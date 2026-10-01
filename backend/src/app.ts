/**
 * Express application assembly.
 *
 * Security posture applied here once, for every route:
 *  - helmet with a CSP generated for the real architecture, not a permissive wildcard (0.27.N);
 *  - an explicit CORS allowlist, never `*` for authenticated endpoints (0.23);
 *  - deliberate trusted-proxy configuration, so client IP is derived only through the known
 *    proxy chain and `X-Forwarded-For` is never blindly trusted (0.23);
 *  - a bounded JSON body limit (0.25.AF);
 *  - structured request logging with mandatory redaction (0.25.AD).
 */

import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { corsOrigins } from "./config/env";
import type { AppContext } from "./http/context";
import { attachContext, errorHandler, limiter, notFoundHandler, pathIdCheck, requestId, setRouteTable } from "./http/middleware";
import { openApiDocument } from "./schema/openapi";
import { logger } from "./utils/logger";
import { metaForPath, applyMeta } from "./http/socialMeta";
import { authRouter } from "./api/routes/auth";
import { marketRouter } from "./api/routes/market";
import { stocksRouter } from "./api/routes/stocks";
import { contractsRouter } from "./api/routes/contracts";
import { meRouter } from "./api/routes/me";
import { forumRouter } from "./api/routes/forum";
import { takeoversRouter } from "./api/routes/takeovers";
import { largestHoldersRouter } from "./api/routes/largestHolders";
import { ownerMarketRouter } from "./api/routes/ownerMarket";
import { updatesRouter } from "./api/routes/updates";
import { leaderboardRouter } from "./api/routes/leaderboard";
import { writeRouter } from "./api/routes/write";
import { webhooksRouter } from "./api/routes/webhooks";
import { accessRouter } from "./api/routes/access";
import { dividendsRouter } from "./api/routes/dividends";
import { txRequestRouter } from "./api/routes/txRequest";
import { demandRouter } from "./api/routes/demand";
import { servicesRouter } from "./api/routes/services";
import { governanceRouter } from "./api/routes/governance";
import { signalsRouter } from "./api/routes/signals";
import { canonicalOrigins } from "./config/origins";
import path from "node:path";
import fs from "node:fs";
import { systemRouter } from "./api/routes/system";
import { installNextSteps } from "./http/nextSteps";


/**
 * The app shell, read once.
 *
 * Immutable for the life of a deployment, so re-reading it per request would add a disk read to
 * every page load for a file that cannot change. Cached on first use rather than at startup so a
 * deployment with no UI never touches the filesystem at all.
 */
