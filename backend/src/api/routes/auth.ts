/**
 * Wallet authentication and API-key routes.
 *
 * MASTER_PLAN 0.27.M: the human UI and the autonomous Agent flow share ONE backend. There is
 * no separate, weaker code path for browser issuance; only the presentation differs.
 *
 * MASTER_PLAN 0.26.B: an Agent that controls an EOA can obtain its key entirely over HTTP
 * with no human visiting the website.
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import { AuthChallenge } from "../../db/models";
import { activeKeyRecovery } from "../../auth/recovery";
import { z } from "zod";
import { getAddress } from "ethers";
import { ApiError } from "../../http/errors";
import { handler, idempotent, limiter, noStore, requireAgent, selfWallet } from "../../http/middleware";
import { createChallenge, consumeChallenge, ChallengeError, type ChallengePurpose } from "../../auth/challenge";
import { getStatus, issueApiKey, revokeApiKey, rotateApiKey, ApiKeyError } from "../../auth/apiKeys";

const ChallengeBody = z.object({
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  purpose: z.enum(["ISSUE_API_KEY", "ROTATE_API_KEY", "REVOKE_API_KEY", "HUMAN_LOGIN", "STORE_ADMIN"]),
});

const SubmitBody = z.object({
  nonce: z.string().min(16),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

/** What was wrong with {nonce, signature}, in words, so a refusal names the field. */
function submitProblem(issues: { path: (string | number)[]; message: string }[]): string {
  const fields = issues.map((i) => String(i.path[0] ?? "body"));
  const parts: string[] = [];
  if (fields.includes("nonce")) parts.push("`nonce` must be the nonce string from POST /api/v1/auth/challenge");
  if (fields.includes("signature"))
    parts.push("`signature` must be the wallet's signature of the challenge `message`, exactly: 0x followed by 130 hex characters");
  if (parts.length === 0) parts.push('send {"nonce": "...", "signature": "0x..."} as a JSON body');
  return parts.join("; ") + ".";
}

/**
 * How to use the key, delivered WITH the key.
 *
 * The site returns a key once and keeps only its hash, so the moment it is issued is the one
 * moment every caller is certain to be reading. Agents issued a key, did not keep it, and asked
 * for another; the answer they then met (409, rotate) was correct but arrived too late to prevent
 * the loss. Every fact here is literally true of this deployment: the key is not stored in
 * recoverable form, the authenticated routes require it, and issuing again is refused while a key
 * is active.
 */
function apiKeyUsage(apiKey: string) {
  return {
    mustPersist: true,
    showOnce: true,
    doNotRequestAnotherIssueChallengeAfterSuccess: true,
    whyShowOnce: "Only a hash of the key is stored. It cannot be shown again or recovered.",
    requiredForMostAuthenticatedEndpoints: true,
    authorizationScheme: "Bearer",
    authorizationHeader: `Authorization: Bearer ${apiKey}`,
    requestNewKeyOnlyForIntentionalRotation: true,
    ifYouLoseIt:
      "Issuing again is refused (409 ACTIVE_KEY_EXISTS) while this key is active. Replacing it is a " +
      "rotation: POST /api/v1/auth/challenge with purpose ROTATE_API_KEY, sign, then POST " +
      "/api/v1/auth/api-key/rotate. Rotation revokes this key at once.",
  };
}

function mapAuthError(error: unknown, wallet: string | null = null): never {
  if (error instanceof ChallengeError) throw new ApiError(error.code, error.message, 400);
  if (error instanceof ApiKeyError && error.code === "ACTIVE_KEY_EXISTS") {
    throw new ApiError(
      "ACTIVE_KEY_EXISTS",
      "This wallet already has an active API key, and it cannot be shown again. If you still have " +
        "it, send it as `Authorization: Bearer <apiKey>`. If you lost it, do NOT issue again: rotate " +
        "(details.ifKeyLost.steps), persist the new key, then use it.",
      409,
      activeKeyRecovery(wallet)
    );
  }
  if (error instanceof ApiKeyError) throw new ApiError(error.code as never, error.message, error.status);
  throw error;
}

/**
 * Whose budget a key issuance spends.
 *
 * An issue/rotate/revoke body carries only the nonce of a challenge, not a wallet, so the limiter
 * used to fall back to the IP — and on the test network twenty agents behind one gateway shared
 * ten issuances a minute. By the operator's decision: on MAINNET the budget stays per IP (the real
 * defence against someone minting keys for many wallets); on every TEST network it is per wallet,
 * found from the challenge the nonce belongs to. Implemented by filling `wallet` in from the
 * challenge before the limiter runs; the handlers read only nonce and signature.
 */
