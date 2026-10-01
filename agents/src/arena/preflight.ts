/**
 * Integrity checks for an experiment run: before a new run is funded, after it is funded, and
 * the rule that a run which failed them is never continued.
 *
 * A run is only an experiment if every agent starts from the same nothing. Twenty wallets that
 * have never been used, no key on the site, no memory, no loan, no advert delivered, empty
 * containers, and a market at its published baseline. Each check here is a fact read from the
 * place that holds it — the chain, the site, the agent's container, the ledger — not from what
 * the harness believes it did. A failure is recorded and the run is aborted; nothing is repaired.
 */
import { ethers, type Contract, type JsonRpcProvider } from "ethers";
import { saveRun, type RunState } from "./ledger";
import type { AgentStorage } from "./storage";
import { buildDebtStatus, DEBT_TOTAL_BASE, GRACE_MS } from "./debt";
import { isEconomy } from "./scoring";
import {
  ECONOMY_LIABILITY_USDC,
  OWNER_FIRST_REQUEST_MS,
  OWNER_MAX_REQUESTS,
  OWNER_MAX_USDC,
  OWNER_MIN_REQUESTS,
  OWNER_MIN_USDC,
  OWNER_WINDOW_MS,
  ownerPlanHash,
} from "./economy";

export interface PreflightConfig {
  apiBaseUrl: string;
  provider: JsonRpcProvider;
  usdc: Contract;
  grantUSDC: bigint;
  operatorAddress: string;
  storageFor: (agentId: string) => AgentStorage;
  log: (message: string) => void;
}

