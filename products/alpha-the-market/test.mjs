/**
 * Tests for Alpha the market, against a simulated AgentGoods market.
 *
 * The simulation implements the constant-product curve (virtual 6,000 USDC seed, 3% trade fees,
 * sells paid only from real USDC), the endpoints the engine calls with the live API's shapes, and a
 * `send` that executes prepared transactions. Other traders act between cycles.
 *
 *     node test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const M = require("./alpha-the-market.js");

const ME = "0x" + "a".repeat(40);
const GENESIS = 1_000_000_000n * 10n ** 18n;
const SEED = 6000n * 1_000_000n;
const FEE_BPS = 300n;

function makeMarket(specs, rngSeed = 7) {
  let r = rngSeed;
  const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  const tokens = specs.map((s, i) => ({
    aicToken: "0x" + (i + 1).toString(16).padStart(40, "0"),
    storeId: "0x" + (i + 1).toString(16).padStart(64, "0"),
    symbol: s.symbol,
    controller: (s.controller ?? "0x" + "c".repeat(39) + (i % 10)).toLowerCase(),
    phase: s.phase ?? "bonding_curve",
    holders: s.holders ?? 2,
    vT: GENESIS - BigInt(Math.round((s.soldPct ?? 0.02) * 1e6)) * GENESIS / 1_000_000n,
    realUSDC: BigInt(Math.round((s.reserve ?? 100) * 1e6)),
    trades: [],
    drift: s.drift ?? 0, // >0: others keep buying (a token that goes somewhere); <0: others sell
    flow: s.flow ?? 15, // USDC size of another participant's typical buy
    commerce: s.commerce ?? 0,
  }));
  const balances = {}; // token -> base units held by ME
  const lag = { reads: 0 }; // while > 0, /me serves the balances as they were before the last trade
  let stale = null;
  let clock = 1_800_000_000;
  const vU = (t) => SEED + t.realUSDC;
  function buy(t, grossUSDC, trader) {
    const net = grossUSDC - (grossUSDC * FEE_BPS) / 10000n;
    const out = (t.vT * net) / (vU(t) + net);
    t.vT -= out; t.realUSDC += net;
    t.trades.unshift({ at: clock, side: "buy", trader });
    return out;
  }
  function sellQuote(t, tokens) {
    const grossOut = (vU(t) * tokens) / (t.vT + tokens);
    const net = grossOut - (grossOut * FEE_BPS) / 10000n;
    return { grossOut, net };
  }
  function sell(t, tokens, trader) {
    const { grossOut, net } = sellQuote(t, tokens);
    if (grossOut > t.realUSDC) throw Object.assign(new Error("insufficient real"), { code: "MARKET_INSUFFICIENT_REAL_USDC" });
    t.vT += tokens; t.realUSDC -= grossOut;
    t.trades.unshift({ at: clock, side: "sell", trader });
    return net;
  }
  const pending = new Map(); // calldata -> op
  let nonce = 0;
  const row = (t) => ({
    aicToken: t.aicToken, storeId: t.storeId, token: { symbol: t.symbol }, phase: t.phase,
    realUSDCReserve: { base: t.realUSDC.toString(), decimals: 6 },
    netSoldPercentageBps: Number(((GENESIS - t.vT) * 10000n) / GENESIS),
    holderCount: t.holders, graduationBlocked: false, takeoverCandidate: null,
    lifetimeGrossVolumeUSDC: { base: "0", decimals: 6 },
    holderReserve: { storeLifetimeCommerceUSDC: { base: String(t.commerce * 1e6), decimals: 6 } },
    store: { protocol: { storeController: t.controller } },
    recentTrades: t.trades.slice(0, 10),
  });
  const find = (addr) => tokens.find((t) => t.aicToken === addr.toLowerCase());
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const p = u.pathname;
    if (p === "/api/v1/market/tokens") {
      const limit = Math.min(Number(u.searchParams.get("limit") ?? 50), 100);
      const sort = u.searchParams.get("sort") ?? "volume";
      const ordered = sort === "newest" ? [...tokens].reverse() : [...tokens].sort((a, b) => (b.realUSDC > a.realUSDC ? 1 : b.realUSDC < a.realUSDC ? -1 : 0));
      return json(200, { items: ordered.slice(0, limit).map(row) });
    }
    if (p === "/api/v1/me") {
      const view = lag.reads > 0 && stale ? (lag.reads--, stale) : balances;
      return json(200, { aicPositions: { items: Object.entries(view).map(([k, v]) => ({ aicToken: k, balance: { base: v.toString(), decimals: 18 } })) } });
    }
    let m = p.match(/^\/api\/v1\/stocks\/(0x[0-9a-f]{40})\/(quote|buy|sell)$/);
    if (m) {
      const t = find(m[1]);
      if (!init.headers?.authorization) return json(401, { error: { code: "INVALID_API_KEY" } });
      if (m[2] === "quote") {
        if (body.side === "buy") {
          const g = BigInt(body.amount);
          const net = g - (g * FEE_BPS) / 10000n;
          return json(200, { quote: { expectedOutAIC: { base: ((t.vT * net) / (vU(t) + net)).toString(), decimals: 18 } } });
        }
        const q = sellQuote(t, BigInt(body.amount));
        if (q.grossOut > t.realUSDC) return json(400, { error: { code: "MARKET_INSUFFICIENT_REAL_USDC", message: "cannot redeem" } });
        return json(200, { quote: { grossUSDC: { base: q.grossOut.toString(), decimals: 6 }, expectedOutUSDC: { base: q.net.toString(), decimals: 6 } } });
      }
      if (!init.headers?.["idempotency-key"]) return json(400, { error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      const gross = m[2] === "buy" ? BigInt(body.amount) : sellQuote(t, BigInt(body.amount)).grossOut;
      if (gross < 100n) return json(400, { error: { code: "BELOW_MINIMUM_TRADE" } });
      const id = (++nonce).toString(16).padStart(8, "0");
      const data = "0x" + id + "0".repeat(64);
      pending.set(data, { kind: m[2], t, amount: BigInt(body.amount), minOut: BigInt(body.minOut ?? "0") });
      const shop = "0x" + "f".repeat(40);
      const payToken = m[2] === "buy" ? "0x" + "e".repeat(40) : t.aicToken;
      const approveAmt = BigInt(body.amount);
      const approveData = "0x095ea7b3" + shop.slice(2).padStart(64, "0") + approveAmt.toString(16).padStart(64, "0");
      return json(201, {
        intent: {
          transaction: { to: shop, data, value: "0" },
          requiredAllowance: { token: payToken, spender: shop, amount: { base: approveAmt.toString() } },
          approvalTransaction: { to: payToken, data: approveData, value: "0" },
        },
      });
    }
    return json(404, { error: { code: "NOT_FOUND", message: p } });
  };
  const sent = [];
  const send = async (tx) => {
    sent.push(tx);
    if (tx.data.startsWith("0x095ea7b3")) return "0xapprove";
    const op = pending.get(tx.data);
    if (!op) throw new Error("unknown tx");
    pending.delete(tx.data);
    if (lag.next) { stale = { ...balances }; lag.reads = lag.next; }
    if (op.kind === "buy") {
      const out = buy(op.t, op.amount, ME);
      if (out < op.minOut) throw new Error("slippage");
      balances[op.t.aicToken] = (balances[op.t.aicToken] ?? 0n) + out;
    } else {
      const net = sell(op.t, op.amount, ME);
      if (net < op.minOut) throw new Error("slippage");
      balances[op.t.aicToken] -= op.amount;
      if (balances[op.t.aicToken] === 0n) delete balances[op.t.aicToken];
    }
    return "0xhash" + tx.data.slice(2, 10);
  };
  /** Other traders act between cycles. */
  function othersAct(minutes) {
    clock += minutes * 60;
    for (const t of tokens) {
      if (t.drift > 0 && rand() < t.drift) buy(t, BigInt(Math.round(t.flow * (0.5 + rand()) * 1e6)), "0x" + "b".repeat(40));
      if (t.drift < 0 && rand() < -t.drift) {
        const tokensToSell = (GENESIS - t.vT) / 50n;
        try { sell(t, tokensToSell, "0x" + "d".repeat(40)); } catch { /* curve cannot pay */ }
      }
    }
    return clock;
  }
  return { fetch, send, tokens, balances, othersAct, now: () => clock, sent, lag };
}

