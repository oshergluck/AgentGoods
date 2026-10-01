const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  deployProtocol,
  createStore,
  fundUSDC,
  StoreType,
  MarketPhase,
  USDC,
} = require("./helpers/deploy");

/**
 * Whole-lifecycle economic simulation.
 *
 * The existing fuzz suite (08) checks invariants at each step: that splitting a purchase cannot
 * extract more than one purchase, that a reward preview matches its execution, that the transition
 * boundary behaves. Those are local properties, and they all hold.
 *
 * This suite asks a different and strictly harder question: **after an entire store lifecycle —
 * hundreds of trades, commerce, rewards and a real DEX listing — is all the money still
 * accounted for?**
 *
 * The reason that is not implied by the local checks: value conservation can fail across a seam
 * that no single step owns. A rounding rule that is correct in isolation, applied in one direction
 * on the way in and another on the way out, loses money slowly and no individual assertion notices.
 * The transition is the sharpest seam of all — it moves every USDC in the curve into a Uniswap pool
 * in one transaction, and it is irreversible.
 *
 * So the assertion here is a closed-system one. Every USDC that enters is minted by the test, so
 * the total is known exactly. At the end, every USDC must be findable in one of the places it is
 * allowed to be. Nothing may be missing, and nothing may have appeared.
 */
