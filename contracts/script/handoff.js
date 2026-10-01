/**
 * Phase 8: hand protocol authority from the bootstrap admin key to a timelock.
 *
 *     npx hardhat run script/handoff.js --network base              # dry run, changes nothing
 *     HANDOFF_EXECUTE=1 npx hardhat run script/handoff.js --network base
 *
 * This is the most dangerous script in the repository, and the danger is not the obvious one.
 * Deploying a timelock is cheap and reversible. Getting the ORDER wrong is not: revoking
 * `DEFAULT_ADMIN_ROLE` from yourself before the timelock demonstrably holds it leaves a protocol
 * that nobody can administer, ever, with no recovery path of any kind. Not "call support" — the
 * roles are gone and the only function that could grant them requires a role nobody has.
 *
 * So the whole script is built around one rule:
 *
 *     GRANT everything, VERIFY everything, and only then REVOKE.
 *
 * Every revoke is preceded by an on-chain read proving the timelock already holds that exact role
 * on that exact contract. If any of those reads disagrees, the script stops before revoking
 * anything, and what it leaves behind is a protocol with two administrators rather than none —
 * which is a bad state to be in for an hour and a trivial one to fix.
 *
 * It also defaults to a dry run. You will see the entire plan, including every address and every
 * role, before anything is sent. `HANDOFF_EXECUTE=1` is the only thing that makes it act.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const LOCAL_CHAIN_IDS = new Set([31337n, 1337n]);

/** 48h. See docs/GUARDIAN_TIMELOCK_MODEL.md §5 for why this number and not a larger one. */
const DEFAULT_MIN_DELAY_SECONDS = 48 * 60 * 60;

const ROLE = {
  DEFAULT_ADMIN: ethers.ZeroHash,
  GUARDIAN: ethers.id("GUARDIAN_ROLE"),
  FACTORY_ADMIN: ethers.id("FACTORY_ADMIN_ROLE"),
  FEE_ADMIN: ethers.id("FEE_ADMIN_ROLE"),
  UPGRADER: ethers.id("UPGRADER_ROLE"),
  WITHDRAWER: ethers.id("WITHDRAWER_ROLE"),
  DESTINATION_ADMIN: ethers.id("DESTINATION_ADMIN_ROLE"),
  RESCUE: ethers.id("RESCUE_ROLE"),
};

/**
 * Exactly which roles move, on which contract.
 *
 * `GUARDIAN_ROLE` is deliberately absent. A timelocked emergency stop is not an emergency stop;
 * the guardian key keeps its pause power and gains nothing else. [GUARDIAN_TIMELOCK_MODEL §5]
 */
const TRANSFERS = [
  { contract: "registry", roles: ["UPGRADER", "FEE_ADMIN", "FACTORY_ADMIN", "DEFAULT_ADMIN"] },
  { contract: "agentGoods", roles: ["UPGRADER", "DEFAULT_ADMIN"] },
  { contract: "treasury", roles: ["WITHDRAWER", "DESTINATION_ADMIN", "RESCUE", "DEFAULT_ADMIN"] },
];

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value.trim();
}

function manifestPath(chainId) {
  const dir = process.env.DEPLOYMENTS_OUT_DIR
    ? path.resolve(process.env.DEPLOYMENTS_OUT_DIR)
    : path.resolve(__dirname, "..", "..", "deployments");
  return path.join(dir, `${chainId}.json`);
}

/** Addresses supplied as a comma-separated list, validated rather than trusted. */
function addressList(name, { allowEmpty = false } = {}) {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    if (allowEmpty) return [];
    throw new Error(`Missing required environment variable ${name} (comma-separated addresses).`);
  }
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const address of list) {
    if (!ethers.isAddress(address)) {
      throw new Error(`${name} contains "${address}", which is not a valid address.`);
    }
  }
  const unique = new Set(list.map((a) => a.toLowerCase()));
  if (unique.size !== list.length) {
    throw new Error(`${name} contains a duplicate address.`);
  }
  return list.map((a) => ethers.getAddress(a));
}

