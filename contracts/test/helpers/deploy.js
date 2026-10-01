const { deployRealUniswap } = require("./uniswap");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const AIC = (n) => ethers.parseUnits(String(n), 18);

const GENESIS_SUPPLY = AIC(1_000_000_000);
const VIRTUAL_USDC = USDC(6000);
const TRANSITION_THRESHOLD = AIC(300_000_000);
const LP_BURN = "0x000000000000000000000000000000000000dEaD";

const StoreType = { Sales: 0, Rentals: 1 };
const ProposalState = {
  Active: 0,
  CancelledBeforeFirstVote: 1,
  Failed: 2,
  PassedAwaitingImplementation: 3,
  ImplementedAwaitingVerification: 4,
  ImplementationVerified: 5,
};
const MarketPhase = { None: 0, BondingCurve: 1, Transitioning: 2, ExternalDex: 3 };
const EpochState = { None: 0, Open: 1, RootProposed: 2, Finalized: 3, Abandoned: 4 };
const ContractRole = {
  Unknown: 0,
  Store: 1,
  AicToken: 2,
  LicenseToken: 3,
  Governance: 4,
  DividendDistributor: 5,
  Factory: 6,
  Registry: 7,
  AgentGoods: 8,
  Treasury: 9,
};

async function deployBehindProxy(implName, initArgs) {
  const Impl = await ethers.getContractFactory(implName);
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const initData = Impl.interface.encodeFunctionData("initialize", initArgs);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return {
    impl,
    proxy,
    contract: Impl.attach(await proxy.getAddress()),
    address: await proxy.getAddress(),
  };
}

/**
 * Deploys the complete canonical protocol exactly the way script/deploy.js does,
 * so every test exercises the real wiring rather than a bespoke test arrangement.
 */
/**
 * @param {{ realDex?: boolean }} [options] `realDex: true` deploys the OFFICIAL Uniswap V2
 *        artifacts instead of the stub router. The listing is one-way and moves real money, so
 *        the transition tests use the real thing; everything else uses the stub because it is
 *        faster and the DEX is not what those tests are about.
 */
async function deployProtocol(options = {}) {
  const signers = await ethers.getSigners();
  const [deployer, guardian, treasuryDest, rootProposer] = signers;

  const chainId = (await ethers.provider.getNetwork()).chainId;

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();

  let dexFactory;
  let router;
  let uniswap = null;
  if (options.realDex) {
    uniswap = await deployRealUniswap(deployer);
    dexFactory = uniswap.factory;
    router = uniswap.router;
  } else {
    dexFactory = await (await ethers.getContractFactory("MockUniswapV2Factory")).deploy();
    await dexFactory.waitForDeployment();
    router = await (
      await ethers.getContractFactory("MockUniswapV2Router02")
    ).deploy(await dexFactory.getAddress());
    await router.waitForDeployment();
  }

  const registryDep = await deployBehindProxy("AICRegistry", [
    chainId,
    await usdc.getAddress(),
    deployer.address,
    guardian.address,
  ]);
  const registry = registryDep.contract;

  const agentGoodsDep = await deployBehindProxy("AgentGoods", [
    registryDep.address,
    await usdc.getAddress(),
    await router.getAddress(),
    LP_BURN,
    deployer.address,
    guardian.address,
  ]);
  const agentGoods = agentGoodsDep.contract;

  await (await registry.setAgentGoods(agentGoodsDep.address)).wait();

  const treasury = await (
    await ethers.getContractFactory("ProtocolTreasury")
  ).deploy(registryDep.address, deployer.address, treasuryDest.address);
  await treasury.waitForDeployment();
  await (await registry.setProtocolTreasury(await treasury.getAddress())).wait();

  /*
   * 0 means the protocol default (six hours). A test that needs to finalize a root without
   * fast-forwarding six hours can pass its own period through options.rootChallengePeriodSeconds.
   */
  const implNames = [
    ["aiCoin", "AICoin", []],
    ["salesStore", "AICStoreSales", []],
    ["rentalsStore", "AICStoreRentals", []],
    ["licenseToken", "LicenseToken", []],
    ["governance", "AICGovernance", []],
    ["distributor", "DividendDistributor", [options.rootChallengePeriodSeconds ?? 0]],
  ];
  const impls = {};
  for (const [key, name, args] of implNames) {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    impls[key] = await c.getAddress();
  }

  const factory = await (
    await ethers.getContractFactory("StoreFactory")
  ).deploy(registryDep.address, agentGoodsDep.address, await usdc.getAddress(), rootProposer.address, impls);
  await factory.waitForDeployment();

  await (await registry.authorizeFactory(await factory.getAddress(), 1)).wait();

  return {
    signers,
    deployer,
    guardian,
    treasuryDest,
    rootProposer,
    chainId,
    usdc,
    dexFactory,
    uniswap,
    router,
    registry,
    registryDep,
    agentGoods,
    agentGoodsDep,
    treasury,
    factory,
    impls,
  };
}

