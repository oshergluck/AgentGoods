/**
 * The protocol's delivery witness, running.
 *
 * A buyer may rate a purchase only after its delivery is recorded on chain. That record used to be
 * written only by the store's own attestor — so the seller decided whether its buyers could ever
 * rate it, and a new store (which has no attestor) could not be rated at all: one run ended with
 * ten licences, every one collected or collectable, and zero signals.
 *
 * The access gateway is the party that actually served the bytes and checked their hash, so it is
 * the honest witness. The registry grants its wallet DELIVERY_GATEWAY_ROLE, and this worker
 * records every redeemed delivery session on chain — batched per licence contract, within
 * seconds, for every store, without the seller doing or deciding anything. The role can only
 * witness: it cannot signal, mint or move value.
 *
 * Off when ACCESS_GATEWAY_PRIVATE_KEY is unset: the protocol then falls back to store attestors.
 */
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { AccessSession } from "../db/models";
import { logger } from "../utils/logger";

const LICENSE_ABI = ["function recordAccessGrants(uint256[] licenseIds)", "function wasDelivered(uint256) view returns (bool)"];
const MAX_BATCH = 100;

export interface DeliveryGatewayOptions {
  privateKey: string;
  rpcUrl: string;
  chainId: number;
  pollMs: number;
}

export class DeliveryGateway {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly wallet: Wallet;

  constructor(private readonly o: DeliveryGatewayOptions) {
    this.wallet = new Wallet(o.privateKey, new JsonRpcProvider(o.rpcUrl, o.chainId));
  }

  get address(): string {
    return this.wallet.address;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.o.pollMs);
    this.timer.unref();
    logger.info({ gateway: this.wallet.address, pollMs: this.o.pollMs }, "delivery gateway started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: every redeemed, unrecorded session, grouped by licence contract, one tx per group. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const sessions = await AccessSession.find({
        redeemedAt: { $ne: null },
        attestationStatus: { $in: ["pending", "failed", "not_configured"] },
      })
        .sort({ issuedAt: 1 })
        .limit(MAX_BATCH * 4)
        .lean();
      const byToken = new Map<string, Set<string>>();
      for (const s of sessions) {
        const set = byToken.get(s.licenseToken) ?? new Set<string>();
        set.add(String(s.licenseId));
        byToken.set(s.licenseToken, set);
      }
      for (const [licenseToken, idSet] of byToken) {
        const license = new Contract(licenseToken, LICENSE_ABI, this.wallet);
        /* Record each licence once: a delivery already on chain needs no second witness. */
        const ids: string[] = [];
        for (const id of [...idSet].slice(0, MAX_BATCH)) {
          const done = await (license.wasDelivered as (i: string) => Promise<boolean>)(id).catch(() => false);
          if (!done) ids.push(id);
        }
        const all = [...idSet].slice(0, MAX_BATCH);
        if (ids.length === 0) {
          await AccessSession.updateMany(
            { licenseToken, licenseId: { $in: all }, redeemedAt: { $ne: null } },
            { $set: { attestationStatus: "confirmed" } }
          );
          continue;
        }
        try {
          const tx = await (license.recordAccessGrants as (ids: string[]) => Promise<{ hash: string; wait: () => Promise<unknown> }>)(ids);
          await AccessSession.updateMany(
            { licenseToken, licenseId: { $in: ids }, redeemedAt: { $ne: null } },
            { $set: { attestationStatus: "submitted", attestationTxHash: tx.hash } }
          );
          await tx.wait();
          await AccessSession.updateMany(
            { licenseToken, licenseId: { $in: all }, redeemedAt: { $ne: null } },
            { $set: { attestationStatus: "confirmed" } }
          );
          logger.info({ licenseToken, count: ids.length, tx: tx.hash }, "delivery gateway recorded deliveries");
        } catch (error) {
          await AccessSession.updateMany(
            { licenseToken, licenseId: { $in: ids }, redeemedAt: { $ne: null } },
            { $set: { attestationStatus: "failed" } }
          );
          logger.warn({ licenseToken, err: String(error).slice(0, 300) }, "delivery gateway could not record deliveries");
        }
      }
    } catch (error) {
      logger.warn({ err: String(error).slice(0, 300) }, "delivery gateway pass failed");
    } finally {
      this.busy = false;
    }
  }
}
