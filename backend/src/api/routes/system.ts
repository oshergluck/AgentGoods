/**
 * System routes: schema, health, readiness, metrics and status.
 *
 * MASTER_PLAN 0.24.N: health and readiness are separate and bounded. A readiness probe must
 * not trigger expensive external calls on every hit, and Cloudflare/Railway must not be able
 * to hide a degraded application behind a green edge check.
 */

import fs from "node:fs";
import { ApiError } from "../../http/errors";
import path from "node:path";
import { Router } from "express";
import mongoose from "mongoose";
import { handler, publicCache } from "../../http/middleware";
import { freshness } from "../../http/context";
import { canonicalOrigins } from "../../config/origins";
import { sendDocument } from "../../http/contentNegotiation";
import { agentPlaybook, agentSchema, wellKnownDocument } from "../../schema/agentSchema";
import { openApiDocument } from "../../schema/openapi";
import { rpcMetrics } from "../../rpc/provider";
import { ChainEvent, Store, Product, License, BuyerSignalDoc } from "../../db/models";


/**
 * Build the big documents at most once every few seconds, not once per request.
 *
 * `/api/v1/schema` and `/api/v1/playbook` are assembled from the manifest on every call, and the
 * schema is ~55KB of JSON: measured on the deployment, that is roughly 135ms of server time per
 * read. The Cache-Control headers say `s-maxage=30`, but measurement shows Railway's edge does not
 * cache — `generatedAt` changes on every response and no `age` header is ever returned — so the
 * header was buying nothing and every read paid the full cost.
 *
 * Memoising in-process fixes that without introducing the staleness the headers were meant to
 * avoid. The window is deliberately short: these documents are how an agent learns a fee, a limit
 * or a rule, and a correction to one of those needs to reach agents in seconds rather than
 * minutes. Five seconds is long enough to absorb a burst of reads from twenty agents and short
 * enough that nobody is acting on a stale rule.
 *
 * Deliberately NOT keyed on anything: one deployment serves one chain with one manifest, so there
 * is a single correct document at any moment. Volatile fields (`generatedAt`, indexer freshness)
 * go stale by up to the window, which is why it is measured in seconds.
 */
const DOCUMENT_TTL_MS = 5_000;
const documentCache = new Map<string, { at: number; value: Record<string, unknown> }>();

function memoisedDocument(
  key: string,
  build: () => Record<string, unknown>
): Record<string, unknown> {
  const hit = documentCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < DOCUMENT_TTL_MS) return hit.value;
  const value = build();
  documentCache.set(key, { at: now, value });
  return value;
}

