#!/usr/bin/env node
/**
 * Production deployment gate. [MASTER_PLAN 29B]
 *
 * Development defaults must not be able to reach a production environment. A warning is not
 * enough: the failure is silent, and the values involved decide whether the system is reading a
 * real chain at all. A mock USDC, a chainId of 31337, or `safeConfirmations: 0` on a chain that
 * reorgs will not announce themselves — they will simply produce confident, wrong answers about
 * money.
 *
 * This is a GATE, not a linter. There is deliberately no override flag, no environment variable
 * that disables it, and no warn-only mode. Reaching production with a mock manifest requires
 * deleting this file, which is visible in review. A test greps this source for the usual escape
 * hatches by name, so do not reintroduce one even as a comment.
 *
 *   node infra/scripts/deploy-gate.mjs --manifest deployments/8453.json --environment PRODUCTION
 *
 * Exits 0 on success with one confirmation line, or non-zero listing EVERY violation, so an
 * operator fixes one round of problems instead of discovering them one at a time.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Per-network minimums. These are protocol data, not opinion: they come from the reorg depth
 * each chain actually exhibits. An unknown chainId is itself a failure — the gate never guesses
 * a safety margin for a network it has not been told about.
 */
const NETWORKS = {
  8453: { name: "base", minSafeConfirmations: 8, minReorgDepth: 64 },
  84532: { name: "base-sepolia", minSafeConfirmations: 4, minReorgDepth: 32 },
};

const LOCAL_ENVIRONMENTS = new Set(["LOCAL"]);
/*
 * ONE vocabulary, and it is the runtime's.
 *
 * This gate used to accept STAGING and CANARY while `backend/src/config/env.ts` and
 * `contracts/script/deploy.js` both spoke LOCAL / PROVING / CUTOVER / PRODUCTION. The result was
 * that a real deployment could never satisfy the gate: deploy.js stamps a testnet manifest
 * PROVING, and the gate refused every environment it was offered because the word was not in its
 * list. Found by running the actual Base Sepolia deployment through it.
 *
 * An enum that disagrees with the code that writes the value it validates is not a stricter check,
 * it is a broken one — and a gate that always refuses gets bypassed, which is how it stops
 * protecting anything.
 */
const DEPLOYABLE_ENVIRONMENTS = new Set(["LOCAL", "PROVING", "CUTOVER", "PRODUCTION"]);

function parseArgs(argv) {
  const args = { manifest: null, environment: null, safeConfirmations: null, maxReorgDepth: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--manifest") args.manifest = value;
    else if (key === "--environment") args.environment = value;
    else if (key === "--safe-confirmations") args.safeConfirmations = Number(value);
    else if (key === "--max-reorg-depth") args.maxReorgDepth = Number(value);
    else continue;
    i += 1;
  }
  return args;
}

/**
 * Runs every check and returns ALL violations.
 *
 * `runtime` carries the indexer settings that live in environment configuration rather than in
 * the manifest, so the gate can check the deployment and the process that will read it together.
 * Missing runtime values are themselves violations in a non-LOCAL environment: a gate that
 * silently skips a check it could not perform is not a gate.
 */
