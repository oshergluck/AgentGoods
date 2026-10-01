#!/usr/bin/env node
/**
 * Remove every off-chain trace of specific wallets from the site's database — and nothing else.
 *
 * An aborted arena run leaves its wallets registered on the site: API keys, challenges, prepared
 * intents, idempotency records, usage rows, delivery sessions, forum posts. A clean next run must
 * not share the site with them, but a full database wipe would also delete what the baseline
 * needs (the published product content). This deletes, for the named wallets only, the records
 * that are theirs; market projections rebuilt from the chain are untouched.
 *
 *     node remove-wallet-identities.mjs --chain 84532 --wallets 0xabc,0xdef   [--execute]
 *
 * Without --execute it only counts.
 */
import mongoose from "mongoose";

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const chainId = Number(value("--chain"));
const wallets = (value("--wallets") ?? "").split(",").map((w) => w.trim().toLowerCase()).filter((w) => /^0x[0-9a-f]{40}$/.test(w));
const execute = args.includes("--execute");
if (!Number.isInteger(chainId) || wallets.length === 0) {
  console.error("usage: remove-wallet-identities.mjs --chain <id> --wallets <0x…,0x…> [--execute]");
  process.exit(1);
}
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Run this with the deployment's environment injected.");
  process.exit(1);
}
await mongoose.connect(uri);
const db = mongoose.connection;

/* collection -> the field that names the wallet. Only records that belong to a wallet. */
const TARGETS = {
  agentaccounts: "walletAddress",
  authchallenges: "walletAddress",
  apiusages: "walletAddress",
  idempotencyrecords: "walletAddress",
  accesssessions: "walletAddress",
  webhooks: "walletAddress",
  transactionintents: "agentWallet",
  forumposts: "wallet",
};

let total = 0;
for (const [name, field] of Object.entries(TARGETS)) {
  const exists = (await db.db.listCollections({ name }).toArray()).length > 0;
  if (!exists) continue;
  const filter = { [field]: { $in: wallets }, ...(name === "authchallenges" || name === "agentaccounts" ? { chainId } : {}) };
  const n = await db.collection(name).countDocuments(filter);
  if (n > 0 && execute) await db.collection(name).deleteMany(filter);
  total += n;
  console.log(`  ${execute ? "deleted" : "would delete"} ${String(n).padStart(5)}  ${name}`);
}
console.log(`${execute ? "deleted" : "would delete"} ${total} record(s) for ${wallets.length} wallet(s) on chain ${chainId}`);
await mongoose.disconnect();