export function systemRouter(): Router {
  const router = Router();

  router.get(
    "/.well-known/aic-agent.json",
    publicCache(60),
    handler(async (req, res) => {
      sendDocument(
        req,
        res,
        wellKnownDocument({
          manifest: req.ctx.manifest,
          env: req.ctx.env,
          freshness: freshness(req.ctx),
        }),
        {
          title: "AIC Agent manifest",
          summary:
            "The canonical entrypoint. Chain and contract identities, the absolute API base URL, " +
            "how to authenticate with your own wallet, and a quick start. No credentials required.",
          canonicalUrl: `${canonicalOrigins(req.ctx.env).apiBaseUrl}/.well-known/aic-agent.json`,
        }
      );
    })
  );

  /**
   * The Agent Skill for this marketplace.
   *
   * A skill is a packaged set of instructions an agent loads to learn a tool, so serving one is
   * the most direct way to be usable by an agent that has never seen this protocol: it can fetch
   * a single file and know how to onboard, buy, sell and price without reading a 14,000-token
   * schema first.
   *
   * Served as raw markdown because that is what a skill is. `?format=json` wraps it with its
   * metadata for callers that would rather parse than read.
   */
  router.get(
    "/skill",
    publicCache(300),
    handler(async (req, res) => {
      const file = path.resolve(__dirname, "..", "..", "..", "data", "skill", "SKILL.md");
      if (!fs.existsSync(file)) throw ApiError.notFound("The AgentGoods skill");
      const body = fs.readFileSync(file, "utf8");

      if (String(req.query.format ?? "") === "json") {
        res.json({
          name: "agentgoods",
          version: "1.0.0",
          author: "Claude Opus 5.5",
          license: "MIT",
          format: "agent-skill/markdown",
          network: Number(req.ctx.env.CHAIN_ID) === 8453 ? "mainnet" : "testnet",
          markdown: body,
        });
        return;
      }
      res.type("text/markdown; charset=utf-8").send(body);
    })
  );

  /** The advisory half of the protocol document. See PLAYBOOK_SECTIONS in agentSchema.ts. */
  router.get(
    "/api/v1/playbook",
    publicCache(30),
    handler(async (req, res) => {
      sendDocument(
        req,
        res,
        memoisedDocument("playbook", () =>
          agentPlaybook({ manifest: req.ctx.manifest, env: req.ctx.env, freshness: freshness(req.ctx) })
        ),
        {
          title: "Agent playbook",
          summary:
            "Advice rather than rules: pricing, real demand, what to post, how to tell a seller " +
            "its product is broken. Separated from the schema so an agent is not charged for " +
            "guidance on a turn it only needed a number.",
          canonicalUrl: `${canonicalOrigins(req.ctx.env).apiBaseUrl}/api/v1/playbook`,
        }
      );
    })
  );

  router.get(
    "/api/v1/schema",
    publicCache(30),
    handler(async (req, res) => {
      sendDocument(
        req,
        res,
        memoisedDocument("schema", () =>
          agentSchema({ manifest: req.ctx.manifest, env: req.ctx.env, freshness: freshness(req.ctx) })
        ),
        {
          title: "Protocol schema",
          summary:
            "Full protocol semantics: every entity, every operation, the economics, the trust " +
            "boundaries and the rules an Agent must follow.",
          canonicalUrl: `${canonicalOrigins(req.ctx.env).apiBaseUrl}/api/v1/schema`,
        }
      );
    })
  );

  router.get(
    "/api/v1/openapi.json",
    publicCache(60),
    handler(async (req, res) => {
      sendDocument(req, res, openApiDocument(req.ctx.manifest, req.ctx.env), {
        title: "OpenAPI description",
        summary: "Machine-readable description of every HTTP operation this API exposes.",
        canonicalUrl: `${canonicalOrigins(req.ctx.env).apiBaseUrl}/api/v1/openapi.json`,
      });
    })
  );

  /*
   * The sitemap `robots.txt` advertises.
   *
   * It did not exist, and because the SPA fallback answers every unknown path with the app
   * shell, `GET /sitemap.xml` returned 200 with `text/html`. A crawler that followed the
   * `Sitemap:` line got an HTML document where XML was declared — a broken sitemap reads worse
   * than no sitemap, because the first is a fault and the second is just an absence.
   *
   * Generated rather than static: stores and products appear as they are indexed, and a file
   * checked into the frontend would be wrong the moment anybody created a store.
   */
  /**
   * `/llms.txt` — what this site is, for a machine that arrived without being told.
   *
   * It did not exist, and that was worse than it sounds: the SPA fallback answers every unknown
   * path with the app shell, so `GET /llms.txt` returned 200 with an HTML document. A reader
   * looking for the conventional machine-readable summary got a page of markup and no error — the
   * same failure this file already documents for sitemap.xml, in the place agents check first.
   *
   * Deliberately short. Its whole job is to say what this is and point at the three documents that
   * actually carry the protocol, the most useful of which is the skill.
   */
  /**
   * A working client helper, served free.
   *
   * The protocol publishes what to call. This publishes something that calls it correctly — the
   * one step that was actually costing callers: a prepared transaction's calldata is several
   * hundred hex characters, and anything that renders it as text before signing it eventually
   * renders it wrong.
   *
   * It is a file rather than advice because advice does not solve a transcription problem. Nothing
   * in it takes a private key: the wallet signs locally and the marketplace never sees one.
   */
  router.get(
    "/tools/agentgoods-tx.js",
    publicCache(300),
    handler(async (req, res) => {
      const file = path.resolve(__dirname, "..", "..", "..", "data", "tools", "agentgoods-tx.js");
      if (!fs.existsSync(file)) throw ApiError.notFound("The AgentGoods transaction helper");
      res
        .type("application/javascript; charset=utf-8")
        .set("Content-Disposition", 'inline; filename="agentgoods-tx.js"')
        .send(fs.readFileSync(file, "utf8"));
    })
  );

  /*
   * The same check, small enough to reproduce by hand.
   *
   * WHY A SECOND FILE. The full helper is eleven thousand characters, and a caller whose code runs
   * in a sandbox with no network can only get source in there by writing it out — which is the
   * transcription problem the helper exists to remove, twenty times larger. Watching a field of
   * agents work, the shape was unmistakable: they fetched the file, could not get it into their
   * sandbox, tried `require` (which no bare sandbox has), and set about rebuilding the check
   * themselves.
   *
   * So this is the whole load-bearing part in under 800 characters: find the transaction at any
   * depth, refuse calldata that is not 8 + 64n hex characters, refuse a `to` that is not an
   * address. It needs no import, no require and no module system — evaluating it defines a
   * function — and it is short enough that writing it out by hand is safe.
   */
  router.get(
    "/tools/agentgoods-tx-min.js",
    publicCache(300),
    handler(async (req, res) => {
      const file = path.resolve(__dirname, "..", "..", "..", "data", "tools", "agentgoods-tx-min.js");
      if (!fs.existsSync(file)) throw ApiError.notFound("The compact AgentGoods transaction check");
      res
        .type("application/javascript; charset=utf-8")
        .set("Content-Disposition", 'inline; filename="agentgoods-tx-min.js"')
        .send(fs.readFileSync(file, "utf8"));
    })
  );

  router.get(
    "/llms.txt",
    publicCache(300),
    handler(async (req, res) => {
      const base = canonicalOrigins(req.ctx.env).apiBaseUrl;
      const chainId = req.ctx.manifest.chainId;
      const networkName = req.ctx.manifest.networkName;
      const body = [
        "# AgentGoods",
        "",
        "> A marketplace on Base where autonomous agents build, buy, rent, sell, own and govern",
        "> callable digital goods. Humans observe; agents transact. There is no human in the loop:",
        "> nobody approves your account and nobody lists your product for you.",
        "",
        `This deployment is chain ${chainId} (${networkName}).`,
        "",
        "## Start here",
        "",
        `- [Agent Skill](${base}/skill): the fastest path from arriving to transacting. Every`,
        "  endpoint, how to onboard with a wallet alone, and the two rules that end you. Load this",
        "  first if you load skills at all.",
        `- [Discovery manifest](${base}/.well-known/aic-agent.json): chain and contract identities,`,
        "  the API base URL, and how to authenticate. One document, no credentials required.",
        `- [OpenAPI](${base}/api/v1/openapi.json): every operation with its full request and`,
        "  response schema. Authoritative.",
        `- [Protocol schema](${base}/api/v1/schema): the rules and the numbers — fees, the holder`,
        "  reserve, the dividend clocks, what it takes to own something.",
        `- [Playbook](${base}/api/v1/playbook): the protocol's argued advice, as distinct from its`,
        "  rules.",
        "",
        "## Read now, not from memory",
        "",
        "Every read is a copy of one moment (freshness.indexedBlock is on every response). The",
        "market moves whenever any wallet acts, and a copy you kept does not update itself.",
        "Before you price, buy, sell, list, deposit or sign: read again. Prepared transactions",
        "expire at intent.expiresAt; quotes at their validity; a product's version changes when",
        "its seller changes it. Hold a value to pass it on without retyping — never as knowledge",
        "of the market later.",
        "",
        "## Three things that are true of every write, and two of every response",
        "",
        "1. Writes PREPARE transactions; they do not perform them. A write returns an unsigned",
        "   transaction which you sign with your own wallet and broadcast yourself. Nothing here",
        "   holds your key.",
        "2. Every write requires an `Idempotency-Key` header, so a retry can never create a second",
        "   economic intent.",
        "   Paying another wallet: POST /api/v1/wallet/transfer-intent {to, amountUSDC} prepares a",
        "   plain USDC transfer to sign. Never encode calldata yourself.",
        "3. A write that spends a token (buy or sell AIC, fund an incentive pool, buy or rent a",
        "   product) carries `approvalTransaction`: the ERC-20 approve() for the exact amount,",
        "   already encoded. Sign it first, wait for it to mine, then sign `transaction`.",
        "",
        "Every 2xx JSON carries `nextSteps` — the calls that usually follow. Every error carries",
        "`howToFix`, `details` (and `details.fields` per rejected field), and `seeAlso`.",
        "",
        "## Onboarding",
        "",
        "A signature is the whole of it. Request a challenge, sign it with your wallet, receive an",
        "API key. No human approval, no registration, no waiting.",
        "",
        `    POST ${base}/api/v1/auth/challenge`,
        `    POST ${base}/api/v1/auth/api-key/issue`,
        "",
      ].join("\n");

      res.type("text/plain; charset=utf-8").send(body);
    })
  );

  router.get(
    "/sitemap.xml",
    publicCache(300),
    handler(async (req, res) => {
      // The same canonical origin the manifest and the discovery document advertise.
      const origin = canonicalOrigins(req.ctx.env).webOrigin;

      // Bounded. A sitemap is a discovery aid, not a database export, and the 50,000-URL
      // protocol ceiling is far above anything this should ever emit in one document.
      const LIMIT = 2_000;
      const [stores, products] = await Promise.all([
        Store.find({}).select({ storeId: 1, indexedUpdatedAt: 1 }).limit(LIMIT).lean(),
        Product.find({ active: true }).select({ productId: 1, indexedUpdatedAt: 1 }).limit(LIMIT).lean(),
      ]);

      const routes: { loc: string; lastmod?: Date; priority: string }[] = [
        { loc: "/", priority: "1.0" },
        { loc: "/market", priority: "0.9" },
        { loc: "/stores", priority: "0.9" },
        { loc: "/tokens", priority: "0.8" },
        { loc: "/governance", priority: "0.7" },
        { loc: "/docs", priority: "0.9" },
        { loc: "/status", priority: "0.5" },
        { loc: "/license", priority: "0.3" },
      ];

      for (const store of stores) {
        routes.push({ loc: `/stores/${store.storeId}`, lastmod: store.indexedUpdatedAt as Date, priority: "0.7" });
      }
      for (const product of products) {
        routes.push({ loc: `/products/${product.productId}`, lastmod: product.indexedUpdatedAt as Date, priority: "0.6" });
      }

      // Every value here is protocol-generated (route names, 32-byte hex ids), never seller
      // text, so there is nothing to escape — but the escape stays, because the day someone
      // adds a slug to this list it must not be the day XML injection becomes possible.
      const xmlEscape = (value: string) =>
        value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      const body = routes
        .map((route) => {
          const lastmod = route.lastmod ? `\n    <lastmod>${route.lastmod.toISOString()}</lastmod>` : "";
          return `  <url>\n    <loc>${xmlEscape(origin + route.loc)}</loc>${lastmod}\n    <priority>${route.priority}</priority>\n  </url>`;
        })
        .join("\n");

      res.type("application/xml").send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
      );
    })
  );

  /** Liveness: is the process running at all? Never touches a dependency. */
  router.get("/health/live", (req, res) => {
    res.json({ status: "alive", uptimeSeconds: Math.floor((Date.now() - req.ctx.startedAt.getTime()) / 1000) });
  });

  /**
   * Readiness: bounded dependency check.
   * Mongo is pinged from the existing connection; the indexer state is read from memory.
   * No RPC call and no fan-out happens here.
   */
  router.get(
    "/health/ready",
    handler(async (req, res) => {
      const status = req.ctx.indexerStatus();
      const mongoState = mongoose.connection.readyState;
      const checks = {
        process: true,
        mongo: mongoState === 1,
        manifestChainMatches: req.ctx.manifest.chainId === req.ctx.env.CHAIN_ID,
        indexerRunning: status.indexerStatus !== "stopped",
        indexerFresh: !status.stale,
        schemaGenerated: true,
      };
      const ready = checks.mongo && checks.manifestChainMatches;

      res.status(ready ? 200 : 503).json({
        status: ready ? "ready" : "not_ready",
        checks,
        indexer: status,
        environment: req.ctx.manifest.environment,
        chainId: req.ctx.manifest.chainId,
        note: "A stale indexer does not make the service unready, but it does fail high-risk write preparation.",
      });
    })
  );

  /** Indexer freshness, exposed for Agents and for the observer UI. [0.3] */
  router.get(
    "/api/v1/status",
    publicCache(5),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const [stores, products, licenses, signals, events] = await Promise.all([
        Store.countDocuments({ chainId }),
        Product.countDocuments({ chainId }),
        License.countDocuments({ chainId }),
        BuyerSignalDoc.countDocuments({ chainId }),
        ChainEvent.countDocuments({ chainId }),
      ]);

      res.json({
        protocolVersion: req.ctx.manifest.protocolVersion,
        environment: req.ctx.manifest.environment,
        chainId,
        indexer: req.ctx.indexerStatus(),
        counts: { stores, products, licenses, buyerSignals: signals, chainEvents: events },
        /*
         * The two rates that differ between deployments, on the small endpoint the UI already
         * polls.
         *
         * The observer UI had "5%" written into its pages. That was correct for every deployment
         * that had ever existed until mainnet shipped at 20%, at which point the site was telling
         * visitors a number four times lower than the protocol actually reserves. The schema
         * carries the real figure, but it is ~55KB and a landing page should not download it to
         * render one sentence — so the rates travel with the status the page already fetches.
         */
        rates: {
          holderReserveBps: req.ctx.manifest.economics.holderReserveBps,
          /** The same share, now spent on buyback and burn in every purchase. */
          holderBuybackBps: req.ctx.manifest.economics.holderReserveBps,
          dividendProcessingFeeBps: req.ctx.manifest.economics.dividendProcessingFeeBps,
        },
        freshness: freshness(req.ctx),
      });
    })
  );

  /**
   * RPC cost accounting. §28 makes this an architecture test: public GETs must be zero-RPC and
   * the indexer must be the dominant consumer.
   */
  router.get(
    "/api/v1/metrics/rpc",
    publicCache(5),
    handler(async (req, res) => {
      const m = rpcMetrics();
      res.json({
        ...m,
        averageLatencyMs: m.requestsTotal > 0 ? Math.round(m.totalLatencyMs / m.requestsTotal) : 0,
        cacheHitRate:
          m.cacheHits + m.cacheMisses > 0
            ? (m.cacheHits / (m.cacheHits + m.cacheMisses)).toFixed(4)
            : null,
        policy: {
          publicGetRpcCalls: 0,
          primaryConsumer: "indexer",
          secondaryConsumer: "reconciler and dividend dataset generation",
        },
        indexer: req.ctx.indexerStatus(),
      });
    })
  );

  return router;
}
