/**
 * MongoDB read model.
 *
 * The chain is the settlement and source-of-truth layer; Mongo is a projection (rule 15).
 * Design rules enforced here:
 *
 *  - MASTER_PLAN 0.25.Z: security-relevant identities have real unique indexes, not
 *    application-level "check then insert".
 *  - MASTER_PLAN 0.25.Y: chain events are at-least-once inputs, so every projection write is
 *    idempotent and keyed on (chainId, txHash, logIndex).
 *  - MASTER_PLAN 0.25.AA: money is stored as exact base-unit strings, never as a double.
 *    Sortable amounts carry a zero-padded companion key.
 *  - MASTER_PLAN 0.27.S: seller-supplied content lives in clearly named untrusted fields and
 *    is never mixed into the trusted protocol fields.
 */

import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Mongoose automatic timestamps are renamed to `indexedAt` / `indexedUpdatedAt`.
 *
 * Several projections carry a CHAIN-derived `createdAt` (a block timestamp in seconds). With
 * the default option names, Mongoose silently overwrote that field with the wall-clock insert
 * time in milliseconds, replacing chain truth with operational metadata. Renaming makes the
 * distinction explicit and impossible to collide with, which is also what MASTER_PLAN 0.25.AB
 * asks for: chain timestamps for on-chain economic time, separate operational timestamps for
 * off-chain records.
 */
const opts = {
  timestamps: { createdAt: "indexedAt", updatedAt: "indexedUpdatedAt" },
  versionKey: false,
} as const;

/* ------------------------------------------------------------------ chain events */

/**
 * Canonical decoded log store. Projections are folded from these, which is what makes the
 * mandated "delete the projection and rebuild from chain" test (MASTER_PLAN 0.3) exact.
 */
const chainEventSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    blockNumber: { type: Number, required: true },
    blockHash: { type: String, required: true },
    txHash: { type: String, required: true },
    txIndex: { type: Number, required: true },
    logIndex: { type: Number, required: true },
    address: { type: String, required: true, lowercase: true },
    contractRole: { type: String, required: true },
    eventName: { type: String, required: true },
    /** Decoded args, all numerics stringified. */
    args: { type: Schema.Types.Mixed, required: true },
    blockTimestamp: { type: Number, required: true },
    /** Entity keys this event projects onto, used for targeted reorg re-projection. */
    storeId: { type: String, default: null },
    finality: { type: String, enum: ["pending", "safe"], required: true, default: "pending" },
  },
  opts
);
chainEventSchema.index({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true });
chainEventSchema.index({ chainId: 1, blockNumber: 1, logIndex: 1 });
chainEventSchema.index({ chainId: 1, address: 1, eventName: 1, blockNumber: 1 });
chainEventSchema.index({ storeId: 1, blockNumber: 1, logIndex: 1 });

/* ---------------------------------------------------------------- indexer cursor */

const indexerCursorSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    stream: { type: String, required: true },
    lastProcessedBlock: { type: Number, required: true, default: 0 },
    lastProcessedBlockHash: { type: String, default: null },
    /** Highest block considered final under SAFE_CONFIRMATIONS. */
    safeBlock: { type: Number, required: true, default: 0 },
    chainHead: { type: Number, required: true, default: 0 },
    lastIndexedAt: { type: Date, default: null },
    status: { type: String, enum: ["starting", "backfilling", "live", "degraded", "stopped"], default: "starting" },
    lastError: { type: String, default: null },
  },
  opts
);
indexerCursorSchema.index({ chainId: 1, stream: 1 }, { unique: true });

/** Rolling record of recently seen block hashes, used to detect a reorg cheaply. */
const blockRefSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    blockNumber: { type: Number, required: true },
    blockHash: { type: String, required: true },
    parentHash: { type: String, required: true },
    timestamp: { type: Number, required: true },
  },
  opts
);
blockRefSchema.index({ chainId: 1, blockNumber: 1 }, { unique: true });

/* ------------------------------------------------------------------ agents/auth */

const agentAccountSchema = new Schema(
  {
    walletAddress: { type: String, required: true, lowercase: true },
    chainId: { type: Number, required: true },
    apiKeyHash: { type: String, default: null },
    apiKeyPrefix: { type: String, default: null },
    status: { type: String, enum: ["NO_KEY", "ACTIVE", "REVOKED"], required: true, default: "NO_KEY" },
    issuedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    rotationCount: { type: Number, default: 0 },
    /** The newest site update this wallet has read, by GET /api/v1/updates with its key. */
    updatesReadAt: { type: Date, default: null },
    /** Optional Agent-configurable, off-chain-only preferences. Never wallet authority. */
    policy: {
      maxPerTransactionUSDC: { type: String, default: null },
      maxDailyUSDC: { type: String, default: null },
      allowedContracts: { type: [String], default: [] },
    },
  },
  opts
);
// One active key per wallet, enforced by the database, not by application logic. [0.27.D]
agentAccountSchema.index({ walletAddress: 1, chainId: 1 }, { unique: true });
agentAccountSchema.index({ apiKeyHash: 1 }, { unique: true, sparse: true });

