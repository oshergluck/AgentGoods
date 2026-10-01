#!/usr/bin/env node
/**
 * As Alpha's controller (the stranger probe's wallet), make it the store's delivery witness.
 *
 * A new store has no access attestor, so no buyer of Alpha could ever rate what they bought.
 * Alpha is the one store present at minute 0; it should be a store whose buyers can rate it.
 * Everything goes through the public API, exactly as an agent's would: /me for the store id,
 * POST /stores/{id}/access-attestor for the prepared transaction, then sign it.
 *
 *     node scripts/set-alpha-attestor.mjs https://testnet.agentgoods.ai
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet } from "ethers";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = (process.argv[2] ?? "https://testnet.agentgoods.ai").replace(/\/$/, "");
const provider = new JsonRpcProvider(process.env.ARENA_RPC_URL ?? "https://sepolia.base.org");
const wallet = new Wallet(JSON.parse(readFileSync(join(HERE, "..", ".probe-wallet.json"), "utf8")).privateKey, provider);

async function apiKey() {
  for (const [purpose, ep] of [["ISSUE_API_KEY", "/api/v1/auth/api-key/issue"], ["ROTATE_API_KEY", "/api/v1/auth/api-key/rotate"]]) {
    const c = await (await fetch(`${ORIGIN}/api/v1/auth/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.address, purpose }) })).json();
    if (!c?.message) continue;
    const r = await (await fetch(`${ORIGIN}${ep}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: c.nonce, signature: await wallet.signMessage(c.message) }) })).json();
    if (r?.apiKey) return r.apiKey;
  }
  throw new Error("no api key");
}

const H = { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${await apiKey()}` };
const me = await (await fetch(`${ORIGIN}/api/v1/me`, { headers: H })).json();
const storeId = me?.stores?.items?.[0]?.storeId;
if (!storeId) throw new Error("no store on /me");

const task = (me.tasks?.items ?? me.actionableTasks?.items ?? []).find?.((t) => t.type === "STORE_HAS_NO_DELIVERY_WITNESS");
console.log(`  /me task STORE_HAS_NO_DELIVERY_WITNESS before: ${task ? "present" : "absent"}`);

const res = await fetch(`${ORIGIN}/api/v1/stores/${storeId}/access-attestor`, {
  method: "POST",
  headers: { ...H, "idempotency-key": `alpha-attestor-${Date.now()}` },
  body: JSON.stringify({ attestor: wallet.address }),
});
const body = await res.json();
if (!res.ok) throw new Error(`prepare refused ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
const tx = body.intent.transaction;
const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0 });
const receipt = await sent.wait();
console.log(`  attestor set to ${wallet.address}: ${sent.hash} mined in block ${receipt.blockNumber}`);
