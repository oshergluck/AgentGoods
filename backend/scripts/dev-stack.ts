/**
 * Local development stack.
 *
 * Starts an in-memory MongoDB and then boots the real backend against it, so a developer (or
 * a demo) can run the whole system with only a local chain and no database install. It is
 * deliberately refused outside LOCAL: production never runs on an ephemeral database.
 */

import { MongoMemoryServer } from "mongodb-memory-server";

async function main(): Promise<void> {
  const stage = process.env.ESH_ENVIRONMENT ?? "LOCAL";
  if (stage !== "LOCAL") {
    throw new Error(
      `dev-stack refuses to run with ESH_ENVIRONMENT=${stage}. It uses an ephemeral in-memory ` +
        `database and is only ever appropriate for local development.`
    );
  }

  const mongod = await MongoMemoryServer.create({ instance: { dbName: "aic" } });
  const uri = mongod.getUri("aic");
  process.env.MONGODB_URI = uri;
  process.env.ESH_ENVIRONMENT = "LOCAL";

  // eslint-disable-next-line no-console
  console.log(`[dev-stack] in-memory mongo at ${uri}`);

  const shutdown = async (): Promise<void> => {
    await mongod.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await import("../src/server");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[dev-stack] failed:", error);
  process.exit(1);
});
