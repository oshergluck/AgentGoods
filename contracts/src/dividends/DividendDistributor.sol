// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IStore} from "../interfaces/IStore.sol";
import {IAICoin} from "../interfaces/IAICoin.sol";
import {IAICRegistry} from "../interfaces/IAICRegistry.sol";
import {IProtocolTreasury, FeeType} from "../interfaces/IProtocolTreasury.sol";
import {AICGovernance} from "../governance/AICGovernance.sol";
import {ProtocolConstants} from "../libraries/ProtocolConstants.sol";

enum EpochState {
    None,
    Open,
    RootProposed,
    Finalized,
    Abandoned
}

/**
 * @title DividendDistributor
 * @notice Per-store, claim-based USDC dividend distribution to eligible EOA AIC holders.
 *
 * @dev Model (MASTER_PLAN 0.13, 0.20, 0.21, 0.25.D-I):
 *
 *   - Every canonical commerce payment continuously reserves 5% of store NET commerce inside
 *     the store. This contract turns accumulated reserve into claimable epochs. There is no
 *     calendar deadline and no owner-controlled withholding.
 *
 *   - `openDistribution` is PERMISSIONLESS. A hostile or absent controller cannot censor
 *     holder distributions.
 *
 *   - The snapshot block is `block.number - 1` of the opening transaction. It is therefore
 *     determined by the trigger itself and cannot be back- or forward-dated after observing
 *     mempool trades. [0.24.C]
 *
 *   - A root is proposed, then must survive an adversarial challenge window before it can be
 *     finalized, and becomes immutable the instant claims are possible. The contract caps
 *     total claims at the funded amount, so a malicious proposer can never assign more USDC
 *     than the epoch actually holds. [0.19.D, 0.25.G]
 *
 *   - Liveness cure: if no root is finalized within ROOT_LIVENESS_TIMEOUT, anyone may
 *     abandon the epoch, which returns the full committed reserve to the store where it
 *     remains protected holder value for a later epoch. A dead root generator can delay
 *     holders but can never strand their money. [0.21.A]
 *
 *   - Governance suspension: a leaf may carry a list of proposal ids that must be resolved
 *     before it becomes claimable. Suspended value is neither forfeited, nor paid to the
 *     controller or protocol, nor redistributed. It simply waits. [0.28.B, 0.29.G]
 *
 *   - Unclaimed policy: no expiry. Holder funds are never returned to the controller. [0.21.J]
 */
