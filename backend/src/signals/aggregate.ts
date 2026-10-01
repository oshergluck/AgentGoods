/**
 * Phase 10.1 — buyer signal aggregation.
 *
 * MASTER_PLAN 14A.3 rules, all enforced here rather than at the route:
 *
 *   - a signal CHANGE replaces the previous verdict and never counts twice (the projection
 *     stores one row per license, so this is structural);
 *   - self signals are excluded from every rate and from coverage, and remain visible in the
 *     raw counts;
 *   - below MIN_SIGNALS, `positiveRate` is `null` with `insufficientSignals: true`; the raw
 *     counts are still returned, so nothing is hidden, only the unearned precision;
 *   - COVERAGE IS NOT GATED. Coverage answers "how much of what this seller delivered was
 *     ever signalled at all", and the low-sample case is precisely the case a buyer needs to
 *     see: a seller with 0 signals across 80 deliveries is the finding, not a missing value.
 *     Absence of signals is itself information, so coverage is exposed whenever anything was
 *     delivered. [MASTER_PLAN 14A.3]
 *   - a scope with zero signals returns zeros, not an error.
 *
 * MASTER_PLAN 14A.2 / docs/DECISIONS D-011: nothing computed in this file is ever used for a
 * payout, a fee, a reward, an entitlement or an ordering. It is read by Agents, not spent by
 * the protocol.
 */

import { BuyerSignalDoc, License, Store } from "../db/models";

export interface SignalRates {
  delivered: number;
  signalled: number;
  positive: number;
  negative: number;
  coverage: string | null;
  positiveRate: string | null;
}

export interface SignalSummary extends SignalRates {
  scope: "seller" | "store" | "product";
  id: string;
  insufficientSignals: boolean;
  minSignals: number;
  raw: {
    signalled: number;
    positive: number;
    negative: number;
    selfSignalCount: number;
  };
  rolling30d: SignalRates;
  /** Deliberate, machine-readable statement of the zero-weight rule. [14A.2] */
  economicWeight: "none";
  disclaimer: string;
}

export const DISCLAIMER =
  "Buyer signals are memory, not arbitration. They carry zero weight in dividends, rewards, " +
  "pricing, ranking or any economic distribution, and they are never used to order results.";

const ROLLING_WINDOW_SECONDS = 30 * 24 * 3600;

interface ScopeFilter {
  chainId: number;
  storeIds?: string[];
  storeId?: string;
  productId?: string;
  sellerWallet?: string;
}

/** Formats a ratio as an exact 4-decimal string. No floating point reaches the API. */
function ratio(numerator: number, denominator: number): string | null {
  if (denominator <= 0) return null;
  const scaled = (BigInt(numerator) * 10_000n) / BigInt(denominator);
  const whole = scaled / 10_000n;
  const frac = (scaled % 10_000n).toString().padStart(4, "0");
  return `${whole}.${frac}`;
}

async function computeRates(
  filter: ScopeFilter,
  minSignals: number,
  sinceTimestamp: number | null
): Promise<SignalRates & { raw: SignalSummary["raw"]; insufficient: boolean }> {
  const signalQuery: Record<string, unknown> = { chainId: filter.chainId };
  const licenseQuery: Record<string, unknown> = { chainId: filter.chainId, delivered: true };

  if (filter.storeId) {
    signalQuery.storeId = filter.storeId;
    licenseQuery.storeId = filter.storeId;
  }
  if (filter.storeIds) {
    signalQuery.storeId = { $in: filter.storeIds };
    licenseQuery.storeId = { $in: filter.storeIds };
  }
  if (filter.productId) {
    signalQuery.productId = filter.productId;
    licenseQuery.productId = filter.productId;
  }
  if (sinceTimestamp !== null) {
    signalQuery.signalledAt = { $gte: sinceTimestamp };
    licenseQuery.firstAccessAt = { $gte: sinceTimestamp };
  }

  const [allSignals, delivered] = await Promise.all([
    BuyerSignalDoc.find(signalQuery).select({ worthIt: 1, selfSignal: 1 }).lean(),
    License.countDocuments(licenseQuery),
  ]);

  const counted = allSignals.filter((s) => !s.selfSignal);
  const signalled = counted.length;
  const positive = counted.filter((s) => s.worthIt).length;
  const negative = signalled - positive;

  const raw = {
    signalled: allSignals.length,
    positive: allSignals.filter((s) => s.worthIt).length,
    negative: allSignals.filter((s) => !s.worthIt).length,
    selfSignalCount: allSignals.filter((s) => s.selfSignal).length,
  };

  const insufficient = signalled < minSignals;

  return {
    delivered,
    signalled,
    positive,
    negative,
    // Always exposed: low coverage is the informative case, not a missing measurement.
    coverage: ratio(signalled, delivered),
    // Below the threshold a rate would be noise presented as a measurement, so it is null.
    positiveRate: insufficient ? null : ratio(positive, signalled),
    raw,
    insufficient,
  };
}