async function cycles(market, state, policy, n, minutes = 30, extra = {}) {
  const logs = [];
  for (let i = 0; i < n; i++) {
    globalThis.fetch = market.fetch;
    const out = await M.runCycle({ origin: "https://sim", apiKey: "k", state, policy, send: market.send, now: market.now(), indexWait: { tries: 1, ms: 0 }, ...extra });
    logs.push(...out.log);
    market.othersAct(minutes);
  }
  return logs;
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name, e.stack?.split("\n").slice(0, 3).join(" | ")]); }
}

await test("refuses to start without your three limits", async () => {
  assert.throws(() => M.normalizePolicy({}), /testSizeUSDC/);
  assert.throws(() => M.normalizePolicy({ testSizeUSDC: 2, maxExposureUSDC: 10 }), /maxLossUSDC/);
  assert.throws(() => M.normalizePolicy({ testSizeUSDC: 0.00005, maxExposureUSDC: 10, maxLossUSDC: 5 }), /at least 0\.0001/);
  assert.throws(() => M.normalizePolicy({ testSizeUSDC: 5, maxExposureUSDC: 2, maxLossUSDC: 5 }), /not even one/);
  assert.throws(() => M.normalizePolicy({ testSizeUSDC: 2, maxExposureUSDC: 6, maxLossUSDC: 1 }), /single test/);
  assert.throws(() => M.newState({}), /wallet/);
});

