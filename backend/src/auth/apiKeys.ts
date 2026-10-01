/**
 * API key lifecycle.
 *
 * Canonical state machine (MASTER_PLAN 0.27.A):
 *
 *     NO_KEY  --signed ISSUE-->  ACTIVE_KEY
 *     ACTIVE  --signed ROTATE--> NEW_ACTIVE_KEY (old revoked atomically)
 *     ACTIVE  --signed REVOKE--> NO_KEY
 *
 * `ISSUE` while an active key exists returns a deterministic conflict and NEVER silently
 * rotates, which is what stops key issuance from becoming a rotation denial of service
 * (0.27.D). Replacement requires a separately signed ROTATE challenge.
 *
 * The raw secret is returned exactly once and is never recoverable afterwards. Only a
 * peppered SHA-512 digest and a display prefix are stored (0.27.A). An API key authenticates
 * API access; it is never wallet authority and can never sign a transaction (0.27.E).
 */

import crypto from "node:crypto";
import { getAddress } from "ethers";
import { AgentAccount } from "../db/models";

const KEY_PREFIX = "aic_live_";
const SECRET_BYTES = 32;

export class ApiKeyError extends Error {
  constructor(
    readonly code:
      | "ACTIVE_KEY_EXISTS"
      | "NO_ACTIVE_KEY"
      | "INVALID_API_KEY"
      | "API_KEY_REVOKED",
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "ApiKeyError";
  }
}

export interface IssuedApiKey {
  /** Shown exactly once. Never stored, never logged, never recoverable. */
  apiKey: string;
  apiKeyPrefix: string;
  wallet: string;
  issuedAt: string;
}

export interface ApiKeyStatus {
  wallet: string;
  status: "NO_KEY" | "ACTIVE" | "REVOKED";
  apiKeyPrefix: string | null;
  issuedAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotationCount: number;
}

function generateSecret(): { raw: string; prefix: string } {
  const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const raw = `${KEY_PREFIX}${secret}`;
  return { raw, prefix: raw.slice(0, KEY_PREFIX.length + 8) };
}

/**
 * Peppered digest. The pepper lives only in process memory, so a database dump alone is not
 * enough to brute force a key. SHA-512 over 256 bits of CSPRNG entropy needs no key
 * stretching: there is no low-entropy human secret to protect here, and a slow KDF on the
 * authentication hot path would be a self-inflicted denial of service.
 */
export function hashApiKey(rawKey: string, pepper: string): string {
  return crypto.createHmac("sha512", pepper).update(rawKey, "utf8").digest("hex");
}

export async function getStatus(wallet: string, chainId: number): Promise<ApiKeyStatus> {
  const address = getAddress(wallet);
  const account = await AgentAccount.findOne({
    walletAddress: address.toLowerCase(),
    chainId,
  }).lean();

  if (!account) {
    return {
      wallet: address,
      status: "NO_KEY",
      apiKeyPrefix: null,
      issuedAt: null,
      lastUsedAt: null,
      revokedAt: null,
      rotationCount: 0,
    };
  }

  return {
    wallet: address,
    status: account.status,
    apiKeyPrefix: account.apiKeyPrefix ?? null,
    issuedAt: account.issuedAt?.toISOString() ?? null,
    lastUsedAt: account.lastUsedAt?.toISOString() ?? null,
    revokedAt: account.revokedAt?.toISOString() ?? null,
    rotationCount: account.rotationCount,
  };
}

/**
 * Issues the first key for a wallet. Refuses if an active key already exists.
 *
 * Crash safety: the raw key is generated in memory, the digest is committed, and only then is
 * the raw key returned. If the process dies between the commit and the HTTP response, the
 * Agent simply never learns the secret and recovers by signing a ROTATE challenge. There is
 * never a second retrievable copy of the secret anywhere. [0.27.A]
 */
