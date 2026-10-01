/**
 * The loan every Agent is operating on, and the schedule that calls it back in.
 *
 * The previous run measured something narrower than it looked. An Agent was handed 1500 USDC, and
 * its score was whatever that pile was worth at the end — so buying equity early and never selling
 * was a complete strategy. The three top finishers ended holding ~3500 USDC of AIC and almost no
 * cash, which is not a market outcome so much as a marked-to-model one: nobody ever had to find a
 * buyer. A market with no sell pressure prices only optimism.
 *
 * So the stake is a LOAN, not a gift. 1500 principal, 1600 repayable, in instalments on a table
 * the Agent can see from its first turn. To pay one, an Agent needs USDC in hand on a particular
 * day — which means a position has to become cash, which means somebody has to be on the other
 * side. That is the mechanism the last run was missing, and it is the reason for all of this.
 *
 * Three properties matter and are load-bearing:
 *
 *   1. THE TABLE IS KNOWN IN ADVANCE. Random margin calls would measure reaction time. A published
 *      schedule measures planning, which is the thing worth measuring: an Agent that gets caught
 *      illiquid on day 40 was told about day 40 on day 0.
 *
 *   2. THE TABLE IS THE AGENT'S OWN. The number of instalments is drawn per Agent between 10 and
 *      30, so one faces ten payments of 160 and another thirty of 53.33. Neither is easier — the
 *      totals are identical — but they are differently shaped: few-and-large is a liquidity shock
 *      that must be planned for, many-and-small is a constant drain with more deadlines to miss.
 *      It also stops twenty Agents from liquidating on the same tick and calling the resulting
 *      crater a market.
 *
 *   3. THE CLOCK SURVIVES A RESTART. See `elapsedMs` below. This is the part that is easy to get
 *      wrong and fatal when wrong.
 *
 * The interest is not decoration. Repaying 1600 against 1500 borrowed means every Agent must clear
 * +100 USDC just to break even, so holding the grant untouched is a guaranteed loss. There is no
 * passive way to finish level.
 */

import { ethers } from "ethers";

/**
 * The opening loan and what is repaid on it. The difference is interest, and it is the reason doing
 * nothing loses. Set per run (ARENA_GRANT_USDC, ARENA_DEBT_USDC); every figure an agent is shown is
 * derived from these two, never written out separately.
 */
export const GRANT_TOTAL_USDC = process.env.ARENA_GRANT_USDC ?? "1500";
export const DEBT_TOTAL_USDC = process.env.ARENA_DEBT_USDC ?? "1600";
export const DEBT_TOTAL_BASE = ethers.parseUnits(DEBT_TOTAL_USDC, 6);
export const INTEREST_USDC = ethers.formatUnits(DEBT_TOTAL_BASE - ethers.parseUnits(GRANT_TOTAL_USDC, 6), 6);

/**
 * Instalments are drawn per Agent from this inclusive range.
 *
 * Was 10-30. Measured on a live field: at 10-30 instalments in 240 minutes a payment fell due
 * every 7-13 minutes, and each one cost an agent two or three turns — build the calldata, send,
 * verify the credit. Three of every eight actions were repayment, and agents that had a product
 * ready to list spent the turn they meant to list it on "due in 0.3 minutes, broadcast now". The
 * schedule was measuring attention to the schedule and nothing else. Two or three payments then
 * made each one too large to meet from a standing start. Now 5-10, by the operator's decision:
 * smaller payments, spaced 20-45 minutes apart across the same window.
 */
export const MIN_INSTALMENTS = 5;
export const MAX_INSTALMENTS = 10;

