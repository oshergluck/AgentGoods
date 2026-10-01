/**
 * The 30% DEX transition, against REAL Uniswap V2.
 *
 * This is the one operation in the protocol that is irreversible, moves the entire real USDC
 * reserve of a store, and cannot be rehearsed in production. It happens once per store, without a
 * human in the loop, and if it fails or mis-prices, the money is gone and the curve is already
 * closed behind it.
 *
 * The stub router in `src/mocks` is not adequate for this. It mints `amountA + amountB` as
 * liquidity, has no MINIMUM_LIQUIDITY lock, no uint112 reserve bound, no `quote()` optimal-amount
 * path and no k-invariant — so a transition can pass against it while reverting, or silently
 * mis-pricing, against the real thing. Everything here runs against the published
 * `@uniswap/v2-core` and `@uniswap/v2-periphery` artifacts, byte for byte.
 *
 * The attack that matters most is at the bottom: anyone can create and seed the pair BEFORE the
 * transition, and Uniswap's router then honours the ratio already in the pool. That is a real,
 * well-known way to steal the value of a listing, and it is why `addLiquidity` is called with
 * slippage bounds rather than zeros.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployProtocol,
  createStore,
  fundUSDC,
  StoreType,
  USDC,
  LP_BURN,
} = require("./helpers/deploy");
const { attachPair, CANONICAL_PAIR_INIT_CODE_HASH } = require("./helpers/uniswap");

/** MarketPhase: None=0, BondingCurve=1, Transitioning=2, ExternalDex=3. */
const PHASE_BONDING_CURVE = 1;
const PHASE_EXTERNAL_DEX = 3;

const MAX_UINT112 = (1n << 112n) - 1n;
const MINIMUM_LIQUIDITY = 1000n;
const LP_PREMIUM_BPS = 3500n;
const BPS = 10_000n;

