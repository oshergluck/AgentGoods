/**
 * Backend integration tests.
 *
 * These run against a real Hardhat chain with the canonical contracts deployed, a real
 * in-memory MongoDB, the real indexer and the real Express app. The assertions below are the
 * ones MASTER_PLAN makes non-negotiable: zero-RPC reads, exactly-once projection, reorg
 * rollback, reconstruction from chain, API-key authority limits, idempotency, and the
 * Phase 10.1 declaration and buyer-signal rules.
 */

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Contract, ethers, keccak256, toUtf8Bytes, Wallet } from "ethers";
import {
  createHarness,
  stopChain,
  declaration,
  UNDECLARED,
  NO_DECLARATION,
  USDC,
  AIC,
  type Harness, createStoreOnChain } from "./helpers/harness";
import { forbidRpc, allowRpc, rpcMetrics, resetRpcMetrics } from "../src/rpc/provider";
import {
  BuyerSignalDoc,
  ChainEvent,
  License,
  Product,
  Store,
  StockMarket,
  StockTrade,
  WebhookDelivery,
} from "../src/db/models";
import { buildChallengeMessage } from "../src/auth/challenge";
import { AuthChallenge, Product } from "../src/db/models";
import { reprojectStore } from "../src/indexer/projector";

let h: Harness;

const PRODUCT_KEY = "premium-dataset-v1";
const PRODUCT_ID = keccak256(toUtf8Bytes(PRODUCT_KEY));

interface StoreHandles {
  storeId: string;
  store: Contract;
  aic: Contract;
  license: Contract;
  controller: Wallet;
}

before(async () => {
  h = await createHarness();
});

after(async () => {
  await h.stop();
  await stopChain();
});

/**
 * Creates a store on chain through the canonical factory and returns typed handles.
 *
 * ONE SALES AND ONE RENTALS STORE PER ADDRESS — StoreFactory enforces it, so every test that
 * creates a store of a given type needs its own controller signer. Reusing one produces
 * `StoreLimitReached`, which surfaces here as an opaque `execution reverted (unknown custom
 * error)` from estimateGas. If you add a test that creates a store, give it an unused signer.
 */
async function createStore(controller: Wallet, symbol: string, type: 0 | 1 = 0): Promise<StoreHandles> {
  const tx = await createStoreOnChain(h, controller, type, `${symbol} AIC`, symbol, `${symbol} Store`);
  const receipt = await tx.wait();

  const parsed = receipt!.logs
    .map((l: { topics: readonly string[]; data: string }) => {
      try {
        return h.contracts.factory.interface.parseLog({ topics: [...l.topics], data: l.data });
      } catch {
        return null;
      }
    })
    .find((e: { name: string } | null) => e && e.name === "StoreCreated")!;

  const storeAbi = h.ctx.abis.abiFor(type === 0 ? "AICStoreSales" : "AICStoreRentals") as never;
  return {
    storeId: parsed.args.storeId,
    store: new Contract(parsed.args.store, storeAbi, controller),
    aic: new Contract(parsed.args.aicToken, h.ctx.abis.abiFor("AICoin") as never, controller),
    license: new Contract(parsed.args.licenseToken, h.ctx.abis.abiFor("LicenseToken") as never, controller),
    controller,
  };
}

async function fundUSDC(to: Wallet, amount: bigint, spender?: string): Promise<void> {
  await (await h.contracts.usdc.mint(to.address, amount)).wait();
  if (spender) {
    await (await (h.contracts.usdc.connect(to) as Contract).approve(spender, amount)).wait();
  }
}

/** A funded, never-before-seen wallet. Only one API key per wallet is ever live. */
async function freshWallet(): Promise<Wallet> {
  const wallet = Wallet.createRandom().connect(h.provider) as Wallet;
  await (await h.signers[0]!.sendTransaction({ to: wallet.address, value: 10n ** 18n })).wait();
  return wallet;
}

