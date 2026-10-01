/**
 * The takeover warning, and the defence it points at.
 *
 * The problem this closes is a real loss of money, not an inconvenience. A store's reward pool is
 * funded with AIC the controller **bought with their own funds**, but it belongs to the STORE — so
 * when a holder takeover changes control, the pool goes with it and the previous controller has no
 * way to recover it afterwards.
 *
 * The protocol already guarantees at least an hour of notice: a candidacy is public the moment it
 * opens and cannot be finalized for `TAKEOVER_OBSERVATION_PERIOD`. That notice existed and nobody
 * was receiving it, because nothing projected the event.
 *
 * What is asserted here:
 *
 *   1. the candidacy is projected the moment it opens;
 *   2. the controller gets a CRITICAL task naming the pool at risk and the time remaining;
 *   3. `withdrawRewardPool` genuinely still works during a candidacy — the warning would be
 *      useless if the action it recommends were blocked;
 *   4. withdrawing is a real DEFENCE, because pool AIC is held by a contract (ineligible, absent
 *      from the heap) and moving it to the controller's EOA makes it count.
 */

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Contract, Wallet, ZeroHash, id } from "ethers";
import {
  createHarness,
  startChain,
  deployProtocol,
  stopChain,
  UNDECLARED,
  USDC,
  type Harness, createStoreOnChain } from "./helpers/harness";
import { StockMarket } from "../src/db/models";
import { leadershipRow } from "../src/api/routes/largestHolders";
import { dexPoolOf, dexUsdcToBuy } from "../src/stores/quotes";

let h: Harness;

async function freshWallet(): Promise<Wallet> {
  const w = Wallet.createRandom().connect(h.provider) as Wallet;
  await (await h.signers[0]!.sendTransaction({ to: w.address, value: 10n ** 18n })).wait();
  return w;
}

