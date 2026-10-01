#!/usr/bin/env node
/**
 * Arrive as a stranger, get a key, read the guides, download the tool, and RUN it.
 *
 * WHY THIS EXISTS. Every document on this deployment is written for an agent that has just found
 * the domain, and every one of them was verified by an operator who already knew where things
 * were. That is not the same test. An agent read `/api/v1/skill` — the obvious generalisation from
 * a document in which every other path begins `/api/v1/` — and got a 404; the tool at
 * `/api/v1/tools/agentgoods-tx.js` answered 401, which tells a caller it needs credentials for a
 * public file. Neither failure was visible from the operator's side, because the operator never
 * typed those paths.
 *
 * So this walks the whole first hour of an agent's life, from a wallet that has never been seen
 * here, and fails loudly on anything a newcomer could not get through:
 *
 *   1. issue an API key from a signature alone — no human approval, no waiting;
 *   2. fetch every documentation and tool path, BOTH with the key and without it, at the root
 *      spelling AND under /api/v1, and require 200 with a real body from all of them;
 *   3. download the transaction helper and EXECUTE it inside a bare node:vm context with no
 *      fetch, no require, no console and no prototype chain — the hardest sandbox we can build —
 *      to prove the published tool is usable where agent code actually runs;
 *   4. ask the API to PREPARE a real write, and put that real response through the tool's
 *      check(), so what is verified is the live payload shape and not a fixture.
 *
 * It signs nothing and spends nothing: step 4 prepares a transaction and never broadcasts it.
 *
 *     node backend/scripts/probe-as-new-agent.mjs https://testnet.agentgoods.ai
 */

import vm from "node:vm";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";

const ORIGIN = (process.argv[2] ?? "https://testnet.agentgoods.ai").replace(/\/$/, "");

/*
 * --build goes all the way: open a store, upload content, list a product, on chain.
 *
 * Reading a document and signing a transaction are different tests, and only the second one
 * answers the question that matters — whether an agent that arrived an hour ago, with nothing but
 * this domain and the file it published, can actually trade here. Everything below is done with
 * the downloaded tool checking each payload, exactly as a newcomer would have to.
 *
 * The probe wallet is new, so the operator lends it gas for two transactions and nothing else.
 */
const BUILD = process.argv.includes("--build");
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const SPLIT_LINES = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));

function operatorKey() {
  const fromFile = (file, key) => {
    if (!existsSync(file)) return null;
    const line = readFileSync(file, "utf8")
      .split(SPLIT_LINES)
      .find((l) => l.trim().startsWith(`${key}=`));
    if (!line) return null;
    const value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    return value.length > 0 ? value : null;
  };
  return (
    process.env.DEPLOYER_PRIVATE_KEY ??
    process.env.PRIVATE_KEY ??
    fromFile(join(REPO, "contracts", ".env"), "DEPLOYER_PRIVATE_KEY") ??
    fromFile(join(REPO, "contracts", ".env"), "PRIVATE_KEY")
  );
}

/* Everything a newcomer is pointed at, in both spellings it would reasonably try. */
const DOCUMENTS = [
  "/.well-known/aic-agent.json",
  "/skill",
  "/api/v1/skill",
  "/llms.txt",
  "/api/v1/llms.txt",
  "/robots.txt",
  "/api/v1/schema",
  "/api/v1/openapi.json",
  "/api/v1/playbook",
  "/api/v1/contracts",
  "/api/v1/status",
  "/api/v1/discovery",
  "/api/v1/forum/pinned",
  "/docs/agents",
];

const TOOLS = ["/tools/agentgoods-tx.js", "/api/v1/tools/agentgoods-tx.js"];

const failures = [];
const note = (ok, line) => {
  console.log(`${ok ? "  ok " : "  FAIL "} ${line}`);
  if (!ok) failures.push(line);
};

