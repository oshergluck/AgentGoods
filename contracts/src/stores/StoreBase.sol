// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStore, StoreStatus, ControllerChangeReason} from "../interfaces/IStore.sol";
import {IAICoin, StoreType} from "../interfaces/IAICoin.sol";
import {IAICRegistry} from "../interfaces/IAICRegistry.sol";
import {ILicenseToken, LicenseKind, TokenSavingDeclaration, DeclarationBasis} from "../interfaces/ILicenseToken.sol";
import {IProtocolTreasury, FeeType} from "../interfaces/IProtocolTreasury.sol";
import {ProtocolConstants} from "../libraries/ProtocolConstants.sol";

/**
 * @title StoreBase
 * @notice Shared commerce, accounting, reward-pool, governance-lock and controller logic
 *         for the canonical Sales and Rentals stores.
 *
 * @dev Accounting model (MASTER_PLAN 0.20, 0.25.D). Every canonical payment is split at
 *      settlement time, never recomputed later from a drainable balance:
 *
 *          gross
 *            -> commerceProtocolFee   (forwarded immediately to ProtocolTreasury)
 *            -> storeNetCommerce
 *                 -> mandatoryHolderReserve  (5% of net; NOT withdrawable by the controller)
 *                 -> ownerAvailable          (the remainder)
 *
 *      Conservation invariants proven by the property tests:
 *          lifetimeNetCommerce == lifetimeOwnerAvailableAccrued + lifetimeHolderReserveAccrued
 *          lifetimeHolderReserveAccrued == unfinalizedHolderReserve + lifetimeHolderReserveCommitted
 *          usdc.balanceOf(store) >= ownerAvailable + unfinalizedHolderReserve
 *
 *      Governance lock (0.28.B, 0.29.C). While any passed proposal is unresolved, EVERY
 *      controller-benefiting value-out path is blocked, not merely a function called
 *      `withdraw`. The complete enumeration of value-moving paths in this contract is:
 *          withdrawOwnerProceeds, withdrawRewardPool, transferController, rescueToken.
 *      There is deliberately no arbitrary call, no delegatecall, no worker-payment path,
 *      no mutable fee recipient and no per-product payment recipient, so no indirect
 *      controller payout route exists to block.
 */
interface IBuyback {
    function buybackAndBurn(address aicToken, uint256 usdcAmount) external returns (uint256 burned);
}

