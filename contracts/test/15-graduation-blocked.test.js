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
 * Graduation is abandoned when a funded external pool already exists.
 *
 * The attack this answers: anyone can create and fund a Uniswap pair for a store's AIC before the
 * bonding curve reaches 30%. At the listing, the router prices our deposit against whatever ratio
 * that pool already has.
 *
 * What the code did BEFORE this change, measured rather than assumed: the 1% slippage bound refused
 * every hostile ratio, so no USDC was ever given away — good. But the refusal happened inside
 * `buy`, so the purchase that crossed the threshold reverted, and so did every purchase after it.
 * A token could be stranded permanently, unable to be bought past 30%, for the cost of seeding a
 * pool with **one millionth of a USDC**. That was the real damage: not theft, a denial of service
 * with a floor price of dust.
 *
 * What it does now: at the moment the threshold is first reached, it checks for a funded pool. If
 * there is one, the market gives up on graduating — permanently and explicitly — and carries on
 * trading on its bonding curve. The purchase that triggered the check succeeds normally.
 */
describe("Graduation is abandoned when a pool was opened first", function () {
  this.timeout(900000);

  async function fixture() {
    const env = await deployProtocol({ realDex: true });
    const creator = env.signers[5];
    const store = await createStore(env, creator, StoreType.Sales, { aicSymbol: "GRD" });
    return { env, store, whale: env.signers[4], attacker: env.signers[13] };
  }

  /** Buys until the market either lists or stops being able to list. Never swallows a revert. */
  async function driveToThreshold(env, store, whale, maxRounds = 400) {
    const aicToken = await store.aic.getAddress();
    for (let i = 0; i < maxRounds; i++) {
      const m = await env.agentGoods.market(aicToken);
      if (Number(m.phase) === MarketPhase.ExternalDex || m.graduationBlocked) return m;
      await fundUSDC(env, whale, USDC(500), await env.agentGoods.getAddress());
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(whale).buy(aicToken, USDC(500), 0, deadline)).wait();
    }
    return env.agentGoods.market(aicToken);
  }

  /** Seeds a real pool at an arbitrary ratio, the way an attacker would. */
  async function seedPool(env, store, attacker, usdcAmount, tokenDivisor) {
    const aicToken = await store.aic.getAddress();
    const usdcAddress = await env.usdc.getAddress();
    const router = await env.uniswap.router.getAddress();

    await fundUSDC(env, attacker, USDC(300), await env.agentGoods.getAddress());
    let deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (await env.agentGoods.connect(attacker).buy(aicToken, USDC(300), 0, deadline)).wait();

    const held = await store.aic.balanceOf(attacker.address);
    const seedTokens = held / tokenDivisor;
    const existing = await env.uniswap.factory.getPair(usdcAddress, aicToken);
    if (existing === ethers.ZeroAddress) {
      await (await env.uniswap.factory.createPair(usdcAddress, aicToken)).wait();
    }
    await fundUSDC(env, attacker, usdcAmount, router);
    await (await store.aic.connect(attacker).approve(router, seedTokens)).wait();
    deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (
      await env.uniswap.router
        .connect(attacker)
        .addLiquidity(usdcAddress, aicToken, usdcAmount, seedTokens, 0, 0, attacker.address, deadline)
    ).wait();
  }

  it("blocks graduation instead of reverting, and the triggering purchase still succeeds", async function () {
    const { env, store, whale, attacker } = await loadFixture(fixture);
    await seedPool(env, store, attacker, USDC(5000), 1000n);

    // The whole point: this must NOT throw. Before the change, it did.
    const m = await driveToThreshold(env, store, whale);

    expect(m.graduationBlocked, "the market must record that it can never list").to.equal(true);
    expect(Number(m.phase), "it stays on the bonding curve").to.equal(MarketPhase.BondingCurve);
    expect(m.netSoldFromCurve).to.be.greaterThanOrEqual(ethers.parseUnits("300000000", 18));
  });

  it("keeps the curve fully usable afterwards, in both directions", async function () {
    const { env, store, whale, attacker } = await loadFixture(fixture);
    await seedPool(env, store, attacker, USDC(5000), 1000n);
    await driveToThreshold(env, store, whale);

    const aicToken = await store.aic.getAddress();
    const shopAddress = await env.agentGoods.getAddress();
    const buyer = env.signers[8];

    // Buying past the threshold works — this is what was impossible before.
    await fundUSDC(env, buyer, USDC(100), shopAddress);
    let deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (await env.agentGoods.connect(buyer).buy(aicToken, USDC(100), 0, deadline)).wait();
    const bought = await store.aic.balanceOf(buyer.address);
    expect(bought, "a purchase beyond the threshold must deliver tokens").to.be.greaterThan(0n);

    // And selling back works, so nobody is trapped in a token that cannot list.
    await (await store.aic.connect(buyer).approve(shopAddress, bought)).wait();
    const usdcBefore = await env.usdc.balanceOf(buyer.address);
    deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (await env.agentGoods.connect(buyer).sell(aicToken, bought, 0, deadline)).wait();
    expect(await env.usdc.balanceOf(buyer.address)).to.be.greaterThan(usdcBefore);
  });

  it("emits GraduationBlocked once, naming the pool responsible", async function () {
    const { env, store, whale, attacker } = await loadFixture(fixture);
    await seedPool(env, store, attacker, USDC(5000), 1000n);

    const aicToken = await store.aic.getAddress();
    const pair = await env.uniswap.factory.getPair(await env.usdc.getAddress(), aicToken);

    const before = await ethers.provider.getBlockNumber();
    await driveToThreshold(env, store, whale);

    const events = await env.agentGoods.queryFilter(
      env.agentGoods.filters.GraduationBlocked(aicToken),
      before
    );
    expect(events.length, "exactly one GraduationBlocked").to.equal(1);
    expect(events[0].args.blockingPair).to.equal(pair);
    expect(events[0].args.poolReserveUSDC, "the event must report the pool's real reserves").to.be.greaterThan(0n);

    // Continuing to trade must not emit it again.
    const buyer = env.signers[8];
    await fundUSDC(env, buyer, USDC(200), await env.agentGoods.getAddress());
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (await env.agentGoods.connect(buyer).buy(aicToken, USDC(200), 0, deadline)).wait();

    const after = await env.agentGoods.queryFilter(
      env.agentGoods.filters.GraduationBlocked(aicToken),
      before
    );
    expect(after.length, "the event is emitted once, not per trade").to.equal(1);
  });

  it("is permanent: draining the hostile pool afterwards does not restore graduation", async function () {
    const { env, store, whale, attacker } = await loadFixture(fixture);
    await seedPool(env, store, attacker, USDC(5000), 1000n);
    await driveToThreshold(env, store, whale);

    const aicToken = await store.aic.getAddress();
    const usdcAddress = await env.usdc.getAddress();
    const pairAddress = await env.uniswap.factory.getPair(usdcAddress, aicToken);
    const pair = await ethers.getContractAt("IERC20", pairAddress);
    const router = await env.uniswap.router.getAddress();

    // The attacker withdraws everything, so the pool is empty again.
    const lp = await pair.balanceOf(attacker.address);
    await (await pair.connect(attacker).approve(router, lp)).wait();
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (
      await env.uniswap.router
        .connect(attacker)
        .removeLiquidity(usdcAddress, aicToken, lp, 0, 0, attacker.address, deadline)
    ).wait();

    // More buying must not resurrect the listing. A decision that could be undone by the attacker
    // would let them choose the moment of graduation, which is worse than never graduating.
    const buyer = env.signers[8];
    for (let i = 0; i < 3; i++) {
      await fundUSDC(env, buyer, USDC(500), await env.agentGoods.getAddress());
      const d = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(buyer).buy(aicToken, USDC(500), 0, d)).wait();
    }

    const m = await env.agentGoods.market(aicToken);
    expect(m.graduationBlocked).to.equal(true);
    expect(Number(m.phase)).to.equal(MarketPhase.BondingCurve);
  });

  it("an EMPTY pair does not block: it lists normally", async function () {
    const { env, store, whale } = await loadFixture(fixture);
    const aicToken = await store.aic.getAddress();

    /*
     * This is the case that decides the whole design. `createPair` is permissionless and needs no
     * capital, so if mere existence disqualified a market, anyone could permanently block any
     * token's graduation for ordinary gas — the mitigation would be cheaper to abuse than the
     * attack. An unfunded pool is harmless because `addLiquidity` into an empty pair mints the
     * initial liquidity at OUR ratio, which is what creating it ourselves would have done.
     */
    await (await env.uniswap.factory.createPair(await env.usdc.getAddress(), aicToken)).wait();

    const m = await driveToThreshold(env, store, whale);
    expect(m.graduationBlocked, "an empty pair must not block graduation").to.equal(false);
    expect(Number(m.phase), "it must list normally").to.equal(MarketPhase.ExternalDex);
  });

  it("still lists normally when no pair exists at all", async function () {
    const { env, store, whale } = await loadFixture(fixture);
    const m = await driveToThreshold(env, store, whale);
    expect(m.graduationBlocked).to.equal(false);
    expect(Number(m.phase)).to.equal(MarketPhase.ExternalDex);
  });

  it("tells a caller through quoteBuy, rather than leaving them to infer it", async function () {
    const { env, store, whale, attacker } = await loadFixture(fixture);
    const aicToken = await store.aic.getAddress();

    const clean = await env.agentGoods.quoteBuy(aicToken, USDC(100));
    expect(clean.graduationBlocked).to.equal(false);

    await seedPool(env, store, attacker, USDC(5000), 1000n);

    // Reported from the live pool BEFORE the threshold is ever reached, so an Agent sizing a
    // purchase to trigger the listing learns it will not, instead of discovering it afterwards.
    const early = await env.agentGoods.quoteBuy(aicToken, USDC(100));
    expect(early.graduationBlocked, "a funded pool must be visible in a quote immediately").to.equal(true);
    expect(early.willTriggerTransition).to.equal(false);

    await driveToThreshold(env, store, whale);

    // And no purchase of any size can graduate it, however large.
    const huge = await env.agentGoods.quoteBuy(aicToken, USDC(1000000));
    expect(huge.graduationBlocked).to.equal(true);
    expect(huge.willTriggerTransition, "no amount graduates a blocked market").to.equal(false);
  });

  it("does not give the attacker the protocol's USDC in any case", async function () {
    const { env, store, whale, attacker } = await loadFixture(fixture);
    await seedPool(env, store, attacker, USDC(5000), 1000n);

    const aicToken = await store.aic.getAddress();
    const usdcAddress = await env.usdc.getAddress();
    const pairAddress = await env.uniswap.factory.getPair(usdcAddress, aicToken);
    const poolBefore = await env.usdc.balanceOf(pairAddress);

    await driveToThreshold(env, store, whale);

    // The protocol contributed nothing to the attacker's pool, and kept its own reserve.
    expect(await env.usdc.balanceOf(pairAddress)).to.equal(poolBefore);
    const m = await env.agentGoods.market(aicToken);
    expect(m.realUSDCReserve, "the curve keeps its USDC").to.be.greaterThan(0n);
    expect(m.lpUSDCUsed).to.equal(0n);
    expect(
      await env.usdc.allowance(await env.agentGoods.getAddress(), await env.uniswap.router.getAddress()),
      "no approval is left standing"
    ).to.equal(0n);
  });

  it("blocks on a dust-seeded pool too, since that is the cheapest grief", async function () {
    const { env, store, whale, attacker } = await loadFixture(fixture);
    // One millionth of a USDC. If this did not block, it would revert instead — which is worse.
    await seedPool(env, store, attacker, 1n, 1000000n);

    const m = await driveToThreshold(env, store, whale);
    expect(m.graduationBlocked).to.equal(true);
    expect(Number(m.phase)).to.equal(MarketPhase.BondingCurve);
  });
});
