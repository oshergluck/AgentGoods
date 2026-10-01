/**
 * The Catalyst: an external, bounded market-maker that runs "Alpha the market" and nothing else.
 *
 * WHY. In runs without it, participant agents produced stores, products and operational activity,
 * but no participant bought another participant's token or product: every market sat at zero
 * history, and zero history is what every buyer filters out. The Catalyst tests one intervention —
 * a small, loss-capped outside actor that is willing to be the first buyer of a token — to see
 * whether first liquidity and history unlock participant-to-participant risk taking.
 *
 * WHAT IT IS NOT. It is not a participant: it is not in `state.agents`, so it has no score, no
 * debt, no repayment schedule and no place on the leaderboard, and it never reads standings. It
 * does not reason: it runs Alpha's own logic, unchanged, with fixed bounds. It trades store tokens
 * only — no product purchases, no ratings, no forum — and only through the same public API the
 * participants use, from one wallet.
 *
 * WHAT IT RECORDS. For every token it touches: the state before its first trade, its entries and
 * exits, and participant trades after it entered — which are observable responses, kept apart from
 * independent activity that did not follow a Catalyst position. Every five minutes, market-wide
 * series. And the REGIME_CHANGE minute, so "before" and "after" are never mixed.
 */

import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { ethers, Wallet, type JsonRpcProvider } from "ethers";

import type { RunState } from "./ledger";
import { saveRun } from "./ledger";

const requireCjs = createRequire(__filename);
// The same file listed in Alpha's store (products/alpha-the-market/alpha-the-market.js); a test
// fails if the copy and the original ever differ.
const Alpha = requireCjs(path.join(__dirname, "vendor", "alpha-the-market.js")) as {
  newState(o: { wallet: string; seed: number }): Record<string, any>;
  runCycle(o: Record<string, unknown>): Promise<{ state: Record<string, any>; log: string[]; actions: Record<string, unknown>[] }>;
  report(state: Record<string, any>): string;
};

/** Fixed, explicit, hard. Alpha enforces loss as a worst case: realised + open + next test <= maxLossUSDC. */
export const CATALYST_POLICY = {
  testSizeUSDC: 2,
  maxExposureUSDC: 12,
  maxLossUSDC: 20,
  maxPositions: 6,
  maxNewPerCycle: 2,
  takeProfitPct: 0.25,
  stopLossPct: 0.2,
  holdSeconds: 20 * 60,
  slippageBps: 100,
};
export const CATALYST_FUNDING = { usdc: "30", gasEth: "0.01" };
const CYCLE_MS = 2 * 60_000;
const MEASURE_MS = 5 * 60_000;
/** A token with this many participant trades since activation no longer needs a first buyer. */
const ENOUGH_INDEPENDENT_TRADES = 3;

export interface CatalysisState {
  wallet: string;
  privateKey: string;
  apiKey?: string;
  activatedAt: string;
  activatedAtElapsedMs: number;
  funding: { usdcTx?: string; gasTx?: string; usdcBase: string; gasWei: string };
  policy: typeof CATALYST_POLICY;
  alpha: Record<string, any>;
  cycles: number;
  tokens: Record<string, TokenTrack>;
  series: MarketMeasure[];
  baseline?: MarketMeasure;
}

interface TokenTrack {
  symbol: string;
  controller: string;
  before: { at: string; realReserveUSDC: number; volumeUSDC: number; holders: number; price1e18: string };
  firstCatalystEntryAt: number | null;
  catalystEntries: number;
  catalystExits: number;
  catalystSpentUSDC: number;
  participantTradesAfterEntry: number;
  firstParticipantTradeAfterEntryAt: number | null;
  participantTradesAfterLastExit: number;
  lastCatalystExitAt: number | null;
}

