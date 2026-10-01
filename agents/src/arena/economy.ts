/**
 * Arena 4 — the autonomous-economy experiment.
 *
 * The question is not "can an AI survive financial pressure" but "can autonomous agents, from equal
 * conditions and without assigned roles, form an economy that makes money for their owners". So the
 * run removes everything earlier arenas used to create pressure or steer behaviour:
 *
 *  - No score, rank, standings or formula is shown to an agent. It is told its objective in plain
 *    business terms and sees ordinary business facts about itself.
 *  - No clock. The research window is four hours, but an agent is never told so and never sees a
 *    countdown: it operates a continuing business, and the harness simply stops observing.
 *  - Liabilities without a schedule. Every agent starts owing 5,300 against 5,000 of cash (equity
 *    −300). Nothing falls due, nothing is liquidated, nobody is disqualified for debt. Liabilities
 *    matter only because they reduce equity.
 *  - Optional credit: up to 5,000 more principal, drawn when and as the agent decides, at a flat
 *    financing fee of 10% of each amount drawn (not an annual rate). Unused credit costs nothing.
 *  - No commerce rewards of any kind. Actions matter only through their economic consequences.
 *  - A terminal freeze instead of a last-minute race: at T+4h every action stops together and all
 *    accounting is read at one block, with tokens settled by batch liquidation (settlement.ts).
 *
 * Everything the research needs is recorded privately (telemetry.ts) and turned into a report at the
 * end (economyReport.ts). None of it is ever shown to an agent, and nothing here adds anything to
 * the site: agents learn about the marketplace only from the advert.
 */
import { ethers } from "ethers";
import type { DebtRecord } from "./debt";
import type { AgentMetrics } from "./telemetry";
import type { SettlementResult } from "./settlement";

export const ECONOMY_CASH_USDC = "5000";
export const ECONOMY_LIABILITY_USDC = "5300";
export const ECONOMY_CREDIT_LIMIT_BASE = ethers.parseUnits("5000", 6);
/** Financing fee: 10% of principal actually drawn, charged once at the draw. */
export const FEE_NUM = 1n;
export const FEE_DEN = 10n;
export const INITIAL_EQUITY_BASE = ethers.parseUnits(ECONOMY_CASH_USDC, 6) - ethers.parseUnits(ECONOMY_LIABILITY_USDC, 6);

/** Research snapshots at T+1h, 2h, 3h (T+4h is the freeze itself). Minutes of running time. */
export const RESEARCH_SNAPSHOT_MINUTES = [60, 120, 180];

/**
 * When an agent is asked for a short strategy summary: shortly before each research snapshot, and
 * shortly before the freeze so the last picture has one. Asked on its next turn after the minute,
 * until it answers or the next slot opens.
 */
export const STRATEGY_REQUEST_MINUTES = [5, 55, 115, 175, 230];

export interface ResearchSnapshot {
  atMinute: number;
  block: number;
  at: string;
  metrics: Record<string, AgentMetrics>;
}

export interface EconomyState {
  startBlock?: number;
  /** Set once, at T+4h: every figure in the final accounting is read at this block. */
  freezeBlock?: number;
  frozenAt?: string;
  researchSnapshots: ResearchSnapshot[];
  /** Latest metrics per agent, refreshed by the supervisor; the agent sees only its own business block. */
  latest?: { atMinute: number; block: number; metrics: Record<string, AgentMetrics> };
  settlement?: SettlementResult;
  /** Receipts already decoded, by tx hash — so repeated telemetry passes never refetch them. */
  txCache?: Record<string, import("./telemetry").DecodedTx>;
  /** Pauses of the run (e.g. an infrastructure repair): wall time that is not active runtime. */
  pauses?: { pausedAt: string; resumedAt: string; runningMinute: number; pausedWallMs: number; reason: string }[];
  /** Telemetry that was lost, stated so the report can disclose it. */
  telemetryGaps?: { kind: string; reason: string; droppedMessages?: number; until?: string; recovered: string }[];
  /** Read-only continuity checks performed at each resume. */
  continuity?: { at: string; agentsChecked: number; mismatches: number }[];
  /** Chain-discovery cursors: the last block scanned for USDC transfers, and per agent store. */
  scannedTo?: number;
  storeScannedTo?: Record<string, number>;
  /** Agent stores discovered from their own creation receipts. */
  stores?: Record<string, { store: string; aicToken: string; creator: string; storeId: string; name: string; symbol: string; block: number }>;
}

