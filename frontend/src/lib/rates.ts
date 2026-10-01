/**
 * Basis points as a percentage, for display.
 *
 * Exists because the holders' share was written into the UI as the literal string "5%" in three
 * places. That was true of every deployment until mainnet launched at 20%, and then the site
 * quietly understated by a factor of four the one number that makes owning AIC worth anything.
 *
 * A rate that is rendered from data cannot drift from the protocol. A rate that is typed into a
 * paragraph always eventually does.
 */
export function bpsToPercent(bps: unknown, fallback = "—"): string {
  const n = Number(bps);
  if (!Number.isFinite(n)) return fallback;
  // 2000 -> "20%", 475 -> "4.75%": trailing zeros are noise on a round number.
  const pct = n / 100;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(2))}%`;
}

/**
 * The share of store net commerce that buys the store's own AIC back and burns it, in bps.
 *
 * Read from `/api/v1/status` -> `rates`. Accepts the buyback name and the older holder-reserve
 * name, since the rate is the same number under either.
 */
export function buybackBps(rates: unknown): number | undefined {
  const r = (rates ?? {}) as Record<string, unknown>;
  const v = r.holderBuybackBps ?? r.buybackBps ?? r.holderReserveBps;
  return typeof v === "number" ? v : undefined;
}