await test("never picks your own store, thin curves, or markets your test would dominate", async () => {
  const mk = makeMarket([
    { symbol: "MINE", controller: ME, reserve: 500 },
    { symbol: "THIN", reserve: 1 },
    { symbol: "TINY", reserve: 3 },
    { symbol: "OK", reserve: 300 },
  ]);
  globalThis.fetch = mk.fetch;
  const state = M.newState({ wallet: ME, seed: 3 });
  const out = await M.runCycle({ origin: "https://sim", apiKey: "k", state, policy: { testSizeUSDC: 2, maxExposureUSDC: 20, maxLossUSDC: 10, minRealReserveUSDC: 2, maxShareOfReserve: 0.2 }, send: mk.send, now: mk.now() });
  const bought = out.actions.filter((a) => a.type === "buy").map((a) => a.symbol);
  assert.deepEqual(bought, ["OK"], JSON.stringify(out.log));
});

await test("respects the exposure cap and the per-cycle limit", async () => {
  const mk = makeMarket(Array.from({ length: 12 }, (_, i) => ({ symbol: "T" + i, reserve: 200 })));
  const state = M.newState({ wallet: ME, seed: 9 });
  const policy = { testSizeUSDC: 3, maxExposureUSDC: 10, maxLossUSDC: 100, maxNewPerCycle: 2, holdSeconds: 1e9 };
  await cycles(mk, state, policy, 5);
  const cost = state.open.reduce((s, p) => s + p.costUSDC, 0);
  assert.ok(cost <= 10, "exposure " + cost);
  assert.equal(state.open.length, 3, "floor(10/3) positions");
});

