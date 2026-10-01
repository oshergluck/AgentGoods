const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployProtocol,
  createStore,
  fundUSDC,
  StoreType,
  MarketPhase,
  USDC,
  TRANSITION_THRESHOLD,
} = require("./helpers/deploy");
const { attachPair } = require("./helpers/uniswap");

/**
 * Buyback and burn: the holders' share of every sale.
 *
 * 20% of a store's net commerce belongs to its AIC holders. It is no longer held in the store for a
 * later distribution: in the purchase transaction itself the store hands it to AgentGoods, which buys
 * the store's own AIC with it and burns what it bought. On the bonding curve that is a fee-free curve
 * buy with no minimum trade; after graduation it is a swap through the external pool, deferred into
 * `pendingBuybackUSDC` (and retried by anyone via `flushBuyback`) if the swap fails, so a pool
 * problem can never block the sale that funded it.
 */

const UNDECLARED = { tokensSaved: 1000n, modelTier: ethers.encodeBytes32String("gpt-6-luna"), basis: 1, declaredAt: 0n }; // every product must declare
const PRODUCT = ethers.id("buyback-product");
const MIN_PRODUCT_PRICE = 523n;

function parseAll(receipt, contracts) {
  const out = [];
  for (const log of receipt.logs) {
    for (const c of contracts) {
      if (log.address.toLowerCase() !== c.target.toLowerCase()) continue;
      try {
        const parsed = c.interface.parseLog(log);
        if (parsed) out.push(parsed);
      } catch {
        // not this contract's event
      }
    }
  }
  return out;
}

async function deadline() {
  return (await ethers.provider.getBlock("latest")).timestamp + 3600;
}

async function addProduct(store, price, rentalPeriod = 0, id = PRODUCT) {
  await (
    await store.store
      .connect(store.creator)
      .createProduct(id, price, 1_000_000, rentalPeriod, ethers.ZeroHash, "", UNDECLARED)
  ).wait();
}

/** A sale (or a rental) of `units` of `id`, paid by `buyer`. Returns the mined receipt. */
async function sell(env, store, buyer, units = 1, id = PRODUCT) {
  const p = await store.store.getProduct(id);
  const gross = p.priceUSDC * BigInt(units);
  await fundUSDC(env, buyer, gross, await store.store.getAddress());
  const fn = store.storeType === StoreType.Rentals ? "rent" : "purchase";
  const tx = await store.store.connect(buyer)[fn](id, units, p.version, gross, ethers.ZeroHash, "");
  return tx.wait();
}

async function buyOnCurve(env, store, buyer, gross) {
  await fundUSDC(env, buyer, gross, await env.agentGoods.getAddress());
  await (
    await env.agentGoods.connect(buyer).buy(await store.aic.getAddress(), gross, 0, await deadline())
  ).wait();
}

/** Pool reserves oriented as (USDC, AIC). */
async function poolReserves(env, pairAddress) {
  const pair = attachPair(pairAddress, env.signers[0]);
  const [r0, r1] = await pair.getReserves();
  const usdcIsToken0 = (await pair.token0()).toLowerCase() === (await env.usdc.getAddress()).toLowerCase();
  return usdcIsToken0 ? { usdc: r0, aic: r1 } : { usdc: r1, aic: r0 };
}

/**
 * Buys on the curve in `chunk` steps until the NEXT such buy would graduate the market, and stops
 * just short of it: the market is left on the curve a little below the threshold.
 */
async function driveBelowThreshold(env, store, whale, chunk = USDC(400)) {
  const aicToken = await store.aic.getAddress();
  for (let i = 0; i < 200; i++) {
    const q = await env.agentGoods.quoteBuy(aicToken, chunk);
    if (q.willTriggerTransition) return;
    await buyOnCurve(env, store, whale, chunk);
  }
  throw new Error("never approached the threshold");
}

