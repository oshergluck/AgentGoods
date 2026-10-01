/**
 * Callable services, end to end: a real chain, the real indexer projection, the real service runner.
 *
 * A service is a product in a Sales store whose listing commits a spec; a buyer prepays calls as units
 * through the ordinary purchase, and the gateway runs each call on the runner. These tests hold the
 * invariants that matter: a call runs and charges once per Idempotency-Key, a failed call is never
 * charged, commerce and the buyback are exactly the store's ordinary settlement, the code is never
 * delivered, and control of the business — with its history — passes on takeover.
 */
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Contract, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { createHarness, startChain, deployProtocol, stopChain, USDC, type Harness, createStoreOnChain } from "./helpers/harness";
import { Purchase, Store } from "../src/db/models";

let h: Harness;
let runner: ChildProcess;
const RUNNER_TOKEN = "runner-test-token-0123456789abcdef";
const RUNNER_PORT = 19_000 + Math.floor(Math.random() * 500);

const idem = (p = "k") => ({ "idempotency-key": `${p}-${Math.random().toString(36).slice(2)}` });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const send = async (wallet: Wallet, intent: any) => {
  const t = intent.transaction as { to: string; data: string; value?: string };
  return (await (await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value ?? "0") })).wait())!;
};

async function freshWallet(): Promise<Wallet> {
  const wallet = Wallet.createRandom().connect(h.provider) as Wallet;
  await (await h.signers[0]!.sendTransaction({ to: wallet.address, value: 10n ** 18n })).wait();
  return wallet;
}

async function issueApiKey(wallet: Wallet): Promise<string> {
  const challenge = await h.request("POST", "/api/v1/auth/challenge", { body: { wallet: wallet.address, purpose: "ISSUE_API_KEY" } });
  const signature = await wallet.signMessage(challenge.body.message as string);
  const issued = await h.request("POST", "/api/v1/auth/api-key/issue", { body: { nonce: challenge.body.nonce, signature } });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return issued.body.apiKey as string;
}

async function fundUsdc(wallet: Wallet, spender: string, amount: bigint) {
  await (await (h.contracts.usdc.connect(h.signers[0]!) as Contract).mint(wallet.address, amount)).wait();
  await (await (h.contracts.usdc.connect(wallet) as Contract).approve(spender, amount)).wait();
}

const CODE = `
function tool(input) {
  if (input.mode === "fail") throw new Error("asked to fail");
  if (input.mode === "badout") return { wrong: true };
  return { words: input.text.split(/\\s+/).filter(Boolean).length };
}`;
const SPEC = {
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 1000 }, mode: { type: "string", enum: ["ok", "fail", "badout"] } },
    required: ["text"],
    additionalProperties: false,
  },
  outputSchema: { type: "object", properties: { words: { type: "integer" } }, required: ["words"], additionalProperties: false },
};
const DECL = { inputTokens: "120000", reasoningTokens: "8000", outputTokens: "4000", modelTier: "gpt-6-luna", basis: "ESTIMATED" };
const LOG = ["Wrote the word counter and ran it on five sample texts", "Fixed empty input returning 1 and re-ran every sample"];

let seller: Wallet;
let sellerKey: string;
let storeId: string;
let storeAddress: string;
let aicAddress: string;
const PID = "word-count-service";
const productId = keccak256(toUtf8Bytes(PID));

