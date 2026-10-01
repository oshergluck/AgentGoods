/**
 * Alpha AIC Arbitrage Tool — finds and executes incentive arbitrage on AgentGoods.
 *
 * THE OPPORTUNITY. Buying a product can also pay the buyer the store's own token (AIC) from the
 * store's customer incentive pool. When the AIC received for N units can be SOLD for more USDC than
 * the N units cost — after the curve's fees, the price impact of the sale, and gas — buying the
 * product and selling the reward is a profit, and the buyer keeps the product too. It appears when
 * a store funds a pool that is large relative to its price.
 *
 * WHAT IT DOES, each cycle:
 *   0. SETTLES first: any reward bought earlier and not yet sold (the indexer was behind, or the
 *      sale was refused) is sold now. This runs even after a halt — it only reduces risk;
 *   1. SCANS every listed product (GET /api/v1/market/products, every page) and ranks them by what
 *      one unit's reward is worth per USDC it costs — the listing itself has no incentive order;
 *   2. PRE-FILTERS cheaply: the per-unit reward valued at the token's current price against the
 *      unit price — anything clearly unprofitable is dropped before a single quote is spent;
 *   3. PRICES each survivor exactly for several unit counts: the product quote (cost and the exact
 *      reward for that many units) and a sell quote for that reward (what it really fetches);
 *   4. PICKS the unit count with the highest net profit after gas, if it clears your minimums;
 *   5. RE-QUOTES that choice immediately before buying — other buyers shrink the pool — and skips
 *      it if it no longer clears your minimums;
 *   6. EXECUTES within your limits: purchase (approval checked before signing), wait for the
 *      reward to arrive, sell exactly what arrived with slippage protection;
 *   7. RECORDS every trade: expected and realised profit, so you see whether the edge was real.
 *      When nothing qualifies it says how close the best candidate came (`nearMisses`), so "no
 *      opportunity" is a measurement, not a silence.
 *
 * YOUR LIMITS, no defaults: maxSpendPerTradeUSDC, maxTotalSpendUSDC, maxLossUSDC, minProfitUSDC.
 * Once realised losses reach maxLossUSDC it stops. The 0.0001 USDC minimum trade applies to the sale: a
 * reward worth less cannot be sold, so such an opportunity is not taken.
 *
 * TWO LAYERS: a pure core (no network, no imports; runs in a bare sandbox) and a driver
 * (`runCycle`) that needs fetch, your API key and a `send(tx)` that signs with YOUR wallet and
 * resolves once mined. It never sees a private key.
 *
 *     const A = AlphaAicArbitrage;
 *     let state = A.newState({ wallet: "0xYou" });
 *     const policy = { maxSpendPerTradeUSDC: 20, maxTotalSpendUSDC: 100, maxLossUSDC: 10, minProfitUSDC: 0.25 };
 *     const out = await A.runCycle({ origin, apiKey, state, policy, send });   // or dryRun: true
 *     console.log(A.report(out.state));
 *
 * Not a promise of profit: an opportunity others see too can close between the re-quote and the
 * moment your purchase lands, and the pool shrinks with every unit anyone buys. Realised profit is
 * measured at the sell quote; your wallet's USDC balance is the final word.
 *
 * Keep `state` between cycles (it is plain JSON): it carries unsold rewards, spend and losses.
 */

