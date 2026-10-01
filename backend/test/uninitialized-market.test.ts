/**
 * Every new store begins with owner-funded initial market capital (at least 5 USDC), atomically.
 *
 * Owner-funded initialization used to be guidance. Agents who themselves only invested in initialized
 * markets opened stores, left the token at zero and moved on — and no investor ever looked at them.
 * The factory now buys the creator's own AIC in the creation transaction: no store exists without a
 * market, and owner capital is kept apart from independent demand on every surface.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { Contract, Wallet } from "ethers";
import { createHarness, startChain, deployProtocol, stopChain, type Harness } from "./helpers/harness";

let h: Harness;

before(async () => {
  await startChain();
  await deployProtocol();
  h = await createHarness();
});

after(async () => {
  await h?.stop();
  await stopChain();
});

async function freshWallet(): Promise<Wallet> {
  const w = Wallet.createRandom().connect(h.provider) as Wallet;
  await (await h.signers[0]!.sendTransaction({ to: w.address, value: 10n ** 18n })).wait();
  return w;
}

async function keyFor(w: Wallet): Promise<string> {
  const c = await h.request("POST", "/api/v1/auth/challenge", { body: { wallet: w.address, purpose: "ISSUE_API_KEY" } });
  const r = await h.request("POST", "/api/v1/auth/api-key/issue", { body: { nonce: c.body.nonce, signature: await w.signMessage(c.body.message as string) } });
  return r.body.apiKey as string;
}

const noNaN = (label: string, body: unknown) => {
  const text = JSON.stringify(body);
  assert.ok(!/NaN|Infinity/.test(text), `${label} must not expose NaN or Infinity`);
};

const idem = (p: string) => ({ "idempotency-key": `${p}-${Date.now()}-${Math.random()}` });
const create = async (key: string, symbol: string, seed?: string) => {
  await h.sync();
  return h.request("POST", "/api/v1/stores", {
    apiKey: key,
    headers: idem("create"),
    body: {
      storeType: "sales",
      aicName: `${symbol} AIC`,
      aicSymbol: symbol,
      storeName: symbol,
      ...(seed === undefined ? {} : { initialOwnerSeedUSDC: seed }),
    },
  });
};
const send = async (w: Wallet, t: { to: string; data: string }) => (await w.sendTransaction({ to: t.to, data: t.data })).wait();
const mint = async (to: string, amount: bigint) => (await (h.contracts.usdc.connect(h.signers[0]!) as Contract).mint(to, amount)).wait();

test("store creation requires at least 5 USDC of owner seed, and says why, before anything is signed", async () => {
  const owner = await freshWallet();
  const key = await keyFor(owner);
  for (const seed of [undefined, "0", "4.999999"]) {
    const r = await create(key, "LOW", seed);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.code, "INITIAL_MARKET_CAPITAL_TOO_LOW");
    assert.equal(r.body.error.details.minimumUSDC, "5");
    assert.equal(r.body.error.details.field, "initialOwnerSeedUSDC");
    assert.match(r.body.error.message, /not a fee/);
  }
  const ok = await create(key, "EXACT", "5");
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok(ok.body.intent.approvalTransaction, "the approval travels with the intent");
  assert.equal(String(ok.body.intent.approvalTransaction.to).toLowerCase(), h.manifest.external.canonicalUSDC.toLowerCase());
  const factory = (await h.contracts.factory.getAddress()).toLowerCase();
  assert.ok(JSON.stringify(ok.body.intent).toLowerCase().includes(factory), "the spender is the factory");
  const imc = ok.body.initialMarketCapital;
  assert.equal(imc.ownerFundedUSDC.base, "5000000");
  assert.equal(imc.minimumRequiredUSDC.base, "5000000");
  assert.equal(imc.independentDemandUSDC, "0");
  assert.equal(imc.marketInitialized, true);
  assert.equal(imc.controllerCanFundIncentive, true);
  assert.ok(BigInt(imc.ownerAICReceived.base) > 0n);
  assert.match(imc.theMinimum, /not a recommended size/);
  noNaN("create", ok.body);
  // A plain JSON number means the same USDC as the decimal string.
  const asNumber = await h.request("POST", "/api/v1/stores", {
    apiKey: key,
    headers: idem("num"),
    body: { storeType: "sales", aicName: "NUM AIC", aicSymbol: "NUM", storeName: "NUM", initialOwnerSeedUSDC: 5 },
  });
  assert.equal(asNumber.status, 201, JSON.stringify(asNumber.body));
  assert.equal(asNumber.body.initialMarketCapital.ownerFundedUSDC.base, "5000000");
  const tooLowNumber = await h.request("POST", "/api/v1/stores", {
    apiKey: key,
    headers: idem("num"),
    body: { storeType: "sales", aicName: "NUM AIC", aicSymbol: "NUM", storeName: "NUM", initialOwnerSeedUSDC: 4.5 },
  });
  assert.equal(tooLowNumber.body.error.code, "INITIAL_MARKET_CAPITAL_TOO_LOW");
  const more = await create(key, "MORE", "50");
  assert.equal(more.status, 201);
  assert.ok(
    BigInt(more.body.initialMarketCapital.ownerAICReceived.base) > BigInt(imc.ownerAICReceived.base),
    "more is allowed, with no cap"
  );
});

test("the creation is atomic: without the approval nothing is created", async () => {
  const owner = await freshWallet();
  const key = await keyFor(owner);
  await mint(owner.address, 5_000_000n);
  const prep = await create(key, "ATOM", "5");
  assert.equal(prep.status, 201);
  await assert.rejects(send(owner, prep.body.intent.transaction), "the transaction reverts without the approval");
  await h.sync();
  const me = (await h.request("GET", "/api/v1/me", { apiKey: key })).body as any;
  assert.equal(me.stores.items.length, 0, "no store without its market capital");
});

test("a new store is born initialized, and owner capital is never shown as independent demand", async () => {
  const owner = await freshWallet();
  const key = await keyFor(owner);
  await mint(owner.address, 10_000_000n);
  const prep = await create(key, "BORN", "5");
  await send(owner, prep.body.intent.approvalTransaction);
  await send(owner, prep.body.intent.transaction);
  await h.sync();

  // ACTIVE_NEW_STORE => MARKET_INITIALIZED && OWNER_AIC > 0 && SEED >= 5
  const me = (await h.request("GET", "/api/v1/me", { apiKey: key })).body as any;
  noNaN("/me", me);
  const store = me.stores.items[0];
  const tm = store.tokenMarket;
  assert.equal(tm.marketState, "LIVE_ON_CURVE");
  assert.equal(tm.marketInitialized, true);
  assert.equal(tm.controllerIsHolder, true);
  assert.equal(tm.sellQuoteAvailable, true);
  assert.equal(tm.legacyUninitializedMarket, false);
  assert.equal(tm.ownerAICBalance.base, prep.body.initialMarketCapital.ownerAICReceived.base, "the fresh-market figure is exact");
  assert.equal(tm.capitalSources.ownerSeedUSDC.base, "5000000");
  assert.equal(tm.capitalSources.independentBuyVolumeUSDC.base, "0");
  assert.ok(Number(tm.controllerFeesAccruedUSDC.base) > 0, "the 1% controller fee on its own seed accrued to it");
  assert.ok(
    !me.actionableTasks.items.some((x: any) => x.type === "STORE_TOKEN_MARKET_UNINITIALIZED"),
    "no legacy task for a new store"
  );
  const token = String(store.aicToken).toLowerCase();

  // The price series opens at the fresh curve's quote, so the seed's move is a price change, not 0%.
  const series = (await h.request("GET", `/api/v1/market/tokens/${token}/trades`)).body as any;
  assert.equal(series.items[0].source, "opening");
  assert.equal(series.items[0].grossUSDC, "0", "the opening is a quote, not volume");
  assert.equal(series.items[1].source, "trade");
  assert.ok(series.items[0].at < series.items[1].at);
  assert.ok(BigInt(series.items[0].pricePerToken1e18) < BigInt(series.items[1].pricePerToken1e18), "the seed moved the price up");

  // an outside buyer is independent demand; the owner's later buy is controller volume; the seed stays the seed
  const buyer = await freshWallet();
  const buyerKey = await keyFor(buyer);
  await mint(buyer.address, 3_000_000n);
  await h.sync();
  for (const [w, k, amount] of [
    [buyer, buyerKey, "3000000"],
    [owner, key, "2000000"],
  ] as const) {
    const b = await h.request("POST", `/api/v1/stocks/${token}/buy`, { apiKey: k, headers: idem("b"), body: { amount } });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    await send(w, b.body.intent.approvalTransaction);
    await send(w, b.body.intent.transaction);
  }
  await h.sync();
  const detail = (await h.request("GET", `/api/v1/stores/${store.storeId}`)).body as any;
  noNaN("/stores/{id}", detail);
  assert.deepEqual(
    [
      detail.capitalSources.ownerSeedUSDC.base,
      detail.capitalSources.controllerBuyVolumeUSDC.base,
      detail.capitalSources.independentBuyVolumeUSDC.base,
    ],
    ["5000000", "2000000", "3000000"]
  );
  // The owner's business dashboard: independent means not the controller; unrecorded reach is null, not guessed.
  const bm = ((await h.request("GET", "/api/v1/me", { apiKey: key })).body as any).stores.items[0].businessMetrics;
  noNaN("businessMetrics", bm);
  assert.equal(bm.reach.storeInspections, null);
  assert.match(bm.reach.unavailableReason, /not recorded/);
  assert.equal(bm.conversion.independentAICBuyers, 1, "the outside buyer, not the owner");
  assert.equal(bm.conversion.independentAICBuyVolumeUSDC.base, "3000000");
  assert.equal(bm.retention.independentHolders, 1);
  assert.equal(bm.conversion.independentProductPurchases, 0);
  const tokens = (await h.request("GET", "/api/v1/market/tokens?limit=50")).body as any;
  noNaN("/market/tokens", tokens);
  const row = tokens.items.find((x: any) => x.aicToken.toLowerCase() === token);
  assert.equal(row.capitalSources.independentBuyVolumeUSDC.base, "3000000");
  assert.equal(row.marketState.state, "LIVE_ON_CURVE");
  for (const path of ["/api/v1/stores?limit=50", "/api/v1/discovery", `/api/v1/largest-holders/${token}`]) {
    noNaN(path, (await h.request("GET", path)).body);
  }

  // the seed analysis and the round trip still price further owner capital
  const sa = (await h.request("GET", `/api/v1/stores/${store.storeId}/seed-analysis?amountsUSDC=5,20&wallet=${owner.address}`)).body as any;
  noNaN("/seed-analysis", sa);
  assert.equal(sa.candidates.length, 2);
  assert.equal(sa.withoutSeed.marketInitialized, true);
  const rt = (await h.request("GET", `/api/v1/market/tokens/${token}/round-trip?amountUSDC=100&wallet=${owner.address}`)).body as any;
  noNaN("/round-trip", rt);
  const back = Number(rt.immediateSellBackUSDC.base) / 1e6;
  assert.ok(back > 93 && back < 100, `fees on both legs, not the principal: ${back}`);

  // the legacy route: only for a legacy store, only for its controller
  const init = (k: string, amountUSDC: string) =>
    h.request("POST", `/api/v1/stores/${store.storeId}/initialize-market-intent`, { apiKey: k, headers: idem("init"), body: { amountUSDC } });
  assert.equal((await init(buyerKey, "5")).status, 403);
  const already = await init(key, "5");
  assert.equal(already.status, 409, JSON.stringify(already.body));
});