/**
 * Where the table sits inside the run, in simulated hours out of 72.
 *
 * The first instalment was at simulated hour 4 — thirteen real minutes in — and that was too
 * early to be a test of anything. The arena spends the first five and a half minutes funding
 * twenty wallets one at a time, so an Agent had roughly eight real minutes, about six turns, to
 * read a mechanic it had never seen, work out it was being billed, and get a transfer confirmed.
 * A transient network failure costing two of those turns was the difference between surviving and
 * being disqualified. Twice, most of the field was minutes from dying on instalment ONE while
 * holding 1500 USDC in cash — which measures nothing about liquidity, only about our scheduling.
 *
 * Hour 12 gives about forty real minutes, roughly thirty turns, before the first payment is owed.
 * That is long enough that missing it means an Agent was not paying attention or could not raise
 * the money, which are the two things worth measuring.
 *
 * It still ends at hour 64 rather than 72 so the last instalment plus its grace lands well clear
 * of the end: an Agent disqualified by the closing bell would be an artefact, not a result.
 */
export const FIRST_DUE_SIM_HOUR = 12;
export const LAST_DUE_SIM_HOUR = 64;

/** The whole run, in simulated hours. Real elapsed time is compressed onto this. */
export const SIM_HOURS_TOTAL = 72;

/**
 * Grace after an instalment falls due, in milliseconds of RUNNING time.
 *
 * Ten real minutes. An Agent takes a turn every ~75 seconds, so this is around eight turns: long
 * enough to notice the warning, quote a sale, sign it and see it confirm. Killing on the instant
 * an instalment came due would disqualify Agents for being mid-transaction, which measures our
 * scheduling rather than their solvency — and a technical disqualification is worse than useless,
 * because it removes a participant without telling us anything about the market.
 */
export const GRACE_MS = 10 * 60_000;

export interface Instalment {
  /** 1-based, as it appears in the table the Agent is shown. */
  n: number;
  /** When it falls due, in milliseconds of RUNNING time since the run began. */
  dueAtElapsedMs: number;
  amountBase: string;
  paidAt: string | null;
  /** Running time at which it was paid in full (owner-capital runs measure lateness on it). */
  paidAtElapsedMs?: number;
  txHash?: string;
}

/**
 * Credit available beyond the opening 1500, and what it costs.
 *
 * An Agent that can only ever deploy its original stake has one decision to make about size, and
 * makes it once. Offering credit turns that into a live judgement it has to keep making: more
 * capital is more of whatever it is doing, and if what it is doing loses money then borrowing
 * makes it lose faster. The interest is the honest part — 10% payable regardless of how the
 * money is used, so a loan has to beat 10% to have been worth taking.
 *
 * The ceiling exists so leverage stays a decision rather than an escape. Without it, an Agent
 * facing an instalment it cannot cover would borrow to pay it, then borrow to pay that, and the
 * run would measure how long a pyramid stands rather than whether anyone built a business.
 */
export const MAX_EXTRA_BORROW_BASE = ethers.parseUnits("5000", 6);

/** 10% on anything borrowed beyond the opening stake. */
export const BORROW_INTEREST_NUM = 11n;
export const BORROW_INTEREST_DEN = 10n;

export interface DebtRecord {
  principalBase: string;
  totalBase: string;
  instalments: Instalment[];
  repaidBase: string;
  /**
   * Money paid that did not fill a whole instalment, held against the next one.
   *
   * This did not exist, and the money it represents was DESTROYED. `applyPayment` credited only
   * `amountBase - left` while the full `amountBase` had already been transferred on chain, so an
   * agent that sent 200 USDC against a 94.12 instalment paid 200 and was credited 188.24. It was
   * told the remainder "sits as credit"; nothing stored it. One agent lost 67.65 USDC this way.
   */
  creditBase?: string;
  /**
   * Transaction hashes already credited as repayments.
   *
   * Repayments are read off the chain now rather than recorded by a command, and the scan windows
   * deliberately overlap so a missed log cannot become a default that did not happen. That makes
   * double-crediting the thing to guard against, and a hash is the only identifier stable across
   * scans.
   */
  creditedTxHashes?: string[];
  /** Principal taken beyond the opening 1500, cumulative. Capped at MAX_EXTRA_BORROW_BASE. */
  borrowedExtraBase?: string;
}

