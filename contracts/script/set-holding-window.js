/**
 * Set the dividend holding window on a live deployment.
 *
 * WHAT THE WINDOW IS. Entitlement to a dividend epoch is an account's MINIMUM balance across the
 * window, not its balance at the snapshot. That is the anti-snipe rule, and it is the reason the
 * merkle builder can say plainly that "an account whose first acquisition falls inside the window
 * opens at zero and weighs zero, with no special case".
 *
 * WHY IT IS BEING CHANGED. The property above has a consequence that the original seven-day value
 * made absolute: the window is a hard floor on how long a market must run before ANY dividend is
 * claimable by anyone. At seven days, a market that ran for four hours could accrue a holder
 * reserve, publish epochs, and pay out exactly nothing - not as a bug, but as arithmetic. Nobody
 * had held for a week, so every weight was zero.
 *
 * Three hours keeps the anti-snipe property intact. Buying just before a snapshot still weighs
 * nothing; you must still hold across the whole window before you are owed anything. It only stops
 * the rule from being unreachable, and it lines the window up with StoreBase.WITHDRAWAL_COOLDOWN
 * so a controller's access to its proceeds and its holders' claim move on one clock instead of two.
 *
 *     npx hardhat run script/set-holding-window.js --network baseSepolia
 *     npx hardhat run script/set-holding-window.js --network base
 *
 * Override with HOLDING_WINDOW_SECONDS. Refuses unless the signer holds FEE_ADMIN_ROLE, and
 * verifies by reading the value back from the chain rather than trusting the receipt.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const DEPLOYMENTS = path.resolve(__dirname, "..", "..", "deployments");
const TARGET = Number(process.env.HOLDING_WINDOW_SECONDS ?? 10_800);

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const file = path.join(DEPLOYMENTS, `${chainId}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment record for chain ${chainId} at ${file}`);

  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const [signer] = await ethers.getSigners();
  const registryAddress = record.contracts.registry.proxy;
  const registry = await ethers.getContractAt("AICRegistry", registryAddress);

  console.log("Dividend holding window");
  console.log(`  network   ${network.name} (chain ${chainId})`);
  console.log(`  registry  ${registryAddress}`);
  console.log(`  signer    ${signer.address}`);

  const FEE_ADMIN_ROLE = ethers.id("FEE_ADMIN_ROLE");
  if (!(await registry.hasRole(FEE_ADMIN_ROLE, signer.address))) {
    throw new Error(
      `signer ${signer.address} does not hold FEE_ADMIN_ROLE on ${registryAddress}. ` +
        `On a handed-off deployment this is a governance action, not a script run.`
    );
  }

  const before = Number(await registry.holdingWindowSeconds());
  console.log(`\n  current   ${before}s (${(before / 3600).toFixed(2)}h)`);
  console.log(`  target    ${TARGET}s (${(TARGET / 3600).toFixed(2)}h)`);
  if (before === TARGET) {
    console.log("\n  already set; nothing to do");
    return;
  }

  await (await registry.setHoldingWindowSeconds(TARGET)).wait();

  /*
   * Poll rather than read once. A mined transaction is not immediately visible to whichever node
   * answers the next call, and this exact read-back has produced a false failure on both chains
   * against transactions that had in fact succeeded.
   */
  let after = before;
  for (let attempt = 0; attempt < 12; attempt++) {
    after = Number(await registry.holdingWindowSeconds());
    if (after === TARGET) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (after !== TARGET) throw new Error(`holding window is ${after}s after the transaction, wanted ${TARGET}s`);
  console.log(`\n  verified on chain: ${after}s`);

  record.protocolParameters = {
    ...(record.protocolParameters ?? {}),
    holdingWindowSeconds: {
      value: TARGET,
      previousValue: before,
      setAt: new Date().toISOString(),
      why:
        "Entitlement is the minimum balance across this window, so the window is a hard floor on " +
        "how long a market must run before any dividend is claimable. Seven days made payouts " +
        "unreachable for short-lived markets. Matched to StoreBase.WITHDRAWAL_COOLDOWN.",
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`  deployment record updated: ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