/**
 * The proving-run gate, read from the report the harness writes.
 *
 * D-027: the handoff is gated on 72 continuous clean hours. Checking it here rather than trusting
 * the operator to remember is the whole point of writing the gate down.
 */
function assertProvingRunPassed() {
  if (process.env.HANDOFF_SKIP_PROVING_GATE === "I_ACCEPT_THE_RISK") {
    console.log(
      "\n  !! Proving-run gate SKIPPED by explicit override. This is only defensible on a testnet."
    );
    return;
  }
  const report = path.resolve(__dirname, "..", "..", "docs", "LIVE_AGENT_PROVING_REPORT.md");
  if (!fs.existsSync(report)) {
    throw new Error(
      "No proving report at docs/LIVE_AGENT_PROVING_REPORT.md. The handoff is gated on a 72-hour " +
        "clean run (DECISIONS D-027). Run the proving harness first.\n" +
        "On a testnet, set HANDOFF_SKIP_PROVING_GATE=I_ACCEPT_THE_RISK to proceed anyway."
    );
  }
  const text = fs.readFileSync(report, "utf8");
  const hours = /cleanHours[^0-9]*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  const passing = /\bPASS\b/.test(text);
  if (!passing || !hours || Number(hours[1]) < 72) {
    throw new Error(
      `The proving report does not show a passing 72-hour run ` +
        `(PASS=${passing}, cleanHours=${hours ? hours[1] : "not found"}). ` +
        `The handoff is irreversible; do not do it on an unproven deployment.`
    );
  }
  console.log(`  proving run                 PASS, ${hours[1]} clean hours`);
}

