/**
 * Periodic price sampling, so the chart has history when nobody was watching.
 *
 * The price series is built from trades. On a bonding curve the price only moves when someone
 * trades, so that series is *correct* — and a market that traded five hours ago renders a chart
 * that stops five hours ago, which reads as broken to whoever arrives next.
 *
 * This writes the missing points. Three properties are deliberate:
 *
 * **It performs no RPC.** The price comes from the indexed projection, the same figure the API
 * already serves. Rule 14 is not suspended because this runs on a timer rather than a request.
 *
 * **It writes on change, with a heartbeat.** Ticking every 30 seconds into the database would
 * store 2,880 near-identical rows per market per day. Writing only when the price actually moved,
 * plus one heartbeat when it has been quiet, produces the same chart from a small fraction of the
 * rows — the frontend already carries the last value forward across gaps.
 *
 * **It is idempotent, last-write-wins per second.** The series is keyed to `(chainId, aicToken,
 * at)` in whole seconds and written by upsert, so two observations inside one second collapse to
 * the newer value rather than the older one surviving. That also makes concurrent instances safe:
 * a rolling deploy runs two copies for a few seconds by design, and they converge instead of one
 * of them erroring.
 */

import { PriceSample, StockMarket } from "../db/models";
import { logger } from "../utils/logger";

export interface PriceSamplerOptions {
  chainId: number;
  /** How often to look. Not how often it writes. */
  intervalMs: number;
  /** Write even with no change once this long has passed, so a quiet series still reaches now. */
  heartbeatSeconds: number;
  /** How long a sample is kept. Mongo expires them; nothing has to remember to clean up. */
  retentionDays: number;
}

export class PriceSampler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Last value written per token, so an unchanged price costs no write and no read. */
  private readonly lastWritten = new Map<string, { price: string; at: number }>();

  constructor(private readonly options: PriceSamplerOptions) {}

  start(): void {
    if (this.timer) return;
    // `unref` so a sampler can never be the reason the process refuses to exit.
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
    logger.info(
      {
        intervalMs: this.options.intervalMs,
        heartbeatSeconds: this.options.heartbeatSeconds,
        retentionDays: this.options.retentionDays,
      },
      "price sampler started"
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests: one pass, awaited. Returns how many samples were written. */
  async tick(): Promise<number> {
    // A slow pass must not overlap the next tick and double-write.
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.sampleOnce();
    } catch (error) {
      // A sampling failure is cosmetic: the chart loses a point. It must never take down the API.
      logger.warn({ err: error }, "price sampling pass failed");
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async sampleOnce(): Promise<number> {
    const { chainId, heartbeatSeconds, retentionDays } = this.options;

    const markets = await StockMarket.find({ chainId })
      .select({ aicToken: 1, storeId: 1, currentIndexedPrice1e18: 1 })
      .lean();

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((now + retentionDays * 86_400) * 1000);
    const writes: Record<string, unknown>[] = [];

    for (const market of markets) {
      const price = String(market.currentIndexedPrice1e18 ?? "0");
      // A market with no price has nothing to record. Writing 0 would draw a line to the floor.
      if (!price || price === "0") continue;

      const key = `${market.aicToken}`;
      const last = this.lastWritten.get(key);
      const changed = last?.price !== price;
      const stale = !last || now - last.at >= heartbeatSeconds;
      if (!changed && !stale) continue;

      writes.push({
        chainId,
        aicToken: market.aicToken,
        storeId: market.storeId,
        at: now,
        price1e18: price,
        reason: changed ? "change" : "heartbeat",
        expiresAt,
      });
      this.lastWritten.set(key, { price, at: now });
    }

    if (writes.length === 0) return 0;

    /*
     * Upsert, so the LAST price observed in a given second wins.
     *
     * The series is keyed to the second, and an insert would simply drop a second observation in
     * the same second — which is not rare: the price can move twice inside one 2-second block
     * window, and the value that was dropped is the newer one. Overwriting keeps the correct
     * value for that second and is still idempotent, so two instances racing during a rolling
     * deploy converge on the same row instead of one of them erroring.
     */
    await PriceSample.bulkWrite(
      writes.map((doc) => ({
        updateOne: {
          filter: { chainId: doc.chainId, aicToken: doc.aicToken, at: doc.at },
          update: { $set: doc },
          upsert: true,
        },
      })),
      { ordered: false }
    );
    return writes.length;
  }
}
