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

const PRODUCT = ethers.id("ts-product");
const OTHER_PRODUCT = ethers.id("ts-product-2");
const SIGNAL_WINDOW = 7 * 24 * 3600;
const MIN_SIGNALS = 5;

const Basis = { Undeclared: 0, Estimated: 1, Measured: 2 };
const UNDECLARED = { tokensSaved: 0n, modelTier: ethers.ZeroHash, basis: Basis.Undeclared, declaredAt: 0n };

function declaration(tokensSaved, modelTier, basis = Basis.Measured) {
  return {
    tokensSaved: BigInt(tokensSaved),
    modelTier: ethers.encodeBytes32String(modelTier),
    basis,
    declaredAt: 0n,
  };
}

describe("Phase 10.1 — declared token saving and post-purchase buyer signal", function () {
  async function fixture() {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[5], StoreType.Sales, { aicSymbol: "TS" });
    const creator = env.signers[5];
    const attestor = env.signers[14];

    await (
      await store.store
        .connect(creator)
        .createProduct(
          PRODUCT,
          USDC(10),
          1000000,
          0,
          ethers.id("content"),
          "ipfs://p",
          declaration(250_000, "frontier-2025-class", Basis.Measured)
        )
    ).wait();

    await (await store.store.connect(creator).setAccessAttestor(attestor.address)).wait();

    return { env, store, creator, attestor };
  }

  async function buy(env, store, buyer, units = 1, productId = PRODUCT) {
    const p = await store.store.getProduct(productId);
    const gross = p.priceUSDC * BigInt(units);
    await fundUSDC(env, buyer, gross, await store.store.getAddress());
    const tx = await store.store
      .connect(buyer)
      .purchase(productId, units, p.version, gross, ethers.ZeroHash, "");
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => {
        try {
          return store.license.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "LicenseIssued");
    return ev.args.tokenId;
  }

  async function deliver(store, attestor, licenseId) {
    return (await store.license.connect(attestor).recordAccessGrant(licenseId)).wait();
  }

  // ======================================================== A. declaration ==

  describe("A. Declared token saving (MASTER_PLAN 14A.1)", function () {
    it("stores the declaration fully on chain with a chain-stamped declaredAt", async function () {
      const { store } = await loadFixture(fixture);
      const p = await store.store.getProduct(PRODUCT);
      expect(p.declaration.tokensSaved).to.equal(250_000n);
      expect(ethers.decodeBytes32String(p.declaration.modelTier)).to.equal("frontier-2025-class");
      expect(p.declaration.basis).to.equal(Basis.Measured);
      expect(p.declaration.declaredAt).to.be.greaterThan(0n);
    });

    it("refuses a listing with no declaration at all", async function () {
      const { store, creator } = await loadFixture(fixture);
      await expect(
        store.store.connect(creator).createProduct(OTHER_PRODUCT, USDC(4), 10, 0, ethers.ZeroHash, "", UNDECLARED)
      ).to.be.revertedWithCustomError(store.store, "InvalidDeclaration");
    });

    it("emits a dedicated declaration event for zero-RPC indexing", async function () {
      const { store, creator } = await loadFixture(fixture);
      await expect(
        store.store
          .connect(creator)
          .createProduct(
            OTHER_PRODUCT,
            USDC(4),
            10,
            0,
            ethers.ZeroHash,
            "",
            declaration(900, "small-2025-class", Basis.Estimated)
          )
      )
        .to.emit(store.store, "TokenSavingDeclared")
        .withArgs(
          OTHER_PRODUCT,
          1n,
          900n,
          ethers.encodeBytes32String("small-2025-class"),
          Basis.Estimated,
          (v) => v > 0n
        );
    });

    it("rejects an internally inconsistent declaration", async function () {
      const { store, creator } = await loadFixture(fixture);
      // Declared basis with no token count.
      await expect(
        store.store
          .connect(creator)
          .createProduct(OTHER_PRODUCT, USDC(4), 10, 0, ethers.ZeroHash, "", {
            tokensSaved: 0n,
            modelTier: ethers.encodeBytes32String("x"),
            basis: Basis.Measured,
            declaredAt: 0n,
          })
      ).to.be.revertedWithCustomError(store.store, "InvalidDeclaration");

      // Declared basis with no model tier.
      await expect(
        store.store
          .connect(creator)
          .createProduct(OTHER_PRODUCT, USDC(4), 10, 0, ethers.ZeroHash, "", {
            tokensSaved: 10n,
            modelTier: ethers.ZeroHash,
            basis: Basis.Estimated,
            declaredAt: 0n,
          })
      ).to.be.revertedWithCustomError(store.store, "InvalidDeclaration");

      // Undeclared basis carrying values.
      await expect(
        store.store
          .connect(creator)
          .createProduct(OTHER_PRODUCT, USDC(4), 10, 0, ethers.ZeroHash, "", {
            tokensSaved: 10n,
            modelTier: ethers.ZeroHash,
            basis: Basis.Undeclared,
            declaredAt: 0n,
          })
      ).to.be.revertedWithCustomError(store.store, "InvalidDeclaration");
    });

    it("ignores a caller-supplied declaredAt and stamps chain time instead", async function () {
      const { store, creator } = await loadFixture(fixture);
      await (
        await store.store.connect(creator).createProduct(OTHER_PRODUCT, USDC(4), 10, 0, ethers.ZeroHash, "", {
          tokensSaved: 42n,
          modelTier: ethers.encodeBytes32String("m"),
          basis: Basis.Estimated,
          declaredAt: 999999999n,
        })
      ).wait();
      const p = await store.store.getProduct(OTHER_PRODUCT);
      expect(p.declaration.declaredAt).to.not.equal(999999999n);
      const block = await ethers.provider.getBlock("latest");
      expect(p.declaration.declaredAt).to.equal(BigInt(block.timestamp));
    });

    it("is immutable within a listing version and bumps the version when changed", async function () {
      const { store, creator } = await loadFixture(fixture);
      const before = await store.store.getProduct(PRODUCT);
      expect(before.version).to.equal(1n);

      await (
        await store.store
          .connect(creator)
          .updateProduct(
            PRODUCT,
            USDC(10),
            1000000,
            0,
            true,
            ethers.id("content"),
            "ipfs://p",
            declaration(10, "frontier-2025-class", Basis.Estimated)
          )
      ).wait();

      const after = await store.store.getProduct(PRODUCT);
      expect(after.version).to.equal(2n);
      expect(after.declaration.tokensSaved).to.equal(10n);
      expect(after.declaration.basis).to.equal(Basis.Estimated);

      // There is no function that can mutate a declaration without bumping the version.
      const names = store.store.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(names.filter((n) => /declar/i.test(n))).to.deep.equal([]);
    });

    it("lets a historical purchase keep the claim it was sold under", async function () {
      const { env, store, creator } = await loadFixture(fixture);
      const buyer = env.signers[6];
      const v1Declaration = (await store.store.getProduct(PRODUCT)).declaration;
      const licenseId = await buy(env, store, buyer, 1);
      const license = await store.license.licenseData(licenseId);
      expect(license.productVersion).to.equal(1n);

      // The seller now downgrades the claim on a new version.
      await (
        await store.store
          .connect(creator)
          .updateProduct(
            PRODUCT,
            USDC(10),
            1000000,
            0,
            true,
            ethers.id("content"),
            "ipfs://p",
            declaration(1, "frontier-2025-class", Basis.Estimated)
          )
      ).wait();

      // The license still points at version 1, whose declaration is reconstructible from the
      // TokenSavingDeclared event stream and is what the indexer keeps per (productId, version).
      expect((await store.license.licenseData(licenseId)).productVersion).to.equal(1n);
      expect(v1Declaration.tokensSaved).to.equal(250_000n);
      expect((await store.store.getProduct(PRODUCT)).version).to.equal(2n);
    });

    it("still reverts a purchase quoted against the pre-edit version", async function () {
      const { env, store, creator } = await loadFixture(fixture);
      const buyer = env.signers[6];
      await (
        await store.store
          .connect(creator)
          .updateProduct(
            PRODUCT,
            USDC(10),
            1000000,
            0,
            true,
            ethers.id("content"),
            "ipfs://p",
            declaration(5, "frontier-2025-class", Basis.Estimated)
          )
      ).wait();
      await fundUSDC(env, buyer, USDC(10), await store.store.getAddress());
      await expect(
        store.store.connect(buyer).purchase(PRODUCT, 1, 1, USDC(10), ethers.ZeroHash, "")
      ).to.be.revertedWithCustomError(store.store, "ProductVersionMismatch");
    });

    it("refuses a declaration change from a non-controller", async function () {
      const { env, store } = await loadFixture(fixture);
      await expect(
        store.store
          .connect(env.signers[9])
          .updateProduct(
            PRODUCT,
            USDC(10),
            1,
            0,
            true,
            ethers.ZeroHash,
            "",
            declaration(1, "x", Basis.Estimated)
          )
      ).to.be.revertedWithCustomError(store.store, "NotController");
    });
  });

  // ============================================================== B. signal ==

  describe("B. Access attestation (MASTER_PLAN 14A.2)", function () {
    it("only lets the store attestor record a delivery", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const licenseId = await buy(env, store, env.signers[6], 1);

      for (const who of [env.signers[6], env.signers[5], env.deployer, env.guardian]) {
        await expect(
          store.license.connect(who).recordAccessGrant(licenseId)
        ).to.be.revertedWithCustomError(store.license, "NotAttestor");
      }
      await expect(store.license.connect(attestor).recordAccessGrant(licenseId)).to.emit(
        store.license,
        "AccessGranted"
      );
      expect(await store.license.wasDelivered(licenseId)).to.equal(true);
      expect(await store.license.accessGrantCount(licenseId)).to.equal(1n);
      expect(await store.license.deliveredCount()).to.equal(1n);
    });

    it("counts a license as delivered exactly once however many grants it gets", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const licenseId = await buy(env, store, env.signers[6], 1);
      await deliver(store, attestor, licenseId);
      await deliver(store, attestor, licenseId);
      await deliver(store, attestor, licenseId);
      expect(await store.license.accessGrantCount(licenseId)).to.equal(3n);
      expect(await store.license.deliveredCount()).to.equal(1n);
    });

    it("lets the protocol delivery gateway record a delivery the seller never attested", async function () {
      const { env, store, creator } = await loadFixture(fixture);
      // The seller removes its own attestor: before the gateway role, its buyers could never rate.
      await (await store.store.connect(creator).setAccessAttestor(ethers.ZeroAddress)).wait();
      const gateway = env.signers[15];
      const licenseId = await buy(env, store, env.signers[6], 1);

      await expect(store.license.connect(gateway).recordAccessGrant(licenseId)).to.be.revertedWithCustomError(
        store.license,
        "NotAttestor"
      );
      const role = await env.registry.DELIVERY_GATEWAY_ROLE();
      await (await env.registry.connect(env.deployer).grantRole(role, gateway.address)).wait();
      expect(await env.registry.isDeliveryGateway(gateway.address)).to.equal(true);

      await expect(store.license.connect(gateway).recordAccessGrant(licenseId)).to.emit(store.license, "AccessGranted");
      expect(await store.license.wasDelivered(licenseId)).to.equal(true);
      // The buyer can now rate, and the seller had no say in it.
      await expect(store.license.connect(env.signers[6]).submitSignal(licenseId, false)).to.not.be.reverted;
    });

    it("gives the delivery gateway no power beyond witnessing", async function () {
      const { env, store } = await loadFixture(fixture);
      const gateway = env.signers[15];
      await (await env.registry.connect(env.deployer).grantRole(await env.registry.DELIVERY_GATEWAY_ROLE(), gateway.address)).wait();
      const licenseId = await buy(env, store, env.signers[6], 1);
      await (await store.license.connect(gateway).recordAccessGrant(licenseId)).wait();
      await expect(store.license.connect(gateway).submitSignal(licenseId, true)).to.be.reverted;
      await expect(store.store.connect(gateway).setAccessAttestor(gateway.address)).to.be.reverted;
    });

    it("refuses attestation when no attestor is configured", async function () {
      const { env, store, creator } = await loadFixture(fixture);
      await (await store.store.connect(creator).setAccessAttestor(ethers.ZeroAddress)).wait();
      const licenseId = await buy(env, store, env.signers[6], 1);
      await expect(
        store.license.connect(env.signers[14]).recordAccessGrant(licenseId)
      ).to.be.revertedWithCustomError(store.license, "NotAttestor");
    });

    it("bounds a batched attestation", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(await buy(env, store, env.signers[6], 1));
      await (await store.license.connect(attestor).recordAccessGrants(ids)).wait();
      for (const id of ids) expect(await store.license.wasDelivered(id)).to.equal(true);

      const tooMany = new Array(201).fill(ids[0]);
      await expect(
        store.license.connect(attestor).recordAccessGrants(tooMany)
      ).to.be.revertedWithCustomError(store.license, "BatchTooLarge");
    });

    it("gives the attestor no other power at all", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const licenseId = await buy(env, store, env.signers[6], 1);
      await deliver(store, attestor, licenseId);

      await expect(
        store.license.connect(attestor).submitSignal(licenseId, true)
      ).to.be.revertedWithCustomError(store.license, "NotLicenseHolder");
      await expect(
        store.license
          .connect(attestor)
          .mint(attestor.address, PRODUCT, 1, 0, 1, 0, ethers.ZeroHash, "")
      ).to.be.revertedWithCustomError(store.license, "NotStore");
      await expect(
        store.store.connect(attestor).withdrawOwnerProceeds(1n, attestor.address)
      ).to.be.revertedWithCustomError(store.store, "NotController");
    });
  });

  describe("B. Buyer signal rules (MASTER_PLAN 14A.2)", function () {
    it("lets the current holder signal after delivery", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const buyer = env.signers[6];
      const licenseId = await buy(env, store, buyer, 1);
      await deliver(store, attestor, licenseId);

      await expect(store.license.connect(buyer).submitSignal(licenseId, true))
        .to.emit(store.license, "BuyerSignalSubmitted")
        .withArgs(licenseId, buyer.address, PRODUCT, true, false, (v) => v > 0n);

      const sig = await store.license.signalOf(licenseId);
      expect(sig.exists).to.equal(true);
      expect(sig.worthIt).to.equal(true);
      expect(sig.changed).to.equal(false);
      expect(sig.selfSignal).to.equal(false);
      expect(sig.signaller).to.equal(buyer.address);
      expect(await store.license.signalledCount()).to.equal(1n);
    });

    it("refuses a signal from a non-holder", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const buyer = env.signers[6];
      const licenseId = await buy(env, store, buyer, 1);
      await deliver(store, attestor, licenseId);

      for (const who of [env.signers[7], env.signers[5], env.deployer]) {
        await expect(
          store.license.connect(who).submitSignal(licenseId, true)
        ).to.be.revertedWithCustomError(store.license, "NotLicenseHolder");
      }
    });

    it("refuses a signal for a license that was never delivered", async function () {
      const { env, store } = await loadFixture(fixture);
      const buyer = env.signers[6];
      const licenseId = await buy(env, store, buyer, 1);
      await expect(
        store.license.connect(buyer).submitSignal(licenseId, true)
      ).to.be.revertedWithCustomError(store.license, "NoAccessGranted");
    });

    it("refuses a signal for an unknown license", async function () {
      const { env, store } = await loadFixture(fixture);
      await expect(
        store.license.connect(env.signers[6]).submitSignal(9999, true)
      ).to.be.revertedWithCustomError(store.license, "UnknownLicense");
    });

    it("makes a previous holder impossible: licenses cannot be transferred at all", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const buyer = env.signers[6];
      const other = env.signers[7];
      const licenseId = await buy(env, store, buyer, 1);
      await deliver(store, attestor, licenseId);

      await expect(
        store.license.connect(buyer).transferFrom(buyer.address, other.address, licenseId)
      ).to.be.revertedWithCustomError(store.license, "NonTransferable");

      // The gate is ownership-based, so it would still be correct for a transferable class.
      expect(await store.license.ownerOf(licenseId)).to.equal(buyer.address);
      await expect(
        store.license.connect(other).submitSignal(licenseId, true)
      ).to.be.revertedWithCustomError(store.license, "NotLicenseHolder");
    });

    it("allows exactly one change inside the window and rejects a second", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const buyer = env.signers[6];
      const licenseId = await buy(env, store, buyer, 1);
      await deliver(store, attestor, licenseId);

      await (await store.license.connect(buyer).submitSignal(licenseId, true)).wait();
      expect(await store.license.canChangeSignal(licenseId)).to.equal(true);

      await expect(store.license.connect(buyer).submitSignal(licenseId, false))
        .to.emit(store.license, "BuyerSignalChanged")
        .withArgs(licenseId, buyer.address, PRODUCT, true, false, (v) => v > 0n);

      const sig = await store.license.signalOf(licenseId);
      expect(sig.worthIt).to.equal(false);
      expect(sig.changed).to.equal(true);
      expect(await store.license.canChangeSignal(licenseId)).to.equal(false);

      await expect(
        store.license.connect(buyer).submitSignal(licenseId, true)
      ).to.be.revertedWithCustomError(store.license, "SignalAlreadyChanged");

      // A change never double counts.
      expect(await store.license.signalledCount()).to.equal(1n);
    });

    it("rejects a no-op change", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const buyer = env.signers[6];
      const licenseId = await buy(env, store, buyer, 1);
      await deliver(store, attestor, licenseId);
      await (await store.license.connect(buyer).submitSignal(licenseId, true)).wait();
      await expect(
        store.license.connect(buyer).submitSignal(licenseId, true)
      ).to.be.revertedWithCustomError(store.license, "SignalUnchanged");
    });

    it("rejects a change once the window has closed", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const buyer = env.signers[6];
      const licenseId = await buy(env, store, buyer, 1);
      await deliver(store, attestor, licenseId);
      await (await store.license.connect(buyer).submitSignal(licenseId, true)).wait();

      const sig = await store.license.signalOf(licenseId);
      // Exactly at the window boundary the change is still allowed.
      await time.setNextBlockTimestamp(Number(sig.signalledAt) + SIGNAL_WINDOW);
      await (await store.license.connect(buyer).submitSignal(licenseId, false)).wait();
      expect((await store.license.signalOf(licenseId)).worthIt).to.equal(false);

      // A fresh license one second past the window cannot be changed.
      const licenseId2 = await buy(env, store, buyer, 1);
      await deliver(store, attestor, licenseId2);
      await (await store.license.connect(buyer).submitSignal(licenseId2, true)).wait();
      const sig2 = await store.license.signalOf(licenseId2);
      await time.setNextBlockTimestamp(Number(sig2.signalledAt) + SIGNAL_WINDOW + 1);
      await expect(
        store.license.connect(buyer).submitSignal(licenseId2, false)
      ).to.be.revertedWithCustomError(store.license, "SignalWindowClosed");
    });

    it("flags a self signal on chain without blocking the purchase", async function () {
      const { env, store, creator, attestor } = await loadFixture(fixture);
      const licenseId = await buy(env, store, creator, 1);
      await deliver(store, attestor, licenseId);

      await expect(store.license.connect(creator).submitSignal(licenseId, true))
        .to.emit(store.license, "BuyerSignalSubmitted")
        .withArgs(licenseId, creator.address, PRODUCT, true, true, (v) => v > 0n);

      const sig = await store.license.signalOf(licenseId);
      expect(sig.selfSignal).to.equal(true);
      // Raw counts still include it.
      expect(await store.license.signalledCount()).to.equal(1n);
    });

    it("flags a signal from a new controller that bought earlier as a self signal", async function () {
      const { env, store, creator, attestor } = await loadFixture(fixture);
      const buyer = env.signers[6];
      const licenseId = await buy(env, store, buyer, 1);
      await deliver(store, attestor, licenseId);

      // The buyer becomes the controller before signalling.
      await (await store.store.connect(creator).transferController(buyer.address)).wait();
      await (await store.store.connect(buyer).setAccessAttestor(attestor.address)).wait();
      await (await store.license.connect(buyer).submitSignal(licenseId, true)).wait();
      expect((await store.license.signalOf(licenseId)).selfSignal).to.equal(true);
    });
  });

  describe("B. Signals carry zero economic weight (MASTER_PLAN 14A.2)", function () {
    it("exposes no protocol contract function that reads signal state for value", async function () {
      const { env, store } = await loadFixture(fixture);
      const economicContracts = [store.store, store.aic, store.distributor, store.governance, env.agentGoods];
      for (const c of economicContracts) {
        const names = c.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
        expect(names.some((n) => /signal/i.test(n)), "no signal surface on economic contracts").to.equal(
          false
        );
      }
    });

    it("leaves dividends, rewards and fees byte-identical whether or not signals exist", async function () {
      const env = await deployProtocol();
      const results = [];

      for (const withSignals of [false, true]) {
        // A distinct creator per pass: one address may hold only one Sales store, and the two
        // passes are independent runs of the same scenario rather than one seller opening twice.
        const creator = withSignals ? env.signers[5] : env.signers[6];
        const store = await createStore(env, creator, StoreType.Sales, {
          aicSymbol: withSignals ? "SIG" : "NOSIG",
        });
        const attestor = env.signers[14];
        await (
          await store.store
            .connect(creator)
            .createProduct(PRODUCT, USDC(100), 100000, 0, ethers.ZeroHash, "", declaration(1000, "gpt-6-luna", 1))
        ).wait();
        await (await store.store.connect(creator).setAccessAttestor(attestor.address)).wait();

        await buyAIC(env, store, creator, USDC(300));
        const held = await store.aic.balanceOf(creator.address);
        await (await store.aic.connect(creator).approve(await store.store.getAddress(), held / 2n)).wait();
        await (await store.store.connect(creator).depositRewardPool(held / 2n)).wait();

        const buyer = env.signers[6];
        const rewardBefore = await store.aic.balanceOf(buyer.address);
        const ids = [];
        for (let i = 0; i < 5; i++) ids.push(await buy(env, store, buyer, 2));

        if (withSignals) {
          await (await store.license.connect(attestor).recordAccessGrants(ids)).wait();
          for (const id of ids) {
            await (await store.license.connect(buyer).submitSignal(id, true)).wait();
          }
        }

        results.push({
          owner: await store.store.ownerAvailableUSDC(),
          reserve: await store.store.lifetimeHolderReserveAccruedUSDC(),
          pool: await store.store.rewardPool(),
          reward: (await store.aic.balanceOf(buyer.address)) - rewardBefore,
          net: await store.store.lifetimeNetCommerceUSDC(),
        });
      }

      expect(results[1].owner).to.equal(results[0].owner);
      expect(results[1].reserve).to.equal(results[0].reserve);
      expect(results[1].net).to.equal(results[0].net);
      expect(results[1].reward).to.equal(results[0].reward);
    });

    it("fuzz: a loop of self purchases cannot raise any payout", async function () {
      const { env, store, creator, attestor } = await loadFixture(fixture);
      await buyAIC(env, store, creator, USDC(300));
      const held = await store.aic.balanceOf(creator.address);
      await (await store.aic.connect(creator).approve(await store.store.getAddress(), held / 2n)).wait();
      await (await store.store.connect(creator).depositRewardPool(held / 2n)).wait();

      const beforeOwner = await store.store.ownerAvailableUSDC();
      const beforeReserve = await store.store.lifetimeHolderReserveAccruedUSDC();
      const beforeAic = await store.aic.balanceOf(creator.address);
      const beforeUsdc = await env.usdc.balanceOf(creator.address);

      let selfSignals = 0;
      let spent = 0n;
      for (let i = 0; i < 25; i++) {
        const id = await buy(env, store, creator, 1);
        spent += USDC(10);
        await deliver(store, attestor, id);
        await (await store.license.connect(creator).submitSignal(id, true)).wait();
        selfSignals += 1;
        const sig = await store.license.signalOf(id);
        expect(sig.selfSignal).to.equal(true);
      }

      // Every self purchase is a real payment: the controller pays gross and can only ever
      // recover the owner-available slice, so manufacturing signals strictly loses money.
      const afterOwner = await store.store.ownerAvailableUSDC();
      const afterReserve = await store.store.lifetimeHolderReserveAccruedUSDC();
      expect(afterOwner - beforeOwner).to.be.lessThan(spent);
      expect(afterReserve).to.be.greaterThan(beforeReserve);

      const usdcSpent = beforeUsdc - (await env.usdc.balanceOf(creator.address));
      const recoverable = afterOwner - beforeOwner;
      expect(recoverable).to.be.lessThan(usdcSpent + spent);

      // The only AIC movement is the ordinary reward, which is unaffected by signals.
      expect(await store.aic.balanceOf(creator.address)).to.be.greaterThanOrEqual(beforeAic);
      expect(selfSignals).to.equal(25);
      expect(await store.license.signalledCount()).to.equal(25n);
    });
  });

  describe("B. Aggregation semantics reference (MASTER_PLAN 14A.3)", function () {
    /**
     * Reference implementation of the indexer aggregation, proven here against chain state.
     * The backend implements the same rules; the API tests assert both agree.
     */
    function aggregate(rows, minSignals = MIN_SIGNALS) {
      const counted = rows.filter((r) => r.signalled && !r.selfSignal);
      const signalled = counted.length;
      const positive = counted.filter((r) => r.worthIt).length;
      const negative = signalled - positive;
      const delivered = rows.filter((r) => r.delivered).length;
      const insufficient = signalled < minSignals;
      const raw = rows.filter((r) => r.signalled);
      return {
        delivered,
        signalled,
        positive,
        negative,
        coverage: insufficient || delivered === 0 ? null : signalled / delivered,
        positiveRate: insufficient ? null : positive / signalled,
        insufficientSignals: insufficient,
        raw: {
          signalled: raw.length,
          positive: raw.filter((r) => r.worthIt).length,
          negative: raw.filter((r) => !r.worthIt).length,
          selfSignalCount: raw.filter((r) => r.selfSignal).length,
        },
      };
    }

    async function collect(store, ids) {
      const rows = [];
      for (const id of ids) {
        const sig = await store.license.signalOf(id);
        rows.push({
          delivered: await store.license.wasDelivered(id),
          signalled: sig.exists,
          worthIt: sig.worthIt,
          selfSignal: sig.selfSignal,
        });
      }
      return rows;
    }

    it("never exposes a rate below MIN_SIGNALS", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const buyers = [env.signers[6], env.signers[7], env.signers[8], env.signers[9]];
      const ids = [];
      for (const b of buyers) {
        const id = await buy(env, store, b, 1);
        await deliver(store, attestor, id);
        await (await store.license.connect(b).submitSignal(id, true)).wait();
        ids.push(id);
      }

      const agg = aggregate(await collect(store, ids));
      expect(agg.signalled).to.equal(4);
      expect(agg.insufficientSignals).to.equal(true);
      expect(agg.positiveRate).to.equal(null);
      expect(agg.coverage).to.equal(null);
      // Raw counts are still present.
      expect(agg.raw.signalled).to.equal(4);
      expect(agg.positive).to.equal(4);
    });

    it("exposes a rate once MIN_SIGNALS is reached", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const buyers = env.signers.slice(6, 12);
      const ids = [];
      for (let i = 0; i < buyers.length; i++) {
        const id = await buy(env, store, buyers[i], 1);
        await deliver(store, attestor, id);
        await (await store.license.connect(buyers[i]).submitSignal(id, i !== 0)).wait();
        ids.push(id);
      }

      const agg = aggregate(await collect(store, ids));
      expect(agg.signalled).to.equal(6);
      expect(agg.insufficientSignals).to.equal(false);
      expect(agg.positive).to.equal(5);
      expect(agg.negative).to.equal(1);
      expect(agg.positiveRate).to.be.closeTo(5 / 6, 1e-9);
      expect(agg.coverage).to.equal(1);
    });

    it("excludes self signals from rates while keeping them in raw counts", async function () {
      const { env, store, creator, attestor } = await loadFixture(fixture);
      const ids = [];

      // Five honest negative signals from distinct buyers.
      const buyers = env.signers.slice(6, 11);
      for (const b of buyers) {
        const id = await buy(env, store, b, 1);
        await deliver(store, attestor, id);
        await (await store.license.connect(b).submitSignal(id, false)).wait();
        ids.push(id);
      }

      const honest = aggregate(await collect(store, ids));
      expect(honest.positiveRate).to.equal(0);

      // The controller now spams twenty positive self signals.
      for (let i = 0; i < 20; i++) {
        const id = await buy(env, store, creator, 1);
        await deliver(store, attestor, id);
        await (await store.license.connect(creator).submitSignal(id, true)).wait();
        ids.push(id);
      }

      const after = aggregate(await collect(store, ids));
      expect(after.positiveRate, "self signals cannot move the rate").to.equal(0);
      expect(after.signalled).to.equal(5);
      expect(after.raw.signalled).to.equal(25);
      expect(after.raw.selfSignalCount).to.equal(20);
      expect(after.raw.positive).to.equal(20);
    });

    it("counts a changed signal once, with its final verdict", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const buyers = env.signers.slice(6, 12);
      const ids = [];
      for (const b of buyers) {
        const id = await buy(env, store, b, 1);
        await deliver(store, attestor, id);
        await (await store.license.connect(b).submitSignal(id, true)).wait();
        ids.push(id);
      }
      // One buyer changes their mind.
      await (await store.license.connect(buyers[0]).submitSignal(ids[0], false)).wait();

      const agg = aggregate(await collect(store, ids));
      expect(agg.signalled).to.equal(6);
      expect(agg.positive).to.equal(5);
      expect(agg.negative).to.equal(1);
    });

    it("treats undelivered licenses as not delivered, so coverage stays honest", async function () {
      const { env, store, attestor } = await loadFixture(fixture);
      const ids = [];
      const buyers = env.signers.slice(6, 12);
      for (let i = 0; i < buyers.length; i++) {
        const id = await buy(env, store, buyers[i], 1);
        ids.push(id);
        // Only half of the deliveries are attested.
        if (i % 2 === 0) {
          await deliver(store, attestor, id);
          await (await store.license.connect(buyers[i]).submitSignal(id, true)).wait();
        }
      }
      const rows = await collect(store, ids);
      expect(rows.filter((r) => r.delivered).length).to.equal(3);
      const agg = aggregate(rows, 3);
      expect(agg.delivered).to.equal(3);
      expect(agg.signalled).to.equal(3);
      expect(agg.coverage).to.equal(1);
    });
  });
});
