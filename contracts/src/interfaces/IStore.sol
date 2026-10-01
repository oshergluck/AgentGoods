// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {StoreType} from "./IAICoin.sol";

/// @notice Lifecycle status of a canonical store.
enum StoreStatus {
    Active,
    Paused,
    Deprecated
}

/// @notice Reason a controller change was recorded (for indexing/audit).
enum ControllerChangeReason {
    Genesis,
    VoluntaryTransfer,
    HolderTakeover
}

interface IStore {
    function storeId() external view returns (bytes32);
    function storeType() external view returns (StoreType);
    function storeCreator() external view returns (address);
    function storeController() external view returns (address);
    function ownershipEpoch() external view returns (uint64);
    function status() external view returns (StoreStatus);

    function aicToken() external view returns (address);
    function licenseToken() external view returns (address);
    function governance() external view returns (address);
    function dividendDistributor() external view returns (address);
    function registry() external view returns (address);
    function usdc() external view returns (address);

    /// @notice Delivery witness allowed to record access grants on the canonical LicenseToken.
    function accessAttestor() external view returns (address);

    // --------------------------------------------------------- accounting
    function ownerAvailableUSDC() external view returns (uint256);
    function unfinalizedHolderReserveUSDC() external view returns (uint256);
    function lifetimeNetCommerceUSDC() external view returns (uint256);
    function lifetimeHolderReserveAccruedUSDC() external view returns (uint256);
    function lifetimeHolderReserveCommittedUSDC() external view returns (uint256);
    function lifetimeOwnerAvailableAccruedUSDC() external view returns (uint256);

    // --------------------------------------------------------- governance
    function unresolvedPassedProposalCount() external view returns (uint256);
    function governanceLockActive() external view returns (bool);

    /// @notice Called by the canonical governance contract when a proposal passes.
    function onGovernanceProposalPassed(uint256 proposalId) external;

    /// @notice Called by the canonical governance contract when an obligation is resolved.
    function onGovernanceProposalResolved(uint256 proposalId) external;

    // ----------------------------------------------------------- takeover
    /// @notice Called by the canonical AIC token when a takeover finalizes.
    function onHolderTakeover(address newController) external;

    // ---------------------------------------------------------- dividends
    /// @notice Called by the canonical dividend distributor when an epoch is opened.
    /// @return committed The reserve amount actually transferred to the distributor.
    function commitHolderReserve(uint256 requested) external returns (uint256 committed);

    /// @notice Called by the distributor when an epoch is abandoned without distributing.
    function returnHolderReserve(uint256 amount) external;
}