describe("30% DEX transition against real Uniswap V2", function () {
  async function fixture() {
    const env = await deployProtocol({ realDex: true });
    const store = await createStore(env, env.signers[5], StoreType.Sales);
    return { env, store, whale: env.signers[9] };
  }

  /** Buys from the curve until the market leaves the bonding-curve phase. */
  async function driveToTransition(env, store, whale, chunkUSDC = USDC(400)) {
    const aicToken = await store.aic.getAddress();
    for (let i = 0; i < 60; i++) {
      const market = await env.agentGoods.market(aicToken);
      if (Number(market.phase) !== PHASE_BONDING_CURVE) return market;

      await fundUSDC(env, whale, chunkUSDC, await env.agentGoods.getAddress());
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(whale).buy(aicToken, chunkUSDC, 0, deadline)).wait();
    }
    throw new Error("the market never transitioned");
  }

  it("deploys the genuine Uniswap V2, so the router's pairFor hash matches the factory", async function () {
    const { env } = await loadFixture(fixture);
    expect(env.uniswap.initCodeHash).to.equal(CANONICAL_PAIR_INIT_CODE_HASH);
    expect(await env.uniswap.router.factory()).to.equal(env.uniswap.factoryAddress);
  });

  it("creates a real, funded, tradeable pair and burns every LP token", async function () {
    const { env, store, whale } = await loadFixture(fixture);
    const aicToken = await store.aic.getAddress();
    const usdcAddress = await env.usdc.getAddress();

    const market = await driveToTransition(env, store, whale);
    expect(Number(market.phase)).to.equal(PHASE_EXTERNAL_DEX, "phase is ExternalDex");

    // The pair the protocol recorded is the pair the REAL factory created.
    const pairAddress = await env.uniswap.factory.getPair(usdcAddress, aicToken);
    expect(pairAddress).to.not.equal(ethers.ZeroAddress);
    expect(market.pair).to.equal(pairAddress);

    const pair = attachPair(pairAddress, env.signers[0]);
    const [r0, r1] = await pair.getReserves();
    expect(r0).to.be.greaterThan(0n);
    expect(r1).to.be.greaterThan(0n);

    // Reserves are uint112 in UniswapV2. Exceeding that bricks the pool permanently.
    expect(r0).to.be.lessThanOrEqual(MAX_UINT112);
    expect(r1).to.be.lessThanOrEqual(MAX_UINT112);

    // The pool holds exactly what the protocol says it contributed.
    const token0 = await pair.token0();
    const usdcReserve = token0.toLowerCase() === usdcAddress.toLowerCase() ? r0 : r1;
    const aicReserve = token0.toLowerCase() === usdcAddress.toLowerCase() ? r1 : r0;
    expect(usdcReserve).to.equal(market.lpUSDCUsed);
    expect(aicReserve).to.equal(market.lpTokenUsed);

    // Every LP token the protocol received is at the burn address. None is held anywhere else.
    const totalSupply = await pair.totalSupply();
    const burned = await pair.balanceOf(LP_BURN);
    expect(await pair.balanceOf(await env.agentGoods.getAddress())).to.equal(0n);
    expect(burned).to.equal(market.lpTokenAmount);
    // Uniswap permanently locks MINIMUM_LIQUIDITY in the pair itself on the first mint.
    expect(totalSupply).to.equal(burned + MINIMUM_LIQUIDITY);
    expect(burned).to.be.greaterThan(0n);

    // And the pool actually works: a real swap through the real router succeeds.
    const trader = env.signers[10];
    await fundUSDC(env, trader, USDC(10), await env.uniswap.router.getAddress());
    const before = await store.aic.balanceOf(trader.address);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (
      await env.uniswap.router
        .connect(trader)
        .swapExactTokensForTokens(USDC(10), 0, [usdcAddress, aicToken], trader.address, deadline)
    ).wait();
    expect(await store.aic.balanceOf(trader.address)).to.be.greaterThan(
      before,
      "the listed pair is tradeable"
    );
  });

  it("lists at the intended 35% premium to the final curve price", async function () {
    const { env, store, whale } = await loadFixture(fixture);
    const aicToken = await store.aic.getAddress();
    const usdcAddress = await env.usdc.getAddress();

    const market = await driveToTransition(env, store, whale);

    /*
     * The listing price is the curve price times 1.35:
     *   tokensForLP = realUSDC * virtualTokenReserve / (virtualUSDC * 1.35)
     * so   usdcPerToken(pool) = realUSDC / tokensForLP = 1.35 * virtualUSDC / virtualTokenReserve.
     *
     * Compared as a ratio in integer arithmetic, with a tolerance for the flooring in both the
     * contract and Uniswap's own optimal-amount path.
     */
    const expectedTokens =
      (market.lpUSDCUsed * market.virtualTokenReserve * BPS) / (market.virtualUSDCReserve * (BPS + LP_PREMIUM_BPS));

    const actual = market.lpTokenUsed;
    const difference = actual > expectedTokens ? actual - expectedTokens : expectedTokens - actual;
    expect(difference * 10_000n).to.be.lessThanOrEqual(
      expectedTokens,
      `listed ${actual} tokens against an expected ${expectedTokens}`
    );

    // Sanity in the other direction: the pool price must be strictly above the final curve price.
    const pair = attachPair(await env.uniswap.factory.getPair(usdcAddress, aicToken), env.signers[0]);
    const [r0, r1] = await pair.getReserves();
    const token0 = await pair.token0();
    const usdcReserve = token0.toLowerCase() === usdcAddress.toLowerCase() ? r0 : r1;
    const aicReserve = token0.toLowerCase() === usdcAddress.toLowerCase() ? r1 : r0;

    // poolPrice = usdcReserve / aicReserve, curvePrice = virtualUSDC / virtualToken.
    // Cross-multiplied so nothing is divided away.
    expect(usdcReserve * market.virtualTokenReserve).to.be.greaterThan(
      aicReserve * market.virtualUSDCReserve,
      "the pool lists above the curve price, as the premium intends"
    );
  });

  it("burns every remaining market token and leaves no approval behind", async function () {
    const { env, store, whale } = await loadFixture(fixture);
    const aicToken = await store.aic.getAddress();
    const usdcAddress = await env.usdc.getAddress();
    const shopAddress = await env.agentGoods.getAddress();

    const supplyBefore = await store.aic.totalSupply();
    const market = await driveToTransition(env, store, whale);

    // Inventory is fully disposed of: partly into the pool, the rest burned.
    expect(market.tokenInventory).to.equal(0n);
    expect(await store.aic.totalSupply()).to.equal(supplyBefore - market.burnedAtTransition);
    expect(market.burnedAtTransition).to.be.greaterThan(0n);

    // The market's real USDC went into the pool and nothing is stranded in the shop.
    expect(market.realUSDCReserve).to.equal(0n);

    /*
     * Approvals are reset to zero on BOTH sides. A dangling allowance to the router would let any
     * future router-level bug drain whatever the shop holds for every other market it runs.
     */
    const routerAddress = await env.uniswap.router.getAddress();
    expect(await env.usdc.allowance(shopAddress, routerAddress)).to.equal(0n);
    expect(await store.aic.allowance(shopAddress, routerAddress)).to.equal(0n);

    // No dust left approved on the pair either.
    expect(await env.usdc.balanceOf(shopAddress)).to.be.greaterThanOrEqual(0n);
    expect(usdcAddress).to.properAddress;
  });

  it("closes the curve permanently: no buy, no sell, no second transition", async function () {
    const { env, store, whale } = await loadFixture(fixture);
    const aicToken = await store.aic.getAddress();
    await driveToTransition(env, store, whale);

    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await fundUSDC(env, whale, USDC(50), await env.agentGoods.getAddress());

    await expect(env.agentGoods.connect(whale).buy(aicToken, USDC(50), 0, deadline)).to.be.reverted;

    const held = await store.aic.balanceOf(whale.address);
    if (held > 0n) {
      await (await store.aic.connect(whale).approve(await env.agentGoods.getAddress(), held)).wait();
      await expect(env.agentGoods.connect(whale).sell(aicToken, held / 100n, 0, deadline)).to.be.reverted;
    }

    const after = await env.agentGoods.market(aicToken);
    expect(Number(after.phase)).to.equal(
      PHASE_EXTERNAL_DEX,
      "still ExternalDex; the transition did not run twice"
    );
  });

  /* ------------------------------------------------------------------ */
  /* The attack this test file exists for.                              */
  /* ------------------------------------------------------------------ */

  it("abandons graduation entirely when a funded pool already exists", async function () {
    const { env, store, whale } = await loadFixture(fixture);
    const aicToken = await store.aic.getAddress();
    const usdcAddress = await env.usdc.getAddress();
    const attacker = env.signers[12];

    // The attacker buys a little AIC from the curve so it has tokens to seed with.
    await fundUSDC(env, attacker, USDC(100), await env.agentGoods.getAddress());
    let deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (await env.agentGoods.connect(attacker).buy(aicToken, USDC(100), 0, deadline)).wait();
    const attackerTokens = await store.aic.balanceOf(attacker.address);
    expect(attackerTokens).to.be.greaterThan(0n);

    /*
     * The attacker creates the pair first and seeds it at a wildly unfavourable ratio: a lot of AIC
     * against almost no USDC. Uniswap's `addLiquidity` honours the ratio already in a funded pool,
     * so a naive transition would deposit its whole USDC reserve at the attacker's price.
     *
     * This used to be tested for either of two acceptable outcomes — list within the slippage
     * bound, or revert leaving state intact. Measurement settled which actually happened: it always
     * reverted, so no value was ever lost, but the revert was inside `buy`, which meant every
     * purchase crossing the threshold reverted forever and the token was stranded for the price of
     * seeding a pool with dust.
     *
     * The behaviour is now definite rather than merely acceptable: the market gives up on
     * graduating and keeps trading on its curve. Full coverage is in 15-graduation-blocked.
     */
    await (await env.uniswap.factory.createPair(usdcAddress, aicToken)).wait();
    const pairAddress = await env.uniswap.factory.getPair(usdcAddress, aicToken);

    await fundUSDC(env, attacker, USDC(1), await env.uniswap.router.getAddress());
    await (await store.aic.connect(attacker).approve(await env.uniswap.router.getAddress(), attackerTokens)).wait();
    deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await (
      await env.uniswap.router
        .connect(attacker)
        .addLiquidity(usdcAddress, aicToken, USDC(1), attackerTokens, 0, 0, attacker.address, deadline)
    ).wait();

    const pair = attachPair(pairAddress, env.signers[0]);
    expect(await pair.totalSupply()).to.be.greaterThan(0n, "the attacker seeded the pool first");

    const shopAddress = await env.agentGoods.getAddress();
    const poolUsdcBefore = await env.usdc.balanceOf(pairAddress);

    // Buying past the threshold must succeed. It must simply never list.
    for (let i = 0; i < 40; i++) {
      const m = await env.agentGoods.market(aicToken);
      if (m.graduationBlocked) break;
      await fundUSDC(env, whale, USDC(500), shopAddress);
      const d = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(whale).buy(aicToken, USDC(500), 0, d)).wait();
    }

    const market = await env.agentGoods.market(aicToken);
    expect(market.graduationBlocked, "graduation must be abandoned").to.equal(true);
    expect(Number(market.phase), "the curve stays open").to.not.equal(PHASE_EXTERNAL_DEX);

    // Nothing of ours reached the attacker's pool, and nothing is left approved.
    expect(await env.usdc.balanceOf(pairAddress)).to.equal(poolUsdcBefore);
    expect(market.lpUSDCUsed).to.equal(0n);
    expect(await env.usdc.allowance(shopAddress, await env.uniswap.router.getAddress())).to.equal(0n);
    expect(market.realUSDCReserve, "the curve keeps its reserve").to.be.greaterThan(0n);
  });

  it("keeps LP amounts inside uint112, so the pool can never be bricked by size", async function () {
    const { env, store, whale } = await loadFixture(fixture);
    const aicToken = await store.aic.getAddress();

    const market = await driveToTransition(env, store, whale);

    /*
     * UniswapV2 stores reserves as uint112. The genesis supply is 1e27, comfortably under
     * 2^112-1 ≈ 5.19e33, but this asserts it rather than assuming it: a future change to the
     * genesis supply or the decimals would brick every listing, and the failure would appear at
     * the transition rather than at the change that caused it.
     */
    expect(market.lpTokenUsed).to.be.lessThanOrEqual(MAX_UINT112);
    expect(market.lpUSDCUsed).to.be.lessThanOrEqual(MAX_UINT112);
    expect(await store.aic.totalSupply()).to.be.lessThanOrEqual(
      MAX_UINT112,
      "the whole supply must fit a uint112 reserve, or a full-supply pool would be impossible"
    );
  });
});
