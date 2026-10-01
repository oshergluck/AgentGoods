// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IAICoin} from "../interfaces/IAICoin.sol";
import {IStore} from "../interfaces/IStore.sol";
import {ProtocolConstants} from "../libraries/ProtocolConstants.sol";

/// @notice Canonical proposal lifecycle. [MASTER_PLAN 0.28, 0.29]
enum ProposalState {
    Active,
    CancelledBeforeFirstVote,
    Failed,
    PassedAwaitingImplementation,
    ImplementedAwaitingVerification,
    ImplementationVerified
}

/**
 * @title AICGovernance
 * @notice Per-store governance with immediate pass-lock and YES-coalition verification.
 *
 * @dev Canonical V1 lifecycle (MASTER_PLAN 0.28 / 0.29), in order:
 *
 *   1. `propose` freezes snapshotBlock, eligibleEOASupplyAtSnapshot, contentHash and deadline.
 *   2. `castVote` uses HISTORICAL checkpointed power. A YES vote additionally creates a
 *      non-custodial, reason-scoped transfer lock on the voter balance, so the YES coalition
 *      cannot sell its way out of the duty it is about to create.
 *   3. The first transaction that makes `yesPower * 2 > eligibleSupplyAtSnapshot` atomically:
 *        - closes voting,
 *        - freezes the coalition and `totalOriginalYesPower`,
 *        - activates the store controller-withdrawal lock,
 *        - starts the YES-coalition dividend suspension.
 *      Exactly 50% does not pass.
 *   4. `markImplemented` is an attestation only. It unlocks nothing.
 *   5. Only original YES voters may `confirmImplementation`, weighted by their ORIGINAL YES
 *      weight. At `confirmed * 2 >= totalOriginalYesPower` the store and the dividend
 *      suspension are released atomically. There is no timeout and no controller bypass.
 *
 *      Commerce, product creation and product editing are never blocked by this contract.
 */
