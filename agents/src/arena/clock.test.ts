/**
 * The run clock must not compound when it is persisted.
 *
 * This reproduces the defect that disqualified eleven agents thirteen minutes into a four-hour
 * run: `elapsedNow()` read the same field the supervisor periodically wrote `elapsedNow()` into,
 * with nothing resetting the segment start, so each save folded the current segment into the base
 * and the next call added it again.
 *
 * The test models both shapes directly rather than importing the arena, because the bug lived in
 * how two lines related to each other and not in any function worth exporting.
 */

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.log("FAIL:", m); fails++; } };

interface Clock { elapsedMs: number }

/** How it was written: the base is re-read from the field that gets written back. */
function buggy(state: Clock, now: () => number) {
  const segmentStartedAt = now();
  return {
    elapsedNow: () => state.elapsedMs + (now() - segmentStartedAt),
  };
}

/** How it is written now: the base is captured once, as a value. */
function fixed(state: Clock, now: () => number) {
  const segmentStartedAt = now();
  const baseElapsedMs = state.elapsedMs;
  return {
    elapsedNow: () => baseElapsedMs + (now() - segmentStartedAt),
  };
}

// Twelve minutes of wall time, persisted every two minutes exactly as the supervisor does.
function simulate(make: typeof fixed): number {
  let t = 1_000_000;
  const state: Clock = { elapsedMs: 0 };
  const clock = make(state, () => t);
  for (let tick = 0; tick < 6; tick++) {
    t += 120_000;
    state.elapsedMs = clock.elapsedNow();  // the persist that caused the bug
  }
  return clock.elapsedNow();
}

const TWELVE_MIN = 12 * 60_000;

const bug = simulate(buggy);
ok(bug > TWELVE_MIN * 2, `the buggy clock should run away, reported ${(bug / 60_000).toFixed(1)}min`);
console.log(`old behaviour: after 12 real minutes the clock read ${(bug / 60_000).toFixed(1)} minutes`);

const good = simulate(fixed);
ok(good === TWELVE_MIN, `clock should read exactly 12min, read ${(good / 60_000).toFixed(3)}min`);
console.log(`new behaviour: after 12 real minutes the clock reads ${(good / 60_000).toFixed(1)} minutes`);

// A resume must continue from the stored base, not restart and not double-count it.
{
  let t = 5_000_000;
  const state: Clock = { elapsedMs: 30 * 60_000 };   // 30 minutes already run
  const clock = fixed(state, () => t);
  ok(clock.elapsedNow() === 30 * 60_000, "a resume did not continue from the stored elapsed time");
  t += 10 * 60_000;
  ok(clock.elapsedNow() === 40 * 60_000, `after 10 more minutes should be 40, got ${clock.elapsedNow() / 60_000}`);
  state.elapsedMs = clock.elapsedNow();
  t += 5 * 60_000;
  ok(clock.elapsedNow() === 45 * 60_000, `persisting mid-run corrupted the clock: ${clock.elapsedNow() / 60_000}`);
}

console.log(fails === 0 ? "\nCLOCK TESTS PASSED" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
