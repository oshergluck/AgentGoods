/**
 * Alpha the market — a bounded exploration engine for AgentGoods store tokens.
 *
 * WHAT IT DOES. Turns uncertainty about which store tokens are worth holding into data, without
 * betting the wallet on a guess. Each cycle it:
 *
 *   1. DISCOVERS every token on the market (GET /api/v1/market/tokens);
 *   2. FILTERS out what breaks your hard limits — your own store, markets not on the curve, open
 *      takeovers, anything you exclude, and (only if you ask) thin curves or markets your test
 *      would dominate. An untouched curve is eligible by default: your buy is its reserve, and
 *      whether anyone follows you there is exactly what the test measures;
 *   3. SAMPLES a few of what is left — at random while it knows little, then more and more by what
 *      has actually worked, as closed tests accumulate;
 *   4. TESTS each with a small, capped buy (your size, your cap);
 *   5. MEASURES every open position each cycle by what the curve would pay for it now;
 *   6. EXITS on your take-profit, stop-loss or holding time;
 *   7. LEARNS: every closed test updates the record of the features that were present when it was
 *      opened, so the next selection leans toward what produced evidence and away from what did not.
 *
 * Explore -> measure -> learn -> reallocate. Exploration becomes less random as evidence grows.
 *
 * THE LIMITS ARE YOURS AND THEY BIND. There are no defaults for the three numbers that decide how
 * much you can lose: `testSizeUSDC`, `maxExposureUSDC` and `maxLossUSDC` must be set, and the engine
 * refuses to start without them. Once realised losses reach `maxLossUSDC`, it opens nothing new.
 *
 * IT KEEPS APART WHAT YOU CAUSED. Buying moves a bonding curve, so a test can change what it
 * measures. Every position records the real reserve before your buy, your own share of it, and
 * whether anyone else traded that token afterwards — so a gain produced only by your own trade is
 * never mistaken for the market agreeing with you.
 *
 * TWO LAYERS, like agentgoods-tx.js:
 *
 *   - The CORE is pure: no network, no timers, no Math.random, no imports. It runs in a bare
 *     sandbox. Randomness comes from a seeded generator stored in the state, so a run can be
 *     replayed exactly.
 *   - The DRIVER (`runCycle`) needs `fetch`, your API key, and a `send` function that signs with
 *     YOUR wallet, broadcasts, and resolves once the transaction is mined. The engine never sees a
 *     private key and cannot move anything you do not sign.
 *
 * USE
 *
 *     const M = AlphaTheMarket;                      // after evaluating this file
 *     let state = M.newState({ wallet: "0xYou", seed: 42 });
 *     const policy = { testSizeUSDC: 2, maxExposureUSDC: 10, maxLossUSDC: 6 };   // YOUR numbers
 *     const out = await M.runCycle({ origin, apiKey, state, policy,
 *                                    send: async (tx) => (await (await signer.sendTransaction(tx)).wait()).hash });
 *     state = out.state;            // persist it between cycles (a file in your workspace)
 *     console.log(M.report(state)); // what it holds, what it learned, what it caused
 *
 * `dryRun: true` does everything except sign: it discovers, filters, samples and quotes, and tells
 * you what it would have done.
 *
 * Not investment advice and no promise of return: the curve charges fees on every trade, so a round
 * trip in which nobody else trades loses money by construction. That is exactly what the
 * measurement is for.
 */

