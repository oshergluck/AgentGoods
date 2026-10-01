/**
 * `GET /api/v1/me` — the Agent Control Snapshot.
 *
 * The endpoint's value is that an Agent can trust it without cross-checking, so the tests are
 * weighted toward the properties that would make it untrustworthy rather than toward field
 * presence:
 *
 *   - **wallet isolation**, because a leak here exposes every Agent's private position at once;
 *   - **bounded output**, because an endpoint that degrades with an Agent's success fails exactly
 *     the Agents who use the protocol most;
 *   - **no RPC**, because Rule 14 is what makes this cheap enough to poll;
 *   - **deterministic task ids**, because an Agent that de-duplicates on them would otherwise act
 *     twice on one obligation.
 *
 * A brand-new Agent with nothing is tested first and deliberately: the empty case is the one every
 * Agent hits on its first call, and the one most likely to throw on an unguarded `.length`.
 */

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {
  createHarness,
  startChain,
  deployProtocol,
  stopChain,
  UNDECLARED,
  USDC,
  type Harness, createStoreOnChain } from "./helpers/harness";
import { forbidRpc, allowRpc, rpcMetrics, resetRpcMetrics } from "../src/rpc/provider";

let h: Harness;

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

async function me(apiKey: string) {
  return h.request("GET", "/api/v1/me", { apiKey });
}

before(async () => {
  await startChain();
  await deployProtocol();
  h = await createHarness();
});

after(async () => {
  await h?.stop();
  await stopChain();
});

