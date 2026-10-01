/**
 * Turning indexed chain events into queued webhook deliveries.
 *
 * This is the transactional-outbox half of MASTER_PLAN 0.27.Y: a delivery row is written only
 * after the projection that the payload describes has been committed. An Agent that receives
 * `dividend.claim_available` and immediately reads `/api/v1/dividends/me` must find the claim
 * there. Emitting from the raw log instead would produce notifications that arrive before the
 * state they announce, which is worse than no notification at all.
 *
 * A webhook is never authority. Nothing in the protocol requires a delivery to arrive, and every
 * event here is recoverable from the cursor APIs. That is stated in the Agent schema and is why
 * the worker is allowed to give up on a dead endpoint.
 */

import crypto from "node:crypto";
import { Webhook, WebhookDelivery } from "../db/models";
import { logger } from "../utils/logger";
import type { EventDoc } from "../indexer/projector";

/** The catalogue published in the Agent schema. Keep the two in step. */
export const WEBHOOK_EVENTS = [
  "product.created",
  "store.created",
  "aic.market_initialized",
  "dividend.distribution_opened",
  "dividend.claim_available",
  "dividend.claim_confirmed",
  "governance.proposal_passed",
  "governance.store_locked",
  "governance.dividends_suspended",
  "governance.implementation_marked",
  "governance.verification_required",
  "governance.verification_threshold_reached",
  "governance.dividends_released",
  "governance.store_unlocked",
  "buyer_signal.submitted",
  "buyer_signal.changed",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

export function isWebhookEvent(value: string): value is WebhookEvent {
  return EVENT_SET.has(value);
}

/**
 * Chain event name to published event type.
 *
 * Several chain events map to more than one published type because they mean different things to
 * different subscribers: `ProposalPassed` is simultaneously "a proposal passed", "the store is
 * locked" and "the YES coalition dividends are suspended", and an Agent should be able to
 * subscribe to exactly the one it acts on.
 */
const EVENT_MAP: Record<string, WebhookEvent[]> = {
  ProductCreated: ["product.created"],
  StoreCreated: ["store.created"],
  MarketInitialized: ["aic.market_initialized"],
  DistributionOpened: ["dividend.distribution_opened"],
  RootFinalized: ["dividend.claim_available"],
  Claimed: ["dividend.claim_confirmed"],
  ProposalPassed: [
    "governance.proposal_passed",
    "governance.store_locked",
    "governance.dividends_suspended",
  ],
  ImplementationMarked: ["governance.implementation_marked", "governance.verification_required"],
  VerificationThresholdReached: [
    "governance.verification_threshold_reached",
    "governance.dividends_released",
    "governance.store_unlocked",
  ],
  BuyerSignalSubmitted: ["buyer_signal.submitted"],
  BuyerSignalChanged: ["buyer_signal.changed"],
};

/**
 * Stable identity for one (event type, chain event) pair.
 *
 * Derived from `(chainId, txHash, logIndex, eventType)`, which is the same identity the indexer
 * uses for exactly-once projection. A replayed log therefore produces the same `eventId`, and the
 * unique index on `(webhookId, eventId)` turns a redelivery attempt into a no-op. This is the
 * `deduplication` guarantee the Agent schema publishes.
 */
export function deliveryEventId(chainId: number, txHash: string, logIndex: number, eventType: string): string {
  return crypto
    .createHash("sha256")
    .update(`${chainId}:${txHash.toLowerCase()}:${logIndex}:${eventType}`)
    .digest("hex")
    .slice(0, 40);
}

function payloadFor(eventType: WebhookEvent, e: EventDoc): Record<string, unknown> {
  return {
    eventId: deliveryEventId(e.chainId, e.txHash, e.logIndex, eventType),
    type: eventType,
    chainId: e.chainId,
    storeId: e.storeId ?? null,
    contract: e.address,
    blockNumber: e.blockNumber,
    txHash: e.txHash,
    logIndex: e.logIndex,
    blockTimestamp: e.blockTimestamp,
    /** Chain-derived arguments, serialized as strings. Never seller prose. */
    data: e.args,
    notAuthoritative:
      "This notification is a projection of chain state, never authority over it. Re-read the " +
      "canonical API before acting, and recover missed events from the cursor APIs.",
  };
}

/**
 * Queues deliveries for one already-projected event.
 *
 * Failure here is logged and swallowed on purpose: a webhook is a convenience, and an indexer
 * that stopped advancing because a notification could not be queued would trade a real guarantee
 * for a cosmetic one.
 */
export async function emitWebhooks(e: EventDoc): Promise<number> {
  const types = EVENT_MAP[e.eventName];
  if (!types || types.length === 0) return 0;

  let queued = 0;
  try {
    for (const eventType of types) {
      const subscribers = await Webhook.find({ active: true, events: eventType }).lean();
      if (subscribers.length === 0) continue;

      const eventId = deliveryEventId(e.chainId, e.txHash, e.logIndex, eventType);
      const payload = payloadFor(eventType, e);

      for (const sub of subscribers) {
        // Upsert, never insert: a replayed log must not produce a second delivery.
        const result = await WebhookDelivery.updateOne(
          { webhookId: sub.webhookId, eventId },
          {
            $setOnInsert: {
              eventId,
              webhookId: sub.webhookId,
              eventType,
              payload,
              attempts: 0,
              nextAttemptAt: new Date(),
              status: "pending",
            },
          },
          { upsert: true }
        );
        if (result.upsertedCount > 0) queued += 1;
      }
    }
  } catch (error) {
    logger.error({ err: String(error), event: e.eventName }, "failed to queue webhook deliveries");
  }
  return queued;
}
