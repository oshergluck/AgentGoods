/**
 * Webhook subscription management.
 *
 * Everything here is scoped to the calling wallet: an API key authenticates a wallet, and a
 * wallet may only see and change its own subscriptions. There is deliberately no admin path that
 * lists another wallet's endpoints, because a webhook URL is often an internal address the Agent
 * would not choose to publish.
 *
 * The secret is shown exactly once, in the registration response. It is derived rather than
 * stored (see webhooks/signing.ts), so "show it again" is not a feature that was left out — the
 * server holds nothing to show. Rotating issues a new one.
 */

import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Webhook, WebhookDelivery } from "../../db/models";
import { ApiError } from "../../http/errors";
import { handler, noStore, requireAgent, selfWallet } from "../../http/middleware";
import { assertSafeWebhookTarget, SsrfError, MAX_WEBHOOK_URL_LENGTH } from "../../webhooks/ssrf";
import { deriveWebhookSecret, SIGNATURE_TOLERANCE_SECONDS } from "../../webhooks/signing";
import { WEBHOOK_EVENTS, isWebhookEvent } from "../../webhooks/emitter";

/** A wallet may not register an unbounded number of endpoints. */
const MAX_WEBHOOKS_PER_WALLET = 10;

const RegisterBody = z.object({
  url: z.string().max(MAX_WEBHOOK_URL_LENGTH),
  events: z.array(z.string().max(64)).min(1).max(WEBHOOK_EVENTS.length),
});

/** The public shape. Never includes the secret, and never another wallet's rows. */
function view(w: Record<string, never> & Record<string, unknown>): Record<string, unknown> {
  return {
    webhookId: w.webhookId,
    url: w.url,
    events: w.events,
    active: w.active,
    secretPrefix: w.secretPrefix,
    secretVersion: w.secretVersion ?? 1,
    createdAt: w.createdAt,
    lastDeliveryAt: w.lastDeliveryAt,
    failureCount: w.failureCount,
  };
}

const SIGNING_GUIDANCE = {
  algorithm: "HMAC-SHA256",
  header: "x-aic-signature",
  format: "v1,t=<unixSeconds>,s=<hexMac>",
  signedString: "v1.<timestamp>.<rawRequestBody>",
  toleranceSeconds: SIGNATURE_TOLERANCE_SECONDS,
  verify: [
    "Read the RAW request body before any JSON parsing or re-serialization.",
    "Reject the delivery if |now - t| exceeds the tolerance; that is the replay defence.",
    "Recompute HMAC-SHA256 over `v1.<t>.<rawBody>` with your secret and compare in constant time.",
    "Deduplicate on x-aic-event-id: a delivery may legitimately arrive more than once.",
  ],
  notAuthoritative:
    "A webhook is a notification, never authority. Never require one to arrive for funds, claims " +
    "or store state to be correct; recover missed events from the cursor APIs.",
};