await test("stops opening tests once realised losses reach maxLossUSDC", async () => {
  const mk = makeMarket(Array.from({ length: 8 }, (_, i) => ({ symbol: "L" + i, reserve: 200, drift: -0.9 })));
  const state = M.newState({ wallet: ME, seed: 5 });
  const policy = { testSizeUSDC: 2, maxExposureUSDC: 6, maxLossUSDC: 3, holdSeconds: 1800 };
  const logs = await cycles(mk, state, policy, 12);
  const NL = String.fromCharCode(10);
  assert.ok(state.haltedReason, "should halt:" + NL + M.report(state) + NL + logs.filter((l) => !l.startsWith("eligible")).slice(-12).join(NL));
  const loss = -state.realizedPnlUSDC;
  assert.ok(loss > 1, "halts once less than one test fits: loss " + loss);
  assert.ok(loss <= 3, "the cap is a bound: loss " + loss);
});

await test("learns: where others really buy, allocation moves there and pays", async () => {
  const specs = [];
  for (let i = 0; i < 6; i++) specs.push({ symbol: "UP" + i, reserve: 250, holders: 6, commerce: 50, drift: 0.9, flow: 400 });
  for (let i = 0; i < 6; i++) specs.push({ symbol: "DN" + i, reserve: 30, holders: 1, commerce: 0, drift: -0.9 });
  const mk = makeMarket(specs, 11);
  const state = M.newState({ wallet: ME, seed: 21 });
  const policy = { testSizeUSDC: 2, maxExposureUSDC: 8, maxLossUSDC: 40, holdSeconds: 3600, maxNewPerCycle: 2 };
  await cycles(mk, state, policy, 40);
  const first = state.closed.slice(0, 8), last = state.closed.slice(-8);
  const upShare = (xs) => xs.filter((p) => p.symbol.startsWith("UP")).length / Math.max(1, xs.length);
  assert.ok(state.closed.length >= 16, "closed " + state.closed.length);
  assert.ok(upShare(last) > upShare(first) || upShare(last) >= 0.75, `early ${upShare(first)} late ${upShare(last)}`);
  assert.ok(state.realizedPnlUSDC > 0, "real edge pays: " + state.realizedPnlUSDC);
});

await test("with no edge anywhere, it stops concentrating and loses less", async () => {
  const run = async (evidenceBeforeExploit) => {
    const specs = [];
    for (let i = 0; i < 6; i++) specs.push({ symbol: "UP" + i, reserve: 250, holders: 6, commerce: 50, drift: 0.9, flow: 15 });
    for (let i = 0; i < 6; i++) specs.push({ symbol: "DN" + i, reserve: 30, holders: 1, commerce: 0, drift: -0.9 });
    const mk = makeMarket(specs, 11);
    const state = M.newState({ wallet: ME, seed: 21 });
    const logs = await cycles(mk, state, { testSizeUSDC: 2, maxExposureUSDC: 8, maxLossUSDC: 40, holdSeconds: 3600, evidenceBeforeExploit }, 40);
    return { state, logs };
  };
  const guarded = await run(10), unguarded = await run(1e9);
  assert.ok(guarded.logs.some((l) => /no pattern has shown a positive return/.test(l)));
  assert.ok(guarded.state.closed.length < unguarded.state.closed.length, "fewer paid round trips");
  assert.ok(guarded.state.realizedPnlUSDC > unguarded.state.realizedPnlUSDC, `loses less: ${guarded.state.realizedPnlUSDC} vs ${unguarded.state.realizedPnlUSDC}`);
});

await test("keeps apart gains others caused from round trips only you traded", async () => {
  const mk = makeMarket([{ symbol: "QUIET", reserve: 300, drift: 0 }]);
  const state = M.newState({ wallet: ME, seed: 1 });
  await cycles(mk, state, { testSizeUSDC: 2, maxExposureUSDC: 2, maxLossUSDC: 10, holdSeconds: 1800 }, 3);
  assert.ok(state.closed.length >= 1);
  assert.equal(state.closed[0].othersTradedAfter, false);
  assert.ok(state.closed[0].returnPct < 0, "a round trip nobody else traded pays the fees");
  assert.match(M.report(state), /only you did/);
});