before(async () => {
  runner = spawn(process.execPath, [path.join(__dirname, "..", "..", "service-runner", "server.js")], {
    env: { ...process.env, PORT: String(RUNNER_PORT), RUNNER_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("runner did not start")), 15_000);
    runner.stdout!.on("data", (d) => String(d).includes("listening") && (clearTimeout(t), resolve()));
  });
  process.env.SERVICE_RUNNER_URL = `http://127.0.0.1:${RUNNER_PORT}`;
  process.env.SERVICE_RUNNER_TOKEN = RUNNER_TOKEN;
  await startChain();
  await deployProtocol();
  h = await createHarness();

  seller = await freshWallet();
  sellerKey = await issueApiKey(seller);
  const receipt = await (await createStoreOnChain(h, seller, 0, "Counter AIC", "CNT", "Counter Works")).wait();
  const created = receipt!.logs
    .map((l) => {
      try {
        return h.contracts.factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "StoreCreated")!;
  storeId = created.args.storeId as string;
  storeAddress = created.args.store as string;
  aicAddress = created.args.aicToken as string;
  await h.sync();
});

after(async () => {
  await h?.stop();
  await stopChain();
  runner?.kill();
  delete process.env.SERVICE_RUNNER_URL;
  delete process.env.SERVICE_RUNNER_TOKEN;
});

function listing(extra: Record<string, unknown> = {}) {
  return {
    productId: PID,
    priceUSDC: "30000",
    unlimitedInventory: true,
    content: b64(CODE),
    contentType: "application/javascript",
    metadataURI: JSON.stringify({ name: "Word counter", description: "Counts words in a text.", demonstrations: [{ input: { text: "a b c" }, output: { words: 3 } }] }),
    declaration: DECL,
    iterations: 2,
    iterationLog: LOG,
    service: SPEC,
    ...extra,
  };
}

describe("Services: listing", { concurrency: 1 }, () => {
  test("refuses a spec the gateway cannot enforce, and a service without code", async () => {
    const badSpec = await h.request("POST", `/api/v1/stores/${storeId}/products`, {
      apiKey: sellerKey,
      headers: idem(),
      body: listing({ productId: "bad-spec", service: { inputSchema: { type: "string", pattern: "(a+)+$" }, outputSchema: { type: "object" } } }),
    });
    assert.equal(badSpec.status, 400, JSON.stringify(badSpec.body));
    assert.match(JSON.stringify(badSpec.body), /pattern: not supported/);

    const noCode = await h.request("POST", `/api/v1/stores/${storeId}/products`, {
      apiKey: sellerKey,
      headers: idem(),
      body: { ...listing({ productId: "no-code" }), content: undefined, contentHash: keccak256(toUtf8Bytes("x")) },
    });
    assert.equal(noCode.status, 400, JSON.stringify(noCode.body));

    const brokenCode = await h.request("POST", `/api/v1/stores/${storeId}/products`, {
      apiKey: sellerKey,
      headers: idem(),
      body: listing({ productId: "broken", content: b64("function tool( {") }),
    });
    assert.equal(brokenCode.status, 400, JSON.stringify(brokenCode.body));
    assert.match(JSON.stringify(brokenCode.body), /cannot be called/);
  });

  test("lists a service; the market, the service list and the descriptor describe it", async () => {
    const res = await h.request("POST", `/api/v1/stores/${storeId}/products`, { apiKey: sellerKey, headers: idem(), body: listing() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await send(seller, res.body.intent)).status, 1);
    await h.sync();

    const market = await h.request("GET", "/api/v1/market/products?mode=SERVICE");
    const item = market.body.items.find((p: any) => p.protocol.productId === productId);
    assert.ok(item, "listed under mode=SERVICE");
    assert.equal(item.mode, "SERVICE");
    assert.equal(item.service.pricePerCall.display, "0.03");
    const sales = await h.request("GET", "/api/v1/market/products?mode=SALE");
    assert.ok(!sales.body.items.some((p: any) => p.protocol.productId === productId), "not listed as a sale");

    const list = await h.request("GET", "/api/v1/services");
    assert.ok(list.body.items.some((s: any) => s.productId === productId));

    const d = await h.request("GET", `/api/v1/services/${storeId}/${productId}`);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.inputSchema, SPEC.inputSchema);
    assert.deepEqual(d.body.outputSchema, SPEC.outputSchema);
    assert.equal(d.body.pricingModel, "PER_CALL");
    assert.equal(d.body.invoke.method, "POST");
    assert.equal(d.body.development.iterations, 2);
    assert.equal(d.body.declaration.declared, true);
    assert.equal(d.body.metrics.callsTotal, 0);
  });
});

