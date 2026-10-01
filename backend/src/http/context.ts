/**
 * Per-process application context.
 *
 * Built once at startup from the validated environment and the protocol manifest, then
 * injected into every route. Holding it in one object keeps route handlers free of imports
 * from the config layer and makes the whole app trivially constructible in tests.
 */

import type { Env } from "../config/env";
import type { ProtocolManifest } from "../config/manifest";
import type { ProviderPool } from "../rpc/provider";
import type { AbiRegistry } from "../indexer/abis";
import type { Indexer, IndexerStatus } from "../indexer/indexer";

export interface AppContext {
  env: Env;
  manifest: ProtocolManifest;
  providers: ProviderPool | null;
  abis: AbiRegistry;
  indexer: Indexer | null;
  /** Indexer freshness, exposed on every discovery and dividend response. [0.22.F] */
  indexerStatus(): IndexerStatus;
  startedAt: Date;
}

export interface FreshnessEnvelope {
  indexedBlock: number;
  safeBlock: number;
  chainHead: number;
  lagBlocks: number;
  lastIndexedAt: string | null;
  indexerStatus: "starting" | "backfilling" | "live" | "degraded" | "stopped";
  stale: boolean;
  asOfIndexedBlock: number;
}

export function freshness(ctx: AppContext): FreshnessEnvelope {
  const s = ctx.indexerStatus();
  return {
    indexedBlock: s.indexedBlock,
    safeBlock: s.safeBlock,
    chainHead: s.chainHead,
    lagBlocks: s.lagBlocks,
    lastIndexedAt: s.lastIndexedAt,
    indexerStatus: s.indexerStatus,
    stale: s.stale,
    asOfIndexedBlock: s.indexedBlock,
  };
}

/** Express request augmentation. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: AppContext;
      requestId: string;
      agent?: { wallet: string; apiKeyPrefix: string; issuedAt?: Date | null; updatesReadAt?: Date | null };
      idempotency?: { key: string; action: string; scopeId: string; requestHash: string };
    }
  }
}

export {};
