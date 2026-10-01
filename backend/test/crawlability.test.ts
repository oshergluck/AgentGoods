/**
 * Can an automated client actually reach this site?
 *
 * This suite exists because of a live failure. The SPA fallback was registered with `app.get`
 * and then re-checked `req.method !== "GET"` inside the handler. Express dispatches HEAD to a
 * GET handler, so every HEAD request fell through that guard into the 404 handler: `GET /`
 * returned 200 and `HEAD /` returned 404, on the same URL, at the same moment.
 *
 * That is not a cosmetic inconsistency. Crawlers, link unfurlers and agent browsers preflight
 * with HEAD to check reachability and content type before spending a GET. They read the 404 and
 * report the site as blocked or unreachable — which is what happened, on a marketplace whose
 * entire stated audience is automated clients.
 *
 * The second half covers the sitemap, which `robots.txt` advertises. It did not exist, and
 * because the fallback answers every unknown path with the app shell, requesting it returned
 * 200 with `text/html`. A crawler following that line got an HTML document where XML was
 * declared. A broken sitemap is worse than no sitemap: one is a fault, the other an absence.
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

const SHELL = `<!doctype html><html lang="en"><head><title>AgentGoods.AI</title></head><body><div id="root"></div></body></html>`;

before(async () => {
  /*
   * A real static root, so the test exercises the shipped wiring rather than a stub. Without
   * FRONTEND_DIST the app serves no UI at all and the fallback under test is never registered —
   * which is exactly how this bug survived the existing suite.
   */
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-ui-"));
  fs.writeFileSync(path.join(uiDir, "index.html"), SHELL);
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

describe("HEAD is answered wherever GET is", { concurrency: 1 }, () => {
  /*
   * Every one of these is a path a crawler actually preflights: the home page, a deep link it
   * was given, a real static file, and the machine-readable entrypoint the whole protocol hangs
   * off.
   */
  const paths = ["/", "/market", "/stores", "/docs", "/robots.txt", "/.well-known/aic-agent.json"];

  for (const urlPath of paths) {
    test(`HEAD ${urlPath} matches the status of GET ${urlPath}`, async () => {
      const get = await h.request("GET", urlPath);
      const head = await h.request("HEAD", urlPath);
      assert.equal(
        head.status,
        get.status,
        `HEAD ${urlPath} returned ${head.status} while GET returned ${get.status} — ` +
          `a crawler preflighting this path would treat the site as unreachable`
      );
      assert.ok(head.status < 400, `${urlPath} must be reachable`);
    });
  }

  test("a client-routed deep link returns the app shell, not a 404", async () => {
    // The route only exists in the browser. The server must still hand back the shell, or a
    // shared link to a store page is dead for anything that is not already running the app.
    const res = await h.request("GET", "/stores/0x" + "11".repeat(32));
    assert.equal(res.status, 200);
  });

  test("a write method still falls through rather than being answered with HTML", async () => {
    // The guard the bug lived in had a real purpose: POST must not receive the app shell.
    const res = await h.request("POST", "/market");
    assert.ok(res.status === 404 || res.status === 405, `expected a rejection, got ${res.status}`);
  });
});

describe("The advertised sitemap is a real sitemap", { concurrency: 1 }, () => {
  test("it is served as XML, not as the app shell", async () => {
    const res = await h.request("GET", "/sitemap.xml");
    assert.equal(res.status, 200);

    // The harness parses JSON and wraps anything else as `{ raw }`.
    const body = String((res.body as { raw?: string }).raw ?? res.body);
    assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, "must declare an XML prolog");
    assert.match(body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.doesNotMatch(body, /<!doctype html>/i, "serving the app shell here is the bug");
  });

  test("it lists the canonical routes against the configured origin", async () => {
    const res = await h.request("GET", "/sitemap.xml");
    const body = String((res.body as { raw?: string }).raw ?? res.body);

    /*
     * Against the WEB origin, not the API base. A sitemap lists pages a browser opens. They
     * are the same host in production because the deployment is same-origin, and the test
     * pins the distinction so a future split cannot quietly point crawlers at the API.
     */
    const webOrigin = "http://localhost:5173";
    for (const route of ["/", "/market", "/stores", "/docs"]) {
      assert.ok(body.includes(`<loc>${webOrigin}${route}</loc>`), `sitemap is missing ${route}`);
    }
    // A sitemap pointing at the wrong host sends every crawler to a domain that is not ours.
    assert.doesNotMatch(body, /up\.railway\.app/, "must never advertise the platform hostname");
  });

  test("robots.txt points at a URL that resolves", async () => {
    // The two have to agree. An advertised sitemap that 404s is a self-inflicted crawl error.
    const robots = await h.request("GET", "/robots.txt");
    assert.equal(robots.status, 200);

    const sitemap = await h.request("HEAD", "/sitemap.xml");
    assert.ok(sitemap.status < 400, "the advertised sitemap must be fetchable, including by HEAD");
  });
});
