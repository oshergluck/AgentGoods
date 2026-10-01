/**
 * The memory is the one prompt section paid for on every turn of the whole run, so its rules are
 * worth asserting rather than assuming: near-duplicates must not consume slots, a repeatedly
 * relearned lesson must outlive a one-off observation, and the character budget must actually bind.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { remember, MEMORY_LIMIT, MEMORY_CHAR_BUDGET, ARENA_DIR, type RunState } from "./ledger";

/*
 * A throwaway RunState per test.
 *
 * `remember` persists through saveRun, so two tests sharing a runId race on the same file and one
 * of them fails with EPERM on the rename — a real collision, not a flake to retry. A random id per
 * test keeps them independent, and the files are removed afterwards.
 */
const written: string[] = [];
function stubState(): RunState {
  const runId = `memtest-${crypto.randomUUID()}`;
  written.push(path.join(ARENA_DIR, `${runId}.json`));
  return {
    runId,
    agents: [{ id: "a1", memory: [] }],
    actions: [],
  } as unknown as RunState;
}

test.after(() => {
  for (const f of written) {
    // The .tmp companion too: saveRun writes tmp-then-rename, and a test that ends mid-write
    // leaves the tmp behind in the live run directory.
    try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(`${f}.tmp`, { force: true }); } catch { /* best effort */ }
  }
});

test("a near-duplicate reinforces instead of taking a slot", () => {
  const s = stubState();
  remember(s, "a1", "Sell in parts: the curve could not settle my whole position at once.", 1);
  remember(s, "a1", "Remember the curve cannot settle a whole position — sell it in parts.", 2);

  const mem = s.agents[0]!.memory;
  assert.equal(mem.length, 1, "the same lesson restated must not consume a second slot");
  assert.equal(mem[0]!.reinforced, 1);
  assert.match(mem[0]!.text, /Sell in parts/, "the original wording is kept, not churned");
});

test("a genuinely different lesson does take its own slot", () => {
  const s = stubState();
  remember(s, "a1", "Sell in parts: the curve cannot settle a whole position.", 1);
  remember(s, "a1", "Rate every product immediately after collecting it.", 2);
  assert.equal(s.agents[0]!.memory.length, 2);
});

test("a reinforced lesson survives eviction; one-off trivia does not", () => {
  const s = stubState();
  // One durable lesson, relearned early and never again.
  remember(s, "a1", "Always check the licence token is the full 42 characters.", 1);
  for (let i = 0; i < 4; i++) {
    remember(s, "a1", "The licence token must be the complete 42 character address, always check it.", 2 + i);
  }
  // Then flood with distinct, recent, one-off observations.
  for (let i = 0; i < MEMORY_LIMIT + 10; i++) {
    remember(s, "a1", `Observation number ${i}: store ${i} listed widget ${i} priced oddly.`, 100 + i);
  }

  const mem = s.agents[0]!.memory;
  assert.ok(
    mem.some((m) => /42 character/i.test(m.text)),
    "a lesson relearned four times must outlive newer one-off notes"
  );
});

test("both budgets bind", () => {
  const s = stubState();
  for (let i = 0; i < 200; i++) {
    remember(s, "a1", `Distinct lesson ${i} about ${"detail".repeat(20)} number ${i}.`, i);
  }
  const mem = s.agents[0]!.memory;
  const chars = mem.reduce((n, m) => n + m.text.length, 0);
  assert.ok(mem.length <= MEMORY_LIMIT, `slots: ${mem.length} > ${MEMORY_LIMIT}`);
  assert.ok(chars <= MEMORY_CHAR_BUDGET, `chars: ${chars} > ${MEMORY_CHAR_BUDGET}`);
});

test("an empty or whitespace note is ignored", () => {
  const s = stubState();
  remember(s, "a1", "   ", 1);
  remember(s, "a1", "", 2);
  assert.equal(s.agents[0]!.memory.length, 0);
});

test("inflected restatements of one lesson merge (regression: observed in a live run)", () => {
  const s = stubState();
  // Verbatim from an agent's memory during a real run. These are one lesson in three wordings;
  // before stemming they overlapped at 0.47 and took three slots and ~600 characters of a
  // 3,000-character budget, re-sent on every turn for the rest of the run.
  remember(s, "a1", "When nothing is selling, demand signaling beats chasing price; seek concrete buy-in signals before building.", 1);
  remember(s, "a1", "When nothing is selling, demand signaling beats price-cutting; push for concrete buyer commitment.", 2);

  const mem = s.agents[0]!.memory;
  assert.equal(mem.length, 1, "these are the same lesson and must occupy one slot");
  assert.equal(mem[0]!.reinforced, 1);
});

test("different lessons from the same agent still stay apart", () => {
  const s = stubState();
  // Also from the same agent's real memory: eliciting demand is not the same claim as
  // signalling beating price-cutting, and lowering the threshold must not merge them.
  remember(s, "a1", "If nothing sells, focus on eliciting concrete demand first; a validated demand signal is worth more than a guess.", 1);
  remember(s, "a1", "When nothing is selling, demand signaling beats price-cutting; push for concrete buyer commitment.", 2);
  assert.equal(s.agents[0]!.memory.length, 2, "distinct lessons must not be merged by the looser threshold");
});
