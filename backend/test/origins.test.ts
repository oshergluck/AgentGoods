/**
 * Canonical URL configuration, and the production manifest it advertises.
 *
 * The failure this guards against is quiet and total: a PRODUCTION deployment that starts happily
 * while publishing a machine-readable document telling every Agent to call `http://localhost:4000`.
 * Nothing errors. The service is healthy. Every Agent that follows the manifest fails, and the
 * operator's own browser works fine because it is the one machine where that URL resolves.
 *
 * So the tests below are mostly about REFUSAL, and they check the refusal is specific — an error
 * that names the field and says why beats one that says "invalid configuration".
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { canonicalOrigins } from "../src/config/origins";
import type { Env } from "../src/config/env";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function env(overrides: Partial<Env>): Env {
  return {
    ESH_ENVIRONMENT: "PRODUCTION",
    PUBLIC_BASE_URL: "https://agentgoods.ai",
    PUBLIC_WEB_URL: "https://agentgoods.ai",
    CORS_ORIGINS: "",
    ...overrides,
  } as Env;
}

describe("Canonical origin configuration", { concurrency: 1 }, () => {
  test("accepts a real production domain and reports it as same-origin", () => {
    const o = canonicalOrigins(env({}));
    assert.equal(o.publicOrigin, "https://agentgoods.ai");
    assert.equal(o.apiBaseUrl, "https://agentgoods.ai");
    assert.equal(o.sameOrigin, true, "one hostname is the point");
    assert.ok(o.allowedOrigins.includes("https://agentgoods.ai"));
  });

  test("REFUSES localhost in PRODUCTION, naming the field", () => {
    for (const bad of ["http://localhost:4000", "https://127.0.0.1", "http://0.0.0.0:8080"]) {
      assert.throws(
        () => canonicalOrigins(env({ PUBLIC_BASE_URL: bad })),
        (e: Error) => /PUBLIC_BASE_URL/.test(e.message) && /reach/i.test(e.message),
        `must refuse ${bad}`
      );
    }
  });

  test("REFUSES plain http in PRODUCTION", () => {
    assert.throws(
      () => canonicalOrigins(env({ PUBLIC_BASE_URL: "http://agentgoods.ai" })),
      /must be https/i
    );
  });

  test("REFUSES a platform-assigned hostname as a canonical identity", () => {
    /*
     * These work, which is exactly why they are dangerous: a deployment would pass every smoke
     * test while advertising a hostname that changes when the service is recreated.
     */
    assert.throws(
      () => canonicalOrigins(env({ PUBLIC_BASE_URL: "https://backend<service>.up.railway.app" })),
      /platform-assigned|canonical identity/i
    );
  });

  test("REFUSES an origin carrying a path, which would corrupt every URL built from it", () => {
    assert.throws(
      () => canonicalOrigins(env({ PUBLIC_BASE_URL: "https://agentgoods.ai/api" })),
      /bare origin/i
    );
    assert.throws(() => canonicalOrigins(env({ PUBLIC_BASE_URL: "not-a-url" })), /valid absolute URL/i);
  });

  test("allows localhost OUTSIDE production, because that is what local development is", () => {
    const o = canonicalOrigins(env({ ESH_ENVIRONMENT: "LOCAL", PUBLIC_BASE_URL: "http://localhost:4000" }));
    assert.equal(o.publicOrigin, "http://localhost:4000");
  });

  test("never produces a wildcard CORS origin", () => {
    const o = canonicalOrigins(env({ CORS_ORIGINS: "https://example.com" }));
    assert.ok(!o.allowedOrigins.includes("*"), "an authenticated API must never allow any origin");
    assert.ok(o.allowedOrigins.includes("https://example.com"));
    assert.ok(o.allowedOrigins.includes("https://agentgoods.ai"), "own origin is always allowed");
  });

  test("reports sameOrigin false when the UI is on a different host", () => {
    const o = canonicalOrigins(
      env({ PUBLIC_BASE_URL: "https://api.agentgoods.ai", PUBLIC_WEB_URL: "https://agentgoods.ai" })
    );
    assert.equal(o.sameOrigin, false);
    assert.ok(o.allowedOrigins.includes("https://agentgoods.ai"), "the UI origin must be allowed to call the API");
  });
});

describe("Deployment manifest sanity", { concurrency: 1 }, () => {
  test("a manifest claiming PRODUCTION must not be a mock or local deployment", () => {
    /*
     * Walks whatever manifests exist rather than asserting a specific chain: the point is that no
     * manifest can ever claim PRODUCTION while carrying mock infrastructure or chainId 31337.
     * The deployment gate enforces this at deploy time; this catches a file edited afterwards.
     */
    const dir = path.join(REPO_ROOT, "deployments");
    if (!existsSync(dir)) return;
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
    assert.ok(files.length > 0, "at least one deployment manifest should exist");

    for (const file of files) {
      const m = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
      if (m.environment !== "PRODUCTION") continue;

      assert.notEqual(m.chainId, 31337, `${file}: chainId 31337 is never production`);
      assert.equal(m.external?.isMockExternal, false, `${file}: mock infrastructure in PRODUCTION`);
      assert.ok(m.roles?.timelock, `${file}: PRODUCTION means authority was handed to a timelock`);
      for (const field of ["registry", "agentGoods"]) {
        assert.ok(m.contracts?.[field]?.proxy, `${file}: missing canonical ${field}`);
      }
      assert.ok(m.external?.canonicalUSDC, `${file}: missing canonical USDC`);
    }
  });

  test("no manifest advertises a localhost URL in a canonical field", () => {
    const dir = path.join(REPO_ROOT, "deployments");
    if (!existsSync(dir)) return;
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const raw = readFileSync(path.join(dir, file), "utf8");
      const m = JSON.parse(raw);
      if (m.environment === "LOCAL" || m.chainId === 31337) continue;
      assert.ok(
        !/localhost|127\.0\.0\.1/.test(raw),
        `${file} is a non-local manifest but contains a localhost reference`
      );
    }
  });
});
