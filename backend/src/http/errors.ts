/**
 * Canonical error model.
 *
 * MASTER_PLAN §20 fixes the error code vocabulary and forbids vague "Something went wrong"
 * responses. Every error an Agent can encounter is a stable machine-readable code with a
 * human explanation and, where useful, structured detail the Agent can act on.
 */

import { explainIssues } from "./fieldGuidance";

export const ERROR_CODES = [
  // auth
  "INVALID_API_KEY",
  "API_KEY_REVOKED",
  "ACTIVE_KEY_EXISTS",
  "NO_ACTIVE_KEY",
  "CHALLENGE_NOT_FOUND",
  "CHALLENGE_EXPIRED",
  "CHALLENGE_ALREADY_USED",
  "SIGNATURE_INVALID",
  "WALLET_MISMATCH",
  "PURPOSE_MISMATCH",
  "CHAIN_MISMATCH",
  "FORBIDDEN",
  // request
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "UNSUPPORTED_VERSION",
  // commerce
  // The CALLER does not hold enough USDC (or has not approved enough). Narrowed to exactly
  // that: a market that cannot pay a redemption is a different condition with a different
  // remedy, and has its own code. [MASTER_PLAN 29A]
  "INSUFFICIENT_USDC",
  "INSUFFICIENT_AIC",
  // The MARKET cannot settle this sell from its real USDC reserve. Nothing to do with the
  // caller balance; the remedy is a smaller sell or waiting for buy-side flow.
  "MARKET_INSUFFICIENT_REAL_USDC",
  "PRODUCT_UNAVAILABLE",
  "PRODUCT_SOLD_OUT",
  "PRODUCT_VERSION_MISMATCH",
  "LICENSE_EXPIRED",
  "LICENSE_REVOKED",
  "STORE_PAUSED",
  "STORE_NOT_CANONICAL",
  // The factory allows one store per type per creator; refused at prepare time, not by the chain.
  "STORE_LIMIT_REACHED",
  // AgentGoods.MIN_TRADE_USDC: 100 base units (0.0001 USDC), the smallest trade that still pays both fees.
  "BELOW_MINIMUM_TRADE",
  "SLIPPAGE_EXCEEDED",
  "QUOTE_EXPIRED",
  "INTENT_EXPIRED",
  // governance
  "VOTE_ALREADY_CAST",
  "PROPOSAL_CLOSED",
  "NOT_ORIGINAL_YES_VOTER",
  // dividends
  "DISTRIBUTION_NOT_FINALIZED",
  "ALREADY_CLAIMED",
  "GOVERNANCE_SUSPENSION_ACTIVE",
  // the factory refuses a store whose initial market capital is under the protocol minimum
  "INITIAL_MARKET_CAPITAL_TOO_LOW",
  // takeover (prepare-time checks against the indexed leader and candidacy; the contract decides)
  "ALREADY_CONTROLLER",
  "CANDIDACY_ALREADY_OPEN",
  "NOT_LARGEST_HOLDER",
  "NO_CANDIDACY",
  "LEADERSHIP_NOT_CONTINUOUS",
  "OBSERVATION_PERIOD_NOT_ELAPSED",
  // Phase 10.1
  "NOT_LICENSE_HOLDER",
  "NO_ACCESS_GRANTED",
  "SIGNAL_ALREADY_FINAL",
  "SIGNAL_WINDOW_CLOSED",
  // transactions
  "TRANSACTION_PENDING",
  "TRANSACTION_FAILED",
  // infrastructure
  "INDEXER_STALE",
  "UNTRUSTED_UNKNOWN_CONTRACT",
  "CANONICAL_MISMATCH",
  "SERVICE_UNAVAILABLE",
  // services (callable products)
  "NOT_A_SERVICE",
  "SERVICE_INACTIVE",
  "SERVICE_INPUT_INVALID",
  "PAYMENT_REQUIRED",
  "CALL_IN_PROGRESS",
  "SERVICE_CODE_NOT_DOWNLOADABLE",
  "SERVICE_RUNNER_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
    documentation: string;
    /** One sentence: what to do about it. Present on every error. */
    howToFix?: string;
    /**
     * The three documents that answer almost any question this error raises.
     *
     * On EVERY error, not only the ones about documentation. A caller that has hit one error is
     * usually one endpoint into a protocol it has never seen, and the specific message tells it
     * what went wrong THIS time and nothing about the shape of everything else. Naming the whole
     * map once, here, means a single failure can resolve the rest — which is the difference
     * between learning an API by reading it and learning it by hitting it forty-one times.
     */
    seeAlso: {
      skill: string;
      openapi: string;
      schema: string;
      /** Only once, on the first response after a site update this caller has not been told about. */
      updates?: { url: string; publishedAt: string; headline: string; note: string };
      howToUseThese: string;
    };
    /** A worked example of getting this right. See EXAMPLES below. */
    example?: ErrorExample;
  };
}

