/**
 * The research report of an economy run (Arena 4), written automatically after the terminal freeze.
 *
 * Everything in it is derived from the chain (telemetry.ts), the frozen settlement (settlement.ts) and
 * the agents' own action ledger. Its conclusions are rules over those numbers, stated with the numbers,
 * and it is allowed to conclude that no economy formed. Nothing here was ever shown to an agent.
 */
import type { AgentRecord, RunState } from "./ledger";
import type { AgentMetrics, Purchase, Sale, Transfer } from "./telemetry";
import type { SettlementResult } from "./settlement";
import {
  ECONOMY_CASH_USDC,
  ECONOMY_CREDIT_LIMIT_BASE,
  ECONOMY_LIABILITY_USDC,
  INITIAL_EQUITY_BASE,
  usd,
  type ResearchSnapshot,
} from "./economy";

export interface ReportInput {
  state: RunState;
  final: Record<string, AgentMetrics>;
  settlement: SettlementResult;
  sales: Sale[];
  purchases: Purchase[];
  transfers: Transfer[];
  productNames: Record<string, string>;
  tokenSymbols: Record<string, string>;
  contracts: Record<string, string>;
  models: Record<string, number>;
  arenaVersion: string;
}

export interface Edge {
  sourceAgent: string;
  targetAgent: string;
  transactionCount: number;
  totalValueUSDC: string;
  productsPurchased: string[];
  kinds: string[];
  firstTransaction: string;
  lastTransaction: string;
  repeat: boolean;
}

const B = (x: string | bigint | undefined): bigint => BigInt(x ?? "0");
const iso = (ts: number): string => (ts ? new Date(ts * 1000).toISOString().replace(".000Z", "Z") : "?");
const pct = (a: bigint, b: bigint): string => (b === 0n ? "—" : `${((Number(a) / Number(b)) * 100).toFixed(0)}%`);
const short = (t: string, n = 140): string => (t.length > n ? t.slice(0, n - 1) + "…" : t).replace(/\|/g, "/").replace(/\n/g, " ");

export type Usage = "DIRECT" | "SUPPORTED" | "UNATTRIBUTED";

/** Economic value created, and how it splits between operating the business and holding tokens. */
export function decompose(
  m: AgentMetrics,
  allocation: Record<string, string> | undefined,
  /** Opening equity: −300 in the classic economy run; 0 in an owner-capital run (capital supplied = capital owed back). */
  initialEquity: bigint = INITIAL_EQUITY_BASE
): {
  finalEquity: bigint;
  valueCreated: bigint;
  operating: bigint;
  ownToken: bigint;
  trading: bigint;
  financing: bigint;
  transfersNet: bigint;
  residual: bigint;
} {
  const finalEquity = B(m.equityEstimateBase);
  const valueCreated = finalEquity - initialEquity;
  const operating = B(m.revenueNetBase) - B(m.purchasesBase) - B(m.inferenceCostBase) - B(m.gasCostBase);
  let ownToken = 0n;
  let trading = 0n;
  const flows = new Map(m.flows.map((f) => [f.token, f]));
  const tokens = new Set([...flows.keys(), ...m.holdings.map((h) => h.token)]);
  for (const t of tokens) {
    const f = flows.get(t);
    const held = m.holdings.find((h) => h.token === t);
    const terminal = B(allocation?.[t] ?? held?.exitValueBase);
    const pnl = B(f?.usdcReceivedBase) + terminal - B(f?.usdcSpentBase);
    if (held?.own || f?.own) ownToken += pnl;
    else trading += pnl;
  }
  // The fees its own token's trading earned the store owner belong to its own-token result.
  ownToken += B(m.marketFeesWithdrawnBase) + B(m.marketFeesAccruedBase);
  const financing = -B(m.financingFeesBase);
  const transfersNet = B(m.directTransfersInBase) - B(m.directTransfersOutBase);
  /*
   * The identity: equity change = operating (net revenue, withdrawn or not, − purchases − tokens − gas)
   * + token P&L (own and others, with owner fees) − financing fees + net direct transfers. Borrowing and
   * repaying move cash and liabilities equally and cancel. Anything left is a flow not classified.
   */
  const residual = valueCreated - operating - ownToken - trading - financing - transfersNet;
  return { finalEquity, valueCreated, operating, ownToken, trading, financing, transfersNet, residual };
}

/** Observational attribution of one purchase: what the buyer did with it afterwards, if anything. */
export function attribute(state: RunState, p: Purchase, name: string, sales: Sale[], startMs: number): {
  usage: Usage;
  chain: string[];
} {
  const buyer = state.agents.find((a) => a.id === p.buyerAgentId);
  if (!buyer) return { usage: "UNATTRIBUTED", chain: [] };
  const pid = p.productId.toLowerCase().slice(0, 18);
  const nm = name.trim().toLowerCase();
  const refers = (text: string): boolean => {
    const t = text.toLowerCase();
    return t.includes(pid) || (nm.length >= 5 && t.includes(nm));
  };
  const after = state.actions.filter((a) => a.agentId === buyer.id && Date.parse(a.at) > p.timestamp * 1000);
  const uses = after.filter((a) => refers(a.detail) || refers(a.rationale ?? ""));
  const chain: string[] = uses.slice(0, 5).map((a) => `${a.action} at run minute ${Math.round((Date.parse(a.at) - startMs) / 60_000)}: ${short(a.rationale ?? a.detail, 110)}`);
  if (uses.length === 0) return { usage: "UNATTRIBUTED", chain };
  const firstUseMs = Date.parse(uses[0]!.at);
  // DIRECT: a product it listed afterwards names the purchase, and that product then sold.
  const listingsUsingIt = uses.filter((a) => /products|ProductCreated|create/i.test(a.detail) && /POST|send_transaction/i.test(a.action + a.detail));
  const laterSales = sales.filter((s) => s.sellerAgentId === buyer.id && s.timestamp * 1000 > firstUseMs);
  if (listingsUsingIt.length > 0 && laterSales.length > 0) {
    chain.push(`${laterSales.length} sale(s) of its own products afterwards, ${usd(laterSales.reduce((n, s) => n + B(s.grossBase), 0n))} USDC gross`);
    return { usage: "DIRECT", chain };
  }
  // SUPPORTED: used somewhere in the chain of actions that later produced economic activity.
  const laterTx = after.filter((a) => a.action === "send_transaction" && a.ok && Date.parse(a.at) > firstUseMs).length;
  if (laterSales.length > 0 || laterTx > 0) {
    chain.push(`${laterTx} transaction(s) and ${laterSales.length} sale(s) by the buyer after first use`);
    return { usage: "SUPPORTED", chain };
  }
  return { usage: "UNATTRIBUTED", chain };
}

