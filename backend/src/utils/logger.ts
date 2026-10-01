/**
 * Structured logging with mandatory redaction.
 *
 * MASTER_PLAN 0.25.AD: production logs redact bearer tokens, signatures where sensitive,
 * nonces after use, PII and signed URLs. §22 adds: never log secrets or full API keys.
 * Redaction lives here, in one place, so no route can forget it.
 */

import pino from "pino";

const REDACTED = "[redacted]";

/**
 * Field paths scrubbed from every log record. The list is deliberately broad: a field that
 * is merely suspicious is cheaper to redact than to leak.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "res.headers['set-cookie']",
  "apiKey",
  "api_key",
  "rawKey",
  "secret",
  "webhookSecret",
  "privateKey",
  "seed",
  "mnemonic",
  "signature",
  "signedUrl",
  "password",
  "email",
  "phone",
  "moltbookApiKey",
  "MOLTBOOK_API_KEY",
  "openaiApiKey",
  "OPENAI_API_KEY",
  "*.apiKey",
  "*.secret",
  "*.privateKey",
  "*.signature",
  "*.signedUrl",
  "*.moltbookApiKey",
  "*.openaiApiKey",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: REDACT_PATHS, censor: REDACTED },
  base: { service: "aic-backend" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Safe rendering of an API key for logs and responses: prefix only, never the secret. */
export function keyPrefixOnly(rawKey: string): string {
  const parts = rawKey.split("_");
  if (parts.length < 3) return REDACTED;
  return `${parts[0]}_${parts[1]}_${parts[2].slice(0, 6)}`;
}

/** Strips anything that looks like a secret out of an arbitrary object before logging. */
export function scrub<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(scrub) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/key|secret|token|password|signature|seed|mnemonic|authorization/i.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = scrub(v);
    }
  }
  return out as T;
}
