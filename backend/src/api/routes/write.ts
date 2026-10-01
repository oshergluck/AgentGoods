/**
 * Agent write API.
 *
 * Every endpoint here returns a TransactionIntent. The backend builds calldata; the Agent EOA
 * signs and submits. No endpoint moves funds, and no endpoint accepts a contract address from
 * the request body: every address is resolved from the canonical Registry projection or the
 * deployment manifest (MASTER_PLAN 0.25.N).
 *
 * Quotes bind chainId, canonical contract, store, product, action, amount, formula version,
 * fees, expected output, min/max constraints, reference block and expiry, exactly as
 * MASTER_PLAN 0.24.G requires, and execution re-checks all of it on chain.
 */

import { capitalAllocationContext, seedAnalysis } from "./ownerMarket";
import { fundamentals, gatherFacts, loadMarkets, priceDecimal } from "../../stores/stockMetrics";
import { freshCurveState, marketStateOf, roundTripOnCurve } from "../../stores/quotes";
import { dexPoolOf, dexSellOut, isGraduated } from "../../stores/quotes";
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { MAX_PROFILE_BYTES, parseProfile } from "../../content/profile";
import { canonicalModel, MODEL_LIST_PRICES } from "../../config/modelPrices";
import { checkIterationLog, IterationLogInput, ITERATION_LOG_RULE, MAX_ITERATIONS_PER_UPLOAD, saveIterationLog, iterationsFeedback } from "../../content/iterationLog";
import { encodeBytes32String, ethers, keccak256, toUtf8Bytes, Interface, isAddress, getAddress } from "ethers";
import { Product, StockMarket, Store, ProductContent, ProductVersion, AicHolder } from "../../db/models";
import { chainNow } from "../../db/chainTime";
import { ApiError } from "../../http/errors";
import { handler, idempotent, noStore, requireAgent, selfWallet } from "../../http/middleware";
import { freshness } from "../../http/context";
import { buildIntent } from "../../transactions/intents";
import { amountAIC, amountUSDC, format } from "../../config/units";
import {
  previewReward,
  quoteBuy,
  quoteSell,
  settle,
  maxTokensSellableNow,
  MAX_UNITS_PER_PURCHASE,
  type CurveState,
} from "../../stores/quotes";
import { declarationView, SELLER_CONTENT_NOTE } from "../serializers";
import { checkServiceSpec, runOnRunner, runnerConfigured, saveServiceSpec, SERVICE_LIMITS } from "../../services/gateway";
import type { Env } from "../../config/env";
import { storeProductContent, MAX_CONTENT_BYTES } from "../../access/storeContent";

const QUOTE_TTL_SECONDS = 300;

/*
 * MANDATORY on every listing. A product without the tokens that building it took gives a buyer nothing to weigh
 * its price against, and while the field was optional most listings left it out.
 */
const DECLARATION_REQUIRED =
  "Every listing must declare the model tokens building it took: declaration {inputTokens, reasoningTokens, " +
  "outputTokens, modelTier, basis}. Count every turn of every iteration — the context you read (input), your " +
  "reasoning, and what you wrote (output) — on the model you ran (GET /api/v1/models). basis is MEASURED when you " +
  "counted, ESTIMATED when you did not.";

const DeclarationInput = z
  .object({
    /*
     * The tokens building the product took, split the way providers bill them: input (context read),
     * reasoning (hidden thinking, billed as output) and output (text written). One total cannot be priced:
     * the same tokens cost ten times more as output than as input. The chain stores the total;
     * the split is committed in the listing (metadataURI.tokenBreakdown) and prices every comparison.
     */
    inputTokens: z.string().regex(/^\d+$/),
    reasoningTokens: z.string().regex(/^\d+$/),
    outputTokens: z.string().regex(/^\d+$/),
    /** Optional: when sent it must equal input + reasoning + output. */
    tokensSaved: z.string().regex(/^\d+$/).optional(),
    modelTier: z.string().min(1).max(31),
    basis: z.enum(["ESTIMATED", "MEASURED"]),
  }, { required_error: DECLARATION_REQUIRED, invalid_type_error: DECLARATION_REQUIRED })
  .refine((d) => !d.tokensSaved || BigInt(d.tokensSaved) === BigInt(d.inputTokens) + BigInt(d.reasoningTokens) + BigInt(d.outputTokens), {
    message: "tokensSaved, when sent, must equal inputTokens + reasoningTokens + outputTokens. You can leave it out.",
    path: ["tokensSaved"],
  })
  /*
   * A model buyers can price: one from the published table (GET /api/v1/models). Spelling is forgiven —
   * "gpt6luna" is gpt-6-luna — and the canonical name is what goes on chain, so every buyer compares the
   * same thing.
   */
  .refine((d) => canonicalModel(d.modelTier) !== null, {
    message: `modelTier must be a model in GET /api/v1/models (spelling is forgiven: "gpt6luna" is gpt-6-luna). Listed: ${Object.keys(MODEL_LIST_PRICES).join(", ")}.`,
    path: ["modelTier"],
  })
  .transform((d) => ({
    ...d,
    modelTier: canonicalModel(d.modelTier) ?? d.modelTier,
    tokensSaved: (BigInt(d.inputTokens) + BigInt(d.reasoningTokens) + BigInt(d.outputTokens)).toString(),
  }))
  /*
   * The contract's own rule, enforced here so it is a refusal and not a reverted transaction.
   *
   * StoreBase._normalizeDeclaration rejects a declaration whose basis is stated while tokensSaved
   * is zero — a half declaration, which would let a buyer be shown a measurement of nothing. This
   * layer used to accept it, prepare the calldata, and hand back a transaction that could only
   * ever revert with InvalidDeclaration(): four bytes, no message, and nothing in it to tell a
   * caller which field was wrong. Caught here, the answer arrives before any gas is spent.
   *
   * A listing cannot claim nothing: the declaration is required, and it must count real work.
   */
  .refine((d) => BigInt(d.tokensSaved) > 0n, {
    message:
      "inputTokens + reasoningTokens + outputTokens must be greater than zero: building anything takes model " +
      "tokens, and a declaration of zero is rejected on chain (InvalidDeclaration).",
    path: ["inputTokens"],
  });

const CreateStoreBody = z.object({
  // "Sales", "SALES" and "sales" are the same store type.
  storeType: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(["sales", "rentals"])),
  aicName: z.string().min(1).max(64),
  aicSymbol: z.string().min(1).max(16),
  storeName: z.string().min(1).max(128),
  /** Owner-funded initial market capital, decimal USDC, at least the protocol minimum. Not a fee. */
  // A decimal string or a plain JSON number: both mean whole USDC, up to 6 decimals.
  initialOwnerSeedUSDC: z
    .union([z.string(), z.number().finite().nonnegative()])
    .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
    .pipe(z.string().regex(/^\d+(\.\d{1,6})?$/, "a decimal USDC amount: digits, optionally a point and at most 6 decimals"))
    .optional(),
});

/**
 * A content commitment that actually commits to something.
 *
 * Used on the update path, where the value may come from an existing product created before this
 * rule existed. Refusing loudly is the right failure: the alternative is re-committing a zero and
 * telling the buyer to verify against nothing.
 */
function requireContentHash(value: string | null | undefined): string {
  if (!value || /^0x0{64}$/i.test(value)) {
    throw ApiError.invalid(
      "This product has no content commitment. Supply a non-zero `contentHash` (keccak256 of the " +
        "exact bytes a buyer receives) to update it.",
      { contentHash: value ?? null }
    );
  }
  return value;
}

/*
 * The fields, before the one rule that ties two of them together.
 *
 * Kept as a plain object so the update body can still derive from it: a refined schema cannot be
 * `.omit()`ed, and the update path has its own rules about which of these are required.
 */
const CreateProductFields = z.object({
  productId: z.string().min(1).max(128),
  // At least 523 base units (0.000523 USDC): the smallest price whose holders' 20% still buys back 100 base units.
  priceUSDC: z
    .string()
    .regex(/^\d+$/)
    .refine((v) => BigInt(v) >= 523n, "priceUSDC must be at least \"523\" base units (0.000523 USDC): below it the holders' buyback would be dust"),
  inventory: z.string().regex(/^\d+$/).optional(),
  unlimitedInventory: z.boolean().optional(),
  rentalPeriodSeconds: z.coerce.number().int().min(0).max(365 * 24 * 3600).optional(),
  /*
   * Required, and required to be non-zero.
   *
   * `contentHash` is the seller's on-chain commitment to exactly what the buyer will receive:
   * the access gateway tells a buyer to check `keccak256(delivered bytes) == contentHash` and
   * not to take delivery on trust. An all-zero hash commits to nothing, so the buyer has no way
   * to tell correct delivery from wrong or empty delivery, and the LicenseToken stops being a
   * claim on anything in particular.
   *
   * This used to be `.optional()` and the call site substituted `bytes32(0)` when it was absent,
   * which meant our own API made an unverifiable product the DEFAULT rather than a deliberate
   * choice. The store contract does not reject a zero hash — per-store contracts are immutable
   * clones, so existing stores cannot be changed — which makes this the layer that can enforce it
   * for everything published from here on.
   */
  contentHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "contentHash must be a 0x-prefixed 32-byte hex string")
    .refine((value) => !/^0x0{64}$/i.test(value), {
      message:
        "contentHash must not be zero. It is the commitment a buyer verifies the delivered bytes " +
        "against; an all-zero hash commits to nothing. Publish keccak256 of the exact content.",
    })
    .optional(),
  /*
   * OR the bytes themselves, and the API does the upload.
   *
   * Listing used to be two requests: upload, carry a 66-character hash to the second call, list.
   * Across an hour of sixteen agents trying to sell, that second step was never reached — not one
   * upload happened — and a hash carried between two calls by a language model is precisely the
   * kind of value that arrives one character short. With `content` here the whole listing is one
   * request: the bytes go in, the commitment is computed on this side, and the prepared
   * transaction comes back. The two-step path still exists for a seller who wants to pin the same
   * bytes to several versions.
   */
  content: z.string().max(Math.ceil((MAX_CONTENT_BYTES * 4) / 3) + 1024).optional(),
  contentType: z.string().max(128).optional(),
  filename: z.string().max(200).optional(),
  // Matches ProtocolConstants.MAX_METADATA_URI_LENGTH: an inline profile document fits here.
  metadataURI: z.string().max(4096).optional(),
  declaration: DeclarationInput,
  /*
   * Optional: list the product as a SERVICE — a callable sold per call — instead of an artifact to keep.
   * `content` is then the service's code (a function taking the input and returning the output), which is
   * run by the service runner and never delivered to a buyer; priceUSDC is the price of ONE call; a buyer
   * prepays calls as units. Only in a Sales store.
   */
  service: z
    .object({
      pricingModel: z.literal("PER_CALL").optional(),
      inputSchema: z.record(z.unknown()),
      outputSchema: z.record(z.unknown()),
    })
    .optional(),
  /*
   * MANDATORY: how many development iterations — build, test, fix cycles — this upload went through.
   *
   * A buyer cannot run a product before paying for it, and a price alone says nothing about what stands
   * behind it. Iterations do: a product that went through one iteration is a first draft; one that went
   * through twenty was built, tested and corrected again and again. The number is committed on chain in the
   * listing with a running total across versions, so a buyer sees the investment behind what it buys.
   * Declared by the seller, like every seller claim; buyers' verdicts are how an inflated count is exposed.
   */
  iterations: z.coerce.number().int().min(1).max(MAX_ITERATIONS_PER_UPLOAD),
  /*
   * MANDATORY with `iterations`: one explanation per iteration, in order — what was tried, tested, found
   * wrong and changed — in words, without revealing the code. A count is cheap to type; ten distinct
   * explanations are the evidence that ten iterations happened. Stored on the site, committed on chain by hash.
   */
  iterationLog: IterationLogInput,
});

/** Creating needs a commitment: either the hash of bytes already uploaded, or the bytes. */
const CreateProductBody = CreateProductFields.refine(
  (b) => Boolean(b.contentHash) !== Boolean(b.content),
  {
    message:
      "Send exactly one of `content` (base64 of the deliverable — the API uploads it and commits " +
      "to it) or `contentHash` (the hash returned by an earlier POST /api/v1/access/content).",
    path: ["content"],
  }
);

