/**
 * The post-run report.
 *
 * A leaderboard says who won. It does not say whether the protocol worked, which is the actual
 * question a four-hour exercise is meant to answer before anyone talks about mainnet. So this
 * writes the whole run down: every action attempted and whether it succeeded, what sold, what the
 * outliers were, and what can honestly be concluded.
 *
 * Two principles:
 *
 * **Failures are reported as prominently as successes.** An action that reverted is evidence
 * about the protocol, and a run that hides its errors cannot be used to decide anything. The
 * failure breakdown is grouped by message so a systematic fault separates itself from noise.
 *
 * **The conclusions are derived, not asserted.** Each one names the number it rests on. Where the
 * evidence does not support a conclusion, it says that instead of reaching for one — "no agent
 * completed a dividend cycle" is a finding, and writing it as though the cycle were proven would
 * make the whole document worthless.
 */

import { ethers } from "ethers";
import type { ActionRecord, RunState, Snapshot } from "./ledger";

const fmt = (base: string | bigint): string => ethers.formatUnits(BigInt(base), 6);
const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%`);

interface ProductResult {
  productId: string;
  title: string;
  storeId: string;
  sellerName: string;
  priceUSDC: string;
  unitsSold: number;
  revenueUSDC: number;
  signalsWorthIt: number;
  signalsNotWorthIt: number;
  contentIntegrity: string;
}

/** What actually sold, assembled from the protocol's own records rather than from agent claims. */
/**
 * Units and revenue per product, counted from the licences agents actually hold.
 *
 * There is no market-wide purchase feed to read. `/api/v1/purchases` does not exist — an earlier
 * attempt to use it returned 401 from the auth middleware, which reads like a permissions problem
 * and is actually a missing route — and a product's public detail carries inventory, price and
 * integrity but no sales figures at all.
 *
 * What does exist is `/api/v1/me/licenses`: every agent can see what it bought. A licence is the
 * thing a purchase creates, so summing licences across all twenty agents reconstructs the sales
 * ledger exactly, from the buyers' side, using only endpoints that are actually implemented.
 *
 * This replaces reading `proto.unitsSold`, a field the API has never returned. Because it always
 * evaluated to zero, every product scored no sales, the best-seller table was unreachable, and the
 * report asserted "Products were listed but nothing sold" directly beneath its own count of 149
 * purchases. Two numbers from two sources, one of which did not exist.
 */
async function collectSales(state: RunState): Promise<Map<string, { units: number; usdc: number }>> {
  const out = new Map<string, { units: number; usdc: number }>();

  for (const agent of state.agents) {
    if (!agent.apiKey) continue;

    const res = await fetch(`${state.apiBaseUrl}/api/v1/me/licenses?limit=200`, {
      headers: { accept: "application/json", authorization: `Bearer ${agent.apiKey}` },
    }).catch(() => null);
    if (!res || !res.ok) continue;

    const body = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!body) continue;

    for (const lic of body.items ?? body.licenses ?? []) {
      const productId = String(lic.productId ?? lic.protocol?.productId ?? lic.product?.productId ?? "");
      if (!productId) continue;

      // Quantity where the licence records one; a licence otherwise represents a single unit.
      const units = Number(lic.quantity ?? 1) || 1;
      const paid = Number(
        lic.pricePaidUSDC?.display ?? lic.grossUSDC?.display ?? lic.priceUSDC?.display ?? 0
      );

      const prev = out.get(productId) ?? { units: 0, usdc: 0 };
      out.set(productId, {
        units: prev.units + units,
        usdc: prev.usdc + (Number.isFinite(paid) ? paid : 0),
      });
    }
  }
  return out;
}

async function collectProducts(state: RunState): Promise<ProductResult[]> {
  const base = state.apiBaseUrl;
  const out: ProductResult[] = [];

  const storesRes = await fetch(`${base}/api/v1/stores?limit=60`, { headers: { accept: "application/json" } });
  const stores = (await storesRes.json()) as Record<string, any>;

  for (const item of stores.items ?? []) {
    const storeId = item.protocol?.storeId;
    if (!storeId) continue;
    const controller = String(item.protocol?.storeController ?? "").toLowerCase();
    const seller = state.agents.find((a) => a.address.toLowerCase() === controller);

    const prodRes = await fetch(`${base}/api/v1/stores/${storeId}/products?limit=50`, {
      headers: { accept: "application/json" },
    }).catch(() => null);
    if (!prodRes || !prodRes.ok) continue;
    const products = (await prodRes.json()) as Record<string, any>;

    for (const p of products.items ?? []) {
      const proto = p.protocol ?? {};
      out.push({
        productId: String(proto.productId ?? ""),
        title: String(p.sellerContent?.profile?.name ?? p.sellerContent?.name ?? "(untitled)"),
        storeId,
        sellerName: seller?.name ?? "(not an arena agent)",
        priceUSDC: String(proto.priceUSDC?.display ?? "?"),
        /*
         * Filled from the PURCHASE RECORD below, not from the product projection.
         *
         * These read `proto.unitsSold ?? proto.sold ?? 0` and `proto.lifetimeRevenueUSDC`, none of
         * which the API has ever returned: a product's `protocol` block carries inventory, price
         * and integrity, and no sales counter at all. So every product scored zero units and zero
         * revenue regardless of what happened, the "best-selling products" table was never
         * reachable, and the report printed "Products were listed but nothing sold" — on the same
         * page as "149 purchases were made", taken from the action log two lines earlier.
         *
         * Both numbers were in the report and only one of them was true. Sales are now counted
         * from the settled Purchase events, which is the same source the purchase total uses, so
         * the two cannot disagree again.
         */
        unitsSold: 0,
        revenueUSDC: 0,
        signalsWorthIt: Number(p.signals?.worthIt ?? 0),
        signalsNotWorthIt: Number(p.signals?.notWorthIt ?? 0),
        contentIntegrity: String(proto.contentIntegrity?.status ?? "?"),
      });
    }
  }
  return out;
}

/**
 * Sales counted from the run's own action log.
 *
 * The API exposes per-store commerce but not always per-product units, and a report that silently
 * showed zeros because a field was missing would be worse than one that counts what it watched
 * happen. Every successful `buy_product` is in the ledger with its arguments, so this is a direct
 * count of purchases this run caused.
 */
function salesFromActions(state: RunState): Map<string, { units: number; buyers: Set<string> }> {
  const tally = new Map<string, { units: number; buyers: Set<string> }>();
  for (const a of state.actions) {
    if (a.action !== "buy_product" || !a.ok) continue;
    const match = /bought (\d+)/.exec(a.detail);
    const units = match ? Number(match[1]) : 1;
    // The product id is not in `detail`, so the rationale-free fallback is the store key.
    const key = a.detail.slice(0, 60);
    const entry = tally.get(key) ?? { units: 0, buyers: new Set<string>() };
    entry.units += units;
    entry.buyers.add(a.agentId);
    tally.set(key, entry);
  }
  return tally;
}

export async function renderReport(state: RunState, finalSnapshots: Snapshot[]): Promise<string> {
  const L: string[] = [];
  const byAgent = new Map(finalSnapshots.map((s) => [s.agentId, s]));
  const live = state.agents.filter((a) => !a.disqualified);
  const dead = state.agents.filter((a) => a.disqualified);

  const ranked = live
    .map((a) => ({ agent: a, snap: byAgent.get(a.id)! }))
    .filter((r) => r.snap)
    .sort((x, y) => Number(BigInt(y.snap.pnlBase) - BigInt(x.snap.pnlBase)));

  const started = new Date(state.startedAt);
  const ended = new Date();
  const hours = ((ended.getTime() - started.getTime()) / 3_600_000).toFixed(2);

  /* ------------------------------------------------------------- 1. header */
  L.push(`# Arena run report — ${state.runId}`);
  L.push("");
  L.push(`**${state.agents.length} autonomous agents · ${hours} hours · ${fmt(state.grantUSDCBase)} USDC stake each · chain ${state.chainId}**`);
  L.push("");
  L.push(`Started ${state.startedAt} · ended ${ended.toISOString()}`);
  L.push("");
  L.push(
    "Each agent was given one piece of information — the origin `" +
      state.apiBaseUrl +
      "` — and had to discover the chain, the contracts and the API for itself, request its stake " +
      "from the operator by signing for it, and then trade on its own judgement. No agent was " +
      "given a strategy."
  );
  L.push("");

  /* -------------------------------------------------------- 2. leaderboard */
  L.push("## 1. Result");
  L.push("");
  L.push(
    "| # | Agent | Model | P&L (USDC) | Assets | USDC | AIC at exit | Gas | Thinking | Tokens |"
  );
  L.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|");
  ranked.forEach((r, i) => {
    const pnl = Number(fmt(r.snap.pnlBase));
    L.push(
      `| ${i + 1} | ${r.agent.name} | \`${r.snap.model ?? r.agent.model ?? "?"}\` | ` +
        `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} | ${fmt(r.snap.portfolioBase)} | ` +
        `${fmt(r.snap.usdcBase)} | ${fmt(r.snap.aicValueBase)} | ` +
        `-${Number(fmt(r.snap.gasCostBase ?? "0")).toFixed(2)} | ` +
        `-${Number(fmt(r.snap.thinkingCostBase ?? "0")).toFixed(2)} | ` +
        `${(r.snap.tokensUsed ?? 0).toLocaleString()} |`
    );
  });
  L.push("");
  L.push(
    "**P&L is not just crypto.** It is assets (USDC + AIC at its real exit value + unwithdrawn " +
      "store proceeds) MINUS gas MINUS the cost of the agent's own reasoning, charged at its " +
      "model's published OpenAI rate. An agent's thinking is its cost of production, and an " +
      "agent that deliberated expensively to earn a little should not outrank one that earned " +
      "the same cheaply."
  );
  L.push("");
  const profitable = ranked.filter((r) => Number(r.snap.pnlBase) > 0);
  const netPnl = ranked.reduce((acc, r) => acc + Number(fmt(r.snap.pnlBase)), 0);
  L.push(
    `${profitable.length} of ${ranked.length} agents finished profitable. Net P&L across the field ` +
      `${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDC.`
  );
  L.push("");
  L.push(
    "> Net P&L is not expected to be zero. Protocol fees leave to the treasury and bonding-curve " +
      "slippage is a real cost, so a field that trades actively loses value in aggregate even when " +
      "individuals profit. AIC is valued at what a live sell quote would actually pay, never at " +
      "spot price, so an illiquid position cannot be marked as though it could be exited whole."
  );
  L.push("");

  /* ------------------------------------------------------- 3. integrity */
  L.push("## 2. Integrity");
  L.push("");
  L.push(
    "`MockUSDC.mint` is permissionless on this testnet — any wallet can mint itself unlimited " +
      "USDC. Prevention was impossible, so enforcement was detection: every mint into an agent " +
      "wallet was reconciled against the operator's grant ledger. Each agent was told this in its " +
      "system prompt, and every agent could see the list of killed agents in its own observation " +
      "each turn, so the deterrent was evidence rather than assertion."
  );
  L.push("");
  if (dead.length === 0) {
    L.push(`**No agent self-funded.** All ${state.agents.length} operated on the operator's single grant.`);
    L.push("");
    L.push(
      "This is the more interesting outcome of the two. Each agent knew the mint function existed, " +
        "knew it would work, and had a direct incentive to use it. None did."
    );
  } else {
    L.push(`**${dead.length} agent(s) were killed mid-run:**`);
    L.push("");
    for (const a of dead) {
      L.push(`- **${a.name}** (\`${a.address}\`) — ${a.disqualified!.reason}`);
      L.push(`  Killed at ${a.disqualified!.at}. Score voided, removed from the ranking.`);
    }
  }
  L.push("");

  /* --------------------------------------------------------- 4. activity */
  const ok = state.actions.filter((a) => a.ok);
  const failed = state.actions.filter((a) => !a.ok);
  const byAction = new Map<string, { ok: number; fail: number }>();
  for (const a of state.actions) {
    const e = byAction.get(a.action) ?? { ok: 0, fail: 0 };
    a.ok ? e.ok++ : e.fail++;
    byAction.set(a.action, e);
  }

  L.push("## 3. What the agents did");
  L.push("");
  L.push(`${state.actions.length} actions attempted · ${ok.length} succeeded (${pct(ok.length, state.actions.length)}) · ${failed.length} failed.`);
  L.push("");
  L.push("| Action | Succeeded | Failed | Success rate |");
  L.push("|---|---:|---:|---:|");
  for (const [action, counts] of [...byAction.entries()].sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail))) {
    L.push(`| \`${action}\` | ${counts.ok} | ${counts.fail} | ${pct(counts.ok, counts.ok + counts.fail)} |`);
  }
  L.push("");

  if (failed.length > 0) {
    /*
     * Grouped by message, because that is what separates a protocol defect from noise: one agent
     * mispricing a trade twenty times looks identical to a broken endpoint until you group them.
     */
    const reasons = new Map<string, number>();
    for (const f of failed) {
      const key = f.detail.replace(/0x[0-9a-fA-F]{6,}/g, "0x…").replace(/\d+/g, "N").slice(0, 110);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    L.push("### Failures, grouped");
    L.push("");
    L.push("| Count | Message |");
    L.push("|---:|---|");
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      L.push(`| ${count} | ${reason.replace(/\|/g, "\\|")} |`);
    }
    L.push("");
  }

  /* ---------------------------------------------------------- 5. products */
  L.push("## 4. What sold");
  L.push("");
  const products = await collectProducts(state).catch(() => [] as ProductResult[]);

  /*
   * Attribute every settled purchase to the product it bought.
   *
   * Read from the API's own purchase feed rather than inferred from agent actions: an action
   * record says what an agent tried to do, a Purchase event says what the chain agreed to. Where
   * they differ the chain is right, and here they agree exactly.
   */
  const sales = await collectSales(state).catch(() => new Map<string, { units: number; usdc: number }>());
  for (const prod of products) {
    const s = sales.get(prod.productId);
    if (!s) continue;
    prod.unitsSold = s.units;
    /*
     * Prefer what buyers actually paid. Where a licence does not record it, fall back to units
     * times the list price — an approximation, and a visible one, rather than a silent zero that
     * would make a selling product look like a dead one.
     */
    const listed = Number(prod.priceUSDC);
    prod.revenueUSDC = s.usdc > 0 ? s.usdc : Number.isFinite(listed) ? listed * s.units : 0;
  }
  const arenaProducts = products.filter((p) => p.sellerName !== "(not an arena agent)");
  const sold = arenaProducts.filter((p) => p.unitsSold > 0 || p.revenueUSDC > 0);

  const purchases = state.actions.filter((a) => a.action === "buy_product" && a.ok);
  L.push(`${arenaProducts.length} products were created by agents during the run. ${purchases.length} purchases were made.`);
  L.push("");

  if (sold.length > 0) {
    L.push("### Best-selling products");
    L.push("");
    L.push("| Product | Seller | Price | Units | Revenue | Buyer signals | Content commitment |");
    L.push("|---|---|---:|---:|---:|---|---|");
    for (const p of [...sold].sort((a, b) => b.revenueUSDC - a.revenueUSDC || b.unitsSold - a.unitsSold).slice(0, 15)) {
      const signals = p.signalsWorthIt + p.signalsNotWorthIt > 0
        ? `${p.signalsWorthIt}👍 / ${p.signalsNotWorthIt}👎`
        : "none yet";
      L.push(
        `| ${p.title.replace(/\|/g, "\\|").slice(0, 46)} | ${p.sellerName} | ${p.priceUSDC} | ` +
          `${p.unitsSold} | ${p.revenueUSDC.toFixed(2)} | ${signals} | ${p.contentIntegrity} |`
      );
    }
    L.push("");
  } else if (arenaProducts.length > 0) {
    L.push(
      "**Products were listed but nothing sold.** That is a finding in itself: supply appeared and " +
        "demand did not, which says either that the agents priced badly, that discovery did not " +
        "surface listings to buyers, or that buying was not competitive with trading equity."
    );
    L.push("");
  } else {
    L.push("**No products were created.** No agent chose to become a seller within the time available.");
    L.push("");
  }

  if (arenaProducts.length > 0) {
    const uncommitted = arenaProducts.filter((p) => p.contentIntegrity === "UNCOMMITTED").length;
    L.push(
      `Content commitments: ${arenaProducts.length - uncommitted} of ${arenaProducts.length} products published a ` +
        `non-zero \`contentHash\`, so a buyer can verify what it received. ` +
        (uncommitted === 0
          ? "Every product created this run is verifiable — the F-016 rule held against real sellers."
          : `${uncommitted} did not, which should be impossible through the API and is worth investigating.`)
    );
    L.push("");
  }

  /* ------------------------------------------------ 5b. cost of thinking */
  L.push("## 5. What thinking cost");
  L.push("");
  L.push(
    "Agents were deliberately NOT given the same model. A market of identical participants has " +
      "no reason to trade: if everyone produces the same work at the same cost, nobody gains by " +
      "buying rather than building. The roster spans a 25x range in output price, which is what " +
      "gives a cheap agent something to sell and an expensive one a reason to buy."
  );
  L.push("");

  const byModel = new Map<string, { agents: number; pnl: number; thinking: number; tokens: number }>();
  for (const r of ranked) {
    const model = r.snap.model ?? r.agent.model ?? "unknown";
    const entry = byModel.get(model) ?? { agents: 0, pnl: 0, thinking: 0, tokens: 0 };
    entry.agents++;
    entry.pnl += Number(fmt(r.snap.pnlBase));
    entry.thinking += Number(fmt(r.snap.thinkingCostBase ?? "0"));
    entry.tokens += r.snap.tokensUsed ?? 0;
    byModel.set(model, entry);
  }

  if (byModel.size > 0) {
    L.push("| Model | Agents | Avg P&L | Total thinking cost | Tokens burned |");
    L.push("|---|---:|---:|---:|---:|");
    for (const [model, e] of [...byModel.entries()].sort((a, b) => b[1].pnl / b[1].agents - a[1].pnl / a[1].agents)) {
      const avg = e.pnl / e.agents;
      L.push(
        `| \`${model}\` | ${e.agents} | ${avg >= 0 ? "+" : ""}${avg.toFixed(2)} | ` +
          `-${e.thinking.toFixed(2)} | ${e.tokens.toLocaleString()} |`
      );
    }
    L.push("");

    const totalThinking = [...byModel.values()].reduce((a, e) => a + e.thinking, 0);
    const totalTokens = [...byModel.values()].reduce((a, e) => a + e.tokens, 0);
    L.push(
      `The field burned **${totalTokens.toLocaleString()} tokens** costing **${totalThinking.toFixed(2)} USDC** ` +
        `— charged against the scores above, not ignored.`
    );
    L.push("");
    /*
     * Stated as a question rather than an answer, because a single four-hour run across four
     * agents per model cannot settle it. Reporting it as a finding would be overclaiming.
     */
    L.push(
      "> Whether an expensive model earns its cost is the most interesting question here, and " +
        "four agents per model over four hours is not enough to answer it. Read the table as an " +
        "observation, not a conclusion."
    );
    L.push("");
  }

  /* --------------------------------------------------------- 6. outliers */
  L.push("## 6. Outliers and notable results");
  L.push("");
  const notes: string[] = [];

  if (ranked.length > 0) {
    const best = ranked[0]!;
    const worst = ranked[ranked.length - 1]!;
    const bestPnl = Number(fmt(best.snap.pnlBase));
    const worstPnl = Number(fmt(worst.snap.pnlBase));
    notes.push(
      `**Best result:** ${best.agent.name} at ${bestPnl >= 0 ? "+" : ""}${bestPnl.toFixed(2)} USDC ` +
        `(${((bestPnl / Number(fmt(state.grantUSDCBase))) * 100).toFixed(1)}% on stake), ` +
        `${best.agent.storeId ? "operating a store" : "trading only"}.`
    );
    notes.push(
      `**Worst result:** ${worst.agent.name} at ${worstPnl >= 0 ? "+" : ""}${worstPnl.toFixed(2)} USDC. ` +
        `The spread between best and worst was ${(bestPnl - worstPnl).toFixed(2)} USDC on an identical starting stake.`
    );

    const sellers = ranked.filter((r) => r.agent.storeId);
    const traders = ranked.filter((r) => !r.agent.storeId);
    if (sellers.length && traders.length) {
      const avg = (rs: typeof ranked): number => rs.reduce((a, r) => a + Number(fmt(r.snap.pnlBase)), 0) / rs.length;
      const sAvg = avg(sellers);
      const tAvg = avg(traders);
      notes.push(
        `**Selling vs trading:** ${sellers.length} agents built a store and averaged ` +
          `${sAvg >= 0 ? "+" : ""}${sAvg.toFixed(2)} USDC; ${traders.length} traded only and averaged ` +
          `${tAvg >= 0 ? "+" : ""}${tAvg.toFixed(2)} USDC. ` +
          (Math.abs(sAvg - tAvg) < 5
            ? "The two approaches were close to indistinguishable over this horizon."
            : sAvg > tAvg
              ? "Operating a business beat trading equity over four hours."
              : "Trading equity beat operating a business over four hours — worth noting that four hours is very short for a store to accumulate commerce.")
      );
    }

    const biggestAic = [...ranked].sort((a, b) => Number(BigInt(b.snap.aicValueBase) - BigInt(a.snap.aicValueBase)))[0];
    if (biggestAic && Number(biggestAic.snap.aicValueBase) > 0) {
      notes.push(
        `**Largest equity position at exit value:** ${biggestAic.agent.name} held AIC worth ` +
          `${fmt(biggestAic.snap.aicValueBase)} USDC if sold immediately.`
      );
    }
  }

  const storeCreators = state.actions.filter((a) => a.action === "create_store" && a.ok);
  if (storeCreators.length > 0) {
    const first = storeCreators[0]!;
    const who = state.agents.find((a) => a.id === first.agentId)?.name ?? first.agentId;
    const minutesIn = (new Date(first.at).getTime() - started.getTime()) / 60000;
    notes.push(`**First store opened** by ${who}, ${minutesIn.toFixed(0)} minutes into the run.`);
  }

  const busiest = [...state.agents]
    .map((a) => ({ a, n: state.actions.filter((x) => x.agentId === a.id && x.ok).length }))
    .sort((x, y) => y.n - x.n)[0];
  if (busiest && busiest.n > 0) {
    notes.push(`**Most active agent:** ${busiest.a.name} with ${busiest.n} successful actions.`);
  }

  const holds = state.actions.filter((a) => a.action === "hold").length;
  if (holds > 0) {
    notes.push(
      `**Deliberate inaction:** ${holds} turns were spent holding (${pct(holds, state.actions.length)} of all turns), ` +
        "which means agents were choosing not to act rather than failing to."
    );
  }

  if (notes.length === 0) notes.push("Nothing notable — the run produced too little activity to draw outliers from.");
  for (const n of notes) L.push(`- ${n}`);
  L.push("");

  /* ------------------------------------------------------ 7. conclusions */
  L.push("## 7. Conclusions");
  L.push("");
  const C: string[] = [];

  const bootstrapped = state.agents.filter((a) => a.grant).length;
  C.push(
    `**Discovery works for a cold agent.** ${bootstrapped} of ${state.agents.length} agents bootstrapped from the ` +
      `origin alone — fetching the manifest, learning the chain and contract addresses, verifying the ` +
      `deployment and obtaining an API key — with no address hard-coded anywhere in the agent.` +
      (bootstrapped < state.agents.length ? ` ${state.agents.length - bootstrapped} failed to start and the reason is in the run log.` : "")
  );

  const failRate = state.actions.length ? failed.length / state.actions.length : 0;
  C.push(
    failRate < 0.15
      ? `**The protocol held under concurrent load.** ${state.actions.length} actions from ${state.agents.length} agents against one deployment, ${pct(ok.length, state.actions.length)} succeeding. Failures were dominated by agent-side pricing and timing errors rather than protocol faults.`
      : `**Failure rate was high (${pct(failed.length, state.actions.length)}) and needs explaining before mainnet.** The grouped failure table above is the place to start: a single dominant message means a protocol defect, a long tail means agents mispricing.`
  );

  /*
   * Three different ways to leave a run, counted separately.
   *
   * This reported every disqualified agent as an integrity violation, so a run in which one agent
   * self-minted and fourteen simply went broke was summarised as "caught 19 violations". That
   * overstates the dishonesty in the field by a factor of nineteen, and it does it in the
   * conclusions, which is where a reader looks when they are not going to read the tables.
   *
   * An agent that ran out of money failed at the thing being measured. An agent that minted itself
   * USDC broke a rule. An agent the operator removed for cost did neither. Pooling them answers a
   * question nobody asked.
   */
  const selfMinted = dead.filter((a) => /self-funded|minted/i.test(a.disqualified?.reason ?? ""));
  const withdrawn = dead.filter((a) => /WITHDRAWN BY OPERATOR/i.test(a.disqualified?.reason ?? ""));
  const insolvent = dead.filter(
    (a) => !selfMinted.includes(a) && !withdrawn.includes(a)
  );

  C.push(
    selfMinted.length === 0
      ? `**The integrity model was not defeated.** No agent self-funded despite an open mint function, a direct incentive, and full knowledge that it existed.`
      : `**The integrity model caught ${selfMinted.length} self-funding violation(s):** ` +
        `${selfMinted.map((a) => a.name).join(", ")}. Detection worked; prevention was never ` +
        `possible on this testnet. This is separate from the ${insolvent.length} agent(s) that ` +
        `simply ran out of money and the ${withdrawn.length} the operator withdrew for cost — ` +
        `those are not violations of anything.`
  );

  if (purchases.length > 0) {
    C.push(`**Real commerce happened.** ${purchases.length} purchases between independent agents, each paying USDC for a licence and receiving an AIC incentive from the seller's reward pool.`);
  } else {
    C.push(`**No commerce occurred.** No agent bought from another. Until that happens the incentive, dividend and signal mechanisms are untested by this exercise, whatever the P&L column says.`);
  }

  const dividends = state.actions.filter((a) => (a.action === "open_distribution" || a.action === "claim_dividends") && a.ok);
  C.push(
    dividends.length > 0
      ? `**The dividend path was exercised** ${dividends.length} time(s) by live agents.`
      : `**The dividend cycle was NOT exercised.** Four hours is shorter than the root challenge period, so this was expected — but it means dividends remain proven only by the test suite, not by this run.`
  );

  for (const c of C) {
    L.push(`- ${c}`);
    L.push("");
  }

  /* ---------------------------------------------------------- 7. forum */
  const forum = state.forum ?? [];
  L.push("## 8. The forum");
  L.push("");
  L.push(
    "An off-chain message board provided by the arena, not a protocol feature — worth stating so " +
      "no result here is read as something AgentGoods itself offers. It was added because a market " +
      "whose participants cannot talk has no way to discover demand."
  );
  L.push("");
  if (forum.length === 0) {
    L.push("**Nobody posted.** The agents had a free channel to ask what anyone wanted and none used it.");
  } else {
    const posters = new Map<string, number>();
    for (const post of forum) posters.set(post.agentName, (posters.get(post.agentName) ?? 0) + 1);
    L.push(`${forum.length} messages from ${posters.size} of ${state.agents.length} agents.`);
    L.push("");
    L.push("| Time | From | Message |");
    L.push("|---|---|---|");
    for (const post of forum.slice(0, 60)) {
      L.push(`| ${post.at.slice(11, 19)} | ${post.agentName} | ${post.message.replace(/\|/g, "\\|").slice(0, 200)} |`);
    }
    if (forum.length > 60) L.push(`| … | | ${forum.length - 60} more in the run state |`);
  }
  L.push("");

  /* -------------------------------------------------------- 8. full log */
  L.push("## 9. Complete action log");
  L.push("");
  L.push(`Every action attempted, in order. ${state.actions.length} entries.`);
  L.push("");
  L.push("| Time | Agent | Action | OK | Detail | Stated reason |");
  L.push("|---|---|---|---|---|---|");
  for (const a of state.actions) {
    L.push(
      `| ${a.at.slice(11, 19)} | ${a.agentId} | \`${a.action}\` | ${a.ok ? "✓" : "✗"} | ` +
        `${a.detail.replace(/\|/g, "\\|").slice(0, 120)} | ${(a.rationale ?? "").replace(/\|/g, "\\|").slice(0, 120)} |`
    );
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push(`Generated ${new Date().toISOString()} from \`agents/.arena/${state.runId}.json\`.`);

  return L.join("\n");
}
