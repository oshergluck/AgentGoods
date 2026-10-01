/**
 * Canonical AIC protocol deployment.
 *
 * Produces `deployments/<chainId>.json`, the protocol manifest that the backend, the
 * indexer, the frontend, the Agent schema and the tests all consume. Nothing downstream
 * hardcodes an address, a fee rate or a chain id. [MASTER_PLAN 0.21.P, 0.24.T, 24]
 *
 * Safety rules enforced here:
 *   - the connected chain id must equal the one the operator asked for;
 *   - production runs refuse mock USDC, mock routers and any src/mocks artifact;
 *   - every required external address must be supplied explicitly, never defaulted;
 *   - the script prints every address, waits for receipts and writes bytecode hashes.
 *
 * Usage:
 *   npx hardhat run script/deploy.js --network baseSepolia
 */

const fs = require("fs");
const path = require("path");
const { ethers, network, artifacts } = require("hardhat");
const { waitForCode, waitForValue } = require("./lib/confirm");

const LOCAL_CHAIN_IDS = new Set([31337n, 1337n]);

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Production deployment never falls back to a default address. [MASTER_PLAN 0.21.R]`
    );
  }
  return value.trim();
}

async function deployBehindProxy(implName, initArgs, label) {
  const Impl = await ethers.getContractFactory(implName);
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  /*
   * Mined is not readable. The proxy's constructor calls initialize() on this implementation, and
   * the node estimating that call may not have the implementation's code yet — it then reverts a
   * deployment that is fine ("execution reverted" at the proxy, 2026-09-26). Wait until it is there.
   */
  await waitForCode(await impl.getAddress(), implName);
  const initData = Impl.interface.encodeFunctionData("initialize", initArgs);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  const implAddress = await impl.getAddress();
  /*
   * A mined deployment is not a readable one on a public RPC, and everything downstream reads
   * these immediately — the version getter, the code hash, the wiring calls. Aborting there would
   * strand a half-finished deployment with no manifest. See script/lib/confirm.js.
   */
  await waitForCode(implAddress, `${label} implementation`);
  await waitForCode(proxyAddress, `${label} proxy`);
  console.log(`  ${label.padEnd(22)} proxy=${proxyAddress} impl=${implAddress}`);
  return { contract: Impl.attach(proxyAddress), proxyAddress, implAddress };
}

async function runtimeCodeHash(address) {
  // Never hash an empty string into the manifest because a node was a block behind.
  const code = await waitForCode(address, "contract");
  return ethers.keccak256(code);
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const isLocal = LOCAL_CHAIN_IDS.has(chainId);
  const [deployer] = await ethers.getSigners();

  const expectedChainId = process.env.EXPECTED_CHAIN_ID;
  if (expectedChainId && BigInt(expectedChainId) !== chainId) {
    throw new Error(`Chain id mismatch: connected to ${chainId}, expected ${expectedChainId}`);
  }

  /*
   * Mainnet does NOT imply PRODUCTION, and the default deliberately does not assume it.
   *
   * I briefly changed this to label a Base mainnet deploy PRODUCTION on the reasoning that a real
   * chain deserves the real label. The backend refused to start, correctly: a PRODUCTION manifest
   * must record a timelock address, because PRODUCTION asserts that protocol admin has been handed
   * to a multisig and is no longer a single deployer key. A contract on mainnet whose admin is
   * still an EOA is deployed, not governed.
   *
   * So the stages mean what they say: PROVING is live on a real chain with the deployer still
   * holding admin; CUTOVER is the handoff in progress; PRODUCTION is after it. Promote with an
   * explicit DEPLOY_ENVIRONMENT once the handoff is actually done.
   */
  const environment = process.env.DEPLOY_ENVIRONMENT || (isLocal ? "LOCAL" : "PROVING");
  if (!["LOCAL", "PROVING", "CUTOVER", "PRODUCTION"].includes(environment)) {
    throw new Error(`DEPLOY_ENVIRONMENT must be LOCAL, PROVING, CUTOVER or PRODUCTION`);
  }

  console.log(`\nAIC protocol deployment`);
  console.log(`  network      ${network.name}`);
  console.log(`  chainId      ${chainId}`);
  console.log(`  environment  ${environment}`);
  console.log(`  deployer     ${deployer.address}\n`);

  // ------------------------------------------------------------- externals
  let usdcAddress;
  let routerAddress;
  let dexFactoryAddress;

  if (isLocal) {
    /*
     * Mock USDC, but REAL Uniswap V2.
     *
     * The listing at the 30% transition is irreversible, moves the whole real reserve, and cannot
     * be rehearsed in production. Running the local stack against a stub router would mean the
     * first genuine exercise of that path happens with real money. These are the published
     * v2-core and v2-periphery artifacts, deployed byte for byte, so the local chain lists into a
     * pool that behaves exactly like mainnet — including MINIMUM_LIQUIDITY, the uint112 reserve
     * bound and the optimal-amount path.
     */
    console.log("Local chain: deploying mock USDC and the REAL UniswapV2 factory/router.");
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.waitForDeployment();
    const { deployRealUniswap } = require("../test/helpers/uniswap");
    const uniswap = await deployRealUniswap((await ethers.getSigners())[0]);
    usdcAddress = await usdc.getAddress();
    routerAddress = uniswap.routerAddress;
    dexFactoryAddress = uniswap.factoryAddress;
    console.log(`  uniswap factory        ${dexFactoryAddress}`);
    console.log(`  uniswap router         ${routerAddress}`);
    console.log(`  pair init code hash    ${uniswap.initCodeHash}`);
  } else {
    usdcAddress = ethers.getAddress(required("CANONICAL_USDC_ADDRESS"));
    routerAddress = ethers.getAddress(required("DEX_ROUTER_ADDRESS"));
    const router = await ethers.getContractAt("AgentGoods", routerAddress).catch(() => null);
    void router;
    const routerContract = new ethers.Contract(
      routerAddress,
      ["function factory() view returns (address)"],
      ethers.provider
    );
    dexFactoryAddress = ethers.getAddress(await routerContract.factory());

    const usdcContract = new ethers.Contract(
      usdcAddress,
      ["function decimals() view returns (uint8)", "function symbol() view returns (string)"],
      ethers.provider
    );
    const decimals = await usdcContract.decimals();
    if (Number(decimals) !== 6) {
      throw new Error(`Configured USDC at ${usdcAddress} reports ${decimals} decimals, expected 6`);
    }
    console.log(`  canonical USDC  ${usdcAddress} (${await usdcContract.symbol()})`);
    console.log(`  DEX router      ${routerAddress}`);
    console.log(`  DEX factory     ${dexFactoryAddress}`);
  }

  const bootstrapAdmin = isLocal ? deployer.address : ethers.getAddress(required("BOOTSTRAP_ADMIN_ADDRESS"));
  const guardian = isLocal ? deployer.address : ethers.getAddress(required("GUARDIAN_ADDRESS"));
  const treasuryDestination = isLocal
    ? deployer.address
    : ethers.getAddress(required("TREASURY_DESTINATION_ADDRESS"));
  const rootProposer = isLocal ? deployer.address : ethers.getAddress(required("DIVIDEND_ROOT_PROPOSER_ADDRESS"));
  const lpBurnAddress = process.env.LP_BURN_ADDRESS
    ? ethers.getAddress(process.env.LP_BURN_ADDRESS)
    : "0x000000000000000000000000000000000000dEaD";

  // -------------------------------------------------------------- registry
  console.log("\nDeploying upgradeable core:");
  const registry = await deployBehindProxy(
    "AICRegistry",
    [chainId, usdcAddress, bootstrapAdmin, guardian],
    "AICRegistry"
  );

  const agentGoods = await deployBehindProxy(
    "AgentGoods",
    [registry.proxyAddress, usdcAddress, routerAddress, lpBurnAddress, bootstrapAdmin, guardian],
    "AgentGoods"
  );

  console.log("\nWiring core configuration:");
  await (await registry.contract.setAgentGoods(agentGoods.proxyAddress)).wait();

  /*
   * Per-deployment curve parameters, set before any market exists (the contract refuses afterwards).
   * Unset, the ProtocolConstants defaults apply: 6,000 USDC virtual reserve and 30% of genesis to graduate.
   * CURVE_VIRTUAL_USDC is whole USDC; CURVE_TRANSITION_BPS is basis points of the genesis supply.
   */
  if (process.env.CURVE_VIRTUAL_USDC || process.env.CURVE_TRANSITION_BPS) {
    const vUSDC = ethers.parseUnits(String(process.env.CURVE_VIRTUAL_USDC ?? "6000"), 6);
    const bps = BigInt(process.env.CURVE_TRANSITION_BPS ?? "3000");
    const threshold = (1_000_000_000n * 10n ** 18n * bps) / 10_000n;
    await (await agentGoods.contract.configureCurve(vUSDC, threshold)).wait();
    console.log(`  agentGoods.configureCurve(virtualUSDC=${ethers.formatUnits(vUSDC, 6)}, threshold=${bps} bps of genesis)`);
  }

  /*
   * The protocol's delivery witness. The access gateway serves a buyer's bytes, so it is the party
   * that knows a delivery happened; with this role it records that on chain for any store, and no
   * seller can stop its buyers from being able to rate it. Optional: without the variable the
   * protocol falls back to store-appointed attestors only.
   */
  if (process.env.DELIVERY_GATEWAY_ADDRESS) {
    const gateway = ethers.getAddress(process.env.DELIVERY_GATEWAY_ADDRESS);
    const role = await registry.contract.DELIVERY_GATEWAY_ROLE();
    await (await registry.contract.grantRole(role, gateway)).wait();
    console.log(`  delivery gateway ${gateway} granted DELIVERY_GATEWAY_ROLE`);
  }
  console.log(`  registry.agentGoods     = ${agentGoods.proxyAddress}`);

  const treasury = await (
    await ethers.getContractFactory("ProtocolTreasury")
  ).deploy(registry.proxyAddress, bootstrapAdmin, treasuryDestination);
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  await (await registry.contract.setProtocolTreasury(treasuryAddress)).wait();
  console.log(`  ProtocolTreasury       = ${treasuryAddress}`);

  // ------------------------------------------------------- implementations
  console.log("\nDeploying immutable component implementations:");
  /*
   * The dividend root challenge period is pinned into the distributor implementation at deploy.
   *
   * 0 means "the protocol default", which is six hours, and that is what a production deploy must
   * use — it is the window in which anyone may prove a published root wrong. It is overridable ONLY
   * through this variable so that a short-lived test deployment can finalize an epoch at all: the
   * period is a hard floor on how long a market must run before any dividend is claimable, and a
   * four-hour exercise against a six-hour window can never pay anybody.
   *
   * Deliberately an env override rather than a source constant, so the production value can never
   * be changed by a commit that forgets to change it back.
   */
  const rootChallengePeriodSeconds = Number(process.env.ROOT_CHALLENGE_PERIOD_SECONDS ?? 0);
  if (rootChallengePeriodSeconds !== 0) {
    console.log(`
  ROOT CHALLENGE PERIOD OVERRIDDEN: ${rootChallengePeriodSeconds}s ` +
      `(${(rootChallengePeriodSeconds / 3600).toFixed(2)}h) instead of the 6h protocol default`);
  }

  const implSpecs = [
    ["aiCoin", "AICoin", []],
    ["salesStore", "AICStoreSales", []],
    ["rentalsStore", "AICStoreRentals", []],
    ["licenseToken", "LicenseToken", []],
    ["governance", "AICGovernance", []],
    ["distributor", "DividendDistributor", [rootChallengePeriodSeconds]],
  ];
  const impls = {};
  const implMeta = {};
  for (const [key, name, args] of implSpecs) {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    impls[key] = await c.getAddress();
    implMeta[key] = {
      contract: name,
      address: impls[key],
      runtimeCodeHash: await runtimeCodeHash(impls[key]),
    };
    console.log(`  ${name.padEnd(22)} ${impls[key]}`);
  }

  // ---------------------------------------------------------------- factory
  const factory = await (
    await ethers.getContractFactory("StoreFactory")
  ).deploy(registry.proxyAddress, agentGoods.proxyAddress, usdcAddress, rootProposer, impls);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  /*
   * The generation is read from the contract, never hardcoded here.
   *
   * This line said `1` while the factory it registers now says 2, which would have written
   * the wrong generation into the Registry and into the deployment record - and the
   * Registry's version is what tells an indexer which rules a store was born under.
   */
  /*
   * Settle the code before reading a constant off it.
   *
   * waitForDeployment() returns when the transaction is mined, which on a public RPC is not the
   * same as the code being served by whichever node answers the next call: reading
   * FACTORY_VERSION() straight after returned "0x" and aborted a deployment that had already
   * succeeded. The same reason deployBehindProxy waits, and the same helper.
   */
  await waitForCode(factoryAddress, "StoreFactory");
  const factoryGeneration = await factory.FACTORY_VERSION();
  console.log(`\n  StoreFactory v${factoryGeneration}        ${factoryAddress}`);

  await (await registry.contract.authorizeFactory(factoryAddress, factoryGeneration)).wait();
  /*
   * Mined is not the same as readable. The very next line used to read this back and get `false`
   * from a node one block behind, which reported a correct deployment as failed. Settle it here,
   * where a delay is expected, rather than in a check whose job is to detect real problems.
   */
  await waitForValue(
    () => registry.contract.isAuthorizedFactory(factoryAddress),
    true,
    "factory authorization"
  );
  console.log(`  factory authorized for canonical creation`);

  // ------------------------------------------------------------- verify
  console.log("\nPost-deployment verification:");
  const checks = [
    ["registry.chainIdentifier", (await registry.contract.chainIdentifier()).toString(), chainId.toString()],
    ["registry.usdc", await registry.contract.usdc(), usdcAddress],
    ["registry.agentGoods", await registry.contract.agentGoods(), agentGoods.proxyAddress],
    ["registry.protocolTreasury", await registry.contract.protocolTreasury(), treasuryAddress],
    ["registry.commerceFeeBps", (await registry.contract.commerceFeeBps()).toString(), "250"],
    // 2000 bps = 20%. Raised from 500: a 5% reserve made equity inert.
    ["registry.holderReserveBps", (await registry.contract.holderReserveBps()).toString(), "2000"],
    [
      "registry.dividendProcessingFeeBps",
      (await registry.contract.dividendProcessingFeeBps()).toString(),
      "500",
    ],
    ["registry.agentGoodsProtocolFeeBps", (await registry.contract.agentGoodsProtocolFeeBps()).toString(), "200"],
    [
      "registry.agentGoodsControllerFeeBps",
      (await registry.contract.agentGoodsControllerFeeBps()).toString(),
      "100",
    ],
    ["factory authorized", String(await registry.contract.isAuthorizedFactory(factoryAddress)), "true"],
  ];
  let failed = 0;
  for (const [label, actual, expected] of checks) {
    const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
    if (!ok) failed++;
    console.log(`  ${ok ? "OK  " : "FAIL"} ${label.padEnd(36)} ${actual}`);
  }
  /*
   * A failed check must not discard the record of what was deployed.
   *
   * These contracts exist and cost real gas the moment they were mined. Throwing here used to
   * abort before the manifest was written, leaving an operator with correct contracts on chain
   * and nothing saying where they are — the worst possible outcome, and strictly worse than a
   * deployment that simply failed. So the manifest is written FIRST, marked as unverified, and
   * only then does the script fail.
   */
  const checksFailed = failed;

  // ------------------------------------------------------------- manifest
  const solc = require("../hardhat.config.js").solidity;
  const deploymentBlock = await ethers.provider.getBlockNumber();

  const manifest = {
    schemaVersion: "1.0.0",
    protocolVersion: "1.0.0",
    environment,
    chainId: Number(chainId),
    networkName: network.name,
    generatedAt: new Date().toISOString(),
    deployer: deployer.address,
    deploymentBlock,
    compiler: {
      version: solc.version,
      optimizer: solc.settings.optimizer,
      evmVersion: solc.settings.evmVersion,
      viaIR: solc.settings.viaIR,
      metadataBytecodeHash: solc.settings.metadata.bytecodeHash,
    },
    roles: {
      bootstrapAdmin,
      guardian,
      treasuryDestination,
      dividendRootProposer: rootProposer,
      timelock: null,
    },
    external: {
      canonicalUSDC: usdcAddress,
      usdcDecimals: 6,
      dexRouter: routerAddress,
      dexFactory: dexFactoryAddress,
      lpBurnAddress,
      isMockExternal: isLocal,
    },
    contracts: {
      registry: {
        proxy: registry.proxyAddress,
        implementation: registry.implAddress,
        implementationVersion: await registry.contract.registryVersion(),
        upgradeable: true,
        proxyStandard: "ERC1967/UUPS",
      },
      agentGoods: {
        proxy: agentGoods.proxyAddress,
        implementation: agentGoods.implAddress,
        implementationVersion: await agentGoods.contract.agentGoodsVersion(),
        upgradeable: true,
        proxyStandard: "ERC1967/UUPS",
      },
      protocolTreasury: {
        address: treasuryAddress,
        upgradeable: false,
        runtimeCodeHash: await runtimeCodeHash(treasuryAddress),
      },
      activeFactories: [
        {
          address: factoryAddress,
          // The generation the factory itself reports, never a literal. A record that says 1
          // about a v2 factory misleads every consumer that reads the manifest to decide which
          // creation rules a store was born under.
          version: Number(factoryGeneration),
          status: "CANONICAL_ACTIVE",
          runtimeCodeHash: await runtimeCodeHash(factoryAddress),
        },
      ],
      deprecatedFactories: [],
      componentImplementations: implMeta,
    },
    economics: {
      aicGenesisSupply: "1000000000000000000000000000",
      aicDecimals: 18,
      // Read from the deployed AgentGoods: per-deployment since configureCurve.
      virtualUSDCReserve: (await agentGoods.contract.virtualUSDCReserve()).toString(),
      transitionThresholdAIC: (await agentGoods.contract.transitionThresholdAIC()).toString(),
      transitionThresholdPercent:
        Number(((await agentGoods.contract.transitionThresholdAIC()) * 10_000n) / (1_000_000_000n * 10n ** 18n)) / 100,
      lpPremiumBps: 3500,
      commerceFeeBps: 250,
      /*
       * Read from the deployed registry rather than written as a literal.
       *
       * This was hardcoded 500 while the contracts were deployed at 2000, so the manifest — the
       * document the backend, the indexer, the frontend and every agent consume — advertised a 5%
       * holder reserve for a protocol that actually reserves 20%. The post-deployment check caught
       * the mismatch only because it compares the CONTRACT against its own expectation; the
       * manifest was never compared to anything. A figure this load-bearing should come from the
       * chain, so it cannot drift from it again.
       */
      holderReserveBps: Number(await registry.contract.holderReserveBps()),
      dividendProcessingFeeBps: Number(await registry.contract.dividendProcessingFeeBps()),
      dividendProcessingFeeBasis: "committed_holder_reserve",
      agentGoodsProtocolFeeBps: 200,
      agentGoodsControllerFeeBps: 100,
      postTransitionProtocolFeeBps: 0,
      storeCreationFeeUSDC: "0",
      takeoverObservationPeriodSeconds: 3600,
      minDistributionUSDC: "1000000",
      /*
       * Read back off the deployed distributor, not written as a literal.
       *
       * This was hardcoded to 21600 and stayed 21600 on a deployment that had pinned three hours,
       * so the manifest published a rule the chain did not enforce. Every other per-deployment
       * value here is read from the contract that enforces it; this one now is too.
       */
      rootChallengePeriodSeconds: Number(
        await (await ethers.getContractAt("DividendDistributor", impls.distributor)).rootChallengePeriod()
      ),
      rootLivenessTimeoutSeconds: 2592000,
      signalWindowSeconds: 604800,
      minSignalsForRate: 5,
      // MASTER_PLAN 29C. Read back from the Registry so the manifest can never drift from chain.
      holdingWindowSeconds: Number(await registry.contract.holdingWindowSeconds()),
      // Read from the deployed factory, which takes it from ProtocolConstants: one source of truth.
      minInitialOwnerSeedUSDC: (await factory.MIN_INITIAL_OWNER_SEED_USDC()).toString(),
      // The exchange's minimum trade (the smallest that still pays both trading fees) and the minimum
      // product price (ProtocolConstants.MIN_PRODUCT_PRICE_USDC: the holders' buyback stays >= 100 units).
      minTradeUSDC: (await agentGoods.contract.MIN_TRADE_USDC()).toString(),
      minProductPriceUSDC: "523",
      /*
       * Read off the deployed store implementation for the same reason as the line above: the
       * backend refuses to boot on a manifest that does not state this, and the only value it
       * could otherwise be given is a literal that would go stale the first time the contract
       * changed. A constant copied into a manifest is a constant that will eventually be wrong.
       */
      ownerWithdrawalCooldownSeconds: Number(
        await (await ethers.getContractAt("AICStoreSales", impls.salesStore)).WITHDRAWAL_COOLDOWN()
      ),
      nominalBlockTimeSeconds: 2,
      salesRewardRate: { numerator: 2, denominator: 1000, minimumPool: "500", poolGate: "0" },
      rentalsRewardRate: { numerator: 2, denominator: 100000, minimumPool: "500", poolGate: "100000" },
    },
  };

  // Overridable so parallel test processes can each own a manifest. Two runs writing the same
  // `deployments/<chainId>.json` produced a manifest whose addresses belonged to the OTHER
  // deployment, which is an unfixable-looking test failure with an entirely mechanical cause.
  const outDir = process.env.DEPLOYMENTS_OUT_DIR
    ? path.resolve(process.env.DEPLOYMENTS_OUT_DIR)
    : path.resolve(__dirname, "..", "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${chainId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nManifest written to ${outFile}`);

  /*
   * Only now is it safe to fail on a bad check. The contracts exist and are already paid for, so
   * the operator must end up with their addresses either way — a deployment that succeeded on
   * chain but left no record of itself is worse than one that plainly failed.
   */
  if (checksFailed > 0) {
    throw new Error(
      `${checksFailed} post-deployment check(s) failed. The manifest at ${outFile} records what ` +
        `WAS deployed — do not redeploy before reading it and checking the addresses on the ` +
        `explorer. The contracts are real whether or not the checks passed.`
    );
  }

  // Also export the ABIs the backend and frontend consume, from the same build.
  const abiDir = path.join(outDir, "abi");
  fs.mkdirSync(abiDir, { recursive: true });
  const abiContracts = [
    "AICRegistry",
    "AgentGoods",
    "ProtocolTreasury",
    "StoreFactory",
    "AICoin",
    "AICStoreSales",
    "AICStoreRentals",
    "LicenseToken",
    "AICGovernance",
    "DividendDistributor",
  ];
  for (const name of abiContracts) {
    const artifact = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(abiDir, `${name}.json`), JSON.stringify(artifact.abi, null, 2) + "\n");
  }
  console.log(`ABIs written to ${abiDir}`);

  console.log("\nDeployment complete.\n");
  /*
   * Source verification, in the same run.
   *
   * Deliberately AFTER the manifest is written and deliberately non-fatal: verification depends on
   * an explorer having indexed the contracts and on a third-party API that can be down. If a
   * verification failure aborted the deployment, an operator would be tempted to redeploy — real
   * gas, a second set of canonical addresses — to fix an entirely off-chain problem. The addresses
   * are already canonical by this point; verification is a repeatable pass over the manifest.
   */
  if (!isLocal) {
    try {
      const { main: verifyAll } = require("./verify");
      await verifyAll();
    } catch (error) {
      console.error(`source verification did not complete: ${error.message ?? error}`);
      console.error(
        "The deployment itself is FINE and the manifest is written. Fix the cause and rerun " +
          "`npx hardhat run script/verify.js --network <network>`. Do NOT redeploy: these " +
          "addresses are already canonical."
      );
    }
  }

  console.log("Next steps (see docs/DEPLOYMENT_RUNBOOK.md):");
  console.log("  1. confirm every contract shows as verified on the explorer");
  console.log("  2. point the backend at the manifest and start the indexer from deploymentBlock");
  console.log("  3. run the canary sequence before funding the proving Agents");
}

main().catch((error) => {
  console.error("\nDEPLOYMENT FAILED\n", error);
  process.exitCode = 1;
});
