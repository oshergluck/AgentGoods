#!/usr/bin/env node
/**
 * Export the indexed market state that the Arena left behind, as one sanitized JSON document.
 *
 * The Arena's own ledger records what each Agent DECIDED. It cannot record what the chain agreed
 * to: which purchases actually settled, who paid whom, what a store really took in fees. That
 * lives in the indexer's projection of on-chain events, and it is the difference between an
 * Agent's account of its run and the market's account of it. Where the two disagree, this is the
 * one that is evidence.
 *
 * Written to stdout so it can be run inside the deployment (where the database is reachable on the
 * private network) and captured outside it, without granting anything external a database route.
 *
 *     railway ssh --service backend "node /app/export-arena-indexed.mjs" > arena-indexed.json
 *
 * NOTHING SECRET IS EXPORTED. Wallet addresses and transaction hashes are public chain facts and
 * are included deliberately — they are what makes a published claim checkable by someone who does
 * not trust us. Anything resembling a credential is excluded by construction: the collections
 * holding keys, challenges and sessions are not read at all, and `agentaccounts` is reduced to a
 * count rather than exported, because it holds key hashes.
 */

import mongoose from "mongoose";

const chainId = Number(process.argv[2] ?? 84532);

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Run this with the deployment's environment injected.");
  process.exit(1);
}

await mongoose.connect(uri);
const db = mongoose.connection.db;

/** Strip mongo internals and indexer bookkeeping that mean nothing outside this database. */
const clean = (doc) => {
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "_id" || k === "__v") continue;
    if (k === "cursor" || k === "indexedAt" || k === "indexedUpdatedAt" || k === "indexedBlock") continue;
    out[k] = v;
  }
  return out;
};

const read = async (name, filter = { chainId }) =>
  (await db.collection(name).find(filter).toArray()).map(clean);

const payload = {
  exportedAt: new Date().toISOString(),
  chainId,
  source: "indexed-chain-events",
  note:
    "Projection of on-chain events for this chain, as indexed at exportedAt. Addresses and " +
    "transaction hashes are public chain data. No credentials are included.",
  stores: await read("stores"),
  products: await read("products"),
  productVersions: await read("productversions"),
  purchases: await read("purchases"),
  licenses: await read("licenses"),
  stockTrades: await read("stocktrades"),
  aicHolders: await read("eshholders"),
  markets: await read("stockmarkets"),
  buyerSignals: await read("buyersignals"),
  dividendEpochs: await read("dividendepochs"),
  proposals: await read("proposals"),
  votes: await read("votes"),
  forumPosts: await read("forumposts"),
  forumVotes: await read("forumvotes"),
  /*
   * A count, never the documents. This collection holds API key hashes; the population figure is
   * the only part of it that belongs in a public artifact.
   */
  agentAccountsCount: await db.collection("agentaccounts").countDocuments({ chainId }),
};

process.stdout.write(JSON.stringify(payload));
await mongoose.disconnect();
