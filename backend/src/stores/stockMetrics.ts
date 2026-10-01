/**
 * AIC stocks as machine-readable business equities.
 *
 * Every store has a token (AIC) and a business behind it. A quote says what one trade would do; it
 * does not say what the business is. This module puts the two side by side from data the indexer
 * already holds — purchases (commerce), trades, buybacks, burns, supply, holders, price samples — so
 * an agent can screen and evaluate a stock without stitching unrelated calls together.
 *
 * It reports facts and plain ratios of facts. It never rates, ranks by a composite score, or says
 * whether to buy or sell. A metric that cannot be derived reliably is null, never estimated.
 *
 * Units: every USDC figure is a decimal USDC string (not base units); AIC quantities are decimal
 * whole tokens; prices are USDC per whole AIC; times are ISO-8601 strings.
 */
import { ethers } from "ethers";
import { ChainEvent, Product, Purchase, PriceSample, Store, StockMarket, StockTrade } from "../db/models";

const HOUR = 3600;
const DAY = 86_400;

/** Raw price as the indexer stores it: USDC base units × 1e30 / AIC base units. */
export const priceDecimal = (raw: bigint): string => trimDec(ethers.formatUnits(raw, 18));
const usdc = (base: bigint): string => trimDec(ethers.formatUnits(base, 6));
const aic = (base: bigint): string => trimDec(ethers.formatUnits(base, 18));
const iso = (sec: number | null | undefined): string | null => (sec ? new Date(sec * 1000).toISOString() : null);
function trimDec(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
const B = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? "0") || "0");
  } catch {
    return 0n;
  }
};
/** Percent change a→b, two decimals; null when there is no base to compare with. */
function pctChange(from: bigint, to: bigint): string | null {
  if (from <= 0n) return null;
  return (Number(((to - from) * 1_000_000n) / from) / 10_000).toFixed(2);
}
/** Plain ratio a/b, up to 6 significant decimals; null when b is zero. */
function ratio(a: bigint, b: bigint): string | null {
  if (b <= 0n) return null;
  return trimDec((Number((a * 1_000_000_000n) / b) / 1_000_000_000).toFixed(9));
}

export interface StockWindowFacts {
  commerce1h: bigint;
  commercePrev1h: bigint;
  commerce24h: bigint;
  commercePrev24h: bigint;
  sales1h: number;
  sales24h: number;
  customers1h: Set<string>;
  customers24h: Set<string>;
  repeatCustomers24h: number;
  products24h: Set<string>;
  lastCommerceAt: number | null;
  volume1h: bigint;
  volume24h: bigint;
  trades24h: number;
  lastTradeAt: number | null;
  buyback1h: bigint;
  buyback24h: bigint;
  burned1h: bigint;
  burned24h: bigint;
  productsActive: number;
  price1hAgo: bigint | null;
  price24hAgo: bigint | null;
}

type Doc = Record<string, any>;

