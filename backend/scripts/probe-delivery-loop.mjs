#!/usr/bin/env node
/**
 * The rating loop, as a buyer who has never been here: key → quote → buy → collect → wait for the
 * protocol to record the delivery → confirm the signal route would now accept a rating.
 *
 * It stops BEFORE submitting a signal, so no rating from this probe ever enters the market.
 * The buyer is funded by the operator (test USDC mint + a little ETH), which is the only thing it
 * gets that an agent does not.
 *
 *     node scripts/probe-delivery-loop.mjs https://testnet.agentgoods.ai
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = (process.argv[2] ?? "https://testnet.agentgoods.ai").replace(/\/$/, "");
const USDC = "0x1A0914e8D20eDcb26181b08C5e40137Cd0741E60";
const provider = new JsonRpcProvider(process.env.ARENA_RPC_URL ?? "https://sepolia.base.org");
const env = readFileSync(join(HERE, "..", "..", "contracts", ".env"), "utf8");
const operator = new Wallet(env.match(/^(?:DEPLOYER_)?PRIVATE_KEY=["']?(0x[0-9a-fA-F]+)/m)[1], provider);
const buyer = Wallet.createRandom().connect(provider);
const say = (l) => console.log("  " + l);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await (await operator.sendTransaction({ to: buyer.address, value: parseEther("0.002") })).wait();
await (await new Contract(USDC, ["function mint(address,uint256)"], operator).mint(buyer.address, parseUnits("5", 6))).wait();
while ((await provider.getBalance(buyer.address)) === 0n) await sleep(2000);
say(`buyer ${buyer.address} funded`);

const ch = await (await fetch(`${ORIGIN}/api/v1/auth/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: buyer.address, purpose: "ISSUE_API_KEY" }) })).json();
const issued = await (await fetch(`${ORIGIN}/api/v1/auth/api-key/issue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: ch.nonce, signature: await buyer.signMessage(ch.message) }) })).json();
const H = { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${issued.apiKey}` };
say("key issued by the buyer itself");

const market = await (await fetch(`${ORIGIN}/api/v1/market/products?limit=20`)).json();
const item = (market.items ?? []).sort((a, b) => Number(a.priceUSDC ?? 1e9) - Number(b.priceUSDC ?? 1e9))[0];
const storeId = item.protocol.storeId, productId = item.protocol.productId;
const quote = await (await fetch(`${ORIGIN}/api/v1/stores/${storeId}/products/${productId}/quote`, { method: "POST", headers: H, body: JSON.stringify({ units: 1 }) })).json();
if (!quote.execution?.body) throw new Error("quote has no execution.body: " + JSON.stringify(quote).slice(0, 300));
const buy = await (await fetch(ORIGIN + quote.execution.endpoint, {
  method: "POST", headers: { ...H, "idempotency-key": `loop-${Date.now()}` },
  body: JSON.stringify(quote.execution.body),
})).json();
if (!buy.intent) throw new Error("purchase not prepared: " + JSON.stringify(buy).slice(0, 400));
for (const t of [buy.intent.approvalTransaction, buy.intent.transaction].filter(Boolean)) {
  const tx = t.transaction ?? t;
  await (await buyer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0, gasLimit: 900000 })).wait();
  await sleep(4000);
}
say(`bought "${item.sellerContent?.name}"`);

let lic = null;
for (let i = 0; i < 40 && !lic; i++) {
  const me = await (await fetch(`${ORIGIN}/api/v1/me`, { headers: H })).json();
  lic = me.licenses?.items?.[0] ?? null;
  if (!lic) await sleep(5000);
}
if (!lic) throw new Error("licence never appeared on /me");
say(`licence on /me: licenseToken ${lic.licenseToken.slice(0, 10)}… licenseId ${lic.licenseId} | next: ${lic.next.slice(0, 60)}…`);

const grant = await (await fetch(`${ORIGIN}/api/v1/access/grant`, { method: "POST", headers: { ...H, "idempotency-key": `grant-${Date.now()}` }, body: JSON.stringify({ licenseToken: lic.licenseToken, licenseId: lic.licenseId }) })).json();
const url = grant.accessUrl ?? grant.url ?? grant.session?.url;
const bytes = await (await fetch(url.startsWith("http") ? url : ORIGIN + url)).arrayBuffer();
say(`collected ${bytes.byteLength} bytes`);

const t0 = Date.now();
let delivered = false;
while (!delivered && Date.now() - t0 < 180000) {
  const l = await (await fetch(`${ORIGIN}/api/v1/licenses/${lic.licenseToken}/${lic.licenseId}`)).json();
  delivered = Boolean(l.license?.delivery?.delivered);
  if (!delivered) await sleep(5000);
}
say(delivered ? `delivery recorded on chain by the gateway after ${Math.round((Date.now() - t0) / 1000)}s — the seller did nothing` : "delivery NOT recorded within 3 minutes");

/* Prepare only: proves the signal route now accepts this buyer, without signing or sending anything. */
const sig = await fetch(`${ORIGIN}/api/v1/licenses/${lic.licenseToken}/${lic.licenseId}/signal`, {
  method: "POST", headers: { ...H, "idempotency-key": `sig-${Date.now()}` }, body: JSON.stringify({ worthIt: true, note: "probe" }),
});
say(`signal route: ${sig.status} ${sig.status === 201 ? "(prepared, NOT signed or sent)" : JSON.stringify(await sig.json()).slice(0, 200)}`);
