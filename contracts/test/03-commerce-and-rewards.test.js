const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployProtocol,
  createStore,
  fundUSDC,
  buyAIC,
  StoreType,
  USDC,
  AIC,
} = require("./helpers/deploy");

/** Phase 10.1: the "no declaration" value. A listing without one is valid. */
const UNDECLARED = { tokensSaved: 1000n, modelTier: ethers.encodeBytes32String("gpt-6-luna"), basis: 1, declaredAt: 0n }; // every product must declare

/** Phase 10.1: build a seller token-saving declaration. Always an unverified seller claim. */
function declaration(tokensSaved, modelTier, basis = 2) {
  return {
    tokensSaved: BigInt(tokensSaved),
    modelTier: ethers.encodeBytes32String(modelTier),
    basis,
    declaredAt: 0n,
  };
}


const PRODUCT = ethers.id("product-1");
const LicenseKind = { PermanentPurchase: 0, TimedRental: 1 };

/** Reference implementation of the canonical payment waterfall, computed independently. */
function ceilBps(amount, bps) {
  if (amount === 0n || bps === 0n) return 0n;
  const r = (amount * bps + 9_999n) / 10_000n;
  return r > amount ? amount : r;
}

/** Protected shares round UP; the controller remainder absorbs the dust. */
function waterfall(gross, commerceFeeBps = 250n, holderReserveBps = 2000n) {
  const protocolFee = ceilBps(gross, commerceFeeBps);
  const net = gross - protocolFee;
  const holderReserve = ceilBps(net, holderReserveBps);
  const ownerAvailable = net - holderReserve;
  return { gross, protocolFee, net, holderReserve, ownerAvailable };
}

/** Reference implementation of the geometric pool decay, computed independently. */
function decayReward(pool, units, rate, denom, minPool, gate) {
  if (pool <= gate) return 0n;
  let total = 0n;
  for (let i = 0; i < units; i++) {
    if (pool < minPool) break;
    const unitReward = (pool * rate) / denom;
    if (unitReward === 0n) break;
    total += unitReward;
    pool -= unitReward;
  }
  return total;
}

