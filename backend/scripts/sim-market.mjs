#!/usr/bin/env node
/**
 * SIMULATED MARKET ACTIVITY for the TEST network — clearly labelled, never real demand.
 *
 * Runs a handful of simulated wallets that use AgentGoods exactly as an agent would — through the public API
 * and signed transactions — so the test site shows a living market: stores, products, services, purchases,
 * service calls, AIC trades, forum posts and ratings. Everything it creates is labelled as simulated:
 * store and product names start with "[SIM]", every description says "Simulated activity, not real demand",
 * and every forum post starts with "[SIMULATED ACTIVITY]".
 *
 * It refuses to run on anything but Base Sepolia (chain 84532), and it is a LOCAL process: start it when
 * you want the test site to look alive, stop it with Ctrl+C. Do not run it while measuring organic activity on
 * the test site: this is not organic activity.
 *
 *     node scripts/sim-market.mjs                 # set up (first run) and loop
 *     node scripts/sim-market.mjs --setup-only    # create wallets, stores and listings, then stop
 *     node scripts/sim-market.mjs --once          # one round of actions, then stop
 *
 * Two kinds of simulated wallet:
 *   - business wallets (SIM_WALLETS): each runs a "[SIM]" store with a product and a callable service, and
 *     buys products, calls services, posts in the forum and rates purchases;
 *   - trader wallets (SIM_TRADERS): a crowd that buys and sells the simulated stores' AIC at random sizes and
 *     random times, straight against the exchange contract — so the stock charts move.
 * gpt-6-luna writes the forum messages and the texts sent to services (falls back to fixed text without a key).
 *
 * Environment (all optional):
 *   SIM_ORIGIN        https://testnet.agentgoods.ai
 *   SIM_WALLETS       6            business wallets
 *   SIM_TRADERS       30           trader wallets
 *   SIM_INTERVAL_SEC  20           seconds between rounds (a round = one business action + 1-4 trades)
 *   SIM_MODEL         gpt-6-luna
 *   SIM_RPC_URL       BASE_SEPOLIA_RPC_URL from contracts/.env, else https://sepolia.base.org
 *   OPENAI_API_KEY    from the environment or backend/.env
 *
 * Funding comes from the operator key in contracts/.env: test USDC is minted by the operator, and at the start
 * of every run each wallet is topped up to 0.01 test ETH for gas (only the difference; nothing during the run). Wallets and keys are kept in backend/.sim/ (git-ignored).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { ethers } from "ethers";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const STATE_DIR = join(HERE, "..", ".sim");
const STATE_FILE = join(STATE_DIR, "wallets.json");
const ORIGIN = (process.env.SIM_ORIGIN ?? "https://testnet.agentgoods.ai").replace(/\/+$/, "");
const COUNT = Math.max(2, Math.min(Number(process.env.SIM_WALLETS ?? 6) || 6, 12));
const TRADERS = Math.max(0, Math.min(Number(process.env.SIM_TRADERS ?? 30) || 30, 200));
const MODEL = process.env.SIM_MODEL ?? "gpt-6-luna";
const INTERVAL_MS = Math.max(5, Number(process.env.SIM_INTERVAL_SEC ?? 20) || 20) * 1000;
const ARGS = new Set(process.argv.slice(2));
const LABEL = "Simulated activity on the test network, not real demand.";
const NAMES = ["Atlas", "Birch", "Cobalt", "Delta", "Ember", "Fjord", "Garnet", "Harbor", "Indigo", "Juniper", "Kestrel", "Lumen"];

function readEnvFile(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`));
    if (m) return m[1].replace(/^["']|["']$/g, "").trim() || null;
  }
  return null;
}
const ENV_FILE = join(REPO, "contracts", ".env");
const OPERATOR_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? readEnvFile(ENV_FILE, "DEPLOYER_PRIVATE_KEY");
const RPC = process.env.SIM_RPC_URL ?? readEnvFile(ENV_FILE, "BASE_SEPOLIA_RPC_URL") ?? "https://sepolia.base.org";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? readEnvFile(join(HERE, "..", ".env"), "OPENAI_API_KEY");

/** gpt-6-luna writes short simulated texts; null when no key or the call fails (callers fall back). */
async function luna(instruction) {
  if (!OPENAI_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "You write short texts for a SIMULATED market on a test network. Plain text, one or two sentences, no " +
              "quotes, no links, no prices you were not given. Never claim to be a real person or a real customer.",
          },
          { role: "user", content: instruction },
        ],
        max_completion_tokens: 400,
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const text = String(j.choices?.[0]?.message?.content ?? "").trim();
    return text ? text.slice(0, 400) : null;
  } catch {
    return null;
  }
}

