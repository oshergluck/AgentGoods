/**
 * Indexer V2.
 *
 * Architecture (MASTER_PLAN §8):
 *
 *     Chain -> Indexer -> MongoDB -> API/UI            (never API -> RPC per read)
 *
 * Guarantees implemented here:
 *  - §8.2 event identity is (chainId, txHash, logIndex) and processing is idempotent;
 *  - §8.3 the cursor lives in Mongo with its block hash, never on the local filesystem;
 *  - §8.4 startup loads the cursor, backfills to the safe head, then follows the head;
 *  - §8.5 reorgs are detected by parent-hash mismatch, rolled back, and replayed;
 *  - §8.7 the backfill window adapts down on provider limits and up on sparse ranges;
 *  - §0.25.Y projections are exactly-once even though logs arrive at least once;
 *  - §0.24.M an object seen only in an unsafe block never becomes permanently canonical.
 */

import { EventEmitter } from "node:events";
import { type Log } from "ethers";
import { AbiRegistry, WATCHED_EVENTS, type ContractRole } from "./abis";
import { AddressBook } from "./addressBook";
import { ProviderPool } from "../rpc/provider";
import { BlockRef, ChainEvent, IndexerCursor } from "../db/models";
import { logger } from "../utils/logger";
import type { ProtocolManifest } from "../config/manifest";
import { applyEvent, reprojectStore, reprojectCore, recountEoaHolders, repairHolderEligibility, setCodeCheck } from "./projector";
import { emitWebhooks } from "../webhooks/emitter";

export interface IndexerOptions {
  manifest: ProtocolManifest;
  providers: ProviderPool;
  abis: AbiRegistry;
  safeConfirmations: number;
  maxReorgDepth: number;
  backfillChunk: number;
  pollIntervalMs: number;
  staleBlocks: number;
}

export interface IndexerStatus {
  chainId: number;
  indexedBlock: number;
  safeBlock: number;
  chainHead: number;
  lagBlocks: number;
  lastIndexedAt: string | null;
  indexerStatus: "starting" | "backfilling" | "live" | "degraded" | "stopped";
  stale: boolean;
  watchedAddresses: number;
}

const STREAM = "canonical";

/**
 * Blocks behind the head before the indexer calls itself "backfilling" rather than "live".
 * Below this, catching up is ordinary steady-state work on an active chain.
 */
const MIN_BACKFILL_BLOCKS = 25;

export class Indexer extends EventEmitter {
  readonly addressBook: AddressBook;
  private readonly o: IndexerOptions;
  private chunk: number;
  private running = false;
  /**
   * Cooperative cancellation for a long backfill. Deliberately separate from `running`, so a
   * single `tick()` is fully self-contained and can be driven synchronously by tests and by
   * the reconciliation job without first starting the background loop.
   */
  private stopRequested = false;
  private timer: NodeJS.Timeout | null = null;
  private status: IndexerStatus;

  constructor(options: IndexerOptions) {
    super();
    this.o = options;
    this.chunk = options.backfillChunk;
    this.addressBook = new AddressBook(options.manifest);
    // The chain's eligibility rule is "no code"; the projector checks it through the same providers.
    setCodeCheck(async (address) => {
      const code = await options.providers.call("getCode", (p) => p.getCode(address));
      return typeof code === "string" && code !== "0x";
    });
    this.status = {
      chainId: options.manifest.chainId,
      indexedBlock: options.manifest.deploymentBlock,
      safeBlock: options.manifest.deploymentBlock,
      chainHead: options.manifest.deploymentBlock,
      lagBlocks: 0,
      lastIndexedAt: null,
      indexerStatus: "starting",
      stale: true,
      watchedAddresses: this.addressBook.size(),
    };
  }

  getStatus(): IndexerStatus {
    return { ...this.status, watchedAddresses: this.addressBook.size() };
  }

