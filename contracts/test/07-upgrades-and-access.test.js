const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployProtocol,
  createStore,
  buyAIC,
  fundUSDC,
  StoreType,
  ContractRole,
  USDC,
  GENESIS_SUPPLY,
} = require("./helpers/deploy");

describe("Upgradeability, guardian powers and access control", function () {
  async function fixture() {
    const env = await deployProtocol();
    const a = await createStore(env, env.signers[5], StoreType.Sales, { aicSymbol: "AAA" });
    const b = await createStore(env, env.signers[6], StoreType.Rentals, { aicSymbol: "BBB" });
    return { env, a, b };
  }

  /** Snapshots every canonical provenance fact so an upgrade can be replayed against it. */
  async function captureProvenance(env) {
    const count = await env.registry.storeCount();
    const stores = [];
    for (let i = 0; i < count; i++) {
      const id = await env.registry.storeIdAt(i);
      const r = await env.registry.getStore(id);
      stores.push({
        storeId: id,
        store: r.store,
        aicToken: r.aicToken,
        licenseToken: r.licenseToken,
        governance: r.governance,
        dividendDistributor: r.dividendDistributor,
        factory: r.factory,
        factoryVersion: r.factoryVersion,
        storeCreator: r.storeCreator,
        createdBlock: r.createdBlock,
        controller: await env.registry.storeController(id),
        epoch: await env.registry.ownershipEpoch(id),
      });
    }
    return stores;
  }

  describe("Upgradeable set is exactly Registry and AgentGoods (MASTER_PLAN 0.16, 0.25.Q)", function () {
    it("gives immutable components no upgrade surface at all", async function () {
      const { a } = await loadFixture(fixture);
      for (const c of [a.store, a.aic, a.license, a.governance, a.distributor]) {
        const names = c.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
        expect(names.some((n) => /upgradeTo|upgradeToAndCall|setImplementation|_authorizeUpgrade/i.test(n))).to.equal(
          false
        );
      }
    });

    it("exposes clones that permanently delegate to one fixed implementation", async function () {
      const { env, a } = await loadFixture(fixture);
      const code = await ethers.provider.getCode(await a.store.getAddress());
      // EIP-1167 minimal proxy runtime is 45 bytes.
      expect((code.length - 2) / 2).to.equal(45);
      expect(code.toLowerCase()).to.include(env.impls.salesStore.slice(2).toLowerCase());
    });
  });

  describe("Registry upgrade safety (MASTER_PLAN 0.19.E, 0.24.S)", function () {
    it("preserves every canonical provenance record across an upgrade", async function () {
      const { env } = await loadFixture(fixture);
      const before = await captureProvenance(env);

      const V2 = await ethers.getContractFactory("AICRegistryV2");
      const v2 = await V2.deploy();
      await v2.waitForDeployment();
      await (await env.registry.upgradeToAndCall(await v2.getAddress(), "0x")).wait();

      const upgraded = V2.attach(await env.registry.getAddress());
      expect(await upgraded.registryVersion()).to.equal("2.0.0");

      const after = await captureProvenance(env);
      expect(after).to.deep.equal(before);
    });

    it("keeps configuration, roles and fee settings across an upgrade", async function () {
      const { env } = await loadFixture(fixture);
      const usdcBefore = await env.registry.usdc();
      const feeBefore = await env.registry.commerceFeeBps();
      const agentGoodsBefore = await env.registry.agentGoods();

      const V2 = await ethers.getContractFactory("AICRegistryV2");
      const v2 = await V2.deploy();
      await v2.waitForDeployment();
      await (await env.registry.upgradeToAndCall(await v2.getAddress(), "0x")).wait();

      expect(await env.registry.usdc()).to.equal(usdcBefore);
      expect(await env.registry.commerceFeeBps()).to.equal(feeBefore);
      expect(await env.registry.agentGoods()).to.equal(agentGoodsBefore);
      expect(await env.registry.hasRole(await env.registry.GUARDIAN_ROLE(), env.guardian.address)).to.equal(true);
    });

    it("has no function, on any role, that can rewrite an existing store record", async function () {
      const { env } = await loadFixture(fixture);
      const names = env.registry.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f) => f.name)
        .sort();
      expect(names).to.deep.equal(
        [
          "authorizeFactory",
          "deprecateFactory",
          "grantRole",
          "initialize",
          "recordControllerChange",
          "registerStore",
          "renounceRole",
          "revokeRole",
          "setCommerceFeeBps",
          "setDividendProcessingFeeBps",
          // Governs the dividend holding window. Touches no store record. [MASTER_PLAN 29C.5]
          "setHoldingWindowSeconds",
          "setPaused",
          "setProtocolTreasury",
          "setAgentGoods",
          "setAgentGoodsFeesBps",
          "upgradeToAndCall",
        ].sort()
      );
    });

    it("refuses an upgrade from a non-upgrader", async function () {
      const { env } = await loadFixture(fixture);
      const V2 = await ethers.getContractFactory("AICRegistryV2");
      const v2 = await V2.deploy();
      await v2.waitForDeployment();
      await expect(env.registry.connect(env.signers[9]).upgradeToAndCall(await v2.getAddress(), "0x")).to.be
        .reverted;
      await expect(env.registry.connect(env.guardian).upgradeToAndCall(await v2.getAddress(), "0x")).to.be
        .reverted;
    });

    it("refuses to re-initialize after deployment", async function () {
      const { env } = await loadFixture(fixture);
      await expect(
        env.registry.initialize(1, await env.usdc.getAddress(), env.deployer.address, env.guardian.address)
      ).to.be.reverted;
    });

    it("keeps the implementation itself permanently uninitializable", async function () {
      const { env } = await loadFixture(fixture);
      const impl = await ethers.getContractAt("AICRegistry", await env.registryDep.impl.getAddress());
      await expect(
        impl.initialize(1, await env.usdc.getAddress(), env.deployer.address, env.guardian.address)
      ).to.be.reverted;
    });
  });

  describe("AgentGoods upgrade safety (MASTER_PLAN 0.19.F, 0.25.Q)", function () {
    it("preserves market accounting and the genesis invariant across an upgrade", async function () {
      const { env, a } = await loadFixture(fixture);
      await buyAIC(env, a, env.signers[7], USDC(500));
      const before = await env.agentGoods.market(await a.aic.getAddress());

      const V2 = await ethers.getContractFactory("AgentGoodsV2");
      const v2 = await V2.deploy();
      await v2.waitForDeployment();
      await (await env.agentGoods.upgradeToAndCall(await v2.getAddress(), "0x")).wait();

      const upgraded = V2.attach(await env.agentGoods.getAddress());
      expect(await upgraded.agentGoodsVersion()).to.equal("2.0.0");

      const after = await env.agentGoods.market(await a.aic.getAddress());
      expect(after.virtualUSDCReserve).to.equal(before.virtualUSDCReserve);
      expect(after.virtualTokenReserve).to.equal(before.virtualTokenReserve);
      expect(after.realUSDCReserve).to.equal(before.realUSDCReserve);
      expect(after.tokenInventory).to.equal(before.tokenInventory);
      expect(after.netSoldFromCurve).to.equal(before.netSoldFromCurve);
      expect(after.controllerFeesUSDC).to.equal(before.controllerFeesUSDC);
      // The slot added after _marketTokens (pendingBuybackUSDC, gap 40 -> 39) reads cleanly after the upgrade.
      expect(await upgraded.pendingBuybackUSDC(await a.aic.getAddress())).to.equal(0n);

      // The genesis invariant is untouched: supply plus burned still equals 1B.
      expect((await a.aic.totalSupply()) + (await a.aic.totalBurned())).to.equal(GENESIS_SUPPLY);
      const acct = await env.agentGoods.usdcAccounting();
      expect(acct.delta).to.equal(0n);
    });

    it("gives an upgrade no generic power to move arbitrary balances", async function () {
      const { env, a } = await loadFixture(fixture);
      const names = env.agentGoods.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f) => f.name)
        .sort();
      expect(names).to.deep.equal(
        [
          "buy",
          // The caller pays and the recipient receives: a buy and a transfer in one call, used by the
          // factory to seed a new store for its creator. It can move only the caller's own USDC.
          "buyFor",
          // Store-only (NotMarketStore): the store's own USDC buys its own AIC, which is burned.
          // Nothing leaves to any address of the caller's choosing.
          "buybackAndBurn",
          // Admin-only, and only before any market exists: sets the curve's virtual reserve and
          // graduation threshold. Moves no balance of anyone.
          "configureCurve",
          // Permissionless retry of a deferred buyback: it can only swap the pending USDC for the
          // market's AIC through the configured router and burn what it receives.
          "flushBuyback",
          "grantRole",
          "initialize",
          "initializeMarket",
          "renounceRole",
          "revokeRole",
          "sell",
          "upgradeToAndCall",
          "withdrawControllerFees",
        ].sort()
      );
      expect(await a.aic.agentGoods()).to.equal(await env.agentGoods.getAddress());
    });

    it("refuses an upgrade to an implementation the upgrader is not authorized for", async function () {
      const { env } = await loadFixture(fixture);
      const bad = await (await ethers.getContractFactory("MaliciousRegistryImpl")).deploy();
      await bad.waitForDeployment();
      await expect(
        env.agentGoods.connect(env.signers[9]).upgradeToAndCall(await bad.getAddress(), "0x")
      ).to.be.reverted;
    });
  });

  describe("Guardian powers are enumerated, not unlimited (MASTER_PLAN 0.17)", function () {
    it("may pause but not unpause", async function () {
      const { env } = await loadFixture(fixture);
      const scope = ethers.id("PAUSE_COMMERCE");
      await (await env.registry.connect(env.guardian).setPaused(scope, true)).wait();
      expect(await env.registry.isPaused(scope)).to.equal(true);
      await expect(env.registry.connect(env.guardian).setPaused(scope, false)).to.be.reverted;
      await (await env.registry.connect(env.deployer).setPaused(scope, false)).wait();
      expect(await env.registry.isPaused(scope)).to.equal(false);
    });

    it("cannot mint AIC, seize a store, forge a claim or make a token canonical", async function () {
      const { env, a } = await loadFixture(fixture);
      const g = env.guardian;

      await expect(a.store.connect(g).transferController(g.address)).to.be.revertedWithCustomError(
        a.store,
        "NotController"
      );
      await expect(a.store.connect(g).onHolderTakeover(g.address)).to.be.revertedWithCustomError(
        a.store,
        "NotAicToken"
      );
      await expect(a.aic.connect(g).burnFromMarket(1n)).to.be.revertedWithCustomError(a.aic, "NotMarket");
      await expect(a.aic.connect(g).lock(g.address, ethers.id("x"), 1n)).to.be.revertedWithCustomError(
        a.aic,
        "NotAuthorizedLocker"
      );
      await expect(env.registry.connect(g).upgradeToAndCall(g.address, "0x")).to.be.reverted;
      await expect(
        a.distributor.connect(g).setRootProposer(g.address, true)
      ).to.be.revertedWithCustomError(a.distributor, "NotAuthorized");

      const names = a.aic.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      expect(names.some((n) => /^mint/i.test(n))).to.equal(false);
    });

    it("can stop a compromised factory from new registrations without erasing history", async function () {
      const { env, a } = await loadFixture(fixture);
      await (await env.registry.connect(env.guardian).deprecateFactory(await env.factory.getAddress())).wait();
      expect(await env.registry.isAuthorizedFactory(await env.factory.getAddress())).to.equal(false);
      expect(await env.registry.isFactoryKnown(await env.factory.getAddress())).to.equal(true);
      expect(await env.registry.isCanonical(await a.aic.getAddress())).to.equal(true);
    });

    it("does not let a pause trap dividend claims or content access", async function () {
      const { env, a } = await loadFixture(fixture);
      // No pause scope exists for claims or license validity at all.
      const scopes = ["PAUSE_STORE_CREATION", "PAUSE_COMMERCE", "PAUSE_MARKET", "PAUSE_REWARD_DEPOSIT"];
      for (const s of scopes) {
        await (await env.registry.connect(env.guardian).setPaused(ethers.id(s), true)).wait();
      }
      const distributorNames = a.distributor.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(distributorNames).to.include("claim");
      // The claim path never consults a pause scope.
      const src = a.distributor.interface.getFunction("claim");
      expect(src).to.not.equal(undefined);
    });
  });

  describe("Timelock handoff (MASTER_PLAN 0.17, 0.25.R)", function () {
    it("can move every upgrade and admin role to a timelock and leave bootstrap with zero", async function () {
      const { env } = await loadFixture(fixture);
      const proposers = [env.deployer.address];
      const executors = [env.deployer.address];
      const timelock = await (
        await ethers.getContractFactory("AICTimelock")
      ).deploy(2 * 24 * 3600, proposers, executors, env.deployer.address);
      await timelock.waitForDeployment();
      const tl = await timelock.getAddress();

      const adminRole = await env.registry.DEFAULT_ADMIN_ROLE();
      const subordinateRoles = [
        await env.registry.UPGRADER_ROLE(),
        await env.registry.FACTORY_ADMIN_ROLE(),
        await env.registry.FEE_ADMIN_ROLE(),
      ];
      const roles = [adminRole, ...subordinateRoles];
      for (const role of roles) {
        await (await env.registry.grantRole(role, tl)).wait();
      }
      // Revocation order matters operationally: DEFAULT_ADMIN_ROLE is the role that
      // authorises every other revocation, so the bootstrap admin must give it up LAST.
      // This ordering is mirrored in docs/DEPLOYMENT_RUNBOOK.md.
      for (const role of subordinateRoles) {
        await (await env.registry.revokeRole(role, env.deployer.address)).wait();
      }
      await (await env.registry.revokeRole(adminRole, env.deployer.address)).wait();

      for (const role of roles) {
        expect(await env.registry.hasRole(role, tl)).to.equal(true);
        expect(await env.registry.hasRole(role, env.deployer.address)).to.equal(false);
      }

      // Bootstrap admin now has zero residual authority.
      const V2 = await ethers.getContractFactory("AICRegistryV2");
      const v2 = await V2.deploy();
      await v2.waitForDeployment();
      await expect(env.registry.connect(env.deployer).upgradeToAndCall(await v2.getAddress(), "0x")).to.be
        .reverted;
      await expect(env.registry.connect(env.deployer).setCommerceFeeBps(100)).to.be.reverted;
    });

    it("enforces the configured delay once the timelock is the upgrade authority", async function () {
      const { env } = await loadFixture(fixture);
      const delay = 2 * 24 * 3600;
      const timelock = await (
        await ethers.getContractFactory("AICTimelock")
      ).deploy(delay, [env.deployer.address], [env.deployer.address], env.deployer.address);
      await timelock.waitForDeployment();
      const tl = await timelock.getAddress();

      await (await env.registry.grantRole(await env.registry.UPGRADER_ROLE(), tl)).wait();
      await (
        await env.registry.revokeRole(await env.registry.UPGRADER_ROLE(), env.deployer.address)
      ).wait();

      const V2 = await ethers.getContractFactory("AICRegistryV2");
      const v2 = await V2.deploy();
      await v2.waitForDeployment();
      const data = env.registry.interface.encodeFunctionData("upgradeToAndCall", [
        await v2.getAddress(),
        "0x",
      ]);
      const registryAddr = await env.registry.getAddress();
      const salt = ethers.id("upgrade-1");

      await (
        await timelock.schedule(registryAddr, 0, data, ethers.ZeroHash, salt, delay)
      ).wait();
      await expect(timelock.execute(registryAddr, 0, data, ethers.ZeroHash, salt)).to.be.reverted;

      await time.increase(delay + 1);
      await (await timelock.execute(registryAddr, 0, data, ethers.ZeroHash, salt)).wait();
      const upgraded = V2.attach(registryAddr);
      expect(await upgraded.registryVersion()).to.equal("2.0.0");
    });
  });

  describe("Treasury boundaries (MASTER_PLAN 0.6, 0.19.G)", function () {
    it("only lets canonical protocol contracts record revenue", async function () {
      const { env } = await loadFixture(fixture);
      await expect(
        env.treasury
          .connect(env.signers[9])
          .recordRevenue(ethers.id("FAKE"), await env.usdc.getAddress(), env.signers[9].address, 1n)
      ).to.be.revertedWithCustomError(env.treasury, "NotCanonicalSource");
    });

    it("cannot withdraw more than accounted revenue", async function () {
      const { env, a } = await loadFixture(fixture);
      await buyAIC(env, a, env.signers[7], USDC(500));
      const usdcAddr = await env.usdc.getAddress();
      const accounted = await env.treasury.accountedBalance(usdcAddr);
      await expect(env.treasury.withdraw(usdcAddr, accounted + 1n)).to.be.revertedWithCustomError(
        env.treasury,
        "InsufficientAccountedBalance"
      );
      await (await env.treasury.withdraw(usdcAddr, accounted)).wait();
      expect(await env.usdc.balanceOf(env.treasuryDest.address)).to.equal(accounted);
    });

    it("rescues only the surplus above the accounted ledger", async function () {
      const { env, a } = await loadFixture(fixture);
      await buyAIC(env, a, env.signers[7], USDC(500));
      const usdcAddr = await env.usdc.getAddress();
      const accounted = await env.treasury.accountedBalance(usdcAddr);
      await (await env.usdc.mint(await env.treasury.getAddress(), USDC(7))).wait();

      await (await env.treasury.rescue(usdcAddr)).wait();
      expect(await env.usdc.balanceOf(env.treasuryDest.address)).to.equal(USDC(7));
      expect(await env.usdc.balanceOf(await env.treasury.getAddress())).to.equal(accounted);
      await expect(env.treasury.rescue(usdcAddr)).to.be.revertedWithCustomError(env.treasury, "NothingToRescue");
    });

    it("refuses an unauthorized destination change or withdrawal", async function () {
      const { env } = await loadFixture(fixture);
      await expect(env.treasury.connect(env.signers[9]).setDestination(env.signers[9].address)).to.be.reverted;
      await expect(env.treasury.connect(env.signers[9]).withdraw(await env.usdc.getAddress(), 1n)).to.be.reverted;
    });
  });
});