var AlphaAicArbitrage = (function () {
  "use strict";

  var VERSION = "1.0.0";
  var USDC = 1000000;
  var MIN_TRADE_USDC = 0.0001;
  var TX_PER_ROUND_TRIP = 4; // approve USDC, purchase, approve AIC, sell

  function lower(s) { return String(s || "").toLowerCase(); }
  function pos(v, d) { v = Number(v); return Number.isFinite(v) && v > 0 ? v : d; }
  function nonneg(v, d) { v = Number(v); return Number.isFinite(v) && v >= 0 ? v : d; }
  function baseOf(f) { return f && typeof f === "object" ? String(f.base) : String(f == null ? "0" : f); }
  function units6(f) { return Number(baseOf(f)) / USDC; }

  function newState(opts) {
    opts = opts || {};
    if (!opts.wallet || !/^0x[0-9a-fA-F]{40}$/.test(opts.wallet)) throw new Error("newState needs { wallet: '0x…' } — yours, so your own store is never traded");
    return { version: VERSION, wallet: lower(opts.wallet), cycles: 0, trades: [], spentUSDC: 0, realizedPnlUSDC: 0, haltedReason: null };
  }

  /** Four limits with no defaults — they decide what you can spend and lose. */
  function normalizePolicy(p) {
    p = p || {};
    function need(name) {
      var v = Number(p[name]);
      if (!Number.isFinite(v) || v <= 0) throw new Error("policy." + name + " must be set to a positive number of USDC — it is your limit, not ours");
      return v;
    }
    var perTrade = need("maxSpendPerTradeUSDC");
    var total = need("maxTotalSpendUSDC");
    if (total < perTrade) throw new Error("policy.maxTotalSpendUSDC is below maxSpendPerTradeUSDC");
    return {
      maxSpendPerTradeUSDC: perTrade,
      maxTotalSpendUSDC: total,
      maxLossUSDC: need("maxLossUSDC"),
      minProfitUSDC: need("minProfitUSDC"),
      minMarginPct: nonneg(p.minMarginPct, 0.05),
      maxUnits: Math.min(365, Math.floor(pos(p.maxUnits, 50))),
      gasCostPerTxUSDC: nonneg(p.gasCostPerTxUSDC, 0.02),
      slippageBps: nonneg(p.slippageBps, 100),
      prefilterRatio: nonneg(p.prefilterRatio, 0.9),
      maxQuotesPerCycle: Math.floor(pos(p.maxQuotesPerCycle, 24)),
      maxPages: Math.floor(pos(p.maxPages, 5)),
      excludeStores: (p.excludeStores || []).map(lower),
      excludeSellers: (p.excludeSellers || []).map(lower),
    };
  }

  /** One market product row -> what the scan decides on. */
  function toListing(row, priceByToken) {
    var store = ((row || {}).store || {}).protocol || {};
    var proto = (row || {}).protocol || {};
    var inc = (row || {}).incentive || {};
    var token = lower(store.tokenAddress);
    var perUnitAIC = Number(baseOf(inc.perUnitAIC)) / 1e18;
    var price1e18 = priceByToken[token] || "0";
    return {
      storeId: proto.storeId,
      productId: proto.productId,
      storeType: proto.storeType,
      active: proto.active !== false,
      controller: lower(store.storeController),
      aicToken: token,
      symbol: store.tokenSymbol || "?",
      unitPriceUSDC: units6(proto.priceUSDC),
      perUnitAIC: perUnitAIC,
      // USDC per whole token at the indexed price; a reward's value before the sale's own impact.
      perUnitValueUSDC: perUnitAIC * (Number(price1e18) / 1e18),
    };
  }

  /** Cheap reasons to skip before spending quotes. Returns null when worth pricing. */
  function skipReason(l, state, policy) {
    if (!l.active) return "inactive";
    if (!/^0x[0-9a-f]{40}$/.test(l.aicToken)) return "no token";
    if (l.controller === state.wallet) return "your own store";
    if (policy.excludeStores.indexOf(lower(l.storeId)) >= 0) return "excluded store";
    if (policy.excludeSellers.indexOf(l.controller) >= 0) return "excluded seller";
    if (!(l.perUnitAIC > 0)) return "no incentive";
    if (!(l.unitPriceUSDC > 0)) return "free product";
    if (l.perUnitValueUSDC < l.unitPriceUSDC * policy.prefilterRatio) return "reward worth less than the price";
    return null;
  }

  /** The unit counts worth quoting: a spread from 1 up to what the per-trade budget allows. */
  function candidateUnits(unitPriceUSDC, policy) {
    var cap = Math.min(policy.maxUnits, Math.floor(policy.maxSpendPerTradeUSDC / unitPriceUSDC));
    if (cap < 1) return [];
    var out = [], seen = {};
    [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 365, cap].forEach(function (n) {
      if (n >= 1 && n <= cap && !seen[n]) { seen[n] = true; out.push(n); }
    });
    return out.sort(function (a, b) { return a - b; });
  }

  /** Net profit of one priced option. Pure: all inputs are quotes already obtained. */
  function evaluate(option, policy) {
    var gas = policy.gasCostPerTxUSDC * TX_PER_ROUND_TRIP;
    var profit = option.sellNetUSDC - option.costUSDC - gas;
    return {
      units: option.units,
      costUSDC: option.costUSDC,
      rewardAIC: option.rewardAIC,
      sellGrossUSDC: option.sellGrossUSDC,
      sellNetUSDC: option.sellNetUSDC,
      gasUSDC: gas,
      profitUSDC: profit,
      marginPct: option.costUSDC > 0 ? profit / option.costUSDC : 0,
      sellable: option.sellGrossUSDC >= MIN_TRADE_USDC,
    };
  }

  /** The best option that clears every minimum, or null. */
  function choose(options, policy, state) {
    var remaining = policy.maxTotalSpendUSDC - state.spentUSDC;
    var best = null;
    for (var i = 0; i < options.length; i++) {
      var e = options[i];
      if (!e.sellable) continue;
      if (e.costUSDC > policy.maxSpendPerTradeUSDC || e.costUSDC > remaining) continue;
      if (e.profitUSDC < policy.minProfitUSDC || e.marginPct < policy.minMarginPct) continue;
      if (!best || e.profitUSDC > best.profitUSDC) best = e;
    }
    return best;
  }

  /** The option nearest to profit, for telling the caller how far off the market is. */
  function closest(options) {
    var best = null;
    for (var i = 0; i < options.length; i++) {
      var e = options[i];
      if (!best || (e.sellable && !best.sellable) || (e.sellable === best.sellable && e.profitUSDC > best.profitUSDC)) best = e;
    }
    return best;
  }

  function report(state) {
    var lines = [];
    lines.push("Alpha AIC Arbitrage v" + VERSION + " — " + state.cycles + " cycle(s), " + state.trades.length + " trade(s)");
    lines.push("spent " + state.spentUSDC.toFixed(2) + " USDC; realised P&L " + state.realizedPnlUSDC.toFixed(4) + " USDC" + (state.haltedReason ? "; HALTED: " + state.haltedReason : ""));
    for (var i = 0; i < state.trades.length; i++) {
      var t = state.trades[i];
      lines.push("  " + t.symbol + " x" + t.units + ": cost " + t.costUSDC.toFixed(4) + ", expected +" + t.expectedProfitUSDC.toFixed(4) +
        (t.pendingSale ? ", sale pending" : t.realizedProfitUSDC === null ? ", not bought" : ", realised at the sell quote " + (t.realizedProfitUSDC >= 0 ? "+" : "") + t.realizedProfitUSDC.toFixed(4)) +
        (t.note ? " (" + t.note + ")" : ""));
    }
    return lines.join("\n");
  }

  /* ──────────────────────────────── driver (needs fetch) ──────────────────────────────── */

  async function api(origin, apiKey, method, path, body, extra) {
    var headers = { accept: "application/json" };
    if (apiKey) headers.authorization = "Bearer " + apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    for (var h in extra || {}) headers[h] = extra[h];
    var res = await fetch(origin.replace(/\/$/, "") + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    var text = await res.text();
    var json = null;
    try { json = JSON.parse(text); } catch (e) { /* keep text */ }
    return { ok: res.ok, status: res.status, body: json };
  }
  function errorOf(r) { var e = (r.body && r.body.error) || {}; return (e.code || "HTTP " + r.status) + (e.message ? ": " + e.message : ""); }

  /** An approval is signed only if it is exactly what the intent says it needs. */
  function checkApproval(intent) {
    var a = intent.approvalTransaction, need = intent.requiredAllowance;
    if (!need) throw new Error("approvalTransaction without requiredAllowance — refusing to sign it");
    var data = lower(a.data);
    if (data.slice(0, 10) !== "0x095ea7b3" || data.length !== 138) throw new Error("approvalTransaction is not a plain ERC-20 approve — refusing");
    var spender = "0x" + data.slice(34, 74);
    var amount = BigInt("0x" + data.slice(74, 138));
    var wanted = BigInt(baseOf(need.amount));
    if (lower(a.to) !== lower(need.token)) throw new Error("approval targets " + a.to + ", not the token the intent names — refusing");
    if (spender !== lower(intent.transaction.to)) throw new Error("approval spender is not the contract being called — refusing");
    if (amount !== wanted) throw new Error("approval amount differs from what the trade needs — refusing");
  }
  function pickTx(t) {
    var h = String(t.data || "").length - 2;
    if (h && (h - 8) % 64) throw new Error("calldata of " + h + " hex characters cannot be valid — refusing to sign it");
    return { to: t.to, data: t.data, value: t.value || "0" };
  }
  async function signIntent(intent, send) {
    if (!intent || !intent.transaction) throw new Error("the response carried no intent.transaction");
    if (intent.approvalTransaction) { checkApproval(intent); await send(pickTx(intent.approvalTransaction)); }
    return send(pickTx(intent.transaction));
  }
  async function aicBalance(origin, apiKey, token) {
    var me = await api(origin, apiKey, "GET", "/api/v1/me");
    if (!me.ok) throw new Error("GET /api/v1/me: " + errorOf(me));
    var items = ((me.body || {}).aicPositions || {}).items || [];
    for (var i = 0; i < items.length; i++) if (lower(items[i].aicToken) === token) return BigInt(baseOf(items[i].balance));
    return 0n;
  }

  /**
   * Sells `amount` of a trade's reward at a fresh quote with a slippage floor. On success the
   * trade is settled; on failure it stays pending with the reason, for the next cycle to retry.
   */
  async function sellReward(ctx, trade, amount) {
    var sq = await api(ctx.origin, ctx.apiKey, "POST", "/api/v1/stocks/" + trade.aicToken + "/quote", { side: "sell", amount: amount.toString() });
    if (!sq.ok) { trade.note = "cannot sell now: " + errorOf(sq); return false; }
    var net = units6(sq.body.quote.expectedOutUSDC);
    var minOut = Math.floor(net * USDC * (1 - ctx.policy.slippageBps / 10000));
    trade.sellAttempts = (trade.sellAttempts || 0) + 1;
    var key = "arb-" + ctx.state.wallet.slice(2, 10) + "-" + trade.at.toString(36) + "-s" + trade.sellAttempts;
    var sell = await api(ctx.origin, ctx.apiKey, "POST", "/api/v1/stocks/" + trade.aicToken + "/sell", { amount: amount.toString(), minOut: String(minOut) }, { "idempotency-key": key });
    if (!sell.ok) { trade.note = "sell refused: " + errorOf(sell); return false; }
    await signIntent(sell.body.intent, ctx.send);
    trade.realizedProfitUSDC = net - trade.costUSDC - trade.gasUSDC;
    trade.pendingSale = false;
    trade.note = "";
    ctx.state.realizedPnlUSDC += trade.realizedProfitUSDC;
    return true;
  }

  /** Retries every reward bought earlier and not yet sold. Runs even when halted: it only reduces risk. */
  async function settlePending(ctx, log) {
    for (var i = 0; i < ctx.state.trades.length; i++) {
      var t = ctx.state.trades[i];
      if (!t.pendingSale) continue;
      try {
        var amount = t.rewardAIC ? BigInt(t.rewardAIC) : 0n;
        if (amount === 0n) {
          var now = await aicBalance(ctx.origin, ctx.apiKey, t.aicToken);
          var before = BigInt(t.balanceBefore || "0");
          if (now <= before) { log.push("pending " + t.symbol + ": reward still not indexed"); continue; }
          amount = now - before;
          t.rewardAIC = amount.toString();
        }
        if (await sellReward(ctx, t, amount)) log.push("pending " + t.symbol + " sold: realised at the sell quote " + (t.realizedProfitUSDC >= 0 ? "+" : "") + t.realizedProfitUSDC.toFixed(4) + " USDC");
        else log.push("pending " + t.symbol + ": " + t.note);
      } catch (e) {
        t.note = "retry failed: " + (e && e.message ? e.message : e);
        log.push("pending " + t.symbol + ": " + t.note);
      }
    }
  }

  /** Product quote + sell quote for `units`, evaluated; null when either side cannot be priced. */
  async function priceOption(ctx, l, n) {
    var pq = await api(ctx.origin, ctx.apiKey, "POST", "/api/v1/stores/" + l.storeId + "/products/" + l.productId + "/quote", { units: n });
    if (!pq.ok) return null;
    var reward = BigInt(baseOf(pq.body.quote.expectedRewardAIC));
    if (reward === 0n) return null;
    var sq = await api(ctx.origin, ctx.apiKey, "POST", "/api/v1/stocks/" + l.aicToken + "/quote", { side: "sell", amount: reward.toString() });
    if (!sq.ok) return null;
    var e = evaluate({ units: n, costUSDC: units6(pq.body.quote.gross), rewardAIC: reward.toString(), sellGrossUSDC: units6(sq.body.quote.grossUSDC), sellNetUSDC: units6(sq.body.quote.expectedOutUSDC) }, ctx.policy);
    e.execution = pq.body.execution;
    return e;
  }

  function hasPending(state, token) {
    for (var i = 0; i < state.trades.length; i++) if (state.trades[i].pendingSale && state.trades[i].aicToken === token) return true;
    return false;
  }

  /**
   * One cycle: settle earlier unsold rewards, then scan, price, choose, and (unless dryRun)
   * execute at most one round trip.
   * opts: { origin, apiKey, state, policy, send?, dryRun?, indexWait?: {tries, ms} }
   */
  function ratioOf(l) { return l.unitPriceUSDC > 0 ? l.perUnitValueUSDC / l.unitPriceUSDC : 0; }

  /** Follows pageInfo.nextCursor up to maxPages pages of 100. */
  async function allPages(origin, path, maxPages) {
    var items = [], cursor = null;
    for (var pg = 0; pg < maxPages; pg++) {
      var r = await api(origin, null, "GET", path + "?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      if (!r.ok) throw new Error("GET " + path + ": " + errorOf(r));
      items = items.concat(((r.body || {}).items) || []);
      var info = (r.body || {}).pageInfo || {};
      if (!info.hasMore || !info.nextCursor) break;
      cursor = info.nextCursor;
    }
    return items;
  }

  async function runCycle(opts) {
    if (typeof fetch !== "function") throw new Error("runCycle needs fetch; the pure core does not");
    var origin = opts.origin, apiKey = opts.apiKey, state = opts.state, send = opts.send;
    var policy = normalizePolicy(opts.policy);
    var dry = !!opts.dryRun;
    if (!apiKey) throw new Error("runCycle needs your apiKey: quotes and purchases are authenticated");
    if (!dry && typeof send !== "function") throw new Error("runCycle needs send(tx) that signs with your wallet and resolves once mined — or dryRun: true");
    var wait = { tries: pos((opts.indexWait || {}).tries, 15), ms: nonneg((opts.indexWait || {}).ms, 2000) };
    var log = [], found = [], nearMisses = [];
    state.cycles++;

    var ctx = { origin: origin, apiKey: apiKey, state: state, policy: policy, send: send };
    if (!dry) await settlePending(ctx, log);

    var lossSoFar = Math.max(0, -state.realizedPnlUSDC);
    if (lossSoFar >= policy.maxLossUSDC) state.haltedReason = "realised loss " + lossSoFar.toFixed(2) + " USDC reached maxLossUSDC";
    if (state.spentUSDC >= policy.maxTotalSpendUSDC) state.haltedReason = "maxTotalSpendUSDC reached";
    if (state.haltedReason) { log.push("halted: " + state.haltedReason); return { state: state, log: log, opportunities: found, nearMisses: nearMisses }; }

    var priceByToken = {};
    (await allPages(origin, "/api/v1/market/tokens", policy.maxPages)).forEach(function (t) { priceByToken[lower(t.aicToken)] = String(t.currentIndexedPrice1e18 || "0"); });
    // The products listing has no incentive ordering, so every page is read and ranked here: the
    // indexed value of what one unit pays, per USDC it costs. Quotes are spent top-down.
    var listings = (await allPages(origin, "/api/v1/market/products", policy.maxPages)).map(function (r) { return toListing(r, priceByToken); });
    listings.sort(function (x, y) { return ratioOf(y) - ratioOf(x); });
    var skipped = 0, quotes = 0;

    for (var i = 0; i < listings.length && quotes < policy.maxQuotesPerCycle; i++) {
      var l = listings[i];
      var why = skipReason(l, state, policy) || (hasPending(state, l.aicToken) ? "unsold reward pending" : null);
      if (why) { skipped++; continue; }
      var options = [];
      var ns = candidateUnits(l.unitPriceUSDC, policy);
      for (var k = 0; k < ns.length && quotes < policy.maxQuotesPerCycle; k++) {
        var n = ns[k];
        var pq = await api(origin, apiKey, "POST", "/api/v1/stores/" + l.storeId + "/products/" + l.productId + "/quote", { units: n });
        quotes++;
        if (!pq.ok) { log.push(l.symbol + " x" + n + ": no product quote — " + errorOf(pq)); break; }
        var reward = BigInt(baseOf(pq.body.quote.expectedRewardAIC));
        if (reward === 0n) break;
        var sq = await api(origin, apiKey, "POST", "/api/v1/stocks/" + l.aicToken + "/quote", { side: "sell", amount: reward.toString() });
        quotes++;
        if (!sq.ok) { options.push(evaluate({ units: n, costUSDC: units6(pq.body.quote.gross), rewardAIC: reward.toString(), sellGrossUSDC: 0, sellNetUSDC: 0 }, policy)); continue; }
        options.push(evaluate({
          units: n,
          costUSDC: units6(pq.body.quote.gross),
          rewardAIC: reward.toString(),
          sellGrossUSDC: units6(sq.body.quote.grossUSDC),
          sellNetUSDC: units6(sq.body.quote.expectedOutUSDC),
        }, policy));
        options[options.length - 1].execution = pq.body.execution;
      }
      var best = choose(options, policy, state);
      if (best) found.push({ listing: l, best: best });
      else {
        var near = closest(options);
        if (near) nearMisses.push({ symbol: l.symbol, storeId: l.storeId, productId: l.productId, units: near.units, costUSDC: near.costUSDC, sellNetUSDC: near.sellNetUSDC, profitUSDC: near.profitUSDC, sellable: near.sellable });
      }
    }
    log.push("scanned " + listings.length + " products; " + skipped + " skipped cheaply; " + quotes + " quotes; " + found.length + " opportunity(ies)");
    if (found.length === 0 && nearMisses.length) {
      nearMisses.sort(function (x, y) { return y.profitUSDC - x.profitUSDC; });
      var m = nearMisses[0];
      log.push("closest: " + m.symbol + " x" + m.units + " — cost " + m.costUSDC.toFixed(4) + ", reward sells for " + m.sellNetUSDC.toFixed(4) + ", " + (m.profitUSDC >= 0 ? "+" : "") + m.profitUSDC.toFixed(4) + " USDC after gas" + (m.sellable ? "" : " (reward below the 0.0001 USDC sale minimum)"));
    }
    if (found.length === 0) return { state: state, log: log, opportunities: found, nearMisses: nearMisses };

    found.sort(function (a, b) { return b.best.profitUSDC - a.best.profitUSDC; });
    var top = found[0], L = top.listing, B = top.best;
    log.push("best: " + L.symbol + " x" + B.units + " — cost " + B.costUSDC.toFixed(4) + ", reward sells for " + B.sellNetUSDC.toFixed(4) + ", expected profit " + B.profitUSDC.toFixed(4) + " USDC after gas");
    if (dry) { log.push("[dry] would buy and sell"); return { state: state, log: log, opportunities: found, nearMisses: nearMisses }; }

    // Re-price right before buying. The scan may be minutes old, and every other buyer of this
    // product shrinks the pool: the reward that made the trade profitable may no longer be there.
    var fresh = await priceOption(ctx, L, B.units);
    if (!fresh || !choose([fresh], policy, state)) {
      log.push("re-quote before buying: " + (fresh ? "profit now " + fresh.profitUSDC.toFixed(4) + " USDC, below your minimum — skipped" : "no longer priceable — skipped"));
      return { state: state, log: log, opportunities: found, nearMisses: nearMisses };
    }
    B = fresh;

    var trade = { id: state.trades.length + 1, at: Date.now(), symbol: L.symbol, storeId: L.storeId, productId: L.productId, aicToken: L.aicToken, units: B.units, costUSDC: B.costUSDC, gasUSDC: B.gasUSDC, expectedProfitUSDC: B.profitUSDC, realizedProfitUSDC: null, pendingSale: false, balanceBefore: null, rewardAIC: null, note: "" };
    try {
      var before = await aicBalance(origin, apiKey, L.aicToken);
      trade.balanceBefore = before.toString();
      var endpoint = String((B.execution || {}).endpoint || ("/api/v1/stores/" + L.storeId + "/products/" + L.productId + "/purchase")).replace(/^https?:\/\/[^/]+/, "");
      var buy = await api(origin, apiKey, "POST", endpoint, (B.execution || {}).body, { "idempotency-key": "arb-" + state.wallet.slice(2, 10) + "-" + trade.at.toString(36) + "-b" });
      if (!buy.ok) { log.push("purchase refused — " + errorOf(buy)); return { state: state, log: log, opportunities: found, nearMisses: nearMisses }; }
      await signIntent(buy.body.intent, send);
      state.spentUSDC += B.costUSDC;
      trade.pendingSale = true;
      state.trades.push(trade);
      var got = 0n;
      for (var t = 0; t < wait.tries; t++) {
        var now = await aicBalance(origin, apiKey, L.aicToken);
        if (now > before) { got = now - before; break; }
        if (t + 1 < wait.tries && wait.ms > 0) await new Promise(function (r) { setTimeout(r, wait.ms); });
      }
      if (got === 0n) { trade.note = "reward not indexed yet; the next cycle sells it"; log.push("bought " + L.symbol + " x" + B.units + "; reward not indexed yet — the next cycle sells it"); return { state: state, log: log, opportunities: found, nearMisses: nearMisses }; }
      trade.rewardAIC = got.toString();
      if (!(await sellReward(ctx, trade, got))) { log.push("bought; " + trade.note + " — the next cycle retries"); return { state: state, log: log, opportunities: found, nearMisses: nearMisses }; }
      log.push("round trip " + L.symbol + " x" + B.units + ": realised at the sell quote " + (trade.realizedProfitUSDC >= 0 ? "+" : "") + trade.realizedProfitUSDC.toFixed(4) + " USDC (expected " + B.profitUSDC.toFixed(4) + "; your wallet's USDC is the final word)");
    } catch (e) {
      trade.note = "not completed: " + (e && e.message ? e.message : e) + (trade.pendingSale ? " — the next cycle retries the sale" : "");
      log.push(trade.note);
    }
    return { state: state, log: log, opportunities: found, nearMisses: nearMisses };
  }

  return {
    VERSION: VERSION,
    newState: newState,
    normalizePolicy: normalizePolicy,
    toListing: toListing,
    skipReason: skipReason,
    candidateUnits: candidateUnits,
    evaluate: evaluate,
    choose: choose,
    checkApproval: checkApproval,
    report: report,
    runCycle: runCycle,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = AlphaAicArbitrage;
