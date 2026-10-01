/**
 * An owner's view of its store as a business, not only as a position.
 *
 * Owners tracked token price and P&L and little else, so they reasoned like traders in their own
 * business. These are the figures an operator steers by, in four buckets — reach, conversion,
 * retention, economics — each computed from indexed purchases, trades and holders. Anything the
 * protocol does not record is listed as not available, never estimated: the API does not log who
 * inspects a store, views a product or requests a quote, so reach and inspection-based conversion
 * cannot be computed today.
 *
 * "Independent" always excludes the store's own controller. The protocol cannot tell whether two
 * wallets share an owner, and says so.
 */
import { AicHolder, Purchase, StockTrade } from "../db/models";
import { amountUSDC } from "../config/units";

export interface StoreRef {
  storeId: string;
  aicToken: string;
  storeController: string;
}

const NOT_RECORDED = "not recorded by the protocol today";

export async function businessMetricsFor(chainId: number, stores: StoreRef[]) {
  const out = new Map<string, unknown>();
  for (const s of stores) {
    const controller = s.storeController.toLowerCase();
    const token = s.aicToken.toLowerCase();
    const [purchases, holders, aic] = await Promise.all([
      Purchase.find({ chainId, storeId: s.storeId }).select({ buyer: 1, grossUSDC: 1, at: 1 }).lean(),
      AicHolder.find({ chainId, aicToken: token, balance: { $ne: "0" }, isContract: { $ne: true } }).select({ holder: 1 }).lean(),
      StockTrade.find({ chainId, aicToken: token, side: "buy", byController: { $ne: true }, ownerSeed: { $ne: true }, buyback: { $ne: true } })
        .select({ trader: 1, grossUSDC: 1 })
        .lean(),
    ]);

    const independent = purchases.filter((p) => String(p.buyer).toLowerCase() !== controller);
    const perBuyer = new Map<string, number>();
    let revenue = 0n;
    for (const p of independent) {
      perBuyer.set(p.buyer, (perBuyer.get(p.buyer) ?? 0) + 1);
      revenue += BigInt(String(p.grossUSDC ?? "0"));
    }
    const buyers = [...perBuyer.keys()];
    const repeatBuyers = buyers.filter((b) => (perBuyer.get(b) ?? 0) >= 2).length;
    const holderSet = new Set(holders.map((h) => String(h.holder).toLowerCase()).filter((h) => h !== controller));
    const buyersWhoHold = buyers.filter((b) => holderSet.has(b)).length;
    const aicBuyers = new Set(aic.map((t) => String(t.trader).toLowerCase()).filter((t) => t !== controller));
    const aicVolume = aic.reduce((a, t) => a + BigInt(String(t.grossUSDC ?? "0")), 0n);
    const last = independent.reduce((a, p) => Math.max(a, Number(p.at ?? 0)), 0);

    out.set(s.storeId, {
      reach: {
        storeInspections: null,
        productViews: null,
        quotesRequested: null,
        unavailableReason: NOT_RECORDED,
      },
      conversion: {
        independentProductPurchases: independent.length,
        independentBuyers: buyers.length,
        independentAICBuyers: aicBuyers.size,
        independentAICBuyVolumeUSDC: amountUSDC(aicVolume),
        inspectionToPurchase: null,
        buyerToHolderPercent: buyers.length > 0 ? ((buyersWhoHold / buyers.length) * 100).toFixed(1) : null,
      },
      retention: {
        repeatBuyers,
        repeatBuyerPercent: buyers.length > 0 ? ((repeatBuyers / buyers.length) * 100).toFixed(1) : null,
        independentHolders: holderSet.size,
        lastIndependentPurchaseAt: last > 0 ? new Date(last * 1000).toISOString() : null,
      },
      economics: {
        independentProductRevenueUSDC: amountUSDC(revenue),
        note: "Proceeds, reserve and your P&L are in the rest of this store's entry and in tokenMarket.",
      },
      howToReadIt:
        "Reach -> conversion -> retention -> economics. Do not optimize economics while ignoring the first three. " +
        "Independent excludes your own wallet; the protocol cannot tell whether two wallets share an owner. Figures " +
        "the protocol does not record are null with unavailableReason — never an estimate.",
    });
  }
  return out;
}
