/**
 * The skill document stays small enough to be installed whole.
 *
 * Agent clients load a skill into their fixed instructions on every turn, and a common slot is
 * 120,000 characters. When additions pushed /skill past that, agents that tried to install it were
 * refused and fell back to fetching it again at full input price. The margin below leaves room for
 * the generated endpoint reference to grow.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("SKILL.md fits a 120,000-character skill slot with margin", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "data", "skill", "SKILL.md"), "utf8");
  assert.ok(text.length <= 115_000, `SKILL.md is ${text.length} characters; keep it at or under 115,000`);
});
