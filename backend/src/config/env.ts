/**
 * Environment configuration.
 *
 * MASTER_PLAN 0.24.O separates PROVING / CUTOVER / PRODUCTION state, and 0.21.R requires
 * production startup to fail closed on missing configuration. Secrets are read here and
 * never re-exported into the schema, OpenAPI, manifest or any response.
 */

import path from "node:path";
import { z } from "zod";

const BooleanFromString = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Deployment stage, distinct from NODE_ENV. [0.24.O] */
  ESH_ENVIRONMENT: z.enum(["LOCAL", "PROVING", "CUTOVER", "PRODUCTION"]).default("LOCAL"),

  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),

  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  DEPLOYMENTS_DIR: z.string().default(path.resolve(process.cwd(), "..", "deployments")),

  RPC_HTTP_URL: z.string().default("http://127.0.0.1:8545"),
  RPC_HTTP_URL_SECONDARY: z.string().optional(),
  RPC_WS_URL: z.string().optional(),

  MONGODB_URI: z.string().default("mongodb://127.0.0.1:27017/aic"),

  /** Confirmations before a block is treated as safe for canonical projections. [0.25.Y] */
  SAFE_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(12),
  /** Maximum reorg depth the indexer is prepared to roll back. */
  MAX_REORG_DEPTH: z.coerce.number().int().positive().default(64),
  /** Indexer lag, in blocks, beyond which write preparation returns INDEXER_STALE. [0.3] */
  INDEXER_STALE_BLOCKS: z.coerce.number().int().positive().default(150),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(2000),
  INDEXER_BACKFILL_CHUNK: z.coerce.number().int().positive().default(2000),
  INDEXER_ENABLED: BooleanFromString.default(true),

  /** Server-side pepper mixed into API key hashes. Never leaves the process. */
  API_KEY_PEPPER: z.string().min(16).default("local-development-pepper-change-me"),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  /** Exact browser origins allowed to call authenticated endpoints. [0.23 CORS] */
  CORS_ORIGINS: z.string().default(""),
  /** Trusted proxy hop count. Never blindly trust X-Forwarded-For. [0.23] */
  /**
   * How many reverse proxies sit in front of this process.
   *
   * 0 means Express ignores `X-Forwarded-For` entirely and `req.ip` is the socket peer — which
   * behind any platform edge is the EDGE's address, identical for every client on earth. Every
   * rate limit then shares one bucket globally, so one busy visitor rate-limits the entire
   * internet, including public protocol discovery. That is not a theoretical failure; it is the
   * production incident this default caused.
   *
   * It must stay 0 for a directly-exposed process, because a trusted `X-Forwarded-For` from an
   * untrusted client is a trivial rate-limit bypass. Behind Railway (or any single edge) it must
   * be 1: the platform appends the real client address, and trusting exactly one hop reads that
   * value while still ignoring anything the client put there itself.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),

  /** Canonical public base URL, used by the schema and by Moltbook post generation. [0.27.V] */
  PUBLIC_BASE_URL: z.string().default("http://localhost:4000"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:5173"),

  OBJECT_STORAGE_ENDPOINT: z.string().optional(),
  OBJECT_STORAGE_BUCKET: z.string().optional(),
  OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().optional(),
  /** AES-256-GCM key (hex) for encrypting paid content at rest. [0.9] */
  /* -------------------------------------------------------- access gateway */
  /**
   * Master key for product content encryption. Per-content keys are DERIVED from it per
   * (store, contentHash) and never stored beside the ciphertext, so this value alone is what
   * stands between a leaked object store and a leaked catalogue.
   *
   * The LOCAL default is deliberately named as a non-secret and is refused in PRODUCTION below.
   */
  CONTENT_ENCRYPTION_KEY: z.string().min(32).default("local-dev-content-key-not-a-secret-000000"),
  /** Signs short-lived delivery URLs. A separate key, because it has a separate purpose. */
  ACCESS_TOKEN_KEY: z.string().min(32).default("local-dev-access-token-key-not-a-secret-00"),

  /**
   * The service runner: the separate deployment that executes hosted service code (service-runner/).
   * Unset, services can still be listed and bought, but an invocation answers SERVICE_RUNNER_UNAVAILABLE —
   * seller code is never executed inside this API process.
   */
  SERVICE_RUNNER_URL: z.string().url().optional(),
  SERVICE_RUNNER_TOKEN: z.string().min(24).optional(),

  /**
   * Rate limits, per identity dimension and per minute.
   * MASTER_PLAN 0.27.S: limits must not break three-Agent proving or self-onboarding, so they
   * are configuration rather than hardcoded constants, and they key on wallet/API key first.
   */
  /* ------------------------------------------------------------ webhooks */
  /** Drain interval for the delivery outbox. */
  /** How often the price sampler looks. It writes only on change, plus a heartbeat. */
  PRICE_SAMPLE_MS: z.coerce.number().int().positive().default(30_000),
  PRICE_SAMPLE_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(300),
  PRICE_SAMPLE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  PRICE_SAMPLER_ENABLED: z.coerce.boolean().default(true),
  WEBHOOK_POLL_MS: z.coerce.number().int().positive().default(2_000),
  /** Deliveries per drain. Bounded so one busy block cannot starve the loop. */
  WEBHOOK_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Attempts before a delivery is abandoned. Every event stays recoverable from the cursor APIs. */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  /** Consecutive failures before the subscription is deactivated. */
  WEBHOOK_MAX_FAILURES: z.coerce.number().int().positive().default(20),

  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(600),
  /**
   * Public protocol discovery gets its own allowance.
   *
   * Discovery is how an Agent starts. If it shares a budget with everything else, ordinary site
   * traffic can make the protocol undiscoverable — which is exactly what happened: an external
   * Agent could not fetch the manifest, the schema or the OpenAPI document while a browser on
   * the same site worked fine. These responses are small, cacheable and identical for every
   * caller, so they can afford a generous ceiling and still be rate limited.
   */
  RATE_LIMIT_DISCOVERY_PER_MIN: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_CHALLENGE_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_KEY_OPS_PER_MIN: z.coerce.number().int().positive().default(10),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /* ------------------------------------------------------------ moltbook */
  /**
   * Moltbook is a third-party social network for autonomous agents. This credential is sent
   * ONLY to the official Moltbook origin (https://www.moltbook.com) and nowhere else. Absent,
   * the integration cannot authenticate and every write it might attempt fails closed.
   */
  MOLTBOOK_API_KEY: z.string().optional(),
  /**
   * disabled: no polling, no drafting, no writes.
   * review: polls and drafts proposed replies, but every publish requires a human to approve it.
   * autonomous: may publish replies within the reply policy and safety gates, unattended.
   * The launch post is NEVER published automatically in any mode; it always requires the
   * explicit `moltbook:publish-launch` command.
   */
  MOLTBOOK_MODE: z.enum(["disabled", "review", "autonomous"]).default("review"),
  /** Official Moltbook API base. Overridable only so tests can point it at a local fixture. */
  MOLTBOOK_BASE_URL: z.string().default("https://www.moltbook.com/api/v1"),
  MOLTBOOK_AGENT_NAME: z.string().default("AgentGoods"),
  /** Public testnet UI, used only in Moltbook post copy. Not protocol-critical. */
  TESTNET_PUBLIC_URL: z.string().default("https://testnet.agentgoods.ai"),
  /** Combined ceiling on posts + comments published per UTC day, across all Moltbook writes. */
  MOLTBOOK_DAILY_WRITE_BUDGET: z.coerce.number().int().positive().default(20),
  /** How often the background poller checks /api/v1/home for mentions/replies. */
  MOLTBOOK_POLL_MS: z.coerce.number().int().positive().default(300_000),
  /** Minimum time between two replies to the same external author, regardless of thread. */
  MOLTBOOK_AUTHOR_COOLDOWN_MINUTES: z.coerce.number().int().nonnegative().default(30),
  /** A thread deeper than this is never replied to, so two agents cannot loop indefinitely. */
  MOLTBOOK_MAX_THREAD_DEPTH: z.coerce.number().int().positive().default(4),
  /**
   * Composes a reply via a single OpenAI chat-completion call (plain text in/out, no tool use, no
   * function calling — see src/integrations/moltbook/llmDraft.ts) when no fixed template matches
   * an on-topic question. Off by default: absent an OPENAI_API_KEY, the integration falls back to
   * template-only behaviour rather than failing.
   */
  MOLTBOOK_LLM_DRAFTING_ENABLED: z.coerce.boolean().default(false),
  /** Never sent anywhere but https://api.openai.com. Used ONLY for Moltbook reply drafting. */
  OPENAI_API_KEY: z.string().optional(),
  /** The delivery gateway's wallet (registry DELIVERY_GATEWAY_ROLE). Unset: no automatic delivery records. */
  ACCESS_GATEWAY_PRIVATE_KEY: z.string().optional(),
  ACCESS_GATEWAY_POLL_MS: z.coerce.number().int().min(2000).default(15000),
  MOLTBOOK_OPENAI_MODEL: z.string().default("gpt-5-mini"),
  MOLTBOOK_OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /** A SEPARATE ceiling from the write budget: this bounds spend on drafting, published or not. */
  MOLTBOOK_DAILY_INFERENCE_BUDGET: z.coerce.number().int().positive().default(50),
  /**
   * Other agents' posts the loop should engage with, comma-separated Moltbook post ids. It replies
   * once to each post itself and answers the comments under it, like on our own posts. An explicit,
   * operator-chosen list: the loop never picks strangers' threads on its own.
   */
  MOLTBOOK_WATCHED_POSTS: z.string().default(""),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${parsed.error.toString()}`);
  }
  const env = parsed.data;

  if (env.ESH_ENVIRONMENT === "PRODUCTION") {
    const missing: string[] = [];
    if (env.API_KEY_PEPPER === "local-development-pepper-change-me") missing.push("API_KEY_PEPPER");
    if (!source.MONGODB_URI) missing.push("MONGODB_URI");
    if (!source.RPC_HTTP_URL) missing.push("RPC_HTTP_URL");
    if (!source.PUBLIC_BASE_URL) missing.push("PUBLIC_BASE_URL");
    if (!env.CORS_ORIGINS) missing.push("CORS_ORIGINS");
    if (env.CONTENT_ENCRYPTION_KEY.startsWith("local-dev-")) missing.push("CONTENT_ENCRYPTION_KEY");
    if (env.ACCESS_TOKEN_KEY.startsWith("local-dev-")) missing.push("ACCESS_TOKEN_KEY");
    if (missing.length > 0) {
      throw new Error(
        `PRODUCTION startup refused: missing or default-valued ${missing.join(", ")}. ` +
          `The backend never silently falls back in production. [MASTER_PLAN 0.21.R]`
      );
    }
  }

  return env;
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}

export function corsOrigins(e: Env): string[] {
  return e.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
