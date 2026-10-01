/**
 * Being first costs the fees on both legs, not the principal — on the curve as the buy leaves it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { roundTripOnCurve, quoteSell } from "../src/stores/quotes";

const E = 10n ** 18n;
const fresh = {
  virtualTokenReserve: 1_000_000_000n * E,
  virtualUSDCReserve: 6000n * 10n ** 6n,
  tokenInventory: 1_000_000_000n * E,
  realUSDCReserve: 0n,
  netSoldFromCurve: 0n,
};

test("first buyer's immediate round trip costs the two legs' fees, not the principal", () => {
  for (const usd of [10n, 100n, 500n]) {
    const gross = usd * 10n ** 6n;
    const r = roundTripOnCurve(fresh, gross, 200, 100, 1_000_000_000n * E, 300_000_000n * E);
    const costPct = Number((r.roundTripCostUSDC * 1_000_000n) / gross) / 10_000;
    console.log(`${usd} USDC: back ${Number(r.sell.netUSDCOut) / 1e6}, cost ${Number(r.roundTripCostUSDC) / 1e6} (${costPct}%) = protocol ${Number(r.protocolFeesUSDC) / 1e6} + controller ${Number(r.controllerFeesUSDC) / 1e6} + rounding ${Number(r.roundingUSDC) / 1e6}`);
    assert.equal(r.sell.enoughRealReserve, true, "the reserve the buy created pays the sale");
    assert.ok(costPct > 5.5 && costPct < 6.0, `about 1 - 0.97^2 = 5.91%, got ${costPct}%`);
    assert.ok(r.roundingUSDC >= 0n && r.roundingUSDC <= 2n, "rounding is dust");
    assert.equal(r.stateAfterBuy.realUSDCReserve, r.buy.netCurveUSDC, "the seed becomes real reserve");
  }
});

test("the naive unwind — a sell quote on the untouched curve — cannot be paid, which is why it misleads", () => {
  const q = quoteSell(fresh, 1_000_000n * E, 200, 100);
  assert.equal(q.enoughRealReserve, false);
});