async function driveToGraduation(env, store, whale, chunk = USDC(400)) {
  const aicToken = await store.aic.getAddress();
  for (let i = 0; i < 200; i++) {
    const m = await env.agentGoods.market(aicToken);
    if (Number(m.phase) === MarketPhase.ExternalDex) return m;
    await buyOnCurve(env, store, whale, chunk);
  }
  throw new Error("never graduated");
}

describe("Buyback and burn: the holders' share of every sale", function () {
  this.timeout(600000);

  async function curveFixture() {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[5], StoreType.Sales, { aicSymbol: "BBK" });
    await addProduct(store, USDC(10));
    return { env, store };
  }

  async function rentalsFixture() {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[5], StoreType.Rentals, { aicSymbol: "BBR" });
    await addProduct(store, USDC(2), 86400);
    return { env, store };
  }

  async function realDexFixture() {
    const env = await deployProtocol({ realDex: true });
    const store = await createStore(env, env.signers[5], StoreType.Sales, { aicSymbol: "BBD" });
    // Large enough that one sale's holders' share (~20% of net) exceeds a 400 USDC curve buy's
    // net, so the buyback alone can carry the market over the threshold.
    await addProduct(store, USDC(2100));
    await addProduct(store, USDC(10), 0, ethers.id("small"));
    return { env, store, whale: env.signers[9] };
  }

  async function graduatedFixture() {
    const f = await realDexFixture();
    const market = await driveToGraduation(f.env, f.store, f.whale);
    return { ...f, market };
  }

  describe("on the bonding curve", function () {
    it("buys back and burns in the purchase transaction, with every number consistent", async function () {
      const { env, store } = await loadFixture(curveFixture);
      const aicToken = await store.aic.getAddress();
      const shop = await env.agentGoods.getAddress();
      const storeAddr = await store.store.getAddress();
      const treasury = await env.treasury.getAddress();
      const buyer = env.signers[6];

      const s = await store.store.previewSettlement(USDC(10));
      expect(s.holderReserve).to.be.greaterThan(0n);
      const m0 = await env.agentGoods.market(aicToken);
      const expectedBurn = await env.agentGoods.calculateBuyReturn(
        m0.virtualTokenReserve,
        m0.virtualUSDCReserve,
        s.holderReserve
      );
      expect(expectedBurn).to.be.greaterThan(0n);
      const supply0 = await store.aic.totalSupply();
      const burned0 = await store.aic.totalBurned();
      const price0 = await env.agentGoods.currentPrice(aicToken);
      const bal0 = {
        store: await env.usdc.balanceOf(storeAddr),
        shop: await env.usdc.balanceOf(shop),
        treasury: await env.usdc.balanceOf(treasury),
      };

      const receipt = await sell(env, store, buyer, 1);
      const events = parseAll(receipt, [env.agentGoods, store.store, store.aic]);

      const bb = events.find((e) => e.name === "BuybackBurned");
      expect(bb, "BuybackBurned emitted").to.not.equal(undefined);
      expect(bb.args.aicToken).to.equal(aicToken);
      expect(bb.args.store).to.equal(storeAddr);
      expect(bb.args.usdcIn).to.equal(s.holderReserve);
      expect(bb.args.aicBurned).to.equal(expectedBurn);
      expect(bb.args.onCurve).to.equal(true);

      const ex = events.find((e) => e.name === "BuybackExecuted");
      expect(ex, "BuybackExecuted emitted").to.not.equal(undefined);
      expect(ex.args.usdcIn).to.equal(s.holderReserve);
      expect(ex.args.burned).to.equal(expectedBurn);
      expect(ex.args.lifetimeBuybackUSDC).to.equal(s.holderReserve);

      const mb = events.find((e) => e.name === "MarketBurn");
      expect(mb, "MarketBurn emitted").to.not.equal(undefined);
      expect(mb.args.market).to.equal(shop);
      expect(mb.args.amount).to.equal(expectedBurn);

      // Supply falls by exactly the burn; price rises.
      expect(await store.aic.totalSupply()).to.equal(supply0 - expectedBurn);
      expect(await store.aic.totalBurned()).to.equal(burned0 + expectedBurn);
      expect(await env.agentGoods.currentPrice(aicToken)).to.be.greaterThan(price0);

      // The curve took the full share, fee-free: reserves move by exactly the share and the burn.
      const m1 = await env.agentGoods.market(aicToken);
      expect(m1.realUSDCReserve - m0.realUSDCReserve).to.equal(s.holderReserve);
      expect(m1.virtualUSDCReserve - m0.virtualUSDCReserve).to.equal(s.holderReserve);
      expect(m0.virtualTokenReserve - m1.virtualTokenReserve).to.equal(expectedBurn);
      expect(m0.tokenInventory - m1.tokenInventory).to.equal(expectedBurn);
      expect(m1.netSoldFromCurve - m0.netSoldFromCurve).to.equal(expectedBurn);
      // No trading fee on a buyback: controller fees and volume untouched, and the treasury got
      // only the commerce fee.
      expect(m1.controllerFeesUSDC).to.equal(m0.controllerFeesUSDC);
      expect(m1.lifetimeGrossVolumeUSDC).to.equal(m0.lifetimeGrossVolumeUSDC);
      expect(events.find((e) => e.name === "TokensPurchased")).to.equal(undefined);

      // Every USDC of the sale is accounted for, exactly.
      const dStore = (await env.usdc.balanceOf(storeAddr)) - bal0.store;
      const dShop = (await env.usdc.balanceOf(shop)) - bal0.shop;
      const dTreasury = (await env.usdc.balanceOf(treasury)) - bal0.treasury;
      expect(dStore).to.equal(s.ownerAvailable);
      expect(dShop).to.equal(s.holderReserve);
      expect(dTreasury).to.equal(s.protocolFee);
      expect(dStore + dShop + dTreasury).to.equal(USDC(10));
      expect(await env.usdc.balanceOf(buyer.address)).to.equal(0n);

      // Store accounting: the share is lifetime buyback, nothing is held back.
      expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
      expect(await store.store.lifetimeHolderReserveAccruedUSDC()).to.equal(s.holderReserve);
      expect(await store.store.ownerAvailableUSDC()).to.equal(s.ownerAvailable);
      expect((await env.agentGoods.usdcAccounting()).delta).to.equal(0n);
    });

    it("sums many small buybacks to the lifetime share, and the store never holds any of it", async function () {
      const { env, store } = await loadFixture(curveFixture);
      await addProduct(store, MIN_PRODUCT_PRICE, 0, ethers.id("tiny"));
      const aicToken = await store.aic.getAddress();
      const storeAddr = await store.store.getAddress();
      const supply0 = await store.aic.totalSupply();
      const real0 = (await env.agentGoods.market(aicToken)).realUSDCReserve;

      let sumIn = 0n;
      let sumBurned = 0n;
      let expectedShare = 0n;
      for (let i = 0; i < 25; i++) {
        const id = i % 3 === 0 ? PRODUCT : ethers.id("tiny");
        const units = 1 + (i % 4);
        const price = (await store.store.getProduct(id)).priceUSDC;
        expectedShare += (await store.store.previewSettlement(price * BigInt(units))).holderReserve;
        const receipt = await sell(env, store, env.signers[6 + (i % 4)], units, id);
        const ex = parseAll(receipt, [store.store]).find((e) => e.name === "BuybackExecuted");
        sumIn += ex.args.usdcIn;
        sumBurned += ex.args.burned;
        expect(ex.args.lifetimeBuybackUSDC).to.equal(sumIn);

        expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
        expect(await env.usdc.balanceOf(storeAddr)).to.equal(await store.store.ownerAvailableUSDC());
      }

      expect(sumIn).to.equal(expectedShare);
      expect(await store.store.lifetimeHolderReserveAccruedUSDC()).to.equal(sumIn);
      expect(await store.store.lifetimeHolderReserveCommittedUSDC()).to.equal(0n);
      expect((await env.agentGoods.market(aicToken)).realUSDCReserve - real0).to.equal(sumIn);
      expect(supply0 - (await store.aic.totalSupply())).to.equal(sumBurned);
      expect((await env.agentGoods.usdcAccounting()).delta).to.equal(0n);
    });

    it("leaves the dividend distributor with nothing it could ever be funded from", async function () {
      const { env, store } = await loadFixture(curveFixture);
      await sell(env, store, env.signers[6], 50);
      expect(await store.store.lifetimeHolderReserveAccruedUSDC()).to.be.greaterThan(0n);
      await expect(store.distributor.openDistribution()).to.be.revertedWithCustomError(
        store.distributor,
        "BelowMinimumDistribution"
      );
      expect(await env.usdc.balanceOf(await store.distributor.getAddress())).to.equal(0n);
    });
  });

  describe("who may buy back", function () {
    it("lets only the market's own store call buybackAndBurn", async function () {
      const { env, store } = await loadFixture(curveFixture);
      const aicToken = await store.aic.getAddress();
      const other = await createStore(env, env.signers[7], StoreType.Sales, { aicSymbol: "OTH" });

      // An EOA with USDC and an allowance.
      const outsider = env.signers[8];
      await fundUSDC(env, outsider, USDC(5), await env.agentGoods.getAddress());
      await expect(
        env.agentGoods.connect(outsider).buybackAndBurn(aicToken, USDC(5))
      ).to.be.revertedWithCustomError(env.agentGoods, "NotMarketStore");

      // The controller of the store is not the store.
      await expect(
        env.agentGoods.connect(store.creator).buybackAndBurn(aicToken, 1n)
      ).to.be.revertedWithCustomError(env.agentGoods, "NotMarketStore");

      // Another canonical store cannot buy back a market that is not its own.
      const otherAddr = await other.store.getAddress();
      await network.provider.request({ method: "hardhat_impersonateAccount", params: [otherAddr] });
      await network.provider.send("hardhat_setBalance", [otherAddr, "0x56BC75E2D63100000"]);
      const otherSigner = await ethers.getSigner(otherAddr);
      await expect(
        env.agentGoods.connect(otherSigner).buybackAndBurn(aicToken, 1n)
      ).to.be.revertedWithCustomError(env.agentGoods, "NotMarketStore");
      await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [otherAddr] });

      // An unknown token is refused as such.
      await expect(
        env.agentGoods.connect(outsider).buybackAndBurn(outsider.address, 1n)
      ).to.be.revertedWithCustomError(env.agentGoods, "UnknownMarket");
    });

    it("refuses flushBuyback on a market still on its curve", async function () {
      const { env, store } = await loadFixture(curveFixture);
      await expect(env.agentGoods.flushBuyback(await store.aic.getAddress()))
        .to.be.revertedWithCustomError(env.agentGoods, "WrongPhase")
        .withArgs(MarketPhase.BondingCurve);
    });
  });

  describe("rentals", function () {
    it("buys back and burns the holders' share of a rental too", async function () {
      const { env, store } = await loadFixture(rentalsFixture);
      const aicToken = await store.aic.getAddress();
      const s = await store.store.previewSettlement(USDC(2) * 3n);
      const supply0 = await store.aic.totalSupply();
      const real0 = (await env.agentGoods.market(aicToken)).realUSDCReserve;

      const receipt = await sell(env, store, env.signers[6], 3);
      const events = parseAll(receipt, [env.agentGoods, store.store]);
      const ex = events.find((e) => e.name === "BuybackExecuted");
      const bb = events.find((e) => e.name === "BuybackBurned");
      expect(ex.args.usdcIn).to.equal(s.holderReserve);
      expect(bb.args.usdcIn).to.equal(s.holderReserve);
      expect(bb.args.aicBurned).to.equal(ex.args.burned);
      expect(bb.args.onCurve).to.equal(true);
      expect(ex.args.burned).to.be.greaterThan(0n);

      expect(supply0 - (await store.aic.totalSupply())).to.equal(ex.args.burned);
      expect((await env.agentGoods.market(aicToken)).realUSDCReserve - real0).to.equal(s.holderReserve);
      expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
      expect(await env.usdc.balanceOf(await store.store.getAddress())).to.equal(s.ownerAvailable);
    });
  });

  describe("the minimum product price (523 base units)", function () {
    it("refuses 522 on create and on update, and accepts 523", async function () {
      const { env, store } = await loadFixture(curveFixture);
      const c = store.store.connect(store.creator);

      await expect(c.createProduct(ethers.id("p522"), 522n, 10, 0, ethers.ZeroHash, "", UNDECLARED))
        .to.be.revertedWithCustomError(store.store, "PriceBelowMinimum")
        .withArgs(522n, MIN_PRODUCT_PRICE);
      await expect(
        c.createProduct(ethers.id("p0"), 0n, 10, 0, ethers.ZeroHash, "", UNDECLARED)
      ).to.be.revertedWithCustomError(store.store, "ZeroPrice");

      await (await c.createProduct(ethers.id("p523"), 523n, 10, 0, ethers.ZeroHash, "", UNDECLARED)).wait();
      expect((await store.store.getProduct(ethers.id("p523"))).priceUSDC).to.equal(523n);

      await expect(c.updateProduct(PRODUCT, 522n, 10, 0, true, ethers.ZeroHash, "", UNDECLARED))
        .to.be.revertedWithCustomError(store.store, "PriceBelowMinimum")
        .withArgs(522n, MIN_PRODUCT_PRICE);
      await expect(
        c.updateProduct(PRODUCT, 0n, 10, 0, true, ethers.ZeroHash, "", UNDECLARED)
      ).to.be.revertedWithCustomError(store.store, "ZeroPrice");
      await (await c.updateProduct(PRODUCT, 523n, 10, 0, true, ethers.ZeroHash, "", UNDECLARED)).wait();
      expect((await store.store.getProduct(PRODUCT)).priceUSDC).to.equal(523n);
      expect(env.chainId).to.be.greaterThan(0n);
    });

    it("gives a 523-base-unit sale a buyback of at least 100 base units, which burns", async function () {
      const { env, store } = await loadFixture(curveFixture);
      await addProduct(store, MIN_PRODUCT_PRICE, 0, ethers.id("p523"));
      const s = await store.store.previewSettlement(MIN_PRODUCT_PRICE);
      expect(s.holderReserve).to.be.greaterThanOrEqual(100n);

      const supply0 = await store.aic.totalSupply();
      const receipt = await sell(env, store, env.signers[6], 1, ethers.id("p523"));
      const ex = parseAll(receipt, [store.store]).find((e) => e.name === "BuybackExecuted");
      expect(ex.args.usdcIn).to.equal(s.holderReserve);
      expect(ex.args.usdcIn).to.be.greaterThanOrEqual(100n);
      expect(ex.args.burned).to.be.greaterThan(0n);
      expect(supply0 - (await store.aic.totalSupply())).to.equal(ex.args.burned);
    });
  });

  describe("graduation and the external pool (real Uniswap V2)", function () {
    it("graduates the market when a sale's buyback carries netSold over the threshold", async function () {
      const { env, store, whale } = await loadFixture(realDexFixture);
      const aicToken = await store.aic.getAddress();
      await driveBelowThreshold(env, store, whale);

      const m0 = await env.agentGoods.market(aicToken);
      expect(Number(m0.phase)).to.equal(MarketPhase.BondingCurve);
      expect(m0.netSoldFromCurve).to.be.lessThan(TRANSITION_THRESHOLD);
      const s = await store.store.previewSettlement(USDC(2100));
      const willBurn = await env.agentGoods.calculateBuyReturn(
        m0.virtualTokenReserve,
        m0.virtualUSDCReserve,
        s.holderReserve
      );
      expect(m0.netSoldFromCurve + willBurn, "the buyback alone crosses the threshold").to.be.greaterThanOrEqual(
        TRANSITION_THRESHOLD
      );

      const receipt = await sell(env, store, env.signers[6], 1);
      const events = parseAll(receipt, [env.agentGoods]);
      const bb = events.find((e) => e.name === "BuybackBurned");
      expect(bb.args.onCurve).to.equal(true);
      expect(bb.args.aicBurned).to.equal(willBurn);
      expect(events.find((e) => e.name === "LiquidityTransition"), "graduated in the sale").to.not.equal(undefined);

      const m1 = await env.agentGoods.market(aicToken);
      expect(Number(m1.phase)).to.equal(MarketPhase.ExternalDex);
      expect(m1.pair).to.not.equal(ethers.ZeroAddress);
      expect(m1.realUSDCReserve).to.equal(0n);
      expect(m1.tokenInventory).to.equal(0n);
      const pool = await poolReserves(env, m1.pair);
      expect(pool.usdc).to.equal(m1.lpUSDCUsed);
      expect(pool.aic).to.equal(m1.lpTokenUsed);
    });

    it("after graduation, swaps the share through the pool and burns what it receives", async function () {
      const { env, store, market } = await loadFixture(graduatedFixture);
      const aicToken = await store.aic.getAddress();
      const shop = await env.agentGoods.getAddress();
      const s = await store.store.previewSettlement(USDC(10));
      const pool0 = await poolReserves(env, market.pair);
      const supply0 = await store.aic.totalSupply();
      const shopUsdc0 = await env.usdc.balanceOf(shop);

      const receipt = await sell(env, store, env.signers[6], 1, ethers.id("small"));
      const events = parseAll(receipt, [env.agentGoods, store.store, store.aic]);
      const bb = events.find((e) => e.name === "BuybackBurned");
      const ex = events.find((e) => e.name === "BuybackExecuted");
      const mb = events.find((e) => e.name === "MarketBurn");
      expect(bb.args.onCurve).to.equal(false);
      expect(bb.args.usdcIn).to.equal(s.holderReserve);
      expect(bb.args.aicBurned).to.be.greaterThan(0n);
      expect(ex.args.usdcIn).to.equal(s.holderReserve);
      expect(ex.args.burned).to.equal(bb.args.aicBurned);
      expect(mb.args.amount).to.equal(bb.args.aicBurned);
      expect(events.find((e) => e.name === "BuybackDeferred")).to.equal(undefined);

      const pool1 = await poolReserves(env, market.pair);
      expect(pool1.usdc - pool0.usdc).to.equal(s.holderReserve);
      expect(pool0.aic - pool1.aic).to.equal(bb.args.aicBurned);
      expect(supply0 - (await store.aic.totalSupply())).to.equal(bb.args.aicBurned);
      expect(await env.agentGoods.pendingBuybackUSDC(aicToken)).to.equal(0n);
      // AgentGoods keeps nothing of the share and holds no AIC.
      expect(await env.usdc.balanceOf(shop)).to.equal(shopUsdc0);
      expect(await store.aic.balanceOf(shop)).to.equal(0n);
      expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
    });

    it("defers a buyback whose swap fails, lets the sale succeed, and burns it on flushBuyback", async function () {
      const { env, store, market } = await loadFixture(graduatedFixture);
      const aicToken = await store.aic.getAddress();
      const shop = await env.agentGoods.getAddress();
      const routerAddr = await env.router.getAddress();
      const s = await store.store.previewSettlement(USDC(10));

      /*
       * Make the router's swap fail without touching the protocol: replace the router's code with
       * one that always reverts, then put the original code back. The router's storage is
       * untouched and its immutables live in the code, so restoring the code restores the router.
       */
      const routerCode = await ethers.provider.getCode(routerAddr);
      await network.provider.send("hardhat_setCode", [routerAddr, "0x60006000fd"]);

      const supply0 = await store.aic.totalSupply();
      const pool0 = await poolReserves(env, market.pair);
      const shopUsdc0 = await env.usdc.balanceOf(shop);

      const r1 = await sell(env, store, env.signers[6], 1, ethers.id("small"));
      expect(r1.status).to.equal(1);
      const e1 = parseAll(r1, [env.agentGoods, store.store]);
      const d1 = e1.find((e) => e.name === "BuybackDeferred");
      expect(d1.args.aicToken).to.equal(aicToken);
      expect(d1.args.usdcIn).to.equal(s.holderReserve);
      expect(d1.args.pendingUSDC).to.equal(s.holderReserve);
      expect(e1.find((e) => e.name === "BuybackBurned")).to.equal(undefined);
      expect(e1.find((e) => e.name === "BuybackExecuted").args.burned).to.equal(0n);

      expect(await env.agentGoods.pendingBuybackUSDC(aicToken)).to.equal(s.holderReserve);
      expect((await env.usdc.balanceOf(shop)) - shopUsdc0).to.equal(s.holderReserve);
      expect(await store.aic.totalSupply()).to.equal(supply0);
      // The license was still sold and the owner still credited.
      expect(await store.store.ownerAvailableUSDC()).to.equal(s.ownerAvailable);
      expect(await store.store.lifetimeHolderReserveAccruedUSDC()).to.be.greaterThan(0n);
      // usdcAccounting does not count deferred buyback USDC: the surplus is exactly the pending amount.
      expect((await env.agentGoods.usdcAccounting()).delta).to.equal(0n); // pending buyback USDC is counted

      // A second sale while still failing accumulates; a flush while still failing keeps it pending.
      await sell(env, store, env.signers[7], 1, ethers.id("small"));
      expect(await env.agentGoods.pendingBuybackUSDC(aicToken)).to.equal(s.holderReserve * 2n);
      await expect(env.agentGoods.connect(env.signers[8]).flushBuyback(aicToken))
        .to.emit(env.agentGoods, "BuybackDeferred")
        .withArgs(aicToken, s.holderReserve * 2n, s.holderReserve * 2n);
      expect(await env.agentGoods.pendingBuybackUSDC(aicToken)).to.equal(s.holderReserve * 2n);

      // The pool recovers: anyone flushes, and the whole pending amount is bought and burned.
      await network.provider.send("hardhat_setCode", [routerAddr, routerCode]);
      const flushTx = await env.agentGoods.connect(env.signers[8]).flushBuyback(aicToken);
      const fr = await flushTx.wait();
      const bb = parseAll(fr, [env.agentGoods]).find((e) => e.name === "BuybackBurned");
      expect(bb.args.usdcIn).to.equal(s.holderReserve * 2n);
      expect(bb.args.onCurve).to.equal(false);
      expect(bb.args.aicBurned).to.be.greaterThan(0n);

      expect(await env.agentGoods.pendingBuybackUSDC(aicToken)).to.equal(0n);
      expect(await env.usdc.balanceOf(shop)).to.equal(shopUsdc0);
      expect(supply0 - (await store.aic.totalSupply())).to.equal(bb.args.aicBurned);
      const pool1 = await poolReserves(env, market.pair);
      expect(pool1.usdc - pool0.usdc).to.equal(s.holderReserve * 2n);
      expect(pool0.aic - pool1.aic).to.equal(bb.args.aicBurned);
      expect((await env.agentGoods.usdcAccounting()).delta).to.equal(0n);

      // Nothing pending: a further flush is a no-op.
      await expect(env.agentGoods.flushBuyback(aicToken)).to.not.emit(env.agentGoods, "BuybackBurned");
    });
  });
});
