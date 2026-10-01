/**
 * HTTP middleware: request identity, authentication, idempotency, caching and errors.
 *
 * Security rules implemented here, each with its plan reference:
 *  - 0.27.P  an API key is scoped to its own wallet; `?wallet=` can never widen it;
 *  - 0.25.W  idempotency is scoped by wallet + action + scope + key, and a key reused with
 *            different parameters is a deterministic conflict, never a second intent;
 *  - 0.27.Q  wallet-specific responses are `private, no-store` and `Vary: Authorization`,
 *            enforced by the application rather than only by a CDN dashboard;
 *  - 0.27.S  rate limits key on wallet/API key as well as IP, so three proving Agents behind
 *            one egress address do not throttle each other;
 *  - 0.23    client IP is derived only through the configured proxy chain.
 */

import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import rateLimit, { type Options as RateLimitOptions } from "express-rate-limit";
import { ApiError } from "./errors";
import { authenticate, ApiKeyError, getStatus } from "../auth/apiKeys";
import { activeKeyRecovery, unknownCallerRecovery } from "../auth/recovery";
import { IdempotencyRecord } from "../db/models";
import { logger } from "../utils/logger";
import { recordRefusal } from "./demand";
import type { AppContext } from "./context";

export function attachContext(ctx: AppContext) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.ctx = ctx;
    next();
  };
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  req.requestId = incoming && /^[\w-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
}

/** Marks a response as wallet-specific so no shared cache may ever store it. [0.27.Q, 0.27.U] */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Vary", "Authorization");
  res.setHeader("Pragma", "no-cache");
  next();
}