const authChallengeSchema = new Schema(
  {
    nonce: { type: String, required: true },
    purpose: {
      type: String,
      required: true,
      enum: ["ISSUE_API_KEY", "ROTATE_API_KEY", "REVOKE_API_KEY", "HUMAN_LOGIN", "STORE_ADMIN"],
    },
    walletAddress: { type: String, required: true, lowercase: true },
    chainId: { type: Number, required: true },
    origin: { type: String, default: null },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  opts
);
// Single-use, purpose-scoped, wallet-scoped, chain-scoped, short-lived. [0.27.B]
authChallengeSchema.index({ nonce: 1 }, { unique: true });
authChallengeSchema.index({ walletAddress: 1, purpose: 1, chainId: 1 });
authChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

const apiUsageSchema = new Schema(
  {
    walletAddress: { type: String, required: true, lowercase: true },
    apiKeyPrefix: { type: String, default: null },
    route: { type: String, required: true },
    method: { type: String, required: true },
    status: { type: Number, required: true },
    latencyMs: { type: Number, required: true },
    requestId: { type: String, required: true },
    at: { type: Date, required: true, default: () => new Date() },
  },
  opts
);
apiUsageSchema.index({ walletAddress: 1, at: -1 });
apiUsageSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

/* --------------------------------------------------------- seller profiles */

/**
 * Untrusted seller media reference. The backend never dereferences `uri`; `origin` tells the
 * UI whether loading it would reach a third party. See src/content/profile.ts.
 */
const mediaSchema = new Schema(
  {
    kind: { type: String, enum: ["image", "video"], default: "image" },
    uri: { type: String, required: true },
    alt: { type: String, default: "" },
    origin: { type: String, enum: ["same_origin", "external", "ipfs"], default: "external" },
  },
  { _id: false }
);

/** Parsed, shape-sanitized projection of an on-chain seller profile document. [0.24.P] */
const profileSchema = new Schema(
  {
    parsed: { type: Boolean, default: false },
    uri: { type: String, default: "" },
    name: { type: String, default: "" },
    tagline: { type: String, default: "" },
    description: { type: String, default: "" },
    highlights: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    category: { type: String, default: "" },
    logo: { type: mediaSchema, default: null },
    cover: { type: mediaSchema, default: null },
    media: { type: [mediaSchema], default: [] },
    tokenDescription: { type: String, default: "" },
    tokenLogo: { type: mediaSchema, default: null },
    iterations: { type: Number, default: null },
    iterationsTotal: { type: Number, default: null },
    iterationLogHash: { type: String, default: null },
    /** Set on a SERVICE listing: the committed spec (input/output schemas) and its pricing model. */
    serviceSpecHash: { type: String, default: null },
    servicePricingModel: { type: String, default: null },
    rejected: { type: [String], default: [] },
  },
  { _id: false }
);

/* ---------------------------------------------------------------------- stores */

const storeSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    address: { type: String, required: true, lowercase: true },
    storeType: { type: String, enum: ["sales", "rentals"], required: true },
    storeCreator: { type: String, required: true, lowercase: true },
    storeController: { type: String, required: true, lowercase: true },
    /** Owner-funded initial market capital from the creation transaction (InitialOwnerSeed). */
    initialOwnerSeedUSDC: { type: String, default: "0" },
    initialOwnerSeedAIC: { type: String, default: "0" },
    ownershipEpoch: { type: Number, required: true, default: 1 },
    accessAttestor: { type: String, default: null, lowercase: true },
    status: { type: String, enum: ["active", "paused", "deprecated"], default: "active" },

    aicToken: { type: String, required: true, lowercase: true },
    licenseToken: { type: String, required: true, lowercase: true },
    governance: { type: String, required: true, lowercase: true },
    dividendDistributor: { type: String, required: true, lowercase: true },
    factory: { type: String, required: true, lowercase: true },
    factoryVersion: { type: Number, required: true },

    createdBlock: { type: Number, required: true },
    createdLogIndex: { type: Number, required: true },
    createdTxHash: { type: String, required: true },
    createdAt: { type: Number, required: true },
    cursor: { type: String, required: true },

    /** Untrusted seller-supplied display data. Never a protocol instruction. [0.24.P] */
    sellerContent: {
      /** Display name from the Factory StoreCreated event. */
      name: { type: String, default: "" },
      /** ERC20 metadata of the store token, from the Factory event. Display text, not an id. */
      tokenName: { type: String, default: "" },
      tokenSymbol: { type: String, default: "" },
      /** Raw on-chain profile document, preserved verbatim. */
      profileRaw: { type: String, default: "" },
      profile: { type: profileSchema, default: () => ({}) },
    },

    ownerAvailableUSDC: { type: String, default: "0" },
    /**
     * Unix seconds of the controller's last proceeds withdrawal, or 0 if it has never withdrawn.
     *
     * StoreBase rate-limits withdrawals to one every WITHDRAWAL_COOLDOWN (3 hours). The contract
     * is the authority, but a UI and an agent both need the countdown for MANY stores at once, and
     * an RPC round trip per store to read a timestamp that an event already told us is a cost paid
     * on every listing forever. So it is projected from the event and the derived countdown is
     * computed against the request clock, never stored.
     *
     * 0 means "never withdrawn", which is NOT the same as "cooldown elapsed" - it is the one case
     * where there is no cooldown at all, because the first withdrawal is always allowed.
     */
    lastOwnerWithdrawalAt: { type: Number, default: 0 },
    unfinalizedHolderReserveUSDC: { type: String, default: "0" },
    lifetimeGrossCommerceUSDC: { type: String, default: "0" },
    lifetimeNetCommerceUSDC: { type: String, default: "0" },
    lifetimeProtocolFeeUSDC: { type: String, default: "0" },
    lifetimeHolderReserveAccruedUSDC: { type: String, default: "0" },
    /** USDC of this store's commerce spent buying back and burning its own AIC, lifetime. */
    lifetimeBuybackUSDC: { type: String, default: "0" },
    /** AIC burned by those buybacks, lifetime. */
    lifetimeBuybackBurnedAIC: { type: String, default: "0" },
    lifetimeHolderReserveCommittedUSDC: { type: String, default: "0" },
    rewardPoolAIC: { type: String, default: "0" },
    lifetimeRewardDistributedAIC: { type: String, default: "0" },

    unresolvedPassedProposalCount: { type: Number, default: 0 },
    governanceLockActive: { type: Boolean, default: false },

    canonical: { type: Boolean, default: true },
    indexedBlock: { type: Number, default: 0 },
  },
  opts
);
storeSchema.index({ chainId: 1, storeId: 1 }, { unique: true });
storeSchema.index({ chainId: 1, address: 1 }, { unique: true });
storeSchema.index({ chainId: 1, aicToken: 1 }, { unique: true });
storeSchema.index({ chainId: 1, licenseToken: 1 }, { unique: true });
storeSchema.index({ chainId: 1, governance: 1 }, { unique: true });
storeSchema.index({ chainId: 1, dividendDistributor: 1 }, { unique: true });
storeSchema.index({ createdBlock: -1, createdLogIndex: -1 });
storeSchema.index({ storeController: 1 });

/* -------------------------------------------------------------------- products */

const declarationSchema = new Schema(
  {
    /** Phase 10.1. UNVERIFIED SELLER CLAIM. Copied verbatim from chain, never computed. */
    declared: { type: Boolean, required: true, default: false },
    tokensSaved: { type: String, default: null },
    tokensSavedSort: { type: String, default: null },
    modelTier: { type: String, default: null },
    basis: { type: String, enum: ["UNDECLARED", "ESTIMATED", "MEASURED"], default: "UNDECLARED" },
    declaredAt: { type: Number, default: null },
    /** Derived projection, recomputed on every update, never stored as truth. [14A.1] */
    tokensSavedPerUsdc: { type: String, default: null },
    tokensSavedPerUsdcSort: { type: String, default: null },
  },
  { _id: false }
);

const productSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    storeAddress: { type: String, required: true, lowercase: true },
    storeType: { type: String, enum: ["sales", "rentals"], required: true },
    productId: { type: String, required: true },
    version: { type: Number, required: true },

    priceUSDC: { type: String, required: true },
    priceUSDCSort: { type: String, required: true },
    inventory: { type: String, required: true },
    unlimitedInventory: { type: Boolean, default: false },
    rentalPeriodSeconds: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    contentHash: { type: String, default: null },

    /** Untrusted seller content, structurally separated from protocol fields. [0.27.S] */
    sellerContent: {
      metadataURI: { type: String, default: "" },
      profile: { type: profileSchema, default: () => ({}) },
    },

    declaration: { type: declarationSchema, default: () => ({}) },

    createdBlock: { type: Number, required: true },
    createdLogIndex: { type: Number, required: true },
    createdTxHash: { type: String, required: true },
    createdAt: { type: Number, required: true },
    updatedBlock: { type: Number, required: true },
    cursor: { type: String, required: true },

    canonical: { type: Boolean, default: true },
    deleted: { type: Boolean, default: false },
  },
  opts
);
productSchema.index({ chainId: 1, storeId: 1, productId: 1 }, { unique: true });
productSchema.index({ createdBlock: -1, createdLogIndex: -1 });
productSchema.index({ active: 1, createdBlock: -1, createdLogIndex: -1 });
productSchema.index({ "declaration.declared": 1, "declaration.tokensSavedPerUsdcSort": -1 });
productSchema.index({ "declaration.basis": 1 });
productSchema.index({ "declaration.modelTier": 1 });
productSchema.index({ priceUSDCSort: 1 });
productSchema.index({ storeType: 1, active: 1 });

/**
 * Immutable historical declaration per (productId, version).
 * MASTER_PLAN 14A.1: a historical purchase keeps the claim it was sold under. The product
 * document holds the CURRENT version; this collection is append-only history.
 */
const productVersionSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    productId: { type: String, required: true },
    version: { type: Number, required: true },
    /*
     * What the seller says they changed in this version.
     *
     * The point of a version is that somebody fixed something; without a note, a buyer sees only
     * that the bytes differ. Seller-written and unverified, like every other seller claim here.
     */
    changelog: { type: String, default: "", maxlength: 600 },
    priceUSDC: { type: String, required: true },
    rentalPeriodSeconds: { type: Number, default: 0 },
    contentHash: { type: String, default: null },
    sellerContent: { metadataURI: { type: String, default: "" }, profile: { type: profileSchema, default: () => ({}) } },
    declaration: { type: declarationSchema, default: () => ({}) },
    blockNumber: { type: Number, required: true },
    logIndex: { type: Number, required: true },
    txHash: { type: String, required: true },
    at: { type: Number, required: true },
  },
  opts
);
productVersionSchema.index({ chainId: 1, storeId: 1, productId: 1, version: 1 }, { unique: true });

/* -------------------------------------------------------------------- licenses */

const licenseSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    licenseToken: { type: String, required: true, lowercase: true },
    tokenId: { type: String, required: true },
    owner: { type: String, required: true, lowercase: true },
    productId: { type: String, required: true },
    productVersion: { type: Number, required: true },
    kind: { type: String, enum: ["permanent", "rental"], required: true },
    quantity: { type: Number, required: true },
    issuedAt: { type: Number, required: true },
    expiresAt: { type: Number, default: 0 },
    permissionHash: { type: String, default: null },
    tokenURI: { type: String, default: "" },

    /** Phase 10.1 delivery record, folded from AccessGranted events. */
    accessGrantCount: { type: Number, default: 0 },
    firstAccessAt: { type: Number, default: null },
    lastAccessAt: { type: Number, default: null },
    delivered: { type: Boolean, default: false },

    blockNumber: { type: Number, required: true },
    logIndex: { type: Number, required: true },
    txHash: { type: String, required: true },
    cursor: { type: String, required: true },
  },
  opts
);
licenseSchema.index({ chainId: 1, licenseToken: 1, tokenId: 1 }, { unique: true });
licenseSchema.index({ owner: 1, blockNumber: -1 });
licenseSchema.index({ storeId: 1, productId: 1 });
licenseSchema.index({ delivered: 1, storeId: 1 });

/* ------------------------------------------------------ Phase 10.1 buyer signal */

const buyerSignalSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    licenseToken: { type: String, required: true, lowercase: true },
    licenseId: { type: String, required: true },
    productId: { type: String, required: true },
    /** The seller identity a signal is attributed to: the controller at signal time. */
    sellerWallet: { type: String, required: true, lowercase: true },
    signaller: { type: String, required: true, lowercase: true },
    worthIt: { type: Boolean, required: true },
    /*
     * What was actually wrong with it, in the buyer's words.
     *
     * A boolean tells a seller that something failed and nothing about what. That is the least
     * actionable possible feedback in a market whose whole premise is that sellers improve — so
     * the signal carries a short written note beside the verdict. Buyer-written and therefore
     * untrusted: rendered as text, never as markup, and never believed by the protocol.
     */
    note: { type: String, default: "", maxlength: 600 },
    /*
     * Which VERSION of the product this verdict was about.
     *
     * Without it, a seller who fixed the fault is stuck with a judgement of the thing they
     * replaced, and a buyer has no way to say "this is better now". Recording the version is what
     * lets a signal be reopened when — and only when — the product genuinely changed.
     */
    productVersion: { type: Number, default: 0 },
    /** True when buyer and seller resolve to the same owner wallet. Excluded from rates. */
    selfSignal: { type: Boolean, required: true, default: false },
    changed: { type: Boolean, default: false },
    signalledAt: { type: Number, required: true },
    changedAt: { type: Number, default: null },
    blockNumber: { type: Number, required: true },
    logIndex: { type: Number, required: true },
    txHash: { type: String, required: true },
  },
  opts
);
// One signal per license, ever. Database-enforced. [14A.2]
buyerSignalSchema.index({ chainId: 1, licenseToken: 1, licenseId: 1 }, { unique: true });
buyerSignalSchema.index({ storeId: 1, signalledAt: -1 });
buyerSignalSchema.index({ productId: 1, selfSignal: 1 });
buyerSignalSchema.index({ sellerWallet: 1, selfSignal: 1, signalledAt: -1 });

/* --------------------------------------------------------------- markets/trades */

const stockMarketSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    aicToken: { type: String, required: true, lowercase: true },
    storeId: { type: String, required: true },
    storeAddress: { type: String, required: true, lowercase: true },
    name: { type: String, default: "" },
    symbol: { type: String, default: "" },
    decimals: { type: Number, default: 18 },

    phase: { type: String, enum: ["bonding_curve", "transitioning", "external_dex"], default: "bonding_curve" },
    genesisSupplyAIC: { type: String, required: true },
    currentSupplyAIC: { type: String, required: true },
    burnedAIC: { type: String, default: "0" },
    /** Burned by buybacks: the holders' share of commerce buying this token and burning it. */
    buybackBurnedAIC: { type: String, default: "0" },
    /** USDC of commerce spent on buybacks, lifetime. */
    lifetimeBuybackUSDC: { type: String, default: "0" },
    /** A graduated market's buyback waiting for its pool swap (see AgentGoods.flushBuyback). */
    pendingBuybackUSDC: { type: String, default: "0" },
    marketInventoryAIC: { type: String, required: true },
    netSoldFromCurveAIC: { type: String, default: "0" },
    netSoldPercentageBps: { type: Number, default: 0 },
    virtualUSDCReserve: { type: String, required: true },
    virtualTokenReserve: { type: String, required: true },
    realUSDCReserve: { type: String, default: "0" },
    controllerFeesUSDC: { type: String, default: "0" },
    lifetimeGrossVolumeUSDC: { type: String, default: "0" },
    currentIndexedPrice1e18: { type: String, default: "0" },
    lpCreated: { type: Boolean, default: false },
    // Set once, permanently, when a market reached the graduation threshold with a funded
    // external pool already in existence. Such a market never lists and stays on its curve.
    graduationBlocked: { type: Boolean, default: false },
    /*
     * Takeover state, projected so a controller can be WARNED rather than surprised.
     *
     * The protocol already guarantees at least an hour of public notice — a candidacy emits an
     * event and cannot finalize for TAKEOVER_OBSERVATION_PERIOD — but nothing was surfacing it,
     * so in practice the notice existed and nobody received it.
     */
    takeoverCandidate: { type: String, default: null, lowercase: true },
    takeoverOpenedAt: { type: Number, default: 0 },
    takeoverLockedBalance: { type: String, default: "0" },
    currentLeader: { type: String, default: null, lowercase: true },
    currentLeaderSince: { type: Number, default: 0 },
    // The seeded half of the curve. Constant at 6,000 USDC for the entire life of almost every
    // market — but a blocked market's graduation-equivalent burn reduces it, so it is stored
    // rather than assumed. Assuming it would make reserveIdentity.holds publish false.
    virtualSeedUSDC: { type: String, default: "6000000000" },
    burnedAtGraduationBlockedAIC: { type: String, default: "0" },
    graduationBlockedPair: { type: String, default: null, lowercase: true },
    graduationBlockedAt: { type: Number, default: 0 },
    pair: { type: String, default: null, lowercase: true },
    lpTokenAmount: { type: String, default: "0" },
    eligibleSupplyAIC: { type: String, default: "0" },
    holderCount: { type: Number, default: 0 },

    createdBlock: { type: Number, required: true },
    createdLogIndex: { type: Number, required: true },
    cursor: { type: String, required: true },
    lastActivityAt: { type: Number, default: 0 },
  },
  opts
);
stockMarketSchema.index({ chainId: 1, aicToken: 1 }, { unique: true });
stockMarketSchema.index({ chainId: 1, storeId: 1 }, { unique: true });
stockMarketSchema.index({ createdBlock: -1, createdLogIndex: -1 });

const stockTradeSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    aicToken: { type: String, required: true, lowercase: true },
    storeId: { type: String, required: true },
    trader: { type: String, required: true, lowercase: true },
    side: { type: String, enum: ["buy", "sell"], required: true },
    // Owner capital kept apart from independent demand: the store's own controller traded, and the
    // creation-time owner seed specifically.
    byController: { type: Boolean, default: false },
    ownerSeed: { type: Boolean, default: false },
    /** A buyback: the store's commerce buying its own AIC to burn — protocol mechanics, never independent demand. */
    buyback: { type: Boolean, default: false },
    /*
     * Which venue filled this trade.
     *
     * Curve trades and pool swaps are deliberately folded into ONE collection so that volume and
     * history do not have to be stitched together by every consumer. That only works if a
     * consumer can still tell them apart when it matters — the fees differ, the price impact
     * differs, and after graduation the curve stops trading entirely. Defaulted to "curve"
     * because every trade written before this field existed was one.
     */
    venue: { type: String, enum: ["curve", "dex"], default: "curve", required: true },
    grossUSDC: { type: String, required: true },
    protocolFeeUSDC: { type: String, required: true },
    controllerFeeUSDC: { type: String, required: true },
    netUSDC: { type: String, required: true },
    tokensAIC: { type: String, required: true },
    /** What this trade actually executed at: gross USDC / tokens, fees included. */
    pricePerToken1e18: { type: String, required: true },
    /*
     * The market's SPOT price immediately after this trade.
     *
     * Two different prices exist for one trade and conflating them draws a chart that contradicts
     * its own trade list. The executed average is what the trader paid — above spot for a buy,
     * because of slippage and fees — and belongs in a trade list. The spot price is what the next
     * unit would cost, and is the only one that forms a continuous series: plotting executed
     * averages against periodic spot samples made every buy spike the line and every following
     * sample fall back, producing repeatable ~2.4% "drops" that no sell had caused.
     */
    spotPriceAfter1e18: { type: String, default: "" },
    netSoldFromCurveAIC: { type: String, required: true },
    blockNumber: { type: Number, required: true },
    logIndex: { type: Number, required: true },
    txHash: { type: String, required: true },
    at: { type: Number, required: true },
  },
  opts
);
stockTradeSchema.index({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true });
stockTradeSchema.index({ aicToken: 1, blockNumber: -1, logIndex: -1 });
stockTradeSchema.index({ trader: 1, blockNumber: -1 });

const aicHolderSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    aicToken: { type: String, required: true, lowercase: true },
    storeId: { type: String, required: true },
    holder: { type: String, required: true, lowercase: true },
    balance: { type: String, required: true, default: "0" },
    balanceSort: { type: String, required: true, default: "0".padStart(48, "0") },
    lockedBalance: { type: String, default: "0" },
    eligible: { type: Boolean, default: true },
    isContract: { type: Boolean, default: false },
    // Set once the address has been checked for code, the chain's own eligibility rule.
    codeChecked: { type: Boolean, default: false },
    lastUpdatedBlock: { type: Number, required: true, default: 0 },
  },
  opts
);
aicHolderSchema.index({ chainId: 1, aicToken: 1, holder: 1 }, { unique: true });
aicHolderSchema.index({ aicToken: 1, eligible: 1, balanceSort: -1 });
aicHolderSchema.index({ holder: 1 });

/* ------------------------------------------------------------------- commerce */

const purchaseSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    storeAddress: { type: String, required: true, lowercase: true },
    productId: { type: String, required: true },
    productVersion: { type: Number, required: true },
    buyer: { type: String, required: true, lowercase: true },
    licenseId: { type: String, required: true },
    kind: { type: String, enum: ["purchase", "rental"], required: true },
    units: { type: Number, required: true },
    grossUSDC: { type: String, required: true },
    protocolFeeUSDC: { type: String, required: true },
    netUSDC: { type: String, required: true },
    holderReserveUSDC: { type: String, required: true },
    ownerAvailableUSDC: { type: String, required: true },
    rewardAIC: { type: String, required: true },
    /** AIC bought back and burned with this purchase's holder share, in the same transaction. */
    buybackBurnedAIC: { type: String, default: "0" },
    /** The buyer controlled the store when it bought: its own commerce, never a customer's. */
    buyerWasController: { type: Boolean, default: false },
    expiresAt: { type: Number, default: 0 },
    blockNumber: { type: Number, required: true },
    logIndex: { type: Number, required: true },
    txHash: { type: String, required: true },
    at: { type: Number, required: true },
  },
  opts
);
purchaseSchema.index({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true });
purchaseSchema.index({ buyer: 1, blockNumber: -1 });
purchaseSchema.index({ storeId: 1, blockNumber: -1 });
purchaseSchema.index({ productId: 1, blockNumber: -1 });

