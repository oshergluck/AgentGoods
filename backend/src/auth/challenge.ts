/**
 * Wallet-signature challenges.
 *
 * MASTER_PLAN 0.25.X: nonce domains are separated, and no signature for one purpose can be
 * replayed for another. Every challenge binds purpose, chainId, wallet, nonce, issuedAt and
 * expiry, and the origin where appropriate.
 *
 * MASTER_PLAN 0.27.B: a nonce is consumed exactly once. Two concurrent submissions of the
 * same signed challenge produce at most one successful state transition, enforced by an
 * atomic conditional update on a uniquely indexed row, not by a read-then-write.
 *
 * MASTER_PLAN 0.23: the signed message must not bind economic validity to the temporary
 * Railway hostname. The origin is recorded for web-session hygiene only and is deliberately
 * absent from the Agent flows, so moving from the Railway domain to the final custom domain
 * invalidates nothing.
 */

import crypto from "node:crypto";
import { verifyMessage, getAddress } from "ethers";
import { AuthChallenge } from "../db/models";

export const PURPOSES = [
  "ISSUE_API_KEY",
  "ROTATE_API_KEY",
  "REVOKE_API_KEY",
  "HUMAN_LOGIN",
  "STORE_ADMIN",
] as const;

export type ChallengePurpose = (typeof PURPOSES)[number];

export interface IssuedChallenge {
  nonce: string;
  purpose: ChallengePurpose;
  wallet: string;
  chainId: number;
  issuedAt: string;
  expiresAt: string;
  /** The exact string the wallet must sign, byte for byte. */
  message: string;
}

export class ChallengeError extends Error {
  constructor(
    readonly code:
      | "CHALLENGE_NOT_FOUND"
      | "CHALLENGE_EXPIRED"
      | "CHALLENGE_ALREADY_USED"
      | "SIGNATURE_INVALID"
      | "WALLET_MISMATCH"
      | "PURPOSE_MISMATCH"
      | "CHAIN_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "ChallengeError";
  }
}

/**
 * The canonical signing payload. It is deliberately human-readable so a person signing in a
 * wallet UI can see exactly what they are authorising, and it contains the purpose in plain
 * text so a signature captured for one purpose is visibly wrong for another.
 */
export function buildChallengeMessage(input: {
  purpose: ChallengePurpose;
  wallet: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  origin?: string | null;
}): string {
  const lines = [
    "AIC Agent Marketplace",
    "",
    `Purpose: ${input.purpose}`,
    `Wallet: ${getAddress(input.wallet)}`,
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expires At: ${input.expiresAt}`,
  ];
  if (input.origin) lines.push(`Origin: ${input.origin}`);
  lines.push(
    "",
    "Signing this proves you control this wallet.",
    "It does NOT authorise any transfer of USDC, AIC or any other asset."
  );
  return lines.join("\n");
}

export interface CreateChallengeOptions {
  purpose: ChallengePurpose;
  wallet: string;
  chainId: number;
  ttlSeconds: number;
  origin?: string | null;
}

export async function createChallenge(options: CreateChallengeOptions): Promise<IssuedChallenge> {
  const wallet = getAddress(options.wallet);
  const nonce = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + options.ttlSeconds * 1000);

  const issuedAt = now.toISOString();
  const expiresAt = expires.toISOString();

  await AuthChallenge.create({
    nonce,
    purpose: options.purpose,
    walletAddress: wallet.toLowerCase(),
    chainId: options.chainId,
    origin: options.origin ?? null,
    issuedAt: now,
    expiresAt: expires,
    consumedAt: null,
  });

  return {
    nonce,
    purpose: options.purpose,
    wallet,
    chainId: options.chainId,
    issuedAt,
    expiresAt,
    message: buildChallengeMessage({
      purpose: options.purpose,
      wallet,
      chainId: options.chainId,
      nonce,
      issuedAt,
      expiresAt,
      origin: options.origin ?? null,
    }),
  };
}

export interface ConsumeChallengeOptions {
  nonce: string;
  signature: string;
  purpose: ChallengePurpose;
  chainId: number;
}

export interface ConsumedChallenge {
  wallet: string;
  purpose: ChallengePurpose;
  chainId: number;
}

/**
 * Verifies a signature against a challenge and consumes the nonce atomically.
 *
 * The consumption uses `findOneAndUpdate` with `consumedAt: null` in the filter, so under
 * concurrent submissions exactly one caller wins and every other caller sees
 * CHALLENGE_ALREADY_USED. Signature verification happens BEFORE consumption so an invalid
 * signature cannot burn a legitimate nonce.
 */
export async function consumeChallenge(options: ConsumeChallengeOptions): Promise<ConsumedChallenge> {
  const record = await AuthChallenge.findOne({ nonce: options.nonce }).lean();
  if (!record) throw new ChallengeError("CHALLENGE_NOT_FOUND", "No such challenge");
  if (record.consumedAt) throw new ChallengeError("CHALLENGE_ALREADY_USED", "Challenge already consumed");
  if (record.expiresAt.getTime() < Date.now()) {
    throw new ChallengeError("CHALLENGE_EXPIRED", "Challenge expired");
  }
  if (record.purpose !== options.purpose) {
    throw new ChallengeError(
      "PURPOSE_MISMATCH",
      `Challenge was issued for ${record.purpose}, not ${options.purpose}`
    );
  }
  if (record.chainId !== options.chainId) {
    throw new ChallengeError("CHAIN_MISMATCH", "Challenge was issued for a different chain");
  }

  const message = buildChallengeMessage({
    purpose: record.purpose as ChallengePurpose,
    wallet: record.walletAddress,
    chainId: record.chainId,
    nonce: record.nonce,
    issuedAt: record.issuedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    origin: record.origin,
  });

  let recovered: string;
  try {
    recovered = verifyMessage(message, options.signature);
  } catch {
    throw new ChallengeError("SIGNATURE_INVALID", "Signature could not be verified");
  }

  if (recovered.toLowerCase() !== record.walletAddress.toLowerCase()) {
    throw new ChallengeError("WALLET_MISMATCH", "Signature does not match the challenge wallet");
  }

  const consumed = await AuthChallenge.findOneAndUpdate(
    { nonce: options.nonce, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { new: true }
  );
  if (!consumed) {
    throw new ChallengeError("CHALLENGE_ALREADY_USED", "Challenge already consumed");
  }

  return {
    wallet: getAddress(record.walletAddress),
    purpose: record.purpose as ChallengePurpose,
    chainId: record.chainId,
  };
}
