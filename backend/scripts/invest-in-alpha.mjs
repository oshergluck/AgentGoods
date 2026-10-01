#!/usr/bin/env node
/**
 * The operator's demonstration store takes its own advice: buy its own token, fund its own pool.
 *
 * Done entirely through the public API as the store's controller — the same wallet that opened
 * Alpha in the stranger probe — so that what it exercises is exactly what any seller would do:
 * POST /stocks/{aic}/buy, approve what the intent says, sign the transaction it prepared; then
 * POST /stores/{id}/reward-pool/deposit-intent with AIC now held, approve, sign. Nothing here
 * touches a contract directly except the two ERC-20 approvals the intents ask for.
 *
 *     node backend/scripts/invest-in-alpha.mjs <origin> <usdcToInvest> <usdcWorthIntoPool>
 *     node backend/scripts/invest-in-alpha.mjs https://testnet.agentgoods.ai 1200 200
 *
 * With <usdcToInvest> 0 nothing is bought: the pool is funded from the position the store was born
 * with (its initial market capital), sized as <usdcWorthIntoPool> of <seedUSDC>:
 *     node backend/scripts/invest-in-alpha.mjs https://testnet.agentgoods.ai 0 30 150
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, parseUnits, formatUnits } from "ethers";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = (process.argv[2] ?? "https://testnet.agentgoods.ai").replace(/\/$/, "");
const INVEST_USDC = process.argv[3] ?? "1200";
const POOL_USDC = process.argv[4] ?? "200";
const SEED_USDC = process.argv[5] ?? "150";
const BASIS_USDC = INVEST_USDC === "0" ? SEED_USDC : INVEST_USDC;
const RPC = process.env.ARENA_RPC_URL ?? "https://sepolia.base.org";

const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(JSON.parse(readFileSync(join(HERE, "..", ".probe-wallet.json"), "utf8")).privateKey, provider);
const ERC20 = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"];

const say = (l) => console.log("  " + l);

async function apiKey() {
  for (const [purpose, ep] of [["ISSUE_API_KEY", "/api/v1/auth/api-key/issue"], ["ROTATE_API_KEY", "/api/v1/auth/api-key/rotate"]]) {
    const c = await (await fetch(`${ORIGIN}/api/v1/auth/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.address, purpose }) })).json();
    if (!c?.message) continue;
    const r = await (await fetch(`${ORIGIN}${ep}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: c.nonce, signature: await wallet.signMessage(c.message) }) })).json();
    if (r?.apiKey) return r.apiKey;
  }
  throw new Error("no api key");
}
const KEY = await apiKey();
const H = { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${KEY}` };

/** Find {to,data} wherever the response put it — the published tool's rule. */
function txFrom(r) {
  for (const stack = [r]; stack.length; ) {
    const n = stack.shift();
    if (!n || typeof n !== "object") continue;
    if (typeof n.to === "string" && typeof n.data === "string") {
      const hex = n.data.length - 2;
      if (hex > 0 && (hex - 8) % 64 !== 0) throw new Error(`calldata is ${hex} hex characters`);
      return { to: n.to, data: n.data, value: n.value ?? 0 };
    }
    for (const k of Object.keys(n)) stack.push(n[k]);
  }
  throw new Error("no transaction in response: " + JSON.stringify(r).slice(0, 300));
}

/** Approve exactly what the intent asks, then sign what it prepared. */
async function executeIntent(body, label) {
  const allowance = body?.intent?.requiredAllowance ?? body?.intent?.allowance ?? null;
  if (allowance) {
    const token = new Contract(allowance.token, ERC20, wallet);
    const need = BigInt(allowance.amount.base);
    const have = await token.allowance(wallet.address, allowance.spender);
    if (have < need) {
      const a = await token.approve(allowance.spender, need);
      await a.wait();
      /*
       * Wait until the approval is VISIBLE, not merely mined. The public endpoint is several
       * nodes behind a balancer; the approve mines on one and the next call's estimateGas lands
       * on another that is a block behind, sees allowance 0, and reverts a transaction that
       * would have succeeded. Read back until every node agrees.
       */
      for (let i = 0; i < 20 && (await token.allowance(wallet.address, allowance.spender)) < need; i++) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      say(`${label}: approved ${allowance.amount.display} ${allowance.tokenSymbol} for ${allowance.spender}`);
    }
  }
  const tx = txFrom(body);
  /* Explicit gas, so a lagging node's estimateGas cannot veto a transaction the chain accepts. */
  const sent = await wallet.sendTransaction({ ...tx, gasLimit: 900_000n });
  const rc = await sent.wait();
  say(`${label}: ${tx.data.length - 2} hex signed, ${sent.hash} ${rc.status === 1 ? "mined" : "REVERTED"}`);
  return rc.status === 1;
}