export interface MarketMeasure {
  at: string;
  runningMinute: number;
  tokens: number;
  tokensWithRealReserve: number;
  tokensWithAnExternalHolder: number;
  participantTokenBuys: number;
  participantTokenSells: number;
  participantBuysOfOtherParticipantsTokens: number;
  uniqueParticipantInvestorsInOthers: number;
  participantCapitalIntoOthersUSDC: number;
  catalystBuys: number;
  catalystSells: number;
  tokenVolumeUSDC: number;
  productsSoldAtLeastOnce: number;
  crossParticipantProductPurchases: number;
  productPurchasesTotal: number;
  topInvestorShareOfParticipantCapital: number;
}

const lower = (s: string) => String(s ?? "").toLowerCase();

/** Activate once, or return the existing Catalyst on resume. */
export async function ensureCatalyst(opts: {
  state: RunState;
  apiBaseUrl: string;
  provider: JsonRpcProvider;
  sendOperatorTransaction: (what: string, job: (o: Record<string, unknown>) => Promise<any>) => Promise<{ hash: string; wait(): Promise<unknown> }>;
  usdc: ethers.Contract;
  operator: Wallet;
  elapsedNow: () => number;
  log: (m: string) => void;
}): Promise<CatalysisState> {
  const s = opts.state as RunState & { catalysis?: CatalysisState };
  if (s.catalysis) return s.catalysis;

  const w = Wallet.createRandom();
  const elapsed = opts.elapsedNow();
  const c: CatalysisState = {
    wallet: w.address,
    privateKey: w.privateKey,
    activatedAt: new Date().toISOString(),
    activatedAtElapsedMs: elapsed,
    funding: { usdcBase: ethers.parseUnits(CATALYST_FUNDING.usdc, 6).toString(), gasWei: ethers.parseEther(CATALYST_FUNDING.gasEth).toString() },
    policy: { ...CATALYST_POLICY },
    alpha: Alpha.newState({ wallet: w.address, seed: Number(BigInt(w.address) % 2_147_483_647n) }),
    cycles: 0,
    tokens: {},
    series: [],
  };
  s.catalysis = c;
  saveRun(opts.state);

  const gas = await opts.sendOperatorTransaction("catalyst gas", (o) => opts.operator.sendTransaction({ to: w.address, value: BigInt(c.funding.gasWei), ...o }));
  await gas.wait();
  const mint = await opts.sendOperatorTransaction("catalyst usdc", (o) =>
    (opts.usdc.mint as (a: string, v: bigint, o?: Record<string, unknown>) => Promise<any>)(w.address, BigInt(c.funding.usdcBase), o)
  );
  await mint.wait();
  c.funding.gasTx = gas.hash;
  c.funding.usdcTx = mint.hash;
  saveRun(opts.state);
  opts.log(
    `REGIME_CHANGE runningMinute=${(elapsed / 60_000).toFixed(1)} catalystMarketMakerEnabled=true ` +
      `wallet=${w.address} budgetUSDC=${CATALYST_FUNDING.usdc} testSizeUSDC=${CATALYST_POLICY.testSizeUSDC} ` +
      `maxExposureUSDC=${CATALYST_POLICY.maxExposureUSDC} maxLossUSDC=${CATALYST_POLICY.maxLossUSDC}`
  );
  return c;
}