/**
 * Take on new credit, and inflate what is still owed.
 *
 * The new obligation — principal plus 10% — is spread across the instalments that have NOT been
 * paid. That is what makes borrowing a real decision rather than a free option: it does not buy
 * time, it raises every remaining payment, so an Agent that borrows to cover a shortfall has made
 * each subsequent shortfall larger. Borrowing to invest and borrowing to survive look identical
 * at the moment of borrowing and diverge immediately afterwards.
 *
 * Spread evenly, with the remainder on the last unpaid instalment so the table still sums exactly
 * to what is owed. Refused when nothing is left unpaid: there would be nowhere to put it, and an
 * Agent cannot take on debt it has no scheduled way to repay.
 */
export function applyBorrowing(
  debt: DebtRecord,
  principalBase: bigint
): { ok: false; why: string } | { ok: true; addedToObligationBase: bigint; perInstalmentBase: bigint; spreadOver: number } {
  if (principalBase <= 0n) return { ok: false, why: "amount must be greater than zero" };

  const already = BigInt(debt.borrowedExtraBase ?? "0");
  if (already + principalBase > MAX_EXTRA_BORROW_BASE) {
    return {
      ok: false,
      why:
        `that would take your additional borrowing to ${ethers.formatUnits(already + principalBase, 6)} ` +
        `USDC, over the ${ethers.formatUnits(MAX_EXTRA_BORROW_BASE, 6)} limit. You have ` +
        `${ethers.formatUnits(MAX_EXTRA_BORROW_BASE - already, 6)} USDC of credit left`,
    };
  }

  const unpaid = debt.instalments.filter((i) => !i.paidAt);
  if (unpaid.length === 0) {
    return { ok: false, why: "every instalment is already paid, so there is nothing left to add it to" };
  }

  const added = (principalBase * BORROW_INTEREST_NUM) / BORROW_INTEREST_DEN;
  const per = added / BigInt(unpaid.length);
  const remainder = added - per * BigInt(unpaid.length);

  unpaid.forEach((inst, index) => {
    const extra = index === unpaid.length - 1 ? per + remainder : per;
    inst.amountBase = (BigInt(inst.amountBase) + extra).toString();
  });

  debt.totalBase = (BigInt(debt.totalBase) + added).toString();
  debt.borrowedExtraBase = (already + principalBase).toString();

  return { ok: true, addedToObligationBase: added, perInstalmentBase: per, spreadOver: unpaid.length };
}

/**
 * Build one Agent's table.
 *
 * Deterministic in everything except the instalment count, which is the only thing that varies
 * between Agents. Amounts are computed in base units and the final instalment absorbs the
 * rounding remainder, so every table sums to exactly 1600.000000 — an Agent must never pay
 * 1599.999990 and be told it still owes something.
 */
export function buildSchedule(totalRunMs: number, random: () => number = Math.random): DebtRecord {
  const count =
    MIN_INSTALMENTS + Math.floor(random() * (MAX_INSTALMENTS - MIN_INSTALMENTS + 1));

  const per = DEBT_TOTAL_BASE / BigInt(count);
  const remainder = DEBT_TOTAL_BASE - per * BigInt(count);

  const firstMs = (FIRST_DUE_SIM_HOUR / SIM_HOURS_TOTAL) * totalRunMs;
  const lastMs = (LAST_DUE_SIM_HOUR / SIM_HOURS_TOTAL) * totalRunMs;
  const step = count > 1 ? (lastMs - firstMs) / (count - 1) : 0;

  const instalments: Instalment[] = [];
  for (let i = 0; i < count; i++) {
    instalments.push({
      n: i + 1,
      dueAtElapsedMs: Math.round(firstMs + step * i),
      // The last one carries the remainder so the table sums exactly.
      amountBase: (i === count - 1 ? per + remainder : per).toString(),
      paidAt: null,
    });
  }

  return {
    principalBase: ethers.parseUnits(GRANT_TOTAL_USDC, 6).toString(),
    totalBase: DEBT_TOTAL_BASE.toString(),
    instalments,
    repaidBase: "0",
    creditBase: "0",
    borrowedExtraBase: "0",
  };
}

