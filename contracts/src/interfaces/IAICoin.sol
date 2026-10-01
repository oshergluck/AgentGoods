// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Store type discriminator used across Registry/Factory/Store contracts.
enum StoreType {
    Sales,
    Rentals
}

/**
 * @title IAICoin
 * @notice Canonical per-store AIC token: fixed 1B supply, historical balance
 *         checkpoints, EOA-only eligibility accounting, reason-scoped non-custodial
 *         transfer locks and an on-chain largest-eligible-holder ranking.
 */
interface IAICoin is IERC20 {
    // ------------------------------------------------------------- identity
    function storeId() external view returns (bytes32);
    function store() external view returns (address);
    function agentGoods() external view returns (address);
    function genesisSupply() external view returns (uint256);
    function totalBurned() external view returns (uint256);

    // --------------------------------------------------- historical records
    /// @notice Balance of `account` as of the end of `blockNumber` (must be in the past).
    function getPastBalance(address account, uint256 blockNumber) external view returns (uint256);

    /// @notice Sum of balances held by eligible EOAs as of the end of `blockNumber`.
    function getPastEligibleSupply(uint256 blockNumber) external view returns (uint256);
    /// @notice Lowest balance held at any point in [fromBlock, toBlock]. [MASTER_PLAN 29C.4]
    function minBalanceInWindow(address account, uint256 fromBlock, uint256 toBlock)
        external
        view
        returns (uint256);

    /// @notice Current sum of balances held by eligible EOAs.
    function eligibleSupply() external view returns (uint256);

    /// @notice Whether `account` currently satisfies the V1 EOA eligibility policy.
    function isEligible(address account) external view returns (bool);

    // ------------------------------------------------------------ ranking
    /// @notice Current largest eligible EOA holder, or address(0) if none.
    function currentLeader() external view returns (address);

    /// @notice Balance recorded for the current leader.
    function currentLeaderBalance() external view returns (uint256);

    /// @notice Chain timestamp at which the current leader most recently became leader.
    function leaderSince() external view returns (uint256);

    /// @notice Number of ranked eligible holders.
    function rankedHolderCount() external view returns (uint256);

    /// @notice Permissionlessly drop an address that is no longer an eligible EOA.
    function purgeIneligible(address account) external;

    // -------------------------------------------------------------- locks
    /// @notice Total amount of `account`'s balance currently locked across all reasons.
    function lockedBalanceOf(address account) external view returns (uint256);

    /// @notice Amount `account` may currently transfer (balance minus locks).
    function transferableBalanceOf(address account) external view returns (uint256);

    /// @notice Amount locked under one specific lock id.
    function lockAmount(address account, bytes32 lockId) external view returns (uint256);

    /// @notice Lock `amount` of `account`'s balance under `lockId`. Caller must be an authorized locker.
    function lock(address account, bytes32 lockId, uint256 amount) external;

    /// @notice Release a previously created lock in full. Caller must be the lock's creator.
    function release(address account, bytes32 lockId) external;

    // --------------------------------------------------------------- burn
    /// @notice Burn `amount` from the caller's own balance. Only the canonical AgentGoods may call.
    function burnFromMarket(uint256 amount) external;
}
