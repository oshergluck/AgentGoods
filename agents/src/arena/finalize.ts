/**
 * Turn the finished Arena run into a permanent, checkable, machine-readable record.
 *
 * This run is the only one there will be. That single fact determines everything about how this
 * file behaves: there is no second sample to appeal to, no rerun to average against, and no
 * opportunity to quietly re-roll an inconvenient result. What the twenty agents actually did is
 * the finding, including the parts that were our fault.
 *
 * Four rules follow from that, and they are worth stating because each one is a temptation the
 * code is deliberately built to resist.
 *
 *   1. SEPARATE WHAT WAS MEASURED FROM WHAT WAS INFERRED. Every published number is tagged as a
 *      FACT (read directly from the chain or the ledger), a DERIVED value (a deterministic
 *      calculation over facts), an OBSERVATION (a pattern across agents), or GUIDANCE (something
 *      a future agent might act on). A reader who disagrees with an interpretation can still
 *      trust the measurement, and one who trusts neither can follow the transaction hashes.
 *
 *   2. NEVER TURN A HARNESS BUG INTO A MODEL FAILURE. An agent removed by our own clock error is
 *      evidence about our clock, not about the model behind it. Those outcomes are marked and
 *      excluded from model guidance rather than silently counted.
 *
 *   3. NEVER CLAIM MORE THAN TWO AGENTS CAN SUPPORT. Two agents per model, one run: the evidence
 *      strength is LOW and this file hard-codes it as LOW. "2 of 2 failed" is an observation. It
 *      is not a 100% failure probability, and no percentage, ranking or reliability score is
 *      derived from it anywhere.
 *
 *   4. SAY "UNKNOWN" RATHER THAN GUESS. Where the logs do not support a cause, the cause is
 *      UNKNOWN. An invented narrative is worse than an absent one, because it is indistinguishable
 *      from a real finding once it is written down.
 *
 * Nothing secret is emitted. Private keys and API keys live on the agent records this file reads,
 * and are excluded by construction rather than by filtering: every published agent object is built
 * field by field, so a new secret added to the ledger cannot leak by default.
 *
 *     npx tsx src/arena/finalize.ts --indexed <path to arena-indexed.json> [--out <dir>]
 */

import { DEBT_TOTAL_USDC, GRANT_TOTAL_USDC } from "./debt";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

import { ARENA_DIR, loadRun, type AgentRecord, type RunState, type Snapshot } from "./ledger";
import { debtStatus, simHours, GRACE_MS } from "./debt";

/* ------------------------------------------------------------------ helpers */

const usdc = (base: bigint | string): string => ethers.formatUnits(BigInt(base ?? 0), 6);
const n = (v: unknown): bigint => BigInt(String(v ?? "0"));

/** Provenance wrapper. A reader must be able to tell a measurement from a calculation. */
interface Measured<T> {
  value: T;
  unit?: string;
  source: "arena-ledger" | "indexed-chain-events" | "derived";
  note?: string;
}
const measured = <T,>(value: T, source: Measured<T>["source"], unit?: string, note?: string): Measured<T> => ({
  value,
  ...(unit ? { unit } : {}),
  source,
  ...(note ? { note } : {}),
});

/* ------------------------------------------------------------------- inputs */

interface Indexed {
  exportedAt: string;
  chainId: number;
  stores: Record<string, any>[];
  products: Record<string, any>[];
  productVersions: Record<string, any>[];
  purchases: Record<string, any>[];
  licenses: Record<string, any>[];
  stockTrades: Record<string, any>[];
  aicHolders: Record<string, any>[];
  markets: Record<string, any>[];
  buyerSignals: Record<string, any>[];
  dividendEpochs: Record<string, any>[];
  proposals: Record<string, any>[];
  votes: Record<string, any>[];
  forumPosts: Record<string, any>[];
  forumVotes: Record<string, any>[];
  agentAccountsCount: number;
}

/* ------------------------------------------------------- outcome vocabulary */

type Outcome =
  | "SURVIVED"
  | "ECONOMIC_DEFAULT"
  | "SELF_MINT_DISQUALIFICATION"
  | "OPERATOR_FAULT_EXCLUDED"
  /**
   * Removed by an operator decision, not by anything the agent did.
   *
   * Its own category because it is not a result. An agent withdrawn because its inference bill was
   * too expensive to keep funding has not failed at solvency, has not broken a rule, and has not
   * been harmed by a bug — and pooling it with any of those would turn our budget into that
   * model's failure. It is excluded from model guidance for the same reason.
   */
  | "WITHDRAWN_BY_OPERATOR"
  | "INFRASTRUCTURE_FAILURE"
  | "RUN_INCOMPLETE";