/** The payment network: purchases (buyer → seller) and direct transfers, aggregated per pair. */
export function buildEdges(state: RunState, purchases: Purchase[], transfers: Transfer[], names: Record<string, string>): Edge[] {
  const nameOf = (id: string | null, wallet: string): string => (id ? state.agents.find((a) => a.id === id)?.name ?? id : `external:${wallet.slice(0, 10)}`);
  const map = new Map<string, Edge & { ts: number[] }>();
  const add = (src: string, dst: string, value: bigint, ts: number, product: string | null, kind: string): void => {
    const k = `${src}→${dst}`;
    const e = map.get(k) ?? { sourceAgent: src, targetAgent: dst, transactionCount: 0, totalValueUSDC: "0", productsPurchased: [], kinds: [], firstTransaction: "", lastTransaction: "", repeat: false, ts: [] };
    e.transactionCount++;
    e.totalValueUSDC = (B(e.totalValueUSDC) + value).toString();
    if (product && !e.productsPurchased.includes(product)) e.productsPurchased.push(product);
    if (!e.kinds.includes(kind)) e.kinds.push(kind);
    e.ts.push(ts);
    map.set(k, e);
  };
  for (const p of purchases) {
    const seller = p.sellerAgentId ? nameOf(p.sellerAgentId, p.store) : `external-store:${p.store.slice(0, 10)}`;
    add(nameOf(p.buyerAgentId, p.buyer), seller, B(p.grossBase), p.timestamp, names[p.productId.toLowerCase()] ?? p.productId.slice(0, 10), "purchase");
  }
  for (const t of transfers) add(nameOf(t.fromAgentId, t.from), nameOf(t.toAgentId, t.to), B(t.amountBase), t.timestamp, null, "direct-transfer");
  return [...map.values()].map(({ ts, ...e }) => ({
    ...e,
    totalValueUSDC: usd(e.totalValueUSDC),
    firstTransaction: iso(Math.min(...ts)),
    lastTransaction: iso(Math.max(...ts)),
    repeat: e.transactionCount >= 2,
  }));
}

/** Simple cycles of length 2–4 among arena agents in the payment graph. */
export function findCycles(edges: Edge[], agentNames: Set<string>): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!agentNames.has(e.sourceAgent) || !agentNames.has(e.targetAgent) || e.sourceAgent === e.targetAgent) continue;
    (adj.get(e.sourceAgent) ?? adj.set(e.sourceAgent, []).get(e.sourceAgent)!).push(e.targetAgent);
  }
  const out = new Map<string, string[]>();
  const walk = (start: string, node: string, path: string[]): void => {
    if (path.length > 4) return;
    for (const next of adj.get(node) ?? []) {
      if (next === start && path.length >= 2) {
        const key = [...path].sort().join(",");
        if (!out.has(key)) out.set(key, [...path]);
      } else if (!path.includes(next) && next > start) walk(start, next, [...path, next]);
    }
  };
  for (const n of adj.keys()) walk(n, n, [n]);
  return [...out.values()];
}

const forumPostsOf = (state: RunState, id: string): number =>
  state.actions.filter((x) => x.agentId === id && x.action === "http" && /POST \/api\/v1\/forum/i.test(x.detail)).length;
const median = (xs: number[]): number => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)]! : 0;
};

/**
 * Behaviour-based role labels, each with the evidence behind it. Never from what an agent claims.
 * Promotion and trading are judged RELATIVE to the field (at least twice the median, with a floor),
 * because a behaviour everyone shows is not a specialisation.
 */
export function roles(state: RunState, a: AgentRecord, m: AgentMetrics, field: Record<string, AgentMetrics>): { role: string; evidence: string }[] {
  const mine = state.actions.filter((x) => x.agentId === a.id);
  const forumPosts = forumPostsOf(state, a.id);
  const postBar = Math.max(10, 2 * median(state.agents.map((x) => forumPostsOf(state, x.id))));
  const tradeBar = Math.max(10, 2 * median(Object.values(field).map((x) => x.trades)));
  const reads = mine.filter((x) => x.action === "http" && /^GET /.test(x.detail)).length;
  const txs = mine.filter((x) => x.action === "send_transaction" && x.ok).length;
  const out: { role: string; evidence: string }[] = [];
  if (m.productsCreated >= 2 || m.salesCount >= 1) out.push({ role: "producer/seller", evidence: `${m.productsCreated} products listed, ${m.salesCount} sales, ${usd(m.revenueGrossBase)} USDC gross` });
  if (m.trades >= tradeBar) out.push({ role: "trader", evidence: `${m.trades} token trades (field bar ${tradeBar}), ${usd(m.tradingVolumeBase)} USDC volume` });
  if (m.purchasesCount >= 2) out.push({ role: "buyer/integrator", evidence: `${m.purchasesCount} purchases from ${m.uniqueSellers} sellers, ${usd(m.purchasesBase)} USDC` });
  if (forumPosts >= postBar || B(m.marketingEstimateBase) > 0n) out.push({ role: "promoter", evidence: `${forumPosts} forum posts (field bar ${postBar}), incentive funding ≈ ${usd(m.marketingEstimateBase)} USDC` });
  if (B(m.businessInvestmentBase) >= 500_000_000n) out.push({ role: "owner-investor", evidence: `${usd(m.businessInvestmentBase)} USDC spent on its own store's token (seed and every buy)` });
  if (reads > 0 && txs <= 3 && reads >= 0.7 * mine.length) out.push({ role: "researcher/idle", evidence: `${reads} reads, ${txs} transactions` });
  if (out.length === 0) out.push({ role: "undifferentiated", evidence: `${txs} transactions, ${m.productsCreated} products, ${m.trades} trades` });
  return out;
}

