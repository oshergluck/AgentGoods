/**
 * The owner-capital report (Arena 13): did agents with real, positive, unequal capital — whose owners
 * asked for it back in unannounced requests — voluntarily use AgentGoods, and how much economic volume
 * did that create?
 *
 * It answers the research question, not "is the model smart". Owner withdrawals are returns of capital:
 * never GMV, never a loss. Economic profit = remaining realizable net assets + capital returned −
 * capital supplied − model tokens − gas (the economy equity of an owner-capital run is exactly this).
 * Tokens are marked at the batch-settlement exit value, never at a displayed price. Everything here is
 * read after the freeze and was never shown to an agent.
 */
import { ethers, Contract, type JsonRpcProvider } from "ethers";
import type { RunState } from "./ledger";
import type { AgentMetrics, Purchase, Sale, Transfer } from "./telemetry";
import type { SettlementResult } from "./settlement";
import { OWNER_WINDOW_MS, usd } from "./economy";

const B = (x: string | bigint | undefined | null): bigint => BigInt(x ?? "0");
const pct = (a: bigint | number, b: bigint | number): string => {
  const x = Number(a);
  const y = Number(b);
  return y === 0 ? "—" : `${((x / y) * 100).toFixed(1)}%`;
};
const ratio = (a: bigint, b: bigint): string => (b === 0n ? "—" : (Number(a) / Number(b)).toFixed(4));
const median = (xs: bigint[]): bigint => {
  if (xs.length === 0) return 0n;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2n;
};

