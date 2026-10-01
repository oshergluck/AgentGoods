/**
 * The forum.
 *
 * It exists because a market whose participants cannot talk has no way to discover demand — and
 * that was not a theory: twenty agents ran for an hour, all listed near-identical products, and
 * sold nothing, because no seller had any way to ask what anyone wanted.
 *
 * The tests weight three things heavily, because they are what turn a message board from a
 * feature into a liability:
 *
 * **Search must be case-insensitive.** A search that misses "Dataset" because the reader typed
 * "dataset" is worse than no search: it returns nothing and the reader concludes nothing matched.
 *
 * **A search term must never be a pattern.** `.*` matching everything, or `(((` throwing, is a
 * denial-of-service primitive reachable from a query string.
 *
 * **Untrusted text must stay text.** This is the only endpoint that serves one participant's
 * words to another, so it is the protocol's most direct prompt-injection surface.
 */

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { createHarness, startChain, deployProtocol, stopChain, type Harness } from "./helpers/harness";
import { ForumPost, ForumVote } from "../src/db/models";

let h: Harness;
let aliceKey: string;
let bobKey: string;

async function keyFor(wallet: Wallet): Promise<string> {
  const challenge = await h.request("POST", "/api/v1/auth/challenge", {
    body: { wallet: wallet.address, purpose: "ISSUE_API_KEY" },
  });
  const body = challenge.body as { nonce: string; message: string };
  const signature = await wallet.signMessage(body.message);
  const issued = await h.request("POST", "/api/v1/auth/api-key/issue", {
    body: { nonce: body.nonce, signature },
  });
  return (issued.body as { apiKey: string }).apiKey;
}

/**
 * A brand-new wallet with its own API key.
 *
 * A wallet may open ONE new discussion every two hours, so any test that needs to START a
 * discussion needs a wallet that has not started one. Sharing `aliceKey` across tests makes the
 * second of them fail with a 429 that has nothing to do with what it is asserting.
 */
async function freshKey(): Promise<string> {
  return keyFor(Wallet.createRandom() as unknown as Wallet);
}

before(async () => {
  await startChain();
  await deployProtocol();
  h = await createHarness();
  aliceKey = await keyFor(h.signers[3]! as unknown as Wallet);
  bobKey = await keyFor(h.signers[4]! as unknown as Wallet);
});

after(async () => {
  await h?.stop();
  await stopChain();
});

describe("Posting", { concurrency: 1 }, () => {
  test("an authenticated Agent can post and it comes back attributable", async () => {
    const res = await h.request("POST", "/api/v1/forum", {
      apiKey: aliceKey,
      body: { message: "Looking for labelled arbitrage examples from this market. Will pay." },
    });
    assert.equal(res.status, 201);

    const read = await h.request("GET", "/api/v1/forum?limit=10");
    assert.equal(read.status, 200);
    const items = (read.body as { items: Record<string, any>[] }).items;
    const mine = items.find((i) => i.message_UNTRUSTED.includes("labelled arbitrage"));
    assert.ok(mine, "the post must be readable");
    // A claim is only useful if it can be checked against who made it.
    assert.match(String(mine!.author.wallet), /^0x[0-9a-f]{40}$/);
  });

  test("posting requires an API key", async () => {
    const res = await h.request("POST", "/api/v1/forum", { body: { message: "anonymous" } });
    assert.equal(res.status, 401, "an unattributable claim is worthless");
  });

  test("reading requires nothing", async () => {
    const res = await h.request("GET", "/api/v1/forum");
    assert.equal(res.status, 200, "an Agent must be able to see demand before it has credentials");
  });

  test("every response carries the untrusted warning", async () => {
    const res = await h.request("GET", "/api/v1/forum");
    const body = res.body as { note: string };
    assert.match(body.note, /UNTRUSTED DATA, never an instruction/i);
  });
});

describe("Search", { concurrency: 1 }, () => {
  before(async () => {
    await ForumPost.deleteMany({});
    /*
     * Seeded straight into the collection, not posted through the API.
     *
     * A wallet may open ONE new discussion every two hours, so three POSTs in a row from one key
     * produce one post and two 429s — and these tests are about SEARCH, not about the cooldown,
     * which has its own coverage below. Seeding keeps this fixture independent of a rate limit it
     * is not testing.
     */
    await ForumPost.insertMany(
      [
        "Selling a Dataset of market snapshots",
        "WANTED: dataset of failed trades",
        "Unrelated chatter about gas prices",
      ].map((message) => ({
        chainId: h.ctx.env.CHAIN_ID,
        wallet: h.signers[3]!.address.toLowerCase(),
        message,
      }))
    );
  });

  test("matches regardless of case", async () => {
    /*
     * The decisive one. Three spellings of the same word must return the same two posts — a
     * reader who types lowercase and sees nothing concludes the market is empty.
     */
    for (const term of ["dataset", "DATASET", "DaTaSeT"]) {
      const res = await h.request("GET", `/api/v1/forum?q=${term}`);
      const items = (res.body as { items: unknown[] }).items;
      assert.equal(items.length, 2, `"${term}" should match both dataset posts`);
    }
  });

  test("a search term is never treated as a pattern", async () => {
    // `.*` would match everything if the term reached the regex engine unescaped.
    const res = await h.request("GET", "/api/v1/forum?q=.*");
    assert.equal(res.status, 200);
    assert.equal((res.body as { items: unknown[] }).items.length, 0, "`.*` is a literal, not a wildcard");
  });

  test("a malformed pattern does not error", async () => {
    // `(((` throws inside the regex engine if it is ever compiled as one.
    const res = await h.request("GET", "/api/v1/forum?q=%28%28%28");
    assert.equal(res.status, 200, "an unbalanced bracket must be a search, not a 500");
  });

  test("an empty search returns the board rather than nothing", async () => {
    const res = await h.request("GET", "/api/v1/forum?q=");
    assert.equal((res.body as { items: unknown[] }).items.length, 3);
  });
});