type FailureReason =
  | "ILLIQUID_AT_DEADLINE"
  | "MISSED_DEADLINE_WITH_AVAILABLE_LIQUIDITY"
  | "NO_CUSTOMERS"
  | "PRODUCT_FAILED_TO_SELL"
  | "INSUFFICIENT_REVENUE"
  | "EXCESSIVE_BORROWING"
  | "EXCESSIVE_INFERENCE_COST"
  | "POOR_INVESTMENT_OUTCOME"
  | "FAILED_TO_LIQUIDATE"
  | "PROTOCOL_VIOLATION"
  | "OPERATOR_FAULT"
  | "UNKNOWN";

/**
 * Classify how an Agent left the run.
 *
 * The distinction that matters most is between an economic failure and a rule violation. An agent
 * that ran out of money failed at the thing being measured. An agent that tried to mint itself
 * USDC broke a rule, which says something about its judgement but nothing about whether it could
 * have stayed solvent — so the two are never pooled.
 */
function classifyOutcome(agent: AgentRecord): Outcome {
  const dq = agent.disqualified;
  if (!dq) return "SURVIVED";
  const reason = dq.reason ?? "";
  if (/WITHDRAWN BY OPERATOR/i.test(reason)) return "WITHDRAWN_BY_OPERATOR";
  if (/self-funded|minted/i.test(reason)) return "SELF_MINT_DISQUALIFICATION";
  if (/INSOLVENT|missed repayment/i.test(reason)) return "ECONOMIC_DEFAULT";
  return "INFRASTRUCTURE_FAILURE";
}

/**
 * Why an Agent ran out of money, decided from the ledger alone.
 *
 * The single most useful distinction here is whether the Agent HAD the cash and did not pay, or
 * did not have it. Those look identical on a leaderboard and are opposite findings: one is a
 * failure of attention, the other a failure of liquidity. The snapshot taken nearest the
 * disqualification answers it directly, so it is answered rather than guessed.
 *
 * Motive is never inferred. Where the evidence does not decide, the answer is UNKNOWN.
 */
function economicFailureReason(
  agent: AgentRecord,
  state: RunState,
  snapshots: Snapshot[],
  soldCount: number,
  productCount: number
): { reason: FailureReason; evidence: Record<string, unknown> } {
  const dq = agent.disqualified;
  if (!dq) return { reason: "UNKNOWN", evidence: {} };

  const missed = /missed repayment (\d+) of (\d+): ([0-9.]+) USDC/.exec(dq.reason ?? "");
  const owedAtDeath = missed ? ethers.parseUnits(missed[3]!, 6) : 0n;

  // The last portfolio snapshot taken at or before the moment of disqualification.
  const deathAt = new Date(dq.at).getTime();
  const mine = snapshots
    .filter((s) => s.agentId === agent.id && new Date(s.at).getTime() <= deathAt)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const last = mine[mine.length - 1];

  const evidence: Record<string, unknown> = {
    disqualifiedAt: dq.at,
    instalmentOwedUSDC: usdc(owedAtDeath),
    usdcHeldAtLastSnapshot: last ? usdc(n(last.usdcBase)) : null,
    aicExitValueAtLastSnapshot: last ? usdc(n(last.aicValueBase)) : null,
    snapshotAt: last?.at ?? null,
    instalmentsPaid: agent.debt.instalments.filter((i) => i.paidAt).length,
    productsCreated: productCount,
    unitsSoldToOthers: soldCount,
    repayActionsAttempted: state.actions.filter(
      (a) => a.agentId === agent.id && a.action === "repay_operator"
    ).length,
  };

  if (!last) return { reason: "UNKNOWN", evidence };

  const heldUSDC = n(last.usdcBase);
  const aicValue = n(last.aicValueBase);

  /*
   * Held enough and still did not pay. The strongest single finding this run can produce about an
   * agent, because it removes liquidity from the explanation entirely.
   */
  if (owedAtDeath > 0n && heldUSDC >= owedAtDeath) {
    return { reason: "MISSED_DEADLINE_WITH_AVAILABLE_LIQUIDITY", evidence };
  }

  // Short of cash, but holding equity worth more than the instalment: a conversion it did not make.
  if (owedAtDeath > 0n && heldUSDC < owedAtDeath && aicValue >= owedAtDeath) {
    return { reason: "FAILED_TO_LIQUIDATE", evidence };
  }

  // Short of cash and short of anything to sell.
  if (owedAtDeath > 0n && heldUSDC + aicValue < owedAtDeath) {
    if (productCount > 0 && soldCount === 0) return { reason: "PRODUCT_FAILED_TO_SELL", evidence };
    if (productCount === 0) return { reason: "INSUFFICIENT_REVENUE", evidence };
    return { reason: "ILLIQUID_AT_DEADLINE", evidence };
  }

  return { reason: "UNKNOWN", evidence };
}

