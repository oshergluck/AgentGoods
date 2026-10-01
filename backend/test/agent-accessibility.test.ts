/**
 * Public protocol discovery must stay reachable by a plain HTTP client.
 *
 * This is a regression suite for a real production incident. An external Agent could not fetch
 * the root, the manifest, the schema or the OpenAPI document, while a browser on the same domain
 * worked. Every infrastructure layer was innocent — DNS resolved, there was no broken AAAA, TLS
 * verified with a complete chain, Cloudflare was DNS-only with no proxy or challenge in the
 * path, and Railway routed correctly to a single same-origin service.
 *
 * The fault was here, in the application:
 *
 *   `TRUST_PROXY_HOPS` defaulted to 0, so Express ignored `X-Forwarded-For` and `req.ip` was the
 *   platform edge's address — the same value for every client on earth. The global rate limiter
 *   keys on `req.ip`, so the entire internet shared one 600-per-minute counter. A page load is a
 *   dozen requests and an open price chart is one per second, so ordinary human traffic could
 *   exhaust it; once exhausted, every path returned 429, discovery included.
 *
 * The tests below are written against the property that matters, not the specific bug: an Agent
 * that knows only the origin must be able to complete discovery, and unrelated traffic must not
 * be able to take that ability away.
 */

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, startChain, deployProtocol, stopChain, type Harness } from "./helpers/harness";

let h: Harness;
let uiDir: string;
let previousDist: string | undefined;

/** Everything an Agent can need before it holds any credential at all. */
const DISCOVERY = [
  "/.well-known/aic-agent.json",
  "/api/v1/schema",
  "/api/v1/openapi.json",
  "/api/v1/contracts",
];

/*
 * robots.txt earns its own assertions.
 *
 * RFC 9309 allows a crawler that gets an unsuccessful status here to assume COMPLETE DISALLOW,
 * and the major crawlers cache that for up to 24 hours. One 429 on this path removes the entire
 * site from a crawler for a day — which is what kept ChatGPT reporting the site as blocked after
 * the rate-limit incident had already been fixed.
 */
const CRAWL_CONTROL = ["/robots.txt", "/sitemap.xml"];

before(async () => {
  /*
   * A real static root. Without FRONTEND_DIST the app serves no UI, so `/robots.txt` does not
   * exist and the assertions below would pass or fail for the wrong reason — the same blind spot
   * that let the original bug through the suite.
   */
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-access-"));
  fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>x</title>");
  fs.writeFileSync(path.join(uiDir, "robots.txt"), "User-agent: *\nAllow: /\n");
  previousDist = process.env.FRONTEND_DIST;
  process.env.FRONTEND_DIST = uiDir;

  await startChain();
  await deployProtocol();
  h = await createHarness();
});

after(async () => {
  await h?.stop();
  await stopChain();
  if (previousDist === undefined) delete process.env.FRONTEND_DIST;
  else process.env.FRONTEND_DIST = previousDist;
  fs.rmSync(uiDir, { recursive: true, force: true });
});

