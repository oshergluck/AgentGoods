/**
 * Process entry point.
 *
 * Startup order is deliberate and fail-closed (MASTER_PLAN 0.21.R):
 *   validate environment -> load and validate the manifest -> connect Mongo -> build ABIs ->
 *   create providers -> start the indexer -> serve HTTP.
 *
 * If the manifest is missing, disagrees with the configured chain, or is a mock manifest in a
 * PRODUCTION environment, the process refuses to start rather than silently falling back.
 *
 * Shutdown is graceful: the HTTP listener stops accepting, the indexer stops on a clean
 * boundary, and Mongo closes, so a restart mid-write cannot corrupt the projection.
 */

import http from "node:http";
import { DeliveryGateway } from "./access/deliveryGateway";
import { WebhookWorker } from "./webhooks/worker";
import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { loadEnv } from "./config/env";
import { loadManifest } from "./config/manifest";
import { AbiRegistry } from "./indexer/abis";
import { Indexer, type IndexerStatus } from "./indexer/indexer";
import { ProviderPool } from "./rpc/provider";
import { createApp } from "./app";
import { canonicalOrigins } from "./config/origins";
import { PriceSampler } from "./indexer/priceSampler";
import { logger } from "./utils/logger";
import type { AppContext } from "./http/context";

dotenv.config();

