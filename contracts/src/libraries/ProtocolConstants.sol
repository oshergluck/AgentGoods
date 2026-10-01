// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

/**
 * @title ProtocolConstants
 * @notice Single on-chain source of truth for AIC protocol economic constants.
 * @dev MASTER_PLAN §0.21.P ("One source of truth for constants"). The backend,
 *      frontend, schema generator and tests all derive their values from the
 *      generated protocol manifest, which is in turn generated from this file
 *      plus deployment output. Never redeclare these numbers elsewhere.
 */
library ProtocolConstants {
    // ----------------------------------------------------------------- units
    /// @notice AIC tokens use 18 decimals.
    uint8   internal constant AIC_DECIMALS = 18;
    /// @notice Canonical USDC uses 6 decimals on every supported deployment chain.
    uint8   internal constant USDC_DECIMALS = 6;
    /// @notice Basis-point denominator.
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    // -------------------------------------------------------------- genesis
    /// @notice Exactly 1,000,000,000 AIC (18 decimals) per store. MASTER_PLAN §12A.1.
    uint256 internal constant AIC_GENESIS_SUPPLY = 1_000_000_000 * 10 ** 18;

    /// @notice Bonding-curve virtual USDC pricing reserve: 6,000 USDC. MASTER_PLAN §12A.4.
    /// @dev Pricing state only. Never real, never withdrawable, never sent to LP.
    uint256 internal constant VIRTUAL_USDC_RESERVE = 6_000 * 10 ** 6;

    /// @notice Net AIC that must be removed from the curve to trigger the DEX transition.
    /// @dev 30% of genesis supply. MASTER_PLAN §0.13 "Exact meaning of the 30% transition".
    uint256 internal constant TRANSITION_THRESHOLD_AIC = 300_000_000 * 10 ** 18;

    /// @notice Minimum owner-funded initial market capital for a new store: 5 USDC (6 decimals).
    /// @dev Not a fee. The creator's USDC buys the store's own AIC on its curve in the creation
    ///      transaction, so every new store is born with real liquidity and an owner position.
    uint256 internal constant MIN_INITIAL_OWNER_SEED_USDC = 5 * 10 ** 6;

    /// @notice Minimum product price: 523 base units (0.000523 USDC).
    /// @dev The smallest price whose holders' share (20% of net commerce) still buys back at least 100 base
    ///      units of USDC even at the maximum 5% commerce fee (102 at the default 2.5%). A cheaper product
    ///      would fund a buyback of dust.
    uint256 internal constant MIN_PRODUCT_PRICE_USDC = 523;

    /// @notice LP pricing premium applied at transition, preserved from V0 (+35%).
    uint256 internal constant LP_PREMIUM_BPS = 3_500;

    // ------------------------------------------------------------ fee rates
    /// @notice Launch commerce protocol fee on Sales/Rentals gross payments: 2.5%.
    uint16 internal constant COMMERCE_FEE_BPS = 250;
    /// @notice Launch AgentGoods protocol trading fee (pre-transition only): 2%.
    uint16 internal constant AGENTGOODS_PROTOCOL_FEE_BPS = 200;
    /// @notice Launch AgentGoods current-store-controller trading fee (pre-transition only): 1%.
    uint16 internal constant AGENTGOODS_CONTROLLER_FEE_BPS = 100;
    /// @notice Mandatory continuous holder reserve rate, on store NET commerce: 20%.
    /// @dev Raised from 5% (500 bps). At 5% a store's equity was economically inert: holding
    ///      another agent's AIC returned so little that autonomous participants ignored equity
    ///      almost entirely, trading finished goods and essentially never taking a position in
    ///      each other. Owning a piece of a working business has to pay enough to be worth the
    ///      capital, or a market in businesses does not form. MASTER_PLAN §0.20.
    uint16 internal constant HOLDER_RESERVE_BPS = 2_000;
    /// @notice Dividend processing fee, charged ON THE COMMITTED RESERVE: 5%. MASTER_PLAN §0.25.E.
    uint16 internal constant DIVIDEND_PROCESSING_FEE_BPS = 500;

    // ------------------------------------------------------------ hard caps
    uint16 internal constant MAX_COMMERCE_FEE_BPS = 500;             // 5%
    uint16 internal constant MAX_AGENTGOODS_PROTOCOL_FEE_BPS = 300;   // 3%
    uint16 internal constant MAX_AGENTGOODS_CONTROLLER_FEE_BPS = 200; // 2%
    uint16 internal constant MAX_DIVIDEND_PROCESSING_FEE_BPS = 1_000;// 10%
    /// @notice The mandatory holder reserve rate is an invariant, not an adjustable fee.
    /// @dev Must track HOLDER_RESERVE_BPS. It exists to state that this rate is fixed at deploy
    ///      time and cannot be tuned by a controller afterwards -- changing it requires a new
    ///      deployment, which is the point.
    uint16 internal constant HOLDER_RESERVE_BPS_IMMUTABLE = 2_000;

    // ------------------------------------------------------------- takeover
    /// @notice Continuous verified-leader duration required to finalize a takeover.
    /// @dev MASTER_PLAN §0.25.B: ">= 3600 seconds of chain timestamp".
    uint256 internal constant TAKEOVER_OBSERVATION_PERIOD = 3_600;

    // ------------------------------------------------------------ dividends
    /// @notice Minimum committed reserve required to open a distribution epoch (1 USDC).
    /// @dev MASTER_PLAN §0.20 "Minimum trigger / anti-spam". Below this, reserve safely accumulates.
    uint256 internal constant MIN_DISTRIBUTION_USDC = 1 * 10 ** 6;
    /// @notice Adversarial verification window between root proposal and finalization.
    /**
     * @notice Dividend entitlement is the MINIMUM balance across this window, not the balance at
     *         the snapshot. [MASTER_PLAN 29C]
     * @dev A buy placed one block before a permissionless `openDistribution` would otherwise earn
     *      the same per token as a position held through the weeks in which the reserve accrued.
     */
    /*
     * THREE HOURS, reduced from seven days.
     *
     * The window is the anti-snipe rule: entitlement is the MINIMUM balance across it, so an
     * account whose first acquisition falls inside it opens at zero and weighs zero. That is
     * correct and it is the whole point — but it also means the window is a hard floor on how long
     * a market must run before ANY dividend is claimable. At seven days, nothing shorter than a
     * week could ever pay a holder a single unit, however much reserve accrued.
     *
     * Three hours keeps the property exactly: you must hold across the window before an epoch
     * opens, and buying just before a snapshot still weighs nothing. It only stops the rule from
     * being unreachable. It is also the same three hours as the controller withdrawal cooldown, so
     * a controller's cash and its holders' claim move on one clock rather than two.
     */
    uint32 internal constant HOLDING_WINDOW_SECONDS = 10_800; // 3 hours
    /// @notice Upper bound on a governed holding window. A longer one would strand the reserve.
    uint32 internal constant MAX_HOLDING_WINDOW_SECONDS = 2_592_000; // 30 days
    /**
     * @notice Nominal block time of the target chain, used to express the holding window in the
     *         block-number units the balance checkpoints are keyed by.
     * @dev Base produces a block every 2 seconds. A wrong value here only stretches or shortens
     *      the window; it can never over-allocate, because the weight is a minimum either way.
     */
    uint32 internal constant NOMINAL_BLOCK_TIME_SECONDS = 2;

    uint256 internal constant ROOT_CHALLENGE_PERIOD = 6 hours;
    /// @notice If no root is finalized within this window, the epoch may be permissionlessly
    ///         abandoned and its reserve rolled forward. MASTER_PLAN §0.21.A liveness cure.
    uint256 internal constant ROOT_LIVENESS_TIMEOUT = 30 days;

    // ----------------------------------------------------------- governance
    /// @notice Proposal passes when yesPower * 2 > eligibleEOASupplyAtSnapshot. Exactly 50% fails.
    /// @dev Encoded as a numerator/denominator pair for schema generation. MASTER_PLAN §0.28.A.
    uint256 internal constant PROPOSAL_PASS_NUMERATOR = 1;
    uint256 internal constant PROPOSAL_PASS_DENOMINATOR = 2;
    /// @notice Implementation unlocks when verifiedYesPower * 2 >= totalOriginalYesPower (>=50%).
    uint256 internal constant VERIFICATION_NUMERATOR = 1;
    uint256 internal constant VERIFICATION_DENOMINATOR = 2;
    uint256 internal constant MIN_VOTING_PERIOD = 1 hours;
    uint256 internal constant MAX_VOTING_PERIOD = 30 days;

    // --------------------------------------------------------------- bounds
    uint256 internal constant MAX_METADATA_URI_LENGTH = 4_096;
    /// @notice Bound on the inline store profile document. Untrusted seller content.
    uint256 internal constant MAX_STORE_PROFILE_LENGTH = 8_192;
    uint256 internal constant MAX_PRODUCT_NAME_LENGTH = 256;
    uint256 internal constant MAX_PURCHASE_QUANTITY = 1_000;
}