export async function issueApiKey(wallet: string, chainId: number, pepper: string): Promise<IssuedApiKey> {
  const address = getAddress(wallet);
  const lower = address.toLowerCase();

  const existing = await AgentAccount.findOne({ walletAddress: lower, chainId }).lean();
  if (existing && existing.status === "ACTIVE") {
    throw new ApiKeyError(
      "ACTIVE_KEY_EXISTS",
      "This wallet already has an active API key. Sign a ROTATE_API_KEY challenge to replace it."
    );
  }

  const { raw, prefix } = generateSecret();
  const now = new Date();

  await AgentAccount.updateOne(
    { walletAddress: lower, chainId },
    {
      $set: {
        walletAddress: lower,
        chainId,
        apiKeyHash: hashApiKey(raw, pepper),
        apiKeyPrefix: prefix,
        status: "ACTIVE",
        issuedAt: now,
        revokedAt: null,
      },
    },
    { upsert: true }
  );

  return { apiKey: raw, apiKeyPrefix: prefix, wallet: address, issuedAt: now.toISOString() };
}

/** Replaces an active key atomically. The previous key stops working in the same write. */
export async function rotateApiKey(wallet: string, chainId: number, pepper: string): Promise<IssuedApiKey> {
  const address = getAddress(wallet);
  const lower = address.toLowerCase();

  const { raw, prefix } = generateSecret();
  const now = new Date();

  const updated = await AgentAccount.findOneAndUpdate(
    { walletAddress: lower, chainId },
    {
      $set: {
        apiKeyHash: hashApiKey(raw, pepper),
        apiKeyPrefix: prefix,
        status: "ACTIVE",
        issuedAt: now,
        revokedAt: null,
      },
      $inc: { rotationCount: 1 },
      $setOnInsert: { walletAddress: lower, chainId },
    },
    { new: true, upsert: true }
  );
  if (!updated) throw new ApiKeyError("NO_ACTIVE_KEY", "No account for this wallet", 404);

  return { apiKey: raw, apiKeyPrefix: prefix, wallet: address, issuedAt: now.toISOString() };
}

export async function revokeApiKey(wallet: string, chainId: number): Promise<ApiKeyStatus> {
  const address = getAddress(wallet);
  const lower = address.toLowerCase();

  /*
   * The hash is REMOVED, not set to null. The unique index on apiKeyHash is sparse, and a sparse
   * index still indexes an explicit null — so the first revoked account held the one allowed null
   * and every later revoke, for any wallet, failed with a duplicate-key 500. Any null already
   * stored is cleared first, so the record that got there before this fix cannot block the next.
   */
  await AgentAccount.updateMany({ apiKeyHash: null, status: { $ne: "ACTIVE" } }, { $unset: { apiKeyHash: "" } });
  const updated = await AgentAccount.findOneAndUpdate(
    { walletAddress: lower, chainId, status: "ACTIVE" },
    { $set: { status: "REVOKED", revokedAt: new Date() }, $unset: { apiKeyHash: "" } },
    { new: true }
  );
  if (!updated) throw new ApiKeyError("NO_ACTIVE_KEY", "This wallet has no active API key", 404);

  return getStatus(address, chainId);
}

export interface AuthenticatedAgent {
  wallet: string;
  apiKeyPrefix: string;
  chainId: number;
  /** When the key was issued; site updates older than this are not news to its holder. */
  issuedAt: Date | null;
  updatesReadAt: Date | null;
}

/**
 * Resolves a bearer key to its wallet. Lookup is by digest, so the plaintext key never has to
 * be compared against anything and never needs to exist in the database.
 */
export async function authenticate(
  rawKey: string,
  chainId: number,
  pepper: string
): Promise<AuthenticatedAgent> {
  if (!rawKey.startsWith(KEY_PREFIX)) {
    throw new ApiKeyError("INVALID_API_KEY", "Malformed API key", 401);
  }

  const digest = hashApiKey(rawKey, pepper);
  const account = await AgentAccount.findOne({ apiKeyHash: digest, chainId }).lean();
  if (!account) throw new ApiKeyError("INVALID_API_KEY", "Unknown API key", 401);
  if (account.status !== "ACTIVE") throw new ApiKeyError("API_KEY_REVOKED", "API key revoked", 401);

  // Fire and forget: last-used tracking must never add latency or fail a request.
  void AgentAccount.updateOne({ _id: account._id }, { $set: { lastUsedAt: new Date() } }).catch(
    () => undefined
  );

  return {
    wallet: getAddress(account.walletAddress),
    apiKeyPrefix: account.apiKeyPrefix ?? "",
    chainId,
    issuedAt: account.issuedAt ?? null,
    updatesReadAt: (account as { updatesReadAt?: Date | null }).updatesReadAt ?? null,
  };
}
