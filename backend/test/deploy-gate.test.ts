/**
 * MASTER_PLAN 29B — the production deployment gate.
 *
 * The gate exists because the failure it prevents is silent. A manifest pointing at a mock USDC
 * does not announce itself; it produces confident, wrong answers about money. So the tests here
 * check two things in equal measure: that real misconfiguration is refused, and that the gate
 * has no way to be talked out of a refusal.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { evaluate } from "../../infra/scripts/deploy-gate.mjs";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LOCAL_MANIFEST = path.join(REPO_ROOT, "deployments", "31337.json");

function localManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(LOCAL_MANIFEST, "utf8")) as Record<string, unknown>;
}

/** A manifest that would be acceptable on Base, used to prove the gate is not simply refusing everything. */
function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: "PRODUCTION",
    chainId: 8453,
    deployer: "0x1111111111111111111111111111111111111111",
    roles: {
      guardian: "0x2222222222222222222222222222222222222222",
      timelock: "0x3333333333333333333333333333333333333333",
    },
    external: {
      isMockExternal: false,
      canonicalUSDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      dexRouter: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    },
    ...overrides,
  };
}

const SAFE_RUNTIME = { safeConfirmations: 8, maxReorgDepth: 64 };

function fields(violations: { field: string }[]): string[] {
  return violations.map((v) => v.field);
}