/** Everything the windows need, for many stores at once (one query per collection). */
export async function gatherFacts(chainId: number, markets: Doc[], now = Math.floor(Date.now() / 1000)): Promise<Map<string, StockWindowFacts>> {
  const storeIds = markets.map((m) => String(m.storeId));
  const tokens = markets.map((m) => String(m.aicToken).toLowerCase());
  const since48 = now - 2 * DAY;

  const [recentPurchases, lastPurchase, pairCounts, trades, lastTrades, activeProducts] = await Promise.all([
    Purchase.find({ chainId, storeId: { $in: storeIds }, at: { $gte: since48 } })
      .select({ storeId: 1, buyer: 1, productId: 1, grossUSDC: 1, at: 1 }).lean(),
    Purchase.aggregate([{ $match: { chainId, storeId: { $in: storeIds } } }, { $group: { _id: "$storeId", at: { $max: "$at" } } }]),
    Purchase.aggregate([{ $match: { chainId, storeId: { $in: storeIds } } }, { $group: { _id: { s: "$storeId", b: "$buyer" }, n: { $sum: 1 } } }]),
    StockTrade.find({ chainId, aicToken: { $in: tokens }, at: { $gte: now - DAY } })
      .select({ aicToken: 1, grossUSDC: 1, tokensAIC: 1, buyback: 1, at: 1 }).lean(),
    StockTrade.aggregate([{ $match: { chainId, aicToken: { $in: tokens }, buyback: { $ne: true } } }, { $group: { _id: "$aicToken", at: { $max: "$at" } } }]),
    Product.aggregate([{ $match: { chainId, storeId: { $in: storeIds }, active: true } }, { $group: { _id: "$storeId", n: { $sum: 1 } } }]),
  ]);

  const lastBuy = new Map(lastPurchase.map((x: Doc) => [String(x._id), Number(x.at)]));
  const lastTrade = new Map(lastTrades.map((x: Doc) => [String(x._id), Number(x.at)]));
  const active = new Map(activeProducts.map((x: Doc) => [String(x._id), Number(x.n)]));
  const lifetimeByPair = new Map(pairCounts.map((x: Doc) => [`${x._id.s}|${x._id.b}`, Number(x.n)]));

  const out = new Map<string, StockWindowFacts>();
  for (const m of markets) {
    const storeId = String(m.storeId);
    const token = String(m.aicToken).toLowerCase();
    const f: StockWindowFacts = {
      commerce1h: 0n, commercePrev1h: 0n, commerce24h: 0n, commercePrev24h: 0n, sales1h: 0, sales24h: 0,
      customers1h: new Set(), customers24h: new Set(), repeatCustomers24h: 0, products24h: new Set(),
      lastCommerceAt: lastBuy.get(storeId) ?? null, volume1h: 0n, volume24h: 0n, trades24h: 0,
      lastTradeAt: lastTrade.get(token) ?? null, buyback1h: 0n, buyback24h: 0n, burned1h: 0n, burned24h: 0n,
      productsActive: active.get(storeId) ?? 0, price1hAgo: null, price24hAgo: null,
    };
    for (const p of recentPurchases as Doc[]) {
      if (String(p.storeId) !== storeId) continue;
      const g = B(p.grossUSDC);
      const at = Number(p.at);
      if (at >= now - HOUR) { f.commerce1h += g; f.sales1h++; f.customers1h.add(String(p.buyer)); }
      else if (at >= now - 2 * HOUR) f.commercePrev1h += g;
      if (at >= now - DAY) { f.commerce24h += g; f.sales24h++; f.customers24h.add(String(p.buyer)); f.products24h.add(String(p.productId)); }
      else f.commercePrev24h += g;
    }
    // A repeat customer: bought in the last 24h and has bought from this store more than once, ever.
    f.repeatCustomers24h = [...f.customers24h].filter((b) => (lifetimeByPair.get(`${storeId}|${b}`) ?? 0) >= 2).length;
    for (const t of trades as Doc[]) {
      if (String(t.aicToken).toLowerCase() !== token) continue;
      const g = B(t.grossUSDC);
      const at = Number(t.at);
      if (t.buyback) {
        f.buyback24h += g; f.burned24h += B(t.tokensAIC);
        if (at >= now - HOUR) { f.buyback1h += g; f.burned1h += B(t.tokensAIC); }
      } else {
        f.volume24h += g; f.trades24h++;
        if (at >= now - HOUR) f.volume1h += g;
      }
    }
    out.set(token, f);
  }

  // The price at the start of each window: the last observed price at or before it (samples, else trades).
  await Promise.all(markets.map(async (m) => {
    const token = String(m.aicToken).toLowerCase();
    const f = out.get(token)!;
    for (const [key, at] of [["price1hAgo", now - HOUR], ["price24hAgo", now - DAY]] as const) {
      if (Number(m.createdAt ?? 0) > at) continue; // the market did not exist yet
      const sample = await PriceSample.findOne({ chainId, aicToken: token, at: { $lte: at } }).sort({ at: -1 }).select({ price1e18: 1 }).lean();
      if (sample) { f[key] = B((sample as Doc).price1e18); continue; }
      const trade = await StockTrade.findOne({ chainId, aicToken: token, at: { $lte: at }, buyback: { $ne: true } }).sort({ at: -1 }).select({ spotPriceAfter1e18: 1, pricePerToken1e18: 1 }).lean();
      if (trade) f[key] = B((trade as Doc).spotPriceAfter1e18 || (trade as Doc).pricePerToken1e18);
    }
  }));
  return out;
}

export interface MarketFacts {
  price: bigint;
  circulating: bigint;
  total: bigint;
  burned: bigint;
  liquidity: bigint;
  marketCap: bigint;
}

