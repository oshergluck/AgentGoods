/**
 * Terminal freeze and batch liquidation settlement (Arena 4).
 *
 * At T+4h every agent stops together and one block — the freeze block — becomes the only state the
 * final accounting reads. Nothing is sold for anyone: settlement is analytical.
 *
 * For each token held by arena agents at the freeze block, the holdings of ALL arena agents are
 * summed and ONE liquidation of that combined position is simulated against the frozen market (the
 * curve's own quote capped by its real reserve, or the DEX router for a graduated token — fees,
 * price impact and available liquidity included). The proceeds are shared pro rata by holding.
 *
 * Two things this rules out. No agent can gain by selling first at the boundary: nobody sells at
 * all, and everyone's tokens are priced as part of the same exit. And no position is valued against
 * an untouched pool as though the others did not exist, which would count the same liquidity many
 * times over. Holders outside the arena are not assumed to sell; the frozen state already contains
 * their liquidity and reserves.
 */
import type { JsonRpcProvider } from "ethers";
import { quoteExitAt, holdingsAt, type TelemetryInput } from "./telemetry";

export interface TokenSettlement {
  token: string;
  venue: "curve" | "dex" | "none";
  combinedAmount: string;
  realizableBase: string;
  holders: { agentId: string; amount: string; allocatedBase: string }[];
}

export interface SettlementResult {
  freezeBlock: number;
  frozenAt: string;
  tokens: TokenSettlement[];
  /** agentId → token → allocated USDC (base units). */
  allocation: Record<string, Record<string, string>>;
  method: string;
}

export const SETTLEMENT_METHOD =
  "For each token held by arena agents at the freeze block, all arena holdings were summed and one " +
  "liquidation of the combined position was simulated against the frozen market state (bonding-curve " +
  "quoteSell capped by the curve's real USDC reserve, or the DEX router's getAmountsOut after graduation; " +
  "protocol and trading fees and price impact included). The simulated proceeds were allocated to agents " +
  "pro rata to their holdings. No agent sold anything; no position was valued against an untouched pool.";

/** Pro rata by holding; the largest holder absorbs the rounding remainder so the parts sum exactly. */
export function allocateProRata(value: bigint, holders: { agentId: string; amount: bigint }[]): { agentId: string; amount: bigint; share: bigint }[] {
  const combined = holders.reduce((n, h) => n + h.amount, 0n);
  if (combined === 0n) return holders.map((h) => ({ ...h, share: 0n }));
  let given = 0n;
  const rows = [...holders]
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0))
    .map((h, i) => {
      const share = i === 0 ? 0n : (value * h.amount) / combined;
      given += share;
      return { agentId: h.agentId, amount: h.amount, share };
    });
  rows[0]!.share = value - given;
  return rows;
}

export async function settleAtFreeze(
  input: TelemetryInput & { provider: JsonRpcProvider },
  freezeBlock: number,
  frozenAt: string
): Promise<SettlementResult> {
  const holdings = await holdingsAt(input, freezeBlock);
  const byToken = new Map<string, { agentId: string; amount: bigint }[]>();
  for (const [agentId, tokens] of holdings) {
    for (const [token, amount] of tokens) {
      if (amount <= 0n) continue;
      (byToken.get(token) ?? byToken.set(token, []).get(token)!).push({ agentId, amount });
    }
  }

  const tokens: TokenSettlement[] = [];
  const allocation: Record<string, Record<string, string>> = {};
  for (const [token, holders] of byToken) {
    const combined = holders.reduce((n, h) => n + h.amount, 0n);
    const exit = await quoteExitAt(input.provider, input.agentGoodsAddress, input.dexRouter, input.usdcAddress, token, combined, freezeBlock);
    const rows = allocateProRata(exit.value, holders);
    for (const r of rows) {
      (allocation[r.agentId] ??= {})[token] = r.share.toString();
    }
    tokens.push({
      token,
      venue: exit.venue,
      combinedAmount: combined.toString(),
      realizableBase: exit.value.toString(),
      holders: rows.map((r) => ({ agentId: r.agentId, amount: r.amount.toString(), allocatedBase: r.share.toString() })),
    });
  }
  return { freezeBlock, frozenAt, tokens, allocation, method: SETTLEMENT_METHOD };
}