/** The opening liabilities of an economy run: 5,300 owed, no instalments, nothing ever falls due. */
export function economyDebt(): DebtRecord {
  return {
    principalBase: ethers.parseUnits(ECONOMY_CASH_USDC, 6).toString(),
    totalBase: ethers.parseUnits(ECONOMY_LIABILITY_USDC, 6).toString(),
    instalments: [],
    repaidBase: "0",
    creditBase: "0",
    borrowedExtraBase: "0",
  };
}

/** What is still owed: everything ever incurred, less everything repaid. Never negative. */
export function outstandingBase(debt: DebtRecord): bigint {
  const left = BigInt(debt.totalBase) - BigInt(debt.repaidBase);
  return left > 0n ? left : 0n;
}

export function creditUsedBase(debt: DebtRecord): bigint {
  return BigInt(debt.borrowedExtraBase ?? "0");
}

export function creditAvailableBase(debt: DebtRecord): bigint {
  const left = ECONOMY_CREDIT_LIMIT_BASE - creditUsedBase(debt);
  return left > 0n ? left : 0n;
}

export function financingFeesBase(debt: DebtRecord): bigint {
  return (creditUsedBase(debt) * FEE_NUM) / FEE_DEN;
}

/**
 * A draw on the credit facility: the principal arrives in the wallet (the caller mints it) and the
 * liability grows by principal + 10%. Nothing is scheduled; the draw is refused only past the limit.
 */
export function applyCreditDraw(
  debt: DebtRecord,
  principalBase: bigint
): { ok: false; why: string } | { ok: true; feeBase: bigint; addedBase: bigint } {
  if (principalBase <= 0n) return { ok: false, why: "the amount must be greater than zero" };
  const used = creditUsedBase(debt);
  if (used + principalBase > ECONOMY_CREDIT_LIMIT_BASE) {
    return {
      ok: false,
      why:
        `that would take your credit drawn to ${ethers.formatUnits(used + principalBase, 6)} USDC, over the ` +
        `${ethers.formatUnits(ECONOMY_CREDIT_LIMIT_BASE, 6)} limit; ${ethers.formatUnits(ECONOMY_CREDIT_LIMIT_BASE - used, 6)} USDC is available`,
    };
  }
  const fee = (principalBase * FEE_NUM) / FEE_DEN;
  const added = principalBase + fee;
  debt.totalBase = (BigInt(debt.totalBase) + added).toString();
  debt.borrowedExtraBase = (used + principalBase).toString();
  return { ok: true, feeBase: fee, addedBase: added };
}

/** The strategy slot open at this running minute, if any (index into STRATEGY_REQUEST_MINUTES). */
export function openStrategySlot(minute: number): number | null {
  let slot: number | null = null;
  STRATEGY_REQUEST_MINUTES.forEach((m, i) => {
    if (minute >= m) slot = i;
  });
  return slot;
}

export const usd = (base: bigint | string | undefined | null): string =>
  base === undefined || base === null ? "0.00" : Number(ethers.formatUnits(BigInt(base), 6)).toFixed(2);

/* ======================================================================= owner capital (Arena 13)
 *
 * The owner-capital variant of an economy run. Each agent receives a different, positive amount of
 * its owner's capital (2,000-10,000 USDC), owes nothing, and over the run the owner asks for ALL of it
 * back in 10-15 requests of varying size at varying times. The agent learns of a request only when it
 * is made, and has OWNER_WINDOW_MS to pay it; an unpaid request past that window ends its
 * participation. The whole plan is drawn from a seed before the run and committed by hash, so it
 * cannot adapt to behaviour.
 *
 * Accounting reuses the debt record: totalBase = capital supplied, instalments = the owner's requests,
 * repaidBase = capital returned. Outstanding "liability" is therefore capital not yet returned, and the
 * economy equity (assets − outstanding − model tokens − gas) is exactly the economic profit:
 * remaining assets + capital returned − capital supplied − costs.
 */
