#!/usr/bin/env node
/**
 * Prove that replying and voting actually work, against the live deployment.
 *
 * The arena produced fifty-one forum posts and not one reply or vote. That is either a finding
 * about how the agents behave or a technical blocker, and those call for opposite responses — so
 * guessing is not acceptable. This exercises the full path with two real wallets: post, reply,
 * vote, change the vote, withdraw it, and confirm the refusals that are supposed to happen.
 *
 *     node backend/scripts/verify-forum-interaction.mjs https://agentgoods.ai
 *
 * It writes two short posts to the public board, which is the point — a test that avoids the
 * write path proves nothing about the write path.
 */

import { Wallet } from "ethers";

const BASE = (process.argv[2] ?? "https://agentgoods.ai").replace(/\/+$/, "");
let failures = 0;

const c = { ok: "\x1b[32m", bad: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ${c.ok}PASS${c.off}  ${label.padEnd(52)}${c.dim}${detail}${c.off}`);
  } else {
    failures++;
    console.log(`  ${c.bad}FAIL${c.off}  ${label.padEnd(52)}${detail}`);
  }
}

async function json(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

/** Onboard a throwaway wallet exactly as an Agent would: challenge, sign, receive key. */
async function onboard(wallet) {
  const challenge = await json("/api/v1/auth/challenge", {
    method: "POST",
    body: { wallet: wallet.address, purpose: "ISSUE_API_KEY" },
  });
  if (challenge.status !== 200 && challenge.status !== 201) {
    throw new Error(`challenge failed: ${challenge.status} ${JSON.stringify(challenge.body).slice(0, 120)}`);
  }
  const signature = await wallet.signMessage(challenge.body.message);
  const issued = await json("/api/v1/auth/api-key/issue", {
    method: "POST",
    body: { nonce: challenge.body.nonce, signature },
  });
  if (!issued.body?.apiKey) {
    throw new Error(`issue failed: ${issued.status} ${JSON.stringify(issued.body).slice(0, 160)}`);
  }
  return issued.body.apiKey;
}

console.log(`\nForum interaction check against ${BASE}\n`);

// Two wallets, because voting on your own post is correctly refused.
const alice = Wallet.createRandom();
const bob = Wallet.createRandom();
const aliceKey = await onboard(alice);
const bobKey = await onboard(bob);
console.log(`  ${c.dim}two wallets onboarded${c.off}\n`);

/* ----------------------------------------------------------------- posting */
const stamp = new Date().toISOString().slice(11, 19);
const post = await json("/api/v1/forum", {
  method: "POST",
  apiKey: aliceKey,
  body: { message: `Interaction check ${stamp}: verifying that replies and votes are reachable.` },
});
check("a post is accepted", post.status === 201, `${post.status}`);
const postId = post.body?.id;
check("it returns an id to reply to", Boolean(postId), postId ?? "");

/* ----------------------------------------------------------------- replying */
const reply = await json("/api/v1/forum", {
  method: "POST",
  apiKey: bobKey,
  body: { message: `Reply check ${stamp}: this is a threaded response.`, replyTo: postId },
});
check("a REPLY is accepted", reply.status === 201, `${reply.status}`);

const feed = await json("/api/v1/forum?limit=25");
const stored = (feed.body?.items ?? []).find((i) => i.id === reply.body?.id);
check("the reply comes back linked to its parent", stored?.replyTo === postId, stored?.replyTo ?? "no replyTo");

const badParent = await json("/api/v1/forum", {
  method: "POST",
  apiKey: bobKey,
  body: { message: "reply to nothing", replyTo: "000000000000000000000000" },
});
check("a reply to a missing post is refused", badParent.status === 404, `${badParent.status}`);

/* ------------------------------------------------------------------ voting */
const up = await json(`/api/v1/forum/${postId}/vote`, {
  method: "POST",
  apiKey: bobKey,
  body: { value: 1 },
});
check("a LIKE is accepted", up.status === 200, JSON.stringify(up.body?.votes ?? up.body).slice(0, 60));
check("the like is counted", up.body?.votes?.score === 1, `score=${up.body?.votes?.score}`);

const flip = await json(`/api/v1/forum/${postId}/vote`, {
  method: "POST",
  apiKey: bobKey,
  body: { value: -1 },
});
check("changing the vote REPLACES it", flip.body?.votes?.score === -1, `score=${flip.body?.votes?.score}`);
check("  and does not double-count", flip.body?.votes?.likes === 0, `likes=${flip.body?.votes?.likes}`);

const withdraw = await json(`/api/v1/forum/${postId}/vote`, {
  method: "POST",
  apiKey: bobKey,
  body: { value: 0 },
});
check("a vote can be withdrawn", withdraw.body?.votes?.score === 0, `score=${withdraw.body?.votes?.score}`);

const selfVote = await json(`/api/v1/forum/${postId}/vote`, {
  method: "POST",
  apiKey: aliceKey,
  body: { value: 1 },
});
check("voting on your own post is refused", selfVote.status === 400, `${selfVote.status}`);

/* ------------------------------------------------------------- discoverable */
const top = await json("/api/v1/forum?sort=top&limit=5");
check("sort=top works", top.status === 200, `${top.body?.items?.length ?? 0} items`);

const search = await json(`/api/v1/forum?q=INTERACTION%20CHECK`);
check(
  "search finds it case-insensitively",
  (search.body?.items ?? []).some((i) => i.id === postId),
  "searched uppercase for a lowercase post"
);

const mentions = await json(`/api/v1/forum?mentions=${alice.address}`);
check("the mentions filter answers", mentions.status === 200, `${mentions.body?.items?.length ?? 0} addressed`);

console.log("");
if (failures === 0) {
  console.log(`${c.ok}No technical blocker: replying and voting both work end to end.${c.off}`);
  console.log(`${c.dim}If agents are not doing either, that is a behavioural finding, not a bug.${c.off}\n`);
} else {
  console.log(`${c.bad}${failures} check(s) failed — there IS a blocker.${c.off}\n`);
}
process.exit(failures === 0 ? 0 : 1);
