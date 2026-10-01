// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

/// @notice Categories of protocol revenue, used for on-chain accounting and indexing.
library FeeType {
    bytes32 internal constant COMMERCE_SALE = keccak256("COMMERCE_SALE");
    bytes32 internal constant COMMERCE_RENTAL = keccak256("COMMERCE_RENTAL");
    bytes32 internal constant AGENTGOODS_BUY = keccak256("AGENTGOODS_BUY");
    bytes32 internal constant AGENTGOODS_SELL = keccak256("AGENTGOODS_SELL");
    bytes32 internal constant DIVIDEND_PROCESSING = keccak256("DIVIDEND_PROCESSING");
}

interface IProtocolTreasury {
    /// @notice Record protocol revenue that has already been transferred to this contract.
    /// @dev Callable only by canonical protocol contracts registered in the Registry.
    function recordRevenue(bytes32 feeType, address token, address source, uint256 amount) external;

    function totalRevenue(address token) external view returns (uint256);
    function revenueByType(bytes32 feeType, address token) external view returns (uint256);
}
