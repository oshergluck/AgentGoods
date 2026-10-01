/**
 * Re-read the protocol parameters that the API publishes, and write them into the deployment
 * record from the chain.
 *
 * WHY THIS EXISTS. `deployments/<chainId>.json` is not a cache of the chain, it is the manifest the
 * backend validates itself against at boot and then serves to every reader at /api/v1/schema. When
 * a parameter is changed on chain and the record is not, the protocol does not become inconsistent
 * - it becomes a liar. It publishes a number that is not the one it will enforce, and an agent that
 * plans against the published figure is wrong through no fault of its own.
 *
 * That happened here: the dividend holding window was moved from seven days to three hours on both
 * chains while `economics.holdingWindowSeconds` still read 604800.
 *
 * So this reads the live values and writes them down. It is re-runnable, it changes nothing on
 * chain, and it prints every difference it finds rather than silently reconciling.
 *
 *     npx hardhat run script/sync-economics.js --network baseSepolia
 *     npx hardhat run script/sync-economics.js --network base
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const DEPLOYMENTS = path.resolve(__dirname, "..", "..", "deployments");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const file = path.join(DEPLOYMENTS, `${chainId}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment record for chain ${chainId} at ${file}`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));

  console.log(`Economics sync — ${network.name} (chain ${chainId})`);

  const registry = await ethers.getContractAt("AICRegistry", record.contracts.registry.proxy);

  /*
   * The cooldown is a constant on the STORE implementation, not on the registry, because it is
   * store code rather than a governable parameter. It is read from the implementation the CURRENT
   * factory generation pins, which is the code every store created from now on will run.
   */
  const salesImpl = record.contracts.componentImplementations.salesStore.address;
  const store = await ethers.getContractAt("AICStoreSales", salesImpl);

  /*
   * The root challenge period is pinned into the DISTRIBUTOR implementation the current factory
   * generation uses, so it is read from there rather than from a constant. The two live networks
   * deliberately differ — Base Sepolia runs a short window so a four-hour exercise can finalize an
   * epoch, Base mainnet keeps the six-hour default — and a single hardcoded number in the manifest
   * would make one of them a lie.
   */
  const distributorImpl = record.contracts.componentImplementations.distributor.address;
  const distributor = await ethers.getContractAt("DividendDistributor", distributorImpl);
  const challengePeriod = await distributor
    .rootChallengePeriod()
    .catch(() => null); // a pre-generation-4 implementation has no such getter

  const live = {
    holdingWindowSeconds: Number(await registry.holdingWindowSeconds()),
    ownerWithdrawalCooldownSeconds: Number(await store.WITHDRAWAL_COOLDOWN()),
    rootChallengePeriodSeconds:
      challengePeriod === null ? 6 * 60 * 60 : Number(challengePeriod),
  };

  record.economics ??= {};
  let changed = 0;
  for (const [key, value] of Object.entries(live)) {
    const before = record.economics[key];
    if (before === value) {
      console.log(`  ${key.padEnd(32)} ${value}  (unchanged)`);
      continue;
    }
    console.log(`  ${key.padEnd(32)} ${before ?? "(absent)"} -> ${value}`);
    record.economics[key] = value;
    changed++;
  }

  if (changed === 0) {
    console.log("\n  record already matches the chain");
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\n  ${changed} value(s) updated: ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