describe("GET /api/v1/me — Agent Control Snapshot", { concurrency: 1 }, () => {
  test("refuses an unauthenticated request", async () => {
    const res = await h.request("GET", "/api/v1/me");
    assert.equal(res.status, 401);
  });

  test("a brand-new Agent with nothing gets a complete, empty, non-throwing snapshot", async () => {
    /*
     * The first call every Agent ever makes. Every collection must exist and be empty rather than
     * absent — an Agent reading `stores.items.length` should not have to guard against undefined
     * on its very first request.
     */
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);
    const res = await me(key);

    assert.equal(res.status, 200);
    const b = res.body as Record<string, any>;

    assert.equal(b.identity.wallet, wallet.address);
    assert.equal(b.identity.apiKeyStatus, "ACTIVE");
    assert.ok("asOfIndexedBlock" in b);
    assert.ok(b.consistency?.model, "consistency semantics must be stated, not implied");

    for (const section of ["stores", "products", "licenses", "aicPositions", "pendingTransactions"]) {
      assert.equal(b[section].count, 0, `${section}.count`);
      assert.deepEqual(b[section].items, [], `${section}.items`);
    }
    assert.equal(b.dividends.claimableCount, 0);
    assert.ok(Array.isArray(b.actionableTasks.items));
  });

  test("NEVER returns the API key, a hash, or any secret", async () => {
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);
    const res = await me(key);
    const serialized = JSON.stringify(res.body);

    assert.ok(!serialized.includes(key), "the raw API key must never be echoed");
    assert.ok(!/apiKeyHash|passwordHash|privateKey|mnemonic|seedPhrase/i.test(serialized));
    // The prefix is fine to show; the key is not. Guard against a future refactor leaking it.
    assert.ok(!("apiKey" in (res.body as Record<string, unknown>).identity!));
  });

  test("WALLET ISOLATION: a key for A cannot read B, by any parameter", async () => {
    /*
     * The single most important test here. `/me` has no wallet parameter at all, so the check is
     * that adding one cannot change whose data comes back — not that it is rejected, but that it
     * is ignored entirely.
     */
    const a = await freshWallet();
    const b = await freshWallet();
    const keyA = await issueApiKey(a);
    await issueApiKey(b);

    for (const attempt of [
      `/api/v1/me?wallet=${b.address}`,
      `/api/v1/me?agent=${b.address}`,
      `/api/v1/me?address=${b.address}`,
      `/api/v1/me?wallet=${b.address.toLowerCase()}`,
    ]) {
      const res = await h.request("GET", attempt, { apiKey: keyA });
      const body = JSON.stringify(res.body);

      /*
       * Two acceptable outcomes, and the assertion is about what must NEVER happen rather than
       * which of the two occurs: either the request is refused outright, or it succeeds and
       * returns A's own state. What it must never do is return B's.
       *
       * In practice `selfWallet` refuses a mismatched wallet parameter with 403, which is the
       * stronger behaviour — it tells a misconfigured Agent it is wrong instead of silently
       * answering a different question than the one it asked.
       */
      if (res.status === 200) {
        assert.equal(
          (res.body as Record<string, any>).identity.wallet,
          a.address,
          `${attempt} returned a 200 but not A's own state`
        );
      } else {
        assert.ok([400, 403].includes(res.status), `${attempt} -> unexpected ${res.status}`);
      }
      assert.ok(
        !body.toLowerCase().includes(b.address.toLowerCase()),
        `${attempt} must never leak wallet B`
      );
    }
  });

  test("a revoked key is refused, and a rotated key invalidates the previous one", async () => {
    const wallet = await freshWallet();
    const first = await issueApiKey(wallet);
    assert.equal((await me(first)).status, 200);

    // Rotation is signature-gated exactly like issuance: holding the old key is not enough.
    const rotChallenge = await h.request("POST", "/api/v1/auth/challenge", {
      body: { wallet: wallet.address, purpose: "ROTATE_API_KEY" },
    });
    assert.equal(rotChallenge.status, 201, JSON.stringify(rotChallenge.body));
    const rotSig = await wallet.signMessage(rotChallenge.body.message as string);
    const rotated = await h.request("POST", "/api/v1/auth/api-key/rotate", {
      apiKey: first,
      body: { nonce: rotChallenge.body.nonce, signature: rotSig },
    });
    assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
    const second = rotated.body.apiKey as string;

    assert.equal((await me(second)).status, 200, "the new key works");
    assert.equal((await me(first)).status, 401, "the superseded key must stop working");

    const revChallenge = await h.request("POST", "/api/v1/auth/challenge", {
      body: { wallet: wallet.address, purpose: "REVOKE_API_KEY" },
    });
    assert.equal(revChallenge.status, 201, JSON.stringify(revChallenge.body));
    const revSig = await wallet.signMessage(revChallenge.body.message as string);
    const revoked = await h.request("POST", "/api/v1/auth/api-key/revoke", {
      apiKey: second,
      body: { nonce: revChallenge.body.nonce, signature: revSig },
    });
    assert.ok([200, 201].includes(revoked.status), JSON.stringify(revoked.body));
    assert.equal((await me(second)).status, 401, "a revoked key must be refused");
  });

  test("two different wallets can each revoke their key (the revoked hash is removed, not nulled)", async () => {
    // A null apiKeyHash is indexed even by a sparse unique index: the second revoke used to 500.
    for (let i = 0; i < 2; i++) {
      const wallet = await freshWallet();
      const key = await issueApiKey(wallet);
      const ch = await h.request("POST", "/api/v1/auth/challenge", {
        body: { wallet: wallet.address, purpose: "REVOKE_API_KEY" },
      });
      const revoked = await h.request("POST", "/api/v1/auth/api-key/revoke", {
        apiKey: key,
        body: { nonce: ch.body.nonce, signature: await wallet.signMessage(ch.body.message as string) },
      });
      assert.ok([200, 201].includes(revoked.status), `revoke #${i + 1}: ${JSON.stringify(revoked.body)}`);
    }
  });

  test("performs NO RPC — it is a projection read, so it is cheap to poll", async () => {
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);

    resetRpcMetrics();
    forbidRpc();
    try {
      const res = await me(key);
      assert.equal(res.status, 200);
    } finally {
      allowRpc();
    }
    assert.equal(
      rpcMetrics().requestsTotal,
      0,
      "GET /api/v1/me must never reach the chain (Rule 14)"
    );
  });

  test("reflects a real store, product and AIC position without a second request", async () => {
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);

    const tx = await createStoreOnChain(h, wallet, 0, "Snapshot AIC", "SNAP", "Snapshot Store");
    const receipt = await tx.wait();
    const created = receipt.logs
      .map((l: any) => {
        try {
          return h.contracts.factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "StoreCreated");
    assert.ok(created, "store created");

    const storeAddress = created.args.store as string;
    // The compiled ABI, not a hand-written signature: a mistyped tuple produces an unrecognised
    // selector and a revert that looks like a contract fault rather than a test fault.
    const { Contract, id, ZeroHash } = await import("ethers");
    const storeAbi = h.ctx.abis.abiFor("AICStoreSales") as never;
    const store = new Contract(storeAddress, storeAbi, wallet);
    const productId = id("snapshot-product");
    await (await store.createProduct(productId, USDC(10), 100, 0, ZeroHash, "", UNDECLARED)).wait();

    await h.sync();
    const res = await me(key);
    const b = res.body as Record<string, any>;

    assert.equal(b.stores.count, 1, "the controlled store appears");
    assert.equal(b.stores.items[0].storeAddress.toLowerCase(), storeAddress.toLowerCase());
    assert.equal(b.products.count, 1, "its product appears");
    assert.equal(b.products.items[0].productId, productId);
    // Money is published as base-unit strings with their decimals, never as a JSON number.
    assert.equal(typeof b.stores.items[0].controllerAvailableProceedsUSDC.base, "string");

    // The store's whole token, valued: it starts at the 6,000 USDC virtual seed, and every store is
    // born with its owner's 5 USDC initial market capital already in the curve.
    const tok = b.stores.items[0].yourStoreToken;
    assert.ok(tok, "each store carries its token's total value");
    assert.equal(tok.startingValueUSDC.base, "6000000000");
    assert.ok(BigInt(tok.totalValueOfAllTokensUSDC.base) > 6_000_000_000n, "the owner seed already moved the price");
    assert.equal(tok.realUSDCInvestedByBuyers.base, String(5_000_000n - 150_000n), "the seed, net of the 3% trading fees");
  });

  test("bounds every collection and offers a deep link instead of growing", async () => {
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);
    const res = await me(key);
    const b = res.body as Record<string, any>;

    for (const section of ["stores", "products", "licenses", "aicPositions"]) {
      assert.ok(b[section].returned <= 25, `${section} must be bounded`);
      assert.ok(typeof b[section].count === "number", `${section} must report a true total`);
      assert.ok(typeof b[section].link === "string", `${section} must offer a deep link`);
    }
    assert.ok(b.actionableTasks.returned <= 50);

    // A control surface, not a data export.
    assert.ok(JSON.stringify(res.body).length < 200_000, "response must stay small");
  });

  test("task ids are deterministic and never duplicated", async () => {
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);

    const first = await me(key);
    const second = await me(key);
    const ids = (t: any) => t.actionableTasks.items.map((x: any) => x.taskId);

    assert.deepEqual(ids(first.body), ids(second.body), "same state must yield identical task ids");
    const set = new Set(ids(first.body));
    assert.equal(set.size, ids(first.body).length, "no duplicate task ids");
  });

  test("every task carries a protocol-owned endpoint, never seller content", async () => {
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);
    const res = await me(key);

    for (const task of (res.body as Record<string, any>).actionableTasks.items) {
      assert.ok(["CRITICAL", "HIGH", "NORMAL", "LOW"].includes(task.priority), "known priority");
      assert.ok(
        typeof task.recommendedEndpoint === "string" && task.recommendedEndpoint.startsWith("/api/v1/"),
        `recommendedEndpoint must be a protocol path, got ${task.recommendedEndpoint}`
      );
      // A seller-injected absolute URL is the attack this forbids.
      assert.ok(!/^https?:/i.test(task.recommendedEndpoint), "never an absolute URL");
      assert.equal(typeof task.requiresWalletSignature, "boolean");
      assert.ok(task.taskId && task.type && task.reason);
    }
  });

  test("states its own freshness so an Agent can refuse to act on stale data", async () => {
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);
    const res = await me(key);
    const b = res.body as Record<string, any>;

    for (const field of ["indexedBlock", "chainHead", "lagBlocks", "indexerStatus", "stale"]) {
      assert.ok(field in b.freshness, `freshness.${field}`);
    }
    assert.equal(b.consistency.asOfIndexedBlock, b.asOfIndexedBlock);
    // An Agent must be told this is not an atomic chain snapshot.
    assert.match(b.consistency.note, /NOT an atomic/i);
  });

  test("does not present un-indexed balances as if they were authoritative", async () => {
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);
    const b = (await me(key)).body as Record<string, any>;

    // Native gas and USDC are not projected. Saying so is better than guessing or an RPC storm.
    assert.equal(b.walletResources.native.source, "NOT_INDEXED");
    assert.equal(b.walletResources.usdc.source, "NOT_INDEXED");
  });
});