async function issueApiKey(wallet: Wallet): Promise<string> {
  const c = await h.request("POST", "/api/v1/auth/challenge", {
    body: { wallet: wallet.address, purpose: "ISSUE_API_KEY" },
  });
  const sig = await wallet.signMessage(c.body.message as string);
  const issued = await h.request("POST", "/api/v1/auth/api-key/issue", {
    body: { nonce: c.body.nonce, signature: sig },
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return issued.body.apiKey as string;
}

/** A store with a funded reward pool and a challenger holding more AIC than the controller. */
async function storeUnderThreat() {
  const controller = await freshWallet();
  const challenger = await freshWallet();
  const key = await issueApiKey(controller);

  const receipt = await (await createStoreOnChain(h, controller, 0, "Threatened AIC", "THRT", "Threatened")).wait();
  const created = receipt!.logs
    .map((l) => {
      try {
        return h.contracts.factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "StoreCreated")!;

  const storeAddress = created.args.store as string;
  const aicAddress = created.args.aicToken as string;
  const storeAbi = h.ctx.abis.abiFor("AICStoreSales") as never;
  const aicAbi = h.ctx.abis.abiFor("AICoin") as never;
  const store = new Contract(storeAddress, storeAbi, controller);
  const aic = new Contract(aicAddress, aicAbi, controller);

  // The controller buys AIC and commits half of it to the customer incentive pool.
  const shop = h.contracts.agentGoods;
  const usdc = h.contracts.usdc;
  await (await (usdc.connect(h.signers[0]!) as Contract).mint(controller.address, USDC(400))).wait();
  await (await (usdc.connect(controller) as Contract).approve(await shop.getAddress(), USDC(400))).wait();
  let deadline = (await h.provider.getBlock("latest"))!.timestamp + 3600;
  await (await (shop.connect(controller) as Contract).buy(aicAddress, USDC(400), 0, deadline)).wait();

  const held = (await aic.balanceOf(controller.address)) as bigint;
  await (await aic.approve(storeAddress, held / 2n)).wait();
  await (await store.depositRewardPool(held / 2n)).wait();

  // The challenger buys MORE, so it becomes the largest eligible holder and can open a candidacy.
  await (await (usdc.connect(h.signers[0]!) as Contract).mint(challenger.address, USDC(3000))).wait();
  await (await (usdc.connect(challenger) as Contract).approve(await shop.getAddress(), USDC(3000))).wait();
  deadline = (await h.provider.getBlock("latest"))!.timestamp + 3600;
  await (await (shop.connect(challenger) as Contract).buy(aicAddress, USDC(3000), 0, deadline)).wait();

  return { controller, challenger, key, store, aic, storeAddress, aicAddress, storeId: created.args.storeId as string };
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

describe("Takeover warning protects the controller's own AIC", { concurrency: 1 }, () => {
  test("a candidacy is projected, and warns the controller as CRITICAL with time to act", async () => {
    const w = await storeUnderThreat();
    const aic = w.aic.connect(w.challenger) as Contract;

    const poolBefore = (await (w.store as Contract).rewardPool()) as bigint;
    assert.ok(poolBefore > 0n, "the fixture must have a pool worth protecting");

    await (await aic.openTakeoverCandidacy()).wait();
    await h.sync();

    const market = await StockMarket.findOne({ chainId: h.env.CHAIN_ID, aicToken: w.aicAddress.toLowerCase() }).lean();
    assert.equal(
      market?.takeoverCandidate,
      w.challenger.address.toLowerCase(),
      "the candidacy must be projected, or the warning can never be produced"
    );
    assert.ok(Number(market?.takeoverOpenedAt ?? 0) > 0, "observation start must be recorded");

    const me = await h.request("GET", "/api/v1/me", { apiKey: w.key });
    assert.equal(me.status, 200);
    const body = me.body as Record<string, any>;

    const task = body.actionableTasks.items.find((t: any) => t.type === "STORE_TAKEOVER_IN_PROGRESS");
    assert.ok(task, "the controller must be told");
    assert.equal(task.priority, "CRITICAL", "losing purchased AIC is not a NORMAL-priority event");
    assert.equal(task.requiresWalletSignature, true);
    assert.match(task.reason, /reward pool/i, "the reason must name what is at risk");
    assert.match(task.reason, /withdrawRewardPool/, "and the action that saves it");
    assert.equal(task.resourceId, w.storeId);

    // There must be real time left to act. A warning that arrives at zero is not a warning.
    const entry = body.takeover.activeCandidaciesAgainstYourStores[0];
    assert.ok(entry, "the takeover section must list it");
    assert.equal(entry.candidate, w.challenger.address.toLowerCase());
    assert.ok(
      entry.observationRemainingSeconds > 0 && entry.observationRemainingSeconds <= 3600,
      `expected time remaining, got ${entry.observationRemainingSeconds}`
    );
    assert.equal(entry.rewardPoolAtRiskAIC.base, poolBefore.toString(), "the amount at risk must be exact");
  });

  test("the recommended action actually works while a candidacy is open", async () => {
    /*
     * The warning is worthless if the escape it names is blocked. A takeover deliberately does NOT
     * set a governance lock, so `withdrawRewardPool` stays available to the controller right up to
     * the moment control changes — this asserts that, rather than assuming it.
     */
    const w = await storeUnderThreat();
    await (await (w.aic.connect(w.challenger) as Contract).openTakeoverCandidacy()).wait();

    const store = w.store as Contract;
    const pool = (await store.rewardPool()) as bigint;
    const before = (await w.aic.balanceOf(w.controller.address)) as bigint;

    await (await store.withdrawRewardPool(pool, w.controller.address)).wait();

    assert.equal(await store.rewardPool(), 0n, "the pool is recovered");
    assert.equal(
      (await w.aic.balanceOf(w.controller.address)) as bigint,
      before + pool,
      "and the AIC is back in the controller's own wallet"
    );
  });

  test("withdrawing is a DEFENCE: pool AIC is ineligible until it reaches an EOA", async () => {
    /*
     * The insight that makes this more than damage limitation. AIC sitting in the store is held by
     * a CONTRACT, so it is ineligible and absent from the eligible-holder heap — it contributes
     * nothing to the controller's standing. Moving it to the controller's own address makes it
     * count, and leadership is what a takeover actually requires.
     */
    const w = await storeUnderThreat();
    const aicRead = w.aic as Contract;

    assert.equal(
      await aicRead.isEligible(w.storeAddress),
      false,
      "the store contract must be ineligible, so the pool contributes nothing while it sits there"
    );
    assert.equal(await aicRead.isEligible(w.controller.address), true);

    const store = w.store as Contract;
    const pool = (await store.rewardPool()) as bigint;
    const eligibleBefore = (await aicRead.eligibleSupply()) as bigint;

    await (await store.withdrawRewardPool(pool, w.controller.address)).wait();

    const eligibleAfter = (await aicRead.eligibleSupply()) as bigint;
    assert.equal(
      eligibleAfter,
      eligibleBefore + pool,
      "withdrawing moves the pool into eligible supply, where it counts toward leadership"
    );
  });

  test("clears the warning when the candidacy is cancelled", async () => {
    const w = await storeUnderThreat();
    const challengerAic = w.aic.connect(w.challenger) as Contract;

    await (await challengerAic.openTakeoverCandidacy()).wait();
    await h.sync();
    let me = await h.request("GET", "/api/v1/me", { apiKey: w.key });
    assert.equal((me.body as any).takeover.activeCandidaciesAgainstYourStores.length, 1);

    await (await challengerAic.cancelTakeoverCandidacy()).wait();
    await h.sync();

    me = await h.request("GET", "/api/v1/me", { apiKey: w.key });
    const body = me.body as Record<string, any>;
    assert.equal(
      body.takeover.activeCandidaciesAgainstYourStores.length,
      0,
      "a cancelled candidacy must stop warning, or the warning stops being believed"
    );
    assert.ok(
      !body.actionableTasks.items.some((t: any) => t.type === "STORE_TAKEOVER_IN_PROGRESS"),
      "and the task must clear with it"
    );
  });

  test("does not warn an Agent about its own candidacy", async () => {
    const w = await storeUnderThreat();
    const challengerKey = await issueApiKey(w.challenger);
    await (await (w.aic.connect(w.challenger) as Contract).openTakeoverCandidacy()).wait();
    await h.sync();

    const me = await h.request("GET", "/api/v1/me", { apiKey: challengerKey });
    const body = me.body as Record<string, any>;
    assert.equal(
      body.takeover.activeCandidaciesAgainstYourStores.length,
      0,
      "your own candidacy is not a threat to you"
    );
    assert.equal(body.takeover.yourOwnCandidacies.length >= 0, true);
  });
});

describe("The takeover path is reachable through the API, not only on chain", { concurrency: 1 }, () => {
  /*
   * The documentation tells agents never to encode a transaction by hand, and until these routes
   * existed the only way to open or finalize a takeover was exactly that. This walks the whole path
   * through the prepared intents: refusal for a non-leader, open, refusal before the period ends,
   * finalize, control transferred.
   */
  const idem = () => ({ "idempotency-key": `tko-${Math.random().toString(36).slice(2)}` });
  const send = async (wallet: Wallet, intent: any) => {
    const t = intent.transaction as { to: string; data: string; value?: string };
    return (await (await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value ?? "0") })).wait())!;
  };

  test("open, wait out the period, finalize: control passes to the largest holder", async () => {
    const w = await storeUnderThreat();
    const challengerKey = await issueApiKey(w.challenger);
    await h.sync();
    const base = `/api/v1/stocks/${w.aicAddress}/takeover`;

    const notLeader = await h.request("POST", `${base}/candidacy-intent`, { apiKey: w.key, headers: idem() });
    assert.equal(notLeader.status, 409, JSON.stringify(notLeader.body));
    assert.equal(notLeader.body.error.code, "ALREADY_CONTROLLER");

    const early = await h.request("POST", `${base}/finalize-intent`, { apiKey: challengerKey, headers: idem() });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, "NO_CANDIDACY");

    const open = await h.request("POST", `${base}/candidacy-intent`, { apiKey: challengerKey, headers: idem() });
    assert.equal(open.status, 201, JSON.stringify(open.body));
    assert.equal((await send(w.challenger, open.body.intent)).status, 1);
    await h.sync();

    const tooSoon = await h.request("POST", `${base}/finalize-intent`, { apiKey: challengerKey, headers: idem() });
    assert.equal(tooSoon.status, 409);
    assert.equal(tooSoon.body.error.code, "OBSERVATION_PERIOD_NOT_ELAPSED");
    assert.equal(tooSoon.body.error.details.largestEligibleHolder, w.challenger.address.toLowerCase());

    const listed = await h.request("GET", "/api/v1/takeovers");
    assert.ok(listed.body.items.some((i: any) => i.claimant === w.challenger.address.toLowerCase()));

    await h.provider.send("evm_increaseTime", [3601]);
    await h.provider.send("evm_mine", []);
    await h.sync();

    const fin = await h.request("POST", `${base}/finalize-intent`, { apiKey: challengerKey, headers: idem() });
    assert.equal(fin.status, 201, JSON.stringify(fin.body));
    assert.equal((await send(w.challenger, fin.body.intent)).status, 1);
    assert.equal(
      String(await (w.store as Contract).storeController()).toLowerCase(),
      w.challenger.address.toLowerCase(),
      "control transferred"
    );

    // The old controller cannot open another store of that type: the slot is not freed by losing control.
    await h.sync();
    const again = await h.request("POST", "/api/v1/stores", {
      apiKey: w.key,
      headers: idem(),
      body: { storeType: "sales", aicName: "Again", aicSymbol: "AGN", storeName: "Again", initialOwnerSeedUSDC: "5" },
    });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.error.code, "STORE_LIMIT_REACHED");
    assert.equal(again.body.error.details.youNoLongerControlIt, true);
    assert.equal(String(again.body.error.details.currentController).toLowerCase(), w.challenger.address.toLowerCase());
    assert.ok(again.body.error.details.yourOptions.some((o: string) => /new wallet/.test(o)));
    assert.ok(!("toListAProductInIt" in again.body.error.details), "no advice to list in a store it does not control");
  });

  test("a holder who is not the largest is refused with the live leader, and cancel releases a candidacy", async () => {
    const w = await storeUnderThreat();
    const bystander = await freshWallet();
    const bystanderKey = await issueApiKey(bystander);
    const challengerKey = await issueApiKey(w.challenger);
    await h.sync();
    const base = `/api/v1/stocks/${w.aicAddress}/takeover`;

    const refused = await h.request("POST", `${base}/candidacy-intent`, { apiKey: bystanderKey, headers: idem() });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "NOT_LARGEST_HOLDER");
    assert.equal(refused.body.error.details.largestEligibleHolder, w.challenger.address.toLowerCase());

    const open = await h.request("POST", `${base}/candidacy-intent`, { apiKey: challengerKey, headers: idem() });
    assert.equal((await send(w.challenger, open.body.intent)).status, 1);
    await h.sync();
    const cancel = await h.request("POST", `${base}/cancel-intent`, { apiKey: challengerKey, headers: idem() });
    assert.equal(cancel.status, 201, JSON.stringify(cancel.body));
    assert.equal((await send(w.challenger, cancel.body.intent)).status, 1);
    assert.equal(await (w.aic as Contract).takeoverCandidacyOpenedAt(w.challenger.address), 0n);
  });
});

