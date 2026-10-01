#!/usr/bin/env node
/**
 * Alpha's seller duty: record its buyers' deliveries on chain, so they can rate what they bought.
 *
 * Alpha is the one store present at minute 0, and it is operated by nobody — so the second half
 * of the rating loop (the seller attesting each delivery) never happened, and every buyer of Alpha
 * was stuck at 412. This does exactly what any seller would, through the public API only:
 * check the store's attestor on chain and set it if missing, then GET /access/attestations/pending
 * and, for each licenseToken, POST /access/attestations and sign what it prepares.
 *
 *     node scripts/attest-alpha-deliveries.mjs https://testnet.agentgoods.ai [--loop 120]
 *
 * With --loop N it repeats every N seconds, so a buyer who collects is attested within minutes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = (process.argv[2] ?? "https://testnet.agentgoods.ai").replace(/\/$/, "");
const loopAt = process.argv.indexOf("--loop");
const LOOP_SECONDS = loopAt > 0 ? Number(process.argv[loopAt + 1] ?? 120) : 0;
const provider = new JsonRpcProvider(process.env.ARENA_RPC_URL ?? "https://sepolia.base.org");
const wallet = new Wallet(JSON.parse(readFileSync(join(HERE, "..", ".probe-wallet.json"), "utf8")).privateKey, provider);
const stamp = () => new Date().toISOString().slice(11, 19);

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

async function sign(intent, label) {
  const tx = intent.transaction;
  const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0 });
  const r = await sent.wait();
  console.log(`${stamp()}  ${label}: ${sent.hash} mined in block ${r.blockNumber}`);
}

async function pass() {
  const me = await (await fetch(`${ORIGIN}/api/v1/me`, { headers: H })).json();
  const store = me?.stores?.items?.[0];
  if (!store) throw new Error("Alpha's controller has no store on /me");
  const address = store.address ?? store.protocol?.address;

  if (address) {
    const c = new Contract(address, ["function accessAttestor() view returns (address)"], provider);
    const attestor = await c.accessAttestor();
    if (attestor.toLowerCase() !== wallet.address.toLowerCase()) {
      const res = await fetch(`${ORIGIN}/api/v1/stores/${store.storeId}/access-attestor`, {
        method: "POST", headers: { ...H, "idempotency-key": `alpha-attestor-${Date.now()}` },
        body: JSON.stringify({ attestor: wallet.address }),
      });
      const b = await res.json();
      if (!res.ok) throw new Error(`attestor refused ${res.status}: ${JSON.stringify(b).slice(0, 200)}`);
      await sign(b.intent, `attestor was ${attestor}; set to ${wallet.address}`);
    }
  }

  const pending = await (await fetch(`${ORIGIN}/api/v1/access/attestations/pending`, { headers: H })).json();
  const groups = pending.items ?? [];
  if (!groups.length) { console.log(`${stamp()}  nothing pending`); return; }
  for (const g of groups) {
    const res = await fetch(`${ORIGIN}/api/v1/access/attestations`, {
      method: "POST", headers: { ...H, "idempotency-key": `alpha-attest-${Date.now()}` },
      body: JSON.stringify({ licenseToken: g.licenseToken, licenseIds: g.licenseIds }),
    });
    const b = await res.json();
    if (!res.ok) { console.log(`${stamp()}  attest refused ${res.status}: ${JSON.stringify(b).slice(0, 200)}`); continue; }
    await sign(b.intent, `attested ${b.attesting?.length ?? g.licenseIds.length} delivery(ies) on ${g.licenseToken}`);
  }
}

do {
  try { await pass(); } catch (e) { console.log(`${stamp()}  pass failed: ${e.message}`); }
  if (LOOP_SECONDS > 0) await new Promise((r) => setTimeout(r, LOOP_SECONDS * 1000));
} while (LOOP_SECONDS > 0);