describe("agentQuickStart is discoverable and consistent", { concurrency: 1 }, () => {
  test("lives in the playbook; the manifest is a bootstrap that points at it", async () => {
    const wk = await h.request("GET", "/.well-known/aic-agent.json");
    const schema = await h.request("GET", "/api/v1/schema");
    const playbook = await h.request("GET", "/api/v1/playbook");
    assert.equal(wk.status, 200);
    assert.equal(schema.status, 200);
    assert.equal(playbook.status, 200);

    /*
     * The quick start lives in the PLAYBOOK, not in /api/v1/schema.
     *
     * The two documents were split so an agent is not charged for advice on every turn it only
     * needed a fee. The schema keeps the rules and the numbers; the playbook keeps the guidance.
     * What must not happen is the quick start becoming unreachable from the schema, so that link
     * is asserted here rather than assumed.
     */
    const pointer = (schema.body as Record<string, any>).playbook;
    assert.ok(pointer, "schema must point at the playbook");
    assert.ok(
      (pointer.whatIsThere as string[]).includes("agentQuickStart"),
      "schema must name agentQuickStart as living in the playbook"
    );

    /*
     * The manifest is the bootstrap, not a second copy of the advice. It carries the canonical
     * auth path as data and names the playbook as the place for strategy.
     */
    const bootstrap = wk.body as Record<string, any>;
    assert.ok(!bootstrap.agentQuickStart, "the manifest must not carry the quick start");
    assert.equal(bootstrap.auth.issue.steps[2].call, "POST /api/v1/auth/api-key/issue");
    assert.match(bootstrap.documents.playbook.url, /\/api\/v1\/playbook$/);

    for (const [name, doc] of [["playbook", playbook.body]] as const) {
      const qs = (doc as Record<string, any>).agentQuickStart;
      assert.ok(qs, `${name} must expose agentQuickStart`);
      assert.ok(Array.isArray(qs.steps) && qs.steps.length >= 5, `${name} steps`);
      assert.ok(Array.isArray(qs.criticalRules) && qs.criticalRules.length >= 5, `${name} rules`);
      /*
       * There is deliberately NO recommended loop, and that is worth asserting.
       *
       * Publishing one to every agent produced twenty participants running the same sequence and
       * competing for the same customers. What replaced it has to actually be there, or the
       * guidance silently vanishes the next time this section is edited.
       */
      assert.ok(!qs.recommendedLoop, `${name} must NOT publish a single recommended loop`);
      assert.ok(qs.findYourOwnLoop, `${name} must explain how to find a loop instead`);
      assert.ok(
        Array.isArray(qs.findYourOwnLoop.whatWeSuggestInstead) &&
          qs.findYourOwnLoop.whatWeSuggestInstead.length >= 3,
        `${name} must suggest designing one, asking the forum, and trying variations`
      );
      // The rule that matters most must be stated, not implied.
      assert.ok(
        qs.criticalRules.some((r: string) => /not wallet authority/i.test(r)),
        `${name} must state that an API key is not wallet authority`
      );
    }
  });

  test("its steps point only at endpoints that actually exist in the OpenAPI document", async () => {
    /*
     * The anti-drift check. A quick start is the one part of the documentation an Agent follows
     * without verifying, so a step naming a route that does not exist is worse than no step.
     */
    const playbook = await h.request("GET", "/api/v1/playbook");
    const openapi = await h.request("GET", "/api/v1/openapi.json");
    const paths = new Set(Object.keys((openapi.body as Record<string, any>).paths ?? {}));

    const steps = (playbook.body as Record<string, any>).agentQuickStart.steps as { action: string }[];
    const referenced = steps
      .map((s) => s.action.match(/\/api\/v1\/[A-Za-z0-9/_-]+/)?.[0])
      .filter((p): p is string => Boolean(p));

    assert.ok(referenced.length >= 3, "the quick start should name real API paths");
    for (const p of referenced) {
      assert.ok(paths.has(p), `agentQuickStart names ${p}, which is not in the OpenAPI document`);
    }
  });

  test("/api/v1/me is documented in OpenAPI and marked as authenticated", async () => {
    const openapi = await h.request("GET", "/api/v1/openapi.json");
    const op = (openapi.body as Record<string, any>).paths?.["/api/v1/me"]?.get;
    assert.ok(op, "/api/v1/me must be documented");
    assert.ok(Array.isArray(op.security) && op.security.length > 0, "must be marked authenticated");
    assert.match(JSON.stringify(op), /actionableTasks/);
  });
});

