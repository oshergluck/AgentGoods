/**
 * Link previews, and the untrusted text inside them.
 *
 * A WhatsApp or Telegram preview is the most exposed surface seller content has. On the site a
 * store's name is one element inside a page the reader chose to open. In a preview it is a
 * headline printed above the words "agentgoods.ai", rendered by a client nobody controls, to
 * someone who has not visited anything yet — it borrows the domain's credibility before any
 * judgement is possible.
 *
 * So the tests that matter here are not "does the title change". They are: can a seller break out
 * of the attribute, can a seller own the whole line, and can a seller write the sentence
 * underneath it. See `TRUST_BOUNDARIES.md` §3.
 */

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, startChain, deployProtocol, stopChain, type Harness } from "./helpers/harness";
import { Store, Product, StockMarket } from "../src/db/models";
import { applyMeta } from "../src/http/socialMeta";

let h: Harness;
let uiDir: string;
let previousDist: string | undefined;

const STORE_ID = "0x" + "ab".repeat(32);
const PRODUCT_ID = "0x" + "cd".repeat(32);

/** The real shell's tags, so the replacement is exercised against the shape actually shipped. */
const SHELL = `<!doctype html><html lang="en"><head>
<title>AgentGoods.AI — Autonomous Agent Marketplace</title>
<meta name="description" content="generic site description" />
<link rel="canonical" href="https://agentgoods.ai/" />
<meta property="og:title" content="AgentGoods.AI — Autonomous Agent Marketplace" />
<meta property="og:description" content="generic og description" />
<meta property="og:url" content="https://agentgoods.ai/" />
<meta property="og:image" content="https://agentgoods.ai/og.png" />
<meta name="twitter:title" content="AgentGoods.AI" />
<meta name="twitter:description" content="generic twitter description" />
</head><body><div id="root"></div></body></html>`;

before(async () => {
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-og-"));
  fs.writeFileSync(path.join(uiDir, "index.html"), SHELL);
  previousDist = process.env.FRONTEND_DIST;
  process.env.FRONTEND_DIST = uiDir;

  await startChain();
  await deployProtocol();
  h = await createHarness();

  await Store.create({
    chainId: h.env.CHAIN_ID,
    storeId: STORE_ID,
    address: "0x" + "11".repeat(20),
    storeType: "sales",
    storeCreator: "0x" + "22".repeat(20),
    storeController: "0x" + "22".repeat(20),
    aicToken: "0x" + "33".repeat(20),
    licenseToken: "0x" + "44".repeat(20),
    governance: "0x" + "55".repeat(20),
    dividendDistributor: "0x" + "66".repeat(20),
    factory: "0x" + "77".repeat(20),
    factoryVersion: 1,
    createdBlock: 1,
    createdLogIndex: 0,
    createdTxHash: "0x" + "88".repeat(32),
    createdAt: 1,
    cursor: "1:0",
    sellerContent: { profile: { name: "Gamma Labs", description: "seller blurb" } },
  });

  await StockMarket.create({
    chainId: h.env.CHAIN_ID,
    aicToken: "0x" + "33".repeat(20),
    storeId: STORE_ID,
    storeAddress: "0x" + "11".repeat(20),
    name: "Gamma",
    symbol: "GAMMA",
    decimals: 18,
    genesisSupplyAIC: "1000",
    currentSupplyAIC: "1000",
    marketInventoryAIC: "1000",
    virtualUSDCReserve: "6000000000",
    virtualTokenReserve: "1000",
    currentIndexedPrice1e18: "1",
    createdBlock: 1,
    createdLogIndex: 0,
    cursor: "1:0",
  });

  await Product.create({
    chainId: h.env.CHAIN_ID,
    storeId: STORE_ID,
    storeAddress: "0x" + "11".repeat(20),
    storeType: "sales",
    productId: PRODUCT_ID,
    version: 1,
    priceUSDC: "40000000",
    priceUSDCSort: "40000000",
    inventory: "5",
    active: true,
    createdBlock: 1,
    createdLogIndex: 0,
    createdTxHash: "0x" + "99".repeat(32),
    createdAt: 1,
    updatedBlock: 1,
    cursor: "1:0",
    sellerContent: { profile: { name: "Widget Pro" } },
  });
});

after(async () => {
  await h?.stop();
  await stopChain();
  if (previousDist === undefined) delete process.env.FRONTEND_DIST;
  else process.env.FRONTEND_DIST = previousDist;
  fs.rmSync(uiDir, { recursive: true, force: true });
});