async function main(): Promise<void> {
  const env = loadEnv();
  logger.level = env.LOG_LEVEL;

  logger.info(
    { environment: env.ESH_ENVIRONMENT, chainId: env.CHAIN_ID, nodeEnv: env.NODE_ENV },
    "starting AIC backend"
  );

  const manifest = loadManifest({
    deploymentsDir: env.DEPLOYMENTS_DIR,
    chainId: env.CHAIN_ID,
    environment: env.ESH_ENVIRONMENT,
  });
  logger.info(
    {
      manifestEnvironment: manifest.environment,
      registry: manifest.contracts.registry.proxy,
      agentGoods: manifest.contracts.agentGoods.proxy,
      deploymentBlock: manifest.deploymentBlock,
    },
    "protocol manifest loaded"
  );

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  logger.info("mongo connected");
  await mongoose.syncIndexes().catch((err) => {
    logger.warn({ err: String(err) }, "index sync reported an issue");
  });

  const abis = new AbiRegistry(path.join(env.DEPLOYMENTS_DIR, "abi")).load();

  const providers = new ProviderPool({
    primaryUrl: env.RPC_HTTP_URL,
    secondaryUrl: env.RPC_HTTP_URL_SECONDARY,
    wsUrl: env.RPC_WS_URL,
    chainId: env.CHAIN_ID,
  });

  const indexer = new Indexer({
    manifest,
    providers,
    abis,
    safeConfirmations: env.SAFE_CONFIRMATIONS,
    maxReorgDepth: env.MAX_REORG_DEPTH,
    backfillChunk: env.INDEXER_BACKFILL_CHUNK,
    pollIntervalMs: env.INDEXER_POLL_MS,
    staleBlocks: env.INDEXER_STALE_BLOCKS,
  });

  const fallbackStatus: IndexerStatus = {
    chainId: manifest.chainId,
    indexedBlock: manifest.deploymentBlock,
    safeBlock: manifest.deploymentBlock,
    chainHead: manifest.deploymentBlock,
    lagBlocks: 0,
    lastIndexedAt: null,
    indexerStatus: "stopped",
    stale: true,
    watchedAddresses: 0,
  };

  const ctx: AppContext = {
    env,
    manifest,
    providers,
    abis,
    indexer: env.INDEXER_ENABLED ? indexer : null,
    indexerStatus: () => (env.INDEXER_ENABLED ? indexer.getStatus() : fallbackStatus),
    startedAt: new Date(),
  };

  if (env.INDEXER_ENABLED) {
    await indexer.start();
    logger.info("indexer started");
  } else {
    logger.warn("indexer disabled by configuration; every read will report stale");
  }

  /*
   * Webhook delivery.
   *
   * `allowPrivateTargets` is LOCAL-only and is the single reason a loopback destination can ever
   * be reached: the development stack has to be able to deliver to a listener on the same
   * machine. In every other environment the SSRF policy applies with no exception.
   */
  const webhookWorker = new WebhookWorker({
    pollIntervalMs: env.WEBHOOK_POLL_MS,
    batchSize: env.WEBHOOK_BATCH_SIZE,
    timeoutMs: env.WEBHOOK_TIMEOUT_MS,
    maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    maxWebhookFailures: env.WEBHOOK_MAX_FAILURES,
    allowPrivateTargets: env.ESH_ENVIRONMENT === "LOCAL",
    signingMasterKey: env.API_KEY_PEPPER,
  });
  webhookWorker.start();
  logger.info({ pollMs: env.WEBHOOK_POLL_MS }, "webhook delivery worker started");

  /*
   * Price sampling. Reads the projection only — no RPC — so it costs nothing on the chain and
   * cannot be a reason the API is slow. A failure inside it loses a chart point and nothing else.
   */
  const priceSampler = new PriceSampler({
    chainId: env.CHAIN_ID,
    intervalMs: env.PRICE_SAMPLE_MS,
    heartbeatSeconds: env.PRICE_SAMPLE_HEARTBEAT_SECONDS,
    retentionDays: env.PRICE_SAMPLE_RETENTION_DAYS,
  });
  if (env.PRICE_SAMPLER_ENABLED) {
    priceSampler.start();
  } else {
    logger.warn("price sampler disabled; a quiet market's chart will stop at its last trade");
  }

  /*
   * Moltbook is deliberately NOT started here. It runs only as a separate local process (see
   * `npm run moltbook:loop` and docs/MOLTBOOK.md) — never inside the Railway-deployed backend.
   * The integration's source is excluded from the Docker build entirely (.dockerignore), so this
   * process has no way to import it even by accident.
   */

  /*
   * The delivery witness. Records every collected delivery on chain so the buyer can rate it,
   * whatever the seller does. Needs its own funded wallet holding DELIVERY_GATEWAY_ROLE.
   */
  const deliveryGateway = env.ACCESS_GATEWAY_PRIVATE_KEY
    ? new DeliveryGateway({
        privateKey: env.ACCESS_GATEWAY_PRIVATE_KEY,
        rpcUrl: env.RPC_HTTP_URL,
        chainId: env.CHAIN_ID,
        pollMs: env.ACCESS_GATEWAY_POLL_MS,
      })
    : null;
  if (deliveryGateway) deliveryGateway.start();
  else logger.warn("delivery gateway off (ACCESS_GATEWAY_PRIVATE_KEY unset); only store attestors can record deliveries");

  const app = createApp(ctx);
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(env.PORT, env.HOST, resolve));
  /*
   * `createApp` validates the canonical origins and throws on a PRODUCTION misconfiguration, so by
   * the time this line runs they are known good. Logging them makes the first line of a deploy
   * answer "what did this instance just tell the world it is?".
   */
  const canonical = canonicalOrigins(env);
  logger.info(
    {
      port: env.PORT,
      host: env.HOST,
      publicOrigin: canonical.publicOrigin,
      apiBaseUrl: canonical.apiBaseUrl,
      sameOrigin: canonical.sameOrigin,
      allowedOrigins: canonical.allowedOrigins,
      servesUi: Boolean(process.env.FRONTEND_DIST),
    },
    "http listening"
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "graceful shutdown started");
    priceSampler.stop();
    deliveryGateway?.stop();

    server.close();
    await webhookWorker.stop().catch(() => undefined);
    await indexer.stop().catch(() => undefined);
    await providers.destroy().catch(() => undefined);
    await mongoose.disconnect().catch(() => undefined);

    logger.info("graceful shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: String(reason) }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: String(error), stack: error.stack }, "uncaught exception");
    void shutdown("uncaughtException");
  });
}

main().catch((error) => {
  logger.fatal({ err: String(error), stack: (error as Error).stack }, "startup failed");
  process.exit(1);
});
