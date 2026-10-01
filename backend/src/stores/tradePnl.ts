/**
 * Profit and loss per trade, from the trader's own history in the same token.
 *
 * The protocol sees every trade on both venues, so a wallet's cost in a token is reconstructible from
 * the indexed fills — as long as the tokens it sells were bought here. Method: FIFO lots. Each buy is a
 * lot (the tokens it received and the gross USDC it paid, fees included); each sell consumes the oldest
 * open lots first and realizes `USDC received − the cost of the tokens it consumed`.
 *
 *  - A SELL shows REALIZED pnl.
 *  - A BUY shows UNREALIZED pnl on the part of its lot that is still OPEN: what those tokens would
 *    actually return if the trader sold its whole open position now — the curve's (or the pool's) own
 *    arithmetic, after fees, with the price impact of the sale — allocated across its open lots, minus
 *    their share of what was paid. Not tokens × the last traded price: on a bonding curve, after a large
 *    buy the marginal price sits far above the average paid, and that product showed a store owner's
 *    100 USDC seed as +38% when selling it would have returned less than it cost. A lot fully consumed
 *    by later sells is CLOSED: its result is in those sells, and it is not counted a second time.
 *  - AIC received from a store's customer incentive pool is a lot that cost nothing, so selling it
 *    realizes its full proceeds instead of "cost unknown".
 *  - A BUYBACK (the store's commerce buying its own AIC to burn) has no pnl: the tokens no longer exist.
 *
 * When a wallet sells more than it ever bought here (tokens received by transfer, or history that
 * predates the index), the cost of that sale is unknown and the row says so instead of inventing one.
 */
import { Purchase, StockMarket, StockTrade } from "../db/models";
import { dexPoolOf, dexSellOut, isGraduated, maxTokensSellableNow, quoteSell } from "./quotes";
import { amountAIC, amountUSDC } from "../config/units";

export interface PnlTrade {
  txHash: string;
  logIndex: number;
  trader: string;
  side: string;
  grossUSDC: string;
  netUSDC: string;
  tokensAIC: string;
  buyback?: boolean;
  /** Curve spot price right after the trade (USDC base per AIC base, scaled 1e30); rebuilds a buy's curve segment. */
  spotPriceAfter1e18?: string;
  venue?: string;
}

/** AIC paid to a buyer from the store's incentive pool: a lot with no cost. Ordered with the trades. */
export interface RewardReceipt {
  txHash: string;
  logIndex: number;
  trader: string;
  tokensAIC: string;
  blockNumber: number;
}

export interface TradePnl {
  kind: "realized" | "unrealized_if_sold_now";
  pnlUSDC: ReturnType<typeof amountUSDC>;
  /** Percent of the cost, two decimals; null when the cost is zero. */
  pnlPercent: string | null;
  costBasisUSDC: ReturnType<typeof amountUSDC>;
  valueUSDC: ReturnType<typeof amountUSDC>;
  /** Buys only: the part of this lot still held, and its share of the cost — for revaluing at a newer price. */
  openAIC?: ReturnType<typeof amountAIC>;
  openCostUSDC?: ReturnType<typeof amountUSDC>;
  /** Buys only: some of this lot was sold; that part's result is in the sells. */
  partlySold?: boolean;
  /**
   * Buys only: the same open tokens at the market's CURRENT price (spot) — what a trading screen shows.
   * It is not what they can be sold for: selling walks the price down the curve. pnlUSDC above is that.
   */
  atCurrentPrice?: {
    pricePerAIC: string;
    valueUSDC: ReturnType<typeof amountUSDC>;
    pnlUSDC: ReturnType<typeof amountUSDC>;
    pnlPercent: string | null;
  };
}

export type TradePnlResult =
  | TradePnl
  | {
      kind: "closed";
      /** What this buy's tokens were sold for, minus what the buy cost: the lot's realized result. */
      pnlUSDC: ReturnType<typeof amountUSDC>;
      pnlPercent: string | null;
      costBasisUSDC: ReturnType<typeof amountUSDC>;
      valueUSDC: ReturnType<typeof amountUSDC>;
      note: string;
    }
  | { kind: "buyback"; note: string }
  | { kind: "unavailable"; reason: string };

const key = (t: { txHash: string; logIndex: number }) => `${t.txHash}:${t.logIndex}`;

function percent(pnl: bigint, cost: bigint): string | null {
  if (cost <= 0n) return null;
  return (Number((pnl * 1_000_000n) / cost) / 10_000).toFixed(2);
}

interface Lot {
  key: string;
  tokens: bigint;
  cost: bigint;
  openTokens: bigint;
  openCost: bigint;
  /** USDC received for this lot's tokens by the sells that consumed them. */
  proceeds: bigint;
  /**
   * The constant-product segment a curve buy moved along: K = x*y and the virtual token reserve before it.
   * With it, the first x tokens of the lot cost costOfFirst(x): cheap at the bottom, dear at the top.
   */
  segment?: { K: bigint; X0: bigint; netAll: bigint };
}