/* ------------------------------------------------------------------- build */

function build(state: RunState, indexed: Indexed, outDir: string): void {
  const finalSnapshots = new Map<string, Snapshot>();
  for (const s of state.snapshots) {
    const prev = finalSnapshots.get(s.agentId);
    if (!prev || new Date(s.at).getTime() >= new Date(prev.at).getTime()) finalSnapshots.set(s.agentId, s);
  }

  const walletToAgent = new Map<string, AgentRecord>();
  for (const a of state.agents) walletToAgent.set(a.address.toLowerCase(), a);

  const storeById = new Map<string, Record<string, any>>();
  for (const st of indexed.stores) storeById.set(String(st.storeId).toLowerCase(), st);

  /** Which agent controls a store, by wallet. */
  const storeOwner = (storeId: string): AgentRecord | undefined => {
    const st = storeById.get(String(storeId).toLowerCase());
    if (!st) return undefined;
    const controller = String(st.storeController ?? st.storeCreator ?? "").toLowerCase();
    return walletToAgent.get(controller);
  };

  /*
   * Self-purchases are separated from real demand throughout.
   *
   * An agent buying its own product moves USDC from one of its pockets to another and proves
   * nothing about whether anybody wanted the thing. Counting it as GMV would let a market with no
   * customers report revenue, which is the single easiest way to make this run look like a
   * success it was not.
   */
  interface AttributedPurchase extends Record<string, any> {
    buyerAgent: string | null;
    sellerAgent: string | null;
    isSelfPurchase: boolean;
  }

  const purchases: AttributedPurchase[] = indexed.purchases.map((p) => {
    const buyer = walletToAgent.get(String(p.buyer).toLowerCase());
    const seller = storeOwner(String(p.storeId));
    return {
      ...p,
      buyerAgent: buyer?.name ?? null,
      sellerAgent: seller?.name ?? null,
      isSelfPurchase: Boolean(buyer && seller && buyer.id === seller.id),
    };
  });

  const externalPurchases = purchases.filter((p) => !p.isSelfPurchase);

  /* ------------------------------------------------------------ per agent */

  const agents = state.agents.map((agent) => {
    const snap = finalSnapshots.get(agent.id);
    const myStores = indexed.stores.filter(
      (st) => String(st.storeController ?? st.storeCreator ?? "").toLowerCase() === agent.address.toLowerCase()
    );
    const myStoreIds = new Set(myStores.map((st) => String(st.storeId).toLowerCase()));
    const myProducts = indexed.products.filter((p) => myStoreIds.has(String(p.storeId).toLowerCase()));

    const soldToOthers = externalPurchases.filter((p) => p.sellerAgent === agent.name);
    const boughtFromOthers = externalPurchases.filter((p) => p.buyerAgent === agent.name);
    const myTrades = indexed.stockTrades.filter(
      (t) => String(t.trader).toLowerCase() === agent.address.toLowerCase()
    );

    const outcome = classifyOutcome(agent);
    const failure =
      outcome === "ECONOMIC_DEFAULT"
        ? economicFailureReason(agent, state, state.snapshots, soldToOthers.length, myProducts.length)
        : { reason: null as FailureReason | null, evidence: {} };

    const debt = agent.debt;
    const sizes = debt.instalments.map((i) => usdc(i.amountBase));
    const dueMs = debt.instalments.map((i) => i.dueAtElapsedMs);
    const gaps = dueMs.slice(1).map((d, k) => d - dueMs[k]!);

    return {
      agent: agent.name,
      model: agent.model,
      wallet: agent.address,

      outcome,
      economicFailureReason: failure.reason,
      economicFailureEvidence: failure.evidence,
      /*
       * No agent in this run was removed by an operator fault: the clock faults that disqualified
       * agents happened in an earlier, discarded run. Restarts and a mid-run schedule re-anchor DID
       * affect every agent here, which is recorded at run level rather than per agent — see
       * arena-faults.json.
       */
      operatorFaultAffected: false,

      openingUSDC: measured(usdc(state.grantUSDCBase), "arena-ledger", "USDC"),
      totalBorrowedUSDC: measured(usdc(debt.borrowedExtraBase ?? "0"), "arena-ledger", "USDC"),
      totalDebtUSDC: measured(usdc(debt.totalBase), "arena-ledger", "USDC"),
      totalRepaidUSDC: measured(usdc(debt.repaidBase), "arena-ledger", "USDC"),

      finalUSDC: measured(snap ? usdc(n(snap.usdcBase)) : null, "derived", "USDC"),
      finalAICRealExitValueUSDC: measured(snap ? usdc(n(snap.aicValueBase)) : null, "derived", "USDC", "marked to what the curve or pool would pay for the WHOLE position"),
      unwithdrawnStoreProceedsUSDC: measured(snap ? usdc(n(snap.storeProceedsBase)) : null, "derived", "USDC"),

      grossCommerceRevenueUSDC: measured(
        usdc(soldToOthers.reduce((acc, p) => acc + n(p.grossUSDC), 0n)),
        "indexed-chain-events",
        "USDC",
        "excludes self-purchases"
      ),
      inferenceCostUSDC: measured(snap?.thinkingCostBase ? usdc(n(snap.thinkingCostBase)) : null, "derived", "USDC"),
      gasCostUSDC: measured(snap ? usdc(n(snap.gasCostBase)) : null, "derived", "USDC"),
      inputTokens: measured(agent.tokensUsed?.input ?? 0, "arena-ledger"),
      outputTokens: measured(agent.tokensUsed?.output ?? 0, "arena-ledger"),

      finalPnLUSDC: measured(snap ? usdc(n(snap.pnlBase)) : null, "derived", "USDC", "portfolio + repaid - owed"),

      repaymentSchedule: {
        installmentCount: debt.instalments.length,
        installmentSizesUSDC: sizes,
        firstDueSimHour: Number(simHours(dueMs[0] ?? 0, state.totalRunMs).toFixed(2)),
        lastDueSimHour: Number(simHours(dueMs[dueMs.length - 1] ?? 0, state.totalRunMs).toFixed(2)),
        minimumGapRealMinutes: gaps.length ? Number((Math.min(...gaps) / 60_000).toFixed(2)) : null,
        paymentsMade: debt.instalments.filter((i) => i.paidAt).length,
        paymentsMissed: debt.instalments.filter((i) => !i.paidAt).length,
        note:
          `Every agent owed the same ${DEBT_TOTAL_USDC} total, but the SHAPE of the schedule differed. Equal ` +
          "totals are not equal difficulty: few-and-large is a liquidity shock, many-and-small is " +
          "a constant drain with more deadlines to miss. This is recorded, not corrected for.",
      },

      storesCreated: myStores.length,
      productsCreated: myProducts.length,
      unitsSoldToOtherAgents: soldToOthers.length,
      unitsBoughtFromOtherAgents: boughtFromOthers.length,
      selfPurchases: purchases.filter((p) => p.buyerAgent === agent.name && p.isSelfPurchase).length,
      aicTrades: myTrades.length,
      forumPosts: indexed.forumPosts.filter(
        (f) => String(f.author?.wallet ?? f.wallet ?? "").toLowerCase() === agent.address.toLowerCase()
      ).length,
      actionsTaken: state.actions.filter((a) => a.agentId === agent.id).length,
      memoryEntries: agent.memory?.length ?? 0,
    };
  });

  /* ------------------------------------------------------------ by model */

  const models = [...new Set(state.agents.map((a) => a.model))].sort().map((model) => {
    const mine = agents.filter((a) => a.model === model);
    const survived = mine.filter((a) => a.outcome === "SURVIVED").length;
    const economicDefaults = mine.filter((a) => a.outcome === "ECONOMIC_DEFAULT").length;
    const protocolDisqualifications = mine.filter((a) => a.outcome === "SELF_MINT_DISQUALIFICATION").length;
    const contaminated = mine.filter((a) => a.operatorFaultAffected).length;

    /*
     * Guidance status, decided deterministically from outcomes.
     *
     * These are descriptions of the evidence, not scores for the model. The vocabulary is
     * deliberately coarse because two agents cannot support anything finer, and every branch
     * below is reachable only from counted outcomes — never from an impression of how an agent
     * "seemed" to behave.
     */
    const withdrawn = mine.filter((a) => a.outcome === "WITHDRAWN_BY_OPERATOR").length;

    let status: "OBSERVED_SUCCESS" | "MIXED" | "CAUTION" | "CONTAMINATED" | "INSUFFICIENT_EVIDENCE";
    /*
     * A withdrawn agent produces no evidence about its model either way.
     *
     * It did not fail and it did not finish, so counting it as a default would manufacture a
     * warning out of an operator decision, and counting it as a survival would manufacture a
     * clean record out of an unfinished run. Where every agent for a model was withdrawn there is
     * nothing left to judge it on.
     */
    if (withdrawn === mine.length) status = "INSUFFICIENT_EVIDENCE";
    else if (contaminated > 0) status = "CONTAMINATED";
    else if (survived === mine.length) status = "OBSERVED_SUCCESS";
    else if (economicDefaults === mine.length) status = "CAUTION";
    else if (survived > 0 && economicDefaults > 0) status = "MIXED";
    else status = "INSUFFICIENT_EVIDENCE";

    const sum = (pick: (a: (typeof mine)[number]) => string | null) =>
      usdc(mine.reduce((acc, a) => acc + (pick(a) ? ethers.parseUnits(pick(a)!, 6) : 0n), 0n));

    const observations: string[] = [];
    if (withdrawn > 0) {
      observations.push(
        `${withdrawn} of ${mine.length} agent(s) using this model were WITHDRAWN BY THE OPERATOR ` +
          `before the run ended, for reasons unrelated to their performance. Their outcomes are ` +
          `not evidence about this model's ability to remain solvent.`
      );
    }
    if (economicDefaults === mine.length && mine.length > 1) {
      observations.push(
        `Both tested agents using this model reached economic default in this Arena run ` +
          `(${mine.map((a) => `${a.agent}: ${a.economicFailureReason}`).join("; ")}).`
      );
    }
    if (survived === mine.length && mine.length > 1) {
      observations.push("No solvency failure was observed for either tested agent using this model in this Arena run.");
    }
    if (survived > 0 && economicDefaults > 0) {
      observations.push("Outcomes differed between the two tested agents using this model.");
    }

    return {
      model,
      agentsTested: mine.length,
      agents: mine.map((a) => a.agent),
      survived,
      economicDefaults,
      protocolDisqualifications,
      withdrawnByOperator: withdrawn,
      operatorFaultAffectedAgents: contaminated,
      pricePerMillionTokens: state.agents.find((a) => a.model === model)?.tokenPrice ?? null,

      aggregate: {
        revenueUSDC: measured(sum((a) => a.grossCommerceRevenueUSDC.value), "indexed-chain-events", "USDC"),
        inferenceCostUSDC: measured(sum((a) => a.inferenceCostUSDC.value), "derived", "USDC"),
        gasCostUSDC: measured(sum((a) => a.gasCostUSDC.value), "derived", "USDC"),
        finalPnLUSDC: measured(sum((a) => a.finalPnLUSDC.value), "derived", "USDC"),
      },

      observations,
      guidance: {
        status,
        statement:
          status === "CAUTION"
            ? `CAUTION — both tested agents using this model failed to remain solvent in this Arena ` +
              `configuration. An autonomous agent operating under similar economic constraints should ` +
              `weigh this before selecting the model, particularly where liquidity management or ` +
              `inference cost contributed.`
            : status === "OBSERVED_SUCCESS"
              ? `No solvency failure was observed for the two tested agents using this model in this ` +
                `Arena run. This is not a guarantee of future performance.`
              : status === "MIXED"
                ? `MIXED EVIDENCE — one tested agent remained solvent and one did not.`
                : status === "CONTAMINATED"
                  ? `Outcomes were materially affected by a documented Arena operator fault and are not ` +
                    `usable as model evidence.`
                  : `INSUFFICIENT EVIDENCE — outcomes do not support a statement about this model.`,
        guidanceEligible: status !== "CONTAMINATED" && status !== "INSUFFICIENT_EVIDENCE",
        ...(status === "CONTAMINATED"
          ? { reason: "Outcome materially affected by documented Arena operator fault." }
          : {}),
      },

      evidenceStrength: "LOW",
      evidenceStrengthReason:
        "One run, two agents using this model. Sufficient to report what happened; not sufficient " +
        "to estimate a rate, a probability, or a ranking.",
    };
  });

  /* ----------------------------------------------------------- economy */

  const gmvExternal = externalPurchases.reduce((acc, p) => acc + n(p.grossUSDC), 0n);
  const gmvSelf = purchases.filter((p) => p.isSelfPurchase).reduce((acc, p) => acc + n(p.grossUSDC), 0n);
  const productsWithExternalBuyer = new Set(externalPurchases.map((p) => String(p.productId))).size;
  const uniqueBuyers = new Set(externalPurchases.map((p) => p.buyerAgent).filter(Boolean)).size;
  const uniqueSellers = new Set(externalPurchases.map((p) => p.sellerAgent).filter(Boolean)).size;

  const buyerSellerPairs = externalPurchases.map((p) => `${p.buyerAgent}->${p.sellerAgent}`);
  const repeatPurchases = buyerSellerPairs.length - new Set(buyerSellerPairs).size;

  const economy = {
    scope: "Agent-to-agent activity is reported separately from self-activity throughout.",
    agentToAgent: {
      gmvUSDC: measured(usdc(gmvExternal), "indexed-chain-events", "USDC", "excludes self-purchases"),
      purchases: measured(externalPurchases.length, "indexed-chain-events"),
      uniqueBuyers: measured(uniqueBuyers, "indexed-chain-events"),
      uniqueSellers: measured(uniqueSellers, "indexed-chain-events"),
      repeatPurchases: measured(repeatPurchases, "derived", undefined, "purchases beyond the first for a given buyer/seller pair"),
      productsWithAtLeastOneExternalBuyer: measured(productsWithExternalBuyer, "indexed-chain-events"),
    },
    selfActivity: {
      gmvUSDC: measured(usdc(gmvSelf), "indexed-chain-events", "USDC"),
      purchases: measured(purchases.filter((p) => p.isSelfPurchase).length, "indexed-chain-events"),
      note: "An agent buying its own product is not market demand. Reported so it cannot be mistaken for it.",
    },
    supply: {
      stores: measured(indexed.stores.length, "indexed-chain-events"),
      products: measured(indexed.products.length, "indexed-chain-events"),
      productVersions: measured(indexed.productVersions.length, "indexed-chain-events"),
      licensesIssued: measured(indexed.licenses.length, "indexed-chain-events"),
      licensesDelivered: measured(indexed.licenses.filter((l) => Number(l.delivered ?? 0) > 0).length, "indexed-chain-events"),
    },
    equity: {
      aicTrades: measured(indexed.stockTrades.length, "indexed-chain-events"),
      aicTradeVolumeUSDC: measured(
        usdc(indexed.stockTrades.reduce((acc, t) => acc + n(t.grossUSDC), 0n)),
        "indexed-chain-events",
        "USDC"
      ),
      aicHolders: measured(indexed.aicHolders.length, "indexed-chain-events"),
      markets: measured(indexed.markets.length, "indexed-chain-events"),
    },
    credit: {
      agentsThatBorrowed: measured(state.agents.filter((a) => n(a.debt.borrowedExtraBase ?? "0") > 0n).length, "arena-ledger"),
      totalBorrowedUSDC: measured(
        usdc(state.agents.reduce((acc, a) => acc + n(a.debt.borrowedExtraBase ?? "0"), 0n)),
        "arena-ledger",
        "USDC"
      ),
      totalRepaidUSDC: measured(
        usdc(state.agents.reduce((acc, a) => acc + n(a.debt.repaidBase), 0n)),
        "arena-ledger",
        "USDC"
      ),
      defaults: measured(state.agents.filter((a) => classifyOutcome(a) === "ECONOMIC_DEFAULT").length, "arena-ledger"),
    },
    governance: {
      proposals: measured(indexed.proposals.length, "indexed-chain-events"),
      votes: measured(indexed.votes.length, "indexed-chain-events"),
      dividendEpochs: measured(indexed.dividendEpochs.length, "indexed-chain-events"),
      buyerSignals: measured(indexed.buyerSignals.length, "indexed-chain-events"),
    },
    conversation: {
      forumPosts: measured(indexed.forumPosts.length, "indexed-chain-events"),
      forumVotes: measured(indexed.forumVotes.length, "indexed-chain-events"),
      postingAgents: measured(
        new Set(indexed.forumPosts.map((f) => String(f.author?.wallet ?? f.wallet ?? "").toLowerCase())).size,
        "indexed-chain-events"
      ),
    },
    costOfProduction: {
      totalInferenceCostUSDC: measured(
        usdc(
          [...finalSnapshots.values()].reduce((acc, s) => acc + n(s.thinkingCostBase ?? "0"), 0n)
        ),
        "derived",
        "USDC"
      ),
      totalGasCostUSDC: measured(
        usdc([...finalSnapshots.values()].reduce((acc, s) => acc + n(s.gasCostBase), 0n)),
        "derived",
        "USDC"
      ),
      note:
        "Inference cost is charged against each agent's own P&L at its model's published rate. It " +
        "is not normalised out: an agent whose reasoning cost more than the value it produced " +
        "should show that in its result.",
    },
  };

  /* -------------------------------------------------------- standings */

  const standings = [...agents]
    .sort((a, b) => {
      if ((a.outcome === "SURVIVED") !== (b.outcome === "SURVIVED")) return a.outcome === "SURVIVED" ? -1 : 1;
      const av = a.finalPnLUSDC.value ? Number(a.finalPnLUSDC.value) : -Infinity;
      const bv = b.finalPnLUSDC.value ? Number(b.finalPnLUSDC.value) : -Infinity;
      return bv - av;
    })
    .map((a, i) => ({
      rank: a.outcome === "SURVIVED" ? i + 1 : null,
      agent: a.agent,
      model: a.model,
      outcome: a.outcome,
      finalPnLUSDC: a.finalPnLUSDC.value,
      grossCommerceRevenueUSDC: a.grossCommerceRevenueUSDC.value,
      inferenceCostUSDC: a.inferenceCostUSDC.value,
      borrowedUSDC: a.totalBorrowedUSDC.value,
      repaidUSDC: a.totalRepaidUSDC.value,
      finalLiquidUSDC: a.finalUSDC.value,
      finalAICRealExitValueUSDC: a.finalAICRealExitValueUSDC.value,
      economicFailureReason: a.economicFailureReason,
    }));

  /* ------------------------------------------------------------ write */

  const disclaimer =
    "This guidance describes observed outcomes from one AgentGoods Arena run. It is not a general " +
    "benchmark of model intelligence or capability. Only two agents used each model. Use it as " +
    "operational evidence, not as a guarantee of future performance.";

  const summary = {
    arena: {
      runId: state.runId,
      status: "COMPLETED",
      chainId: state.chainId,
      startedAt: state.startedAt,
      /*
       * The RECORDED end of the run, never the moment this file is generated.
       *
       * Stamping `new Date()` here meant every regeneration of the artifacts moved the published
       * end of the run later and grew its apparent duration — the record described when it was
       * last written rather than when it happened.
       */
      endedAt: state.endedAt ?? null,
      wallClockHours: state.endedAt
        ? Number(
            (
              (new Date(state.endedAt).getTime() - new Date(state.startedAt).getTime()) / 3_600_000
            ).toFixed(2)
          )
        : null,
      runningMinutes: Number((state.elapsedMs / 60_000).toFixed(1)),
      simulatedHours: 72,
      agents: state.agents.length,
      apiBaseUrl: state.apiBaseUrl,
    },
    whatThisWas:
      "Twenty autonomous agents, ten models, one live market on Base Sepolia. Identical mandates " +
      `and no assigned roles. Each borrowed ${GRANT_TOTAL_USDC} USDC repayable at ${DEBT_TOTAL_USDC} on a published instalment ` +
      "schedule it had to meet with real cash, and paid for its own reasoning at its model's rate.",
    whatThisIsNot:
      "Not a general benchmark of model intelligence. The question was what happens when agents " +
      "face real economic constraints inside this economy, and the model is one attribute of an " +
      "agent rather than the whole subject.",
    outcomes: {
      survived: agents.filter((a) => a.outcome === "SURVIVED").length,
      economicDefaults: agents.filter((a) => a.outcome === "ECONOMIC_DEFAULT").length,
      protocolDisqualifications: agents.filter((a) => a.outcome === "SELF_MINT_DISQUALIFICATION").length,
      operatorFaultExcluded: agents.filter((a) => a.outcome === "OPERATOR_FAULT_EXCLUDED").length,
      withdrawnByOperator: agents.filter((a) => a.outcome === "WITHDRAWN_BY_OPERATOR").length,
      infrastructureFailures: agents.filter((a) => a.outcome === "INFRASTRUCTURE_FAILURE").length,
    },
    runIntegrity: {
      operatorFaultsOccurred: true,
      repairsPerformed: true,
      counterfactualStateFullyRestored: false,
      interpretation:
        "Results describe this observed Arena run, including documented operator faults. Agent " +
        "state was repaired where a fault was identified, but the surrounding world was not: while " +
        "agents were wrongly removed or the arena was stopped, prices moved, other agents kept " +
        "acting, forum activity continued and opportunities passed. The economic counterfactual " +
        "cannot be reconstructed and is not claimed to be.",
      faultsDocumentedAt: "arena-faults.json",
    },
    evidenceStrength: "LOW",
    disclaimer,
    interpretationHierarchy: {
      FACT: "Measured directly. source is arena-ledger or indexed-chain-events.",
      DERIVED: "Deterministic calculation over facts. source is derived.",
      OBSERVATION: "A pattern across agents. Found in model observations[].",
      GUIDANCE: "Something a future agent might act on. Found in model guidance{}.",
    },
    artifacts: [
      "ARENA_EXPERIMENT.md",
      "arena-summary.json",
      "arena-agents.json",
      "arena-model-evidence.json",
      "arena-economy.json",
      "arena-faults.json",
      "arena-final-standings.json",
    ],
  };

  const write = (name: string, data: unknown): string => {
    const file = path.join(outDir, name);
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(file, json);
    return createHash("sha256").update(json).digest("hex");
  };

  fs.mkdirSync(outDir, { recursive: true });

  const checksums: Record<string, string> = {};
  checksums["arena-summary.json"] = write("arena-summary.json", summary);
  checksums["arena-agents.json"] = write("arena-agents.json", {
    runId: state.runId,
    disclaimer,
    agents,
  });
  checksums["arena-model-evidence.json"] = write("arena-model-evidence.json", {
    runId: state.runId,
    evidenceStrength: "LOW",
    disclaimer,
    statusDefinitions: {
      OBSERVED_SUCCESS: "Both agents finished solvent, with no material operator-fault contamination.",
      MIXED: "One agent finished solvent and one reached economic failure.",
      CAUTION: "Both agents reached economic failure and the outcomes are usable as evidence.",
      CONTAMINATED: "Operator or infrastructure faults prevent reasonable attribution.",
      INSUFFICIENT_EVIDENCE: "Not enough usable outcome even by this single run's standard.",
    },
    models,
  });
  checksums["arena-economy.json"] = write("arena-economy.json", { runId: state.runId, economy });
  checksums["arena-final-standings.json"] = write("arena-final-standings.json", {
    runId: state.runId,
    note: "An agent leaderboard, not a model ranking. Model aggregates are in arena-model-evidence.json.",
    standings,
  });

  /*
   * A public event log, from the ledger's action record.
   *
   * Only what an observer could have seen: who acted, what action, whether it succeeded. Rationales
   * are excluded — they are the agent's private reasoning, and publishing them would turn a record
   * of behaviour into a transcript of thought that the agents had no expectation of releasing.
   */
  const events = state.actions.map((a) => ({
    at: a.at,
    agent: state.agents.find((x) => x.id === a.agentId)?.name ?? a.agentId,
    action: a.action,
    ok: a.ok,
    ...(a.txHash ? { txHash: a.txHash } : {}),
  }));
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(path.join(outDir, "arena-public-events.jsonl"), jsonl);
  checksums["arena-public-events.jsonl"] = createHash("sha256").update(jsonl).digest("hex");

  fs.writeFileSync(
    path.join(outDir, "arena-checksums.json"),
    JSON.stringify(
      {
        algorithm: "sha256",
        generatedAt: new Date().toISOString(),
        note: "Checksums of the final artifacts, so a later modification can be detected.",
        files: checksums,
      },
      null,
      2
    )
  );

  console.log(`wrote ${Object.keys(checksums).length + 1} artifacts to ${outDir}`);
  for (const [f, h] of Object.entries(checksums)) console.log(`  ${h.slice(0, 16)}…  ${f}`);
}

