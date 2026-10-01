/**
 * Discovery documents must be readable by machines AND by HTML-only fetchers.
 *
 * An external Agent could reach `/` but not `/.well-known/aic-agent.json`, `/api/v1/schema` or
 * `/api/v1/openapi.json`. The split was exactly `text/html` reachable / `application/json` not —
 * some assistant browsing tools fetch through a browser-shaped pipeline and cannot render a raw
 * JSON response, so the request succeeds and the tool reports the resource as unavailable.
 *
 * For this product that is fatal rather than cosmetic: the root page tells an Agent to start at
 * the manifest, so the bootstrap chain breaks at step two.
 *
 * The fix is content negotiation, and **the entire risk of it is in one word: strictly.** JSON
 * stays canonical for every client that can take it, and HTML is served only to a client whose
 * stated preference for HTML is strictly stronger than for JSON. Any drift that lets a `*​/*`
 * client receive HTML converts a fix for one broken client into an outage for every correct one —
 * so the negotiation table is asserted directly, not just end to end.
 */

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHarness, startChain, deployProtocol, stopChain, type Harness } from "./helpers/harness";
import { prefersHtml } from "../src/http/contentNegotiation";

let h: Harness;

const DISCOVERY = [
  "/.well-known/aic-agent.json",
  "/api/v1/schema",
  "/api/v1/openapi.json",
  "/api/v1/contracts",
];

before(async () => {
  await startChain();
  await deployProtocol();
  h = await createHarness();
});

after(async () => {
  await h?.stop();
  await stopChain();
});

describe("The negotiation table", { concurrency: 1 }, () => {
  const cases: [string, string | undefined, boolean][] = [
    ["no Accept header at all", undefined, false],
    ["empty Accept header", "", false],
    ["*/* — curl, and most Agent HTTP clients", "*/*", false],
    ["application/json — a conforming Agent", "application/json", false],
    ["application/json with a wildcard fallback", "application/json, */*;q=0.1", false],
    ["text/html and JSON at equal weight — ties go to JSON", "text/html,application/json", false],
    ["JSON weighted above HTML", "text/html;q=0.5,application/json;q=0.9", false],
    ["a browser's Accept header", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", true],
    ["bare text/html", "text/html", true],
    ["HTML weighted above JSON", "text/html;q=0.9,application/json;q=0.4", true],
    ["text/* wildcard above JSON", "text/*;q=0.9,application/json;q=0.2", true],
  ];

  for (const [label, header, expected] of cases) {
    test(`${label} -> ${expected ? "HTML" : "JSON"}`, () => {
      assert.equal(prefersHtml(header), expected, `Accept: ${header ?? "(absent)"}`);
    });
  }

  test("a malformed q value does not silently drop the type", () => {
    // Treating an unparseable q as 0 would remove JSON from consideration and flip the result.
    assert.equal(prefersHtml("application/json;q=banana, text/html;q=0.5"), false);
  });
});

describe("Machines still get JSON", { concurrency: 1 }, () => {
  for (const path of DISCOVERY) {
    test(`${path} returns JSON to a default client`, async () => {
      const res = await h.request("GET", path);
      assert.equal(res.status, 200);
      assert.match(
        String(res.headers?.["content-type"] ?? ""),
        /application\/json/,
        `${path} must stay JSON for machines`
      );
      assert.equal(typeof res.body, "object");
    });

    test(`${path} returns JSON when Accept is */*`, async () => {
      const res = await h.request("GET", path, { headers: { accept: "*/*" } });
      assert.match(String(res.headers?.["content-type"] ?? ""), /application\/json/);
    });

    test(`${path} returns JSON when Accept is application/json`, async () => {
      const res = await h.request("GET", path, { headers: { accept: "application/json" } });
      assert.match(String(res.headers?.["content-type"] ?? ""), /application\/json/);
    });
  }
});

describe("HTML-only clients can read the same documents", { concurrency: 1 }, () => {
  const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

  for (const path of DISCOVERY) {
    test(`${path} renders as HTML for a browser-shaped client`, async () => {
      const res = await h.request("GET", path, { headers: { accept: BROWSER } });
      assert.equal(res.status, 200);
      assert.match(String(res.headers?.["content-type"] ?? ""), /text\/html/);

      const html = String((res.body as { raw?: string }).raw ?? res.body);
      assert.match(html, /^<!doctype html>/i);

      // The HTML must not be a stub — it carries the document itself.
      assert.match(html, /<pre>/, "the document must be present, not merely linked");
      assert.ok(html.length > 400, `HTML representation was only ${html.length} bytes`);
    });

    test(`${path} tells a machine where the canonical JSON is`, async () => {
      const res = await h.request("GET", path, { headers: { accept: BROWSER } });
      const html = String((res.body as { raw?: string }).raw ?? res.body);

      // A client that lands on the HTML must still be able to find the real representation.
      assert.match(html, /<link rel="alternate" type="application\/json" href="[^"]+"/);
      assert.match(html, /Accept: application\/json/, "and be told how to request it");
    });
  }

  test("the rendered JSON parses back to the same document", async () => {
    const json = await h.request("GET", "/.well-known/aic-agent.json");
    const html = await h.request("GET", "/.well-known/aic-agent.json", { headers: { accept: BROWSER } });

    const page = String((html.body as { raw?: string }).raw ?? html.body);
    const block = /<pre>([\s\S]*)<\/pre>/.exec(page)?.[1] ?? "";
    const unescaped = block
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");

    /*
     * Volatile fields are stripped before comparing. These are two separate requests, so a
     * generation timestamp and the indexer freshness block legitimately differ between them —
     * comparing them raw would make this test fail on a clock tick rather than on a real
     * divergence, which is the classic way a useful assertion gets deleted for being flaky.
     */
    const VOLATILE = new Set(["generatedAt", "freshness", "asOf", "observedAt", "nowSec"]);
    const stable = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stable);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([key]) => !VOLATILE.has(key))
            .map(([key, v]) => [key, stable(v)])
        );
      }
      return value;
    };

    // The whole promise of the HTML view: it is the same document, not a summary of it.
    assert.deepEqual(stable(JSON.parse(unescaped)), stable(json.body));
  });
});

describe("Caching cannot cross the representations", { concurrency: 1 }, () => {
  for (const path of DISCOVERY) {
    test(`${path} sets Vary: Accept`, async () => {
      // Without this a shared cache can hand HTML to a client that asked for JSON, breaking
      // conforming Agents intermittently and in a way that is very hard to reproduce.
      const res = await h.request("GET", path);
      assert.match(String(res.headers?.["vary"] ?? ""), /Accept/i, `${path} must vary on Accept`);
    });
  }
});