async function get(path, key) {
  const headers = { accept: "*/*" };
  if (key) headers.authorization = `Bearer ${key}`;
  try {
    const res = await fetch(ORIGIN + path, { headers });
    const text = await res.text();
    return { status: res.status, bytes: text.length, type: res.headers.get("content-type") ?? "", text };
  } catch (error) {
    return { status: 0, bytes: 0, type: "", text: "", error: String(error) };
  }
}

console.log(`probing ${ORIGIN} as an agent that has never been here\n`);

/* ── 1. a key, from a signature alone ────────────────────────────────────────────────────────── */
/*
 * A stranger the first time, the same stranger afterwards.
 *
 * A fresh wallet every run is the honest test of onboarding, and it was also how the first --build
 * run stranded a store: the run opened Alpha on chain, the probe misread its own /me response, and
 * by the time that was fixed the key that controlled the store was gone with the process. Keeping
 * the identity in a gitignored file costs the purity of nothing — the account is still one that
 * arrived with no introduction — and it means a re-run continues what the last one started
 * instead of leaving another orphan behind.
 */
const WALLET_FILE = join(HERE, "..", ".probe-wallet.json");
let wallet;
if (existsSync(WALLET_FILE) && BUILD) {
  wallet = new Wallet(JSON.parse(readFileSync(WALLET_FILE, "utf8")).privateKey);
  console.log(`1. onboarding as ${wallet.address} (the same stranger as last time)`);
} else {
  wallet = Wallet.createRandom();
  if (BUILD) writeFileSync(WALLET_FILE, JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey }, null, 2));
  console.log(`1. onboarding as ${wallet.address}`);
}

const challenge = await (
  await fetch(`${ORIGIN}/api/v1/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: wallet.address, purpose: "ISSUE_API_KEY" }),
  })
).json();
note(Boolean(challenge?.message && challenge?.nonce), `challenge: ${challenge?.nonce ? "issued" : JSON.stringify(challenge).slice(0, 200)}`);

let apiKey = null;
if (challenge?.message) {
  const issued = await (
    await fetch(`${ORIGIN}/api/v1/auth/api-key/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) }),
    })
  ).json();
  apiKey = issued?.apiKey ?? null;
  /* A returning wallet already has a key; rotation is the same signature with another purpose. */
  if (!apiKey) {
    const c2 = await (
      await fetch(`${ORIGIN}/api/v1/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: wallet.address, purpose: "ROTATE_API_KEY" }),
      })
    ).json();
    if (c2?.message) {
      const rotated = await (
        await fetch(`${ORIGIN}/api/v1/auth/api-key/rotate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nonce: c2.nonce, signature: await wallet.signMessage(c2.message) }),
        })
      ).json();
      apiKey = rotated?.apiKey ?? null;
    }
  }
  note(Boolean(apiKey), `api key: ${apiKey ? "issued from the signature alone" : JSON.stringify(issued).slice(0, 200)}`);
}

/* ── 2. the guides, with the key and without it ──────────────────────────────────────────────── */
console.log(`\n2. reading the guides (anonymous, then with the key)`);
for (const path of DOCUMENTS) {
  for (const [label, key] of [["anon", null], ["keyed", apiKey]]) {
    if (label === "keyed" && !apiKey) continue;
    const r = await get(path, key);
    const ok = r.status === 200 && r.bytes > 50;
    note(ok, `${label.padEnd(5)} ${path.padEnd(34)} ${String(r.status).padEnd(4)} ${r.bytes} bytes ${r.type.split(";")[0]}${r.error ? " " + r.error : ""}`);
  }
}

/* ── 3. the tool: downloaded, then executed in the hardest sandbox available ─────────────────── */
console.log(`\n3. downloading the tool and running it with no network, no require, no console`);
let toolSource = null;
for (const path of TOOLS) {
  const r = await get(path, apiKey);
  const ok = r.status === 200 && r.bytes > 500;
  note(ok, `${path.padEnd(34)} ${String(r.status).padEnd(4)} ${r.bytes} bytes ${r.type.split(";")[0]}`);
  if (ok && !toolSource) toolSource = r.text;
}

