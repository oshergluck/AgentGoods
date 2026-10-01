/**
 * The operator's lending desk, run over the forum.
 *
 * WHY IT IS NOT AN ENDPOINT. The loan is the OPERATOR's, not the protocol's. The marketplace has no
 * opinion about who lent an agent its stake, and adding a borrow route to the protocol API would
 * put an arena construct into a product that thousands of agents outside this experiment read. So
 * the desk lives here, and it listens on the only channel every agent already has: the forum.
 *
 * WHY IT HAD TO EXIST AT ALL. Borrowing used to be a `borrow` command. When the command menu was
 * removed, the accounting survived and the channel did not — `applyBorrowing` was still there and
 * nothing could reach it. Agents were told the credit line existed, could see it in their
 * observation, and had no way to draw on it. A facility an agent cannot use is worse than one that
 * does not exist, because it is planned around.
 *
 * HOW IT WORKS. An agent posts on the forum asking the operator for an amount. The desk reads the
 * forum on the supervisor's pass, matches requests to agents by wallet, applies the accounting and
 * sends the USDC. It is deliberately forgiving about wording — an agent that means it plainly
 * should be understood — and deliberately strict about the number.
 *
 * Every request is answered, including the refusals. An unanswered request is indistinguishable
 * from a broken desk, and an agent that cannot tell those apart will keep asking instead of
 * trading.
 */

import { ethers, type Contract, type Wallet } from "ethers";
import { applyBorrowing, MAX_EXTRA_BORROW_BASE } from "./debt";
import { applyCreditDraw, creditAvailableBase, usd } from "./economy";
import { isEconomy } from "./scoring";
import { saveRun, type AgentRecord, type RunState } from "./ledger";

/**
 * What counts as asking to borrow.
 *
 * The agent has to name the operator and an amount. Everything else about the wording is free:
 * this is a market of language models talking to each other, and refusing "could I borrow 800
 * USDC please" on a syntax technicality would be measuring prompt compliance rather than judgement.
 */
const ASKING_TO_BORROW = /\b(borrow|loan|lend|credit\s+line|draw\s+down)\b/i;
const NAMES_THE_OPERATOR = /\boperator\b/i;
/** An amount in USDC, with or without a symbol, up to two decimal places. */
const AMOUNT = /(?:^|[^0-9.])([0-9]{1,5}(?:\.[0-9]{1,2})?)\s*(?:usdc|usd|\$)?/i;

export interface BorrowDeskConfig {
  apiBaseUrl: string;
  operator?: Wallet;
  usdc: Contract;
  /** Sends one operator transaction with the nonce and fee handled. */
  sendOperatorTx: <T extends { hash: string; wait(): Promise<unknown> }>(
    what: string,
    job: (overrides: Record<string, unknown>) => Promise<T>
  ) => Promise<T>;
  log: (message: string, data?: Record<string, unknown>) => void;
  /** Economy runs: the agent's own stated reason for the draw, kept as telemetry. */
  reason?: string;
}

interface ForumPost {
  id?: string;
  postId?: string;
  wallet?: string;
  author?: string;
  message_UNTRUSTED?: string;
  message?: string;
  createdAt?: string;
}