var AlphaTheMarket = (function () {
  "use strict";

  var VERSION = "1.0.0";
  var USDC = 1000000; // 6 decimals
  var MIN_TRADE_USDC = 0.0001; // the curve refuses anything smaller (BELOW_MINIMUM_TRADE)

  /* ─────────────────────────────── pure core ─────────────────────────────── */

  /** A small seeded PRNG (mulberry32). The seed lives in the state, so runs replay exactly. */
  function nextRandom(state) {
    var t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function newState(opts) {
    opts = opts || {};
    if (!opts.wallet || !/^0x[0-9a-fA-F]{40}$/.test(opts.wallet)) throw new Error("newState needs { wallet: '0x…' } — your own address, so your store is never a candidate");
    var seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : 1;
    return {
      version: VERSION,
      wallet: opts.wallet.toLowerCase(),
      rng: seed,
      cycles: 0,
      open: [], // { aicToken, storeId, tokens, costUSDC, openedAt, features, reserveBeforeUSDC, ownShareOfReserve, lastValueUSDC, lastMeasuredAt, othersTradedAfter, illiquidSince }
      closed: [], // same plus { proceedsUSDC, closedAt, returnPct, reason }
      patterns: {}, // "feature=value" -> { n, sumReturn, wins }
      realizedPnlUSDC: 0,
      haltedReason: null,
    };
  }

  /** The three limits have no defaults: they decide how much you can lose. */
  function normalizePolicy(p) {
    p = p || {};
    function need(name) {
      var v = Number(p[name]);
      if (!Number.isFinite(v) || v <= 0) throw new Error("policy." + name + " must be set to a positive number of USDC — it is your limit, not ours");
      return v;
    }
    var testSize = need("testSizeUSDC");
    if (testSize < MIN_TRADE_USDC) throw new Error("policy.testSizeUSDC must be at least " + MIN_TRADE_USDC + " USDC: the curve refuses smaller trades");
    var cap = need("maxExposureUSDC");
    if (cap < testSize) throw new Error("policy.maxExposureUSDC is below testSizeUSDC: not even one test would fit");
    var maxLoss = need("maxLossUSDC");
    if (maxLoss < testSize) throw new Error("policy.maxLossUSDC is below testSizeUSDC: a single test can lose up to its whole size, so none could be opened");
    return {
      testSizeUSDC: testSize,
      maxExposureUSDC: cap,
      maxLossUSDC: maxLoss,
      maxPositions: pos(p.maxPositions, 5),
      maxNewPerCycle: pos(p.maxNewPerCycle, 2),
      holdSeconds: pos(p.holdSeconds, 1800),
      takeProfitPct: pos(p.takeProfitPct, 0.25),
      stopLossPct: pos(p.stopLossPct, 0.2),
      // Both off by default: an untouched curve is where the earliest, most neglected opportunities
      // are, and your own buy is its reserve — you can sell back as long as you sell first. Set them
      // if you want only markets someone else already holds USDC in.
      minRealReserveUSDC: nonneg(p.minRealReserveUSDC, 0),
      maxShareOfReserve: pos(p.maxShareOfReserve, 1),
      slippageBps: nonneg(p.slippageBps, 100),
      minEpsilon: clamp01(p.minEpsilon, 0.1),
      priorStrength: pos(p.priorStrength, 3),
      // After this many closed tests, exploit only a pattern that has shown a positive return.
      evidenceBeforeExploit: pos(p.evidenceBeforeExploit, 10),
      excludeTokens: (p.excludeTokens || []).map(lower),
      excludeControllers: (p.excludeControllers || []).map(lower),
    };
  }
  function pos(v, d) { v = Number(v); return Number.isFinite(v) && v > 0 ? v : d; }
  function nonneg(v, d) { v = Number(v); return Number.isFinite(v) && v >= 0 ? v : d; }
  function clamp01(v, d) { v = Number(v); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : d; }
  function lower(s) { return String(s).toLowerCase(); }

  /** Base-unit field ({base} or a plain string) -> Number of whole units. */
  function units(field, decimals) {
    if (field === null || field === undefined) return 0;
    var raw = typeof field === "object" ? field.base : field;
    if (raw === undefined || raw === null || raw === "") return 0;
    var d = typeof field === "object" && Number.isFinite(field.decimals) ? field.decimals : decimals;
    return Number(raw) / Math.pow(10, d);
  }

  /** One market-token row -> the facts the engine decides on. */
  function toCandidate(row, wallet) {
    var controller = lower((((row || {}).store || {}).protocol || {}).storeController || "");
    var trades = Array.isArray(row.recentTrades) ? row.recentTrades : [];
    var reserve = units(row.realUSDCReserve, 6);
    var cand = {
      aicToken: lower(row.aicToken || ""),
      storeId: row.storeId,
      symbol: ((row.token || {}).symbol) || "?",
      controller: controller,
      phase: row.phase,
      graduationBlocked: row.graduationBlocked === true,
      takeoverOpen: !!row.takeoverCandidate,
      holders: Number(row.holderCount) || 0,
      realReserveUSDC: reserve,
      progressBps: Number(row.netSoldPercentageBps) || 0,
      volumeUSDC: units(row.lifetimeGrossVolumeUSDC, 6),
      commerceUSDC: units(((row.holderReserve || {}).storeLifetimeCommerceUSDC), 6),
      recentTrades: trades.map(function (t) { return { at: Number(t.at) || 0, side: t.side, trader: lower(t.trader || "") }; }),
      ownStore: controller === wallet,
    };
    cand.features = featuresOf(cand);
    return cand;
  }

  /** Coarse buckets, so a handful of closed tests can already say something. */
  function featuresOf(c) {
    var others = c.recentTrades.length;
    return [
      "holders=" + (c.holders <= 1 ? "0-1" : c.holders <= 4 ? "2-4" : "5+"),
      "reserve=" + (c.realReserveUSDC < 20 ? "<20" : c.realReserveUSDC < 200 ? "20-200" : "200+"),
      "progress=" + (c.progressBps < 500 ? "<5%" : c.progressBps < 2000 ? "5-20%" : "20%+"),
      "activity=" + (others === 0 ? "none" : others <= 3 ? "some" : "busy"),
      "commerce=" + (c.commerceUSDC > 0 ? "sales" : "none"),
    ];
  }

  /** Hard constraints. Returns null when eligible, or the reason it is not. */
  function ineligibleReason(c, state, policy) {
    if (!/^0x[0-9a-f]{40}$/.test(c.aicToken)) return "no token address";
    if (c.ownStore) return "your own store";
    if (policy.excludeTokens.indexOf(c.aicToken) >= 0) return "excluded token";
    if (policy.excludeControllers.indexOf(c.controller) >= 0) return "excluded controller";
    if (c.phase !== "bonding_curve") return "not on the curve (" + c.phase + ")";
    if (c.takeoverOpen) return "takeover in progress";
    if (c.realReserveUSDC < policy.minRealReserveUSDC) return "thin curve: " + c.realReserveUSDC.toFixed(2) + " USDC real reserve";
    if (policy.maxShareOfReserve < 1 && policy.testSizeUSDC / (c.realReserveUSDC + policy.testSizeUSDC) > policy.maxShareOfReserve) {
      return "your test would be most of this market — you would mostly measure yourself";
    }
    for (var i = 0; i < state.open.length; i++) if (state.open[i].aicToken === c.aicToken) return "already testing it";
    return null;
  }

  /** Shrunk mean return of one feature value: a pattern seen once says little. */
  function featureScore(state, f, k) {
    var p = state.patterns[f];
    if (!p || !p.n) return 0;
    return p.sumReturn / (p.n + k);
  }
  function scoreOf(state, c, policy) {
    var s = 0;
    for (var i = 0; i < c.features.length; i++) s += featureScore(state, c.features[i], policy.priorStrength);
    return s / c.features.length;
  }
  /** How random the next pick is: 1 with no evidence, falling toward minEpsilon as tests close. */
  function epsilon(state, policy) {
    var e = 1 / (1 + state.closed.length / 5);
    return Math.max(policy.minEpsilon, e);
  }

  function exposureUSDC(state) {
    var s = 0;
    for (var i = 0; i < state.open.length; i++) s += state.open[i].costUSDC;
    return s;
  }

  /**
   * Decide this cycle's entries. Pure: same state, same candidates, same decision.
   * Returns { picks: [candidate], skipped: [{symbol, reason}], epsilon }.
   */
  function selectEntries(state, candidates, policy) {
    var out = { picks: [], skipped: [], epsilon: epsilon(state, policy) };
    if (state.haltedReason) return out;
    /*
     * The loss cap is a worst case, not an average: a test can lose up to its whole size (a curve
     * others have drained cannot buy you back). So realised losses PLUS everything still open PLUS
     * the new test must fit inside maxLossUSDC — which makes the cap a bound, not a hope.
     */
    var lossSoFar = Math.max(0, -state.realizedPnlUSDC);
    if (policy.maxLossUSDC - lossSoFar < policy.testSizeUSDC) {
      state.haltedReason = "realised loss " + lossSoFar.toFixed(2) + " USDC leaves less than one test (" + policy.testSizeUSDC + " USDC) inside maxLossUSDC " + policy.maxLossUSDC;
      return out;
    }
    var eligible = [];
    for (var i = 0; i < candidates.length; i++) {
      var why = ineligibleReason(candidates[i], state, policy);
      if (why) out.skipped.push({ symbol: candidates[i].symbol, aicToken: candidates[i].aicToken, reason: why });
      else eligible.push(candidates[i]);
    }
    var room = Math.min(
      policy.maxNewPerCycle,
      policy.maxPositions - state.open.length,
      Math.floor((policy.maxExposureUSDC - exposureUSDC(state) + 1e-9) / policy.testSizeUSDC),
      // Never open a test that, lost in full on top of what is lost and what is open, breaches the cap.
      Math.floor((policy.maxLossUSDC - lossSoFar - exposureUSDC(state) + 1e-9) / policy.testSizeUSDC)
    );
    if (room <= 0 && eligible.length > 0) out.waitingReason = "limits leave no room for another test this cycle";
    while (room > 0 && eligible.length > 0) {
      var idx;
      if (nextRandom(state) < out.epsilon) {
        idx = Math.floor(nextRandom(state) * eligible.length); // explore: uniform over the eligible set
      } else {
        var best = -Infinity; idx = 0;
        for (var j = 0; j < eligible.length; j++) {
          var sc = scoreOf(state, eligible[j], policy) + nextRandom(state) * 1e-9; // random tie-break
          if (sc > best) { best = sc; idx = j; }
        }
        /*
         * Concentrate only on demonstrated edge. With enough closed tests and nothing that has
         * returned more than it cost, "the least bad" is still a loss: no exploit, only the
         * occasional exploration draw above.
         */
        if (state.closed.length >= policy.evidenceBeforeExploit && best <= 1e-9) {
          out.noEdge = "no pattern has shown a positive return after " + state.closed.length + " closed tests; exploring only";
          room--;
          continue;
        }
      }
      out.picks.push(eligible.splice(idx, 1)[0]);
      room--;
    }
    return out;
  }

  /** Should an open position close now? Returns a reason or null. */
  function exitReason(p, nowSec, policy) {
    if (p.lastValueUSDC !== null && p.lastValueUSDC !== undefined) {
      var r = (p.lastValueUSDC - p.costUSDC) / p.costUSDC;
      if (r >= policy.takeProfitPct) return "take-profit (" + pct(r) + ")";
      if (r <= -policy.stopLossPct) return "stop-loss (" + pct(r) + ")";
    }
    if (nowSec - p.openedAt >= policy.holdSeconds) return "holding time reached";
    return null;
  }
  function pct(x) { return (x * 100).toFixed(1) + "%"; }

  /** A closed test teaches every feature it was opened with. */
  function learn(state, position) {
    for (var i = 0; i < position.features.length; i++) {
      var f = position.features[i];
      var p = state.patterns[f] || (state.patterns[f] = { n: 0, sumReturn: 0, wins: 0 });
      p.n++;
      p.sumReturn += position.returnPct;
      if (position.returnPct > 0) p.wins++;
    }
  }

  function closePosition(state, p, proceedsUSDC, nowSec, reason) {
    var i = state.open.indexOf(p);
    if (i >= 0) state.open.splice(i, 1);
    p.proceedsUSDC = proceedsUSDC;
    p.closedAt = nowSec;
    p.reason = reason;
    p.returnPct = (proceedsUSDC - p.costUSDC) / p.costUSDC;
    state.realizedPnlUSDC += proceedsUSDC - p.costUSDC;
    state.closed.push(p);
    learn(state, p);
    return p;
  }

  /** A readable account of what it holds, what it learned and what it caused. */
  function report(state) {
    var lines = [];
    lines.push("Alpha the market v" + VERSION + " — " + state.cycles + " cycle(s), " + state.open.length + " open, " + state.closed.length + " closed");
    lines.push("realised P&L " + state.realizedPnlUSDC.toFixed(4) + " USDC; open cost " + exposureUSDC(state).toFixed(2) + " USDC" + (state.haltedReason ? "; HALTED: " + state.haltedReason : ""));
    for (var i = 0; i < state.open.length; i++) {
      var p = state.open[i];
      lines.push("  open " + p.symbol + ": cost " + p.costUSDC.toFixed(2) + ", now " + (p.lastValueUSDC === null ? "unmeasurable (illiquid)" : p.lastValueUSDC.toFixed(4)) +
        ", your share of reserve at entry " + pct(p.ownShareOfReserve) + (p.othersTradedAfter ? ", others traded after you" : ", nobody else has traded it since"));
    }
    var wo = state.writtenOff || [];
    if (wo.length) lines.push("written off (under the minimum trade, still in your wallet): " + wo.map(function (w) { return w.symbol; }).join(", "));
    var mine = 0, others = 0;
    for (var k = 0; k < state.closed.length; k++) (state.closed[k].othersTradedAfter ? others++ : mine++);
    if (state.closed.length) lines.push("closed tests: " + others + " where others traded after entry, " + mine + " where only you did (those measure your own fees, not the market)");
    var keys = Object.keys(state.patterns).sort();
    if (keys.length) {
      lines.push("what the evidence says so far (mean return per feature, n = closed tests):");
      for (var j = 0; j < keys.length; j++) {
        var s = state.patterns[keys[j]];
        lines.push("  " + keys[j] + ": n=" + s.n + ", mean " + pct(s.sumReturn / s.n) + ", wins " + s.wins);
      }
    }
    return lines.join("\n");
  }

  /* ─────────────────────────────── driver (needs fetch) ─────────────────────────────── */

  function requireFetch() {
    if (typeof fetch !== "function") throw new Error("runCycle needs fetch; the pure core (newState, selectEntries, exitReason, report) does not");
  }
  function idem(state, tag) {
    return "atm-" + state.wallet.slice(2, 10) + "-" + state.cycles + "-" + tag + "-" + Math.floor(nextRandom(state) * 1e9).toString(36);
  }

  async function api(origin, apiKey, method, path, body, extraHeaders) {
    var headers = { accept: "application/json" };
    if (apiKey) headers.authorization = "Bearer " + apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    for (var h in extraHeaders || {}) headers[h] = extraHeaders[h];
    var res = await fetch(origin.replace(/\/$/, "") + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    var text = await res.text();
    var json = null;
    try { json = JSON.parse(text); } catch (e) { /* keep text */ }
    return { ok: res.ok, status: res.status, body: json, text: text };
  }
  function errorOf(r) {
    var e = (r.body && r.body.error) || {};
    return (e.code || ("HTTP " + r.status)) + (e.message ? ": " + e.message : "");
  }

  /**
   * An approval is signed only if it is exactly what the intent says it needs: the token named in
   * requiredAllowance, the exact amount, and the contract of the transaction that follows as the
   * spender. Anything else — a different spender, a larger amount — is refused before signing.
   */
  function checkApproval(intent) {
    var a = intent.approvalTransaction, need = intent.requiredAllowance;
    if (!need) throw new Error("approvalTransaction without requiredAllowance — refusing to sign it");
    var data = lower(a.data || "");
    if (data.slice(0, 10) !== "0x095ea7b3" || data.length !== 138) throw new Error("approvalTransaction is not a plain ERC-20 approve — refusing to sign it");
    var spender = "0x" + data.slice(34, 74);
    var amount = BigInt("0x" + data.slice(74, 138));
    var wanted = BigInt(need.amount && need.amount.base !== undefined ? need.amount.base : need.amount);
    if (lower(a.to) !== lower(need.token)) throw new Error("approval targets " + a.to + ", not the token the intent names — refusing");
    if (spender !== lower(intent.transaction.to)) throw new Error("approval spender " + spender + " is not the contract being called — refusing");
    if (amount !== wanted) throw new Error("approval amount " + amount + " differs from the " + wanted + " the trade needs — refusing");
  }

  /** Signs an intent's approval (if any) and then its transaction, each through YOUR send(). */
  async function signIntent(intent, send) {
    if (!intent || !intent.transaction) throw new Error("the response carried no intent.transaction");
    var hashes = [];
    if (intent.approvalTransaction) { checkApproval(intent); hashes.push(await send(pickTx(intent.approvalTransaction))); }
    hashes.push(await send(pickTx(intent.transaction)));
    return hashes;
  }
  function pickTx(t) {
    var h = String(t.data || "").length - 2;
    if (h && (h - 8) % 64) throw new Error("calldata of " + h + " hex characters cannot be valid — refusing to sign it");
    return { to: t.to, data: t.data, value: t.value || "0" };
  }

  async function balances(origin, apiKey) {
    var me = await api(origin, apiKey, "GET", "/api/v1/me");
    if (!me.ok) throw new Error("GET /api/v1/me: " + errorOf(me));
    var map = {};
    var items = ((me.body || {}).aicPositions || {}).items || [];
    for (var i = 0; i < items.length; i++) map[lower(items[i].aicToken)] = String(items[i].balance && items[i].balance.base !== undefined ? items[i].balance.base : items[i].balance || "0");
    return map;
  }

  /** Wait for the index to show a balance change after a mined trade (mined is not indexed). */
  async function waitForBalance(origin, apiKey, token, before, direction, wait) {
    for (var i = 0; i < wait.tries; i++) {
      var now = await balances(origin, apiKey);
      var v = BigInt(now[token] || "0");
      if (direction > 0 ? v > before : v < before) return v;
      if (i + 1 < wait.tries && wait.ms > 0) await new Promise(function (r) { setTimeout(r, wait.ms); });
    }
    return null;
  }

  /**
   * One cycle: measure and exit open tests, then open new ones within your limits.
   * opts: { origin, apiKey, state, policy, send, dryRun?, now? }
   * Returns { state, log: [string], actions: [...] }. Persist `state` yourself.
   */
  async function runCycle(opts) {
    requireFetch();
    var origin = opts.origin, apiKey = opts.apiKey, state = opts.state, send = opts.send;
    var policy = normalizePolicy(opts.policy);
    var dry = !!opts.dryRun;
    if (!dry && typeof send !== "function") throw new Error("runCycle needs send(tx) that signs with your wallet and resolves once mined — or dryRun: true");
    if (!apiKey) throw new Error("runCycle needs your apiKey: quotes and trades are authenticated");
    var nowSec = opts.now || Math.floor(Date.now() / 1000);
    var wait = { tries: pos((opts.indexWait || {}).tries, 15), ms: nonneg((opts.indexWait || {}).ms, 2000) };
    var log = [], actions = [];
    state.cycles++;

    // 1. discover — two views merged, because one page sorted by volume would never show the
    //    newest, zero-volume tokens: the neglected ones this is for.
    var rows = [], seen = {};
    var views = ["volume", "newest"];
    for (var v = 0; v < views.length; v++) {
      var list = await api(origin, null, "GET", "/api/v1/market/tokens?limit=100&sort=" + views[v]);
      if (!list.ok) throw new Error("GET /api/v1/market/tokens: " + errorOf(list));
      var items = (list.body && list.body.items) || [];
      for (var it = 0; it < items.length; it++) {
        var key = lower(items[it].aicToken || "");
        if (!seen[key]) { seen[key] = true; rows.push(items[it]); }
      }
    }
    var candidates = rows.map(function (r) { return toCandidate(r, state.wallet); });
    var byToken = {};
    for (var i = 0; i < candidates.length; i++) byToken[candidates[i].aicToken] = candidates[i];

    // 2. reconcile buys that were not yet indexed, then measure every open test and note whether
    //    anyone else traded it after we entered
    if (state.open.some(function (q) { return q.indexed === false; })) {
      var held = await balances(origin, apiKey);
      for (var u = 0; u < state.open.length; u++) {
        var pu = state.open[u];
        if (pu.indexed !== false) continue;
        var nowHeld = BigInt(held[pu.aicToken] || "0") - BigInt(pu.heldBefore || "0");
        if (nowHeld > 0n) { pu.tokens = nowHeld.toString(); pu.indexed = true; }
      }
    }
    for (var o = 0; o < state.open.length; o++) {
      var p = state.open[o];
      var c = byToken[p.aicToken];
      if (c) {
        for (var t = 0; t < c.recentTrades.length; t++) {
          var tr = c.recentTrades[t];
          if (tr.trader !== state.wallet && tr.at > p.openedAt) p.othersTradedAfter = true;
        }
      }
      var q = await api(origin, apiKey, "POST", "/api/v1/stocks/" + p.aicToken + "/quote", { side: "sell", amount: p.tokens });
      if (q.ok) {
        p.lastValueUSDC = units(q.body.quote.expectedOutUSDC, 6);
        p.lastGrossUSDC = q.body.quote.grossUSDC !== undefined ? units(q.body.quote.grossUSDC, 6) : p.lastValueUSDC;
        p.illiquidSince = null;
      } else {
        p.lastValueUSDC = null;
        if (!p.illiquidSince) p.illiquidSince = nowSec;
        log.push(p.symbol + ": cannot be measured — " + errorOf(q));
      }
      p.lastMeasuredAt = nowSec;
    }

    // 3. exits
    var toClose = state.open.slice();
    for (var x = 0; x < toClose.length; x++) {
      var position = toClose[x];
      var why = exitReason(position, nowSec, policy);
      if (!why) continue;
      if (position.lastValueUSDC === null) { log.push(position.symbol + ": wants to exit (" + why + ") but the curve cannot pay now; holding"); continue; }
      /*
       * Below the exchange's minimum a position cannot be sold at all. Retrying would only collect
       * refusals and hold the slot forever, so it is written off: counted as a full loss (the cap
       * stays a bound) and learned from, while the tokens stay in your wallet and in the report.
       */
      if ((position.lastGrossUSDC !== undefined ? position.lastGrossUSDC : position.lastValueUSDC) < MIN_TRADE_USDC) {
        position.writtenOff = true;
        closePosition(state, position, 0, nowSec, why + "; worth under the " + MIN_TRADE_USDC + " USDC minimum trade, so unsellable — written off");
        (state.writtenOff = state.writtenOff || []).push({ symbol: position.symbol, aicToken: position.aicToken, tokens: position.tokens });
        log.push(position.symbol + ": written off — worth " + position.lastValueUSDC.toFixed(4) + " USDC, under the minimum trade; the tokens stay in your wallet");
        continue;
      }
      var minOut = Math.floor(position.lastValueUSDC * USDC * (1 - policy.slippageBps / 10000));
      actions.push({ type: "sell", symbol: position.symbol, aicToken: position.aicToken, tokens: position.tokens, expectedUSDC: position.lastValueUSDC, reason: why });
      if (dry) { log.push("[dry] would sell " + position.symbol + " for ~" + position.lastValueUSDC.toFixed(4) + " USDC: " + why); continue; }
      var sell = await api(origin, apiKey, "POST", "/api/v1/stocks/" + position.aicToken + "/sell", { amount: position.tokens, minOut: String(Math.max(minOut, 0)) }, { "idempotency-key": idem(state, "s") });
      if (!sell.ok) { log.push(position.symbol + ": sell refused — " + errorOf(sell)); continue; }
      try {
        var before = BigInt((await balances(origin, apiKey))[position.aicToken] || "0");
        await signIntent(sell.body.intent, send);
        await waitForBalance(origin, apiKey, position.aicToken, before, -1, wait);
        closePosition(state, position, position.lastValueUSDC, nowSec, why);
        log.push("sold " + position.symbol + ": " + why + ", return " + pct(position.returnPct) + (position.othersTradedAfter ? "" : " (nobody else traded it — this measured your own fees)"));
      } catch (e) {
        log.push(position.symbol + ": sell not completed — " + (e && e.message ? e.message : e));
      }
    }

    // 4. select and open new tests
    var sel = selectEntries(state, candidates, policy);
    if (state.haltedReason) log.push("no new tests: " + state.haltedReason);
    else if (sel.waitingReason) log.push("no new tests this cycle: " + sel.waitingReason);
    if (sel.noEdge) log.push(sel.noEdge);
    log.push("eligible after filters: " + (candidates.length - sel.skipped.length) + " of " + candidates.length + "; exploring with epsilon " + sel.epsilon.toFixed(2));
    var bal = null;
    for (var s = 0; s < sel.picks.length; s++) {
      var cand = sel.picks[s];
      var sizeBase = String(Math.round(policy.testSizeUSDC * USDC));
      var qb = await api(origin, apiKey, "POST", "/api/v1/stocks/" + cand.aicToken + "/quote", { side: "buy", amount: sizeBase });
      if (!qb.ok) { log.push(cand.symbol + ": no buy quote — " + errorOf(qb)); continue; }
      var expected = BigInt(qb.body.quote.expectedOutAIC.base !== undefined ? qb.body.quote.expectedOutAIC.base : qb.body.quote.expectedOutAIC);
      var minOutAic = (expected * BigInt(10000 - Math.round(policy.slippageBps))) / 10000n;
      actions.push({ type: "buy", symbol: cand.symbol, aicToken: cand.aicToken, sizeUSDC: policy.testSizeUSDC, features: cand.features });
      if (dry) { log.push("[dry] would buy " + cand.symbol + " for " + policy.testSizeUSDC + " USDC (" + cand.features.join(", ") + ")"); continue; }
      var buy = await api(origin, apiKey, "POST", "/api/v1/stocks/" + cand.aicToken + "/buy", { amount: sizeBase, minOut: minOutAic.toString() }, { "idempotency-key": idem(state, "b") });
      if (!buy.ok) { log.push(cand.symbol + ": buy refused — " + errorOf(buy)); continue; }
      try {
        if (!bal) bal = await balances(origin, apiKey);
        var had = BigInt(bal[cand.aicToken] || "0");
        await signIntent(buy.body.intent, send);
        var after = await waitForBalance(origin, apiKey, cand.aicToken, had, +1, wait);
        var got = after === null ? expected : after - had;
        bal[cand.aicToken] = (had + got).toString();
        state.open.push({
          aicToken: cand.aicToken, storeId: cand.storeId, symbol: cand.symbol,
          tokens: got.toString(), costUSDC: policy.testSizeUSDC, openedAt: nowSec, features: cand.features,
          reserveBeforeUSDC: cand.realReserveUSDC,
          ownShareOfReserve: policy.testSizeUSDC / (cand.realReserveUSDC + policy.testSizeUSDC),
          lastValueUSDC: null, lastMeasuredAt: null, othersTradedAfter: false, illiquidSince: null,
          indexed: after !== null, heldBefore: had.toString(),
        });
        log.push("bought " + cand.symbol + " for " + policy.testSizeUSDC + " USDC" + (after === null ? " (not yet indexed; recorded the quoted amount)" : ""));
      } catch (e) {
        log.push(cand.symbol + ": buy not completed — " + (e && e.message ? e.message : e));
      }
    }
    return { state: state, log: log, actions: actions };
  }

  return {
    VERSION: VERSION,
    newState: newState,
    normalizePolicy: normalizePolicy,
    toCandidate: toCandidate,
    featuresOf: featuresOf,
    ineligibleReason: ineligibleReason,
    selectEntries: selectEntries,
    exitReason: exitReason,
    closePosition: closePosition,
    checkApproval: checkApproval,
    learn: learn,
    report: report,
    runCycle: runCycle,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = AlphaTheMarket;
