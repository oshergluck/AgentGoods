/**
 * Webhook delivery worker.
 *
 * Drains the outbox, signs each body, POSTs it, and retires an endpoint that will not accept
 * deliveries. The behaviours that matter:
 *
 *  - the SSRF check runs again immediately before every request, against the address actually
 *    resolved now. Validating only at registration is defeated by DNS rebinding.
 *  - retries back off exponentially with jitter and stop at a fixed attempt count, after which
 *    the delivery is marked `dead` rather than retried forever. A webhook is a notification; the
 *    protocol never depends on one arriving, so an endpoint that is gone is allowed to stay gone.
 *  - a webhook whose failures accumulate is deactivated, so one broken subscriber cannot occupy
 *    the queue indefinitely.
 *  - the response body is read but never parsed, acted on, or logged beyond a short excerpt. It
 *    is attacker-controlled text from a destination the Agent chose.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { Webhook, WebhookDelivery } from "../db/models";
import { logger } from "../utils/logger";
import { assertSafeWebhookTarget, SsrfError } from "./ssrf";
import { deriveWebhookSecret, signDelivery } from "./signing";

export interface WorkerOptions {
  /** How often to drain the queue. */
  pollIntervalMs: number;
  /** Deliveries handled per drain. Bounded so one busy epoch cannot starve the loop. */
  batchSize: number;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Attempts before a delivery is declared dead. */
  maxAttempts: number;
  /** Consecutive failures before the subscription itself is deactivated. */
  maxWebhookFailures: number;
  /** LOCAL only: permits delivery to loopback so the dev stack can receive its own webhooks. */
  allowPrivateTargets: boolean;
  /** Master key the per-webhook signing secret is derived from. Never stored in the database. */
  signingMasterKey: string;
}

/** Exponential backoff with full jitter, capped. Attempt 1 waits ~5s, attempt 6 ~5 minutes. */
export function backoffMs(attempt: number): number {
  const base = Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 300_000);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

export class WebhookWorker {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(private readonly o: WorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Let a drain in progress finish, so a delivery is never abandoned mid-request.
    for (let i = 0; i < 50 && this.inFlight; i += 1) await sleep(100);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.drain();
      } catch (error) {
        logger.error({ err: String(error) }, "webhook worker drain failed");
      }
      if (!this.running) break;
      await new Promise((resolve) => {
        this.timer = setTimeout(resolve, this.o.pollIntervalMs);
      });
    }
  }

  /** One pass over due deliveries. Safe to call directly; the tests drive it synchronously. */
  async drain(): Promise<{ delivered: number; failed: number; dead: number }> {
    this.inFlight = true;
    const summary = { delivered: 0, failed: 0, dead: 0 };
    try {
      const due = await WebhookDelivery.find({ status: "pending", nextAttemptAt: { $lte: new Date() } })
        .sort({ nextAttemptAt: 1 })
        .limit(this.o.batchSize)
        .lean();

      for (const delivery of due) {
        const outcome = await this.deliver(delivery.webhookId, delivery.eventId, delivery.payload, delivery.attempts);
        if (outcome === "delivered") summary.delivered += 1;
        else if (outcome === "dead") summary.dead += 1;
        else summary.failed += 1;
      }
    } finally {
      this.inFlight = false;
    }
    return summary;
  }

  private async deliver(
    webhookId: string,
    eventId: string,
    payload: unknown,
    attempts: number
  ): Promise<"delivered" | "failed" | "dead"> {
    const subscription = await Webhook.findOne({ webhookId }).lean();
    if (!subscription || !subscription.active) {
      await WebhookDelivery.updateOne(
        { webhookId, eventId },
        { $set: { status: "dead", lastError: "subscription inactive or removed" } }
      );
      return "dead";
    }

    // Recomputed, never read from storage: the database holds nothing that can forge a delivery.
    const { secret } = deriveWebhookSecret(this.o.signingMasterKey, webhookId, subscription.secretVersion ?? 1);

    const rawBody = JSON.stringify(payload);
    const nextAttempt = attempts + 1;

    try {
      // Re-validate NOW. The address a hostname resolves to is not a property of registration.
      const target = await assertSafeWebhookTarget(subscription.url, {
        allowPrivate: this.o.allowPrivateTargets,
      });

      const signature = signDelivery(rawBody, secret);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.o.timeoutMs);

      let status = 0;
      try {
        const response = await fetch(target.url.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "aic-webhooks/1",
            "x-aic-event": String((payload as { type?: string }).type ?? ""),
            "x-aic-event-id": eventId,
            "x-aic-signature": signature.header,
            "x-aic-timestamp": String(signature.timestamp),
          },
          body: rawBody,
          signal: controller.signal,
          redirect: "manual", // a redirect is a second destination that was never validated
        });
        status = response.status;
        // Drained and discarded: the response body is attacker-controlled and means nothing.
        await response.text().catch(() => "");
      } finally {
        clearTimeout(timeout);
      }

      if (status >= 200 && status < 300) {
        await WebhookDelivery.updateOne(
          { webhookId, eventId },
          { $set: { status: "delivered", attempts: nextAttempt, lastError: null } }
        );
        await Webhook.updateOne({ webhookId }, { $set: { lastDeliveryAt: new Date(), failureCount: 0 } });
        return "delivered";
      }

      return await this.recordFailure(webhookId, eventId, nextAttempt, `HTTP ${status}`);
    } catch (error) {
      const reason =
        error instanceof SsrfError
          ? `destination rejected: ${error.reason}`
          : String(error).slice(0, 200);
      return await this.recordFailure(webhookId, eventId, nextAttempt, reason);
    }
  }

  private async recordFailure(
    webhookId: string,
    eventId: string,
    attempts: number,
    lastError: string
  ): Promise<"failed" | "dead"> {
    const exhausted = attempts >= this.o.maxAttempts;

    await WebhookDelivery.updateOne(
      { webhookId, eventId },
      {
        $set: {
          attempts,
          lastError,
          status: exhausted ? "dead" : "pending",
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        },
      }
    );

    const updated = await Webhook.findOneAndUpdate(
      { webhookId },
      { $inc: { failureCount: 1 } },
      { new: true }
    ).lean();

    if (updated && updated.failureCount >= this.o.maxWebhookFailures) {
      // One dead endpoint must not be able to occupy the queue forever.
      await Webhook.updateOne({ webhookId }, { $set: { active: false } });
      logger.warn(
        { webhookId, failureCount: updated.failureCount },
        "webhook deactivated after repeated delivery failures"
      );
    }

    return exhausted ? "dead" : "failed";
  }
}
