// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAICoin} from "../interfaces/IAICoin.sol";
import {IAICRegistry, ContractRole} from "../interfaces/IAICRegistry.sol";
import {IProtocolTreasury, FeeType} from "../interfaces/IProtocolTreasury.sol";
import {ProtocolConstants} from "../libraries/ProtocolConstants.sol";

interface IUniswapV2Router02 {
    function factory() external view returns (address);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

/// @notice One-way market lifecycle. [MASTER_PLAN 0.25.K]
enum MarketPhase {
    None,
    BondingCurve,
    Transitioning,
    ExternalDex
}

/**
 * @title AgentGoods
 * @notice Canonical AIC market coordinator: 6,000-virtual-USDC bonding curve before the
 *         30% transition, external DEX liquidity after it.
 *
 * @dev Upgradeable (UUPS) per MASTER_PLAN 0.16, with the blast radius deliberately minimised:
 *      - it can never mint AIC (the token has no mint path at all);
 *      - `burnFromMarket` only ever burns the market own balance, never a third-party balance;
 *      - it never holds an allowance over a user balance beyond the exact pull of a trade;
 *      - real USDC is tracked per market in `realUSDCReserve` and controller fees are tracked
 *        separately, so an implementation bug cannot silently reclassify one as the other.
 *
 *      Economics preserved exactly from V0 (documented in docs/AGENTGOODS_TOKENOMICS.md):
 *      constant-product curve over virtual reserves seeded with 6,000 USDC and 1B AIC,
 *      2% protocol + 1% current-store-controller fee taken from gross on both sides, and the
 *      +35% LP pricing premium at transition.
 *
 *      Bugs fixed relative to V0, each with a regression test:
 *        - V0 `depositCoin` gave the creator a genesis buy. V1 initialises the market with
 *          the full 1B and a zero creator allocation. [12A.1]
 *        - V0 measured the transition against `totalPurchased`, which it decremented on sells
 *          but which was really "net sold". V1 names it `netSoldFromCurve` and uses an exact
 *          300,000,000 AIC threshold against the genesis inventory. [0.13]
 *        - V0 added liquidity with `amountAMin = amountBMin = 0` and no manipulation guard.
 *          V1 enforces explicit minimums and a deadline. [0.25.L]
 *        - V0 checked sell solvency against `usdcReserve` AFTER already mutating it and could
 *          pay out from other markets. V1 checks real per-market solvency first. [0.25.J]
 *        - V0 called `burn()` on a token that has no burn function, so the transition could
 *          never complete. V1 uses the explicit `burnFromMarket` market-only burn. [5.1]
 */
contract AgentGoods is Initializable, AccessControlUpgradeable, ReentrancyGuardTransient, UUPSUpgradeable {
    /**
     * @dev 1e18 price scaling x 1e12 for the USDC(6) to token(18) decimal gap. See `currentPrice`.
     */
    uint256 private constant PRICE_SCALE = 1e30;

    using SafeERC20 for IERC20;

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Minimum gross USDC per trade, preserved from V0 (1.000000 USDC).
    /// @dev 100 base units (0.0001 USDC): the smallest trade on which the 2% protocol and 1% controller fees
    ///      still round to at least one unit each. It was 1 USDC, which blocked small exits. Buybacks pay no
    ///      fees and are not subject to it.
    uint256 public constant MIN_TRADE_USDC = 100;
    /// @notice Slippage tolerance applied to the LP deposit at transition (1%).
    uint256 public constant LP_SLIPPAGE_BPS = 100;

    struct Market {
        address aicToken;
        address store;
        bytes32 storeId;
        MarketPhase phase;
        uint256 tokenInventory; // real AIC held by this contract for that market
        uint256 realUSDCReserve; // real USDC attributable to that curve
        uint256 virtualTokenReserve;
        uint256 virtualUSDCReserve;
        uint256 netSoldFromCurve;
        uint256 controllerFeesUSDC;
        uint256 lifetimeGrossVolumeUSDC;
        uint256 createdBlock;
        address pair;
        uint256 lpTokenAmount;
        uint256 lpUSDCUsed;
        uint256 lpTokenUsed;
        uint256 burnedAtTransition;
        /**
         * @dev Set once, permanently, if a FUNDED external pool already existed when the market
         *      first reached the graduation threshold. Such a market stays on its bonding curve
         *      forever and never lists. See `_graduationWouldBeHijacked`.
         */
        bool graduationBlocked;
        /// @dev Inventory burned by `_burnAsIfGraduated` when graduation was abandoned.
        uint256 burnedAtGraduationBlocked;
    }

    // ------------------------------------------------------------- storage
    IAICRegistry public registry;
    IERC20 public usdc;
    IUniswapV2Router02 public router;
    IUniswapV2Factory public dexFactory;
    address public lpBurnAddress;

    mapping(address => Market) private _markets;
    address[] private _marketTokens;

    /// @dev USDC for a graduated market's buyback whose pool swap failed; flushed by `flushBuyback`.
    mapping(address => uint256) public pendingBuybackUSDC;

    /**
     * @dev Per-deployment curve parameters. Zero means the ProtocolConstants default (6,000 USDC virtual reserve,
     *      30% of genesis to graduate), so a deployment that never sets them — and any proxy upgraded from an
     *      implementation without them — behaves exactly as before. Settable once, by the admin, before the
     *      first market exists: a market's economics can never change under it.
     */
    uint256 public virtualUSDCReserveConfig;
    uint256 public transitionThresholdAICConfig;

    /// @dev Reserved for future implementations. Never reorder or shrink.
    ///      (40 -> 39: pendingBuybackUSDC; 39 -> 37: the two curve parameters.)
    uint256[37] private __gap;

    // -------------------------------------------------------------- events
    event MarketInitialized(
        address indexed aicToken,
        address indexed store,
        bytes32 indexed storeId,
        uint256 genesisInventory,
        uint256 virtualUSDCReserve,
        uint256 virtualTokenReserve,
        uint256 createdBlock
    );
    event TokensPurchased(
        address indexed aicToken,
        address indexed buyer,
        uint256 grossUSDC,
        uint256 protocolFeeUSDC,
        uint256 controllerFeeUSDC,
        uint256 netCurveUSDC,
        uint256 tokensOut,
        uint256 netSoldFromCurve,
        uint256 virtualUSDCReserve,
        uint256 virtualTokenReserve
    );
    event TokensSold(
        address indexed aicToken,
        address indexed seller,
        uint256 tokensIn,
        uint256 grossUSDC,
        uint256 protocolFeeUSDC,
        uint256 controllerFeeUSDC,
        uint256 netUSDCOut,
        uint256 netSoldFromCurve,
        uint256 virtualUSDCReserve,
        uint256 virtualTokenReserve
    );
    event LiquidityTransition(
        address indexed aicToken,
        address indexed pair,
        uint256 usdcToLP,
        uint256 tokensToLP,
        uint256 lpTokens,
        uint256 tokensBurned
    );
    /**
     * @notice A market reached the graduation threshold with a funded external pool already in
     *         existence, and will therefore never list. Emitted once, and it is permanent.
     * @dev The market keeps trading on its bonding curve exactly as before. This is not a failure
     *      of the purchase that triggered it: that purchase succeeds normally.
     */
    event GraduationBlocked(
        address indexed aicToken,
        address indexed blockingPair,
        uint256 poolReserveUSDC,
        uint256 poolReserveAIC,
        uint256 netSoldFromCurve
    );
    /**
     * @notice A blocked market burned inventory so its supply and price land where graduation
     *         would have put them, with the virtual seed reduced to keep redemption exact.
     */
    event GraduationBurn(
        address indexed aicToken,
        uint256 tokensBurned,
        uint256 newVirtualTokenReserve,
        uint256 newVirtualUSDCReserve,
        uint256 newVirtualSeedUSDC
    );
    event ControllerFeesWithdrawn(address indexed aicToken, address indexed controller, uint256 amount);
    event DexConfigured(address router, address dexFactory, address lpBurnAddress);
    /**
     * @notice A store's buyback: `usdcIn` of its commerce bought `aicBurned` of its own AIC, which was burned.
     * @param onCurve true on the bonding curve, false through the external pool after graduation.
     */
    event BuybackBurned(address indexed aicToken, address indexed store, uint256 usdcIn, uint256 aicBurned, bool onCurve);
    /// @notice A graduated market's buyback could not swap; the USDC waits in `pendingBuybackUSDC`.
    event BuybackDeferred(address indexed aicToken, uint256 usdcIn, uint256 pendingUSDC);

    // -------------------------------------------------------------- errors
    error NotAuthorizedFactory();
    error MarketExists();
    error UnknownMarket();
    error WrongPhase(MarketPhase actual);
    error GenesisInventoryMismatch(uint256 expected, uint256 actual);
    error NotCanonicalToken();
    error BelowMinimumTrade(uint256 provided, uint256 minimum);
    error SlippageExceeded(uint256 got, uint256 minimum);
    error DeadlinePassed();
    error InsufficientCurveLiquidity(uint256 requested, uint256 available);
    error InsufficientRealReserve(uint256 required, uint256 available);
    error MarketPaused();
    error NotStoreController();
    error ZeroAmount();
    error ZeroAddress();
    error TransitionFailed();
    error NotMarketStore();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address registry_,
        address usdc_,
        address router_,
        address lpBurnAddress_,
        address admin_,
        address guardian_
    ) external initializer {
        if (
            registry_ == address(0) || usdc_ == address(0) || router_ == address(0) || lpBurnAddress_ == address(0)
                || admin_ == address(0) || guardian_ == address(0)
        ) revert ZeroAddress();

        __AccessControl_init();


        registry = IAICRegistry(registry_);
        usdc = IERC20(usdc_);
        router = IUniswapV2Router02(router_);
        dexFactory = IUniswapV2Factory(IUniswapV2Router02(router_).factory());
        lpBurnAddress = lpBurnAddress_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(UPGRADER_ROLE, admin_);
        _grantRole(GUARDIAN_ROLE, guardian_);

        emit DexConfigured(router_, address(dexFactory), lpBurnAddress_);
    }