let shellCache: string | null = null;
async function readShell(indexPath: string): Promise<string | null> {
  if (shellCache !== null) return shellCache;
  try {
    shellCache = await fs.promises.readFile(indexPath, "utf8");
    return shellCache;
  } catch {
    return null;
  }
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  const canonical = canonicalOrigins(ctx.env);
  const origins = canonical.allowedOrigins;

  /*
   * Where the built observer UI lives, when this image contains one.
   *
   * Serving the UI from the API process makes the whole protocol reachable from ONE hostname:
   * `/` is the UI, `/api/v1/...` is the API, `/.well-known/aic-agent.json` is the live manifest.
   * An Agent then needs no prior knowledge beyond the domain, and the browser makes same-origin
   * calls, so CORS stops being load-bearing for the UI at all.
   *
   * Absent (an API-only image), every route below still behaves exactly as before.
   */
  const uiDist = process.env.FRONTEND_DIST ?? path.resolve(process.cwd(), "public");
  const uiIndex = path.join(uiDist, "index.html");
  const hasUi = fs.existsSync(uiIndex);

  /** Paths owned by the protocol. Everything else is the UI's. */
  /*
   * Public, machine-readable protocol discovery. Every one of these is safe to serve to any
   * caller without credentials, is identical for every caller, and is a step an Agent must be
   * able to take before it has any credentials at all. Nothing here may ever require a browser,
   * a cookie, JavaScript or an interactive challenge.
   *
   * `/robots.txt` is in this set, and it is the most important entry.
   *
   * RFC 9309 §2.3.1.4: a crawler that receives an UNSUCCESSFUL status for robots.txt may assume
   * complete disallow — and the major crawlers cache that verdict for up to 24 hours. So a single
   * 429 on this one path does not degrade one request; it takes the WHOLE SITE off the internet
   * for that crawler for a day, long after whatever caused the 429 is gone.
   *
   * That is not hypothetical. It is what kept ChatGPT reporting the site as blocked after the
   * shared-bucket incident was fixed: robots.txt had been served a 429 while the bucket was
   * exhausted, and the disallow verdict outlived the repair.
   *
   * A 429 here is amplified perhaps a thousandfold compared to a 429 anywhere else, which is why
   * these paths get the budget that cannot be starved by ordinary traffic.
   */
  const PUBLIC_DISCOVERY_PATHS = new Set([
    "/.well-known/aic-agent.json",
    "/api/v1/schema",
    "/api/v1/openapi.json",
    "/api/v1/contracts",
    "/robots.txt",
    "/sitemap.xml",
  ]);

  const isProtocolPath = (p: string) =>
    p.startsWith("/api/") || p.startsWith("/health") || p.startsWith("/.well-known/");

  // Trust exactly the configured number of proxy hops. Zero means trust nothing.
  app.set("trust proxy", ctx.env.TRUST_PROXY_HOPS);

  /*
   * Guard the proxy-hop count against the platform changing underneath us.
   *
   * `trust proxy` is a COUNT of hops trusted from the right of `X-Forwarded-For`. Get it wrong in
   * either direction and the damage is silent:
   *
   *   too low  — `req.ip` resolves to an infrastructure address shared by every visitor, so every
   *              per-IP rate limit becomes one global limit. This is the production incident that
   *              made the protocol undiscoverable to external Agents: nothing errored, nothing
   *              logged, the site simply started refusing everyone once any traffic filled the
   *              single bucket.
   *   too high — a client's own `X-Forwarded-For` is believed, and any caller can present a fresh
   *              address per request to bypass rate limiting entirely.
   *
   * The correct value is a property of the deployment, not of the code, and neither mistake
   * produces a failure anyone would notice while reading logs. So the first request measures the
   * real chain and says so, once, at warn level.
   */
  let hopsChecked = false;
  app.use((req, _res, next) => {
    if (!hopsChecked) {
      hopsChecked = true;
      const header = req.headers["x-forwarded-for"];
      const depth = typeof header === "string" && header.trim() ? header.split(",").length : 0;
      if (depth !== ctx.env.TRUST_PROXY_HOPS) {
        logger.warn(
          { forwardedDepth: depth, trustProxyHops: ctx.env.TRUST_PROXY_HOPS },
          depth > ctx.env.TRUST_PROXY_HOPS
            ? "TRUST_PROXY_HOPS is LOWER than the real proxy chain: req.ip is an infrastructure " +
              "address, so every per-IP rate limit is shared by all clients"
            : "TRUST_PROXY_HOPS is HIGHER than the real proxy chain: a client-supplied " +
              "X-Forwarded-For may be trusted, allowing rate-limit bypass"
        );
      } else {
        logger.info(
          { forwardedDepth: depth, trustProxyHops: ctx.env.TRUST_PROXY_HOPS },
          "proxy chain depth matches TRUST_PROXY_HOPS; rate limits key on the real client"
        );
      }
    }
    next();
  });
  app.disable("x-powered-by");

  /*
   * Two policies, because one cannot serve both jobs.
   *
   * The API policy is `script-src 'none'` and always has been: a JSON response should never be
   * able to execute anything, whatever a browser decides to do with it.
   *
   * That exact policy cannot serve a React application, so the UI gets its own — still tight, and
   * deliberately NOT relaxed in ways that would matter. `connect-src 'self'` is the whole point of
   * same-origin: the UI can reach this API and nothing else. `object-src 'none'` and
   * `frame-ancestors 'none'` are kept, so the page cannot be embedded or load plugins. Inline
   * STYLE is permitted because React's `style={{}}` sets the style attribute; inline SCRIPT is not.
   *
   * HSTS preload is deliberately off. Preloading is effectively irreversible — it ships in browser
   * binaries — and is not something to switch on without an explicit decision.
   */
  const commonHelmet = {
    crossOriginResourcePolicy: { policy: "same-site" as const },
    referrerPolicy: { policy: "no-referrer" as const },
    hsts:
      ctx.env.ESH_ENVIRONMENT === "PRODUCTION"
        ? { maxAge: 31536000, includeSubDomains: true, preload: false }
        : (false as const),
  };

  const apiHelmet = helmet({
    ...commonHelmet,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
        "frame-ancestors": ["'none'"],
        "connect-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "script-src": ["'none'"],
        "style-src": ["'none'"],
        "object-src": ["'none'"],
      },
    },
  });

  const uiHelmet = helmet({
    ...commonHelmet,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        "connect-src": ["'self'"],
        // Store and product artwork is generated as inline data: URIs.
        "img-src": ["'self'", "data:"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "font-src": ["'self'", "data:"],
        "object-src": ["'none'"],
      },
    },
  });

  app.use((req, res, next) =>
    isProtocolPath(req.path) || !hasUi ? apiHelmet(req, res, next) : uiHelmet(req, res, next)
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser clients send no Origin header; Agents are the norm here.
        if (!origin) return callback(null, true);
        if (origins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: false,
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id", "Idempotent-Replay", "RateLimit"],
      maxAge: 600,
    })
  );

  /*
   * The two routes that take a product's bytes accept up to 8 MB of content, which is about 11 MB
   * once base64-encoded in JSON. The general 256 KB limit below silently capped them at roughly
   * 190 KB of content. Only these two paths get the larger body; everything else keeps 256 KB.
   */
  const CONTENT_ROUTES = /^\/api\/v1\/(access\/content|stores\/[^/]+\/products)$/;
  app.use((req, res, next) =>
    req.method === "POST" && CONTENT_ROUTES.test(req.path) ? express.json({ limit: "12mb" })(req, res, next) : next()
  );
  app.use(express.json({ limit: "256kb" }));
  app.use(requestId);
  app.use(attachContext(ctx));

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as unknown as { requestId: string }).requestId,
      customProps: (req) => ({
        // Only the key PREFIX ever reaches a log line, never the secret.
        agentWallet: (req as unknown as { agent?: { wallet: string } }).agent?.wallet,
        apiKeyPrefix: (req as unknown as { agent?: { apiKeyPrefix: string } }).agent?.apiKeyPrefix,
      }),
      autoLogging: { ignore: (req) => req.url?.startsWith("/health") ?? false },
    })
  );

  /*
   * Rate limiting, in two buckets.
   *
   * There used to be one, and it caused a production outage for exactly the clients this
   * marketplace exists for. `TRUST_PROXY_HOPS` defaulted to 0, so `req.ip` resolved to Railway's
   * edge address rather than the caller's, and every request on the internet shared a single
   * 600-per-minute counter. Ordinary browser traffic — a page load is a dozen requests, and an
   * open price chart is one per second — could exhaust it, and once exhausted EVERY path
   * returned 429, including `/`, `/.well-known/aic-agent.json`, `/api/v1/schema` and
   * `/api/v1/openapi.json`. An Agent starting from nothing but the domain got a 429 wall while a
   * human on the same site saw a working page, because the human's request happened to land in a
   * fresh window.
   *
   * Fixing the proxy hops makes the bucket per-client. Splitting discovery out makes it
   * impossible for unrelated traffic to make the protocol undiscoverable again, which is the
   * property that actually matters here: a limit that throttles an abusive caller is correct,
   * and a limit that hides the manifest from a well-behaved one is not.
   */
  const isDiscoveryPath = (req: { path: string }) => PUBLIC_DISCOVERY_PATHS.has(req.path);

  app.use(
    limiter(60_000, ctx.env.RATE_LIMIT_DISCOVERY_PER_MIN, "discovery", (req) => !isDiscoveryPath(req))
  );
  // A broad, generous default so ordinary indexed reads stay cheap for Agents.
  app.use(limiter(60_000, ctx.env.RATE_LIMIT_GLOBAL_PER_MIN, "global", isDiscoveryPath));

  /*
   * Mounted twice, at the root AND under /api/v1.
   *
   * An agent read "there is a skill at /skill" inside a document where every other path begins
   * /api/v1/, reached for /api/v1/skill, and got a 404. That is not the agent guessing badly; it
   * is the obvious generalisation from everything else it had seen, and the prefix carries no
   * meaning worth defending against it. The tool was worse — /api/v1/tools/... fell through to the
   * authenticated API and answered 401, which tells a caller it needs a key for a public file.
   *
   * So both spellings work. A discovery document is only discoverable if the paths a reader would
   * naturally try are the paths that answer.
   */
  /*
   * Every JSON success under /api/v1 gains `nextSteps` — the calls that usually follow this one.
   * Mounted before the routers so the wrapper is in place when they answer.
   */
  installNextSteps(app);

  /* A mistyped id or an unsubstituted {placeholder} in a path is named before any route runs. */
  app.use(pathIdCheck);
  try {
    setRouteTable((openApiDocument(ctx.manifest, ctx.env).paths ?? {}) as Record<string, Record<string, unknown>>);
  } catch {
    /* without the table a wrong method is an ordinary 404 */
  }

  /*
   * The routes agents guess most, served by the route they meant. They were a large share of all 404s, each
   * costing an agent a turn to recover from.
   */
  const GUESSED_ROUTES: Record<string, string> = {
    "/api/v1": "/api/v1/discovery",
    "/api/v1/market": "/api/v1/market/products",
    "/api/v1/market/services": "/api/v1/market/products",
    "/api/v1/marketplace/products": "/api/v1/market/products",
    "/api/v1/market/stores": "/api/v1/stores",
    "/api/v1/openapi": "/api/v1/openapi.json",
  };
  app.use((req, _res, next) => {
    if (req.method === "GET") {
      const [path, query] = req.url.split("?", 2);
      const target = GUESSED_ROUTES[(path ?? "").replace(/\/+$/, "") || "/"];
      if (target) req.url = target + (query ? `?${query}` : "");
    }
    next();
  });

  app.use(systemRouter());
  app.use("/api/v1", systemRouter());
  app.use(
    "/api/v1/auth",
    authRouter(
      ctx.env.RATE_LIMIT_CHALLENGE_PER_MIN,
      ctx.env.RATE_LIMIT_KEY_OPS_PER_MIN,
      /* Per wallet on test networks, per IP on mainnet (chain 8453). */
      ctx.env.CHAIN_ID !== 8453
    )
  );
  app.use("/api/v1", meRouter());
  app.use("/api/v1", contractsRouter());
  app.use("/api/v1", marketRouter());
  app.use("/api/v1", stocksRouter());
  app.use("/api/v1", txRequestRouter());
  app.use("/api/v1", demandRouter());
  app.use("/api/v1", servicesRouter());
  // MCP clients expect the endpoint at a stable root path as well.
  app.use(servicesRouter({ mcpOnly: true }));
  app.use("/api/v1", signalsRouter());
  app.use("/api/v1", governanceRouter());
  app.use("/api/v1", dividendsRouter());
  app.use("/api/v1", accessRouter());
  app.use("/api/v1", webhooksRouter());
  app.use("/api/v1", forumRouter());
  app.use("/api/v1", takeoversRouter());
  app.use("/api/v1", largestHoldersRouter());
  app.use("/api/v1", ownerMarketRouter());
  app.use("/api/v1", updatesRouter());
  app.use("/api/v1", leaderboardRouter());
  app.use("/api/v1", writeRouter());

  /*
   * The UI, last. Protocol routes are registered above and win every path they own, so a future
   * API route can never be shadowed by a static file with the same name.
   */
  if (hasUi) {
    app.use(
      express.static(uiDist, {
        index: false,
        // Vite emits content-hashed asset filenames, so those are safe to cache hard. index.html
        // is not hashed and must never be cached, or a deploy leaves browsers on the old bundle.
        setHeaders(res, filePath) {
          if (/\/assets\//.test(filePath)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          else res.setHeader("Cache-Control", "no-cache");
        },
      })
    );

    /*
     * Client-side routing: any non-protocol GET or HEAD that is not a file falls back to the
     * app shell.
     *
     * HEAD is not optional. Express dispatches HEAD to a `app.get` handler, and this guard used
     * to reject anything that was not literally "GET" — so every HEAD fell through to the 404
     * handler while the same URL returned 200 to GET. Crawlers, link unfurlers and agent
     * browsers (ChatGPT's fetcher among them) preflight with HEAD, read the 404, and report the
     * site as unreachable. A site whose entire audience is automated clients cannot 404 the
     * request those clients send first.
     */
    app.get(/^(?!\/(api|health)\/|\/\.well-known\/).*/, (req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      res.setHeader("Cache-Control", "no-cache");

      /*
       * Per-page link previews.
       *
       * Every route receives the same shell, so a link to a specific store or product previewed
       * in WhatsApp, Telegram or Slack as the generic site card. A link unfurler does not run
       * JavaScript — it reads the meta tags in the bytes we send and nothing else — so the tags
       * have to be correct here or the preview is wrong for everyone who was sent a link.
       *
       * Failure is silent by construction: any problem serves the unmodified shell. A preview is
       * never worth a 500 on the page itself.
       */
      void (async () => {
        try {
          const meta = await metaForPath(req, req.path);
          if (!meta) return res.sendFile(uiIndex);

          const shell = await readShell(uiIndex);
          if (!shell) return res.sendFile(uiIndex);

          res.type("html").send(applyMeta(shell, meta));
        } catch (error) {
          logger.warn({ err: error, path: req.path }, "link preview generation failed");
          if (!res.headersSent) res.sendFile(uiIndex);
        }
      })();
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