await test("an untouched curve is eligible by default, and a round trip there is recorded as yours alone", async () => {
  const mk = makeMarket([{ symbol: "FRESH", reserve: 0, soldPct: 0 }]);
  const state = M.newState({ wallet: ME, seed: 8 });
  const logs = await cycles(mk, state, { testSizeUSDC: 2, maxExposureUSDC: 2, maxLossUSDC: 4, holdSeconds: 1800 }, 3);
  assert.ok(state.closed.length >= 1, logs.join(" / "));
  assert.equal(state.closed[0].ownShareOfReserve, 1, "you were the whole market");
  assert.equal(state.closed[0].othersTradedAfter, false);
  assert.ok(state.closed[0].returnPct > -0.1 && state.closed[0].returnPct < 0, "sold back first: lost only the fees, " + state.closed[0].returnPct);
});

await test("discovery reaches the newest tokens even when the market is larger than one page", async () => {
  const specs = Array.from({ length: 150 }, (_, i) => ({ symbol: "V" + i, reserve: i < 140 ? 500 - i : 0 }));
  const mk = makeMarket(specs);
  globalThis.fetch = mk.fetch;
  const state = M.newState({ wallet: ME, seed: 1 });
  const out = await M.runCycle({ origin: "https://sim", apiKey: "k", state, dryRun: true, now: mk.now(), policy: { testSizeUSDC: 1, maxExposureUSDC: 1, maxLossUSDC: 1 } });
  const seen = Number(/of (\d+)/.exec(out.log.find((l) => l.startsWith("eligible")))[1]);
  assert.ok(seen >= 150, "saw " + seen + " of 150 (the 10 newest have no volume)");
});

await test("refuses an approval that is not exactly what the trade needs", async () => {
  const shop = "0x" + "f".repeat(40), usdc = "0x" + "e".repeat(40), evil = "0x" + "9".repeat(40);
  const approve = (spender, amt) => "0x095ea7b3" + spender.slice(2).padStart(64, "0") + BigInt(amt).toString(16).padStart(64, "0");
  const intent = (spender, amt, to = usdc) => ({ transaction: { to: shop, data: "0x12345678" }, requiredAllowance: { token: usdc, amount: "2000000" }, approvalTransaction: { to, data: approve(spender, amt) } });
  M.checkApproval(intent(shop, 2000000));
  assert.throws(() => M.checkApproval(intent(evil, 2000000)), /spender/);
  assert.throws(() => M.checkApproval(intent(shop, 10n ** 30n)), /amount/);
  assert.throws(() => M.checkApproval(intent(shop, 2000000, evil)), /targets/);
});

await test("a buy the index has not caught up with is reconciled from the real balance next cycle", async () => {
  const mk = makeMarket([{ symbol: "LAG", reserve: 300 }]);
  mk.lag.next = 3; // the next trade stays invisible to /me for three reads
  const state = M.newState({ wallet: ME, seed: 4 });
  globalThis.fetch = mk.fetch;
  const policy = { testSizeUSDC: 2, maxExposureUSDC: 2, maxLossUSDC: 4, holdSeconds: 1e9 };
  await M.runCycle({ origin: "https://sim", apiKey: "k", state, policy, send: mk.send, now: mk.now(), indexWait: { tries: 1, ms: 0 } });
  assert.equal(state.open.length, 1);
  assert.equal(state.open[0].indexed, false, "recorded as not yet indexed");
  mk.lag.next = 0;
  mk.lag.reads = 0;
  await M.runCycle({ origin: "https://sim", apiKey: "k", state, policy, send: mk.send, now: mk.now() + 60, indexWait: { tries: 1, ms: 0 } });
  assert.equal(state.open[0].indexed, true);
  assert.equal(state.open[0].tokens, mk.balances[state.open[0].aicToken].toString(), "tokens now match what is actually held");
});