/*
 * An update supplies only what it is changing.
 *
 * This derived from CreateProductBody, which made `contentHash` REQUIRED when that rule was added
 * for creation (F-016) — so every update had to re-send a hash it was not changing, and a seller
 * repricing a product got "Invalid update" with no indication which field was missing. Twenty
 * such failures in one multi-agent test run, all of them the API refusing a legitimate edit.
 *
 * Creation still requires a commitment. Updating keeps the existing one unless a new one is
 * given, and the route already refuses to carry a ZERO hash forward, so nothing is weakened.
 */
const UpdateProductBody = CreateProductFields.omit({ productId: true })
  .extend({
    active: z.boolean().optional(),
    /*
     * What you fixed, in your own words.
     *
     * A new version tells a buyer the bytes differ. It does not tell them whether the thing that
     * broke for them was addressed, which is the only question they have — and the buyer who
     * reported the fault is the single most likely next purchaser. Describing the change is how a
     * seller converts a complaint into a sale.
     *
     * Unverified, like every seller claim: the protocol stores it and never checks it.
     */
    changelog: z.string().max(600).optional(),
  })
  // Leaving `declaration` out of an update keeps the product's current declaration.
  .partial({ contentHash: true, priceUSDC: true, iterations: true, iterationLog: true, declaration: true })
  .refine((b) => (b.iterations === undefined) === (b.iterationLog === undefined), {
    message: "`iterations` and `iterationLog` go together: " + ITERATION_LOG_RULE,
    path: ["iterationLog"],
  })
  .refine((b) => !(b.content !== undefined || b.contentHash !== undefined) || b.iterations !== undefined, {
    message:
      "A new upload must say how many development iterations it went through: send `iterations` (an integer, " +
      "at least 1) with every content change. A price- or status-only update does not need it.",
    path: ["iterations"],
  });

const PurchaseBody = z.object({
  /*
   * Coerced, because half the callers send numbers as strings.
   *
   * Six quotes in a row were refused for `"units": "1"` after `units` had been given a default —
   * the default covered absence, not the string. Every other numeric field here is a string of
   * digits by design (base units), so a caller writing "1" is following the API's own habit.
   */
  units: z.coerce.number().int().min(1).max(MAX_UNITS_PER_PURCHASE),
  expectedVersion: z.coerce.number().int().min(1),
  maxTotalUSDC: usdcBaseUnits("maxTotalUSDC"),
  licenseURI: z.string().max(2048).optional(),
});

/**
 * USDC base units, the way callers actually send them.
 *
 * Thirty-two purchases in twenty minutes were refused with "maxTotalUSDC is wrong or missing" —
 * the gross sent as dollars ("1.01") or as a JSON number. A whole number is the same base units
 * whichever way it is written, so it is accepted; a decimal is refused with the conversion done.
 */
function usdcBaseUnits(field: string) {
  return z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "number" && Number.isSafeInteger(v) ? String(v) : String(v).trim()))
    .superRefine((v, c) => {
      if (/^\d+$/.test(v)) return;
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: /^\d*\.\d+$/.test(v)
          ? `${field} is in USDC base units (6 decimals), not dollars: ${v} USDC is "${BigInt(Math.round(Number(v) * 1e6)).toString()}".`
          : `${field} is USDC base units as a string of digits: 1 USDC is "1000000".`,
      });
    });
}

const TradeBody = z.object({
  amount: z.string().regex(/^\d+$/),
  minOut: z.string().regex(/^\d+$/).optional(),
  deadlineSeconds: z.coerce.number().int().min(30).max(3600).optional(),
});

const UNLIMITED = (2n ** 64n - 1n).toString();

/** AgentGoods.MIN_TRADE_USDC: a compile-time constant of the exchange, identical on every deployment. */
const MIN_TRADE_USDC_BASE = 100n; // 0.0001 USDC: the smallest trade on which both trading fees round to at least one unit

/** The one ERC-20 call the wallet route prepares. */
const ERC20_TRANSFER = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]);

const TransferBody = z
  .object({
    to: z.string().optional(),
    recipient: z.string().optional(),
    amountUSDC: z.union([z.string(), z.number()]).optional(),
    amount: z.union([z.string(), z.number()]).optional(),
  })
  /* `amount` and `recipient` are what half the callers wrote; both spellings are honoured. */
  /* A whole number sent as a JSON number is the same base units; a decimal is refused below with the conversion. */
  .transform((b) => {
    const a = b.amountUSDC ?? b.amount;
    return { to: b.to ?? b.recipient, amountUSDC: typeof a === "number" && Number.isSafeInteger(a) ? String(a) : a === undefined ? undefined : String(a) };
  })
  .pipe(
    z.object({
      to: z.string({ required_error: "Required" }).refine((v) => isAddress(v), "to must be a 20-byte address"),
      amountUSDC: z
        .string({ required_error: "Required" })
        .superRefine((v, c) => {
          if (/^\d+$/.test(v)) return;
          const dec = /^\d*\.\d+$/.test(v) ? v : null;
          c.addIssue({
            code: z.ZodIssueCode.custom,
            message: dec
              ? `amountUSDC is in base units (USDC has 6 decimals), not dollars: ${v} USDC is "${(BigInt(Math.round(Number(v) * 1e6))).toString()}".`
              : "USDC base units as a string of digits: 1 USDC is \"1000000\".",
          });
        }),
    })
  );

/**
 * Encodes the on-chain declaration tuple. The backend NEVER computes, infers, normalises
 * upward or improves a declaration; it copies the seller values verbatim into calldata, and
 * `declaredAt` is left at zero because the contract stamps chain time itself. [14A.1]
 */
/** The declared split, committed in the listing next to the total the chain stores. */
function tokenBreakdownOf(d: z.infer<typeof DeclarationInput>) {
  return {
    input: Number(d.inputTokens),
    reasoning: Number(d.reasoningTokens),
    output: Number(d.outputTokens),
    model: d.modelTier,
  };
}

/** Adds (or replaces) tokenBreakdown in a JSON listing when a declaration is sent with an update. */
function withTokenBreakdown(metadataURI: string, d: z.infer<typeof DeclarationInput> | undefined): string {
  if (!d) return metadataURI;
  let doc: Record<string, unknown> = {};
  try {
    const t = (metadataURI ?? "").trim();
    doc = t.startsWith("{") ? (JSON.parse(t) as Record<string, unknown>) : {};
  } catch {
    doc = {};
  }
  const next = JSON.stringify({ ...doc, tokenBreakdown: tokenBreakdownOf(d) });
  if (next.length > 4096) {
    throw ApiError.invalid("metadataURI is too long once the token breakdown is added; shorten the description.", {
      issues: [{ path: ["metadataURI"], message: "at most 4096 characters including tokenBreakdown" }],
    });
  }
  return next;
}

function encodeDeclaration(input: z.infer<typeof DeclarationInput>): [bigint, string, number, bigint] {
  const basis = input.basis === "MEASURED" ? 2 : 1;
  return [BigInt(input.tokensSaved), encodeBytes32String(input.modelTier), basis, 0n];
}

/**
 * A service's code must compile and expose a callable before it is listed. When the runner is configured the
 * code is run once — with the first demonstration's input if the listing has one — and only a code error
 * (CODE_INVALID) refuses the listing; a runtime error on that input is the seller's to judge.
 */
async function checkServiceCode(env: Env, contentBase64: string, meta: Record<string, unknown> | null): Promise<void> {
  const code = Buffer.from(contentBase64, "base64").toString("utf8");
  if (Buffer.byteLength(code, "utf8") > SERVICE_LIMITS.maxCodeBytes) {
    throw ApiError.invalid(`A service's code is at most ${SERVICE_LIMITS.maxCodeBytes} bytes.`, {
      issues: [{ path: ["content"], message: "too large for a service" }],
    });
  }
  if (!runnerConfigured(env)) return;
  const demos = Array.isArray(meta?.demonstrations) ? (meta!.demonstrations as Record<string, unknown>[]) : [];
  const probeInput = demos.length > 0 && demos[0] && typeof demos[0] === "object" ? (demos[0] as Record<string, unknown>).input ?? null : null;
  const result = await runOnRunner(env, code, probeInput);
  if (!result.ok && result.code === "CODE_INVALID") {
    throw ApiError.invalid(`The service code cannot be called: ${result.message}`, {
      issues: [{ path: ["content"], message: result.message }],
      remedy: "Send JavaScript that defines `function tool(input) { ... }` (or run/handler/main, or module.exports = (input) => ...) and returns JSON.",
    });
  }
}

function productIdBytes32(raw: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw : keccak256(toUtf8Bytes(raw));
}

/**
 * Deadline for an on-chain trade, measured against CHAIN time rather than this process clock.
 *
 * `block.timestamp` is what the contract compares the deadline to, and it is not the same clock
 * as `Date.now()`. A chain running ahead of the backend (a test chain that has been time-warped,
 * an L2 with a drifting sequencer clock, a node with a skewed host) makes a wall-clock deadline
 * already expired at the moment it is signed, and the Agent gets `DeadlinePassed` on a
 * transaction that was never late. Taking the later of the two is safe in both directions: the
 * deadline is only ever an upper bound on how long the intent stays valid.
 *
 * The chain timestamp comes from the indexed block log, so this costs no RPC call.
 */
async function tradeDeadline(chainId: number, windowSeconds: number): Promise<number> {
  return (await chainNow(chainId)) + windowSeconds;
}

/** The indexed curve state, in the exact shape the quote maths expects. */
function curveStateOf(market: {
  virtualTokenReserve: string;
  virtualUSDCReserve: string;
  marketInventoryAIC: string;
  realUSDCReserve: string;
  netSoldFromCurveAIC: string;
}): CurveState {
  return {
    virtualTokenReserve: BigInt(market.virtualTokenReserve),
    virtualUSDCReserve: BigInt(market.virtualUSDCReserve),
    tokenInventory: BigInt(market.marketInventoryAIC),
    realUSDCReserve: BigInt(market.realUSDCReserve),
    netSoldFromCurve: BigInt(market.netSoldFromCurveAIC),
  };
}

/**
 * Refuses a sell the market cannot settle, with the amount it CAN settle right now.
 *
 * `sellSolvencyRule`: a redemption is paid from REAL USDC actually held for that market, never
 * from the virtual pricing reserve. That is a property of the market, not of the caller wallet,
 * so it gets its own error code and its own remedy. Conflating it with `INSUFFICIENT_USDC` made
 * an Agent top up a balance that was never the constraint, or abandon a position it could have
 * exited in two smaller sells. [MASTER_PLAN 29A]
 */
function assertMarketCanSettle(
  state: CurveState,
  grossUSDC: bigint,
  market: { aicToken: string; storeId: string; symbol?: string }
): void {
  if (grossUSDC <= state.realUSDCReserve) return;
  const sellable = maxTokensSellableNow(state);
  throw new ApiError(
    "MARKET_INSUFFICIENT_REAL_USDC",
    `This market can redeem ${format(state.realUSDCReserve, 6)} USDC right now. The requested ` +
      `sell settles to ${format(grossUSDC, 6)} USDC. Your own USDC balance is not the constraint.`,
    409,
    {
      aicToken: market.aicToken,
      storeId: market.storeId,
      requestedGrossUSDC: amountUSDC(grossUSDC),
      redeemableNowUSDC: amountUSDC(state.realUSDCReserve),
      shortfallUSDC: amountUSDC(grossUSDC - state.realUSDCReserve),
      maxTokensSellableNow: amountAIC(sellable, market.symbol),
      derived: true,
      reason: "sell_solvency",
      remedy:
        "Sell at most maxTokensSellableNow, or wait for buy-side flow to increase the real " +
        "reserve. maxTokensSellableNow is derived from the indexed curve state and is exact " +
        "only while no other trade lands first.",
    }
  );
}


/* -------------------------------------------------------------- quote context */

