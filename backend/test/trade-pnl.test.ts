/** Per-trade PnL: FIFO lots from the trader's own fills; realized on sells, unrealized only on what is still held. */
import test from "node:test";
import assert from "node:assert/strict";
import { lastPriceMarker, positionExitValue, replayPnl, type PnlTrade } from "../src/stores/tradePnl";
import { quoteBuy, quoteSell } from "../src/stores/quotes";

const t = (i: number, trader: string, side: "buy" | "sell", usdc: bigint, tokens: bigint, buyback = false): PnlTrade => ({
  txHash: `0x${i}`,
  logIndex: 0,
  trader,
  side,
  grossUSDC: usdc.toString(),
  netUSDC: usdc.toString(),
  tokensAIC: tokens.toString(),
  buyback,
});
const get = (r: Map<string, any>, i: number) => r.get(`0x${i}:0`);

test("FIFO: a sell consumes the oldest buy first; a fully sold buy is closed, not counted again", () => {
  const history = [
    t(1, "a", "buy", 100n, 1000n), // 0.10 per token
    t(2, "a", "buy", 300n, 1000n), // 0.30 per token
    t(3, "a", "sell", 150n, 1000n), // consumes lot 1 entirely: cost 100, realized +50
    t(4, "a", "sell", 90n, 500n), // half of lot 2: cost 150, realized -60
  ];
  const r = replayPnl(history, (tokens) => tokens / 5n); // marked at 0.20 per token
  assert.equal(get(r, 3).kind, "realized");
  assert.equal(get(r, 3).pnlUSDC.base, "50");
  assert.equal(get(r, 4).pnlUSDC.base, "-60");
  assert.equal(get(r, 1).kind, "closed", "every token of the first buy was sold");
  assert.equal(get(r, 1).pnlUSDC.base, "50", "it cost 100 and its tokens sold for 150");
  assert.equal(get(r, 1).valueUSDC.base, "150");
  const b2 = get(r, 2);
  assert.equal(b2.kind, "unrealized_if_sold_now");
  assert.equal(b2.openAIC.base, "500");
  assert.equal(b2.openCostUSDC.base, "150");
  assert.equal(b2.pnlUSDC.base, "-50", "500 open tokens worth 100 against 150 of cost");
  assert.equal(b2.partlySold, true);
});

test("traders are kept apart; selling tokens never bought here is unavailable; buybacks carry no pnl", () => {
  const history = [
    t(1, "a", "buy", 100n, 1000n),
    t(2, "b", "sell", 50n, 10n),
    t(3, "store", "buy", 7n, 70n, true),
    t(4, "a", "sell", 200n, 2000n),
    t(5, "a", "buy", 10n, 100n),
    t(6, "a", "sell", 20n, 100n),
  ];
  const r = replayPnl(history, () => 0n);
  assert.equal(get(r, 2).kind, "unavailable");
  assert.equal(get(r, 3).kind, "buyback");
  assert.equal(get(r, 4).kind, "unavailable", "sold more than it bought");
  assert.equal(get(r, 6).kind, "realized");
  assert.equal(get(r, 6).pnlUSDC.base, "10");
});

test("a buy marked at its own price shows 0: its fees are in the entry price, not a loss", () => {
  const tokens = 1000n * 10n ** 18n;
  const price = (100_000_000n * 10n ** 30n) / tokens;
  const r = replayPnl([t(1, "a", "buy", 100_000_000n, tokens)], lastPriceMarker(price));
  assert.equal(get(r, 1).pnlUSDC.base, "0");
});

test("an open position is valued as one sale of all of it, shared across its lots", () => {
  // Two buys by the same trader; selling all 2000 tokens returns 150, not 2 x the per-lot values.
  const history = [t(1, "a", "buy", 100n, 1000n), t(2, "a", "buy", 100n, 1000n)];
  const r = replayPnl(history, (tokens) => (tokens === 2000n ? 150n : 999n));
  assert.equal(get(r, 1).valueUSDC.base, "75");
  assert.equal(get(r, 2).valueUSDC.base, "75");
  assert.equal(get(r, 1).pnlUSDC.base, "-25");
});

test("AIC received from the incentive pool is a zero-cost lot: selling it realizes its proceeds", () => {
  const history = [
    { ...t(1, "b", "buy", 0n, 500n), side: "reward" },
    t(2, "b", "sell", 40n, 500n),
  ] as PnlTrade[];
  const r = replayPnl(history, () => 0n);
  assert.equal(get(r, 2).kind, "realized");
  assert.equal(get(r, 2).pnlUSDC.base, "40");
  assert.equal(get(r, 1), undefined, "a reward receipt is not a trade row");
});

