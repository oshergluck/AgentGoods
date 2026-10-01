/**
 * The service gateway: everything between "a buyer wants to call this service" and "the result".
 *
 * Payment is the existing commerce path, unchanged. A SERVICE is a product in a Sales store whose
 * listing commits a service spec; buying N units of it on chain (AICStoreSales.purchase) buys N
 * prepaid calls, settled exactly like any purchase — protocol fee, controller proceeds, the holders'
 * share spent on buying back and burning the store's AIC. Nothing here moves money or trusts a
 * seller's word about revenue: a call can start only against units the chain says the caller bought.
 *
 * A call spends one prepaid unit only when it SUCCEEDS. A failed or timed-out call releases its
 * reservation, so a paid unit is never lost to a result that was never delivered.
 *
 * Seller code is never executed in this process: it is sent, with the caller's input and nothing
 * else, to the service runner (service-runner/), a separate deployment with no secrets.
 */
import crypto from "node:crypto";
import { keccak256, toUtf8Bytes } from "ethers";
import { AccessSession, License, ProductContent, ServiceCall, ServiceCredit, ServiceSpec } from "../db/models";
import { decryptContent } from "../access/content";
import { ApiError } from "../http/errors";
import type { Env } from "../config/env";
import { checkSchema, type JsonSchema } from "./jsonSchema";

export const SERVICE_LIMITS = {
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 64 * 1024,
  timeoutMs: 10_000,
  memoryBytes: 32 * 1024 * 1024,
  maxCodeBytes: 200 * 1024,
};

/** Canonical JSON: keys sorted at every level, so the same spec always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function specHashOf(inputSchema: unknown, outputSchema: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson({ inputSchema, outputSchema }))).toLowerCase();
}

/** Checks a seller's spec; throws a refusal naming every problem. */
export function checkServiceSpec(spec: { inputSchema: unknown; outputSchema: unknown }): void {
  const problems = [
    ...checkSchema(spec.inputSchema).map((p) => `service.inputSchema ${p}`),
    ...checkSchema(spec.outputSchema).map((p) => `service.outputSchema ${p}`),
  ];
  if (problems.length > 0) {
    throw ApiError.invalid(`The service spec is not usable: ${problems.join("; ")}.`, {
      issues: problems.map((message) => ({ path: ["service"], message })),
      remedy:
        "Describe input and output with the supported JSON Schema subset: type, properties, required, " +
        "additionalProperties (true/false), items, enum, const, minimum, maximum, minLength, maxLength, minItems, " +
        "maxItems, description. `pattern` is not supported.",
    });
  }
}

export async function saveServiceSpec(
  chainId: number,
  storeId: string,
  spec: { inputSchema: JsonSchema; outputSchema: JsonSchema }
): Promise<string> {
  const specHash = specHashOf(spec.inputSchema, spec.outputSchema);
  await ServiceSpec.updateOne(
    { chainId, specHash },
    { $setOnInsert: { chainId, specHash, storeId, inputSchema: spec.inputSchema, outputSchema: spec.outputSchema } },
    { upsert: true }
  );
  return specHash;
}

export async function loadServiceSpec(chainId: number, specHash: string | null | undefined) {
  if (!specHash) return null;
  return ServiceSpec.findOne({ chainId, specHash: specHash.toLowerCase() }).lean();
}

/* ------------------------------------------------------------------ runner */

export type RunnerResult =
  | { ok: true; output: unknown; outputBytes: number; ms: number }
  | { ok: false; code: string; message: string; ms: number };

export function runnerConfigured(env: Env): boolean {
  return Boolean(env.SERVICE_RUNNER_URL && env.SERVICE_RUNNER_TOKEN);
}