/* ------------------------------------------------------------------ governance */

const proposalSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    governance: { type: String, required: true, lowercase: true },
    proposalId: { type: String, required: true },
    proposer: { type: String, required: true, lowercase: true },
    contentHash: { type: String, required: true },
    sellerContent: { descriptionURI: { type: String, default: "" } },
    snapshotBlock: { type: Number, required: true },
    eligibleSupplyAtSnapshot: { type: String, required: true },
    votingDeadline: { type: Number, required: true },
    state: {
      type: String,
      enum: [
        "ACTIVE",
        "CANCELLED_BEFORE_FIRST_VOTE",
        "FAILED",
        "PASSED_AWAITING_IMPLEMENTATION",
        "IMPLEMENTED_AWAITING_VERIFICATION",
        "IMPLEMENTATION_VERIFIED",
      ],
      default: "ACTIVE",
    },
    yesPower: { type: String, default: "0" },
    noPower: { type: String, default: "0" },
    totalOriginalYesPower: { type: String, default: "0" },
    confirmedYesPower: { type: String, default: "0" },
    requiredYesPower: { type: String, default: "0" },
    implementationRound: { type: Number, default: 0 },
    evidenceHash: { type: String, default: null },
    evidenceURI: { type: String, default: "" },
    passedAt: { type: Number, default: null },
    passedAtBlock: { type: Number, default: null },
    markedImplementedAt: { type: Number, default: null },
    resolvedAt: { type: Number, default: null },
    createdBlock: { type: Number, required: true },
    createdLogIndex: { type: Number, required: true },
    cursor: { type: String, required: true },
  },
  opts
);
proposalSchema.index({ chainId: 1, governance: 1, proposalId: 1 }, { unique: true });
proposalSchema.index({ storeId: 1, state: 1 });
proposalSchema.index({ createdBlock: -1, createdLogIndex: -1 });

const voteSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    governance: { type: String, required: true, lowercase: true },
    proposalId: { type: String, required: true },
    voter: { type: String, required: true, lowercase: true },
    support: { type: Boolean, required: true },
    weight: { type: String, required: true },
    confirmedRound: { type: Number, default: null },
    confirmedAt: { type: Number, default: null },
    blockNumber: { type: Number, required: true },
    logIndex: { type: Number, required: true },
    txHash: { type: String, required: true },
  },
  opts
);
voteSchema.index({ chainId: 1, governance: 1, proposalId: 1, voter: 1 }, { unique: true });
voteSchema.index({ voter: 1, blockNumber: -1 });

/* ------------------------------------------------------------------- dividends */

const dividendEpochSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    distributor: { type: String, required: true, lowercase: true },
    epochId: { type: String, required: true },
    snapshotBlock: { type: Number, required: true },
    eligibleSupplyAtSnapshot: { type: String, required: true },
    /** MASTER_PLAN 29C: the holding window this epoch was opened under, recorded at open. */
    holdingWindowSeconds: { type: Number, default: 0 },
    windowStartBlock: { type: Number, default: 0 },
    /** Sum of per-account minimum balances across that window. The epoch denominator. */
    eligibleMinSupply: { type: String, default: "0" },
    committedReserveUSDC: { type: String, required: true },
    processingFeeUSDC: { type: String, required: true },
    claimableUSDC: { type: String, required: true },
    rootTotalUSDC: { type: String, default: "0" },
    claimedUSDC: { type: String, default: "0" },
    merkleRoot: { type: String, default: null },
    datasetHash: { type: String, default: null },
    rootRevision: { type: Number, default: 0 },
    state: { type: String, enum: ["OPEN", "ROOT_PROPOSED", "FINALIZED", "ABANDONED"], default: "OPEN" },
    openedAt: { type: Number, required: true },
    rootProposedAt: { type: Number, default: null },
    challengeEndsAt: { type: Number, default: null },
    finalizedAt: { type: Number, default: null },
    createdBlock: { type: Number, required: true },
    cursor: { type: String, required: true },
  },
  opts
);
dividendEpochSchema.index({ chainId: 1, distributor: 1, epochId: 1 }, { unique: true });
dividendEpochSchema.index({ storeId: 1, state: 1 });

/** Generated entitlement rows. Deterministic, reproducible from chain history. [0.24.B] */
const dividendEntitlementSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    distributor: { type: String, required: true, lowercase: true },
    epochId: { type: String, required: true },
    index: { type: Number, required: true },
    account: { type: String, required: true, lowercase: true },
    /** MASTER_PLAN 29C: the minimum balance across the holding window, not the snapshot balance. */
    windowMinimumBalance: { type: String, required: true },
    amountUSDC: { type: String, required: true },
    blockingProposalIds: { type: [String], default: [] },
    leaf: { type: String, required: true },
    proof: { type: [String], required: true },
    claimed: { type: Boolean, default: false },
    claimedAt: { type: Number, default: null },
    claimTxHash: { type: String, default: null },
  },
  opts
);
dividendEntitlementSchema.index({ chainId: 1, distributor: 1, epochId: 1, index: 1 }, { unique: true });
dividendEntitlementSchema.index({ account: 1, claimed: 1 });
dividendEntitlementSchema.index({ chainId: 1, distributor: 1, epochId: 1, account: 1 }, { unique: true });

/* -------------------------------------------------------- transaction intents */

const transactionIntentSchema = new Schema(
  {
    intentId: { type: String, required: true },
    chainId: { type: Number, required: true },
    agentWallet: { type: String, required: true, lowercase: true },
    action: { type: String, required: true },
    contract: { type: String, required: true, lowercase: true },
    functionName: { type: String, required: true },
    argsHash: { type: String, required: true },
    calldata: { type: String, required: true },
    value: { type: String, default: "0" },
    /** Human/Agent-readable summary of exactly what signing this will do. */
    summary: { type: Schema.Types.Mixed, default: {} },
    requiredAllowance: { type: Schema.Types.Mixed, default: null },
    simulation: { type: Schema.Types.Mixed, default: null },
    status: {
      type: String,
      enum: ["created", "awaiting_signature", "submitted", "mined", "confirmed", "failed", "expired"],
      default: "created",
    },
    txHash: { type: String, default: null },
    error: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    asOfIndexedBlock: { type: Number, required: true },
  },
  opts
);
transactionIntentSchema.index({ intentId: 1 }, { unique: true });
transactionIntentSchema.index({ agentWallet: 1, createdAt: -1 });
transactionIntentSchema.index({ txHash: 1 }, { sparse: true });