export interface ErrorExample {
  whatWentWrong: string;
  doThisInstead: string;
  example: unknown;
}

/**
 * A worked example for every error an Agent can actually hit.
 *
 * A message that states a rule is not the same as a message that shows the rule being obeyed.
 * "Idempotency-Key header is required" is accurate and complete, and Agents still failed the same
 * call four times in a row -- because knowing that a header is required is not the same as knowing
 * what to put in it. The pattern repeated everywhere: an Agent told it had insufficient USDC would
 * retry the identical amount, an Agent told its quote had expired would resubmit the stale quote.
 *
 * So every error carries a concrete correct call. Not a schema and not a documentation link: the
 * actual shape, with realistic values, beside a one-line statement of what to do differently. The
 * cost is a few hundred bytes on a response the Agent has already failed to use. The benefit is
 * that its next attempt can be different from its last one.
 *
 * Held as data rather than written into each throw site, so the wording stays consistent and the
 * whole vocabulary can be reviewed as one table.
 */
/**
 * How to fix it, one sentence per code, on EVERY error.
 *
 * `example` shows a correct call for the codes that have one; `details.fields` says what to send
 * per rejected field; `seeAlso` names the documents. What was still missing was the plain
 * instruction — the thing a caller reads first — and for a third of the codes there was nothing
 * but the message. Every code now has one, and a code that somehow does not gets a sentence that
 * points at the parts of the envelope that do.
 */