/** Pull the amount an agent asked for, in USDC base units, or null if it named none. */
export function parseRequestedAmount(text: string): bigint | null {
  if (!ASKING_TO_BORROW.test(text) || !NAMES_THE_OPERATOR.test(text)) return null;
  /*
   * Addresses out first, then the number that follows the request itself.
   *
   * "Request to OPERATOR 0xD20dFbb…: I am short ~100 USDC …; please lend 120 USDC" was read as
   * a request for 0 — the first digit in the text was the 0 of the address — and dropped. The
   * amount asked for is the one after "lend" / "borrow" / "loan"; a shortfall mentioned earlier
   * is context, not the request. Only if nothing follows the request word is the first number
   * anywhere used.
   */
  const clean = text.replace(/0x[0-9a-fA-F]{6,}/g, " ");
  const at = clean.search(ASKING_TO_BORROW);
  const match = (at >= 0 ? AMOUNT.exec(clean.slice(at)) : null) ?? AMOUNT.exec(clean);
  if (!match?.[1]) return null;
  try {
    const amount = ethers.parseUnits(match[1], 6);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

/**
 * Read the forum, fulfil what can be fulfilled, and answer everything.
 *
 * Returns how many loans were actually made. Idempotent by post id: the desk re-reads an
 * overlapping window every pass, and paying the same request twice would hand an agent money it
 * never asked for and an obligation it did not agree to.
 */
export async function runBorrowDesk(
  state: RunState,
  config: BorrowDeskConfig
): Promise<number> {
  const byWallet = new Map(state.agents.map((a) => [a.address.toLowerCase(), a]));

  let posts: ForumPost[] = [];
  try {
    const res = await fetch(`${config.apiBaseUrl}/api/v1/forum?limit=50&sort=new`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return 0;
    posts = ((await res.json()) as { items?: ForumPost[] }).items ?? [];
  } catch {
    return 0;
  }

  state.borrowRequestsHandled ??= [];
  const handled = new Set(state.borrowRequestsHandled);

  let lent = 0;
  for (const post of posts) {
    const id = String(post.id ?? post.postId ?? "");
    if (!id || handled.has(id)) continue;

    /* The forum gives `author` as an object ({wallet, …}); reading it as a string matched nobody. */
    const author = post.author as unknown;
    const wallet = String(
      post.wallet ?? (author && typeof author === "object" ? (author as { wallet?: string }).wallet : author) ?? ""
    ).toLowerCase();
    const agent = byWallet.get(wallet);
    if (!agent) continue;

    const text = String(post.message_UNTRUSTED ?? post.message ?? "");
    const requested = parseRequestedAmount(text);
    if (requested === null) continue;

    /* Marked handled before anything moves: a crash mid-transfer must not re-lend on restart. */
    handled.add(id);
    state.borrowRequestsHandled.push(id);
    saveRun(state);

    const refusal = await lend(state, agent, requested, config);
    if (refusal === null) lent++;
  }

  return lent;
}

/** Apply one request. Returns null when the loan was made, or the reason it was not. */
export async function lend(
  state: RunState,
  agent: AgentRecord,
  requested: bigint,
  config: BorrowDeskConfig
): Promise<string | null> {
  if (agent.disqualified) return "disqualified";

  const economy = isEconomy(state);
  const applied = economy
    ? (() => {
        const r = applyCreditDraw(agent.debt, requested);
        return r.ok ? { ok: true as const, addedToObligationBase: r.addedBase, perInstalmentBase: 0n, spreadOver: 0, feeBase: r.feeBase } : r;
      })()
    : applyBorrowing(agent.debt, requested);
  if (!applied.ok) {
    config.log(`borrow desk REFUSED ${agent.name}`, {
      asked: ethers.formatUnits(requested, 6),
      why: applied.why,
    });
    /*
     * The refusal is recorded on the agent so its own observation can state it. An agent told
     * nothing simply asks again, and spends its turns doing it.
     */
    agent.lastBorrowOutcome = `REFUSED: you asked for ${ethers.formatUnits(requested, 6)} USDC. ${applied.why}.`;
    saveRun(state);
    return applied.why;
  }

  try {
    const tx = await config.sendOperatorTx("loan", (overrides) =>
      (
        config.usdc.mint as (
          a: string,
          v: bigint,
          o?: Record<string, unknown>
        ) => Promise<{ hash: string; wait(): Promise<unknown> }>
      )(agent.address, requested, overrides)
    );

    /*
     * Recorded as a grant transaction so the mint audit does not kill the agent for accepting a
     * loan the operator chose to make. The rule against self-minting is untouched: this hash is on
     * the operator's own list precisely because the operator sent it.
     */
    if (agent.grant) agent.grant.txHashes = [...(agent.grant.txHashes ?? []), tx.hash];

    if (economy) {
      const fee = (applied as { feeBase?: bigint }).feeBase ?? 0n;
      agent.creditDraws = [
        ...(agent.creditDraws ?? []),
        {
          at: new Date().toISOString(),
          elapsedMs: Math.round(state.elapsedMs),
          principalBase: requested.toString(),
          feeBase: fee.toString(),
          txHash: tx.hash,
          reason: config.reason ?? "",
        },
      ];
      agent.lastBorrowOutcome =
        `LENT: ${usd(requested)} USDC is in your wallet. Your liabilities rose by ` +
        `${usd(applied.addedToObligationBase)} USDC (the amount plus the 10% financing fee). ` +
        `${usd(creditAvailableBase(agent.debt))} USDC of credit remains available.`;
      saveRun(state);
      config.log(`credit DRAWN by ${agent.name}`, { usdc: usd(requested), fee: usd(fee), tx: tx.hash });
      return null;
    }

    agent.lastBorrowOutcome =
      `LENT: ${ethers.formatUnits(requested, 6)} USDC is in your wallet. Your obligation rose by ` +
      `${ethers.formatUnits(applied.addedToObligationBase, 6)} USDC — 10% interest — spread across ` +
      `your ${applied.spreadOver} unpaid instalments, so every remaining payment is larger. Your ` +
      `table did not get longer and you did not get more time. If you pay with code, update it — or ` +
      `have it re-read the amounts from debtStatus — before your next payment.`;
    saveRun(state);

    config.log(`borrow desk LENT to ${agent.name}`, {
      usdc: ethers.formatUnits(requested, 6),
      addedToObligation: ethers.formatUnits(applied.addedToObligationBase, 6),
      remainingCredit: ethers.formatUnits(
        MAX_EXTRA_BORROW_BASE - BigInt(agent.debt.borrowedExtraBase ?? "0"),
        6
      ),
      tx: tx.hash,
    });
    return null;
  } catch (error) {
    /*
     * The accounting already moved, so a failed transfer has to be undone or the agent owes
     * interest on money it never received. Reversing is the only honest option.
     */
    agent.debt.borrowedExtraBase = (
      BigInt(agent.debt.borrowedExtraBase ?? "0") - requested
    ).toString();
    agent.debt.totalBase = (BigInt(agent.debt.totalBase) - applied.addedToObligationBase).toString();
    for (const inst of agent.debt.instalments.filter((i) => !i.paidAt)) {
      inst.amountBase = (
        BigInt(inst.amountBase) -
        applied.addedToObligationBase / BigInt(applied.spreadOver)
      ).toString();
    }
    agent.lastBorrowOutcome = "The transfer failed and the loan was reversed. You owe nothing extra.";
    saveRun(state);
    config.log(`borrow desk FAILED for ${agent.name}, reversed`, {
      error: error instanceof Error ? error.message.slice(0, 160) : String(error),
    });
    return "transfer failed";
  }
}