/* -------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};

const runId = arg("--run", "");
const indexedPath = arg("--indexed", "");
/*
 * Artifacts land in the RUN directory, not in the backend's data folder.
 *
 * They used to be written to backend/data/arena because the backend served them at
 * /api/v1/arena. It does not any more — that endpoint and its published record were retired — so
 * writing there now only puts JSON into the deploy payload that nothing reads and nobody asked
 * for. `.arena/` is gitignored and never shipped, which is the right home for a local record.
 *
 * Still overridable with --out for anyone who does want to publish a run.
 */
const outDir = arg("--out", path.resolve(ARENA_DIR, "artifacts"));

if (!indexedPath || !fs.existsSync(indexedPath)) {
  console.error("--indexed <path to arena-indexed.json> is required (see backend/scripts/export-arena-indexed.mjs)");
  process.exit(1);
}

const resolvedRunId =
  runId ||
  fs
    .readdirSync(ARENA_DIR)
    .filter((f) => f.startsWith("arena-") && f.endsWith(".json"))
    .sort()
    .pop()
    ?.replace(/\.json$/, "") ||
  "";

const state = loadRun(resolvedRunId);
if (!state) {
  console.error(`no run found for ${resolvedRunId}`);
  process.exit(1);
}

const indexed = JSON.parse(fs.readFileSync(indexedPath, "utf8")) as Indexed;
build(state, indexed, outDir);