  /** Loads the cursor and the watched address set. No RPC. */
  async init(): Promise<void> {
    const chainId = this.o.manifest.chainId;
    await this.addressBook.hydrate(chainId);
    // Rows indexed before holders were checked for code are classified once, here.
    await repairHolderEligibility(chainId).catch(() => 0);
    await recountEoaHolders(chainId).catch(() => undefined);

    const cursor = await IndexerCursor.findOneAndUpdate(
      { chainId, stream: STREAM },
      {
        $setOnInsert: {
          chainId,
          stream: STREAM,
          lastProcessedBlock: Math.max(0, this.o.manifest.deploymentBlock - 1),
          safeBlock: Math.max(0, this.o.manifest.deploymentBlock - 1),
          chainHead: 0,
          status: "starting",
        },
      },
      { upsert: true, new: true }
    );

    this.status.indexedBlock = cursor.lastProcessedBlock;
    this.status.safeBlock = cursor.safeBlock;
    logger.info(
      { indexedBlock: cursor.lastProcessedBlock, watched: this.addressBook.size() },
      "indexer initialised"
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    await this.init();
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.setStatus("stopped");
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        logger.error({ err: String(error) }, "indexer tick failed");
        await this.setStatus("degraded", String(error));
      }
      if (!this.running) break;
      await new Promise((resolve) => {
        this.timer = setTimeout(resolve, this.o.pollIntervalMs);
      });
    }
  }

  /** One unit of work: detect reorgs, then advance toward the head. Safe to call in tests. */
  async tick(): Promise<void> {
    const head = await this.o.providers.call("getBlockNumber", (p) => p.getBlockNumber());
    this.status.chainHead = head;
    const safeHead = Math.max(0, head - this.o.safeConfirmations);

    await this.detectAndHandleReorg();

    let from = this.status.indexedBlock + 1;
    if (from > head) {
      await this.persistCursor(this.status.indexedBlock, safeHead, head);
      await this.setStatus("live");
      return;
    }

    /*
     * "backfilling" must mean MEANINGFULLY behind, not merely "a tick is in progress".
     *
     * The threshold used to be `safeConfirmations * 4`, which degenerates to zero on a chain
     * configured with `safeConfirmations: 0`. A single pending block then flipped the status to
     * backfilling for the duration of every tick, so a perfectly healthy indexer on a busy chain
     * displayed amber almost continuously — and that status is exactly what an Agent reads to
     * decide whether the data under it can be trusted. A floor keeps the signal meaningful.
     */
    const backlogThreshold = Math.max(this.o.safeConfirmations * 4, MIN_BACKFILL_BLOCKS);
    await this.setStatus(head - this.status.indexedBlock > backlogThreshold ? "backfilling" : "live");

    while (from <= head && !this.stopRequested) {
      const to = Math.min(from + this.chunk - 1, head);
      await this.scanRange(from, to, head, safeHead);

      this.status.indexedBlock = to;
      await this.persistCursor(to, safeHead, head);
      from = to + 1;
    }

    this.status.safeBlock = safeHead;
    this.status.lagBlocks = Math.max(0, head - this.status.indexedBlock);
    this.status.stale = this.status.lagBlocks > this.o.staleBlocks;
    this.status.lastIndexedAt = new Date().toISOString();
    await this.setStatus(this.status.stale ? "degraded" : "live");
    this.emit("advanced", this.getStatus());
  }

  /**
   * Scans one block range to a fixed point.
   *
   * The log filter is narrow by address (MASTER_PLAN 8.6), which creates a subtlety: a store
   * created inside this very range is not in the address set used to build the filter, so its
   * own `ProductCreated`, `CommerceSettled` and similar logs would never be fetched and the
   * cursor would advance straight past them. Discovering new canonical addresses therefore
   * re-scans the same range with the enlarged set until the set stops growing. Ingestion is
   * idempotent, so re-offering already-processed logs is a no-op.
   */
  private async scanRange(from: number, to: number, head: number, safeHead: number): Promise<void> {
    const MAX_DISCOVERY_PASSES = 8;
    for (let pass = 0; pass < MAX_DISCOVERY_PASSES; pass++) {
      const sizeBefore = this.addressBook.size();
      const logs = await this.fetchLogs(from, to);
      await this.recordBlockRefs(logs, from, to, head);
      await this.ingest(logs, safeHead);
      if (this.addressBook.size() === sizeBefore) return;
      logger.debug(
        { from, to, pass, watched: this.addressBook.size() },
        "new canonical addresses discovered; re-scanning the range"
      );
    }
    logger.warn({ from, to }, "address discovery did not converge within the pass limit");
  }

  /**
   * Adaptive `eth_getLogs`. Narrow address filter; window halves on a provider limit error
   * and grows back on sparse ranges. [MASTER_PLAN 8.6, 8.7]
   */
  private async fetchLogs(from: number, to: number): Promise<Log[]> {
    const addresses = this.addressBook.addresses();
    if (addresses.length === 0) return [];

    try {
      const logs = await this.o.providers.call("getLogs", (p) =>
        p.getLogs({ fromBlock: from, toBlock: to, address: addresses })
      );
      if (logs.length < 50 && this.chunk < this.o.backfillChunk * 8) {
        this.chunk = Math.min(this.chunk * 2, this.o.backfillChunk * 8);
      }
      return logs;
    } catch (error) {
      const message = String(error);
      const limited = /too many|limit|range|exceed|timeout|response size/i.test(message);
      if (limited && this.chunk > 1) {
        this.chunk = Math.max(1, Math.floor(this.chunk / 2));
        logger.warn({ from, to, chunk: this.chunk }, "reducing backfill window after provider limit");
        return this.fetchLogs(from, Math.min(from + this.chunk - 1, to));
      }
      throw error;
    }
  }

  /**
   * Stores block hashes for every block that produced a log, plus the tip of the scanned
   * range, which is what the next tick compares against to detect a reorg.
   */
  private async recordBlockRefs(logs: Log[], from: number, to: number, head: number): Promise<void> {
    const wanted = new Set<number>(logs.map((l) => l.blockNumber));
    // Always anchor the tip so an empty range still detects a reorg.
    if (to >= head - this.o.maxReorgDepth) wanted.add(to);
    if (wanted.size === 0) return;

    const chainId = this.o.manifest.chainId;
    for (const blockNumber of [...wanted].sort((a, b) => a - b)) {
      const block = await this.o.providers.call("getBlock", (p) => p.getBlock(blockNumber));
      if (!block) continue;
      await BlockRef.updateOne(
        { chainId, blockNumber },
        {
          $set: {
            chainId,
            blockNumber,
            blockHash: block.hash ?? "",
            parentHash: block.parentHash,
            timestamp: block.timestamp,
          },
        },
        { upsert: true }
      );
    }

    // Keep the block reference window bounded.
    await BlockRef.deleteMany({ chainId, blockNumber: { $lt: from - this.o.maxReorgDepth * 4 } });
  }

  /**
   * Compares stored block hashes against the chain and, on divergence, rolls the projection
   * back to the fork point. [MASTER_PLAN 8.5, 0.25.Y]
   */
  private async detectAndHandleReorg(): Promise<number | null> {
    const chainId = this.o.manifest.chainId;
    const recent = await BlockRef.find({ chainId })
      .sort({ blockNumber: -1 })
      .limit(this.o.maxReorgDepth)
      .lean();
    if (recent.length === 0) return null;

    let forkPoint: number | null = null;
    for (const ref of recent) {
      const onChain = await this.o.providers.call("getBlock", (p) => p.getBlock(ref.blockNumber));
      if (!onChain) {
        // Block no longer exists at that height: definitely reorged past it.
        forkPoint = ref.blockNumber - 1;
        continue;
      }
      if (onChain.hash === ref.blockHash) {
        break;
      }
      forkPoint = ref.blockNumber - 1;
    }

    if (forkPoint === null) return null;

    logger.warn({ forkPoint, previousIndexed: this.status.indexedBlock }, "reorg detected, rolling back");
    await this.rollbackTo(forkPoint);
    this.emit("reorg", { forkPoint });
    return forkPoint;
  }

  /**
   * Removes every projection above the fork point and rebuilds the affected entities by
   * replaying their surviving canonical events. Rebuilding from the event log rather than
   * attempting to invert each projection write is what makes rollback exact.
   */
  async rollbackTo(forkPoint: number): Promise<void> {
    const chainId = this.o.manifest.chainId;

    const orphaned = await ChainEvent.find({ chainId, blockNumber: { $gt: forkPoint } })
      .select({ storeId: 1, contractRole: 1 })
      .lean();
    const affectedStores = new Set<string>();
    let coreAffected = false;
    for (const e of orphaned) {
      if (e.storeId) affectedStores.add(e.storeId);
      if (e.contractRole === "registry" || e.contractRole === "factory" || e.contractRole === "treasury") {
        coreAffected = true;
      }
    }

    await ChainEvent.deleteMany({ chainId, blockNumber: { $gt: forkPoint } });
    await BlockRef.deleteMany({ chainId, blockNumber: { $gt: forkPoint } });

    if (coreAffected) {
      await reprojectCore(chainId, this.addressBook);
    }
    for (const storeId of affectedStores) {
      await reprojectStore(chainId, storeId);
    }

    this.status.indexedBlock = forkPoint;
    this.status.safeBlock = Math.min(this.status.safeBlock, forkPoint);
    await this.persistCursor(forkPoint, this.status.safeBlock, this.status.chainHead);
  }

  /** Decodes, persists and projects a batch of logs. Every step is idempotent. */
  private async ingest(logs: Log[], safeHead: number): Promise<void> {
    const chainId = this.o.manifest.chainId;
    const ordered = [...logs].sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.index - b.index : a.blockNumber - b.blockNumber
    );

    for (const log of ordered) {
      const watched = this.addressBook.get(log.address);
      if (!watched) continue;

      const decoded = this.decode(watched.role, log);
      if (!decoded) continue;

      const blockRef = await BlockRef.findOne({ chainId, blockNumber: log.blockNumber }).lean();
      const blockTimestamp = blockRef?.timestamp ?? 0;

      const doc = {
        chainId,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        txIndex: log.transactionIndex,
        logIndex: log.index,
        address: log.address.toLowerCase(),
        contractRole: watched.role,
        eventName: decoded.name,
        args: decoded.args,
        blockTimestamp,
        // Tag by the watched address first, then fall back to a storeId carried in the event
        // itself. Registry and Factory addresses are not store-scoped, but their events are,
        // and the tag is what makes targeted reorg re-projection and rebuild-from-log exact.
        storeId: watched.storeId ?? storeIdFromArgs(decoded.args),
        finality: log.blockNumber <= safeHead ? ("safe" as const) : ("pending" as const),
      };

      // Exactly-once projection: the unique index makes a replayed log a no-op.
      const result = await ChainEvent.updateOne(
        { chainId, txHash: doc.txHash, logIndex: doc.logIndex },
        { $set: doc },
        { upsert: true }
      );
      const isNew = result.upsertedCount > 0;

      if (isNew) {
        await applyEvent(doc, this.addressBook);
        // Transactional outbox: deliveries are queued only AFTER the projection commits, so an
        // Agent that reacts to a notification always finds the state it announces. [0.27.Y]
        await emitWebhooks(doc);
        this.emit("event", doc);
      } else {
        // Already projected; only refresh finality so "pending" can become "safe".
        await ChainEvent.updateOne(
          { chainId, txHash: doc.txHash, logIndex: doc.logIndex },
          { $set: { finality: doc.finality } }
        );
      }
    }
  }

  private decode(role: ContractRole, log: Log): { name: string; args: Record<string, unknown> } | null {
    const iface = this.o.abis.interfaceFor(role);
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      return null;
    }
    if (!parsed) return null;
    if (!WATCHED_EVENTS[role].includes(parsed.name)) return null;

    const args: Record<string, unknown> = {};
    parsed.fragment.inputs.forEach((input, i) => {
      args[input.name || `arg${i}`] = normalize(parsed!.args[i]);
    });
    return { name: parsed.name, args };
  }

  private async persistCursor(indexed: number, safeBlock: number, head: number): Promise<void> {
    const chainId = this.o.manifest.chainId;
    const ref = await BlockRef.findOne({ chainId, blockNumber: indexed }).lean();
    await IndexerCursor.updateOne(
      { chainId, stream: STREAM },
      {
        $set: {
          lastProcessedBlock: indexed,
          lastProcessedBlockHash: ref?.blockHash ?? null,
          safeBlock,
          chainHead: head,
          lastIndexedAt: new Date(),
        },
      }
    );
  }

  private async setStatus(status: IndexerStatus["indexerStatus"], error?: string): Promise<void> {
    this.status.indexerStatus = status;
    await IndexerCursor.updateOne(
      { chainId: this.o.manifest.chainId, stream: STREAM },
      { $set: { status, lastError: error ?? null } }
    );
  }
}

/** Extracts a store identity carried inside an event payload, if there is one. */
function storeIdFromArgs(args: Record<string, unknown>): string | null {
  const value = args.storeId;
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
}

/** Recursively converts ethers Result values into JSON-safe, exact representations. */
function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalize(v);
    return out;
  }
  return value;
}