/*
 * What the first x tokens of a lot cost, fees included.
 *
 * A buy on a bonding curve does not pay one price: its first tokens are cheap and its last are dear.
 * Charging every token the lot's average made a partial sell look like a large gain and the rest like a
 * large loss — the same 500 USDC buy, half sold straight back, showed +40% and −52% where both halves had
 * lost only their fees. Selling back takes the top of the curve first (the most recently, most expensively
 * bought tokens), so a lot is consumed from the top and what remains open is its cheapest part.
 */
function costOfFirst(lot: Lot, x: bigint): bigint {
  if (x <= 0n) return 0n;
  if (x >= lot.tokens) return lot.cost;
  const seg = lot.segment;
  if (!seg || seg.netAll <= 0n) return (lot.cost * x) / lot.tokens;
  const net = seg.K / (seg.X0 - x) - seg.K / seg.X0;
  return (lot.cost * net) / seg.netAll;
}

/** The segment behind a curve buy, from its net USDC, its tokens and the spot price right after it. */
function segmentOf(t: PnlTrade, tokens: bigint): Lot["segment"] {
  if ((t.venue ?? "curve") !== "curve") return undefined;
  const spot = BigInt(String(t.spotPriceAfter1e18 ?? "") || "0");
  const net = BigInt(t.netUSDC || "0");
  if (spot <= 0n || net <= 0n || tokens <= 0n) return undefined;
  const SCALE = 10n ** 30n;
  // After the buy: price = Ua/Xa and Ua*Xa = (Ua-net)*(Xa+tokens)  =>  Xa = net*tokens / (price*tokens - net).
  const denom = spot * tokens - net * SCALE;
  if (denom <= 0n) return undefined;
  const Xa = (net * tokens * SCALE) / denom;
  const Ua = (spot * Xa) / SCALE;
  const X0 = Xa + tokens;
  const K = Ua * Xa;
  const netAll = K / Xa - K / X0;
  return netAll > 0n ? { K, X0, netAll } : undefined;
}

/**
 * Replays each trader's full history (ascending chain order) and returns a result for every trade in it.
 * `positionValueNow` is what selling a trader's whole open position would return now (after fees and price
 * impact); it is allocated across that trader's open lots by tokens. Rows with side "reward" are incentive
 * receipts: zero-cost lots that produce no row of their own.
 */
