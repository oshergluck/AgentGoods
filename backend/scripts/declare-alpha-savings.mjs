#!/usr/bin/env node
/**
 * Set the token-saving declarations on Alpha's live products (a declaration change is a new version).
 *
 *     node scripts/declare-alpha-savings.mjs https://testnet.agentgoods.ai
 *
 * The figures and how each was obtained are in ALPHA_SAVINGS below; the same text goes into each
 * listing's description so a buyer can see the method, not only the number.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

export const ALPHA_SAVINGS = {
  "Alpha the market": {
    declaration: { tokensSaved: "445000", modelTier: "claude-opus-5-5", basis: "MEASURED" },
    method:
      "Declared saving, MEASURED: building this tool took 104 model calls and 445,592 tokens " +
      "(192,714 written, 252,878 read) across 10 fix-and-test iterations, not counting re-reading " +
      "earlier context. That is what a buyer does not spend.",
  },
  "Alpha tx builder": {
    declaration: { tokensSaved: "86000", modelTier: "claude-opus-5-5", basis: "MEASURED" },
    method:
      "Declared saving, MEASURED (a floor): the turns that wrote and revised this helper family " +
      "used 86,029 tokens, not counting the investigation around them.",
  },
  "Alpha tx min": {
    declaration: { tokensSaved: "53000", modelTier: "gpt-6-luna", basis: "ESTIMATED" },
    method:
      "Declared saving, ESTIMATED: on this deployment a hand-copied calldata that came out " +
      "malformed cost 3.21 refused retries on average at about 16,500 tokens per turn (measured " +
      "over 19,524 agent actions); this check prevents that copy.",
  },
};

const HERE = dirname(fileURLToPath(import.meta.url));
const O = (process.argv[2] ?? "https://testnet.agentgoods.ai").replace(/\/$/, "");
if (process.argv[1] && process.argv[1].endsWith("declare-alpha-savings.mjs")) {
  const w = new ethers.Wallet(JSON.parse(readFileSync(resolve(HERE, "..", ".probe-wallet.json"), "utf8")).privateKey, new ethers.JsonRpcProvider(process.env.RPC_URL ?? "https://sepolia.base.org"));
  const post = async (p, b, h = {}) => (await fetch(O + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) })).json();
  let key;
  for (const [purpose, ep] of [["ISSUE_API_KEY", "/api/v1/auth/api-key/issue"], ["ROTATE_API_KEY", "/api/v1/auth/api-key/rotate"]]) {
    const c = await post("/api/v1/auth/challenge", { wallet: w.address, purpose });
    const r = await post(ep, { nonce: c.nonce, signature: await w.signMessage(c.message) });
    if (r.apiKey) { key = r.apiKey; break; }
  }
  const A = { authorization: `Bearer ${key}` };
  const items = (await (await fetch(O + "/api/v1/market/products?limit=100")).json()).items;
  for (const it of items) {
    const sc = it.sellerContent ?? {};
    const spec = ALPHA_SAVINGS[sc.name];
    if (!spec) continue;
    const meta = JSON.parse(sc.metadataURI ?? "{}");
    meta.description = String(meta.description ?? "").replace(/\s*Declared saving[\s\S]*$/, "") + " " + spec.method;
    const metadataURI = JSON.stringify(meta);
    if (metadataURI.length > 4096) throw new Error(`${sc.name}: metadataURI ${metadataURI.length} > 4096`);
    const { storeId, productId } = it.protocol;
    const res = await post(`/api/v1/stores/${storeId}/products/${productId}/update`, {
      metadataURI,
      declaration: spec.declaration,
      changelog: "Declared token saving corrected; the method is in the description.",
    }, { ...A, "idempotency-key": "declare-" + productId.slice(2, 12) + "-" + Date.now() });
    if (!res.intent) { console.error(sc.name, "refused:", JSON.stringify(res.error ?? res).slice(0, 400)); continue; }
    const t = res.intent.transaction;
    if ((t.data.length - 2 - 8) % 64) throw new Error("calldata length cannot be valid");
    const rc = await (await w.sendTransaction({ to: t.to, data: t.data, value: t.value ?? 0 })).wait();
    console.log(`${sc.name}: ${spec.declaration.tokensSaved} ${spec.declaration.basis} — tx ${rc.hash} status ${rc.status}`);
  }
}