contract AICGovernance is ReentrancyGuardTransient {
    struct Proposal {
        address proposer;
        uint48 snapshotBlock;
        uint48 votingDeadline;
        uint48 passedAt;
        uint48 markedImplementedAt;
        uint32 implementationRound;
        ProposalState state;
        bytes32 contentHash;
        string descriptionURI;
        bytes32 evidenceHash;
        string evidenceURI;
        uint256 eligibleSupplyAtSnapshot;
        uint256 yesPower;
        uint256 noPower;
        uint256 totalOriginalYesPower;
        uint256 confirmedYesPower;
        uint256 voterCount;
    }

    /// @notice Anti-grief bound on how often a controller may restart the verification round.
    uint256 public constant MARK_IMPLEMENTED_COOLDOWN = 1 hours;
    uint32 public constant MAX_IMPLEMENTATION_ROUNDS = 64;
    /// @notice Bounded anti-spam: concurrently active proposals per proposer.
    uint256 public constant MAX_ACTIVE_PROPOSALS_PER_PROPOSER = 3;
    uint256 public constant MAX_DESCRIPTION_URI_LENGTH = ProtocolConstants.MAX_METADATA_URI_LENGTH;

    IAICoin public aicToken;
    address public store;
    bytes32 public storeId;
    bool private _initialized;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;

    /// @dev proposalId => voter => original YES weight (zero for NO voters and non-voters).
    mapping(uint256 => mapping(address => uint256)) public originalYesWeight;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => mapping(address => bool)) public voteLockReleased;
    /// @dev proposalId => round => voter => confirmed.
    mapping(uint256 => mapping(uint32 => mapping(address => bool))) public hasConfirmed;
    mapping(address => uint256) public activeProposalsOf;

    /// @notice Monotonic count of passed proposals that have not reached verification threshold.
    uint256 public unresolvedPassedProposalCount;

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        bytes32 indexed contentHash,
        uint256 snapshotBlock,
        uint256 eligibleSupplyAtSnapshot,
        uint256 votingDeadline,
        string descriptionURI
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalPassed(
        uint256 indexed proposalId,
        uint256 totalOriginalYesPower,
        uint256 eligibleSupplyAtSnapshot,
        uint256 passedAtBlock,
        uint256 passedAtTimestamp
    );
    event ProposalFailed(uint256 indexed proposalId, uint256 yesPower, uint256 noPower);
    event ProposalCancelled(uint256 indexed proposalId);
    event ImplementationMarked(
        uint256 indexed proposalId,
        uint32 indexed round,
        bytes32 evidenceHash,
        string evidenceURI,
        uint256 markedAt
    );
    event ImplementationConfirmed(
        uint256 indexed proposalId,
        uint32 indexed round,
        address indexed voter,
        uint256 weight,
        uint256 confirmedYesPower,
        uint256 requiredYesPower
    );
    event ImplementationDisputed(uint256 indexed proposalId, uint32 indexed round, address indexed voter, string reason);
    event VerificationThresholdReached(uint256 indexed proposalId, uint256 confirmedYesPower, uint256 totalOriginalYesPower);
    event VoteLockReleased(uint256 indexed proposalId, address indexed voter, uint256 amount);

    error NotController();
    error NotEligible();
    error NoVotingPower();
    error AlreadyVoted();
    error VotingClosed();
    error VotingStillOpen();
    error BadState(ProposalState actual);
    error UnknownProposal();
    error InvalidVotingPeriod();
    error TooManyActiveProposals();
    error NotOriginalYesVoter();
    error AlreadyConfirmed();
    error MarkCooldownActive(uint256 secondsRemaining);
    error TooManyRounds();
    error InsufficientTransferableForYes(uint256 required, uint256 available);
    error UriTooLong();
    error LocksNotReleasable();
    error AlreadyInitialized();

    /// @dev Deployed once as an implementation and cloned per store (EIP-1167). [0.25.P]
    constructor() {
        _initialized = true;
    }

    function initialize(address aicToken_, address store_, bytes32 storeId_) external {
        if (_initialized) revert AlreadyInitialized();
        require(aicToken_ != address(0) && store_ != address(0), "Gov: zero");
        _initialized = true;
        aicToken = IAICoin(aicToken_);
        store = store_;
        storeId = storeId_;
    }

    // ============================================================ lifecycle ==

    function proposal(uint256 proposalId) external view returns (Proposal memory) {
        if (proposalId == 0 || proposalId > proposalCount) revert UnknownProposal();
        return _proposals[proposalId];
    }

    function state(uint256 proposalId) public view returns (ProposalState) {
        if (proposalId == 0 || proposalId > proposalCount) revert UnknownProposal();
        Proposal storage p = _proposals[proposalId];
        if (p.state == ProposalState.Active && block.timestamp > p.votingDeadline) {
            return ProposalState.Failed;
        }
        return p.state;
    }

    /// @notice Whether a passed proposal has reached its verification threshold.
    function isResolved(uint256 proposalId) external view returns (bool) {
        if (proposalId == 0 || proposalId > proposalCount) return false;
        return _proposals[proposalId].state == ProposalState.ImplementationVerified;
    }

    /// @notice Whether a proposal has passed and is still unresolved (dividend suspension active).
    function isSuspending(uint256 proposalId) external view returns (bool) {
        if (proposalId == 0 || proposalId > proposalCount) return false;
        ProposalState s = _proposals[proposalId].state;
        return s == ProposalState.PassedAwaitingImplementation || s == ProposalState.ImplementedAwaitingVerification;
    }

    function voteLockId(uint256 proposalId) public view returns (bytes32) {
        return keccak256(abi.encode("AIC_GOVERNANCE_YES", address(this), proposalId));
    }

    /**
     * @notice Create a proposal. Only an eligible EOA that held AIC at the snapshot may propose.
     * @param contentHash Integrity hash of the off-chain proposal text/evidence bundle.
     * @param descriptionURI Bounded pointer to the off-chain proposal content (untrusted data).
     * @param votingPeriod Seconds of voting time, bounded by protocol constants.
     */
    function propose(bytes32 contentHash, string calldata descriptionURI, uint256 votingPeriod)
        external
        nonReentrant
        returns (uint256 proposalId)
    {
        if (votingPeriod < ProtocolConstants.MIN_VOTING_PERIOD || votingPeriod > ProtocolConstants.MAX_VOTING_PERIOD) {
            revert InvalidVotingPeriod();
        }
        if (bytes(descriptionURI).length > MAX_DESCRIPTION_URI_LENGTH) revert UriTooLong();
        if (!aicToken.isEligible(msg.sender)) revert NotEligible();
        if (activeProposalsOf[msg.sender] >= MAX_ACTIVE_PROPOSALS_PER_PROPOSER) revert TooManyActiveProposals();

        uint256 snapshotBlock = block.number - 1;
        if (aicToken.getPastBalance(msg.sender, snapshotBlock) == 0) revert NoVotingPower();

        uint256 eligibleAtSnapshot = aicToken.getPastEligibleSupply(snapshotBlock);
        if (eligibleAtSnapshot == 0) revert NoVotingPower();

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.proposer = msg.sender;
        p.snapshotBlock = uint48(snapshotBlock);
        p.votingDeadline = uint48(block.timestamp + votingPeriod);
        p.state = ProposalState.Active;
        p.contentHash = contentHash;
        p.descriptionURI = descriptionURI;
        p.eligibleSupplyAtSnapshot = eligibleAtSnapshot;

        activeProposalsOf[msg.sender] += 1;

        emit ProposalCreated(
            proposalId, msg.sender, contentHash, snapshotBlock, eligibleAtSnapshot, p.votingDeadline, descriptionURI
        );
    }

    /// @notice Cancel a proposal before any vote has been cast. Proposer only. [0.29.E]
    function cancel(uint256 proposalId) external nonReentrant {
        Proposal storage p = _requireProposal(proposalId);
        if (p.state != ProposalState.Active) revert BadState(p.state);
        if (p.voterCount != 0) revert BadState(p.state);
        if (msg.sender != p.proposer) revert NotController();

        p.state = ProposalState.CancelledBeforeFirstVote;
        _decrementActive(p.proposer);
        emit ProposalCancelled(proposalId);
    }

    /**
     * @notice Vote with historical snapshot power.
     * @dev A YES vote locks an equal amount of the current balance of the voter under a
     *      reason-scoped, non-custodial lock. The voter keeps ownership and eligibility, but
     *      cannot transfer that amount away while the obligation exists. [0.29.A]
     */
    function castVote(uint256 proposalId, bool support) external nonReentrant {
        Proposal storage p = _requireProposal(proposalId);
        if (p.state != ProposalState.Active) revert BadState(p.state);
        if (block.timestamp > p.votingDeadline) revert VotingClosed();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();
        if (!aicToken.isEligible(msg.sender)) revert NotEligible();

        uint256 weight = aicToken.getPastBalance(msg.sender, p.snapshotBlock);
        if (weight == 0) revert NoVotingPower();

        hasVoted[proposalId][msg.sender] = true;
        p.voterCount += 1;

        if (support) {
            uint256 available = aicToken.transferableBalanceOf(msg.sender);
            if (available < weight) revert InsufficientTransferableForYes(weight, available);

            originalYesWeight[proposalId][msg.sender] = weight;
            p.yesPower += weight;
            aicToken.lock(msg.sender, voteLockId(proposalId), weight);
        } else {
            p.noPower += weight;
        }

        emit VoteCast(proposalId, msg.sender, support, weight);

        // Atomic passage in the same state transition that crosses the threshold. [0.28.A/B]
        if (support && p.yesPower * ProtocolConstants.PROPOSAL_PASS_DENOMINATOR > p.eligibleSupplyAtSnapshot) {
            _pass(proposalId, p);
        }
    }

    function _pass(uint256 proposalId, Proposal storage p) private {
        p.state = ProposalState.PassedAwaitingImplementation;
        p.passedAt = uint48(block.timestamp);
        p.totalOriginalYesPower = p.yesPower;
        unresolvedPassedProposalCount += 1;
        _decrementActive(p.proposer);

        emit ProposalPassed(proposalId, p.totalOriginalYesPower, p.eligibleSupplyAtSnapshot, block.number, block.timestamp);

        IStore(store).onGovernanceProposalPassed(proposalId);
    }

    /// @notice Finalise a proposal that reached its deadline without passing. Permissionless.
    function finalizeFailed(uint256 proposalId) external nonReentrant {
        Proposal storage p = _requireProposal(proposalId);
        if (p.state != ProposalState.Active) revert BadState(p.state);
        if (block.timestamp <= p.votingDeadline) revert VotingStillOpen();

        p.state = ProposalState.Failed;
        _decrementActive(p.proposer);
        emit ProposalFailed(proposalId, p.yesPower, p.noPower);
    }

    // ======================================================== implementation ==

    /**
     * @notice Controller attestation that the approved change has been implemented.
     * @dev Unlocks nothing and restores no dividend. Repeating the same evidence hash is
     *      idempotent; a materially different claim opens a new verification round, which is
     *      rate limited and capped so the controller cannot grief voters. [0.28.C, 0.29.M]
     */
    function markImplemented(uint256 proposalId, bytes32 evidenceHash, string calldata evidenceURI)
        external
        nonReentrant
    {
        Proposal storage p = _requireProposal(proposalId);
        if (msg.sender != IStore(store).storeController()) revert NotController();
        if (bytes(evidenceURI).length > MAX_DESCRIPTION_URI_LENGTH) revert UriTooLong();

        if (p.state == ProposalState.PassedAwaitingImplementation) {
            p.state = ProposalState.ImplementedAwaitingVerification;
            p.implementationRound = 1;
        } else if (p.state == ProposalState.ImplementedAwaitingVerification) {
            if (p.evidenceHash == evidenceHash) {
                // Idempotent re-attestation of the same claim: no round change, no reset.
                emit ImplementationMarked(proposalId, p.implementationRound, evidenceHash, evidenceURI, block.timestamp);
                return;
            }
            uint256 elapsed = block.timestamp - p.markedImplementedAt;
            if (elapsed < MARK_IMPLEMENTED_COOLDOWN) {
                revert MarkCooldownActive(MARK_IMPLEMENTED_COOLDOWN - elapsed);
            }
            if (p.implementationRound >= MAX_IMPLEMENTATION_ROUNDS) revert TooManyRounds();
            p.implementationRound += 1;
            p.confirmedYesPower = 0;
        } else {
            revert BadState(p.state);
        }

        p.evidenceHash = evidenceHash;
        p.evidenceURI = evidenceURI;
        p.markedImplementedAt = uint48(block.timestamp);

        emit ImplementationMarked(proposalId, p.implementationRound, evidenceHash, evidenceURI, block.timestamp);
    }

    /// @notice Required confirmed power for the current round: ceil(totalOriginalYesPower / 2).
    function requiredVerificationPower(uint256 proposalId) public view returns (uint256) {
        Proposal storage p = _proposals[proposalId];
        uint256 total = p.totalOriginalYesPower;
        return (total + ProtocolConstants.VERIFICATION_DENOMINATOR - 1) / ProtocolConstants.VERIFICATION_DENOMINATOR;
    }

    /**
     * @notice Confirm that the controller actually implemented the approved change.
     * @dev Only members of the ORIGINAL YES coalition may confirm, weighted by the original
     *      YES weight. NO voters, abstainers and later buyers have zero verification power.
     */
    function confirmImplementation(uint256 proposalId) external nonReentrant {
        Proposal storage p = _requireProposal(proposalId);
        if (p.state != ProposalState.ImplementedAwaitingVerification) revert BadState(p.state);
        if (!aicToken.isEligible(msg.sender)) revert NotEligible();

        uint256 weight = originalYesWeight[proposalId][msg.sender];
        if (weight == 0) revert NotOriginalYesVoter();

        uint32 round = p.implementationRound;
        if (hasConfirmed[proposalId][round][msg.sender]) revert AlreadyConfirmed();
        hasConfirmed[proposalId][round][msg.sender] = true;

        p.confirmedYesPower += weight;
        uint256 required = requiredVerificationPower(proposalId);

        emit ImplementationConfirmed(proposalId, round, msg.sender, weight, p.confirmedYesPower, required);

        if (p.confirmedYesPower * ProtocolConstants.VERIFICATION_DENOMINATOR >= p.totalOriginalYesPower) {
            p.state = ProposalState.ImplementationVerified;
            unresolvedPassedProposalCount -= 1;
            emit VerificationThresholdReached(proposalId, p.confirmedYesPower, p.totalOriginalYesPower);
            IStore(store).onGovernanceProposalResolved(proposalId);
        }
    }

    /// @notice Record a dispute for visibility. Does not subtract already-confirmed power. [0.28.I]
    function disputeImplementation(uint256 proposalId, string calldata reason) external {
        Proposal storage p = _requireProposal(proposalId);
        if (p.state != ProposalState.ImplementedAwaitingVerification) revert BadState(p.state);
        if (originalYesWeight[proposalId][msg.sender] == 0) revert NotOriginalYesVoter();
        if (bytes(reason).length > MAX_DESCRIPTION_URI_LENGTH) revert UriTooLong();
        emit ImplementationDisputed(proposalId, p.implementationRound, msg.sender, reason);
    }

    // ================================================================ locks ==

    /**
     * @notice Release a YES vote lock once its proposal reached a lock-releasing state.
     * @dev Permissionless: anyone may release on behalf of a voter, so a passive voter can
     *      never be stuck. Locks of other reasons are untouched. [0.29.A, 0.29.E]
     */
    function releaseVoteLock(uint256 proposalId, address voter) public nonReentrant {
        Proposal storage p = _requireProposal(proposalId);
        ProposalState s = state(proposalId);
        bool releasable = s == ProposalState.Failed || s == ProposalState.CancelledBeforeFirstVote
            || s == ProposalState.ImplementationVerified;
        if (!releasable) revert LocksNotReleasable();

        uint256 weight = originalYesWeight[proposalId][voter];
        if (weight == 0 || voteLockReleased[proposalId][voter]) return;

        // A deadline-expired proposal is settled lazily here as well as via finalizeFailed.
        if (p.state == ProposalState.Active) {
            p.state = ProposalState.Failed;
            _decrementActive(p.proposer);
            emit ProposalFailed(proposalId, p.yesPower, p.noPower);
        }

        voteLockReleased[proposalId][voter] = true;
        aicToken.release(voter, voteLockId(proposalId));
        emit VoteLockReleased(proposalId, voter, weight);
    }

    function releaseVoteLocks(uint256 proposalId, address[] calldata voters) external {
        uint256 len = voters.length;
        require(len <= 200, "Gov: batch too large");
        for (uint256 i = 0; i < len; i++) {
            releaseVoteLock(proposalId, voters[i]);
        }
    }

    // ============================================================= internal ==

    function _requireProposal(uint256 proposalId) private view returns (Proposal storage) {
        if (proposalId == 0 || proposalId > proposalCount) revert UnknownProposal();
        return _proposals[proposalId];
    }

    function _decrementActive(address proposer) private {
        uint256 current = activeProposalsOf[proposer];
        if (current > 0) activeProposalsOf[proposer] = current - 1;
    }
}