describe("Production deployment gate (MASTER_PLAN 29B)", { concurrency: 1 }, () => {
  test("accepts the local mock manifest for LOCAL, because that is what LOCAL is for", () => {
    const violations = evaluate({ manifest: localManifest(), environment: "LOCAL", runtime: {} });
    assert.deepEqual(violations, []);
  });

  test("refuses the same manifest for PRODUCTION and names every violation at once", () => {
    const violations = evaluate({ manifest: localManifest(), environment: "PRODUCTION", runtime: {} });
    const named = fields(violations);

    assert.ok(named.includes("external.isMockExternal"), "mock external infrastructure is refused");
    assert.ok(named.includes("chainId"), "the local chain is refused");
    assert.ok(named.includes("safeConfirmations"), "zero-confirmation finality is refused");
    assert.ok(named.includes("maxReorgDepth"), "an unstated reorg depth is refused");
    assert.ok(named.includes("manifest.environment"), "a LOCAL manifest cannot be deployed as PRODUCTION");

    // One run, all of it. An operator should never have to rediscover these one at a time.
    assert.ok(violations.length >= 5, `expected the whole set in one run, got ${violations.length}`);
  });

  test("accepts a correctly configured Base manifest", () => {
    const violations = evaluate({
      manifest: baseManifest(),
      environment: "PRODUCTION",
      runtime: SAFE_RUNTIME,
    });
    assert.deepEqual(violations, [], JSON.stringify(violations));
  });

  test("enforces the per-network confirmation and reorg minimums", () => {
    const tooShallow = evaluate({
      manifest: baseManifest(),
      environment: "PRODUCTION",
      runtime: { safeConfirmations: 4, maxReorgDepth: 64 },
    });
    assert.deepEqual(fields(tooShallow), ["safeConfirmations"]);

    const shallowReorg = evaluate({
      manifest: baseManifest(),
      environment: "PRODUCTION",
      runtime: { safeConfirmations: 8, maxReorgDepth: 32 },
    });
    assert.deepEqual(fields(shallowReorg), ["maxReorgDepth"]);

    const invertedWindow = evaluate({
      manifest: baseManifest(),
      environment: "PRODUCTION",
      runtime: { safeConfirmations: 64, maxReorgDepth: 64 },
    });
    assert.ok(
      invertedWindow.some((v) => v.field === "maxReorgDepth" && /must exceed safeConfirmations/.test(v.message)),
      "a rollback window no deeper than the finality window is refused"
    );
  });

  test("refuses a chain it has no recorded minimums for, rather than guessing one", () => {
    const violations = evaluate({
      manifest: baseManifest({ chainId: 424242 }),
      environment: "PRODUCTION",
      runtime: SAFE_RUNTIME,
    });
    assert.ok(violations.some((v) => v.field === "chainId" && /no recorded/.test(v.message)));
  });

  test("refuses a guardian that is the deployer, and a missing timelock", () => {
    const sameKey = evaluate({
      manifest: baseManifest({
        roles: {
          guardian: "0x1111111111111111111111111111111111111111",
          timelock: "0x3333333333333333333333333333333333333333",
        },
      }),
      environment: "PRODUCTION",
      runtime: SAFE_RUNTIME,
    });
    assert.deepEqual(fields(sameKey), ["roles.guardian"]);

    const noTimelock = evaluate({
      manifest: baseManifest({ roles: { guardian: "0x2222222222222222222222222222222222222222" } }),
      environment: "PRODUCTION",
      runtime: SAFE_RUNTIME,
    });
    assert.deepEqual(fields(noTimelock), ["roles.timelock"]);
  });

  test("lets PROVING proceed without a timelock, because one cannot exist yet", () => {
    /*
     * The staged flow, and the reason it has to be staged: `script/handoff.js` deploys the timelock
     * and refuses to run until a 72-hour clean proving run has happened against a live deployment.
     * The proving run needs the deployment. So a timelock cannot possibly exist at deploy time, and
     * a gate demanding one for every non-LOCAL environment would make real deployment impossible.
     */
    const canary = baseManifest({ environment: "PROVING", roles: { guardian: "0x2222222222222222222222222222222222222222" } });
    const violations = evaluate({ manifest: canary, environment: "PROVING", runtime: SAFE_RUNTIME });
    assert.deepEqual(fields(violations), [], "PROVING must not require a timelock");
  });

  test("still refuses everything else under PROVING, so the relaxation is exactly one field", () => {
    // The concern with scoping a check to one environment is that it quietly scopes its neighbours
    // too. A mock USDC must be just as refused under PROVING as under PRODUCTION.
    const mocked = baseManifest({
      environment: "PROVING",
      roles: { guardian: "0x2222222222222222222222222222222222222222" },
      external: {
        isMockExternal: true,
        canonicalUSDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        dexRouter: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      },
    });
    const violations = evaluate({ manifest: mocked, environment: "PROVING", runtime: SAFE_RUNTIME });
    assert.ok(fields(violations).includes("external.isMockExternal"));

    const sameKey = evaluate({
      manifest: baseManifest({
        environment: "PROVING",
        deployer: "0x2222222222222222222222222222222222222222",
        roles: { guardian: "0x2222222222222222222222222222222222222222" },
      }),
      environment: "PROVING",
      runtime: SAFE_RUNTIME,
    });
    assert.ok(fields(sameKey).includes("roles.guardian"));
  });

  test("still refuses a PRODUCTION manifest with no timelock", () => {
    // The same manifest that passes as PROVING must fail as PRODUCTION. If this ever passes, the
    // scoping above has become a hole rather than a stage.
    const violations = evaluate({
      manifest: baseManifest({ roles: { guardian: "0x2222222222222222222222222222222222222222" } }),
      environment: "PRODUCTION",
      runtime: SAFE_RUNTIME,
    });
    assert.deepEqual(fields(violations), ["roles.timelock"]);
  });

  test("refuses a rehearsal DEX address left in a Base mainnet manifest", () => {
    /*
     * Base Sepolia has no official Uniswap V2, so a testnet rehearsal must deploy its own and point
     * DEX_ROUTER_ADDRESS at it. Forgetting to put the canonical address back is the easy mistake,
     * and nothing else would catch it: the value is a well-formed address, the deployment succeeds,
     * and the protocol lists into a venue nobody can find — irreversibly.
     */
    const stale = evaluate({
      manifest: baseManifest({
        external: {
          isMockExternal: false,
          canonicalUSDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          dexRouter: "0x1234567890123456789012345678901234567890",
        },
      }),
      environment: "PRODUCTION",
      runtime: SAFE_RUNTIME,
    });
    assert.ok(fields(stale).includes("external.dexRouter"));

    // A wrong USDC is caught the same way, and it is the single address most worth getting right.
    const wrongUsdc = evaluate({
      manifest: baseManifest({
        external: {
          isMockExternal: false,
          canonicalUSDC: "0x1234567890123456789012345678901234567890",
          dexRouter: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
        },
      }),
      environment: "PRODUCTION",
      runtime: SAFE_RUNTIME,
    });
    assert.ok(fields(wrongUsdc).includes("external.canonicalUSDC"));

    // And the canonical pair still passes, so this is a check rather than a blanket refusal.
    const good = evaluate({
      manifest: baseManifest({
        external: {
          isMockExternal: false,
          canonicalUSDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          dexRouter: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
        },
      }),
      environment: "PRODUCTION",
      runtime: SAFE_RUNTIME,
    });
    assert.deepEqual(fields(good), []);
  });

  test("has no flag, environment variable or code path that downgrades a failure to a warning", () => {
    const source = readFileSync(path.join(REPO_ROOT, "infra", "scripts", "deploy-gate.mjs"), "utf8");
    for (const escape of ["--force", "FORCE", "SKIP_GATE", "warnOnly", "--warn", "ALLOW_MOCK"]) {
      assert.ok(!source.includes(escape), `the gate must not honour ${escape}`);
    }
    // A failing evaluation must exit non-zero; there is exactly one success exit.
    assert.ok(source.includes("process.exit(1)"));
    assert.equal(source.split("process.exit(0)").length - 1, 1);
  });
});
