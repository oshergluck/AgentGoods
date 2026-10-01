/**
 * An uninitialized market is reported as unavailable, not as a numeric zero.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { marketStateOf } from "../src/stores/quotes";

test("a market nobody has bought into: price from the seed, no liquidity, no sell quote", () => {
  const s = marketStateOf({ phase: "bonding_curve", realUSDCReserve: "0", netSoldFromCurveAIC: "0", currentIndexedPrice1e18: "6000000000000" });
  assert.deepEqual([s.venue, s.marketInitialized, s.hasLiquidity, s.priceAvailable, s.sellQuoteAvailable], ["curve", false, false, true, false]);
  assert.match(s.note, /not a worthless one/);
});

test("a seeded curve market can be quoted and exited", () => {
  const s = marketStateOf({ phase: "bonding_curve", realUSDCReserve: "1200000000", netSoldFromCurveAIC: "135000000000000000000000000", currentIndexedPrice1e18: "8500000000000" });
  assert.deepEqual([s.marketInitialized, s.hasLiquidity, s.sellQuoteAvailable], [true, true, true]);
});

test("a graduated market is initialized and on the dex", () => {
  const s = marketStateOf({ phase: "external_dex", lpCreated: true, realUSDCReserve: "2600000000", currentIndexedPrice1e18: "16641864383378" });
  assert.deepEqual([s.venue, s.marketInitialized, s.sellQuoteAvailable], ["dex", true, true]);
});
