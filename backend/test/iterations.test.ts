import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIterationLog, iterationLogHash } from "../src/content/iterationLog";
import { developmentView } from "../src/api/serializers";
import { parseProfile } from "../src/content/profile";

const good = [
  "First version parsed only JSON input; tested on five real feeds",
  "Two feeds lacked fields, so added defaults and re-ran all five",
  "Output ignored the limit input; fixed it and checked three limits",
];

test("an iteration log needs exactly one explanation per iteration", () => {
  assert.deepEqual(checkIterationLog(3, good), good);
  assert.throws(() => checkIterationLog(4, good), /does not explain/);
  assert.throws(() => checkIterationLog(2, good), /does not explain/);
});

test("repeated explanations are refused", () => {
  assert.throws(() => checkIterationLog(2, [good[0], good[0].toUpperCase()]), /does not explain/);
});

test("explanations that reveal code are refused, prose passes", () => {
  assert.throws(() => checkIterationLog(1, ["const f = (x) => { return x.map(y => y * 2); };"]), /does not explain/);
  assert.throws(() => checkIterationLog(1, ["```js\nfunction parse(a) {}\n```"]), /does not explain/);
  assert.doesNotThrow(() => checkIterationLog(1, ["Switched the retry policy to back off exponentially after timeouts"]));
});

test("the listing commits to the log by hash, and product views expose it", () => {
  const hash = iterationLogHash(good);
  const meta = JSON.stringify({ name: "x", iterations: 3, iterationsTotal: 7, iterationLogHash: hash });
  const p = parseProfile(meta);
  assert.equal(p.iterations, 3);
  assert.equal(p.iterationsTotal, 7);
  assert.equal(p.iterationLogHash, hash);
  const d = developmentView(meta, 2, "0xstore", "0xprod");
  assert.equal(d.iterationsDeclared, true);
  assert.equal(d.iterationsTotal, 7);
  assert.equal(d.iterationLogHash, hash);
  assert.match(d.iterationLog, /\/stores\/0xstore\/products\/0xprod\/iterations$/);
  assert.equal(developmentView('{"name":"old"}', 1, "s", "p").iterationsDeclared, false);
});

test("only the seller's declared split is priced; the site estimates nothing", async () => {
  const { buildCostOf, declarationView } = await import("../src/api/serializers");
  const d = developmentView(JSON.stringify({ name: "x", iterations: 20, iterationsTotal: 20 }), 1, "s", "p");
  assert.equal("workFloor" in d, false, "no token figure is derived from iterations");
  const split = { input: 900_000, reasoning: 50_000, output: 50_000 };
  const decl = declarationView({ declared: true, tokensSaved: "1000000", modelTier: "gpt-5", basis: "MEASURED" }, split);
  assert.equal(decl.buildCostUSDC?.atDeclaredModel?.model, "gpt-5");
  assert.equal(decl.buildCostUSDC?.atDeclaredModel?.usdc, "2.13", "900k x $1.25 + 100k x $10 per million");
  const noSplit = declarationView({ declared: true, tokensSaved: "1000", modelTier: "gpt-5", basis: "ESTIMATED" });
  assert.equal(noSplit.buildCostUSDC, null, "a total without a split is not priced by assuming a mix");
  assert.equal(buildCostOf(0, null, split), null);
});
