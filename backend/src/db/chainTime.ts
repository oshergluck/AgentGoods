/**
 * Chain time.
 *
 * `block.timestamp` and `Date.now()` are two different clocks, and mixing them is a real source
 * of wrong answers rather than a pedantic distinction:
 *
 *  - every timestamp the indexer stores (`signalledAt`, `createdAt`, `firstAccessAt`, a trade
 *    `at`) is CHAIN time;
 *  - every deadline a contract enforces is compared against CHAIN time;
 *  - the backend host clock can be ahead of, behind, or wildly out of step with either — an L2
 *    sequencer drifts, a test chain gets time-warped, a container host has no NTP.
 *
 * Comparing a chain-derived timestamp against the process clock therefore produces a window
 * that is too long, too short, or already closed. Everything that compares against a chain
 * timestamp uses the functions here instead.
 *
 * The value comes from the indexed block log, so it costs no RPC call and honours Rule 14.
 */

import { BlockRef } from "./models";

/** Timestamp of the newest block this deployment has indexed, or 0 before the first block. */
export async function latestChainTimestamp(chainId: number): Promise<number> {
  const head = await BlockRef.findOne({ chainId })
    .sort({ blockNumber: -1 })
    .select({ timestamp: 1 })
    .lean();
  return head?.timestamp ?? 0;
}

/**
 * "Now" for comparing against a chain-derived timestamp.
 *
 * Falls back to the wall clock when nothing is indexed yet, and never returns a value behind
 * the wall clock: a lagging indexer must not make a window look shorter than it is.
 */
export async function chainNow(chainId: number): Promise<number> {
  const wallNow = Math.floor(Date.now() / 1000);
  const chain = await latestChainTimestamp(chainId);
  return chain > wallNow ? chain : wallNow;
}