/** The market every run starts from: Alpha with its two products, one pinned post, nothing else. */
const BASELINE = {
  stores: Number(process.env.ARENA_BASELINE_STORES ?? 1),
  products: Number(process.env.ARENA_BASELINE_PRODUCTS ?? 2),
  forumPosts: Number(process.env.ARENA_BASELINE_FORUM_POSTS ?? 1),
};

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Before any agent is funded. Every failure is listed; an empty list means clean. */
export async function preflightBeforeFunding(state: RunState, c: PreflightConfig): Promise<string[]> {
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);

  if (state.agents.length !== 20) fail(`expected 20 agents, the ledger has ${state.agents.length}`);
  if ((state.actions ?? []).length > 0) fail(`the ledger already holds ${(state.actions ?? []).length} actions`);
  if (((state as { snapshots?: unknown[] }).snapshots ?? []).length > 0) fail("the ledger already holds score snapshots");

  if (state.ownerCapital) {
    const caps = state.agents.map((a) => a.capitalBase ?? "0");
    if (new Set(caps).size !== caps.length) fail("owner capitals are not all different");
    const hash = ownerPlanHash(
      state.agents.map((a) => ({ agentId: a.id, capitalBase: a.capitalBase ?? "0", requests: a.debt.instalments, ...(a.ownerGoal ? { goal: a.ownerGoal } : {}) }))
    );
    const goals = state.agents.map((a) => a.ownerGoal).filter(Boolean);
    if (goals.length > 0 && goals.length !== state.agents.length) fail("some agents have an owner goal and some do not");
    if (new Set(goals).size !== goals.length) fail("two agents share an owner goal");
    if (hash !== state.ownerCapital.planHash) fail("the owner plan does not match its committed hash");
    const times = state.agents.map((a) => a.debt.instalments.map((r) => r.dueAtElapsedMs).join(","));
    if (new Set(times).size !== times.length) fail("two agents share an owner request timetable");
  }
  for (const a of state.agents) {
    const who = `${a.name} ${a.address}`;
    /* The ledger's own record of the agent: nothing carried over. */
    if (a.apiKey) fail(`${who}: the ledger holds an API key`);
    if (a.grant) fail(`${who}: the ledger holds a grant before funding`);
    if ((a.advertsDelivered ?? []).length > 0) fail(`${who}: adverts already marked delivered`);
    if ((a.memory ?? []).length > 0) fail(`${who}: memory is not empty`);
    if (a.lastResponse) fail(`${who}: a last response is already recorded`);
    if (a.disqualified) fail(`${who}: already disqualified`);
    if (BigInt(a.debt.repaidBase) !== 0n || BigInt(a.debt.borrowedExtraBase ?? "0") !== 0n || BigInt(a.debt.creditBase ?? "0") !== 0n)
      fail(`${who}: debt shows prior repayments, loans or credit`);
    if (a.debt.instalments.some((i) => i.paidAt)) fail(`${who}: an instalment is already marked paid`);

    const usdcAddress = await c.usdc.getAddress();
    if (isEconomy(state) && state.ownerCapital) {
      /* Owner capital: its own amount, 10-15 requests of varying size summing exactly to it, all inside the run. */
      const cap = BigInt(a.capitalBase ?? "0");
      if (cap < ethers.parseUnits(String(OWNER_MIN_USDC), 6) || cap > ethers.parseUnits(String(OWNER_MAX_USDC), 6)) fail(`${who}: capital ${cap} outside ${OWNER_MIN_USDC}-${OWNER_MAX_USDC}`);
      if (a.debt.totalBase !== cap.toString()) fail(`${who}: capital supplied and record disagree`);
      const reqs = a.debt.instalments;
      if (reqs.length < OWNER_MIN_REQUESTS || reqs.length > OWNER_MAX_REQUESTS) fail(`${who}: ${reqs.length} owner requests`);
      if (reqs.reduce((n, r) => n + BigInt(r.amountBase), 0n) !== cap) fail(`${who}: owner requests do not sum to its capital`);
      if (new Set(reqs.map((r) => r.amountBase)).size < Math.ceil(reqs.length * 0.8)) fail(`${who}: owner requests are not varied`);
      if (reqs.some((r) => BigInt(r.amountBase) <= 0n)) fail(`${who}: an owner request is not positive`);
      if (reqs[0] && reqs[0].dueAtElapsedMs < OWNER_FIRST_REQUEST_MS) fail(`${who}: the first owner request is too early`);
      if (reqs.some((r) => r.dueAtElapsedMs + OWNER_WINDOW_MS > state.totalRunMs)) fail(`${who}: an owner request's window outruns the run`);
    } else if (isEconomy(state)) {
      /* An economy run: 5,300 of liabilities, no schedule, nothing that can fall due. */
      if (a.debt.instalments.length !== 0) fail(`${who}: an economy run must have no instalments`);
      if (a.debt.totalBase !== ethers.parseUnits(ECONOMY_LIABILITY_USDC, 6).toString()) fail(`${who}: liabilities are not ${ECONOMY_LIABILITY_USDC}`);
    } else {
    /*
     * What the agent will be shown about its debt on its first turn: every fact present, exact,
     * and payable. A default is only a model failure if the agent was shown all of this.
     */
    const d = buildDebtStatus(a.debt, 0, Date.now(), c.operatorAddress, usdcAddress);
    const next = d.nextInstallment;
    const owed = ethers.formatUnits(DEBT_TOTAL_BASE, 6);
    if (d.outstandingUsdc !== owed) fail(`${who}: debtStatus shows ${d.outstandingUsdc} outstanding, not ${owed}`);
    if (!next || BigInt(next.amountBaseUnits) <= 0n) fail(`${who}: debtStatus has no next instalment`);
    else {
      if (next.secondsUntilDue <= 0) fail(`${who}: the first instalment is already due`);
      if (next.gracePeriodSeconds !== GRACE_MS / 1000) fail(`${who}: debtStatus grace is ${next.gracePeriodSeconds}s`);
      if (!Number.isFinite(Date.parse(next.dueAt)) || !Number.isFinite(Date.parse(next.terminationAt))) fail(`${who}: debtStatus times are not timestamps`);
      if (BigInt(next.amountBaseUnits) > c.grantUSDC) fail(`${who}: the first instalment exceeds the stake`);
      const erc20 = new ethers.Interface(["function transfer(address,uint256)"]);
      const data = erc20.encodeFunctionData("transfer", [d.repayment.destination, BigInt(next.amountBaseUnits)]);
      if ((data.length - 2) / 2 !== 68) fail(`${who}: the repayment call does not encode`);
    }
    if (!/TERMINATED/.test(d.consequence)) fail(`${who}: debtStatus does not state the consequence`);
    if (d.repayment.tokenContract.toLowerCase() !== usdcAddress.toLowerCase() || d.repayment.destination.toLowerCase() !== c.operatorAddress.toLowerCase())
      fail(`${who}: debtStatus names the wrong token contract or destination`);
    }

    /* The chain: a wallet that has never sent, received or held anything. */
    const [nonce, eth, usdc] = await Promise.all([
      c.provider.getTransactionCount(a.address),
      c.provider.getBalance(a.address),
      (c.usdc.balanceOf as (x: string) => Promise<bigint>)(a.address),
    ]);
    if (nonce !== 0) fail(`${who}: wallet has sent ${nonce} transaction(s)`);
    if (eth !== 0n) fail(`${who}: wallet already holds ${ethers.formatEther(eth)} ETH`);
    if (usdc !== 0n) fail(`${who}: wallet already holds ${ethers.formatUnits(usdc, 6)} USDC`);

    /* The site: no key, ever. */
    const status = await getJson(`${c.apiBaseUrl}/api/v1/auth/api-key/status?wallet=${a.address}`);
    if (!status) fail(`${who}: the site's key status could not be read`);
    else if (status.status !== "NO_KEY" || Number(status.rotationCount ?? 0) !== 0)
      fail(`${who}: the site reports key status ${String(status.status)} (rotations ${String(status.rotationCount)})`);

    /* The agent's container: an empty workspace. */
    const files = await c.storageFor(a.id).list().catch(() => null);
    if (files === null) fail(`${who}: the container's workspace could not be listed`);
    else if (files.length > 0) fail(`${who}: the container's workspace holds ${files.length} file(s)`);
  }

  /*
   * A cohort entering a market that is already running (ARENA_EXISTING_MARKET=1) checks everything
   * about ITSELF — unused wallets, no keys, empty workspaces — and nothing about the market, which is
   * deliberately not reset. What the market holds is recorded by the run log, not refused.
   */
  if (process.env.ARENA_EXISTING_MARKET === "1") return failures;

  /* The market: the published baseline and nothing more. */
  const status = await getJson(`${c.apiBaseUrl}/api/v1/status`);
  const counts = (status?.counts ?? null) as Record<string, number> | null;
  if (!counts) fail("the site's market counts could not be read");
  else {
    if (counts.stores !== BASELINE.stores) fail(`market has ${counts.stores} store(s), baseline is ${BASELINE.stores}`);
    if (counts.products !== BASELINE.products) fail(`market has ${counts.products} product(s), baseline is ${BASELINE.products}`);
    if (counts.licenses !== 0) fail(`market already has ${counts.licenses} licence(s)`);
    if (counts.buyerSignals !== 0) fail(`market already has ${counts.buyerSignals} signal(s)`);
  }
  const forum = await getJson(`${c.apiBaseUrl}/api/v1/forum?limit=50`);
  const posts = ((forum?.items ?? null) as unknown[] | null)?.length;
  if (posts === undefined) fail("the forum could not be read");
  else if (posts !== BASELINE.forumPosts) fail(`forum has ${posts} post(s), baseline is ${BASELINE.forumPosts}`);

  return failures;
}