/** Public, indexed data may be briefly edge-cached as long as freshness travels with it. */
export function publicCache(seconds: number) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds}`);
    next();
  };
}

export async function requireAgent(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      /*
       * Which branch the caller is on, when the request says who it is. An agent that already
       * holds a key must not be sent back to ISSUE: that is the loop this answer exists to end.
       * The wallet is only ever taken from the request itself; with none, nothing is guessed.
       */
      const named = [req.query.wallet, (req.body as { wallet?: unknown } | undefined)?.wallet]
        .map((w) => (typeof w === "string" ? w.trim() : ""))
        .find((w) => /^0x[0-9a-fA-F]{40}$/.test(w));
      const status = named ? await getStatus(named, req.ctx.env.CHAIN_ID).catch(() => null) : null;
      if (status && status.status === "ACTIVE") {
        throw new ApiError(
          "INVALID_API_KEY",
          "Missing Authorization: Bearer <api key> header. This wallet already has an active key — " +
            "send it; if you lost it, rotate (details.ifKeyLost). Do not issue again.",
          401,
          { reason: "MISSING_AUTHORIZATION", wallet: named, ...activeKeyRecovery(named ?? null), activeApiKeyExists: true }
        );
      }
      throw new ApiError(
        "INVALID_API_KEY",
        "Missing Authorization: Bearer <api key> header. If you have a key, send it. If you had one and " +
          "lost it, rotate — issuing again is refused while a key is active. Only if you never had one, issue.",
        401,
        { reason: "MISSING_AUTHORIZATION", ...unknownCallerRecovery() }
      );
    }
    const agent = await authenticate(match[1].trim(), req.ctx.env.CHAIN_ID, req.ctx.env.API_KEY_PEPPER);
    req.agent = {
      wallet: agent.wallet,
      apiKeyPrefix: agent.apiKeyPrefix,
      issuedAt: agent.issuedAt,
      updatesReadAt: agent.updatesReadAt,
    };
    next();
  } catch (error) {
    if (error instanceof ApiKeyError) {
      next(new ApiError(error.code as never, error.message, error.status));
      return;
    }
    next(error);
  }
}

/**
 * Resolves the wallet a request may act for. An API key authenticates exactly one wallet and
 * can never be widened with a query parameter. [MASTER_PLAN 0.27.P]
 */
export function selfWallet(req: Request): string {
  if (!req.agent) throw ApiError.unauthorized("INVALID_API_KEY", "Authentication required");
  const requested = req.query.wallet;
  if (typeof requested === "string" && requested.toLowerCase() !== req.agent.wallet.toLowerCase()) {
    throw ApiError.forbidden(
      "An API key is scoped to its own wallet. Use the public endpoints for other addresses."
    );
  }
  return req.agent.wallet;
}

export interface IdempotencyOptions {
  action: string;
  scope?: (req: Request) => string;
  ttlSeconds?: number;
}

/**
 * Idempotency for write endpoints.
 *
 * On a repeat with the same body, the stored response is replayed. On a repeat with a
 * different body, the request is rejected with IDEMPOTENCY_CONFLICT so a mistyped retry can
 * never create a second economic intent. [MASTER_PLAN 0.25.W, rule 13]
 */
export function idempotent(options: IdempotencyOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = req.header("idempotency-key");
      if (!key) {
        throw ApiError.invalid(
          "Missing Idempotency-Key header. Every write endpoint requires one so a retry can " +
            "never create a second economic intent."
        );
      }
      if (!/^[\w.:-]{8,128}$/.test(key)) {
        throw ApiError.invalid("Idempotency-Key must be 8-128 characters of [A-Za-z0-9._:-]");
      }

      const wallet = selfWallet(req).toLowerCase();
      const scopeId = options.scope ? options.scope(req) : "";
      const requestHash = crypto
        .createHash("sha256")
        .update(JSON.stringify({ body: req.body ?? {}, params: req.params, action: options.action, scopeId }))
        .digest("hex");

      const existing = await IdempotencyRecord.findOne({
        walletAddress: wallet,
        action: options.action,
        scopeId,
        key,
      }).lean();

      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ApiError(
            "IDEMPOTENCY_CONFLICT",
            "This Idempotency-Key was already used with different parameters.",
            409,
            { key, action: options.action }
          );
        }
        if (typeof existing.responseStatus === "number" && existing.responseBody != null) {
          res.setHeader("idempotent-replay", "true");
          res.status(existing.responseStatus).json(existing.responseBody);
          return;
        }
        // A previous attempt committed the reservation but never stored a response.
        throw new ApiError(
          "TRANSACTION_PENDING",
          "A request with this Idempotency-Key is still in progress. Retry shortly.",
          409
        );
      }

      const ttl = options.ttlSeconds ?? 60 * 60 * 24;
      try {
        await IdempotencyRecord.create({
          key,
          walletAddress: wallet,
          action: options.action,
          scopeId,
          requestHash,
          expiresAt: new Date(Date.now() + ttl * 1000),
        });
      } catch (error) {
        // Unique index collision: a concurrent identical request won the race.
        if ((error as { code?: number }).code === 11000) {
          throw new ApiError(
            "TRANSACTION_PENDING",
            "A concurrent request with this Idempotency-Key is in progress. Retry shortly.",
            409
          );
        }
        throw error;
      }

      req.idempotency = { key, action: options.action, scopeId, requestHash };

      // Capture the response so an identical retry replays it byte for byte.
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        void IdempotencyRecord.updateOne(
          { walletAddress: wallet, action: options.action, scopeId, key },
          { $set: { responseStatus: res.statusCode, responseBody: body } }
        ).catch((err) => logger.error({ err: String(err) }, "failed to persist idempotent response"));
        return originalJson(body);
      }) as typeof res.json;

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Rate limiting keyed on the strongest identity available.
 * MASTER_PLAN 0.27.S: limits must not throttle three proving Agents that share one egress IP,
 * so an authenticated request is keyed on its wallet rather than its address.
 */
/**
 * @param skip Paths this limiter does not police, so a caller can be counted by a different
 *        budget instead. Used to keep public protocol discovery out of the general bucket.
 */
export function limiter(
  windowMs: number,
  max: number,
  name: string,
  skip?: (req: Request) => boolean
) {
  const options: Partial<RateLimitOptions> = {
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    ...(skip ? { skip } : {}),
    keyGenerator: (req: Request) => {
      if (req.agent?.wallet) return `wallet:${req.agent.wallet.toLowerCase()}`;
      const bodyWallet = (req.body as { wallet?: string } | undefined)?.wallet;
      if (typeof bodyWallet === "string") return `wallet:${bodyWallet.toLowerCase()}`;
      return `ip:${req.ip ?? "unknown"}`;
    },
    handler: (req: Request, res: Response) => {
      res
        .status(429)
        .json(
          new ApiError("RATE_LIMITED", `Rate limit exceeded for ${name}`, 429, {
            windowMs,
            limit: max,
          }).toBody(req.requestId)
        );
    },
  };
  return rateLimit(options);
}

/**
 * Ids in a path, checked before any route sees them.
 *
 * A store or product id is 32 bytes — 64 hex characters after 0x — and a wallet or token address
 * is 20 bytes, 40. An id one character long or short is never a different store: it is the right
 * store retyped, and "Store not found" sent the caller looking for a store that does not exist
 * instead of at the character it added. A route template's own placeholder ({storeId}, :storeId)
 * reaching the server means the id was never substituted. Both are answered here, with the count.
 */
export function pathIdCheck(req: Request, res: Response, next: NextFunction): void {
  const path = (req.originalUrl ?? req.url).split("?")[0] ?? "";
  if (!path.startsWith("/api/")) return next();
  for (const raw of path.split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      seg = raw;
    }
    if (/^\{[^}]*\}$|^:[A-Za-z]\w*$/.test(seg)) {
      res.status(400).json(
        new ApiError(
          "INVALID_REQUEST",
          `The path still contains the template placeholder ${seg}. Replace it with the real id — ` +
            "your own store ids are in GET /api/v1/me (stores.items[].storeId); anyone's are in the market listings.",
          400
        ).toBody(req.requestId)
      );
      return;
    }
    if (!/^0x/i.test(seg)) continue;
    const hex = seg.slice(2);
    const bad = !/^[0-9a-fA-F]*$/.test(hex) ? "contains characters that are not hex" : hex.length !== 40 && hex.length !== 64 ? `has ${hex.length} hex characters` : null;
    if (bad) {
      res.status(400).json(
        new ApiError(
          "INVALID_REQUEST",
          `The id ${seg.slice(0, 12)}… in the path ${bad}. Store and product ids are 64 hex characters after 0x; ` +
            "wallet and token addresses are 40. An id that is one character off was retyped, not looked up: " +
            "take it from the field of the response that gave it to you (storeId, productId, aicToken) " +
            "programmatically, and do not copy it by hand.",
          400
        ).toBody(req.requestId)
      );
      return;
    }
  }
  next();
}

/** Routes by method, from the OpenAPI document, so a 404 can say "this path is a POST". */
let routeTable: { method: string; re: RegExp; path: string }[] = [];
export function setRouteTable(paths: Record<string, Record<string, unknown>>): void {
  routeTable = [];
  for (const [p, ops] of Object.entries(paths)) {
    const escaped = p.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    const re = new RegExp("^" + escaped.replace(/\{[^}]+\}/g, "[^/]+") + "/?$");
    for (const m of Object.keys(ops)) routeTable.push({ method: m.toUpperCase(), re, path: p });
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  const path = (req.originalUrl ?? req.url).split("?")[0] ?? "";
  const other = routeTable.filter((r) => r.method !== req.method && r.re.test(path));
  if (other.length) {
    const methods = [...new Set(other.map((r) => r.method))].join(" or ");
    res.status(405).json(
      new ApiError(
        "INVALID_REQUEST",
        `${req.method} is not how this path is called: ${other[0]!.path} is ${methods}. ` +
          "Send the same path with that method; its body is described in /api/v1/openapi.json.",
        405
      ).toBody(req.requestId)
    );
    return;
  }
  // A route an agent expected to exist is demand too.
  recordRefusal(req, "NOT_FOUND");
  res
    .status(404)
    .json(ApiError.notFound(`Route ${req.method} ${req.path}`).toBody(req.requestId));
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  /*
   * A body this server could not parse is the caller's error, and used to be reported as ours.
   *
   * express.json rejects malformed JSON with a SyntaxError carrying `type: "entity.parse.failed"`,
   * which fell through to the 500 branch below: "An unexpected error occurred. The request was
   * not applied." An agent that sent one unbalanced brace read that the server had crashed, and
   * had no reason to look at its own body. It is a 400, and it says where the JSON broke.
   */
  const parseFailure = error as { type?: string; status?: number; message?: string } | null;
  if (parseFailure && typeof parseFailure === "object" && parseFailure.type === "entity.parse.failed") {
    res.status(400).json(
      ApiError.invalid(
        "The request body is not valid JSON, so it was not read. " +
          `Parser said: ${(parseFailure.message ?? "").slice(0, 160)}. ` +
          "Build the body as an object and serialise it; never assemble JSON by hand.",
        { issues: [{ path: ["(body)"], message: "not valid JSON" }] }
      ).toBody(req.requestId)
    );
    return;
  }
  if (parseFailure && typeof parseFailure === "object" && parseFailure.type === "entity.too.large") {
    res.status(413).json(
      ApiError.invalid("The request body is larger than this API accepts (256kb).", {
        issues: [{ path: ["(body)"], message: "too large" }],
      }).toBody(req.requestId)
    );
    return;
  }

  if (error instanceof ApiError) {
    if (error.status >= 500) {
      logger.error({ err: error.message, code: error.code, requestId: req.requestId }, "api error");
    }
    // A refusal is demand the site did not meet; kept as route + code only (see DemandSignal).
    if (error.status >= 400 && error.status < 500) recordRefusal(req, error.code);
    res.status(error.status).json(error.toBody(req.requestId));
    return;
  }

  logger.error({ err: String(error), stack: (error as Error)?.stack, requestId: req.requestId }, "unhandled error");
  res
    .status(500)
    .json(
      new ApiError("INTERNAL_ERROR", "An unexpected error occurred. The request was not applied.", 500).toBody(
        req.requestId
      )
    );
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function handler(
  fn: (req: Request, res: Response) => Promise<void> | void
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}