/** USDC per whole AIC as a decimal string, from base amounts (USDC 6, AIC 18 decimals). */
const perToken = (usdcBase: bigint, aicBase: bigint): string | null => (aicBase > 0n ? priceDecimal((usdcBase * 10n ** 30n) / aicBase) : null);
const spot = (usdcReserve: bigint, tokenReserve: bigint): bigint => (tokenReserve > 0n ? (usdcReserve * 10n ** 30n) / tokenReserve : 0n);
const impactPct = (before: bigint, after: bigint): string | null =>
  before > 0n ? (Number(((after - before) * 1_000_000n) / before) / 10_000).toFixed(4) : null;
const usdcDec = (base: bigint): string => {
  const s = ethers.formatUnits(base, 6);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};

/** The business around a quote: the stock's market, commerce and buyback figures (read-only). */
async function quoteContext(chainId: number, aicToken: string): Promise<Record<string, unknown> | null> {
  try {
    const { markets, storeOf } = await loadMarkets(chainId, { aicToken: aicToken.toLowerCase() });
    const m = markets[0];
    if (!m) return null;
    const facts = await gatherFacts(chainId, [m]);
    const f = fundamentals(m, storeOf.get(String(m.storeId)), facts.get(String(m.aicToken).toLowerCase())!);
    return {
      market: { priceUSDC: f.market.priceUSDC, marketCapUSDC: f.market.marketCapUSDC, liquidityUSDC: f.market.liquidityUSDC, volume24hUSDC: f.market.volume24hUSDC, holdersCount: f.market.holdersCount },
      business: { commerce1hUSDC: f.business.commerce1hUSDC, commerce24hUSDC: f.business.commerce24hUSDC, commerceGrowth1hPct: f.business.commerceGrowth1hPct, uniqueCustomers24h: f.business.uniqueCustomers24h },
      buyback: { buyback1hUSDC: f.buyback.buyback1hUSDC, buyback24hUSDC: f.buyback.buyback24hUSDC, lifetimeBuybackUSDC: f.buyback.lifetimeBuybackUSDC },
      fundamentals: `GET /api/v1/stocks/${String(m.aicToken).toLowerCase()}/fundamentals`,
    };
  } catch {
    return null;
  }
}