export function replayPnl(
  historyAscending: PnlTrade[],
  positionValueNow: (tokens: bigint) => bigint,
  /** The market's current spot price (USDC base per AIC base, scaled 1e30), for the at-current-price figure. */
  spotPrice1e30: bigint = 0n
): Map<string, TradePnlResult> {
  const out = new Map<string, TradePnlResult>();
  const lotsByTrader = new Map<string, Lot[]>();
  const allLots: Lot[] = [];

  for (const t of historyAscending) {
    if (t.buyback) {
      out.set(key(t), { kind: "buyback", note: "The store's commerce bought this AIC and burned it; nobody holds it." });
      continue;
    }
    const lots = lotsByTrader.get(t.trader) ?? [];
    lotsByTrader.set(t.trader, lots);
    const tokens = BigInt(t.tokensAIC || "0");

    if (t.side === "reward") {
      // Paid out of the incentive pool: the tokens are held, and they cost nothing.
      lots.push({ key: key(t), tokens, cost: 0n, openTokens: tokens, openCost: 0n, proceeds: 0n });
      continue;
    }

    if (t.side === "buy") {
      const paid = BigInt(t.grossUSDC || "0");
      const lot: Lot = { key: key(t), tokens, cost: paid, openTokens: tokens, openCost: paid, proceeds: 0n, segment: segmentOf(t, tokens) };
      lots.push(lot);
      allLots.push(lot);
      continue;
    }

    // A sell consumes the oldest open lots first.
    const received = BigInt(t.netUSDC || "0");
    let need = tokens;
    let costOfSold = 0n;
    const consumed: { lot: Lot; take: bigint }[] = [];
    for (const lot of lots) {
      if (need === 0n) break;
      if (lot.openTokens === 0n) continue;
      const take = lot.openTokens < need ? lot.openTokens : need;
      // From the top of what is still open: the dearest remaining tokens of this lot.
      const remainingCost = costOfFirst(lot, lot.openTokens - take);
      const part = lot.openCost - remainingCost;
      lot.openTokens -= take;
      lot.openCost = remainingCost;
      costOfSold += part;
      need -= take;
      consumed.push({ lot, take });
    }
    // This sale's proceeds, attributed to the lots it consumed in proportion to the tokens taken from each.
    if (need === 0n && tokens > 0n) {
      let left = received;
      consumed.forEach((c, i) => {
        const share = i === consumed.length - 1 ? left : (received * c.take) / tokens;
        c.lot.proceeds += share;
        left -= share;
      });
    }
    if (need > 0n) {
      out.set(key(t), {
        kind: "unavailable",
        reason:
          "COST_BASIS_UNKNOWN: this wallet sold more of the token than it bought on either venue here " +
          "(tokens received by transfer, or bought before the index), so its cost cannot be known.",
      });
      continue;
    }
    out.set(key(t), {
      kind: "realized",
      pnlUSDC: amountUSDC(received - costOfSold),
      pnlPercent: percent(received - costOfSold, costOfSold),
      costBasisUSDC: amountUSDC(costOfSold),
      valueUSDC: amountUSDC(received),
    });
  }

  /*
   * Buy rows are judged on what is still open now, after every later sell: the trader's whole open
   * position is valued as one sale (its price impact is the position's, not each lot's), then shared out.
   */
  const valueOf = new Map<Lot, bigint>();
  for (const lots of lotsByTrader.values()) {
    const open = lots.filter((l) => l.openTokens > 0n);
    const total = open.reduce((acc, l) => acc + l.openTokens, 0n);
    if (total === 0n) continue;
    const exit = positionValueNow(total);
    let left = exit;
    open.forEach((l, i) => {
      const share = i === open.length - 1 ? left : (exit * l.openTokens) / total;
      valueOf.set(l, share);
      left -= share;
    });
  }
  for (const lot of allLots) {
    if (lot.openTokens === 0n) {
      out.set(lot.key, {
        kind: "closed",
        pnlUSDC: amountUSDC(lot.proceeds - lot.cost),
        pnlPercent: percent(lot.proceeds - lot.cost, lot.cost),
        costBasisUSDC: amountUSDC(lot.cost),
        valueUSDC: amountUSDC(lot.proceeds),
        note: "Every token of this buy was sold later: this is what they sold for, minus what the buy cost.",
      });
      continue;
    }
    const value = valueOf.get(lot) ?? 0n;
    out.set(lot.key, {
      kind: "unrealized_if_sold_now",
      pnlUSDC: amountUSDC(value - lot.openCost),
      pnlPercent: percent(value - lot.openCost, lot.openCost),
      costBasisUSDC: amountUSDC(lot.openCost),
      valueUSDC: amountUSDC(value),
      openAIC: amountAIC(lot.openTokens),
      openCostUSDC: amountUSDC(lot.openCost),
      ...(lot.openTokens < lot.tokens ? { partlySold: true } : {}),
      ...(spotPrice1e30 > 0n
        ? (() => {
            const atSpot = (lot.openTokens * spotPrice1e30) / 10n ** 30n;
            return {
              atCurrentPrice: {
                pricePerAIC: (Number(spotPrice1e30) / 1e18).toPrecision(6),
                valueUSDC: amountUSDC(atSpot),
                pnlUSDC: amountUSDC(atSpot - lot.openCost),
                pnlPercent: percent(atSpot - lot.openCost, lot.openCost),
              },
            };
          })()
        : {}),
    });
  }
  return out;
}

/**
 * Marks tokens at the market's last traded price (USDC per whole token, scaled 1e30 over base units, as
 * the indexer stores it). A buy's price is its gross USDC per token, fees included — so a buy marked at
 * its own price is worth exactly what it cost.
 */
export function lastPriceMarker(lastPricePerToken1e30: bigint): (tokens: bigint) => bigint {
  return (tokens) => (tokens * lastPricePerToken1e30) / 10n ** 30n;
}