describe("an unread site update is announced until it is read", { concurrency: 1 }, () => {
  /*
   * The standing "/updates every few minutes" step turned into a ritual: a literal caller read
   * /updates after every call. The notice now appears only when the site changed after the
   * wallet's key was issued, carries the update's timestamp, and stays until the wallet reads
   * GET /api/v1/updates with its key.
   */
  const notices = (body: Record<string, unknown>) =>
    ((body.nextSteps as { call: string; publishedAt?: string }[] | undefined) ?? []).filter(
      (s) => s.call === "GET /api/v1/updates"
    );

  test("a key issued after the latest update never sees the notice", async () => {
    const key = await issueApiKey(await freshWallet());
    for (let i = 0; i < 2; i++) {
      const res = await me(key);
      assert.equal(res.status, 200);
      assert.equal(notices(res.body).length, 0, "no standing /updates step");
    }
  });

  test("a key issued before the latest update sees it on every response until it reads /updates", async () => {
    const { latestSiteUpdate } = await import("../src/api/routes/updates");
    const latest = latestSiteUpdate();
    if (!latest) return; // nothing announced within the window: nothing to notice
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);
    const { AgentAccount } = await import("../src/db/models");
    await AgentAccount.updateOne(
      { walletAddress: wallet.address.toLowerCase() },
      { $set: { issuedAt: new Date(+new Date(latest.at) - 60_000), updatesReadAt: null } }
    );
    const first = await me(key);
    const shown = notices(first.body);
    assert.equal(shown.length, 1, JSON.stringify(first.body.nextSteps));
    assert.equal(shown[0]!.publishedAt, latest.at);
    const second = await me(key);
    assert.equal(notices(second.body).length, 1, "it stays while unread");

    const anonymous = await h.request("GET", "/api/v1/updates");
    assert.equal(anonymous.status, 200);
    assert.equal(notices((await me(key)).body).length, 1, "a read without the key is not counted");

    const read = await h.request("GET", "/api/v1/updates", { apiKey: key });
    assert.equal(read.status, 200);
    assert.match(String(read.headers?.["cache-control"]), /no-store/, "a keyed read is never cached");
    assert.equal(notices((await me(key)).body).length, 0, "reading it with the key ends the notice");
  });

  test("errors carry no standing /updates link; an unread update is noticed under seeAlso until read", async () => {
    const other = "0x0000000000000000000000000000000000000001";
    const refuse = (key: string) => h.request("GET", `/api/v1/me?wallet=${other}`, { apiKey: key });
    const seeAlsoUpdates = (body: Record<string, unknown>) =>
      ((body.error as Record<string, any> | undefined)?.seeAlso ?? {}).updates;

    const fresh = await issueApiKey(await freshWallet());
    const plain = await refuse(fresh);
    assert.ok(plain.status >= 400, JSON.stringify(plain.body));
    assert.equal(seeAlsoUpdates(plain.body), undefined, "no standing link on an error");

    const { latestSiteUpdate } = await import("../src/api/routes/updates");
    const latest = latestSiteUpdate();
    if (!latest) return;
    const wallet = await freshWallet();
    const key = await issueApiKey(wallet);
    const { AgentAccount } = await import("../src/db/models");
    await AgentAccount.updateOne(
      { walletAddress: wallet.address.toLowerCase() },
      { $set: { issuedAt: new Date(+new Date(latest.at) - 60_000), updatesReadAt: null } }
    );
    const first = await refuse(key);
    assert.equal(seeAlsoUpdates(first.body)?.publishedAt, latest.at, JSON.stringify(first.body));
    const again = await refuse(key);
    assert.equal(seeAlsoUpdates(again.body)?.publishedAt, latest.at, "still there while unread");
    await h.request("GET", "/api/v1/updates", { apiKey: key });
    const after = await refuse(key);
    assert.equal(seeAlsoUpdates(after.body), undefined, "gone once read");
    const ok = await me(key);
    assert.equal(notices(ok.body).length, 0, "and from successes too");
  });
});
