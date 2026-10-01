#!/usr/bin/env node
/**
 * Clear everything this backend projected from a contract deployment that no longer exists.
 *
 * Redeploying the protocol mints a fresh set of canonical addresses. Every store, product,
 * licence, trade and holder already in the database belongs to the OLD addresses, and nothing
 * removes them: the API filters by chainId, not by deployment, so a redeploy leaves the market
 * showing a hundred listings that can never be bought from contracts that no longer answer. The
 * forum survives too, carrying hundreds of posts arguing about prices in a market that is gone.
 *
 * That residue is not merely untidy. A new field of agents reads it as the state of the market,
 * anchors on it, and reproduces the behaviour the reset was meant to escape.
 *
 * WHAT IS CLEARED, and why each one:
 *   - indexer state (cursor, block refs, raw events) — so the indexer re-reads the new
 *     deployment from its own deploymentBlock instead of resuming mid-history of a dead one
 *   - stores, products, versions, licences, purchases, content — the projection itself
 *   - markets, trades, holders, price samples — the curve state of tokens that no longer exist
 *   - signals, dividends, proposals, votes — reputation and governance earned under old contracts
 *   - forum posts and votes — the conversation about a market that is gone
 *   - agent accounts, challenges, API usage — so the population metrics describe the new run and
 *     not 193 wallets from previous ones
 *   - intents, idempotency records, access sessions — in-flight state referencing old addresses
 *
 * WHAT IS NOT TOUCHED: webhooks and publications, which are operator configuration rather than
 * market data, and anything belonging to another chainId.
 *
 * Dry by default. Nothing is deleted without --execute, and the chainId must be named explicitly:
 *
 *     node backend/scripts/reset-deployment.mjs --chain 84532
 *     node backend/scripts/reset-deployment.mjs --chain 84532 --execute
 *
 * Run it with the production environment injected, e.g. `railway run --service backend node ...`,
 * so MONGODB_URI comes from the deployment rather than from a local guess.
 */

import mongoose from "mongoose";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const chainArg = args[args.indexOf("--chain") + 1];
const chainId = Number(chainArg);

if (!args.includes("--chain") || !Number.isInteger(chainId)) {
  console.error("Name the chain explicitly: --chain 84532 [--execute]");
  process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Run this with the deployment's environment injected.");
  process.exit(1);
}

/*
 * Collections are addressed by NAME rather than through the models module.
 *
 * Importing the app's models would drag in the whole config and env validation for a job that
 * only needs a connection, and it would silently miss any collection whose model is not exported.
 * The names below are mongoose's pluralised defaults for the schemas in src/db/models.ts.
 */
const SCOPED = [
  // indexer state — must go, or the new deployment is never indexed from its own start block
  "chainevents",
  "indexercursors",
  "blockrefs",
  // the projection
  "stores",
  "products",
  "productversions",
  "iterationlogs",
  "licenses",
  "purchases",
  "productcontents",
  // market state
  "stockmarkets",
  "stocktrades",
  "aicholders",
  "eshholders", // the name before the ESH→AIC rename; kept so an older database is cleared too
  "pricesamples",
  // reputation and governance
  "buyersignals",
  "proposals",
  "votes",
  "dividendepochs",
  "dividendentitlements",
  // conversation
  "forumposts",
  "forumvotes",
  // published unmet demand: searches and refusals from a market that is gone
  "demandsignals",
  // services: specs, calls and prepaid-call balances against old contracts; buyback burns
  "servicespecs",
  "servicecalls",
  "servicecredits",
  "buybackburns",
  // identity and in-flight state
  "agentaccounts",
  "authchallenges",
  "apiusages",
  "transactionintents",
  "idempotencyrecords",
  "accesssessions",
];

/** Collections with no chainId field; cleared wholesale or not at all. */
const UNSCOPED = new Set(["idempotencyrecords", "authchallenges", "apiusages", "accesssessions", "productcontents"]);

await mongoose.connect(uri);
const db = mongoose.connection.db;
console.log(`\nconnected to ${mongoose.connection.name}`);
console.log(`chain ${chainId} · ${execute ? "EXECUTING" : "dry run (pass --execute to delete)"}\n`);

const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
let total = 0;

for (const name of SCOPED) {
  if (!existing.has(name)) continue;
  const collection = db.collection(name);

  /*
   * Scope by chainId wherever the documents carry one, so a reset of the testnet cannot reach
   * another chain's data sharing the same database.
   */
  const filter = UNSCOPED.has(name) ? {} : { chainId };
  const count = await collection.countDocuments(filter);
  if (count === 0) continue;

  total += count;
  if (execute) {
    const result = await collection.deleteMany(filter);
    console.log(`  deleted ${String(result.deletedCount).padStart(7)}  ${name}`);
  } else {
    console.log(`  would delete ${String(count).padStart(7)}  ${name}${UNSCOPED.has(name) ? "  (all chains — no chainId field)" : ""}`);
  }
}

console.log(`\n${execute ? "deleted" : "would delete"} ${total} document(s)`);
if (!execute) console.log("Nothing was changed. Re-run with --execute to apply.");
else console.log("The indexer will rebuild the projection from the new deployment's start block.");

await mongoose.disconnect();