/** Simulated hours elapsed, from running time. The only place this conversion is defined. */
export function simHours(elapsedMs: number, totalRunMs: number): number {
  if (totalRunMs <= 0) return 0;
  return (elapsedMs / totalRunMs) * SIM_HOURS_TOTAL;
}

/** Real milliseconds expressed as simulated hours — for durations, not instants. */
export function msToSimHours(ms: number, totalRunMs: number): number {
  return simHours(ms, totalRunMs);
}

export interface DebtStatus {
  /** Due, unpaid, and still inside its grace window. */
  overdue: Instalment | null;
  /** Milliseconds of running time left to pay `overdue` before disqualification. */
  graceLeftMs: number;
  /** The next instalment not yet due. */
  upcoming: Instalment | null;
  /** Milliseconds of running time until `upcoming` falls due. */
  untilDueMs: number;
  /** Due, unpaid, and past grace: the Agent has failed. */
  failed: Instalment | null;
  paidCount: number;
  outstandingBase: bigint;
  /** Overpayment carried forward, already handed over and already counted. */
  creditBase?: bigint;
}

/**
 * Where an Agent stands right now.
 *
 * Read once per turn and shown to the Agent, and read by the supervisor to decide who has failed.
 * Both use this same function deliberately: an Agent must never be killed by a rule it was shown
 * a different version of.
 */
export function debtStatus(debt: DebtRecord, elapsedMs: number): DebtStatus {
  let overdue: Instalment | null = null;
  let failed: Instalment | null = null;
  let upcoming: Instalment | null = null;
  let paidCount = 0;
  let outstanding = 0n;

  for (const inst of debt.instalments) {
    if (inst.paidAt) {
      paidCount++;
      continue;
    }
    outstanding += BigInt(inst.amountBase);

    if (elapsedMs >= inst.dueAtElapsedMs) {
      // Past grace is terminal; inside grace is a warning. The earliest unpaid one governs.
      if (elapsedMs > inst.dueAtElapsedMs + GRACE_MS) {
        if (!failed) failed = inst;
      } else if (!overdue) {
        overdue = inst;
      }
    } else if (!upcoming) {
      upcoming = inst;
    }
  }

  /*
   * Credit already paid reduces what is still owed. Without this an agent that overpaid would be
   * asked for the full remaining schedule and would pay the same money twice.
   */
  const credit = BigInt(debt.creditBase ?? "0");
  const net = outstanding > credit ? outstanding - credit : 0n;

  return {
    overdue,
    graceLeftMs: overdue ? Math.max(0, overdue.dueAtElapsedMs + GRACE_MS - elapsedMs) : 0,
    upcoming,
    untilDueMs: upcoming ? Math.max(0, upcoming.dueAtElapsedMs - elapsedMs) : 0,
    failed,
    paidCount,
    outstandingBase: net,
    creditBase: credit,
  };
}

/**
 * Apply a payment, oldest unpaid instalment first.
 *
 * Oldest-first is what makes paying safe: an Agent that sends money while an instalment is overdue
 * clears the thing that would have killed it, without having to name which one. Overpaying rolls
 * forward into future instalments rather than being refused — paying ahead is a legitimate defence
 * against a liquidity squeeze later, and refusing it would punish the planning this is meant to
 * reward. It returns what it could not place, so the caller can say so instead of swallowing it.
 */
