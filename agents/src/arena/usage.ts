/**
 * A durable record of what inference has cost, across every run.
 *
 * Per-run token counts live in that run's state file, because a score is a per-run measurement.
 * This is the other thing worth knowing: what the whole exercise has spent on one API key, in
 * total, across every restart and every test.
 *
 * Two reasons it is separate from the run state:
 *
 * **A run can be discarded; the bill cannot.** Four hours were restarted eight times while the
 * agents' instructions were corrected. Each restart resumed the same run so the token counts
 * accumulated, but a fresh run would have reset them to zero — and the money would still have
 * been spent. An accounting record that resets when you start over is not an accounting record.
 *
 * **One key has limits.** Twenty agents on a single API key share that key's rate and spend
 * limits, so knowing the running total is what makes it possible to say "this is what a 4-hour,
 * 20-agent run costs" before starting another.
 *
 * Written append-only and atomically, so a crash mid-run costs at most the last write.
 */

import fs from "node:fs";
import path from "node:path";
import { ARENA_DIR, MODEL_PRICES } from "./ledger";

const FILE = path.join(ARENA_DIR, "token-usage.json");

interface ModelUsage {
  input: number;
  output: number;
  calls: number;
  costUSD: number;
}

export interface UsageLedger {
  firstRecordedAt: string;
  lastUpdatedAt: string;
  totals: { input: number; output: number; calls: number; costUSD: number };
  byModel: Record<string, ModelUsage>;
  byRun: Record<string, { input: number; output: number; calls: number; costUSD: number }>;
}

function empty(): UsageLedger {
  const now = new Date().toISOString();
  return {
    firstRecordedAt: now,
    lastUpdatedAt: now,
    totals: { input: 0, output: 0, calls: 0, costUSD: 0 },
    byModel: {},
    byRun: {},
  };
}

export function loadUsage(): UsageLedger {
  try {
    if (!fs.existsSync(FILE)) return empty();
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as UsageLedger;
  } catch {
    // A corrupt ledger must not stop a run; it is a record, not a dependency.
    return empty();
  }
}

/**
 * Record one completion.
 *
 * Called on every decision, including ones whose action later failed — the tokens were spent
 * either way, and an accounting that only counts successes understates the bill.
 */
export function recordUsage(
  runId: string,
  model: string,
  input: number,
  output: number,
  cachedInput = 0
): void {
  if (input <= 0 && output <= 0) return;

  const ledger = loadUsage();
  const price: { input: number; output: number; cachedInput?: number } = MODEL_PRICES[model] ?? { input: 0.4, output: 1.6 };
  const cached = Math.min(cachedInput, input);
  const cost = ((input - cached) * price.input + cached * (price.cachedInput ?? price.input) + output * price.output) / 1_000_000;

  ledger.totals.input += input;
  ledger.totals.output += output;
  ledger.totals.calls += 1;
  ledger.totals.costUSD = Number((ledger.totals.costUSD + cost).toFixed(6));

  const perModel = ledger.byModel[model] ?? { input: 0, output: 0, calls: 0, costUSD: 0 };
  perModel.input += input;
  perModel.output += output;
  perModel.calls += 1;
  perModel.costUSD = Number((perModel.costUSD + cost).toFixed(6));
  ledger.byModel[model] = perModel;

  const perRun = ledger.byRun[runId] ?? { input: 0, output: 0, calls: 0, costUSD: 0 };
  perRun.input += input;
  perRun.output += output;
  perRun.calls += 1;
  perRun.costUSD = Number((perRun.costUSD + cost).toFixed(6));
  ledger.byRun[runId] = perRun;

  ledger.lastUpdatedAt = new Date().toISOString();

  fs.mkdirSync(ARENA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, FILE);
}

/** A one-line summary for the run log, so the bill is visible while it is being incurred. */
export function usageSummary(): string {
  const ledger = loadUsage();
  const t = ledger.totals;
  return (
    `inference to date: ${t.calls.toLocaleString()} calls, ` +
    `${(t.input + t.output).toLocaleString()} tokens, $${t.costUSD.toFixed(2)} ` +
    `(since ${ledger.firstRecordedAt.slice(0, 16)}Z, across ${Object.keys(ledger.byRun).length} run(s))`
  );
}