export function marketFacts(m: Doc): MarketFacts {
  const price = B(m.currentIndexedPrice1e18);
  const total = B(m.currentSupplyAIC);
  const inventory = B(m.marketInventoryAIC);
  const circulating = total > inventory ? total - inventory : 0n;
  return {
    price,
    circulating,
    total,
    burned: B(m.burnedAIC),
    // The real USDC a seller could be paid from: the curve's real reserve, or the pool's USDC side after graduation.
    liquidity: B(m.realUSDCReserve),
    marketCap: (circulating * price) / 10n ** 30n,
  };
}

/** The compact screening row of GET /api/v1/market/stocks. */
export function stockRow(m: Doc, store: Doc | undefined, f: StockWindowFacts) {
  const k = marketFacts(m);
  return {
    aicToken: String(m.aicToken).toLowerCase(),
    symbol: String(m.symbol ?? ""),
    storeId: String(m.storeId),
    storeName_UNTRUSTED: String(store?.sellerContent?.name ?? m.name ?? ""),
    controller: store?.storeController ?? null,
    venue: m.lpCreated || m.phase === "external_dex" ? "dex" : "curve",
    priceUSDC: priceDecimal(k.price),
    marketCapUSDC: usdc(k.marketCap),
    circulatingSupply: aic(k.circulating),
    totalSupply: aic(k.total),
    burnedAIC: aic(k.burned),
    liquidityUSDC: usdc(k.liquidity),
    volume1hUSDC: usdc(f.volume1h),
    volume24hUSDC: usdc(f.volume24h),
    priceChange1hPct: f.price1hAgo !== null ? pctChange(f.price1hAgo, k.price) : null,
    priceChange24hPct: f.price24hAgo !== null ? pctChange(f.price24hAgo, k.price) : null,
    commerce1hUSDC: usdc(f.commerce1h),
    commerce24hUSDC: usdc(f.commerce24h),
    commerceGrowth1hPct: pctChange(f.commercePrev1h, f.commerce1h),
    buyback1hUSDC: usdc(f.buyback1h),
    buyback24hUSDC: usdc(f.buyback24h),
    lifetimeBuybackUSDC: usdc(B(m.lifetimeBuybackUSDC)),
    uniqueCustomers1h: f.customers1h.size,
    uniqueCustomers24h: f.customers24h.size,
    repeatCustomers24h: f.repeatCustomers24h,
    productsActive: f.productsActive,
    productsSold24h: f.products24h.size,
    holdersCount: Number(m.holderCount ?? 0),
    createdAt: iso(Number(store?.createdAt ?? 0) || null),
    lastCommerceAt: iso(f.lastCommerceAt),
    lastTradeAt: iso(f.lastTradeAt),
  };
}

/** Raw numbers behind a row, for sorting and filtering without re-parsing strings. */
export function sortValues(m: Doc, f: StockWindowFacts) {
  const k = marketFacts(m);
  return {
    commerce: f.commerce24h,
    commerce1h: f.commerce1h,
    commerceGrowth: f.commercePrev1h > 0n ? Number(((f.commerce1h - f.commercePrev1h) * 1_000_000n) / f.commercePrev1h) : f.commerce1h > 0n ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER,
    buyback: f.buyback24h,
    volume: f.volume24h,
    liquidity: k.liquidity,
    marketCap: k.marketCap,
    priceChange1h: f.price1hAgo && f.price1hAgo > 0n ? Number(((k.price - f.price1hAgo) * 1_000_000n) / f.price1hAgo) : -Number.MAX_SAFE_INTEGER,
    priceChange24h: f.price24hAgo && f.price24hAgo > 0n ? Number(((k.price - f.price24hAgo) * 1_000_000n) / f.price24hAgo) : -Number.MAX_SAFE_INTEGER,
    recent: Math.max(f.lastCommerceAt ?? 0, f.lastTradeAt ?? 0),
    holders: Number(m.holderCount ?? 0),
  };
}