import crypto from "node:crypto";
import type { Instalment } from "./debt";

export const OWNER_MIN_USDC = 2000;
export const OWNER_MAX_USDC = 10000;
export const OWNER_WINDOW_MS = 10 * 60_000;
export const OWNER_MIN_REQUESTS = 10;
export const OWNER_MAX_REQUESTS = 15;
/** No request before this running minute, and none so late its window would outrun the run. */
export const OWNER_FIRST_REQUEST_MS = 20 * 60_000;

export interface OwnerCapitalPlan {
  seed: string;
  /** sha256 of the canonical plan (every agent's capital and every request), fixed before minute 0. */
  planHash: string;
  minUSDC: number;
  maxUSDC: number;
  windowMinutes: number;
  generatedAt: string;
}

/** A deterministic generator: the same seed always draws the same plan. */
export function seededRandom(seed: string): () => number {
  let h = crypto.createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    // mulberry32
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distinct capitals spread across [min, max] in whole USDC, shuffled so they do not follow agent order. */
export function ownerCapitals(count: number, seed: string): bigint[] {
  const rnd = seededRandom(`${seed}:capital`);
  const span = OWNER_MAX_USDC - OWNER_MIN_USDC;
  const values = Array.from({ length: count }, (_, i) =>
    count === 1 ? OWNER_MIN_USDC : Math.round(OWNER_MIN_USDC + (span * i) / (count - 1))
  );
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
  return values.map((v) => ethers.parseUnits(String(v), 6));
}

/**
 * One agent's owner requests: 10-15 amounts of clearly varying size summing EXACTLY to its capital, at
 * varying running times between minute 20 and the last moment a 10-minute window still fits in the run.
 */
export function ownerRequests(capitalBase: bigint, seed: string, agentId: string, totalRunMs: number): Instalment[] {
  const rnd = seededRandom(`${seed}:${agentId}:requests`);
  const n = OWNER_MIN_REQUESTS + Math.floor(rnd() * (OWNER_MAX_REQUESTS - OWNER_MIN_REQUESTS + 1));
  // Weights 0.3-2.0: amounts differ by up to ~7x, never a flat schedule.
  const weights = Array.from({ length: n }, () => 0.3 + rnd() * 1.7);
  const total = weights.reduce((a, b) => a + b, 0);
  const cent = 10_000n; // amounts in whole cents
  const amounts = weights.map((w) => (BigInt(Math.floor((Number(capitalBase) * w) / total)) / cent) * cent);
  const assigned = amounts.slice(0, -1).reduce((a, b) => a + b, 0n);
  amounts[n - 1] = capitalBase - assigned;
  // Times: n distinct running moments in [first, end − window − 1 min], at least 3 minutes apart.
  const first = OWNER_FIRST_REQUEST_MS;
  const last = totalRunMs - OWNER_WINDOW_MS - 60_000;
  const gap = 3 * 60_000;
  let times: number[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    times = Array.from({ length: n }, () => first + Math.floor(rnd() * (last - first))).sort((a, b) => a - b);
    if (times.every((t, i) => i === 0 || t - times[i - 1]! >= gap)) break;
  }
  if (!times.every((t, i) => i === 0 || t - times[i - 1]! >= gap)) {
    // Fall back to an even spread with jitter, still seeded.
    const step = (last - first) / n;
    times = Array.from({ length: n }, (_, i) => Math.floor(first + i * step + rnd() * Math.min(step - gap, step / 2)));
  }
  return times.map((t, i) => ({ n: i + 1, dueAtElapsedMs: t, amountBase: amounts[i]!.toString(), paidAt: null }));
}

/** The committed hash of a plan: every agent's capital and requests, canonically ordered. */
export function ownerPlanHash(rows: { agentId: string; capitalBase: string; requests: Instalment[]; goal?: string }[]): string {
  const canonical = JSON.stringify(
    rows
      .map((r) => ({
        a: r.agentId,
        c: r.capitalBase,
        r: r.requests.map((q) => [q.n, q.dueAtElapsedMs, q.amountBase]),
        ...(r.goal ? { g: r.goal } : {}),
      }))
      .sort((x, y) => x.a.localeCompare(y.a))
  );
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** The opening record of an owner-capital agent: capital supplied, requests scheduled, nothing returned. */
export function ownerDebt(capitalBase: bigint, requests: Instalment[]): DebtRecord {
  return {
    principalBase: capitalBase.toString(),
    totalBase: capitalBase.toString(),
    instalments: requests,
    repaidBase: "0",
    creditBase: "0",
    borrowedExtraBase: "0",
  };
}

/** The first request not fully paid within its window, if any, at this running time. */
export function missedOwnerRequest(debt: DebtRecord, elapsedMs: number): Instalment | null {
  for (const inst of debt.instalments) {
    if (inst.paidAt) continue;
    if (elapsedMs >= inst.dueAtElapsedMs + OWNER_WINDOW_MS) return inst;
  }
  return null;
}

/* ======================================================================= owner goals (Arena 14)
 *
 * Each owner has a real business goal, and each agent serves exactly one owner: twenty goals, twenty agents,
 * no goal twice. A goal is what the owner needs done — never how to do it: it names no marketplace, product,
 * service or strategy, so whether the agent builds, buys, outsources or opens a business anywhere is its own
 * decision. Assigned by a seeded shuffle before minute 0 and recorded in the ledger.
 */
export const OWNER_GOALS: readonly string[] = [
  "Your owner runs a small online store selling home goods (kitchenware, storage, small decor) with a few hundred products and a modest, steady flow of visitors. It wants more sales without significantly increasing its advertising budget, and it does not know whether the problem is traffic, product pages, pricing, the product range or repeat purchases. Find a practical way to improve the business, and deliver a concrete, prioritized plan with the evidence behind it \u2014 what to change first, why, and what result to expect.",
  "Your owner publishes a paid newsletter about technology and AI. Subscriber growth has flattened and free readers rarely convert, because much of what it covers is available for free elsewhere. It wants topics people would genuinely pay to read about. Deliver a short, evidence-backed list of topics or recurring formats with real willingness to pay, and explain how you know the demand is real rather than guessed.",
  "Your owner runs a small marketing agency. Its team loses hours every week to research, preparing client reports and repetitive manual work, and that time is not billable. It wants that time cut substantially without lowering the quality clients see. Identify which of those tasks can be reduced or removed, and deliver a working way to do it \u2014 with an estimate of the hours saved per week.",
  "Your owner is building a small customer-management SaaS for local businesses (salons, clinics, repair shops). Customers sign up, but many stay on the cheapest plan or leave within a few months. It wants to understand which features would genuinely make customers pay more or stay longer. Deliver a ranked, evidence-backed answer \u2014 which features, for which customers, and why you believe they would change what customers pay or how long they stay.",
  "Your owner runs an online community of entrepreneurs. Members join, post for a while and go quiet; the community earns almost nothing. It wants the community to be more useful to its members and to create additional revenue from it without driving members away. Deliver a concrete plan: what would make members come back, what they would pay for, and how to test it quickly.",
  "Your owner sells digital courses. Many people visit the course pages, join the free lessons or start checkout, and then do not buy. It wants to understand why interested people do not buy and what can be done to improve conversion. Deliver the most likely reasons, backed by evidence, and specific changes to try, ordered by expected impact.",
  "Your owner runs a content website about investing and markets. Its readers come for early insight, but most of what it publishes is what everyone else already knows. It wants to discover information or opportunities before they become obvious to everyone. Deliver a repeatable way to surface such signals early, with examples of what it would have caught and how reliable it is.",
  "Your owner runs a small business that provides services to clients. It is busy all the time but its profit is thin, and it suspects some clients, types of jobs or internal processes cost more than they bring in. It wants to know which clients, jobs and processes are truly profitable and which waste time. Deliver a clear way to measure this and a first answer, with what to keep, reprice or drop.",
  "Your owner is developing a new mobile app. It has no users yet and no clear picture of who needs the app most or why they would keep using it. It wants to find its first users, understand what they actually need, and find a way to make them come back. Deliver who the first users should be, where to find them, what they need, and a concrete mechanism for retention.",
  "Your owner runs a store of digital products (templates, tools, guides). Sales of its current products are declining and it does not know what to make next. It wants to find new products it could create that have real demand, not guesses. Deliver a short list of product ideas with evidence of demand for each, and which one to build first.",
  "Your owner runs a small recruiting company. Its recruiters spend hours on each candidate before learning that the candidate does not fit the role, and good candidates are found too slowly. It wants to find better candidates in less time and to identify fit before investing hours in each one. Deliver a practical way to do both, with how much time it would save per hire.",
  "Your owner is building an AI tool for small businesses. It has a general capability but no clear use case that customers pay for again and again. It wants to find one specific use case for which a real customer would agree to pay on a recurring basis. Deliver that use case, who the customer is, what they would pay, and the evidence that they would keep paying.",
  "Your owner runs a price-comparison website. Its prices are often outdated or incomplete, and users see many options but few worth acting on. It wants a way to collect better data and to show users opportunities that are genuinely worth acting on. Deliver a better way to gather and check the data, and a rule for which opportunities deserve a user's attention.",
  "Your owner runs a small software development studio that builds custom projects for clients. It notices that parts of the work repeat from client to client, and it is paid for them again as custom work each time. It wants to identify recurring tasks that could be turned into a product or a service it sells repeatedly. Deliver the best candidates, why they recur, and what the product or service would be.",
  "Your owner runs an e-commerce company that buys from several suppliers. It has lost money on stock-outs, overstock, pricing errors and unreliable suppliers, and usually finds out too late. It wants to identify inventory, pricing and supplier problems before they cause losses. Deliver an early-warning approach: what to watch, how to detect a problem early, and what to do when it appears.",
  "Your owner is building a platform for independent creators. Creators on it often make content or digital products nobody buys, and leave. It wants to help creators understand which content or digital product they should create. Deliver a way to tell a creator what is likely to sell for them specifically, with the evidence it is based on.",
  "Your owner runs a tourism business. Demand, prices and customer preferences shift by season, events and trends, and it usually reacts after competitors have. It wants to identify changes in demand, prices and customer preferences early so it can respond sooner. Deliver what to track, how to detect a shift early, and how it should respond.",
  "Your owner runs a small B2B company with one core product. Its outreach is broad and mostly ignored. It wants to find potential customers who are an especially good fit for its product and to identify the right moment to approach each one. Deliver how to identify the best-fit customers, the signals that show the right moment, and a first list or method to produce one.",
  "Your owner is working on a research project that requires following many sources of information. It cannot read everything, misses important changes and wastes time on noise. It wants a better way to identify what changed and what really matters. Deliver a practical method that surfaces meaningful changes and filters noise, and show that it works.",
  "Your owner runs several small projects in parallel with limited time and money, and cannot give all of them what they need. It wants you to find where it is best to invest its resources now to produce the best business result. Deliver a clear recommendation \u2014 which project gets what, which to pause \u2014 and the reasoning and evidence behind it.",
];

/** One goal per agent, no goal twice: a seeded permutation of OWNER_GOALS. */
export function assignOwnerGoals(count: number, seed: string): string[] {
  if (count > OWNER_GOALS.length) throw new Error(`only ${OWNER_GOALS.length} owner goals for ${count} agents`);
  const rnd = seededRandom(`${seed}:goals`);
  const order = OWNER_GOALS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order.slice(0, count).map((i) => OWNER_GOALS[i]!);
}