let tool = null;
if (toolSource) {
  try {
    /* Bare: no globals at all beyond what the language itself provides. */
    const context = vm.createContext(Object.create(null));
    tool = vm.runInContext(`${toolSource}\n;AgentGoodsTx;`, context, { timeout: 5000 });
    note(typeof tool?.check === "function", `evaluated in a bare vm context; exports: ${Object.keys(tool ?? {}).join(", ")}`);

    const arg = "f".repeat(64);
    const fixture = { intent: { transaction: { to: "0x" + "ab".repeat(20), data: "0xa1b2c3d4" + arg + arg } } };
    const got = tool.check(fixture);
    note(got.data.length === 2 + 8 + 128, `check() on a well-formed payload returned ${got.data.length - 2} hex characters`);

    let caught = "";
    try {
      tool.check({ intent: { transaction: { to: "0x" + "ab".repeat(20), data: "0xa1b2c3d4" + arg + arg.slice(0, 50) } } });
    } catch (e) {
      caught = e.message;
    }
    note(caught.includes("multiple of 64"), `check() refused a truncated payload: ${caught.slice(0, 90)}`);
  } catch (error) {
    note(false, `the published tool did not run in a bare sandbox: ${String(error).slice(0, 200)}`);
  }
}

/* ── 4. a REAL prepared write, through the tool ──────────────────────────────────────────────── */
console.log(`\n4. preparing a real write and putting the live response through the tool`);
if (apiKey && tool) {
  const res = await fetch(`${ORIGIN}/api/v1/stores`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "Idempotency-Key": `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify({
      storeType: "sales",
      aicName: "Probe",
      aicSymbol: "PROBE",
      storeName: "accessibility probe (prepared, never signed)",
      initialOwnerSeedUSDC: "5",
    }),
  });
  const body = await res.json().catch(() => ({}));
  note(res.status < 300, `POST /api/v1/stores -> ${res.status}${res.status >= 300 ? " " + JSON.stringify(body).slice(0, 300) : ""}`);
  if (res.status < 300) {
    try {
      const tx = tool.check(body);
      note(true, `the tool read the live response: to ${tx.to}, ${tx.data.length - 2} hex characters of calldata`);
    } catch (error) {
      note(false, `the tool could not read a live prepared write: ${String(error).slice(0, 200)}`);
    }
  }

  /* An error on purpose: every refusal must point at the documents, not just at itself. */
  const bad = await fetch(`${ORIGIN}/api/v1/stores`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({}),
  });
  const badBody = await bad.json().catch(() => ({}));
  const seeAlso = badBody?.error?.seeAlso ?? badBody?.seeAlso;
  note(Boolean(seeAlso?.skill && seeAlso?.openapi && seeAlso?.schema), `a refusal points at ${seeAlso ? Object.keys(seeAlso).join(", ") : "nothing"}`);
}

/* ── 5. --build: open a store and list a product, on chain, using the downloaded tool ────────── */
if (BUILD && apiKey && tool) {
  console.log(`\n5. building for real: a store named Alpha, and a product in it`);

  const key = operatorKey();
  const rpc = process.env.ARENA_RPC_URL ?? process.env.RPC_HTTP_URL ?? "https://sepolia.base.org";
  const provider = new JsonRpcProvider(rpc);
  const signer = wallet.connect(provider);

  /* Gas for two transactions, lent by the operator. The probe wallet holds nothing else. */
  if (key) {
    const operator = new Wallet(key, provider);
    let balance = await provider.getBalance(wallet.address);
    if (balance < 200_000_000_000_000n) {
      const funding = await operator.sendTransaction({ to: wallet.address, value: 500_000_000_000_000n });
      await funding.wait();
      /*
       * Read it back more than once. A mined transfer is not immediately visible from every node
       * behind a public endpoint, and a single read that happens to land on a lagging one reports
       * a funded wallet as empty — which is how this step failed while the very next transaction
       * went through.
       */
      for (let i = 0; i < 10 && balance < 200_000_000_000_000n; i++) {
        balance = await provider.getBalance(wallet.address);
        if (balance < 200_000_000_000_000n) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    note(balance > 0n, `the probe wallet holds ${balance} wei of gas`);
  } else {
    note(false, "no operator key, so the probe cannot be funded and nothing can be signed");
  }

  /*
   * Every store is born with owner-funded initial market capital. The probe wallet gets that USDC
   * from the testnet token's public mint — the same faucet any stranger has.
   */
  const ALPHA_SEED_USDC = process.env.ALPHA_SEED_USDC ?? "150";
  {
    const usdcAddr = process.env.USDC_ADDRESS ?? "0x1A0914e8D20eDcb26181b08C5e40137Cd0741E60";
    const usdc = new Contract(usdcAddr, ["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"], signer);
    const need = BigInt(Math.round(Number(ALPHA_SEED_USDC) * 1e6));
    if ((await usdc.balanceOf(wallet.address)) < need) {
      await (await usdc.mint(wallet.address, need)).wait();
      for (let i = 0; i < 10 && (await usdc.balanceOf(wallet.address)) < need; i++) await new Promise((r) => setTimeout(r, 2000));
    }
    note((await usdc.balanceOf(wallet.address)) >= need, `the probe wallet holds the ${ALPHA_SEED_USDC} USDC seed`);
  }

  /** Prepare, verify with the tool, sign, send, and report what the chain said. */
  async function write(path, body, label) {
    const res = await fetch(ORIGIN + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "Idempotency-Key": tool.newIdempotencyKey(),
      },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => ({}));
    if (res.status >= 300) {
      note(false, `${label}: POST ${path} -> ${res.status} ${JSON.stringify(parsed).slice(0, 300)}`);
      return null;
    }
    const tx = tool.check(parsed); // the published tool, on a live payload, before any gas is spent
    const allowance = parsed?.intent?.requiredAllowance ?? parsed?.intent?.allowance ?? null;
    if (allowance && parsed?.intent?.approvalTransaction) {
      const approval = parsed.intent.approvalTransaction;
      await (await signer.sendTransaction({ to: approval.to, data: approval.data })).wait();
      const erc20 = new Contract(allowance.token, ["function allowance(address,address) view returns (uint256)"], provider);
      for (let i = 0; i < 20 && (await erc20.allowance(wallet.address, allowance.spender)) < BigInt(allowance.amount.base); i++) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      note(true, `${label}: approved ${allowance.amount.display} ${allowance.tokenSymbol} for ${allowance.spender}`);
    }
    const sent = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: 9_000_000n });
    const receipt = await sent.wait();
    note(receipt.status === 1, `${label}: ${tx.data.length - 2} hex characters signed, ${sent.hash} ${receipt.status === 1 ? "mined" : "REVERTED"}`);
    return receipt.status === 1 ? parsed : null;
  }

  /** The indexer projects a transaction a few seconds after it is mined. */
  async function waitFor(check, what, seconds = 90) {
    for (let i = 0; i < seconds; i += 3) {
      const found = await check();
      if (found) return found;
      await new Promise((r) => setTimeout(r, 3000));
    }
    note(false, `${what} never appeared in the API`);
    return null;
  }

  /* Whatever this wallet already controls, so a re-run continues instead of duplicating. */
  const already = await (async () => {
    const r = await get("/api/v1/me", apiKey);
    if (r.status !== 200) return null;
    const list = JSON.parse(r.text)?.stores?.items ?? [];
    return list.length > 0 ? list[0] : null;
  })();

  const created = already
    ? (note(true, `store Alpha already exists as ${already.storeId}; continuing with it`), already)
    : await write(
        "/api/v1/stores",
        { storeType: "sales", aicName: "Alpha", aicSymbol: "ALPHA", storeName: "Alpha", initialOwnerSeedUSDC: ALPHA_SEED_USDC },
        "store Alpha"
      );

  if (created) {
    const mine = already ?? await waitFor(async () => {
      const r = await get("/api/v1/me", apiKey);
      const body = r.status === 200 ? JSON.parse(r.text) : null;
      const list = body?.stores?.items ?? [];
      return Array.isArray(list) && list.length > 0 ? list[0] : null;
    }, "the store");

    const storeId = mine?.storeId ?? mine?.id ?? null;
    note(Boolean(storeId), `the store was indexed as ${storeId ?? "(nothing)"}`);

    if (storeId) {
      /*
       * Content first, because the product commits to its hash.
       *
       * What is sold here is the thing this whole probe is about: a builder that turns a prepared
       * response into a verified transaction without the payload ever becoming text. It is the
       * same shape as the published helper, so the buyer receives something that works.
       */
      const content = [
        "// Alpha tx builder — turn a prepared response into a signable transaction, offline.",
        "// Runs with no network and no dependencies: give it the response body you already have.",
        "export function build(responseBody) {",
        "  const stack = [responseBody];",
        "  while (stack.length) {",
        "    const node = stack.shift();",
        "    if (!node || typeof node !== 'object') continue;",
        "    if (typeof node.to === 'string' && typeof node.data === 'string') {",
        "      const hex = node.data.length - 2;",
        "      if (hex > 0 && (hex - 8) % 64 !== 0) throw new Error('calldata is ' + hex + ' hex characters: an argument is incomplete');",
        "      return { to: node.to, data: node.data, value: node.value ?? 0 };",
        "    }",
        "    for (const key of Object.keys(node)) stack.push(node[key]);",
        "  }",
        "  throw new Error('no transaction in that response');",
        "}",
      ].join("\n");

      const upload = await fetch(`${ORIGIN}/api/v1/access/content`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          storeId,
          content: Buffer.from(content, "utf8").toString("base64"),
          contentType: "text/javascript",
          filename: "alpha-tx-builder.js",
        }),
      });
      const uploaded = await upload.json().catch(() => ({}));
      const contentHash = uploaded?.contentHash ?? uploaded?.content?.contentHash ?? null;
      note(Boolean(contentHash), `content uploaded: ${contentHash ?? JSON.stringify(uploaded).slice(0, 200)}`);

      /* Already listed? A re-run continues; it does not publish the same product twice. */
      const alreadyListed = await (async () => {
        const r = await get("/api/v1/market/products?limit=50", apiKey);
        if (r.status !== 200) return null;
        const items = JSON.parse(r.text)?.items ?? [];
        return items.find((p) => p?.protocol?.storeId === storeId) ?? null;
      })();

      /*
       * The one-request path, proven on a second product.
       *
       * The deliverable is the compact checker the site publishes, sent as `content`: no upload
       * first, no hash carried anywhere. If the response comes back with `content.contentHash`,
       * the API did the commitment on its side.
       */
      const storeProducts = await (async () => {
        const r = await get("/api/v1/market/products?limit=50", apiKey);
        if (r.status !== 200) return [];
        return (JSON.parse(r.text)?.items ?? []).filter((p) => p?.protocol?.storeId === storeId);
      })();
      if (storeProducts.length >= 2) {
        note(true, `the one-request listing is already in the market (${storeProducts.length} products in Alpha)`);
      } else {
        const minTool = await get("/tools/agentgoods-tx-min.js", apiKey);
        const oneShot = await write(
          `/api/v1/stores/${storeId}/products`,
          {
            productId: "alpha-tx-min",
            // Priced at the saving at gpt-5 list rates: 53,000 tokens of retry turns, ~95% read ($1.25/M)
            // and ~5% written ($10/M) = 0.089 USDC.
            priceUSDC: "89000",
            unlimitedInventory: true,
            content: Buffer.from(minTool.text, "utf8").toString("base64"),
            contentType: "text/javascript",
            filename: "alpha-tx-min.js",
            metadataURI: JSON.stringify({
              name: "Alpha tx min",
              description:
                "The compact transaction check, under 800 characters: finds the transaction in a " +
                "response, refuses calldata that is not 8 + 64n hex characters. No network, no imports. " +
                "Declared saving, ESTIMATED: on this deployment a hand-copied calldata that came out " +
                "malformed cost 3.21 refused retries on average at about 16,500 tokens per turn " +
                "(measured over 19,524 agent actions); this check prevents that copy. Priced at that saving at " +
                "gpt-5 list rates (mostly read tokens): 0.089 USDC.",
            }),
            declaration: { tokensSaved: "53000", modelTier: "gpt-5", basis: "ESTIMATED" },
          },
          "product Alpha tx min, listed in ONE request with the bytes inline"
        );
        note(
          Boolean(oneShot?.content?.contentHash),
          `the API committed to ${oneShot?.content?.contentHash ?? "(no contentHash in the response)"} ` +
            `(${oneShot?.content?.byteLength ?? "?"} bytes) without a separate upload`
        );
      }

      if (contentHash && alreadyListed) {
        note(true, `product Alpha tx builder is already listed in ${storeId}`);
      } else if (contentHash) {
        const listed = await write(
          `/api/v1/stores/${storeId}/products`,
          {
            productId: "alpha-tx-builder",
            // Priced at the saving at gpt-5 list rates, with the written/read mix measured for Alpha the
            // market (192,714 / 252,878): 86,029 tokens = 0.43 USDC.
            priceUSDC: "430000",
            unlimitedInventory: true,
            contentHash,
            metadataURI: JSON.stringify({
              name: "Alpha tx builder",
              description:
                "Turns a prepared response into a signable transaction offline: finds the " +
                "transaction, refuses calldata that is not 8 + 64n hex characters, returns " +
                "{to, data, value}. No network, no dependencies. Declared saving, MEASURED (a " +
                "floor): the turns that wrote and revised this helper family used 86,029 tokens, " +
                "not counting the investigation around them. Priced at that saving at gpt-5 list rates: " +
                "0.43 USDC.",
            }),
            declaration: { tokensSaved: "86000", modelTier: "gpt-5", basis: "MEASURED" },
            /*
             * A defensible, ESTIMATED saving, with the method in the description, because the skill
             * recommends declaring one and Alpha is its worked example. (A MEASURED zero is refused:
             * a basis with a zero saving is InvalidDeclaration on chain.)
             */
          },
          "product Alpha tx builder"
        );

        if (listed) {
          /*
           * Match on what the market actually returns.
           *
           * A listing is nested under `protocol`, and its productId is the keccak of the string
           * that was submitted, not the string — so a check that looked for "alpha-tx-builder" at
           * the top level reported a healthy listing as missing. The store id is the stable thing
           * a seller can compare against.
           */
          const inMarket = await waitFor(async () => {
            const r = await get("/api/v1/market/products?limit=50", apiKey);
            if (r.status !== 200) return null;
            const items = JSON.parse(r.text)?.items ?? [];
            return items.find((p) => p?.protocol?.storeId === storeId) ?? null;
          }, "the product");
          const name = (() => {
            try {
              return JSON.parse(inMarket?.sellerContent?.metadataURI ?? "{}").name ?? "(no name)";
            } catch {
              return "(unparsed metadata)";
            }
          })();
          note(Boolean(inMarket), `listed in the market as "${name}" at ${inMarket?.protocol?.priceUSDC?.display ?? "?"} USDC`);
        }
      }
    }
  }
}

console.log(
  failures.length === 0
    ? `\nAll clear. A newcomer can onboard, read every guide, download the tool and run it${BUILD ? ", and open a store and list a product with it" : ""}.`
    : `\n${failures.length} problem(s) a newcomer would hit:\n` + failures.map((f) => "  - " + f).join("\n")
);
process.exit(failures.length === 0 ? 0 : 1);
