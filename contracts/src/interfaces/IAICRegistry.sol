// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {StoreType} from "./IAICoin.sol";

/// @notice Canonical role a contract address plays in the protocol.
enum ContractRole {
    Unknown,
    Store,
    AicToken,
    LicenseToken,
    Governance,
    DividendDistributor,
    Factory,
    Registry,
    AgentGoods,
    Treasury
}

/// @notice Immutable canonical component set recorded for a store at creation.
struct StoreRecord {
    bytes32 storeId;
    address store;
    address aicToken;
    address licenseToken;
    address governance;
    address dividendDistributor;
    address factory;
    address storeCreator;
    uint64 factoryVersion;
    uint64 createdBlock;
    StoreType storeType;
    bool exists;
}

interface IAICRegistry {
    // ------------------------------------------------------- configuration
    function chainIdentifier() external view returns (uint256);
    function usdc() external view returns (address);
    function agentGoods() external view returns (address);
    function protocolTreasury() external view returns (address);
    function commerceFeeBps() external view returns (uint16);
    function dividendProcessingFeeBps() external view returns (uint16);
    function agentGoodsProtocolFeeBps() external view returns (uint16);
    function agentGoodsControllerFeeBps() external view returns (uint16);
    function holdingWindowSeconds() external view returns (uint32);
    /// @notice Whether `account` is the protocol's delivery witness (DELIVERY_GATEWAY_ROLE).
    function isDeliveryGateway(address account) external view returns (bool);

    // ---------------------------------------------------------- provenance
    function isAuthorizedFactory(address factory) external view returns (bool);
    function isFactoryKnown(address factory) external view returns (bool);
    function factoryVersion(address factory) external view returns (uint64);

    function getStore(bytes32 storeId) external view returns (StoreRecord memory);
    function storeIdOf(address storeAddress) external view returns (bytes32);
    function roleOf(address contractAddress) external view returns (ContractRole);
    function isCanonical(address contractAddress) external view returns (bool);
    function canonicalStoreOf(address contractAddress) external view returns (bytes32);
    function storeCount() external view returns (uint256);
    function storeIdAt(uint256 index) external view returns (bytes32);

    // ------------------------------------------------------- controller map
    function storeController(bytes32 storeId) external view returns (address);
    function ownershipEpoch(bytes32 storeId) external view returns (uint64);

    /// @notice Called by the canonical Store when its controller changes.
    function recordControllerChange(bytes32 storeId, address newController, uint8 reason) external;

    // --------------------------------------------------------- registration
    /// @notice Called by an authorized Factory inside the atomic store creation transaction.
    function registerStore(StoreRecord calldata record) external;

    // --------------------------------------------------------------- pause
    function isPaused(bytes32 scope) external view returns (bool);
}
