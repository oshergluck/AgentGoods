#!/usr/bin/env node
/**
 * Writes procedural artwork to `public/media`.
 *
 * Two modes:
 *
 *   node scripts/generate-media.mjs                 # the demo catalogue, by name
 *   node scripts/generate-media.mjs --from-api      # every store and product the API knows about
 *
 * `--from-api` is the one that matters in operation: it walks the live catalogue and generates a
 * cover for anything that does not have one yet, so a listing created five minutes ago has its own
 * artwork rather than a placeholder. It is idempotent — a seed always produces the same image — so
 * it is safe to run on a schedule or after every deployment. `--force` regenerates regardless.
 *
 * The generator itself lives in `media-engine.mjs` and is shared with the UI, so a store that
 * appears between runs still gets the same artwork rendered client-side. Nothing here fetches an
 * image from anywhere: every byte is computed from the id. See docs/DECISIONS.md D-017.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coverSvg, logoSvg } from "./media-engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "media");
const API = process.env.ESH_API_URL ?? "http://127.0.0.1:4000";

const args = new Set(process.argv.slice(2));
const fromApi = args.has("--from-api");
const force = args.has("--force");

mkdirSync(outDir, { recursive: true });

function write(name, svg) {
  const file = join(outDir, name);
  if (!force && existsSync(file)) return false;
  writeFileSync(file, svg, "utf8");
  return true;
}

/* ------------------------------------------------------- the demo catalogue */

const DEMO_LOGOS = [
  ["atlas", "ATLS"],
  ["vector", "VCTR"],
  ["prism", "PRSM"],
];

const DEMO_COVERS = [
  ["atlas-store", "Atlas Corpus Works storefront"],
  ["vector-store", "Vector Inference Credits storefront"],
  ["prism-store", "Prism Streaming Access storefront"],
  ["curated-embedding-corpus", "Curated embedding corpus"],
  ["legal-clause-taxonomy", "Legal clause taxonomy"],
  ["raw-scrape-dump", "Raw scrape dump"],
  ["inference-credits", "Inference credits"],
  ["eval-harness", "Evaluation harness suite"],
  ["market-feed", "Realtime market feed"],
];

function generateDemo() {
  let written = 0;
  for (const [name, initials] of DEMO_LOGOS) {
    if (write(`${name}-logo.svg`, logoSvg(`${name}-logo`, initials))) written += 1;
  }
  for (const [name, caption] of DEMO_COVERS) {
    if (write(`${name}-cover.svg`, coverSvg(`${name}-cover`, caption))) written += 1;
  }
  return written;
}

/* ------------------------------------------------------------ the live API */

async function json(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
}

/**
 * Generates artwork for everything the API currently lists.
 *
 * Seeded by the on-chain id, never by a seller-supplied name: a name can be copied, an id cannot,
 * so two stores calling themselves the same thing still look completely different.
 */
async function generateFromApi() {
  let written = 0;

  const stores = await json("/api/v1/stores?limit=100");
  for (const store of stores.items ?? []) {
    const id = store.protocol.storeId;
    const name = store.sellerContent?.profile?.name || store.sellerContent?.name || "";
    const symbol = store.token?.symbol || "";
    if (write(`auto-store-${id.slice(2, 14)}-cover.svg`, coverSvg(id, name))) written += 1;
    if (write(`auto-store-${id.slice(2, 14)}-logo.svg`, logoSvg(id, symbol))) written += 1;
  }

  const products = await json("/api/v1/market/products?limit=100&availability=any");
  for (const product of products.items ?? []) {
    const id = product.protocol.productId;
    const name = product.sellerContent?.profile?.name || "";
    if (write(`auto-product-${id.slice(2, 14)}-cover.svg`, coverSvg(id, name))) written += 1;
  }

  const tokens = await json("/api/v1/market/tokens?limit=100");
  for (const token of tokens.items ?? []) {
    const address = token.eshToken;
    if (write(`auto-token-${address.slice(2, 14)}-logo.svg`, logoSvg(address, token.token?.symbol ?? ""))) {
      written += 1;
    }
  }

  return written;
}

/* ------------------------------------------------------------------- main */

const written = fromApi ? await generateFromApi() : generateDemo();
const total = readdirSync(outDir).filter((f) => f.endsWith(".svg")).length;

// eslint-disable-next-line no-console
console.log(
  `media: wrote ${written} new file(s), ${total} total in ${outDir}` +
    (force ? " (forced regeneration)" : written === 0 ? " (nothing new)" : "")
);