/** Creates a store through the canonical factory and returns typed handles. */
/** The protocol's minimum owner-funded initial market capital: 5 USDC. */
const MIN_INITIAL_OWNER_SEED_USDC = 5_000_000n;

async function createStore(env, creator, storeType = StoreType.Sales, names = {}) {
  const aicName = names.aicName || "Acme Store AIC";
  const aicSymbol = names.aicSymbol || "ACME";
  const storeName = names.storeName || "Acme Store";

  // Every store is created with owner-funded initial market capital (at least 5 USDC). The creator is
  // funded and approves the factory here, so a test that is not about the seed does not repeat it.
  const seed = names.seedUSDC ?? MIN_INITIAL_OWNER_SEED_USDC;
  await fundUSDC(env, creator, seed, await env.factory.getAddress());
  const tx = await env.factory
    .connect(creator)
    .createStore(storeType, aicName, aicSymbol, storeName, seed);
  const receipt = await tx.wait();

  const parsed = receipt.logs
    .map((l) => {
      try {
        return env.factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "StoreCreated");

  const storeId = parsed.args.storeId;
  const seedEvent = receipt.logs
    .map((l) => {
      try {
        return env.factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "InitialOwnerSeed");
  const storeAddress = parsed.args.store;

  const storeContractName = storeType === StoreType.Sales ? "AICStoreSales" : "AICStoreRentals";
  return {
    storeId,
    store: await ethers.getContractAt(storeContractName, storeAddress),
    aic: await ethers.getContractAt("AICoin", parsed.args.aicToken),
    license: await ethers.getContractAt("LicenseToken", parsed.args.licenseToken),
    governance: await ethers.getContractAt("AICGovernance", parsed.args.governance),
    distributor: await ethers.getContractAt("DividendDistributor", parsed.args.dividendDistributor),
    creator,
    storeType,
    seedUSDC: seed,
    seedTokens: seedEvent ? seedEvent.args.tokensOut : 0n,
  };
}

/** Mints USDC and approves a spender in one step. */
async function fundUSDC(env, account, amount, spender) {
  await (await env.usdc.mint(account.address, amount)).wait();
  if (spender) {
    await (await env.usdc.connect(account).approve(spender, amount)).wait();
  }
}

/** Buys AIC on the bonding curve with an unconstrained deadline. */
async function buyAIC(env, store, buyer, grossUSDC, minOut = 0n) {
  await fundUSDC(env, buyer, grossUSDC, await env.agentGoods.getAddress());
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
  return env.agentGoods
    .connect(buyer)
    .buy(await store.aic.getAddress(), grossUSDC, minOut, deadline);
}

module.exports = {
  USDC,
  AIC,
  GENESIS_SUPPLY,
  VIRTUAL_USDC,
  TRANSITION_THRESHOLD,
  LP_BURN,
  StoreType,
  ProposalState,
  MarketPhase,
  EpochState,
  ContractRole,
  deployProtocol,
  deployBehindProxy,
  createStore,
  MIN_INITIAL_OWNER_SEED_USDC,
  fundUSDC,
  buyAIC,
};