    // ===================================================== curve parameters ==

    event CurveParametersConfigured(uint256 virtualUSDCReserve, uint256 transitionThresholdAIC);
    error CurveParametersLocked();
    error InvalidCurveParameters();

    /// @notice The virtual USDC reserve new markets start with.
    function virtualUSDCReserve() public view returns (uint256) {
        return virtualUSDCReserveConfig == 0 ? ProtocolConstants.VIRTUAL_USDC_RESERVE : virtualUSDCReserveConfig;
    }

    /// @notice Net AIC that must leave the curve before it graduates to the DEX pool.
    function transitionThresholdAIC() public view returns (uint256) {
        return transitionThresholdAICConfig == 0 ? ProtocolConstants.TRANSITION_THRESHOLD_AIC : transitionThresholdAICConfig;
    }

    /**
     * @notice Set this deployment's curve parameters. Admin only, and only before any market exists.
     * @param virtualUSDCReserve_ virtual USDC reserve (6 decimals), at least 1 USDC
     * @param transitionThresholdAIC_ net AIC sold that triggers graduation: above zero, below genesis supply
     */
    function configureCurve(uint256 virtualUSDCReserve_, uint256 transitionThresholdAIC_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_marketTokens.length != 0) revert CurveParametersLocked();
        if (virtualUSDCReserve_ < 10 ** 6 || transitionThresholdAIC_ == 0 || transitionThresholdAIC_ >= ProtocolConstants.AIC_GENESIS_SUPPLY) {
            revert InvalidCurveParameters();
        }
        virtualUSDCReserveConfig = virtualUSDCReserve_;
        transitionThresholdAICConfig = transitionThresholdAIC_;
        emit CurveParametersConfigured(virtualUSDCReserve_, transitionThresholdAIC_);
    }

    // ======================================================= market setup ==

    function market(address aicToken) external view returns (Market memory) {
        Market memory m = _markets[aicToken];
        if (m.phase == MarketPhase.None) revert UnknownMarket();
        return m;
    }

    function marketCount() external view returns (uint256) {
        return _marketTokens.length;
    }

    function marketTokenAt(uint256 index) external view returns (address) {
        return _marketTokens[index];
    }

    /**
     * @notice Initialise a market for a freshly created canonical AIC token.
     * @dev Called by an authorised Factory inside the atomic store creation transaction.
     *      Rejects any inventory that is not EXACTLY the genesis supply, so a partially
     *      funded, over funded, wrong-decimals, wrong-token or duplicated market cannot
     *      become active. The check reads the real balance; no backend assertion is trusted.
     *      [12A.2]
     */
    function initializeMarket(address aicToken, address store_, bytes32 storeId_) external nonReentrant {
        if (!registry.isAuthorizedFactory(msg.sender)) revert NotAuthorizedFactory();
        if (aicToken == address(0) || store_ == address(0)) revert ZeroAddress();
        if (_markets[aicToken].phase != MarketPhase.None) revert MarketExists();

        uint256 inventory = IERC20(aicToken).balanceOf(address(this));
        if (inventory != ProtocolConstants.AIC_GENESIS_SUPPLY) {
            revert GenesisInventoryMismatch(ProtocolConstants.AIC_GENESIS_SUPPLY, inventory);
        }
        if (IERC20(aicToken).totalSupply() != ProtocolConstants.AIC_GENESIS_SUPPLY) {
            revert GenesisInventoryMismatch(ProtocolConstants.AIC_GENESIS_SUPPLY, IERC20(aicToken).totalSupply());
        }

        Market storage m = _markets[aicToken];
        m.aicToken = aicToken;
        m.store = store_;
        m.storeId = storeId_;
        m.phase = MarketPhase.BondingCurve;
        m.tokenInventory = inventory;
        m.realUSDCReserve = 0;
        m.virtualTokenReserve = ProtocolConstants.AIC_GENESIS_SUPPLY;
        m.virtualUSDCReserve = virtualUSDCReserve();
        m.netSoldFromCurve = 0;
        m.createdBlock = block.number;
        _marketTokens.push(aicToken);

        emit MarketInitialized(
            aicToken,
            store_,
            storeId_,
            inventory,
            virtualUSDCReserve(),
            ProtocolConstants.AIC_GENESIS_SUPPLY,
            block.number
        );
    }

    // ============================================================== curve ==

    /// @notice Constant-product buy output. Identical formula to V0.
    function calculateBuyReturn(uint256 tokenReserve, uint256 usdcReserve, uint256 usdcAmount)
        public
        pure
        returns (uint256)
    {
        if (tokenReserve == 0 || usdcReserve == 0 || usdcAmount == 0) return 0;
        return (tokenReserve * usdcAmount) / (usdcReserve + usdcAmount);
    }

    /// @notice Constant-product sell output. Identical formula to V0.
    function calculateSellReturn(uint256 tokenReserve, uint256 usdcReserve, uint256 tokenAmount)
        public
        pure
        returns (uint256)
    {
        if (tokenReserve == 0 || usdcReserve == 0 || tokenAmount == 0) return 0;
        return (usdcReserve * tokenAmount) / (tokenReserve + tokenAmount);
    }

    struct BuyQuote {
        uint256 grossUSDC;
        uint256 protocolFeeUSDC;
        uint256 controllerFeeUSDC;
        uint256 netCurveUSDC;
        uint256 tokensOut;
        uint256 netSoldAfter;
        uint256 netSoldPercentageBps;
        bool willTriggerTransition;
        bool enoughInventory;
        uint256 pricePerTokenGross1e18;
        /**
         * @notice True when this market can never list, because a funded external pool already
         *         existed when it first reached the threshold.
         * @dev When set, `willTriggerTransition` is always false however large the purchase: there
         *      is no amount of USDC that causes this market to graduate.
         */
        bool graduationBlocked;
    }

    function quoteBuy(address aicToken, uint256 grossUSDC) public view returns (BuyQuote memory q) {
        Market storage m = _markets[aicToken];
        if (m.phase != MarketPhase.BondingCurve) return q;

        q.grossUSDC = grossUSDC;
        q.protocolFeeUSDC = (grossUSDC * registry.agentGoodsProtocolFeeBps()) / ProtocolConstants.BPS_DENOMINATOR;
        q.controllerFeeUSDC = (grossUSDC * registry.agentGoodsControllerFeeBps()) / ProtocolConstants.BPS_DENOMINATOR;
        q.netCurveUSDC = grossUSDC - q.protocolFeeUSDC - q.controllerFeeUSDC;

        q.tokensOut = calculateBuyReturn(m.virtualTokenReserve, m.virtualUSDCReserve, q.netCurveUSDC);
        q.enoughInventory = q.tokensOut > 0 && q.tokensOut <= m.tokenInventory;
        q.netSoldAfter = m.netSoldFromCurve + q.tokensOut;
        q.netSoldPercentageBps =
            (q.netSoldAfter * ProtocolConstants.BPS_DENOMINATOR) / ProtocolConstants.AIC_GENESIS_SUPPLY;
        /*
         * A quote must never promise a listing that cannot happen. Once blocked, no purchase of any
         * size graduates this market, so `willTriggerTransition` is false regardless of the amount.
         *
         * The live pool check is included for a market that has not yet reached the threshold:
         * a caller sizing a purchase to trigger the listing should be told now that it will not,
         * rather than discovering it from the absence of an event afterwards.
         */
        q.graduationBlocked = m.graduationBlocked || _graduationWouldBeHijacked(aicToken);
        q.willTriggerTransition =
            !q.graduationBlocked && q.netSoldAfter >= transitionThresholdAIC();
        q.pricePerTokenGross1e18 = q.tokensOut > 0 ? (grossUSDC * PRICE_SCALE) / q.tokensOut : 0;
    }

    struct SellQuote {
        uint256 tokensIn;
        uint256 grossUSDC;
        uint256 protocolFeeUSDC;
        uint256 controllerFeeUSDC;
        uint256 netUSDCOut;
        uint256 netSoldAfter;
        bool enoughRealReserve;
        uint256 pricePerTokenGross1e18;
    }

    function quoteSell(address aicToken, uint256 tokensIn) public view returns (SellQuote memory q) {
        Market storage m = _markets[aicToken];
        if (m.phase != MarketPhase.BondingCurve) return q;

        q.tokensIn = tokensIn;
        q.grossUSDC = calculateSellReturn(m.virtualTokenReserve, m.virtualUSDCReserve, tokensIn);
        q.protocolFeeUSDC = (q.grossUSDC * registry.agentGoodsProtocolFeeBps()) / ProtocolConstants.BPS_DENOMINATOR;
        q.controllerFeeUSDC = (q.grossUSDC * registry.agentGoodsControllerFeeBps()) / ProtocolConstants.BPS_DENOMINATOR;
        q.netUSDCOut = q.grossUSDC - q.protocolFeeUSDC - q.controllerFeeUSDC;
        // Virtual USDC is pricing state. Only real USDC can ever satisfy a redemption. [0.25.J]
        q.enoughRealReserve = q.grossUSDC <= m.realUSDCReserve;
        q.netSoldAfter = m.netSoldFromCurve > tokensIn ? m.netSoldFromCurve - tokensIn : 0;
        q.pricePerTokenGross1e18 = tokensIn > 0 ? (q.grossUSDC * PRICE_SCALE) / tokensIn : 0;
    }

    /**
     * @notice Spot price of one WHOLE store token, denominated in WHOLE USDC, scaled by 1e18.
     *
     * @dev The scaling is `PRICE_SCALE = 1e30`, not `1e18`, and the extra `1e12` is not
     *      arbitrary: USDC has 6 decimals and the store token has 18, so
     *
     *        usdcPerToken = (usdc / 1e6) / (token / 1e18) = usdc * 1e12 / token
     *
     *      and the 1e18-scaled form of that is `usdc * 1e30 / token`. Returning the 1e18-scaled
     *      form in USDC BASE units instead (the earlier `1e36` factor) reported a 7.16e-6 USDC
     *      price as 7.16, which reads as dollars. MASTER_PLAN 0.27.J forbids exactly that
     *      confusion, so every price surface in this system now uses this one definition.
     */
    function currentPrice(address aicToken) external view returns (uint256) {
        Market storage m = _markets[aicToken];
        if (m.virtualTokenReserve == 0) return 0;
        return (m.virtualUSDCReserve * PRICE_SCALE) / m.virtualTokenReserve;
    }

    // =============================================================== trade ==

    function buy(address aicToken, uint256 grossUSDC, uint256 minTokensOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        return _buy(aicToken, grossUSDC, minTokensOut, deadline, msg.sender);
    }

    /**
     * @notice Buy on the curve with the caller's USDC, delivering the AIC to `recipient`.
     * @dev The caller pays; the recipient receives and is the buyer named in TokensPurchased. Used by
     *      the StoreFactory to seed a new store's market for its creator in the creation transaction.
     *      Economically a buy followed by a transfer — nothing a caller could not already do in two
     *      steps — so it needs no role.
     */
    function buyFor(address aicToken, uint256 grossUSDC, uint256 minTokensOut, uint256 deadline, address recipient)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (recipient == address(0)) revert ZeroAddress();
        return _buy(aicToken, grossUSDC, minTokensOut, deadline, recipient);
    }

    function _buy(address aicToken, uint256 grossUSDC, uint256 minTokensOut, uint256 deadline, address recipient)
        internal
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (registry.isPaused(keccak256("PAUSE_MARKET"))) revert MarketPaused();
        if (grossUSDC < MIN_TRADE_USDC) revert BelowMinimumTrade(grossUSDC, MIN_TRADE_USDC);

        Market storage m = _markets[aicToken];
        if (m.phase == MarketPhase.None) revert UnknownMarket();
        if (m.phase != MarketPhase.BondingCurve) revert WrongPhase(m.phase);
        if (registry.roleOf(aicToken) != ContractRole.AicToken) revert NotCanonicalToken();

        uint256 protocolFee = (grossUSDC * registry.agentGoodsProtocolFeeBps()) / ProtocolConstants.BPS_DENOMINATOR;
        uint256 controllerFee = (grossUSDC * registry.agentGoodsControllerFeeBps()) / ProtocolConstants.BPS_DENOMINATOR;
        uint256 netCurve = grossUSDC - protocolFee - controllerFee;

        tokensOut = calculateBuyReturn(m.virtualTokenReserve, m.virtualUSDCReserve, netCurve);
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut > m.tokenInventory) revert InsufficientCurveLiquidity(tokensOut, m.tokenInventory);
        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        usdc.safeTransferFrom(msg.sender, address(this), grossUSDC);

        m.virtualUSDCReserve += netCurve;
        m.virtualTokenReserve -= tokensOut;
        m.tokenInventory -= tokensOut;
        m.realUSDCReserve += netCurve;
        m.netSoldFromCurve += tokensOut;
        m.controllerFeesUSDC += controllerFee;
        m.lifetimeGrossVolumeUSDC += grossUSDC;

        IERC20(aicToken).safeTransfer(recipient, tokensOut);
        _forwardProtocolFee(FeeType.AGENTGOODS_BUY, protocolFee, m.store);

        emit TokensPurchased(
            aicToken,
            recipient,
            grossUSDC,
            protocolFee,
            controllerFee,
            netCurve,
            tokensOut,
            m.netSoldFromCurve,
            m.virtualUSDCReserve,
            m.virtualTokenReserve
        );

        _maybeGraduate(aicToken, m);
    }

    function _maybeGraduate(address aicToken, Market storage m) private {
        if (!m.graduationBlocked && m.netSoldFromCurve >= transitionThresholdAIC()) {
            if (_graduationWouldBeHijacked(aicToken)) {
                m.graduationBlocked = true;
                (address blockingPair, uint256 rUSDC, uint256 rAIC) = _externalPoolState(aicToken);
                emit GraduationBlocked(aicToken, blockingPair, rUSDC, rAIC, m.netSoldFromCurve);
                // Apply graduation's economic outcome on the curve instead. Emits its own event
                // and refuses rather than approximating if any guard fails.
                _burnAsIfGraduated(aicToken, m);
            } else {
                _transitionToDex(aicToken, m);
            }
        }
    }

    /**
     * @notice Buy the store's own AIC with `usdcAmount` of its commerce and burn it — the holders' share of
     *         every sale, delivered as a permanently smaller supply instead of a dividend to claim.
     * @dev Only the market's own store may call it; the store pays. Works in both phases:
     *        - on the bonding curve: a fee-free curve buy with no minimum trade; the USDC joins the real
     *          reserve, the bought tokens leave the inventory and are burned, and they count toward
     *          graduation like any sale from the curve;
     *        - after graduation: a swap through the external pool, and the received AIC is burned. If the
     *          swap fails the USDC waits in `pendingBuybackUSDC` and anyone can `flushBuyback` it later, so
     *          a pool problem can never block the purchase that funded it.
     *      Economically the same money as the old holder reserve; the reward reaches holders as supply
     *      reduction and a higher price, with nothing to distribute or claim.
     */
    function buybackAndBurn(address aicToken, uint256 usdcAmount) external nonReentrant returns (uint256 burned) {
        Market storage m = _markets[aicToken];
        if (m.phase == MarketPhase.None) revert UnknownMarket();
        if (msg.sender != m.store) revert NotMarketStore();
        if (usdcAmount == 0) return 0;
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        if (m.phase == MarketPhase.BondingCurve) {
            burned = calculateBuyReturn(m.virtualTokenReserve, m.virtualUSDCReserve, usdcAmount);
            if (burned > m.tokenInventory) burned = m.tokenInventory;
            m.virtualUSDCReserve += usdcAmount;
            m.realUSDCReserve += usdcAmount;
            if (burned > 0) {
                m.virtualTokenReserve -= burned;
                m.tokenInventory -= burned;
                m.netSoldFromCurve += burned;
                IAICoin(aicToken).burnFromMarket(burned);
            }
            emit BuybackBurned(aicToken, msg.sender, usdcAmount, burned, true);
            _maybeGraduate(aicToken, m);
            return burned;
        }

        pendingBuybackUSDC[aicToken] += usdcAmount;
        burned = _swapAndBurn(aicToken, m.store);
    }

    /// @notice Retry a graduated market's deferred buyback. Anyone may call it; it only ever buys and burns.
    function flushBuyback(address aicToken) external nonReentrant returns (uint256 burned) {
        Market storage m = _markets[aicToken];
        if (m.phase != MarketPhase.ExternalDex) revert WrongPhase(m.phase);
        burned = _swapAndBurn(aicToken, m.store);
    }

    function _swapAndBurn(address aicToken, address store_) private returns (uint256 burned) {
        uint256 amount = pendingBuybackUSDC[aicToken];
        if (amount == 0) return 0;
        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = aicToken;
        uint256 before = IERC20(aicToken).balanceOf(address(this));
        usdc.forceApprove(address(router), amount);
        try router.swapExactTokensForTokens(amount, 0, path, address(this), block.timestamp) {
            usdc.forceApprove(address(router), 0);
            pendingBuybackUSDC[aicToken] = 0;
            burned = IERC20(aicToken).balanceOf(address(this)) - before;
            if (burned > 0) IAICoin(aicToken).burnFromMarket(burned);
            emit BuybackBurned(aicToken, store_, amount, burned, false);
        } catch {
            usdc.forceApprove(address(router), 0);
            emit BuybackDeferred(aicToken, amount, amount);
        }
    }

    function sell(address aicToken, uint256 tokensIn, uint256 minUSDCOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 netUSDCOut)
    {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (registry.isPaused(keccak256("PAUSE_MARKET"))) revert MarketPaused();
        if (tokensIn == 0) revert ZeroAmount();

        Market storage m = _markets[aicToken];
        if (m.phase == MarketPhase.None) revert UnknownMarket();
        if (m.phase != MarketPhase.BondingCurve) revert WrongPhase(m.phase);

        uint256 grossUSDC = calculateSellReturn(m.virtualTokenReserve, m.virtualUSDCReserve, tokensIn);
        if (grossUSDC == 0) revert ZeroAmount();
        // Solvency FIRST, against real reserve only. Virtual USDC can never pay a redemption.
        if (grossUSDC > m.realUSDCReserve) revert InsufficientRealReserve(grossUSDC, m.realUSDCReserve);

        uint256 protocolFee = (grossUSDC * registry.agentGoodsProtocolFeeBps()) / ProtocolConstants.BPS_DENOMINATOR;
        uint256 controllerFee = (grossUSDC * registry.agentGoodsControllerFeeBps()) / ProtocolConstants.BPS_DENOMINATOR;
        netUSDCOut = grossUSDC - protocolFee - controllerFee;
        if (netUSDCOut < minUSDCOut) revert SlippageExceeded(netUSDCOut, minUSDCOut);

        uint256 balanceBefore = IERC20(aicToken).balanceOf(address(this));
        IERC20(aicToken).safeTransferFrom(msg.sender, address(this), tokensIn);
        uint256 received = IERC20(aicToken).balanceOf(address(this)) - balanceBefore;
        // Canonical AIC is never fee-on-transfer; the delta check makes that an enforced
        // assumption rather than an implicit one. [0.21.H]
        require(received == tokensIn, "AgentGoods: unexpected transfer amount");

        m.virtualTokenReserve += tokensIn;
        m.virtualUSDCReserve -= grossUSDC;
        m.tokenInventory += tokensIn;
        m.realUSDCReserve -= grossUSDC;
        m.netSoldFromCurve = m.netSoldFromCurve > tokensIn ? m.netSoldFromCurve - tokensIn : 0;
        m.controllerFeesUSDC += controllerFee;
        m.lifetimeGrossVolumeUSDC += grossUSDC;

        usdc.safeTransfer(msg.sender, netUSDCOut);
        _forwardProtocolFee(FeeType.AGENTGOODS_SELL, protocolFee, m.store);

        emit TokensSold(
            aicToken,
            msg.sender,
            tokensIn,
            grossUSDC,
            protocolFee,
            controllerFee,
            netUSDCOut,
            m.netSoldFromCurve,
            m.virtualUSDCReserve,
            m.virtualTokenReserve
        );
    }

    function _forwardProtocolFee(bytes32 feeType, uint256 amount, address source) private {
        if (amount == 0) return;
        address treasury = registry.protocolTreasury();
        usdc.safeTransfer(treasury, amount);
        IProtocolTreasury(treasury).recordRevenue(feeType, address(usdc), source, amount);
    }

    // ========================================================== transition ==

    /**
     * @dev One-way, non-reentrant transition. Phase is moved to `Transitioning` before any
     *      external call so no trade can execute against a half-transitioned market, and the
     *      whole thing reverts atomically on failure rather than leaving partially burned AIC
     *      or a phase marked complete without liquidity. [0.25.K]
     */
    /**
     * @notice The external pool for this market, with its reserves oriented as (USDC, AIC).
     * @dev Returns zeroes when no pair exists. Uniswap orders a pair's tokens by address, so the
     *      orientation must be resolved rather than assumed — reading them the wrong way round
     *      would make this check report the opposite of the truth roughly half the time.
     */
    function _externalPoolState(address aicToken)
        private
        view
        returns (address pair, uint256 reserveUSDC, uint256 reserveAIC)
    {
        pair = dexFactory.getPair(address(usdc), aicToken);
        if (pair == address(0)) return (address(0), 0, 0);

        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(pair).getReserves();
        if (address(usdc) < aicToken) {
            return (pair, uint256(r0), uint256(r1));
        }
        return (pair, uint256(r1), uint256(r0));
    }

    /**
     * @notice Would graduating right now hand the protocol's USDC to whoever pre-seeded a pool?
     *
     * @dev **The check is on RESERVES, deliberately not on the pair merely existing.**
     *
     *      An unfunded pair is harmless: `addLiquidity` into an empty pool mints the initial
     *      liquidity at the ratio WE supply, which is exactly what creating the pair ourselves
     *      would have done. Verified empirically, not assumed.
     *
     *      Treating mere existence as disqualifying would be actively worse than the attack it
     *      defends against. `createPair` is permissionless and needs no capital at all, so anyone
     *      could permanently block any token's graduation for ordinary gas. The mitigation would
     *      become cheaper to abuse than the thing it mitigates.
     *
     *      A FUNDED pool is the real hazard, because the router prices our deposit against its
     *      existing ratio. Today that reverts — the 1% slippage bound refuses any ratio we did not
     *      intend, so no USDC is ever given away — but a revert inside `buy` means every purchase
     *      that would cross the threshold reverts forever, which strands the token with no
     *      explanation and no way forward.
     *
     *      So the market stops trying. It stays on its bonding curve permanently, which keeps
     *      working, and says so through `GraduationBlocked` and `graduationBlocked` rather than
     *      failing silently. [Operator decision, 2026-09-23]
     */
    function _graduationWouldBeHijacked(address aicToken) private view returns (bool) {
        (address pair, uint256 reserveUSDC, uint256 reserveAIC) = _externalPoolState(aicToken);
        if (pair == address(0)) return false;
        return reserveUSDC > 0 || reserveAIC > 0;
    }

    /**
     * @notice Burn inventory so a blocked market lands where graduation would have put it.
     *
     * @dev A market that cannot list would otherwise keep its entire genesis supply and its
     *      original curve price, leaving it visibly different from every token that did graduate.
     *      This applies the equivalent outcome on the curve itself.
     *
     *      **The curve has exactly zero solvency margin, which constrains everything here.**
     *      Because `virtualTokenReserve + outstanding == genesis` and
     *      `virtualUSDC == seed + realUSDC`, selling every outstanding token quotes precisely the
     *      real reserve — to the base unit. Measured, not assumed. So burning tokens and shrinking
     *      the token reserve ALONE raises the quoted payout above the USDC that exists, and holders
     *      who sell late are refused. That is the exact trap this whole design avoids, so it cannot
     *      be the implementation.
     *
     *      The seed must therefore move with the burn. Solving for a price exactly
     *      `LP_PREMIUM_BPS` above the current curve price, while keeping the full-exit payout
     *      exactly equal to the real reserve, gives:
     *
     *          burn = premium * vUSDC * vTokens / ((BPS + premium) * vUSDC - BPS * seed)
     *          newVirtualUSDC = vUSDC - ceil(realUSDC * burn / outstanding)
     *
     *      The seed appears in the denominator, which is the whole point: the ratio differs from
     *      graduation's precisely BECAUSE the virtual seed still prices this market, whereas an
     *      external pool would have held only real money. [Operator decision, 2026-09-23]
     *
     *      Every rounding choice is made in the direction that protects redemption: the burn rounds
     *      down (slightly less than the full premium) and the reserve reduction rounds up (a
     *      slightly lower payout), so the exit identity can only ever gain margin, never lose it.
     *
     *      Refuses rather than approximates. If any guard fails the market is simply left blocked
     *      with its supply intact, which is a worse cosmetic outcome and a perfectly safe one.
     */
    function _burnAsIfGraduated(address aicToken, Market storage m) private {
        uint256 vTokens = m.virtualTokenReserve;
        uint256 vUSDC = m.virtualUSDCReserve;
        uint256 realUSDC = m.realUSDCReserve;
        uint256 inventory = m.tokenInventory;

        if (vTokens == 0 || inventory == 0 || realUSDC == 0) return;
        if (vUSDC <= realUSDC) return; // no seed to draw down
        uint256 seed = vUSDC - realUSDC;

        // Tokens held by anyone other than this curve. Read from the token rather than derived
        // from a genesis constant, so it stays correct after any burn that has already happened.
        uint256 totalSupply = IERC20(aicToken).totalSupply();
        if (totalSupply <= inventory) return;
        uint256 outstanding = totalSupply - inventory;

        uint256 denominator =
            (ProtocolConstants.BPS_DENOMINATOR + ProtocolConstants.LP_PREMIUM_BPS) * vUSDC;
        uint256 seedTerm = ProtocolConstants.BPS_DENOMINATOR * seed;
        if (denominator <= seedTerm) return;
        denominator -= seedTerm;

        uint256 burnAmount = (ProtocolConstants.LP_PREMIUM_BPS * vUSDC * vTokens) / denominator;
        // Never empty the curve: it has to keep quoting after this, in both directions.
        if (burnAmount == 0 || burnAmount >= inventory) return;

        // Ceiling division, deliberately: a larger reduction means a smaller payout.
        uint256 reduction = (realUSDC * burnAmount + outstanding - 1) / outstanding;
        // The seed may shrink a great deal, but it must not vanish or invert.
        if (reduction >= seed) return;

        m.tokenInventory = inventory - burnAmount;
        m.virtualTokenReserve = vTokens - burnAmount;
        m.virtualUSDCReserve = vUSDC - reduction;
        m.burnedAtGraduationBlocked = burnAmount;

        IAICoin(aicToken).burnFromMarket(burnAmount);

        emit GraduationBurn(
            aicToken,
            burnAmount,
            m.virtualTokenReserve,
            m.virtualUSDCReserve,
            m.virtualUSDCReserve - realUSDC
        );
    }

    function _transitionToDex(address aicToken, Market storage m) private {
        m.phase = MarketPhase.Transitioning;

        uint256 usdcForLP = m.realUSDCReserve;
        uint256 inventory = m.tokenInventory;
        if (usdcForLP == 0 || inventory == 0) revert TransitionFailed();

        // V0 pricing premium preserved exactly:
        //   tokensForLP = realUSDC * virtualTokenReserve / (virtualUSDCReserve * 1.35)
        uint256 denominator = (m.virtualUSDCReserve * (ProtocolConstants.BPS_DENOMINATOR + ProtocolConstants.LP_PREMIUM_BPS))
            / ProtocolConstants.BPS_DENOMINATOR;
        if (denominator == 0) revert TransitionFailed();

        uint256 tokensForLP = (usdcForLP * m.virtualTokenReserve) / denominator;
        if (tokensForLP > inventory) tokensForLP = inventory;
        if (tokensForLP == 0) revert TransitionFailed();

        address pair = dexFactory.getPair(address(usdc), aicToken);
        if (pair == address(0)) {
            pair = dexFactory.createPair(address(usdc), aicToken);
        }

        usdc.forceApprove(address(router), usdcForLP);
        IERC20(aicToken).forceApprove(address(router), tokensForLP);

        uint256 minUSDC = (usdcForLP * (ProtocolConstants.BPS_DENOMINATOR - LP_SLIPPAGE_BPS))
            / ProtocolConstants.BPS_DENOMINATOR;
        uint256 minTokens = (tokensForLP * (ProtocolConstants.BPS_DENOMINATOR - LP_SLIPPAGE_BPS))
            / ProtocolConstants.BPS_DENOMINATOR;

        (uint256 usedUSDC, uint256 usedTokens, uint256 liquidity) = router.addLiquidity(
            address(usdc), aicToken, usdcForLP, tokensForLP, minUSDC, minTokens, address(this), block.timestamp
        );

        usdc.forceApprove(address(router), 0);
        IERC20(aicToken).forceApprove(address(router), 0);

        m.realUSDCReserve -= usedUSDC;
        m.tokenInventory -= usedTokens;
        m.lpUSDCUsed = usedUSDC;
        m.lpTokenUsed = usedTokens;
        m.pair = pair;
        m.lpTokenAmount = liquidity;

        // Lock LP forever. UniswapV2 LP tokens have no burn function. [V0 behaviour preserved]
        uint256 lpBalance = IERC20(pair).balanceOf(address(this));
        if (lpBalance > 0) {
            IERC20(pair).safeTransfer(lpBurnAddress, lpBalance);
        }

        // Burn only what this market still holds. Never an EOA, reward pool or LP balance.
        uint256 remaining = m.tokenInventory;
        if (remaining > 0) {
            m.tokenInventory = 0;
            m.burnedAtTransition = remaining;
            IAICoin(aicToken).burnFromMarket(remaining);
        }

        m.phase = MarketPhase.ExternalDex;

        emit LiquidityTransition(aicToken, pair, usedUSDC, usedTokens, liquidity, remaining);
    }

    // =========================================================== fees ==

    /**
     * @notice Withdraw accrued store-controller trading fees.
     * @dev Paid to the CURRENT authoritative controller from the Registry, not to a stale
     *      historical creator. A takeover therefore redirects the 1% fee immediately. [0.13]
     */
    function withdrawControllerFees(address aicToken, address to) external nonReentrant {
        Market storage m = _markets[aicToken];
        if (m.phase == MarketPhase.None) revert UnknownMarket();
        address controller = registry.storeController(m.storeId);
        if (msg.sender != controller) revert NotStoreController();
        if (to == address(0)) revert ZeroAddress();

        uint256 amount = m.controllerFeesUSDC;
        if (amount == 0) revert ZeroAmount();
        m.controllerFeesUSDC = 0;
        usdc.safeTransfer(to, amount);
        emit ControllerFeesWithdrawn(aicToken, controller, amount);
    }

    // ======================================================== diagnostics ==

    /// @notice Solvency view used by the reconciler and the invariant tests.
    function usdcAccounting()
        external
        view
        returns (uint256 contractBalance, uint256 sumRealReserves, uint256 sumControllerFees, int256 delta)
    {
        uint256 reserves;
        uint256 fees;
        uint256 pending;
        uint256 len = _marketTokens.length;
        for (uint256 i = 0; i < len; i++) {
            address token = _marketTokens[i];
            Market storage m = _markets[token];
            reserves += m.realUSDCReserve;
            fees += m.controllerFeesUSDC;
            // USDC a graduated market's deferred buyback is holding until flushBuyback swaps it.
            pending += pendingBuybackUSDC[token];
        }
        contractBalance = usdc.balanceOf(address(this));
        sumRealReserves = reserves;
        sumControllerFees = fees;
        delta = int256(contractBalance) - int256(reserves + fees + pending);
    }

    function agentGoodsVersion() external pure virtual returns (string memory) {
        return "1.0.0";
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
