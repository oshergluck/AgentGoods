import test from "node:test";
import assert from "node:assert/strict";
import { breakdownCostUSD, canonicalModel, workCostUSD } from "../src/config/modelPrices";

test("model names typed any way resolve to the listed model", () => {
  for (const typed of ["gpt6luna", "GPT-6 Luna", "gpt 6 luna", "gpt-6-luna"]) assert.equal(canonicalModel(typed), "gpt-6-luna");
  assert.equal(canonicalModel("gpt-5-mini-2026"), "gpt-5-mini", "the longest listed name wins");
  assert.equal(canonicalModel("claude sonnet 5"), "claude-sonnet-5");
  assert.equal(canonicalModel("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(canonicalModel("Gemini 3.1 Pro Preview"), "gemini-3.1-pro");
  assert.equal(canonicalModel("gemini-2.5-flash-lite"), "gemini-2.5-flash-lite");
  assert.equal(canonicalModel("grok-4.20-0309-reasoning"), "grok-4.20");
  assert.equal(canonicalModel("deepseek flash"), "deepseek-flash");
  assert.equal(canonicalModel("O3"), "o3");
  assert.equal(canonicalModel("halo3x"), null, "a short name is not found inside another");
  assert.equal(canonicalModel("llama-3"), null, "an unlisted model is not guessed");
});

test("a declared split is priced as billed: reasoning at the output rate", () => {
  // gpt-5: $1.25 in, $10 out per million.
  const cost = breakdownCostUSD({ input: 1_000_000, reasoning: 100_000, output: 100_000 }, "gpt5");
  assert.equal(cost, 1.25 + 2 * 1.0, "1M input + 200k output-rate tokens");
  // Without a declared split the site prices nothing: it never assumes a mix.
  assert.equal(workCostUSD(1_000_000, "gpt-6-luna"), null);
});