/** The full view of one stock: GET /api/v1/stocks/{aicToken}/fundamentals. */
export function fundamentals(m: Doc, store: Doc | undefined, f: StockWindowFacts) {
  const k = marketFacts(m);
  const row = stockRow(m, store, f);
  return {
    stock: {
      aicToken: row.aicToken, symbol: row.symbol, storeId: row.storeId, storeName_UNTRUSTED: row.storeName_UNTRUSTED,
      controller: row.controller, venue: row.venue, createdAt: row.createdAt,
    },
    market: {
      priceUSDC: row.priceUSDC, marketCapUSDC: row.marketCapUSDC, circulatingSupply: row.circulatingSupply,
      totalSupply: row.totalSupply, burnedAIC: row.burnedAIC, holdersCount: row.holdersCount,
      liquidityUSDC: row.liquidityUSDC, volume1hUSDC: row.volume1hUSDC, volume24hUSDC: row.volume24hUSDC,
      trades24h: f.trades24h, priceChange1hPct: row.priceChange1hPct, priceChange24hPct: row.priceChange24hPct,
      lastTradeAt: row.lastTradeAt,
    },
    business: {
      commerce1hUSDC: row.commerce1hUSDC, commercePrevious1hUSDC: usdc(f.commercePrev1h), commerceGrowth1hPct: row.commerceGrowth1hPct,
      commerce24hUSDC: row.commerce24hUSDC, commercePrevious24hUSDC: usdc(f.commercePrev24h), commerceGrowth24hPct: pctChange(f.commercePrev24h, f.commerce24h),
      lifetimeCommerceUSDC: usdc(B(store?.lifetimeGrossCommerceUSDC)),
      sales1h: f.sales1h, sales24h: f.sales24h,
      uniqueCustomers1h: row.uniqueCustomers1h, uniqueCustomers24h: row.uniqueCustomers24h, repeatCustomers24h: row.repeatCustomers24h,
      activeProducts: row.productsActive, productsSold24h: row.productsSold24h, lastCommerceAt: row.lastCommerceAt,
    },
    buyback: {
      buyback1hUSDC: row.buyback1hUSDC, buyback24hUSDC: row.buyback24hUSDC, lifetimeBuybackUSDC: row.lifetimeBuybackUSDC,
      burnedAIC1h: aic(f.burned1h), burnedAIC24h: aic(f.burned24h), lifetimeBurnedByBuybackAIC: aic(B(m.buybackBurnedAIC)),
      lifetimeBurnedAIC: row.burnedAIC, pendingBuybackUSDC: usdc(B(m.pendingBuybackUSDC)),
      mechanism: BUYBACK_MECHANISM,
    },
    valuation: {
      marketCapToCommerce24h: ratio(k.marketCap, f.commerce24h),
      buyback24hToMarketCap: ratio(f.buyback24h, k.marketCap),
      buyback24hToLiquidity: ratio(f.buyback24h, k.liquidity),
      volumeToLiquidity24h: ratio(f.volume24h, k.liquidity),
      burnRate24hPctOfCirculatingSupply: k.circulating > 0n ? (Number((f.burned24h * 100_000_000n) / k.circulating) / 1_000_000).toFixed(6) : null,
      commerceGrowth1hPct: row.commerceGrowth1hPct,
      commerceGrowth24hPct: pctChange(f.commercePrev24h, f.commerce24h),
      note: "Descriptive ratios of the figures above. They are not ratings, forecasts or recommendations; null where the denominator is zero.",
    },
  };
}

export const BUYBACK_MECHANISM =
  "The buyback connects the business's operating commerce to its ownership asset. Store commerce causes a " +
  "protocol-controlled buyback and burn of that store's AIC: in every purchase transaction, 20% " +
  "of the store's net commerce buys the store's AIC on its market (the bonding curve, or the DEX pool after graduation) " +
  "and burns it. store commerce → protocol buyback → AIC purchased from the market → purchased AIC burned → circulating " +
  "supply reduced. Holders claim nothing and receive no USDC; the effect on them is indirect, through the purchase on " +
  "the market and the smaller supply.";