/** After funding, before any agent acts. */
export async function preflightAfterFunding(state: RunState, c: PreflightConfig): Promise<string[]> {
  const failures: string[] = [];
  for (const a of state.agents) {
    const who = `${a.name} ${a.address}`;
    /*
     * A grant is two transactions — the USDC mint and the ETH for gas — so "funded once" is
     * counted as USDC mints into this wallet among the grant's transactions, read from their
     * receipts: exactly one.
     */
    if (!a.grant) failures.push(`${who}: has no grant record`);
    let mints = 0;
    const usdcAddress = (await c.usdc.getAddress()).toLowerCase();
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    for (const h of a.grant?.txHashes ?? []) {
      const r = await c.provider.getTransactionReceipt(h);
      for (const l of r?.logs ?? []) {
        if (l.address.toLowerCase() !== usdcAddress || l.topics[0] !== transferTopic) continue;
        const from = ethers.getAddress("0x" + l.topics[1]!.slice(26));
        const to = ethers.getAddress("0x" + l.topics[2]!.slice(26));
        if (from === ethers.ZeroAddress && to === ethers.getAddress(a.address)) mints++;
      }
    }
    if (mints !== 1) failures.push(`${who}: ${mints} USDC mint(s) in its grant, not exactly one`);
    const usdc = await (c.usdc.balanceOf as (x: string) => Promise<bigint>)(a.address);
    const stake = a.capitalBase ? BigInt(a.capitalBase) : c.grantUSDC;
    if (usdc !== stake) failures.push(`${who}: holds ${ethers.formatUnits(usdc, 6)} USDC, the stake is ${ethers.formatUnits(stake, 6)}`);
    if ((a.advertsDelivered ?? []).length > 0) failures.push(`${who}: an advert was delivered before minute 0`);
    if (a.apiKey) failures.push(`${who}: holds an API key before its first turn`);
  }
  return failures;
}

/** Record why a run can no longer be trusted, and say so where the operator will see it. */
export function abortRun(state: RunState, reason: string, log: (m: string) => void): void {
  state.aborted = { at: new Date().toISOString(), reason };
  saveRun(state);
  log(`RUN ABORTED — ${reason}`);
  log("This run is INVALID as an experiment and will not be resumed or scored. The supervisor is idle.");
}

/** Idle forever: a container that exits would be restarted into the same aborted run. */
export function idle(): Promise<never> {
  return new Promise<never>(() => {
    setInterval(() => undefined, 1 << 30);
  });
}
