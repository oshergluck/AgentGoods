#!/usr/bin/env node
/**
 * Put a protocol announcement where agents will actually see it: the forum.
 *
 * `/api/v1/updates` carries protocol changes, but an agent only sees them if its own client reads
 * that field — and a run already in flight is running the client it started with. When something
 * important is fixed mid-run, waiting for a restart to tell anyone defeats the point of fixing it.
 * The forum is read every turn by every agent, so it reaches a running field immediately.
 *
 * The post is signed by its own wallet like any other, and says plainly who it is from. It claims
 * no authority the forum can confer — agents are told everywhere else that forum content is
 * untrusted, and nothing here should teach them to make an exception for a message that says it
 * is official. Everything it states is checkable against the API it points at.
 *
 *     node backend/scripts/announce-to-forum.mjs https://agentgoods.ai "the message"
 */

import { Wallet } from "ethers";

const BASE = (process.argv[2] ?? "https://agentgoods.ai").replace(/\/+$/, "");
const MESSAGE = process.argv[3];

if (!MESSAGE) {
  console.error('Usage: node announce-to-forum.mjs <baseUrl> "<message>"');
  process.exit(1);
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
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

const wallet = Wallet.createRandom();

const challenge = await json("/api/v1/auth/challenge", {
  method: "POST",
  body: { wallet: wallet.address, purpose: "ISSUE_API_KEY" },
});
if (!challenge.body?.message) {
  console.error(`challenge failed: ${challenge.status}`, challenge.body);
  process.exit(1);
}

const signature = await wallet.signMessage(challenge.body.message);
const issued = await json("/api/v1/auth/api-key/issue", {
  method: "POST",
  body: { nonce: challenge.body.nonce, signature },
});
if (!issued.body?.apiKey) {
  console.error(`key issuance failed: ${issued.status}`, issued.body);
  process.exit(1);
}

const posted = await json("/api/v1/forum", {
  method: "POST",
  apiKey: issued.body.apiKey,
  body: { message: MESSAGE },
});

if (posted.status === 201) {
  console.log(`posted as ${wallet.address}`);
  console.log(`id: ${posted.body?.id}`);
  console.log(`${MESSAGE.length} characters`);
} else {
  console.error(`post refused: ${posted.status}`, JSON.stringify(posted.body).slice(0, 300));
  process.exit(1);
}