test("on a bonding curve, a large position is worth what selling it returns, far below tokens x last price", () => {
  const e18 = 10n ** 18n;
  // A 250 USDC virtual reserve, where the owner's 100 USDC seed bought ~279.5M AIC.
  const market = {
    virtualUSDCReserve: "347000000", // 250 virtual + 97 net in
    virtualTokenReserve: (720_461_095n * e18).toString(),
    marketInventoryAIC: (720_461_095n * e18).toString(),
    realUSDCReserve: "97000000",
    netSoldFromCurveAIC: (279_538_905n * e18).toString(),
  };
  const tokens = 279_538_905n * e18;
  const lastPrice1e30 = 495_901n * 10n ** 18n; // 4.95901e-7 USDC per AIC, the last trade
  const exit = positionExitValue(market, { protocolBps: 200, controllerBps: 100 }, lastPrice1e30)(tokens);
  const atLastPrice = lastPriceMarker(lastPrice1e30)(tokens);
  assert.ok(atLastPrice > 138_000_000n, "the old mark: about 138.6 USDC");
  assert.ok(exit < 100_000_000n, `selling it returns less than the 100 paid (got ${exit})`);
  assert.ok(exit > 90_000_000n, "about 97 minus the sell fees");
});

test("an open buy also carries its value at the current price, apart from what selling it returns", () => {
  const e18 = 10n ** 18n;
  // 1000 AIC bought for 100 USDC (0.10 each); spot now 0.19; selling all of it would return 94.
  // Spot in the indexer's scale: USDC base units per AIC base unit x 1e30 — 0.19 USDC per AIC is 190000e12.
  const r = replayPnl([t(1, "a", "buy", 100_000_000n, 1000n * e18)], () => 94_000_000n, 190_000n * 10n ** 12n);
  assert.equal(get(r, 1).atCurrentPrice.pricePerAIC, "0.190000");
  const b = get(r, 1);
  assert.equal(b.pnlUSDC.display, "-6", "if sold now");
  assert.equal(b.atCurrentPrice.valueUSDC.display, "190", "1000 x 0.19");
  assert.equal(b.atCurrentPrice.pnlUSDC.display, "90");
  assert.equal(b.atCurrentPrice.pnlPercent, "90.00");
});

test("a partial sell of one big curve buy loses only fees, and so does what is still held", () => {
  const e18 = 10n ** 18n;
  const fees = { protocolBps: 200, controllerBps: 100 };
  // A fresh 250 USDC curve over 1e9 AIC; buy 500 USDC, sell half straight back.
  let state = { virtualTokenReserve: 1_000_000_000n * e18, virtualUSDCReserve: 250_000_000n, tokenInventory: 1_000_000_000n * e18, realUSDCReserve: 0n, netSoldFromCurve: 0n };
  const buy = quoteBuy(state, 500_000_000n, fees.protocolBps, fees.controllerBps, 1_000_000_000n * e18, 950_000_000n * e18);
  state = {
    virtualTokenReserve: state.virtualTokenReserve - buy.tokensOut,
    virtualUSDCReserve: state.virtualUSDCReserve + buy.netCurveUSDC,
    tokenInventory: state.tokenInventory - buy.tokensOut,
    realUSDCReserve: buy.netCurveUSDC,
    netSoldFromCurve: buy.tokensOut,
  };
  const spotAfterBuy = (state.virtualUSDCReserve * 10n ** 30n) / state.virtualTokenReserve;
  const half = buy.tokensOut / 2n;
  const sell = quoteSell(state, half, fees.protocolBps, fees.controllerBps);
  state = {
    ...state,
    virtualTokenReserve: state.virtualTokenReserve + half,
    virtualUSDCReserve: state.virtualUSDCReserve - sell.grossUSDC,
    tokenInventory: state.tokenInventory + half,
    realUSDCReserve: state.realUSDCReserve - sell.grossUSDC,
    netSoldFromCurve: state.netSoldFromCurve - half,
  };
  const history: PnlTrade[] = [
    { txHash: "0x1", logIndex: 0, trader: "a", side: "buy", grossUSDC: "500000000", netUSDC: buy.netCurveUSDC.toString(), tokensAIC: buy.tokensOut.toString(), spotPriceAfter1e18: spotAfterBuy.toString(), venue: "curve" },
    { txHash: "0x2", logIndex: 0, trader: "a", side: "sell", grossUSDC: sell.grossUSDC.toString(), netUSDC: sell.netUSDCOut.toString(), tokensAIC: half.toString(), venue: "curve" },
  ];
  const market = {
    virtualTokenReserve: state.virtualTokenReserve.toString(),
    virtualUSDCReserve: state.virtualUSDCReserve.toString(),
    marketInventoryAIC: state.tokenInventory.toString(),
    realUSDCReserve: state.realUSDCReserve.toString(),
    netSoldFromCurveAIC: state.netSoldFromCurve.toString(),
  };
  const r = replayPnl(history, positionExitValue(market, fees, 0n));
  const realized = Number(get(r, 2).pnlUSDC.display);
  const open = Number(get(r, 1).pnlUSDC.display);
  const soldFor = Number(get(r, 2).valueUSDC.display);
  const exitRest = Number(get(r, 1).valueUSDC.display);
  // Each leg of a straight round trip loses its fees (3% in, 3% out): about 6% of what it moved.
  assert.ok(realized < 0 && realized > -0.07 * soldFor, `the sale lost only fees, not +40%: ${realized} on ${soldFor}`);
  assert.ok(open < 0 && open > -0.07 * Number(get(r, 1).costBasisUSDC.display), `the rest lost only fees, not -52%: ${open}`);
  // Together they are the true total: everything back minus the 500 paid.
  assert.ok(Math.abs(realized + open - (soldFor + exitRest - 500)) < 0.01, "the halves add up to the whole");
});