function walletFromNonce(perWallet: boolean) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (perWallet) {
      const nonce = (req.body as { nonce?: unknown } | undefined)?.nonce;
      if (typeof nonce === "string" && nonce.length >= 16) {
        const ch = await AuthChallenge.findOne({ nonce }).select({ walletAddress: 1 }).lean().catch(() => null);
        if (ch?.walletAddress) (req.body as Record<string, unknown>).wallet = ch.walletAddress;
      }
    }
    next();
  };
}

/** Where a signed challenge of each purpose is completed. Named in the challenge response. */
const COMPLETE_ENDPOINT: Record<string, string> = {
  ISSUE_API_KEY: "/api/v1/auth/api-key/issue",
  ROTATE_API_KEY: "/api/v1/auth/api-key/rotate",
  REVOKE_API_KEY: "/api/v1/auth/api-key/revoke",
};

export function authRouter(challengePerMinute: number, keyOpsPerMinute: number, keyOpsPerWallet = false): Router {
  const router = Router();

  // Challenge issuance is unauthenticated but rate limited BY WALLET, not by IP, so several
  // Agents behind one egress address never throttle each other. [0.27.D, 0.27.S]
  const challengeLimiter = limiter(60_000, challengePerMinute, "auth challenge");
  const issueLimiter = [walletFromNonce(keyOpsPerWallet), limiter(60_000, keyOpsPerMinute, "api key issuance")];

  router.post(
    "/challenge",
    noStore,
    challengeLimiter,
    handler(async (req, res) => {
      const parsed = ChallengeBody.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid challenge request", { issues: parsed.error.issues });

      const origin = parsed.data.purpose === "HUMAN_LOGIN" ? req.header("origin") ?? null : null;
      const challenge = await createChallenge({
        purpose: parsed.data.purpose as ChallengePurpose,
        wallet: getAddress(parsed.data.wallet),
        chainId: req.ctx.env.CHAIN_ID,
        ttlSeconds: req.ctx.env.CHALLENGE_TTL_SECONDS,
        origin,
      });

      res.status(201).json({
        ...challenge,
        instructions:
          "Sign the `message` string exactly as given with the wallet named in it, using a " +
          "personal_sign / eth_sign style signature, then POST {nonce, signature} to " +
          (COMPLETE_ENDPOINT[parsed.data.purpose] ?? "the endpoint for this purpose") + ". " +
          "This signature proves wallet control only; it authorises no transfer.",
      });
    })
  );

  // Backwards-compatible aliases so an Agent can follow either documented shape.
  // (Kept for existing callers; not named in any document.)
  router.post("/api-key/challenge", noStore, challengeLimiter, handler(async (req, res) => {
    req.body = { ...(req.body ?? {}), purpose: (req.body as { purpose?: string })?.purpose ?? "ISSUE_API_KEY" };
    const parsed = ChallengeBody.safeParse(req.body);
    if (!parsed.success) throw ApiError.invalid("Invalid challenge request", { issues: parsed.error.issues });
    const challenge = await createChallenge({
      purpose: parsed.data.purpose as ChallengePurpose,
      wallet: getAddress(parsed.data.wallet),
      chainId: req.ctx.env.CHAIN_ID,
      ttlSeconds: req.ctx.env.CHALLENGE_TTL_SECONDS,
      origin: null,
    });
    res.status(201).json(challenge);
  }));

  /** ISSUE. Refuses when an active key exists; never silently rotates. [0.27.A] */
  router.post(
    "/api-key/issue",
    noStore,
    issueLimiter,
    handler(async (req, res) => {
      const parsed = SubmitBody.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid(`This issue was refused: ${submitProblem(parsed.error.issues)}`, { issues: parsed.error.issues });
      let walletForError: string | null = null;
      try {
        const consumed = await consumeChallenge({
          nonce: parsed.data.nonce,
          signature: parsed.data.signature,
          purpose: "ISSUE_API_KEY",
          chainId: req.ctx.env.CHAIN_ID,
        });
        walletForError = consumed.wallet;
        const issued = await issueApiKey(consumed.wallet, req.ctx.env.CHAIN_ID, req.ctx.env.API_KEY_PEPPER);
        res.status(201).json({
          ...issued,
          apiKeyUsage: apiKeyUsage(issued.apiKey),
          nextStep: { action: "PERSIST_API_KEY", then: "USE_API_KEY_FOR_AUTHENTICATED_REQUESTS" },
          shownOnce: true,
          warning:
            "This is the only time this key is shown. It cannot be recovered. It authenticates " +
            "API access only: it cannot sign blockchain transactions and has no authority over " +
            "your wallet funds. Never paste a private key or seed phrase anywhere.",
        });
      } catch (error) {
        mapAuthError(error, walletForError);
      }
    })
  );

  /** ROTATE. Requires its own separately signed purpose. [0.27.A, 0.27.D] */
  router.post(
    "/api-key/rotate",
    noStore,
    issueLimiter,
    handler(async (req, res) => {
      const parsed = SubmitBody.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid(`This rotate was refused: ${submitProblem(parsed.error.issues)}`, { issues: parsed.error.issues });
      try {
        const consumed = await consumeChallenge({
          nonce: parsed.data.nonce,
          signature: parsed.data.signature,
          purpose: "ROTATE_API_KEY",
          chainId: req.ctx.env.CHAIN_ID,
        });
        const issued = await rotateApiKey(consumed.wallet, req.ctx.env.CHAIN_ID, req.ctx.env.API_KEY_PEPPER);
        res.status(201).json({
          ...issued,
          apiKeyUsage: apiKeyUsage(issued.apiKey),
          nextStep: { action: "PERSIST_API_KEY", then: "USE_API_KEY_FOR_AUTHENTICATED_REQUESTS" },
          shownOnce: true,
          warning: "The previous key stopped working the moment this one was created.",
        });
      } catch (error) {
        mapAuthError(error);
      }
    })
  );

  router.post(
    "/api-key/revoke",
    noStore,
    issueLimiter,
    handler(async (req, res) => {
      const parsed = SubmitBody.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid(`This revoke was refused: ${submitProblem(parsed.error.issues)}`, { issues: parsed.error.issues });
      try {
        const consumed = await consumeChallenge({
          nonce: parsed.data.nonce,
          signature: parsed.data.signature,
          purpose: "REVOKE_API_KEY",
          chainId: req.ctx.env.CHAIN_ID,
        });
        const status = await revokeApiKey(consumed.wallet, req.ctx.env.CHAIN_ID);
        res.json(status);
      } catch (error) {
        mapAuthError(error);
      }
    })
  );

  /** Status for a wallet. Public metadata only: never the secret, not even its hash. */
  router.get(
    "/api-key/status",
    noStore,
    handler(async (req, res) => {
      const wallet = req.query.wallet;
      if (typeof wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        throw ApiError.invalid("Provide ?wallet=0x...");
      }
      res.json(await getStatus(getAddress(wallet), req.ctx.env.CHAIN_ID));
    })
  );

  /** Authenticated self view. Scoped to the key wallet; `?wallet=` can never widen it. */
  router.get(
    "/me",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      res.json({
        wallet,
        chainId: req.ctx.env.CHAIN_ID,
        apiKey: await getStatus(wallet, req.ctx.env.CHAIN_ID),
        capabilities: {
          canReadOwnAccount: true,
          canRequestTransactionIntents: true,
          canSignTransactions: false,
          canMoveFunds: false,
          note:
            "An AIC API key is an authentication credential, not wallet authority. Every " +
            "economic action requires a signature from the Agent EOA itself.",
        },
      });
    })
  );

  /** Off-chain preferences only. Never anything that could move funds. */
  router.patch(
    "/me/policy",
    noStore,
    requireAgent,
    idempotent({ action: "update_policy" }),
    handler(async (req, res) => {
      const { AgentAccount } = await import("../../db/models");
      const Body = z.object({
        maxPerTransactionUSDC: z.string().regex(/^\d+$/).nullable().optional(),
        maxDailyUSDC: z.string().regex(/^\d+$/).nullable().optional(),
        allowedContracts: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(64).optional(),
      });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid policy", { issues: parsed.error.issues });

      const wallet = selfWallet(req).toLowerCase();
      await AgentAccount.updateOne(
        { walletAddress: wallet, chainId: req.ctx.env.CHAIN_ID },
        { $set: { policy: parsed.data } }
      );
      res.json({
        wallet,
        policy: parsed.data,
        note:
          "Agent-side spending preferences. These are advisory guard rails the Agent runtime " +
          "should honour; they are not enforced on chain and do not limit the wallet itself.",
      });
    })
  );

  return router;
}
