/**
 * Price sampling.
 *
 * The chart was built from trades alone, so a market that traded hours ago rendered a series that
 * stopped hours ago. Correct, and it reads as broken. These samples fill the gap.
 *
 * The tests are weighted toward the two things that would make it a liability rather than a
 * feature: writing far more rows than the chart needs, and misrepresenting a sample as trading
 * activity. A sample carries zero volume for a reason — no trade happened, and a chart that
 * implied one would be lying about liquidity.
 */

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { createHarness, startChain, deployProtocol, stopChain, USDC, type Harness } from "./helpers/harness";
import { PriceSample, StockMarket } from "../src/db/models";
import { PriceSampler } from "../src/indexer/priceSampler";
import { forbidRpc, allowRpc, rpcMetrics, resetRpcMetrics } from "../src/rpc/provider";

let h: Harness;

function sampler(overrides: Partial<ConstructorParameters<typeof PriceSampler>[0]> = {}) {
  return new PriceSampler({
    chainId: h.env.CHAIN_ID,
    intervalMs: 30_000,
    heartbeatSeconds: 300,
    retentionDays: 30,
    ...overrides,
  });
}

async function seedMarket(price: string, token = "0xaaaa000000000000000000000000000000000001") {
  await StockMarket.deleteMany({});
  await PriceSample.deleteMany({});
  await StockMarket.create({
    chainId: h.env.CHAIN_ID,
    aicToken: token,
    storeId: "0x" + "11".repeat(32),
    storeAddress: "0xbbbb000000000000000000000000000000000002",
    name: "Sample",
    symbol: "SMP",
    decimals: 18,
    genesisSupplyAIC: "1000",
    currentSupplyAIC: "1000",
    marketInventoryAIC: "1000",
    virtualUSDCReserve: "6000000000",
    virtualTokenReserve: "1000",
    currentIndexedPrice1e18: price,
    createdBlock: 1,
    createdLogIndex: 0,
    cursor: "1:0",
  });
  return token;
}

before(async () => {
  await startChain();
  await deployProtocol();
  h = await createHarness();
});

after(async () => {
  await h?.stop();
  await stopChain();
});

describe("Price sampler", { concurrency: 1 }, () => {
  test("records a first sample so a quiet market still has a series", async () => {
    const token = await seedMarket("12345");
    const written = await sampler().tick();
    assert.equal(written, 1);

    const rows = await PriceSample.find({ aicToken: token }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.price1e18, "12345");
    assert.ok(rows[0]!.expiresAt, "retention must be enforced by Mongo, not by a cleanup job");
  });

  test("does NOT write again when the price has not moved", async () => {
    /*
     * The whole point of change-plus-heartbeat. A naive 30-second tick writes 2,880 near-identical
     * rows per market per day; the chart is identical and the storage is not.
     */
    await seedMarket("12345");
    const s = sampler();
    assert.equal(await s.tick(), 1, "first pass writes");
    assert.equal(await s.tick(), 0, "unchanged price writes nothing");
    assert.equal(await s.tick(), 0);
    assert.equal(await PriceSample.countDocuments({}), 1);
  });

  test("writes as soon as the price actually moves", async () => {
    const token = await seedMarket("100");
    const s = sampler();
    await s.tick();

    await StockMarket.updateOne({ aicToken: token }, { $set: { currentIndexedPrice1e18: "200" } });
    assert.equal(await s.tick(), 1, "a real move must be captured");

    /*
     * Asserted on the LATEST sample rather than a row count. The series is keyed to the second, so
     * two observations inside one second legitimately collapse to one row — and the value that
     * must survive is the newer one.
     */
    const rows = await PriceSample.find({}).sort({ at: 1 }).lean();
    const latest = rows[rows.length - 1]!;
    assert.equal(latest.price1e18, "200", "the newer price must win its second");
    assert.equal(latest.reason, "change");
  });

  test("heartbeats a flat market so the series still reaches the present", async () => {
    await seedMarket("777");
    // heartbeatSeconds 0 makes every pass stale, which is the heartbeat path under test.
    const s = sampler({ heartbeatSeconds: 0 });
    await s.tick();
    const second = await s.tick();
    assert.equal(second, 1, "a quiet market must still extend its series");
    const rows = await PriceSample.find({}).sort({ at: 1 }).lean();
    assert.ok(rows.length >= 1);
    assert.equal(rows[rows.length - 1]!.reason, "heartbeat", "and mark it as a heartbeat, not a trade");
    assert.equal(rows[rows.length - 1]!.price1e18, "777");
  });

  test("never records a zero price as if it were real", async () => {
    // A market with no trades has no price. A zero sample would draw the line to the floor.
    await seedMarket("0");
    assert.equal(await sampler().tick(), 0);
    assert.equal(await PriceSample.countDocuments({}), 0);
  });

  test("performs NO RPC — it reads the projection, like everything else", async () => {
    await seedMarket("500");
    resetRpcMetrics();
    forbidRpc();
    try {
      await sampler().tick();
    } finally {
      allowRpc();
    }
    assert.equal(rpcMetrics().requestsTotal, 0, "sampling must never reach the chain");
  });

  test("two instances running at once cannot corrupt the series", async () => {
    /*
     * A rolling deploy runs two copies for a few seconds by design, so this is a normal condition
     * rather than an edge case. The unique index makes the duplicate a no-op instead of a crash.
     */
    await seedMarket("9999");
    const [a, b] = await Promise.all([sampler().tick(), sampler().tick()]);
    assert.ok(a + b >= 1, "at least one instance records the sample");
    const rows = await PriceSample.find({}).lean();
    assert.equal(rows.length, 1, "and exactly one row exists for that second");
  });
});

describe("Samples reach the chart, labelled honestly", { concurrency: 1 }, () => {
  test("the trades endpoint merges samples and marks their source", async () => {
    const token = await seedMarket("4242");
    await sampler().tick();

    const res = await h.request("GET", `/api/v1/market/tokens/${token}/trades`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as Record<string, any>;

    assert.ok(body.items.length >= 1, "the sample must reach the chart");
    const sample = body.items.find((i: any) => i.source === "sample");
    assert.ok(sample, "and be labelled as a sample");
    assert.equal(sample.pricePerToken1e18, "4242");

    // The honesty that matters: a sample is not trading activity.
    assert.equal(sample.grossUSDC, "0", "a sample must never imply volume");
    assert.equal(sample.txHash, null, "and must not pretend to be a transaction");
    assert.equal(body.counts.samples, 1);
    assert.equal(body.counts.trades, 0);
    assert.match(body.note, /never read a sample as trading activity/i);
  });

  test("the merged series is strictly ascending, which the chart library requires", async () => {
    const token = await seedMarket("100");
    const s = sampler({ heartbeatSeconds: 0 });
    await s.tick();
    await StockMarket.updateOne({ aicToken: token }, { $set: { currentIndexedPrice1e18: "150" } });
    await s.tick();

    const res = await h.request("GET", `/api/v1/market/tokens/${token}/trades`);
    const items = (res.body as Record<string, any>).items as { at: number }[];
    for (let i = 1; i < items.length; i++) {
      assert.ok(items[i]!.at >= items[i - 1]!.at, "times must not go backwards");
    }
    const seconds = new Set(items.map((i) => i.at));
    assert.equal(seconds.size, items.length, "and must be unique, or the chart refuses to render");
  });
});
