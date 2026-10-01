#!/usr/bin/env node
/**
 * Push URLs to IndexNow.
 *
 * The site was unfindable — not unreachable. A domain registered yesterday is in no search index,
 * so anything that tries to *find* it rather than fetch a known URL comes back empty. That is a
 * separate failure from the reachability work in `EXTERNAL_AGENT_ACCESS_AUDIT.md`, and it has a
 * separate remedy: tell the indexes the site exists.
 *
 * IndexNow is the one part of that which needs no account. It is an open protocol supported by
 * Bing, Yandex, Seznam and Naver: host a key file at the domain root, then POST a URL list. Bing
 * matters most here, because assistant browsing tools lean on its index and its safety
 * classification, and a domain with no index presence has nothing to weigh against its newness.
 *
 * Google does NOT support IndexNow — it needs Search Console, which needs an account login.
 *
 *     node backend/scripts/indexnow-submit.mjs
 *     node backend/scripts/indexnow-submit.mjs --dry-run
 *
 * Re-runnable. Submitting an unchanged URL again is explicitly allowed by the protocol, though
 * spamming it is not, so this is a thing to run after meaningful content changes rather than on a
 * timer.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const HOST = "agentgoods.ai";
const ORIGIN = `https://${HOST}`;
const DRY = process.argv.includes("--dry-run");

/** The key lives beside the repo, and the file it names must be served at the domain root. */
const keyPath = path.join(ROOT, ".indexnow-key");
if (!fs.existsSync(keyPath)) {
  console.error(`No .indexnow-key at ${keyPath}. Generate one and place <key>.txt in frontend/public/.`);
  process.exit(1);
}
const key = fs.readFileSync(keyPath, "utf8").trim();
const keyLocation = `${ORIGIN}/${key}.txt`;

/*
 * Verify the key file is actually served BEFORE submitting.
 *
 * IndexNow rejects a submission whose key cannot be fetched, and it does so asynchronously — the
 * POST still returns 200. So a broken key produces a silent no-op that looks like success, which
 * is worth one request to rule out.
 */
async function verifyKey() {
  const res = await fetch(keyLocation, { headers: { "user-agent": "AgentGoods-IndexNow/1.0" } });
  if (!res.ok) throw new Error(`key file ${keyLocation} returned ${res.status}`);
  const body = (await res.text()).trim();
  if (body !== key) throw new Error(`key file content does not match the key (got ${body.slice(0, 16)}…)`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/plain/i.test(type)) console.warn(`  warning: key file served as "${type}", expected text/plain`);
  console.log(`  key verified at ${keyLocation}`);
}

/** The canonical routes, plus every indexed store and product, discovered from the live sitemap. */
async function collectUrls() {
  const res = await fetch(`${ORIGIN}/sitemap.xml`, { headers: { "user-agent": "AgentGoods-IndexNow/1.0" } });
  if (!res.ok) throw new Error(`sitemap returned ${res.status}`);
  const xml = await res.text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (urls.length === 0) throw new Error("sitemap contained no URLs");
  // The sitemap is already the canonical list, so it cannot drift from what is actually served.
  return urls;
}

const urls = await collectUrls();
console.log(`\nIndexNow submission for ${HOST}`);
console.log(`  ${urls.length} URLs from ${ORIGIN}/sitemap.xml`);

await verifyKey();

if (DRY) {
  for (const u of urls) console.log(`    ${u}`);
  console.log("\n  --dry-run: nothing submitted.\n");
  process.exit(0);
}

const payload = { host: HOST, key, keyLocation, urlList: urls };
const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(payload),
});

/*
 * 200 accepted, 202 accepted-pending-key-validation. 400 bad request, 403 key not valid,
 * 422 URL does not belong to the host, 429 too many requests.
 */
const text = await res.text();
console.log(`  POST api.indexnow.org/indexnow -> ${res.status} ${res.statusText} ${text.slice(0, 120)}`);

if (res.status === 200 || res.status === 202) {
  console.log(`\n  Submitted ${urls.length} URLs. Indexing is not instant; allow days.\n`);
  process.exit(0);
}
console.error(`\n  Submission rejected.\n`);
process.exit(1);