const HOW_TO_FIX: Partial<Record<ErrorCode, string>> = {
  INVALID_API_KEY:
    "Send `Authorization: Bearer <apiKey>`. Had a key and lost it: do not issue again — challenge with purpose ROTATE_API_KEY, sign, POST /api/v1/auth/api-key/rotate {nonce, signature}, keep the new key. Never had one: POST /api/v1/auth/challenge {wallet, purpose: \"ISSUE_API_KEY\"}, sign, POST /api/v1/auth/api-key/issue {nonce, signature}, keep the key. details names the branch when it can.",
  API_KEY_REVOKED: "This key was replaced by a rotation or revoked. If you hold the newer key, send it. If a key is still active but you lost it, rotate (purpose ROTATE_API_KEY). If the wallet has no active key, issue one (purpose ISSUE_API_KEY).",
  ACTIVE_KEY_EXISTS: "A key is active and cannot be shown again. Have it: send it as Bearer. Lost it: do not issue again — follow details.ifKeyLost.steps (rotate), keep the new key, use it.",
  NO_ACTIVE_KEY: "Issue a key first: challenge with purpose ISSUE_API_KEY, then POST /api/v1/auth/api-key/issue.",
  CHALLENGE_NOT_FOUND: "Request a fresh challenge and answer that one; nonces are single-use and short-lived.",
  CHALLENGE_EXPIRED: "Request a fresh challenge and sign it promptly; a challenge lives a few minutes.",
  CHALLENGE_ALREADY_USED: "Each nonce answers once. Request a fresh challenge.",
  SIGNATURE_INVALID: "Sign the challenge's `message` EXACTLY as returned, with the wallet you named. Do not reconstruct or reword it.",
  WALLET_MISMATCH: "The signature was made by a different wallet than the one in the challenge. Sign with the wallet you named.",
  PURPOSE_MISMATCH: "The challenge was issued for a different purpose. Request one with the purpose that matches the endpoint (ISSUE_API_KEY or ROTATE_API_KEY).",
  CHAIN_MISMATCH: "Your request names a different chain than this deployment. Read chainId from /api/v1/contracts and use that.",
  FORBIDDEN: "This wallet does not control the resource. `details` names who does; act on what you control (GET /api/v1/me).",
  RATE_LIMITED: "Wait `details.retryAfterSeconds`, then send the SAME request once.",
  INVALID_REQUEST: "Read `details.fields`: each rejected field says what to send. Fix only those fields and send again with a fresh Idempotency-Key.",
  NOT_FOUND: "The id or path does not exist on this deployment. If it is a PATH: every route that exists is in /skill (one table) and /api/v1/openapi.json — do not guess one. If it is an ID: read the current ids from /api/v1/me or the market; never reuse an id from another deployment.",
  IDEMPOTENCY_CONFLICT: "The same Idempotency-Key was used with a different body. Use a NEW key for a new action; reuse a key only to retry the identical request.",
  UNSUPPORTED_VERSION: "The product changed since you read it. Re-read it and send its current `version` as expectedVersion.",
  INSUFFICIENT_USDC: "Your wallet holds less USDC than this needs, or has not approved it. Check `details`; if it is the allowance, sign `intent.approvalTransaction` first.",
  INSUFFICIENT_AIC: "You hold less of this store's AIC than you asked to use. Buy it on the store's curve first: POST /api/v1/stocks/{aicToken}/buy.",
  MARKET_INSUFFICIENT_REAL_USDC: "The market cannot redeem that much right now. Sell at most `details.maxTokensSellableNow`, or wait for buy-side flow.",
  SLIPPAGE_EXCEEDED: "The price moved past your minOut. Re-quote and send again with a minOut that reflects the current price.",
  QUOTE_EXPIRED: "Request a fresh quote and act on it within its validity window.",
  INTENT_EXPIRED: "Prepare the transaction again with the request that created it; the new response carries a fresh transaction-request link.",
  PRODUCT_UNAVAILABLE: "This product is inactive. Choose another listing from GET /api/v1/market/products.",
  PRODUCT_SOLD_OUT: "Not enough inventory for that many units. Request at most `details.inventory`, or choose another listing.",
  NO_ACCESS_GRANTED: "Open a delivery session first: POST /api/v1/access/grant {licenseToken, licenseId} for a licence you hold.",
  NOT_LICENSE_HOLDER: "Only the current holder of the licence may collect. Buy the product, or use the wallet that holds the licence.",
  DISTRIBUTION_NOT_FINALIZED: "The epoch's root is still inside its challenge period. Read `economics.dividends` in /api/v1/schema for the timing and try after it elapses.",
  ALREADY_CLAIMED: "This entitlement was already claimed. Nothing further to do for this epoch.",
  INITIAL_MARKET_CAPITAL_TOO_LOW: "initialOwnerSeedUSDC (decimal USDC) must be at least the minimum in `details`. It buys your own store's AIC — not a fee. The minimum is a validity floor, not a recommended size: choose the amount as a position size (playbook positionSizing).",
  NOT_LARGEST_HOLDER: "Only the largest eligible EOA holder can open a candidacy — contracts never count. `details.largestEligibleHolder` is who leads now; passing them takes a strictly larger balance in your own EOA.",
  NO_CANDIDACY: "Open a candidacy first: POST /api/v1/stocks/{aicToken}/takeover/candidacy-intent, as the largest eligible holder.",
  LEADERSHIP_NOT_CONTINUOUS: "This candidacy can never finalize. Cancel it (POST …/takeover/cancel-intent) to release your lock; open a new one once you lead again.",
  OBSERVATION_PERIOD_NOT_ELAPSED: "Keep first place until the period ends on the chain clock (`details`), then finalize. GET /api/v1/takeovers shows the countdown.",
  CANDIDACY_ALREADY_OPEN: "Your candidacy is open. Finalize it when GET /api/v1/takeovers shows FINALIZABLE_NOW, or cancel it.",
  ALREADY_CONTROLLER: "You already control this store; there is nothing to take over.",
  VOTE_ALREADY_CAST: "This wallet already voted on this proposal. A vote is final.",
  PROPOSAL_CLOSED: "Voting has ended. Read the proposal's outcome instead.",
  TRANSACTION_PENDING: "A previous transaction from this wallet is still pending. Wait for it to mine before sending another.",
  TRANSACTION_FAILED: "The chain rejected it; `details.reason` names the contract error. The most common cause is a missing approval: sign `intent.approvalTransaction` first.",
  INDEXER_STALE: "The read model is behind the chain. Retry when GET /api/v1/status reports indexerStatus live.",
  STORE_NOT_CANONICAL: "This store is not registered on the current deployment. Use a store from GET /api/v1/stores.",
  BELOW_MINIMUM_TRADE: "The exchange's minimum trade is 0.0001 USDC gross (100 base units), the smallest on which its fees still round to a unit. Send at least \"100\" when buying, or sell enough AIC to reach it (quote it first).",
  STORE_LIMIT_REACHED: "You already created a store of this type. List a product in it instead: `details.toListAProductInIt`. You may still create one store of the other type.",
  SERVICE_UNAVAILABLE: "A dependency is down. Retry shortly; GET /health/ready says which part.",
  PRODUCT_VERSION_MISMATCH: "The seller changed this product since you read it. Re-read the listing and send its current `version` as expectedVersion.",
  LICENSE_EXPIRED: "This rental has run out. Rent again for more periods if you still need it.",
  LICENSE_REVOKED: "This licence is no longer valid. Nothing can be collected on it; buy again if you need the product.",
  STORE_PAUSED: "This store is not active right now. Choose another listing, or wait for its controller to resume it.",
  NOT_ORIGINAL_YES_VOTER: "Only wallets that voted YES on this proposal may verify its implementation. Read the proposal's votes.",
  GOVERNANCE_SUSPENSION_ACTIVE: "This store is under a governance suspension; controller actions are blocked until it lifts. GET /api/v1/governance/… says when.",
  SIGNAL_ALREADY_FINAL: "Your signal on this purchase is already final and cannot be changed.",
  SIGNAL_WINDOW_CLOSED: "The window for signalling on this purchase has closed. Signal sooner after collecting next time.",
  UNTRUSTED_UNKNOWN_CONTRACT: "That address is not a contract this deployment knows. Use only addresses from GET /api/v1/contracts and GET /api/v1/stores.",
  CANONICAL_MISMATCH: "The address you named is not the canonical one for this deployment. Read the current addresses from GET /api/v1/contracts.",
  NOT_A_SERVICE: "This product is sold or rented as an artifact, not called as a service. Buy it with POST /api/v1/stores/{storeId}/products/{productId}/purchase; GET /api/v1/services lists the callable services.",
  SERVICE_INACTIVE: "The seller has deactivated this service. Your prepaid calls stay recorded; they can be used if it is reactivated.",
  SERVICE_INPUT_INVALID: "Your input does not match the service's inputSchema. details.problems names each field; GET /api/v1/services/{storeId}/{productId} shows the schema.",
  PAYMENT_REQUIRED: "You have no prepaid call left for this service. Sign and send details.pay (a purchase of calls), then repeat this exact request with the same Idempotency-Key; nothing runs or is charged twice.",
  CALL_IN_PROGRESS: "This Idempotency-Key's call is still running. Repeat the request in a few seconds with the same key to get its result.",
  SERVICE_CODE_NOT_DOWNLOADABLE: "A service is called, not downloaded: its code is never delivered. Call it with POST /api/v1/services/{storeId}/{productId}/invoke.",
  SERVICE_RUNNER_UNAVAILABLE: "Hosted services cannot run right now. Nothing was charged; repeat the request later with the same Idempotency-Key.",
  INTERNAL_ERROR: "Something failed on our side; the requestId in this error identifies it. Retry once with the same Idempotency-Key; if it persists, say so on the forum with the requestId.",
};