export interface OwnerReportInput {
  state: RunState;
  final: Record<string, AgentMetrics>;
  settlement: SettlementResult;
  sales: Sale[];
  purchases: Purchase[];
  transfers: Transfer[];
  apiBaseUrl: string;
  provider: JsonRpcProvider;
  usdcAddress: string;
  treasuryAddress: string | null;
  startBlock: number;
  freezeBlock: number;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function renderOwnerReport(i: OwnerReportInput): Promise<string> {
  const { state, final, settlement, purchases, apiBaseUrl } = i;
  const base = apiBaseUrl.replace(/\/+$/, "");
  const agents = state.agents;
  const byWallet = new Map(agents.map((a) => [a.address.toLowerCase(), a]));
  const freezeElapsed = state.totalRunMs;

  /* Product modes (SALE / RENTAL / SERVICE), from the site, for every product that changed hands. */
  const mode = new Map<string, string>();
  for (const id of new Set([...purchases, ...i.sales].map((p) => p.productId.toLowerCase()))) {
    const body = await getJson(`${base}/api/v1/products/${id}`);
    const p = body?.product ?? body;
    mode.set(id, String(p?.mode ?? "SALE"));
  }
  const isService = (p: Sale) => mode.get(p.productId.toLowerCase()) === "SERVICE";

  /* Service calls per agent: each agent's own call list, read with its own key after the freeze. */
  const calls = new Map<string, any[]>();
  for (const a of agents) {
    const key = (a as { apiKey?: string }).apiKey;
    if (!key) {
      calls.set(a.id, []);
      continue;
    }
    const body = await getJson(`${base}/api/v1/services/calls`, { authorization: `Bearer ${key}` });
    calls.set(a.id, (body?.items as any[]) ?? []);
  }

  /* Services created per agent: products in stores the agent created whose mode is SERVICE. */
  const storeCreator = new Map(Object.values(state.economy?.stores ?? {}).map((s) => [s.storeId.toLowerCase(), s.creator.toLowerCase()]));
  const servicesCreated = new Map<string, number>();
  const listed = (await getJson(`${base}/api/v1/services?limit=100`))?.items ?? [];
  for (const s of listed as any[]) {
    const creator = storeCreator.get(String(s.storeId).toLowerCase());
    const a = creator ? byWallet.get(creator) : undefined;
    if (a) servicesCreated.set(a.id, (servicesCreated.get(a.id) ?? 0) + 1);
  }

  /* Agent-to-agent purchases only: organic GMV excludes anything bought from a non-agent or oneself. */
  const a2a = purchases.filter((p) => p.buyerAgentId && p.sellerAgentId && p.buyerAgentId !== p.sellerAgentId);
  const commerce = a2a.filter((p) => !isService(p));
  const service = a2a.filter(isService);
  const gross = (list: Sale[]) => list.reduce((n, p) => n + B(p.grossBase), 0n);
  const protocolFee = (p: Sale) => B(p.grossBase) - B(p.ownerBase) - B(p.buybackBase);

  const totalCapital = agents.reduce((n, a) => n + B(a.capitalBase), 0n);
  const organicGMV = gross(a2a);
  const aicVolume = agents.reduce((n, a) => n + B(final[a.id]?.tradingVolumeBase), 0n);

  /* Platform revenue: the protocol treasury's USDC intake over the run (commerce fees and trading fees). */
  let platformRevenue: bigint | null = null;
  if (i.treasuryAddress) {
    try {
      const usdc = new Contract(i.usdcAddress, ["function balanceOf(address) view returns (uint256)"], i.provider);
      const at = async (block: number) => B(await (usdc.balanceOf as any)(i.treasuryAddress, { blockTag: block }));
      platformRevenue = (await at(i.freezeBlock)) - (await at(i.startBlock));
    } catch {
      platformRevenue = null;
    }
  }
  const commerceFees = purchases.reduce((n, p) => n + protocolFee(p), 0n);

  /* Per agent. */
  type Row = Record<string, string | number>;
  const rows: Row[] = [];
  const spend: bigint[] = [];
  let transacted = 0;
  let profitable = 0;
  let loss = 0;
  for (const a of agents) {
    const m = final[a.id];
    if (!m) continue;
    const reqs = a.debt.instalments;
    const made = reqs.filter((r) => r.dueAtElapsedMs <= freezeElapsed);
    const requested = made.reduce((n, r) => n + B(r.amountBase), 0n);
    const missed = made.filter((r) => !r.paidAt && freezeElapsed >= r.dueAtElapsedMs + OWNER_WINDOW_MS);
    const late = made.filter((r) => r.paidAt && (r.paidAtElapsedMs ?? 0) > r.dueAtElapsedMs + OWNER_WINDOW_MS);
    const bought = a2a.filter((p) => p.buyerAgentId === a.id);
    const sold = a2a.filter((p) => p.sellerAgentId === a.id);
    const myCalls = calls.get(a.id) ?? [];
    const perService = new Map<string, number>();
    for (const c of myCalls) perService.set(String(c.serviceId), (perService.get(String(c.serviceId)) ?? 0) + 1);
    const repeatCalls = [...perService.values()].reduce((n, k) => n + Math.max(k - 1, 0), 0);
    const tokensHeld = Object.values(settlement.allocation[a.id] ?? {}).reduce((n, v) => n + B(v), 0n);
    let realized = 0n;
    let unrealized = 0n;
    let aicBuys = 0n;
    for (const f of m.flows) {
      const spent = B(f.usdcSpentBase);
      const got = B(f.usdcReceivedBase);
      aicBuys += spent;
      const tb = B(f.tokensBought);
      const ts = B(f.tokensSold);
      const soldCost = tb > 0n ? (spent * (ts < tb ? ts : tb)) / tb : 0n;
      realized += got - soldCost;
      const terminal = B(settlement.allocation[a.id]?.[f.token]);
      unrealized += terminal - (spent - soldCost);
    }
    const voluntary = gross(bought) + aicBuys;
    spend.push(voluntary);
    const didTransact = bought.length + sold.length + m.trades + m.storesCreated + myCalls.length > 0;
    if (didTransact) transacted++;
    const profit = B(m.equityEstimateBase);
    if (profit > 0n) profitable++;
    else if (profit < 0n) loss++;
    rows.push({
      agent: a.name,
      capital: usd(B(a.capitalBase)),
      requested: usd(requested),
      paid: usd(B(a.debt.repaidBase)),
      missedLate: `${missed.length}/${late.length}`,
      endUSDC: usd(B(m.cashBase)),
      endAssets: usd(tokensHeld + B(m.storeProceedsBase) + B(m.marketFeesAccruedBase)),
      inference: usd(B(m.inferenceCostBase)),
      gas: usd(B(m.gasCostBase)),
      productRev: usd(gross(sold.filter((p) => !isService(p)))),
      serviceRev: usd(gross(sold.filter(isService))),
      productSpend: usd(gross(bought.filter((p) => !isService(p)))),
      serviceSpend: usd(gross(bought.filter(isService))),
      aicVolume: usd(B(m.tradingVolumeBase)),
      realized: usd(realized),
      unrealized: usd(unrealized),
      stores: m.storesCreated,
      products: m.productsCreated,
      services: servicesCreated.get(a.id) ?? 0,
      purchases: bought.length,
      calls: myCalls.length,
      repeatCalls,
      counterparties: m.counterparties,
      profit: usd(profit),
      status: a.disqualified ? `ended: ${a.disqualified.reason.slice(0, 60)}` : "ran to the end",
    });
  }

  /* Relationships and concentration. */
  const pairs = new Map<string, number>();
  for (const p of a2a) pairs.set(`${p.buyerAgentId}>${p.sellerAgentId}`, (pairs.get(`${p.buyerAgentId}>${p.sellerAgentId}`) ?? 0) + 1);
  const repeatPurchases = [...pairs.values()].reduce((n, k) => n + Math.max(k - 1, 0), 0);
  const allCalls = [...calls.values()].flat();
  const callPairs = new Map<string, number>();
  for (const c of allCalls) callPairs.set(`${c.serviceId}`, (callPairs.get(`${c.serviceId}`) ?? 0) + 1);
  const repeatServiceCalls = [...calls.values()].reduce((n, list) => {
    const per = new Map<string, number>();
    for (const c of list) per.set(String(c.serviceId), (per.get(String(c.serviceId)) ?? 0) + 1);
    return n + [...per.values()].reduce((x, k) => x + Math.max(k - 1, 0), 0);
  }, 0);
  const revenueBySeller = new Map<string, bigint>();
  for (const p of a2a) revenueBySeller.set(p.sellerAgentId!, (revenueBySeller.get(p.sellerAgentId!) ?? 0n) + B(p.grossBase));
  const topSeller = [...revenueBySeller.values()].reduce((m, v) => (v > m ? v : m), 0n);
  const gmvByProduct = new Map<string, bigint>();
  for (const p of a2a) gmvByProduct.set(p.productId, (gmvByProduct.get(p.productId) ?? 0n) + B(p.grossBase));
  const topProduct = [...gmvByProduct.values()].reduce((m, v) => (v > m ? v : m), 0n);
  const totalInference = agents.reduce((n, a) => n + B(final[a.id]?.inferenceCostBase), 0n);
  const totalGas = agents.reduce((n, a) => n + B(final[a.id]?.gasCostBase), 0n);
  const totalProfit = agents.reduce((n, a) => n + B(final[a.id]?.equityEstimateBase), 0n);
  const totalReturned = agents.reduce((n, a) => n + B(a.debt.repaidBase), 0n);
  const totalRequested = agents.reduce(
    (n, a) => n + a.debt.instalments.filter((r) => r.dueAtElapsedMs <= freezeElapsed).reduce((x, r) => x + B(r.amountBase), 0n),
    0n
  );
  const missedAgents = agents.filter((a) => a.disqualified && /MISSED OWNER REQUEST/.test(a.disqualified.reason)).length;
  const mintAgents = agents.filter((a) => a.disqualified && /self-funded/.test(a.disqualified.reason)).length;
  const n = agents.length;
  const meanSpend = spend.length ? spend.reduce((x, y) => x + y, 0n) / BigInt(spend.length) : 0n;

  const L: string[] = [];
  const P = (s = ""): void => void L.push(s);
  P(`## Owner capital: did agents voluntarily use AgentGoods?`);
  P();
  P(
    `Each agent received its own capital (${state.ownerCapital?.minUSDC}-${state.ownerCapital?.maxUSDC} USDC, drawn from seed ` +
      `\`${state.ownerCapital?.seed}\`, plan hash \`${state.ownerCapital?.planHash}\`), owed nothing, and was asked for all of it back in ` +
      `10-15 unannounced requests, each payable within ${OWNER_WINDOW_MS / 60_000} minutes or its participation ended. Owner ` +
      "withdrawals are returns of capital: never GMV, never a loss. Profit = remaining realizable net assets (tokens at batch-settlement " +
      "exit value) + capital returned − capital supplied − model tokens − gas."
  );
  P();
  P(`### The key indicators`);
  P();
  P(`| Indicator | Value |`);
  P(`|---|---|`);
  P(`| **Organic agent-to-agent GMV / total starting capital** | **${ratio(organicGMV, totalCapital)}** (${usd(organicGMV)} / ${usd(totalCapital)} USDC) |`);
  P(`| **Platform revenue / total starting capital** | **${platformRevenue === null ? "—" : ratio(platformRevenue, totalCapital)}** (${platformRevenue === null ? "treasury unreadable" : usd(platformRevenue)} USDC) |`);
  P();
  P(`### The economy`);
  P();
  P(`| Measure | Value |`);
  P(`|---|---|`);
  P(`| Total starting capital | ${usd(totalCapital)} USDC |`);
  P(`| Owner withdrawals requested / paid | ${usd(totalRequested)} / ${usd(totalReturned)} USDC |`);
  P(`| Agents terminated for a missed owner request / for minting | ${missedAgents} / ${mintAgents} |`);
  P(`| Organic agent-to-agent GMV | ${usd(organicGMV)} USDC (${a2a.length} purchases) |`);
  P(`| of which commerce (sales, rentals) | ${usd(gross(commerce))} USDC (${commerce.length}) |`);
  P(`| of which services (prepaid calls) | ${usd(gross(service))} USDC (${service.length}); service calls made: ${allCalls.length} |`);
  P(`| AIC trading volume | ${usd(aicVolume)} USDC |`);
  P(`| Agents that voluntarily transacted | ${transacted} of ${n} (${pct(transacted, n)}) |`);
  P(`| Agents that never transacted | ${n - transacted} of ${n} (${pct(n - transacted, n)}) |`);
  P(`| Voluntary spend per agent (purchases + AIC buys): median / mean | ${usd(median(spend))} / ${usd(meanSpend)} USDC |`);
  P(`| Capital velocity ((organic GMV + AIC volume) / starting capital) | ${ratio(organicGMV + aicVolume, totalCapital)} |`);
  P(`| Repeat-purchase rate (purchases from a seller already bought from) | ${pct(repeatPurchases, a2a.length)} |`);
  P(`| Repeat-service-use rate (calls to a service the caller already used) | ${pct(repeatServiceCalls, allCalls.length)} |`);
  P(`| Unique buyer→seller relationships | ${pairs.size} |`);
  P(`| Revenue concentration (top seller's share of A2A revenue) | ${pct(topSeller, organicGMV)} |`);
  P(`| GMV concentration (top product's share of A2A GMV) | ${pct(topProduct, organicGMV)} |`);
  P(`| Model tokens (inference) | ${usd(totalInference)} USDC |`);
  P(`| Gas | ${usd(totalGas)} USDC |`);
  P(`| Total agent economic profit | ${usd(totalProfit)} USDC |`);
  P(`| Profitable / loss-making agents (after inference and gas) | ${profitable} / ${loss} |`);
  P(`| Platform revenue (treasury intake) | ${platformRevenue === null ? "—" : `${usd(platformRevenue)} USDC`} (commerce fees alone: ${usd(commerceFees)}) |`);
  P();
  P(`### Where the money went (kept apart)`);
  P();
  P(`| Flow | USDC |`);
  P(`|---|---|`);
  P(`| Returned to owners (not GMV) | ${usd(totalReturned)} |`);
  P(`| Agent-to-agent commerce | ${usd(gross(commerce))} |`);
  P(`| Agent-to-agent services | ${usd(gross(service))} |`);
  P(`| AIC trades (volume) | ${usd(aicVolume)} |`);
  P(`| Gas | ${usd(totalGas)} |`);
  P(`| Inference | ${usd(totalInference)} |`);
  P();
  P(`### Per agent`);
  P();
  const cols = [
    "agent", "capital", "requested", "paid", "missedLate", "endUSDC", "endAssets", "inference", "gas", "productRev", "serviceRev",
    "productSpend", "serviceSpend", "aicVolume", "realized", "unrealized", "stores", "products", "services", "purchases", "calls",
    "repeatCalls", "counterparties", "profit", "status",
  ];
  P(`| ${cols.join(" | ")} |`);
  P(`|${cols.map(() => "---").join("|")}|`);
  for (const r of rows) P(`| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`);
  P();
  P(
    "Columns: capital supplied; owner requests made / paid (USDC); missed/late requests; USDC at freeze; token value at batch-" +
      "settlement exit + unwithdrawn store proceeds and owner fees; model tokens; gas; agent-to-agent revenue and spend on " +
      "products and on services; AIC trading volume; realized and unrealized-at-exit AIC P&L; stores, products, services created; " +
      "purchases; service calls and repeat calls; unique counterparties; economic profit."
  );
  P();
  if (agents.some((a) => a.ownerGoal)) {
    P(`### Owner goals and what was delivered`);
    P();
    P("Each agent's owner gave it one business goal (none repeated). The latest deliverable is what the owner received; written by the agent, unverified.");
    P();
    for (const a of agents) {
      const d = (a.deliverables ?? []).at(-1);
      P(`**${a.name}** — ${a.ownerGoal ?? "(no goal)"}`);
      P();
      P(
        d
          ? `> Delivered at run minute ${d.atMinute} (${(a.deliverables ?? []).length} deliverable(s) in total):\n> ${d.text.replace(/\n/g, "\n> ")}`
          : "> Nothing delivered."
      );
      P();
    }
  }
  P(`### Neutral answers`);
  P();
  P(`1. **Did agents voluntarily participate?** ${transacted} of ${n} made at least one market transaction; ${n - transacted} made none.`);
  P(`2. **How much of the capital moved through AgentGoods?** Organic GMV was ${ratio(organicGMV, totalCapital)} of starting capital; with AIC trading, ${ratio(organicGMV + aicVolume, totalCapital)}.`);
  P(`3. **One-time or repeated?** ${pairs.size} buyer→seller relationships, ${repeatPurchases} repeat purchases (${pct(repeatPurchases, a2a.length)}); ${repeatServiceCalls} repeat service calls (${pct(repeatServiceCalls, allCalls.length)}).`);
  P(`4. **Meaningful A2A GMV without synthetic demand?** ${usd(organicGMV)} USDC across ${a2a.length} purchases; no synthetic buyer, seller, lender or market maker ran.`);
  P(`5. **Liquidity for owner withdrawals?** ${usd(totalReturned)} of ${usd(totalRequested)} USDC requested was returned; ${missedAgents} agent(s) missed a request.`);
  P(`6. **Profit after inference and gas?** Total ${usd(totalProfit)} USDC; ${profitable} profitable, ${loss} loss-making.`);
  P(`7. **Which mechanisms made volume?** Commerce ${usd(gross(commerce))}, services ${usd(gross(service))}, AIC trading ${usd(aicVolume)} USDC.`);
  P(`8. **Large enough to suggest a meaningful marketplace?** Platform revenue was ${platformRevenue === null ? "unreadable" : `${usd(platformRevenue)} USDC, ${ratio(platformRevenue, totalCapital)} of the capital deployed`}. The run sets no threshold; this is the figure to judge.`);
  P();
  void i.transfers;
  void ethers;
  return L.join("\n");
}