describe("Commerce settlement, holder reserve and AIC customer incentives", function () {
  async function salesFixture() {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[5], StoreType.Sales);
    await (
      await store.store
        .connect(store.creator)
        .createProduct(PRODUCT, USDC(10), 1000, 0, ethers.id("content"), "ipfs://product", UNDECLARED)
    ).wait();
    return { env, store };
  }

  async function rentalsFixture() {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[5], StoreType.Rentals, { aicSymbol: "RENT" });
    await (
      await store.store
        .connect(store.creator)
        .createProduct(PRODUCT, USDC(2), 100, 86400, ethers.id("content"), "ipfs://rental", UNDECLARED)
    ).wait();
    return { env, store };
  }

  async function buyProduct(env, store, buyer, units = 1, maxTotal = USDC(1_000_000)) {
    const gross = USDC(10) * BigInt(units);
    await fundUSDC(env, buyer, gross, await store.store.getAddress());
    const version = (await store.store.getProduct(PRODUCT)).version;
    return store.store
      .connect(buyer)
      .purchase(PRODUCT, units, version, maxTotal, ethers.ZeroHash, "ipfs://license");
  }

  describe("Payment waterfall (MASTER_PLAN 0.20, 0.25.D)", function () {
    it("splits gross into 2.5% protocol fee, 5% holder reserve of net, and owner available", async function () {
      const { env, store } = await loadFixture(salesFixture);
      const expected = waterfall(USDC(10));
      const preview = await store.store.previewSettlement(USDC(10));
      expect(preview.protocolFee).to.equal(expected.protocolFee);
      expect(preview.net).to.equal(expected.net);
      expect(preview.holderReserve).to.equal(expected.holderReserve);
      expect(preview.ownerAvailable).to.equal(expected.ownerAvailable);
      expect(preview.gross).to.equal(preview.protocolFee + preview.holderReserve + preview.ownerAvailable);
    });

    it("executes the waterfall exactly, forwards the protocol fee and buys back the holders' share", async function () {
      const { env, store } = await loadFixture(salesFixture);
      const w = waterfall(USDC(10));
      const aicToken = await store.aic.getAddress();
      const treasury0 = await env.usdc.balanceOf(await env.treasury.getAddress());
      const real0 = (await env.agentGoods.market(aicToken)).realUSDCReserve;
      await buyProduct(env, store, env.signers[6], 1);

      expect(await store.store.ownerAvailableUSDC()).to.equal(w.ownerAvailable);
      // The holders' share never sits in the store: it bought and burned the store's AIC.
      expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
      expect(await store.store.lifetimeHolderReserveAccruedUSDC()).to.equal(w.holderReserve);
      expect((await env.agentGoods.market(aicToken)).realUSDCReserve - real0).to.equal(w.holderReserve);
      expect((await env.usdc.balanceOf(await env.treasury.getAddress())) - treasury0).to.equal(w.protocolFee);
      expect(await env.usdc.balanceOf(await store.store.getAddress())).to.equal(w.ownerAvailable);
    });

    it("keeps lifetime conservation across many purchases", async function () {
      const { env, store } = await loadFixture(salesFixture);
      for (let i = 0; i < 12; i++) {
        await buyProduct(env, store, env.signers[6], (i % 4) + 1);
      }
      const net = await store.store.lifetimeNetCommerceUSDC();
      const ownerAccrued = await store.store.lifetimeOwnerAvailableAccruedUSDC();
      const reserveAccrued = await store.store.lifetimeHolderReserveAccruedUSDC();
      expect(net).to.equal(ownerAccrued + reserveAccrued);

      // Every holders' share was bought back in its own purchase; none is held back.
      expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
      expect(await store.store.lifetimeHolderReserveCommittedUSDC()).to.equal(0n);
      let expectedReserve = 0n;
      for (let i = 0; i < 12; i++) expectedReserve += waterfall(USDC(10) * BigInt((i % 4) + 1)).holderReserve;
      expect(reserveAccrued).to.equal(expectedReserve);

      const onHand = await env.usdc.balanceOf(await store.store.getAddress());
      const ownerAvailable = await store.store.ownerAvailableUSDC();
      expect(onHand).to.equal(ownerAvailable);
    });

    it("cannot be split-traded into extracting more value than a single purchase", async function () {
      const { env, store } = await loadFixture(salesFixture);
      const single = await store.store.previewSettlement(USDC(100));

      let splitOwner = 0n;
      let splitReserve = 0n;
      let splitFee = 0n;
      for (let i = 0; i < 10; i++) {
        const s = await store.store.previewSettlement(USDC(10));
        splitOwner += s.ownerAvailable;
        splitReserve += s.holderReserve;
        splitFee += s.protocolFee;
      }
      // Splitting can only ever lose dust to rounding, never gain.
      expect(splitOwner).to.be.lessThanOrEqual(single.ownerAvailable);
      expect(splitFee + splitReserve + splitOwner).to.be.lessThanOrEqual(USDC(100));
    });
  });

  describe("Quote binding and authorization (MASTER_PLAN 0.24.G, 0.24.H, 29)", function () {
    it("rejects a purchase whose expected product version is stale", async function () {
      const { env, store } = await loadFixture(salesFixture);
      const buyer = env.signers[6];
      const staleVersion = (await store.store.getProduct(PRODUCT)).version;
      await (
        await store.store
          .connect(store.creator)
          .updateProduct(PRODUCT, USDC(20), 1000, 0, true, ethers.id("content"), "ipfs://v2", UNDECLARED)
      ).wait();

      await fundUSDC(env, buyer, USDC(100), await store.store.getAddress());
      await expect(
        store.store
          .connect(buyer)
          .purchase(PRODUCT, 1, staleVersion, USDC(100), ethers.ZeroHash, "")
      ).to.be.revertedWithCustomError(store.store, "ProductVersionMismatch");
    });

    it("rejects a purchase above the Agent authorized maximum", async function () {
      const { env, store } = await loadFixture(salesFixture);
      const buyer = env.signers[6];
      await fundUSDC(env, buyer, USDC(100), await store.store.getAddress());
      const version = (await store.store.getProduct(PRODUCT)).version;
      await expect(
        store.store.connect(buyer).purchase(PRODUCT, 2, version, USDC(19), ethers.ZeroHash, "")
      ).to.be.revertedWithCustomError(store.store, "PriceAboveMaximum");
    });

    it("has no server-signed purchase path at all", async function () {
      const { store } = await loadFixture(salesFixture);
      const names = store.store.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(names).to.not.include("setServerSigner");
      expect(names.some((n) => /signature|serverSigner/i.test(n))).to.equal(false);
    });

    it("has no refund path at all (MASTER_PLAN 0.13 no-refund V1 invariant)", async function () {
      const { store } = await loadFixture(salesFixture);
      const names = store.store.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(names.some((n) => /refund/i.test(n))).to.equal(false);
      const licenseNames = store.license.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(licenseNames.some((n) => /burn/i.test(n))).to.equal(false);
    });

    it("decrements inventory and rejects an oversold purchase", async function () {
      const { env, store } = await loadFixture(salesFixture);
      await (
        await store.store
          .connect(store.creator)
          .updateProduct(PRODUCT, USDC(10), 2, 0, true, ethers.id("content"), "", UNDECLARED)
      ).wait();
      const buyer = env.signers[6];
      const version = (await store.store.getProduct(PRODUCT)).version;
      await fundUSDC(env, buyer, USDC(100), await store.store.getAddress());
      await (
        await store.store.connect(buyer).purchase(PRODUCT, 2, version, USDC(100), ethers.ZeroHash, "")
      ).wait();
      expect((await store.store.getProduct(PRODUCT)).inventory).to.equal(0n);
      await expect(
        store.store.connect(buyer).purchase(PRODUCT, 1, version, USDC(100), ethers.ZeroHash, "")
      ).to.be.revertedWithCustomError(store.store, "InsufficientInventory");
    });
  });

  describe("LicenseToken (MASTER_PLAN 0.13, PHASE 10)", function () {
    it("mints a permanent non-transferable license on purchase", async function () {
      const { env, store } = await loadFixture(salesFixture);
      const buyer = env.signers[6];
      await buyProduct(env, store, buyer, 3);

      expect(await store.license.totalIssued()).to.equal(1n);
      expect(await store.license.ownerOf(1)).to.equal(buyer.address);
      const data = await store.license.licenseData(1);
      expect(data.productId).to.equal(PRODUCT);
      expect(data.quantity).to.equal(3n);
      expect(data.expiresAt).to.equal(0n);
      expect(data.kind).to.equal(LicenseKind.PermanentPurchase);
      expect(await store.license.isValid(1)).to.equal(true);
    });

    it("refuses every transfer and approval", async function () {
      const { env, store } = await loadFixture(salesFixture);
      const buyer = env.signers[6];
      await buyProduct(env, store, buyer, 1);
      await expect(
        store.license.connect(buyer).transferFrom(buyer.address, env.signers[7].address, 1)
      ).to.be.revertedWithCustomError(store.license, "NonTransferable");
      await expect(store.license.connect(buyer).approve(env.signers[7].address, 1)).to.be.revertedWithCustomError(
        store.license,
        "NonTransferable"
      );
      await expect(
        store.license.connect(buyer).setApprovalForAll(env.signers[7].address, true)
      ).to.be.revertedWithCustomError(store.license, "NonTransferable");
    });

    it("refuses minting from anyone other than the canonical store", async function () {
      const { env, store } = await loadFixture(salesFixture);
      await expect(
        store.license
          .connect(env.signers[9])
          .mint(env.signers[9].address, PRODUCT, 1, 0, 1, LicenseKind.PermanentPurchase, ethers.ZeroHash, "")
      ).to.be.revertedWithCustomError(store.license, "NotStore");
    });
  });

  describe("Rental time semantics (MASTER_PLAN 0.24.I)", function () {
    async function rent(env, store, renter, periods) {
      const gross = USDC(2) * BigInt(periods);
      await fundUSDC(env, renter, gross, await store.store.getAddress());
      const version = (await store.store.getProduct(PRODUCT)).version;
      return store.store.connect(renter).rent(PRODUCT, periods, version, gross, ethers.ZeroHash, "");
    }

    it("sets expiry from chain time, exclusive of the end instant", async function () {
      const { env, store } = await loadFixture(rentalsFixture);
      const renter = env.signers[6];
      const tx = await rent(env, store, renter, 3);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const data = await store.license.licenseData(1);
      expect(data.expiresAt).to.equal(BigInt(block.timestamp) + 3n * 86400n);
      expect(data.kind).to.equal(LicenseKind.TimedRental);
      expect(await store.license.isValid(1)).to.equal(true);

      await time.increaseTo(Number(data.expiresAt) - 1);
      expect(await store.license.isValid(1)).to.equal(true);
      await time.increaseTo(Number(data.expiresAt));
      expect(await store.license.isValid(1)).to.equal(false);
    });

    it("consumes exactly one concurrent rental slot regardless of duration", async function () {
      const { env, store } = await loadFixture(rentalsFixture);
      const before = (await store.store.getProduct(PRODUCT)).inventory;
      await rent(env, store, env.signers[6], 30);
      expect((await store.store.getProduct(PRODUCT)).inventory).to.equal(before - 1n);
    });

    it("rejects a rental period outside the configured bounds", async function () {
      const { env, store } = await loadFixture(rentalsFixture);
      await expect(
        store.store
          .connect(store.creator)
          .createProduct(ethers.id("bad"), USDC(1), 1, 30, ethers.ZeroHash, "", UNDECLARED)
      ).to.be.revertedWithCustomError(store.store, "InvalidRentalPeriod");
    });
  });

  describe("AIC customer incentive decay model (MASTER_PLAN 15)", function () {
    async function fundRewardPool(env, store, amount) {
      const controller = store.creator;
      await buyAIC(env, store, controller, USDC(2000));
      const held = await store.aic.balanceOf(controller.address);
      expect(held).to.be.greaterThan(amount);
      await (await store.aic.connect(controller).approve(await store.store.getAddress(), amount)).wait();
      await (await store.store.connect(controller).depositRewardPool(amount)).wait();
      return held;
    }

    it("gives the controller no free founder allocation: its AIC is what its initial capital bought", async function () {
      const { store } = await loadFixture(salesFixture);
      expect(await store.aic.balanceOf(store.creator.address)).to.equal(store.seedTokens);
      await expect(
        store.store.connect(store.creator).depositRewardPool(AIC(1))
      ).to.be.revertedWithCustomError(store.aic, "ERC20InsufficientAllowance");
    });

    it("backs the pool with really transferred AIC", async function () {
      const { env, store } = await loadFixture(salesFixture);
      await fundRewardPool(env, store, AIC(1_000_000));
      expect(await store.store.rewardPool()).to.equal(AIC(1_000_000));
      expect(await store.aic.balanceOf(await store.store.getAddress())).to.equal(AIC(1_000_000));
    });

    it("matches the Sales decay formula exactly (2/1000 of the remaining pool per unit)", async function () {
      const { env, store } = await loadFixture(salesFixture);
      const pool = AIC(1_000_000);
      await fundRewardPool(env, store, pool);

      for (const units of [1, 2, 5, 10, 100]) {
        const expected = decayReward(pool, units, 2n, 1000n, 500n, 0n);
        expect(await store.store.previewReward(units)).to.equal(expected);
      }
    });

    it("matches the Rentals decay formula exactly (2/100000 per period, 100000 gate)", async function () {
      const { env, store } = await loadFixture(rentalsFixture);
      const controller = store.creator;
      await buyAIC(env, store, controller, USDC(2000));
      const pool = AIC(1_000_000);
      await (await store.aic.connect(controller).approve(await store.store.getAddress(), pool)).wait();
      await (await store.store.connect(controller).depositRewardPool(pool)).wait();

      for (const units of [1, 2, 5, 30, 365]) {
        const expected = decayReward(pool, units, 2n, 100000n, 500n, 100000n);
        expect(await store.store.previewReward(units)).to.equal(expected);
      }
    });

    it("uses different rates for Sales and Rentals rather than one generic percentage", async function () {
      const env = await deployProtocol();
      const sales = await createStore(env, env.signers[5], StoreType.Sales, { aicSymbol: "S1" });
      const rentals = await createStore(env, env.signers[6], StoreType.Rentals, { aicSymbol: "R1" });
      expect(await sales.store.rewardRateDenominator()).to.equal(1000n);
      expect(await rentals.store.rewardRateDenominator()).to.equal(100000n);
      expect(await sales.store.rewardPoolGate()).to.equal(0n);
      expect(await rentals.store.rewardPoolGate()).to.equal(100000n);
    });

    it("pays exactly the previewed reward and reduces the pool once, not twice", async function () {
      const { env, store } = await loadFixture(salesFixture);
      const pool = AIC(1_000_000);
      await fundRewardPool(env, store, pool);

      const buyer = env.signers[7];
      const expected = await store.store.previewReward(3);
      const burnedBefore = await store.aic.totalBurned();
      const receipt = await (await buyProduct(env, store, buyer, 3)).wait();
      const buyback = receipt.logs
        .map((l) => {
          try {
            return env.agentGoods.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "BuybackBurned");

      expect(await store.aic.balanceOf(buyer.address)).to.equal(expected);
      // Single reduction: the V0 transfer-then-burn double subtraction is not reproduced.
      expect(await store.store.rewardPool()).to.equal(pool - expected);
      expect(await store.aic.balanceOf(await store.store.getAddress())).to.equal(pool - expected);
      expect(await store.store.lifetimeRewardDistributed()).to.equal(expected);
      // The only burn in the purchase is the holders' buyback; the reward itself burns nothing.
      expect((await store.aic.totalBurned()) - burnedBefore).to.equal(buyback.args.aicBurned);
    });

    it("decays progressively across repeated purchases and never underflows", async function () {
      const { env, store } = await loadFixture(salesFixture);
      await fundRewardPool(env, store, AIC(1000));

      let previous = await store.store.previewReward(1);
      for (let i = 0; i < 25; i++) {
        const reward = await store.store.previewReward(1);
        expect(reward).to.be.lessThanOrEqual(previous);
        previous = reward;
        await buyProduct(env, store, env.signers[7], 1);
        expect(await store.store.rewardPool()).to.be.greaterThanOrEqual(0n);
      }
      expect(await store.store.rewardPool()).to.be.greaterThan(0n);
    });

    it("works with a zero reward pool", async function () {
      const { env, store } = await loadFixture(salesFixture);
      expect(await store.store.previewReward(5)).to.equal(0n);
      await buyProduct(env, store, env.signers[6], 1);
      expect(await store.aic.balanceOf(env.signers[6].address)).to.equal(0n);
    });

    it("never distributes more AIC than the store holds", async function () {
      const { env, store } = await loadFixture(salesFixture);
      await fundRewardPool(env, store, AIC(1000));
      for (let i = 0; i < 30; i++) {
        await buyProduct(env, store, env.signers[7], 10);
        const pool = await store.store.rewardPool();
        const held = await store.aic.balanceOf(await store.store.getAddress());
        expect(held).to.be.greaterThanOrEqual(pool);
      }
    });

    it("lets the Agent preview match the executed result for unchanged state", async function () {
      const { env, store } = await loadFixture(salesFixture);
      await fundRewardPool(env, store, AIC(500_000));
      const buyer = env.signers[7];
      const predicted = await store.store.previewReward(7);
      const before = await store.aic.balanceOf(buyer.address);
      await buyProduct(env, store, buyer, 7);
      expect((await store.aic.balanceOf(buyer.address)) - before).to.equal(predicted);
    });

    it("charges no protocol fee on the AIC incentive itself", async function () {
      const { env, store } = await loadFixture(salesFixture);
      await fundRewardPool(env, store, AIC(1_000_000));
      const treasuryAicBefore = await store.aic.balanceOf(await env.treasury.getAddress());
      await buyProduct(env, store, env.signers[7], 2);
      expect(await store.aic.balanceOf(await env.treasury.getAddress())).to.equal(treasuryAicBefore);
    });
  });

  describe("Controller withdrawal boundaries (MASTER_PLAN 0.25.D)", function () {
    it("lets the controller withdraw only owner-available proceeds", async function () {
      const { env, store } = await loadFixture(salesFixture);
      await buyProduct(env, store, env.signers[6], 10);
      const available = await store.store.ownerAvailableUSDC();
      const bought = await store.store.lifetimeHolderReserveAccruedUSDC();
      expect(bought).to.be.greaterThan(0n);

      await expect(
        store.store.connect(store.creator).withdrawOwnerProceeds(available + 1n, store.creator.address)
      ).to.be.revertedWithCustomError(store.store, "InsufficientOwnerBalance");

      await (
        await store.store.connect(store.creator).withdrawOwnerProceeds(available, store.creator.address)
      ).wait();
      expect(await env.usdc.balanceOf(store.creator.address)).to.equal(available);
      // The holders' share was already bought back at purchase time: nothing of it was in the
      // store for the controller to reach, and after withdrawing everything the store is empty.
      expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
      expect(await store.store.lifetimeHolderReserveAccruedUSDC()).to.equal(bought);
      expect(await env.usdc.balanceOf(await store.store.getAddress())).to.equal(0n);
    });

    it("refuses a withdrawal from a non-controller", async function () {
      const { env, store } = await loadFixture(salesFixture);
      await buyProduct(env, store, env.signers[6], 1);
      await expect(
        store.store.connect(env.signers[9]).withdrawOwnerProceeds(1n, env.signers[9].address)
      ).to.be.revertedWithCustomError(store.store, "NotController");
    });

    it("refuses to rescue canonical USDC or canonical AIC", async function () {
      const { env, store } = await loadFixture(salesFixture);
      await expect(
        store.store.connect(store.creator).rescueToken(await env.usdc.getAddress(), store.creator.address)
      ).to.be.revertedWithCustomError(store.store, "ProtectedToken");
      await expect(
        store.store.connect(store.creator).rescueToken(await store.aic.getAddress(), store.creator.address)
      ).to.be.revertedWithCustomError(store.store, "ProtectedToken");
    });

    it("has no arbitrary call, delegatecall or worker payment path", async function () {
      const { store } = await loadFixture(salesFixture);
      const names = store.store.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      for (const forbidden of ["execute", "call", "delegatecall", "payWorker", "multicall", "setFeeRecipient"]) {
        expect(names).to.not.include(forbidden);
      }
    });
  });
});