abstract contract StoreBase is IStore, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ----------------------------------------------------------------- types
    struct Product {
        bytes32 productId;
        uint64 version;
        uint128 priceUSDC;
        uint64 inventory;
        uint32 rentalPeriodSeconds;
        bool active;
        bool exists;
        bytes32 contentHash;
        string metadataURI;
        /// @dev Unverified seller claim about the inference cost this product replaces. [14A.1]
        TokenSavingDeclaration declaration;
    }

    /// @notice Sentinel inventory value meaning "unlimited supply".
    uint64 internal constant UNLIMITED_INVENTORY = type(uint64).max;
    /// @notice Bound on per-transaction units, which also bounds the reward decay loop.
    uint256 internal constant MAX_UNITS_PER_PURCHASE = 365;

    // ------------------------------------------------ set once at initialize
    bytes32 private _storeId;
    address private _registry;
    address private _usdc;
    address private _aicToken;
    address private _storeCreator;
    address private _factory;
    bool private _initialized;

    // ------------------------------------------------------------ wired once
    address private _licenseToken;
    address private _governance;
    address private _dividendDistributor;
    bool private _wired;

    // ------------------------------------------------------------ controller
    address private _storeController;
    uint64 private _ownershipEpoch;
    StoreStatus private _status;

    // ------------------------------------------------------------ accounting
    uint256 private _ownerAvailableUSDC;
    uint256 private _unfinalizedHolderReserveUSDC;
    uint256 private _lifetimeGrossCommerceUSDC;
    uint256 private _lifetimeProtocolFeeUSDC;
    uint256 private _lifetimeNetCommerceUSDC;
    uint256 private _lifetimeHolderReserveAccruedUSDC;
    uint256 private _lifetimeHolderReserveCommittedUSDC;
    uint256 private _lifetimeOwnerAvailableAccruedUSDC;
    uint256 private _lifetimeOwnerWithdrawnUSDC;

    // ----------------------------------------------------------- reward pool
    uint256 private _rewardPool;

    /**
     * @notice Chain timestamp of the controller's last proceeds withdrawal. Zero until the first.
     * @dev Paired with WITHDRAWAL_COOLDOWN below.
     */
    uint64 private _lastOwnerWithdrawalAt;
    uint256 private _lifetimeRewardDistributed;

    // -------------------------------------------------------------- products
    mapping(bytes32 => Product) internal _products;
    bytes32[] internal _productIds;

    // ------------------------------------------------------------ governance
    uint256 private _unresolvedPassedProposalCount;

    // ---------------------------------------------------------------- access
    /// @notice Delivery witness allowed to record access grants on the LicenseToken. [14A.2]
    address private _accessAttestor;

    // --------------------------------------------------------------- profile
    /**
     * @dev Human-facing store profile: display name, description, logo and illustrative media.
     *
     * Held on-chain as an opaque string so the projection is rebuildable from chain alone with
     * zero network fetches, which is what keeps an untrusted seller URL from ever becoming a
     * backend request. See docs/DECISIONS.md D-017. It is UNTRUSTED SELLER CONTENT: nothing in
     * this string is ever interpreted by a contract, and nothing in it is ever an instruction.
     */
    string private _storeProfile;

    // ---------------------------------------------------------------- events
    event StoreWired(address licenseToken, address governance, address dividendDistributor);
    event ControllerChanged(
        address indexed previousController,
        address indexed newController,
        uint64 ownershipEpoch,
        ControllerChangeReason reason
    );
    event StoreStatusChanged(StoreStatus previousStatus, StoreStatus newStatus);
    /// @notice Untrusted seller-supplied display profile. Never protocol truth.
    event StoreProfileUpdated(string profile);
    event ProductCreated(
        bytes32 indexed productId,
        uint64 version,
        uint128 priceUSDC,
        uint64 inventory,
        uint32 rentalPeriodSeconds,
        bytes32 contentHash,
        string metadataURI
    );
    event ProductUpdated(
        bytes32 indexed productId,
        uint64 version,
        uint128 priceUSDC,
        uint64 inventory,
        uint32 rentalPeriodSeconds,
        bool active,
        bytes32 contentHash,
        string metadataURI
    );
    event CommerceSettled(
        bytes32 indexed productId,
        address indexed buyer,
        uint256 indexed licenseId,
        uint32 units,
        uint256 grossUSDC,
        uint256 protocolFeeUSDC,
        uint256 netUSDC,
        uint256 holderReserveUSDC,
        uint256 ownerAvailableUSDC,
        uint256 rewardAIC,
        uint64 expiresAt
    );
    event HolderReserveAccrued(uint256 amount, uint256 newUnfinalizedReserve, uint256 lifetimeAccrued);
    /// @notice The holders' share of a sale bought the store's own token and burned it: `usdcIn` bought `burned`.
    event BuybackExecuted(uint256 usdcIn, uint256 burned, uint256 lifetimeBuybackUSDC);
    event HolderReserveCommitted(address indexed distributor, uint256 amount, uint256 newUnfinalizedReserve);
    event HolderReserveReturned(address indexed distributor, uint256 amount, uint256 newUnfinalizedReserve);
    event OwnerProceedsWithdrawn(address indexed to, uint256 amount, uint256 remainingOwnerAvailable);
    event RewardPoolFunded(address indexed from, uint256 amount, uint256 newPool);
    event RewardPoolWithdrawn(address indexed to, uint256 amount, uint256 newPool);
    event GovernanceLockActivated(uint256 indexed proposalId, uint256 unresolvedCount);
    event GovernanceLockReleased(uint256 indexed proposalId, uint256 unresolvedCount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event AccessAttestorChanged(address indexed previousAttestor, address indexed newAttestor);
    event TokenSavingDeclared(
        bytes32 indexed productId,
        uint64 version,
        uint64 declaredTokensSaved,
        bytes32 declaredModelTier,
        DeclarationBasis basis,
        uint64 declaredAt
    );

    // ---------------------------------------------------------------- errors
    error NotController();
    error NotFactory();
    error NotGovernance();
    error NotDistributor();
    error NotAicToken();
    error AlreadyWired();
    error NotWired();
    error GovernanceLocked();
    error StoreNotActive();
    error CommercePaused();
    error ProductExists();
    error UnknownProduct();
    error ProductInactive();
    error ProductVersionMismatch(uint64 expected, uint64 actual);
    error PriceAboveMaximum(uint256 total, uint256 maximum);
    error InsufficientInventory(uint64 available, uint64 requested);
    error InvalidUnits();
    error InsufficientOwnerBalance(uint256 requested, uint256 available);
    error InsufficientRewardPool(uint256 requested, uint256 available);
    error ProtectedToken();
    error ZeroAddress();
    error UriTooLong();
    error ZeroPrice();
    error PriceBelowMinimum(uint256 price, uint256 minimum);
    error AlreadyInitialized();
    error InvalidDeclaration();

    /// @dev Deployed once as an implementation and cloned per store (EIP-1167). [0.25.P]
    constructor() {
        _initialized = true;
    }

    function initialize(bytes32 storeId_, address registry_, address usdc_, address aicToken_, address storeCreator_)
        external
    {
        if (_initialized) revert AlreadyInitialized();
        if (registry_ == address(0) || usdc_ == address(0) || aicToken_ == address(0) || storeCreator_ == address(0)) {
            revert ZeroAddress();
        }
        _initialized = true;
        _storeId = storeId_;
        _registry = registry_;
        _usdc = usdc_;
        _aicToken = aicToken_;
        _storeCreator = storeCreator_;
        _factory = msg.sender;
        _storeController = storeCreator_;
        _ownershipEpoch = 1;
        _status = StoreStatus.Active;
    }

    // ============================================================== wiring ==

    function wire(address licenseToken_, address governance_, address dividendDistributor_) external {
        if (msg.sender != _factory) revert NotFactory();
        if (_wired) revert AlreadyWired();
        if (licenseToken_ == address(0) || governance_ == address(0) || dividendDistributor_ == address(0)) {
            revert ZeroAddress();
        }
        _licenseToken = licenseToken_;
        _governance = governance_;
        _dividendDistributor = dividendDistributor_;
        _wired = true;
        emit StoreWired(licenseToken_, governance_, dividendDistributor_);
    }

    // ============================================================ modifiers ==

    modifier onlyController() {
        if (msg.sender != _storeController) revert NotController();
        _;
    }

    /// @dev Blocks every controller-benefiting value-out path while governance is unresolved.
    modifier notGovernanceLocked() {
        if (_unresolvedPassedProposalCount != 0) revert GovernanceLocked();
        _;
    }

    modifier whenCommerceAllowed() {
        if (_status != StoreStatus.Active) revert StoreNotActive();
        if (IAICRegistry(_registry).isPaused(keccak256("PAUSE_COMMERCE"))) revert CommercePaused();
        _;
    }

    // ============================================================= identity ==

    function storeId() public view returns (bytes32) {
        return _storeId;
    }

    function storeType() public view virtual returns (StoreType);

    function storeCreator() external view returns (address) {
        return _storeCreator;
    }

    function storeController() public view returns (address) {
        return _storeController;
    }

    function ownershipEpoch() external view returns (uint64) {
        return _ownershipEpoch;
    }

    function status() external view returns (StoreStatus) {
        return _status;
    }

    function factory() external view returns (address) {
        return _factory;
    }

    function aicToken() public view returns (address) {
        return _aicToken;
    }

    function licenseToken() public view returns (address) {
        return _licenseToken;
    }

    function governance() public view returns (address) {
        return _governance;
    }

    function dividendDistributor() public view returns (address) {
        return _dividendDistributor;
    }

    function registry() public view returns (address) {
        return _registry;
    }

    function usdc() public view returns (address) {
        return _usdc;
    }

    // =========================================================== accounting ==

    function ownerAvailableUSDC() external view returns (uint256) {
        return _ownerAvailableUSDC;
    }

    function unfinalizedHolderReserveUSDC() external view returns (uint256) {
        return _unfinalizedHolderReserveUSDC;
    }

    function lifetimeGrossCommerceUSDC() external view returns (uint256) {
        return _lifetimeGrossCommerceUSDC;
    }

    function lifetimeProtocolFeeUSDC() external view returns (uint256) {
        return _lifetimeProtocolFeeUSDC;
    }

    function lifetimeNetCommerceUSDC() external view returns (uint256) {
        return _lifetimeNetCommerceUSDC;
    }

    function lifetimeHolderReserveAccruedUSDC() external view returns (uint256) {
        return _lifetimeHolderReserveAccruedUSDC;
    }

    function lifetimeHolderReserveCommittedUSDC() external view returns (uint256) {
        return _lifetimeHolderReserveCommittedUSDC;
    }

    function lifetimeOwnerAvailableAccruedUSDC() external view returns (uint256) {
        return _lifetimeOwnerAvailableAccruedUSDC;
    }

    function lifetimeOwnerWithdrawnUSDC() external view returns (uint256) {
        return _lifetimeOwnerWithdrawnUSDC;
    }

    function rewardPool() public view returns (uint256) {
        return _rewardPool;
    }

    function lifetimeRewardDistributed() external view returns (uint256) {
        return _lifetimeRewardDistributed;
    }

    // =========================================================== governance ==

    function unresolvedPassedProposalCount() external view returns (uint256) {
        return _unresolvedPassedProposalCount;
    }

    function governanceLockActive() public view returns (bool) {
        return _unresolvedPassedProposalCount != 0;
    }

    function onGovernanceProposalPassed(uint256 proposalId) external {
        if (msg.sender != _governance) revert NotGovernance();
        _unresolvedPassedProposalCount += 1;
        emit GovernanceLockActivated(proposalId, _unresolvedPassedProposalCount);
    }

    function onGovernanceProposalResolved(uint256 proposalId) external {
        if (msg.sender != _governance) revert NotGovernance();
        // The governance contract transitions each proposal at most once, so this cannot
        // underflow; the explicit guard makes the invariant testable rather than implicit.
        require(_unresolvedPassedProposalCount > 0, "Store: lock underflow");
        _unresolvedPassedProposalCount -= 1;
        emit GovernanceLockReleased(proposalId, _unresolvedPassedProposalCount);
    }

    // ============================================================ controller ==

    /**
     * @notice Voluntary controller transfer. Blocked while a governance obligation is open.
     * @dev Cannot withdraw or redirect holder reserve, cannot reset distribution epochs and
     *      cannot change the canonical AIC. It bumps the ownership epoch so every stale
     *      backend session of the previous controller becomes invalid immediately. [0.21.F]
     */
    function transferController(address newController)
        external
        onlyController
        notGovernanceLocked
        nonReentrant
    {
        if (newController == address(0)) revert ZeroAddress();
        _setController(newController, ControllerChangeReason.VoluntaryTransfer);
    }

    /**
     * @notice Install the verified largest eligible EOA holder as controller.
     * @dev Only the canonical AIC token may call, and only after it has itself verified
     *      leadership and the continuous one-hour observation period. A governance lock does
     *      NOT block takeover: the unresolved obligation simply follows the store to the new
     *      controller. [0.29.J]
     */
    function onHolderTakeover(address newController) external {
        if (msg.sender != _aicToken) revert NotAicToken();
        if (newController == address(0)) revert ZeroAddress();
        _setController(newController, ControllerChangeReason.HolderTakeover);
    }

    function _setController(address newController, ControllerChangeReason reason) private {
        address previous = _storeController;
        _storeController = newController;
        _ownershipEpoch += 1;
        emit ControllerChanged(previous, newController, _ownershipEpoch, reason);
        IAICRegistry(_registry).recordControllerChange(_storeId, newController, uint8(reason));
    }

    /**
     * @notice Set the delivery witness allowed to record access grants on the LicenseToken.
     * @dev Allowed during a governance lock because it moves no value: the attestor can only
     *      witness a delivery that already happened. It can never signal, mint or transfer.
     *      [14A.2]
     */
    function setAccessAttestor(address attestor) external onlyController nonReentrant {
        emit AccessAttestorChanged(_accessAttestor, attestor);
        _accessAttestor = attestor;
    }

    function accessAttestor() external view returns (address) {
        return _accessAttestor;
    }

    /**
     * @notice Publish the store's display profile: name, description, logo and media.
     * @dev Deliberately NOT gated by `notGovernanceLocked`. Publishing a description moves no
     *      value out of the store, and a locked controller must still be able to make the
     *      changes a passed proposal asks for. [MASTER_PLAN 0.29 / 11.6]
     * @param profile Opaque, untrusted seller string. The protocol never parses it.
     */
    function setStoreProfile(string calldata profile) external onlyController nonReentrant {
        if (bytes(profile).length > ProtocolConstants.MAX_STORE_PROFILE_LENGTH) revert UriTooLong();
        _storeProfile = profile;
        emit StoreProfileUpdated(profile);
    }

    function storeProfile() external view returns (string memory) {
        return _storeProfile;
    }

    /// @notice Pause or deprecate the store. Deprecation never strands reserve or licenses.
    function setStatus(StoreStatus newStatus) external onlyController nonReentrant {
        StoreStatus previous = _status;
        _status = newStatus;
        emit StoreStatusChanged(previous, newStatus);
    }

    // ============================================================== products ==

    function productCount() external view returns (uint256) {
        return _productIds.length;
    }

    function productIdAt(uint256 index) external view returns (bytes32) {
        return _productIds[index];
    }

    function getProduct(bytes32 productId) external view returns (Product memory) {
        Product memory p = _products[productId];
        if (!p.exists) revert UnknownProduct();
        return p;
    }

    /**
     * @notice Create a product. Allowed during a governance lock because implementing an
     *         approved proposal may require it. [0.29.B]
     * @dev There is no seller-controlled payment recipient: settlement always runs through
     *      this contract, so a "special" product can never bypass the protocol fee, the
     *      mandatory holder reserve or the governance withdrawal lock. [0.29.N]
     */
    function createProduct(
        bytes32 productId,
        uint128 priceUSDC,
        uint64 inventory,
        uint32 rentalPeriodSeconds,
        bytes32 contentHash,
        string calldata metadataURI,
        TokenSavingDeclaration calldata declaration
    ) external onlyController nonReentrant {
        if (productId == bytes32(0)) revert UnknownProduct();
        if (_products[productId].exists) revert ProductExists();
        if (priceUSDC == 0) revert ZeroPrice();
        if (priceUSDC < ProtocolConstants.MIN_PRODUCT_PRICE_USDC) revert PriceBelowMinimum(priceUSDC, ProtocolConstants.MIN_PRODUCT_PRICE_USDC);
        if (bytes(metadataURI).length > ProtocolConstants.MAX_METADATA_URI_LENGTH) revert UriTooLong();
        _validateRentalPeriod(rentalPeriodSeconds);

        TokenSavingDeclaration memory decl = _normalizeDeclaration(declaration);

        _products[productId] = Product({
            productId: productId,
            version: 1,
            priceUSDC: priceUSDC,
            inventory: inventory,
            rentalPeriodSeconds: rentalPeriodSeconds,
            active: true,
            exists: true,
            contentHash: contentHash,
            metadataURI: metadataURI,
            declaration: decl
        });
        _productIds.push(productId);

        emit ProductCreated(productId, 1, priceUSDC, inventory, rentalPeriodSeconds, contentHash, metadataURI);
        emit TokenSavingDeclared(productId, 1, decl.tokensSaved, decl.modelTier, decl.basis, decl.declaredAt);
    }

    /**
     * @dev Validates a seller declaration and stamps its chain timestamp. The contract never
     *      computes, infers or improves the values; it only rejects internally inconsistent
     *      ones so an Agent cannot be shown a half declaration. [14A.1]
     */
    function _normalizeDeclaration(TokenSavingDeclaration calldata declaration)
        private
        view
        returns (TokenSavingDeclaration memory)
    {
        // Every product version declares the model tokens building it took; an undeclared listing is refused.
        if (declaration.basis == DeclarationBasis.Undeclared) revert InvalidDeclaration();
        if (declaration.tokensSaved == 0 || declaration.modelTier == bytes32(0)) revert InvalidDeclaration();
        return TokenSavingDeclaration(
            declaration.tokensSaved, declaration.modelTier, declaration.basis, uint64(block.timestamp)
        );
    }

    /**
     * @notice Update a product. Every update bumps `version`, which invalidates outstanding
     *         quotes bound to the previous version. [0.24.H]
     */
    function updateProduct(
        bytes32 productId,
        uint128 priceUSDC,
        uint64 inventory,
        uint32 rentalPeriodSeconds,
        bool active,
        bytes32 contentHash,
        string calldata metadataURI,
        TokenSavingDeclaration calldata declaration
    ) external onlyController nonReentrant {
        Product storage p = _products[productId];
        if (!p.exists) revert UnknownProduct();
        if (priceUSDC == 0) revert ZeroPrice();
        if (priceUSDC < ProtocolConstants.MIN_PRODUCT_PRICE_USDC) revert PriceBelowMinimum(priceUSDC, ProtocolConstants.MIN_PRODUCT_PRICE_USDC);
        if (bytes(metadataURI).length > ProtocolConstants.MAX_METADATA_URI_LENGTH) revert UriTooLong();
        _validateRentalPeriod(rentalPeriodSeconds);

        TokenSavingDeclaration memory decl = _normalizeDeclaration(declaration);

        // Every update bumps the version, which is what makes a declaration immutable for the
        // life of a version and lets a historical purchase keep the claim it was sold under.
        p.version += 1;
        p.priceUSDC = priceUSDC;
        p.inventory = inventory;
        p.rentalPeriodSeconds = rentalPeriodSeconds;
        p.active = active;
        p.contentHash = contentHash;
        p.metadataURI = metadataURI;
        p.declaration = decl;

        emit ProductUpdated(
            productId, p.version, priceUSDC, inventory, rentalPeriodSeconds, active, contentHash, metadataURI
        );
        emit TokenSavingDeclared(
            productId, p.version, decl.tokensSaved, decl.modelTier, decl.basis, decl.declaredAt
        );
    }

    function _validateRentalPeriod(uint32 rentalPeriodSeconds) internal view virtual;

    // ============================================================ settlement ==

    struct Settlement {
        uint256 gross;
        uint256 protocolFee;
        uint256 net;
        uint256 holderReserve;
        uint256 ownerAvailable;
    }

    /**
     * @notice Pure preview of the canonical payment waterfall for a gross USDC amount.
     * @dev Rounding direction is a security property, not a detail. The protocol fee and the
     *      mandatory holder reserve round UP; only the controller-available remainder absorbs
     *      the dust. Flooring both would let a seller price a product low enough that each
     *      individual sale rounds the fee and the 5% holder reserve to zero, so splitting one
     *      sale into many identical micro-sales would extract more value than the single
     *      equivalent sale and would pay holders nothing. Rounding the protected amounts up
     *      makes splitting strictly worse for the controller, which is exactly the property
     *      MASTER_PLAN 0.21.Q and 0.25.I require. Found by the split-purchase property test.
     */
    function previewSettlement(uint256 gross) public view returns (Settlement memory s) {
        s.gross = gross;
        uint16 feeBps = IAICRegistry(_registry).commerceFeeBps();
        s.protocolFee = _ceilBps(gross, feeBps);
        s.net = gross - s.protocolFee;
        s.holderReserve = _ceilBps(s.net, ProtocolConstants.HOLDER_RESERVE_BPS);
        s.ownerAvailable = s.net - s.holderReserve;
    }

    /// @dev ceil(amount * bps / 10000), saturating at `amount` so a share can never exceed the whole.
    function _ceilBps(uint256 amount, uint16 bps) internal pure returns (uint256 result) {
        if (amount == 0 || bps == 0) return 0;
        result = (amount * bps + ProtocolConstants.BPS_DENOMINATOR - 1) / ProtocolConstants.BPS_DENOMINATOR;
        if (result > amount) result = amount;
    }

    /**
     * @dev Pulls `gross` USDC from the buyer and splits it. Reentrancy-safe: all state is
     *      written before the outbound protocol fee transfer.
     */
    function _settle(address buyer, uint256 gross) internal returns (Settlement memory s) {
        s = previewSettlement(gross);

        IERC20(_usdc).safeTransferFrom(buyer, address(this), gross);

        _lifetimeGrossCommerceUSDC += s.gross;
        _lifetimeProtocolFeeUSDC += s.protocolFee;
        _lifetimeNetCommerceUSDC += s.net;
        _lifetimeHolderReserveAccruedUSDC += s.holderReserve;
        _lifetimeOwnerAvailableAccruedUSDC += s.ownerAvailable;
        _ownerAvailableUSDC += s.ownerAvailable;

        /*
         * The holders' share becomes a buyback, in this same transaction: it buys this store's own token
         * on its market (the bonding curve, or the external pool after graduation) and burns it. The same
         * money as the old holder reserve, delivered as a permanently smaller supply — nothing to hold
         * back, distribute or claim. `_unfinalizedHolderReserveUSDC` therefore stays zero.
         */
        if (s.holderReserve > 0) {
            address shop = IAICRegistry(_registry).agentGoods();
            IERC20(_usdc).forceApprove(shop, s.holderReserve);
            uint256 burned = IBuyback(shop).buybackAndBurn(_aicToken, s.holderReserve);
            IERC20(_usdc).forceApprove(shop, 0);
            emit BuybackExecuted(s.holderReserve, burned, _lifetimeHolderReserveAccruedUSDC);
        }

        if (s.protocolFee > 0) {
            address treasury = IAICRegistry(_registry).protocolTreasury();
            IERC20(_usdc).safeTransfer(treasury, s.protocolFee);
            IProtocolTreasury(treasury).recordRevenue(
                storeType() == StoreType.Sales ? FeeType.COMMERCE_SALE : FeeType.COMMERCE_RENTAL,
                _usdc,
                address(this),
                s.protocolFee
            );
        }
    }

    // ========================================================= reward pool ==

    /**
     * @notice Fund the optional customer AIC incentive pool with already-acquired AIC.
     * @dev The pool must be backed by real transferred AIC. There is no mint path and no
     *      free founder allocation: the controller has to buy AIC on the market first.
     *      [12A.3]
     */
    function depositRewardPool(uint256 amount) external nonReentrant returns (uint256) {
        if (IAICRegistry(_registry).isPaused(keccak256("PAUSE_REWARD_DEPOSIT"))) revert CommercePaused();
        if (amount == 0) revert InvalidUnits();

        uint256 before = IERC20(_aicToken).balanceOf(address(this));
        IERC20(_aicToken).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(_aicToken).balanceOf(address(this)) - before;

        _rewardPool += received;
        emit RewardPoolFunded(msg.sender, received, _rewardPool);
        return _rewardPool;
    }

    /// @notice Withdraw uncommitted reward AIC. Blocked while a governance obligation is open.
    function withdrawRewardPool(uint256 amount, address to)
        external
        onlyController
        notGovernanceLocked
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount > _rewardPool) revert InsufficientRewardPool(amount, _rewardPool);
        _rewardPool -= amount;
        IERC20(_aicToken).safeTransfer(to, amount);
        emit RewardPoolWithdrawn(to, amount, _rewardPool);
    }

    /// @notice Per-unit reward rate in basis points of the remaining pool. Differs per store type.
    function rewardRateBps() public pure virtual returns (uint256);

    /// @notice Reward denominator, which together with the rate expresses the exact V0 fraction.
    function rewardRateDenominator() public pure virtual returns (uint256);

    /// @notice Minimum remaining pool (in AIC base units) below which no reward is paid.
    function rewardMinimumPool() public pure virtual returns (uint256);

    /// @notice Additional gate on the total pool before any reward is computed.
    function rewardPoolGate() public pure virtual returns (uint256);

    /**
     * @notice Deterministic preview of the AIC incentive for `units` at the current pool.
     * @dev This is the exact integer algorithm the purchase path executes, so the Agent
     *      preview and the contract result are identical for unchanged state. The pool decays
     *      geometrically WITHIN a multi-unit purchase, which is the intended V0 model (the V0
     *      Sales contract computed the decayed pool but then ignored it - see
     *      docs/AIC_INCENTIVE_MODEL.md). [15]
     */
    function previewReward(uint256 units) public view returns (uint256 totalReward) {
        uint256 pool = _rewardPool;
        if (pool <= rewardPoolGate()) return 0;
        if (units == 0 || units > MAX_UNITS_PER_PURCHASE) return 0;

        uint256 rate = rewardRateBps();
        uint256 denom = rewardRateDenominator();
        uint256 minPool = rewardMinimumPool();

        for (uint256 i = 0; i < units; i++) {
            if (pool < minPool) break;
            uint256 unitReward = (pool * rate) / denom;
            if (unitReward == 0) break;
            totalReward += unitReward;
            pool -= unitReward;
        }
    }

    /**
     * @dev Pays the computed incentive. The pool is reduced by exactly the transferred
     *      amount: V1 does NOT reproduce the V0 double reduction (transfer, then an
     *      equal burnFrom plus a second subtraction), which was unreachable in V0 because
     *      the token exposes no burn, and which would have made the pool accounting diverge
     *      from the AIC the contract actually holds. Documented in docs/DECISIONS.md.
     */
    function _payReward(address buyer, uint256 units) internal returns (uint256 reward) {
        reward = previewReward(units);
        if (reward == 0) return 0;
        if (reward > _rewardPool) reward = _rewardPool;

        _rewardPool -= reward;
        _lifetimeRewardDistributed += reward;
        IERC20(_aicToken).safeTransfer(buyer, reward);
    }

    // ============================================================ withdrawal ==

    /**
     * @notice Withdraw owner-available proceeds only.
     * @dev Cannot reach the mandatory holder reserve, committed distributions, protocol fees
     *      or reward escrow, because each of those lives in its own balance counter and this
     *      function is bounded by `_ownerAvailableUSDC`. [0.25.D]
     */
    /**
     * @notice Minimum time between controller withdrawals of store proceeds.
     *
     * @dev THREE HOURS, and the reason is economic rather than defensive.
     *
     *      A controller that can sweep proceeds the instant they land has no reason to ever open a
     *      dividend epoch: its own cash is always immediately available, while the holder reserve
     *      is somebody else's problem. Holders then wait on a distribution nobody has an incentive
     *      to open, and equity in a working store pays nothing in practice however much the store
     *      earns.
     *
     *      Spacing withdrawals changes that calculation. Between withdrawals the controller's cash
     *      is committed anyway, so opening an epoch costs it nothing it could otherwise have spent
     *      — and it is the action that makes its own token worth holding, which is what lets it
     *      raise capital and what makes a customer incentive paid in that token mean something.
     *
     *      It does NOT touch the money. Nothing is forfeited, nothing is redirected, and the
     *      balance keeps accruing while the timer runs; only the timing of access moves. The
     *      holder reserve was never withdrawable by the controller in the first place.
     */
    uint64 public constant WITHDRAWAL_COOLDOWN = 3 hours;

    /// @notice The controller withdrew too soon. `nextAllowedAt` is a chain timestamp.
    error WithdrawalTooSoon(uint64 lastWithdrawalAt, uint64 nextAllowedAt, uint64 nowTimestamp);

    /// @notice When the controller may next withdraw. Zero means "right now, never withdrawn".
    function nextOwnerWithdrawalAt() public view returns (uint64) {
        if (_lastOwnerWithdrawalAt == 0) return 0;
        return _lastOwnerWithdrawalAt + WITHDRAWAL_COOLDOWN;
    }

    /// @notice Seconds until the controller may withdraw again. Zero when it may withdraw now.
    function secondsUntilOwnerWithdrawal() external view returns (uint64) {
        uint64 next = nextOwnerWithdrawalAt();
        if (next == 0 || block.timestamp >= next) return 0;
        return next - uint64(block.timestamp);
    }

    function withdrawOwnerProceeds(uint256 amount, address to)
        external
        onlyController
        notGovernanceLocked
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();

        /*
         * The cooldown, checked before the balance.
         *
         * Ordered this way so a controller that is too early is told THAT, rather than being told
         * its balance is insufficient when the balance was never the problem.
         */
        uint64 next = nextOwnerWithdrawalAt();
        if (next != 0 && block.timestamp < next) {
            revert WithdrawalTooSoon(_lastOwnerWithdrawalAt, next, uint64(block.timestamp));
        }

        if (amount > _ownerAvailableUSDC) revert InsufficientOwnerBalance(amount, _ownerAvailableUSDC);
        _ownerAvailableUSDC -= amount;
        _lifetimeOwnerWithdrawnUSDC += amount;
        _lastOwnerWithdrawalAt = uint64(block.timestamp);
        IERC20(_usdc).safeTransfer(to, amount);
        emit OwnerProceedsWithdrawn(to, amount, _ownerAvailableUSDC);
    }

    // ============================================================= dividends ==

    /**
     * @notice Move accrued holder reserve into the distributor when an epoch opens.
     * @dev Permissionless in practice: the distributor exposes a permissionless open path, so
     *      an inactive or hostile controller cannot censor holder distributions. [0.21.A]
     */
    function commitHolderReserve(uint256 requested) external nonReentrant returns (uint256 committed) {
        if (msg.sender != _dividendDistributor) revert NotDistributor();
        committed = requested > _unfinalizedHolderReserveUSDC ? _unfinalizedHolderReserveUSDC : requested;
        if (committed == 0) return 0;

        _unfinalizedHolderReserveUSDC -= committed;
        _lifetimeHolderReserveCommittedUSDC += committed;
        IERC20(_usdc).safeTransfer(_dividendDistributor, committed);
        emit HolderReserveCommitted(_dividendDistributor, committed, _unfinalizedHolderReserveUSDC);
    }

    /// @notice Roll an abandoned epoch reserve back into the store so a later epoch can use it.
    function returnHolderReserve(uint256 amount) external nonReentrant {
        if (msg.sender != _dividendDistributor) revert NotDistributor();
        if (amount == 0) return;
        // The distributor sets an exact allowance immediately before this call.
        IERC20(_usdc).safeTransferFrom(_dividendDistributor, address(this), amount);
        _unfinalizedHolderReserveUSDC += amount;
        _lifetimeHolderReserveCommittedUSDC -= amount;
        emit HolderReserveReturned(_dividendDistributor, amount, _unfinalizedHolderReserveUSDC);
    }

    // ================================================================ rescue ==

    /**
     * @notice Recover a foreign token accidentally sent to the store.
     * @dev Deliberately cannot touch canonical USDC or canonical AIC, so it can never be used
     *      to extract customer payments, holder reserve or reward escrow. Also blocked while
     *      governance is locked so it cannot become an indirect controller payout. [0.19.G]
     */
    function rescueToken(address token, address to)
        external
        onlyController
        notGovernanceLocked
        nonReentrant
    {
        if (token == _usdc || token == _aicToken) revert ProtectedToken();
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) revert InvalidUnits();
        IERC20(token).safeTransfer(to, balance);
        emit TokenRescued(token, to, balance);
    }

    // ============================================================= internal ==

    function _consumeInventory(Product storage p, uint64 units) internal {
        if (p.inventory == UNLIMITED_INVENTORY) return;
        if (p.inventory < units) revert InsufficientInventory(p.inventory, units);
        p.inventory -= units;
    }

    function _requirePurchasable(bytes32 productId, uint64 expectedVersion)
        internal
        view
        returns (Product storage p)
    {
        p = _products[productId];
        if (!p.exists) revert UnknownProduct();
        if (!p.active) revert ProductInactive();
        if (p.version != expectedVersion) revert ProductVersionMismatch(expectedVersion, p.version);
    }

    function _mintLicense(
        address to,
        bytes32 productId,
        uint64 productVersion,
        uint64 expiresAt,
        uint32 units,
        LicenseKind kind,
        bytes32 permissionHash,
        string calldata uri
    ) internal returns (uint256) {
        return ILicenseToken(_licenseToken).mint(
            to, productId, productVersion, expiresAt, units, kind, permissionHash, uri
        );
    }
}
