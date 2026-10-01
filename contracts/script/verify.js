/**
 * Block explorer source verification.
 *
 * Runs after deployment and, crucially, is ALSO runnable on its own:
 *
 *     npx hardhat run script/verify.js --network base
 *
 * That separation matters. Verification depends on an explorer having indexed the contract, which
 * can lag a deployment by minutes, and on an API key and a third-party service that can simply be
 * down. If a verification failure aborted or "failed" a deployment, an operator would be tempted to
 * redeploy — spending real gas and creating a second set of canonical addresses — to fix a problem
 * that is entirely off-chain. So the deployment records what it deployed, verification is a
 * separate, repeatable pass over that record, and it can be retried as often as needed.
 *
 * Why verification is not optional in practice: the whole provenance model asks an Agent to trust
 * a contract because the Registry says the Factory created it. A human auditing that claim needs to
 * read the source at the address. Unverified bytecode makes every "verify this yourself" statement
 * in the documentation unfollowable.
 */

const fs = require("node:fs");
const path = require("node:path");
const { run, network, ethers } = require("hardhat");

/** Explorers need a few confirmations before they can see a contract at all. */
const CONFIRMATIONS_BEFORE_VERIFY = 5;

function manifestPath(chainId) {
  const dir = process.env.DEPLOYMENTS_OUT_DIR
    ? path.resolve(process.env.DEPLOYMENTS_OUT_DIR)
    : path.resolve(__dirname, "..", "..", "deployments");
  return path.join(dir, `${chainId}.json`);
}

/**
 * Every address to verify, with the constructor arguments it was deployed with.
 *
 * Read from the manifest rather than from deployment-time variables, so this is reproducible days
 * later by someone who did not run the deployment.
 */
function verificationTargets(manifest) {
  const c = manifest.contracts;
  const targets = [];

  // UUPS implementations take no constructor arguments; the proxy holds the init calldata.
  targets.push({
    name: "AICRegistry (implementation)",
    address: c.registry.implementation,
    constructorArguments: [],
  });
  targets.push({
    name: "AgentGoods (implementation)",
    address: c.agentGoods.implementation,
    constructorArguments: [],
  });

  /*
   * The ERC1967 proxies themselves. Their constructor arguments are the implementation address and
   * the initializer calldata, which the manifest does not record verbatim — so they are verified
   * best-effort and a failure here is reported rather than treated as fatal. Explorers generally
   * recognise a standard ERC1967Proxy and link it to its implementation automatically.
   */
  targets.push({
    name: "AICRegistry (proxy)",
    address: c.registry.proxy,
    constructorArguments: null,
    optional: true,
  });
  targets.push({
    name: "AgentGoods (proxy)",
    address: c.agentGoods.proxy,
    constructorArguments: null,
    optional: true,
  });

  targets.push({
    name: "ProtocolTreasury",
    address: c.protocolTreasury.address,
    constructorArguments: [c.registry.proxy, manifest.roles.bootstrapAdmin, manifest.roles.treasuryDestination],
  });

  for (const factory of c.activeFactories ?? []) {
    targets.push({
      name: `StoreFactory v${factory.version}`,
      address: factory.address,
      constructorArguments: [
        c.registry.proxy,
        c.agentGoods.proxy,
        manifest.external.canonicalUSDC,
        manifest.roles.dividendRootProposer,
        componentImplementationTuple(c),
      ],
    });
  }

  // The clone implementations. Each is deployed with no constructor arguments, because a clone
  // cannot run one — which is exactly why the codebase uses initializers throughout.
  for (const [label, entry] of Object.entries(c.componentImplementations ?? {})) {
    const address = typeof entry === "string" ? entry : entry?.address;
    if (typeof address !== "string" || !address.startsWith("0x")) continue;
    /*
     * Most implementations take no constructor argument. The distributor does: its root challenge
     * period is pinned at deploy, so verification has to supply the exact value that was used or
     * the explorer compares against different bytecode and rejects it. The value is read from the
     * manifest, which sync-economics reads back off the chain, so it cannot drift from what was
     * actually deployed.
     */
    const constructorArguments =
      label === "distributor" ? [manifest.economics?.rootChallengePeriodSeconds ?? 0] : [];
    targets.push({ name: `${label} (clone implementation)`, address, constructorArguments });
  }

  return targets.filter((t) => typeof t.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(t.address));
}

/**
 * The implementation set the Factory was constructed with, in its declared order.
 *
 * Read back from the manifest rather than hard-coded, so a Factory deployed with a different
 * component set still verifies. The order must match the constructor's struct field order.
 */