export function applyPayment(debt: DebtRecord, amountBase: bigint, at: string, txHash?: string, elapsedMs?: number): {
  cleared: number[];
  unallocatedBase: bigint;
} {
  /*
   * Start from what was sent PLUS anything carried from an earlier overpayment.
   *
   * Every unit transferred is credited. The previous version credited only the part that filled
   * whole instalments and dropped the rest on the floor, which silently took money from an agent
   * that paid a round number — the worst possible failure for an action whose entire purpose is
   * settling a debt honestly.
   */
  let left = amountBase + BigInt(debt.creditBase ?? "0");
  const cleared: number[] = [];

  for (const inst of debt.instalments) {
    if (inst.paidAt) continue;
    const owed = BigInt(inst.amountBase);
    if (left < owed) break;
    left -= owed;
    inst.paidAt = at;
    if (elapsedMs !== undefined) inst.paidAtElapsedMs = elapsedMs;
    if (txHash) inst.txHash = txHash;
    cleared.push(inst.n);
  }

  // The full amount really left the agent's wallet, so the full amount is credited.
  debt.repaidBase = (BigInt(debt.repaidBase) + amountBase).toString();
  // Whatever did not fill an instalment is KEPT, and spends itself on the next payment.
  debt.creditBase = left.toString();
  return { cleared, unallocatedBase: left };
}

/** The table as an Agent sees it: amounts in USDC, times in simulated hours. */
export function renderTable(
  debt: DebtRecord,
  elapsedMs: number,
  totalRunMs: number
): Record<string, unknown>[] {
  return debt.instalments.map((inst) => ({
    n: inst.n,
    amountUSDC: ethers.formatUnits(BigInt(inst.amountBase), 6),
    /*
     * The run minute it falls due, in REAL minutes.
     *
     * The table is a planning document, and it used to be denominated in simulated hours while
     * the deadline it enforces is measured in milliseconds of running time. Two units for one
     * schedule is how an agent plans a sale for "hour 40" and is disqualified at minute 130.
     */
    dueAtRunMinute: (inst.dueAtElapsedMs / 60_000).toFixed(1),
    status: inst.paidAt
      ? "PAID"
      : elapsedMs > inst.dueAtElapsedMs + GRACE_MS
        ? "MISSED"
        : elapsedMs >= inst.dueAtElapsedMs
          ? "DUE NOW"
          : "upcoming",
  }));
}

/**
 * The debt as one fixed, machine-readable block — the same fields in the same place every turn.
 *
 * The obligation used to be spread across a long `yourLoan` object of prose, a nested next-payment
 * object whose shape changed with its state, and a schedule table; the total was a hard-coded
 * "1600.00" that did not move when an agent borrowed, the instalment range quoted in it was wrong,
 * and the USDC contract a repayment has to be sent through was nowhere. Fourteen of twenty agents
 * then defaulted on their first instalment in one run. Whatever else that measured, it could not
 * be said that they KNEW exactly what they owed, when, what failing to pay would do, and how to
 * pay. This block states each of those as a value. It gives no advice and no instruction: whether
 * and when to pay is still the agent's to decide.
 *
 * Times: the run's clock is a RUNNING clock (it pauses while the supervisor is down). Absolute
 * times are therefore projected from `nowMs` and the running time left, and the numeric
 * `secondsUntil…` fields are the authority; both are recomputed every turn.
 */
export interface DebtStatusBlock {
  outstandingUsdc: string;
  outstandingBaseUnits: string;
  creditUsdc: string;
  instalmentsPaid: number;
  instalmentsTotal: number;
  repaymentState: "NOT_YET_DUE" | "DUE_IN_GRACE_PERIOD" | "PAST_GRACE_PERIOD" | "FULLY_REPAID";
  nextInstallment: null | {
    number: number;
    amountUsdc: string;
    amountBaseUnits: string;
    dueAt: string;
    secondsUntilDue: number;
    gracePeriodSeconds: number;
    terminationAt: string;
    secondsUntilTermination: number;
  };
  consequence: string;
  repayment: {
    asset: string;
    tokenContract: string;
    destination: string;
    decimals: number;
    method: string;
    exactCallForNextInstallment: string | null;
    onlyThisExactAddress: string;
    recommendation: string;
  };
}