describe("Who leads, told to everyone who asks and to every agent on /me", { concurrency: 1 }, () => {
  test("/largest-holders names the leader, the runner-up and what passing the leader costs", async () => {
    const w = await storeUnderThreat();
    await (await w.store.withdrawRewardPool(await w.store.rewardPool(), w.controller.address)).wait();
    await h.sync();

    const all = await h.request("GET", "/api/v1/largest-holders");
    assert.equal(all.status, 200);
    const row = all.body.items.find((r: any) => r.aicToken === w.aicAddress.toLowerCase());
    assert.ok(row, "every store is listed");
    assert.equal(row.largestEligibleHolder.address, w.challenger.address.toLowerCase());
    for (const holder of (await h.request("GET", `/api/v1/largest-holders/${w.aicAddress}`)).body.topEligibleHolders) {
      assert.equal(await h.provider.getCode(holder.address), "0x", `a contract is never ranked: ${holder.address}`);
    }
    assert.equal(row.runnerUp.address, w.controller.address.toLowerCase());
    assert.ok(BigInt(row.canTheLeaderBeOvertaken.fromZero.tokensToBuyAIC.base) > BigInt(row.largestEligibleHolder.balanceAIC.base));
    const fz = row.canTheLeaderBeOvertaken.fromZero;
    assert.ok(fz.estimatedCostUSDC || fz.notBuyableOnTheCurve, "either priced or explained: " + JSON.stringify(fz));

    const one = await h.request("GET", `/api/v1/largest-holders/${w.storeId}?wallet=${w.controller.address}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.topEligibleHolders[0].address, w.challenger.address.toLowerCase());
    const gap = one.body.canTheLeaderBeOvertaken.forYou;
    const expected = BigInt(one.body.largestEligibleHolder.balanceAIC.base) - BigInt(gap.yourBalanceAIC.base) + 1n;
    assert.equal(BigInt(gap.tokensToBuyAIC.base), expected, "one base unit past the leader, from your own balance");
    assert.ok(one.body.howToOvertake.some((s: string) => /EOAs only/.test(s)));
    assert.equal((await h.request("GET", "/api/v1/largest-holders/nonsense")).status, 400);
  });

  test("/me tells the leader it leads and the controller that it leads nothing — with a warning", async () => {
    const w = await storeUnderThreat();
    const challengerKey = await issueApiKey(w.challenger);
    await h.sync();

    const leaderMe = (await h.request("GET", "/api/v1/me", { apiKey: challengerKey })).body as any;
    const standing = leaderMe.takeover.yourStanding;
    assert.match(standing.summary, /You are the largest eligible holder of 1 store/);
    assert.equal(standing.youLead[0].aicToken, w.aicAddress.toLowerCase());
    assert.equal(standing.youLead[0].isYourOwnStore, false);
    assert.match(standing.youLead[0].whatItMeans, /candidacy-intent/);

    const ctrlMe = (await h.request("GET", "/api/v1/me", { apiKey: w.key })).body as any;
    const theirs = ctrlMe.takeover.yourStanding;
    assert.equal(theirs.summary, "You are not the largest eligible holder of any store.");
    const own = theirs.tokensYouHoldOrControlLedBySomeoneElse.find((r: any) => r.aicToken === w.aicAddress.toLowerCase());
    assert.equal(own.largestEligibleHolder.address, w.challenger.address.toLowerCase());
    assert.match(own.warning, /your own store/);
  });
});

test("passing the leader is priced with the curve's own arithmetic while the market is on its curve", () => {
  const E = 10n ** 18n;
  const market = {
    storeId: "0x" + "1".repeat(64), aicToken: "0x" + "2".repeat(40), phase: "bonding_curve",
    virtualTokenReserve: (900_000_000n * E).toString(), virtualUSDCReserve: (6_600n * 10n ** 6n).toString(),
    marketInventoryAIC: (900_000_000n * E).toString(), realUSDCReserve: (600n * 10n ** 6n).toString(), netSoldFromCurveAIC: (100_000_000n * E).toString(),
  };
  const ranked = [{ holder: "0x" + "a".repeat(40), balance: (60_000_000n * E).toString() }, { holder: "0x" + "b".repeat(40), balance: (40_000_000n * E).toString() }];
  const o = { fees: { protocolBps: 200, controllerBps: 100 }, observationPeriodSeconds: 3600, now: 0 };
  const row: any = leadershipRow(market, { storeController: "0x" + "c".repeat(40) }, ranked, { ...o, wallet: "0x" + "b".repeat(40), walletBalance: 40_000_000n * E });
  assert.equal(row.largestEligibleHolder.address, "0x" + "a".repeat(40));
  assert.equal(row.leadMarginAIC.base, (20_000_000n * E).toString());
  assert.equal(row.canTheLeaderBeOvertaken.forYou.tokensToBuyAIC.base, (20_000_000n * E + 1n).toString());
  // net = vU*t/(vT-t) = 6,600 * 20M / 880M = 150.0 USDC; gross = net / (1 - 3%) = 154.64, rounded up
  const cost = Number(row.canTheLeaderBeOvertaken.forYou.estimatedCostUSDC.base) / 1e6;
  assert.ok(cost > 154.6 && cost < 154.7, "cost " + cost);
  const leaderView: any = leadershipRow(market, undefined, ranked, { ...o, wallet: "0x" + "a".repeat(40) });
  assert.equal(leaderView.canTheLeaderBeOvertaken.forYou.youLead, true);
});

describe("The acquisition scan prices control with the curve, not with spot", { concurrency: 1 }, () => {
  test("estimatedCostUSDC buys at least tokensToBuyAIC at the contract's own quote, and spot x tokens would not", async () => {
    // A store still on its curve: one modest buyer, far from the transition threshold.
    const controller = await freshWallet();
    const receipt = await (await createStoreOnChain(h, controller, 0, "Curve AIC", "CRVE", "Curve")).wait();
    const created = receipt!.logs
      .map((l) => { try { return h.contracts.factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "StoreCreated")!;
    const aicAddress = created.args.aicToken as string;
    const shop = h.contracts.agentGoods;
    await (await (h.contracts.usdc.connect(h.signers[0]!) as Contract).mint(controller.address, USDC(300))).wait();
    await (await (h.contracts.usdc.connect(controller) as Contract).approve(await shop.getAddress(), USDC(300))).wait();
    const deadline = (await h.provider.getBlock("latest"))!.timestamp + 3600;
    await (await (shop.connect(controller) as Contract).buy(aicAddress, USDC(300), 0, deadline)).wait();
    await h.sync();

    const res = await h.request("GET", `/api/v1/largest-holders/${aicAddress}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body as any;
    assert.equal(row.market.phase, "bonding_curve");
    assert.ok(row.continuousLeadRequiredSeconds > 0);
    assert.ok(Array.isArray(row.readThisFirst) && row.readThisFirst.some((s: string) => /not the full cost to acquire control/.test(s)));
    assert.ok("lifetimeGrossCommerceUSDC" in row.business && "realUSDCReserve" in row.market);

    const pass = row.canTheLeaderBeOvertaken.fromZero;
    assert.equal(pass.curveCanSettleRequiredBuy, true);
    const tokens = BigInt(pass.tokensToBuyAIC.base);
    const cost = BigInt(pass.estimatedCostUSDC.base);
    assert.equal(pass.confirmWithLiveQuote.body.amount, cost.toString());

    const q = await (shop as Contract).quoteBuy(aicAddress, cost);
    assert.ok(BigInt(q.tokensOut) >= tokens, `the estimate must actually buy the lead: ${q.tokensOut} < ${tokens}`);

    // And spot x tokens would have under-priced it: the price rises while you buy.
    // Spot = the marginal price vU / vT before buying, grossed up for the same 3% of fees.
    const m = await StockMarket.findOne({ chainId: h.env.CHAIN_ID, aicToken: aicAddress.toLowerCase() }).lean();
    const naive = (tokens * BigInt(m!.virtualUSDCReserve) * 10_000n) / (BigInt(m!.virtualTokenReserve) * 9_700n);
    assert.ok(naive < cost, `spot x tokens (${naive}) must be below the real cost (${cost})`);
  });
});

describe("After graduation, every figure and every trade uses the DEX pool", { concurrency: 1 }, () => {
  test("quote, /me value, cost to pass the leader and a real sell all agree with the router", async () => {
    const w = await storeUnderThreat(); // 3,400 USDC of buying graduates this market
    const key = await issueApiKey(w.challenger);
    await h.sync();
    const market = await StockMarket.findOne({ chainId: h.env.CHAIN_ID, aicToken: w.aicAddress.toLowerCase() }).lean();
    assert.notEqual(market?.phase, "bonding_curve", "the fixture must have graduated");

    const routerAddr = h.ctx.manifest.external.dexRouter;
    const usdcAddr = h.ctx.manifest.external.canonicalUSDC;
    const router = new Contract(routerAddr, [
      "function getAmountsOut(uint256,address[]) view returns (uint256[])",
      "function getAmountsIn(uint256,address[]) view returns (uint256[])",
    ], h.provider);
    const bal = (await (w.aic as Contract).balanceOf(w.challenger.address)) as bigint;
    const sellAmount = bal / 10n;
    const routerOut = ((await router.getAmountsOut(sellAmount, [w.aicAddress, usdcAddr])) as bigint[])[1]!;

    // quote
    const q = await h.request("POST", `/api/v1/stocks/${w.aicAddress}/quote`, { apiKey: key, body: { side: "sell", amount: sellAmount.toString() } });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.quote.venue, "dex");
    assert.equal(BigInt(q.body.quote.expectedOutUSDC.base), routerOut, "quote = router.getAmountsOut");

    // /me values the whole position on the pool
    const me = (await h.request("GET", "/api/v1/me", { apiKey: key })).body as any;
    const pos = me.aicPositions.items.find((i: any) => i.aicToken.toLowerCase() === w.aicAddress.toLowerCase());
    const routerWhole = ((await router.getAmountsOut(bal, [w.aicAddress, usdcAddr])) as bigint[])[1]!;
    assert.equal(pos.valueIfSoldNow.venue, "dex");
    assert.equal(BigInt(pos.valueIfSoldNow.netUSDCOut.base), routerWhole, "/me = router for the whole position");

    // cost to pass the leader, bought from the pool, matches getAmountsIn (+1 base unit of rounding)
    const lh = (await h.request("GET", `/api/v1/largest-holders/${w.aicAddress}`)).body as any;
    const pass = lh.canTheLeaderBeOvertaken.fromZero;
    assert.equal(pass.venue, "dex");
    if (pass.estimatedCostUSDC) {
      const routerIn = ((await router.getAmountsIn(BigInt(pass.tokensToBuyAIC.base), [usdcAddr, w.aicAddress])) as bigint[])[0]!;
      const est = BigInt(pass.estimatedCostUSDC.base);
      assert.ok(est >= routerIn && est - routerIn <= 1n, `estimate ${est} vs router ${routerIn}`);
    } else {
      assert.match(pass.notBuyableOnTheCurve, /DEX pool/, "explained on the right venue");
    }
    // and the pool-buy arithmetic itself, on an amount the pool can supply
    const fresh = await StockMarket.findOne({ chainId: h.env.CHAIN_ID, aicToken: w.aicAddress.toLowerCase() }).lean();
    const pool = dexPoolOf(fresh as never)!;
    const want = pool.tokenReserve / 20n;
    const needIn = ((await router.getAmountsIn(want, [usdcAddr, w.aicAddress])) as bigint[])[0]!;
    const mine = dexUsdcToBuy(pool, want)!;
    assert.ok(mine >= needIn && mine - needIn <= 1n, `dexUsdcToBuy ${mine} vs router ${needIn}`);

    // the pool contract is never ranked
    for (const holder of lh.topEligibleHolders) assert.equal(await h.provider.getCode(holder.address), "0x", `contract ranked: ${holder.address}`);

    // a real sell through the API: approval, then the router swap
    const usdcBefore = (await (h.contracts.usdc as Contract).balanceOf(w.challenger.address)) as bigint;
    const sell = await h.request("POST", `/api/v1/stocks/${w.aicAddress}/sell`, {
      apiKey: key,
      headers: { "idempotency-key": `dex-sell-${Date.now()}` },
      body: { amount: sellAmount.toString(), minOut: ((routerOut * 99n) / 100n).toString() },
    });
    assert.equal(sell.status, 201, JSON.stringify(sell.body));
    const intent = sell.body.intent as any;
    assert.equal(String(intent.transaction.to).toLowerCase(), routerAddr.toLowerCase());
    await (await w.challenger.sendTransaction({ to: intent.approvalTransaction.to, data: intent.approvalTransaction.data })).wait();
    const rc = await (await w.challenger.sendTransaction({ to: intent.transaction.to, data: intent.transaction.data })).wait();
    assert.equal(rc!.status, 1);
    const got = ((await (h.contracts.usdc as Contract).balanceOf(w.challenger.address)) as bigint) - usdcBefore;
    assert.equal(got, routerOut, "the sell paid exactly what the quote said");
  });
});