const log = (...a) => console.log(`[sim ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const idem = () => ({ "idempotency-key": `sim-${crypto.randomBytes(8).toString("hex")}` });

async function api(method, path, { key, body, headers } = {}) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json };
}

function fail(what, r) {
  const e = r?.body?.error;
  return new Error(`${what}: ${r?.status} ${e?.code ?? ""} ${String(e?.message ?? "").slice(0, 160)}`);
}

/* ------------------------------------------------------------------ chain */

const provider = new ethers.JsonRpcProvider(RPC);
const usdcAbi = ["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"];

/** Signs a prepared intent through its transaction-request link: the approval first if needed, then the call. */
async function sendIntent(wallet, intent) {
  const path = intent?.transactionRequest?.path ?? (intent?.intentId ? `/api/v1/tx/${intent.intentId}` : null);
  if (!path) {
    const t = intent?.transaction;
    if (!t) throw new Error("no transaction in the intent");
    const tx = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value ?? 0) });
    return tx.wait();
  }
  for (let step = 0; step < 3; step++) {
    const r = await api("GET", path);
    if (r.status !== 200) throw fail("transaction request", r);
    const t = r.body.transaction;
    const tx = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value ?? 0) });
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`transaction reverted (${r.body.step})`);
    if (r.body.step !== "approval") return receipt;
    await sleep(2500);
  }
  throw new Error("transaction request did not finish");
}

/* ------------------------------------------------------------------ state */

function loadState() {
  if (!existsSync(STATE_FILE)) return { wallets: [] };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}
function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/* ------------------------------------------------------------------ setup */

/** Gas, once per run: a wallet below 0.01 test ETH gets exactly the difference; one at or above gets nothing. */
const GAS_TARGET = ethers.parseEther("0.01");
async function topUpGas(operator, address, label) {
  const eth = await provider.getBalance(address);
  if (eth >= GAS_TARGET) return false;
  const diff = GAS_TARGET - eth;
  await (await operator.sendTransaction({ to: address, value: diff })).wait();
  log(`${label}: gas topped up by ${ethers.formatEther(diff)} to 0.01 test ETH`);
  return true;
}

async function ensureUsdc(usdc, w) {
  const addr = w.address;
  const bal = await usdc.balanceOf(addr);
  if (bal < 60_000_000n) {
    await (await usdc.mint(addr, 300_000_000n)).wait();
    log(`${w.name}: +300 test USDC`);
  }
}

async function ensureKey(w) {
  if (w.apiKey) return;
  const wallet = new ethers.Wallet(w.privateKey);
  const c = await api("POST", "/api/v1/auth/challenge", { body: { wallet: wallet.address, purpose: "ISSUE_API_KEY" } });
  if (c.status !== 201) throw fail("challenge", c);
  const signature = await wallet.signMessage(c.body.message);
  const k = await api("POST", "/api/v1/auth/api-key/issue", { body: { nonce: c.body.nonce, signature } });
  if (k.status !== 201) throw fail("api key", k);
  w.apiKey = k.body.apiKey;
}

async function findStore(w) {
  const r = await api("GET", `/api/v1/stores?controller=${w.address}&limit=5`);
  const s = r.body?.items?.[0];
  if (!s) return null;
  const p = s.protocol ?? s;
  return { storeId: p.storeId, aicToken: s.token?.address ?? p.tokenAddress ?? p.aicToken ?? s.aicToken ?? null };
}

async function ensureStore(wallet, w, i) {
  if (w.storeId && w.aicToken) return;
  if (w.storeId) {
    const s = await findStore(w);
    if (s?.aicToken) w.aicToken = s.aicToken;
    return;
  }
  const existing = await findStore(w);
  if (existing) {
    Object.assign(w, existing);
    return;
  }
  const r = await api("POST", "/api/v1/stores", {
    key: w.apiKey,
    headers: idem(),
    body: {
      storeType: "sales",
      aicName: `SIM ${w.name}`,
      aicSymbol: `SIM${String.fromCharCode(65 + i)}`,
      storeName: `[SIM] ${w.name} Works`,
      initialOwnerSeedUSDC: "10",
    },
  });
  if (r.status !== 201) throw fail("create store", r);
  await sendIntent(wallet, r.body.intent);
  for (let t = 0; t < 30 && !w.storeId; t++) {
    await sleep(4000);
    const s = await findStore(w);
    if (s) Object.assign(w, s);
  }
  if (!w.storeId) throw new Error("store not indexed yet");
  log(`${w.name}: store ${w.storeId.slice(0, 10)}… created`);
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const DECL = { inputTokens: "90000", reasoningTokens: "6000", outputTokens: "4000", modelTier: "gpt-6-luna", basis: "ESTIMATED" };
const LOG2 = (n) => [
  `[SIM] Wrote the first version of the ${n} helper and ran it on a few sample inputs`,
  `[SIM] Fixed an edge case found in testing for the ${n} helper and re-ran every sample`,
];

async function ensureListings(wallet, w) {
  if (w.listed) return;
  const sale = {
    productId: `sim-${w.name.toLowerCase()}-profiler`,
    priceUSDC: String(200_000 + Math.floor(Math.random() * 8) * 50_000),
    unlimitedInventory: true,
    content: b64(`// ${LABEL}\nmodule.exports = (rows) => ({ rows: rows.length, columns: Object.keys(rows[0] || {}) });\n`),
    contentType: "text/javascript",
    metadataURI: JSON.stringify({
      name: `[SIM] ${w.name} CSV profiler`,
      description: `${LABEL} Summarises rows and columns of a table.`,
      demonstrations: [{ input: [{ a: 1, b: 2 }], output: { rows: 1, columns: ["a", "b"] } }],
    }),
    declaration: DECL,
    iterations: 2,
    iterationLog: LOG2("profiler"),
  };
  const service = {
    productId: `sim-${w.name.toLowerCase()}-wordcount`,
    priceUSDC: String(20_000 + Math.floor(Math.random() * 6) * 10_000),
    unlimitedInventory: true,
    content: b64(`// ${LABEL}\nfunction tool(input) { return { words: String(input.text).split(/\\s+/).filter(Boolean).length }; }\n`),
    contentType: "text/javascript",
    metadataURI: JSON.stringify({
      name: `[SIM] ${w.name} word counter`,
      description: `${LABEL} A callable service: counts the words in a text.`,
      demonstrations: [{ input: { text: "a b c" }, output: { words: 3 } }],
    }),
    declaration: DECL,
    iterations: 2,
    iterationLog: LOG2("word counter"),
    service: {
      pricingModel: "PER_CALL",
      inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 2000 } }, required: ["text"] },
      outputSchema: { type: "object", properties: { words: { type: "integer" } }, required: ["words"] },
    },
  };
  for (const body of [sale, service]) {
    const r = await api("POST", `/api/v1/stores/${w.storeId}/products`, { key: w.apiKey, headers: idem(), body });
    if (r.status === 409) continue; // already listed
    if (r.status !== 201) throw fail(`list ${body.productId}`, r);
    await sendIntent(wallet, r.body.intent);
    log(`${w.name}: listed ${body.service ? "service" : "product"} ${body.productId}`);
  }
  w.listed = true;
}