export interface SummaryOptions {
  chainId: number;
  minSignals: number;
  now?: number;
}

export async function productSummary(
  productId: string,
  storeId: string,
  options: SummaryOptions
): Promise<SignalSummary> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const base = { chainId: options.chainId, storeId, productId };
  const lifetime = await computeRates(base, options.minSignals, null);
  const rolling = await computeRates(base, options.minSignals, now - ROLLING_WINDOW_SECONDS);
  return assemble("product", productId, lifetime, rolling, options.minSignals);
}

export async function storeSummary(storeId: string, options: SummaryOptions): Promise<SignalSummary> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const base = { chainId: options.chainId, storeId };
  const lifetime = await computeRates(base, options.minSignals, null);
  const rolling = await computeRates(base, options.minSignals, now - ROLLING_WINDOW_SECONDS);
  return assemble("store", storeId, lifetime, rolling, options.minSignals);
}

/**
 * Seller scope: every store currently controlled by that wallet.
 *
 * Attribution follows the CURRENT controller, because that is the party an Agent is about to
 * transact with. A takeover therefore moves the record with the store, which is the honest
 * reading of "this seller delivered value" for a buyer deciding right now.
 */
export async function sellerSummary(wallet: string, options: SummaryOptions): Promise<SignalSummary> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const stores = await Store.find({
    chainId: options.chainId,
    storeController: wallet.toLowerCase(),
  })
    .select({ storeId: 1 })
    .lean();
  const storeIds = stores.map((s) => s.storeId);

  if (storeIds.length === 0) {
    const empty = {
      delivered: 0,
      signalled: 0,
      positive: 0,
      negative: 0,
      coverage: null,
      positiveRate: null,
      raw: { signalled: 0, positive: 0, negative: 0, selfSignalCount: 0 },
      insufficient: true,
    };
    return assemble("seller", wallet.toLowerCase(), empty, empty, options.minSignals);
  }

  const base = { chainId: options.chainId, storeIds };
  const lifetime = await computeRates(base, options.minSignals, null);
  const rolling = await computeRates(base, options.minSignals, now - ROLLING_WINDOW_SECONDS);
  return assemble("seller", wallet.toLowerCase(), lifetime, rolling, options.minSignals);
}

function assemble(
  scope: SignalSummary["scope"],
  id: string,
  lifetime: Awaited<ReturnType<typeof computeRates>>,
  rolling: Awaited<ReturnType<typeof computeRates>>,
  minSignals: number
): SignalSummary {
  return {
    scope,
    id,
    delivered: lifetime.delivered,
    signalled: lifetime.signalled,
    positive: lifetime.positive,
    negative: lifetime.negative,
    coverage: lifetime.coverage,
    positiveRate: lifetime.positiveRate,
    insufficientSignals: lifetime.insufficient,
    minSignals,
    raw: lifetime.raw,
    rolling30d: {
      delivered: rolling.delivered,
      signalled: rolling.signalled,
      positive: rolling.positive,
      negative: rolling.negative,
      coverage: rolling.coverage,
      positiveRate: rolling.positiveRate,
    },
    economicWeight: "none",
    disclaimer: DISCLAIMER,
  };
}

/**
 * Batched seller summaries, so a product list can embed each seller record without an N+1
 * fan-out. [MASTER_PLAN 14A.4 "in a single call"]
 */
export async function sellerSummaries(
  wallets: string[],
  options: SummaryOptions
): Promise<Map<string, SignalSummary>> {
  const unique = [...new Set(wallets.map((w) => w.toLowerCase()))];
  const out = new Map<string, SignalSummary>();
  for (const wallet of unique) {
    out.set(wallet, await sellerSummary(wallet, options));
  }
  return out;
}
