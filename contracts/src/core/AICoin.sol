// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IAICoin} from "../interfaces/IAICoin.sol";
import {IStore} from "../interfaces/IStore.sol";
import {ProtocolConstants} from "../libraries/ProtocolConstants.sol";
import {EligibleHolderHeap} from "../libraries/EligibleHolderHeap.sol";

/**
 * @title AICoin
 * @notice Canonical per-store AIC token.
 *
 * @dev Design notes (MASTER_PLAN references in brackets):
 *
 *  - Fixed genesis supply of exactly 1,000,000,000 AIC minted atomically to the
 *    canonical AgentGoods at construction. There is no post-genesis mint path and the
 *    store creator receives zero free allocation. [12A.1, 0.25.M]
 *
 *  - Historical balance and eligible-supply checkpoints back every snapshot-based
 *    right (voting power, dividend entitlement). Current balances are never used to
 *    infer historical rights. [0.24.A, 5.3, 5.5]
 *
 *  - "Eligible" means an EOA under the V1 policy: a non-zero address with no code.
 *    The protocol documents (docs/EOA_ELIGIBILITY.md) that this is a policy check and
 *    not cryptographic proof of key custody; purgeIneligible is the permissionless
 *    repair path for addresses that gain code after being ranked. [0.7, 0.19.B]
 *
 *  - Reason-scoped NON-CUSTODIAL locks implement governance YES escrow and takeover
 *    candidacy without ever moving balances into a contract, which would destroy the
 *    eligibility of the holder. [0.29.A, 0.21.D]
 *
 *  - An indexed max-heap over eligible balances makes "is X the largest eligible EOA
 *    holder?" an O(1) on-chain question at finalization, with no trusted indexer,
 *    no caller-supplied list and no unbounded loop. [0.25.B]
 */
