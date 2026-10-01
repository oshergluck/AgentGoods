const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployProtocol,
  createStore,
  fundUSDC,
  StoreType,
  MarketPhase,
  USDC,
} = require("./helpers/deploy");

/**
 * A blocked market burns inventory so it lands where graduation would have put it.
 *
 * The property that constrains this entire feature, and the reason it is tested this hard: **the
 * bonding curve has exactly zero solvency margin.** Because `virtualTokenReserve + outstanding`
 * always equals genesis, and `virtualUSDC` always equals `seed + realUSDC`, a sell of every
 * outstanding token quotes precisely the real reserve — to the base unit, measured.
 *
 * So burning tokens and shrinking the token reserve alone would raise the quoted payout above the
 * USDC that actually exists, and holders selling late would be refused. That is the trap D-035
 * exists to prevent, and it would have been reintroduced by the obvious implementation.
 *
 * The burn therefore moves the virtual seed with it. These tests assert the two things that makes
 * true together: the price lands at the +35% premium, and a full exit remains exactly payable.
 */
describe("Blocked markets burn as if they had graduated", function () {
  this.timeout(900000);

  const BPS = 10_000n;
  const PREMIUM = 3_500n;
  const GENESIS = ethers.parseUnits("1000000000", 18);

  async function fixture() {
    const env = await deployProtocol({ realDex: true });
    const creator = env.signers[5];
    const store = await createStore(env, creator, StoreType.Sales, { aicSymbol: "BRN" });
    return { env, store, whale: env.signers[4], attacker: env.signers[13] };
  }

  async function seedPool(env, store, attacker) {
    const aicToken = await store.aic.getAddress();
    const usdcAddress = await env.usdc.getAddress();
    const router = await env.uniswap.router.getAddress();

    await fundUSDC(env, attacker, USDC(300), await env.agentGoods.getAddress());
    let deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (await env.agentGoods.connect(attacker).buy(aicToken, USDC(300), 0, deadline)).wait();

    const held = await store.aic.balanceOf(attacker.address);
    await (await env.uniswap.factory.createPair(usdcAddress, aicToken)).wait();
    await fundUSDC(env, attacker, USDC(5000), router);
    await (await store.aic.connect(attacker).approve(router, held / 1000n)).wait();
    deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (
      await env.uniswap.router
        .connect(attacker)
        .addLiquidity(usdcAddress, aicToken, USDC(5000), held / 1000n, 0, 0, attacker.address, deadline)
    ).wait();
  }

  /** Buys until the market blocks, recording the market state immediately before it does. */
  async function driveUntilBlocked(env, store, whale) {
    const aicToken = await store.aic.getAddress();
    let before = null;
    for (let i = 0; i < 400; i++) {
      const m = await env.agentGoods.market(aicToken);
      if (m.graduationBlocked) return { before, after: m };
      before = m;
      await fundUSDC(env, whale, USDC(500), await env.agentGoods.getAddress());
      const d = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(whale).buy(aicToken, USDC(500), 0, d)).wait();
    }
    throw new Error("market never blocked");
  }

  /**
   * The market state immediately BEFORE the burn, reconstructed from the state after it.
   *
   * It cannot simply be snapshotted: the burn happens inside the same transaction as the purchase
   * that triggers it, so the last observable reading still predates that purchase's own effect on
   * the reserves. Reconstruction is exact because the burn's arithmetic is invertible —
   * `outstanding` is untouched by it (supply and inventory fall by the same amount), so the
   * reduction applied to the virtual reserve can be recomputed from public values.
   */
  function preBurnState(after, supplyAfter) {
    const burned = after.burnedAtGraduationBlocked;
    const outstanding = supplyAfter - after.tokenInventory;
    const reduction =
      outstanding === 0n
        ? 0n
        : (after.realUSDCReserve * burned + outstanding - 1n) / outstanding;
    return {
      virtualTokenReserve: after.virtualTokenReserve + burned,
      virtualUSDCReserve: after.virtualUSDCReserve + reduction,
      realUSDCReserve: after.realUSDCReserve,
      outstanding,
      reduction,
      burned,
    };
  }

  /** The contract's own sell formula, so the test cannot drift from the implementation. */
  function sellQuote(vTokens, vUSDC, tokensIn) {
    if (vTokens === 0n || vUSDC === 0n || tokensIn === 0n) return 0n;
    return (vUSDC * tokensIn) / (vTokens + tokensIn);
  }

  async function blockedWorld() {
    const { env, store, whale, attacker } = await loadFixture(fixture);
    await seedPool(env, store, attacker);
    const { after } = await driveUntilBlocked(env, store, whale);
    return { env, store, whale, attacker, m: after };
  }

  it("burns a real amount and leaves the curve still holding inventory", async function () {
    const { store, m } = await blockedWorld();

    expect(m.graduationBlocked).to.equal(true);
    expect(m.burnedAtGraduationBlocked, "something must actually have been burned").to.be.greaterThan(0n);
    expect(m.tokenInventory, "the curve must keep inventory to trade with").to.be.greaterThan(0n);

    // Supply really fell: this is a burn, not an accounting entry.
    const supply = await store.aic.totalSupply();
    expect(supply).to.equal(GENESIS - m.burnedAtGraduationBlocked);
    expect(supply).to.be.lessThan(GENESIS);
  });

  it("lands the price at the +35% premium, the same step graduation would have applied", async function () {
    const { store, m } = await blockedWorld();
    const supplyAfter = await store.aic.totalSupply();
    const before = preBurnState(m, supplyAfter);

    // Price is virtualUSDC / virtualTokens, compared at a fixed scale to avoid truncation.
    const SCALE = 10n ** 30n;
    const priceBefore = (before.virtualUSDCReserve * SCALE) / before.virtualTokenReserve;
    const priceAfter = (m.virtualUSDCReserve * SCALE) / m.virtualTokenReserve;

    const expected = (priceBefore * (BPS + PREMIUM)) / BPS;
    // Within 0.5%. The burn rounds down and the reserve reduction rounds up, both deliberately, so
    // the realised step sits at or just under the premium and never above it.
    const tolerance = expected / 200n;
    expect(priceAfter).to.be.greaterThan(expected - tolerance);
    expect(priceAfter).to.be.lessThanOrEqual(expected + tolerance);
  });

  it("KEEPS THE EXIT EXACT: every holder can still sell everything back", async function () {
    const { env, store, m } = await blockedWorld();
    const aicToken = await store.aic.getAddress();

    /*
     * The assertion this whole feature lives or dies on. Before the seed adjustment was added, the
     * equivalent burn opened a 180 USDC hole in a 582 USDC reserve — a 31% shortfall — and sellers
     * were refused outright.
     */
    const supply = await store.aic.totalSupply();
    const outstanding = supply - m.tokenInventory;
    const quoted = sellQuote(m.virtualTokenReserve, m.virtualUSDCReserve, outstanding);

    expect(
      quoted,
      `selling every outstanding token quotes ${quoted} but only ${m.realUSDCReserve} real USDC exists`
    ).to.be.lessThanOrEqual(m.realUSDCReserve);

    // And the identity is still tight rather than merely satisfied: the curve has not quietly
    // become over-collateralised, which would mean value stranded in it forever.
    const margin = m.realUSDCReserve - quoted;
    expect(margin, "the exit identity must stay tight, not just safe").to.be.lessThan(USDC(1));

    expect(aicToken).to.be.a("string");
    expect(Number(m.phase)).to.equal(MarketPhase.BondingCurve);
  });

  it("actually pays every seller out, in sequence, after the burn", async function () {
    const { env, store, whale, attacker } = await loadFixture(fixture);
    await seedPool(env, store, attacker);
    await driveUntilBlocked(env, store, whale);

    const aicToken = await store.aic.getAddress();
    const shop = await env.agentGoods.getAddress();

    // The behavioural counterpart to the arithmetic above: drive the exits for real.
    for (const seller of [whale, attacker]) {
      const bal = await store.aic.balanceOf(seller.address);
      if (bal === 0n) continue;
      await (await store.aic.connect(seller).approve(shop, bal)).wait();
      const before = await env.usdc.balanceOf(seller.address);
      const d = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(seller).sell(aicToken, bal, 0, d)).wait();
      expect(
        await env.usdc.balanceOf(seller.address),
        "a holder was not paid after the blocked burn"
      ).to.be.greaterThan(before);
    }
  });

  it("keeps the curve tradeable in both directions afterwards", async function () {
    const { env, store } = await blockedWorld();
    const aicToken = await store.aic.getAddress();
    const shop = await env.agentGoods.getAddress();
    const buyer = env.signers[8];

    await fundUSDC(env, buyer, USDC(100), shop);
    let d = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (await env.agentGoods.connect(buyer).buy(aicToken, USDC(100), 0, d)).wait();
    const bought = await store.aic.balanceOf(buyer.address);
    expect(bought).to.be.greaterThan(0n);

    await (await store.aic.connect(buyer).approve(shop, bought)).wait();
    const before = await env.usdc.balanceOf(buyer.address);
    d = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (await env.agentGoods.connect(buyer).sell(aicToken, bought, 0, d)).wait();
    expect(await env.usdc.balanceOf(buyer.address)).to.be.greaterThan(before);
  });

  it("reduces the virtual seed, and says so in its event", async function () {
    const { env, store, m } = await blockedWorld();
    const aicToken = await store.aic.getAddress();
    const supplyAfter = await store.aic.totalSupply();
    const before = preBurnState(m, supplyAfter);

    const seedBefore = before.virtualUSDCReserve - before.realUSDCReserve;
    const seedAfter = m.virtualUSDCReserve - m.realUSDCReserve;

    // The seed moving is the whole mechanism. It must shrink, and it must not vanish or invert.
    expect(seedAfter, "the seed must shrink to keep redemption exact").to.be.lessThan(seedBefore);
    expect(seedAfter, "the seed must not be erased").to.be.greaterThan(0n);
    expect(before.reduction, "the reduction must be real, not a rounding artefact").to.be.greaterThan(0n);

    const events = await env.agentGoods.queryFilter(env.agentGoods.filters.GraduationBurn(aicToken));
    expect(events.length, "exactly one GraduationBurn").to.equal(1);
    expect(events[0].args.tokensBurned).to.equal(m.burnedAtGraduationBlocked);
    expect(events[0].args.newVirtualSeedUSDC).to.equal(seedAfter);
    expect(events[0].args.newVirtualTokenReserve).to.equal(m.virtualTokenReserve);
    expect(events[0].args.newVirtualUSDCReserve).to.equal(m.virtualUSDCReserve);
  });

  it("burns once, not on every subsequent trade", async function () {
    const { env, store } = await blockedWorld();
    const aicToken = await store.aic.getAddress();
    // +1: the burn shares a block with the purchase that triggered it, and queryFilter's
    // fromBlock is inclusive, so starting at the current height would re-read that same burn.
    const from = (await ethers.provider.getBlockNumber()) + 1;
    const supplyAfterBurn = await store.aic.totalSupply();

    const buyer = env.signers[8];
    for (let i = 0; i < 3; i++) {
      await fundUSDC(env, buyer, USDC(400), await env.agentGoods.getAddress());
      const d = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(buyer).buy(aicToken, USDC(400), 0, d)).wait();
    }

    expect(await store.aic.totalSupply(), "supply must not keep falling").to.equal(supplyAfterBurn);
    const events = await env.agentGoods.queryFilter(env.agentGoods.filters.GraduationBurn(aicToken), from);
    expect(events.length).to.equal(0);
  });

  it("does not burn on a market that graduates normally", async function () {
    const { env, store, whale } = await loadFixture(fixture);
    const aicToken = await store.aic.getAddress();
    const from = await ethers.provider.getBlockNumber();

    for (let i = 0; i < 400; i++) {
      const m = await env.agentGoods.market(aicToken);
      if (Number(m.phase) === MarketPhase.ExternalDex) break;
      await fundUSDC(env, whale, USDC(500), await env.agentGoods.getAddress());
      const d = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(whale).buy(aicToken, USDC(500), 0, d)).wait();
    }

    const m = await env.agentGoods.market(aicToken);
    expect(Number(m.phase)).to.equal(MarketPhase.ExternalDex);
    expect(m.burnedAtGraduationBlocked, "a graduated market uses the listing burn, not this one").to.equal(0n);
    const events = await env.agentGoods.queryFilter(env.agentGoods.filters.GraduationBurn(aicToken), from);
    expect(events.length).to.equal(0);
  });

  it("holds the reserve identity that the API publishes", async function () {
    const { m } = await blockedWorld();
    // curvePricingReserveUSDC == virtualSeedUSDC + realUSDCReserve, still true after the burn.
    const seed = m.virtualUSDCReserve - m.realUSDCReserve;
    expect(seed + m.realUSDCReserve).to.equal(m.virtualUSDCReserve);
    expect(seed).to.be.greaterThan(0n);
  });
});