contract DividendDistributor is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Epoch {
        uint48 snapshotBlock;
        uint48 openedAt;
        uint48 rootProposedAt;
        uint48 finalizedAt;
        uint32 rootRevision;
        EpochState state;
        uint256 committedReserveUSDC;
        uint256 processingFeeUSDC;
        uint256 claimableUSDC;
        uint256 eligibleSupplyAtSnapshot;
        /**
         * @dev The holding window this epoch was opened under, and the block it starts at.
         *      Recorded at open and never recomputed, so changing the registry parameter can
         *      never retroactively alter an epoch in flight and a historical root stays
         *      reproducible from the epoch record alone. [MASTER_PLAN 29C.5]
         */
        uint32 holdingWindowSeconds;
        uint48 windowStartBlock;
        /// @dev Sum of per-account MINIMUM balances across the window, supplied with the root.
        uint256 eligibleMinSupply;
        bytes32 merkleRoot;
        bytes32 datasetHash;
        uint256 rootTotalUSDC;
        uint256 claimedUSDC;
    }

    uint32 public constant MAX_ROOT_REVISIONS = 8;
    uint256 public constant MAX_BLOCKING_PROPOSALS = 16;

    address public store;
    bytes32 public storeId;
    IAICoin public aicToken;
    IERC20 public usdc;
    IAICRegistry public registry;
    address public governance;
    bool private _initialized;

    uint256 public epochCount;
    mapping(uint256 => Epoch) private _epochs;
    /// @dev epochId => leaf index => claimed.
    mapping(uint256 => mapping(uint256 => bool)) public claimed;
    /// @dev epochId => account => total claimed, for cheap API reads.
    mapping(uint256 => mapping(address => uint256)) public claimedBy;

    /// @notice Addresses allowed to propose a Merkle root.
    mapping(address => bool) public isRootProposer;

    uint256 public lifetimeClaimedUSDC;
    uint256 public lifetimeProcessingFeeUSDC;

    event RootProposerSet(address indexed proposer, bool allowed);
    event DistributionOpened(
        uint256 indexed epochId,
        uint256 snapshotBlock,
        uint256 committedReserveUSDC,
        uint256 eligibleSupplyAtSnapshot,
        address indexed openedBy,
        uint32 holdingWindowSeconds,
        uint256 windowStartBlock
    );
    event RootProposed(
        uint256 indexed epochId,
        uint32 indexed revision,
        bytes32 merkleRoot,
        bytes32 datasetHash,
        uint256 rootTotalUSDC,
        address indexed proposer,
        uint256 challengeEndsAt,
        uint256 eligibleMinSupply
    );
    event RootFinalized(
        uint256 indexed epochId,
        bytes32 merkleRoot,
        bytes32 datasetHash,
        uint256 claimableUSDC,
        uint256 rootTotalUSDC,
        uint256 processingFeeUSDC,
        uint256 dustReturnedUSDC
    );
    event DistributionAbandoned(uint256 indexed epochId, uint256 returnedUSDC, address indexed by);
    event Claimed(
        uint256 indexed epochId,
        uint256 indexed index,
        address indexed account,
        uint256 amountUSDC,
        uint256 epochClaimedTotal
    );

    error NotAuthorized();
    error EpochNotFound();
    error EpochBusy();
    error BadState(EpochState actual);
    error BelowMinimumDistribution(uint256 available, uint256 minimum);
    error ZeroEligibleSupply();
    error RootTotalTooHigh(uint256 rootTotal, uint256 claimable);
    error MinSupplyAboveSnapshot(uint256 proposed, uint256 snapshotSupply);
    error ChallengeWindowOpen(uint256 secondsRemaining);
    error TooManyRevisions();
    error LivenessTimeoutNotReached(uint256 secondsRemaining);
    error AlreadyClaimed();
    error InvalidProof();
    error GovernanceSuspensionActive(uint256 proposalId);
    error TooManyBlockingProposals();
    error ExceedsRootTotal();
    error ZeroAddress();
    error AlreadyInitialized();

    /**
     * @notice How long a proposed root may be challenged before it can be finalized.
     * @dev PINNED AT DEPLOY, NOT GOVERNABLE, AND NOT A GLOBAL CONSTANT ANY MORE.
     *
     *      This was `ProtocolConstants.ROOT_CHALLENGE_PERIOD`, a single 6-hour value compiled into
     *      every deployment. That is correct for production — six hours is the window in which
     *      anyone may prove a published root wrong, and shortening it on a live market shortens the
     *      only defence holders have against a bad root.
     *
     *      It is also a hard floor on how long a market must run before ANY dividend can be
     *      claimed, and that made it unworkable on a test network: a four-hour exercise could
     *      accrue reserve, open an epoch and propose a root, and `finalizeRoot` would still revert
     *      with `ChallengeWindowOpen` until two hours after the exercise had ended. Nothing was
     *      claimable, by arithmetic, and no participant could have discovered why.
     *
     *      Making it an immutable set at construction lets a test deployment pin a shorter window
     *      WITHOUT the production value being a source-level toggle somebody can ship by accident.
     *      Both networks build from this identical source; they differ only in the value handed to
     *      the constructor, and the value each one is running is readable on chain.
     *
     *      It is immutable rather than a storage variable on purpose: clones delegatecall to this
     *      implementation, so an immutable is baked into the implementation's code and is shared,
     *      unwritable and free to read for every store cloned from it. A governable challenge
     *      period would let whoever controls the parameter shorten the window on a root that is
     *      already under challenge, which is the one moment it must not move.
     */
    uint256 public immutable rootChallengePeriod;

    /// @notice Lower bound on the challenge period, so a deploy cannot set it to nothing.
    /// @dev An hour is short enough for a test run and long enough that a root cannot be proposed
    ///      and finalized inside one block window before anyone could look at it. Zero, or a few
    ///      seconds, would make the challenge window decorative.
    uint256 public constant MIN_ROOT_CHALLENGE_PERIOD = 1 hours;

    error ChallengePeriodTooShort(uint256 requested, uint256 minimum);
    error ChallengePeriodTooLong(uint256 requested, uint256 maximum);

    /**
     * @dev Deployed once as an implementation and cloned per store (EIP-1167). [0.25.P]
     * @param rootChallengePeriod_ Challenge window for every store cloned from this implementation.
     *        Pass 0 for the protocol default, which is what a production deploy does.
     */
    constructor(uint256 rootChallengePeriod_) {
        uint256 period = rootChallengePeriod_ == 0
            ? ProtocolConstants.ROOT_CHALLENGE_PERIOD
            : rootChallengePeriod_;
        if (period < MIN_ROOT_CHALLENGE_PERIOD) {
            revert ChallengePeriodTooShort(period, MIN_ROOT_CHALLENGE_PERIOD);
        }
        /*
         * Never longer than the liveness timeout. Past that point an epoch can be permissionlessly
         * abandoned, so a challenge period beyond it would describe a root that can never be
         * finalized and an epoch that can only ever be rolled forward.
         */
        if (period > ProtocolConstants.ROOT_LIVENESS_TIMEOUT) {
            revert ChallengePeriodTooLong(period, ProtocolConstants.ROOT_LIVENESS_TIMEOUT);
        }
        rootChallengePeriod = period;
        _initialized = true;
    }

    function initialize(
        address store_,
        bytes32 storeId_,
        address aicToken_,
        address usdc_,
        address registry_,
        address governance_,
        address initialRootProposer_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (
            store_ == address(0) || aicToken_ == address(0) || usdc_ == address(0) || registry_ == address(0)
                || governance_ == address(0)
        ) revert ZeroAddress();
        store = store_;
        storeId = storeId_;
        aicToken = IAICoin(aicToken_);
        usdc = IERC20(usdc_);
        registry = IAICRegistry(registry_);
        governance = governance_;
        if (initialRootProposer_ != address(0)) {
            isRootProposer[initialRootProposer_] = true;
            emit RootProposerSet(initialRootProposer_, true);
        }
    }

    // =============================================================== roles ==

    /// @notice Registry admin manages root proposers. This is the liveness cure path.
    function setRootProposer(address proposer, bool allowed) external {
        if (!_isRegistryAdmin(msg.sender)) revert NotAuthorized();
        if (proposer == address(0)) revert ZeroAddress();
        isRootProposer[proposer] = allowed;
        emit RootProposerSet(proposer, allowed);
    }

    function _isRegistryAdmin(address account) private view returns (bool) {
        (bool ok, bytes memory data) = address(registry).staticcall(
            abi.encodeWithSignature("hasRole(bytes32,address)", bytes32(0), account)
        );
        return ok && data.length == 32 && abi.decode(data, (bool));
    }

    function _isGuardian(address account) private view returns (bool) {
        (bool ok, bytes memory data) = address(registry).staticcall(
            abi.encodeWithSignature("hasRole(bytes32,address)", keccak256("GUARDIAN_ROLE"), account)
        );
        return ok && data.length == 32 && abi.decode(data, (bool));
    }

    // ============================================================= epochs ==

    function epoch(uint256 epochId) external view returns (Epoch memory) {
        if (epochId == 0 || epochId > epochCount) revert EpochNotFound();
        return _epochs[epochId];
    }

    /// @notice True while an epoch exists that has neither finalized nor been abandoned.
    function hasOpenEpoch() public view returns (bool) {
        if (epochCount == 0) return false;
        EpochState s = _epochs[epochCount].state;
        return s == EpochState.Open || s == EpochState.RootProposed;
    }

    /**
     * @notice Permissionlessly convert accumulated holder reserve into a new claim epoch.
     * @dev Exactly one epoch may be in flight at a time, which makes double allocation of the
     *      same reserve unit structurally impossible. [0.25.F]
     */
    function openDistribution() external nonReentrant returns (uint256 epochId) {
        if (hasOpenEpoch()) revert EpochBusy();

        uint256 available = IStore(store).unfinalizedHolderReserveUSDC();
        if (available < ProtocolConstants.MIN_DISTRIBUTION_USDC) {
            revert BelowMinimumDistribution(available, ProtocolConstants.MIN_DISTRIBUTION_USDC);
        }

        uint256 snapshotBlock = block.number - 1;
        uint256 eligibleAtSnapshot = aicToken.getPastEligibleSupply(snapshotBlock);
        // Zero eligible EOA supply: keep the reserve accumulating instead of dividing by
        // zero or handing holder money to the controller. [0.25.H]
        if (eligibleAtSnapshot == 0) revert ZeroEligibleSupply();

        uint256 committed = IStore(store).commitHolderReserve(available);
        if (committed == 0) revert BelowMinimumDistribution(0, ProtocolConstants.MIN_DISTRIBUTION_USDC);

        epochId = ++epochCount;
        Epoch storage e = _epochs[epochId];
        e.snapshotBlock = uint48(snapshotBlock);
        e.openedAt = uint48(block.timestamp);
        e.state = EpochState.Open;
        e.committedReserveUSDC = committed;
        e.eligibleSupplyAtSnapshot = eligibleAtSnapshot;

        /*
         * Resolve the holding window ONCE, here.
         *
         * The checkpoints are keyed by block number, so a window expressed in seconds is
         * converted with the chain nominal block time. Getting that constant slightly wrong
         * only stretches or shortens the window; it can never over-allocate, because the weight
         * is a minimum over whatever window results. [MASTER_PLAN 29C.5]
         */
        uint32 windowSeconds = registry.holdingWindowSeconds();
        uint256 windowBlocks = uint256(windowSeconds) / ProtocolConstants.NOMINAL_BLOCK_TIME_SECONDS;
        e.holdingWindowSeconds = windowSeconds;
        e.windowStartBlock = uint48(snapshotBlock > windowBlocks ? snapshotBlock - windowBlocks : 0);

        uint16 feeBps = registry.dividendProcessingFeeBps();
        // The processing fee is charged ON the committed reserve, not as extra store
        // commerce. holders receive 95% of the reserve, not 90% of store net. [0.25.E]
        e.processingFeeUSDC = (committed * feeBps) / ProtocolConstants.BPS_DENOMINATOR;
        e.claimableUSDC = committed - e.processingFeeUSDC;

        emit DistributionOpened(
            epochId,
            snapshotBlock,
            committed,
            eligibleAtSnapshot,
            msg.sender,
            e.holdingWindowSeconds,
            e.windowStartBlock
        );
    }

    /**
     * @notice Propose (or replace, within the challenge window) the entitlement Merkle root.
     * @param rootTotalUSDC Sum of every entitlement in the dataset. Capped at `claimableUSDC`,
     *        which is what makes an inflated or malicious root economically inert.
     */
    function proposeRoot(
        uint256 epochId,
        bytes32 merkleRoot,
        bytes32 datasetHash,
        uint256 rootTotalUSDC,
        uint256 eligibleMinSupply
    ) external nonReentrant {
        if (!isRootProposer[msg.sender] && !_isGuardian(msg.sender)) revert NotAuthorized();
        Epoch storage e = _requireEpoch(epochId);
        if (e.state != EpochState.Open && e.state != EpochState.RootProposed) revert BadState(e.state);
        if (rootTotalUSDC > e.claimableUSDC) revert RootTotalTooHigh(rootTotalUSDC, e.claimableUSDC);
        if (merkleRoot == bytes32(0)) revert InvalidProof();

        /*
         * Two constant-gas necessary conditions on the min-balance denominator.
         *
         * Every account minimum over the window is at most its balance at the snapshot, so the
         * sum of minimums cannot exceed the snapshot eligible supply. A proposer claiming
         * otherwise is either wrong or inflating the denominator, and either way the root is
         * refused before it can enter a challenge window. The EXACT value is defended by the
         * challenge window, where any observer recomputes each leaf from
         * `IAICoin.minBalanceInWindow`. [MASTER_PLAN 29C.5]
         */
        if (eligibleMinSupply == 0) revert ZeroEligibleSupply();
        if (eligibleMinSupply > e.eligibleSupplyAtSnapshot) {
            revert MinSupplyAboveSnapshot(eligibleMinSupply, e.eligibleSupplyAtSnapshot);
        }
        e.eligibleMinSupply = eligibleMinSupply;

        if (e.state == EpochState.RootProposed) {
            if (e.rootRevision >= MAX_ROOT_REVISIONS) revert TooManyRevisions();
        }

        e.state = EpochState.RootProposed;
        e.rootRevision += 1;
        e.merkleRoot = merkleRoot;
        e.datasetHash = datasetHash;
        e.rootTotalUSDC = rootTotalUSDC;
        e.rootProposedAt = uint48(block.timestamp);

        emit RootProposed(
            epochId,
            e.rootRevision,
            merkleRoot,
            datasetHash,
            rootTotalUSDC,
            msg.sender,
            block.timestamp + rootChallengePeriod,
            eligibleMinSupply
        );
    }

    /// @notice Finalize a root after its challenge window. Permissionless. Root becomes immutable.
    function finalizeRoot(uint256 epochId) external nonReentrant {
        Epoch storage e = _requireEpoch(epochId);
        if (e.state != EpochState.RootProposed) revert BadState(e.state);

        uint256 elapsed = block.timestamp - e.rootProposedAt;
        if (elapsed < rootChallengePeriod) {
            revert ChallengeWindowOpen(rootChallengePeriod - elapsed);
        }

        e.state = EpochState.Finalized;
        e.finalizedAt = uint48(block.timestamp);

        uint256 fee = e.processingFeeUSDC;
        if (fee > 0) {
            address treasury = registry.protocolTreasury();
            usdc.safeTransfer(treasury, fee);
            IProtocolTreasury(treasury).recordRevenue(FeeType.DIVIDEND_PROCESSING, address(usdc), store, fee);
            lifetimeProcessingFeeUSDC += fee;
        }

        // Deterministic rounding dust stays protected holder value and rolls forward. [0.25.I]
        uint256 dust = e.claimableUSDC - e.rootTotalUSDC;
        if (dust > 0) {
            usdc.forceApprove(store, dust);
            IStore(store).returnHolderReserve(dust);
            usdc.forceApprove(store, 0);
        }

        emit RootFinalized(
            epochId, e.merkleRoot, e.datasetHash, e.claimableUSDC, e.rootTotalUSDC, fee, dust
        );
    }

    /**
     * @notice Abandon a stalled epoch and return its full reserve to the store.
     * @dev Permissionless after ROOT_LIVENESS_TIMEOUT. No processing fee is taken, so a
     *      stalled epoch costs holders nothing.
     */
    function abandonDistribution(uint256 epochId) external nonReentrant {
        Epoch storage e = _requireEpoch(epochId);
        if (e.state != EpochState.Open && e.state != EpochState.RootProposed) revert BadState(e.state);

        uint256 elapsed = block.timestamp - e.openedAt;
        if (elapsed < ProtocolConstants.ROOT_LIVENESS_TIMEOUT) {
            revert LivenessTimeoutNotReached(ProtocolConstants.ROOT_LIVENESS_TIMEOUT - elapsed);
        }

        e.state = EpochState.Abandoned;
        uint256 amount = e.committedReserveUSDC;

        usdc.forceApprove(store, amount);
        IStore(store).returnHolderReserve(amount);
        usdc.forceApprove(store, 0);

        emit DistributionAbandoned(epochId, amount, msg.sender);
    }

    // ============================================================== claims ==

    /// @notice Canonical leaf encoding. Double hashing prevents internal-node second preimages.
    function leafHash(
        uint256 epochId,
        uint256 index,
        address account,
        uint256 amountUSDC,
        uint256[] calldata blockingProposalIds
    ) public view returns (bytes32) {
        return keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        block.chainid,
                        address(this),
                        epochId,
                        index,
                        account,
                        amountUSDC,
                        keccak256(abi.encodePacked(blockingProposalIds))
                    )
                )
            )
        );
    }

    /**
     * @notice Claim a finalized entitlement.
     * @param blockingProposalIds Governance proposals that must be resolved first. Empty for
     *        an immediately claimable entitlement. The list is committed inside the leaf, so
     *        a claimant cannot drop a blocking proposal to claim early.
     */
    function claim(
        uint256 epochId,
        uint256 index,
        address account,
        uint256 amountUSDC,
        uint256[] calldata blockingProposalIds,
        bytes32[] calldata proof
    ) external nonReentrant {
        Epoch storage e = _requireEpoch(epochId);
        if (e.state != EpochState.Finalized) revert BadState(e.state);
        if (claimed[epochId][index]) revert AlreadyClaimed();
        if (blockingProposalIds.length > MAX_BLOCKING_PROPOSALS) revert TooManyBlockingProposals();

        bytes32 leaf = leafHash(epochId, index, account, amountUSDC, blockingProposalIds);
        if (!MerkleProof.verifyCalldata(proof, e.merkleRoot, leaf)) revert InvalidProof();

        for (uint256 i = 0; i < blockingProposalIds.length; i++) {
            uint256 proposalId = blockingProposalIds[i];
            if (!AICGovernance(governance).isResolved(proposalId)) {
                revert GovernanceSuspensionActive(proposalId);
            }
        }

        uint256 newTotal = e.claimedUSDC + amountUSDC;
        if (newTotal > e.rootTotalUSDC) revert ExceedsRootTotal();

        claimed[epochId][index] = true;
        e.claimedUSDC = newTotal;
        claimedBy[epochId][account] += amountUSDC;
        lifetimeClaimedUSDC += amountUSDC;

        usdc.safeTransfer(account, amountUSDC);

        emit Claimed(epochId, index, account, amountUSDC, newTotal);
    }

    function _requireEpoch(uint256 epochId) private view returns (Epoch storage) {
        if (epochId == 0 || epochId > epochCount) revert EpochNotFound();
        return _epochs[epochId];
    }
}