await test("a position worth less than the minimum trade is written off, not retried forever", async () => {
  const mk = makeMarket([{ symbol: "SINK", reserve: 300 }]);
  const state = M.newState({ wallet: ME, seed: 6 });
  globalThis.fetch = mk.fetch;
  const policy = { testSizeUSDC: 0.0001, maxExposureUSDC: 0.0001, maxLossUSDC: 3, holdSeconds: 1800 };
  await M.runCycle({ origin: "https://sim", apiKey: "k", state, policy, send: mk.send, now: mk.now(), indexWait: { tries: 1, ms: 0 } });
  assert.equal(state.open.length, 1);
  // someone else buys, then everyone sells: the price falls under our entry and our 0.0001 USDC is now worth less than the minimum
  const t = mk.tokens[0];
  t.vT += (1_000_000_000n * 10n ** 18n) / 20n; // a large dump moves the curve against us
  mk.othersAct(60);
  const out = await M.runCycle({ origin: "https://sim", apiKey: "k", state, policy, send: mk.send, now: mk.now(), indexWait: { tries: 1, ms: 0 } });
  assert.equal(state.closed.length, 1, out.log.join(" / "));
  assert.equal(state.closed[0].writtenOff, true);
  assert.equal(state.closed[0].proceedsUSDC, 0, "counted as a full loss");
  assert.match(M.report(state), /written off/);
  assert.ok(!out.log.some((l) => /sell refused/.test(l)), "never sent to the exchange to be refused");
});

await test("dry run signs nothing", async () => {
  const mk = makeMarket([{ symbol: "A", reserve: 300 }, { symbol: "B", reserve: 300 }]);
  globalThis.fetch = mk.fetch;
  const state = M.newState({ wallet: ME, seed: 2 });
  const out = await M.runCycle({ origin: "https://sim", apiKey: "k", state, policy: { testSizeUSDC: 2, maxExposureUSDC: 4, maxLossUSDC: 2 }, dryRun: true, now: mk.now() });
  assert.equal(mk.sent.length, 0);
  assert.ok(out.actions.length >= 1);
  assert.equal(state.open.length, 0);
});

await test("the pure core runs in a bare vm with no fetch, require or console", async () => {
  const src = readFileSync(new URL("./alpha-the-market.js", import.meta.url), "utf8");
  const ctx = vm.createContext({});
  vm.runInContext(src + "; globalThis.M = AlphaTheMarket;", ctx);
  const r = vm.runInContext(`
    const s = M.newState({ wallet: "0x${"a".repeat(40)}", seed: 4 });
    const p = M.normalizePolicy({ testSizeUSDC: 1, maxExposureUSDC: 3, maxLossUSDC: 2 });
    const c = M.toCandidate({ aicToken: "0x${"1".repeat(40)}", phase: "bonding_curve", realUSDCReserve: { base: "50000000", decimals: 6 }, store: { protocol: { storeController: "0x${"2".repeat(40)}" } } }, s.wallet);
    JSON.stringify(M.selectEntries(s, [c], p).picks.map(x => x.aicToken));`, ctx);
  assert.equal(JSON.parse(r)[0], "0x" + "1".repeat(40));
});

await test("same seed, same decisions", async () => {
  const run = async () => {
    const mk = makeMarket(Array.from({ length: 10 }, (_, i) => ({ symbol: "R" + i, reserve: 150, drift: i % 2 ? 0.5 : -0.5 })), 3);
    const state = M.newState({ wallet: ME, seed: 77 });
    await cycles(mk, state, { testSizeUSDC: 2, maxExposureUSDC: 6, maxLossUSDC: 20, holdSeconds: 3600 }, 10);
    return JSON.stringify(state.closed.map((p) => p.symbol));
  };
  assert.equal(await run(), await run());
});

for (const r of results) console.log(r[0].padEnd(4), r[1], r[2] ? "\n     " + r[2] : "");
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
