/**
 * Per-deployment curve parameters (AgentGoods.configureCurve): a 250 USDC virtual reserve and graduation at
 * 95% of genesis sold, with the pool opening 35% above the curve's last spot price. Unset, the defaults
 * (6,000 USDC, 30%) apply unchanged.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployProtocol, createStore, fundUSDC, StoreType, USDC } = require("./helpers/deploy");
const { attachPair } = require("./helpers/uniswap");

const GENESIS = 1_000_000_000n * 10n ** 18n;
const PHASE_BONDING_CURVE = 1;
const PHASE_EXTERNAL_DEX = 3;

describe("curve parameters per deployment", function () {
  async function base() {
    return { env: await deployProtocol({ realDex: true }) };
  }

  it("defaults to 6,000 USDC and 30% when never configured", async function () {
    const { env } = await loadFixture(base);
    expect(await env.agentGoods.virtualUSDCReserve()).to.equal(USDC(6000));
    expect(await env.agentGoods.transitionThresholdAIC()).to.equal((GENESIS * 3000n) / 10_000n);
  });

  it("only the admin can configure, and only before any market exists", async function () {
    const { env } = await loadFixture(base);
    await expect(env.agentGoods.connect(env.signers[7]).configureCurve(USDC(250), (GENESIS * 9500n) / 10_000n)).to.be.reverted;
    await expect(env.agentGoods.configureCurve(USDC(250), GENESIS)).to.be.revertedWithCustomError(env.agentGoods, "InvalidCurveParameters");
    await (await env.agentGoods.configureCurve(USDC(250), (GENESIS * 9500n) / 10_000n)).wait();
    await createStore(env, env.signers[5], StoreType.Sales);
    await expect(env.agentGoods.configureCurve(USDC(300), (GENESIS * 9500n) / 10_000n)).to.be.revertedWithCustomError(env.agentGoods, "CurveParametersLocked");
  });

  it("a 250 USDC curve graduates only at 95% sold, into a pool priced 35% above the last curve spot", async function () {
    const { env } = await loadFixture(base);
    await (await env.agentGoods.configureCurve(USDC(250), (GENESIS * 9500n) / 10_000n)).wait();
    const store = await createStore(env, env.signers[5], StoreType.Sales);
    const aicToken = await store.aic.getAddress();
    const whale = env.signers[9];
    // 250 at creation, plus the net of the owner's seed that createStore buys in the same transaction.
    const start = (await env.agentGoods.market(aicToken)).virtualUSDCReserve;
    expect(start).to.be.greaterThanOrEqual(USDC(250));
    expect(start).to.be.lessThan(USDC(260));

    let last = null;
    for (let i = 0; i < 200; i++) {
      const m = await env.agentGoods.market(aicToken);
      if (Number(m.phase) !== PHASE_BONDING_CURVE) break;
      // Still on the curve: never graduated before 95% of genesis left it.
      expect(m.netSoldFromCurve).to.be.lessThan((GENESIS * 9500n) / 10_000n);
      last = m;
      await fundUSDC(env, whale, USDC(200), await env.agentGoods.getAddress());
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(whale).buy(aicToken, USDC(200), 0, deadline)).wait();
    }
    const after = await env.agentGoods.market(aicToken);
    expect(Number(after.phase)).to.equal(PHASE_EXTERNAL_DEX);

    // Pool price vs the curve's spot at the moment of transition (reserves after the triggering buy).
    const pair = attachPair(after.pair, env.signers[0]);
    const [r0, r1] = await pair.getReserves();
    const usdcIs0 = (await pair.token0()).toLowerCase() === (await env.usdc.getAddress()).toLowerCase();
    const [usdcR, aicR] = usdcIs0 ? [r0, r1] : [r1, r0];
    const poolPrice = (usdcR * 10n ** 30n) / aicR;
    const curveSpot = (after.virtualUSDCReserve * 10n ** 30n) / after.virtualTokenReserve;
    const premiumBps = ((poolPrice - curveSpot) * 10_000n) / curveSpot;
    expect(Number(premiumBps)).to.be.within(3400, 3600);
    expect(last).to.not.equal(null);
  });

  it("a buyback that crosses 95% graduates inside the purchase, and every burned token is accounted for", async function () {
    const { env } = await loadFixture(base);
    await (await env.agentGoods.configureCurve(USDC(250), (GENESIS * 9500n) / 10_000n)).wait();
    const store = await createStore(env, env.signers[5], StoreType.Sales);
    const aicToken = await store.aic.getAddress();
    const whale = env.signers[9];
    const buyer = env.signers[8];
    const PRODUCT = ethers.id("graduation-by-buyback");
    const UNDECLARED = { tokensSaved: 1000n, modelTier: ethers.encodeBytes32String("gpt-6-luna"), basis: 1, declaredAt: 0n }; // every product must declare
    await (await store.store.connect(store.creator).createProduct(PRODUCT, USDC(100), 1_000_000, 0, ethers.ZeroHash, "", UNDECLARED)).wait();

    // Direct buys up to just below the threshold.
    for (let i = 0; i < 400; i++) {
      const q = await env.agentGoods.quoteBuy(aicToken, USDC(50));
      if (q.willTriggerTransition) break;
      await fundUSDC(env, whale, USDC(50), await env.agentGoods.getAddress());
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await (await env.agentGoods.connect(whale).buy(aicToken, USDC(50), 0, deadline)).wait();
    }
    expect(Number((await env.agentGoods.market(aicToken)).phase)).to.equal(PHASE_BONDING_CURVE);

    // Now only product purchases: their buybacks carry the curve across 95%.
    let graduatedBy = null;
    for (let i = 0; i < 50; i++) {
      const p = await store.store.getProduct(PRODUCT);
      await fundUSDC(env, buyer, p.priceUSDC, await store.store.getAddress());
      const receipt = await (await store.store.connect(buyer).purchase(PRODUCT, 1, p.version, p.priceUSDC, ethers.ZeroHash, "")).wait();
      expect(receipt.status).to.equal(1);
      if (Number((await env.agentGoods.market(aicToken)).phase) === PHASE_EXTERNAL_DEX) {
        graduatedBy = i;
        break;
      }
    }
    expect(graduatedBy).to.not.equal(null, "a purchase's buyback graduated the market");

    const m = await env.agentGoods.market(aicToken);
    // No stray AIC left in AgentGoods, and supply = genesis minus every burn (buybacks + graduation).
    expect(m.tokenInventory).to.equal(0n);
    expect(await store.aic.balanceOf(await env.agentGoods.getAddress())).to.equal(0n);
    const supply = await store.aic.totalSupply();
    expect(supply).to.be.lessThan(GENESIS);
    expect(m.burnedAtTransition).to.be.greaterThan(0n);

    // Purchases after graduation still work: their buyback swaps through the pool.
    const p = await store.store.getProduct(PRODUCT);
    await fundUSDC(env, buyer, p.priceUSDC, await store.store.getAddress());
    const after = await (await store.store.connect(buyer).purchase(PRODUCT, 1, p.version, p.priceUSDC, ethers.ZeroHash, "")).wait();
    expect(after.status).to.equal(1);
  });
});