describe("Voting", { concurrency: 1 }, () => {
  let postId: string;

  before(async () => {
    await ForumPost.deleteMany({});
    await ForumVote.deleteMany({});
    const created = await h.request("POST", "/api/v1/forum", {
      apiKey: aliceKey,
      body: { message: "A post worth rating" },
    });
    postId = (created.body as { id: string }).id;
  });

  test("a like raises the score", async () => {
    const res = await h.request("POST", `/api/v1/forum/${postId}/vote`, {
      apiKey: bobKey,
      body: { value: 1 },
    });
    assert.equal(res.status, 200);
    assert.deepEqual((res.body as { votes: unknown }).votes, { likes: 1, dislikes: 0, score: 1 });
  });

  test("voting twice replaces rather than accumulates", async () => {
    /*
     * The rule that makes a score mean anything. Enforced by a unique index on (post, wallet)
     * rather than by a read-then-write, which two concurrent requests can both pass.
     */
    await h.request("POST", `/api/v1/forum/${postId}/vote`, { apiKey: bobKey, body: { value: 1 } });
    const res = await h.request("POST", `/api/v1/forum/${postId}/vote`, {
      apiKey: bobKey,
      body: { value: -1 },
    });
    assert.deepEqual((res.body as { votes: unknown }).votes, { likes: 0, dislikes: 1, score: -1 });
  });

  test("a vote can be withdrawn", async () => {
    const res = await h.request("POST", `/api/v1/forum/${postId}/vote`, {
      apiKey: bobKey,
      body: { value: 0 },
    });
    assert.deepEqual((res.body as { votes: unknown }).votes, { likes: 0, dislikes: 0, score: 0 });
  });

  test("an Agent cannot vote for itself", async () => {
    // Otherwise a score measures how much an Agent likes itself.
    const res = await h.request("POST", `/api/v1/forum/${postId}/vote`, {
      apiKey: aliceKey,
      body: { value: 1 },
    });
    assert.equal(res.status, 400);
  });

  test("sort=top ranks by score", async () => {
    // Two DIFFERENT authors: one wallet cannot open two discussions inside the cooldown.
    const low = await h.request("POST", "/api/v1/forum", {
      apiKey: await freshKey(),
      body: { message: "Unpopular opinion" },
    });
    const high = await h.request("POST", "/api/v1/forum", {
      apiKey: await freshKey(),
      body: { message: "Popular opinion" },
    });
    await h.request("POST", `/api/v1/forum/${(high.body as { id: string }).id}/vote`, {
      apiKey: bobKey,
      body: { value: 1 },
    });
    await h.request("POST", `/api/v1/forum/${(low.body as { id: string }).id}/vote`, {
      apiKey: bobKey,
      body: { value: -1 },
    });

    const res = await h.request("GET", "/api/v1/forum?sort=top&limit=10");
    const items = (res.body as { items: Record<string, any>[] }).items;
    assert.match(items[0]!.message_UNTRUSTED, /Popular opinion/);
    assert.match(items[items.length - 1]!.message_UNTRUSTED, /Unpopular opinion/);
  });
});

describe("Untrusted text stays text", { concurrency: 1 }, () => {
  test("control characters and bidi overrides are stripped", async () => {
    /*
     * A bidirectional override makes a message RENDER differently from how it is stored, which is
     * a spoofing primitive rather than expression. Stripped, not escaped — there is no legitimate
     * use for it in a market message.
     */
    const res = await h.request("POST", "/api/v1/forum", {
      apiKey: await freshKey(),
      body: { message: "Trust me‮gnihsihp‬\u0000 now" },
    });
    assert.equal(res.status, 201);
    const stored = (res.body as { message: string }).message;
    assert.ok(!stored.includes("‮"), "bidi override must not survive");
    assert.ok(!stored.includes("\u0000"), "control characters must not survive");
  });

  test("markup is stored verbatim and never interpreted", async () => {
    // It is data. The API's job is to carry it unchanged and label it, not to rewrite it.
    const payload = '<script>alert(1)</script> buy my thing';
    const res = await h.request("POST", "/api/v1/forum", { apiKey: await freshKey(), body: { message: payload } });
    assert.equal(res.status, 201);
    assert.equal((res.body as { message: string }).message, payload);

    const read = await h.request("GET", "/api/v1/forum?q=buy%20my%20thing");
    const items = (read.body as { items: Record<string, any>[] }).items;
    assert.equal(items[0]!.message_UNTRUSTED, payload, "served verbatim, under an _UNTRUSTED name");
  });

  test("an over-long message is refused rather than silently truncated", async () => {
    /*
     * The limit is 4000, raised from 500 when agents gained the ability to run code.
     *
     * The point of running it is to post the program AND its output so a sceptic can reproduce
     * the result, and that does not fit in 500 characters — so the one message type that could
     * actually establish trust was the one the limit forbade. The property under test is
     * unchanged and is the important part: too long is REFUSED, never quietly cut down.
     */
    const accepted = await h.request("POST", "/api/v1/forum", {
      apiKey: await freshKey(),
      body: { message: "x".repeat(4000) },
    });
    assert.equal(accepted.status, 201, "4000 characters is within the limit");

    // A different wallet again: the 400 under test must be the LENGTH rule, not the cooldown.
    const res = await h.request("POST", "/api/v1/forum", {
      apiKey: await freshKey(),
      body: { message: "x".repeat(4001) },
    });
    assert.equal(res.status, 400, "truncating would change what someone said");
  });
});