export function evaluate({ manifest, environment, runtime = {} }) {
  const violations = [];
  const fail = (field, message) => violations.push({ field, message });

  if (!DEPLOYABLE_ENVIRONMENTS.has(environment)) {
    fail("environment", `unknown environment "${environment}"; expected one of ${[...DEPLOYABLE_ENVIRONMENTS].join(", ")}`);
    return violations;
  }

  const isLocal = LOCAL_ENVIRONMENTS.has(environment);

  if (manifest.environment !== environment) {
    fail(
      "manifest.environment",
      `manifest was built for ${manifest.environment}, but this deployment targets ${environment}`
    );
  }

  if (isLocal) {
    // LOCAL exists precisely so the mock stack can run. Nothing below applies.
    return violations;
  }

  if (manifest.external?.isMockExternal === true) {
    fail(
      "external.isMockExternal",
      "the manifest points at MOCK external infrastructure (mock USDC, mock DEX). Real money " +
        "would move against contracts nobody else recognises."
    );
  }

  const chainId = Number(manifest.chainId);
  if (chainId === 31337) {
    fail("chainId", "chainId 31337 is the local development chain and can never be a deployment target");
  }

  const network = NETWORKS[chainId];
  if (!network) {
    fail(
      "chainId",
      `chainId ${chainId} has no recorded confirmation or reorg minimums. Add it to NETWORKS in ` +
        "this gate, with values justified by that chain observed behaviour, before deploying to it."
    );
  }

  const safeConfirmations = runtime.safeConfirmations;
  if (safeConfirmations === null || safeConfirmations === undefined || Number.isNaN(safeConfirmations)) {
    fail("safeConfirmations", "not supplied; a non-LOCAL deployment must state it explicitly");
  } else if (safeConfirmations === 0) {
    fail("safeConfirmations", "0 means every unconfirmed block is treated as final. Never valid off LOCAL.");
  } else if (network && safeConfirmations < network.minSafeConfirmations) {
    fail(
      "safeConfirmations",
      `${safeConfirmations} is below the ${network.name} minimum of ${network.minSafeConfirmations}`
    );
  }

  const maxReorgDepth = runtime.maxReorgDepth;
  if (maxReorgDepth === null || maxReorgDepth === undefined || Number.isNaN(maxReorgDepth)) {
    fail("maxReorgDepth", "not supplied; a non-LOCAL deployment must state it explicitly");
  } else {
    if (network && maxReorgDepth < network.minReorgDepth) {
      fail(
        "maxReorgDepth",
        `${maxReorgDepth} is below the ${network.name} minimum of ${network.minReorgDepth}`
      );
    }
    if (
      safeConfirmations !== null &&
      safeConfirmations !== undefined &&
      !Number.isNaN(safeConfirmations) &&
      maxReorgDepth <= safeConfirmations
    ) {
      fail(
        "maxReorgDepth",
        `must exceed safeConfirmations (${safeConfirmations}); a rollback window no deeper than ` +
          "the finality window cannot undo the reorg it was sized for"
      );
    }
  }

  const usdc = manifest.external?.canonicalUSDC ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(usdc)) {
    fail("external.canonicalUSDC", "missing or malformed");
  }

  const router = manifest.external?.dexRouter ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(router)) {
    fail("external.dexRouter", "missing or malformed");
  }

  /*
   * On a chain we know the canonical addresses for, check them — do not merely check their shape.
   *
   * This exists because of a specific, easy, silent mistake. Base Sepolia has NO official Uniswap
   * V2: the mainnet router address holds an unrelated contract there and the mainnet factory
   * address has no code at all, so a testnet rehearsal has to deploy its own V2 and point
   * DEX_ROUTER_ADDRESS at it. The obvious failure mode is then forgetting to put the real address
   * back before mainnet.
   *
   * Nothing else would catch it. The address is well-formed, the deployment succeeds, and the
   * protocol lists into a pool nobody can find at the one moment in a token's life that cannot be
   * retried. A shape check is no protection against a plausible wrong value.
   */
  const KNOWN_EXTERNALS = {
    8453: {
      canonicalUSDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      dexRouter: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
      dexFactory: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6",
    },
  };
  const known = KNOWN_EXTERNALS[Number(manifest.chainId)];
  if (known) {
    for (const [field, expected] of Object.entries(known)) {
      const actual = String(manifest.external?.[field] ?? "").toLowerCase();
      if (actual && actual !== expected) {
        fail(
          `external.${field}`,
          `is ${manifest.external[field]}, but the canonical address on chain ` +
            `${manifest.chainId} is ${expected}. A rehearsal address left in place here would ` +
            `list every token into a venue nobody can find, irreversibly.`
        );
      }
    }
  }

  const guardian = (manifest.roles?.guardian ?? "").toLowerCase();
  const deployer = (manifest.deployer ?? "").toLowerCase();
  if (!guardian) {
    fail("roles.guardian", "missing");
  } else if (guardian === deployer) {
    fail(
      "roles.guardian",
      "the guardian is the deployer. The pause authority and the key that created the system " +
        "must not be the same key."
    );
  }

  /*
   * The timelock is required for PRODUCTION and only for PRODUCTION, and the distinction is not a
   * softening of the rule — it is the rule being applied to the right stage.
   *
   * A timelock cannot exist before the deployment it governs: `script/handoff.js` deploys it, and
   * it refuses to run until a 72-hour clean proving run has happened against a LIVE deployment
   * (D-027). Requiring one at deploy time would therefore make every real deployment impossible,
   * and a gate that cannot be satisfied is a gate that gets bypassed.
   *
   * So the stages are distinct, and PRODUCTION means "authority has been handed over":
   *
   *     PROVING / CUTOVER bootstrap admin holds authority; every other gate check applies in full
   *     PRODUCTION        the handoff is complete and recorded
   */
  if (environment === "PRODUCTION" && !manifest.roles?.timelock) {
    fail(
      "roles.timelock",
      "missing. PRODUCTION means authority has been handed to a timelock; a manifest without one " +
        "is still in its bootstrap state, where a single key can upgrade every contract. Deploy " +
        "and run the proving harness under PROVING, then run script/handoff.js, then re-run this " +
        "gate for PRODUCTION."
    );
  }

  return violations;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest || !args.environment) {
    console.error("usage: deploy-gate.mjs --manifest <path> --environment <LOCAL|PROVING|CUTOVER|PRODUCTION>");
    console.error("       [--safe-confirmations <n>] [--max-reorg-depth <n>]");
    process.exit(2);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8"));
  } catch (error) {
    console.error(`deploy-gate: cannot read manifest ${args.manifest}: ${String(error)}`);
    process.exit(2);
  }

  const runtime = {
    safeConfirmations:
      args.safeConfirmations ?? (process.env.SAFE_CONFIRMATIONS ? Number(process.env.SAFE_CONFIRMATIONS) : undefined),
    maxReorgDepth:
      args.maxReorgDepth ?? (process.env.MAX_REORG_DEPTH ? Number(process.env.MAX_REORG_DEPTH) : undefined),
  };

  const violations = evaluate({ manifest, environment: args.environment, runtime });

  if (violations.length === 0) {
    console.log(
      `deploy-gate: PASS — ${args.manifest} is acceptable for ${args.environment} ` +
        `(chainId ${manifest.chainId}).`
    );
    process.exit(0);
  }

  console.error(`deploy-gate: REFUSED — ${violations.length} violation(s) for ${args.environment}:`);
  for (const v of violations) console.error(`  - ${v.field}: ${v.message}`);
  console.error("\nThis gate has no override. Fix the configuration.");
  process.exit(1);
}

// Only run as a CLI; importing it for tests must not exit the process.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main();
}