/* ------------------------------------------------------------------ actions */

async function simProducts() {
  const r = await api("GET", "/api/v1/market/products?limit=100&q=SIM");
  return (r.body?.items ?? []).filter((p) => /\[SIM\]/.test(p.sellerContent?.metadataURI ?? ""));
}

async function buyProduct(wallet, w) {
  const items = (await simProducts()).filter((p) => p.mode === "SALE" && p.protocol.storeId !== w.storeId);
  if (!items.length) return "no product to buy";
  const p = pick(items).protocol;
  const r = await api("POST", `/api/v1/stores/${p.storeId}/products/${p.productId}/purchase`, {
    key: w.apiKey,
    headers: idem(),
    body: { units: 1, expectedVersion: p.version, maxTotalUSDC: p.priceUSDC.base },
  });
  if (r.status !== 201) throw fail("purchase", r);
  await sendIntent(wallet, r.body.intent);
  return `bought ${p.productId.slice(0, 10)}… for ${p.priceUSDC.display} USDC`;
}

async function callService(wallet, w) {
  const items = (await simProducts()).filter((p) => p.mode === "SERVICE" && p.protocol.storeId !== w.storeId);
  if (!items.length) return "no service to call";
  const p = pick(items).protocol;
  const key = `sim-call-${crypto.randomBytes(8).toString("hex")}`;
  const text = (await luna("Write one sentence a user might want word-counted, about any everyday topic.")) ??
    pick(["simulated call one two three", "a quick simulated test", "four simulated words here now"]);
  const body = { input: { text }, prepayCalls: 1 + Math.floor(Math.random() * 3) };
  let r = await api("POST", `/api/v1/services/${p.storeId}/${p.productId}/invoke`, { key: w.apiKey, headers: { "idempotency-key": key }, body });
  if (r.status === 402) {
    await sendIntent(wallet, r.body.error.details.pay);
    for (let t = 0; t < 10 && r.status === 402; t++) {
      await sleep(4000);
      r = await api("POST", `/api/v1/services/${p.storeId}/${p.productId}/invoke`, { key: w.apiKey, headers: { "idempotency-key": key }, body });
    }
  }
  if (r.status !== 200) throw fail("invoke", r);
  return `called service ${p.productId.slice(0, 10)}… -> ${r.body.state} ${JSON.stringify(r.body.output_UNTRUSTED ?? r.body.failure)}`;
}

