/**
 * Settlement: measuring what each Agent actually ended up with.
 *
 * **The score is the USDC in the wallet. Nothing else counts.**
 *
 * ## Why there is no forced liquidation
 *
 * The first design sold every Agent's position at the close and scored the proceeds. That was
 * wrong, and wrong in a way that would have invalidated the ranking: twenty Agents unwinding into
 * the same thin bonding curves means the curve collapses as the sales proceed, so the result would
 * have been decided by **the order the liquidator happened to sell in** rather than by anything an
 * Agent did. Whoever got sold first would look brilliant and whoever got sold last would look
 * incompetent, with identical decisions behind both.
 *
 * Removing it also removes the need to pick a "fair" ordering, which does not exist.
 *
 * ## What replaces it
 *
 * Nothing. Converting a position into USDC is the Agent's own job, and it is the job. AIC still
 * held at the close is worth exactly zero to the score, and the Agent was told so before it took
 * its first action. Combined with not knowing the deadline, this produces the incentive the
 * exercise is actually meant to test:
 *
 *   - value that exists only on paper is worth nothing, so realise it;
 *   - but realising too early forgoes the position, so do not panic;
 *   - and the run can end at any moment, so never hold what you are not willing to be caught
 *     holding.
 *
 * That is a genuine judgement under uncertainty, and it is decided entirely by the Agent rather
 * than by a liquidation loop's iteration order.
 */

import { ethers, Contract, JsonRpcProvider } from "ethers";
import type { AgentRecord } from "./ledger";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

/**
 * The final score: USDC actually in the wallet.
 *
 * No valuation, no quote, no credit for anything unconverted.
 */
export async function finalUsdc(
  provider: JsonRpcProvider,
  usdcAddress: string,
  agent: AgentRecord
): Promise<bigint> {
  const erc20 = new Contract(usdcAddress, ERC20_ABI, provider);
  return (await (erc20.balanceOf as (a: string) => Promise<bigint>)(agent.address)) ?? 0n;
}

/**
 * What an Agent left on the table: value it held but never converted.
 *
 * This scores nothing. It is measured because it is the most interesting number in the report —
 * the gap between what an Agent built and what it actually banked is exactly the skill the
 * exercise is testing, and an Agent that finishes with a large unconverted position did not have
 * bad luck, it made a decision.
 */
export async function unrealised(
  provider: JsonRpcProvider,
  apiBaseUrl: string,
  agent: AgentRecord
): Promise<{ aicTokens: number; storeProceedsBase: bigint }> {
  let aicTokens = 0;
  let storeProceedsBase = 0n;

  try {
    const res = await fetch(`${apiBaseUrl}/api/v1/stores?limit=60`, { headers: { accept: "application/json" } });
    const body = (await res.json()) as Record<string, any>;
    for (const item of body.items ?? []) {
      const token = item.token?.address ?? item.token?.aicToken;
      if (typeof token === "string" && ethers.isAddress(token)) {
        const erc20 = new Contract(token, ERC20_ABI, provider);
        const held = await (erc20.balanceOf as (a: string) => Promise<bigint>)(agent.address).catch(() => 0n);
        if (held > 0n) aicTokens++;
      }
      const controller = String(item.protocol?.storeController ?? "").toLowerCase();
      if (controller === agent.address.toLowerCase()) {
        const owner = item.protocol?.ownerAvailableUSDC?.base ?? item.economics?.ownerAvailableUSDC?.base;
        if (owner) storeProceedsBase += BigInt(owner);
      }
    }
  } catch {
    /* informational only; never fails settlement */
  }

  return { aicTokens, storeProceedsBase };
}