describe("Services: invocation", { concurrency: 1 }, () => {
  let buyer: Wallet;
  let buyerKey: string;
  const invoke = (key: string, headers: Record<string, string>, body: unknown) =>
    h.request("POST", `/api/v1/services/${storeId}/${productId}/invoke`, { apiKey: key, headers, body });

  test("refuses without an Idempotency-Key, and refuses input that breaks the schema", async () => {
    buyer = await freshWallet();
    buyerKey = await issueApiKey(buyer);
    const noKey = await invoke(buyerKey, {}, { input: { text: "hi" } });
    assert.equal(noKey.status, 400);
    const bad = await invoke(buyerKey, idem(), { input: { text: 5, extra: true } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error.code, "SERVICE_INPUT_INVALID");
    assert.ok(bad.body.error.details.problems.length >= 2);
    assert.ok(bad.body.error.howToFix);
  });

  test("with no prepaid call: 402 with a purchase to sign; after paying, the same key runs once and charges once", async () => {
    const key = idem("first");
    const unpaid = await invoke(buyerKey, key, { input: { text: "one two three" }, prepayCalls: 3 });
    assert.equal(unpaid.status, 402, JSON.stringify(unpaid.body));
    assert.equal(unpaid.body.error.code, "PAYMENT_REQUIRED");
    assert.equal(unpaid.body.error.details.state, "PAYMENT_PREPARED");
    assert.equal(unpaid.body.error.details.quote.total.display, "0.09");

    // Retrying before paying never runs the code.
    const stillUnpaid = await invoke(buyerKey, key, { input: { text: "one two three" }, prepayCalls: 3 });
    assert.equal(stillUnpaid.status, 402);

    await fundUsdc(buyer, storeAddress, 90_000n);
    assert.equal((await send(buyer, unpaid.body.error.details.pay)).status, 1);
    await h.sync();

    const paid = await invoke(buyerKey, key, { input: { text: "one two three" } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.state, "SUCCEEDED");
    assert.equal(paid.body.charged, true);
    assert.deepEqual(paid.body.output_UNTRUSTED, { words: 3 });
    assert.equal(paid.body.prepaidCallsLeft, 2);

    const replay = await invoke(buyerKey, key, { input: { text: "one two three" } });
    assert.equal(replay.body.callId, paid.body.callId);
    assert.equal(replay.body.replayed, true);
    const credits = await h.request("GET", `/api/v1/services/${storeId}/${productId}/credits`, { apiKey: buyerKey });
    assert.equal(credits.body.left, 2, "a replay never spends a second call");

    const conflict = await invoke(buyerKey, key, { input: { text: "different" } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
  });

  test("a failed call is never charged: a thrown error and output that breaks the outputSchema", async () => {
    const thrown = await invoke(buyerKey, idem(), { input: { text: "x", mode: "fail" } });
    assert.equal(thrown.status, 200);
    assert.equal(thrown.body.state, "FAILED");
    assert.equal(thrown.body.charged, false);
    assert.equal(thrown.body.failure.code, "SERVICE_ERROR");
    const badOut = await invoke(buyerKey, idem(), { input: { text: "x", mode: "badout" } });
    assert.equal(badOut.body.state, "FAILED");
    assert.equal(badOut.body.failure.code, "OUTPUT_SCHEMA_MISMATCH");
    const credits = await h.request("GET", `/api/v1/services/${storeId}/${productId}/credits`, { apiKey: buyerKey });
    assert.equal(credits.body.left, 2, "failed calls released their prepaid calls");
  });

  test("the code is never delivered: a service license cannot be collected as a download", async () => {
    const me = await h.request("GET", "/api/v1/me", { apiKey: buyerKey });
    const lic = (me.body.licenses?.items ?? me.body.licenses ?? []).find((l: any) => String(l.productId) === productId);
    assert.ok(lic, JSON.stringify(me.body.licenses).slice(0, 400));
    const grant = await h.request("POST", "/api/v1/access/grant", {
      apiKey: buyerKey,
      body: { licenseToken: lic.licenseToken, licenseId: String(lic.licenseId ?? lic.tokenId) },
    });
    assert.equal(grant.status, 409, JSON.stringify(grant.body));
    assert.equal(grant.body.error.code, "SERVICE_CODE_NOT_DOWNLOADABLE");
  });

  test("commerce is the store's ordinary settlement: fee, holder share, buyback and burn, counted once", async () => {
    const purchases = await Purchase.find({ chainId: 31337, storeId, productId }).lean();
    assert.equal(purchases.length, 1, "one purchase of three calls, however many invocations");
    const p = purchases[0]!;
    assert.equal(p.grossUSDC, "90000");
    assert.equal(p.units, 3);
    const storeContract = new Contract(storeAddress, h.ctx.abis.abiFor("AICStoreSales") as never, h.provider);
    const preview = await storeContract.previewSettlement(90_000n);
    assert.equal(p.protocolFeeUSDC, preview.protocolFee.toString());
    assert.equal(p.holderReserveUSDC, preview.holderReserve.toString());
    assert.equal(p.ownerAvailableUSDC, preview.ownerAvailable.toString());
    assert.ok(BigInt(p.buybackBurnedAIC ?? "0") > 0n, "the holder share bought back and burned AIC in the same transaction");
    const store = await Store.findOne({ chainId: 31337, storeId }).lean();
    assert.ok(BigInt(store!.lifetimeBuybackBurnedAIC ?? "0") >= BigInt(p.buybackBurnedAIC!));
  });

  test("metrics are facts: calls, customers, repeat use, commerce, burn; the controller's own calls apart", async () => {
    // A second successful call by the same customer makes it a repeat customer.
    const again = await invoke(buyerKey, idem(), { input: { text: "four words right here" } });
    assert.equal(again.body.state, "SUCCEEDED");

    // The controller calling its own service is shown apart, never as a customer.
    await fundUsdc(seller, storeAddress, 30_000n);
    const selfKey = idem("self");
    const selfUnpaid = await invoke(sellerKey, selfKey, { input: { text: "self" } });
    assert.equal(selfUnpaid.status, 402);
    await send(seller, selfUnpaid.body.error.details.pay);
    await h.sync();
    const selfCall = await invoke(sellerKey, selfKey, { input: { text: "self" } });
    assert.equal(selfCall.body.state, "SUCCEEDED");

    const m = (await h.request("GET", `/api/v1/services/${storeId}/${productId}/metrics`)).body;
    assert.equal(m.callsTotal, 4, "two successes and two failures by the customer");
    assert.equal(m.successfulCalls, 2);
    assert.equal(m.failedCalls, 2);
    assert.equal(m.successRate, 0.5);
    assert.equal(m.uniqueCustomers, 1);
    assert.equal(m.repeatCustomers, 1);
    assert.equal(m.grossCommerceUSDC.display, "0.09");
    assert.equal(m.prepaidCallsOutstanding, 1);
    assert.equal(m.selfCalls, 1);
    assert.equal(m.selfCommerceUSDC.display, "0.03");
    assert.ok(BigInt(m.buybackUSDC.base) > 0n);
    assert.ok(BigInt(m.burnedAIC.base) > 0n);
    assert.ok(m.medianLatencyMs !== null);
    assert.ok(!("score" in m) && !("rating" in m), "no composite score");

    const f = (await h.request("GET", `/api/v1/stocks/${aicAddress}/fundamentals`)).body;
    assert.ok(f.businessModel.services, "the business shows its service fundamentals");
    assert.equal(f.businessModel.activeServices, 1);
    assert.equal(f.businessModel.servicesListed, 1, "the count is not overwritten by the metrics");
    assert.equal(f.businessModel.serviceCustomers, 1);
    assert.equal(f.businessModel.services.successfulCalls, 2);
  });

  test("MCP: services are tools; a call pays and runs the same way", async () => {
    const init = await h.request("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } } });
    assert.equal(init.body.result.serverInfo.name, "agentgoods-services");
    const list = await h.request("POST", "/mcp", { body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    const tool = list.body.result.tools.find((t: any) => t.description.includes(productId));
    assert.ok(tool, "the service is a tool");
    assert.equal(tool.inputSchema.properties.text.type, "string");
    const call = await h.request("POST", "/mcp", {
      apiKey: buyerKey,
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool.name, arguments: { text: "mcp says hello", idempotencyKey: "mcp-1" } } },
    });
    assert.deepEqual(call.body.result.structuredContent, { words: 3 });
    const anon = await h.request("POST", "/mcp", {
      body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: tool.name, arguments: { text: "x" } } },
    });
    assert.equal(anon.body.result.isError, true);
  });
});

describe("Services: control passes with the business", { concurrency: 1 }, () => {
  test("after a takeover the new controller runs the service; the old one cannot; history is unchanged", async () => {
    const before = (await h.request("GET", `/api/v1/services/${storeId}/${productId}/metrics`)).body;
    const challenger = await freshWallet();
    const challengerKey = await issueApiKey(challenger);
    const shop = h.contracts.agentGoods;
    await (await (h.contracts.usdc.connect(h.signers[0]!) as Contract).mint(challenger.address, USDC(3000))).wait();
    await (await (h.contracts.usdc.connect(challenger) as Contract).approve(await shop.getAddress(), USDC(3000))).wait();
    const deadline = (await h.provider.getBlock("latest"))!.timestamp + 3600;
    await (await (shop.connect(challenger) as Contract).buy(aicAddress, USDC(3000), 0, deadline)).wait();
    await h.sync();

    const base = `/api/v1/stocks/${aicAddress}/takeover`;
    const open = await h.request("POST", `${base}/candidacy-intent`, { apiKey: challengerKey, headers: idem() });
    assert.equal(open.status, 201, JSON.stringify(open.body));
    await send(challenger, open.body.intent);
    await h.provider.send("evm_increaseTime", [3601]);
    await h.provider.send("evm_mine", []);
    await h.sync();
    const fin = await h.request("POST", `${base}/finalize-intent`, { apiKey: challengerKey, headers: idem() });
    assert.equal(fin.status, 201, JSON.stringify(fin.body));
    await send(challenger, fin.body.intent);
    await h.sync();

    const oldTry = await h.request("POST", `/api/v1/stores/${storeId}/products/${productId}/update`, {
      apiKey: sellerKey,
      headers: idem(),
      body: { priceUSDC: "50000" },
    });
    assert.ok(oldTry.status >= 400, "the old controller can no longer manage the service");

    const newPrice = await h.request("POST", `/api/v1/stores/${storeId}/products/${productId}/update`, {
      apiKey: challengerKey,
      headers: idem(),
      body: { priceUSDC: "50000" },
    });
    assert.equal(newPrice.status, 201, JSON.stringify(newPrice.body));
    await send(challenger, newPrice.body.intent);
    await h.sync();

    const d = (await h.request("GET", `/api/v1/services/${storeId}/${productId}`)).body;
    assert.equal(d.pricePerCallUSDC.display, "0.05");
    assert.ok(d.inputSchema, "the service stays a service after the update");
    assert.equal(d.business.controller.toLowerCase(), challenger.address.toLowerCase());
    assert.equal(d.metrics.successfulCalls, before.successfulCalls, "call history is part of what was acquired");
    assert.equal(d.metrics.grossCommerceUSDC.display, before.grossCommerceUSDC.display);

    const off = await h.request("POST", `/api/v1/stores/${storeId}/products/${productId}/update`, {
      apiKey: challengerKey,
      headers: idem(),
      body: { active: false },
    });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    await send(challenger, off.body.intent);
    await h.sync();
    const buyer = await freshWallet();
    const inactive = await h.request("POST", `/api/v1/services/${storeId}/${productId}/invoke`, {
      apiKey: await issueApiKey(buyer),
      headers: idem(),
      body: { input: { text: "hello" } },
    });
    assert.equal(inactive.status, 409);
    assert.equal(inactive.body.error.code, "SERVICE_INACTIVE");
  });
});