async function tradeAIC(wallet, w, state) {
  const tokens = state.wallets.filter((x) => x.aicToken && x.address !== w.address).map((x) => x.aicToken);
  if (!tokens.length) return "no token to trade";
  const token = pick(tokens);
  if (Math.random() < 0.6) {
    const amount = String((1 + Math.floor(Math.random() * 5)) * 1_000_000);
    const r = await api("POST", `/api/v1/stocks/${token}/buy`, { key: w.apiKey, headers: idem(), body: { amount } });
    if (r.status !== 201) throw fail("buy AIC", r);
    await sendIntent(wallet, r.body.intent);
    return `bought ${Number(amount) / 1e6} USDC of ${token.slice(0, 10)}…`;
  }
  const erc20 = new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)"], provider);
  const held = await erc20.balanceOf(w.address);
  if (held === 0n) return "nothing to sell";
  const amount = (held * BigInt(20 + Math.floor(Math.random() * 40))) / 100n;
  const r = await api("POST", `/api/v1/stocks/${token}/sell`, { key: w.apiKey, headers: idem(), body: { amount: amount.toString() } });
  if (r.status !== 201) throw fail("sell AIC", r);
  await sendIntent(wallet, r.body.intent);
  return `sold part of a ${token.slice(0, 10)}… position`;
}

const LINES = [
  "Anyone tried the word counter services here? Looking for one that handles long texts.",
  "Listed a small CSV profiler, feedback welcome.",
  "Prices look reasonable on the simulated services so far.",
  "Which of these services has the lowest latency in your tests?",
  "Bought a profiler, it did what the description said.",
];
async function forumPost(_wallet, w) {
  const d = await api("GET", "/api/v1/forum/discussions?limit=20&q=SIMULATED");
  const threads = (d.body?.items ?? []).map((x) => x.discussion).filter((x) => /SIMULATED ACTIVITY/.test(x.message_UNTRUSTED ?? ""));
  const topic = pick([
    "asking which simulated word-counter service is fastest",
    "sharing that a simulated CSV profiler worked as described",
    "asking other simulated sellers what they plan to list next",
    "commenting on simulated store token prices moving today",
    "asking for feedback on a simulated product",
  ]);
  const written = await luna(`Write a forum message from a simulated market participant ${topic}.`);
  const message = `[SIMULATED ACTIVITY] ${written ?? pick(LINES)} (${LABEL})`;
  const body = threads.length && Math.random() < 0.8 ? { message, replyTo: pick(threads).id } : { message };
  const r = await api("POST", "/api/v1/forum", { key: w.apiKey, headers: idem(), body });
  if (r.status === 429 && !body.replyTo) return "discussion limit: skipped";
  if (r.status !== 201) throw fail("forum", r);
  return body.replyTo ? "replied in a simulated thread" : "opened a simulated discussion";
}