contract AICoin is ERC20, IAICoin {
    using Checkpoints for Checkpoints.Trace208;
    using EligibleHolderHeap for EligibleHolderHeap.Heap;

    // ----------------------------------------------------------- lock reasons
    bytes32 public constant TAKEOVER_LOCK_ID = keccak256("AIC_TAKEOVER_CANDIDACY");

    // ------------------------------------------------ set once at initialize
    string private _tokenName;
    string private _tokenSymbol;
    bytes32 private _storeId;
    address private _agentGoods;
    address private _factory;
    uint256 private _genesisSupply;
    bool private _initialized;

    // ------------------------------------------------------------ wired once
    address private _store;
    address private _governance;
    bool private _wired;

    // ------------------------------------------------------------ accounting
    uint256 private _totalBurned;
    uint256 private _eligibleSupply;

    mapping(address => Checkpoints.Trace208) private _balanceCheckpoints;
    Checkpoints.Trace208 private _eligibleSupplyCheckpoints;

    /// @dev Whether the balance of an account is currently counted inside _eligibleSupply.
    mapping(address => bool) private _countedEligible;
    /// @dev The exact amount currently contributed by an account to _eligibleSupply.
    mapping(address => uint256) private _countedAmount;

    // ----------------------------------------------------------------- locks
    mapping(address => mapping(bytes32 => uint256)) private _lockAmount;
    mapping(address => mapping(bytes32 => address)) private _lockCreator;
    mapping(address => uint256) private _totalLocked;

    // --------------------------------------------------------------- ranking
    EligibleHolderHeap.Heap private _ranking;
    address private _leader;
    uint256 private _leaderSince;

    // -------------------------------------------------------------- takeover
    mapping(address => uint256) public takeoverCandidacyOpenedAt;

    // ---------------------------------------------------------------- events
    event Wired(address indexed store, address indexed governance);
    event MarketBurn(address indexed market, uint256 amount);
    event EligibilityPurged(address indexed account, uint256 removedBalance);
    event LeaderChanged(
        address indexed previousLeader,
        address indexed newLeader,
        uint256 newLeaderBalance,
        uint256 since
    );
    event BalanceLocked(address indexed account, bytes32 indexed lockId, address indexed locker, uint256 amount);
    event BalanceUnlocked(address indexed account, bytes32 indexed lockId, address indexed locker, uint256 amount);
    event TakeoverCandidacyOpened(address indexed candidate, uint256 lockedBalance, uint256 openedAt);
    event TakeoverCandidacyCancelled(address indexed candidate);
    event TakeoverFinalized(
        address indexed newController,
        uint256 balance,
        uint256 candidacyOpenedAt,
        uint256 finalizedAt
    );

    // ---------------------------------------------------------------- errors
    error NotFactory();
    error AlreadyInitialized();
    error AlreadyWired();
    error NotWired();
    error NotMarket();
    error NotAuthorizedLocker();
    error LockAlreadyExists();
    error NotLockCreator();
    error InsufficientTransferableBalance(address account, uint256 requested, uint256 available);
    error AccountStillEligible();
    error NotEligible();
    error NotLeader();
    error NoCandidacy();
    error CandidacyAlreadyOpen();
    error ObservationPeriodNotElapsed(uint256 elapsed, uint256 required);
    error LeadershipNotContinuous();
    error ZeroAmount();

    /**
     * @dev This contract is deployed once as an IMPLEMENTATION and then cloned per store
     *      (EIP-1167). A clone is immutable: it has no proxy admin and no upgrade path, and
     *      its implementation address is canonical protocol code. [0.25.P]
     *      The implementation itself is permanently locked so it can never be initialized.
     */
    constructor() ERC20("AIC Implementation", "AIC-IMPL") {
        _initialized = true;
    }

    /**
     * @notice One-shot initialization performed by the deploying Factory in the same
     *         transaction as the clone, so no clone can exist uninitialized.
     */
    function initialize(string calldata name_, string calldata symbol_, bytes32 storeId_, address agentGoods_)
        external
    {
        if (_initialized) revert AlreadyInitialized();
        require(agentGoods_ != address(0), "AIC: zero market");
        _initialized = true;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        _storeId = storeId_;
        _agentGoods = agentGoods_;
        _factory = msg.sender;
        _genesisSupply = ProtocolConstants.AIC_GENESIS_SUPPLY;

        // Genesis: the entire supply is committed to the market. The creator gets zero.
        _mint(agentGoods_, ProtocolConstants.AIC_GENESIS_SUPPLY);
    }

    function name() public view override returns (string memory) {
        return _tokenName;
    }

    function symbol() public view override returns (string memory) {
        return _tokenSymbol;
    }

    // ============================================================== wiring ==

    /**
     * @notice One-time wiring of the circular Store/Governance references.
     * @dev Called by the deploying Factory inside the same atomic creation transaction,
     *      so the token can never be observed in a seizable half-initialized state. [0.25.P]
     */
    function wire(address store_, address governance_) external {
        if (msg.sender != _factory) revert NotFactory();
        if (_wired) revert AlreadyWired();
        require(store_ != address(0) && governance_ != address(0), "AIC: zero wire");
        _store = store_;
        _governance = governance_;
        _wired = true;
        emit Wired(store_, governance_);
    }

    // ============================================================ identity ==

    function factory() external view returns (address) {
        return _factory;
    }

    function storeId() external view returns (bytes32) {
        return _storeId;
    }

    function store() external view returns (address) {
        return _store;
    }

    function governance() external view returns (address) {
        return _governance;
    }

    function agentGoods() external view returns (address) {
        return _agentGoods;
    }

    function genesisSupply() external view returns (uint256) {
        return _genesisSupply;
    }

    function totalBurned() external view returns (uint256) {
        return _totalBurned;
    }

    // ========================================================= eligibility ==

    /**
     * @notice V1 eligibility policy: a non-zero address that currently has no code.
     * @dev Deliberately excludes smart-contract wallets (including ERC-1271) from
     *      voting, dividends and takeover in V1. Documented in docs/EOA_ELIGIBILITY.md.
     */
    function isEligible(address account) public view returns (bool) {
        return account != address(0) && account.code.length == 0;
    }

    function eligibleSupply() external view returns (uint256) {
        return _eligibleSupply;
    }

    function getPastBalance(address account, uint256 blockNumber) external view returns (uint256) {
        require(blockNumber < block.number, "AIC: block not mined");
        return _balanceCheckpoints[account].upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    function getPastEligibleSupply(uint256 blockNumber) external view returns (uint256) {
        require(blockNumber < block.number, "AIC: block not mined");
        return _eligibleSupplyCheckpoints.upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    /**
     * @notice Lowest balance `account` held at any point in `[fromBlock, toBlock]`.
     *
     * @dev This is the entitlement weight for a dividend epoch. [MASTER_PLAN 29C.4]
     *
     *      Reads the checkpoint array this contract already maintains; no additional storage,
     *      no per-holder bookkeeping and no iteration over the holder set. The balance before an
     *      account first appears is zero, which falls out of `upperLookup` returning zero, so an
     *      account whose first acquisition is inside the window weighs zero with no special case.
     *
     *      Cost is O(log n + k) where k is THIS account checkpoint count inside the window. It is
     *      a view, called per leaf by whoever is verifying that leaf, and is never invoked from a
     *      state-changing path.
     */
    function minBalanceInWindow(address account, uint256 fromBlock, uint256 toBlock)
        external
        view
        returns (uint256)
    {
        require(toBlock < block.number, "AIC: block not mined");
        require(fromBlock <= toBlock, "AIC: empty window");

        Checkpoints.Trace208 storage trace = _balanceCheckpoints[account];
        uint48 from = SafeCast.toUint48(fromBlock);
        uint48 to = SafeCast.toUint48(toBlock);

        // Balance as it stood at the window start. Everything inside the window can only be
        // compared against this, never replace it: the minimum includes the opening value.
        uint256 running = trace.upperLookup(from);

        uint256 total = trace.length();
        if (total == 0) return running;

        // First checkpoint strictly after the window start.
        uint256 lo = 0;
        uint256 hi = total;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (trace.at(SafeCast.toUint32(mid))._key > from) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }

        for (uint256 i = lo; i < total; ++i) {
            Checkpoints.Checkpoint208 memory cp = trace.at(SafeCast.toUint32(i));
            if (cp._key > to) break;
            if (cp._value < running) running = cp._value;
            if (running == 0) break; // cannot go lower; stop paying for the rest of the walk
        }

        return running;
    }

    /**
     * @notice Permissionlessly remove an address that gained code after being ranked.
     * @dev Closes the CREATE2/constructor edge case: an address may have had no code when
     *      it received AIC and later become a contract. Until it is purged it can block a
     *      takeover (fail-closed) but can never itself finalize one. [0.19.B, 0.25.B]
     */
    function purgeIneligible(address account) external {
        if (isEligible(account)) revert AccountStillEligible();

        uint256 removed = 0;
        if (_countedEligible[account]) {
            removed = _countedAmount[account];
            _eligibleSupply -= removed;
            _countedEligible[account] = false;
            _countedAmount[account] = 0;
            _pushEligibleSupplyCheckpoint();
        }
        if (_ranking.contains(account)) {
            _ranking.remove(account);
        }
        // Any takeover candidacy held by a now-ineligible address is void.
        if (takeoverCandidacyOpenedAt[account] != 0) {
            takeoverCandidacyOpenedAt[account] = 0;
            _releaseInternal(account, TAKEOVER_LOCK_ID);
            emit TakeoverCandidacyCancelled(account);
        }
        _refreshLeader();
        emit EligibilityPurged(account, removed);
    }

    // ============================================================= ranking ==

    function currentLeader() public view returns (address) {
        return _leader;
    }

    function currentLeaderBalance() external view returns (uint256) {
        return _ranking.rootKey();
    }

    function leaderSince() external view returns (uint256) {
        return _leaderSince;
    }

    function rankedHolderCount() external view returns (uint256) {
        return _ranking.size();
    }

    function rankedKeyOf(address account) external view returns (uint256) {
        return _ranking.keyOf(account);
    }

    function _refreshLeader() private {
        address newLeader = _ranking.root();
        if (newLeader != _leader) {
            address previous = _leader;
            _leader = newLeader;
            _leaderSince = block.timestamp;
            emit LeaderChanged(previous, newLeader, _ranking.rootKey(), block.timestamp);
        }
    }

    // =============================================================== locks ==

    function lockedBalanceOf(address account) public view returns (uint256) {
        return _totalLocked[account];
    }

    function transferableBalanceOf(address account) public view returns (uint256) {
        uint256 bal = balanceOf(account);
        uint256 locked = _totalLocked[account];
        return bal > locked ? bal - locked : 0;
    }

    function lockAmount(address account, bytes32 lockId) external view returns (uint256) {
        return _lockAmount[account][lockId];
    }

    function lockCreator(address account, bytes32 lockId) external view returns (address) {
        return _lockCreator[account][lockId];
    }

    /**
     * @notice Create a reason-scoped, non-custodial lock on part of a balance.
     * @dev Locks from different reasons sum, so a unit of balance backs at most one
     *      obligation at a time. That is exactly the "reject reuse until release" safe
     *      rule of 0.28.N. Only the canonical governance contract may lock externally;
     *      takeover locks are created by this contract itself.
     */
    function lock(address account, bytes32 lockId, uint256 amount) external {
        if (!_wired) revert NotWired();
        if (msg.sender != _governance) revert NotAuthorizedLocker();
        _lockInternal(account, lockId, amount, msg.sender);
    }

    function release(address account, bytes32 lockId) external {
        if (_lockCreator[account][lockId] != msg.sender) revert NotLockCreator();
        _releaseInternal(account, lockId);
    }

    function _lockInternal(address account, bytes32 lockId, uint256 amount, address locker) private {
        if (amount == 0) revert ZeroAmount();
        if (_lockAmount[account][lockId] != 0) revert LockAlreadyExists();
        uint256 available = transferableBalanceOf(account);
        if (available < amount) revert InsufficientTransferableBalance(account, amount, available);

        _lockAmount[account][lockId] = amount;
        _lockCreator[account][lockId] = locker;
        _totalLocked[account] += amount;
        emit BalanceLocked(account, lockId, locker, amount);
    }

    function _releaseInternal(address account, bytes32 lockId) private {
        uint256 amount = _lockAmount[account][lockId];
        if (amount == 0) return;
        address locker = _lockCreator[account][lockId];
        delete _lockAmount[account][lockId];
        delete _lockCreator[account][lockId];
        _totalLocked[account] -= amount;
        emit BalanceUnlocked(account, lockId, locker, amount);
    }

    // ============================================================ takeover ==

    /**
     * @notice Open a takeover candidacy as the current largest eligible EOA holder.
     * @dev The balance of the caller is immobilised for the observation period, which makes a
     *      flash-funded or one-block "largest holder" economically impossible: the tokens
     *      cannot leave the candidate for at least one hour of chain time. [0.15, 0.19.A]
     *
     *      Only the currently TRANSFERABLE part is newly locked. Any amount already locked by
     *      another reason (a governance YES obligation, for example) is by definition already
     *      immobile, so re-locking it would double count the same units and would make the
     *      largest holder unable to run a takeover simply because it had voted. Reason-scoped
     *      locks compose; releasing one never releases another. [0.19.K, 0.29.J]
     *
     *      Correctness does not depend on this lock: finalization independently requires the
     *      caller to still be the verified heap leader AND for `_leaderSince` to predate the
     *      candidacy, and `_leaderSince` resets whenever the leading address changes.
     */
    function openTakeoverCandidacy() external {
        if (!_wired) revert NotWired();
        if (!isEligible(msg.sender)) revert NotEligible();
        if (takeoverCandidacyOpenedAt[msg.sender] != 0) revert CandidacyAlreadyOpen();
        if (_leader != msg.sender) revert NotLeader();

        uint256 bal = balanceOf(msg.sender);
        if (bal == 0) revert ZeroAmount();

        takeoverCandidacyOpenedAt[msg.sender] = block.timestamp;
        uint256 free = transferableBalanceOf(msg.sender);
        if (free > 0) {
            _lockInternal(msg.sender, TAKEOVER_LOCK_ID, free, address(this));
        }
        emit TakeoverCandidacyOpened(msg.sender, bal, block.timestamp);
    }

    function cancelTakeoverCandidacy() external {
        if (takeoverCandidacyOpenedAt[msg.sender] == 0) revert NoCandidacy();
        takeoverCandidacyOpenedAt[msg.sender] = 0;
        _releaseInternal(msg.sender, TAKEOVER_LOCK_ID);
        emit TakeoverCandidacyCancelled(msg.sender);
    }

    /**
     * @notice Finalize a takeover and become the store controller.
     * @dev Four conditions, all verified on-chain with O(1) work:
     *      1. the caller is an eligible EOA right now;
     *      2. the caller is the heap root, that is the largest eligible EOA holder;
     *      3. the caller has held the leader position continuously since before candidacy
     *         opened (_leaderSince is reset whenever the root address changes);
     *      4. at least TAKEOVER_OBSERVATION_PERIOD seconds of chain time have elapsed.
     */
    function finalizeTakeover() external {
        uint256 openedAt = takeoverCandidacyOpenedAt[msg.sender];
        if (openedAt == 0) revert NoCandidacy();
        if (!isEligible(msg.sender)) revert NotEligible();
        if (_leader != msg.sender) revert NotLeader();
        if (_leaderSince > openedAt) revert LeadershipNotContinuous();

        uint256 elapsed = block.timestamp - openedAt;
        if (elapsed < ProtocolConstants.TAKEOVER_OBSERVATION_PERIOD) {
            revert ObservationPeriodNotElapsed(elapsed, ProtocolConstants.TAKEOVER_OBSERVATION_PERIOD);
        }

        takeoverCandidacyOpenedAt[msg.sender] = 0;
        _releaseInternal(msg.sender, TAKEOVER_LOCK_ID);

        emit TakeoverFinalized(msg.sender, balanceOf(msg.sender), openedAt, block.timestamp);
        IStore(_store).onHolderTakeover(msg.sender);
    }

    // ================================================================ burn ==

    /**
     * @notice Burn AIC from the balance of the caller. Only the canonical market may call.
     * @dev Used exclusively by the one-way 30% transition to destroy the remaining
     *      non-LP market inventory. It can never touch a third-party balance. [0.13, 5.1]
     */
    function burnFromMarket(uint256 amount) external {
        if (msg.sender != _agentGoods) revert NotMarket();
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount);
        _totalBurned += amount;
        emit MarketBurn(msg.sender, amount);
    }

    // ============================================================= ERC-20 ==

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) {
            uint256 available = transferableBalanceOf(from);
            if (available < value) revert InsufficientTransferableBalance(from, value, available);
        }

        super._update(from, to, value);

        if (from != address(0)) _syncAccount(from);
        if (to != address(0)) _syncAccount(to);
        _pushEligibleSupplyCheckpoint();
        _refreshLeader();
    }

    /// @dev Re-derives every per-account projection (checkpoint, eligible supply, ranking).
    function _syncAccount(address account) private {
        uint256 newBalance = balanceOf(account);
        _balanceCheckpoints[account].push(SafeCast.toUint48(block.number), SafeCast.toUint208(newBalance));

        bool eligibleNow = isEligible(account);

        if (_countedEligible[account]) {
            _eligibleSupply -= _countedAmount[account];
        }
        if (eligibleNow) {
            _eligibleSupply += newBalance;
            _countedAmount[account] = newBalance;
        } else {
            _countedAmount[account] = 0;
        }
        _countedEligible[account] = eligibleNow;

        _ranking.set(account, eligibleNow ? newBalance : 0);
    }

    function _pushEligibleSupplyCheckpoint() private {
        _eligibleSupplyCheckpoints.push(SafeCast.toUint48(block.number), SafeCast.toUint208(_eligibleSupply));
    }
}