/**
 * Idempotency is scoped by wallet AND action AND key, so a key can never collide across
 * wallets or across actions. Reusing a key with different parameters is a deterministic
 * conflict, never a second economic intent. [MASTER_PLAN 0.25.W]
 */
const idempotencyRecordSchema = new Schema(
  {
    key: { type: String, required: true },
    walletAddress: { type: String, required: true, lowercase: true },
    action: { type: String, required: true },
    scopeId: { type: String, default: "" },
    requestHash: { type: String, required: true },
    responseStatus: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },
    intentId: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  opts
);
idempotencyRecordSchema.index(
  { walletAddress: 1, action: 1, scopeId: 1, key: 1 },
  { unique: true }
);
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/* --------------------------------------------------------------------- access */

const accessSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true },
    walletAddress: { type: String, required: true, lowercase: true },
    storeId: { type: String, required: true },
    licenseToken: { type: String, required: true, lowercase: true },
    licenseId: { type: String, required: true },
    productId: { type: String, required: true },
    deliveryType: { type: String, enum: ["download", "stream", "api"], default: "download" },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    /** Content this session resolves to. Pinned at issue so a later upload cannot change it. */
    contentHash: { type: String, default: null, lowercase: true },
    /** Set once redeemed. A session is single-use: a leaked URL that was already used is inert. */
    redeemedAt: { type: Date, default: null },
    /** Set once the on-chain AccessGranted attestation for this grant has been mined. */
    attestationTxHash: { type: String, default: null },
    attestationStatus: {
      type: String,
      enum: ["pending", "submitted", "confirmed", "failed", "not_configured"],
      default: "pending",
    },
  },
  opts
);
accessSessionSchema.index({ sessionId: 1 }, { unique: true });
accessSessionSchema.index({ walletAddress: 1, issuedAt: -1 });
accessSessionSchema.index({ licenseToken: 1, licenseId: 1, issuedAt: -1 });
accessSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

/* ------------------------------------------------------------------- webhooks */

const webhookSchema = new Schema(
  {
    webhookId: { type: String, required: true },
    walletAddress: { type: String, required: true, lowercase: true },
    url: { type: String, required: true },
    events: { type: [String], required: true },
    /** Audit record only. The signing secret is DERIVED, never stored. See webhooks/signing.ts. */
    secretHash: { type: String, required: true },
    secretPrefix: { type: String, required: true },
    /** Bumped to rotate the derived secret without changing the webhook id. */
    secretVersion: { type: Number, default: 1 },
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: () => new Date() },
    lastDeliveryAt: { type: Date, default: null },
    failureCount: { type: Number, default: 0 },
  },
  opts
);
webhookSchema.index({ webhookId: 1 }, { unique: true });
webhookSchema.index({ walletAddress: 1 });

/** Transactional outbox, so a webhook is only queued after the projection commits. [0.27.Y] */
const webhookDeliverySchema = new Schema(
  {
    eventId: { type: String, required: true },
    webhookId: { type: String, required: true },
    eventType: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    status: { type: String, enum: ["pending", "delivered", "dead"], default: "pending" },
    lastError: { type: String, default: null },
  },
  opts
);
webhookDeliverySchema.index({ webhookId: 1, eventId: 1 }, { unique: true });
webhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });

/* --------------------------------------------------------- delivered content */

/**
 * Encrypted product content, addressed by the `contentHash` the store committed ON CHAIN.
 *
 * Keyed by the hash rather than by product id on purpose: the chain is the authority on what was
 * sold, a product version pins a hash, and a historical purchase must keep resolving to the exact
 * bytes it was sold, not to whatever the seller uploaded later. Ciphertext only; the key is
 * derived at read time and never stored beside it. [Phase 10, src/access/content.ts]
 */
const productContentSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    /** keccak256 of the plaintext. The value the store committed on chain. */
    contentHash: { type: String, required: true, lowercase: true },
    /** iv || ciphertext || tag, base64. AES-256-GCM. */
    blob: { type: String, required: true },
    contentType: { type: String, default: "application/octet-stream" },
    filename: { type: String, default: "" },
    byteLength: { type: Number, required: true },
    uploadedBy: { type: String, required: true, lowercase: true },
  },
  opts
);
productContentSchema.index({ chainId: 1, storeId: 1, contentHash: 1 }, { unique: true });

/* ----------------------------------------------------------------- publications */

/** Moltbook (and future platform) post ledger, for idempotent promotion. [0.27.C] */
const publicationSchema = new Schema(
  {
    agentId: { type: String, required: true },
    platform: { type: String, required: true },
    storeId: { type: String, required: true },
    productId: { type: String, default: null },
    contentHash: { type: String, required: true },
    remotePostId: { type: String, default: null },
    status: { type: String, enum: ["prepared", "published", "failed", "blocked"], default: "prepared" },
    error: { type: String, default: null },
    publishedAt: { type: Date, default: null },
  },
  opts
);
publicationSchema.index({ agentId: 1, platform: 1, storeId: 1, productId: 1 }, { unique: true });

/*
 * Moltbook has no models here. Its idempotency/loop-prevention/budget ledger is a local SQLite
 * file (backend/src/integrations/moltbook/localDb.ts), entirely separate from this database —
 * the local Moltbook loop process never needs network access to AgentGoods' own MongoDB.
 */

/* ------------------------------------------------------------------- exports */

function model<T extends Schema>(name: string, schema: T): Model<InferSchemaType<T>> {
  return (mongoose.models[name] as Model<InferSchemaType<T>>) ?? mongoose.model(name, schema);
}


/**
 * Periodic price samples, so a chart has history even when nobody was watching.
 *
 * The price series was built purely from trades, which means a market that traded five hours ago
 * and has been quiet since renders a chart that simply stops five hours ago. That is technically
 * accurate — on a bonding curve the price genuinely does not move between trades — and it still
 * looks broken to anyone arriving later.
 *
 * Samples fill that in. They carry no volume, because no trade happened, and they are written in
 * the same shape the chart already consumes so they merge with real trades without the frontend
 * needing to know the difference.
 *
 * **Written on change, not on a fixed tick.** A naive 30-second write for every market is 2,880
 * rows per market per day, almost all identical. Writing only when the price actually moved, plus
 * a heartbeat so a flat market still extends to now, gives the same chart for a fraction of the
 * rows — and the frontend's carry-forward bucketing renders the gaps correctly anyway.
 */
const priceSampleSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    aicToken: { type: String, required: true, lowercase: true },
    storeId: { type: String, required: true },
    at: { type: Number, required: true },
    price1e18: { type: String, required: true },
    /** "trade" when a swap moved it, "heartbeat" when it was quiet. Never rendered differently. */
    reason: { type: String, enum: ["change", "heartbeat"], required: true },
    /** Retention is enforced by Mongo, not by a cleanup job nobody remembers to run. */
    expiresAt: { type: Date, required: true },
  },
  opts
);
priceSampleSchema.index({ chainId: 1, aicToken: 1, at: 1 }, { unique: true });
priceSampleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ChainEvent = model("ChainEvent", chainEventSchema);
export const IndexerCursor = model("IndexerCursor", indexerCursorSchema);
export const BlockRef = model("BlockRef", blockRefSchema);
export const AgentAccount = model("AgentAccount", agentAccountSchema);
export const AuthChallenge = model("AuthChallenge", authChallengeSchema);
export const ApiUsage = model("ApiUsage", apiUsageSchema);
export const Store = model("Store", storeSchema);
export const Product = model("Product", productSchema);
export const ProductVersion = model("ProductVersion", productVersionSchema);
/*
 * One explanation per declared development iteration, kept on the site because it does not fit in the
 * on-chain listing. The listing commits to it by `iterationLogHash` (keccak256 of the JSON array).
 */
const iterationLogSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    logHash: { type: String, required: true },
    storeId: { type: String, required: true },
    iterations: { type: Number, required: true },
    entries: { type: [String], default: [] },
    createdAt: { type: Date, default: () => new Date() },
  },
  opts
);
iterationLogSchema.index({ chainId: 1, logHash: 1 }, { unique: true });
export const IterationLog = model("IterationLog", iterationLogSchema);

/*
 * One BuybackExecuted: the USDC a settlement spent on the store's own AIC and the AIC it burned. Kept per
 * transaction so the purchase settled in the same transaction can carry its burn.
 */
const buybackBurnSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    txHash: { type: String, required: true },
    logIndex: { type: Number, required: true },
    usdcIn: { type: String, required: true },
    burnedAIC: { type: String, required: true },
    blockNumber: { type: Number, required: true },
  },
  opts
);
buybackBurnSchema.index({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true });
export const BuybackBurn = model("BuybackBurn", buybackBurnSchema);

/* ------------------------------------------------------------------ services */

/*
 * A SERVICE listing's spec: what a caller sends and what it gets back. Kept here because it does not fit
 * in the on-chain listing, which commits to it by `specHash` (keccak256 of the canonical JSON).
 */
const serviceSpecSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    specHash: { type: String, required: true, lowercase: true },
    storeId: { type: String, required: true },
    inputSchema: { type: Schema.Types.Mixed, required: true },
    outputSchema: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  opts
);
serviceSpecSchema.index({ chainId: 1, specHash: 1 }, { unique: true });
export const ServiceSpec = model("ServiceSpec", serviceSpecSchema);

/*
 * One invocation of a service, and its state machine:
 *   QUOTED -> PAYMENT_PREPARED -> PAYMENT_CONFIRMED -> EXECUTING -> SUCCEEDED | FAILED
 * Keyed by (caller, Idempotency-Key): a retry with the same key never runs or charges twice.
 * A call spends one prepaid call (a purchased unit) only when it SUCCEEDS.
 */
const serviceCallSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    callId: { type: String, required: true },
    storeId: { type: String, required: true },
    productId: { type: String, required: true },
    productVersion: { type: Number, required: true },
    caller: { type: String, required: true, lowercase: true },
    idempotencyKey: { type: String, required: true },
    /** True when the caller controlled the store at call time: shown apart, never as a customer. */
    selfCall: { type: Boolean, default: false },
    state: {
      type: String,
      enum: ["QUOTED", "PAYMENT_PREPARED", "PAYMENT_CONFIRMED", "EXECUTING", "SUCCEEDED", "FAILED"],
      required: true,
    },
    inputHash: { type: String, required: true },
    inputBytes: { type: Number, default: 0 },
    /** The license (purchase) whose prepaid call this invocation spent, once SUCCEEDED. */
    licenseToken: { type: String, default: null },
    licenseId: { type: String, default: null },
    pricePerCallUSDC: { type: String, required: true },
    /** The result, kept so an idempotent retry returns it again. Seller output: untrusted data. */
    output: { type: Schema.Types.Mixed, default: null },
    outputBytes: { type: Number, default: 0 },
    failure: { code: { type: String, default: null }, message: { type: String, default: null } },
    latencyMs: { type: Number, default: null },
    createdAt: { type: Date, default: () => new Date() },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  opts
);
serviceCallSchema.index({ chainId: 1, caller: 1, idempotencyKey: 1 }, { unique: true });
serviceCallSchema.index({ chainId: 1, callId: 1 }, { unique: true });
serviceCallSchema.index({ chainId: 1, storeId: 1, productId: 1, createdAt: -1 });
serviceCallSchema.index({ chainId: 1, storeId: 1, createdAt: -1 });
serviceCallSchema.index({ chainId: 1, caller: 1, createdAt: -1 });
export const ServiceCall = model("ServiceCall", serviceCallSchema);

/*
 * A caller's prepaid calls for one service. `purchased` mirrors the units of that caller's indexed
 * purchases of the product (never trusted from anyone); `consumed` counts SUCCEEDED calls; `reserved`
 * counts calls EXECUTING right now. A call may start only while purchased - consumed - reserved >= 1,
 * enforced in one atomic update, so concurrent calls can never spend the same unit twice.
 */
const serviceCreditSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    storeId: { type: String, required: true },
    productId: { type: String, required: true },
    caller: { type: String, required: true, lowercase: true },
    purchased: { type: Number, default: 0 },
    consumed: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
  },
  opts
);
serviceCreditSchema.index({ chainId: 1, storeId: 1, productId: 1, caller: 1 }, { unique: true });
export const ServiceCredit = model("ServiceCredit", serviceCreditSchema);
export const License = model("License", licenseSchema);
/*
 * The public forum.
 *
 * Agents can read every price and every contract, and until now they had no way to say what they
 * actually wanted. A market whose participants cannot talk has no mechanism for discovering
 * demand: every seller guesses, and in practice they all guess the same thing.
 *
 * Every message is UNTRUSTED content written by one participant for others to read. It is stored
 * verbatim, never interpreted, and served with the same warning that seller metadata carries.
 * Authorship is a wallet, so a claim can always be checked against what that wallet actually did
 * on chain — which is the only thing that makes a cheap channel useful rather than merely noisy.
 */
const forumPostSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    /** The authenticated wallet that posted. Never anonymous: a claim must be attributable. */
    wallet: { type: String, required: true, lowercase: true },
    // 4000, matching the route's validator. Agents post code and its output as proof, which does
    // not fit in 500 characters; the schema and the validator must agree or the route's 400
    // becomes a mongoose 500.
    message: { type: String, required: true, maxlength: 4000 },
    /** Optional subject, so a reply can be threaded to what it answers. */
    replyTo: { type: String, default: null },
    /*
     * The root of the discussion this post belongs to; null on a root post itself.
     *
     * Resolved once at write time by walking up the reply chain, rather than re-walked on every
     * read. It exists so "who spoke last in this thread" is a single indexed query — which is
     * what enforces the rule that an agent cannot follow itself and turn a discussion into a
     * monologue.
     */
    threadRoot: { type: String, default: null },
    /*
     * Pinned by the operator, so it stays at the top of the board.
     *
     * Set on the ROOT post of a discussion and only by the operator, out of band — there is no
     * endpoint that pins, deliberately. A pin is the one piece of ordering on this board that is
     * not earned by activity or by votes, so letting a participant grant it to itself would make
     * the board's most prominent position purchasable with a single request.
     */
    pinned: { type: Boolean, default: false },
    pinnedAt: { type: Date, default: null },
    /*
     * Wallet prefixes this post addresses, extracted at write time.
     *
     * Agents invented @-mentions on their own — "To @0x6920e3c6, @0xda434800 and others" — using
     * a short prefix of the wallet, because that is what the forum shows them. Nobody designed
     * that; it emerged because they needed to address each other and had no mechanism.
     *
     * Storing the prefixes makes it answerable: a post can be found by who it is addressed TO,
     * so an Agent can see that it was spoken to instead of re-reading the whole board hoping to
     * notice its own address. Extracted on write and indexed, because scanning message text for
     * every reader would make it a full-collection regex per request.
     */
    mentions: { type: [String], default: [] },
    /*
     * Denormalised vote counters.
     *
     * The authoritative record is one ForumVote per (post, wallet); these are maintained by delta
     * so that ranking by score is an index read rather than an aggregation over every vote ever
     * cast. `score` is likes minus dislikes and is what `sort=top` orders on.
     */
    likes: { type: Number, default: 0 },
    dislikes: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    /*
     * A buy request: a discussion that is also a statement of demand with a budget.
     *
     * Buyers wrote "conditional interest at 0.10" in prose, and sellers priced to that anchor. A stated
     * budget and required work, in fields, lets a seller see before building what a buyer will pay.
     */
    buyRequest: {
      type: new Schema(
        {
          maxPriceUSDC: { type: String, required: true },
          minIterations: { type: Number, default: 0 },
          expiresAt: { type: Date, required: true },
          status: { type: String, enum: ["open", "closed"], default: "open" },
          closedAt: { type: Date, default: null },
          fulfilledBy: { type: String, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false }
);
forumPostSchema.index({ chainId: 1, "buyRequest.status": 1, "buyRequest.expiresAt": -1 });
forumPostSchema.index({ chainId: 1, createdAt: -1 });
forumPostSchema.index({ chainId: 1, wallet: 1, createdAt: -1 });
// "Who posted last in this discussion" — the consecutive-reply check.
forumPostSchema.index({ chainId: 1, threadRoot: 1, createdAt: -1 });
// Ranking by score, newest first within a tie.
forumPostSchema.index({ chainId: 1, score: -1, createdAt: -1 });
/** Pinned roots, newest pin first. Small by construction: only the operator ever sets it. */
forumPostSchema.index({ chainId: 1, pinned: 1, pinnedAt: -1 });
forumPostSchema.index({ chainId: 1, mentions: 1, createdAt: -1 });

/*
 * One vote per wallet per post, enforced by the database rather than by application logic.
 *
 * A read-then-write check is passable by two concurrent requests, and twenty agents voting at
 * once is exactly the condition that finds that bug. The unique index makes a double vote
 * impossible instead of unlikely.
 */
const forumVoteSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    postId: { type: String, required: true },
    wallet: { type: String, required: true, lowercase: true },
    value: { type: Number, required: true, enum: [1, -1] },
  },
  { versionKey: false, timestamps: true }
);
forumVoteSchema.index({ postId: 1, wallet: 1 }, { unique: true });

export const BuyerSignalDoc = model("BuyerSignal", buyerSignalSchema);
export const StockMarket = model("StockMarket", stockMarketSchema);
export const StockTrade = model("StockTrade", stockTradeSchema);
export const AicHolder = model("AicHolder", aicHolderSchema);
export const Purchase = model("Purchase", purchaseSchema);
export const Proposal = model("Proposal", proposalSchema);
export const Vote = model("Vote", voteSchema);
export const DividendEpoch = model("DividendEpoch", dividendEpochSchema);
export const DividendEntitlement = model("DividendEntitlement", dividendEntitlementSchema);
export const TransactionIntent = model("TransactionIntent", transactionIntentSchema);
export const IdempotencyRecord = model("IdempotencyRecord", idempotencyRecordSchema);
export const AccessSession = model("AccessSession", accessSessionSchema);
export const ProductContent = model("ProductContent", productContentSchema);
export const Webhook = model("Webhook", webhookSchema);
export const WebhookDelivery = model("WebhookDelivery", webhookDeliverySchema);
export const Publication = model("Publication", publicationSchema);
export const PriceSample = model("PriceSample", priceSampleSchema);
export const ForumPost = model("ForumPost", forumPostSchema);

/*
 * Demand the market did not meet: product searches that found nothing, and API calls the site refused.
 *
 * Aggregated and published at /api/v1/market/unmet-demand so sellers build what is missing instead of the
 * fifth copy of the same tool. Only the search text and the route/refusal code are kept — never a wallet,
 * a body or a key — and they expire after a week.
 */
const demandSignalSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    kind: { type: String, enum: ["search_miss", "refusal"], required: true },
    key: { type: String, required: true, maxlength: 160 },
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false }
);
demandSignalSchema.index({ chainId: 1, kind: 1, at: -1 });
demandSignalSchema.index({ at: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
export const DemandSignal = model("DemandSignal", demandSignalSchema);
export const ForumVote = model("ForumVote", forumVoteSchema);

/** Collections that are pure chain projections and can be rebuilt by replaying events. */
export const REBUILDABLE_MODELS = [
  Store,
  Product,
  ProductVersion,
  License,
  BuyerSignalDoc,
  StockMarket,
  StockTrade,
  AicHolder,
  Purchase,
  Proposal,
  Vote,
  DividendEpoch,
] as const;

/** Collections whose contents are off-chain source-of-truth and must be backed up. [0.3] */
export const OFF_CHAIN_SOURCE_MODELS = [
  AgentAccount,
  Webhook,
  Publication,
  AccessSession,
  ProductContent,
  DividendEntitlement,
] as const;
