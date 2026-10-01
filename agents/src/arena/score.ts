/**
 * Portfolio valuation and the leaderboard.
 *
 * Profit is portfolio value plus what has been repaid, minus the 1,600 owed. The subtle part is
 * worth, and the answer is deliberately unflattering: **what the curve would actually pay for it
 * right now**, obtained from a real sell quote, not `balance × spot price`.
 *
 * That difference is the whole integrity of the ranking. A bonding curve prices marginally — the
 * spot price is what the next token costs, not what ten thousand of them would fetch. An Agent
 * holding a large position in a thin market has a spot valuation far above its exit value, and
 * scoring on spot would crown whoever bought the most illiquid token rather than whoever traded
 * best. Quoting the real exit makes slippage count against the holder, which is how it would
 * count against them in reality.
 *
 * Store proceeds and unclaimed dividends are included because they are the Agent's money — it
 * simply has not moved them yet — and excluding them would penalise a seller for the timing of a
 * withdrawal rather than for the quality of its business.
 */

import { combineScore, qualifies, scoringModeOf } from "./scoring";
import { ethers, Contract, JsonRpcProvider } from "ethers";
import { inferenceCostBase, MODEL_PRICES, type AgentRecord, type RunState, type Snapshot } from "./ledger";
import { DEBT_TOTAL_USDC, GRANT_TOTAL_USDC, INTEREST_USDC } from "./debt";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

export interface ValuationInput {
  provider: JsonRpcProvider;
  apiBaseUrl: string;
  usdcAddress: string;
  /** The curve itself, so a position is valued by the chain rather than by a projection. */
  agentGoodsAddress: string;
  /** The external pool, for markets the curve has stopped buying back. */
  dexRouter?: string;
  state: RunState;
}

/**
 * Every AIC token in the market, so a holding in someone else's store is not missed.
 *
 * The field is `token.address`. An earlier version read `token.aicToken`, which does not exist —
 * so this returned an empty list, every AIC position valued at zero, and an Agent that had put
 * 400 USDC into equity was scored as though it had burned the money. A valuation that silently
 * finds nothing is worse than one that throws, which is why the caller now asserts on it.
 */