/**
 * The withdrawal cooldown.
 *
 * Three hours between controller withdrawals, so that opening a dividend epoch is not always the
 * strictly worse option for a controller. It moves the TIMING of access and nothing else: no money
 * is forfeited, no money is redirected, and the balance keeps accruing while the timer runs.
 */
describe("Controller withdrawals are spaced", function () {
  const P = ethers.id("cooldown-product");

  async function fixture() {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[9], StoreType.Sales, { aicSymbol: "COOL" });
    await (
      await store.store
        .connect(store.creator)
        .createProduct(P, USDC(10), 1000, 0, ethers.id("c"), "ipfs://p", UNDECLARED)
    ).wait();
    return { env, store };
  }

  async function sell(env, store, buyer) {
    await fundUSDC(env, buyer, USDC(10), await store.store.getAddress());
    const version = (await store.store.getProduct(P)).version;
    await (
      await store.store.connect(buyer).purchase(P, 1, version, USDC(1000), ethers.ZeroHash, "ipfs://l")
    ).wait();
  }

  it("allows the FIRST withdrawal immediately", async function () {
    const { env, store } = await loadFixture(fixture);
    await sell(env, store, env.signers[8]);

    const available = await store.store.ownerAvailableUSDC();
    expect(available).to.be.greaterThan(0n);
    expect(await store.store.nextOwnerWithdrawalAt()).to.equal(0n);
    await expect(
      store.store.connect(store.creator).withdrawOwnerProceeds(available, store.creator.address)
    ).to.not.be.reverted;
  });

  it("refuses a SECOND withdrawal inside three hours, naming when it may retry", async function () {
    const { env, store } = await loadFixture(fixture);
    await sell(env, store, env.signers[8]);
    await (await store.store.connect(store.creator).withdrawOwnerProceeds(1n, store.creator.address)).wait();

    expect(await store.store.nextOwnerWithdrawalAt()).to.be.greaterThan(0n);
    expect(await store.store.secondsUntilOwnerWithdrawal()).to.be.greaterThan(0n);
    await expect(
      store.store.connect(store.creator).withdrawOwnerProceeds(1n, store.creator.address)
    ).to.be.revertedWithCustomError(store.store, "WithdrawalTooSoon");
  });

  it("allows it again once three hours have passed", async function () {
    const { env, store } = await loadFixture(fixture);
    await sell(env, store, env.signers[8]);
    await (await store.store.connect(store.creator).withdrawOwnerProceeds(1n, store.creator.address)).wait();

    await time.increase(3 * 60 * 60);
    expect(await store.store.secondsUntilOwnerWithdrawal()).to.equal(0n);
    await expect(
      store.store.connect(store.creator).withdrawOwnerProceeds(1n, store.creator.address)
    ).to.not.be.reverted;
  });

  it("does not touch the money: proceeds keep accruing while the timer runs", async function () {
    const { env, store } = await loadFixture(fixture);
    await sell(env, store, env.signers[8]);
    await (await store.store.connect(store.creator).withdrawOwnerProceeds(1n, store.creator.address)).wait();

    const before = await store.store.ownerAvailableUSDC();
    await sell(env, store, env.signers[7]);
    expect(await store.store.ownerAvailableUSDC()).to.be.greaterThan(
      before,
      "proceeds must still accrue during the cooldown"
    );
  });

  it("never touches the holders' share, which was bought back at purchase time", async function () {
    const { env, store } = await loadFixture(fixture);
    await sell(env, store, env.signers[8]);
    const bought = await store.store.lifetimeHolderReserveAccruedUSDC();
    await (await store.store.connect(store.creator).withdrawOwnerProceeds(1n, store.creator.address)).wait();
    expect(bought).to.be.greaterThan(0n);
    expect(await store.store.lifetimeHolderReserveAccruedUSDC()).to.equal(bought);
    expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
  });
});
