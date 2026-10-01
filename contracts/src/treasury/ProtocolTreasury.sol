// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IProtocolTreasury} from "../interfaces/IProtocolTreasury.sol";
import {IAICRegistry} from "../interfaces/IAICRegistry.sol";

/**
 * @title ProtocolTreasury
 * @notice Destination and ledger for all AIC protocol revenue.
 *
 * @dev Non-upgradeable by design (MASTER_PLAN 0.16 "Treasury"): it needs bounded role and
 *      configuration management, not arbitrary implementation replacement. Withdrawal
 *      authority moves behind the operator multisig/timelock at final handoff.
 *
 *      Separation of funds: this contract only ever holds protocol revenue. Store
 *      commerce proceeds, mandatory holder reserve, reward escrow and customer
 *      liabilities are all held by their own contracts and are never routed here.
 */
contract ProtocolTreasury is IProtocolTreasury, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant WITHDRAWER_ROLE = keccak256("WITHDRAWER_ROLE");
    bytes32 public constant DESTINATION_ADMIN_ROLE = keccak256("DESTINATION_ADMIN_ROLE");
    bytes32 public constant RESCUE_ROLE = keccak256("RESCUE_ROLE");

    IAICRegistry public immutable registry;

    /// @notice Address that receives withdrawals. Starts as the bootstrap admin, ends as the multisig.
    address public destination;

    mapping(address => uint256) private _totalRevenue;
    mapping(bytes32 => mapping(address => uint256)) private _revenueByType;
    /// @notice Revenue accounted for but not yet withdrawn, per token.
    mapping(address => uint256) public accountedBalance;

    event RevenueRecorded(
        bytes32 indexed feeType,
        address indexed token,
        address indexed source,
        uint256 amount,
        uint256 newTotal
    );
    event DestinationChanged(address indexed previousDestination, address indexed newDestination);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error NotCanonicalSource();
    error ZeroAddress();
    error InsufficientAccountedBalance(uint256 requested, uint256 available);
    error NothingToRescue();

    constructor(address registry_, address admin_, address destination_) {
        if (registry_ == address(0) || admin_ == address(0) || destination_ == address(0)) revert ZeroAddress();
        registry = IAICRegistry(registry_);
        destination = destination_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(WITHDRAWER_ROLE, admin_);
        _grantRole(DESTINATION_ADMIN_ROLE, admin_);
        _grantRole(RESCUE_ROLE, admin_);
    }

    /**
     * @notice Record revenue already transferred in by a canonical protocol contract.
     * @dev Only canonical Registry-known contracts may attribute revenue, so a random
     *      address cannot pollute protocol accounting. The transfer itself must already
     *      have happened; this call is the ledger entry.
     */
    function recordRevenue(bytes32 feeType, address token, address source, uint256 amount) external {
        if (!registry.isCanonical(msg.sender)) revert NotCanonicalSource();
        if (amount == 0) return;

        _totalRevenue[token] += amount;
        _revenueByType[feeType][token] += amount;
        accountedBalance[token] += amount;

        emit RevenueRecorded(feeType, token, source, amount, _totalRevenue[token]);
    }

    function totalRevenue(address token) external view returns (uint256) {
        return _totalRevenue[token];
    }

    function revenueByType(bytes32 feeType, address token) external view returns (uint256) {
        return _revenueByType[feeType][token];
    }

    function setDestination(address newDestination) external onlyRole(DESTINATION_ADMIN_ROLE) {
        if (newDestination == address(0)) revert ZeroAddress();
        emit DestinationChanged(destination, newDestination);
        destination = newDestination;
    }

    /// @notice Withdraw accounted protocol revenue to the configured destination.
    function withdraw(address token, uint256 amount) external onlyRole(WITHDRAWER_ROLE) nonReentrant {
        uint256 available = accountedBalance[token];
        if (amount > available) revert InsufficientAccountedBalance(amount, available);
        accountedBalance[token] = available - amount;
        IERC20(token).safeTransfer(destination, amount);
        emit Withdrawn(token, destination, amount);
    }

    /**
     * @notice Rescue tokens that were sent here by accident and are not protocol revenue.
     * @dev Bounded by construction: only the surplus above the accounted ledger can move,
     *      so a rescue can never consume recorded protocol revenue. [0.19.G]
     */
    function rescue(address token) external onlyRole(RESCUE_ROLE) nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 accounted = accountedBalance[token];
        if (balance <= accounted) revert NothingToRescue();
        uint256 surplus = balance - accounted;
        IERC20(token).safeTransfer(destination, surplus);
        emit Rescued(token, destination, surplus);
    }
}
