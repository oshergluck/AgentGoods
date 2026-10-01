/**
 * The arena stays a neutral experiment. These checks read the harness itself: every agent in an economy
 * run gets the same instructions, no agent is given a role, a strategy or a business model, nothing buys,
 * calls or trades for an agent, and nothing is rewarded but the economic outcome.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = (f: string) => fs.readFileSync(path.join(__dirname, "..", "src", "arena", f), "utf8");
const brain = src("brain.ts");
const arena = src("arena.ts");
const agent = src("agent.ts");

function economyPrompt(): string {
  const start = brain.indexOf("const SYSTEM_PROMPT_ECONOMY = `");
  assert.ok(start >= 0, "the economy prompt exists");
  // The prompt is one template literal: it ends at the first closing backtick.
  const open = start + "const SYSTEM_PROMPT_ECONOMY = `".length;
  const end = brain.indexOf("`", open);
  return brain.slice(open, end);
}

test("the economy system prompt is one fixed text: nothing in it varies by agent", () => {
  const prompt = economyPrompt();
  assert.equal(/\$\{/.test(prompt), false, "no per-agent interpolation in the economy prompt");
});

test("no agent is told what kind of participant to be", () => {
  const prompt = economyPrompt().toLowerCase();
  for (const phrase of [
    "your role is",
    "you are a seller",
    "you are a buyer",
    "you are an investor",
    "you are a trader",
    "market maker",
    "build a service",
    "you should invest",
    "you must buy",
  ]) {
    assert.equal(prompt.includes(phrase), false, `the prompt does not say "${phrase}"`);
  }
});

test("an economy run sends no mandate or archetype to anyone", () => {
  assert.match(brain, /scoring === "economy" \? \[\] :/, "the mandate/archetype message is skipped in economy runs");
});

test("every agent draws the same reasoning effort in an economy run", () => {
  assert.match(arena, /ARENA_SCORING \?\? ""\) === "economy"\) return "medium"/);
});

test("no hidden demand: market makers, lenders, commentators and harness attestation are off by default", () => {
  assert.match(arena, /process\.env\.ARENA_CATALYST === "1"/);
  assert.match(arena, /process\.env\.ARENA_FORUM_DESK !== "1"/);
  assert.match(arena, /process\.env\.ARENA_COMMENTATORS === "1"/);
  assert.match(agent, /process\.env\.ARENA_HARNESS_ATTEST === "1"/);
});

test("the harness never buys or calls a service on an agent's behalf", () => {
  const harness = fs
    .readdirSync(path.join(__dirname, "..", "src", "arena"))
    .filter((f) => f.endsWith(".ts") && f !== "siteTelemetry.ts")
    .map((f) => src(f))
    .join("\n");
  assert.equal(/\/services\/[^"'`]*\/invoke/.test(harness), false, "no service invocation in the harness");
  assert.equal(/functionName:\s*["']purchase["']/.test(harness), false, "no purchase prepared by the harness");
});

test("site telemetry only reads", () => {
  const t = src("siteTelemetry.ts");
  assert.equal(/method:\s*["'](POST|PUT|DELETE|PATCH)["']/.test(t), false);
});
