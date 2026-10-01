// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ProtocolConstants} from "../libraries/ProtocolConstants.sol";
import {IAICRegistry, StoreRecord} from "../interfaces/IAICRegistry.sol";
import {StoreType} from "../interfaces/IAICoin.sol";

interface IAgentGoodsInit {
    function initializeMarket(address aicToken, address store, bytes32 storeId) external;
    function buyFor(address aicToken, uint256 grossUSDC, uint256 minTokensOut, uint256 deadline, address recipient)
        external
        returns (uint256 tokensOut);
}

interface IAICoinInit {
    function initialize(string calldata name_, string calldata symbol_, bytes32 storeId_, address agentGoods_)
        external;
    function wire(address store_, address governance_) external;
}

interface IStoreInit {
    function initialize(bytes32 storeId_, address registry_, address usdc_, address aicToken_, address storeCreator_)
        external;
    function wire(address licenseToken_, address governance_, address dividendDistributor_) external;
}

interface ILicenseTokenInit {
    function initialize(string calldata name_, string calldata symbol_, bytes32 storeId_, address store_) external;
}

interface IGovernanceInit {
    function initialize(address aicToken_, address store_, bytes32 storeId_) external;
}

interface IDistributorInit {
    function initialize(
        address store_,
        bytes32 storeId_,
        address aicToken_,
        address usdc_,
        address registry_,
        address governance_,
        address initialRootProposer_
    ) external;
}

/**
 * @title StoreFactory
 * @notice Immutable, versioned creator of canonical AIC store component sets.
 *
 * @dev MASTER_PLAN 0.15 / 0.16 / 0.25.O / 0.25.P. This contract is NEVER proxy-upgradeable.
 *      A new generation is a NEW immutable Factory that the upgradeable Registry authorises
 *      for FUTURE creation only; already-created stores keep exactly the code they were born
 *      with, because a clone permanently delegates to one fixed implementation address and
 *      has no admin and no upgrade path.
 *
 *      Creation is atomic in one transaction:
 *
 *          clone AICoin        -> initialize (mints the full 1B straight to AgentGoods)
 *          clone Store          -> initialize
 *          clone LicenseToken   -> initialize
 *          clone Governance     -> initialize
 *          clone Distributor    -> initialize
 *          cross-wire the component set (one-shot, factory-only)
 *          AgentGoods.initializeMarket  (re-verifies the exact 1B inventory on chain)
 *          Registry.registerStore      (append-only canonical provenance)
 *
 *      Either all of it succeeds or the whole transaction reverts, so a half-canonical store
 *      or an orphaned component set cannot exist. Clones are created with CREATE, not CREATE2,
 *      so no counterfactual address exists for an attacker to front-run and initialize, and
 *      every component is initialized in the same call that creates it. [0.25.O, 0.25.P]
 *
 *      Nothing a caller supplies ever becomes a protocol component: every address written to
 *      the Registry was deployed inside this transaction from a pinned implementation.
 */