async function apiKeyFor(c: CatalysisState, apiBaseUrl: string): Promise<string> {
  if (c.apiKey) return c.apiKey;
  const w = new Wallet(c.privateKey);
  const post = async (p: string, b: unknown) =>
    (await fetch(apiBaseUrl + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json() as Promise<any>;
  for (const [purpose, ep] of [["ISSUE_API_KEY", "/api/v1/auth/api-key/issue"], ["ROTATE_API_KEY", "/api/v1/auth/api-key/rotate"]] as const) {
    const ch = await post("/api/v1/auth/challenge", { wallet: w.address, purpose });
    if (!ch?.message) continue;
    const r = await post(ep, { nonce: ch.nonce, signature: await w.signMessage(ch.message) });
    if (r?.apiKey) { c.apiKey = r.apiKey as string; return c.apiKey; }
  }
  throw new Error("catalyst: could not obtain an API key");
}

async function allTokens(apiBaseUrl: string): Promise<any[]> {
  const seen = new Map<string, any>();
  for (const sort of ["volume", "newest"]) {
    const r = await fetch(`${apiBaseUrl}/api/v1/market/tokens?limit=100&sort=${sort}`, { headers: { accept: "application/json" } });
    if (!r.ok) continue;
    for (const it of ((await r.json()) as any).items ?? []) seen.set(lower(it.aicToken), it);
  }
  return [...seen.values()];
}

async function tradesOf(apiBaseUrl: string, token: string): Promise<{ at: number; side: string; trader: string; grossUSDC: string }[]> {
  const r = await fetch(`${apiBaseUrl}/api/v1/market/tokens/${token}/trades?limit=1000`, { headers: { accept: "application/json" } });
  if (!r.ok) return [];
  return (((await r.json()) as any).items ?? []).map((t: any) => ({ at: Number(t.at), side: t.side, trader: lower(t.trader), grossUSDC: String(t.grossUSDC ?? "0") }));
}

/** Market-wide measurement from the public API only. */
export async function measureMarket(state: RunState, apiBaseUrl: string, runningMinute: number): Promise<MarketMeasure> {
  const participants = new Set(state.agents.map((a) => lower(a.address)));
  const catalyst = lower((state as RunState & { catalysis?: CatalysisState }).catalysis?.wallet ?? "");
  const tokens = await allTokens(apiBaseUrl);
  const controllerOfStore = new Map<string, string>();
  const m: MarketMeasure = {
    at: new Date().toISOString(), runningMinute, tokens: tokens.length, tokensWithRealReserve: 0, tokensWithAnExternalHolder: 0,
    participantTokenBuys: 0, participantTokenSells: 0, participantBuysOfOtherParticipantsTokens: 0,
    uniqueParticipantInvestorsInOthers: 0, participantCapitalIntoOthersUSDC: 0, catalystBuys: 0, catalystSells: 0,
    tokenVolumeUSDC: 0, productsSoldAtLeastOnce: 0, crossParticipantProductPurchases: 0, productPurchasesTotal: 0,
    topInvestorShareOfParticipantCapital: 0,
  };
  const investors = new Map<string, number>();
  for (const t of tokens) {
    const controller = lower(t.store?.protocol?.storeController ?? "");
    controllerOfStore.set(lower(t.storeId), controller);
    if (BigInt(t.realUSDCReserve?.base ?? "0") > 0n) m.tokensWithRealReserve++;
    const trades = await tradesOf(apiBaseUrl, t.aicToken);
    const externalBuyers = new Set<string>();
    for (const x of trades) {
      const usd = Number(x.grossUSDC) / 1e6;
      m.tokenVolumeUSDC += usd;
      if (x.side === "buy" && x.trader !== controller) externalBuyers.add(x.trader);
      if (x.trader === catalyst) { if (x.side === "buy") m.catalystBuys++; else m.catalystSells++; continue; }
      if (!participants.has(x.trader)) continue;
      if (x.side === "buy") m.participantTokenBuys++; else m.participantTokenSells++;
      if (x.side === "buy" && x.trader !== controller && participants.has(controller)) {
        m.participantBuysOfOtherParticipantsTokens++;
        m.participantCapitalIntoOthersUSDC += usd;
        investors.set(x.trader, (investors.get(x.trader) ?? 0) + usd);
      }
    }
    if (externalBuyers.size > 0) m.tokensWithAnExternalHolder++;
  }
  m.uniqueParticipantInvestorsInOthers = investors.size;
  const top = Math.max(0, ...investors.values());
  m.topInvestorShareOfParticipantCapital = m.participantCapitalIntoOthersUSDC > 0 ? top / m.participantCapitalIntoOthersUSDC : 0;
  try {
    const sold = await (await fetch(`${apiBaseUrl}/api/v1/market/products?limit=100&soldAtLeastOnce=true`)).json() as any;
    m.productsSoldAtLeastOnce = (sold.items ?? []).length;
    const up = await (await fetch(`${apiBaseUrl}/api/v1/updates?minutes=180`)).json() as any;
    for (const p of up.purchases ?? []) {
      m.productPurchasesTotal++;
      const seller = controllerOfStore.get(lower(p.storeId)) ?? "";
      if (participants.has(lower(p.buyer)) && participants.has(seller) && lower(p.buyer) !== seller) m.crossParticipantProductPurchases++;
    }
  } catch { /* measurements must never stop the run */ }
  return m;
}

/** Track what the Catalyst did to each token and what participants did after it. */
async function trackTokens(c: CatalysisState, state: RunState, apiBaseUrl: string, rows: any[]): Promise<void> {
  const participants = new Set(state.agents.map((a) => lower(a.address)));
  const byToken = new Map(rows.map((r) => [lower(r.aicToken), r]));
  const touched = new Set<string>([
    ...(c.alpha.open ?? []).map((p: any) => p.aicToken),
    ...(c.alpha.closed ?? []).map((p: any) => p.aicToken),
  ]);
  for (const token of touched) {
    const row = byToken.get(token);
    const track = (c.tokens[token] ??= {
      symbol: row?.token?.symbol ?? "?",
      controller: lower(row?.store?.protocol?.storeController ?? ""),
      before: { at: "", realReserveUSDC: 0, volumeUSDC: 0, holders: 0, price1e18: "0" },
      firstCatalystEntryAt: null, catalystEntries: 0, catalystExits: 0, catalystSpentUSDC: 0,
      participantTradesAfterEntry: 0, firstParticipantTradeAfterEntryAt: null,
      participantTradesAfterLastExit: 0, lastCatalystExitAt: null,
    });
    const trades = await tradesOf(apiBaseUrl, token);
    const mine = trades.filter((t) => t.trader === lower(c.wallet)).sort((a, b) => a.at - b.at);
    if (mine.length === 0) continue;
    track.firstCatalystEntryAt = mine.find((t) => t.side === "buy")?.at ?? track.firstCatalystEntryAt;
    track.catalystEntries = mine.filter((t) => t.side === "buy").length;
    track.catalystExits = mine.filter((t) => t.side === "sell").length;
    track.catalystSpentUSDC = mine.filter((t) => t.side === "buy").reduce((s, t) => s + Number(t.grossUSDC) / 1e6, 0);
    track.lastCatalystExitAt = [...mine].reverse().find((t) => t.side === "sell")?.at ?? null;
    const theirs = trades.filter((t) => participants.has(t.trader)).sort((a, b) => a.at - b.at);
    const after = theirs.filter((t) => track.firstCatalystEntryAt !== null && t.at > track.firstCatalystEntryAt);
    track.participantTradesAfterEntry = after.length;
    track.firstParticipantTradeAfterEntryAt = after[0]?.at ?? null;
    track.participantTradesAfterLastExit = track.lastCatalystExitAt ? theirs.filter((t) => t.at > track.lastCatalystExitAt!).length : 0;
  }
}

/** The Catalyst's loop: one Alpha cycle every CYCLE_MS, a market measurement every MEASURE_MS. */
export async function runCatalyst(opts: {
  state: RunState;
  apiBaseUrl: string;
  provider: JsonRpcProvider;
  endsAt: number;
  elapsedNow: () => number;
  log: (m: string) => void;
  sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const s = opts.state as RunState & { catalysis?: CatalysisState };
  const c = s.catalysis!;
  const signer = new Wallet(c.privateKey, opts.provider);
  const send = async (tx: { to: string; data: string; value?: string | number }) => {
    const sent = await signer.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) });
    const rc = await sent.wait();
    return rc?.hash ?? sent.hash;
  };
  const participants = new Set(opts.state.agents.map((a) => lower(a.address)));
  let lastMeasure = 0;
  if (!c.baseline) {
    c.baseline = await measureMarket(opts.state, opts.apiBaseUrl, opts.elapsedNow() / 60_000).catch(() => undefined);
    saveRun(opts.state);
    if (c.baseline) opts.log(`CATALYST baseline (end of regime A): ${JSON.stringify(c.baseline)}`);
    lastMeasure = Date.now();
  }
  while (Date.now() < opts.endsAt) {
    try {
      const apiKey = await apiKeyFor(c, opts.apiBaseUrl);
      const rows = await allTokens(opts.apiBaseUrl);
      // Participants' tokens only (never the operator's own store), and not a token that already
      // has enough independent participant activity to need no first buyer.
      const exclude: string[] = [];
      for (const r of rows) {
        const token = lower(r.aicToken);
        const controller = lower(r.store?.protocol?.storeController ?? "");
        if (!participants.has(controller)) { exclude.push(token); continue; }
        const t = c.tokens[token];
        if (t && t.participantTradesAfterEntry >= ENOUGH_INDEPENDENT_TRADES && !(c.alpha.open ?? []).some((p: any) => p.aicToken === token)) exclude.push(token);
      }
      // Record the before-state of a token the first time it is a candidate, so a later entry has one.
      for (const r of rows) {
        const token = lower(r.aicToken);
        const known = (c as any).before ??= {};
        if (!known[token]) {
          known[token] = {
            at: new Date().toISOString(),
            realReserveUSDC: Number(r.realUSDCReserve?.base ?? "0") / 1e6,
            volumeUSDC: Number(r.lifetimeGrossVolumeUSDC ?? "0") / 1e6,
            holders: Number(r.holderCount ?? 0),
            price1e18: String(r.currentIndexedPrice1e18 ?? "0"),
          };
        }
      }
      const out = await Alpha.runCycle({
        origin: opts.apiBaseUrl, apiKey, state: c.alpha, send,
        policy: { ...c.policy, excludeTokens: exclude },
      });
      c.alpha = out.state;
      c.cycles++;
      for (const line of out.log) opts.log(`[CATALYST] ${line}`);
      await trackTokens(c, opts.state, opts.apiBaseUrl, rows);
      for (const [token, t] of Object.entries(c.tokens)) {
        if (!t.before.at) t.before = (c as any).before?.[token] ?? t.before;
      }
      if (Date.now() - lastMeasure >= MEASURE_MS) {
        const m = await measureMarket(opts.state, opts.apiBaseUrl, opts.elapsedNow() / 60_000);
        c.series.push(m);
        lastMeasure = Date.now();
        opts.log(
          `CATALYSIS minute=${m.runningMinute.toFixed(1)} reserveTokens=${m.tokensWithRealReserve}/${m.tokens} ` +
            `participantCrossBuys=${m.participantBuysOfOtherParticipantsTokens} investors=${m.uniqueParticipantInvestorsInOthers} ` +
            `catalystBuys=${m.catalystBuys} crossProductPurchases=${m.crossParticipantProductPurchases}`
        );
      }
      saveRun(opts.state);
    } catch (error) {
      opts.log(`[CATALYST] cycle failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await opts.sleep(CYCLE_MS);
  }
}

/** The "Market Catalysis Experiment" section of the final report. Facts, then interpretation, labelled. */
export function renderCatalysis(state: RunState): string {
  const c = (state as RunState & { catalysis?: CatalysisState }).catalysis;
  if (!c) return "";
  const a = c.baseline;
  const last = c.series[c.series.length - 1];
  const touched = Object.entries(c.tokens).filter(([, t]) => t.catalystEntries > 0);
  const lines: string[] = [];
  lines.push("", "=".repeat(104), "MARKET CATALYSIS EXPERIMENT", "=".repeat(104));
  lines.push("Research question: does bounded exogenous market-making activity unlock endogenous agent-to-agent risk taking, investment and commerce?");
  lines.push("");
  lines.push(`1. Before the market maker (regime A, minute 0 to ${(c.activatedAtElapsedMs / 60_000).toFixed(1)}):`);
  if (a) {
    lines.push(`   tokens ${a.tokens}, with real reserve ${a.tokensWithRealReserve}; participant buys of other participants' tokens ${a.participantBuysOfOtherParticipantsTokens}; ` +
      `unique participant investors in others ${a.uniqueParticipantInvestorsInOthers}; cross-participant product purchases ${a.crossParticipantProductPurchases} (of ${a.productPurchasesTotal} purchases in the last 180 minutes).`);
    if (a.participantBuysOfOtherParticipantsTokens === 0 && a.crossParticipantProductPurchases === 0) {
      lines.push("   Observed: without a market-maker, the participant agents produced supply and operational activity but did not originate cross-agent demand or investment before the intervention; they repeatedly avoided bearing first-mover market risk.");
      lines.push("   Interpretation (not an observed internal state): this is consistent with a first-buyer / coordination deadlock; risk aversion is a plausible explanation.");
    } else {
      lines.push("   Observed: some cross-participant activity existed before the intervention (counts above), so regime A was not a complete deadlock.");
    }
  } else {
    lines.push("   (no baseline measurement was recorded)");
  }
  lines.push(`2. Activated at running minute ${(c.activatedAtElapsedMs / 60_000).toFixed(1)} (${c.activatedAt}); wallet ${c.wallet} (operator catalyst, not a participant).`);
  lines.push(`3. What it did: ${c.cycles} Alpha cycles; bounds ${JSON.stringify(c.policy)}; tokens only — no product purchases, ratings or forum posts.`);
  lines.push(`4. Capital: funded ${ethers.formatUnits(BigInt(c.funding.usdcBase), 6)} USDC; spent on buys ${touched.reduce((s, [, t]) => s + t.catalystSpentUSDC, 0).toFixed(2)} USDC; Alpha realised P&L ${Number(c.alpha.realizedPnlUSDC ?? 0).toFixed(4)} USDC.`);
  lines.push(`5. Tokens it gave first liquidity/history: ${touched.filter(([, t]) => t.before.realReserveUSDC === 0).map(([, t]) => t.symbol).join(", ") || "none"}.`);
  for (const [token, t] of touched) {
    lines.push(`   ${t.symbol} (${token.slice(0, 10)}…): before reserve ${t.before.realReserveUSDC.toFixed(2)} USDC, holders ${t.before.holders}; catalyst buys ${t.catalystEntries}, sells ${t.catalystExits}; ` +
      `participant trades after its entry ${t.participantTradesAfterEntry}` +
      (t.firstParticipantTradeAfterEntryAt && t.firstCatalystEntryAt ? ` (first after ${Math.round((t.firstParticipantTradeAfterEntryAt - t.firstCatalystEntryAt) / 60)} min)` : "") +
      `; after its last exit ${t.participantTradesAfterLastExit}.`);
  }
  if (a && last) {
    lines.push(`6. Participant investment in others: ${a.participantBuysOfOtherParticipantsTokens} -> ${last.participantBuysOfOtherParticipantsTokens} buys; investors ${a.uniqueParticipantInvestorsInOthers} -> ${last.uniqueParticipantInvestorsInOthers}; capital ${a.participantCapitalIntoOthersUSDC.toFixed(2)} -> ${last.participantCapitalIntoOthersUSDC.toFixed(2)} USDC (top investor share ${(last.topInvestorShareOfParticipantCapital * 100).toFixed(0)}%).`);
    lines.push(`7. Product demand (the catalyst bought none): cross-participant purchases ${a.crossParticipantProductPurchases} -> ${last.crossParticipantProductPurchases}; products sold at least once ${a.productsSoldAtLeastOnce} -> ${last.productsSoldAtLeastOnce}.`);
  }
  lines.push(`8. Follow-on after exits: ${touched.filter(([, t]) => t.participantTradesAfterLastExit > 0).length} of ${touched.length} tokens saw participant trades after the catalyst's last exit.`);
  lines.push("9. Deadlock resolved or artificial activity: read 6-8 together — participant trades that began only while the catalyst held are an observable response, not pre-existing demand; activity that continued after it exited is the stronger signal.");
  lines.push("10. Limits of causal inference: one run, one intervention time, no control arm; agents also learn over time, so a change after activation is not proven to be caused by it. The skill, playbook, scoring and prompts were unchanged at activation.");
  return lines.join("\n");
}

export const _forTests = { measureMarket, trackTokens };
export function catalystFileHash(): string {
  const fs = requireCjs("node:fs") as typeof import("node:fs");
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "vendor", "alpha-the-market.js"))).digest("hex");
}
