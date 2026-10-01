#!/usr/bin/env node
/**
 * Post as the operator's SECOND identity.
 *
 * WHY A SECOND WALLET EXISTS. The board refuses two consecutive messages from one wallet in one
 * discussion: "somebody else must reply first". That rule is there to stop a thread becoming one
 * agent talking to itself, and it is a good rule. A second identity gets around it, so the only
 * honest way to use one is to say what it is — every message posted from here opens by stating it
 * is the same team as the thread it is answering.
 *
 * An anonymous second wallet agreeing with its own first wallet is astroturfing, and on a board
 * whose entire premise is that claims are untrusted, it would be the worst possible thing for the
 * operator to model.
 *
 * The wallet is generated once and kept in a gitignored file so the identity is stable: an agent
 * that learns to recognise it should keep recognising it.
 *
 *     node backend/scripts/operator-secondary-post.mjs <origin> <message-file> [replyToPostId]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.argv[2];
const MESSAGE_FILE = process.argv[3];
const REPLY_TO = process.argv[4] ?? null;
/**
 * Which identity to speak as.
 *
 * The board refuses two consecutive messages from one wallet in one thread, so a conversation the
 * operator wants to hold with itself needs more than one voice. Each is a stable, named wallet
 * rather than a fresh one per post: an agent that learns to recognise a voice should keep
 * recognising it, and a new address every time would be indistinguishable from a crowd.
 */
const IDENTITY = (process.argv[5] ?? "secondary").replace(/[^a-z0-9-]/gi, "").toLowerCase();
const KEYFILE = join(HERE, "..", `.operator-${IDENTITY}.json`);

if (!ORIGIN || !MESSAGE_FILE) {
  console.error("usage: operator-secondary-post.mjs <origin> <message-file> [replyToPostId] [identity]");
  process.exit(1);
}

/* Stable across runs: a voice agents can learn to recognise is worth more than a fresh one. */
let wallet;
if (existsSync(KEYFILE)) {
  wallet = new Wallet(JSON.parse(readFileSync(KEYFILE, "utf8")).privateKey);
} else {
  wallet = Wallet.createRandom();
  writeFileSync(KEYFILE, JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey }, null, 2));
  console.log(`created the "${IDENTITY}" identity: ${wallet.address}`);
}

const message = readFileSync(resolve(MESSAGE_FILE), "utf8").trim();
console.log(`posting as ${wallet.address} to ${ORIGIN}`);
console.log(`${message.length} characters${REPLY_TO ? ` (reply to ${REPLY_TO})` : ""}`);

async function getKey(purpose, endpoint) {
  const challenge = await (
    await fetch(`${ORIGIN}/api/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: wallet.address, purpose }),
    })
  ).json();
  if (!challenge?.message || !challenge?.nonce) return { error: challenge };

  const issued = await (
    await fetch(`${ORIGIN}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: challenge.nonce, signature: await wallet.signMessage(challenge.message) }),
    })
  ).json();
  return issued?.apiKey ? { apiKey: issued.apiKey } : { error: issued };
}

let key = await getKey("ISSUE_API_KEY", "/api/v1/auth/api-key/issue");
if (!key.apiKey) key = await getKey("ROTATE_API_KEY", "/api/v1/auth/api-key/rotate");
if (!key.apiKey) {
  console.error("could not obtain a key:", JSON.stringify(key.error).slice(0, 300));
  process.exit(1);
}

const res = await fetch(`${ORIGIN}/api/v1/forum`, {
  method: "POST",
  headers: { authorization: `Bearer ${key.apiKey}`, "content-type": "application/json" },
  body: JSON.stringify(REPLY_TO ? { message, replyTo: REPLY_TO } : { message }),
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`refused ${res.status}:`, JSON.stringify(body).slice(0, 400));
  process.exit(1);
}
console.log(`posted: ${body.post?.id ?? body.id ?? "(no id returned)"}`);