contract StoreFactory {
    /**
     * @notice Immutable protocol generation of this factory.
     * @dev Generation 2 adds the per-creator store cap below. Generation 1 had none, so a
     *      Registry that still authorises a v1 factory still allows uncapped creation — the cap
     *      is only real once every older generation is deauthorised. See `storeOfCreator`.
     *
     *      Generation 3 changes no factory logic at all. It exists because the store
     *      implementations it pins changed: `StoreBase` now rate-limits owner withdrawals
     *      (`WITHDRAWAL_COOLDOWN`). A clone permanently delegates to the implementation it was
     *      born with, so new code for future stores can only mean a new pinned set, and a new
     *      pinned set can only mean a new factory. The version is bumped rather than left at 2
     *      because it is baked into every store id this factory derives, and two generations
     *      sharing a version would make provenance ambiguous for anyone auditing later.
     *
     *      Generation 4 is the same story again, for the distributor: `DividendDistributor` now
     *      pins its root challenge period as an immutable set at deploy rather than reading a
     *      global constant, so a short-lived test deployment can finalize an epoch at all. The
     *      factory logic is untouched. Note that the two live networks are deliberately NOT on the
     *      same generation — Base Sepolia runs 4 with a 3-hour challenge period, Base mainnet
     *      stays on 3 with the 6-hour default — and that is recorded per chain in
     *      `deployments/<chainId>.json` rather than assumed to be uniform.
     */
    uint64 public constant FACTORY_VERSION = 5;
    /// @notice Minimum owner-funded initial market capital, readable on chain. The value lives in ProtocolConstants.
    uint256 public constant MIN_INITIAL_OWNER_SEED_USDC = ProtocolConstants.MIN_INITIAL_OWNER_SEED_USDC;

    IAICRegistry public immutable registry;
    address public immutable agentGoods;
    address public immutable usdc;
    /// @notice Address seeded as the initial dividend Merkle-root proposer for new stores.
    address public immutable initialRootProposer;

    // Pinned canonical implementations. Immutable for the lifetime of this factory version.
    address public immutable aiCoinImplementation;
    address public immutable salesStoreImplementation;
    address public immutable rentalsStoreImplementation;
    address public immutable licenseTokenImplementation;
    address public immutable governanceImplementation;
    address public immutable distributorImplementation;

    using SafeERC20 for IERC20;

    uint256 public storesCreated;

    /**
     * @notice The store one creator already owns of each type, or zero. One Sales, one Rentals.
     * @dev THIS IS WHAT MAKES REPUTATION COST SOMETHING.
     *
     *      Without a cap, a seller whose store has been marked worthless by its buyers abandons it
     *      and creates another for the price of gas, which makes every reputation signal in the
     *      protocol worth exactly nothing: buyers cannot punish a seller that can respawn, so a
     *      rational seller ships junk, collects, and rotates. Capping creation per address means a
     *      store is a position a seller has to defend rather than a disposable wrapper.
     *
     *      What it does NOT do, stated plainly because overclaiming here would be worse than
     *      having no cap: it binds an ADDRESS, and addresses are free. Anyone can fund a new one
     *      and create two more stores. The cap does not make identity expensive; it makes
     *      REPUTATION NON-TRANSFERABLE. A seller starting again starts with no holders, no
     *      dividend history, no license holders, no buyer signals and no customers, and has to
     *      rebuild all of it — while the store it abandoned stays on chain, permanently, with
     *      whatever its buyers said about it. That asymmetry is the whole mechanism, and it is an
     *      economic cost rather than a technical barrier.
     */
    mapping(address => mapping(StoreType => bytes32)) public storeOfCreator;

    struct Components {
        address store;
        address aicToken;
        address licenseToken;
        address governance;
        address dividendDistributor;
    }

    event StoreCreated(
        bytes32 indexed storeId,
        address indexed store,
        address indexed creator,
        address aicToken,
        address licenseToken,
        address governance,
        address dividendDistributor,
        StoreType storeType,
        uint64 factoryVersion,
        string storeName,
        /// @dev ERC20 metadata of the store token, emitted so an indexer never has to read it
        ///      back over RPC and the projection stays a pure function of the event log.
        string aicName,
        string aicSymbol
    );

    error NotAuthorized();
    error ZeroAddress();
    error NameTooLong();
    error CreationPaused();
    /// @notice This address already owns a store of this type. One Sales and one Rentals, per address.
    error StoreLimitReached(address creator, StoreType storeType, bytes32 existingStore);
    error InitialSeedTooLow(uint256 provided, uint256 minimum);

    /// @notice The creator's own USDC bought the store's AIC in the creation transaction.
    /// @dev Owner-funded market initialization — never independent demand. Indexers use this to
    ///      keep the seed apart from later, independent buying.
    event InitialOwnerSeed(bytes32 indexed storeId, address indexed creator, address indexed aicToken, uint256 seedUSDC, uint256 tokensOut);

    struct Implementations {
        address aiCoin;
        address salesStore;
        address rentalsStore;
        address licenseToken;
        address governance;
        address distributor;
    }

    constructor(
        address registry_,
        address agentGoods_,
        address usdc_,
        address initialRootProposer_,
        Implementations memory impls
    ) {
        if (registry_ == address(0) || agentGoods_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        if (
            impls.aiCoin == address(0) || impls.salesStore == address(0) || impls.rentalsStore == address(0)
                || impls.licenseToken == address(0) || impls.governance == address(0) || impls.distributor == address(0)
        ) revert ZeroAddress();

        registry = IAICRegistry(registry_);
        agentGoods = agentGoods_;
        usdc = usdc_;
        initialRootProposer = initialRootProposer_;

        aiCoinImplementation = impls.aiCoin;
        salesStoreImplementation = impls.salesStore;
        rentalsStoreImplementation = impls.rentalsStore;
        licenseTokenImplementation = impls.licenseToken;
        governanceImplementation = impls.governance;
        distributorImplementation = impls.distributor;
    }

    /**
     * @notice Deterministically derive the canonical storeId for a creation.
     * @dev Binds chain, registry, factory generation, creator, store type and a unique
     *      monotonic nonce, so a replayed creation intent cannot collide with or hijack an
     *      existing identity. [0.19.I]
     */
    function computeStoreId(address creator, StoreType storeType_, uint256 nonce) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(registry), address(this), FACTORY_VERSION, creator, storeType_, nonce)
        );
    }

    /**
     * @notice Create a complete canonical store. Zero protocol fee; the creator pays gas only.
     * @dev ONE STORE OF EACH TYPE PER ADDRESS. A second Sales store, or a second Rentals store,
     *      from an address that already owns one reverts with StoreLimitReached. See
     *      `storeOfCreator` for why the cap exists and what it deliberately does not do.
     * @param storeType_ Sales or Rentals.
     * @param aicName ERC-20 name of the canonical store AIC token.
     * @param aicSymbol ERC-20 symbol of the canonical store AIC token.
     * @param storeName Human display name, indexed only. Untrusted seller content.
     */
    function createStore(
        StoreType storeType_,
        string calldata aicName,
        string calldata aicSymbol,
        string calldata storeName,
        uint256 initialOwnerSeedUSDC
    ) external returns (bytes32 storeId, Components memory c) {
        if (!registry.isAuthorizedFactory(address(this))) revert NotAuthorized();
        if (registry.isPaused(keccak256("PAUSE_STORE_CREATION"))) revert CreationPaused();
        if (initialOwnerSeedUSDC < ProtocolConstants.MIN_INITIAL_OWNER_SEED_USDC) {
            revert InitialSeedTooLow(initialOwnerSeedUSDC, ProtocolConstants.MIN_INITIAL_OWNER_SEED_USDC);
        }
        if (bytes(aicName).length > 64 || bytes(aicSymbol).length > 16 || bytes(storeName).length > 128) {
            revert NameTooLong();
        }

        /*
         * The cap, checked before anything is deployed.
         *
         * Placed ahead of every clone so a refused creation costs the caller a revert rather than
         * six deployments, and so no half-built component set can exist for a creation that was
         * never allowed. The existing storeId is returned in the error because a caller that hits
         * this usually wants to operate the store it already owns, and making it re-query for the
         * id would be a needless round trip.
         */
        bytes32 existing = storeOfCreator[msg.sender][storeType_];
        if (existing != bytes32(0)) revert StoreLimitReached(msg.sender, storeType_, existing);

        uint256 nonce = ++storesCreated;
        storeId = computeStoreId(msg.sender, storeType_, nonce);

        /*
         * Written BEFORE the component deployments, not after.
         *
         * _deployComponents and initializeMarket call out to freshly cloned contracts. Those are
         * pinned implementations rather than caller-supplied addresses, so re-entry is not
         * reachable today — but recording the cap after the external calls would make that a
         * property of the implementations rather than of this function, and a later implementation
         * change could quietly turn the cap off. Effects before interactions keeps it local.
         */
        storeOfCreator[msg.sender][storeType_] = storeId;

        c = _deployComponents(storeId, storeType_, aicName, aicSymbol);

        // Market initialisation re-verifies the exact genesis inventory on chain.
        IAgentGoodsInit(agentGoods).initializeMarket(c.aicToken, c.store, storeId);

        // Append-only canonical provenance.
        registry.registerStore(
            StoreRecord({
                storeId: storeId,
                store: c.store,
                aicToken: c.aicToken,
                licenseToken: c.licenseToken,
                governance: c.governance,
                dividendDistributor: c.dividendDistributor,
                factory: address(this),
                storeCreator: msg.sender,
                factoryVersion: FACTORY_VERSION,
                createdBlock: uint64(block.number),
                storeType: storeType_,
                exists: true
            })
        );

        emit StoreCreated(
            storeId,
            c.store,
            msg.sender,
            c.aicToken,
            c.licenseToken,
            c.governance,
            c.dividendDistributor,
            storeType_,
            FACTORY_VERSION,
            storeName,
            aicName,
            aicSymbol
        );

        /*
         * The store is born with a market. The creator's USDC buys its AIC on the curve here, after
         * registration (the curve only trades a registered canonical token) and inside the same
         * transaction — so if the seed fails for any reason, the whole creation reverts and no store
         * without an owner position and real liquidity can exist. Not a fee: every unit goes to the
         * curve, and the AIC goes to the creator.
         */
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), initialOwnerSeedUSDC);
        IERC20(usdc).forceApprove(agentGoods, initialOwnerSeedUSDC);
        uint256 seededTokens = IAgentGoodsInit(agentGoods).buyFor(c.aicToken, initialOwnerSeedUSDC, 1, block.timestamp, msg.sender);
        emit InitialOwnerSeed(storeId, msg.sender, c.aicToken, initialOwnerSeedUSDC, seededTokens);
    }

    function _deployComponents(
        bytes32 storeId,
        StoreType storeType_,
        string calldata aicName,
        string calldata aicSymbol
    ) private returns (Components memory c) {
        // 1. Genesis token. initialize() mints exactly 1B straight to the market.
        c.aicToken = Clones.clone(aiCoinImplementation);
        IAICoinInit(c.aicToken).initialize(aicName, aicSymbol, storeId, agentGoods);

        // 2. Store.
        c.store = Clones.clone(
            storeType_ == StoreType.Sales ? salesStoreImplementation : rentalsStoreImplementation
        );
        IStoreInit(c.store).initialize(storeId, address(registry), usdc, c.aicToken, msg.sender);

        // 3. Remaining components.
        c.licenseToken = Clones.clone(licenseTokenImplementation);
        ILicenseTokenInit(c.licenseToken).initialize(
            string.concat(aicSymbol, " License"), string.concat(aicSymbol, "-LIC"), storeId, c.store
        );

        c.governance = Clones.clone(governanceImplementation);
        IGovernanceInit(c.governance).initialize(c.aicToken, c.store, storeId);

        c.dividendDistributor = Clones.clone(distributorImplementation);
        IDistributorInit(c.dividendDistributor).initialize(
            c.store, storeId, c.aicToken, usdc, address(registry), c.governance, initialRootProposer
        );

        // 4. One-shot cross wiring, only possible from this factory in this transaction.
        IStoreInit(c.store).wire(c.licenseToken, c.governance, c.dividendDistributor);
        IAICoinInit(c.aicToken).wire(c.store, c.governance);
    }
}