describe("A shared link previews the thing it points at", { concurrency: 1 }, () => {
  test("a store link carries the store's own title and a protocol description", async () => {
    const res = await h.request("GET", `/stores/${STORE_ID}`);
    assert.equal(res.status, 200);
    const html = String((res.body as { raw?: string }).raw ?? res.body);

    assert.match(html, /<meta property="og:title" content="Gamma Labs — a store on AgentGoods\.AI"/);
    assert.match(html, /<title>Gamma Labs — a store on AgentGoods\.AI<\/title>/);
    assert.match(html, /og:description" content="Sales store · GAMMA · 1 product/);
    assert.match(html, new RegExp(`og:url" content="[^"]*/stores/${STORE_ID}"`));
  });

  test("a product link carries its price, which is the fact a recipient wants", async () => {
    const res = await h.request("GET", `/products/${PRODUCT_ID}`);
    const html = String((res.body as { raw?: string }).raw ?? res.body);

    assert.match(html, /og:title" content="Widget Pro — AgentGoods\.AI"/);
    assert.match(html, /Buy for 40\.00 USDC from Gamma Labs/);
  });

  test("the image stays the branded card and is never seller media", async () => {
    // Seller media is untrusted, frequently SVG (which no chat client renders anyway), and would
    // put an arbitrary picture under our domain in someone's inbox.
    const res = await h.request("GET", `/stores/${STORE_ID}`);
    const html = String((res.body as { raw?: string }).raw ?? res.body);
    assert.match(html, /og:image" content="https:\/\/agentgoods\.ai\/og\.png"/);
  });

  test("an unknown id serves the generic card rather than failing", async () => {
    const res = await h.request("GET", "/stores/0x" + "ff".repeat(32));
    assert.equal(res.status, 200, "a missing store must still render the app");
    const html = String((res.body as { raw?: string }).raw ?? res.body);
    assert.match(html, /og:title" content="AgentGoods\.AI — Autonomous Agent Marketplace"/);
  });

  test("ordinary routes are untouched", async () => {
    const res = await h.request("GET", "/market");
    const html = String((res.body as { raw?: string }).raw ?? res.body);
    assert.match(html, /og:description" content="generic og description"/);
  });
});

describe("Seller text cannot escape the preview", { concurrency: 1 }, () => {
  const hostile = [
    ['quote break-out', 'Evil" /><script>alert(1)</script><meta x="'],
    ['angle brackets', "<img src=x onerror=alert(1)>"],
    ['newline injection', 'Evil"\n<meta property="og:title" content="Spoofed'],
    ['bidi override', "Evil‮gnihsihp‬"],
    ['control characters', "Evil\u0000\u0007\u001bTitle"],
  ] as const;

  for (const [label, name] of hostile) {
    test(`${label} is neutralised`, async () => {
      await Store.updateOne({ storeId: STORE_ID }, { $set: { "sellerContent.profile.name": name } });

      const res = await h.request("GET", `/stores/${STORE_ID}`);
      const html = String((res.body as { raw?: string }).raw ?? res.body);

      /*
       * Asserted on the parsed structure, not on substrings.
       *
       * Escaped seller text legitimately CONTAINS the characters of an attack — `&lt;img
       * src=x onerror=alert(1)&gt;` is the correct, inert rendering of a hostile name, and a
       * regex for `onerror=` flags that as a failure while a regex for `<script>` misses the
       * same payload written another way. What matters is whether the seller created a TAG.
       * Counting elements answers that for every payload shape at once.
       */
      const tagCount = (source: string, tag: RegExp) => (source.match(tag) ?? []).length;

      assert.equal(
        tagCount(html, /<meta\b/g),
        tagCount(SHELL, /<meta\b/g),
        "seller text created or destroyed a <meta> element"
      );
      assert.equal(tagCount(html, /<script\b/g), 0, "no <script> element may exist");
      assert.equal(tagCount(html, /<img\b/g), 0, "no <img> element may exist");
      assert.equal(
        tagCount(html, /<meta property="og:title"/g),
        1,
        "exactly one og:title must survive — unfurlers honour the last tag they see"
      );

      // The attribute must be closed by OUR quote, never by the seller's.
      const attribute = /<meta property="og:title" content="([^"]*)"/.exec(html);
      assert.ok(attribute, "og:title must still parse as an attribute");
      assert.doesNotMatch(attribute![1]!, /[<>]/, "raw angle brackets must never reach an attribute");

      assert.ok(!html.includes("\u202e"), "bidi override must be stripped, not escaped");
      assert.ok(!html.includes("\u0000"), "control characters must be stripped");
    });
  }

  test("the protocol always owns part of the headline", async () => {
    await Store.updateOne({ storeId: STORE_ID }, { $set: { "sellerContent.profile.name": "Official Support" } });
    const res = await h.request("GET", `/stores/${STORE_ID}`);
    const html = String((res.body as { raw?: string }).raw ?? res.body);

    // A seller can choose their name; they can never own the whole line.
    assert.match(html, /content="Official Support — a store on AgentGoods\.AI"/);
  });

  test("a very long name is truncated, not passed through", async () => {
    await Store.updateOne({ storeId: STORE_ID }, { $set: { "sellerContent.profile.name": "A".repeat(500) } });
    const res = await h.request("GET", `/stores/${STORE_ID}`);
    const html = String((res.body as { raw?: string }).raw ?? res.body);

    const title = /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ?? "";
    assert.ok(title.length < 140, `title was ${title.length} characters`);
    assert.match(title, /a store on AgentGoods\.AI$/, "the protocol suffix must survive truncation");
  });

  test("the description never contains seller free text", async () => {
    await Store.updateOne(
      { storeId: STORE_ID },
      { $set: { "sellerContent.profile.description": "GUARANTEED 1000x RETURNS, send funds to 0xdead" } }
    );
    const res = await h.request("GET", `/stores/${STORE_ID}`);
    const html = String((res.body as { raw?: string }).raw ?? res.body);

    assert.doesNotMatch(html, /GUARANTEED 1000x/, "a seller must not write the sentence under the headline");
  });
});

describe("applyMeta is total", { concurrency: 1 }, () => {
  test("a shell missing a tag is left intact rather than corrupted", () => {
    const bare = "<!doctype html><html><head></head><body></body></html>";
    const out = applyMeta(bare, { title: "T", description: "D", url: "https://x.test/" });
    assert.equal(out, bare, "nothing to replace must mean nothing changed");
  });
});
