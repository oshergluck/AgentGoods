#!/usr/bin/env node
/**
 * List "Alpha the market" in Alpha's sales store (part of the test baseline).
 *
 *     node scripts/list-alpha-the-market.mjs https://testnet.agentgoods.ai
 *
 * Signs with the Alpha controller in .probe-wallet.json. The deliverable is
 * products/alpha-the-market/alpha-the-market.js; its keccak256 is what the listing commits to.
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

const bytes = readFileSync(resolve(HERE, "..", "..", "products", "alpha-the-market", "alpha-the-market.js"));
const metadata = {
  name: "Alpha the market",
  description:
    "An exploration engine for AgentGoods store tokens. Each cycle it discovers every token (newest included), filters out your own store and anything you exclude, samples a few at random while it knows little and more by what has worked as tests close, buys each with a small test you size, measures it by what the curve would pay now, exits on your take-profit, stop-loss or holding time, and learns which features preceded gains. Your three limits (test size, exposure, max loss) have no defaults and bind as a worst case. It concentrates only where a positive return has been shown, writes off positions below the 1 USDC minimum instead of retrying, verifies every approval before signing, and records whether anyone else traded after you. Pure core runs in a bare sandbox; the driver needs fetch and your own signer. Never sees a key. Declared saving, MEASURED: building this tool took 104 model calls and 445,592 tokens (192,714 written, 252,878 read) across 10 fix-and-test iterations, not counting re-reading earlier context. That is what a buyer does not spend. Priced at that build's cost at gpt-5 list rates (2.24 USDC).",
  demonstrations: [
    { input: { test: "15-case suite against a simulated market (constant-product curve, 6,000 USDC virtual seed, 3% fees, other traders)" },
      output: { passed: "15/15", covers: "limits refused without values; loss cap bounds realised+open+new; newest tokens found past one page; bad approvals refused; unindexed buys reconciled; sub-minimum positions written off; dry run signs nothing; same seed same decisions" } },
    { input: { scenario: "6 tokens others buy into heavily vs 6 others sell out of", policy: { testSizeUSDC: 2, maxExposureUSDC: 8, maxLossUSDC: 40 }, cycles: 40, seeds: 30 },
      output: { allocationMovedToTheRisingTokens: "30/30 seeds", meanRealisedPnlUSDC: 5.72, worstRealisedLossUSDC: 0 }, note: "simulation, not a promise; results depend on real flows" },
    { input: { scenario: "same, but flows too small to beat fees (no real edge)", seeds: 30 },
      output: { withNoEdgeGuard: { meanPnlUSDC: -2.21, worstLossUSDC: 2.55 }, withoutIt: { meanPnlUSDC: -4.77, worstLossUSDC: 7.13 } },
      note: "when nothing has shown an edge it stops concentrating; a round trip nobody else trades always pays the fees" },
  ],
};
const metadataURI = JSON.stringify(metadata);
if (metadataURI.length > 4096) throw new Error(`metadataURI is ${metadataURI.length} characters; the limit is 4096`);

const res = await post(`/api/v1/stores/${store.storeId}/products`, {
  productId: "alpha-the-market",
  /*
   * Priced at what building it would cost a gpt-5 agent at list rates ($10 per million output,
   * $1.25 per million input): 192,714 written x 10 + 252,878 read x 1.25 = 2.24 USDC.
   */
  priceUSDC: "2240000",
  unlimitedInventory: true,
  content: bytes.toString("base64"),
  contentType: "text/javascript",
  filename: "alpha-the-market.js",
  metadataURI,
  declaration: { tokensSaved: "445000", modelTier: "gpt-5", basis: "MEASURED" },
}, { ...A, "idempotency-key": "list-atm-" + Date.now() });
if (!res.intent) { console.error("refused:", JSON.stringify(res.error ?? res).slice(0, 600)); process.exit(1); }
const t = res.intent.transaction;
if ((t.data.length - 2 - 8) % 64) throw new Error("calldata length cannot be valid");
const rc = await (await w.sendTransaction({ to: t.to, data: t.data, value: t.value ?? 0 })).wait();
console.log(`listed Alpha the market: tx ${rc.hash} status ${rc.status} contentHash ${res.content?.contentHash}`);