function findLicenses(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const x of node) findLicenses(x, out);
    return out;
  }
  if (node.licenseToken && (node.licenseId || node.tokenId)) out.push(node);
  for (const v of Object.values(node)) findLicenses(v, out);
  return out;
}
async function rate(wallet, w) {
  const me = await api("GET", "/api/v1/me", { key: w.apiKey });
  const lic = findLicenses(me.body);
  if (!lic.length) return "nothing to rate";
  const l = pick(lic);
  const id = String(l.licenseId ?? l.tokenId);
  const r = await api("POST", `/api/v1/licenses/${l.licenseToken}/${id}/signal`, {
    key: w.apiKey,
    headers: idem(),
    body: { worthIt: Math.random() < 0.8, note: `[SIMULATED ACTIVITY] simulated rating. ${LABEL}` },
  });
  if (r.status !== 201 && r.status !== 200) return `rating not open yet (${r.body?.error?.code ?? r.status})`;
  if (r.body?.intent) await sendIntent(wallet, r.body.intent);
  return "rated a purchase";
}

const ACTIONS = [
  [buyProduct, 3],
  [callService, 4],
  [tradeAIC, 1],
  [forumPost, 1],
  [rate, 1],
];

/* ------------------------------------------------------------------ trader fleet */

const exchangeAbi = [
  "function buy(address aicToken, uint256 grossUSDC, uint256 minTokensOut, uint256 deadline)",
  "function sell(address aicToken, uint256 tokensIn, uint256 minUSDCOut, uint256 deadline)",
];
const erc20Abi = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

/*
 * An explicit gas limit, and one retry: a load-balanced RPC node can estimate a trade against state from before
 * the approval it depends on was mined, and report a revert that would not happen.
 */
const GAS = { gasLimit: 500_000n };
async function settle(send) {
  try {
    const r = await (await send()).wait();
    if (r.status !== 1) throw new Error("reverted");
    return r;
  } catch {
    await sleep(4000);
    const r = await (await send()).wait();
    if (r.status !== 1) throw new Error("reverted on retry");
    return r;
  }
}

/** One random trade by one random trader: buy 1-15 USDC of a simulated token, or sell 10-80% of a holding. */
async function traderTrade(ctx, state) {
  const tokens = state.wallets.map((x) => x.aicToken).filter(Boolean);
  if (!tokens.length || !state.traders.length) return null;
  const t = pick(state.traders);
  const wallet = new ethers.Wallet(t.privateKey, provider);
  if (!t.funded) {
    await (await ctx.usdc.mint(t.address, 150_000_000n)).wait();
    t.funded = true;
    saveState(state);
  }
  const token = pick(tokens);
  const aic = new ethers.Contract(token, erc20Abi, wallet);
  const held = await aic.balanceOf(t.address);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const exchange = new ethers.Contract(ctx.exchange, exchangeAbi, wallet);
  if (held > 0n && Math.random() < 0.45) {
    const amount = (held * BigInt(10 + Math.floor(Math.random() * 71))) / 100n;
    await (await aic.approve(ctx.exchange, amount, GAS)).wait();
    await settle(() => exchange.sell(token, amount, 0n, deadline, GAS));
    return `trader ${t.address.slice(0, 8)}… sold ${ethers.formatUnits(amount, 18).slice(0, 10)} of ${token.slice(0, 8)}…`;
  }
  const usdcBal = await new ethers.Contract(ctx.usdcAddress, erc20Abi, provider).balanceOf(t.address);
  if (usdcBal < 20_000_000n) await (await ctx.usdc.mint(t.address, 100_000_000n)).wait();
  const amount = BigInt(1 + Math.floor(Math.random() * 15)) * 1_000_000n;
  await (await new ethers.Contract(ctx.usdcAddress, erc20Abi, wallet).approve(ctx.exchange, amount, GAS)).wait();
  await settle(() => exchange.buy(token, amount, 0n, deadline, GAS));
  return `trader ${t.address.slice(0, 8)}… bought ${Number(amount) / 1e6} USDC of ${token.slice(0, 8)}…`;
}
function weightedAction() {
  const total = ACTIONS.reduce((n, [, w]) => n + w, 0);
  let x = Math.random() * total;
  for (const [fn, wgt] of ACTIONS) if ((x -= wgt) < 0) return fn;
  return ACTIONS[0][0];
}

/* ------------------------------------------------------------------ main */

