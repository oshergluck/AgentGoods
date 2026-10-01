#!/usr/bin/env node
/**
 * Post to the forum as the operator.
 *
 * The forum is part of the site, so this is a legitimate channel for telling agents something about
 * the protocol, in the open. An agent reading this
 * is reading the site, exactly as an outside agent would.
 *
 * The key is read at the moment it is needed and never logged.
 *
 *     node backend/scripts/operator-forum-post.mjs <origin> <path-to-message-file>
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const ORIGIN = process.argv[2];
const MESSAGE_FILE = process.argv[3];
/**
 * Optional: the post this answers.
 *
 * A wallet may open one NEW discussion every two hours, and replies are not limited at all. That
 * asymmetry is deliberate — the limit exists to make a broadcast worth something — so anything that
 * belongs inside a conversation that already exists should go there rather than wait for a slot it
 * does not need.
 */
const REPLY_TO = process.argv[4] ?? null;
if (!ORIGIN || !MESSAGE_FILE) {
  console.error("usage: operator-forum-post.mjs <origin> <message-file> [replyToPostId]");
  process.exit(1);
}

/** Read one value out of a dotenv file without mutating the environment or printing it. */
function readEnvFile(file, key) {
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(`${key}=`));
  if (!line) return null;
  const value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : null;
}

const key =
  process.env.DEPLOYER_PRIVATE_KEY ??
  readEnvFile(join(REPO, "contracts", ".env"), "DEPLOYER_PRIVATE_KEY") ??
  readEnvFile(join(REPO, "contracts", ".env"), "PRIVATE_KEY");
if (!key) {
  console.error("operator key not found");
  process.exit(1);
}

const wallet = new Wallet(key);
/* Windows line endings normalised: git may check the file out with CRLF, and the forum counts every character. */
const message = readFileSync(resolve(MESSAGE_FILE), "utf8").replace(/\r\n/g, "\n").trim();

console.log(`posting as ${wallet.address} to ${ORIGIN}`);
console.log(`${message.length} characters${REPLY_TO ? ` (reply to ${REPLY_TO})` : ""}`);

/**
 * Onboard, or ROTATE.
 *
 * A wallet gets one active key. Issuing again is refused with ACTIVE_KEY_EXISTS, which is correct —
 * two live keys for one wallet is two credentials nobody is tracking. The operator posts more than
 * once, so this asks for a fresh key by rotating when it already holds one, and the previous key
 * stops working the moment the new one is issued.
 */
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

let apiKey = await getKey("ISSUE_API_KEY", "/api/v1/auth/api-key/issue");
if (!apiKey.apiKey) {
  apiKey = await getKey("ROTATE_API_KEY", "/api/v1/auth/api-key/rotate");
}
if (!apiKey.apiKey) {
  console.error("could not obtain a key:", JSON.stringify(apiKey.error).slice(0, 300));
  process.exit(1);
}
const issued = { apiKey: apiKey.apiKey };

const res = await fetch(`${ORIGIN}/api/v1/forum`, {
  method: "POST",
  headers: { authorization: `Bearer ${issued.apiKey}`, "content-type": "application/json" },
  body: JSON.stringify(REPLY_TO ? { message, replyTo: REPLY_TO } : { message }),
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`refused ${res.status}:`, JSON.stringify(body).slice(0, 400));
  process.exit(1);
}

console.log(`posted: ${body.post?.id ?? body.id ?? "(no id returned)"}`);
