const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployProtocol,
  createStore,
  fundUSDC,
  StoreType,
  USDC,
} = require("./helpers/deploy");

/**
 * The holders' share must be unreachable by everyone.
 *
 * The holders' share of every sale (20% of net commerce) is no longer held in the store: it buys the
 * store's own AIC and burns it in the purchase transaction (see test/06-buyback.test.js). What this
 * suite proves is the other half of that promise: after the buyback, the store holds only the owner's
 * proceeds, and no role — not the store controller, not a new controller, not the protocol operator —
 * can take more than those proceeds, so nothing of the holders' share can be diverted even in the
 * instant between payment and buyback.
 *
 * Two kinds of check, because either alone is insufficient:
 *
 *   1. An ABI surface sweep. A behavioural test can only prove that the paths it thought to try
 *      are closed. Enumerating the whole external surface proves there is no path it did not think
 *      to try — if someone adds `sweepReserve()` next year, this fails on the shape of the ABI
 *      before anyone has to imagine how it might be abused.
 *
 *   2. Behavioural proof, because an ABI sweep only knows names. `withdrawOwnerProceeds` is a
 *      legitimate function with a legitimate name that would drain the reserve if its bound were
 *      wrong, and no amount of reading the ABI would notice.
 */
describe("The holders' share is unreachable (bought back, never held)", function () {
  this.timeout(300000);

  const PRODUCT = ethers.id("reserve-product");
  const PRICE = USDC(100);

  /** A store with real commerce on it, so the holders' share has actually been bought back. */
  async function storeWithAccruedReserve() {
    const env = await deployProtocol();
    const creator = env.signers[5];
    const store = await createStore(env, creator, StoreType.Sales, { aicSymbol: "RSV" });
    await (
      await store.store
        .connect(creator)
        .createProduct(PRODUCT, PRICE, 1000000, 0, ethers.ZeroHash, "", { tokensSaved: 1000n, modelTier: ethers.encodeBytes32String("gpt-6-luna"), basis: 1, declaredAt: 0n })
    ).wait();

    const buyer = env.signers[9];
    const storeAddress = await store.store.getAddress();
    for (let i = 0; i < 3; i++) {
      await fundUSDC(env, buyer, PRICE, storeAddress);
      await (
        await store.store.connect(buyer).purchase(PRODUCT, 1, 1, PRICE, ethers.ZeroHash, "")
      ).wait();
    }

    // `reserve` is the lifetime holders' share, all of it already bought back and burned.
    const reserve = await store.store.lifetimeHolderReserveAccruedUSDC();
    expect(reserve, "the fixture must actually have bought back a holders' share").to.be.greaterThan(0n);
    expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
    // The store holds exactly the owner's proceeds, and nothing of the holders' share.
    expect(await env.usdc.balanceOf(storeAddress)).to.equal(await store.store.ownerAvailableUSDC());
    return { env, store, creator, buyer, reserve };
  }

  it("exposes no value-moving function outside the reviewed set", async function () {
    const { store } = await storeWithAccruedReserve();

    /*
     * Every function on the store that can move value out, and why each is allowed to exist.
     * The set is closed on purpose: a new entry here is a deliberate decision that has to be
     * argued for in review, not something that arrives quietly with a feature.
     */
    const PERMITTED_OUTBOUND = new Set([
      // Bounded by `_ownerAvailableUSDC`, which the reserve was already subtracted from.
      "withdrawOwnerProceeds",
      // Distributor-only, and the destination is the distributor — this is the reserve becoming
      // a dividend, which is the one movement holders are owed.
      "commitHolderReserve",
      // Distributor-only, and it moves USDC *into* the store.
      "returnHolderReserve",
      // Cannot touch canonical USDC or canonical AIC; asserted behaviourally below.
      "rescueToken",
      // Matched on the word "transfer", but it transfers CONTROL, not value. It changes who may
      // later call `withdrawOwnerProceeds` — and that function's bound is unchanged by who calls
      // it, so a new controller inherits exactly the same inability to reach the reserve.
      "transferController",
      // Moves AIC from the reward escrow, bounded by `_rewardPool`. The holder reserve is USDC,
      // a different token entirely, so this cannot express the reserve as an amount at all.
      "withdrawRewardPool",
    ]);

    const suspicious = /withdraw|sweep|drain|claim|rescue|transfer|send|payout|extract|collect|skim|commit|return/i;
    const found = [];
    store.store.interface.forEachFunction((fn) => {
      if (fn.stateMutability === "view" || fn.stateMutability === "pure") return;
      if (suspicious.test(fn.name)) found.push(fn.name);
    });

    for (const name of found) {
      expect(
        PERMITTED_OUTBOUND.has(name),
        `${name}() can move value and is not in the reviewed set. If it is legitimate, add it to ` +
          `PERMITTED_OUTBOUND with the reason it cannot reach the holder reserve — and prove that ` +
          `with a test in this file.`
      ).to.equal(true);
    }

    // And the reverse direction: every permitted name must still exist, so a rename cannot
    // silently empty the allow-list and make this assertion vacuous.
    for (const name of PERMITTED_OUTBOUND) {
      expect(store.store.interface.getFunction(name), `${name}() disappeared`).to.not.equal(null);
    }
  });

  it("cannot express the reserve through the reward-pool path, which is a different token", async function () {
    const { env, store, creator, reserve } = await storeWithAccruedReserve();
    const usdcHeldBefore = await env.usdc.balanceOf(await store.store.getAddress());

    // `withdrawRewardPool` is bounded by the AIC escrow. Asking it for the reserve amount is
    // asking for AIC, not USDC, and it is refused on a bound that has nothing to do with USDC.
    await expect(
      store.store.connect(creator).withdrawRewardPool(reserve, creator.address)
    ).to.be.revertedWithCustomError(store.store, "InsufficientRewardPool");

    expect(await env.usdc.balanceOf(await store.store.getAddress())).to.equal(usdcHeldBefore);
    expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
  });

  it("refuses a controller withdrawal that would dip into the reserve", async function () {
    const { store, creator, reserve } = await storeWithAccruedReserve();
    const available = await store.store.ownerAvailableUSDC();

    // One base unit past what is genuinely the owner's. Off-by-one is the interesting case: a
    // bound written as `>=` instead of `>` would let exactly this through.
    await expect(
      store.store.connect(creator).withdrawOwnerProceeds(available + 1n, creator.address)
    ).to.be.revertedWithCustomError(store.store, "InsufficientOwnerBalance");

    // And the whole reserve, which is what an actual attempt would look like.
    await expect(
      store.store.connect(creator).withdrawOwnerProceeds(available + reserve, creator.address)
    ).to.be.revertedWithCustomError(store.store, "InsufficientOwnerBalance");
  });

  it("does not let a NEW controller reach the reserve either", async function () {
    const { env, store, creator, reserve } = await storeWithAccruedReserve();
    const successor = env.signers[8];

    // The allow-list above permits `transferController` on the grounds that handing over control
    // hands over no additional reach. That is an assertion about behaviour, so it is asserted.
    await (await store.store.connect(creator).transferController(successor.address)).wait();

    const available = await store.store.ownerAvailableUSDC();
    await expect(
      store.store.connect(successor).withdrawOwnerProceeds(available + reserve, successor.address)
    ).to.be.revertedWithCustomError(store.store, "InsufficientOwnerBalance");

    await expect(
      store.store.connect(successor).commitHolderReserve(reserve)
    ).to.be.revertedWithCustomError(store.store, "NotDistributor");

    expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
  });

  it("leaves the store empty after the owner withdraws everything they can", async function () {
    const { env, store, creator, reserve } = await storeWithAccruedReserve();
    const available = await store.store.ownerAvailableUSDC();

    await (
      await store.store.connect(creator).withdrawOwnerProceeds(available, creator.address)
    ).wait();

    expect(await store.store.ownerAvailableUSDC()).to.equal(0n);
    expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
    expect(await store.store.lifetimeHolderReserveAccruedUSDC()).to.equal(reserve);

    // The holders' share was never there to take: the store is now genuinely empty.
    expect(await env.usdc.balanceOf(await store.store.getAddress())).to.equal(0n);

    /*
     * A second withdrawal of even one unit now fails because nothing is available.
     *
     * The cooldown has to be stepped past first, or the revert would be WithdrawalTooSoon and this
     * test would pass for the wrong reason — it is asserting that the reserve is UNREACHABLE, not
     * that the timer is running.
     */
    await time.increase(3 * 60 * 60);
    await expect(
      store.store.connect(creator).withdrawOwnerProceeds(1n, creator.address)
    ).to.be.revertedWithCustomError(store.store, "InsufficientOwnerBalance");
  });

  it("refuses commitHolderReserve from anyone but the distributor", async function () {
    const { env, store, creator, reserve } = await storeWithAccruedReserve();

    for (const who of [creator, env.signers[9], env.deployer]) {
      await expect(
        store.store.connect(who).commitHolderReserve(reserve),
        "only the distributor may move the reserve"
      ).to.be.revertedWithCustomError(store.store, "NotDistributor");
    }

    expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
  });

  it("refuses to rescue canonical USDC, which is what the owner's proceeds are held in", async function () {
    const { env, store, creator, reserve } = await storeWithAccruedReserve();

    // `rescueToken` is the function an operator would reach for if the bound were missing: it
    // moves an entire token balance to an address of the caller's choosing.
    await expect(
      store.store.connect(creator).rescueToken(await env.usdc.getAddress(), creator.address)
    ).to.be.reverted;

    await expect(
      store.store.connect(creator).rescueToken(await store.aic.getAddress(), creator.address)
    ).to.be.reverted;

    expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
  });

  it("gives the protocol treasury no path to a store's reserve at all", async function () {
    const { env, store, reserve } = await storeWithAccruedReserve();

    // The treasury's withdrawal is bounded by its own accounted ledger, which is credited only
    // by `recordRevenue` from a canonical contract. A store's reserve was never recorded there,
    // so it cannot appear in that bound no matter how much reserve exists.
    const accounted = await env.treasury.accountedBalance(await env.usdc.getAddress());

    await expect(
      env.treasury.withdraw(await env.usdc.getAddress(), accounted + reserve)
    ).to.be.reverted;

    // Withdrawing exactly the accounted amount still works — the bound is the ledger, not a freeze.
    if (accounted > 0n) {
      await (await env.treasury.withdraw(await env.usdc.getAddress(), accounted)).wait();
      expect(await env.treasury.accountedBalance(await env.usdc.getAddress())).to.equal(0n);
    }

    expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
  });
});