describe("Whole-lifecycle economic simulation", function () {
  this.timeout(900000);

  const PRODUCT = ethers.id("sim-product");
  const PRICE = USDC(50);

  /** Deterministic, so a failure is reproducible from its seed rather than "sometimes". */
  function makeRandom(seed) {
    let state = BigInt(seed) || 1n;
    return () => {
      state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return Number((state >> 33n) % 1000000n) / 1000000;
    };
  }

  /**
   * Every USDC the simulation creates, tracked at the source.
   *
   * Deliberately NOT read back from the chain: the point is to compare an independently kept
   * external ledger against what the protocol says. Deriving the total from protocol state would
   * make the assertion circular and it would pass against a protocol that had lost money
   * consistently.
   */
  class Ledger {
    constructor() {
      this.minted = 0n;
      this.actors = new Set();
    }
    async fund(env, account, amount, spender) {
      await fundUSDC(env, account, amount, spender);
      this.minted += amount;
      this.actors.add(account.address);
    }
  }

  async function usdcAt(env, address) {
    return env.usdc.balanceOf(address);
  }

  it("conserves every USDC across commerce, curve trading and a real DEX listing", async function () {
    const random = makeRandom(20260923);
    // The real Uniswap artifacts: the listing is the seam this test exists to check, so testing it
    // against a mock router would leave exactly the gap the test is for.
    const env = await deployProtocol({ realDex: true });
    const ledger = new Ledger();

    const creator = env.signers[5];
    const store = await createStore(env, creator, StoreType.Sales, { aicSymbol: "SIM" });
    // createStore minted the creator's initial market capital; it is part of what must be conserved.
    ledger.minted += store.seedUSDC;
    const storeAddress = await store.store.getAddress();
    const aicAddress = await store.aic.getAddress();
    const shopAddress = await env.agentGoods.getAddress();

    await (
      await store.store
        .connect(creator)
        .createProduct(PRODUCT, PRICE, 1000000, 0, ethers.ZeroHash, "", { tokensSaved: 1000n, modelTier: ethers.encodeBytes32String("gpt-6-luna"), basis: 1, declaredAt: 0n })
    ).wait();

    const traders = [6, 7, 8, 9].map((i) => env.signers[i]);

    // ---------------------------------------------------------------- phase 1
    // Interleaved commerce and curve trading, which is how a real store behaves and which is the
    // arrangement most likely to expose a seam between the two accounting systems.
    let purchases = 0;
    for (let round = 0; round < 12; round++) {
      const buyer = traders[Math.floor(random() * traders.length)];

      if (random() < 0.5) {
        await ledger.fund(env, buyer, PRICE, storeAddress);
        await (
          await store.store.connect(buyer).purchase(PRODUCT, 1, 1, PRICE, ethers.ZeroHash, "")
        ).wait();
        purchases++;
      } else {
        const gross = USDC(5 + Math.floor(random() * 20));
        await ledger.fund(env, buyer, gross, shopAddress);
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
        await (await env.agentGoods.connect(buyer).buy(aicAddress, gross, 0, deadline)).wait();
      }
    }
    expect(purchases, "the simulation must have exercised commerce").to.be.greaterThan(0);

    // Some sells too, so the curve is exercised in both directions before the transition.
    for (const trader of traders) {
      const bal = await store.aic.balanceOf(trader.address);
      if (bal === 0n) continue;
      const portion = bal / 4n;
      if (portion === 0n) continue;
      await (await store.aic.connect(trader).approve(shopAddress, portion)).wait();
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(trader).sell(aicAddress, portion, 0, deadline)).wait();
    }

    // ---------------------------------------------------------------- phase 2
    // Drive all the way to the DEX listing.
    const whale = env.signers[3];
    let transitioned = false;
    for (let i = 0; i < 500 && !transitioned; i++) {
      const gross = USDC(500);
      await ledger.fund(env, whale, gross, shopAddress);
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(whale).buy(aicAddress, gross, 0, deadline)).wait();
      transitioned = (await env.agentGoods.market(aicAddress)).phase === BigInt(MarketPhase.ExternalDex);
    }
    expect(transitioned, "the simulation must reach the DEX listing").to.equal(true);

    const market = await env.agentGoods.market(aicAddress);
    const pair = market.pair;
    expect(pair).to.not.equal(ethers.ZeroAddress);

    // ---------------------------------------------------------------- phase 3
    // More commerce AFTER the listing. Commerce is independent of market phase, and a store whose
    // accounting quietly changed at the transition would show up here rather than earlier. Each
    // purchase's buyback now swaps through the real pool and burns what it receives.
    const pairUsdcBeforeCommerce = await usdcAt(env, pair);
    const supplyBeforeCommerce = await store.aic.totalSupply();
    for (let round = 0; round < 6; round++) {
      const buyer = traders[Math.floor(random() * traders.length)];
      await ledger.fund(env, buyer, PRICE, storeAddress);
      await (
        await store.store.connect(buyer).purchase(PRODUCT, 1, 1, PRICE, ethers.ZeroHash, "")
      ).wait();
    }

    expect(await usdcAt(env, pair), "post-listing buybacks paid USDC into the pool").to.be.greaterThan(
      pairUsdcBeforeCommerce
    );
    expect(await store.aic.totalSupply(), "post-listing buybacks burned AIC").to.be.lessThan(supplyBeforeCommerce);
    expect(await env.agentGoods.pendingBuybackUSDC(aicAddress), "no buyback was deferred").to.equal(0n);

    // Every unit of the holders' share was bought back (curve or pool); none sits in the store.
    const buybacks = await env.agentGoods.queryFilter(env.agentGoods.filters.BuybackBurned(aicAddress));
    const boughtBack = buybacks.reduce((a, e) => a + e.args.usdcIn, 0n);
    expect(boughtBack).to.equal(await store.store.lifetimeHolderReserveAccruedUSDC());
    expect(boughtBack, "commerce must have funded buybacks").to.be.greaterThan(0n);
    expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);

    // ---------------------------------------------------------------- phase 4
    // The owner takes what is theirs. This is the moment an over-generous bound would show.
    const ownerAvailable = await store.store.ownerAvailableUSDC();
    if (ownerAvailable > 0n) {
      await (
        await store.store.connect(creator).withdrawOwnerProceeds(ownerAvailable, creator.address)
      ).wait();
    }

    // The operator takes protocol fees.
    const usdcAddress = await env.usdc.getAddress();
    const accounted = await env.treasury.accountedBalance(usdcAddress);
    if (accounted > 0n) {
      await (await env.treasury.withdraw(usdcAddress, accounted)).wait();
    }

    // ------------------------------------------------------------ the audit
    /*
     * Every place a USDC is permitted to be at the end. If the sum does not equal what was minted,
     * either the protocol lost money or this list is missing a location — and both of those are
     * findings worth having.
     */
    const locations = {
      storeContract: await usdcAt(env, storeAddress),
      agentGoods: await usdcAt(env, shopAddress),
      treasury: await usdcAt(env, await env.treasury.getAddress()),
      treasuryDestination: await usdcAt(env, env.treasuryDest.address),
      dexPair: await usdcAt(env, pair),
      distributor: await usdcAt(env, await store.distributor.getAddress()),
      storeOwner: await usdcAt(env, creator.address),
    };
    for (const address of ledger.actors) {
      locations[`actor:${address}`] = await usdcAt(env, address);
    }
    // The deployer funds nothing here but may hold USDC from protocol setup; count it so the
    // assertion is about conservation rather than about who happens to hold what.
    locations.deployer = await usdcAt(env, env.deployer.address);

    const found = Object.values(locations).reduce((a, b) => a + b, 0n);

    /*
     * Guards against the assertion passing for an uninteresting reason. A conservation check over a
     * simulation that moved almost nothing, or that never actually listed, is satisfied trivially
     * and proves nothing — so the shape of the run is asserted before its arithmetic.
     */
    expect(ledger.minted, "the simulation must have moved real money").to.be.greaterThan(USDC(1000));
    expect(locations.dexPair, "the listing must have funded the pool").to.be.greaterThan(0n);
    expect(locations.treasuryDestination, "the operator must have earned fees").to.be.greaterThan(0n);
    // The owner withdrew everything available and the holders' share was bought back at purchase
    // time, so the store holds nothing at all.
    expect(locations.storeContract, "the store holds no reserve after the owner withdraws").to.equal(0n);

    const detail = Object.entries(locations)
      .filter(([, v]) => v > 0n)
      .map(([k, v]) => `    ${k.padEnd(50)} ${v}`)
      .join("\n");

    expect(
      found,
      `USDC is not conserved.\n  minted: ${ledger.minted}\n  found:  ${found}\n` +
        `  delta:  ${found - ledger.minted}\n  locations:\n${detail}`
    ).to.equal(ledger.minted);
  });

  it("leaves the curve with no USDC and no inventory after listing", async function () {
    const env = await deployProtocol({ realDex: true });
    const creator = env.signers[5];
    const store = await createStore(env, creator, StoreType.Sales, { aicSymbol: "DRN" });
    const aicAddress = await store.aic.getAddress();
    const shopAddress = await env.agentGoods.getAddress();
    const whale = env.signers[3];

    let transitioned = false;
    for (let i = 0; i < 500 && !transitioned; i++) {
      await fundUSDC(env, whale, USDC(500), shopAddress);
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(whale).buy(aicAddress, USDC(500), 0, deadline)).wait();
      transitioned = (await env.agentGoods.market(aicAddress)).phase === BigInt(MarketPhase.ExternalDex);
    }
    expect(transitioned).to.equal(true);

    const market = await env.agentGoods.market(aicAddress);

    // Everything that was the curve's is now either in the pool or burned. A non-zero residue here
    // would be USDC stranded in a contract with no function that can reach it — money destroyed
    // rather than money moved, and invisible to a balance-delta check.
    expect(market.realUSDCReserve, "the curve must retain no USDC").to.equal(0n);
    expect(market.tokenInventory, "the curve must retain no inventory").to.equal(0n);

    // The exception, and it is accounted for: controller fees accrued before the transition are
    // still owed to the controller and are withdrawn separately.
    const shopHeld = await env.usdc.balanceOf(shopAddress);
    expect(
      shopHeld,
      "AgentGoods may hold only unwithdrawn controller fees after a listing"
    ).to.equal(market.controllerFeesUSDC);
  });

  it("never lets total AIC exceed genesis, across the whole lifecycle", async function () {
    const env = await deployProtocol({ realDex: true });
    const creator = env.signers[5];
    const store = await createStore(env, creator, StoreType.Sales, { aicSymbol: "SUP" });
    const aicAddress = await store.aic.getAddress();
    const shopAddress = await env.agentGoods.getAddress();
    const genesis = await store.aic.totalSupply();

    // F-004 was a doubled genesis supply that no test noticed because every assertion checked
    // deltas. This one checks the absolute, at every stage.
    expect(genesis).to.equal(ethers.parseUnits("1000000000", 18));

    const whale = env.signers[3];
    let transitioned = false;
    for (let i = 0; i < 500 && !transitioned; i++) {
      await fundUSDC(env, whale, USDC(500), shopAddress);
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(whale).buy(aicAddress, USDC(500), 0, deadline)).wait();
      expect(await store.aic.totalSupply()).to.be.lessThanOrEqual(genesis);
      transitioned = (await env.agentGoods.market(aicAddress)).phase === BigInt(MarketPhase.ExternalDex);
    }

    // The transition burns; supply may only ever go down.
    expect(await store.aic.totalSupply()).to.be.lessThan(genesis);
  });
});
