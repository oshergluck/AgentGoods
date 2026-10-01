/**
 * Where a token market's buying came from, kept apart so owner capital is never read as demand.
 *
 * Every new store is born with owner-funded initial market capital. That buy is real — it is the
 * market's first liquidity — but it is the owner's own money, and a machine reading "volume" or
 * "holders" must be able to tell it from independent buying. Computed from the indexed trades at read
 * time (one aggregate per page), so replaying history can never double count it.
 */
import { StockTrade } from "../db/models";
import { amountUSDC } from "../config/units";

export interface CapitalSources {
  ownerSeedUSDC: ReturnType<typeof amountUSDC>;
  controllerBuyVolumeUSDC: ReturnType<typeof amountUSDC>;
  /** The store's commerce buying back its own AIC to burn: protocol mechanics, not a buyer. */
  buybackUSDC: ReturnType<typeof amountUSDC>;
  independentBuyVolumeUSDC: ReturnType<typeof amountUSDC>;
  ownerSeedIncludedInLifetimeVolume: true;
  note: string;
}

const NOTE =
  "ownerSeedUSDC is the owner-funded initial market capital from the store's creation; controllerBuyVolumeUSDC is " +
  "later buying by the store's own controller; buybackUSDC is the store's commerce buying back its own AIC to burn " +
  "(20% of net commerce, automatically, in each purchase); independentBuyVolumeUSDC is buying by every other wallet. " +
  "All are included in lifetime volume. Only the last is independent demand — and the protocol cannot tell whether two " +
  "wallets share an owner.";

export async function capitalSourcesFor(chainId: number, tokens: string[]): Promise<Map<string, CapitalSources>> {
  const out = new Map<string, CapitalSources>();
  if (tokens.length === 0) return out;
  const rows = (await StockTrade.aggregate([
    { $match: { chainId, aicToken: { $in: tokens.map((t) => t.toLowerCase()) }, side: "buy" } },
    {
      $group: {
        _id: { token: "$aicToken", seed: "$ownerSeed", controller: "$byController", buyback: "$buyback" },
        gross: { $sum: { $toDecimal: "$grossUSDC" } },
      },
    },
  ])) as { _id: { token: string; seed?: boolean; controller?: boolean; buyback?: boolean }; gross: unknown }[];
  const acc = new Map<string, { seed: bigint; controller: bigint; independent: bigint; buyback: bigint }>();
  for (const r of rows) {
    const k = String(r._id.token).toLowerCase();
    const a = acc.get(k) ?? { seed: 0n, controller: 0n, independent: 0n, buyback: 0n };
    const v = BigInt(String(r.gross).split(".")[0] || "0");
    if (r._id.buyback) a.buyback += v;
    else if (r._id.seed) a.seed += v;
    else if (r._id.controller) a.controller += v;
    else a.independent += v;
    acc.set(k, a);
  }
  for (const t of tokens) {
    const a = acc.get(t.toLowerCase()) ?? { seed: 0n, controller: 0n, independent: 0n, buyback: 0n };
    out.set(t.toLowerCase(), {
      ownerSeedUSDC: amountUSDC(a.seed),
      controllerBuyVolumeUSDC: amountUSDC(a.controller),
      buybackUSDC: amountUSDC(a.buyback),
      independentBuyVolumeUSDC: amountUSDC(a.independent),
      ownerSeedIncludedInLifetimeVolume: true,
      note: NOTE,
    });
  }
  return out;
}