async function main() {
  if (!OPERATOR_KEY) throw new Error("No DEPLOYER_PRIVATE_KEY in the environment or contracts/.env");
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== 84532) throw new Error(`Refusing to run: RPC is chain ${net.chainId}, not Base Sepolia (84532)`);
  const status = await api("GET", "/api/v1/schema");
  const chain = Number(status.body?.chainId ?? status.body?.chain?.chainId ?? status.body?.protocol?.chainId ?? 0);
  if (chain && chain !== 84532) throw new Error(`Refusing to run: ${ORIGIN} serves chain ${chain}, not 84532`);

  const deployment = await api("GET", "/api/v1/contracts");
  const usdcAddress = deployment.body?.core?.canonicalUSDC?.address ?? deployment.body?.core?.canonicalUSDC;
  if (!usdcAddress) throw new Error("Could not read the canonical USDC address from /api/v1/contracts");
  const operator = new ethers.Wallet(OPERATOR_KEY, provider);
  const usdc = new ethers.Contract(usdcAddress, usdcAbi, operator);
  const ag = deployment.body?.core?.agentGoods;
  const exchange = ag?.proxy ?? ag?.address ?? ag;
  if (typeof exchange !== "string") throw new Error("Could not read the exchange address from /api/v1/contracts");
  const ctx = { operator, usdc, usdcAddress, exchange };

  const state = loadState();
  while (state.wallets.length < COUNT) {
    const w = ethers.Wallet.createRandom();
    state.wallets.push({ name: NAMES[state.wallets.length % NAMES.length], address: w.address, privateKey: w.privateKey });
  }
  state.traders ??= [];
  while (state.traders.length < TRADERS) {
    const w = ethers.Wallet.createRandom();
    state.traders.push({ address: w.address, privateKey: w.privateKey, funded: false });
  }
  saveState(state);
  log(`gpt-6-luna writing: ${OPENAI_KEY ? MODEL : "off (no OPENAI_API_KEY): fixed texts"}; ${state.traders.length} trader wallets`);
  log(`${state.wallets.length} simulated wallets on ${ORIGIN} — everything they create is labelled [SIM] / [SIMULATED ACTIVITY]`);

  for (const [i, w] of state.wallets.entries()) {
    const wallet = new ethers.Wallet(w.privateKey, provider);
    try {
      await topUpGas(operator, w.address, w.name);
      await ensureUsdc(usdc, w);
      await ensureKey(w);
      saveState(state);
      await ensureStore(wallet, w, i);
      saveState(state);
      await ensureListings(wallet, w);
      saveState(state);
    } catch (e) {
      log(`${w.name}: setup step failed — ${e.message}`);
    }
  }
  // Gas for the trader crowd, once per run, to 0.01 test ETH each (only the difference is sent).
  let topped = 0;
  for (const t of state.traders) {
    try {
      if (await topUpGas(operator, t.address, `trader ${t.address.slice(0, 8)}…`)) topped++;
    } catch (e) {
      log(`trader ${t.address.slice(0, 8)}…: gas top-up failed — ${e.message}`);
    }
  }
  log(`trader gas: ${topped} of ${state.traders.length} topped up to 0.01 test ETH, the rest already had it`);
  if (ARGS.has("--setup-only")) return;

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    log("stopping after this action (Ctrl+C again to force)");
    process.on("SIGINT", () => process.exit(1));
  });
  let round = 0;
  while (!stop) {
    const w = pick(state.wallets.filter((x) => x.apiKey && x.storeId));
    if (!w) {
      log("no simulated wallet is ready yet");
      break;
    }
    const wallet = new ethers.Wallet(w.privateKey, provider);
    const action = weightedAction();
    try {
      if (round % 10 === 0) await ensureUsdc(usdc, w);
      const what = await action(wallet, w, state);
      log(`${w.name}: ${what}`);
    } catch (e) {
      log(`${w.name}: ${action.name} failed — ${e.message}`);
    }
    // The crowd: 1-4 random trades by random trader wallets every round.
    const trades = 1 + Math.floor(Math.random() * 4);
    for (let k = 0; k < trades && !stop; k++) {
      try {
        const what = await traderTrade(ctx, state);
        if (what) log(what);
      } catch (e) {
        log(`trader trade failed — ${String(e.shortMessage ?? e.message).slice(0, 140)}`);
      }
    }
    round++;
    if (ARGS.has("--once")) break;
    await sleep(INTERVAL_MS * (0.5 + Math.random()));
  }
}

main().catch((e) => {
  console.error(`[sim] ${e.message}`);
  process.exit(1);
});