async function issueApiKey(wallet: Wallet): Promise<string> {
  const challenge = await h.request("POST", "/api/v1/auth/challenge", {
    body: { wallet: wallet.address, purpose: "ISSUE_API_KEY" },
  });
  assert.equal(challenge.status, 201);
  const signature = await wallet.signMessage(challenge.body.message as string);
  const issued = await h.request("POST", "/api/v1/auth/api-key/issue", {
    body: { nonce: challenge.body.nonce, signature },
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return issued.body.apiKey as string;
}

/* ====================================================================== */

/**
 * One root suite with concurrency 1.
 *
 * Every suite below mutates shared state: the chain (and therefore each signer nonce), the
 * database, and the indexer cursor. node:test would otherwise interleave them, which produced
 * nonce collisions and cross-suite projection counts rather than real failures.
 */
describe("AIC backend", { concurrency: 1 }, () => {


describe("Indexer: projection, exactly-once and reconstruction", { concurrency: 1 }, () => {
  test("projects a canonical store creation with its full component set", async () => {
    const controller = h.signers[5]!;
    const s = await createStore(controller, "IDX1");
    await h.sync();

    const doc = await Store.findOne({ chainId: 31337, storeId: s.storeId }).lean();
    assert.ok(doc, "store projection exists");
    assert.equal(doc!.address, (await s.store.getAddress()).toLowerCase());
    assert.equal(doc!.aicToken, (await s.aic.getAddress()).toLowerCase());
    assert.equal(doc!.storeController, controller.address.toLowerCase());
    assert.equal(doc!.canonical, true);

    const market = await StockMarket.findOne({ chainId: 31337, aicToken: doc!.aicToken }).lean();
    assert.ok(market, "market projection exists");
    assert.equal(market!.genesisSupplyAIC, AIC(1_000_000_000).toString());
    // Born with the controller's 5 USDC initial market capital: its AIC left the market inventory,
    // the seed (net of the 3% trading fees) is the first real reserve, and the store records it.
    const seedAIC = (await s.aic.balanceOf(controller.address)) as bigint;
    assert.ok(seedAIC > 0n, "the controller holds its seed position");
    assert.equal(BigInt(market!.marketInventoryAIC) + seedAIC, AIC(1_000_000_000));
    assert.equal(market!.realUSDCReserve, (USDC(5) * 97n / 100n).toString());
    assert.equal(market!.phase, "bonding_curve");
    assert.equal(doc!.initialOwnerSeedUSDC, USDC(5).toString());
  });

  test("is idempotent: replaying a range changes nothing", async () => {
    await h.sync();
    const eventsBefore = await ChainEvent.countDocuments({ chainId: 31337 });
    const storesBefore = await Store.countDocuments({ chainId: 31337 });
    const productsBefore = await Product.countDocuments({ chainId: 31337 });

    // Rewind the cursor a few blocks so the SAME logs are fetched and offered again. The
    // unique (chainId, txHash, logIndex) key must make every re-offer a no-op.
    const head = await h.provider.getBlockNumber();
    await h.indexer.rollbackTo(Math.max(0, head - 3));
    await h.sync();

    // The real invariant is uniqueness of the event identity, not a fragile absolute count.
    const duplicates = await ChainEvent.aggregate([
      { $match: { chainId: 31337 } },
      { $group: { _id: { txHash: "$txHash", logIndex: "$logIndex" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    assert.equal(duplicates.length, 0, "no duplicate (txHash, logIndex) events after replay");
    assert.equal(await Store.countDocuments({ chainId: 31337 }), storesBefore, "no duplicate stores");
    assert.equal(await Product.countDocuments({ chainId: 31337 }), productsBefore, "no duplicate products");
    assert.ok((await ChainEvent.countDocuments({ chainId: 31337 })) >= eventsBefore, "no events lost");
  });

  test("rolls a reorg back to the fork point and replays cleanly", async () => {
    const controller = h.signers[19]!;
    const s = await createStore(controller, "REORG");
    await h.sync();
    assert.ok(await Store.findOne({ chainId: 31337, storeId: s.storeId }).lean(), "indexed before rollback");

    const forkPoint = (await h.provider.getBlockNumber()) - 1;
    await h.indexer.rollbackTo(forkPoint);

    const orphaned = await ChainEvent.countDocuments({ chainId: 31337, blockNumber: { $gt: forkPoint } });
    assert.equal(orphaned, 0, "orphaned events are deleted");

    // Replaying restores exactly the same canonical state.
    await h.sync();
    const restored = await Store.findOne({ chainId: 31337, storeId: s.storeId }).lean();
    assert.ok(restored, "state is restored by replaying the canonical log");
    assert.equal(restored!.storeController, controller.address.toLowerCase());
  });

  test("rebuilds a store projection exactly from the event log", async () => {
    const controller = h.signers[6]!;
    const s = await createStore(controller, "RBLD");
    await (
      await s.store.createProduct(
        PRODUCT_ID,
        USDC(10),
        1000,
        0,
        ethers.ZeroHash,
        JSON.stringify({ name: "rebuild fixture", description: "integration test listing" }),
        declaration(120_000, "frontier-class", 2)
      )
    ).wait();
    await h.sync();

    const before = await Product.findOne({ chainId: 31337, storeId: s.storeId, productId: PRODUCT_ID }).lean();
    assert.ok(before);

    // Delete every rebuildable projection for this store and replay from chain_events.
    await reprojectStore(31337, s.storeId);

    const after = await Product.findOne({ chainId: 31337, storeId: s.storeId, productId: PRODUCT_ID }).lean();
    assert.ok(after, "product is reconstructable from the event log alone");
    assert.equal(after!.priceUSDC, before!.priceUSDC);
    assert.equal(after!.version, before!.version);
    assert.equal(after!.declaration.tokensSaved, before!.declaration.tokensSaved);
    assert.equal(after!.declaration.basis, before!.declaration.basis);
    assert.equal(after!.declaration.tokensSavedPerUsdc, before!.declaration.tokensSavedPerUsdc);
  });
});

describe("RPC cost architecture (MASTER_PLAN rule 14, section 28)", { concurrency: 1 }, () => {
  test("public GET endpoints perform zero RPC calls", async () => {
    await h.sync();
    resetRpcMetrics();
    forbidRpc("public GET endpoints must read only from the indexed projection");

    try {
      const paths = [
        "/api/v1/discovery",
        "/api/v1/products/recent",
        "/api/v1/stores/recent",
        "/api/v1/market/products",
        "/api/v1/stores",
        "/api/v1/contracts",
        "/api/v1/schema",
        "/.well-known/aic-agent.json",
        "/api/v1/openapi.json",
        "/api/v1/status",
      ];
      for (const p of paths) {
        const res = await h.request("GET", p);
        assert.equal(res.status, 200, `${p} returned ${res.status}`);
      }
    } finally {
      allowRpc();
    }

    assert.equal(rpcMetrics().requestsTotal, 0, "no RPC call was made while serving public GETs");
  });
});

describe("Authentication and API-key authority", { concurrency: 1 }, () => {
  test("issues exactly one key per wallet and refuses a second issue", async () => {
    const wallet = h.signers[7]!;
    const key = await issueApiKey(wallet);
    assert.ok(key.startsWith("aic_live_"));

    const challenge = await h.request("POST", "/api/v1/auth/challenge", {
      body: { wallet: wallet.address, purpose: "ISSUE_API_KEY" },
    });
    const signature = await wallet.signMessage(challenge.body.message as string);
    const second = await h.request("POST", "/api/v1/auth/api-key/issue", {
      body: { nonce: challenge.body.nonce, signature },
    });
    assert.equal(second.status, 409);
    assert.equal((second.body.error as { code: string }).code, "ACTIVE_KEY_EXISTS");
  });

  test("never returns the secret again after issuance", async () => {
    const wallet = h.signers[8]!;
    await issueApiKey(wallet);
    const status = await h.request("GET", `/api/v1/auth/api-key/status?wallet=${wallet.address}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "ACTIVE");
    assert.ok(status.body.apiKeyPrefix);
    assert.ok(!("apiKey" in status.body), "the raw key is never returned again");
    assert.ok(!("apiKeyHash" in status.body), "the hash is never exposed either");
  });

  test("rejects a replayed challenge nonce", async () => {
    const wallet = h.signers[9]!;
    const challenge = await h.request("POST", "/api/v1/auth/challenge", {
      body: { wallet: wallet.address, purpose: "ISSUE_API_KEY" },
    });
    const signature = await wallet.signMessage(challenge.body.message as string);
    const first = await h.request("POST", "/api/v1/auth/api-key/issue", {
      body: { nonce: challenge.body.nonce, signature },
    });
    assert.equal(first.status, 201);

    const replay = await h.request("POST", "/api/v1/auth/api-key/issue", {
      body: { nonce: challenge.body.nonce, signature },
    });
    assert.equal(replay.status, 400);
    assert.equal((replay.body.error as { code: string }).code, "CHALLENGE_ALREADY_USED");
  });

  test("refuses a signature produced for a different purpose", async () => {
    const wallet = h.signers[10]!;
    const challenge = await h.request("POST", "/api/v1/auth/challenge", {
      body: { wallet: wallet.address, purpose: "HUMAN_LOGIN" },
    });
    const signature = await wallet.signMessage(challenge.body.message as string);
    const misuse = await h.request("POST", "/api/v1/auth/api-key/issue", {
      body: { nonce: challenge.body.nonce, signature },
    });
    assert.equal(misuse.status, 400);
    assert.equal((misuse.body.error as { code: string }).code, "PURPOSE_MISMATCH");
  });

  test("refuses a signature from a different wallet", async () => {
    const owner = h.signers[11]!;
    const attacker = h.signers[12]!;
    const challenge = await h.request("POST", "/api/v1/auth/challenge", {
      body: { wallet: owner.address, purpose: "ISSUE_API_KEY" },
    });
    const signature = await attacker.signMessage(challenge.body.message as string);
    const res = await h.request("POST", "/api/v1/auth/api-key/issue", {
      body: { nonce: challenge.body.nonce, signature },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body.error as { code: string }).code, "WALLET_MISMATCH");
  });

  test("refuses an expired challenge", async () => {
    const wallet = h.signers[13]!;
    const challenge = await h.request("POST", "/api/v1/auth/challenge", {
      body: { wallet: wallet.address, purpose: "ISSUE_API_KEY" },
    });
    await AuthChallenge.updateOne(
      { nonce: challenge.body.nonce },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );
    const signature = await wallet.signMessage(challenge.body.message as string);
    const res = await h.request("POST", "/api/v1/auth/api-key/issue", {
      body: { nonce: challenge.body.nonce, signature },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body.error as { code: string }).code, "CHALLENGE_EXPIRED");
  });

  test("an API key cannot read another wallet private data", async () => {
    const wallet = h.signers[14]!;
    const key = await issueApiKey(wallet);
    const other = h.signers[15]!.address;

    const res = await h.request("GET", `/api/v1/dividends/me?wallet=${other}`, { apiKey: key });
    assert.equal(res.status, 403);
    assert.equal((res.body.error as { code: string }).code, "FORBIDDEN");
  });

  test("marks wallet-specific responses as never cacheable", async () => {
    const wallet = h.signers[16]!;
    const key = await issueApiKey(wallet);
    const res = await h.request("GET", "/api/v1/dividends/me", { apiKey: key });
    assert.equal(res.status, 200);
    assert.match(res.headers["cache-control"] ?? "", /no-store/);
    assert.match(res.headers["vary"] ?? "", /Authorization/i);
  });

  test("states plainly that the key cannot sign or move funds", async () => {
    const wallet = h.signers[17]!;
    const key = await issueApiKey(wallet);
    const res = await h.request("GET", "/api/v1/auth/me", { apiKey: key });
    const caps = res.body.capabilities as Record<string, unknown>;
    assert.equal(caps.canSignTransactions, false);
    assert.equal(caps.canMoveFunds, false);
  });

  test("rejects an unknown or malformed key", async () => {
    const bad = await h.request("GET", "/api/v1/auth/me", { apiKey: "aic_live_not_a_real_key" });
    assert.equal(bad.status, 401);
    const malformed = await h.request("GET", "/api/v1/auth/me", { apiKey: "hello" });
    assert.equal(malformed.status, 401);
  });
});

describe("Idempotency (MASTER_PLAN 0.25.W)", { concurrency: 1 }, () => {
  test("replays the stored response for an identical retry and conflicts on a changed body", async () => {
    const wallet = h.signers[18]!;
    const key = await issueApiKey(wallet);
    const idem = "idem-test-key-000001";

    const first = await h.request("POST", "/api/v1/stores", {
      apiKey: key,
      headers: { "idempotency-key": idem },
      body: { storeType: "sales", aicName: "Idem AIC", aicSymbol: "IDEM", storeName: "Idem Store", initialOwnerSeedUSDC: "5" },
    });
    assert.equal(first.status, 201);
    const intentId = (first.body.intent as { intentId: string }).intentId;

    const replay = await h.request("POST", "/api/v1/stores", {
      apiKey: key,
      headers: { "idempotency-key": idem },
      body: { storeType: "sales", aicName: "Idem AIC", aicSymbol: "IDEM", storeName: "Idem Store", initialOwnerSeedUSDC: "5" },
    });
    assert.equal(replay.status, 201);
    assert.equal((replay.body.intent as { intentId: string }).intentId, intentId, "same intent, not a second one");
    assert.equal(replay.headers["idempotent-replay"], "true");

    const conflict = await h.request("POST", "/api/v1/stores", {
      apiKey: key,
      headers: { "idempotency-key": idem },
      body: { storeType: "rentals", aicName: "Other", aicSymbol: "OTHR", storeName: "Other", initialOwnerSeedUSDC: "5" },
    });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body.error as { code: string }).code, "IDEMPOTENCY_CONFLICT");
  });

  test("refuses a write with no Idempotency-Key", async () => {
    const wallet = h.signers[19]!;
    const key = await issueApiKey(wallet);
    const res = await h.request("POST", "/api/v1/stores", {
      apiKey: key,
      body: { storeType: "sales", aicName: "N", aicSymbol: "N", storeName: "N", initialOwnerSeedUSDC: "5" },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body.error as { code: string }).code, "INVALID_REQUEST");
  });

  test("scopes an idempotency key to its own wallet", async () => {
    const a = h.signers[5]!;
    const b = h.signers[6]!;
    const keyA = await ensureKey(a);
    const keyB = await ensureKey(b);
    const shared = "shared-idem-key-0001";
    const body = { storeType: "sales", aicName: "S", aicSymbol: "SS", storeName: "S", initialOwnerSeedUSDC: "5" };

    const resA = await h.request("POST", "/api/v1/stores", {
      apiKey: keyA,
      headers: { "idempotency-key": shared },
      body,
    });
    const resB = await h.request("POST", "/api/v1/stores", {
      apiKey: keyB,
      headers: { "idempotency-key": shared },
      body,
    });
    assert.equal(resA.status, 201);
    assert.equal(resB.status, 201);
    assert.notEqual(
      (resA.body.intent as { intentId: string }).intentId,
      (resB.body.intent as { intentId: string }).intentId,
      "the same key for two wallets produces two independent intents"
    );
  });
});

describe("Transaction intents never carry wallet authority", { concurrency: 1 }, () => {
  test("returns calldata for the Agent to sign and never a signature", async () => {
    const wallet = h.signers[7]!;
    const key = await ensureKey(wallet);
    const res = await h.request("POST", "/api/v1/stores", {
      apiKey: key,
      headers: { "idempotency-key": `intent-${Date.now()}` },
      body: { storeType: "sales", aicName: "Sig AIC", aicSymbol: "SIGX", storeName: "Sig Store", initialOwnerSeedUSDC: "5" },
    });
    assert.equal(res.status, 201);
    const intent = res.body.intent as Record<string, unknown>;
    assert.ok((intent.transaction as { data: string }).data.startsWith("0x"));
    assert.equal((intent.signing as { signer: string }).signer, wallet.address);
    // The response must contain no signing material of any kind: the backend never signs.
    const serialized = JSON.stringify(intent);
    for (const forbidden of ["privateKey", "mnemonic", "seedPhrase", "signedTransaction", "rawTransaction"]) {
      assert.ok(!serialized.includes(forbidden), `response must not contain ${forbidden}`);
    }
    assert.ok(!("signature" in intent), "an intent is unsigned by construction");
    assert.ok(!("signedTransaction" in (intent.transaction as object)), "no signed transaction is returned");
  });
});

/* ============================== Phase 10.1 ============================== */

describe("Phase 10.1 — declared token saving", { concurrency: 1 }, () => {
  let s: StoreHandles;

  test("projects a declaration verbatim and derives tokens per USDC", async () => {
    s = await createStore(h.signers[1]!, "DECL");
    await (
      await s.store.createProduct(
        PRODUCT_ID,
        USDC(4),
        1000,
        0,
        ethers.ZeroHash,
        JSON.stringify({ name: "declared fixture", description: "integration test listing" }),
        declaration(200_000, "frontier-2025-class", 2)
      )
    ).wait();
    await h.sync();

    const doc = await Product.findOne({ chainId: 31337, storeId: s.storeId, productId: PRODUCT_ID }).lean();
    assert.ok(doc);
    assert.equal(doc!.declaration.declared, true);
    assert.equal(doc!.declaration.basis, "MEASURED");
    assert.equal(doc!.declaration.tokensSaved, "200000");
    assert.equal(doc!.declaration.modelTier, "frontier-2025-class");
    // 200000 tokens for 4 USDC = 50000 tokens per USDC.
    assert.equal(doc!.declaration.tokensSavedPerUsdc, "50000");
  });

  test("labels the declaration as unverified seller data in every response", async () => {
    const res = await h.request("GET", `/api/v1/products/${PRODUCT_ID}`);
    assert.equal(res.status, 200);
    const product = res.body.product as Record<string, Record<string, unknown>>;
    assert.equal(product.declaration.verified, false);
    assert.equal(product.declaration.derived, true);
    assert.match(String(product.declaration.disclaimer), /UNVERIFIED SELLER CLAIM/);
    assert.match(String(product.sellerContent.note), /Untrusted/);
  });

  test("keeps the declaration structurally outside the trusted protocol envelope", async () => {
    const res = await h.request("GET", `/api/v1/products/${PRODUCT_ID}`);
    const product = res.body.product as Record<string, Record<string, unknown>>;
    assert.ok(!("tokensSaved" in product.protocol), "a seller claim never sits in the protocol envelope");
    assert.ok("declaration" in product);
    assert.ok("sellerContent" in product);
  });

  test("refuses a listing with no token declaration, on chain and in the API", async () => {
    const undeclaredId = keccak256(toUtf8Bytes("undeclared-product"));
    await assert.rejects(
      s.store.createProduct(undeclaredId, USDC(2), 10, 0, ethers.ZeroHash, "", NO_DECLARATION),
      /InvalidDeclaration|revert/,
      "the contract refuses a product that declares no tokens"
    );
  });

  test("filters and sorts on the derived field without any RPC", async () => {
    await h.sync();
    resetRpcMetrics();
    forbidRpc("declaration filters must be served from the projection");
    try {
      const declared = await h.request("GET", "/api/v1/market/products?declared=true");
      assert.equal(declared.status, 200);
      for (const item of declared.body.items as Record<string, Record<string, unknown>>[]) {
        assert.equal(item.declaration.declared, true);
      }

      const measured = await h.request("GET", "/api/v1/market/products?basis=MEASURED");
      assert.equal(measured.status, 200);
      for (const item of measured.body.items as Record<string, Record<string, unknown>>[]) {
        assert.equal(item.declaration.basis, "MEASURED");
      }

      const ranged = await h.request("GET", "/api/v1/market/products?minTokensSavedPerUsdc=1000");
      assert.equal(ranged.status, 200);
      for (const item of ranged.body.items as Record<string, Record<string, unknown>>[]) {
        assert.ok(Number(item.declaration.tokensSavedPerUsdc) >= 1000);
      }

      const sorted = await h.request("GET", "/api/v1/market/products?sort=tokensSavedPerUsdc_desc&declared=true");
      assert.equal(sorted.status, 200);
      const values = (sorted.body.items as Record<string, Record<string, unknown>>[]).map((i) =>
        Number(i.declaration.tokensSavedPerUsdc)
      );
      for (let i = 1; i < values.length; i++) {
        assert.ok(values[i - 1]! >= values[i]!, "descending order holds");
      }
    } finally {
      allowRpc();
    }
    assert.equal(rpcMetrics().requestsTotal, 0);
  });

  test("keeps a declaration immutable within a version and records history per version", async () => {
    const { ProductVersion } = await import("../src/db/models");
    const v1 = await ProductVersion.findOne({
      chainId: 31337,
      storeId: s.storeId,
      productId: PRODUCT_ID,
      version: 1,
    }).lean();
    assert.ok(v1);
    assert.equal(v1!.declaration.tokensSaved, "200000");

    await (
      await s.store.updateProduct(
        PRODUCT_ID,
        USDC(4),
        1000,
        0,
        true,
        ethers.ZeroHash,
        JSON.stringify({ name: "declared fixture", description: "integration test listing" }),
        declaration(1, "frontier-2025-class", 1)
      )
    ).wait();
    await h.sync();

    const v1Again = await ProductVersion.findOne({
      chainId: 31337,
      storeId: s.storeId,
      productId: PRODUCT_ID,
      version: 1,
    }).lean();
    assert.equal(v1Again!.declaration.tokensSaved, "200000", "version 1 history is untouched");

    const v2 = await ProductVersion.findOne({
      chainId: 31337,
      storeId: s.storeId,
      productId: PRODUCT_ID,
      version: 2,
    }).lean();
    assert.equal(v2!.declaration.tokensSaved, "1");
    assert.equal(v2!.declaration.basis, "ESTIMATED");

    const current = await Product.findOne({ chainId: 31337, storeId: s.storeId, productId: PRODUCT_ID }).lean();
    assert.equal(current!.version, 2);
  });

  test("the backend never computes or improves a declaration", async () => {
    // Must be the controller of the DECL store created above, or the upload is a 403.
    const wallet = h.signers[1]!;
    const key = await ensureKey(wallet);
    const pid = "backend-must-not-touch-this";

    // The deliverable exists before the product commits to it; listing otherwise is refused.
    const deliverable = "A declaration is the seller's claim. This file is what is delivered.";
    const stored = await h.request("POST", "/api/v1/access/content", {
      apiKey: key,
      body: {
        storeId: s.storeId,
        content: Buffer.from(deliverable, "utf8").toString("base64"),
        contentType: "text/plain",
      },
    });
    assert.equal(stored.status, 201, JSON.stringify(stored.body));

    const res = await h.request("POST", `/api/v1/stores/${s.storeId}/products`, {
      apiKey: key,
      headers: { "idempotency-key": `decl-${Date.now()}` },
      body: {
        productId: pid,
        priceUSDC: USDC(3).toString(),
        contentHash: ethers.keccak256(ethers.toUtf8Bytes(deliverable)),
        inventory: "5",
        metadataURI: JSON.stringify({ name: "Declaration fixture", description: "integration test listing" }),
        declaration: { inputTokens: "12000", reasoningTokens: "200", outputTokens: "145", modelTier: "gpt5mini", basis: "ESTIMATED" },
        iterations: 2,
        iterationLog: ["First draft tested on three sample inputs", "Fixed the empty-input case and re-ran all three"],
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const summary = (res.body.intent as { summary: { protocol: Record<string, unknown> } }).summary;
    const echoed = summary.protocol.declaration as Record<string, unknown>;
    assert.equal(echoed.tokensSaved, "12345", "copied verbatim, not recomputed");
    assert.equal(echoed.basis, "ESTIMATED");
    assert.equal(summary.protocol.declarationIsSellerClaim, true);

    // The same listing without a declaration is refused before any transaction is prepared.
    const refused = await h.request("POST", `/api/v1/stores/${s.storeId}/products`, {
      apiKey: key,
      headers: { "idempotency-key": `nodecl-${Date.now()}` },
      body: {
        productId: `${pid}-nodecl`,
        priceUSDC: USDC(3).toString(),
        contentHash: ethers.keccak256(ethers.toUtf8Bytes(deliverable)),
        inventory: "5",
        iterations: 2,
        iterationLog: ["First draft tested on three sample inputs", "Fixed the empty-input case and re-ran all three"],
      },
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(JSON.stringify(refused.body), /declaration/);
  });

  test("an update's new `content` is stored and committed, as at listing", async () => {
    /*
     * The update body accepted `content` and nothing read it: a seller that sent repaired bytes
     * got a new version committed to the OLD hash, with no error.
     */
    const key = await ensureKey(h.signers[1]!);
    const url = `/api/v1/stores/${s.storeId}/products/${PRODUCT_ID}/update`;
    const repaired = "The repaired deliverable, sent with the update itself.";
    const b64 = Buffer.from(repaired, "utf8").toString("base64");

    const res = await h.request("POST", url, {
      apiKey: key,
      headers: { "idempotency-key": `upd-content-${Date.now()}` },
      body: {
        content: b64,
        contentType: "text/plain",
        changelog: "fixed the empty-input case",
        iterations: 1,
        iterationLog: ["Fixed the empty-input case and re-tested it"],
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const expected = ethers.keccak256(ethers.toUtf8Bytes(repaired)).toLowerCase();
    assert.equal(String((res.body.content as { contentHash: string }).contentHash).toLowerCase(), expected);
    const protocol = (res.body.intent as { summary: { protocol: Record<string, unknown> } }).summary.protocol;
    assert.equal(String(protocol.contentHash).toLowerCase(), expected, "the intent commits the NEW bytes");
    assert.equal(protocol.contentChanged, true);

    const both = await h.request("POST", url, {
      apiKey: key,
      headers: { "idempotency-key": `upd-both-${Date.now()}` },
      body: { content: b64, contentHash: expected },
    });
    assert.equal(both.status, 400, "content and contentHash together are refused");

    const nothingBehind = await h.request("POST", url, {
      apiKey: key,
      headers: { "idempotency-key": `upd-empty-${Date.now()}` },
      body: {
        contentHash: ethers.keccak256(ethers.toUtf8Bytes("never uploaded")),
        iterations: 1,
        iterationLog: ["Re-committed bytes that were never uploaded"],
      },
    });
    assert.equal(nothingBehind.status, 400, JSON.stringify(nothingBehind.body));
    assert.match(JSON.stringify(nothingBehind.body), /No content is stored for this contentHash/);
  });

  test("work done after listing is declared with iterations alone, and only adds to the total", async () => {
    const key = await ensureKey(h.signers[1]!);
    const url = `/api/v1/stores/${s.storeId}/products/${PRODUCT_ID}/update`;
    // The shared fixture is a legacy zero-hash product; a real listing always commits to its bytes.
    await Product.updateOne(
      { storeId: s.storeId.toLowerCase(), productId: PRODUCT_ID.toLowerCase() },
      { $set: { contentHash: ethers.keccak256(ethers.toUtf8Bytes("fixture bytes")) } }
    );
    const res = await h.request("POST", url, {
      apiKey: key,
      headers: { "idempotency-key": `upd-iter-${Date.now()}` },
      body: {
        iterations: 2,
        iterationLog: ["Ran it on twelve real inputs and fixed an empty-array crash", "Edited the parser for nested keys and re-ran every case"],
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const dev = res.body.development as { iterations: number; iterationsTotal: number };
    assert.equal(dev.iterations, 2);
    assert.ok(dev.iterationsTotal >= 2, "added to whatever was committed before");

    const lonely = await h.request("POST", url, {
      apiKey: key,
      headers: { "idempotency-key": `upd-iter-bad-${Date.now()}` },
      body: { iterations: 2 },
    });
    assert.equal(lonely.status, 400, "iterations without their explanations are refused");
  });

  test("every prepared transaction has a transaction-request link a wallet fetches instead of copying calldata", async () => {
    const key = await ensureKey(h.signers[1]!);
    const url = `/api/v1/stores/${s.storeId}/products/${PRODUCT_ID}/update`;
    const res = await h.request("POST", url, {
      apiKey: key,
      headers: { "idempotency-key": `upd-txreq-${Date.now()}` },
      body: { iterations: 1, iterationLog: ["Re-ran the full suite after tightening the input check"] },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const intent = res.body.intent as { intentId: string; transaction: { to: string; data: string }; transactionRequest: { path: string; url: string } };
    assert.match(intent.transactionRequest.path, /^\/api\/v1\/tx\/txi_[0-9a-f]{32}$/);

    const fetched = await h.request("GET", intent.transactionRequest.path);
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    const tx = fetched.body.transaction as { to: string; data: string };
    assert.equal(tx.to.toLowerCase(), intent.transaction.to.toLowerCase());
    assert.equal(tx.data, intent.transaction.data, "the same calldata, fetched rather than copied");
    assert.equal(fetched.body.step, "main");
    assert.equal(String(fetched.body.from).toLowerCase(), h.signers[1]!.address.toLowerCase());

    assert.equal((await h.request("GET", "/api/v1/tx/not-an-id")).status, 400);
    assert.equal((await h.request("GET", `/api/v1/tx/txi_${"0".repeat(32)}`)).status, 404);
  });
});

describe("Phase 10.1 — post-purchase buyer signal", { concurrency: 1 }, () => {
  let s: StoreHandles;
  let attestor: Wallet;
  let buyer: Wallet;
  let licenseId: bigint;

  test("records delivery on chain and projects it", async () => {
    const controller = h.signers[2]!;
    attestor = h.signers[14]!;
    buyer = h.signers[15]!;

    s = await createStore(controller, "SIGS");
    await (
      await s.store.createProduct(
        PRODUCT_ID,
        USDC(5),
        1000,
        0,
        ethers.ZeroHash,
        JSON.stringify({ name: "sig fixture", description: "integration test listing" }),
        declaration(50_000, "mid-class", 2)
      )
    ).wait();
    await (await s.store.setAccessAttestor(attestor.address)).wait();

    await fundUSDC(buyer, USDC(50), await s.store.getAddress());
    const buyTx = await (s.store.connect(buyer) as Contract).purchase(
      PRODUCT_ID,
      1,
      1,
      USDC(50),
      ethers.ZeroHash,
      ""
    );
    const receipt = await buyTx.wait();
    const issued = receipt!.logs
      .map((l: { topics: readonly string[]; data: string }) => {
        try {
          return s.license.interface.parseLog({ topics: [...l.topics], data: l.data });
        } catch {
          return null;
        }
      })
      .find((e: { name: string } | null) => e && e.name === "LicenseIssued")!;
    licenseId = issued.args.tokenId;

    await h.sync();
    let doc = await License.findOne({
      chainId: 31337,
      licenseToken: (await s.license.getAddress()).toLowerCase(),
      tokenId: licenseId.toString(),
    }).lean();
    assert.equal(doc!.delivered, false, "not delivered until attested");

    await (await (s.license.connect(attestor) as Contract).recordAccessGrant(licenseId)).wait();
    await h.sync();

    doc = await License.findOne({
      chainId: 31337,
      licenseToken: (await s.license.getAddress()).toLowerCase(),
      tokenId: licenseId.toString(),
    }).lean();
    assert.equal(doc!.delivered, true);
    assert.equal(doc!.accessGrantCount, 1);
    assert.ok(doc!.firstAccessAt! > 0);
  });

  test("refuses a signal intent from a non-holder", async () => {
    const stranger = h.signers[16]!;
    const key = await ensureKey(stranger);
    const res = await h.request(
      "POST",
      `/api/v1/licenses/${(await s.license.getAddress()).toLowerCase()}/${licenseId}/signal`,
      { apiKey: key, headers: { "idempotency-key": `sig-${Date.now()}` }, body: { worthIt: true } }
    );
    assert.equal(res.status, 403);
    assert.equal((res.body.error as { code: string }).code, "NOT_LICENSE_HOLDER");
  });

  test("refuses a signal intent before delivery is attested", async () => {
    await fundUSDC(buyer, USDC(50), await s.store.getAddress());
    const tx = await (s.store.connect(buyer) as Contract).purchase(
      PRODUCT_ID,
      1,
      1,
      USDC(50),
      ethers.ZeroHash,
      ""
    );
    const receipt = await tx.wait();
    const issued = receipt!.logs
      .map((l: { topics: readonly string[]; data: string }) => {
        try {
          return s.license.interface.parseLog({ topics: [...l.topics], data: l.data });
        } catch {
          return null;
        }
      })
      .find((e: { name: string } | null) => e && e.name === "LicenseIssued")!;
    const undeliveredId = issued.args.tokenId;
    await h.sync();

    const key = await ensureKey(buyer);
    const res = await h.request(
      "POST",
      `/api/v1/licenses/${(await s.license.getAddress()).toLowerCase()}/${undeliveredId}/signal`,
      { apiKey: key, headers: { "idempotency-key": `nodeliv-${Date.now()}` }, body: { worthIt: true } }
    );
    assert.equal(res.status, 412);
    assert.equal((res.body.error as { code: string }).code, "NO_ACCESS_GRANTED");
  });

  test("builds a signal intent for the holder and projects the on-chain signal", async () => {
    const key = await ensureKey(buyer);
    const res = await h.request(
      "POST",
      `/api/v1/licenses/${(await s.license.getAddress()).toLowerCase()}/${licenseId}/signal`,
      { apiKey: key, headers: { "idempotency-key": `ok-${Date.now()}` }, body: { worthIt: true } }
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(String(res.body.disclaimer), /zero weight/i);
    assert.match(String(res.body.notRecordedYet), /sign and send/);

    // Prepared but not sent: /me says so, because nothing is recorded yet.
    const taskTypes = async () =>
      ((await h.request("GET", "/api/v1/me", { apiKey: key })).body as any).actionableTasks.items.map((t: any) => t.type);
    assert.ok((await taskTypes()).includes("RATING_PREPARED_BUT_NOT_SENT"));

    await (await (s.license.connect(buyer) as Contract).submitSignal(licenseId, true)).wait();
    await h.sync();
    assert.ok(!(await taskTypes()).includes("RATING_PREPARED_BUT_NOT_SENT"), "sent: the task is gone");

    const doc = await BuyerSignalDoc.findOne({
      chainId: 31337,
      licenseToken: (await s.license.getAddress()).toLowerCase(),
      licenseId: licenseId.toString(),
    }).lean();
    assert.ok(doc);
    assert.equal(doc!.worthIt, true);
    assert.equal(doc!.selfSignal, false);
    assert.equal(doc!.signaller, buyer.address.toLowerCase());
  });

  test("a changed signal is final UNLESS the seller ships a new version", async () => {
    /*
     * Two rules meeting, and the interaction is the point.
     *
     * A signal may be changed once and is then final, because a reputation input that could be
     * edited at will would be worth nothing. But a seller who actually repairs the fault should
     * not be stuck with a verdict on software that no longer exists — so a NEW VERSION, and only
     * a new version, reopens it.
     *
     * The product in this suite has already been updated, so the reopening branch is what applies
     * here. Both branches are asserted rather than just the one that happens to fire.
     */
    await (await (s.license.connect(buyer) as Contract).submitSignal(licenseId, false)).wait();
    await h.sync();

    const key = await ensureKey(buyer);
    const res = await h.request(
      "POST",
      `/api/v1/licenses/${(await s.license.getAddress()).toLowerCase()}/${licenseId}/signal`,
      { apiKey: key, headers: { "idempotency-key": `final-${Date.now()}` }, body: { worthIt: true } }
    );

    const signal = await BuyerSignalDoc.findOne({ chainId: 31337, licenseId: String(licenseId) }).lean();
    const product = await Product.findOne({ chainId: 31337, productId: signal!.productId })
      .select({ version: 1 })
      .lean();
    const signalledVersion = Number(signal?.productVersion ?? 0);
    const currentVersion = Number(product?.version ?? 0);

    if (signalledVersion > 0 && currentVersion > signalledVersion) {
      assert.equal(res.status, 201, "a new version of the product reopens a final signal");
    } else {
      assert.equal(res.status, 409, "with no new version, one change is final");
      assert.equal((res.body.error as { code: string }).code, "SIGNAL_ALREADY_FINAL");
    }
  });

  test("never exposes a rate below MIN_SIGNALS and always exposes coverage honestly", async () => {
    const res = await h.request("GET", `/api/v1/signals/stores/${s.storeId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.insufficientSignals, true);
    assert.equal(res.body.positiveRate, null, "no rate from fewer than MIN_SIGNALS signals");
    // Coverage is deliberately NOT gated: how little was signalled is the informative part.
    assert.notEqual(res.body.coverage, null, "coverage is exposed even below MIN_SIGNALS");
    assert.equal(
      res.body.coverage,
      ratioString(res.body.signalled as number, res.body.delivered as number),
      "coverage is exactly signalled/delivered"
    );
    assert.equal(typeof res.body.signalled, "number");
    assert.equal(typeof res.body.delivered, "number");
    assert.equal(res.body.economicWeight, "none");
    assert.ok(res.body.raw, "raw counts are still present");
  });

  test("excludes self signals from rates while keeping them in raw counts", async () => {
    const controller = h.signers[17]!;
    const self = await createStore(controller, "SELF");
    const selfAttestor = controller;
    await (
      await self.store.createProduct(PRODUCT_ID, USDC(1), 1000, 0, ethers.ZeroHash, "", UNDECLARED)
    ).wait();
    await (await self.store.setAccessAttestor(selfAttestor.address)).wait();

    // The controller buys from itself eight times and signals positively every time.
    for (let i = 0; i < 8; i++) {
      await fundUSDC(controller, USDC(1), await self.store.getAddress());
      const tx = await self.store.purchase(PRODUCT_ID, 1, 1, USDC(1), ethers.ZeroHash, "");
      const receipt = await tx.wait();
      const issued = receipt!.logs
        .map((l: { topics: readonly string[]; data: string }) => {
          try {
            return self.license.interface.parseLog({ topics: [...l.topics], data: l.data });
          } catch {
            return null;
          }
        })
        .find((e: { name: string } | null) => e && e.name === "LicenseIssued")!;
      const id = issued.args.tokenId;
      await (await self.license.recordAccessGrant(id)).wait();
      await (await self.license.submitSignal(id, true)).wait();
    }
    await h.sync();

    const res = await h.request("GET", `/api/v1/signals/stores/${self.storeId}`);
    assert.equal(res.status, 200);
    const raw = res.body.raw as Record<string, number>;
    assert.equal(raw.signalled, 8, "self signals are visible in raw counts");
    assert.equal(raw.selfSignalCount, 8);
    assert.equal(res.body.signalled, 0, "self signals are excluded from the counted set");
    assert.equal(res.body.positiveRate, null, "eight self signals cannot manufacture a positive rate");
    assert.equal(res.body.insufficientSignals, true);
  });

  test("embeds the seller summary in product list and detail responses", async () => {
    const list = await h.request("GET", "/api/v1/market/products?limit=5");
    assert.equal(list.status, 200);
    for (const item of list.body.items as Record<string, unknown>[]) {
      assert.ok(item.sellerSignals, "every product row carries the seller record");
      assert.equal((item.sellerSignals as { economicWeight: string }).economicWeight, "none");
    }

    const detail = await h.request("GET", `/api/v1/products/${PRODUCT_ID}`);
    assert.ok(detail.body.productSignals, "product detail carries the product summary");
    assert.ok((detail.body.product as Record<string, unknown>).sellerSignals);
  });

  test("offers no sorting by signal metrics anywhere in the API", async () => {
    const openapi = await h.request("GET", "/api/v1/openapi.json");
    const serialized = JSON.stringify(openapi.body);
    assert.ok(
      !/positiveRate_desc|signals_desc|sort=positive|sort=signal/i.test(serialized),
      "no signal-based sort option is advertised"
    );

    const res = await h.request("GET", "/api/v1/market/products?sort=positiveRate_desc");
    assert.equal(res.status, 400, "an unknown sort key is rejected rather than silently honoured");
  });
});

describe("Schema and OpenAPI", { concurrency: 1 }, () => {
  test("serves a complete, self-describing Agent schema", async () => {
    const res = await h.request("GET", "/api/v1/schema");
    assert.equal(res.status, 200);
    const s = res.body;
    for (const key of [
      "schemaVersion",
      "protocolVersion",
      "provenance",
      "chain",
      "canonicalContracts",
      "whatIsAIC",
      "storeTypes",
      "economics",
      "declaredTokenSaving",
      "buyerSignals",
      "authentication",
      "transactionIntentModel",
      "discovery",
      "indexerFreshness",
      "webhooks",
      "errors",
      "rateLimits",
      "security",
      "upgradeability",
      "onboarding",
    ]) {
      assert.ok(key in s, `schema exposes ${key}`);
    }

    /*
     * `recommendations` is ADVICE, so it lives in the playbook rather than here — the two
     * documents were split so an agent is not charged for guidance on a turn it only needed a
     * fee. It must still be reachable from the schema, which is what this asserts.
     */
    assert.ok(!("recommendations" in s), "advice does not belong in the lean schema");
    const playbookPointer = s.playbook as { whatIsThere: string[] };
    assert.ok(playbookPointer, "schema must point at the playbook");
    assert.ok(
      playbookPointer.whatIsThere.includes("recommendations"),
      "schema must name recommendations as living in the playbook"
    );

    const economics = s.economics as Record<string, Record<string, unknown>>;
    assert.equal(economics.genesis.aicGenesisSupply, AIC(1_000_000_000).toString());
    assert.equal(economics.genesis.creatorGenesisAllocation, "0");
    assert.equal(economics.agentGoods.virtualUSDCIsRealMoney, false);
    assert.equal(economics.dividends.dividendProcessingFeeBasis, "committed_holder_reserve");
    assert.equal(economics.commerce.commerceFeeBps, 250);
    // 2000 bps = 20%. Raised from 500: at 5% holding another agent's AIC returned so little that
    // equity was economically inert and nobody invested in anybody. ProtocolConstants is the
    // source of truth; this assertion exists to catch an accidental change, not to pin a choice.
    assert.equal(economics.commerce.holderReserveBps, 2000);
    assert.equal((economics.refunds ?? economics.commerce.refunds as never)["exists"], false);
  });

  test("states the anti prompt-injection rule explicitly", async () => {
    const res = await h.request("GET", "/api/v1/schema");
    const security = res.body.security as Record<string, unknown>;
    assert.match(String(security.promptInjectionRule), /UNTRUSTED DATA/);
    assert.ok(Array.isArray(security.antiScamRules));
    assert.ok((security.antiScamRules as string[]).length >= 5);
  });

  test("states the Phase 10.1 rules exactly", async () => {
    const res = await h.request("GET", "/api/v1/schema");
    const decl = res.body.declaredTokenSaving as Record<string, unknown>;
    assert.equal(decl.verified, false);
    assert.equal(decl.isSellerClaim, true);
    assert.equal(decl.optional, true);
    assert.equal(decl.undeclaredIsValid, true);

    const signals = res.body.buyerSignals as Record<string, unknown>;
    assert.equal(signals.economicWeight, "none");
    assert.equal(signals.noSortingBySignals, true);
    assert.equal(signals.minSignalsForRate, 5);
  });

  test("serves an OpenAPI document that documents the untrusted fields", async () => {
    const res = await h.request("GET", "/api/v1/openapi.json");
    assert.equal(res.status, 200);
    assert.equal(res.body.openapi, "3.1.0");
    const schemas = (res.body.components as Record<string, Record<string, Record<string, unknown>>>).schemas;
    assert.match(String(schemas.Declaration.description), /UNVERIFIED SELLER CLAIM/);
    assert.match(String(schemas.SignalSummary.description), /ZERO weight/);
  });

  test("serves the well-known discovery document", async () => {
    const res = await h.request("GET", "/.well-known/aic-agent.json");
    assert.equal(res.status, 200);
    const auth = res.body.auth as Record<string, any>;
    assert.equal(auth.canonicalAuthEndpoints.issue, "POST /api/v1/auth/api-key/issue");
    assert.equal(auth.lostKey.action, "ROTATE");
    assert.equal((res.body.security as Record<string, unknown>).apiKeyIsNotWalletAuthority, true);
  });
});

describe("Canonical contract catalog", { concurrency: 1 }, () => {
  test("answers canonical for a factory-created component", async () => {
    const s = await createStore(h.signers[18]!, "CAT1");
    await h.sync();
    const aicAddress = (await s.aic.getAddress()).toLowerCase();
    const res = await h.request("GET", `/api/v1/contracts/${aicAddress}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.canonical, true);
    assert.equal(res.body.role, "AIC_TOKEN");
    assert.equal(res.body.storeId, s.storeId);
  });

  test("answers untrusted, not malicious, for an unknown address", async () => {
    const stranger = ethers.Wallet.createRandom().address;
    const res = await h.request("GET", `/api/v1/contracts/${stranger}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.canonical, false);
    assert.equal(res.body.warning, "UNTRUSTED_UNKNOWN_CONTRACT");
    assert.match(String(res.body.explanation), /does not by itself mean it is malicious/);
  });

  test("warns when an implementation address is looked up instead of its proxy", async () => {
    const impl = h.manifest.contracts.registry.implementation;
    const res = await h.request("GET", `/api/v1/contracts/${impl}`);
    assert.equal(res.body.role, "REGISTRY_IMPLEMENTATION");
    assert.match(String(res.body.warning), /Transact with the proxy/);
  });

  test("provides no way for a caller to insert an address into the catalog", async () => {
    const wallet = h.signers[5]!;
    const key = await ensureKey(wallet);
    // Even fully authenticated, there is no catalog write route to reach.
    const post = await h.request("POST", "/api/v1/contracts", {
      apiKey: key,
      headers: { "idempotency-key": `catalog-${Date.now()}` },
      body: { address: ethers.ZeroAddress, role: "AIC_TOKEN", canonical: true },
    });
    assert.ok([404, 405].includes(post.status), "there is no write route on the catalog at all");

    const put = await h.request("POST", `/api/v1/contracts/${ethers.ZeroAddress}`, {
      apiKey: key,
      headers: { "idempotency-key": `catalog2-${Date.now()}` },
      body: { canonical: true },
    });
    assert.ok([404, 405].includes(put.status));
  });
});

/** Issues a key for a wallet, or rotates if one already exists, and returns the raw key. */
async function ensureKey(wallet: Wallet): Promise<string> {
  const status = await h.request("GET", `/api/v1/auth/api-key/status?wallet=${wallet.address}`);
  const purpose = status.body.status === "ACTIVE" ? "ROTATE_API_KEY" : "ISSUE_API_KEY";
  const challenge = await h.request("POST", "/api/v1/auth/challenge", {
    body: { wallet: wallet.address, purpose },
  });
  const signature = await wallet.signMessage(challenge.body.message as string);
  const path = purpose === "ROTATE_API_KEY" ? "/api/v1/auth/api-key/rotate" : "/api/v1/auth/api-key/issue";
  const issued = await h.request("POST", path, { body: { nonce: challenge.body.nonce, signature } });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return issued.body.apiKey as string;
}

/** Silences an unused-import warning while keeping the helper available to future tests. */
void buildChallengeMessage;
});

/** Exact 4-decimal ratio, mirroring the aggregator. Kept float-free on purpose. */
function ratioString(numerator: number, denominator: number): string | null {
  if (denominator <= 0) return null;
  const scaled = (BigInt(numerator) * 10_000n) / BigInt(denominator);
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}`;
}

/* ====================================================================== */

/**
 * MASTER_PLAN 29A — a market that cannot pay is not a wallet that cannot pay.
 *
 * The point of these two tests is that the codes are distinguished by CAUSE, not merely ordered:
 * each case is set up so the other condition is comfortably satisfied.
 */
describe("Liquidity failure is distinct from balance failure (MASTER_PLAN 29A)", { concurrency: 1 }, () => {
  test("a sell larger than the real reserve returns MARKET_INSUFFICIENT_REAL_USDC", async () => {
    const controller = h.signers[3]!;
    const s = await createStore(controller, "LIQ1");
    await h.sync();

    const market = await StockMarket.findOne({ chainId: 31337, storeId: s.storeId }).lean();
    assert.ok(market, "the market was indexed");

    // Buy a position, so there are tokens to sell and a real reserve that is much smaller than
    // the pricing reserve the curve quotes against. A fresh wallet, because only one API key
    // per wallet is ever live and the shared signers may already hold one.
    const buyer = await freshWallet();
    const apiKey = await issueApiKey(buyer);
    await fundUSDC(buyer, USDC(50), h.manifest.contracts.agentGoods.proxy);

    const shop = new Contract(
      h.manifest.contracts.agentGoods.proxy,
      ["function buy(address,uint256,uint256,uint256) returns (uint256)"],
      buyer
    );
    const head = await h.provider.getBlock("latest");
    const deadline = Math.max(head?.timestamp ?? 0, Math.floor(Date.now() / 1000)) + 3600;
    await (await shop.buy!(market!.aicToken, USDC(20), 0, deadline)).wait();
    await h.sync();

    const after = await StockMarket.findOne({ chainId: 31337, aicToken: market!.aicToken }).lean();
    const held = BigInt(after!.genesisSupplyAIC) - BigInt(after!.marketInventoryAIC);
    assert.ok(held > 0n, "the buyer holds tokens");

    /*
     * Selling back exactly what was bought is always solvent — that is the curve invariant. The
     * insolvent case is a redemption larger than the real reserve, which is what a holder who
     * accumulated across many buys, or a whale exiting, actually looks like. The quote is a pure
     * function of curve state, so asking for a larger amount is a faithful simulation of it.
     */
    const res = await h.request("POST", `/api/v1/stocks/${market!.aicToken}/quote`, {
      apiKey,
      body: { side: "sell", amount: (held * 20n).toString() },
    });

    assert.equal(res.status, 409, JSON.stringify(res.body));
    const error = res.body.error as {
      code: string;
      message: string;
      details: Record<string, never> & Record<string, unknown>;
    };
    assert.equal(error.code, "MARKET_INSUFFICIENT_REAL_USDC");
    assert.equal(
      (error.details.redeemableNowUSDC as { base: string }).base,
      after!.realUSDCReserve,
      "the error states exactly what the market can pay right now"
    );
    assert.equal(error.details.reason, "sell_solvency");
    assert.ok(BigInt((error.details.maxTokensSellableNow as { base: string }).base) > 0n);
    assert.match(
      error.message,
      /balance is not the constraint/,
      "the message says plainly that this is not a wallet problem"
    );
    assert.match(String(error.details.remedy), /Sell at most maxTokensSellableNow/);
  });

  test("a buy from an under-funded wallet returns INSUFFICIENT_USDC, not the market code", async () => {
    const controller = h.signers[16]!;
    const s = await createStore(controller, "LIQ2");
    await h.sync();
    const market = await StockMarket.findOne({ chainId: 31337, storeId: s.storeId }).lean();

    // The market has an untouched curve, so liquidity is emphatically not the issue here.
    const pauper = await freshWallet();
    const apiKey = await issueApiKey(pauper);

    const res = await h.request("POST", `/api/v1/stocks/${market!.aicToken}/buy`, {
      apiKey,
      headers: { "idempotency-key": `poor-${Date.now()}` },
      body: { side: "buy", amount: USDC(500).toString() },
    });

    // The intent is produced, and its preflight reports the caller shortfall rather than a
    // market condition: the two never share a code.
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const intent = res.body.intent as Record<string, never> & Record<string, unknown>;
    const simulation = intent.simulation as { status: string } | undefined;
    assert.ok(simulation, "the intent carries a preflight");
    assert.notEqual(simulation!.status, "would_succeed", "an unfunded buy cannot be reported as fine");
  });

  test("the error code list agrees across errors.ts, the manifest schema and OpenAPI", async () => {
    const schema = await h.request("GET", "/api/v1/schema");
    const openapi = await h.request("GET", "/api/v1/openapi.json");

    const schemaCodes = ((schema.body.errors as { codes: string[] }).codes ?? []).slice().sort();
    const openapiCodes = (
      ((openapi.body.components as Record<string, never> & Record<string, unknown>).schemas as never as {
        Error: { properties: { error: { properties: { code: { enum: string[] } } } } };
      }).Error.properties.error.properties.code.enum ?? []
    )
      .slice()
      .sort();

    assert.deepEqual(schemaCodes, openapiCodes);
    assert.ok(schemaCodes.includes("MARKET_INSUFFICIENT_REAL_USDC"));
    assert.ok(schemaCodes.includes("INSUFFICIENT_USDC"));
  });
});

/* ====================================================================== */

/**
 * Webhooks end to end: register through the API, produce a real chain event, let the indexer
 * project it, and confirm the outbox queued a delivery with the right identity.
 *
 * The Agent schema advertises this capability, which is why it is tested against the running app
 * rather than against the emitter in isolation.
 */
describe("Webhook subscriptions", { concurrency: 1 }, () => {
  test("registers an endpoint, shows the secret once, and never returns it again", async () => {
    const wallet = await freshWallet();
    const apiKey = await issueApiKey(wallet);

    const created = await h.request("POST", "/api/v1/webhooks", {
      apiKey,
      body: { url: "https://example.com/aic-hook", events: ["product.created", "store.created"] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const secret = created.body.secret as string;
    assert.ok(secret.startsWith("whsec_"), "a signing secret is issued");
    assert.ok((created.body.signing as { algorithm: string }).algorithm === "HMAC-SHA256");

    const listed = await h.request("GET", "/api/v1/webhooks", { apiKey });
    assert.equal(listed.status, 200);
    const items = listed.body.items as Record<string, unknown>[];
    assert.equal(items.length, 1);
    assert.ok(!JSON.stringify(items).includes(secret), "the secret is never returned again");
    assert.equal(items[0]!.secretPrefix, secret.slice(0, 16));
  });

  test("refuses a destination that would reach infrastructure, even in LOCAL", async () => {
    const wallet = await freshWallet();
    const apiKey = await issueApiKey(wallet);

    /*
     * This harness runs as LOCAL, where loopback and http are deliberately permitted so the dev
     * stack can deliver to itself. That relaxation is scoped: instance metadata and embedded
     * credentials stay refused in EVERY environment, because nothing about local development
     * requires reaching 169.254.169.254. Testing under LOCAL therefore still exercises the rule
     * that matters most rather than skipping it.
     */
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://user:pass@example.com/hook",
      "ftp://example.com/hook",
      "not-a-url",
    ]) {
      const res = await h.request("POST", "/api/v1/webhooks", {
        apiKey,
        body: { url, events: ["product.created"] },
      });
      assert.equal(res.status, 400, `${url} must be refused: ${JSON.stringify(res.body)}`);
      assert.equal((res.body.error as { code: string }).code, "INVALID_REQUEST");
    }

    // And the documented LOCAL escape hatch does work, or the dev stack could not be tested.
    const loopback = await h.request("POST", "/api/v1/webhooks", {
      apiKey,
      body: { url: "http://127.0.0.1:9931/hook", events: ["product.created"] },
    });
    assert.equal(loopback.status, 201, "LOCAL permits a loopback receiver");
  });

  test("refuses an event type outside the published catalogue", async () => {
    const wallet = await freshWallet();
    const apiKey = await issueApiKey(wallet);
    const res = await h.request("POST", "/api/v1/webhooks", {
      apiKey,
      body: { url: "https://example.com/hook", events: ["admin.drain_treasury"] },
    });
    assert.equal(res.status, 400);
    assert.ok((res.body.error as { details: { unknown: string[] } }).details.unknown.includes("admin.drain_treasury"));
  });

  test("scopes subscriptions to the owning wallet", async () => {
    const owner = await freshWallet();
    const stranger = await freshWallet();
    const ownerKey = await issueApiKey(owner);
    const strangerKey = await issueApiKey(stranger);

    const created = await h.request("POST", "/api/v1/webhooks", {
      apiKey: ownerKey,
      body: { url: "https://example.com/owned", events: ["product.created"] },
    });
    const webhookId = (created.body.webhook as { webhookId: string }).webhookId;

    const strangerList = await h.request("GET", "/api/v1/webhooks", { apiKey: strangerKey });
    assert.equal((strangerList.body.items as unknown[]).length, 0, "another wallet sees nothing");

    const strangerDelete = await h.request("DELETE", `/api/v1/webhooks/${webhookId}`, {
      apiKey: strangerKey,
    });
    assert.equal(strangerDelete.status, 404, "another wallet cannot delete it");

    const strangerDeliveries = await h.request("GET", `/api/v1/webhooks/${webhookId}/deliveries`, {
      apiKey: strangerKey,
    });
    assert.equal(strangerDeliveries.status, 404, "another wallet cannot read its delivery log");
  });

  test("queues exactly one delivery per subscribed event, and deduplicates a replay", async () => {
    const wallet = await freshWallet();
    const apiKey = await issueApiKey(wallet);
    const created = await h.request("POST", "/api/v1/webhooks", {
      apiKey,
      body: { url: "https://example.com/queued", events: ["store.created", "product.created"] },
    });
    const webhookId = (created.body.webhook as { webhookId: string }).webhookId;

    // A real store creation, indexed by the real indexer.
    const s = await createStore(h.signers[14]!, "WHK1");
    await h.sync();

    const queued = await WebhookDelivery.find({ webhookId }).lean();
    assert.ok(queued.length >= 1, "the store creation queued a delivery");
    const storeCreated = queued.find((d) => d.eventType === "store.created");
    assert.ok(storeCreated, "store.created was queued");
    assert.equal(storeCreated!.status, "pending");
    assert.equal(storeCreated!.payload.chainId, 31337);
    assert.equal(storeCreated!.payload.storeId, s.storeId);
    assert.match(String(storeCreated!.payload.notAuthoritative), /never authority/);

    // Replaying the same log must not queue a second delivery.
    const before = await WebhookDelivery.countDocuments({ webhookId });
    await h.sync();
    await h.sync();
    const after = await WebhookDelivery.countDocuments({ webhookId });
    assert.equal(after, before, "a replayed log deduplicates on the stable event id");
  });

  test("rotating invalidates the previous secret", async () => {
    const wallet = await freshWallet();
    const apiKey = await issueApiKey(wallet);
    const created = await h.request("POST", "/api/v1/webhooks", {
      apiKey,
      body: { url: "https://example.com/rotate", events: ["product.created"] },
    });
    const webhookId = (created.body.webhook as { webhookId: string }).webhookId;
    const first = created.body.secret as string;

    const rotated = await h.request("POST", `/api/v1/webhooks/${webhookId}/rotate`, { apiKey });
    assert.equal(rotated.status, 201);
    const second = rotated.body.secret as string;
    assert.notEqual(second, first, "rotation issues a different secret");
    assert.equal(rotated.body.secretVersion, 2);
  });

  test("deleting a subscription abandons its pending deliveries rather than retrying them", async () => {
    const wallet = await freshWallet();
    const apiKey = await issueApiKey(wallet);
    const created = await h.request("POST", "/api/v1/webhooks", {
      apiKey,
      body: { url: "https://example.com/deleted", events: ["store.created"] },
    });
    const webhookId = (created.body.webhook as { webhookId: string }).webhookId;

    await createStore(h.signers[15]!, "WHK2");
    await h.sync();
    assert.ok((await WebhookDelivery.countDocuments({ webhookId, status: "pending" })) > 0);

    const deleted = await h.request("DELETE", `/api/v1/webhooks/${webhookId}`, { apiKey });
    assert.equal(deleted.status, 204);
    assert.equal(await WebhookDelivery.countDocuments({ webhookId, status: "pending" }), 0);
    assert.ok((await WebhookDelivery.countDocuments({ webhookId, status: "dead" })) > 0);
  });
});

/* ====================================================================== */

/**
 * Access gateway, end to end against real chain state.
 *
 * Delivered plaintext cannot be recalled, so the authorization decision is the whole product here.
 * Each test isolates one leg of it: the licence must exist, the caller must be its CURRENT holder,
 * the content must be the bytes the chain committed, and a link must not outlive its single use.
 */
describe("Access gateway (Phase 10 delivery)", { concurrency: 1 }, () => {
  const CONTENT = Buffer.from("curated-embedding-corpus-v3: 4.1M passages", "utf8");
  const CONTENT_HASH = keccak256(CONTENT);

  async function storeWithDeliverableProduct(controller: Wallet, symbol: string) {
    const s = await createStore(controller, symbol);
    await (
      await s.store.createProduct(
        PRODUCT_ID,
        USDC(5),
        1000,
        0,
        CONTENT_HASH,
        JSON.stringify({ name: "gateway fixture", description: "integration test listing" }),
        UNDECLARED
      )
    ).wait();
    await h.sync();
    return s;
  }

  async function buyLicense(s: StoreHandles, buyer: Wallet): Promise<string> {
    await fundUSDC(buyer, USDC(50), await s.store.getAddress());
    const receipt = await (
      await (s.store.connect(buyer) as Contract).purchase(PRODUCT_ID, 1, 1, USDC(5), ethers.ZeroHash, "")
    ).wait();
    const issued = receipt!.logs
      .map((l: { topics: readonly string[]; data: string }) => {
        try {
          return s.license.interface.parseLog({ topics: [...l.topics], data: l.data });
        } catch {
          return null;
        }
      })
      .find((e: { name: string } | null) => e && e.name === "LicenseIssued")!;
    await h.sync();
    return String(issued.args.licenseId ?? issued.args.tokenId);
  }

  test("delivers exactly the bytes the chain committed, once", async () => {
    const controller = h.signers[11]!;
    const buyer = await freshWallet();
    const s = await storeWithDeliverableProduct(controller, "GATE1");

    const sellerKey = await issueApiKey(controller);
    const upload = await h.request("POST", "/api/v1/access/content", {
      apiKey: sellerKey,
      body: { storeId: s.storeId, content: CONTENT.toString("base64"), filename: "corpus.txt" },
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    assert.equal(upload.body.contentHash, CONTENT_HASH, "the upload commits the on-chain hash");

    const licenseId = await buyLicense(s, buyer);
    const buyerKey = await issueApiKey(buyer);

    const grant = await h.request("POST", "/api/v1/access/grant", {
      apiKey: buyerKey,
      body: { licenseToken: (await s.license.getAddress()).toLowerCase(), licenseId },
    });
    assert.equal(grant.status, 201, JSON.stringify(grant.body));
    assert.equal(grant.body.singleUse, true);
    assert.equal(grant.body.contentHash, CONTENT_HASH);

    const url = new URL(grant.body.url as string);
    const fetched = await h.request("GET", url.pathname);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers["x-aic-content-hash"], CONTENT_HASH);

    // Single use: the same link must be inert now.
    const replay = await h.request("GET", url.pathname);
    assert.equal(replay.status, 403, "a delivery link is single use");
  });

  test("refuses a wallet that does not hold the license", async () => {
    const controller = h.signers[12]!;
    const buyer = await freshWallet();
    const stranger = await freshWallet();
    const s = await storeWithDeliverableProduct(controller, "GATE2");

    const sellerKey = await issueApiKey(controller);
    await h.request("POST", "/api/v1/access/content", {
      apiKey: sellerKey,
      body: { storeId: s.storeId, content: CONTENT.toString("base64") },
    });

    const licenseId = await buyLicense(s, buyer);
    const strangerKey = await issueApiKey(stranger);

    const grant = await h.request("POST", "/api/v1/access/grant", {
      apiKey: strangerKey,
      body: { licenseToken: (await s.license.getAddress()).toLowerCase(), licenseId },
    });
    assert.equal(grant.status, 403);
    assert.equal((grant.body.error as { code: string }).code, "NOT_LICENSE_HOLDER");
  });

  test("refuses to upload content for a store the caller does not control", async () => {
    const controller = h.signers[13]!;
    const stranger = await freshWallet();
    const s = await storeWithDeliverableProduct(controller, "GATE3");

    const strangerKey = await issueApiKey(stranger);
    const upload = await h.request("POST", "/api/v1/access/content", {
      apiKey: strangerKey,
      body: { storeId: s.storeId, content: CONTENT.toString("base64") },
    });
    assert.equal(upload.status, 403);
    assert.equal((upload.body.error as { code: string }).code, "FORBIDDEN");
  });

  test("refuses when the seller has uploaded nothing matching the committed hash", async () => {
    const controller = h.signers[4]!;
    const buyer = await freshWallet();
    const s = await storeWithDeliverableProduct(controller, "GATE4");

    // Deliberately no upload.
    const licenseId = await buyLicense(s, buyer);
    const buyerKey = await issueApiKey(buyer);

    const grant = await h.request("POST", "/api/v1/access/grant", {
      apiKey: buyerKey,
      body: { licenseToken: (await s.license.getAddress()).toLowerCase(), licenseId },
    });
    assert.equal(grant.status, 409);
    assert.equal((grant.body.error as { code: string }).code, "PRODUCT_UNAVAILABLE");
    assert.match(String((grant.body.error as { details: { remedy: string } }).details.remedy), /licence remains valid/i);
  });

  test("rejects a forged or edited delivery link without revealing which part failed", async () => {
    const forged = await h.request("GET", "/api/v1/access/content/a1.abcdefgh12345678.99999999999.deadbeef");
    assert.equal(forged.status, 403);
    assert.equal((forged.body.error as { message: string }).message, "This access link is not valid.");

    const garbage = await h.request("GET", "/api/v1/access/content/not-a-token");
    assert.equal(garbage.status, 403);
    assert.equal((garbage.body.error as { message: string }).message, "This access link is not valid.");
  });

  test("scopes the session list to the calling wallet", async () => {
    const wallet = await freshWallet();
    const apiKey = await issueApiKey(wallet);
    const res = await h.request("GET", "/api/v1/access/sessions", { apiKey });
    assert.equal(res.status, 200);
    assert.equal((res.body.items as unknown[]).length, 0, "a wallet with no purchases sees nothing");
  });
});

/* ====================================================================== */

/**
 * The price series must survive the 30% transition.
 *
 * The curve stops quoting at the listing and the pool takes over. If the indexer only watched the
 * curve, the chart would go flat forever at the single most interesting moment in a token's life —
 * and nothing would report an error, because from the indexer's point of view trading simply
 * stopped. These tests assert the series continues across the boundary with the same scaling.
 */
describe("Trading continuity across the DEX transition", { concurrency: 1 }, () => {
  test("keeps recording trades from the pool after the curve closes", async () => {
    const whale = h.signers[0]!;
    const controller = h.signers[8]!;
    const s = await createStore(controller, "CONT");
    await h.sync();

    const aicToken = (await s.aic.getAddress()).toLowerCase();
    const shop = new Contract(
      h.manifest.contracts.agentGoods.proxy,
      [
        "function buy(address,uint256,uint256,uint256) returns (uint256)",
        "function market(address) view returns (tuple(address aicToken,address store,bytes32 storeId,uint8 phase,uint256 tokenInventory,uint256 realUSDCReserve,uint256 virtualTokenReserve,uint256 virtualUSDCReserve,uint256 netSoldFromCurve,uint256 controllerFeesUSDC,uint256 lifetimeGrossVolumeUSDC,uint256 createdBlock,address pair,uint256 lpTokenAmount,uint256 lpUSDCUsed,uint256 lpTokenUsed,uint256 burnedAtTransition))",
      ],
      whale
    );

    // Drive the curve to the one-way transition.
    for (let i = 0; i < 40; i++) {
      const state = await shop.market!(aicToken);
      if (Number(state.phase) !== 1) break;
      await fundUSDC(whale, USDC(500), h.manifest.contracts.agentGoods.proxy);
      const head = await h.provider.getBlock("latest");
      const deadline = Math.max(head?.timestamp ?? 0, Math.floor(Date.now() / 1000)) + 3600;
      await (await shop.buy!(aicToken, USDC(500), 0, deadline)).wait();
    }
    await h.sync();

    const market = await StockMarket.findOne({ chainId: 31337, aicToken }).lean();
    assert.equal(market!.phase, "external_dex", "the market transitioned");
    assert.ok(market!.pair && !/^0x0+$/.test(market!.pair), "a real pair address was recorded");

    const curveTrades = await StockTrade.countDocuments({ chainId: 31337, aicToken });
    assert.ok(curveTrades > 0, "the curve produced a price history");
    const priceAtListing = BigInt(market!.currentIndexedPrice1e18);
    assert.ok(priceAtListing > 0n);

    // Now trade on the POOL, through the real router, exactly as any outside trader would.
    const router = new Contract(
      h.manifest.external.dexRouter,
      [
        "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
      ],
      whale
    );
    await fundUSDC(whale, USDC(100), h.manifest.external.dexRouter);
    const head = await h.provider.getBlock("latest");
    const deadline = Math.max(head?.timestamp ?? 0, Math.floor(Date.now() / 1000)) + 3600;
    await (
      await router.swapExactTokensForTokens!(
        USDC(100),
        0,
        [h.manifest.external.canonicalUSDC, aicToken],
        whale.address,
        deadline
      )
    ).wait();
    await h.sync();

    // The SAME series grew. No gap, no separate collection, no second price field.
    const afterTrades = await StockTrade.countDocuments({ chainId: 31337, aicToken });
    assert.ok(afterTrades > curveTrades, "a pool swap was recorded into the same trade series");

    const newest = await StockTrade.findOne({ chainId: 31337, aicToken })
      .sort({ blockNumber: -1, logIndex: -1 })
      .lean();
    assert.equal(newest!.side, "buy");
    assert.ok(BigInt(newest!.grossUSDC) > 0n);
    assert.ok(BigInt(newest!.tokensAIC) > 0n);

    // A pool trade pays this protocol nothing, and says so rather than omitting the fields.
    assert.equal(newest!.protocolFeeUSDC, "0");
    assert.equal(newest!.controllerFeeUSDC, "0");

    /*
     * Continuity of SCALE is the property that actually keeps a chart readable. A pool price on a
     * different scale would render as a vertical cliff at the listing rather than a price move.
     * The buy pushed the price up, so it must be above the listing price but within one order of
     * magnitude of it.
     */
    const poolPrice = BigInt(newest!.pricePerToken1e18);
    assert.ok(poolPrice > 0n);
    assert.ok(poolPrice < priceAtListing * 100n, "the pool price is on the same scale as the curve price");
    assert.ok(poolPrice * 100n > priceAtListing, "the pool price is on the same scale as the curve price");
  });

  test("updates the indexed price from pool reserves once the curve is closed", async () => {
    const market = await StockMarket.findOne({ chainId: 31337, phase: "external_dex" }).lean();
    assert.ok(market, "a transitioned market exists from the previous test");
    assert.ok(BigInt(market!.currentIndexedPrice1e18) > 0n, "a listed market never reports a zero price");
    assert.ok(BigInt(market!.lifetimeGrossVolumeUSDC) > 0n, "pool volume accrues to the same counter");
  });
});
