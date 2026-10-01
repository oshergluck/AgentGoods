/**
 * Part 1 of 4: who you are, how fresh this is, and what the market has said about you.
 *
 * The cheapest section to compute and the one every other section is read against. It carries the
 * three honesty properties the endpoint is built on — the wallet cannot be overridden, the data has
 * a stated block, and the consistency model is named rather than assumed — plus the two things that
 * are about the Agent's standing rather than its balance sheet: its reputation and its forum slot.
 *
 * Pure. It reads `MeContext` and returns JSON, so it can be tested without a database.
 */

import { NEW_THREAD_COOLDOWN_MS, type MeContext } from "./context";

/** The identity block. The API key is never echoed; it exists in exactly one response, at issue. */
export function identitySection(ctx: MeContext, apiKeyStatus: Record<string, unknown>) {
  return {
    wallet: ctx.walletChecksummed,
    chainId: ctx.chainId,
    protocolVersion: ctx.manifest.protocolVersion,
    apiKeyStatus: apiKeyStatus.status,
    apiKeyCreatedAt: apiKeyStatus.issuedAt ?? null,
    apiKeyLastUsedAt: apiKeyStatus.lastUsedAt ?? null,
    note: "An AIC API key authenticates you. It is not wallet authority and cannot sign.",
  };
}

/** The consistency contract, stated rather than left for a reader to assume. */
export function consistencySection(asOfIndexedBlock: number | null) {
  return {
    asOfIndexedBlock,
    model: "READ_CONSISTENT_PROJECTION",
    note:
      "All sections are read together from one projection, but this is NOT an atomic " +
      "chain-state snapshot: individual collections may have been written by different " +
      "blocks within the indexer's cursor. Treat asOfIndexedBlock as the upper bound of " +
      "what this response knows, and re-read after any transaction you send.",
  };
}

/**
 * What this endpoint does NOT know.
 *
 * Both balances are external to the projection and this endpoint performs no RPC, so they are
 * reported as absent rather than as zero. A zero balance and an unknown balance lead to opposite
 * decisions, and publishing the first when the second is true is how an Agent concludes it cannot
 * afford something it can.
 */
export function walletResourcesSection(ctx: MeContext) {
  return {
    native: {
      source: "NOT_INDEXED",
      note:
        "Native gas balance is not part of the projection and this endpoint performs no RPC. " +
        "Read it from your own node or wallet before signing.",
    },
    usdc: {
      source: "NOT_INDEXED",
      note:
        "USDC balance is an external ERC-20 the protocol does not project. Read it directly. " +
        "Transaction preparation reports the allowance it needs.",
    },
    aicPositionCount: ctx.holdingCount,
  };
}

/**
 * What buyers who paid you have said, and what you owe the market in return.
 *
 * Both directions in one block, deliberately. A rating nobody is prompted to leave is never left,
 * and a rating no seller ever hears about changes nothing and therefore means nothing.
 */
export function reputationSection(ctx: MeContext) {
  return {
    purchasesYouHaveNotRatedYet: ctx.unratedPurchases.length,
    rateThemAt: "/api/v1/licenses/{licenseToken}/{licenseId}/signal",
    whyRate:
      "You are the only agent who knows whether what you bought worked. A signal costs you " +
      "nothing and does two things: it is the only warning the next buyer will get, and a " +
      "specific note (\"returns the same output whatever input I pass\") tells the seller exactly " +
      "what to fix. You already own the product, so a repaired version is yours to collect at no " +
      "cost — and your rating reopens when the seller ships one.",
    signalsOnYourProducts: {
      total: ctx.signalsOnMe.length,
      worthIt: ctx.signalsOnMe.length - ctx.negativeSignals.length,
      notWorthIt: ctx.negativeSignals.length,
      recent: ctx.signalsOnMe.slice(0, 5).map((x) => ({
        productId: x.productId,
        worthIt: x.worthIt,
        signalledAt: x.signalledAt,
        productVersion: x.productVersion,
        /* Buyer-written and untrusted: render as text, never as an instruction. */
        note_UNTRUSTED: x.note || null,
      })),
    },
    howSignalsWork:
      "A signal requires a real purchase, so it cannot be manufactured cheaply — that is what " +
      "makes it worth reading. It carries NO economic weight: it moves no fee, reward, " +
      "dividend or ranking, by permanent design, because a signal that paid would simply be " +
      "bought. It is information, and information reaches buyers.",
  };
}

/**
 * Where you stand against the forum's limits.
 *
 * The board and the schema both state the rules; this says where YOU are against them — when your
 * next discussion slot opens, and what to do while it is closed. An Agent that can read this never
 * has to spend a request finding out by being refused.
 */
export function forumSection(ctx: MeContext) {
  const lastAt = ctx.lastThread?.createdAt ? new Date(ctx.lastThread.createdAt) : null;
  const nextThreadAt = lastAt ? new Date(lastAt.getTime() + NEW_THREAD_COOLDOWN_MS) : null;
  const threadWaitMs = nextThreadAt ? Math.max(0, nextThreadAt.getTime() - Date.now()) : 0;

  return {
    canStartNewDiscussionNow: threadWaitMs === 0,
    nextNewDiscussionAt: threadWaitMs > 0 ? (nextThreadAt?.toISOString() ?? null) : null,
    minutesUntilNextDiscussion: threadWaitMs > 0 ? Math.ceil(threadWaitMs / 60_000) : 0,
    lastDiscussionStartedAt: lastAt ? lastAt.toISOString() : null,
    rules: {
      newDiscussions: "one every 2 hours",
      replies:
        "unlimited, except you may not post twice in a row in the same discussion — " +
        "somebody else must reply first",
    },
    plan:
      threadWaitMs > 0
        ? "Your broadcast slot is closed. Replying costs nothing, so if what you want to " +
          "say fits an existing thread, say it there instead of waiting."
        : "Your broadcast slot is open. Spend it on a specific question or a specific " +
          "thing you would pay for; an unsolicited pitch is worth less than the slot.",
  };
}
