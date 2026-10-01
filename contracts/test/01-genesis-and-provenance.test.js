const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployProtocol,
  createStore,
  StoreType,
  ContractRole,
  MarketPhase,
  GENESIS_SUPPLY,
  VIRTUAL_USDC,
  MIN_INITIAL_OWNER_SEED_USDC,
  fundUSDC,
} = require("./helpers/deploy");

describe("Genesis, canonical provenance and store creation", function () {
  async function fixture() {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[5], StoreType.Sales);
    return { env, store };
  }

  describe("AIC genesis invariants (MASTER_PLAN 12A.1, 12A.2, 0.25.M)", function () {
    it("commits exactly 1,000,000,000 AIC to AgentGoods", async function () {
      const { env, store } = await loadFixture(fixture);
      expect(await store.aic.totalSupply()).to.equal(GENESIS_SUPPLY);
      // The whole supply was committed to the market; the only AIC that left it is what the
      // creator's initial market capital bought in the creation transaction.
      expect((await store.aic.balanceOf(await env.agentGoods.getAddress())) + store.seedTokens).to.equal(GENESIS_SUPPLY);
      expect(await store.aic.genesisSupply()).to.equal(GENESIS_SUPPLY);
    });

    it("gives the store creator no free AIC — only what its initial market capital bought", async function () {
      const { store } = await loadFixture(fixture);
      const net = MIN_INITIAL_OWNER_SEED_USDC - (MIN_INITIAL_OWNER_SEED_USDC * 300n) / 10_000n;
      const bought = (GENESIS_SUPPLY * net) / (VIRTUAL_USDC + net);
      expect(store.seedTokens).to.equal(bought);
      expect(await store.aic.balanceOf(store.creator.address)).to.equal(bought);
      expect(await store.aic.balanceOf(await store.store.getAddress())).to.equal(0n);
    });

    it("leaves no unassigned initial AIC anywhere else", async function () {
      const { env, store } = await loadFixture(fixture);
      const market = await store.aic.balanceOf(await env.agentGoods.getAddress());
      const creator = await store.aic.balanceOf(store.creator.address);
      expect(market + creator).to.equal(await store.aic.totalSupply());
    });

    it("starts every market from 6,000 virtual USDC plus the creator's initial capital, with real liquidity", async function () {
      const { env, store } = await loadFixture(fixture);
      const m = await env.agentGoods.market(await store.aic.getAddress());
      const net = MIN_INITIAL_OWNER_SEED_USDC - (MIN_INITIAL_OWNER_SEED_USDC * 300n) / 10_000n;
      expect(m.virtualUSDCReserve).to.equal(VIRTUAL_USDC + net);
      expect(m.virtualTokenReserve).to.equal(GENESIS_SUPPLY - store.seedTokens);
      expect(m.realUSDCReserve).to.equal(net);
      expect(m.tokenInventory).to.equal(GENESIS_SUPPLY - store.seedTokens);
      expect(m.netSoldFromCurve).to.equal(store.seedTokens);
      expect(m.phase).to.equal(MarketPhase.BondingCurve);
    });

    it("has no mint path after genesis", async function () {
      const { store } = await loadFixture(fixture);
      const iface = store.aic.interface;
      const mintLike = iface.fragments.filter(
        (f) => f.type === "function" && /^(mint|_mint|mintTo)$/i.test(f.name)
      );
      expect(mintLike.length).to.equal(0);
    });

    it("cannot be initialized twice", async function () {
      const { env, store } = await loadFixture(fixture);
      await expect(
        store.aic.initialize("X", "X", ethers.ZeroHash, await env.agentGoods.getAddress())
      ).to.be.revertedWithCustomError(store.aic, "AlreadyInitialized");
    });

    it("locks the shared implementation so it can never be initialized", async function () {
      const { env } = await loadFixture(fixture);
      const impl = await ethers.getContractAt("AICoin", env.impls.aiCoin);
      await expect(
        impl.initialize("X", "X", ethers.ZeroHash, env.deployer.address)
      ).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
      expect(await impl.totalSupply()).to.equal(0n);
    });
  });

  describe("Canonical registry provenance (MASTER_PLAN 0.15, 0.18)", function () {
    it("records the complete canonical component set", async function () {
      const { env, store } = await loadFixture(fixture);
      const record = await env.registry.getStore(store.storeId);
      expect(record.store).to.equal(await store.store.getAddress());
      expect(record.aicToken).to.equal(await store.aic.getAddress());
      expect(record.licenseToken).to.equal(await store.license.getAddress());
      expect(record.governance).to.equal(await store.governance.getAddress());
      expect(record.dividendDistributor).to.equal(await store.distributor.getAddress());
      expect(record.factory).to.equal(await env.factory.getAddress());
      expect(record.factoryVersion).to.equal(1n);
      expect(record.storeCreator).to.equal(store.creator.address);
      expect(record.exists).to.equal(true);
    });

    it("assigns exactly one canonical role per component address", async function () {
      const { env, store } = await loadFixture(fixture);
      expect(await env.registry.roleOf(await store.store.getAddress())).to.equal(ContractRole.Store);
      expect(await env.registry.roleOf(await store.aic.getAddress())).to.equal(ContractRole.AicToken);
      expect(await env.registry.roleOf(await store.license.getAddress())).to.equal(
        ContractRole.LicenseToken
      );
      expect(await env.registry.roleOf(await store.governance.getAddress())).to.equal(
        ContractRole.Governance
      );
      expect(await env.registry.roleOf(await store.distributor.getAddress())).to.equal(
        ContractRole.DividendDistributor
      );
    });

    it("reports an unknown address as non-canonical rather than as a scam", async function () {
      const { env } = await loadFixture(fixture);
      const stranger = ethers.Wallet.createRandom().address;
      expect(await env.registry.isCanonical(stranger)).to.equal(false);
      expect(await env.registry.roleOf(stranger)).to.equal(ContractRole.Unknown);
    });

    it("rejects a direct registerStore call from a non-factory address", async function () {
      const { env, store } = await loadFixture(fixture);
      const attacker = env.signers[9];
      const fake = await (await ethers.getContractFactory("FakeAIC")).deploy(GENESIS_SUPPLY);
      await fake.waitForDeployment();

      await expect(
        env.registry.connect(attacker).registerStore({
          storeId: ethers.id("attacker-store"),
          store: attacker.address,
          aicToken: await fake.getAddress(),
          licenseToken: attacker.address,
          governance: attacker.address,
          dividendDistributor: attacker.address,
          factory: attacker.address,
          storeCreator: attacker.address,
          factoryVersion: 1,
          createdBlock: 0,
          storeType: StoreType.Sales,
          exists: true,
        })
      ).to.be.revertedWithCustomError(env.registry, "NotAuthorizedFactory");
      expect(await env.registry.isCanonical(await fake.getAddress())).to.equal(false);
      expect(store.storeId).to.not.equal(ethers.ZeroHash);
    });

    it("rejects an unauthorized factory clone that copies legitimate bytecode", async function () {
      const { env } = await loadFixture(fixture);
      const rogue = await (
        await ethers.getContractFactory("StoreFactory")
      ).deploy(
        await env.registry.getAddress(),
        await env.agentGoods.getAddress(),
        await env.usdc.getAddress(),
        env.rootProposer.address,
        env.impls
      );
      await rogue.waitForDeployment();

      await expect(
        rogue.connect(env.signers[9]).createStore(StoreType.Sales, "Rogue", "RGE", "Rogue", 5_000_000n)
      ).to.be.revertedWithCustomError(rogue, "NotAuthorized");
    });

    it("prevents a component address from being registered under a second store", async function () {
      const { env, store } = await loadFixture(fixture);
      // Authorize a second factory generation and have it try to reuse an existing component.
      const rogue = await (
        await ethers.getContractFactory("ReusingFactory")
      ).deploy(await env.registry.getAddress());
      await rogue.waitForDeployment();
      await (await env.registry.authorizeFactory(await rogue.getAddress(), 2)).wait();

      await expect(
        rogue.tryReuse(ethers.id("second-store"), await store.aic.getAddress(), env.deployer.address)
      ).to.be.revertedWithCustomError(env.registry, "AddressAlreadyCanonical");
    });

    it("stops a deprecated factory from creating new canonical stores but keeps its history", async function () {
      const { env, store } = await loadFixture(fixture);
      await (await env.registry.deprecateFactory(await env.factory.getAddress())).wait();

      await expect(
        env.factory.connect(env.signers[6]).createStore(StoreType.Sales, "A", "A", "A", 5_000_000n)
      ).to.be.revertedWithCustomError(env.factory, "NotAuthorized");

      // Historical provenance survives: deprecated is not scam. [0.27.F]
      expect(await env.registry.isFactoryKnown(await env.factory.getAddress())).to.equal(true);
      const record = await env.registry.getStore(store.storeId);
      expect(record.factory).to.equal(await env.factory.getAddress());
      expect(await env.registry.isCanonical(await store.aic.getAddress())).to.equal(true);
    });

    it("refuses to initialize a market for an uncanonical lookalike token", async function () {
      const { env } = await loadFixture(fixture);
      const fake = await (await ethers.getContractFactory("FakeAIC")).deploy(GENESIS_SUPPLY);
      await fake.waitForDeployment();
      await expect(
        env.agentGoods
          .connect(env.deployer)
          .initializeMarket(await fake.getAddress(), env.deployer.address, ethers.id("x"))
      ).to.be.revertedWithCustomError(env.agentGoods, "NotAuthorizedFactory");
    });

    it("gives every store a unique deterministic storeId", async function () {
      const { env } = await loadFixture(fixture);
      // One creator may hold one store of EACH type, so the same-creator case is Sales+Rentals.
      // A second store of the SAME type is capped; that is covered in its own block below.
      const a = await createStore(env, env.signers[6], StoreType.Sales, { aicSymbol: "AAA" });
      const b = await createStore(env, env.signers[6], StoreType.Rentals, { aicSymbol: "BBB" });
      const c = await createStore(env, env.signers[7], StoreType.Sales, { aicSymbol: "CCC" });
      expect(a.storeId).to.not.equal(b.storeId);
      expect(a.storeId).to.not.equal(c.storeId);
      expect(b.storeId).to.not.equal(c.storeId);
      expect(await env.registry.storeIdOf(await a.store.getAddress())).to.equal(a.storeId);
    });

    it("caps creation at one Sales and one Rentals store per address", async function () {
      const { env } = await loadFixture(fixture);
      const creator = env.signers[8];

      const sales = await createStore(env, creator, StoreType.Sales, { aicSymbol: "CAP1" });
      const rentals = await createStore(env, creator, StoreType.Rentals, { aicSymbol: "CAP2" });

      expect(await env.factory.storeOfCreator(creator.address, StoreType.Sales)).to.equal(sales.storeId);
      expect(await env.factory.storeOfCreator(creator.address, StoreType.Rentals)).to.equal(rentals.storeId);

      // A third of either type is refused, and the error names the store they already own so a
      // caller does not have to go looking for it.
      await expect(
        env.factory.connect(creator).createStore(StoreType.Sales, "X", "X", "X", 5_000_000n)
      )
        .to.be.revertedWithCustomError(env.factory, "StoreLimitReached")
        .withArgs(creator.address, StoreType.Sales, sales.storeId);

      await expect(
        env.factory.connect(creator).createStore(StoreType.Rentals, "Y", "Y", "Y", 5_000_000n)
      )
        .to.be.revertedWithCustomError(env.factory, "StoreLimitReached")
        .withArgs(creator.address, StoreType.Rentals, rentals.storeId);
    });

    it("refuses the second store BEFORE deploying anything, so no orphan components exist", async function () {
      const { env } = await loadFixture(fixture);
      const creator = env.signers[9];
      await createStore(env, creator, StoreType.Sales, { aicSymbol: "ORPH" });

      const countBefore = await env.registry.storeCount();
      const createdBefore = await env.factory.storesCreated();

      await expect(
        env.factory.connect(creator).createStore(StoreType.Sales, "Z", "Z", "Z", 5_000_000n)
      ).to.be.revertedWithCustomError(env.factory, "StoreLimitReached");

      // The nonce must not have advanced and nothing must have been registered: a refused
      // creation that still burned a nonce would silently change future storeIds.
      expect(await env.registry.storeCount()).to.equal(countBefore);
      expect(await env.factory.storesCreated()).to.equal(createdBefore);
    });

    it("caps the ADDRESS, not the agent: a fresh address may create again", async function () {
      const { env } = await loadFixture(fixture);
      // Documented behaviour, deliberately. The cap makes reputation non-transferable rather
      // than making identity expensive — the new store starts with no holders, no history and
      // no customers, while the abandoned one stays on chain permanently.
      await createStore(env, env.signers[10], StoreType.Sales, { aicSymbol: "ID1" });
      const second = await createStore(env, env.signers[11], StoreType.Sales, { aicSymbol: "ID2" });
      expect(second.storeId).to.not.equal(ethers.ZeroHash);
    });
  });

  describe("Store creation economics", function () {
    it("charges no creation fee: the initial capital buys the creator's AIC, paying only the standard trading fee", async function () {
      const { env } = await loadFixture(fixture);
      const creator = env.signers[7];
      const revenueBefore = await env.treasury.totalRevenue(await env.usdc.getAddress());
      const store = await createStore(env, creator, StoreType.Sales, { aicSymbol: "FEE" });
      expect(await env.usdc.balanceOf(creator.address)).to.equal(0n, "the seed was spent on the creator's own AIC");
      expect(await store.aic.balanceOf(creator.address)).to.equal(store.seedTokens);
      const revenue = (await env.treasury.totalRevenue(await env.usdc.getAddress())) - revenueBefore;
      expect(revenue).to.equal((MIN_INITIAL_OWNER_SEED_USDC * 200n) / 10_000n, "only the 2% trading fee on the seed");
    });

    it("refuses a store with less than 5 USDC of initial market capital, and creates nothing", async function () {
      const { env } = await loadFixture(fixture);
      const creator = env.signers[8];
      await fundUSDC(env, creator, MIN_INITIAL_OWNER_SEED_USDC, await env.factory.getAddress());
      const created = await env.factory.storesCreated();
      for (const seed of [0n, MIN_INITIAL_OWNER_SEED_USDC - 1n]) {
        await expect(env.factory.connect(creator).createStore(StoreType.Sales, "Low", "LOW", "Low", seed))
          .to.be.revertedWithCustomError(env.factory, "InitialSeedTooLow")
          .withArgs(seed, MIN_INITIAL_OWNER_SEED_USDC);
      }
      expect(await env.factory.storesCreated()).to.equal(created);
      expect(await env.factory.storeOfCreator(creator.address, StoreType.Sales)).to.equal(ethers.ZeroHash);
    });

    it("accepts exactly 5 USDC, and more, delivering the AIC to the creator and naming it the buyer", async function () {
      const { env } = await loadFixture(fixture);
      const exact = await createStore(env, env.signers[9], StoreType.Sales, { aicSymbol: "EXA" });
      expect(exact.seedUSDC).to.equal(MIN_INITIAL_OWNER_SEED_USDC);
      const more = await createStore(env, env.signers[10], StoreType.Sales, { aicSymbol: "MOR", seedUSDC: 50_000_000n });
      expect(more.seedTokens).to.be.greaterThan(exact.seedTokens);
      const m = await env.agentGoods.market(await more.aic.getAddress());
      expect(m.realUSDCReserve).to.equal(50_000_000n - (50_000_000n * 300n) / 10_000n);
      expect(await more.aic.balanceOf(env.signers[10].address)).to.equal(more.seedTokens);
    });

    it("reverts the WHOLE creation when the seed cannot be paid — no store without its market capital", async function () {
      const { env } = await loadFixture(fixture);
      const creator = env.signers[11];
      const created = await env.factory.storesCreated();
      // funded but not approved: the seed transfer fails, so nothing of the store may remain
      await (await env.usdc.mint(creator.address, MIN_INITIAL_OWNER_SEED_USDC)).wait();
      await expect(env.factory.connect(creator).createStore(StoreType.Sales, "NoAp", "NOAP", "NoAp", MIN_INITIAL_OWNER_SEED_USDC)).to.be.reverted;
      // approved but not funded: the same
      const broke = env.signers[12];
      await (await env.usdc.connect(broke).approve(await env.factory.getAddress(), MIN_INITIAL_OWNER_SEED_USDC)).wait();
      await expect(env.factory.connect(broke).createStore(StoreType.Sales, "Broke", "BRK", "Broke", MIN_INITIAL_OWNER_SEED_USDC)).to.be.reverted;
      expect(await env.factory.storesCreated()).to.equal(created);
      expect(await env.factory.storeOfCreator(creator.address, StoreType.Sales)).to.equal(ethers.ZeroHash);
      expect(await env.factory.storeOfCreator(broke.address, StoreType.Sales)).to.equal(ethers.ZeroHash);
    });

    it("sets the creator as the initial controller with ownership epoch 1", async function () {
      const { env, store } = await loadFixture(fixture);
      expect(await store.store.storeController()).to.equal(store.creator.address);
      expect(await store.store.ownershipEpoch()).to.equal(1n);
      expect(await env.registry.storeController(store.storeId)).to.equal(store.creator.address);
      expect(await env.registry.ownershipEpoch(store.storeId)).to.equal(1n);
    });

    it("keeps store creation atomic: a failing market init reverts the whole creation", async function () {
      const { env } = await loadFixture(fixture);
      const storesBefore = await env.registry.storeCount();
      // Pause store creation, which makes the factory refuse before any component exists.
      await (await env.registry.setPaused(ethers.id("PAUSE_STORE_CREATION"), true)).wait();
      await expect(
        env.factory.connect(env.signers[8]).createStore(StoreType.Sales, "P", "P", "P", 5_000_000n)
      ).to.be.revertedWithCustomError(env.factory, "CreationPaused");
      expect(await env.registry.storeCount()).to.equal(storesBefore);
    });
  });
});