export function writeRouter(): Router {
  const router = Router();
  router.use(noStore, requireAgent);

  /* ------------------------------------------------------ store creation */

  router.post(
    "/stores",
    idempotent({ action: "create_store" }),
    handler(async (req, res) => {
      const parsed = CreateStoreBody.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid store request", { issues: parsed.error.issues });
      const minSeed = BigInt(req.ctx.manifest.economics.minInitialOwnerSeedUSDC);
      const rawSeed = parsed.data.initialOwnerSeedUSDC;
      const seedBase = rawSeed === undefined ? 0n : BigInt(rawSeed.split(".")[0]!) * 1_000_000n + BigInt(((rawSeed.split(".")[1] ?? "") + "000000").slice(0, 6));
      if (seedBase < minSeed) {
        throw new ApiError(
          "INITIAL_MARKET_CAPITAL_TOO_LOW",
          `Store creation requires at least ${format(minSeed, 6)} USDC of owner-funded initial AIC market capital. ` +
            "It buys your own store's AIC in the creation transaction — it is not a fee.",
          400,
          {
            minimumUSDC: format(minSeed, 6),
            providedUSDC: rawSeed === undefined ? null : format(seedBase, 6),
            field: "initialOwnerSeedUSDC",
          }
        );
      }
      const wallet = selfWallet(req);
      const m = req.ctx.manifest;
      const factory = m.contracts.activeFactories[0];
      if (!factory) throw new ApiError("SERVICE_UNAVAILABLE", "No active factory is configured", 503);

      /*
       * A seed larger than the wallet holds is refused here, in words. One agent sent base units into
       * this decimal field and was handed a transaction for 100,000,000 USDC, which the chain refused
       * with an unnamed ERC20 error.
       */
      if (req.ctx.providers) {
        try {
          const erc20 = new Interface(["function balanceOf(address) view returns (uint256)"]);
          const raw = await req.ctx.providers.call("eth_call", (p) =>
            p.call({ to: m.external.canonicalUSDC, data: erc20.encodeFunctionData("balanceOf", [wallet]) })
          );
          const [balance] = erc20.decodeFunctionResult("balanceOf", raw) as unknown as [bigint];
          if (balance > 0n && seedBase > balance) {
            throw ApiError.invalid(
              `initialOwnerSeedUSDC is ${format(seedBase, 6)} USDC, but this wallet holds ${format(balance, 6)} USDC. ` +
                'The field is decimal USDC ("100" is one hundred USDC), not base units.',
              { issues: [{ path: ["initialOwnerSeedUSDC"], message: "more than the wallet holds" }], walletUSDC: format(balance, 6) }
            );
          }
        } catch (err) {
          if (err instanceof ApiError) throw err;
          /* a failed balance read is not a reason to refuse; the transaction is simulated anyway */
        }
      }

      /*
       * One store per type per creator, refused HERE and not by the chain.
       *
       * The factory enforces this with StoreLimitReached, and it did: 206 of the 207 reverted
       * transactions in one run were this one error — eight agents that already owned a store
       * asked for a second, this route prepared it, and the chain refused it. Two hundred and two
       * times. The revert carries four bytes and no sentence, so every one of those agents learned
       * only that "the protocol refused", and tried again.
       *
       * The factory publishes the mapping it checks, so the answer is one eth_call away. Read it,
       * and refuse with the store they already have and the endpoint that lists a product in it —
       * which is almost always what a caller in this position actually wants.
       */
      const typeIndex = parsed.data.storeType === "sales" ? 0 : 1;
      const factoryAbi = req.ctx.abis.interfaceFor("factory");
      let existingStoreId: string | null = null;
      if (req.ctx.providers && factoryAbi.hasFunction("storeOfCreator")) {
        try {
          const raw = await req.ctx.providers.call("eth_call", (p) =>
            p.call({
              to: factory.address,
              data: factoryAbi.encodeFunctionData("storeOfCreator", [wallet, typeIndex]),
            })
          );
          const [id] = factoryAbi.decodeFunctionResult("storeOfCreator", raw);
          if (typeof id === "string" && !/^0x0{64}$/i.test(id)) existingStoreId = id.toLowerCase();
        } catch {
          /* The chain read failing is not a reason to refuse; the simulation below still runs. */
        }
      }
      if (existingStoreId) {
        /*
         * The factory's record is per creator and permanent: it is not cleared when control of the
         * store passes to someone else. A wallet whose store was taken over is therefore still
         * refused — and "list a product in it" would be wrong advice, because it controls nothing.
         */
        const existing = await Store.findOne({ chainId: req.ctx.env.CHAIN_ID, storeId: existingStoreId })
          .select({ storeController: 1 })
          .lean();
        const lostIt =
          existing?.storeController != null && existing.storeController.toLowerCase() !== wallet.toLowerCase();
        throw new ApiError(
          "STORE_LIMIT_REACHED",
          lostIt
            ? `This wallet created a ${parsed.data.storeType} store that is now controlled by another wallet. The factory ` +
                "allows one store per type per creator, permanently — losing control does not free the slot. Nothing was prepared."
            : `This wallet already created a ${parsed.data.storeType} store, and the factory allows one ` +
                "per type per creator. Nothing was prepared: the transaction could only revert.",
          409,
          {
            storeType: parsed.data.storeType,
            existingStoreId,
            ...(lostIt
              ? {
                  currentController: existing!.storeController,
                  youNoLongerControlIt: true,
                  yourOptions: [
                    `Take it back: become its largest eligible holder and hold first place for the observation period — GET /api/v1/largest-holders/${existingStoreId} shows what that takes.`,
                    parsed.data.storeType === "sales"
                      ? 'Open the other type: this wallet may still create one "rentals" store.'
                      : 'Open the other type: this wallet may still create one "sales" store.',
                    "Start a new business from a new wallet. It starts with no holders, history, ratings or customers; the old store keeps its record.",
                  ],
                }
              : {
                  yourStore: `/api/v1/stores/${existingStoreId}`,
                  toListAProductInIt: `POST /api/v1/stores/${existingStoreId}/products`,
                }),
            toSeeWhatYouControl: "/api/v1/me",
            theOtherType:
              parsed.data.storeType === "sales"
                ? 'You may still create one "rentals" store from this wallet.'
                : 'You may still create one "sales" store from this wallet.',
          }
        );
      }

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "create_store",
        contract: factory.address,
        abi: req.ctx.abis.interfaceFor("factory"),
        functionName: "createStore",
        args: [
          parsed.data.storeType === "sales" ? 0 : 1,
          parsed.data.aicName,
          parsed.data.aicSymbol,
          parsed.data.storeName,
          seedBase,
        ],
        allowance: {
          token: m.external.canonicalUSDC,
          tokenSymbol: "USDC",
          spender: factory.address,
          amount: amountUSDC(seedBase),
          reason: "Your initial market capital: the factory uses exactly this to buy your store's AIC for you, in the creation transaction.",
        },
        summary: {
          action: "create_store",
          description: `Create a canonical ${parsed.data.storeType} store with its own 1,000,000,000 AIC market.`,
          protocol: {
            factory: factory.address,
            factoryVersion: factory.version,
            storeType: parsed.data.storeType,
            protocolCreationFeeUSDC: "0",
            initialOwnerSeedUSDC: format(seedBase, 6),
            minimumInitialOwnerSeedUSDC: format(minSeed, 6),
            genesisSupplyAIC: m.economics.aicGenesisSupply,
            creatorGenesisAllocationAIC: "0",
            virtualUSDCReserve: m.economics.virtualUSDCReserve,
          },
          sellerContent: { aicName: parsed.data.aicName, storeName: parsed.data.storeName },
          warnings: [
            "Store creation charges no fee. Your initial market capital buys your own store's AIC in the same transaction; the standard curve trading fees apply to that buy.",
            "All 1,000,000,000 AIC go to the market; you receive only what your initial capital buys — nothing free.",
            "If the initial buy cannot be paid, the whole creation reverts: no store exists without its market capital.",
          ],
        },
      });

      res.status(201).json({
        intent,
        initialMarketCapital: (() => {
          const e = m.economics;
          const rt = roundTripOnCurve(
            freshCurveState(BigInt(e.virtualUSDCReserve), BigInt(e.aicGenesisSupply)),
            seedBase,
            e.agentGoodsProtocolFeeBps,
            e.agentGoodsControllerFeeBps,
            BigInt(e.aicGenesisSupply),
            BigInt(e.transitionThresholdAIC)
          );
          return {
            ownerFundedUSDC: amountUSDC(seedBase),
            ownerAICReceived: amountAIC(rt.buy.tokensOut),
            tradingFeesOnTheSeedUSDC: { protocol: amountUSDC(rt.buy.protocolFeeUSDC), controller: amountUSDC(rt.buy.controllerFeeUSDC) },
            realReserveUSDC: amountUSDC(rt.buy.netCurveUSDC),
            marketInitialized: true,
            controllerIsHolder: true,
            controllerCanFundIncentive: true,
            independentDemandUSDC: "0",
            whatItIs:
              "This is initial market capital, not a creation fee: it buys your own store's AIC, which you receive, " +
              "and becomes the market's first real liquidity. It is owner capital — not independent demand.",
            theMinimum:
              "The minimum is a validity floor, not a recommended size. The curve's depth comes from its virtual reserve, not " +
              "from this amount; what the amount decides is how much of the earliest ownership of your business you hold. " +
              "You can add to it later with an ordinary buy (GET /api/v1/stores/{storeId}/seed-analysis compares sizes).",
            yourExposure:
              "You receive an AIC position against this capital, but remain exposed to fees, curve mechanics, liquidity, " +
              "opportunity cost and changes in its market value.",
            figuresAreFor: "a fresh market, as the creation transaction will find it.",
          };
        })(),
      });
    })
  );

  /* ---------------------------------------------------------- products */

  router.post(
    "/stores/:storeId/products",
    idempotent({ action: "create_product", scope: (req) => req.params.storeId }),
    handler(async (req, res) => {
      const parsed = CreateProductBody.safeParse(req.body);
      if (!parsed.success) {
        /*
         * Name the fields in the message itself, not only in the payload.
         *
         * "Invalid product request" is true of every one of these and distinguishes none of them.
         * A caller reading only the message learned nothing; `details.fields` now says what to send
         * for each rejected field, and the message points straight at it.
         */
        const rejected = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))];
        throw ApiError.invalid(
          `This product was not listed: ${rejected.join(", ")} ${rejected.length === 1 ? "is" : "are"} ` +
            "wrong or missing. details.fields says exactly what to send for each one.",
          { issues: parsed.error.issues }
        );
      }
      const wallet = selfWallet(req);
      const store = await requireControlledStore(req, wallet);

      /*
       * A listing needs a name. Refused here, because the chain does not care and buyers do.
       *
       * The first product an agent listed in one run had an empty metadataURI: no name, no
       * description, nothing the market could search or a buyer could read — a committed hash
       * with a price on it. The protocol allows that; this API does not any more. The name is the
       * one thing every other reader of this listing needs, and it costs the seller a word.
       */
      const meta = (() => {
        const text = (parsed.data.metadataURI ?? "").trim();
        if (!text.startsWith("{")) return null;
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      const listingName = typeof meta?.name === "string" ? meta.name.trim() : "";
      if (!listingName) {
        throw ApiError.invalid(
          "This product was not listed: it has no name. Send metadataURI as JSON with a non-empty " +
            '`name` — {"name": "...", "description": "...", "demonstrations": [...]} — so buyers ' +
            "can find it and know what it is.",
          { issues: [{ path: ["metadataURI"], message: "must be JSON with a non-empty name" }] }
        );
      }

      // A SERVICE: its spec is stored by hash and committed in the listing; its code is checked before listing.
      let serviceBlock: { pricingModel: "PER_CALL"; specHash: string } | null = null;
      if (parsed.data.service) {
        if (store.storeType !== "sales") {
          throw ApiError.invalid("A service is sold per call from a Sales store; this is a rentals store.", {
            issues: [{ path: ["service"], message: "only in a Sales store" }],
          });
        }
        if (parsed.data.content === undefined) {
          throw ApiError.invalid("A service's code must be sent as `content` (base64 of the JavaScript source) with the listing.", {
            issues: [{ path: ["content"], message: "required for a service" }],
          });
        }
        checkServiceSpec(parsed.data.service);
        await checkServiceCode(req.ctx.env, parsed.data.content, meta);
        serviceBlock = {
          pricingModel: "PER_CALL",
          specHash: await saveServiceSpec(req.ctx.env.CHAIN_ID, store.storeId, {
            inputSchema: parsed.data.service.inputSchema,
            outputSchema: parsed.data.service.outputSchema,
          }),
        };
      }

      // Iterations go on chain with the listing: this version's and the running total (a new product starts it).
      const createLog = checkIterationLog(parsed.data.iterations, parsed.data.iterationLog);
      const createLogHash = await saveIterationLog(req.ctx.env.CHAIN_ID, store.storeId, createLog);
      parsed.data.metadataURI = JSON.stringify({
        ...meta,
        iterations: parsed.data.iterations,
        iterationsTotal: parsed.data.iterations,
        iterationLogHash: createLogHash,
        ...(parsed.data.declaration ? { tokenBreakdown: tokenBreakdownOf(parsed.data.declaration) } : {}),
        ...(serviceBlock ? { service: serviceBlock } : {}),
      });
      if (parsed.data.metadataURI.length > 4096) {
        throw ApiError.invalid("metadataURI is too long once iterations are added; shorten the description.", {
          issues: [{ path: ["metadataURI"], message: "at most 4096 characters including iterations" }],
        });
      }

      const declaration = encodeDeclaration(parsed.data.declaration);
      const inventory = parsed.data.unlimitedInventory
        ? UNLIMITED
        : (parsed.data.inventory ?? "0");

      /*
       * The bytes came with the listing: store them now, and the commitment is theirs.
       *
       * Done before anything else is examined, so that the "is there anything behind the hash"
       * check below sees exactly what a two-step caller's upload would have left, and both paths
       * are judged by the same rule.
       */
      let contentHash = parsed.data.contentHash ?? "";
      let uploadedNow: { contentHash: string; byteLength: number } | null = null;
      if (parsed.data.content !== undefined) {
        uploadedNow = await storeProductContent({
          chainId: req.ctx.env.CHAIN_ID,
          storeId: store.storeId,
          wallet,
          contentBase64: parsed.data.content,
          contentType: parsed.data.contentType,
          filename: parsed.data.filename,
          encryptionKey: req.ctx.env.CONTENT_ENCRYPTION_KEY,
        });
        contentHash = uploadedNow.contentHash;
      }

      /*
       * Warnings the PROTOCOL raises, not the agent's own client.
       *
       * Everything an agent needs to learn has to arrive through the API, because a real agent is
       * a third-party program nobody can restart to teach it something. Guidance that lives only
       * in one client reaches only that client — so the two failures that have cost the most here
       * are detected server-side and returned to whoever is listing, whatever they are running.
       */
      const productWarnings: string[] = [
        "A token-saving declaration is an unverified seller claim. Do not overstate it: " +
          "buyers can compare it against your delivered signal record.",
        "The declaration is immutable for this product version. Changing it creates a new version.",
      ];

      /*
       * Is there anything behind the hash?
       *
       * A product commits a contentHash on chain and the gateway serves whatever was uploaded
       * against it. When nothing was uploaded, every check a careful buyer performs still passes
       * — the commitment is real — and they receive nothing. That is worse than an obvious
       * failure, so the protocol says it at the moment of listing rather than leaving it to be
       * discovered by someone who already paid.
       */
      const committed = contentHash.toLowerCase();
      if (committed && !/^0x0+$/.test(committed)) {
        const stored = await ProductContent.findOne({
          chainId: req.ctx.env.CHAIN_ID,
          storeId: store.storeId,
          contentHash: committed,
        })
          .select({ byteLength: 1 })
          .lean();

        if (!stored) {
          /*
           * REFUSED, not warned.
           *
           * This was a warning, and warnings do not bind: nine of the first fifteen listings
           * ignored it and shipped a product whose committed bytes did not exist. A buyer of one
           * of those pays, receives a valid licence, verifies the hash correctly and collects
           * nothing — and every check they can perform says the transaction was sound, because
           * the commitment itself is genuine. A marketplace that lets a seller list goods it
           * cannot deliver is not protecting anybody by mentioning it politely.
           *
           * The ordering this imposes is the right way round anyway: upload the deliverable, then
           * list it. The upload needs only the storeId and the bytes, so nothing forces a seller
           * to list first.
           */
          throw ApiError.invalid(
            "No content is stored for this contentHash, so this product could not be delivered.",
            {
              contentHash: committed,
              storeId: store.storeId,
              why:
                "A buyer would pay, receive a valid licence, verify the hash successfully and " +
                "collect nothing. Every check they can run would pass, because the commitment is " +
                "genuine — it is the thing committed to that does not exist.",
              remedy:
                "Upload the deliverable first: POST /api/v1/access/content with this storeId and " +
                "the bytes whose keccak256 equals this contentHash. Then create the product.",
              ifYouMeantToSellText:
                "If the deliverable IS the text you wrote, upload that text. The rule is not that " +
                "a product must be code — it is that what you commit to must exist.",
            }
          );
        } else {
          productWarnings.push(
            `Content is stored for this hash (${stored.byteLength} bytes) and will be delivered on purchase.`
          );
        }
      }

      /*
       * No warning compares the declaration with the price. A declaration is the seller's word; whether the
       * product was worth its price is for buyers to say (worth it or not), not for the site to predict.
       */

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "create_product",
        contract: store.address,
        abi: req.ctx.abis.interfaceFor("store"),
        functionName: "createProduct",
        args: [
          productIdBytes32(parsed.data.productId),
          BigInt(parsed.data.priceUSDC),
          BigInt(inventory),
          parsed.data.rentalPeriodSeconds ?? 0,
          contentHash,
          parsed.data.metadataURI ?? "",
          declaration,
        ],
        allowance: null,
        summary: {
          action: "create_product",
          description: "List a new product in your store.",
          protocol: {
            storeId: store.storeId,
            priceUSDC: amountUSDC(BigInt(parsed.data.priceUSDC)),
            inventory: parsed.data.unlimitedInventory ? "unlimited" : inventory,
            declaration: parsed.data.declaration ?? null,
            declarationIsSellerClaim: true,
          },
          sellerContent: { metadataURI: parsed.data.metadataURI ?? "" },
          warnings: productWarnings,
        },
      });

      /*
       * Said once: when this is the store's FIRST product and its token market is still uninitialized.
       * The owner now has something to sell, and the token is still invisible to numeric screens.
       */
      const firstProductNote = await (async () => {
        const existing = await Product.countDocuments({ chainId: req.ctx.env.CHAIN_ID, storeId: store.storeId });
        if (existing > 0) return null;
        const mk = await StockMarket.findOne({ chainId: req.ctx.env.CHAIN_ID, aicToken: String(store.aicToken ?? "").toLowerCase() }).lean();
        if (!mk || marketStateOf(mk as Record<string, unknown>).marketInitialized) return null;
        return {
          message: "You now have a product, but your store's AIC market remains uninitialized.",
          consider:
            "If you expect token investors to discover the business, evaluate whether a small owner-funded seed " +
            "would make its economics measurable. It is a capital-allocation decision, not a required step.",
          analyzeSeedEconomics: `GET /api/v1/stores/${store.storeId}/seed-analysis?wallet=${wallet}&amountsUSDC=<your amounts>`,
        };
      })();
      res.status(201).json({
        intent,
        development: iterationsFeedback(parsed.data.iterations, parsed.data.iterations),
        ...(firstProductNote ? { yourTokenMarket: firstProductNote } : {}),
        /*
         * Said back, because the caller never saw a hash. When the bytes came inline the
         * commitment was computed here, and a seller should be able to see what it is about to
         * sign for without decoding calldata.
         */
        ...(uploadedNow
          ? {
              content: {
                stored: true,
                contentHash: uploadedNow.contentHash,
                byteLength: uploadedNow.byteLength,
                note:
                  "Your bytes were stored and this contentHash is committed in the transaction " +
                  "above. A buyer verifies keccak256 of what they receive against it.",
              },
            }
          : {}),
      });
    })
  );

  router.post(
    "/stores/:storeId/products/:productId/update",
    idempotent({ action: "update_product", scope: (req) => `${req.params.storeId}:${req.params.productId}` }),
    handler(async (req, res) => {
      const parsed = UpdateProductBody.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid update", { issues: parsed.error.issues });

      /*
       * Held for the version this update is about to create.
       *
       * The version row itself is written by the indexer when the transaction lands, so the note
       * is staged here against the NEXT version number and attached when that row appears. Doing
       * it this way keeps the chain as the authority on what changed and when, while still
       * letting the seller say why.
       */
      const changelogText = (parsed.data.changelog ?? "").trim();
      const wallet = selfWallet(req);
      const store = await requireControlledStore(req, wallet);

      const current = await Product.findOne({
        chainId: req.ctx.env.CHAIN_ID,
        storeId: store.storeId,
        productId: req.params.productId,
      }).lean();
      if (!current) throw ApiError.notFound("Product");

      /*
       * An update without `declaration` keeps the current one. The contract writes the declaration of every new
       * version, so encoding "nothing" here used to wipe a product's declaration on a simple repricing.
       */
      const cur = current.declaration as { declared?: boolean; tokensSaved?: string | null; modelTier?: string | null; basis?: string } | undefined;
      if (!parsed.data.declaration && !(cur?.declared && cur.tokensSaved && BigInt(cur.tokensSaved) > 0n)) {
        throw ApiError.invalid(`This product has no token declaration yet, so this update must add one. ${DECLARATION_REQUIRED}`, {
          issues: [{ path: ["declaration"], message: "required: this product declares no tokens yet" }],
        });
      }
      const keptDeclaration: [bigint, string, number, bigint] = parsed.data.declaration
        ? encodeDeclaration(parsed.data.declaration)
        : [BigInt(cur!.tokensSaved!), encodeBytes32String(String(cur!.modelTier ?? "")), cur!.basis === "MEASURED" ? 2 : 1, 0n];
      /* New listing text sent without a declaration keeps the committed token split. */
      const keptBreakdown = (uri: string): string => {
        if (parsed.data.declaration) return uri;
        try {
          const prev = JSON.parse(String(current.sellerContent?.metadataURI ?? "{}")) as Record<string, unknown>;
          const doc = JSON.parse(uri) as Record<string, unknown>;
          if (prev.tokenBreakdown && !doc.tokenBreakdown) return JSON.stringify({ ...doc, tokenBreakdown: prev.tokenBreakdown });
        } catch {
          /* not JSON: nothing to carry */
        }
        return uri;
      };

      /*
       * A service stays a service: new listing text keeps the committed spec unless a new `service` is sent.
       * New code for a service is checked on the runner before it can be listed.
       */
      const previousService = (() => {
        try {
          const prev = JSON.parse(String(current.sellerContent?.metadataURI ?? "{}")) as Record<string, unknown>;
          return (prev.service ?? null) as Record<string, unknown> | null;
        } catch {
          return null;
        }
      })();
      let nextService: Record<string, unknown> | null = previousService;
      if (parsed.data.service) {
        if (store.storeType !== "sales") {
          throw ApiError.invalid("A service is sold per call from a Sales store; this is a rentals store.", {
            issues: [{ path: ["service"], message: "only in a Sales store" }],
          });
        }
        checkServiceSpec(parsed.data.service);
        nextService = {
          pricingModel: "PER_CALL",
          specHash: await saveServiceSpec(req.ctx.env.CHAIN_ID, store.storeId, {
            inputSchema: parsed.data.service.inputSchema,
            outputSchema: parsed.data.service.outputSchema,
          }),
        };
      }
      if (nextService && parsed.data.content !== undefined) {
        await checkServiceCode(req.ctx.env, parsed.data.content, null);
      }
      const keptService = (uri: string): string => {
        if (!nextService) return uri;
        try {
          const doc = JSON.parse(uri) as Record<string, unknown>;
          const next = JSON.stringify({ ...doc, service: nextService });
          if (next.length > 4096) {
            throw ApiError.invalid("metadataURI is too long once the service spec hash is added; shorten the description.", {
              issues: [{ path: ["metadataURI"], message: "at most 4096 characters including service" }],
            });
          }
          return next;
        } catch (e) {
          if (e instanceof ApiError) throw e;
          return uri;
        }
      };

      const inventory = parsed.data.unlimitedInventory ? UNLIMITED : (parsed.data.inventory ?? current.inventory);

      /*
       * New bytes, handled exactly as at listing.
       *
       * The body schema accepted `content` here and nothing read it: a seller that sent repaired
       * bytes got a new version committed to the OLD hash, no error, and buyers still collected the
       * broken file. Now `content` is stored and committed, and a new `contentHash` must have
       * something stored behind it — the same rule a listing is held to.
       */
      if (parsed.data.content !== undefined && parsed.data.contentHash) {
        throw ApiError.invalid(
          "Send exactly one of `content` (base64 of the new deliverable — the API stores it and " +
            "commits to it) or `contentHash` (from an earlier POST /api/v1/access/content).",
          { fields: { content: "or contentHash, not both" } }
        );
      }
      let newContentHash: string | undefined = parsed.data.contentHash;
      let uploadedNow: { contentHash: string; byteLength: number } | null = null;
      if (parsed.data.content !== undefined) {
        uploadedNow = await storeProductContent({
          chainId: req.ctx.env.CHAIN_ID,
          storeId: store.storeId,
          wallet,
          contentBase64: parsed.data.content,
          contentType: parsed.data.contentType,
          filename: parsed.data.filename,
          encryptionKey: req.ctx.env.CONTENT_ENCRYPTION_KEY,
        });
        newContentHash = uploadedNow.contentHash;
      } else if (newContentHash && !/^0x0+$/.test(newContentHash)) {
        const stored = await ProductContent.findOne({
          chainId: req.ctx.env.CHAIN_ID,
          storeId: store.storeId,
          contentHash: newContentHash.toLowerCase(),
        })
          .select({ _id: 1 })
          .lean();
        if (!stored) {
          throw ApiError.invalid(
            "No content is stored for this contentHash, so this version could not be delivered.",
            {
              contentHash: newContentHash.toLowerCase(),
              storeId: store.storeId,
              remedy:
                "Send the new bytes as `content` (base64) in this update, or upload them first with " +
                "POST /api/v1/access/content and send the contentHash it returns.",
            }
          );
        }
      }

      /*
       * Staged against the version this update will create.
       *
       * The version row is written by the indexer when the transaction lands, so the note is
       * upserted here for `current.version + 1` and is waiting when that row appears. If the
       * seller never broadcasts the intent, a changelog for a version that does not exist sits
       * harmlessly unreferenced — which is much better than the alternative of losing the note
       * because the chain had not caught up at the moment it was written.
       */
      if (changelogText) {
        await ProductVersion.updateOne(
          {
            chainId: req.ctx.env.CHAIN_ID,
            storeId: store.storeId,
            productId: req.params.productId,
            version: Number(current.version ?? 0) + 1,
          },
          { $set: { changelog: changelogText } },
          { upsert: true }
        );
      }

      /*
       * Iterations travel with every upload. A content change adds this upload's iterations to the running
       * total already committed for the product; a price- or status-only update carries the listing as it is.
       */
      const updatedMetadataURI = await (async () => {
        const base = parsed.data.metadataURI ?? current.sellerContent?.metadataURI ?? "";
        const asJson = (text: string): Record<string, unknown> | null => {
          const t = (text ?? "").trim();
          if (!t.startsWith("{")) return null;
          try {
            return JSON.parse(t) as Record<string, unknown>;
          } catch {
            return null;
          }
        };
        const committed = asJson(String(current.sellerContent?.metadataURI ?? "")) ?? {};
        if (parsed.data.iterations === undefined || parsed.data.iterationLog === undefined) {
          // New listing text without a new upload keeps the development already committed for this content.
          if (parsed.data.metadataURI === undefined) return base;
          const doc = asJson(base);
          if (!doc) return base;
          const carried: Record<string, unknown> = {};
          for (const k of ["iterations", "iterationsTotal", "iterationLogHash"]) if (committed[k] !== undefined) carried[k] = committed[k];
          return JSON.stringify({ ...doc, ...carried });
        }
        const doc: Record<string, unknown> = asJson(base) ?? {};
        const log = checkIterationLog(parsed.data.iterations, parsed.data.iterationLog);
        doc.iterationLogHash = await saveIterationLog(req.ctx.env.CHAIN_ID, store.storeId, log);
        let previous = Number((current.sellerContent as { profile?: { iterationsTotal?: number | null } } | undefined)?.profile?.iterationsTotal ?? 0) || 0;
        try {
          const old = JSON.parse(String(current.sellerContent?.metadataURI ?? "{}")) as Record<string, unknown>;
          previous = Math.max(previous, Number(old.iterationsTotal ?? old.iterations ?? 0) || 0);
        } catch {
          /* not JSON: no previous count */
        }
        const next = JSON.stringify({ ...doc, iterations: parsed.data.iterations, iterationsTotal: previous + parsed.data.iterations });
        if (next.length > 4096) {
          throw ApiError.invalid("metadataURI is too long once iterations are added; shorten the description.", {
            issues: [{ path: ["metadataURI"], message: "at most 4096 characters including iterations" }],
          });
        }
        return next;
      })();

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "update_product",
        contract: store.address,
        abi: req.ctx.abis.interfaceFor("store"),
        functionName: "updateProduct",
        args: [
          current.productId,
          BigInt(parsed.data.priceUSDC ?? current.priceUSDC),
          BigInt(inventory),
          parsed.data.rentalPeriodSeconds ?? current.rentalPeriodSeconds,
          parsed.data.active ?? current.active,
          /*
           * On update the existing hash is kept when none is supplied, but a zero can never be
           * re-committed: a legacy product with no commitment must gain one to be edited, rather
           * than silently carrying its missing guarantee forward into a new version.
           */
          requireContentHash(newContentHash ?? current.contentHash),
          withTokenBreakdown(keptService(keptBreakdown(updatedMetadataURI)), parsed.data.declaration),
          keptDeclaration,
        ],
        allowance: null,
        summary: {
          action: "update_product",
          description: `Update product ${current.productId}. This increments its version to ${current.version + 1}.`,
          protocol: {
            storeId: store.storeId,
            productId: current.productId,
            currentVersion: current.version,
            nextVersion: current.version + 1,
            declaration: parsed.data.declaration ?? null,
            contentHash: (newContentHash ?? current.contentHash ?? null),
            contentChanged: Boolean(newContentHash && newContentHash.toLowerCase() !== String(current.contentHash ?? "").toLowerCase()),
          },
          warnings: [
            "Every update bumps productVersion, which invalidates outstanding quotes bound to " +
              "the previous version. Historical purchases keep the version they were sold under.",
          ],
        },
      });

      res.status(201).json({
        intent,
        ...(parsed.data.iterations !== undefined
          ? { development: iterationsFeedback(parsed.data.iterations, Number(JSON.parse(updatedMetadataURI || "{}").iterationsTotal ?? parsed.data.iterations)) }
          : {}),
        ...(uploadedNow ? { content: { contentHash: uploadedNow.contentHash, byteLength: uploadedNow.byteLength, stored: true } } : {}),
      });
    })
  );

  /* ------------------------------------------------- customer incentive */

  /**
   * Fund a store's customer reward pool.
   *
   * THIS ROUTE DID NOT EXIST. The protocol told sellers to run a customer incentive, ranked stores
   * by it, and provided no way to fund one over the API at all — the only client that managed it
   * was calling `depositRewardPool` on the contract directly, which an agent reading the site
   * could not have known to do. A capability the documentation urges and the API withholds is not
   * a capability.
   *
   * The pool is denominated in the store's OWN AIC, which the controller receives none of at
   * genesis, so funding one requires buying into your own curve first. The refusal below says so
   * rather than failing with an allowance error.
   */
  router.post(
    "/stores/:storeId/reward-pool/deposit-intent",
    idempotent({ action: "fund_reward_pool", scope: (req) => req.params.storeId }),
    handler(async (req, res) => {
      const Body = z.object({ aicAmount: z.string().regex(/^\d+$/) });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) {
        throw ApiError.invalid("Invalid reward pool deposit", {
          issues: parsed.error.issues,
          expected: '{"aicAmount":"<base units, 18 decimals>"}',
        });
      }
      const wallet = selfWallet(req);
      const store = await requireControlledStore(req, wallet);
      const amount = BigInt(parsed.data.aicAmount);
      if (amount <= 0n) throw ApiError.invalid("aicAmount must be greater than zero.");
      const sym = await storeTokenSymbol(req.ctx.env.CHAIN_ID, (store as { aicToken?: string }).aicToken);
      const aic = (v: bigint) => amountAIC(v, sym);

      const held = await AicHolder.findOne(
        { chainId: req.ctx.env.CHAIN_ID, holder: wallet.toLowerCase(), aicToken: store.aicToken },
        { balance: 1 }
      ).lean();
      const balance = BigInt(held?.balance ?? "0");
      if (balance < amount) {
        throw new ApiError(
          "INSUFFICIENT_AIC",
          `A reward pool is funded with this store's OWN token, and you hold ${aic(balance).display} of it.`,
          409,
          {
            storeId: store.storeId,
            aicToken: store.aicToken,
            youHold: aic(balance),
            youAskedToDeposit: aic(amount),
            why:
              "Creating a store allocates the founder ZERO of its token — the whole supply goes " +
              "to the market. Buy some of your own AIC first; you are the earliest buyer, so it " +
              "is the cheapest it will be.",
            remedy: `POST /api/v1/stocks/${store.aicToken}/buy`,
          }
        );
      }

      const rate =
        store.storeType === "rentals"
          ? req.ctx.manifest.economics.rentalsRewardRate
          : req.ctx.manifest.economics.salesRewardRate;

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "fund_reward_pool",
        contract: store.address,
        abi: req.ctx.abis.interfaceFor("store"),
        functionName: "depositRewardPool",
        args: [amount.toString()],
        allowance: {
          token: store.aicToken,
          tokenSymbol: "AIC",
          spender: store.address,
          amount: aic(amount),
          reason: "Exact amount for this deposit. Approve exactly this, never an unlimited allowance.",
        },
        summary: {
          action: "fund_reward_pool",
          description: "Fund the customer incentive pool for this store, in its own AIC.",
          protocol: {
            storeId: store.storeId,
            storeType: store.storeType,
            depositAIC: aic(amount),
            poolAfterAIC: aic(BigInt(store.rewardPoolAIC ?? "0") + amount),
            ratePerUnit: `${rate.numerator}/${rate.denominator} of the REMAINING pool`,
            unitMeans: store.storeType === "rentals" ? "one rental period" : "one item bought",
            nextUnitWouldPayAIC: aic(
              previewReward(BigInt(store.rewardPoolAIC ?? "0") + amount, 1, {
                numerator: BigInt(rate.numerator),
                denominator: BigInt(rate.denominator),
                minimumPool: BigInt(rate.minimumPool),
                poolGate: BigInt(rate.poolGate),
              })
            ),
          },
          warnings: [
            "The reward decays geometrically: each unit is paid a share of what REMAINS, so the " +
              "pool is never emptied outright and each purchase pays slightly less than the last.",
            store.storeType === "rentals"
              ? "Rentals pay 100x less per unit than sales, because a rentals unit is a PERIOD of " +
                "time and one purchase can span many of them."
              : "Sales pay per item bought.",
            "What is distributed is gone. What is not distributed stays withdrawable.",
            "The pool transfers with the store if you are ever taken over.",
          ],
        },
      });

      res.status(201).json({ intent });
    })
  );

  /* --------------------------------------------------------- attestor */

  router.post(
    "/stores/:storeId/access-attestor",
    idempotent({ action: "set_access_attestor", scope: (req) => req.params.storeId }),
    handler(async (req, res) => {
      const Body = z.object({ attestor: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid attestor", { issues: parsed.error.issues });
      const wallet = selfWallet(req);
      const store = await requireControlledStore(req, wallet);

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "set_access_attestor",
        contract: store.address,
        abi: req.ctx.abis.interfaceFor("store"),
        functionName: "setAccessAttestor",
        args: [parsed.data.attestor],
        allowance: null,
        summary: {
          action: "set_access_attestor",
          description:
            "Designate the delivery witness allowed to record on-chain access grants for this store.",
          protocol: { storeId: store.storeId, attestor: parsed.data.attestor },
          warnings: [
            "The attestor can only witness deliveries. It cannot signal, mint, move value or " +
              "become controller.",
            "Buyers cannot signal until a delivery is attested, and missing attestations show " +
              "up publicly as collapsing coverage.",
          ],
        },
      });

      res.status(201).json({ intent });
    })
  );

  /* ---------------------------------------------------------- profile */

  /**
   * Publish the store display profile: name, description, logo, illustrative media.
   *
   * The body is passed through to chain verbatim. The backend validates SHAPE ONLY (size, JSON
   * well-formedness, URI schemes) and never edits, enriches or improves what a seller wrote;
   * the indexer applies the same sanitizer on the way back out. See docs/DECISIONS.md D-017.
   *
   * Deliberately available while a governance lock is active: publishing a description moves no
   * value out of the store, and a locked controller must still be able to implement a proposal.
   */
  router.post(
    "/stores/:storeId/profile",
    idempotent({ action: "set_store_profile", scope: (req) => req.params.storeId }),
    handler(async (req, res) => {
      const Body = z.object({ profile: z.union([z.string().max(MAX_PROFILE_BYTES), z.record(z.unknown())]) });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid profile", { issues: parsed.error.issues });

      const raw =
        typeof parsed.data.profile === "string"
          ? parsed.data.profile
          : JSON.stringify(parsed.data.profile);
      if (Buffer.byteLength(raw, "utf8") > MAX_PROFILE_BYTES) {
        throw ApiError.invalid(`Profile exceeds ${MAX_PROFILE_BYTES} bytes on chain`);
      }
      // Reject before spending gas on something the indexer would then drop.
      const preview = parseProfile(raw);
      if (raw.trim().startsWith("{") && !preview.parsed) {
        throw ApiError.invalid("Profile is not a valid JSON document", { rejected: preview.rejected });
      }

      const wallet = selfWallet(req);
      const store = await requireControlledStore(req, wallet);

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "set_store_profile",
        contract: store.address,
        abi: req.ctx.abis.interfaceFor("store"),
        functionName: "setStoreProfile",
        args: [raw],
        allowance: null,
        summary: {
          action: "set_store_profile",
          description: "Publish untrusted display content for this store: name, description, media.",
          protocol: { storeId: store.storeId, bytes: Buffer.byteLength(raw, "utf8") },
          warnings: [
            "This content is display only. It confers no protocol meaning, no canonicality and " +
              "no priority in any listing.",
            "Fields that fail shape sanitization are dropped by the indexer and reported as " +
              "rejectedFields; they are never repaired.",
            ...(preview.rejected.length > 0
              ? [`These fields will be dropped as written: ${preview.rejected.join(", ")}`]
              : []),
          ],
        },
      });

      res.status(201).json({ intent, willPublish: preview.rejected, bytes: Buffer.byteLength(raw, "utf8") });
    })
  );

  /* ----------------------------------------------------------- wallet */

  /**
   * A plain USDC transfer, PREPARED like every other write.
   *
   * WHY THE API PREPARES SOMETHING THAT IS NOT A PROTOCOL ACTION. Every write this API returns is
   * passed to a signer as an object and never becomes text. The one thing an agent here has to do
   * with USDC that the protocol does not prepare — pay another wallet: a lender, a counterparty, a
   * collaborator — it therefore had to ABI-encode by hand: 136 hex characters, and in one run
   * twenty-five consecutive hand-encoded transfers were 126 to 140 characters long. Not one was
   * the protocol refusing anything. A language model reproducing a 136-character string is the
   * failure mode this whole API is built to remove, and it was being asked to do it on the single
   * most routine payment there is.
   *
   * No allowance: transfer() spends the caller's own balance. The preflight simulation catches a
   * balance that is short before anything is signed.
   */
  router.post(
    "/wallet/transfer-intent",
    idempotent({ action: "transfer_usdc" }),
    handler(async (req, res) => {
      const parsed = TransferBody.safeParse(req.body);
      if (!parsed.success) {
        const said = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
        throw ApiError.invalid(`A transfer needs { "to": <address>, "amountUSDC": <base units> }. ${said}`, {
          issues: parsed.error.issues,
        });
      }
      const wallet = selfWallet(req);
      const m = req.ctx.manifest;
      const to = getAddress(parsed.data.to);
      const amount = BigInt(parsed.data.amountUSDC);
      if (amount <= 0n) throw ApiError.invalid("amountUSDC must be greater than zero.", { issues: [{ path: ["amountUSDC"], message: "zero" }] });
      if (to.toLowerCase() === wallet.toLowerCase()) {
        throw ApiError.invalid("That is your own wallet. A transfer to yourself moves nothing and costs gas.", {
          issues: [{ path: ["to"], message: "is the sender" }],
        });
      }

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "transfer_usdc",
        contract: m.external.canonicalUSDC,
        abi: ERC20_TRANSFER,
        functionName: "transfer",
        args: [to, amount],
        allowance: null,
        requireFreshIndexer: false,
        summary: {
          action: "transfer_usdc",
          description: `Send ${amountUSDC(amount).display} USDC from your wallet to ${to}.`,
          protocol: {
            token: m.external.canonicalUSDC,
            to,
            amountUSDC: amountUSDC(amount),
            noAllowanceNeeded: true,
            irreversible: true,
          },
          warnings: [
            "A transfer cannot be undone. Check `to` once more; it is a wallet on this chain and nothing else.",
            "This is a plain token transfer, not a protocol action: nothing is recorded by the marketplace beyond the chain itself.",
          ],
        },
      });

      res.status(201).json({ intent });
    })
  );

  /* ----------------------------------------------------------- quotes */

  router.post(
    "/stores/:storeId/products/:productId/quote",
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;
      const Body = z.object({ units: z.coerce.number().int().min(1).max(MAX_UNITS_PER_PURCHASE) });
      /* `units` defaults to one. Eighteen quotes in one run were 400 for an empty body. */
      const parsed = Body.safeParse({ units: 1, ...((req.body as Record<string, unknown> | undefined) ?? {}) });
      if (!parsed.success) {
        throw ApiError.invalid("This quote was not prepared: `units` must be a whole number from 1 to 365.", {
          issues: parsed.error.issues,
        });
      }

      const store = await Store.findOne({ chainId, storeId: req.params.storeId }).lean();
      if (!store) throw ApiError.notFound("Store");
      const product = await Product.findOne({ chainId, storeId: store.storeId, productId: req.params.productId }).lean();
      if (!product) throw ApiError.notFound("Product");

      if (!product.active) throw new ApiError("PRODUCT_UNAVAILABLE", "This product is not active", 409);
      if (store.status !== "active") throw new ApiError("STORE_PAUSED", "This store is not active", 409);

      const units = parsed.data.units;
      if (!product.unlimitedInventory) {
        const needed = store.storeType === "rentals" ? 1n : BigInt(units);
        if (BigInt(product.inventory) < needed) {
          throw new ApiError("PRODUCT_SOLD_OUT", "Not enough inventory remaining", 409, {
            inventory: product.inventory,
            requested: units,
          });
        }
      }

      const price = BigInt(product.priceUSDC);
      const gross = price * BigInt(units);
      const m = req.ctx.manifest;
      const breakdown = settle(gross, m.economics.commerceFeeBps, m.economics.holderReserveBps);
      const rewardParams =
        store.storeType === "sales"
          ? {
              numerator: BigInt(m.economics.salesRewardRate.numerator),
              denominator: BigInt(m.economics.salesRewardRate.denominator),
              minimumPool: BigInt(m.economics.salesRewardRate.minimumPool),
              poolGate: BigInt(m.economics.salesRewardRate.poolGate),
            }
          : {
              numerator: BigInt(m.economics.rentalsRewardRate.numerator),
              denominator: BigInt(m.economics.rentalsRewardRate.denominator),
              minimumPool: BigInt(m.economics.rentalsRewardRate.minimumPool),
              poolGate: BigInt(m.economics.rentalsRewardRate.poolGate),
            };
      const reward = previewReward(BigInt(store.rewardPoolAIC), units, rewardParams);
      const rewardSymbol = await storeTokenSymbol(chainId, (store as { aicToken?: string }).aicToken);

      const now = Math.floor(Date.now() / 1000);
      const quoteId = `q_${crypto.randomBytes(12).toString("hex")}`;

      res.json({
        quote: {
          quoteId,
          chainId,
          contract: store.address,
          storeId: store.storeId,
          productId: product.productId,
          productVersion: product.version,
          /* The name the purchase body uses. The quote said "pass expectedVersion" and returned only productVersion. */
          expectedVersion: product.version,
          action: store.storeType === "rentals" ? "rent" : "purchase",
          units,
          formulaVersion: "1.0.0",
          gross: amountUSDC(breakdown.gross),
          protocolFee: amountUSDC(breakdown.protocolFee),
          net: amountUSDC(breakdown.net),
          mandatoryHolderReserve: amountUSDC(breakdown.holderReserve),
          controllerAvailable: amountUSDC(breakdown.ownerAvailable),
          maxTotalUSDC: breakdown.gross.toString(),
          expectedRewardAIC: amountAIC(reward, rewardSymbol),
          /*
           * Said here, because a number without its unit is a different number for each store
           * type. A rentals quote for `units: 30` is thirty rental periods in one purchase, and
           * the reward was computed by running the rentals decay thirty times — not thirty items
           * at the sales rate.
           */
          unitMeans: store.storeType === "rentals" ? "one rental period" : "one item",
          rewardComputedAs:
            store.storeType === "rentals"
              ? `the rentals rate ${m.economics.rentalsRewardRate.numerator}/${m.economics.rentalsRewardRate.denominator} of the remaining pool, applied once per period, ${units} time(s), inside this one purchase`
              : `the sales rate ${m.economics.salesRewardRate.numerator}/${m.economics.salesRewardRate.denominator} of the remaining pool, applied once per item, ${units} time(s), inside this one purchase`,
          rentalExpiresAt:
            store.storeType === "rentals" ? now + product.rentalPeriodSeconds * units : null,
          asOfIndexedBlock: req.ctx.indexerStatus().indexedBlock,
          createdAt: now,
          expiresAt: now + QUOTE_TTL_SECONDS,
          roundingMode: "protocol fee and holder reserve round up; controller remainder absorbs dust",
        },
        declaration: declarationView(product.declaration),
        sellerContent: { metadataURI: product.sellerContent?.metadataURI ?? "", note: SELLER_CONTENT_NOTE },
        execution: {
          endpoint: `/api/v1/stores/${store.storeId}/products/${product.productId}/${store.storeType === "rentals" ? "rent" : "purchase"}`,
          /* The exact body, so nothing has to be copied field by field. */
          body: { units, expectedVersion: product.version, maxTotalUSDC: breakdown.gross.toString() },
          note:
            "POST execution.body to execution.endpoint (with an Idempotency-Key). The contract reverts " +
            "if the product version changed or the total exceeds your maximum.",
        },
        requester: wallet,
        freshness: freshness(req.ctx),
      });
    })
  );

  /* --------------------------------------------------------- commerce */

  /*
   * "buy" answers as "purchase".
   *
   * Fourteen 404s in one run were POST …/products/{id}/buy — the word every buyer reached for,
   * and the word this API's own next-steps text had used. A route that exists under one spelling
   * and 404s under the obvious other one is a puzzle, not a contract. Both spellings prepare the
   * same purchase, under the same idempotency scope.
   */
  for (const path of ["purchase", "buy", "rent"] as const) {
    const verb = path === "rent" ? "rent" : "purchase";
    router.post(
      `/stores/:storeId/products/:productId/${path}`,
      idempotent({
        action: verb,
        scope: (req) => `${req.params.storeId}:${req.params.productId}`,
      }),
      handler(async (req, res) => {
        const parsed = PurchaseBody.safeParse(req.body);
        if (!parsed.success) {
          const rejected = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))];
          throw ApiError.invalid(
            `This ${verb} was not prepared: ${rejected.join(", ")} ${rejected.length === 1 ? "is" : "are"} ` +
              "wrong or missing: " +
              parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") +
              ". details.fields says what to send for each one; the quote endpoint gives " +
              "the exact expectedVersion and gross to use.",
            { issues: parsed.error.issues }
          );
        }
        const wallet = selfWallet(req);
        const chainId = req.ctx.env.CHAIN_ID;

        const store = await Store.findOne({ chainId, storeId: req.params.storeId }).lean();
        if (!store) throw ApiError.notFound("Store");
        const expectedType = verb === "rent" ? "rentals" : "sales";
        if (store.storeType !== expectedType) {
          throw ApiError.invalid(`This is a ${store.storeType} store; use the ${store.storeType} endpoint.`);
        }

        const product = await Product.findOne({
          chainId,
          storeId: store.storeId,
          productId: req.params.productId,
        }).lean();
        if (!product) throw ApiError.notFound("Product");
        if (product.version !== parsed.data.expectedVersion) {
          throw new ApiError(
            "PRODUCT_VERSION_MISMATCH",
            "The product changed since your quote. Request a fresh quote.",
            409,
            { quotedVersion: parsed.data.expectedVersion, currentVersion: product.version }
          );
        }

        const gross = BigInt(product.priceUSDC) * BigInt(parsed.data.units);
        if (gross > BigInt(parsed.data.maxTotalUSDC)) {
          throw new ApiError("QUOTE_EXPIRED", "Total exceeds your authorised maximum", 409, {
            total: gross.toString(),
            maxTotalUSDC: parsed.data.maxTotalUSDC,
          });
        }

        const intent = await buildIntent({
          ctx: req.ctx,
          wallet,
          action: verb,
          contract: store.address,
          abi: req.ctx.abis.interfaceFor("store"),
          functionName: verb === "rent" ? "rent" : "purchase",
          args: [
            product.productId,
            parsed.data.units,
            parsed.data.expectedVersion,
            BigInt(parsed.data.maxTotalUSDC),
            "0x" + "00".repeat(32),
            parsed.data.licenseURI ?? "",
          ],
          allowance: {
            token: req.ctx.manifest.external.canonicalUSDC,
            tokenSymbol: "USDC",
            spender: store.address,
            amount: amountUSDC(gross),
            reason:
              "Exact amount for this purchase. Approve exactly this, never an unlimited allowance.",
          },
          summary: {
            action: verb,
            description: `${verb === "rent" ? "Rent" : "Buy"} ${parsed.data.units} unit(s) of ${product.productId}.`,
            protocol: {
              storeId: store.storeId,
              productId: product.productId,
              productVersion: product.version,
              units: parsed.data.units,
              totalUSDC: amountUSDC(gross),
              declaration: declarationView(product.declaration),
            },
            sellerContent: { metadataURI: product.sellerContent?.metadataURI ?? "" },
            warnings: [
              "V1 has no refund path. This purchase is final.",
              "The token-saving declaration is an unverified seller claim.",
              "The LicenseToken you receive is non-transferable.",
            ],
          },
        });

        res.status(201).json({
          intent,
          /*
           * The buyer's part does not end at payment. Most buyers never collected what they bought,
           * and a purchase never collected can never be rated — so the seller never learned whether
           * its code worked.
           */
          afterYouBuy: [
            "1) Sign and send intent.transaction — the purchase.",
            "2) Collect it: POST /api/v1/access/grant {licenseToken, licenseId} and GET the URL it returns. Your licence id is " +
              "in /api/v1/me once the purchase is indexed. The delivery is recorded on chain within about a minute.",
            "3) Use it, then rate it: POST /api/v1/licenses/{licenseToken}/{licenseId}/signal {\"worthIt\": true|false, " +
              "\"note\": \"what worked or what to fix\"} — and sign and send that transaction too. Worth it or not worth it, your " +
              "verdict is how the seller learns whether its code works and the only way sellers build a real reputation.",
          ],
        });
      })
    );
  }

  /* ------------------------------------------------------------ market */

  router.post(
    "/stocks/:aicToken/quote",
    handler(async (req, res) => {
      const Body = z.object({
        side: z.enum(["buy", "sell"]),
        amount: z.string().regex(/^\d+$/),
      });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid quote", { issues: parsed.error.issues });

      const market = await requireMarket(req);
      const m = req.ctx.manifest;
      const state = curveStateOf(market);

      if (market.phase !== "bonding_curve") {
        /*
         * A graduated market trades on its UniswapV2 pool. This used to refuse with "trade there"
         * and nothing else, while buy and sell went on preparing curve trades that could only
         * revert — so after graduation an agent could trade the token only by encoding a router
         * call by hand. It is quoted on the pool now, and buy/sell prepare the router swap.
         */
        const pool = isGraduated(market) ? dexPoolOf(market) : null;
        if (!pool) {
          throw new ApiError("PRODUCT_UNAVAILABLE", "This market is between venues and cannot be quoted right now.", 409, { phase: market.phase, pair: market.pair });
        }
        const now = Math.floor(Date.now() / 1000);
        const amount = BigInt(parsed.data.amount);
        const out =
          parsed.data.side === "buy"
            ? (amount * 997n * pool.tokenReserve) / (pool.usdcReserve * 1000n + amount * 997n)
            : dexSellOut(pool, amount);
        const before = spot(pool.usdcReserve, pool.tokenReserve);
        const dexExtra =
          parsed.data.side === "buy"
            ? (() => {
                const after = { usdcReserve: pool.usdcReserve + amount, tokenReserve: pool.tokenReserve - out };
                return {
                  inputUSDC: usdcDec(amount),
                  aicReceived: ethers.formatUnits(out, 18),
                  averageExecutionPriceUSDC: perToken(amount, out),
                  spotPriceBeforeUSDC: priceDecimal(before),
                  spotPriceAfterUSDC: priceDecimal(spot(after.usdcReserve, after.tokenReserve)),
                  priceImpactPct: impactPct(before, spot(after.usdcReserve, after.tokenReserve)),
                  immediateSellValueUSDC: usdcDec(dexSellOut(after, out)),
                };
              })()
            : (() => {
                const after = { usdcReserve: pool.usdcReserve - out, tokenReserve: pool.tokenReserve + amount };
                return {
                  aicSold: ethers.formatUnits(amount, 18),
                  usdcReceived: usdcDec(out),
                  averageExecutionPriceUSDC: perToken(out, amount),
                  spotPriceBeforeUSDC: priceDecimal(before),
                  spotPriceAfterUSDC: priceDecimal(spot(after.usdcReserve, after.tokenReserve)),
                  priceImpactPct: impactPct(before, spot(after.usdcReserve, after.tokenReserve)),
                };
              })();
        const dexContext = parsed.data.side === "buy" ? await quoteContext(req.ctx.env.CHAIN_ID, String(market.aicToken)) : null;
        res.json({
          quote: {
            side: parsed.data.side,
            venue: "dex",
            ...dexExtra,
            ...(dexContext ?? {}),
            chainId: req.ctx.env.CHAIN_ID,
            contract: m.external.dexRouter,
            pair: market.pair,
            aicToken: market.aicToken,
            ...(parsed.data.side === "buy"
              ? { grossUSDC: amountUSDC(amount), expectedOutAIC: amountAIC(out, market.symbol) }
              : { tokensInAIC: amountAIC(amount, market.symbol), expectedOutUSDC: amountUSDC(out) }),
            poolFee: "0.3% (UniswapV2); no protocol or store-owner fee on the pool",
            note: "This market has graduated from its bonding curve to its DEX pool. POST …/buy or …/sell prepares the router swap.",
            asOfIndexedBlock: req.ctx.indexerStatus().indexedBlock,
            createdAt: now,
            expiresAt: now + QUOTE_TTL_SECONDS,
          },
          freshness: freshness(req.ctx),
        });
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      if (parsed.data.side === "buy") {
        const allocationCtx = req.agent?.wallet
          ? await capitalAllocationContext(req.ctx.env.CHAIN_ID, String(req.agent.wallet), String(market.aicToken), BigInt(parsed.data.amount))
          : null;
        const q = quoteBuy(
          state,
          BigInt(parsed.data.amount),
          m.economics.agentGoodsProtocolFeeBps,
          m.economics.agentGoodsControllerFeeBps,
          BigInt(m.economics.aicGenesisSupply),
          BigInt(m.economics.transitionThresholdAIC)
        );
        const beforeSpot = spot(state.virtualUSDCReserve, state.virtualTokenReserve);
        const afterState = {
          ...state,
          virtualUSDCReserve: state.virtualUSDCReserve + q.netCurveUSDC,
          virtualTokenReserve: state.virtualTokenReserve - q.tokensOut,
          realUSDCReserve: state.realUSDCReserve + q.netCurveUSDC,
          tokenInventory: state.tokenInventory - q.tokensOut,
          netSoldFromCurve: q.netSoldAfter,
        };
        const afterSpot = spot(afterState.virtualUSDCReserve, afterState.virtualTokenReserve);
        const resell = quoteSell(afterState, q.tokensOut, m.economics.agentGoodsProtocolFeeBps, m.economics.agentGoodsControllerFeeBps);
        const resellPayable = resell.grossUSDC > afterState.realUSDCReserve && resell.grossUSDC > 0n
          ? (resell.netUSDCOut * afterState.realUSDCReserve) / resell.grossUSDC
          : resell.netUSDCOut;
        const buyContext = await quoteContext(req.ctx.env.CHAIN_ID, String(market.aicToken));
        res.json({
          quote: {
            side: "buy",
            venue: "curve",
            inputUSDC: usdcDec(q.grossUSDC),
            aicReceived: ethers.formatUnits(q.tokensOut, 18),
            averageExecutionPriceUSDC: perToken(q.grossUSDC, q.tokensOut),
            spotPriceBeforeUSDC: priceDecimal(beforeSpot),
            spotPriceAfterUSDC: priceDecimal(afterSpot),
            priceImpactPct: impactPct(beforeSpot, afterSpot),
            immediateSellValueUSDC: usdcDec(resellPayable),
            immediateSellValueNote: "What selling the AIC received would pay straight after this buy, fees included, capped by the curve's real USDC reserve.",
            ...(buyContext ?? {}),
            chainId: req.ctx.env.CHAIN_ID,
            contract: m.contracts.agentGoods.proxy,
            aicToken: market.aicToken,
            grossUSDC: amountUSDC(q.grossUSDC),
            protocolFeeUSDC: amountUSDC(q.protocolFeeUSDC),
            controllerFeeUSDC: amountUSDC(q.controllerFeeUSDC),
            netCurveUSDC: amountUSDC(q.netCurveUSDC),
            expectedOutAIC: amountAIC(q.tokensOut, market.symbol),
            priceImpactNote: `Constant product over virtual reserves seeded with ${(Number(m.economics.virtualUSDCReserve) / 1e6).toLocaleString("en-US")} USDC.`,
            netSoldPercentageBps: q.netSoldPercentageBps,
            willTriggerTransition: q.willTriggerTransition,
            enoughInventory: q.enoughInventory,
            asOfIndexedBlock: req.ctx.indexerStatus().indexedBlock,
            createdAt: now,
            expiresAt: now + QUOTE_TTL_SECONDS,
          },
          ...(allocationCtx ? { capitalAllocationContext: allocationCtx } : {}),
          freshness: freshness(req.ctx),
        });
        return;
      }

      const q = quoteSell(
        state,
        BigInt(parsed.data.amount),
        m.economics.agentGoodsProtocolFeeBps,
        m.economics.agentGoodsControllerFeeBps
      );
      assertMarketCanSettle(state, q.grossUSDC, market);
      const sellBefore = spot(state.virtualUSDCReserve, state.virtualTokenReserve);
      const sellAfter = spot(state.virtualUSDCReserve - q.grossUSDC, state.virtualTokenReserve + q.tokensIn);
      res.json({
        quote: {
          side: "sell",
          venue: "curve",
          aicSold: ethers.formatUnits(q.tokensIn, 18),
          usdcReceived: usdcDec(q.netUSDCOut),
          averageExecutionPriceUSDC: perToken(q.netUSDCOut, q.tokensIn),
          spotPriceBeforeUSDC: priceDecimal(sellBefore),
          spotPriceAfterUSDC: priceDecimal(sellAfter),
          priceImpactPct: impactPct(sellBefore, sellAfter),
          chainId: req.ctx.env.CHAIN_ID,
          contract: m.contracts.agentGoods.proxy,
          aicToken: market.aicToken,
          tokensInAIC: amountAIC(q.tokensIn, market.symbol),
          grossUSDC: amountUSDC(q.grossUSDC),
          protocolFeeUSDC: amountUSDC(q.protocolFeeUSDC),
          controllerFeeUSDC: amountUSDC(q.controllerFeeUSDC),
          expectedOutUSDC: amountUSDC(q.netUSDCOut),
          enoughRealReserve: q.enoughRealReserve,
          solvencyNote:
            `Only real USDC can satisfy a redemption. The ${(Number(m.economics.virtualUSDCReserve) / 1e6).toLocaleString("en-US")} virtual USDC is pricing state ` +
            "and can never be paid out.",
          asOfIndexedBlock: req.ctx.indexerStatus().indexedBlock,
          createdAt: now,
          expiresAt: now + QUOTE_TTL_SECONDS,
        },
        freshness: freshness(req.ctx),
      });
    })
  );

  for (const side of ["buy", "sell"] as const) {
    router.post(
      `/stocks/:aicToken/${side}`,
      idempotent({ action: `stock_${side}`, scope: (req) => req.params.aicToken }),
      handler(async (req, res) => {
        const parsed = TradeBody.safeParse(req.body);
        if (!parsed.success) throw ApiError.invalid("Invalid trade", { issues: parsed.error.issues });
        const wallet = selfWallet(req);
        const market = await requireMarket(req);
        const m = req.ctx.manifest;
        const deadline = await tradeDeadline(req.ctx.env.CHAIN_ID, parsed.data.deadlineSeconds ?? 600);
        const amount = BigInt(parsed.data.amount);
        const minOut = BigInt(parsed.data.minOut ?? "0");
        // An owner of an uninitialized store buying INTO another market: facts beside the intent, never a block.
        const allocation = async () => {
          if (side !== "buy") return {};
          const c = await capitalAllocationContext(req.ctx.env.CHAIN_ID, wallet, String(market.aicToken), amount);
          return c ? { capitalAllocationContext: c } : {};
        };

        if (isGraduated(market)) {
          const pool = dexPoolOf(market);
          if (!pool) throw new ApiError("PRODUCT_UNAVAILABLE", "This market is between venues and cannot be traded right now.", 409, { phase: market.phase, pair: market.pair });
          const usdc = m.external.canonicalUSDC;
          const path = side === "buy" ? [usdc, market.aicToken] : [market.aicToken, usdc];
          const expected =
            side === "buy"
              ? (amount * 997n * pool.tokenReserve) / (pool.usdcReserve * 1000n + amount * 997n)
              : dexSellOut(pool, amount);
          const intent = await buildIntent({
            ctx: req.ctx,
            wallet,
            action: `stock_${side}`,
            contract: m.external.dexRouter,
            abi: DEX_ROUTER,
            functionName: "swapExactTokensForTokens",
            args: [amount, minOut, path, wallet, deadline],
            allowance: {
              token: side === "buy" ? usdc : market.aicToken,
              tokenSymbol: side === "buy" ? "USDC" : "AIC",
              spender: m.external.dexRouter,
              amount: side === "buy" ? amountUSDC(amount) : amountAIC(amount),
              reason: "Exact trade amount. Never approve more than this.",
            },
            summary: {
              action: `stock_${side}`,
              description:
                side === "buy"
                  ? `Buy AIC on its DEX pool with ${amount} USDC base units (the market has graduated).`
                  : `Sell ${amount} AIC base units into its DEX pool (the market has graduated).`,
              protocol: {
                venue: "dex",
                router: m.external.dexRouter,
                pair: market.pair,
                aicToken: market.aicToken,
                storeId: market.storeId,
                expectedOut: expected.toString(),
                minOut: minOut.toString(),
                deadline,
              },
              warnings: [
                "Set minOut from a fresh quote. Zero means you accept any price.",
                "The pool charges 0.3%; the price moves with the size of your trade.",
              ],
            },
          });
          res.status(201).json({ intent, ...(await allocation()) });
          return;
        }

        /*
         * The exchange's minimum, refused HERE and not by the chain.
         *
         * AgentGoods reverts any trade whose gross USDC is under MIN_TRADE_USDC (1 USDC) with
         * BelowMinimumTrade — four bytes, no sentence. Twelve of one run's reverts were exactly
         * that: agents buying for 0.40 and 0.75 USDC, the prices they had negotiated on the forum,
         * against a minimum no document stated. The API prepared each one. Now it refuses, says the
         * minimum, and says what would clear it.
         */
        const grossForMinimum =
          side === "buy"
            ? amount
            : quoteSell(
                curveStateOf(market),
                amount,
                m.economics.agentGoodsProtocolFeeBps,
                m.economics.agentGoodsControllerFeeBps
              ).grossUSDC;
        if (grossForMinimum < MIN_TRADE_USDC_BASE) {
          throw new ApiError(
            "BELOW_MINIMUM_TRADE",
            `The exchange does not execute a trade worth less than ${format(MIN_TRADE_USDC_BASE, 6)} USDC ` +
              `gross; this one is ${format(grossForMinimum, 6)} USDC. Nothing was prepared: the ` +
              "transaction could only revert (BelowMinimumTrade).",
            409,
            {
              side,
              minimumGrossUSDC: amountUSDC(MIN_TRADE_USDC_BASE),
              thisTradeGrossUSDC: amountUSDC(grossForMinimum),
              remedy:
                side === "buy"
                  ? `Send amount of at least "${MIN_TRADE_USDC_BASE.toString()}" (USDC base units).`
                  : "Sell enough AIC that the gross USDC out is at least 1 USDC; POST the quote endpoint to size it.",
            }
          );
        }

        // Refuse a sell the market cannot settle BEFORE an intent is ever built, so the Agent
        // never signs a transaction that is certain to revert. [MASTER_PLAN 29A.3]
        if (side === "sell") {
          const state = curveStateOf(market);
          const q = quoteSell(
            state,
            amount,
            m.economics.agentGoodsProtocolFeeBps,
            m.economics.agentGoodsControllerFeeBps
          );
          assertMarketCanSettle(state, q.grossUSDC, market);
        }

        const intent = await buildIntent({
          ctx: req.ctx,
          wallet,
          action: `stock_${side}`,
          contract: m.contracts.agentGoods.proxy,
          abi: req.ctx.abis.interfaceFor("agentGoods"),
          functionName: side,
          args: [market.aicToken, amount, minOut, deadline],
          allowance: {
            token: side === "buy" ? m.external.canonicalUSDC : market.aicToken,
            tokenSymbol: side === "buy" ? "USDC" : "AIC",
            spender: m.contracts.agentGoods.proxy,
            amount: side === "buy" ? amountUSDC(amount) : amountAIC(amount),
            reason: "Exact trade amount. Never approve more than this.",
          },
          summary: {
            action: `stock_${side}`,
            description:
              side === "buy"
                ? `Buy AIC on the bonding curve with ${amount} USDC base units.`
                : `Sell ${amount} AIC base units back to the bonding curve.`,
            protocol: {
              aicToken: market.aicToken,
              storeId: market.storeId,
              minOut: minOut.toString(),
              deadline,
              protocolFeeBps: m.economics.agentGoodsProtocolFeeBps,
              controllerFeeBps: m.economics.agentGoodsControllerFeeBps,
            },
            warnings: [
              "Set minOut from a fresh quote. Zero means you accept any price.",
              `A buy that crosses the ${req.ctx.manifest.economics.transitionThresholdPercent}% net-sold threshold triggers the one-way DEX transition.`,
            ],
          },
        });

        res.status(201).json({ intent, ...(await allocation()) });
      })
    );
  }

  return router;
}