export function webhooksRouter(): Router {
  const router = Router();

  /** Register an endpoint. The secret is returned here and nowhere else, ever. */
  router.post(
    "/webhooks",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const parsed = RegisterBody.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid webhook", { issues: parsed.error.issues });

      const unknown = parsed.data.events.filter((e) => !isWebhookEvent(e));
      if (unknown.length > 0) {
        throw ApiError.invalid("Unknown webhook event type", {
          unknown,
          supported: [...WEBHOOK_EVENTS],
        });
      }
      const events = [...new Set(parsed.data.events)];

      const wallet = selfWallet(req);
      const existing = await Webhook.countDocuments({ walletAddress: wallet.toLowerCase() });
      if (existing >= MAX_WEBHOOKS_PER_WALLET) {
        throw new ApiError(
          "FORBIDDEN",
          `A wallet may register at most ${MAX_WEBHOOKS_PER_WALLET} webhooks. Delete one first.`,
          403,
          { limit: MAX_WEBHOOKS_PER_WALLET }
        );
      }

      // Validated here AND again before every delivery: registration-time validation alone is
      // defeated by DNS rebinding.
      let target;
      try {
        target = await assertSafeWebhookTarget(parsed.data.url, {
          allowPrivate: req.ctx.env.ESH_ENVIRONMENT === "LOCAL",
        });
      } catch (error) {
        if (error instanceof SsrfError) {
          throw ApiError.invalid(error.message, {
            reason: error.reason,
            policy:
              "Private, loopback, link-local, unique-local and cloud metadata destinations are " +
              "rejected, and the destination is re-checked before every delivery.",
          });
        }
        throw error;
      }

      const webhookId = `wh_${crypto.randomBytes(12).toString("hex")}`;
      const derived = deriveWebhookSecret(req.ctx.env.API_KEY_PEPPER, webhookId, 1);

      await Webhook.create({
        webhookId,
        walletAddress: wallet.toLowerCase(),
        url: target.url.toString(),
        events,
        secretHash: derived.secretHash,
        secretPrefix: derived.secretPrefix,
        secretVersion: 1,
        active: true,
      });

      res.status(201).json({
        webhook: view({ webhookId, url: target.url.toString(), events, active: true, secretPrefix: derived.secretPrefix, secretVersion: 1, createdAt: new Date(), lastDeliveryAt: null, failureCount: 0 } as never),
        secret: derived.secret,
        secretShownOnce:
          "Store this now. It is derived from a key held only in server configuration and is " +
          "never returned again; rotate to obtain a new one.",
        signing: SIGNING_GUIDANCE,
      });
    })
  );

  /** The calling wallet's own subscriptions. */
  router.get(
    "/webhooks",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const rows = await Webhook.find({ walletAddress: wallet.toLowerCase() }).sort({ createdAt: -1 }).lean();
      res.json({
        items: rows.map((r) => view(r as never)),
        supportedEvents: [...WEBHOOK_EVENTS],
        signing: SIGNING_GUIDANCE,
        limit: MAX_WEBHOOKS_PER_WALLET,
      });
    })
  );

  /** Recent delivery attempts for one subscription, so an Agent can debug its own receiver. */
  router.get(
    "/webhooks/:webhookId/deliveries",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const hook = await Webhook.findOne({
        webhookId: req.params.webhookId,
        walletAddress: wallet.toLowerCase(),
      }).lean();
      if (!hook) throw ApiError.notFound("Webhook");

      const rows = await WebhookDelivery.find({ webhookId: hook.webhookId })
        .sort({ _id: -1 })
        .limit(50)
        .lean();

      res.json({
        webhookId: hook.webhookId,
        items: rows.map((d) => ({
          eventId: d.eventId,
          eventType: d.eventType,
          status: d.status,
          attempts: d.attempts,
          nextAttemptAt: d.nextAttemptAt,
          lastError: d.lastError,
        })),
        note:
          "A `dead` delivery was abandoned after the retry budget. Nothing is lost: every event " +
          "here is recoverable from the cursor APIs, which remain the authority.",
      });
    })
  );

  /** Rotate the signing secret. The old one stops verifying immediately. */
  router.post(
    "/webhooks/:webhookId/rotate",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const hook = await Webhook.findOne({
        webhookId: req.params.webhookId,
        walletAddress: wallet.toLowerCase(),
      }).lean();
      if (!hook) throw ApiError.notFound("Webhook");

      const version = (hook.secretVersion ?? 1) + 1;
      const derived = deriveWebhookSecret(req.ctx.env.API_KEY_PEPPER, hook.webhookId, version);
      await Webhook.updateOne(
        { webhookId: hook.webhookId },
        { $set: { secretVersion: version, secretHash: derived.secretHash, secretPrefix: derived.secretPrefix } }
      );

      res.status(201).json({
        webhookId: hook.webhookId,
        secret: derived.secret,
        secretVersion: version,
        secretShownOnce: "Store this now. The previous secret stops verifying immediately.",
        signing: SIGNING_GUIDANCE,
      });
    })
  );

  /** Delete a subscription. Pending deliveries for it are abandoned, not retried. */
  router.delete(
    "/webhooks/:webhookId",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const result = await Webhook.deleteOne({
        webhookId: req.params.webhookId,
        walletAddress: wallet.toLowerCase(),
      });
      if (result.deletedCount === 0) throw ApiError.notFound("Webhook");

      await WebhookDelivery.updateMany(
        { webhookId: req.params.webhookId, status: "pending" },
        { $set: { status: "dead", lastError: "subscription deleted" } }
      );
      res.status(204).end();
    })
  );

  return router;
}