async function post(path, body) {
  const res = await fetch(`${ORIGIN}${path}`, { method: "POST", headers: { ...H, "Idempotency-Key": `alpha-${Date.now()}-${Math.random().toString(36).slice(2)}` }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(j.error ?? j).slice(0, 500)}`);
  return j;
}
async function me() {
  return (await fetch(`${ORIGIN}/api/v1/me`, { headers: H })).json();
}

console.log(`Alpha's controller ${wallet.address} on ${ORIGIN}`);
const m0 = await me();
const store = m0.stores.items[0];
const aic = store.aicToken;
say(`store ${store.storeId.slice(0, 12)}… token ${aic}`);
const usdc = new Contract("0x1A0914e8D20eDcb26181b08C5e40137Cd0741E60", ERC20, wallet);
say(`USDC in wallet: ${formatUnits(await usdc.balanceOf(wallet.address), 6)}`);

/* 1. buy own AIC with the whole amount (skipped at 0: the store was born holding its seed position) */
if (INVEST_USDC !== "0") {
  const buy = await post(`/api/v1/stocks/${aic}/buy`, { amount: parseUnits(INVEST_USDC, 6).toString() });
  const q = buy?.intent?.summary?.protocol ?? buy?.intent?.summary ?? {};
  say(`buy prepared: ${JSON.stringify(q).slice(0, 220)}`);
  if (!(await executeIntent(buy, "buy"))) process.exit(1);
}

/* 2. wait for the position to be indexed */
let held = 0n;
for (let i = 0; i < 40; i++) {
  const token = new Contract(aic, ERC20, wallet);
  held = await token.balanceOf(wallet.address);
  if (held > 0n) break;
  await new Promise((r) => setTimeout(r, 3000));
}
say(`AIC now held: ${formatUnits(held, 18)}`);

/* 3. fund the pool with the share of tokens that POOL_USDC bought */
const share = (held * parseUnits(POOL_USDC, 6)) / parseUnits(BASIS_USDC, 6);
say(`depositing ${formatUnits(share, 18)} AIC (the ${POOL_USDC}/${BASIS_USDC} share) into the incentive pool`);
for (let i = 0; i < 30; i++) {
  /* the deposit route checks the INDEXED holding, which lags the chain by a few seconds */
  try {
    const dep = await post(`/api/v1/stores/${store.storeId}/reward-pool/deposit-intent`, { aicAmount: share.toString() });
    say(`deposit prepared: next unit would pay ${dep?.intent?.summary?.protocol?.nextUnitWouldPayAIC?.display ?? "?"} AIC`);
    if (!(await executeIntent(dep, "deposit"))) process.exit(1);
    break;
  } catch (e) {
    if (!/INSUFFICIENT_AIC|hold 0/.test(String(e)) || i === 29) throw e;
    await new Promise((r) => setTimeout(r, 4000));
  }
}

await new Promise((r) => setTimeout(r, 8000));
const m1 = await me();
const s1 = m1.stores.items[0];
console.log("\nAfter:");
say(`AIC held: ${formatUnits(await new Contract(aic, ERC20, wallet).balanceOf(wallet.address), 18)}`);
say(`provenOwnership: ${JSON.stringify(s1.provenOwnership ?? null).slice(0, 300)}`);
const mk = await (await fetch(`${ORIGIN}/api/v1/market/products?limit=5`, { headers: H })).json();
for (const p of mk.items ?? []) say(`product ${p.protocol.productId.slice(0, 10)}… incentive: ${JSON.stringify(p.incentive).slice(0, 160)}`);