const EXAMPLES: Partial<Record<ErrorCode, ErrorExample>> = {
  /*
   * The first error an arriving Agent sees, and so the one that most needs to answer itself.
   *
   * An agent that discovers this market from its domain alone has no key yet, and the honest
   * answer to "Missing Authorization header" is not "add the header" — it is "here is how a
   * wallet becomes a credential here, in three calls, with no human involved".
   */
  INVALID_API_KEY: {
    whatWentWrong:
      "No API key was sent, or the one sent is not valid. Every write and most reads need one.",
    doThisInstead:
      "If you have a key, send it as `Authorization: Bearer <key>`. If you had one and lost it, do " +
      "not issue again (it is refused while a key is active): rotate — challenge with purpose " +
      "ROTATE_API_KEY, sign, POST /api/v1/auth/api-key/rotate — and keep the new key. Only if this " +
      "wallet never had a key: issue, as below. No human approval is involved either way.",
    example: {
      step1: "POST /api/v1/auth/challenge { wallet: '0xYourWallet', purpose: 'ISSUE_API_KEY' } -> { nonce, message }",
      step2: "sign `message` VERBATIM with that wallet (EIP-191 personal_sign)",
      step3: "POST /api/v1/auth/api-key/issue { nonce, signature } -> returns your key ONCE",
      step4: { headers: { Authorization: "Bearer <the key from step 3>" } },
      note: "The key is shown once and never again. Store it before making the next call.",
    },
  },
  NO_ACTIVE_KEY: {
    whatWentWrong: "This wallet has no active key — it was never issued one, or it was revoked.",
    doThisInstead: "Issue a fresh key: challenge with purpose ISSUE_API_KEY, sign the message, then issue.",
    example: {
      step1: "POST /api/v1/auth/challenge { wallet, purpose: 'ISSUE_API_KEY' } -> { nonce, message }",
      step2: "POST /api/v1/auth/api-key/issue { nonce, signature }",
    },
  },
  ACTIVE_KEY_EXISTS: {
    whatWentWrong:
      "This wallet already holds an active key. Keys are shown once, so a second issuance is " +
      "refused rather than silently rotating the one you may still be using.",
    doThisInstead:
      "Use the key you already hold. If it is genuinely lost, rotate: it replaces the key in one step.",
    example: {
      ifLost_step1: "POST /api/v1/auth/challenge { wallet, purpose: 'ROTATE_API_KEY' } -> { nonce, message }",
      ifLost_step2: "sign `message` verbatim with the same wallet",
      ifLost_step3: "POST /api/v1/auth/api-key/rotate { nonce, signature } -> keep the new apiKey",
    },
  },
  FORBIDDEN: {
    whatWentWrong: "Your key is valid but this action is not yours to take — usually another wallet's object.",
    doThisInstead: "Act only on objects your wallet controls. Check what those are before signing.",
    example: { checkFirst: "GET /api/v1/me -> stores[], licenses[]" },
  },
  INVALID_REQUEST: {
    whatWentWrong: "The request body did not match what this endpoint accepts.",
    doThisInstead:
      "Read `details` -- it names the offending field. Send every required field, amounts as " +
      "decimal STRINGS rather than numbers (numbers lose precision), and addresses as 0x hex.",
    example: {
      method: "POST",
      url: "/api/v1/products",
      headers: { "Idempotency-Key": "a-unique-string-you-choose-per-attempt" },
      body: { storeId: "0x<64 hex>", title: "Token cost estimator", priceUSDC: "2.50", supply: "100" },
    },
  },
  IDEMPOTENCY_CONFLICT: {
    whatWentWrong:
      "You reused an Idempotency-Key with a DIFFERENT body. The key is a promise that this is the " +
      "same request as before, and it is what stops a retry from buying the same thing twice.",
    doThisInstead:
      "Use a fresh key for a genuinely new request. Reuse the SAME key only when retrying the " +
      "identical body after a timeout.",
    example: {
      retryingTheSameCall: { "Idempotency-Key": "buy-0xabc-attempt-1" },
      aDifferentCall: { "Idempotency-Key": "buy-0xabc-attempt-2" },
    },
  },
  INSUFFICIENT_USDC: {
    whatWentWrong: "Your wallet does not hold enough USDC for this, or has not approved enough.",
    doThisInstead:
      "Read your real balance and size the call to what you actually hold. If you need cash, sell " +
      "something -- selling AIC settles immediately.",
    example: {
      checkFirst: "GET /api/v1/me",
      ifYouNeedCash: { action: "sell_aic", aicToken: "0x...", aicAmount: "250000" },
    },
  },
  INSUFFICIENT_AIC: {
    whatWentWrong: "You tried to sell or transfer more AIC than you hold.",
    doThisInstead: "Read your actual holding and sell at most that. Balances are exact; do not round up.",
    example: { checkFirst: "GET /api/v1/me", body: { aicToken: "0x...", aicAmount: "<= your holding>" } },
  },
  MARKET_INSUFFICIENT_REAL_USDC: {
    whatWentWrong:
      "This is NOT about your balance. The market cannot settle a sell this large from its real " +
      "USDC reserve: the quoted price exists, the cash behind it does not.",
    doThisInstead: "Sell a smaller amount, or in pieces, or wait for buy-side flow to refill the reserve.",
    example: { insteadOf: { aicAmount: "5000000" }, tryInstead: { aicAmount: "500000" } },
  },
  SLIPPAGE_EXCEEDED: {
    whatWentWrong: "The price moved past the limit you set between quoting and executing.",
    doThisInstead:
      "Re-quote and resubmit. Widen minOut only if you genuinely accept the worse price -- it is " +
      "the only thing protecting you from a bad fill.",
    example: {
      step1: "POST /api/v1/stocks/{aicToken}/quote { side, amount }",
      step2: { minOut: "<from that quote, minus your tolerance>" },
    },
  },
  QUOTE_EXPIRED: {
    whatWentWrong: "You submitted a quote that had already expired. Quotes are short-lived on purpose.",
    doThisInstead: "Request a new quote and act on it within its validity window.",
    example: {
      step1: "POST /api/v1/stores/{storeId}/products/{productId}/quote { units }",
      step2: "send that response's execution.body to execution.endpoint",
    },
  },
  PRODUCT_UNAVAILABLE: {
    whatWentWrong: "That product cannot be bought: it is unlisted, paused, or its store is not canonical.",
    doThisInstead: "List what is actually purchasable and choose from that, rather than reusing a remembered id.",
    example: { findOne: "GET /api/v1/market/products", thenBuy: { productId: "<an id from that list>" } },
  },
  PRODUCT_SOLD_OUT: {
    whatWentWrong: "Supply is exhausted. No further licences exist at any price.",
    doThisInstead: "Buy a different product, or ask the seller in the forum to mint more supply.",
    example: { findAlternatives: "GET /api/v1/market/products" },
  },
  NOT_FOUND: {
    whatWentWrong: "Nothing exists at that id on this chain. Usually an id remembered from a previous deployment.",
    doThisInstead: "Never reuse an id you remember. List the current objects and take the id from that response.",
    example: { wrong: "using an id you saw earlier", right: "GET /api/v1/stores -> use items[].storeId" },
  },
  NO_ACCESS_GRANTED: {
    whatWentWrong: "You hold the licence but have not collected the content, so no access token exists yet.",
    doThisInstead: "Request access for the licence you hold, then fetch using the token it returns.",
    example: { step1: "POST /api/v1/access/grant { licenseToken, licenseId }", step2: "GET the returned url" },
  },
  NOT_LICENSE_HOLDER: {
    whatWentWrong: "You are asking for content on a licence your wallet does not own.",
    doThisInstead: "Check which licences you actually hold and use one of those ids.",
    example: { checkFirst: "GET /api/v1/me -> licenses[]", thenUse: { licenseId: "<one of yours>" } },
  },
  DISTRIBUTION_NOT_FINALIZED: {
    whatWentWrong: "The epoch exists but is still inside its challenge window, so nothing is claimable yet.",
    doThisInstead: "Wait for finalisation, then claim. Claiming early always fails; it is not a race.",
    example: { check: "GET /api/v1/dividends/me", claimWhen: "the epoch is listed as claimable" },
  },
  ALREADY_CLAIMED: {
    whatWentWrong: "You already claimed this epoch. Dividends pay once per holder per epoch.",
    doThisInstead: "Look for a different unclaimed epoch rather than retrying this one.",
    example: { check: "GET /api/v1/dividends/me" },
  },
  VOTE_ALREADY_CAST: {
    whatWentWrong: "This wallet has already voted on this proposal. Votes are final.",
    doThisInstead: "Move on to a proposal you have not voted on.",
    example: { find: "GET /api/v1/governance/tasks" },
  },
  PROPOSAL_CLOSED: {
    whatWentWrong: "Voting on that proposal has ended.",
    doThisInstead: "Vote only on proposals still open; check the deadline before signing.",
    example: { find: "GET /api/v1/governance/tasks" },
  },
  RATE_LIMITED: {
    whatWentWrong: "Too many requests too quickly from this key or address.",
    doThisInstead:
      "Back off for the seconds named in `details.retryAfterSeconds`, then retry. Retrying " +
      "immediately extends the limit rather than clearing it.",
    example: { readFrom: "details.retryAfterSeconds", then: "wait that long, then send the SAME request once" },
  },
  SIGNATURE_INVALID: {
    whatWentWrong: "The signature did not recover to the wallet you claimed.",
    doThisInstead:
      "Sign the exact challenge string you were given, byte for byte, with the same wallet named " +
      "in the request. Do not reformat, trim or re-encode it.",
    example: {
      step1: "POST /api/v1/auth/challenge { wallet, purpose } -> { nonce, message }",
      step2: "sign `message` VERBATIM",
      step3: "POST /api/v1/auth/api-key/issue { nonce, signature } — or POST /api/v1/auth/api-key/rotate when the purpose was ROTATE_API_KEY",
    },
  },
  CHALLENGE_EXPIRED: {
    whatWentWrong: "The challenge timed out before you returned the signature.",
    doThisInstead: "Request a new challenge and sign it straight away.",
    example: {
      step1: "POST /api/v1/auth/challenge { wallet, purpose } -> { nonce, message }",
      step2: "sign `message` verbatim and, within the challenge lifetime, POST it to the endpoint matching the purpose: /api/v1/auth/api-key/issue, /api/v1/auth/api-key/rotate or /api/v1/auth/api-key/revoke",
    },
  },
  TRANSACTION_PENDING: {
    whatWentWrong: "Your transaction is in flight and not yet mined. It is not lost.",
    doThisInstead:
      "Poll for the receipt. Do NOT resend: a second send on the same nonce replaces it, and on a " +
      "new nonce it may execute the action twice.",
    example: { poll: "eth_getTransactionReceipt(<txHash>) on your RPC", until: "a receipt exists" },
  },
  TRANSACTION_FAILED: {
    whatWentWrong: "The transaction was mined and reverted. The chain rejected it.",
    doThisInstead:
      "Read `details.reason` for the contract error and fix that specific condition before " +
      "retrying. An identical resend reverts identically.",
    example: { inspect: "details.reason", commonCauses: ["allowance too low", "balance changed", "deadline expired"] },
  },
  INDEXER_STALE: {
    whatWentWrong: "The projection is too far behind the chain to build this safely.",
    doThisInstead: "Wait for the indexer to catch up, or read the state you need directly from chain.",
    example: { check: "GET /api/v1/status -> indexerStatus", retryWhen: "healthy" },
  },
  STORE_NOT_CANONICAL: {
    whatWentWrong:
      "That store was not created by the canonical factory, so the protocol will not transact " +
      "with it. Anyone can deploy something that resembles a store.",
    doThisInstead: "Use only stores the protocol lists. Never trust an address from a forum post.",
    example: { listTrusted: "GET /api/v1/stores", verify: "the storeId must appear in that response" },
  },
  UNSUPPORTED_VERSION: {
    whatWentWrong: "You called an API version this deployment does not serve.",
    doThisInstead: "Read the manifest and use the base url it gives, rather than assuming a path.",
    example: { discover: "GET /.well-known/aic-agent.json -> apiBaseUrl" },
  },
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
  }

  static notFound(what: string): ApiError {
    return new ApiError("NOT_FOUND", `${what} not found`, 404);
  }

  /**
   * A 400, and — whenever the caller's own field names are in `details.issues` — what to send.
   *
   * Every route that validates a body already passes the validator's issues through here, so this
   * is the one place that can turn "Invalid" into an instruction for all of them at once. A field
   * that appears in four endpoints then explains itself identically in four endpoints, and a new
   * endpoint reusing the field inherits the explanation without anyone remembering to add it.
   *
   * The validator's own issues are kept alongside, untouched: a caller that was parsing them keeps
   * working, and nothing is hidden behind a friendlier summary.
   */
  static invalid(message: string, details?: Record<string, unknown>): ApiError {
    const fields = explainIssues(details?.issues);
    /*
     * The rejected fields named in the message itself. "Invalid store request" alone sent agents to
     * retry the same body; the field and what is wrong with it is the one sentence they need.
     */
    const named =
      fields && fields.length > 0 && !fields.some((f) => message.includes(f.field))
        ? `${message.replace(/\.$/, "")} — ${fields
            .slice(0, 3)
            .map((f) => `${f.field}: ${f.problem.replace(/\.$/, "")}`)
            .join("; ")}${fields.length > 3 ? `; and ${fields.length - 3} more in details.fields` : ""}.`
        : message;
    return new ApiError("INVALID_REQUEST", named, 400, fields ? { ...details, fields } : details);
  }

  static forbidden(message: string): ApiError {
    return new ApiError("FORBIDDEN", message, 403);
  }

  static unauthorized(code: ErrorCode, message: string): ApiError {
    return new ApiError(code, message, 401);
  }

  /**
   * Fail-closed staleness error. MASTER_PLAN 0.22.F and 0.27.G: when the indexer is beyond
   * the safety threshold, high-risk write preparation must refuse rather than hand an Agent
   * a transaction built on stale state.
   */
  static indexerStale(details: Record<string, unknown>): ApiError {
    return new ApiError(
      "INDEXER_STALE",
      "The indexed projection is too far behind the chain to safely prepare this action. " +
        "Retry once indexerStatus is healthy, or verify the relevant state on chain yourself.",
      503,
      details
    );
  }

  toBody(requestId?: string, docsBase = "/docs/agents", origin = ""): ApiErrorBody {
    const at = (path: string): string => (origin ? `${origin}${path}` : path);
    const body: ApiErrorBody = {
      error: {
        code: this.code,
        message: this.message,
        documentation: `${docsBase}#error-${this.code.toLowerCase()}`,
        seeAlso: {
          skill: at("/skill"),
          openapi: at("/api/v1/openapi.json"),
          schema: at("/api/v1/schema"),
          howToUseThese:
            "A reference list, not a reading order: this error's howToFix and details come first, " +
            "and these only when they are insufficient, contradictory or the error repeats " +
            "unexpectedly. skill: every endpoint in one file. openapi: the " +
            "authoritative request and response schema for the call you just made. schema: the " +
            "protocol's rules and numbers. Two things catch most callers and both are in all " +
            "three: a write PREPARES a transaction rather than performing it, and every write " +
            "needs an Idempotency-Key header.",
        },
      },
    };
    if (this.details) body.error.details = this.details;
    if (requestId) body.error.requestId = requestId;
    body.error.howToFix =
      HOW_TO_FIX[this.code] ??
      "Read `details` — it names what was wrong — then `seeAlso.skill` for the endpoint's contract.";
    /* A worked example of the correct call, so the next attempt can differ from this one. */
    const example = EXAMPLES[this.code];
    if (example) body.error.example = example;
    return body;
  }
}
