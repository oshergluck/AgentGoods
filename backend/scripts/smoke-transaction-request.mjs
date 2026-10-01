#!/usr/bin/env node
/**
 * Smoke test for transaction requests, against a live deployment, as the operator wallet.
 *
 * Prepares a 0.01 USDC transfer from the operator to the treasury destination (both ours), fetches it through its
 * transaction-request link (GET /api/v1/tx/{intentId}), checks it is byte-for-byte the prepared
 * transaction, and — with --send — signs and broadcasts exactly what the link returned. On the test network
 * this moves 0.01 mock USDC.
 *
 *     node backend/scripts/smoke-transaction-request.mjs https://testnet.agentgoods.ai [--send]
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet, JsonRpcProvider } from "ethers";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGIN = process.argv[2];
const SEND = process.argv.includes("--send");
if (!ORIGIN) {
  console.error("usage: smoke-transaction-request.mjs <origin> [--send]");
  process.exit(1);
}
function readEnvFile(file, key) {
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.trim().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") || null : null;
}
const key =
  process.env.DEPLOYER_PRIVATE_KEY ??
  readEnvFile(join(REPO, "contracts", ".env"), "DEPLOYER_PRIVATE_KEY") ??
  readEnvFile(join(REPO, "contracts", ".env"), "PRIVATE_KEY");
if (!key) throw new Error("operator key not found");
const wallet = new Wallet(key);

async function getKey(purpose, endpoint) {
  const c = await (await fetch(`${ORIGIN}/api/v1/auth/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.address, purpose }) })).json();
  if (!c?.nonce) return null;
  const r = await (await fetch(`${ORIGIN}${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: c.nonce, signature: await wallet.signMessage(c.message) }) })).json();
  return r?.apiKey ?? null;
}
const apiKey = (await getKey("ISSUE_API_KEY", "/api/v1/auth/api-key/issue")) ?? (await getKey("ROTATE_API_KEY", "/api/v1/auth/api-key/rotate"));
if (!apiKey) throw new Error("could not obtain an API key");

const prep = await fetch(`${ORIGIN}/api/v1/wallet/transfer-intent`, {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": `smoke-${Date.now()}` },
  body: JSON.stringify({ to: process.env.SMOKE_TO ?? "0x7437a03cacda010dde5272045d1ad2cb01e2b0dc", amountUSDC: "10000" }),
});
const prepared = await prep.json();
if (prep.status !== 201) throw new Error(`prepare failed ${prep.status}: ${JSON.stringify(prepared).slice(0, 300)}`);
const intent = prepared.intent;
console.log("intent", intent.intentId, "link", intent.transactionRequest?.url);

const got = await fetch(intent.transactionRequest.url);
const req = await got.json();
if (got.status !== 200) throw new Error(`link answered ${got.status}: ${JSON.stringify(req).slice(0, 300)}`);
const same = req.transaction.to.toLowerCase() === intent.transaction.to.toLowerCase() && req.transaction.data === intent.transaction.data;
console.log("link returned step", req.step, "from", req.from, "identical to the intent:", same);
if (!same) process.exit(2);

const bad = await fetch(`${ORIGIN}/api/v1/tx/not-an-id`);
const missing = await fetch(`${ORIGIN}/api/v1/tx/txi_${"0".repeat(32)}`);
console.log("bad id ->", bad.status, "unknown id ->", missing.status);

if (SEND) {
  const manifest = await (await fetch(`${ORIGIN}/.well-known/aic-agent.json`)).json();
  const rpc = manifest?.chain?.rpcUrl ?? manifest?.rpcUrl ?? "https://sepolia.base.org";
  const signer = wallet.connect(new JsonRpcProvider(rpc));
  const sent = await signer.sendTransaction({ to: req.transaction.to, data: req.transaction.data, value: BigInt(req.transaction.value ?? "0") });
  const receipt = await sent.wait();
  console.log("signed exactly what the link returned:", sent.hash, "status", receipt?.status);
}
