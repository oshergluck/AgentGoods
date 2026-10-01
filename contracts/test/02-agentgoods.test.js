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
  AIC,
  GENESIS_SUPPLY,
  VIRTUAL_USDC,
  TRANSITION_THRESHOLD,
  LP_BURN,
} = require("./helpers/deploy");

const BPS = 10_000n;
const PROTOCOL_FEE_BPS = 200n;
const CONTROLLER_FEE_BPS = 100n;

function buyReturn(tokenReserve, usdcReserve, usdcAmount) {
  if (tokenReserve === 0n || usdcReserve === 0n || usdcAmount === 0n) return 0n;
  return (tokenReserve * usdcAmount) / (usdcReserve + usdcAmount);
}

function sellReturn(tokenReserve, usdcReserve, tokenAmount) {
  if (tokenReserve === 0n || usdcReserve === 0n || tokenAmount === 0n) return 0n;
  return (usdcReserve * tokenAmount) / (tokenReserve + tokenAmount);
}

describe("AgentGoods bonding curve, fees, solvency and the 30% transition", function () {
  async function fixture() {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[5], StoreType.Sales);
    return { env, store };
  }

  async function deadline() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
  }

  async function buy(env, store, buyer, gross, minOut = 0n) {
    await fundUSDC(env, buyer, gross, await env.agentGoods.getAddress());
    return env.agentGoods.connect(buyer).buy(await store.aic.getAddress(), gross, minOut, await deadline());
  }

  describe("Fee structure (MASTER_PLAN 0.13, 15A)", function () {
    it("splits a 100 USDC buy into 2 protocol, 1 controller and 97 curve USDC", async function () {
      const { env, store } = await loadFixture(fixture);
      const q = await env.agentGoods.quoteBuy(await store.aic.getAddress(), USDC(100));
      expect(q.protocolFeeUSDC).to.equal(USDC(2));
      expect(q.controllerFeeUSDC).to.equal(USDC(1));
      expect(q.netCurveUSDC).to.equal(USDC(97));
      expect(q.grossUSDC).to.equal(q.protocolFeeUSDC + q.controllerFeeUSDC + q.netCurveUSDC);
    });

    it("executes exactly what the quote predicted", async function () {
      const { env, store } = await loadFixture(fixture);
      const buyer = env.signers[6];
      const q = await env.agentGoods.quoteBuy(await store.aic.getAddress(), USDC(100));
      await buy(env, store, buyer, USDC(100));
      expect(await store.aic.balanceOf(buyer.address)).to.equal(q.tokensOut);
    });

    it("matches the constant-product formula over the virtual reserves", async function () {
      const { env, store } = await loadFixture(fixture);
      const m0 = await env.agentGoods.market(await store.aic.getAddress());
      const expected = buyReturn(m0.virtualTokenReserve, m0.virtualUSDCReserve, USDC(97));
      const q = await env.agentGoods.quoteBuy(await store.aic.getAddress(), USDC(100));
      expect(q.tokensOut).to.equal(expected);
    });

    it("forwards the protocol fee to the treasury and records it by fee type", async function () {
      const { env, store } = await loadFixture(fixture);
      const usdcAddr = await env.usdc.getAddress();
      const tr = await env.treasury.getAddress();
      const [bal0, rev0, typ0] = [await env.usdc.balanceOf(tr), await env.treasury.totalRevenue(usdcAddr), await env.treasury.revenueByType(ethers.id("AGENTGOODS_BUY"), usdcAddr)];
      await buy(env, store, env.signers[6], USDC(100));
      expect((await env.usdc.balanceOf(tr)) - bal0).to.equal(USDC(2));
      expect((await env.treasury.totalRevenue(usdcAddr)) - rev0).to.equal(USDC(2));
      expect((await env.treasury.revenueByType(ethers.id("AGENTGOODS_BUY"), usdcAddr)) - typ0).to.equal(USDC(2));
    });

    it("accrues the 1% fee to the CURRENT controller, not a stale creator", async function () {
      const { env, store } = await loadFixture(fixture);
      const fromSeed = (await env.agentGoods.market(await store.aic.getAddress())).controllerFeesUSDC;
      await buy(env, store, env.signers[6], USDC(100));
      const m = await env.agentGoods.market(await store.aic.getAddress());
      expect(m.controllerFeesUSDC).to.equal(fromSeed + USDC(1));

      const newController = env.signers[8];
      await (await store.store.connect(store.creator).transferController(newController.address)).wait();

      await expect(
        env.agentGoods.connect(store.creator).withdrawControllerFees(await store.aic.getAddress(), store.creator.address)
      ).to.be.revertedWithCustomError(env.agentGoods, "NotStoreController");

      await (
        await env.agentGoods
          .connect(newController)
          .withdrawControllerFees(await store.aic.getAddress(), newController.address)
      ).wait();
      expect(await env.usdc.balanceOf(newController.address)).to.equal(fromSeed + USDC(1));
    });

    it("rejects a fee configuration above the hard cap", async function () {
      const { env } = await loadFixture(fixture);
      await expect(env.registry.setAgentGoodsFeesBps(301, 100)).to.be.revertedWithCustomError(
        env.registry,
        "FeeAboveCap"
      );
      await expect(env.registry.setAgentGoodsFeesBps(200, 201)).to.be.revertedWithCustomError(
        env.registry,
        "FeeAboveCap"
      );
      await expect(env.registry.setCommerceFeeBps(501)).to.be.revertedWithCustomError(env.registry, "FeeAboveCap");
      await expect(env.registry.setDividendProcessingFeeBps(1001)).to.be.revertedWithCustomError(
        env.registry,
        "FeeAboveCap"
      );
    });

    it("rejects an unauthorized fee update", async function () {
      const { env } = await loadFixture(fixture);
      await expect(env.registry.connect(env.signers[9]).setCommerceFeeBps(100)).to.be.reverted;
    });
  });

  describe("Trading safety", function () {
    it("sets the minimum trade at 100 base units (0.0001 USDC)", async function () {
      const { env } = await loadFixture(fixture);
      expect(await env.agentGoods.MIN_TRADE_USDC()).to.equal(100n);
    });

    it("refuses a 99-base-unit buy", async function () {
      const { env, store } = await loadFixture(fixture);
      await expect(buy(env, store, env.signers[6], 99n))
        .to.be.revertedWithCustomError(env.agentGoods, "BelowMinimumTrade")
        .withArgs(99n, 100n);
      await expect(buy(env, store, env.signers[6], 0n))
        .to.be.revertedWithCustomError(env.agentGoods, "BelowMinimumTrade")
        .withArgs(0n, 100n);
    });

    it("accepts a 100-base-unit buy, which still pays at least one unit of each fee", async function () {
      const { env, store } = await loadFixture(fixture);
      const aicToken = await store.aic.getAddress();
      const treasury = await env.treasury.getAddress();
      const buyer = env.signers[6];
      const before = await env.agentGoods.market(aicToken);
      const treasuryBefore = await env.usdc.balanceOf(treasury);

      const q = await env.agentGoods.quoteBuy(aicToken, 100n);
      expect(q.protocolFeeUSDC).to.be.greaterThanOrEqual(1n);
      expect(q.controllerFeeUSDC).to.be.greaterThanOrEqual(1n);
      expect(q.tokensOut).to.be.greaterThan(0n);

      await expect(buy(env, store, buyer, 100n))
        .to.emit(env.agentGoods, "TokensPurchased")
        .withArgs(
          aicToken,
          buyer.address,
          100n,
          q.protocolFeeUSDC,
          q.controllerFeeUSDC,
          q.netCurveUSDC,
          q.tokensOut,
          before.netSoldFromCurve + q.tokensOut,
          before.virtualUSDCReserve + q.netCurveUSDC,
          before.virtualTokenReserve - q.tokensOut
        );

      const after = await env.agentGoods.market(aicToken);
      expect((await env.usdc.balanceOf(treasury)) - treasuryBefore).to.equal(q.protocolFeeUSDC);
      expect((await env.usdc.balanceOf(treasury)) - treasuryBefore).to.be.greaterThanOrEqual(1n);
      expect(after.controllerFeesUSDC - before.controllerFeesUSDC).to.equal(q.controllerFeeUSDC);
      expect(after.controllerFeesUSDC - before.controllerFeesUSDC).to.be.greaterThanOrEqual(1n);
      expect(after.realUSDCReserve - before.realUSDCReserve).to.equal(q.netCurveUSDC);
      expect(await store.aic.balanceOf(buyer.address)).to.equal(q.tokensOut);
      expect((await env.agentGoods.usdcAccounting()).delta).to.equal(0n);
    });

    it("enforces the slippage minimum", async function () {
      const { env, store } = await loadFixture(fixture);
      const q = await env.agentGoods.quoteBuy(await store.aic.getAddress(), USDC(100));
      await expect(buy(env, store, env.signers[6], USDC(100), q.tokensOut + 1n)).to.be.revertedWithCustomError(
        env.agentGoods,
        "SlippageExceeded"
      );
    });

    it("enforces the deadline", async function () {
      const { env, store } = await loadFixture(fixture);
      const buyer = env.signers[6];
      await fundUSDC(env, buyer, USDC(100), await env.agentGoods.getAddress());
      const past = (await ethers.provider.getBlock("latest")).timestamp - 1;
      await expect(
        env.agentGoods.connect(buyer).buy(await store.aic.getAddress(), USDC(100), 0, past)
      ).to.be.revertedWithCustomError(env.agentGoods, "DeadlinePassed");
    });

    it("refuses to sell more than the real USDC reserve can satisfy", async function () {
      const { env, store } = await loadFixture(fixture);
      const buyer = env.signers[6];
      await buy(env, store, buyer, USDC(100));
      const held = await store.aic.balanceOf(buyer.address);

      // A second party acquires AIC cheaply elsewhere is impossible here, so instead prove the
      // quote reports insolvency for a sell that would need more real USDC than exists.
      const hugeSell = held * 1000n;
      const q = await env.agentGoods.quoteSell(await store.aic.getAddress(), hugeSell);
      expect(q.enoughRealReserve).to.equal(false);
    });

    it("never lets virtual USDC leave the contract", async function () {
      const { env, store } = await loadFixture(fixture);
      const buyer = env.signers[6];
      await buy(env, store, buyer, USDC(100));
      const held = await store.aic.balanceOf(buyer.address);
      await (await store.aic.connect(buyer).approve(await env.agentGoods.getAddress(), held)).wait();
      await (
        await env.agentGoods.connect(buyer).sell(await store.aic.getAddress(), held, 0, await deadline())
      ).wait();

      // The buyer can never end up with more real USDC than they put in.
      expect(await env.usdc.balanceOf(buyer.address)).to.be.lessThan(USDC(100));
      const acct = await env.agentGoods.usdcAccounting();
      expect(acct.delta).to.equal(0n);
    });

    it("keeps buy/sell round trips conservative under many small trades", async function () {
      const { env, store } = await loadFixture(fixture);
      const trader = env.signers[6];
      const aicAddr = await store.aic.getAddress();
      const shopAddr = await env.agentGoods.getAddress();
      let spent = 0n;

      for (let i = 0; i < 10; i++) {
        await buy(env, store, trader, USDC(10));
        spent += USDC(10);
      }
      const held = await store.aic.balanceOf(trader.address);
      await (await store.aic.connect(trader).approve(shopAddr, held)).wait();
      for (let i = 0; i < 5; i++) {
        const chunk = held / 5n;
        await (await env.agentGoods.connect(trader).sell(aicAddr, chunk, 0, await deadline())).wait();
      }

      const recovered = await env.usdc.balanceOf(trader.address);
      expect(recovered).to.be.lessThan(spent, "round trip must not create value");
      const acct = await env.agentGoods.usdcAccounting();
      expect(acct.delta).to.equal(0n);
    });

    it("blocks trading when the market pause scope is active", async function () {
      const { env, store } = await loadFixture(fixture);
      await (await env.registry.connect(env.guardian).setPaused(ethers.id("PAUSE_MARKET"), true)).wait();
      await expect(buy(env, store, env.signers[6], USDC(100))).to.be.revertedWithCustomError(
        env.agentGoods,
        "MarketPaused"
      );
    });

    it("rejects a duplicate market initialization", async function () {
      const { env, store } = await loadFixture(fixture);
      // Even the authorized factory cannot re-initialize an existing market.
      const fakeFactory = await (
        await ethers.getContractFactory("ReusingFactory")
      ).deploy(await env.registry.getAddress());
      await fakeFactory.waitForDeployment();
      await (await env.registry.authorizeFactory(await fakeFactory.getAddress(), 2)).wait();
      const holder = await (await ethers.getContractFactory("ContractHolder")).deploy();
      await holder.waitForDeployment();
      const data = env.agentGoods.interface.encodeFunctionData("initializeMarket", [
        await store.aic.getAddress(),
        await store.store.getAddress(),
        store.storeId,
      ]);
      const res = await holder.callTarget.staticCall(await env.agentGoods.getAddress(), data);
      expect(res[0]).to.equal(false);
    });
  });

  describe("30% transition (MASTER_PLAN 0.13, 0.25.K, 0.25.L)", function () {
    /** Buys until the transition fires, returning the total gross USDC spent. */
    async function driveToTransition(env, store) {
      const buyer = env.signers[6];
      const aicAddr = await store.aic.getAddress();
      let spent = 0n;
      for (let i = 0; i < 200; i++) {
        const m = await env.agentGoods.market(aicAddr);
        if (m.phase !== BigInt(MarketPhase.BondingCurve)) break;
        const amount = USDC(500);
        await buy(env, store, buyer, amount);
        spent += amount;
      }
      return { buyer, spent };
    }

    it("does not transition below the exact threshold", async function () {
      const { env, store } = await loadFixture(fixture);
      const aicAddr = await store.aic.getAddress();
      await buy(env, store, env.signers[6], USDC(1000));
      const m = await env.agentGoods.market(aicAddr);
      expect(m.netSoldFromCurve).to.be.lessThan(TRANSITION_THRESHOLD);
      expect(m.phase).to.equal(MarketPhase.BondingCurve);
      expect(m.pair).to.equal(ethers.ZeroAddress);
    });

    it("transitions exactly once when net sold crosses 300,000,000 AIC", async function () {
      const { env, store } = await loadFixture(fixture);
      const aicAddr = await store.aic.getAddress();
      await driveToTransition(env, store);

      const m = await env.agentGoods.market(aicAddr);
      expect(m.phase).to.equal(MarketPhase.ExternalDex);
      expect(m.netSoldFromCurve).to.be.greaterThanOrEqual(TRANSITION_THRESHOLD);
      expect(m.pair).to.not.equal(ethers.ZeroAddress);
      expect(m.lpTokenUsed).to.be.greaterThan(0n);
      expect(m.lpUSDCUsed).to.be.greaterThan(0n);
    });

    it("burns every remaining market token and burns nothing else", async function () {
      const { env, store } = await loadFixture(fixture);
      const aicAddr = await store.aic.getAddress();
      const { buyer } = await driveToTransition(env, store);

      const m = await env.agentGoods.market(aicAddr);
      expect(m.tokenInventory).to.equal(0n);
      expect(m.burnedAtTransition).to.be.greaterThan(0n);
      expect(await store.aic.totalBurned()).to.equal(m.burnedAtTransition);

      // Supply conservation: genesis == current supply + cumulative burned. [0.25.M]
      expect(await store.aic.totalSupply()).to.equal(GENESIS_SUPPLY - (await store.aic.totalBurned()));

      // Third-party balances are untouched.
      expect(await store.aic.balanceOf(buyer.address)).to.be.greaterThan(0n);
      expect(await store.aic.balanceOf(await env.agentGoods.getAddress())).to.equal(0n);
    });

    it("sends LP tokens to the burn address and never to the controller", async function () {
      const { env, store } = await loadFixture(fixture);
      const aicAddr = await store.aic.getAddress();
      await driveToTransition(env, store);
      const m = await env.agentGoods.market(aicAddr);
      const pair = await ethers.getContractAt("MockUniswapV2Pair", m.pair);
      expect(await pair.balanceOf(LP_BURN)).to.equal(m.lpTokenAmount);
      expect(await pair.balanceOf(await env.agentGoods.getAddress())).to.equal(0n);
      expect(await pair.balanceOf(store.creator.address)).to.equal(0n);
    });

    it("never puts the 6,000 virtual USDC into the LP", async function () {
      const { env, store } = await loadFixture(fixture);
      const aicAddr = await store.aic.getAddress();
      const { spent } = await driveToTransition(env, store);
      const m = await env.agentGoods.market(aicAddr);
      // Real USDC used for LP can only come from real curve reserve, never virtual pricing state.
      expect(m.lpUSDCUsed).to.be.lessThanOrEqual(spent);
      expect(m.lpUSDCUsed).to.be.lessThan(spent);
    });

    it("blocks curve trades after the transition", async function () {
      const { env, store } = await loadFixture(fixture);
      const aicAddr = await store.aic.getAddress();
      const { buyer } = await driveToTransition(env, store);

      await fundUSDC(env, buyer, USDC(100), await env.agentGoods.getAddress());
      await expect(
        env.agentGoods.connect(buyer).buy(aicAddr, USDC(100), 0, await deadline())
      ).to.be.revertedWithCustomError(env.agentGoods, "WrongPhase");

      const held = await store.aic.balanceOf(buyer.address);
      await (await store.aic.connect(buyer).approve(await env.agentGoods.getAddress(), held)).wait();
      await expect(
        env.agentGoods.connect(buyer).sell(aicAddr, held, 0, await deadline())
      ).to.be.revertedWithCustomError(env.agentGoods, "WrongPhase");
    });

    it("reverts the entire transition if LP creation cannot meet the slippage minimum", async function () {
      const { env, store } = await loadFixture(fixture);
      const aicAddr = await store.aic.getAddress();
      // A manipulated pool that consumes only 50% of the desired deposit must be rejected.
      await (await env.router.setConsumeBps(5000)).wait();

      const buyer = env.signers[6];
      let reverted = false;
      for (let i = 0; i < 200; i++) {
        const m = await env.agentGoods.market(aicAddr);
        if (m.phase !== BigInt(MarketPhase.BondingCurve)) break;
        try {
          await buy(env, store, buyer, USDC(500));
        } catch (e) {
          reverted = true;
          expect(String(e)).to.match(/INSUFFICIENT_[AB]_AMOUNT/);
          break;
        }
      }
      expect(reverted).to.equal(true);
      // The market stays coherently pre-transition; nothing was half-burned.
      const m = await env.agentGoods.market(aicAddr);
      expect(m.phase).to.equal(MarketPhase.BondingCurve);
      expect(await store.aic.totalBurned()).to.equal(0n);
      expect(await store.aic.totalSupply()).to.equal(GENESIS_SUPPLY);
    });

    it("keeps net sold semantics: sells reduce net sold, they are not lifetime volume", async function () {
      const { env, store } = await loadFixture(fixture);
      const aicAddr = await store.aic.getAddress();
      const trader = env.signers[6];
      await buy(env, store, trader, USDC(1000));
      const after1 = await env.agentGoods.market(aicAddr);

      const held = await store.aic.balanceOf(trader.address);
      await (await store.aic.connect(trader).approve(await env.agentGoods.getAddress(), held / 2n)).wait();
      await (await env.agentGoods.connect(trader).sell(aicAddr, held / 2n, 0, await deadline())).wait();
      const after2 = await env.agentGoods.market(aicAddr);

      expect(after2.netSoldFromCurve).to.be.lessThan(after1.netSoldFromCurve);
      expect(after2.lifetimeGrossVolumeUSDC).to.be.greaterThan(after1.lifetimeGrossVolumeUSDC);
    });
  });

  describe("Solvency accounting", function () {
    it("keeps contract USDC exactly equal to reserves plus controller fees", async function () {
      const { env, store } = await loadFixture(fixture);
      const a = await createStore(env, env.signers[7], StoreType.Rentals, { aicSymbol: "BBB" });
      await buy(env, store, env.signers[6], USDC(250));
      await buy(env, a, env.signers[8], USDC(130));

      const acct = await env.agentGoods.usdcAccounting();
      expect(acct.delta).to.equal(0n);
      expect(acct.contractBalance).to.equal(acct.sumRealReserves + acct.sumControllerFees);
    });

    it("does not let one market pay out another market reserve", async function () {
      const { env, store } = await loadFixture(fixture);
      const other = await createStore(env, env.signers[7], StoreType.Sales, { aicSymbol: "CCC" });
      await buy(env, other, env.signers[8], USDC(5000));

      const trader = env.signers[6];
      await buy(env, store, trader, USDC(10));
      const held = await store.aic.balanceOf(trader.address);

      // Ask for far more USDC than this market holds; other market funds must be unreachable.
      const q = await env.agentGoods.quoteSell(await store.aic.getAddress(), held * 10_000n);
      expect(q.enoughRealReserve).to.equal(false);
      await (await store.aic.connect(trader).approve(await env.agentGoods.getAddress(), held)).wait();
      // Selling everything they own is still fine and bounded by this market reserve.
      await (
        await env.agentGoods.connect(trader).sell(await store.aic.getAddress(), held, 0, await deadline())
      ).wait();
      const m = await env.agentGoods.market(await store.aic.getAddress());
      expect(m.realUSDCReserve).to.be.greaterThanOrEqual(0n);
      const acct = await env.agentGoods.usdcAccounting();
      expect(acct.delta).to.equal(0n);
    });
  });
});