/** A store token's own symbol (ATLS, EUSD…), so its amounts are not all labelled with the generic "AIC". */
async function storeTokenSymbol(chainId: number, aicToken: string | undefined): Promise<string | undefined> {
  if (!aicToken) return undefined;
  const m = await StockMarket.findOne({ chainId, aicToken: String(aicToken).toLowerCase() }).select({ symbol: 1 }).lean();
  return (m as { symbol?: string } | null)?.symbol || undefined;
}

async function requireControlledStore(
  req: Parameters<typeof selfWallet>[0],
  wallet: string
): Promise<Record<string, never> & { storeId: string; address: string; storeType: string; rewardPoolAIC: string }> {
  const store = await Store.findOne({
    chainId: req.ctx.env.CHAIN_ID,
    storeId: req.params.storeId,
  }).lean();
  if (!store) throw ApiError.notFound("Store");
  if (store.storeController.toLowerCase() !== wallet.toLowerCase()) {
    throw ApiError.forbidden(
      "Only the current storeController may manage this store. Control follows the Registry, " +
        "so a takeover or transfer changes it immediately."
    );
  }
  return store as never;
}

/** The external UniswapV2 router a graduated market trades through. */
const DEX_ROUTER = new Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);

async function requireMarket(req: { ctx: { env: { CHAIN_ID: number } }; params: Record<string, string> }) {
  const market = await StockMarket.findOne({
    chainId: req.ctx.env.CHAIN_ID,
    aicToken: req.params.aicToken.toLowerCase(),
  }).lean();
  if (!market) {
    throw new ApiError(
      "UNTRUSTED_UNKNOWN_CONTRACT",
      "That token has no canonical AIC market. Verify it through /api/v1/contracts.",
      404
    );
  }
  return market;
}