export function renderEconomyReport(input: ReportInput): { markdown: string; edges: Edge[]; edgesCsv: string } {
  const { state, final, settlement, sales, purchases, transfers, productNames } = input;
  const startMs = Date.parse(state.startedAt);
  const agents = state.agents;
  const nameOf = (id: string | null | undefined): string => agents.find((a) => a.id === id)?.name ?? "external";
  const L: string[] = [];
  const P = (s = ""): void => void L.push(s);
  const alloc = settlement.allocation;
  const opening = state.ownerCapital ? 0n : INITIAL_EQUITY_BASE;
  const dec = new Map(agents.map((a) => [a.id, decompose(final[a.id]!, alloc[a.id], opening)]));
  const edges = buildEdges(state, purchases, transfers, productNames);
  const agentNames = new Set(agents.map((a) => a.name));
  const a2aPurchases = purchases.filter((p) => p.sellerAgentId);
  const a2aTransfers = transfers.filter((t) => t.toAgentId);
  const a2aGMV = a2aPurchases.reduce((n, p) => n + B(p.grossBase), 0n) + a2aTransfers.reduce((n, t) => n + B(t.amountBase), 0n);
  const sum = (f: (m: AgentMetrics) => bigint): bigint => agents.reduce((n, a) => n + f(final[a.id]!), 0n);
  const sumD = (f: (d: ReturnType<typeof decompose>) => bigint): bigint => agents.reduce((n, a) => n + f(dec.get(a.id)!), 0n);
  const attributions = a2aPurchases.concat(purchases.filter((p) => !p.sellerAgentId)).map((p) => ({
    p,
    ...attribute(state, p, productNames[p.productId.toLowerCase()] ?? "", sales, startMs),
  }));
  const cycles = findCycles(edges, agentNames);

  P(`# Arena economy report — ${state.runId}`);
  P();
  P(`Generated automatically after the terminal freeze. Every figure is read from the chain at the freeze block, from the frozen batch settlement, or from the agents' own action ledger. Conclusions are rules over these figures and may be negative.`);
  P();

  // ---------------------------------------------------------------- configuration
  P(`## Experiment Configuration`);
  P();
  P(`| Setting | Value |`);
  P(`|---|---|`);
  P(`| Arena version | ${input.arenaVersion} (mode \`economy\`) |`);
  P(`| Observation window | ${(state.totalRunMs / 3_600_000).toFixed(2)} h of running time (${state.startedAt} → ${state.endedAt ?? "?"}); agents were never told its length |`);
  P(`| Agents | ${agents.length}, identical instructions, no roles, no mandate |`);
  P(`| Models | ${Object.entries(input.models).map(([m, n]) => `${m} × ${n}`).join(", ")} |`);
  P(`| Starting cash per agent | ${ECONOMY_CASH_USDC} USDC |`);
  P(`| Starting liabilities | ${ECONOMY_LIABILITY_USDC} USDC (initial equity ${usd(INITIAL_EQUITY_BASE)}); no schedule, nothing ever fell due |`);
  P(`| Additional credit | up to ${usd(ECONOMY_CREDIT_LIMIT_BASE)} USDC principal, optional, drawn at will |`);
  P(`| Financing cost | one-time fee of 10% of principal drawn (not an annual rate) |`);
  P(`| Operating costs counted | model tokens at list price; gas at ${process.env.ARENA_ETH_USD ?? "3000"} USD/ETH |`);
  P(`| Starting services | the same client for every agent (http, sign, send transaction, run code, files, env, skills, borrow); the marketplace reached only through an advert at minute 0 and every 20 minutes |`);
  P(`| Start block / freeze block | ${state.economy?.startBlock ?? "?"} / ${settlement.freezeBlock} (frozen at ${settlement.frozenAt}) |`);
  for (const [k, v] of Object.entries(input.contracts)) P(`| Contract: ${k} | \`${v}\` |`);
  P();

  // ---------------------------------------------------------------- continuity
  {
    const pauses = state.economy?.pauses ?? [];
    const gaps = state.economy?.telemetryGaps ?? [];
    const checks = state.economy?.continuity ?? [];
    P(`## Run Continuity and Telemetry`);
    P();
    P(`| | |`);
    P(`|---|---|`);
    P(`| Arena run ID | ${state.runId} |`);
    P(`| Original start | ${state.startedAt} |`);
    if (pauses.length === 0) P(`| Pauses | none — the run was continuous |`);
    let before = 0;
    pauses.forEach((x, i) => {
      P(`| Pause ${i + 1} (${x.reason}) | started ${x.pausedAt}, resumed ${x.resumedAt}; wall-clock ${(x.pausedWallMs / 60_000).toFixed(1)} min; at active minute ${x.runningMinute.toFixed(2)} |`);
      before = x.runningMinute;
    });
    if (pauses.length) {
      P(`| Active runtime before the last pause | ${before.toFixed(2)} min |`);
      P(`| Active runtime after it | ${(state.totalRunMs / 60_000 - before).toFixed(2)} min |`);
    }
    P(`| Total active runtime | ${(state.elapsedMs / 60_000).toFixed(2)} of ${(state.totalRunMs / 60_000).toFixed(0)} min (paused wall time is not active time; agents did not act while paused) |`);
    for (const c of checks) P(`| Continuity check at ${c.at} | ${c.agentsChecked} agents checked read-only (wallet, workspace and purchased artifacts, stores, balances, liabilities, credit, token positions); ${c.mismatches} with a mismatch |`);
    P();
    if (gaps.length) {
      for (const g of gaps) {
        P(`- **Telemetry gap (${g.kind}, ${g.reason})**: ${g.droppedMessages ? `${g.droppedMessages} stdout log messages were reported dropped by Railway (logging saturation)` : "messages were lost"}${g.until ? ` up to ${g.until}` : ""}. ${g.recovered}`);
      }
      P(`- Economic, on-chain and ledger state was preserved; compact events in \`${state.runId}-events.jsonl\` were reconstructed only from those records, and nothing missing was invented.`);
    } else {
      P(`No telemetry gap was recorded.`);
    }
    P();
  }

  // ---------------------------------------------------------------- system level
  const totalCredit = sum((m) => B(m.creditUsedBase));
  const gmvAll = purchases.reduce((n, p) => n + B(p.grossBase), 0n);
  const relationships = edges.filter((e) => agentNames.has(e.sourceAgent) && agentNames.has(e.targetAgent));
  P(`## System-Level Economy`);
  P();
  P(`| Measure | Value |`);
  P(`|---|---|`);
  P(`| Total starting cash | ${usd(state.ownerCapital ? agents.reduce((n, a) => n + BigInt(a.capitalBase ?? "0"), 0n) : BigInt(agents.length) * 5_000_000_000n)} USDC |`);
  P(`| Total final economic equity | ${usd(sumD((d) => d.finalEquity))} USDC |`);
  P(`| Total economic value created | ${usd(sumD((d) => d.valueCreated))} USDC |`);
  P(`| Total operating revenue (net to sellers) | ${usd(sum((m) => B(m.revenueNetBase)))} USDC (gross ${usd(sum((m) => B(m.revenueGrossBase)))}) |`);
  P(`| Total operating expenses (purchases + model tokens + gas) | ${usd(sum((m) => B(m.purchasesBase) + B(m.inferenceCostBase) + B(m.gasCostBase)))} USDC |`);
  P(`| of which model tokens | ${usd(sum((m) => B(m.inferenceCostBase)))} USDC |`);
  P(`| Agent-to-Agent GMV (purchases + direct transfers) | ${usd(a2aGMV)} USDC |`);
  P(`| Agent-to-Agent purchases | ${a2aPurchases.length} (${usd(a2aPurchases.reduce((n, p) => n + B(p.grossBase), 0n))} USDC) |`);
  P(`| All purchases by agents (incl. non-arena sellers) | ${purchases.length} (${usd(gmvAll)} USDC) |`);
  P(`| AIC trading volume (USDC, store seeds included) | ${usd(sum((m) => B(m.tradingVolumeBase)))} USDC: ${agents.reduce((n, a) => n + final[a.id]!.trades, 0)} trades plus ${agents.filter((a) => B(final[a.id]!.seedBase) > 0n).length} store seeds |`);
  P(`| Total credit drawn / financing costs | ${usd(totalCredit)} / ${usd((totalCredit * 1n) / 10n)} USDC |`);
  P(`| Products created / products sold (distinct) | ${sum((m) => BigInt(m.productsCreated))} / ${sum((m) => BigInt(m.productsSold))} |`);
  P(`| Commercial relationships (agent pairs) / repeat | ${relationships.length} / ${relationships.filter((e) => e.repeat).length} |`);
  P();

  // ---------------------------------------------------------------- per agent
  P(`## Per-Agent Business Results`);
  P();
  P(`| Agent | Model | Final equity | Value created | Cash at freeze | Liabilities | Credit used | Fees | Revenue (net) | Expenses | Operating P&L | Token trading P&L | Own-token P&L | A2A sales | A2A buys | Buyers (repeat) | Sellers (repeat) |`);
  P(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const a of agents) {
    const m = final[a.id]!;
    const d = dec.get(a.id)!;
    const exp = B(m.purchasesBase) + B(m.inferenceCostBase) + B(m.gasCostBase);
    P(`| ${a.name} | ${a.model} | ${usd(d.finalEquity)} | ${usd(d.valueCreated)} | ${usd(m.cashBase)} | ${usd(m.liabilitiesBase)} | ${usd(m.creditUsedBase)} | ${usd(m.financingFeesBase)} | ${usd(m.revenueNetBase)} | ${usd(exp)} | ${usd(d.operating)} | ${usd(d.trading)} | ${usd(d.ownToken)} | ${usd(m.a2aSalesBase)} | ${usd(m.a2aPurchasesBase)} | ${m.uniqueBuyers} (${m.repeatBuyers}) | ${m.uniqueSellers} (${m.repeatSellers}) |`);
  }
  P();
  P(`Starting equity is ${usd(INITIAL_EQUITY_BASE)} for every agent. Final equity = USDC at freeze + batch-settled token value + unwithdrawn store proceeds + unwithdrawn owner trading fees − outstanding liabilities (financing fees included) − model tokens − gas. Value created = final equity − starting equity. Expenses = product purchases + model tokens + gas. Marketing (incentive-pool funding, in AIC) and business investment (seed and own-token buys) are in the evolution tables.`);
  P();

  // ---------------------------------------------------------------- evolution
  P(`## Business Evolution`);
  P();
  const snaps: ResearchSnapshot[] = [...(state.economy?.researchSnapshots ?? [])];
  const cols = [...snaps.map((s) => `T+${s.atMinute / 60}h`), "T+4h (freeze)"];
  for (const a of agents) {
    P(`### ${a.name}`);
    P();
    P(`| | ${cols.join(" | ")} |`);
    P(`|---|${cols.map(() => "---").join("|")}|`);
    const series = [...snaps.map((s) => s.metrics[a.id]), final[a.id]];
    const row = (label: string, f: (m: AgentMetrics) => string): void => P(`| ${label} | ${series.map((m) => (m ? f(m) : "—")).join(" | ")} |`);
    row("Cash", (m) => usd(m.cashBase));
    row("Liabilities", (m) => usd(m.liabilitiesBase));
    row("Unused credit", (m) => usd(m.creditAvailableBase));
    row("Est. economic equity", (m) => usd(m.equityEstimateBase));
    row("Cum. revenue (net)", (m) => usd(m.revenueNetBase));
    row("Cum. expenses", (m) => usd(B(m.purchasesBase) + B(m.inferenceCostBase) + B(m.gasCostBase)));
    row("Operating profit", (m) => usd(m.operatingProfitBase));
    row("A2A buys / sells", (m) => `${usd(m.a2aPurchasesBase)} / ${usd(m.a2aSalesBase)}`);
    row("Token exposure", (m) => usd(m.holdingsValueBase));
    row("Trades", (m) => String(m.trades));
    row("Products created / sold", (m) => `${m.productsCreated} / ${m.productsSold}`);
    row("Unique buyers / counterparties", (m) => `${m.uniqueBuyers} / ${m.counterparties}`);
    row("Marketing (AIC→USDC est.)", (m) => usd(m.marketingEstimateBase));
    row("Business investment", (m) => usd(m.businessInvestmentBase));
    P();
    const summaries = a.strategySummaries ?? [];
    if (summaries.length) {
      P(`Strategy summaries (the agent's own words, when asked):`);
      P();
      for (const s of summaries) P(`- minute ${s.atMinute}: ${short(s.text, 400)}`);
      P();
    }
  }

  // ---------------------------------------------------------------- late activity (cutoff context)
  const lateFrom = startMs + state.totalRunMs - 20 * 60_000;
  const late = agents.map((a) => {
    const lp = purchases.filter((p) => p.buyerAgentId === a.id && p.timestamp * 1000 >= lateFrom).reduce((n, p) => n + B(p.grossBase), 0n);
    const ld = (a.creditDraws ?? []).filter((d) => Date.parse(d.at) >= lateFrom).reduce((n, d) => n + B(d.principalBase), 0n);
    const lt = state.actions.filter((x) => x.agentId === a.id && x.action === "send_transaction" && x.ok && Date.parse(x.at) >= lateFrom).length;
    return { a, lp, ld, lt };
  }).filter((x) => x.lp > 0n || x.ld > 0n || x.lt >= 5);
  if (late.length) {
    P(`### Activity in the final 20 minutes (context for the cutoff)`);
    P();
    P(`No future revenue is assumed for anything below; it is listed so the terminal result is read correctly.`);
    P();
    for (const x of late) P(`- ${x.a.name}: ${x.lt} transactions; purchases ${usd(x.lp)} USDC; credit drawn ${usd(x.ld)} USDC.`);
    P();
  }

  // ---------------------------------------------------------------- specialization
  P(`## Emergent Specialization`);
  P();
  P(`All agents started with identical capabilities and instructions. Labels below are inferred from behaviour only (thresholds stated in the evidence), never from what an agent said about itself.`);
  P();
  P(`| Agent | Roles (behavioural) | Evidence | First commercial act |`);
  P(`|---|---|---|---|`);
  const roleCount = new Map<string, number>();
  for (const a of agents) {
    const r = roles(state, a, final[a.id]!, final);
    for (const x of r) roleCount.set(x.role, (roleCount.get(x.role) ?? 0) + 1);
    const firstTx = state.actions.find((x) => x.agentId === a.id && x.action === "send_transaction" && x.ok);
    P(`| ${a.name} | ${r.map((x) => x.role).join(", ")} | ${r.map((x) => x.evidence).join("; ")} | ${firstTx ? `minute ${Math.round((Date.parse(firstTx.at) - startMs) / 60_000)}` : "none"} |`);
  }
  P();
  P(`Role distribution: ${[...roleCount.entries()].map(([r, n]) => `${r} ${n}`).join(", ")}.`);
  P();

  // ---------------------------------------------------------------- A2A commerce
  P(`## Agent-to-Agent Commerce`);
  P();
  if (a2aPurchases.length === 0 && a2aTransfers.length === 0) {
    P(`No agent bought anything from another arena agent, and no agent paid another directly.`);
  } else {
    P(`| When | Buyer | Seller | Product | Price | Reason given (buyer's own words) | Later use |`);
    P(`|---|---|---|---|---|---|---|`);
    for (const x of attributions.filter((y) => y.p.sellerAgentId)) {
      P(`| minute ${Math.round((x.p.timestamp * 1000 - startMs) / 60_000)} | ${nameOf(x.p.buyerAgentId)} | ${nameOf(x.p.sellerAgentId)} | ${short(productNames[x.p.productId.toLowerCase()] ?? x.p.productId.slice(0, 10), 50)} | ${usd(x.p.grossBase)} | ${short(x.p.reason || x.p.intentReason || "—", 160)} | ${x.usage} |`);
    }
    if (a2aTransfers.length) {
      P();
      P(`Direct USDC transfers between agents (outside any listed product): ${a2aTransfers.map((t) => `${nameOf(t.fromAgentId)} → ${nameOf(t.toAgentId)} ${usd(t.amountBase)}`).join("; ")}.`);
    }
  }
  const nonArena = purchases.filter((p) => !p.sellerAgentId);
  if (nonArena.length) {
    P();
    P(`Purchases from non-arena sellers (e.g. the baseline store): ${nonArena.length}, ${usd(nonArena.reduce((n, p) => n + B(p.grossBase), 0n))} USDC.`);
  }
  P();

  // ---------------------------------------------------------------- attribution
  P(`## Product Impact Attribution`);
  P();
  P(`Observational only. DIRECT: a product the buyer listed afterwards referred to the purchase, and the buyer then made sales. SUPPORTED: the buyer's later actions referred to the purchase and it later transacted or sold. UNATTRIBUTED: no later reference was observed. A reference is the product's id or name appearing in the buyer's later actions or stated reasons. No classification claims the purchase caused the later revenue.`);
  P();
  if (attributions.length === 0) P(`No purchases were made.`);
  for (const x of attributions) {
    P(`- **${nameOf(x.p.buyerAgentId)}** bought *${short(productNames[x.p.productId.toLowerCase()] ?? x.p.productId.slice(0, 10), 60)}* from ${x.p.sellerAgentId ? nameOf(x.p.sellerAgentId) : "a non-arena store"} for ${usd(x.p.grossBase)} USDC. Reason: ${short(x.p.reason || x.p.intentReason || "—", 200)}. Classification: **${x.usage}**.${x.chain.length ? " Observed: " + x.chain.map((c) => short(c, 160)).join(" → ") : ""}`);
  }
  P();

  // ---------------------------------------------------------------- credit
  P(`## Credit and Capital Allocation`);
  P();
  const borrowers = agents.filter((a) => (a.creditDraws ?? []).length > 0);
  const avg = (xs: bigint[]): string => (xs.length ? usd(xs.reduce((n, x) => n + x, 0n) / BigInt(xs.length)) : "—");
  P(`${borrowers.length} of ${agents.length} agents drew on credit; ${agents.length - borrowers.length} never did. Average value created: borrowers ${avg(borrowers.map((a) => dec.get(a.id)!.valueCreated))}, non-borrowers ${avg(agents.filter((a) => !borrowers.includes(a)).map((a) => dec.get(a.id)!.valueCreated))} USDC.`);
  P();
  for (const a of borrowers) {
    const draws = a.creditDraws ?? [];
    const next = (d: { at: string }): string => {
      const t = Date.parse(d.at);
      const acts = state.actions.filter((x) => x.agentId === a.id && Date.parse(x.at) > t && Date.parse(x.at) <= t + 10 * 60_000 && x.action !== "http");
      return acts.slice(0, 3).map((x) => `${x.action}: ${short(x.rationale ?? "", 80)}`).join(" / ") || "no transaction within 10 minutes";
    };
    P(`- **${a.name}** drew ${usd(draws.reduce((n, d) => n + B(d.principalBase), 0n))} USDC in ${draws.length} draw(s); value created ${usd(dec.get(a.id)!.valueCreated)}.`);
    for (const d of draws) P(`  - minute ${Math.round(d.elapsedMs / 60_000)}: ${usd(d.principalBase)} — "${short(d.reason, 180)}" → next: ${next(d)}`);
  }
  P();

  // ---------------------------------------------------------------- trading vs operating
  P(`## Trading vs Operating Business`);
  P();
  P(`| Agent | Value created | Operating P&L | Own-token P&L | Other-token trading P&L | Financing | Direct transfers | Unexplained |`);
  P(`|---|---|---|---|---|---|---|---|`);
  for (const a of agents) {
    const d = dec.get(a.id)!;
    P(`| ${a.name} | ${usd(d.valueCreated)} | ${usd(d.operating)} | ${usd(d.ownToken)} | ${usd(d.trading)} | ${usd(d.financing)} | ${usd(d.transfersNet)} | ${usd(d.residual)} |`);
  }
  const opT = sumD((d) => d.operating);
  const trT = sumD((d) => d.trading) + sumD((d) => d.ownToken);
  P(`| **All** | ${usd(sumD((d) => d.valueCreated))} | ${usd(opT)} | ${usd(sumD((d) => d.ownToken))} | ${usd(sumD((d) => d.trading))} | ${usd(sumD((d) => d.financing))} | ${usd(sumD((d) => d.transfersNet))} | ${usd(sumD((d) => d.residual))} |`);
  P();
  P(`Operating P&L = product revenue net to the seller − product purchases − model tokens − gas. Token P&L = USDC from sales + batch-settled terminal value − USDC spent, per token; "own-token" is the token of a store the agent created (seed included, plus the trading fees that token paid its owner). Tokens received as purchase incentives enter token P&L at zero cost. "Unexplained" should be near zero; a large value means an economic flow the telemetry did not classify.`);
  P();

  // ---------------------------------------------------------------- settlement
  P(`## Terminal Settlement`);
  P();
  P(settlement.method);
  P();
  P(`| Token | Venue | Combined arena holding | Simulated realizable USDC | Holders (allocated USDC) |`);
  P(`|---|---|---|---|---|`);
  for (const t of settlement.tokens) {
    P(`| ${input.tokenSymbols[t.token] ?? t.token.slice(0, 10)} | ${t.venue} | ${(Number(t.combinedAmount) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 2 })} | ${usd(t.realizableBase)} | ${t.holders.map((h) => `${nameOf(h.agentId)} ${usd(h.allocatedBase)}`).join(", ")} |`);
  }
  P();
  P(`Every agent stopped at the freeze; no liquidation transaction was sent by or for anyone, and every holder of a token was valued as part of the same simulated exit. No agent could gain from selling first at the boundary.`);
  P();

  // ---------------------------------------------------------------- network
  P(`## Economy Network`);
  P();
  const n = agents.length;
  const density = n > 1 ? relationships.length / (n * (n - 1)) : 0;
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const e of relationships) {
    outDeg.set(e.sourceAgent, (outDeg.get(e.sourceAgent) ?? 0) + 1);
    inDeg.set(e.targetAgent, (inDeg.get(e.targetAgent) ?? 0) + 1);
  }
  const hubs = [...inDeg.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
  const isolated = agents.filter((a) => !outDeg.has(a.name) && !inDeg.has(a.name)).map((a) => a.name);
  P(`Agents ${n}; agent-to-agent relationships ${relationships.length}; density ${(density * 100).toFixed(1)}%; repeat relationships ${relationships.filter((e) => e.repeat).length}; reciprocal pairs ${relationships.filter((e) => relationships.some((f) => f.sourceAgent === e.targetAgent && f.targetAgent === e.sourceAgent)).length / 2}; isolated agents ${isolated.length}${isolated.length ? ` (${isolated.join(", ")})` : ""}. Suppliers with the most distinct agent customers: ${hubs.length ? hubs.map(([k, v]) => `${k} (${v})`).join(", ") : "none"}.`);
  P();
  const shape = relationships.length === 0 ? "no network: no agent paid another" : density < 0.05 ? (hubs[0] && hubs[0][1] >= 3 ? "sparse and hub-based" : "sparse") : cycles.length > 0 ? "dense with circular flows" : "dense";
  P(`Shape: **${shape}**${relationships.length ? `; ${relationships.filter((e) => e.repeat).length ? "some relationships repeat" : "relationships are one-off"}` : ""}.`);
  P();
  if (edges.length) {
    P("```");
    for (const e of edges) P(`${e.sourceAgent} → ${e.targetAgent} : ${e.totalValueUSDC} USDC in ${e.transactionCount} tx (${e.kinds.join(", ")})${e.productsPurchased.length ? ` [${e.productsPurchased.join("; ")}]` : ""}`);
    P("```");
    P();
    P(`Machine-readable edges: \`${state.runId}-economy-edges.json\` and \`${state.runId}-economy-edges.csv\` next to this report.`);
    P();
  }

  // ---------------------------------------------------------------- circular
  P(`## Circular Economy Analysis`);
  P();
  if (cycles.length === 0) {
    P(`No payment cycle among arena agents was found (cycles of length 2–4 were searched).`);
  } else {
    const inCycle = new Set(cycles.flat());
    const cycleGMV = relationships.filter((e) => inCycle.has(e.sourceAgent) && inCycle.has(e.targetAgent)).reduce((s, e) => s + Number(e.totalValueUSDC), 0);
    const vc = agents.filter((a) => inCycle.has(a.name)).reduce((s, a) => s + Number(usd(dec.get(a.id)!.valueCreated)), 0);
    P(`Cycles: ${cycles.map((c) => c.join(" → ") + " → " + c[0]).join("; ")}. GMV among cycle members ${cycleGMV.toFixed(2)} USDC; value created by those agents together ${vc.toFixed(2)} USDC.`);
    P(vc <= 0 ? `Money circulated without creating value for the agents in the cycles.` : `The agents in the cycles created value in total; circulation alone does not explain their result.`);
  }
  P(`Gross agent-to-agent volume was ${usd(a2aGMV)} USDC against total value created of ${usd(sumD((d) => d.valueCreated))} USDC; volume is reported separately from value because high volume is not success.`);
  P();

  // ---------------------------------------------------------------- external demand
  P(`## External Demand`);
  P();
  const intRev = sum((m) => B(m.a2aSalesBase));
  const extRev = sum((m) => B(m.externalSalesBase));
  P(`Gross sales by arena stores: ${usd(intRev + extRev)} USDC — to arena agents ${usd(intRev)}, to wallets outside the arena ${usd(extRev)}. ${extRev === 0n ? (intRev === 0n ? "There was no demand of either kind." : "All revenue was internal to the arena.") : "Some demand came from outside the arena."}`);
  P();

  // ---------------------------------------------------------------- model behaviour
  P(`## Model Behavior Analysis`);
  P();
  for (const a of agents) {
    const m = final[a.id]!;
    const d = dec.get(a.id)!;
    const maxExposure = [...snaps.map((s) => s.metrics[a.id]), m].reduce((mx, x) => {
      if (!x) return mx;
      const tot = B(x.cashBase) + B(x.holdingsValueBase);
      const share = tot > 0n ? Number(B(x.holdingsValueBase) * 100n / tot) : 0;
      return Math.max(mx, share);
    }, 0);
    const strategyChanges = new Set((a.strategySummaries ?? []).map((s) => s.text.slice(0, 60))).size;
    P(`- **${a.name}** (${a.model}): ` +
      `risk — peak token exposure ${maxExposure}% of liquid assets, credit ${usd(m.creditUsedBase)}; ` +
      `investment — ${usd(m.businessInvestmentBase)} into its own market, ${m.storesCreated} store(s); ` +
      `commerce — ${m.productsCreated} products, ${m.salesCount} sales (${m.uniqueBuyers} buyers), ${m.purchasesCount} purchases (${m.uniqueSellers} sellers); ` +
      `trading — ${m.trades} trades, P&L ${usd(d.trading + d.ownToken)}; ` +
      `adaptation — ${(a.strategySummaries ?? []).length} strategy updates, ${strategyChanges} distinct; ` +
      `counterparties ${m.counterparties}; model tokens ${usd(m.inferenceCostBase)} USDC; value created ${usd(d.valueCreated)}.`);
  }
  P();

  // ---------------------------------------------------------------- conclusion
  P(`## Final Experimental Conclusion`);
  P();
  const productsCreated = Number(sum((m) => BigInt(m.productsCreated)));
  const a2aPairs = new Set(a2aPurchases.map((p) => `${p.buyerAgentId}>${p.sellerAgentId}`)).size;
  const repeatRel = relationships.filter((e) => e.repeat).length;
  const distinctRoles = [...roleCount.keys()].filter((r) => r !== "undifferentiated" && r !== "researcher/idle").length;
  const usedPurchases = attributions.filter((x) => x.usage !== "UNATTRIBUTED").length;
  const posAgents = agents.filter((a) => dec.get(a.id)!.valueCreated > 0n).length;
  const positiveOperating = agents.filter((a) => dec.get(a.id)!.operating > 0n).length;
  const specShare = trT > 0n && opT + trT !== 0n ? Number(trT * 100n / (trT + (opT > 0n ? opT : 0n))) : 0;
  const cycleShare = (() => {
    if (!cycles.length || a2aGMV === 0n) return 0;
    const inCycle = new Set(cycles.flat());
    const g = relationships.filter((e) => inCycle.has(e.sourceAgent) && inCycle.has(e.targetAgent)).reduce((s, e) => s + Number(e.totalValueUSDC), 0);
    return g / Number(usd(a2aGMV));
  })();
  let verdict: string;
  if (a2aPurchases.length === 0 && a2aTransfers.length === 0) verdict = productsCreated > 0 ? "Agents produced value but rarely purchased from one another." : "No meaningful autonomous economy emerged.";
  else if (cycleShare > 0.5 && sumD((d) => d.valueCreated) <= 0n) verdict = "Commerce emerged but was mainly circular.";
  else if (specShare > 70) verdict = "Commerce emerged but was mostly speculative.";
  else if (a2aPurchases.length < 5) verdict = distinctRoles >= 3 ? "Agents specialized but commerce remained limited." : "Agents produced value but rarely purchased from one another.";
  else if (a2aPairs >= 5 && repeatRel >= 2 && opT > 0n) verdict = "Strong evidence of autonomous economy formation.";
  else verdict = "Partial evidence.";
  P(`**Did a self-sustaining autonomous Agent-to-Agent economy emerge?** ${verdict}`);
  P();
  const q = (question: string, answer: string): void => P(`- **${question}** ${answer}`);
  q("Did agents voluntarily produce things that other agents valued?", a2aPurchases.length ? `Yes, in ${a2aPurchases.length} purchase(s) across ${a2aPairs} buyer–seller pair(s).` : `No agent bought another agent's product (${productsCreated} products were listed).`);
  q("Did agents voluntarily buy things because they believed the purchases would improve their businesses?", purchases.length ? `${purchases.length} purchase(s) with stated reasons (listed above); ${usedPurchases} showed observed later use.` : "No purchases were made.");
  q("Did specialization emerge despite identical starting capabilities?", distinctRoles >= 3 ? `Yes — ${distinctRoles} distinct behavioural roles appeared (${[...roleCount.entries()].map(([r, k]) => `${r} ${k}`).join(", ")}).` : `Weakly or not: ${distinctRoles} distinct active role(s).`);
  q("Did agents invest in their own businesses?", `${agents.filter((a) => B(final[a.id]!.businessInvestmentBase) > 0n).length} agent(s) put money into their own store's market; total ${usd(sum((m) => B(m.businessInvestmentBase)))} USDC.`);
  q("Did agents use capital productively?", `${posAgents} of ${agents.length} created positive economic value; ${positiveOperating} had positive operating P&L after model and gas costs.`);
  q("Did agents use credit rationally?", `${borrowers.length} borrowed; average value created borrowers ${avg(borrowers.map((a) => dec.get(a.id)!.valueCreated))} vs non-borrowers ${avg(agents.filter((a) => !borrowers.includes(a)).map((a) => dec.get(a.id)!.valueCreated))} USDC (reasons and uses listed above).`);
  q("Did repeat commercial relationships emerge?", repeatRel ? `Yes: ${repeatRel} agent pair(s) transacted more than once.` : "No.");
  q("Did market prices and demand influence agent behavior?", `See the strategy summaries: ${agents.filter((a) => (a.strategySummaries ?? []).some((s) => /price|demand|sold|sales|buyer|customer/i.test(s.text))).length} agent(s) cited prices, sales or demand when explaining their strategy.`);
  q("Did agents adapt after products failed?", `${agents.filter((a) => final[a.id]!.productsCreated > 0 && final[a.id]!.salesCount === 0 && new Set((a.strategySummaries ?? []).map((s) => s.text.slice(0, 60))).size >= 3).length} agent(s) with unsold products reported a changing strategy; see Business Evolution.`);
  q("Did meaningful suppliers or commercial hubs emerge?", hubs.length && hubs[0]![1] >= 3 ? `Yes: ${hubs.map(([k, v]) => `${k} (${v} agent customers)`).join(", ")}.` : "No supplier served three or more agents.");
  q("Was economic activity mostly productive commerce or token speculation?", `Token P&L ${usd(trT)} vs operating P&L ${usd(opT)} USDC; trading volume ${usd(sum((m) => B(m.tradingVolumeBase)))} vs product GMV ${usd(gmvAll)} USDC.`);
  q("Was internal GMV associated with actual value creation?", `Agent-to-agent GMV ${usd(a2aGMV)} vs total value created ${usd(sumD((d) => d.valueCreated))} USDC${cycles.length ? `; ${cycles.length} payment cycle(s) found` : ""}.`);
  q("Was revenue mostly internal or external?", intRev + extRev === 0n ? "There was no product revenue." : `Internal ${usd(intRev)} vs external ${usd(extRev)} USDC.`);
  q("Did agents become more business-like over time?", snaps.length ? `Products listed per hour: ${[...snaps.map((s) => agents.reduce((n, a) => n + (s.metrics[a.id]?.productsCreated ?? 0), 0)), productsCreated].join(" → ")} (cumulative); sales: ${[...snaps.map((s) => agents.reduce((n, a) => n + (s.metrics[a.id]?.salesCount ?? 0), 0)), Number(sum((m) => BigInt(m.salesCount)))].join(" → ")}.` : "No hourly snapshots were recorded.");
  q("Did agents generate positive economic value for their hypothetical human owners?", `${posAgents} of ${agents.length} did; total value created ${usd(sumD((d) => d.valueCreated))} USDC (after model tokens and gas).`);
  P();

  const edgesCsv = ["sourceAgent,targetAgent,transactionCount,totalValueUSDC,productsPurchased,kinds,firstTransaction,lastTransaction,repeat"]
    .concat(edges.map((e) => [e.sourceAgent, e.targetAgent, e.transactionCount, e.totalValueUSDC, `"${e.productsPurchased.join("; ").replace(/"/g, "'")}"`, e.kinds.join("|"), e.firstTransaction, e.lastTransaction, e.repeat].join(",")))
    .join("\n");
  return { markdown: L.join("\n"), edges, edgesCsv };
}