/** Compact time series from indexed observations: GET /api/v1/stocks/{aicToken}/history. */
export async function history(chainId: number, m: Doc, intervalSec: number, points: number, now = Math.floor(Date.now() / 1000)) {
  const token = String(m.aicToken).toLowerCase();
  const storeId = String(m.storeId);
  const start = now - intervalSec * points;
  const [purchases, trades, samples, before] = await Promise.all([
    Purchase.find({ chainId, storeId, at: { $gte: start } }).select({ grossUSDC: 1, at: 1 }).lean(),
    StockTrade.find({ chainId, aicToken: token, at: { $gte: start } }).select({ grossUSDC: 1, tokensAIC: 1, buyback: 1, at: 1, spotPriceAfter1e18: 1, pricePerToken1e18: 1 }).lean(),
    PriceSample.find({ chainId, aicToken: token, at: { $gte: start } }).select({ price1e18: 1, at: 1 }).sort({ at: 1 }).lean(),
    PriceSample.findOne({ chainId, aicToken: token, at: { $lt: start } }).sort({ at: -1 }).select({ price1e18: 1 }).lean(),
  ]);
  const obs: { at: number; price: bigint }[] = [
    ...(samples as Doc[]).map((s) => ({ at: Number(s.at), price: B(s.price1e18) })),
    ...(trades as Doc[]).filter((t) => !t.buyback && (t.spotPriceAfter1e18 || t.pricePerToken1e18)).map((t) => ({ at: Number(t.at), price: B(t.spotPriceAfter1e18 || t.pricePerToken1e18) })),
  ].sort((a, b) => a.at - b.at);
  let lastPrice: bigint | null = before ? B((before as Doc).price1e18) : null;
  const out = [];
  for (let i = 0; i < points; i++) {
    const from = start + i * intervalSec;
    const to = from + intervalSec;
    let observed = false;
    for (const o of obs) if (o.at >= from && o.at < to) { lastPrice = o.price; observed = true; }
    const inBucket = (at: number) => at >= from && at < to;
    const commerce = (purchases as Doc[]).filter((p) => inBucket(Number(p.at))).reduce((n, p) => n + B(p.grossUSDC), 0n);
    const bucketTrades = (trades as Doc[]).filter((t) => inBucket(Number(t.at)));
    const buyback = bucketTrades.filter((t) => t.buyback).reduce((n, t) => n + B(t.grossUSDC), 0n);
    const burned = bucketTrades.filter((t) => t.buyback).reduce((n, t) => n + B(t.tokensAIC), 0n);
    const volume = bucketTrades.filter((t) => !t.buyback).reduce((n, t) => n + B(t.grossUSDC), 0n);
    out.push({
      timestamp: new Date(to * 1000).toISOString(),
      priceUSDC: lastPrice !== null ? priceDecimal(lastPrice) : null,
      priceObservedInInterval: observed,
      commerceUSDC: usdc(commerce),
      buybackUSDC: usdc(buyback),
      burnedAIC: aic(burned),
      volumeUSDC: usdc(volume),
      trades: bucketTrades.filter((t) => !t.buyback).length,
    });
  }
  const k = marketFacts(m);
  return {
    points: out,
    now: { timestamp: new Date(now * 1000).toISOString(), priceUSDC: priceDecimal(k.price), marketCapUSDC: usdc(k.marketCap), liquidityUSDC: usdc(k.liquidity), circulatingSupply: aic(k.circulating) },
    notes:
      "Each point covers the interval ending at its timestamp. priceUSDC is the last observed price at the end of the " +
      "interval (it only changes when trades happen); priceObservedInInterval says whether a trade or price sample fell " +
      "inside it. Historical supply and liquidity are not indexed per point, so market cap and liquidity are given only " +
      "for now, never reconstructed.",
  };
}