export async function runOnRunner(env: Env, code: string, input: unknown): Promise<RunnerResult> {
  if (!runnerConfigured(env)) {
    throw new ApiError(
      "SERVICE_RUNNER_UNAVAILABLE",
      "Hosted services cannot run on this deployment right now: no service runner is configured. Nothing was charged.",
      503,
      { retry: "Try again later with the same Idempotency-Key; your prepaid calls are untouched." }
    );
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVICE_LIMITS.timeoutMs + 8_000);
  try {
    const res = await fetch(`${env.SERVICE_RUNNER_URL!.replace(/\/+$/, "")}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.SERVICE_RUNNER_TOKEN}` },
      body: JSON.stringify({
        code,
        input,
        timeoutMs: SERVICE_LIMITS.timeoutMs,
        memoryBytes: SERVICE_LIMITS.memoryBytes,
        maxOutputBytes: SERVICE_LIMITS.maxOutputBytes,
      }),
      signal: controller.signal,
    });
    if (res.status === 429) return { ok: false, code: "RUNNER_BUSY", message: "The runner is at capacity.", ms: Date.now() - started };
    if (!res.ok) return { ok: false, code: "RUNNER_ERROR", message: `The runner answered ${res.status}.`, ms: Date.now() - started };
    const body = (await res.json()) as RunnerResult;
    return { ...body, ms: typeof body.ms === "number" ? body.ms : Date.now() - started } as RunnerResult;
  } catch {
    return { ok: false, code: "RUNNER_UNREACHABLE", message: "The runner did not answer in time.", ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** The service's committed code, decrypted for the runner only. Never returned to a caller. */
export async function loadServiceCode(env: Env, chainId: number, storeId: string, contentHash: string): Promise<string> {
  const stored = await ProductContent.findOne({ chainId, storeId, contentHash: contentHash.toLowerCase() }).lean();
  if (!stored) {
    throw new ApiError(
      "PRODUCT_UNAVAILABLE",
      "The seller has not uploaded code matching the hash this service commits on chain. Nothing was charged.",
      409,
      { contentHash }
    );
  }
  return decryptContent(stored.blob, env.CONTENT_ENCRYPTION_KEY, storeId, contentHash).toString("utf8");
}

/* ------------------------------------------------------------------ credits */

/** Re-reads what the chain says this caller bought, then returns the credit row. */
export async function syncCredits(chainId: number, storeId: string, productId: string, caller: string) {
  const who = caller.toLowerCase();
  const licenses = await License.find({ chainId, storeId, productId, owner: who, kind: "permanent" })
    .select({ quantity: 1 })
    .lean();
  const purchased = licenses.reduce((sum, l) => sum + Number(l.quantity ?? 0), 0);
  return ServiceCredit.findOneAndUpdate(
    { chainId, storeId, productId, caller: who },
    { $max: { purchased }, $setOnInsert: { consumed: 0, reserved: 0 } },
    { upsert: true, new: true }
  ).lean();
}

/** Reserves one prepaid call atomically, or returns null when none is left. */
export async function reserveCredit(chainId: number, storeId: string, productId: string, caller: string) {
  return ServiceCredit.findOneAndUpdate(
    {
      chainId,
      storeId,
      productId,
      caller: caller.toLowerCase(),
      $expr: { $gte: [{ $subtract: ["$purchased", { $add: ["$consumed", "$reserved"] }] }, 1] },
    },
    { $inc: { reserved: 1 } },
    { new: true }
  ).lean();
}

export async function settleCredit(chainId: number, storeId: string, productId: string, caller: string, succeeded: boolean) {
  await ServiceCredit.updateOne(
    { chainId, storeId, productId, caller: caller.toLowerCase() },
    succeeded ? { $inc: { reserved: -1, consumed: 1 } } : { $inc: { reserved: -1 } }
  );
}

export const creditsLeft = (c: { purchased?: number; consumed?: number; reserved?: number } | null | undefined) =>
  Math.max(Number(c?.purchased ?? 0) - Number(c?.consumed ?? 0) - Number(c?.reserved ?? 0), 0);

/**
 * The license whose prepaid call a successful invocation spent: the oldest one with units left.
 * The first successful call on a license is recorded as a delivery, so the buyer can rate it.
 */
export async function assignLicense(chainId: number, storeId: string, productId: string, caller: string) {
  const who = caller.toLowerCase();
  const licenses = await License.find({ chainId, storeId, productId, owner: who, kind: "permanent" })
    .sort({ blockNumber: 1, logIndex: 1 })
    .select({ licenseToken: 1, tokenId: 1, quantity: 1 })
    .lean();
  const spent = await ServiceCall.aggregate([
    { $match: { chainId, storeId, productId, caller: who, state: "SUCCEEDED", licenseId: { $ne: null } } },
    { $group: { _id: { t: "$licenseToken", i: "$licenseId" }, n: { $sum: 1 } } },
  ]);
  const used = new Map(spent.map((s) => [`${s._id.t}:${s._id.i}`, Number(s.n)]));
  const lic = licenses.find((l) => (used.get(`${l.licenseToken}:${l.tokenId}`) ?? 0) < Number(l.quantity ?? 0)) ?? licenses[licenses.length - 1];
  return lic ? { licenseToken: lic.licenseToken, licenseId: String(lic.tokenId) } : null;
}

export async function recordServiceDelivery(
  chainId: number,
  storeId: string,
  productId: string,
  caller: string,
  license: { licenseToken: string; licenseId: string },
  contentHash: string
) {
  const exists = await AccessSession.exists({ licenseToken: license.licenseToken, licenseId: license.licenseId, deliveryType: "api" });
  if (exists) return;
  const now = new Date();
  await AccessSession.create({
    sessionId: `svc_${crypto.randomBytes(18).toString("base64url")}`,
    walletAddress: caller.toLowerCase(),
    storeId,
    licenseToken: license.licenseToken,
    licenseId: license.licenseId,
    productId,
    contentHash,
    deliveryType: "api",
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 7 * 24 * 3600_000),
    redeemedAt: now,
    attestationStatus: "pending",
  });
  void chainId;
}

export function inputHashOf(input: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson(input ?? null))).toLowerCase();
}