function componentImplementationTuple(contracts) {
  const impls = contracts.componentImplementations ?? {};
  const address = (entry) => (typeof entry === "string" ? entry : entry?.address);
  // The order MUST match StoreFactory.Implementations field order exactly: a struct argument is
  // ABI-encoded positionally, so a transposed pair verifies as a different contract and fails
  // with an unhelpful bytecode mismatch.
  return [
    address(impls.aiCoin),
    address(impls.salesStore),
    address(impls.rentalsStore),
    address(impls.licenseToken),
    address(impls.governance),
    address(impls.distributor),
  ];
}

function isAlreadyVerified(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return message.includes("already verified") || message.includes("already been verified");
}

async function verifyTarget(target) {
  if (target.constructorArguments === null) {
    // Nothing recorded to reconstruct the constructor call with; attempt without arguments.
    await run("verify:verify", { address: target.address });
    return;
  }
  await run("verify:verify", {
    address: target.address,
    constructorArguments: target.constructorArguments,
  });
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  if (chainId === 31337) {
    console.log("verify: local chain has no block explorer; nothing to do.");
    return;
  }

  const apiKey = process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    // Fail loudly rather than skipping quietly: a deployment nobody can read the source of is a
    // deployment that cannot be audited, and the operator must know that now rather than later.
    throw new Error(
      "verify: BASESCAN_API_KEY (or ETHERSCAN_API_KEY) is not set. Source verification is required " +
        "for any non-local deployment: the provenance model asks people to audit these contracts, " +
        "and unverified bytecode makes that impossible. Get a free key from the explorer and rerun " +
        "`npx hardhat run script/verify.js --network " + network.name + "`."
    );
  }

  const file = manifestPath(chainId);
  if (!fs.existsSync(file)) {
    throw new Error(`verify: no deployment manifest at ${file}. Deploy first.`);
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const targets = verificationTargets(manifest);

  console.log(`\nVerifying ${targets.length} contract(s) on ${network.name} (chainId ${chainId}):`);

  // Let the explorer catch up. Verifying a contract it has not indexed yet fails with a confusing
  // "does not have bytecode" error that reads like a deployment problem.
  const deployedAt = Number(manifest.deploymentBlock ?? 0);
  if (deployedAt > 0) {
    const head = await ethers.provider.getBlockNumber();
    const confirmations = head - deployedAt;
    if (confirmations < CONFIRMATIONS_BEFORE_VERIFY) {
      const needed = CONFIRMATIONS_BEFORE_VERIFY - confirmations;
      console.log(`  waiting for ${needed} more confirmation(s) before verifying…`);
      await new Promise((resolve) => setTimeout(resolve, needed * 3000));
    }
  }

  const results = [];
  for (const target of targets) {
    process.stdout.write(`  ${target.name.padEnd(36)} ${target.address} … `);
    try {
      await verifyTarget(target);
      console.log("verified");
      results.push({ ...target, status: "verified" });
    } catch (error) {
      if (isAlreadyVerified(error)) {
        console.log("already verified");
        results.push({ ...target, status: "already_verified" });
        continue;
      }
      const reason = String(error?.message ?? error).split("\n")[0];
      console.log(`FAILED (${reason})`);
      results.push({ ...target, status: "failed", reason });
    }
  }

  const failed = results.filter((r) => r.status === "failed" && !r.optional);
  const optionalFailed = results.filter((r) => r.status === "failed" && r.optional);

  // Record the outcome in the manifest, so "is this deployment auditable?" is answerable from the
  // manifest alone rather than from someone's terminal scrollback.
  manifest.verification = {
    verifiedAt: new Date().toISOString(),
    explorer: network.name,
    results: results.map((r) => ({ name: r.name, address: r.address, status: r.status, reason: r.reason ?? null })),
    complete: failed.length === 0,
  };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log("");
  if (optionalFailed.length > 0) {
    console.log(
      `  ${optionalFailed.length} optional target(s) did not verify (proxies usually resolve ` +
        `themselves on the explorer). Not treated as a failure.`
    );
  }
  if (failed.length > 0) {
    throw new Error(
      `verify: ${failed.length} required contract(s) did not verify: ` +
        failed.map((f) => f.name).join(", ") +
        `. Fix and rerun this script; do NOT redeploy — the addresses are already canonical.`
    );
  }

  console.log(`verify: all ${results.length} target(s) verified. Manifest updated.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.message ?? error);
      process.exit(1);
    });
}

module.exports = { main, verificationTargets };
