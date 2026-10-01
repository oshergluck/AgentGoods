/**
 * Tests for Alpha AIC Arbitrage against a simulated AgentGoods market.
 *
 * Simulated: constant-product token curves (6,000 USDC virtual seed, 3% fee on each trade, sells
 * paid only from real USDC, 0.0001 USDC minimum gross), sales-store incentive pools paying 2/1000 of the
 * remaining pool per unit, product purchases that pay that reward, and the API shapes the tool
 * reads. `send` executes prepared transactions against the simulation.
 *
 *     node test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const A = require("./alpha-aic-arbitrage.js");

const ME = "0x" + "a".repeat(40);
const GENESIS = 1_000_000_000n * 10n ** 18n;
const SEED = 6000n * 1_000_000n;
const FEE_BPS = 300n;
const R_NUM = 2n, R_DEN = 1000n;

function makeMarket(specs) {
  const stores = specs.map((s, i) => {
    const id = (i + 1).toString(16);
    return {
      storeId: "0x" + id.padStart(64, "0"),
      productId: "0x" + ("f" + id).padStart(64, "0"),
      token: "0x" + id.padStart(40, "0"),
      shop: "0x" + ("e" + id).padStart(40, "0"),
      symbol: s.symbol,
      controller: (s.controller ?? "0x" + "c".repeat(39) + (i % 10)).toLowerCase(),
      priceBase: BigInt(Math.round(s.price * 1e6)),
      vT: GENESIS - BigInt(Math.round((s.soldPct ?? 0.15) * 1e6)) * GENESIS / 1_000_000n,
      realUSDC: BigInt(Math.round((s.reserve ?? 1000) * 1e6)),
      pool: BigInt(Math.round((s.poolTokens ?? 0) * 1e6)) * 10n ** 12n,
      active: s.active ?? true,
    };
  });
  const bal = {}; // ME's AIC per token
  const ctl = { indexLag: false, productQuotes: 0, drainAt: 0 }; // true: the indexer has not caught up, /me shows no balances
  const vU = (t) => SEED + t.realUSDC;
  const price1e18 = (t) => ((vU(t) * 10n ** 30n) / t.vT).toString(); // USDC per whole token, 1e18-scaled
  const reward = (s, n) => { let p = s.pool, r = 0n; for (let i = 0; i < n; i++) { const u = (p * R_NUM) / R_DEN; r += u; p -= u; } return r; };
  const sellQ = (s, tokens) => { const g = (vU(s) * tokens) / (s.vT + tokens); return { g, net: g - (g * FEE_BPS) / 10000n }; };
  const pending = new Map(); let nonce = 0; const sent = [];
  const J = (st, b) => ({ ok: st < 400, status: st, text: async () => JSON.stringify(b) });
  const byStore = (id) => stores.find((s) => s.storeId === id);
  const byToken = (t) => stores.find((s) => s.token === t.toLowerCase());
  const intent = (kind, s, data, payToken, amount, extra) => {
    const approveData = "0x095ea7b3" + s.shop.slice(2).padStart(64, "0") + BigInt(amount).toString(16).padStart(64, "0");
    pending.set(data, { kind, s, ...extra });
    return { intent: { transaction: { to: s.shop, data, value: "0" }, requiredAllowance: { token: payToken, amount: { base: String(amount) } }, approvalTransaction: { to: payToken, data: approveData, value: "0" } } };
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname, body = init.body ? JSON.parse(init.body) : undefined;
    if (p === "/api/v1/market/tokens") return J(200, { items: stores.map((s) => ({ aicToken: s.token, currentIndexedPrice1e18: price1e18(s) })) });
    if (p === "/api/v1/market/products") return J(200, { items: stores.map((s) => ({
      protocol: { storeId: s.storeId, productId: s.productId, storeType: "sales", priceUSDC: { base: s.priceBase.toString() }, active: s.active },
      store: { protocol: { tokenAddress: s.token, storeController: s.controller, tokenSymbol: s.symbol } },
      incentive: { perUnitAIC: { base: ((s.pool * R_NUM) / R_DEN).toString() } },
    })) });
    if (p === "/api/v1/me") return J(200, { aicPositions: { items: Object.entries(ctl.indexLag ? {} : bal).map(([k, v]) => ({ aicToken: k, balance: { base: v.toString() } })) } });
    if (!init.headers?.authorization) return J(401, { error: { code: "INVALID_API_KEY" } });
    let m = p.match(/^\/api\/v1\/stores\/(0x[0-9a-f]{64})\/products\/(0x[0-9a-f]{64})\/(quote|purchase)$/);
    if (m) {
      const s = byStore(m[1]);
      if (m[3] === "quote") {
        ctl.productQuotes++;
        if (ctl.drainAt && ctl.productQuotes === ctl.drainAt) s.pool /= 100n; // another buyer took the pool
        const n = Number(body.units ?? 1);
        return J(200, { quote: { gross: { base: (s.priceBase * BigInt(n)).toString() }, expectedRewardAIC: { base: reward(s, n).toString() } },
          execution: { endpoint: `/api/v1/stores/${s.storeId}/products/${s.productId}/purchase`, body: { units: n, expectedVersion: 1, maxTotalUSDC: (s.priceBase * BigInt(n)).toString() } } });
      }
      if (!init.headers?.["idempotency-key"]) return J(400, { error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      const data = "0x" + (++nonce).toString(16).padStart(8, "0") + "0".repeat(64);
      return J(201, intent("purchase", s, data, "0x" + "9".repeat(40), s.priceBase * BigInt(body.units), { units: body.units }));
    }
    m = p.match(/^\/api\/v1\/stocks\/(0x[0-9a-f]{40})\/(quote|sell)$/);
    if (m) {
      const s = byToken(m[1]);
      const q = sellQ(s, BigInt(body.amount));
      if (m[2] === "quote") {
        if (q.g > s.realUSDC) return J(400, { error: { code: "MARKET_INSUFFICIENT_REAL_USDC" } });
        return J(200, { quote: { grossUSDC: { base: q.g.toString() }, expectedOutUSDC: { base: q.net.toString() } } });
      }
      if (q.g < 100n) return J(400, { error: { code: "BELOW_MINIMUM_TRADE" } });
      const data = "0x" + (++nonce).toString(16).padStart(8, "0") + "0".repeat(64);
      return J(201, intent("sell", s, data, s.token, BigInt(body.amount), { amount: BigInt(body.amount), minOut: BigInt(body.minOut) }));
    }
    return J(404, { error: { code: "NOT_FOUND", message: p } });
  };
  const send = async (tx) => {
    sent.push(tx);
    if (tx.data.startsWith("0x095ea7b3")) return "0xapprove";
    const op = pending.get(tx.data); if (!op) throw new Error("unknown tx"); pending.delete(tx.data);
    const s = op.s;
    if (op.kind === "purchase") {
      const r = reward(s, op.units); s.pool -= r; bal[s.token] = (bal[s.token] ?? 0n) + r;
    } else {
      const q = sellQ(s, op.amount); if (q.net < op.minOut) throw new Error("slippage");
      s.vT += op.amount; s.realUSDC -= q.g; bal[s.token] -= op.amount;
    }
    return "0xh" + tx.data.slice(2, 10);
  };
  return { fetch, send, stores, bal, sent, reward, ctl };
}

async function cycle(mk, state, policy, extra = {}) {
  globalThis.fetch = mk.fetch;
  return A.runCycle({ origin: "https://sim", apiKey: "k", state, policy, send: mk.send, indexWait: { tries: 1, ms: 0 }, ...extra });
}
const POLICY = { maxSpendPerTradeUSDC: 20, maxTotalSpendUSDC: 100, maxLossUSDC: 10, minProfitUSDC: 0.25 };

const results = [];
async function test(name, fn) { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name, e.stack?.split("\n").slice(0, 3).join(" | ")]); } }

await test("refuses to start without your four limits", async () => {
  assert.throws(() => A.normalizePolicy({}), /maxSpendPerTradeUSDC/);
  assert.throws(() => A.normalizePolicy({ maxSpendPerTradeUSDC: 5, maxTotalSpendUSDC: 10, maxLossUSDC: 1 }), /minProfitUSDC/);
  assert.throws(() => A.normalizePolicy({ maxSpendPerTradeUSDC: 50, maxTotalSpendUSDC: 10, maxLossUSDC: 1, minProfitUSDC: 1 }), /below/);
  assert.throws(() => A.newState({}), /wallet/);
});

await test("finds and executes a real incentive arbitrage, and the profit is realised", async () => {
  // A generous pool relative to price: 0.2% of 40M tokens per unit at ~7.9e-6 USDC ≈ 0.63 USDC per unit, against a 0.30 price.
  const mk = makeMarket([{ symbol: "RICH", price: 0.3, poolTokens: 40_000_000, reserve: 2000 }]);
  const state = A.newState({ wallet: ME });
  const out = await cycle(mk, state, POLICY);
  assert.equal(state.trades.length, 1, out.log.join(" / "));
  assert.ok(state.trades[0].realizedProfitUSDC > 0.25, "realised " + state.trades[0].realizedProfitUSDC);
  assert.ok(state.trades[0].units > 1, "more than one unit when that is better: " + state.trades[0].units);
});

await test("a reward indexed late is sold by the next cycle, and the token is not bought twice meanwhile", async () => {
  const mk = makeMarket([{ symbol: "RICH", price: 0.3, poolTokens: 40_000_000, reserve: 2000 }]);
  let state = A.newState({ wallet: ME });
  mk.ctl.indexLag = true;
  const first = await cycle(mk, state, POLICY);
  state = JSON.parse(JSON.stringify(state)); // saved to disk and loaded again between cycles
  assert.equal(state.trades.length, 1, first.log.join(" / "));
  assert.equal(state.trades[0].pendingSale, true);
  assert.match(first.log.join(" / "), /next cycle sells it/);
  const lagged = await cycle(mk, state, POLICY); // still lagging: no sale, and no second RICH position
  assert.equal(state.trades.length, 1, lagged.log.join(" / "));
  assert.match(lagged.log[0], /still not indexed/);
  mk.ctl.indexLag = false;
  const second = await cycle(mk, state, POLICY);
  assert.equal(state.trades[0].pendingSale, false, second.log.join(" / "));
  assert.ok(state.trades[0].realizedProfitUSDC > 0, "realised " + state.trades[0].realizedProfitUSDC);
  assert.match(second.log[0], /^pending RICH sold/);
  const ops = mk.sent.filter((t) => !t.data.startsWith("0x095ea7b3")); // approvals may legitimately repeat
  assert.equal(new Set(ops.map((t) => t.data)).size, ops.length, "no trade signed twice");
});

await test("re-quotes before buying and skips when the pool was drained since the scan", async () => {
  const mk = makeMarket([{ symbol: "RICH", price: 0.3, poolTokens: 40_000_000, reserve: 2000 }]);
  await cycle(mk, A.newState({ wallet: ME }), POLICY, { dryRun: true }); // how many product quotes a scan takes
  mk.ctl.drainAt = mk.ctl.productQuotes * 2 + 1; // the next scan's quotes, then the re-quote drains
  const state = A.newState({ wallet: ME });
  const out = await cycle(mk, state, POLICY);
  assert.equal(state.trades.length, 0, out.log.join(" / "));
  assert.equal(mk.sent.length, 0, "nothing signed");
  assert.match(out.log.join(" / "), /re-quote before buying: profit now -?\d/);
});

await test("leaves a close-but-unprofitable incentive alone (like Alpha's live one)", async () => {
  const mk = makeMarket([{ symbol: "CLOSE", price: 0.5, poolTokens: 27_000_000, reserve: 1164, soldPct: 0.1625 }]);
  const state = A.newState({ wallet: ME });
  const out = await cycle(mk, state, POLICY);
  assert.equal(state.trades.length, 0, out.log.join(" / "));
  assert.equal(mk.sent.length, 0, "nothing signed");
});

await test("never trades your own store, an excluded seller, or a product without an incentive", async () => {
  const mk = makeMarket([
    { symbol: "MINE", price: 0.3, poolTokens: 40_000_000, controller: ME },
    { symbol: "NOPOOL", price: 0.3, poolTokens: 0 },
    { symbol: "BANNED", price: 0.3, poolTokens: 40_000_000, controller: "0x" + "b".repeat(40) },
  ]);
  const state = A.newState({ wallet: ME });
  await cycle(mk, state, { ...POLICY, excludeSellers: ["0x" + "b".repeat(40)] });
  assert.equal(state.trades.length, 0);
});

await test("respects the per-trade and total spend limits", async () => {
  const mk = makeMarket([{ symbol: "RICH", price: 0.3, poolTokens: 400_000_000, reserve: 20000 }]);
  const state = A.newState({ wallet: ME });
  const policy = { ...POLICY, maxSpendPerTradeUSDC: 3, maxTotalSpendUSDC: 6 };
  for (let i = 0; i < 5; i++) await cycle(mk, state, policy);
  assert.ok(state.trades.length >= 2, "it did trade: " + state.trades.length);
  assert.ok(state.trades.every((t) => t.costUSDC <= 3 + 1e-9), "per trade");
  assert.ok(state.spentUSDC <= 6 + 1e-9, "total " + state.spentUSDC);
});

await test("does not take a reward too small to sell (under the 0.0001 USDC minimum)", async () => {
  const mk = makeMarket([{ symbol: "TINY", price: 0.05, poolTokens: 0.3, reserve: 2000 }]);
  const state = A.newState({ wallet: ME });
  const out = await cycle(mk, state, { ...POLICY, minProfitUSDC: 0.001, minMarginPct: 0, maxSpendPerTradeUSDC: 0.2 });
  // a reward this small is dropped before any quote is spent on it, and nothing is bought
  assert.equal(state.trades.length, 0, out.log.join(" / "));
  // and the rule itself: an option whose sale is under 0.0001 USDC gross is never chosen, however profitable
  const p = A.normalizePolicy({ ...POLICY, minProfitUSDC: 0.000001, minMarginPct: 0 });
  const e = A.evaluate({ units: 1, costUSDC: 0.00001, rewardAIC: "1", sellGrossUSDC: 0.00009, sellNetUSDC: 0.00008 }, p);
  assert.equal(e.sellable, false);
  assert.equal(A.choose([e], p, A.newState({ wallet: ME })), null);
});

await test("refuses an approval that is not exactly what the trade needs", async () => {
  const shop = "0x" + "f".repeat(40), usdc = "0x" + "e".repeat(40), evil = "0x" + "9".repeat(40);
  const approve = (sp, amt) => "0x095ea7b3" + sp.slice(2).padStart(64, "0") + BigInt(amt).toString(16).padStart(64, "0");
  const intent = (sp, amt) => ({ transaction: { to: shop, data: "0x12345678" }, requiredAllowance: { token: usdc, amount: "2000000" }, approvalTransaction: { to: usdc, data: approve(sp, amt) } });
  A.checkApproval(intent(shop, 2000000));
  assert.throws(() => A.checkApproval(intent(evil, 2000000)), /spender/);
  assert.throws(() => A.checkApproval(intent(shop, 10n ** 30n)), /amount/);
});

await test("dry run finds the opportunity and signs nothing", async () => {
  const mk = makeMarket([{ symbol: "RICH", price: 0.3, poolTokens: 40_000_000, reserve: 2000 }]);
  const state = A.newState({ wallet: ME });
  const out = await cycle(mk, state, POLICY, { dryRun: true });
  assert.equal(mk.sent.length, 0);
  assert.equal(out.opportunities.length, 1);
});

await test("the pure core runs in a bare vm with no fetch, require or console", async () => {
  const src = readFileSync(new URL("./alpha-aic-arbitrage.js", import.meta.url), "utf8");
  const ctx = vm.createContext({});
  vm.runInContext(src + "; globalThis.A = AlphaAicArbitrage;", ctx);
  const r = vm.runInContext(`
    const p = A.normalizePolicy({ maxSpendPerTradeUSDC: 5, maxTotalSpendUSDC: 10, maxLossUSDC: 2, minProfitUSDC: 0.1 });
    const e = A.evaluate({ units: 3, costUSDC: 1.5, rewardAIC: "1", sellGrossUSDC: 2.2, sellNetUSDC: 2.1 }, p);
    JSON.stringify({ units: A.candidateUnits(0.5, p), profit: Math.round(e.profitUSDC * 1000) / 1000 });`, ctx);
  const o = JSON.parse(r);
  assert.deepEqual(o.units, [1, 2, 3, 5, 8, 10]);
  assert.equal(o.profit, 0.52);
});

for (const r of results) console.log(r[0].padEnd(4), r[1], r[2] ? "\n     " + r[2] : "");
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