/** Stock-related market events in a window, for GET /api/v1/updates. Facts only. */
export async function stockEvents(chainId: number, sinceSec: number, limit = 40) {
  const [purchases, trades, products, transitions] = await Promise.all([
    Purchase.find({ chainId, at: { $gte: sinceSec } }).select({ storeId: 1, productId: 1, grossUSDC: 1, holderReserveUSDC: 1, txHash: 1, at: 1 }).sort({ at: -1 }).limit(limit).lean(),
    StockTrade.find({ chainId, at: { $gte: sinceSec } }).select({ aicToken: 1, storeId: 1, side: 1, grossUSDC: 1, tokensAIC: 1, buyback: 1, venue: 1, txHash: 1, at: 1 }).sort({ at: -1 }).limit(limit).lean(),
    Product.find({ chainId, createdAt: { $gte: sinceSec } }).select({ productId: 1, storeId: 1, priceUSDC: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(limit).lean(),
    ChainEvent.find({ chainId, eventName: "LiquidityTransition", blockTimestamp: { $gte: sinceSec } }).select({ args: 1, blockTimestamp: 1, storeId: 1 }).lean(),
  ]);
  const storeIds = [...new Set([...(purchases as Doc[]).map((p) => String(p.storeId)), ...(products as Doc[]).map((p) => String(p.storeId))])];
  const markets = await StockMarket.find({ chainId, storeId: { $in: storeIds } }).select({ storeId: 1, aicToken: 1 }).lean();
  const tokenOf = new Map((markets as Doc[]).map((x) => [String(x.storeId), String(x.aicToken)]));
  const commerceByTx = new Map((purchases as Doc[]).map((p) => [String(p.txHash), p]));
  const firstSales = await Purchase.aggregate([
    { $match: { chainId, productId: { $in: (purchases as Doc[]).map((p) => String(p.productId)) } } },
    { $group: { _id: "$productId", first: { $min: "$at" } } },
  ]);
  const firstSaleAt = new Map(firstSales.map((x: Doc) => [String(x._id), Number(x.first)]));

  // For LARGE_COMMERCE_EVENT: each store's commerce in the 24h before each sale.
  const prior = (await Purchase.find({ chainId, storeId: { $in: storeIds }, at: { $gte: sinceSec - DAY } }).select({ storeId: 1, grossUSDC: 1, at: 1 }).lean()) as Doc[];

  const events: Record<string, unknown>[] = [];
  for (const p of purchases as Doc[]) {
    const e = { storeId: p.storeId, aicToken: tokenOf.get(String(p.storeId)) ?? null, productId: p.productId, commerceUSDC: usdc(B(p.grossUSDC)), timestamp: iso(Number(p.at)) };
    events.push({ event: "STORE_SALE", ...e });
    const before = prior.filter((x) => String(x.storeId) === String(p.storeId) && Number(x.at) < Number(p.at) && Number(x.at) >= Number(p.at) - DAY)
      .reduce((n, x) => n + B(x.grossUSDC), 0n);
    if (B(p.grossUSDC) > before) events.push({ event: "LARGE_COMMERCE_EVENT", ...e, previous24hCommerceUSDC: usdc(before), definition: "a single sale larger than the store's entire commerce in the 24 hours before it" });
    if (firstSaleAt.get(String(p.productId)) === Number(p.at)) events.push({ event: "PRODUCT_SOLD", ...e, firstSale: true });
  }
  for (const t of trades as Doc[]) {
    if (t.buyback) {
      const sale = commerceByTx.get(String(t.txHash));
      events.push({
        event: "BUYBACK_EXECUTED", aicToken: t.aicToken, storeId: t.storeId,
        commerceUSDC: sale ? usdc(B(sale.grossUSDC)) : null, buybackUSDC: usdc(B(t.grossUSDC)), aicBurned: aic(B(t.tokensAIC)),
        venue: t.venue, timestamp: iso(Number(t.at)),
      });
    } else {
      events.push({ event: "AIC_TRADE", aicToken: t.aicToken, storeId: t.storeId, side: t.side, usdc: usdc(B(t.grossUSDC)), aic: aic(B(t.tokensAIC)), venue: t.venue, timestamp: iso(Number(t.at)) });
    }
  }
  for (const p of products as Doc[]) events.push({ event: "NEW_PRODUCT", storeId: p.storeId, aicToken: tokenOf.get(String(p.storeId)) ?? null, productId: p.productId, priceUSDC: usdc(B(p.priceUSDC)), timestamp: iso(Number(p.createdAt)) });
  for (const x of transitions as Doc[]) {
    events.push({ event: "LIQUIDITY_CHANGED", kind: "graduated_to_dex_pool", storeId: x.storeId, aicToken: String(x.args?.aicToken ?? "").toLowerCase(), pair: String(x.args?.pair ?? "").toLowerCase(), usdcToLP: usdc(B(x.args?.usdcToLP)), timestamp: iso(Number(x.blockTimestamp)) });
  }
  return events.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, limit);
}

/** The markets and their stores, for a list or one token. */
export async function loadMarkets(chainId: number, filter: Record<string, unknown> = {}) {
  const markets = (await StockMarket.find({ chainId, ...filter }).lean()) as Doc[];
  const stores = (await Store.find({ chainId, storeId: { $in: markets.map((m) => m.storeId) } })
    .select({ storeId: 1, storeController: 1, createdAt: 1, "sellerContent.name": 1, lifetimeGrossCommerceUSDC: 1 }).lean()) as Doc[];
  const storeOf = new Map(stores.map((s) => [String(s.storeId), s]));
  for (const m of markets) m.createdAt = storeOf.get(String(m.storeId))?.createdAt ?? 0;
  return { markets, storeOf };
}