async function hasRole(contract, role, account) {
  return contract.hasRole(role, account);
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [signer] = await ethers.getSigners();
  const execute = process.env.HANDOFF_EXECUTE === "1";
  const isLocal = LOCAL_CHAIN_IDS.has(chainId);

  console.log(`\nAIC authority handoff — ${network.name} (chainId ${chainId})`);
  console.log(`Mode: ${execute ? "EXECUTE (this will send transactions)" : "DRY RUN (nothing will be sent)"}\n`);

  const file = manifestPath(chainId);
  if (!fs.existsSync(file)) throw new Error(`No deployment manifest at ${file}.`);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));

  if (manifest.roles?.timelock) {
    throw new Error(
      `This deployment already records a timelock at ${manifest.roles.timelock}. The handoff has ` +
        `already been done. Re-running it cannot help and may revoke a role you still need.`
    );
  }

  // ------------------------------------------------------------------ preflight
  console.log("Preflight");

  const bootstrapAdmin = ethers.getAddress(manifest.roles.bootstrapAdmin);
  if (signer.address.toLowerCase() !== bootstrapAdmin.toLowerCase()) {
    throw new Error(
      `The connected signer is ${signer.address}, but the manifest's bootstrap admin is ` +
        `${bootstrapAdmin}. Only the bootstrap admin can hand over its own roles.`
    );
  }
  console.log(`  bootstrap admin             ${bootstrapAdmin} (connected)`);

  if (!isLocal) assertProvingRunPassed();

  const proposers = addressList("TIMELOCK_PROPOSERS");
  // An empty executor set means "anyone may execute". That is a normal and safe configuration —
  // the delay has already elapsed and the call is already public — but it must be chosen, not
  // arrived at, so it is spelled with an explicit sentinel rather than by leaving a variable unset.
  const executorsRaw = process.env.TIMELOCK_EXECUTORS?.trim();
  const openExecution = executorsRaw === "ANYONE";
  const executors = openExecution ? [ethers.ZeroAddress] : addressList("TIMELOCK_EXECUTORS");

  const minDelay = Number(process.env.TIMELOCK_MIN_DELAY_SECONDS ?? DEFAULT_MIN_DELAY_SECONDS);
  if (!Number.isInteger(minDelay) || minDelay < 0) {
    throw new Error("TIMELOCK_MIN_DELAY_SECONDS must be a non-negative integer.");
  }
  if (!isLocal && minDelay < 3600) {
    throw new Error(
      `A timelock delay of ${minDelay}s provides essentially no warning to holders before an ` +
        `upgrade lands, which defeats the purpose of having one. Refusing. See ` +
        `docs/GUARDIAN_TIMELOCK_MODEL.md §5.`
    );
  }

  const guardian = ethers.getAddress(manifest.roles.guardian);
  for (const proposer of proposers) {
    if (proposer.toLowerCase() === bootstrapAdmin.toLowerCase()) {
      throw new Error(
        `${proposer} is both the bootstrap admin and a proposed timelock proposer. The handoff is ` +
          `supposed to REMOVE that key's authority; leaving it able to propose upgrades keeps it.`
      );
    }
    if (proposer.toLowerCase() === guardian.toLowerCase()) {
      throw new Error(
        `${proposer} is both the guardian and a timelock proposer. Keeping those separate is what ` +
          `makes a stolen guardian key a denial of service rather than a takeover.`
      );
    }
  }

  console.log(`  timelock delay              ${minDelay}s (${(minDelay / 3600).toFixed(1)}h)`);
  console.log(`  proposers (${proposers.length})`.padEnd(30) + proposers.join("\n" + " ".repeat(30)));
  console.log(
    `  executors`.padEnd(30) + (openExecution ? "ANYONE (open execution after the delay)" : executors.join("\n" + " ".repeat(30)))
  );
  console.log(`  guardian (unchanged)        ${guardian}`);

  // ------------------------------------------------------------------ contracts
  const registry = await ethers.getContractAt("AICRegistry", manifest.contracts.registry.proxy);
  const agentGoods = await ethers.getContractAt("AgentGoods", manifest.contracts.agentGoods.proxy);
  const treasury = await ethers.getContractAt("ProtocolTreasury", manifest.contracts.protocolTreasury.address);
  const targets = { registry, agentGoods, treasury };

  console.log("\nCurrent authority");
  for (const { contract, roles } of TRANSFERS) {
    for (const role of roles) {
      const held = await hasRole(targets[contract], ROLE[role], bootstrapAdmin);
      console.log(`  ${contract.padEnd(12)} ${role.padEnd(18)} bootstrapAdmin=${held ? "YES" : "no"}`);
      if (!held) {
        console.log(
          `    note: the bootstrap admin does not hold this role, so there is nothing to move. ` +
            `Continuing — this is expected if a previous run was interrupted after granting.`
        );
      }
    }
  }

  if (!execute) {
    console.log(
      "\nDry run complete. Nothing was sent.\n" +
        "Re-read the plan above — especially the proposer list and the delay — and if it is right, " +
        "rerun with HANDOFF_EXECUTE=1.\n"
    );
    return;
  }

  // ------------------------------------------------------- 1. deploy the timelock
  console.log("\n[1/4] Deploying the timelock");
  const Timelock = await ethers.getContractFactory("AICTimelock");
  // admin = address(0): the timelock administers itself from birth. Passing an admin here would
  // leave a key able to rewrite the proposer set without a delay, which is the whole thing we are
  // trying to stop doing.
  const timelock = await Timelock.deploy(minDelay, proposers, executors, ethers.ZeroAddress);
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log(`  AICTimelock                 ${timelockAddress}`);

  // ------------------------------------------------------------- 2. grant
  console.log("\n[2/4] Granting every role to the timelock");
  for (const { contract, roles } of TRANSFERS) {
    for (const role of roles) {
      if (await hasRole(targets[contract], ROLE[role], timelockAddress)) {
        console.log(`  ${contract.padEnd(12)} ${role.padEnd(18)} already held, skipping`);
        continue;
      }
      const tx = await targets[contract].grantRole(ROLE[role], timelockAddress);
      await tx.wait();
      console.log(`  ${contract.padEnd(12)} ${role.padEnd(18)} granted`);
    }
  }

  // -------------------------------------------------------------- 3. verify
  // The entire safety of this script is this block. Nothing is revoked until every single role has
  // been read back from chain on the timelock's address.
  console.log("\n[3/4] Verifying the timelock holds everything BEFORE revoking anything");
  const missing = [];
  for (const { contract, roles } of TRANSFERS) {
    for (const role of roles) {
      const held = await hasRole(targets[contract], ROLE[role], timelockAddress);
      console.log(`  ${contract.padEnd(12)} ${role.padEnd(18)} ${held ? "confirmed" : "MISSING"}`);
      if (!held) missing.push(`${contract}.${role}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Stopping before any revoke. The timelock does not hold: ${missing.join(", ")}.\n` +
        `Nothing has been removed from the bootstrap admin, so the protocol currently has TWO ` +
        `administrators and is fully operable. Investigate, then rerun — the grant step is ` +
        `idempotent and will skip what is already in place.`
    );
  }

  // -------------------------------------------------------------- 4. revoke
  console.log("\n[4/4] Revoking the bootstrap admin");
  // DEFAULT_ADMIN last on each contract: it is the role that authorizes the other revokes, so
  // dropping it first would strand the remaining ones.
  for (const { contract, roles } of TRANSFERS) {
    const ordered = [...roles.filter((r) => r !== "DEFAULT_ADMIN"), ...roles.filter((r) => r === "DEFAULT_ADMIN")];
    for (const role of ordered) {
      if (!(await hasRole(targets[contract], ROLE[role], bootstrapAdmin))) {
        console.log(`  ${contract.padEnd(12)} ${role.padEnd(18)} not held, skipping`);
        continue;
      }
      const tx = await targets[contract].revokeRole(ROLE[role], bootstrapAdmin);
      await tx.wait();
      console.log(`  ${contract.padEnd(12)} ${role.padEnd(18)} revoked`);
    }
  }

  // ------------------------------------------------------------ final assertion
  console.log("\nFinal state");
  const residual = [];
  for (const { contract, roles } of TRANSFERS) {
    for (const role of roles) {
      if (await hasRole(targets[contract], ROLE[role], bootstrapAdmin)) {
        residual.push(`${contract}.${role}`);
      }
    }
  }
  if (residual.length > 0) {
    throw new Error(`The bootstrap admin still holds: ${residual.join(", ")}. The handoff is INCOMPLETE.`);
  }
  console.log("  bootstrap admin holds no protocol role.");

  const guardianIntact = await hasRole(registry, ROLE.GUARDIAN, guardian);
  console.log(`  guardian still holds GUARDIAN_ROLE: ${guardianIntact ? "yes" : "NO — investigate"}`);
  if (!guardianIntact) {
    throw new Error("The guardian lost its role during the handoff. The protocol has no emergency stop.");
  }

  manifest.roles.timelock = timelockAddress;
  manifest.handoff = {
    completedAt: new Date().toISOString(),
    timelock: timelockAddress,
    minDelaySeconds: minDelay,
    proposers,
    executors: openExecution ? "ANYONE" : executors,
    revokedFrom: bootstrapAdmin,
  };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`\n  manifest updated: ${file}`);

  console.log(
    `\nHandoff complete.\n\n` +
      `One thing remains, and it is not optional: push a trivial change all the way through the ` +
      `timelock — propose, wait ${(minDelay / 3600).toFixed(1)}h, execute — before you ever need to. ` +
      `Set a parameter to the value it already has. A timelock you have never executed through is ` +
      `one you do not know how to use.\n`
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`\n${error.message ?? error}\n`);
      process.exit(1);
    });
}

module.exports = { main, TRANSFERS, ROLE };