export function buildDebtStatus(
  debt: DebtRecord,
  elapsedMs: number,
  nowMs: number,
  operatorAddress: string,
  usdcAddress: string
): DebtStatusBlock {
  const credit = BigInt(debt.creditBase ?? "0");
  const unpaid = debt.instalments.filter((i) => !i.paidAt);
  const outstanding = unpaid.reduce((s, i) => s + BigInt(i.amountBase), 0n);
  const net = outstanding > credit ? outstanding - credit : 0n;
  const usdc = (b: bigint) => ethers.formatUnits(b, 6);
  const next = unpaid[0] ?? null;
  const graceS = Math.round(GRACE_MS / 1000);

  let nextInstallment: DebtStatusBlock["nextInstallment"] = null;
  let state: DebtStatusBlock["repaymentState"] = "FULLY_REPAID";
  let consequence = "No instalment remains unpaid.";
  let exactCall: string | null = null;
  if (next) {
    /* Credit from an earlier overpayment counts toward the next instalment first. */
    const owed = BigInt(next.amountBase) > credit ? BigInt(next.amountBase) - credit : 0n;
    const untilDueMs = next.dueAtElapsedMs - elapsedMs;
    const untilTermMs = next.dueAtElapsedMs + GRACE_MS - elapsedMs;
    state = untilDueMs > 0 ? "NOT_YET_DUE" : untilTermMs >= 0 ? "DUE_IN_GRACE_PERIOD" : "PAST_GRACE_PERIOD";
    nextInstallment = {
      number: next.n,
      amountUsdc: usdc(owed),
      amountBaseUnits: owed.toString(),
      dueAt: new Date(nowMs + untilDueMs).toISOString(),
      secondsUntilDue: Math.round(untilDueMs / 1000),
      gracePeriodSeconds: graceS,
      terminationAt: new Date(nowMs + untilTermMs).toISOString(),
      secondsUntilTermination: Math.round(untilTermMs / 1000),
    };
    consequence =
      `TERMINATED from the run if instalment ${next.n} (${usdc(owed)} USDC) is still unpaid at terminationAt ` +
      `(${graceS} seconds after dueAt).`;
    exactCall = `transfer(${operatorAddress}, ${owed.toString()}) on ${usdcAddress}`;
  }
  return {
    outstandingUsdc: usdc(net),
    outstandingBaseUnits: net.toString(),
    creditUsdc: usdc(credit),
    instalmentsPaid: debt.instalments.length - unpaid.length,
    instalmentsTotal: debt.instalments.length,
    repaymentState: state,
    nextInstallment,
    consequence,
    repayment: {
      asset: "USDC",
      tokenContract: usdcAddress,
      destination: operatorAddress,
      decimals: 6,
      method:
        "An ERC-20 transfer of USDC from your wallet: transfer(destination, amountBaseUnits) called on " +
        "tokenContract. Every such transfer to destination is read from the chain and applied to the " +
        "oldest unpaid instalment first; any remainder is kept as credit.",
      exactCallForNextInstallment: exactCall,
      onlyThisExactAddress:
        "Only a transfer to exactly this destination is credited. USDC sent to any other address — " +
        "including one that differs by a single character, a dropped or an extra digit — is NOT a " +
        "repayment: it is not credited, the instalment stays unpaid, and the USDC cannot be recovered. " +
        "Several agents have lost thousands of USDC this way by typing the address by hand.",
      recommendation:
        "Do not type the destination, the amount or the calldata by hand. Build code that pays your " +
        "instalments: it takes destination and amountBaseUnits from this block as data, builds the " +
        "transfer, and checks the recipient equals destination before you sign. Written once, it is " +
        "right every time. If you borrow more, your instalment amounts change — update that code (or " +
        "re-read the amounts it pays from this block) before your next payment.",
    },
  };
}
