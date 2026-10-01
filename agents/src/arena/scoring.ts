/**
 * How a run is scored, chosen once per run.
 *
 *  - "final": net P&L in the valuation taken when the clock stops. A peak given back counts for nothing.
 *  - "best_minute": the highest net P&L measured at any running minute. A peak, once measured, is kept.
 *  - "blend": 40% of the best minute plus 60% of the final result — a peak counts, but what you still
 *    hold at the end counts more.
 *  - "economy": NOT A SCORE (Arena 4). Agents are told no formula, see no rank and no clock, and have no
 *    repayment schedule. The run ends in a terminal freeze and is evaluated privately on economic
 *    equity with batch settlement (settlement.ts) and a research report (economyReport.ts).
 *
 * Set by ARENA_SCORING when a run is created and recorded in its ledger, so a resume can never switch
 * a run's rule half-way: the ledger's mode wins over the environment for a run already under way.
 */
export type ScoringMode = "final" | "best_minute" | "blend" | "best_minute_qualified" | "economy";

export const BLEND_BEST_WEIGHT = 40n;
export const BLEND_FINAL_WEIGHT = 60n;

const env = process.env.ARENA_SCORING;
export const ENV_SCORING: ScoringMode =
  env === "best_minute" ? "best_minute" : env === "blend" ? "blend" : env === "best_minute_qualified" ? "best_minute_qualified" : env === "economy" ? "economy" : "final";

/** Arena 4: no score, no rank, no clock, no repayment schedule. */
export function isEconomy(state: { scoringMode?: ScoringMode } | null | undefined): boolean {
  return scoringModeOf(state) === "economy";
}

/**
 * "best_minute_qualified": ranked by the best minute, but the result counts only for an agent that, when
 * the clock stops, has repaid its whole debt and has a final net P&L above zero. Anyone else has failed,
 * whatever its peak, and ranks below every agent that qualified.
 */
export function qualifies(mode: ScoringMode, debtCleared: boolean, finalPnlBase: bigint, score: bigint): boolean {
  if (mode === "best_minute_qualified") return debtCleared && finalPnlBase > 0n;
  if (mode === "economy") return true;
  return score >= 0n;
}

export function scoringModeOf(state: { scoringMode?: ScoringMode } | null | undefined): ScoringMode {
  return state?.scoringMode ?? ENV_SCORING;
}

/** The score from the two measurements: `best` is the highest measured minute, `now` the valuation at hand. */
export function combineScore(mode: ScoringMode, best: bigint | null, now: bigint): bigint {
  if (mode === "final" || mode === "economy" || best === null) return now;
  if (mode === "best_minute" || mode === "best_minute_qualified") return best;
  return (best * BLEND_BEST_WEIGHT + now * BLEND_FINAL_WEIGHT) / 100n;
}

/** One short phrase per mode, for every place that states what the ranking is on. */
export const RANKED_ON: Record<ScoringMode, string> = {
  final: "net P&L NOW — the final result is this figure at the END of the run, not the best minute",
  best_minute: "SCORE = the BEST net P&L you reached at any measured minute so far — not your P&L at the end",
  best_minute_qualified:
    "SCORE = the BEST net P&L you reached at any measured minute — but it COUNTS ONLY IF, when the clock stops, " +
    "you have repaid your whole debt AND your final net P&L is above zero. Otherwise you have failed, whatever your peak.",
  blend:
    "SCORE = 40% of your BEST measured minute + 60% of your net P&L NOW (at the end: the final valuation). " +
    "A peak counts; what you still hold at the end counts more.",
  // Never shown to an agent: economy runs have no ranking.
  economy: "no score: evaluated privately on economic equity after the terminal freeze",
};
