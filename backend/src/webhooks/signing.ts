/**
 * Webhook secrets and delivery signatures.
 *
 * The contract published in the Agent schema is "HMAC-SHA256 over the raw body with your webhook
 * secret".
 *
 * The secret is DERIVED, not stored. `secret = HMAC(masterKey, webhookId:version)`, so the server
 * can always recompute the key it needs to sign with, while the database holds no value that
 * could be used to forge a delivery. Hashing the secret instead — the reflex, and what this file
 * did first — is wrong here: the sender must reproduce the key, not merely recognise it, so a
 * one-way hash would leave the worker unable to sign at all. Storing it reversibly would work but
 * puts a forgery key in every backup.
 *
 * Two further properties make the signature worth checking:
 *
 *  - the signed string includes a timestamp, so a captured delivery cannot be replayed a week
 *    later against a receiver that only checks the body signature;
 *  - the signature covers the RAW body bytes, not a re-serialization. A receiver that re-encodes
 *    JSON before verifying will get a different byte string and, correctly, fail.
 */

import crypto from "node:crypto";

export const SIGNATURE_VERSION = "v1";
/** Deliveries older than this must be rejected by the receiver as replays. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface DerivedSecret {
  /** Returned to the Agent exactly once at registration, then never again. */
  secret: string;
  /** Stored for audit only. Knowing it does not allow forging a delivery. */
  secretHash: string;
  /** Stored and displayed, so an Agent can tell two registrations apart without the secret. */
  secretPrefix: string;
}

/**
 * Deterministically derives the signing secret for a webhook.
 *
 * Deterministic on purpose: the worker recomputes it on every delivery, so nothing usable for
 * forgery is ever written to the database. `masterKey` lives in configuration, never in Mongo.
 * Bumping `version` rotates the secret without changing the webhook id.
 */
export function deriveWebhookSecret(masterKey: string, webhookId: string, version = 1): DerivedSecret {
  const material = crypto
    .createHmac("sha256", masterKey)
    .update(`aic-webhook-secret:v${version}:${webhookId}`)
    .digest();
  const secret = `whsec_${material.toString("base64url")}`;
  return {
    secret,
    // A plain digest of the derived secret, recorded so an operator can confirm which secret a
    // subscription is using without that record being enough to produce one.
    secretHash: crypto.createHash("sha256").update(secret).digest("hex"),
    secretPrefix: secret.slice(0, 16),
  };
}

export interface DeliverySignature {
  timestamp: number;
  header: string;
}

/**
 * Signs a raw body.
 *
 * The signed string is `<version>.<timestamp>.<rawBody>` so that neither the timestamp nor the
 * version can be changed without invalidating the signature. Both are echoed in the header, so a
 * receiver reconstructs exactly what was signed without guessing.
 */
export function signDelivery(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): DeliverySignature {
  const signed = `${SIGNATURE_VERSION}.${timestamp}.${rawBody}`;
  const mac = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  return { timestamp, header: `${SIGNATURE_VERSION},t=${timestamp},s=${mac}` };
}

/**
 * Reference verification, published in the docs so a receiver has a correct implementation to
 * copy rather than one to invent. Also used by the tests, so the documented algorithm is the one
 * that is actually exercised.
 */
export function verifyDelivery(
  rawBody: string,
  header: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  const match = /^v1,t=(\d+),s=([0-9a-f]{64})$/.exec(header ?? "");
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${SIGNATURE_VERSION}.${timestamp}.${rawBody}`)
    .digest();
  const provided = Buffer.from(match[2]!, "hex");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}