/** PnL for the given rows of one token, each computed from its trader's whole history in that token. */
export async function pnlForTrades(
  chainId: number,
  aicToken: string,
  rows: { txHash: string; logIndex: number; trader: string }[],
  fees: { protocolBps: number; controllerBps: number } = { protocolBps: 0, controllerBps: 0 }
): Promise<{ pnl: Map<string, TradePnlResult>; markPrice1e30: bigint }> {
  /*
   * The mark is the market's CURRENT price — the spot the indexer holds after every trade, buybacks
   * included — not the average price of the last trade, which is a past fill and not a price at all.
   */
  const market = (await StockMarket.findOne({ chainId, aicToken }).lean()) as Record<string, unknown> | null;
  let markPrice1e30 = BigInt(String(market?.currentIndexedPrice1e18 ?? "0") || "0");
  if (markPrice1e30 === 0n) {
    const last = await StockTrade.findOne({ chainId, aicToken, buyback: { $ne: true } })
      .sort({ blockNumber: -1, logIndex: -1 })
      .select({ pricePerToken1e18: 1 })
      .lean();
    markPrice1e30 = BigInt(String((last as { pricePerToken1e18?: string } | null)?.pricePerToken1e18 ?? "0") || "0");
  }
  const traders = [...new Set(rows.map((r) => r.trader))];
  if (traders.length === 0) return { pnl: new Map(), markPrice1e30 };

  const trades = (await StockTrade.find({ chainId, aicToken, trader: { $in: traders } })
    .sort({ blockNumber: 1, logIndex: 1 })
    .select({ txHash: 1, logIndex: 1, trader: 1, side: 1, grossUSDC: 1, netUSDC: 1, tokensAIC: 1, buyback: 1, blockNumber: 1, spotPriceAfter1e18: 1, venue: 1 })
    .lean()) as unknown as (PnlTrade & { blockNumber: number })[];

  // AIC these traders received from this store's incentive pool: zero-cost lots, in chain order with the trades.
  const rewards = market?.storeId
    ? ((await Purchase.find({ chainId, storeId: String(market.storeId), buyer: { $in: traders }, rewardAIC: { $nin: ["0", ""] } })
        .select({ txHash: 1, logIndex: 1, buyer: 1, rewardAIC: 1, blockNumber: 1 })
        .lean()) as unknown as { txHash: string; logIndex: number; buyer: string; rewardAIC: string; blockNumber: number }[])
    : [];
  const history = [
    ...trades,
    ...rewards.map((r) => ({
      txHash: `reward:${r.txHash}`,
      logIndex: r.logIndex,
      trader: r.buyer,
      side: "reward",
      grossUSDC: "0",
      netUSDC: "0",
      tokensAIC: r.rewardAIC,
      blockNumber: r.blockNumber,
    })),
  ].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  return { pnl: replayPnl(history, positionExitValue(market, fees, markPrice1e30), markPrice1e30), markPrice1e30 };
}

/**
 * What selling `tokens` would return now: on the curve, its sell formula after both fees and capped by the
 * real USDC it can pay; after graduation, the pool's constant-product output. Falls back to the last price
 * only when the market's state is not indexed.
 */
export function positionExitValue(
  market: Record<string, unknown> | null,
  fees: { protocolBps: number; controllerBps: number },
  markPrice1e30: bigint
): (tokens: bigint) => bigint {
  if (!market) return lastPriceMarker(markPrice1e30);
  if (isGraduated(market)) {
    const pool = dexPoolOf(market);
    return pool ? (tokens) => dexSellOut(pool, tokens) : lastPriceMarker(markPrice1e30);
  }
  const state = {
    virtualTokenReserve: BigInt(String(market.virtualTokenReserve ?? "0")),
    virtualUSDCReserve: BigInt(String(market.virtualUSDCReserve ?? "0")),
    tokenInventory: BigInt(String(market.marketInventoryAIC ?? "0")),
    realUSDCReserve: BigInt(String(market.realUSDCReserve ?? "0")),
    netSoldFromCurve: BigInt(String(market.netSoldFromCurveAIC ?? "0")),
  };
  if (state.virtualTokenReserve === 0n || state.virtualUSDCReserve === 0n) return lastPriceMarker(markPrice1e30);
  return (tokens) => {
    // Only what the curve can actually pay: beyond that, a sale is refused, so it is worth nothing now.
    const sellable = tokens < maxTokensSellableNow(state) ? tokens : maxTokensSellableNow(state);
    return quoteSell(state, sellable, fees.protocolBps, fees.controllerBps).netUSDCOut;
  };
}

export const PNL_METHOD =
  "Per trader, per token, FIFO lots, from every fill of that wallet in this token on both venues. A buy's cost is " +
  "the gross USDC it paid — fees are part of the entry price, not a loss on the trade. A SELL consumes the oldest " +
  "open buys first and realizes USDC received minus their cost. On the curve a buy's first tokens are cheap and its last " +
  "are dear, so each part of a curve buy carries its own curve cost, and a sell takes the dearest remaining part first " +
  "(selling back walks down the curve the buy walked up) — a straight round trip shows its fees, not a gain and a loss. A BUY shows unrealized pnl only on the part still " +
  "held, valued at what selling the trader's whole open position would return NOW (unrealized_if_sold_now): the curve's " +
  "own sell arithmetic after both fees and the real USDC it can pay, or the pool's output after graduation — not tokens " +
  "times a price, which on a curve overstates a large position. The same open tokens at the market's CURRENT price " +
  "(markPricePerAIC, the spot now) are also given, as atCurrentPrice — what a trading screen shows, not what they can be " +
  "sold for. Once later sells consumed a buy it is `closed`, " +
  "showing what its tokens sold for minus what it cost. AIC received from the store's incentive pool is a lot that cost " +
  "nothing. A buyback row has no pnl: its AIC was burned. Tokens that arrived by other transfers have no known cost, so a " +
  "sell of them says unavailable rather than guessing. Gas is not included.";
