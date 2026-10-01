/**
 * Can a running Agent learn something its author never anticipated?
 *
 * This is the property that matters for a long-lived Agent, and the one the arena failed. Two
 * separate allow-lists — one picking fields out of `/updates`, one fingerprinting six named
 * schema sections — meant an Agent could only ever notice what had already been thought of when
 * its client was written. The protocol grew a block announcing that broken things had been fixed,
 * and every Agent already running discarded it silently and carried on under the old rules.
 *
 * Restarting every participant to teach it a new field is not an answer: a real deployment has
 * agents running for hours or days against a protocol that changes underneath them. So these
 * tests assert the inverted default — forward everything, strip only what is known to be noise —
 * using fields invented here that no production code mentions.
 *
 *     npx tsx src/arena/learnability.test.ts
 */

import { changedSections, hash32, stripVolatile } from "./agent";

let failures = 0;
const c = { ok: "\x1b[32m", bad: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ${c.ok}PASS${c.off}  ${label.padEnd(58)}${c.dim}${detail.slice(0, 50)}${c.off}`);
  } else {
    failures++;
    console.log(`  ${c.bad}FAIL${c.off}  ${label.padEnd(58)}${detail.slice(0, 110)}`);
  }
}

console.log("\nCan a running Agent notice what nobody wrote code for?\n");

/* ------------------------------------------------- volatile keys are not changes */

const withClocks = {
  forum: { rule: "be civil" },
  freshness: { blockNumber: 100, asOf: "2026-09-23T10:00:00Z" },
  counts: { returned: 12 },
};
const withClocksLater = {
  forum: { rule: "be civil" },
  freshness: { blockNumber: 999, asOf: "2026-09-23T11:00:00Z" },
  counts: { returned: 47 },
};

check(
  "a moving clock is NOT reported as a protocol change",
  JSON.stringify(stripVolatile(withClocks)) === JSON.stringify(stripVolatile(withClocksLater)),
  "freshness/counts stripped"
);

check(
  "identical documents hash identically",
  hash32(JSON.stringify(stripVolatile(withClocks))) === hash32(JSON.stringify(stripVolatile(withClocksLater))),
  ""
);

/* ------------------------------------- a section nobody anticipated IS a change */

const before = { forum: { rule: "be civil" }, pricing: { note: "declare honestly" } };

// A section invented for this test. No code in the arena mentions it, which is the point.
const after = {
  forum: { rule: "be civil" },
  pricing: { note: "declare honestly" },
  somethingNobodyWroteCodeFor: {
    headline: "Tariffs now apply to cross-store sales",
    detail: "A rule that did not exist when the client was written.",
  },
};

const diff = changedSections(before, after);
check(
  "a brand-new section is detected",
  diff.names.includes("somethingNobodyWroteCodeFor"),
  diff.names.join(", ") || "nothing detected"
);
check(
  "  and its CONTENT is handed to the Agent, not just its name",
  JSON.stringify(diff.content).includes("Tariffs now apply"),
  JSON.stringify(diff.content).slice(0, 50)
);
check(
  "  while unchanged sections stay quiet",
  !diff.names.includes("forum") && !diff.names.includes("pricing"),
  diff.names.join(", ")
);

check(
  "the fingerprint moves when a new section appears",
  hash32(JSON.stringify(stripVolatile(before))) !== hash32(JSON.stringify(stripVolatile(after))),
  ""
);

/* ------------------------------------------------- edits and removals both count */

const edited = { ...before, pricing: { note: "declare honestly AND verifiably" } };
check(
  "an edit inside an existing section is detected",
  changedSections(before, edited).names.includes("pricing"),
  changedSections(before, edited).names.join(", ")
);

const removed = { forum: before.forum };
check(
  "a REMOVED section is reported as removed",
  changedSections(before, removed).names.some((n) => n.includes("removed")),
  changedSections(before, removed).names.join(", ")
);

/* ----------------------------------------------------- nothing changed is silent */

check(
  "an unchanged document reports nothing",
  changedSections(before, { ...before }).names.length === 0,
  ""
);

/* ------------------------------------------------------------- deep, not shallow */

const deepBefore = { a: { b: { c: { d: "old" } } } };
const deepAfter = { a: { b: { c: { d: "new" } } } };
check(
  "a change buried four levels down is still detected",
  changedSections(deepBefore, deepAfter).names.includes("a"),
  ""
);

const deepVolatile = { a: { b: { updatedAt: "t1", real: "same" } } };
const deepVolatile2 = { a: { b: { updatedAt: "t2", real: "same" } } };
check(
  "  but a buried timestamp is still not a change",
  JSON.stringify(stripVolatile(deepVolatile)) === JSON.stringify(stripVolatile(deepVolatile2)),
  "stripping is recursive"
);

console.log("");
if (failures === 0) {
  console.log(`${c.ok}A running Agent can learn rules that did not exist when it started.${c.off}\n`);
} else {
  console.log(`${c.bad}${failures} check(s) failed — running agents will miss protocol changes.${c.off}\n`);
}
process.exit(failures === 0 ? 0 : 1);
