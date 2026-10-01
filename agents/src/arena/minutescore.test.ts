/**
 * Per-minute measurement, kept as history: each agent's net P&L is sampled every minute (last and
 * highest, from the moment the rule took effect, never retroactively). The SCORE is not the highest
 * minute: it is the net P&L at the end of the run, so rankScoreBase follows the valuation it is given.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { rankScoreBase, recordMinuteSamples } from "./score";
import { ARENA_DIR, loadRun, saveRun, type RunState, type Snapshot } from "./ledger";

const snap = (agentId: string, pnlUSDC: number): Snapshot =>
  ({ agentId, pnlBase: String(Math.round(pnlUSDC * 1e6)) }) as unknown as Snapshot;
const fresh = (fromMin = 0, nowMin = 0) =>
  ({ elapsedMs: nowMin * 60_000, minuteScoring: { fromElapsedMs: fromMin * 60_000, samples: {} } }) as unknown as RunState;
const best = (s: RunState, id = "a") => {
  const b = s.minuteScoring?.samples[id]?.bestPnlBase;
  return b === undefined ? 0 : Number(b) / 1e6;
};

/** Feed one measurement per minute, minute 1, 2, 3 … */
function feed(state: RunState, values: number[], id = "a", startMinute = 1) {
  const after: number[] = [];
  values.forEach((v, i) => {
    state.elapsedMs = (startMinute + i) * 60_000;
    recordMinuteSamples(state, [snap(id, v)]);
    after.push(best(state, id));
  });
  return after;
}

test("all-negative minutes: the best never deteriorates", () => {
  const state = fresh();
  const after = feed(state, [-100.5, -102, -99.2, -101, -98.7, -100]);
  assert.deepEqual(after, [-100.5, -100.5, -99.2, -99.2, -98.7, -98.7]);
  const s = state.minuteScoring!.samples.a!;
  assert.equal(s.bestAtMinute, 5, "minute 5 set the best");
  assert.equal(Number(s.lastPnlBase) / 1e6, -100, "the last minute is kept apart");
  assert.equal(s.lastAtMinute, 6);
});

test("mixed signs: final best is the highest minute", () => {
  const state = fresh();
  const after = feed(state, [-10, 4, 2, 9, -20]);
  assert.equal(after.at(-1), 9);
  assert.equal(state.minuteScoring!.samples.a!.bestAtMinute, 4);
});

test("best and its minute survive a save and a restart exactly; worse minutes do not move it, better ones do", () => {
  const runId = `minscore-${crypto.randomUUID()}`;
  const file = path.join(ARENA_DIR, `${runId}.json`);
  try {
    const state = { runId, agents: [], actions: [], snapshots: [], elapsedMs: 0, minuteScoring: { fromElapsedMs: 0, samples: {} } } as unknown as RunState;
    feed(state, [-50, -20, -35]); // best -20 at minute 2
    saveRun(state);

    const resumed = loadRun(runId)!; // the same load the coordinator performs on resume
    assert.equal(best(resumed), -20);
    assert.equal(resumed.minuteScoring!.samples.a!.bestAtMinute, 2);

    feed(resumed, [-40], "a", 4); // a worse minute
    assert.equal(best(resumed), -20, "a worse minute does not change the best");
    assert.equal(resumed.minuteScoring!.samples.a!.bestAtMinute, 2);

    feed(resumed, [-5], "a", 5); // a better minute
    assert.equal(best(resumed), -5);
    assert.equal(resumed.minuteScoring!.samples.a!.bestAtMinute, 5);
  } finally {
    for (const f of [file, `${file}.tmp`]) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
  }
});

test("minutes before the rule took effect are not counted", () => {
  const state = fresh(145, 100);
  recordMinuteSamples(state, [snap("a", 900)]);
  assert.equal(state.minuteScoring!.samples.a, undefined);
  state.elapsedMs = 146 * 60_000;
  recordMinuteSamples(state, [snap("a", 40)]);
  assert.equal(best(state), 40);
});

test("before any sample, the ranking falls back to the P&L now", () => {
  assert.equal(rankScoreBase(fresh(), "x", "7000000"), 7_000_000n);
});

test("the score is the final net P&L, not the best minute: a peak given back counts for nothing", () => {
  const state = fresh();
  feed(state, [50, 120, 10]); // peaked at 120, finished at 10
  assert.equal(best(state), 120, "the peak is kept as history");
  assert.equal(Number(rankScoreBase(state, "a", String(10 * 1e6))) / 1e6, 10, "ranked on the final valuation");
});

test("a best_minute run ranks on the peak; a final run on the end", () => {
  const peak = fresh();
  (peak as any).scoringMode = "best_minute";
  feed(peak, [50, 120, 10]);
  assert.equal(Number(rankScoreBase(peak, "a", String(10 * 1e6))) / 1e6, 120, "best minute: the peak counts");
  const end = fresh();
  (end as any).scoringMode = "final";
  feed(end, [50, 120, 10]);
  assert.equal(Number(rankScoreBase(end, "a", String(10 * 1e6))) / 1e6, 10, "final: the end counts");
});

test("a blend run ranks on 40% of the peak plus 60% of the end", () => {
  const s = fresh();
  (s as any).scoringMode = "blend";
  feed(s, [50, 120, 10]); // peak 120, end 10 -> 0.4*120 + 0.6*10 = 54
  assert.equal(Number(rankScoreBase(s, "a", String(10 * 1e6))) / 1e6, 54);
});

test("best_minute_qualified: the peak ranks, but only with the debt repaid and a final P&L above zero", async () => {
  const { qualifies } = await import("./scoring");
  const s = fresh();
  (s as any).scoringMode = "best_minute_qualified";
  feed(s, [50, 120, 10]);
  assert.equal(Number(rankScoreBase(s, "a", String(10 * 1e6))) / 1e6, 120, "the peak is the score");
  assert.equal(qualifies("best_minute_qualified", true, 10_000_000n, 120_000_000n), true, "repaid and above zero");
  assert.equal(qualifies("best_minute_qualified", true, 0n, 120_000_000n), false, "final P&L at zero fails");
  assert.equal(qualifies("best_minute_qualified", false, 10_000_000n, 120_000_000n), false, "unpaid debt fails");
});