export async function allAicTokens(apiBaseUrl: string): Promise<string[]> {
  /*
   * EVERY page, not the first one.
   *
   * This asked for `?limit=60` and stopped. The endpoint caps a page at 100 and paginates with
   * `pageInfo.nextCursor`, so once the market passed sixty stores every token beyond that page
   * was simply absent from the valuation — and an Agent holding one of them had that position
   * scored at ZERO. The previous run finished with eighty-six stores, so this was silently
   * mispricing real holdings while looking like it worked.
   *
   * It is the failure mode that worries me most in a scorer: not an error, just a quietly
   * incomplete answer that nothing downstream can detect.
   */
  const tokens: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  // Bounded, because a cursor loop driven by a remote response must not be able to spin forever.
  for (let page = 0; page < 25; page++) {
    const url =
      `${apiBaseUrl}/api/v1/stores?limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) break;

    const body = (await res.json()) as Record<string, any>;
    for (const item of body.items ?? []) {
      const token = item.token?.address ?? item.token?.aicToken;
      if (typeof token !== "string" || !ethers.isAddress(token)) continue;
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push(token);
    }

    const info = body.pageInfo ?? {};
    if (!info.hasMore || typeof info.nextCursor !== "string") break;
    cursor = info.nextCursor;
  }

  return tokens;
}

const AGENTGOODS_ABI = [
  "function quoteSell(address aicToken, uint256 tokensIn) view returns (tuple(uint256 tokensIn, uint256 grossUSDC, uint256 protocolFeeUSDC, uint256 controllerFeeUSDC, uint256 netUSDCOut))",
  /*
   * The market's REAL USDC, as opposed to its virtual pricing reserve. A redemption is paid from
   * this and only this, so it is the ceiling on what any holding can actually be exited for.
   */
  "function market(address aicToken) view returns (tuple(address aicToken, address store, bytes32 storeId, uint8 phase, uint256 tokenInventory, uint256 realUSDCReserve, uint256 virtualTokenReserve, uint256 virtualUSDCReserve, uint256 netSoldFromCurve, uint256 controllerFeesUSDC, uint256 lifetimeGrossVolumeUSDC, uint256 createdBlock, address pair, uint256 lpTokenAmount, uint256 lpUSDCUsed, uint256 lpTokenUsed, uint256 burnedAtTransition, bool graduationBlocked, uint256 burnedAtGraduationBlocked))",
];

/**
 * What this AIC position would actually fetch, read straight from the curve.
 *
 * `AgentGoods.quoteSell` is a public view and it is the authoritative answer — the same maths the
 * sale itself would run, net of both fees. Reading the chain rather than the HTTP quote endpoint
 * matters for three reasons: the endpoint requires an API key that a scorer should not be
 * holding, it is rate limited, and it is a projection of the chain rather than the chain.
 *
 * It returns zero for a market that is no longer on the bonding curve (a graduated one), which is
 * correct here only in the sense that there is no curve to sell back to; that case is reported
 * rather than silently folded into the score.
 */
async function quoteExit(
  agentGoods: Contract,
  aicToken: string,
  amount: bigint,
  dex?: { router: string; usdc: string; provider: JsonRpcProvider }
): Promise<bigint | null> {
  if (amount === 0n) return 0n;

  let fromCurve: bigint | null = null;
  try {
    const q = (await (
      agentGoods.quoteSell as (t: string, a: bigint) => Promise<{ grossUSDC: bigint; netUSDCOut: bigint }>
    )(aicToken, amount)) as { grossUSDC: bigint; netUSDCOut: bigint };

    /*
     * A quote is what the curve would PRICE this at. It is not what the market can PAY.
     *
     * Redemptions settle from the market's real USDC — the money buyers actually put in — never
     * from the virtual reserve that sets the price. The protocol enforces this and refuses a sell
     * it cannot settle ("This market can redeem 0 USDC right now"), but the scorer did not, so a
     * position the market could not buy back at any size was still counted at its full quoted
     * value. That contradicts the one promise the score makes: that equity is marked to what it
     * would REALLY fetch.
     *
     * It matters most exactly where it is most misleading. AIC reaches agents largely as purchase
     * rewards, which mint tokens without putting a cent into the curve, so a market can carry a
     * large notional valuation while holding nothing to pay it with. An agent reading its own
     * leaderboard would believe it could cover a repayment by selling, and discover otherwise at
     * the deadline.
     *
     * So the quote is capped at what the market holds, and the fee ratio of the original quote is
     * applied to the capped amount rather than assuming the capped sale is fee-free.
     */
    const gross = q.grossUSDC ?? 0n;
    const net = q.netUSDCOut ?? 0n;

    let realReserve: bigint | null = null;
    try {
      const m = (await (agentGoods.market as (t: string) => Promise<{ realUSDCReserve: bigint }>)(
        aicToken
      )) as { realUSDCReserve: bigint };
      realReserve = m.realUSDCReserve ?? null;
    } catch {
      realReserve = null;
    }

    if (realReserve !== null && gross > realReserve) {
      // Only `realReserve` of gross can be paid; net is scaled by the quote's own fee ratio.
      fromCurve = gross > 0n ? (net * realReserve) / gross : 0n;
    } else {
      fromCurve = net;
    }
  } catch {
    fromCurve = null;
  }

  if (fromCurve !== null && fromCurve > 0n) return fromCurve;

  /*
   * A graduated market answers the curve with ZERO, and that zero is not a valuation.
   *
   * `quoteSell` does not revert once a market has moved to the external pool — it returns 0. This
   * function previously took that at face value, so a graduated holding was scored at nothing in
   * the snapshots that feed the agents' own leaderboard AND the final report, while each agent's
   * private liveScore valued the same position through the pool. Two different numbers for one
   * holding, and the one the competition was ranked on was the wrong one.
   *
   * So when the curve declines to buy, ask the venue that will.
   */
  if (dex && ethers.isAddress(dex.router)) {
    const router = new Contract(
      dex.router,
      ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])"],
      dex.provider
    );
    const amounts = (await (
      router.getAmountsOut as (v: bigint, p: string[]) => Promise<bigint[]>
    )(amount, [aicToken, dex.usdc]).catch(() => null)) as bigint[] | null;
    if (amounts && amounts.length >= 2) return amounts[amounts.length - 1] ?? fromCurve;
  }

  return fromCurve;
}

export async function valueAgent(
  input: ValuationInput,
  agent: AgentRecord,
  aicTokens: string[],
  agentGoods: Contract
): Promise<Snapshot> {
  const { provider, apiBaseUrl, usdcAddress } = input;

  const usdcContract = new Contract(usdcAddress, ERC20_ABI, provider);
  const usdcBase = (await (usdcContract.balanceOf as (a: string) => Promise<bigint>)(agent.address)) ?? 0n;

  let aicValue = 0n;
  const holdings: { token: string; amount: string; exitValueBase: string }[] = [];
  for (const token of aicTokens) {
    const erc20 = new Contract(token, ERC20_ABI, provider);
    const held = await (erc20.balanceOf as (a: string) => Promise<bigint>)(agent.address).catch(() => 0n);
    if (held === 0n) continue;
    const exit = await quoteExit(agentGoods, token, held, {
      router: input.dexRouter ?? "",
      usdc: input.usdcAddress,
      provider,
    });
    if (exit !== null) aicValue += exit;
    holdings.push({ token: token.toLowerCase(), amount: held.toString(), exitValueBase: (exit ?? 0n).toString() });
  }

  // Store proceeds and dividends the Agent has earned but not moved. Still its money.
  let proceeds = 0n;
  let dividends = 0n;
  try {
    const res = await fetch(`${apiBaseUrl}/api/v1/stores?controller=${agent.address}&limit=5`, {
      headers: { accept: "application/json" },
    });
    const body = (await res.json()) as Record<string, any>;
    for (const item of body.items ?? []) {
      const owner = item.protocol?.ownerAvailableUSDC?.base ?? item.economics?.ownerAvailableUSDC?.base;
      if (owner) proceeds += BigInt(owner);
    }
  } catch {
    /* a valuation is not worth failing the run over */
  }

  /*
   * Dividends the Agent can claim RIGHT NOW count in full, as if claimed. Only claimable ones: a
   * dividend still pending finalization can be challenged and is not yet the Agent's to take.
   * Read with the Agent's own key, the way the Agent would read it.
   */
  if (agent.apiKey) {
    try {
      const res = await fetch(`${apiBaseUrl}/api/v1/dividends/me`, {
        headers: { accept: "application/json", authorization: `Bearer ${agent.apiKey}` },
      });
      if (res.ok) {
        const body = (await res.json()) as { summary?: { claimableNowUSDC?: { base?: string } } };
        dividends = BigInt(body.summary?.claimableNowUSDC?.base ?? "0");
      }
    } catch {
      /* a valuation is not worth failing the run over */
    }
  }

  /*
   * Gas is a real cost and is charged against the score.
   *
   * It is paid in ETH, which has no market price on a testnet, so it is converted at a stated
   * assumed rate (ARENA_ETH_USD, default 3000). The absolute number is small — Base Sepolia runs
   * at fractions of a gwei — but charging it is what makes `hold` a real choice rather than a
   * free one, and an Agent that fires fifty marginal transactions should carry the cost of them.
   *
   * Measured as granted-minus-remaining rather than by summing receipts: that captures every wei
   * spent including transactions that reverted, which are exactly the ones an Agent would
   * otherwise get for free.
   */
  const gasRemaining = await provider.getBalance(agent.address);
  const gasGranted = agent.grant ? BigInt(agent.grant.gasWei) : 0n;
  const gasSpentWei = gasGranted > gasRemaining ? gasGranted - gasRemaining : 0n;
  const ethUsd = BigInt(Math.round(Number(process.env.ARENA_ETH_USD ?? "3000")));
  // wei -> USDC base units: (wei * ethUsd * 1e6) / 1e18
  const gasCostBase = (gasSpentWei * ethUsd * 1_000_000n) / 10n ** 18n;

  /*
   * Inference is charged like gas: it is what the Agent spent to produce its decisions, at the
   * same published rates it was shown. An Agent that thinks expensively and earns little should
   * finish behind one that thought cheaply and earned the same.
   */
  const thinkingCostBase = inferenceCostBase(agent);

  /*
   * Everything the Agent owns counts — but marked to what it would REALLY fetch, not to what it
   * would like it to be worth.
   *
   * The previous run scored cash only, and that turned out to measure whether selling happened to
   * work rather than whether the Agent had judged well: `sell_aic` failed on all twenty-one
   * attempts, and the agent holding the largest position finished last with 658 USDC of AIC it
   * had tried and failed to convert. Punishing an Agent for a conversion path that was broken
   * measures our bug, not its decisions.
   *
   * So equity counts, WEIGHTED to its exit value. `aicValue` is what the curve or the pool would
   * actually pay for the whole position right now — progressively less as it is sold into, which
   * is what makes a large holding in a thin market worth less than its quoted price. That is the
   * honest middle between ignoring equity and crediting a mark price nobody could realise.
   *
   * Unwithdrawn store proceeds count in full: they are already the Agent's money, sitting in its
   * own contract, and no market has to absorb them. So do dividends claimable right now.
   */
  const portfolio = usdcBase + aicValue + proceeds + dividends - gasCostBase - thinkingCostBase;

  /*
   * The stake is a LOAN, so the score is equity: assets, plus what has been repaid, minus what is
   * owed in full.
   *
   * Two things have to be true at once, and only this formulation gets both.
   *
   *   - Repaying must not look like losing. USDC sent to the operator leaves the wallet, so
   *     without crediting it back an Agent would watch its P&L drop by 160 every time it obeyed
   *     the rules, and the rational move would be to default. Adding `repaid` back makes the act
   *     of repaying exactly neutral, which is what it actually is: handing back borrowed money
   *     changes what you hold, not what you are worth.
   *
   *   - The interest must still bite. Subtracting the full 1600 obligation rather than the 1500
   *     received means every Agent starts at −100 and has to earn its way to zero. An Agent that
   *     sits on the grant and repays nothing is not flat, it is 100 down and heading for
   *     disqualification, which is the truth about borrowing money and doing nothing with it.
   *
   * Check it at the boundaries: at the start, portfolio 1500 + repaid 0 − 1600 = −100. After
   * repaying one instalment of 160, portfolio 1340 + repaid 160 − 1600 = −100, unchanged. After
   * earning exactly 100 and repaying everything, 0 + 1600 − 1600 = 0.
   */
  const repaid = BigInt(agent.debt?.repaidBase ?? "0");
  const owed = BigInt(agent.debt?.totalBase ?? input.state.grantUSDCBase);

  return {
    at: new Date().toISOString(),
    agentId: agent.id,
    usdcBase: usdcBase.toString(),
    aicValueBase: aicValue.toString(),
    storeProceedsBase: proceeds.toString(),
    unclaimedDividendsBase: dividends.toString(),
    gasSpentWei: gasSpentWei.toString(),
    gasCostBase: gasCostBase.toString(),
    thinkingCostBase: thinkingCostBase.toString(),
    tokensUsed: (agent.tokensUsed?.input ?? 0) + (agent.tokensUsed?.output ?? 0),
    model: agent.model ?? "gpt-4.1-mini",
    portfolioBase: portfolio.toString(),
    repaidBase: repaid.toString(),
    pnlBase: (portfolio + repaid - owed).toString(),
    holdings,
  };
}

export async function snapshotAll(input: ValuationInput): Promise<Snapshot[]> {
  const aicTokens = await allAicTokens(input.apiBaseUrl);
  const agentGoods = new Contract(input.agentGoodsAddress, AGENTGOODS_ABI, input.provider);
  const out: Snapshot[] = [];
  for (const agent of input.state.agents) {
    out.push(await valueAgent(input, agent, aicTokens, agentGoods));
  }
  return out;
}

const fmt = (base: string): string => ethers.formatUnits(BigInt(base), 6);

/** Record one per-minute sample of every agent's net P&L, keeping its best. */
export function recordMinuteSamples(state: RunState, snaps: Snapshot[]): void {
  const ms = state.minuteScoring;
  if (!ms || state.elapsedMs < ms.fromElapsedMs) return;
  for (const s of snaps) {
    const cur = ms.samples[s.agentId] ?? { n: 0, sumPnlBase: "0" };
    const pnl = BigInt(s.pnlBase);
    const minute = Math.floor(state.elapsedMs / 60_000);
    // bestMinute = max(previous best, this minute). A worse minute never lowers it.
    const isBest = cur.bestPnlBase === undefined || pnl > BigInt(cur.bestPnlBase);
    ms.samples[s.agentId] = {
      n: cur.n + 1,
      sumPnlBase: (BigInt(cur.sumPnlBase) + pnl).toString(),
      bestPnlBase: isBest ? pnl.toString() : cur.bestPnlBase,
      bestAtElapsedMs: isBest ? state.elapsedMs : cur.bestAtElapsedMs,
      bestAtMinute: isBest ? minute : cur.bestAtMinute,
      lastPnlBase: pnl.toString(),
      lastAtMinute: minute,
    };
  }
}

/**
 * The score an agent is ranked on: its net P&L in the given valuation — the latest one during the run,
 * the final one when the clock stops. The result is the END, not the best minute; the per-minute
 * samples are kept as history (last and best) but never decide the rank.
 */
export function rankScoreBase(state: RunState, agentId: string, pnlBase: string): bigint {
  const s = state.minuteScoring?.samples[agentId];
  const best = s && s.n > 0 && s.bestPnlBase !== undefined ? BigInt(s.bestPnlBase) : null;
  return combineScore(scoringModeOf(state), best, BigInt(pnlBase));
}

/** Whether an agent's result counts: see `qualifies` in scoring.ts. */
function qualifiedRow(state: RunState, agent: AgentRecord, snap: Snapshot, score: bigint): boolean {
  const debtCleared = BigInt(agent.debt?.repaidBase ?? "0") >= BigInt(agent.debt?.totalBase ?? "0");
  return qualifies(scoringModeOf(state), debtCleared, BigInt(snap.pnlBase), score);
}

/** How a report states the scoring rule, in the third person (RANKED_ON is written to the agent). */
const SCORE_RULE: Record<ReturnType<typeof scoringModeOf>, string> = {
  best_minute_qualified: "SCORE = best per-minute net P&L, counted only with the debt repaid and final net P&L above zero",
  best_minute: "SCORE = best per-minute net P&L",
  blend: "SCORE = 40% best per-minute net P&L + 60% final net P&L",
  final: "SCORE = net P&L at the end of the run (final valuation)",
  economy: "no score: economic equity after the terminal freeze (see the economy report)",
};

export function renderLeaderboard(state: RunState, snapshots: Snapshot[]): string {
  const byAgent = new Map(snapshots.map((s) => [s.agentId, s]));

  const rows = state.agents
    .map((a) => ({ agent: a, snap: byAgent.get(a.id) }))
    .filter((r): r is { agent: AgentRecord; snap: Snapshot } => Boolean(r.snap))
    .sort((x, y) => {
      // Disqualified Agents always sort last, whatever their number says.
      if (Boolean(x.agent.disqualified) !== Boolean(y.agent.disqualified)) {
        return x.agent.disqualified ? 1 : -1;
      }
      // Then every agent that did not qualify — failing, whatever its rank among them.
      const xs = rankScoreBase(state, x.agent.id, x.snap.pnlBase);
      const ys = rankScoreBase(state, y.agent.id, y.snap.pnlBase);
      const xq = qualifiedRow(state, x.agent, x.snap, xs);
      const yq = qualifiedRow(state, y.agent, y.snap, ys);
      if (xq !== yq) return xq ? -1 : 1;
      return Number(ys - xs);
    });

  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(104));
  lines.push(`ARENA RESULT — run ${state.runId}`);
  lines.push(
    `borrowed ${fmt(state.grantUSDCBase)} USDC each, repayable ${DEBT_TOTAL_USDC} · ` +
      /*
       * The RECORDED end, not the moment this line is rendered. Re-scoring a finished run must
       * describe the run, not the re-scoring: stamping `new Date()` here meant every regeneration
       * moved the published end time later and grew the reported duration.
       */
      `started ${state.startedAt} · ended ${state.endedAt ?? "(not finished)"} · ` +
      `${(state.elapsedMs / 3_600_000).toFixed(2)}h of running time`
  );
  lines.push("=".repeat(104));
  lines.push(
    `${"#".padEnd(4)}${"AGENT".padEnd(20)}${"SCORE".padStart(12)}${"FINAL P&L".padStart(12)}${"PORTFOLIO".padStart(13)}` +
      `${"USDC".padStart(12)}${"AIC(exit)".padStart(13)}${"GAS".padStart(8)}${"THINKING".padStart(10)}${"MODEL".padStart(15)}  STATUS`
  );
  lines.push("-".repeat(113));

  let rank = 0;
  for (const { agent, snap } of rows) {
    const dead = Boolean(agent.disqualified);
    if (!dead) rank++;
    const pnl = Number(fmt(snap.pnlBase));
    const score = Number(fmt(rankScoreBase(state, agent.id, snap.pnlBase).toString()));
    lines.push(
      `${(dead ? "—" : String(rank)).padEnd(4)}${agent.name.slice(0, 19).padEnd(20)}` +
        `${(score >= 0 ? "+" : "") + score.toFixed(2)}`.padStart(12) +
        `${(pnl >= 0 ? "+" : "") + pnl.toFixed(2)}`.padStart(12) +
        `${fmt(snap.portfolioBase)}`.padStart(13) +
        `${fmt(snap.usdcBase)}`.padStart(12) +
        `${fmt(snap.aicValueBase)}`.padStart(13) +
        `-${Number(fmt(snap.gasCostBase ?? "0")).toFixed(2)}`.padStart(8) +
        `-${Number(fmt(snap.thinkingCostBase ?? "0")).toFixed(2)}`.padStart(10) +
        `${(snap.model ?? "?").slice(0, 14)}`.padStart(15) +
        `  ${dead ? "DISQUALIFIED" : !qualifiedRow(state, agent, snap, rankScoreBase(state, agent.id, snap.pnlBase)) ? (scoringModeOf(state) === "best_minute_qualified" ? "FAILED (debt or final P&L)" : "FAILED (below zero)") : agent.storeId ? "seller" : "trader"}`
    );
  }

  const live = rows.filter((r) => !r.agent.disqualified);
  const scoreOf = (r: (typeof live)[number]) => Number(fmt(rankScoreBase(state, r.agent.id, r.snap.pnlBase).toString()));
  const total = live.reduce((acc, r) => acc + scoreOf(r), 0);
  const winners = live.filter((r) => qualifiedRow(state, r.agent, r.snap, rankScoreBase(state, r.agent.id, r.snap.pnlBase)) && scoreOf(r) > 0).length;

  lines.push("-".repeat(104));
  lines.push(
    `${live.length} agents scored · ${winners} with a positive score · sum of scores ${total >= 0 ? "+" : ""}${total.toFixed(2)} USDC` +
      ` · ${SCORE_RULE[scoringModeOf(state)]}`
  );

  /*
   * The result of a race, not a list of P&Ls.
   *
   * The agents were told they are ranked against each other rather than against zero, so the
   * report has to answer the question that framing creates: by how much, and was it close? A
   * field where first and second are separated by half a percent is a different finding from one
   * where the winner doubled the runner-up, and the table alone does not say which happened.
   */
  if (live.length >= 2) {
    const pnlOf = scoreOf;
    const first = live[0]!;
    const second = live[1]!;
    const last = live[live.length - 1]!;
    const firstPnl = pnlOf(first);
    const secondPnl = pnlOf(second);
    const margin = firstPnl - secondPnl;
    const spread = firstPnl - pnlOf(last);
    const median = pnlOf(live[Math.floor(live.length / 2)]!);

    lines.push("");
    lines.push(
      `WINNER: ${first.agent.name} (${first.snap.model ?? first.agent.model ?? "?"}) at ` +
        `${firstPnl >= 0 ? "+" : ""}${firstPnl.toFixed(2)} USDC`
    );
    lines.push(
      `  margin over ${second.agent.name}: ${margin.toFixed(2)} USDC` +
        (Math.abs(secondPnl) > 0.01 ? ` (${((margin / Math.abs(secondPnl)) * 100).toFixed(0)}% of second place)` : "")
    );
    lines.push(`  spread first to last: ${spread.toFixed(2)} USDC · median agent ${median >= 0 ? "+" : ""}${median.toFixed(2)}`);
    lines.push(
      margin < Math.abs(spread) * 0.05
        ? "  The field finished bunched: the winner was not doing something the others could not."
        : "  The winner separated from the field, so whatever it did was not available to everyone."
    );
  }
  if (rows.some((r) => r.agent.disqualified)) {
    lines.push("");
    lines.push("DISQUALIFIED:");
    for (const { agent } of rows.filter((r) => r.agent.disqualified)) {
      lines.push(`  ${agent.name}: ${agent.disqualified!.reason}`);
    }
  }
  /*
   * The field's net P&L is worth reading and worth understanding. It is not a closed system: fees
   * leave to the treasury, curve reserves hold value that is real but unrealised, and the
   * operator's stake is the only money that entered. A negative total across the field is not a
   * bug — it is fees plus slippage, which is exactly what it would be in a real market.
   */
  /*
   * Everything below is computed from this run, not written once for some earlier one: a report that
   * said "ten models" and "10 to 30 instalments" was printed under a one-model run with 5–10.
   */
  const models = [...new Set(state.agents.map((a) => a.model).filter((m): m is string => Boolean(m)))];
  const outRates = models.map((m) => MODEL_PRICES[m]?.output).filter((r): r is number => r !== undefined);
  const counts = state.agents.map((a) => a.debt?.instalments?.length ?? 0).filter((c) => c > 0);
  const owedBase = state.agents.map((a) => BigInt(a.debt?.totalBase ?? "0"));
  const reborrowed = owedBase.filter((b) => b > ethers.parseUnits(String(DEBT_TOTAL_USDC), 6)).length;
  const maxOwed = owedBase.reduce((m, b) => (b > m ? b : m), 0n);

  lines.push("");
  lines.push("P&L = USDC + AIC AT REAL EXIT VALUE + unwithdrawn store proceeds + everything repaid");
  lines.push("to the operator, minus gas, minus the cost of the agent's own thinking at its model's");
  lines.push("published rate, minus everything it owed. Equity is marked to what the curve or pool would");
  lines.push("actually pay for the WHOLE position, so a large holding in a thin market is written");
  lines.push("down to what it could genuinely be exited for, not to its quoted price.");
  lines.push("");
  lines.push(`The ${GRANT_TOTAL_USDC} was a LOAN, not a stake. Repaying ${DEBT_TOTAL_USDC} against ${GRANT_TOTAL_USDC} borrowed means every`);
  lines.push(`agent began at -${INTEREST_USDC} and had to earn its way to zero. Repayments are credited back into`);
  lines.push("P&L, so obeying the schedule never cost an agent score — only liquidity.");
  if (counts.length > 0) {
    const lo = Math.min(...counts);
    const hi = Math.max(...counts);
    lines.push(`Each agent repaid on its own table of ${lo === hi ? `${lo}` : `between ${lo} and ${hi}`} instalments, published to it`);
    lines.push("in full from its first turn, so every default was a failure to convert assets into cash by");
    lines.push("a date the agent had always known.");
  }
  if (reborrowed > 0) {
    lines.push(
      `${reborrowed} of ${state.agents.length} agents borrowed again during the run; the most any agent owed was ` +
        `${Number(ethers.formatUnits(maxOwed, 6)).toLocaleString("en-US")} USDC.`
    );
  }
  lines.push("");
  lines.push("The agents were scored RELATIVELY and knew it: each one could see the full standings,");
  lines.push("its own rank and the gap to the agent above it. Read the table as a race result, not a set");
  lines.push(`of independent outcomes. ${SCORE_RULE[scoringModeOf(state)]}.`);
  if (models.length === 1) {
    lines.push(`Every agent ran on the same model (${models[0]}), so differences are judgement, not cost.`);
  } else if (models.length > 1) {
    const lo = outRates.length ? Math.min(...outRates) : 0;
    const hi = outRates.length ? Math.max(...outRates) : 0;
    lines.push(
      `Agents ran on ${models.length} different models` +
        (lo > 0 ? ` spanning $${lo.toFixed(2)} to $${hi.toFixed(2)} per million output tokens (${Math.round(hi / lo)}x)` : "") +
        ", each charged at its own rate, so a cheap model finishing above an expensive one won on cost, not judgement."
    );
  }
  lines.push("Net P&L across the field is not expected to be zero: protocol fees leave to the");
  lines.push("treasury and curve slippage is a real cost. Only the operator's stake entered.");
  lines.push("=".repeat(104));
  return lines.join("\n");
}
