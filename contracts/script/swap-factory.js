/**
 * Replace the authorised StoreFactory generation, in place, on a live deployment.
 *
 * WHY THIS EXISTS. StoreFactory is deliberately not upgradeable: a clone permanently delegates to
 * one fixed implementation, so a store keeps exactly the code it was born with. A new generation
 * is therefore a NEW immutable factory that the Registry authorises for FUTURE creation, with the
 * previous generation deprecated. That is the designed path, and this script is that path.
 *
 * WHAT CHANGED IN GENERATION 2. One Sales store and one Rentals store per creator address. Nothing
 * else: the component implementations are REUSED EXACTLY as they are, read from the deployment
 * record rather than redeployed, because a redeploy would change every future store's code for a
 * reason unrelated to the cap. The two chains genuinely have different store implementations (the
 * holder reserve is a compile-time constant: 2000 bps on mainnet, 500 on testnet), so reusing each
 * chain's own pinned set is not an optimisation, it is the only correct behaviour.
 *
 * WHY DEPRECATING THE OLD ONE IS NOT OPTIONAL. The cap lives in the factory, so while generation 1
 * stays authorised the cap is advisory: a seller that hit the limit calls the old factory and
 * creates a third store. Authorising v2 without deprecating v1 would put a rule in the schema that
 * the protocol does not actually enforce, which is worse than having no rule.
 *
 *     npx hardhat run script/swap-factory.js --network baseSepolia
 *     npx hardhat run script/swap-factory.js --network base
 *
 * Refuses to run unless the signer holds FACTORY_ADMIN_ROLE, and verifies the end state by reading
 * it back from the chain rather than assuming the transactions did what they said.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");
const { waitForCode } = require("./lib/confirm");

const DEPLOYMENTS = path.resolve(__dirname, "..", "..", "deployments");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const file = path.join(DEPLOYMENTS, `${chainId}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment record for chain ${chainId} at ${file}`);

  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const [signer] = await ethers.getSigners();

  console.log("StoreFactory generation swap");
  console.log(`  network      ${network.name} (chain ${chainId})`);
  console.log(`  environment  ${record.environment}`);
  console.log(`  signer       ${signer.address}`);

  const registryAddress = record.contracts.registry.proxy;
  const registry = await ethers.getContractAt("AICRegistry", registryAddress);

  const FACTORY_ADMIN_ROLE = ethers.id("FACTORY_ADMIN_ROLE");
  if (!(await registry.hasRole(FACTORY_ADMIN_ROLE, signer.address))) {
    throw new Error(
      `signer ${signer.address} does not hold FACTORY_ADMIN_ROLE on registry ${registryAddress}. ` +
        `On a handed-off deployment this is a governance action, not a script run.`
    );
  }

  const active = record.contracts.activeFactories ?? [];
  const impls = record.contracts.componentImplementations;

  /*
   * WHICH IMPLEMENTATIONS A GENERATION REDEPLOYS, AND WHY IT IS NOT "ALL OF THEM".
   *
   * Generation 2 changed only the factory, so it reused every pinned implementation exactly as it
   * was. Generation 3 changes `StoreBase` - owner withdrawals are now rate-limited - so the two
   * store implementations MUST be redeployed. A clone delegates permanently to the code it was
   * born with, so reusing the old pin would authorise a new factory that still produces stores
   * without the cooldown.
   *
   * Everything else is still reused, and that is the deliberate part. Redeploying aiCoin,
   * licenseToken, governance or distributor would change the code of every future store's
   * components for a reason unconnected to this change, and would throw away the only cheap
   * guarantee available here: that an untouched component is byte-identical to the one already
   * running. A generation redeploys exactly what it changed.
   *
   * REDEPLOY_FOR_GENERATION names them, so a future generation states its own set rather than
   * inheriting this one silently.
   */
  const REDEPLOY_FOR_GENERATION = JSON.parse(
    process.env.REDEPLOY_IMPLEMENTATIONS ?? '{"salesStore":"AICStoreSales","rentalsStore":"AICStoreRentals"}'
  );

  /*
   * Constructor arguments for the implementations that take any.
   *
   * Only the distributor does: its root challenge period is pinned at deploy so a test network can
   * run a window short enough to finalize an epoch inside a four-hour exercise, while production
   * keeps the six-hour default. 0 means the default, and a generation that does not repin the
   * distributor never reaches this.
   */
  const rootChallengePeriodSeconds = Number(process.env.ROOT_CHALLENGE_PERIOD_SECONDS ?? 0);
  const CONSTRUCTOR_ARGS = {
    distributor: [rootChallengePeriodSeconds],
  };

  const implArg = {
    aiCoin: impls.aiCoin.address,
    salesStore: impls.salesStore.address,
    rentalsStore: impls.rentalsStore.address,
    licenseToken: impls.licenseToken.address,
    governance: impls.governance.address,
    distributor: impls.distributor.address,
  };

  console.log("\n  redeploying the implementations whose code changed:");
  const redeployed = {};
  for (const [key, contractName] of Object.entries(REDEPLOY_FOR_GENERATION)) {
    const deployed = await (
      await ethers.getContractFactory(contractName)
    ).deploy(...(CONSTRUCTOR_ARGS[key] ?? []));
    await deployed.waitForDeployment();
    const at = await deployed.getAddress();
    /*
     * The same read-back wait as the factory below. An implementation that is mined but not yet
     * visible to the node answering the next call would be pinned into the factory as an address
     * with no code, and every store created from it would be a clone of nothing.
     */
    await waitForCode(at, contractName);
    console.log(`    ${key.padEnd(14)} ${at}   (was ${implArg[key]})`);
    redeployed[key] = { contract: contractName, address: at, previousAddress: implArg[key] };
    implArg[key] = at;
  }

  console.log("\n  reusing pinned implementations (NOT redeployed):");
  for (const [k, v] of Object.entries(implArg)) {
    if (!(k in REDEPLOY_FOR_GENERATION)) console.log(`    ${k.padEnd(14)} ${v}`);
  }

  // ---------------------------------------------------------------- deploy
  const factory = await (
    await ethers.getContractFactory("StoreFactory")
  ).deploy(
    registryAddress,
    record.contracts.agentGoods.proxy,
    record.external.canonicalUSDC,
    record.roles.dividendRootProposer,
    implArg
  );
  await factory.waitForDeployment();
  const address = await factory.getAddress();
  /*
   * Mined is not readable. waitForDeployment() returns on the mining receipt, but the next call
   * may be answered by a node that has not caught up, and reading a constant then comes back
   * "0x" and aborts a deployment that in fact succeeded. This exact failure happened once on
   * baseSepolia; do not remove the wait.
   */
  await waitForCode(address, "StoreFactory");
  const generation = await factory.FACTORY_VERSION();
  console.log(`\n  StoreFactory v${generation}        ${address}`);

  if (active.some((f) => f.version === Number(generation))) {
    throw new Error(`generation ${generation} is already recorded as active; nothing to swap`);
  }

  // ---------------------------------------------------------------- authorise the new one
  await (await registry.authorizeFactory(address, generation)).wait();
  console.log(`  authorised v${generation}`);

  // ---------------------------------------------------------------- deprecate every older one
  const deprecated = [];
  for (const old of active) {
    await (await registry.deprecateFactory(old.address)).wait();
    deprecated.push(old);
    console.log(`  deprecated v${old.version}   ${old.address}`);
  }

  // ---------------------------------------------------------------- verify by reading back
  /*
   * Poll, do not read once.
   *
   * A mined transaction is not immediately visible to whichever node answers the next call. Both
   * read-backs below failed exactly once on Base mainnet against transactions that had in fact
   * succeeded — v1 really was deprecated and the script aborted anyway, leaving the deployment
   * record unwritten while the chain was already correct. A false failure here is worse than a
   * slow one, because it invites re-running a swap that does not need re-running.
   */
  const settle = async (read, want, what) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      if ((await read()) === want) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(what);
  };

  await settle(
    () => registry.isAuthorizedFactory(address),
    true,
    "new factory is not authorised after the transaction"
  );
  for (const old of deprecated) {
    await settle(
      () => registry.isAuthorizedFactory(old.address),
      false,
      `old factory ${old.address} is STILL authorised — the cap would be bypassable`
    );
    // Deprecated is not "unknown": historical provenance must survive. [0.27.F]
    if (!(await registry.isFactoryKnown(old.address))) {
      throw new Error(`old factory ${old.address} lost its known status; history would be unverifiable`);
    }
  }
  console.log("\n  verified on chain: new generation authorised, every older one deprecated but still known");

  // ---------------------------------------------------------------- record
  const runtimeCode = await ethers.provider.getCode(address);
  record.contracts.activeFactories = [
    {
      address,
      version: Number(generation),
      status: "CANONICAL_ACTIVE",
      runtimeCodeHash: ethers.keccak256(runtimeCode),
    },
  ];
  record.contracts.deprecatedFactories = [
    ...(record.contracts.deprecatedFactories ?? []),
    ...deprecated.map((f) => ({ ...f, status: "CANONICAL_DEPRECATED" })),
  ];
  for (const [key, info] of Object.entries(redeployed)) {
    record.contracts.componentImplementations[key] = {
      ...(record.contracts.componentImplementations[key] ?? {}),
      contract: info.contract,
      address: info.address,
      runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(info.address)),
      supersedes: info.previousAddress,
      pinnedByFactoryGeneration: Number(generation),
      ...(key === "distributor"
        ? {
            rootChallengePeriodSeconds: Number(
              await (await ethers.getContractAt("DividendDistributor", info.address)).rootChallengePeriod()
            ),
          }
        : {}),
    };
  }

  record.factoryGenerationNotes = {
    ...(record.factoryGenerationNotes ?? {}),
    2: "One Sales store and one Rentals store per creator address (StoreFactory.storeOfCreator).",
    3:
      "Store implementations redeployed with StoreBase.WITHDRAWAL_COOLDOWN (3 hours) on owner " +
      "proceeds withdrawals. Factory logic unchanged; the generation exists to pin the new store code.",
    4:
      "DividendDistributor redeployed with its root challenge period pinned as an immutable at " +
      "deploy instead of a global constant. TEST NETWORKS ONLY so far: it exists so a short " +
      "exercise can finalize an epoch, because the challenge period is a hard floor on how long a " +
      "market must run before any dividend is claimable. Production keeps the 6-hour default.",
  };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`  deployment record updated: ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
