// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IAICRegistry, StoreRecord, ContractRole} from "../interfaces/IAICRegistry.sol";
import {ProtocolConstants} from "../libraries/ProtocolConstants.sol";

/**
 * @title AICRegistry
 * @notice Canonical discovery, provenance and version-routing layer of the AIC protocol.
 *
 * @dev Upgradeable (UUPS) because it must be able to authorise future Factory generations
 *      and improve discovery metadata. MASTER_PLAN 0.16 / 0.19.E constrain that power:
 *
 *      - Canonical provenance is APPEND ONLY. There is no function, for any role, that can
 *        rewrite an existing store record, re-point a component to a different store, or
 *        change the role of an address that already has one. A malicious or buggy upgrade
 *        therefore cannot silently re-attribute historical provenance without an explicit,
 *        visible code change that the provenance replay tests will catch.
 *      - Only an authorised Factory can create a canonical record, and it may only record
 *        itself as the creating factory. A fake Factory cannot self-register.
 *      - Factory authorisation is checked at REGISTRATION time, not cached at Factory
 *        deployment, which closes the deprecation race of 0.19.H.
 *      - Registry upgrade is not store ownership: no role here can become a storeController.
 *        [0.19.J]
 */
contract AICRegistry is IAICRegistry, Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    // ------------------------------------------------------------------ roles
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant FACTORY_ADMIN_ROLE = keccak256("FACTORY_ADMIN_ROLE");
    bytes32 public constant FEE_ADMIN_ROLE = keccak256("FEE_ADMIN_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    /**
     * @notice The protocol's delivery witness: the access gateway that actually serves a buyer's
     *         bytes, and so the one party that knows a delivery happened.
     * @dev A buyer signal requires a recorded delivery. When only the store's own attestor could
     *      record one, the seller decided whether its buyers could ever rate it — a store with no
     *      attestor (the default) could not be rated at all. A holder of this role may record a
     *      delivery for any canonical store's licence, and no seller can revoke it. It can only
     *      witness: it cannot signal, mint, move value or change a signal. Role-based, so it adds
     *      no storage to this upgradeable contract. [14A.2]
     */
    bytes32 public constant DELIVERY_GATEWAY_ROLE = keccak256("DELIVERY_GATEWAY_ROLE");

    // ----------------------------------------------------------- pause scopes
    bytes32 public constant PAUSE_STORE_CREATION = keccak256("PAUSE_STORE_CREATION");
    bytes32 public constant PAUSE_COMMERCE = keccak256("PAUSE_COMMERCE");
    bytes32 public constant PAUSE_MARKET = keccak256("PAUSE_MARKET");
    bytes32 public constant PAUSE_REWARD_DEPOSIT = keccak256("PAUSE_REWARD_DEPOSIT");

    struct FactoryInfo {
        uint64 version;
        bool known;
        bool authorized;
        uint64 authorizedAtBlock;
        uint64 deprecatedAtBlock;
    }

    // -------------------------------------------------------------- storage
    uint256 private _chainId;
    address private _usdc;
    address private _agentGoods;
    address private _protocolTreasury;

    uint16 private _commerceFeeBps;
    uint16 private _dividendProcessingFeeBps;
    uint16 private _agentGoodsProtocolFeeBps;
    uint16 private _agentGoodsControllerFeeBps;
    /// @dev Dividend holding window in seconds. See ProtocolConstants.HOLDING_WINDOW_SECONDS.
    uint32 private _holdingWindowSeconds;

    mapping(address => FactoryInfo) private _factories;
    address[] private _knownFactories;

    mapping(bytes32 => StoreRecord) private _stores;
    bytes32[] private _storeIds;
    mapping(address => bytes32) private _storeIdByAddress;

    mapping(address => ContractRole) private _roles;
    mapping(address => bytes32) private _canonicalStoreOf;

    mapping(bytes32 => address) private _controllers;
    mapping(bytes32 => uint64) private _ownershipEpochs;

    mapping(bytes32 => bool) private _paused;

    /// @dev Reserved for future versions. Never reorder or shrink. [0.16 storage layout safety]
    uint256[40] private __gap;

    // --------------------------------------------------------------- events
    event RegistryInitialized(uint256 chainId, address usdc, address agentGoods, address treasury);
    event FactoryAuthorized(address indexed factory, uint64 version, uint256 atBlock);
    event FactoryDeprecated(address indexed factory, uint64 version, uint256 atBlock);
    event StoreRegistered(
        bytes32 indexed storeId,
        address indexed store,
        address indexed aicToken,
        address licenseToken,
        address governance,
        address dividendDistributor,
        address factory,
        uint64 factoryVersion,
        address storeCreator,
        uint8 storeType
    );
    event ControllerChanged(
        bytes32 indexed storeId,
        address indexed previousController,
        address indexed newController,
        uint64 ownershipEpoch,
        uint8 reason
    );
    event ProtocolFeeChanged(bytes32 indexed feeType, uint16 oldFeeBps, uint16 newFeeBps);
    event HoldingWindowChanged(uint32 previousSeconds, uint32 newSeconds);
    event AgentGoodsSet(address indexed previousAgentGoods, address indexed newAgentGoods);
    event TreasurySet(address indexed previousTreasury, address indexed newTreasury);
    event ScopePaused(bytes32 indexed scope, bool paused);

    // --------------------------------------------------------------- errors
    error ZeroAddress();
    error NotAuthorizedFactory();
    error FactoryMismatch();
    error StoreAlreadyRegistered(bytes32 storeId);
    error AddressAlreadyCanonical(address contractAddress);
    error UnknownStore(bytes32 storeId);
    error NotCanonicalStore();
    error FeeAboveCap(uint16 requested, uint16 cap);
    error HoldingWindowAboveCap(uint32 requested, uint32 cap);
    error FactoryAlreadyKnown();
    error InvalidRecord();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        uint256 chainId_,
        address usdc_,
        address admin_,
        address guardian_
    ) external initializer {
        if (usdc_ == address(0) || admin_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        __AccessControl_init();


        _chainId = chainId_;
        _usdc = usdc_;

        _commerceFeeBps = ProtocolConstants.COMMERCE_FEE_BPS;
        _dividendProcessingFeeBps = ProtocolConstants.DIVIDEND_PROCESSING_FEE_BPS;
        _agentGoodsProtocolFeeBps = ProtocolConstants.AGENTGOODS_PROTOCOL_FEE_BPS;
        _agentGoodsControllerFeeBps = ProtocolConstants.AGENTGOODS_CONTROLLER_FEE_BPS;
        _holdingWindowSeconds = ProtocolConstants.HOLDING_WINDOW_SECONDS;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(FACTORY_ADMIN_ROLE, admin_);
        _grantRole(FEE_ADMIN_ROLE, admin_);
        _grantRole(UPGRADER_ROLE, admin_);
        _grantRole(GUARDIAN_ROLE, guardian_);

        emit RegistryInitialized(chainId_, usdc_, address(0), address(0));
    }

    // ==================================================== configuration ====

    function chainIdentifier() external view returns (uint256) {
        return _chainId;
    }

    function usdc() external view returns (address) {
        return _usdc;
    }

    function agentGoods() external view returns (address) {
        return _agentGoods;
    }

    function protocolTreasury() external view returns (address) {
        return _protocolTreasury;
    }

    function commerceFeeBps() external view returns (uint16) {
        return _commerceFeeBps;
    }

    function dividendProcessingFeeBps() external view returns (uint16) {
        return _dividendProcessingFeeBps;
    }

    function agentGoodsProtocolFeeBps() external view returns (uint16) {
        return _agentGoodsProtocolFeeBps;
    }

    function agentGoodsControllerFeeBps() external view returns (uint16) {
        return _agentGoodsControllerFeeBps;
    }

    /// @notice The mandatory holder reserve rate is an invariant, exposed for schema generation.
    function holderReserveBps() external pure returns (uint16) {
        return ProtocolConstants.HOLDER_RESERVE_BPS;
    }

    function setAgentGoods(address agentGoods_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (agentGoods_ == address(0)) revert ZeroAddress();
        emit AgentGoodsSet(_agentGoods, agentGoods_);
        _agentGoods = agentGoods_;
        if (_roles[agentGoods_] == ContractRole.Unknown) {
            _roles[agentGoods_] = ContractRole.AgentGoods;
        }
    }

    function setProtocolTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasurySet(_protocolTreasury, treasury_);
        _protocolTreasury = treasury_;
        if (_roles[treasury_] == ContractRole.Unknown) {
            _roles[treasury_] = ContractRole.Treasury;
        }
    }

    /**
     * @notice Window over which a dividend entitlement weight is the account minimum balance.
     * @dev Read ONCE per epoch, at `openDistribution`, and stored on the epoch. Changing it can
     *      therefore never retroactively alter an epoch already in flight. [MASTER_PLAN 29C.5]
     */
    function holdingWindowSeconds() external view returns (uint32) {
        return _holdingWindowSeconds;
    }

    function setHoldingWindowSeconds(uint32 seconds_) external onlyRole(FEE_ADMIN_ROLE) {
        if (seconds_ > ProtocolConstants.MAX_HOLDING_WINDOW_SECONDS) {
            revert HoldingWindowAboveCap(seconds_, ProtocolConstants.MAX_HOLDING_WINDOW_SECONDS);
        }
        emit HoldingWindowChanged(_holdingWindowSeconds, seconds_);
        _holdingWindowSeconds = seconds_;
    }

    function setCommerceFeeBps(uint16 bps) external onlyRole(FEE_ADMIN_ROLE) {
        if (bps > ProtocolConstants.MAX_COMMERCE_FEE_BPS) {
            revert FeeAboveCap(bps, ProtocolConstants.MAX_COMMERCE_FEE_BPS);
        }
        emit ProtocolFeeChanged(keccak256("COMMERCE_FEE"), _commerceFeeBps, bps);
        _commerceFeeBps = bps;
    }

    function setDividendProcessingFeeBps(uint16 bps) external onlyRole(FEE_ADMIN_ROLE) {
        if (bps > ProtocolConstants.MAX_DIVIDEND_PROCESSING_FEE_BPS) {
            revert FeeAboveCap(bps, ProtocolConstants.MAX_DIVIDEND_PROCESSING_FEE_BPS);
        }
        emit ProtocolFeeChanged(keccak256("DIVIDEND_PROCESSING_FEE"), _dividendProcessingFeeBps, bps);
        _dividendProcessingFeeBps = bps;
    }

    function setAgentGoodsFeesBps(uint16 protocolBps, uint16 controllerBps) external onlyRole(FEE_ADMIN_ROLE) {
        if (protocolBps > ProtocolConstants.MAX_AGENTGOODS_PROTOCOL_FEE_BPS) {
            revert FeeAboveCap(protocolBps, ProtocolConstants.MAX_AGENTGOODS_PROTOCOL_FEE_BPS);
        }
        if (controllerBps > ProtocolConstants.MAX_AGENTGOODS_CONTROLLER_FEE_BPS) {
            revert FeeAboveCap(controllerBps, ProtocolConstants.MAX_AGENTGOODS_CONTROLLER_FEE_BPS);
        }
        emit ProtocolFeeChanged(keccak256("AGENTGOODS_PROTOCOL_FEE"), _agentGoodsProtocolFeeBps, protocolBps);
        emit ProtocolFeeChanged(keccak256("AGENTGOODS_CONTROLLER_FEE"), _agentGoodsControllerFeeBps, controllerBps);
        _agentGoodsProtocolFeeBps = protocolBps;
        _agentGoodsControllerFeeBps = controllerBps;
    }

    // ========================================================== factories ====

    function authorizeFactory(address factory, uint64 version) external onlyRole(FACTORY_ADMIN_ROLE) {
        if (factory == address(0)) revert ZeroAddress();
        FactoryInfo storage info = _factories[factory];
        if (info.known) revert FactoryAlreadyKnown();

        info.known = true;
        info.authorized = true;
        info.version = version;
        info.authorizedAtBlock = uint64(block.number);
        _knownFactories.push(factory);
        _roles[factory] = ContractRole.Factory;

        emit FactoryAuthorized(factory, version, block.number);
    }

    /**
     * @notice Stop a Factory generation from creating NEW canonical stores.
     * @dev Historical provenance is untouched: a deprecated Factory remains a valid,
     *      known, canonical historical creator. Deprecated is not scam. [0.27.F]
     */
    function deprecateFactory(address factory) external {
        if (!hasRole(FACTORY_ADMIN_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert NotAuthorizedFactory();
        }
        FactoryInfo storage info = _factories[factory];
        if (!info.known) revert NotAuthorizedFactory();
        info.authorized = false;
        info.deprecatedAtBlock = uint64(block.number);
        emit FactoryDeprecated(factory, info.version, block.number);
    }

    function isAuthorizedFactory(address factory) public view returns (bool) {
        return _factories[factory].authorized;
    }

    function isFactoryKnown(address factory) external view returns (bool) {
        return _factories[factory].known;
    }

    function factoryVersion(address factory) external view returns (uint64) {
        return _factories[factory].version;
    }

    function factoryInfo(address factory) external view returns (FactoryInfo memory) {
        return _factories[factory];
    }

    function knownFactoryCount() external view returns (uint256) {
        return _knownFactories.length;
    }

    function knownFactoryAt(uint256 index) external view returns (address) {
        return _knownFactories[index];
    }

    // ======================================================== registration ====

    /**
     * @notice Record a canonical store and its component set. Append only.
     * @dev Called by an authorised Factory inside the atomic creation transaction. Every
     *      component address must be previously unknown, which makes component substitution
     *      and duplicate registration impossible. [0.15, 0.18]
     */
    function registerStore(StoreRecord calldata record) external {
        if (!isAuthorizedFactory(msg.sender)) revert NotAuthorizedFactory();
        if (record.factory != msg.sender) revert FactoryMismatch();
        if (_paused[PAUSE_STORE_CREATION]) revert InvalidRecord();

        if (record.storeId == bytes32(0)) revert InvalidRecord();
        if (_stores[record.storeId].exists) revert StoreAlreadyRegistered(record.storeId);

        if (
            record.store == address(0) || record.aicToken == address(0) || record.licenseToken == address(0)
                || record.governance == address(0) || record.dividendDistributor == address(0)
                || record.storeCreator == address(0)
        ) revert InvalidRecord();

        _claimRole(record.store, ContractRole.Store, record.storeId);
        _claimRole(record.aicToken, ContractRole.AicToken, record.storeId);
        _claimRole(record.licenseToken, ContractRole.LicenseToken, record.storeId);
        _claimRole(record.governance, ContractRole.Governance, record.storeId);
        _claimRole(record.dividendDistributor, ContractRole.DividendDistributor, record.storeId);

        StoreRecord memory stored = record;
        stored.factoryVersion = _factories[msg.sender].version;
        stored.createdBlock = uint64(block.number);
        stored.exists = true;

        _stores[record.storeId] = stored;
        _storeIds.push(record.storeId);
        _storeIdByAddress[record.store] = record.storeId;

        _controllers[record.storeId] = record.storeCreator;
        _ownershipEpochs[record.storeId] = 1;

        emit StoreRegistered(
            record.storeId,
            record.store,
            record.aicToken,
            record.licenseToken,
            record.governance,
            record.dividendDistributor,
            msg.sender,
            stored.factoryVersion,
            record.storeCreator,
            uint8(record.storeType)
        );
        emit ControllerChanged(record.storeId, address(0), record.storeCreator, 1, 0);
    }

    function _claimRole(address target, ContractRole role, bytes32 storeId_) private {
        if (_roles[target] != ContractRole.Unknown) revert AddressAlreadyCanonical(target);
        _roles[target] = role;
        _canonicalStoreOf[target] = storeId_;
    }

    // =========================================================== lookups ====

    function getStore(bytes32 storeId_) external view returns (StoreRecord memory) {
        StoreRecord memory record = _stores[storeId_];
        if (!record.exists) revert UnknownStore(storeId_);
        return record;
    }

    function storeExists(bytes32 storeId_) external view returns (bool) {
        return _stores[storeId_].exists;
    }

    function storeIdOf(address storeAddress) external view returns (bytes32) {
        return _storeIdByAddress[storeAddress];
    }

    function roleOf(address contractAddress) external view returns (ContractRole) {
        return _roles[contractAddress];
    }

    function isCanonical(address contractAddress) external view returns (bool) {
        return _roles[contractAddress] != ContractRole.Unknown;
    }

    function canonicalStoreOf(address contractAddress) external view returns (bytes32) {
        return _canonicalStoreOf[contractAddress];
    }

    function storeCount() external view returns (uint256) {
        return _storeIds.length;
    }

    function storeIdAt(uint256 index) external view returns (bytes32) {
        return _storeIds[index];
    }

    // ======================================================== controller ====

    function storeController(bytes32 storeId_) external view returns (address) {
        return _controllers[storeId_];
    }

    function ownershipEpoch(bytes32 storeId_) external view returns (uint64) {
        return _ownershipEpochs[storeId_];
    }

    /**
     * @notice Mirror a controller change that the canonical Store has already validated.
     * @dev Only the canonical Store contract of that storeId may call. No admin, guardian
     *      or upgrader path exists that can set a controller. [0.19.J]
     */
    function recordControllerChange(bytes32 storeId_, address newController, uint8 reason) external {
        StoreRecord storage record = _stores[storeId_];
        if (!record.exists) revert UnknownStore(storeId_);
        if (msg.sender != record.store) revert NotCanonicalStore();
        if (newController == address(0)) revert ZeroAddress();

        address previous = _controllers[storeId_];
        _controllers[storeId_] = newController;
        uint64 epoch = _ownershipEpochs[storeId_] + 1;
        _ownershipEpochs[storeId_] = epoch;

        emit ControllerChanged(storeId_, previous, newController, epoch, reason);
    }

    // ===================================================== delivery gateway ==

    function isDeliveryGateway(address account) external view returns (bool) {
        return hasRole(DELIVERY_GATEWAY_ROLE, account);
    }

    // ============================================================= pause ====

    function isPaused(bytes32 scope) external view returns (bool) {
        return _paused[scope];
    }

    /**
     * @notice Granular emergency pause. Guardian may pause; only admin may unpause.
     * @dev Pausing new economic actions must never trap claims, content access or safe
     *      exits, so dividend claims and license validity intentionally have no pause
     *      scope at all. [0.21.M, 0.19.K]
     */
    function setPaused(bytes32 scope, bool paused_) external {
        if (paused_) {
            if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
                revert NotAuthorizedFactory();
            }
        } else {
            _checkRole(DEFAULT_ADMIN_ROLE);
        }
        _paused[scope] = paused_;
        emit ScopePaused(scope, paused_);
    }

    // =========================================================== upgrade ====

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    /// @notice Implementation version tag, bumped by every deployed implementation.
    function registryVersion() external pure virtual returns (string memory) {
        return "1.0.0";
    }
}