describe("Discovery is reachable without credentials", { concurrency: 1 }, () => {
  for (const path of DISCOVERY) {
    test(`${path} answers 200 with JSON`, async () => {
      const res = await h.request("GET", path);
      assert.equal(res.status, 200, `${path} must not require credentials`);

      // A machine client parses this. HTML here means the SPA fallback swallowed a protocol
      // path, which is the other way this becomes unusable.
      assert.equal(typeof res.body, "object", `${path} must return parsed JSON, not a document`);
      assert.ok(res.body !== null);
    });
  }

  for (const path of CRAWL_CONTROL) {
    test(`${path} is on the budget that cannot be starved`, async () => {
      const res = await h.request("GET", path);
      assert.equal(res.status, 200, `${path} must never fail`);

      // The decisive check: it must NOT share the general budget, because that is the budget
      // ordinary traffic exhausts.
      const limit = /limit=(\d+)/.exec(String(res.headers?.["ratelimit"] ?? ""))?.[1];
      const general = /limit=(\d+)/.exec(
        String((await h.request("GET", "/api/v1/stores?limit=1")).headers?.["ratelimit"] ?? "")
      )?.[1];
      assert.ok(limit, `${path} must advertise a limit`);
      assert.notEqual(
        limit,
        general,
        `${path} shares the general budget — a 429 here disallows the whole site for a day`
      );
    });
  }

  test("no discovery response is an HTML challenge or a login page", async () => {
    for (const path of DISCOVERY) {
      const res = await h.request("GET", path);
      const body = JSON.stringify(res.body);
      assert.doesNotMatch(body, /<!doctype html/i, `${path} returned a document`);
      assert.doesNotMatch(body, /captcha|challenge-platform|cf-browser-verification/i);
    }
  });
});

describe("Unrelated traffic cannot make the protocol undiscoverable", { concurrency: 1 }, () => {
  test("discovery is not counted against the general request budget", async () => {
    /*
     * The heart of the incident. Discovery and ordinary reads are now separate budgets, so
     * exhausting one cannot close the other. Asserted through the advertised RateLimit headers
     * rather than by draining a limiter, which would make the suite slow and order-dependent.
     */
    const discovery = await h.request("GET", "/.well-known/aic-agent.json");
    const ordinary = await h.request("GET", "/api/v1/stores?limit=1");

    const discoveryLimit = discovery.headers?.["ratelimit"] ?? "";
    const ordinaryLimit = ordinary.headers?.["ratelimit"] ?? "";

    assert.ok(discoveryLimit, "discovery must still advertise a limit — it is rate limited, not exempt");
    assert.ok(ordinaryLimit, "ordinary reads must advertise a limit");
    assert.notEqual(
      discoveryLimit,
      ordinaryLimit,
      "discovery and ordinary reads share a counter again — one can starve the other"
    );
  });

  test("discovery is still rate limited, not made unlimited", async () => {
    // The fix must not be "turn the limit off". An unbounded public endpoint is a different
    // production incident, not a solution to this one.
    const res = await h.request("GET", "/api/v1/schema");
    const header = String(res.headers?.["ratelimit"] ?? "");
    assert.match(header, /limit=\d+/, "discovery must advertise a finite limit");

    const limit = Number(/limit=(\d+)/.exec(header)?.[1]);
    assert.ok(limit > 0 && Number.isFinite(limit), `expected a finite positive limit, got ${header}`);
  });
});

describe("Authenticated endpoints stay authenticated", { concurrency: 1 }, () => {
  test("/api/v1/me without credentials is a documented 401, not an infrastructure failure", async () => {
    const res = await h.request("GET", "/api/v1/me");
    assert.equal(res.status, 401, "reachable but unauthorised is the correct answer");

    const body = res.body as { error?: { code?: string; message?: string; documentation?: string } };
    assert.equal(body.error?.code, "INVALID_API_KEY");
    assert.ok(body.error?.message, "an Agent must be told what is missing");
    assert.ok(body.error?.documentation, "and where the rule is written down");
  });

  test("private Agent state is never cacheable by a shared cache", async () => {
    const res = await h.request("GET", "/api/v1/me");
    const cache = String(res.headers?.["cache-control"] ?? "");
    assert.match(cache, /no-store/, "per-wallet state must never be stored by an intermediary");
    assert.match(cache, /private/, "and must never be served from a shared cache");
  });

  test("fixing discovery did not open a private endpoint to any origin", async () => {
    // The wrong fix for a reachability problem is a wildcard CORS header. Pinned so it cannot
    // be introduced as a quick remedy later.
    const res = await h.request("GET", "/api/v1/me", { headers: { origin: "https://evil.example" } });
    assert.notEqual(res.headers?.["access-control-allow-origin"], "*");
  });
});
