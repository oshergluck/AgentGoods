#!/usr/bin/env node
/**
 * List "Alpha AIC Arbitrage Tool" in Alpha's sales store.
 *
 *     node scripts/list-alpha-aic-arbitrage.mjs https://testnet.agentgoods.ai
 *
 * Signs with the Alpha controller in .probe-wallet.json. The deliverable is
 * products/alpha-aic-arbitrage/alpha-aic-arbitrage.js; its keccak256 is what the listing commits to.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const HERE = dirname(fileURLToPath(import.meta.url));
const O = (process.argv[2] ?? "https://testnet.agentgoods.ai").replace(/\/$/, "");
const RPC = process.env.RPC_URL ?? "https://sepolia.base.org";
const w = new ethers.Wallet(JSON.parse(readFileSync(resolve(HERE, "..", ".probe-wallet.json"), "utf8")).privateKey, new ethers.JsonRpcProvider(RPC));
const post = async (p, b, h = {}) => (await fetch(O + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) })).json();

let key;
for (const [purpose, ep] of [["ISSUE_API_KEY", "/api/v1/auth/api-key/issue"], ["ROTATE_API_KEY", "/api/v1/auth/api-key/rotate"]]) {
  const c = await post("/api/v1/auth/challenge", { wallet: w.address, purpose });
  const r = await post(ep, { nonce: c.nonce, signature: await w.signMessage(c.message) });
  if (r.apiKey) { key = r.apiKey; break; }
}
const A = { authorization: `Bearer ${key}` };
const me = await (await fetch(O + "/api/v1/me", { headers: A })).json();
const store = me.stores.items.find((s) => s.storeType === "sales");
if (!store) throw new Error("Alpha has no sales store yet — run probe-as-new-agent.mjs --build first");

const bytes = readFileSync(resolve(HERE, "..", "..", "products", "alpha-aic-arbitrage", "alpha-aic-arbitrage.js"));
const metadata = {
  name: "Alpha AIC Arbitrage Tool",
  description:
    "Finds and executes incentive arbitrage: buying a product can also pay you the store's AIC from its customer incentive pool, and when that reward sells for more USDC than the units cost (after curve fees, the sale's price impact and gas) the round trip is a profit and you keep the product. Each cycle it first sells any reward left unsold earlier, then reads every listed product, ranks them by reward value per USDC, drops the clearly unprofitable ones before spending a quote, prices the rest exactly for several unit counts (product quote + sell quote), re-quotes the best right before buying, verifies the approval, buys, waits for the reward and sells exactly what arrived with a slippage floor. Four limits with no defaults: max spend per trade, max total spend, max loss, min profit. Rewards under the 1 USDC sale minimum are never taken. When nothing qualifies it tells you how close the best candidate came. State is plain JSON. Pure core runs in a bare sandbox; the driver needs fetch and your own signer and never sees a key. Declared saving, MEASURED (a floor): building it took 38 model calls and 141,597 tokens (45,371 written, 96,226 read) across 10 build-and-test iterations, including a live testnet dry run, not counting re-reading earlier context. Priced at that build's cost at gpt-5 list rates (0.57 USDC).",
  demonstrations: [
    { input: { test: "11-case suite against a simulated market (constant-product curves, 6,000 USDC virtual seed, 3% fees, sales pools paying 2/1000 of the remaining pool per unit, 1 USDC minimum)" },
      output: { passed: "11/11", covers: "refuses to start without the four limits; executes a real arbitrage and realises the profit; sells a late-indexed reward on the next cycle without buying the token twice, across a JSON save/load; skips when the pool was drained between scan and purchase; leaves a close-but-unprofitable incentive alone; never trades your own store or excluded sellers; per-trade and total limits bind; no reward under the sale minimum; bad approvals refused; dry run signs nothing; core runs in a bare vm" } },
    { input: { live: "dry run on testnet.agentgoods.ai", policy: { maxSpendPerTradeUSDC: 20, maxTotalSpendUSDC: 50, maxLossUSDC: 5, minProfitUSDC: 0.1 } },
      output: { scanned: 5, skippedBeforeQuoting: 4, quotes: 18, opportunities: 0, closest: "3 units cost 1.50 USDC, reward sold for 1.3452 — -0.23 after gas", seconds: 3 },
      note: "no opportunity at that moment, and it said by how much; opportunities appear when a store's pool is large relative to its price" },
  ],
};
const metadataURI = JSON.stringify(metadata);
if (metadataURI.length > 4096) throw new Error(`metadataURI is ${metadataURI.length} characters; the limit is 4096`);
if (process.argv.includes("--check")) { console.log(`ok: ${metadataURI.length} characters, ${bytes.length} bytes, store ${store.storeId}`); process.exit(0); }

const res = await post(`/api/v1/stores/${store.storeId}/products`, {
  productId: "alpha-aic-arbitrage",
  /*
   * Priced at what building it would cost a gpt-5 agent at list rates: 45,371 written x 10/M +
   * 96,226 read x 1.25/M = 0.57 USDC.
   */
  priceUSDC: "570000",
  unlimitedInventory: true,
  content: bytes.toString("base64"),
  contentType: "text/javascript",
  filename: "alpha-aic-arbitrage.js",
  metadataURI,
  declaration: { tokensSaved: "141000", modelTier: "gpt-5", basis: "MEASURED" },
}, { ...A, "idempotency-key": "list-aea-" + Date.now() });
if (!res.intent) { console.error("refused:", JSON.stringify(res.error ?? res).slice(0, 600)); process.exit(1); }
const t = res.intent.transaction;
if ((t.data.length - 2 - 8) % 64) throw new Error("calldata length cannot be valid");
const rc = await (await w.sendTransaction({ to: t.to, data: t.data, value: t.value ?? 0 })).wait();
console.log(`listed Alpha AIC Arbitrage Tool: tx ${rc.hash} status ${rc.status} contentHash ${res.content?.contentHash}`);
