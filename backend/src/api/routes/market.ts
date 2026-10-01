/**
 * Marketplace read API: products, stores, discovery feeds.
 *
 * Every handler in this file reads ONLY from the indexed Mongo projection. Rule 14 and §28
 * make that an architecture test, not a preference: the route tests arm `forbidRpc()` and
 * fail if any of these paths reaches for the chain.
 *
 * Phase 10.1 additions:
 *   - declaration filters (`declared`, `basis`, `declaredModelTier`) and range filters and
 *     sorting on the derived `tokensSavedPerUsdc`;
 *   - the seller signal summary embedded in list and detail responses, so an Agent can weigh
 *     a claim against that seller record in a single call. [14A.1, 14A.4]
 */

import { PNL_METHOD, pnlForTrades } from "../../stores/tradePnl";
import { capitalSourcesFor } from "../../stores/capitalSources";
import { marketStateOf } from "../../stores/quotes";
import { Router } from "express";
import { withdrawalCooldownView } from "../../stores/withdrawalCooldown";
import { z } from "zod";
import { AicHolder, BuyerSignalDoc, IterationLog, License, PriceSample, Product, ProductVersion, Purchase, Store, StockMarket, StockTrade } from "../../db/models";
import { iterationLogHash } from "../../content/iterationLog";
import { priceDecimal } from "../../stores/stockMetrics";
import { recordSearchMiss } from "../../http/demand";
import { MODEL_LIST_PRICES, normaliseModel, workCostUSD, type TokenBreakdown } from "../../config/modelPrices";
import { amountAIC, amountUSDC } from "../../config/units";
import { ApiError } from "../../http/errors";
import { handler, publicCache } from "../../http/middleware";
import { freshness } from "../../http/context";
import { DELIVERABLE_FROM } from "../../schema/agentSchema";
import { productView, storeView, marketView, storeCard, SELLER_CONTENT_NOTE } from "../serializers";
import { sellerSummaries, sellerSummary, storeSummary, productSummary } from "../../signals/aggregate";
import { decodeCursor, sortKey } from "../../db/sortKey";

const MAX_RECENT_PRODUCTS = 50;
const MAX_RECENT_STORES = 10;
const MAX_PAGE = 100;
const MAX_TRADES = 5_000;

const ListQuery = z.object({
  /*
   * Free text, matched across everything the seller wrote.
   *
   * This was a single regex over the raw seller-content blob, so "token calculator" only matched a
   * product whose text contained that exact adjacent phrase. Buyers looking for a thing by
   * describing it found nothing and concluded the market was empty, then went to the forum to ask
   * for a product that was already listed. Multiple terms are now AND-ed independently, which is
   * what a searcher means by typing two words.
   */
  q: z.string().max(200).optional(),
  /** Targeted at the product's NAME only, for when a buyer knows what it is called. */
  name: z.string().max(200).optional(),
  /** Targeted at the DESCRIPTION only, for searching what a product does rather than its title. */
  description: z.string().max(200).optional(),
  type: z.enum(["sales", "rentals"]).optional(),
  store: z.string().optional(),
  /** Every product controlled by one wallet, resolved through the stores it owns. */
  seller: z.string().max(64).optional(),
  minPriceUSDC: z.string().regex(/^\d+$/).optional(),
  maxPriceUSDC: z.string().regex(/^\d+$/).optional(),
  availability: z.enum(["in_stock", "any"]).optional(),
  /** Only products that actually ship bytes a buyer can collect. */
  hasDeliverable: z.enum(["true", "false"]).optional(),
  /** Only products that have been revised at least once — a seller that maintains its work. */
  revised: z.enum(["true", "false"]).optional(),
  minVersion: z.coerce.number().int().min(1).max(1000).optional(),
  /** Inventory shape, for buyers who care whether supply can run out. */
  inventory: z.enum(["limited", "unlimited"]).optional(),
  /** Rental term bounds, in seconds. Meaningless for sales products and ignored for them. */
  minRentalPeriodSeconds: z.coerce.number().int().min(0).optional(),
  maxRentalPeriodSeconds: z.coerce.number().int().min(0).optional(),
  /** Listing time, as unix seconds or an ISO timestamp. */
  createdAfter: z.string().max(40).optional(),
  createdBefore: z.string().max(40).optional(),

  /*
   * Evidence filters: what the market has actually done with a product, rather than what its
   * seller says about it.
   *
   * These are the ones worth having. A description is a claim and every seller writes a confident
   * one, so filtering on text sorts sellers by fluency. A purchase is a fact, a delivery is a
   * fact, and a store's lifetime commerce is a fact. In this market seven of fifteen listed
   * products had ever been bought by anyone, and no query could separate those seven.
   */
  /** Only products somebody has actually paid for. */
  soldAtLeastOnce: z.enum(["true", "false"]).optional(),
  minUnitsSold: z.coerce.number().int().min(0).optional(),
  /** Only products whose seller has actually handed the goods over at least this many times. */
  minDelivered: z.coerce.number().int().min(0).optional(),
  /** Only products whose buyers said afterwards that they were worth it. */
  minWorthItSignals: z.coerce.number().int().min(0).optional(),
  /** Only products from stores with at least this much lifetime commerce, in USDC base units. */
  storeMinGrossUSDC: z.string().regex(/^\d+$/).optional(),
  /** Exclude a wallet's own products — an agent has no reason to buy from itself. */
  excludeSeller: z.string().max(64).optional(),
  /** Only stores in this state. Paused stores cannot sell and are excluded by default elsewhere. */
  storeStatus: z.enum(["active", "paused", "any"]).optional(),
  /** Only products whose listing carries a published demonstration of the thing running. */
  hasDemonstration: z.enum(["true", "false"]).optional(),
  /** Convenience for "what can I afford", in decimal USDC rather than base units. */
  affordableWithUSDC: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  // Phase 10.1
  declared: z.enum(["true", "false"]).optional(),
  basis: z.enum(["MEASURED", "ESTIMATED", "UNDECLARED"]).optional(),
  declaredModelTier: z.string().max(64).optional(),
  minTokensSavedPerUsdc: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  maxTokensSavedPerUsdc: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  /** Development iterations the seller declared behind the product, across all its versions. */
  minIterations: z.coerce.number().int().min(1).optional(),
  /** SALE (keep the artifact), RENTAL (access for a period) or SERVICE (call it, pay per call). */
  mode: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.enum(["SALE", "RENTAL", "SERVICE"])).optional(),
  /** Your model: every product's work is also priced at it (buildCostUSDC.atYourModel). */
  model: z.string().max(64).optional(),
  sort: z
    .enum([
      "iterations_desc",
      "newest",
      "oldest",
      "price_asc",
      "price_desc",
      "tokensSavedPerUsdc_desc",
      "tokensSavedPerUsdc_asc",
      /* Ordering by evidence rather than by claim. See resolveSort. */
      "mostSold",
      "storeCommerce_desc",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
  cursor: z.string().max(256).optional(),
});

/** Converts a decimal tokens-per-USDC bound into the stored 6-decimal sort key. */
function perUsdcSortKey(value: string): string {
  const [whole, frac = ""] = value.split(".");
  const scaled = BigInt(whole) * 10n ** 6n + BigInt(frac.padEnd(6, "0").slice(0, 6) || "0");
  return sortKey(scaled);
}

export function marketRouter(): Router {
  const router = Router();

  /** General paginated product search. */
  /**
   * One product, at the address a reader would guess for it.
   *
   * Three 404s in a row were GET /stores/{storeId}/products/{productId} — the path every other
   * product operation hangs off (…/quote, …/purchase, …/update), and the one place there was no
   * GET. A caller that has a storeId and a productId, and wants the listing, should not have to
   * page the whole market to find it. Same view as the market returns, so nothing differs by route.
   */
  /**
   * The development behind a product: for every version, the iterations its seller declared and one
   * explanation per iteration. Each log is checked against the hash committed on chain in that version's
   * listing, so what is shown is what the seller committed to. Explanations, never code.
   */
  router.get(
    "/stores/:storeId/products/:productId/iterations",
    publicCache(15),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const storeId = String(req.params.storeId).toLowerCase();
      const productId = String(req.params.productId).toLowerCase();
      const product = await Product.findOne({ chainId, storeId, productId }).lean();
      if (!product) {
        throw new ApiError("NOT_FOUND", "Product not found", 404, {
          storeId,
          productId,
          howToFindIt: "productId is the 32-byte id under protocol.productId in GET /api/v1/market/products.",
        });
      }
      const versions = (await ProductVersion.find({ chainId, storeId, productId }).sort({ version: 1 }).lean()) as Record<string, unknown>[];
      const rows = new Map<number, string>();
      for (const v of versions) rows.set(Number(v.version), String((v.sellerContent as { metadataURI?: string } | undefined)?.metadataURI ?? ""));
      rows.set(Number(product.version), String(product.sellerContent?.metadataURI ?? ""));
      const read = (text: string): Record<string, unknown> => {
        try {
          const t = text.trim();
          return t.startsWith("{") ? (JSON.parse(t) as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      };
      // A version whose listing carries no new log (a price or text change) repeats the previous one; show each log once.
      const shown = new Set<string>();
      const out: Record<string, unknown>[] = [];
      for (const [version, text] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
        const j = read(text);
        const hash = typeof j.iterationLogHash === "string" ? j.iterationLogHash.toLowerCase() : null;
        if (!hash || shown.has(hash)) continue;
        shown.add(hash);
        const log = (await IterationLog.findOne({ chainId, logHash: hash }).lean()) as { entries?: string[] } | null;
        const entries = log?.entries ?? [];
        const matches = log !== null && iterationLogHash(entries) === hash;
        out.push({
          version,
          iterations: Number(j.iterations ?? entries.length) || null,
          iterationsTotalAfter: Number(j.iterationsTotal ?? j.iterations ?? 0) || null,
          iterationLogHash: hash,
          matchesOnChainHash: matches,
          entries: matches ? entries.map((explanation, i) => ({ iteration: i + 1, explanation })) : [],
        });
      }
      const current = read(String(product.sellerContent?.metadataURI ?? ""));
      res.json({
        storeId,
        productId,
        currentVersion: product.version,
        iterationsTotal: Number(current.iterationsTotal ?? current.iterations ?? 0) || null,
        uploads: out,
        note:
          "Seller-written explanations of each development iteration — what was tried, tested, found wrong and " +
          "changed — without the code. Each log matches the hash committed on chain in that version's listing " +
          "(matchesOnChainHash). Unverified, like every seller claim: compare it with the demonstrations and " +
          "buyers' verdicts. A product listed before iteration logs existed has none.",
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/stores/:storeId/products/:productId",
    publicCache(15),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const doc = await Product.findOne({
        chainId,
        storeId: String(req.params.storeId).toLowerCase(),
        productId: String(req.params.productId).toLowerCase(),
      }).lean();
      if (!doc) {
        throw new ApiError("NOT_FOUND", "Product not found", 404, {
          storeId: req.params.storeId,
          productId: req.params.productId,
          howToFindIt:
            "productId is the 32-byte id the market shows under protocol.productId (the keccak of " +
            "the string you listed with), not the string itself. GET /api/v1/market/products?limit=50 " +
            "lists them; GET /api/v1/me lists your own.",
        });
      }
      const [item] = await decorateProducts(req, [doc as unknown as Record<string, unknown>]);
      res.json({ product: item, freshness: freshness(req.ctx) });
    })
  );

  router.get(
    "/market/products",
    publicCache(10),
    handler(async (req, res) => {
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) throw ApiError.invalid("Invalid query", { issues: parsed.error.issues });
      const q = parsed.data;
      const chainId = req.ctx.env.CHAIN_ID;

      const filter: Record<string, unknown> = { chainId, canonical: true, deleted: false };
      if (q.availability !== "any") filter.active = true;
      if (q.type) filter.storeType = q.type;
      if (q.store) filter.storeId = q.store;
      if (q.minPriceUSDC || q.maxPriceUSDC) {
        const range: Record<string, string> = {};
        if (q.minPriceUSDC) range.$gte = sortKey(q.minPriceUSDC);
        if (q.maxPriceUSDC) range.$lte = sortKey(q.maxPriceUSDC);
        filter.priceUSDCSort = range;
      }

      // Phase 10.1 declaration filters.
      if (q.declared === "true") filter["declaration.declared"] = true;
      if (q.declared === "false") filter["declaration.declared"] = false;
      if (q.basis) filter["declaration.basis"] = q.basis;
      if (q.declaredModelTier) filter["declaration.modelTier"] = q.declaredModelTier;
      if (q.minIterations) filter["sellerContent.profile.iterationsTotal"] = { $gte: q.minIterations };
      if (q.mode === "SERVICE") filter["sellerContent.profile.serviceSpecHash"] = { $ne: null };
      if (q.mode === "SALE") {
        filter.storeType = "sales";
        filter["sellerContent.profile.serviceSpecHash"] = null;
      }
      if (q.mode === "RENTAL") filter.storeType = "rentals";
      if (q.minTokensSavedPerUsdc || q.maxTokensSavedPerUsdc) {
        const range: Record<string, string> = {};
        if (q.minTokensSavedPerUsdc) range.$gte = perUsdcSortKey(q.minTokensSavedPerUsdc);
        if (q.maxTokensSavedPerUsdc) range.$lte = perUsdcSortKey(q.maxTokensSavedPerUsdc);
        filter["declaration.tokensSavedPerUsdcSort"] = range;
      }

      /*
       * Text search, across seller-written content only.
       *
       * That content is explicitly untrusted display data: a seller can write anything, and
       * matching it is not an endorsement of it. What the search must not do is pretend to be
       * ranked relevance — results stay in the requested sort order, so a seller cannot buy
       * position by stuffing its description with terms.
       *
       * Seller content is stored as one JSON string, so a targeted `name` or `description` search
       * anchors the pattern to that key inside the blob. It is a narrower net than a parsed field
       * would be, and it is honest about which half of the text it looked at, which the previous
       * undifferentiated regex was not.
       */
      const textClauses: Record<string, unknown>[] = [];

      if (q.q) {
        // Every term must appear somewhere. Capped, because each one costs a regex pass.
        for (const term of q.q.trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
          textClauses.push({ "sellerContent.metadataURI": { $regex: escapeRegex(term), $options: "i" } });
        }
      }
      if (q.name) {
        textClauses.push({
          "sellerContent.metadataURI": { $regex: jsonFieldRegex("name", q.name), $options: "i" },
        });
      }
      if (q.description) {
        textClauses.push({
          "sellerContent.metadataURI": { $regex: jsonFieldRegex("description", q.description), $options: "i" },
        });
      }
      if (textClauses.length > 0) filter.$and = textClauses;

      /*
       * Everything one wallet sells, resolved through the stores it controls.
       *
       * Products carry a storeId and not an owner, so this is a lookup rather than a field match.
       * It exists because "who else does this seller sell to" and "what else has this seller
       * built" are the two questions a buyer asks after one good purchase, and neither was
       * answerable without reading every store by hand.
       */
      if (q.seller) {
        const owned = await Store.find(
          { chainId, storeController: q.seller.toLowerCase() },
          { storeId: 1 }
        ).lean();
        // No stores means no products; an impossible filter is correct rather than ignoring it.
        filter.storeId = { $in: owned.map((st) => st.storeId) };
      }

      /*
       * Whether the product ships anything.
       *
       * A zero content hash is a listing that commits to no bytes. Buyers had no way to exclude
       * those except by paying and finding out.
       */
      if (q.hasDeliverable === "true") {
        filter.contentHash = { $nin: [null, "", ZERO_HASH] };
      } else if (q.hasDeliverable === "false") {
        filter.contentHash = { $in: [null, "", ZERO_HASH] };
      }

      if (q.revised === "true") filter.version = { $gt: 1 };
      else if (q.revised === "false") filter.version = { $lte: 1 };
      if (q.minVersion !== undefined) filter.version = { ...(filter.version as object ?? {}), $gte: q.minVersion };

      if (q.inventory === "unlimited") filter.unlimitedInventory = true;
      else if (q.inventory === "limited") filter.unlimitedInventory = false;

      if (q.minRentalPeriodSeconds !== undefined || q.maxRentalPeriodSeconds !== undefined) {
        const range: Record<string, number> = {};
        if (q.minRentalPeriodSeconds !== undefined) range.$gte = q.minRentalPeriodSeconds;
        if (q.maxRentalPeriodSeconds !== undefined) range.$lte = q.maxRentalPeriodSeconds;
        filter.rentalPeriodSeconds = range;
      }

      const createdRange: Record<string, number> = {};
      const asUnix = (value: string): number | null => {
        if (/^\d+$/.test(value)) return Number(value);
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
      };
      if (q.createdAfter) {
        const t = asUnix(q.createdAfter);
        if (t === null) throw ApiError.invalid("createdAfter must be unix seconds or an ISO timestamp");
        createdRange.$gte = t;
      }
      if (q.createdBefore) {
        const t = asUnix(q.createdBefore);
        if (t === null) throw ApiError.invalid("createdBefore must be unix seconds or an ISO timestamp");
        createdRange.$lte = t;
      }
      if (Object.keys(createdRange).length > 0) filter.createdAt = createdRange;

      if (q.affordableWithUSDC) {
        const [whole, frac = ""] = q.affordableWithUSDC.split(".");
        const base = BigInt(whole || "0") * 1_000_000n + BigInt((frac.padEnd(6, "0").slice(0, 6)) || "0");
        filter.priceUSDCSort = { ...((filter.priceUSDCSort as object) ?? {}), $lte: sortKey(base) };
      }

      /*
       * Evidence filters, each resolved to a set of ids before the main query.
       *
       * Deliberately separate round trips rather than one aggregation pipeline joined onto
       * products: they only run when asked for, they are readable, and a slow one can be
       * identified. Products carry no sales counters — sales live in the purchase and licence
       * projections — so this is a lookup either way.
       */
      const restrictToProducts = (ids: string[]): void => {
        const existing = filter.productId as { $in?: string[] } | undefined;
        const next = existing?.$in ? existing.$in.filter((id) => ids.includes(id)) : ids;
        filter.productId = { $in: next };
      };

      if (q.soldAtLeastOnce === "true" || q.minUnitsSold !== undefined) {
        const threshold = q.minUnitsSold ?? 1;
        const rows = await Purchase.aggregate([
          { $match: { chainId } },
          { $group: { _id: "$productId", units: { $sum: 1 } } },
          { $match: { units: { $gte: threshold } } },
        ]);
        restrictToProducts(rows.map((r: { _id: string }) => r._id));
      } else if (q.soldAtLeastOnce === "false") {
        const sold = await Purchase.distinct("productId", { chainId });
        filter.productId = { $nin: sold };
      }

      if (q.minDelivered !== undefined) {
        const rows = await License.aggregate([
          { $match: { chainId, delivered: { $gt: 0 } } },
          { $group: { _id: "$productId", n: { $sum: 1 } } },
          { $match: { n: { $gte: q.minDelivered } } },
        ]);
        restrictToProducts(rows.map((r: { _id: string }) => r._id));
      }

      if (q.minWorthItSignals !== undefined) {
        const rows = await BuyerSignalDoc.aggregate([
          { $match: { chainId, worthIt: true } },
          { $group: { _id: "$productId", n: { $sum: 1 } } },
          { $match: { n: { $gte: q.minWorthItSignals } } },
        ]);
        restrictToProducts(rows.map((r: { _id: string }) => r._id));
      }

      /*
       * Store-level conditions, resolved to store ids.
       *
       * `storeMinGrossUSDC` is the most useful filter here for a buyer deciding who to trust: a
       * store that has taken real money has been chosen by somebody, which no amount of description
       * can establish. (It counts every buyer, the owner included; who paid is in the purchases.)
       */
      const storeConditions: Record<string, unknown> = {};
      if (q.storeMinGrossUSDC) storeConditions.lifetimeGrossCommerceUSDC = { $gte: q.storeMinGrossUSDC };
      if (q.storeStatus && q.storeStatus !== "any") storeConditions.status = q.storeStatus;
      if (q.excludeSeller) storeConditions.storeController = { $ne: q.excludeSeller.toLowerCase() };

      if (Object.keys(storeConditions).length > 0) {
        const matching = await Store.find({ chainId, ...storeConditions }, { storeId: 1 }).lean();
        const ids = matching.map((st) => st.storeId);
        const existing = filter.storeId as { $in?: string[] } | string | undefined;
        if (typeof existing === "string") {
          filter.storeId = ids.includes(existing) ? existing : { $in: [] };
        } else if (existing?.$in) {
          filter.storeId = { $in: existing.$in.filter((id) => ids.includes(id)) };
        } else {
          filter.storeId = { $in: ids };
        }
      }

      /*
       * A published demonstration: the seller ran the product at listing time and attached the
       * real output. Matched on the marker the listing flow writes into seller content.
       */
      /*
       * The marker is now a STRUCTURE, and it is documented.
       *
       * This matched the word DEMONSTRATED, which "the listing flow" used to write — a client
       * command that no longer exists. No document said what the marker was, so no seller could
       * set it, and a field of buyers filtered on hasDemonstration=true against a market in which
       * nothing could ever match. The marker is now `demonstrations: [{input, output}]` inside the
       * metadataURI JSON, stated in the skill, the schema and the OpenAPI body; the old word is
       * still honoured so nothing already listed goes dark.
       */
      const DEMO = "\"demonstrations\"\\s*:\\s*\\[\\s*\\{";
      if (q.hasDemonstration === "true") {
        textClauses.push({
          $or: [
            { "sellerContent.metadataURI": { $regex: DEMO } },
            { "sellerContent.metadataURI": { $regex: "DEMONSTRATED", $options: "i" } },
          ],
        });
        filter.$and = textClauses;
      } else if (q.hasDemonstration === "false") {
        filter["sellerContent.metadataURI"] = {
          ...((filter["sellerContent.metadataURI"] as object) ?? {}),
          $not: new RegExp(`${DEMO}|DEMONSTRATED`, "i"),
        };
      }

      const limit = q.limit ?? 25;
      const sort = resolveSort(q.sort);

      // Cursor pagination on canonical creation order, never on a mutable updatedAt. [0.27.I]
      if (q.cursor && (q.sort ?? "newest") === "newest") {
        const decoded = decodeCursor(q.cursor);
        if (!decoded) throw ApiError.invalid("Malformed cursor");
        /*
         * Pushed onto $and rather than assigned to $or.
         *
         * The text search now builds its own clauses, and a bare `filter.$or = [...]` here would
         * silently coexist with them in a way mongo resolves as "matches the text OR is past the
         * cursor" — which would return the whole collection on page two of any search.
         */
        const pageClause = {
          $or: [
            { createdBlock: { $lt: decoded.blockNumber } },
            { createdBlock: decoded.blockNumber, createdLogIndex: { $lt: decoded.logIndex } },
          ],
        };
        filter.$and = [...((filter.$and as Record<string, unknown>[]) ?? []), pageClause];
      }

      const docs = await Product.find(filter).sort(sort).limit(limit + 1).lean();
      const hasMore = docs.length > limit;
      const page = docs.slice(0, limit);
      // A search for something nobody sells is published (anonymously) as unmet demand.
      if (docs.length === 0 && !q.cursor && (q.q || q.name || q.description)) {
        recordSearchMiss(chainId, String(q.q ?? q.name ?? q.description));
      }

      const items = await decorateProducts(req, page);

      res.json({
        items,
        pageInfo: {
          hasMore,
          nextCursor: hasMore ? page[page.length - 1]?.cursor ?? null : null,
          limit,
        },
        freshness: freshness(req.ctx),
      });
    })
  );

  /**
   * The 50 newest canonical active products across the protocol.
   * Ordering is canonical creation event order. An edit never makes a product new. [0.22.B]
   */
  router.get(
    "/products/recent",
    publicCache(5),
    handler(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? MAX_RECENT_PRODUCTS) || MAX_RECENT_PRODUCTS, MAX_RECENT_PRODUCTS);
      const chainId = req.ctx.env.CHAIN_ID;
      const safeBlock = req.ctx.indexerStatus().safeBlock;

      const docs = await Product.find({
        chainId,
        canonical: true,
        deleted: false,
        active: true,
        // A product first seen in an unsafe block never enters the canonical feed. [0.24.M]
        createdBlock: { $lte: safeBlock },
      })
        .sort({ createdBlock: -1, createdLogIndex: -1 })
        .limit(limit)
        .lean();

      res.json({
        items: await decorateProducts(req, docs),
        count: docs.length,
        maximum: MAX_RECENT_PRODUCTS,
        ordering: "canonical creation event order (createdBlock desc, createdLogIndex desc)",
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/products/:productId",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const doc = await Product.findOne({ chainId, productId: req.params.productId }).lean();
      if (!doc) throw ApiError.notFound("Product");

      const store = await Store.findOne({ chainId, storeId: doc.storeId }).lean();
      if (!store) throw ApiError.notFound("Store for product");

      const signals = await productSummary(doc.productId, doc.storeId, {
        chainId,
        minSignals: req.ctx.manifest.economics.minSignalsForRate,
      });
      const seller = await sellerSummary(store.storeController, {
        chainId,
        minSignals: req.ctx.manifest.economics.minSignalsForRate,
      });

      const market = await StockMarket.findOne({ chainId, aicToken: store.aicToken })
        .select({ aicToken: 1, name: 1, symbol: 1, decimals: 1 })
        .lean();
      const view = withYourModel(
        productView(doc as never, store.rewardPoolAIC, seller, market?.symbol ?? "", store as never),
        typeof req.query.model === "string" ? req.query.model : null
      );

      /*
       * Was this product listed before sellers actually uploaded their content?
       *
       * Until the cutoff, a listing committed a contentHash on chain and the bytes behind it were
       * never uploaded, so the gateway had nothing to deliver. Those listings are still here,
       * still valid, still purchasable — and still undeliverable, and no amount of reading the
       * description reveals it. A buyer had to pay to find out.
       *
       * The timestamp is the block time the product was created on chain, so this is checkable
       * without trusting this server: compare `createdAtUnix` against the cutoff yourself. The
       * verdict below is a convenience, not the evidence.
       */
      const deliverableFromUnix = Math.floor(Date.parse(DELIVERABLE_FROM) / 1000);
      const createdAtUnix = Number(doc.createdAt ?? 0);
      const predatesUploads = createdAtUnix > 0 && createdAtUnix < deliverableFromUnix;

      res.json({
        product: view,
        productSignals: signals,

        deliverability: {
          createdAtUnix,
          createdAt: createdAtUnix > 0 ? new Date(createdAtUnix * 1000).toISOString() : null,
          productsBecameDeliverableAt: DELIVERABLE_FROM,
          canBeDelivered: !predatesUploads,
          verdict: predatesUploads
            ? "DO NOT BUY. This product was listed before sellers uploaded their content. It " +
              "commits a contentHash on chain that no bytes were ever stored against, so paying " +
              "for it gives you a valid licence and nothing to collect."
            : "Listed after sellers began uploading content, so the gateway should have " +
              "something to deliver. Verify it on arrival anyway: keccak256 of the delivered " +
              "bytes must equal the product's contentHash.",
          checkThisYourself:
            "createdAtUnix is the block timestamp this product was created at, taken from the " +
            "chain rather than from this server's clock. Compare it against " +
            "productsBecameDeliverableAt without trusting the verdict above.",
        },

        store: storeView(store as never, undefined, market as never),
        purchaseGuidance: {
          note:
            "Obtain a fresh quote immediately before purchasing. It revalidates productVersion, " +
            "active status, inventory, price, rental terms, license policy and reward preview.",
          quoteEndpoint: `/api/v1/stores/${doc.storeId}/products/${doc.productId}/quote`,
          checkDeliverabilityFirst:
            "The `deliverability` block above says whether this product can be delivered at all. " +
            "A quote will happily price something the gateway cannot hand over.",
        },
        freshness: freshness(req.ctx),
      });
    })
  );

  /** Paginated canonical store list. */
  router.get(
    "/stores",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const limit = Math.min(Number(req.query.limit ?? 25) || 25, MAX_PAGE);
      const filter: Record<string, unknown> = { chainId, canonical: true };
      if (req.query.type === "sales" || req.query.type === "rentals") filter.storeType = req.query.type;
      if (typeof req.query.controller === "string") {
        filter.storeController = req.query.controller.toLowerCase();
      }
      if (req.query.status === "active" || req.query.status === "paused") {
        filter.status = req.query.status;
      }

      if (typeof req.query.cursor === "string") {
        const decoded = decodeCursor(req.query.cursor);
        if (!decoded) throw ApiError.invalid("Malformed cursor");
        filter.$or = [
          { createdBlock: { $lt: decoded.blockNumber } },
          { createdBlock: decoded.blockNumber, createdLogIndex: { $lt: decoded.logIndex } },
        ];
      }

      /*
       * Ordering, including by money — which is stored as a base-unit STRING.
       *
       * `lifetimeGrossCommerceUSDC` is a decimal string because a uint256 does not fit a BSON
       * number. Sorting it lexically would rank "9" above "10000000", so the money orderings run
       * through an aggregation that casts to Decimal128 first. The cheap orderings stay on the
       * plain indexed find, because paying for an aggregation to sort by block number would be
       * silly.
       *
       * Every ordering is over the WHOLE collection, not over the page: sorting a page after
       * fetching it is the bug this is written to avoid.
       */
      const sortParam = String(req.query.sort ?? "newest");

      /*
       * What the NEXT unit actually pays, which is the only incentive figure worth comparing.
       *
       * The pool size is not the answer. The protocol pays a fraction of the REMAINING pool per
       * unit and the fraction differs by store type by a factor of one hundred:
       *
       *   sales    2/1000   = 0.2%   of the remaining pool, per ITEM bought
       *   rentals  2/100000 = 0.002% of the remaining pool, per RENTAL PERIOD
       *
       * A rentals "unit" is a period of time, not a thing: `expiresAt = now + rentalPeriodSeconds
       * * periods`, so renting for longer buys more units and earns more. The rate is 100x lower
       * precisely because a rental repeats and can span many periods, so the same underlying
       * activity produces far more reward events than a one-off sale does.
       *
       * The two gates are NOT meaningful thresholds and must not be described as such. AIC has 18
       * decimals, so `poolGate` of 100,000 base units is 1e-13 AIC and `minimumPool` of 500 is
       * 5e-16 AIC — any pool a seller would plausibly fund clears both instantly. They exist to
       * stop the per-unit arithmetic rounding to zero, not to require a minimum deposit.
       *
       * So ranking stores by raw pool would rank them by the wrong number. The reward for one unit
       * is computed here from the protocol's own parameters, and that is what is ranked and shown.
       */
      const rewardRates = {
        sales: req.ctx.manifest.economics.salesRewardRate,
        rentals: req.ctx.manifest.economics.rentalsRewardRate,
      };
      const nextUnitReward = (pool: bigint, storeType: string): bigint => {
        const r = storeType === "rentals" ? rewardRates.rentals : rewardRates.sales;
        const gate = BigInt(r.poolGate);
        const min = BigInt(r.minimumPool);
        if (pool <= gate || pool < min) return 0n;
        return (pool * BigInt(r.numerator)) / BigInt(r.denominator);
      };

      /*
       * WHEN THIS STORE'S CONTROLLER MAY NEXT TAKE ITS MONEY OUT.
       *
       * StoreBase rate-limits owner withdrawals to one every WITHDRAWAL_COOLDOWN. That is not
       * decoration on a listing: for anyone weighing whether to hold a store's token, the gap
       * between the controller's withdrawals is the gap during which commerce accumulates inside
       * the store rather than leaving it. A store that withdrew a minute ago and a store that can
       * empty itself right now are different propositions, and until now a reader could not tell
       * them apart.
       *
       * `lastOwnerWithdrawalAt` of 0 means the controller has never withdrawn, and the first
       * withdrawal is always allowed - so there is no cooldown at all, not an elapsed one.
       */
      const cooldownSeconds = req.ctx.manifest.economics.ownerWithdrawalCooldownSeconds;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const withdrawalTimer = (store: Record<string, unknown>): Record<string, unknown> => ({
        ...withdrawalCooldownView({
          factoryVersion: Number(store.factoryVersion ?? 0),
          lastOwnerWithdrawalAt: Number(store.lastOwnerWithdrawalAt ?? 0),
          cooldownSeconds,
          nowSeconds,
        }),
        whatItMeans:
          "How long until this store's controller may next withdraw its proceeds. Commerce " +
          "arriving inside that gap stays in the store. It never affects the holder reserve, " +
          "which is not the controller's to withdraw at any point in the cycle.",
      });

      const MONEY_SORTS: Record<string, { field: string; dir: 1 | -1 }> = {
        commerce_desc: { field: "lifetimeGrossCommerceUSDC", dir: -1 },
        commerce_asc: { field: "lifetimeGrossCommerceUSDC", dir: 1 },
        unclaimed_desc: { field: "ownerAvailableUSDC", dir: -1 },
        /*
         * The holder reserve: what the store owes its token holders.
         *
         * `reserve_desc` ranks by USDC accrued for holders but not yet opened into a claimable
         * epoch — money that already belongs to whoever holds the token and is waiting to be
         * distributed. For anyone deciding what equity to buy this is the most direct figure
         * available: commerce says the business trades, and reserve says what that trade has
         * already set aside for its owners.
         *
         * `reserveLifetime_desc` ranks by everything ever accrued, which is the track record
         * rather than the pending balance.
         */
        /* The holders' share of commerce spent buying back and burning the store's AIC, lifetime. */
        buyback_desc: { field: "lifetimeBuybackUSDC", dir: -1 },
        // Earlier names, kept as aliases: the reserve they ranked by is now the buyback.
        reserve_desc: { field: "lifetimeBuybackUSDC", dir: -1 },
        reserveLifetime_desc: { field: "lifetimeBuybackUSDC", dir: -1 },
      };

      /*
       * Near and far on the withdrawal clock.
       *
       * Sorting on `lastOwnerWithdrawalAt` gives exactly the same order as sorting on the derived
       * `nextWithdrawalAllowedAt`, because the cooldown added to it is the same constant for every
       * store. Sorting on the stored field keeps the ordering inside the database over every
       * store, which is the property that matters, instead of computing a countdown per row and
       * ranking a single page of it.
       *
       * A store that has never withdrawn has 0, which sorts first under `timer_asc` — and that is
       * correct, not an artefact: it is the most available store there is.
       */
      const TIMER_SORTS: Record<string, 1 | -1> = {
        withdrawalTimer_asc: 1,
        withdrawalTimer_desc: -1,
      };

      let docs: Record<string, unknown>[];
      if (sortParam === "incentive_desc" || sortParam === "incentive_asc") {
        /*
         * Ranked on the COMPUTED next-unit reward, not on a stored field.
         *
         * The value depends on storeType, so it cannot be a plain index; and it is derived from
         * two numbers already on the document, so it does not need to be. Every canonical store is
         * loaded, ranked, and then paged — the ordering is over the whole collection, which is the
         * property that matters. Store counts here are in the hundreds, not millions.
         */
        const all = (await Store.find(filter).lean()) as Record<string, unknown>[];
        const dir = sortParam === "incentive_desc" ? -1 : 1;
        docs = all
          .map((d) => ({
            d,
            reward: nextUnitReward(BigInt(String(d.rewardPoolAIC ?? "0")), String(d.storeType ?? "sales")),
          }))
          .sort((a, b) => (a.reward === b.reward ? 0 : a.reward > b.reward ? -dir : dir))
          .slice(0, limit + 1)
          .map((x) => x.d);
      } else if (TIMER_SORTS[sortParam]) {
        docs = (await Store.find(filter)
          .sort({ lastOwnerWithdrawalAt: TIMER_SORTS[sortParam]!, createdBlock: -1, createdLogIndex: -1 })
          .limit(limit + 1)
          .lean()) as Record<string, unknown>[];
      } else if (MONEY_SORTS[sortParam]) {
        const { field, dir } = MONEY_SORTS[sortParam]!;
        docs = (await Store.aggregate([
          { $match: filter },
          {
            $addFields: {
              // Empty and malformed values sort as zero rather than failing the whole query.
              _amount: {
                $convert: { input: `$${field}`, to: "decimal", onError: 0, onNull: 0 },
              },
            },
          },
          { $sort: { _amount: dir, createdBlock: -1, createdLogIndex: -1 } },
          { $limit: limit + 1 },
          { $project: { _amount: 0 } },
        ])) as Record<string, unknown>[];
      } else {
        const order: Record<string, 1 | -1> =
          sortParam === "oldest"
            ? { createdBlock: 1, createdLogIndex: 1 }
            : sortParam === "name_asc"
              ? { "sellerContent.name": 1, createdBlock: -1 }
              : { createdBlock: -1, createdLogIndex: -1 };
        docs = (await Store.find(filter).sort(order).limit(limit + 1).lean()) as Record<string, unknown>[];
      }

      const hasMore = docs.length > limit;
      const page = docs.slice(0, limit);

      const pageTokens = page.map((s) => String(s.aicToken ?? ""));
      const tokens = await StockMarket.find({ chainId, aicToken: { $in: pageTokens } })
        .select({ aicToken: 1, name: 1, symbol: 1, decimals: 1, phase: 1, lpCreated: 1, realUSDCReserve: 1, netSoldFromCurveAIC: 1, currentIndexedPrice1e18: 1, pair: 1 })
        .lean();
      const tokenByAddress = new Map(tokens.map((t) => [t.aicToken, t]));

      const overviewOf = await storeOverviews(req, page, tokens);

      res.json({
        items: page.map((s) => {
          const pool = BigInt(String(s.rewardPoolAIC ?? "0"));
          const tk = tokenByAddress.get(String(s.aicToken ?? ""));
          const overview = overviewOf.get(String(s.storeId));
          const type = String(s.storeType ?? "sales");
          const rate = type === "rentals" ? rewardRates.rentals : rewardRates.sales;
          return {
            ...storeView(s as never, undefined, tokenByAddress.get(String(s.aicToken ?? "")) as never),
            overview,
            tokenMarketState: (() => {
              const t = tokenByAddress.get(String(s.aicToken ?? ""));
              return t ? marketStateOf(t as Record<string, unknown>) : null;
            })(),
            /*
             * Published because it is what a buyer is actually choosing between, and because a
             * list that can be SORTED by a number has to SHOW it.
             */
            controllerWithdrawal: withdrawalTimer(s),
            customerIncentive: {
              // In the store's own token symbol (ATLS, EUSD…), not the generic "AIC".
              poolAIC: amountAIC(pool, (tk as { symbol?: string } | undefined)?.symbol || undefined),
              nextUnitRewardAIC: amountAIC(nextUnitReward(pool, type), (tk as { symbol?: string } | undefined)?.symbol || undefined),
              unitMeans:
                type === "rentals"
                  ? "one RENTAL PERIOD. Renting for longer buys more units and earns more."
                  : "one item bought.",
              ratePerUnit: `${rate.numerator}/${rate.denominator} of the REMAINING pool`,
              decay:
                "Geometric: each unit takes its share of what is left, so the reward shrinks with " +
                "every purchase and the pool is never exhausted outright.",
              rentalsAreSlower:
                "Rentals pay 2/100000 per period against sales' 2/1000 — 100x lower — because a " +
                "rental repeats and can span many periods for the same underlying activity.",
            },
          };
        }),
        pageInfo: { hasMore, nextCursor: hasMore ? String(page[page.length - 1]?.cursor ?? "") || null : null, limit },
        ordering: {
          applied: sortParam,
          means:
            {
              newest: "creation event order, newest first",
              oldest: "creation event order, oldest first",
              commerce_desc: "lifetime gross commerce, descending — the busiest businesses first",
              commerce_asc: "lifetime gross commerce, ascending",
              reserve_desc:
                "holder reserve accrued and not yet distributed, descending — what the store " +
                "already owes its token holders",
              reserveLifetime_desc: "holder reserve accrued over the store's whole life, descending",
              unclaimed_desc: "USDC sitting unclaimed for the controller, descending",
              name_asc: "seller-written store name, A to Z (untrusted text)",
              incentive_desc:
                "what the NEXT unit would pay a buyer in AIC, descending — computed from the " +
                "pool and the store type, not the raw pool size",
              incentive_asc: "the same, ascending",
              withdrawalTimer_asc:
                "controller withdrawal timer, NEAREST first — stores whose controller may take " +
                "proceeds out soonest (a store that has never withdrawn may do so immediately)",
              withdrawalTimer_desc:
                "controller withdrawal timer, FURTHEST first — stores that just withdrew and must " +
                "now let proceeds accumulate for the whole cooldown",
            }[sortParam] ?? "creation event order, newest first",
          options: [
            "newest", "oldest", "commerce_desc", "commerce_asc",
            "reserve_desc", "reserveLifetime_desc", "unclaimed_desc", "name_asc",
            "incentive_desc", "incentive_asc",
            "withdrawalTimer_asc", "withdrawalTimer_desc",
          ],
          alsoFilterable: ["type=sales|rentals", "status=active|paused", "controller=<wallet>"],
          sortedAcrossEveryStore:
            "Ordering is applied in the database over every store, not over the page returned.",
          forDecidingWhereToInvest:
            "commerce_desc ranks by money that actually moved through the store, which is the " +
            "only figure here that a seller cannot write for itself. Each row carries its own " +
            "accounting and its token address, so a promising row can be acted on directly.",
        },
        freshness: freshness(req.ctx),
      });
    })
  );

  /** The 10 newest canonical stores with their canonical AIC identity. [0.22.C] */
  router.get(
    "/stores/recent",
    publicCache(5),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const limit = Math.min(Number(req.query.limit ?? MAX_RECENT_STORES) || MAX_RECENT_STORES, MAX_RECENT_STORES);
      const safeBlock = req.ctx.indexerStatus().safeBlock;

      const stores = await Store.find({ chainId, canonical: true, createdBlock: { $lte: safeBlock } })
        .sort({ createdBlock: -1, createdLogIndex: -1 })
        .limit(limit)
        .lean();

      const markets = await StockMarket.find({
        chainId,
        aicToken: { $in: stores.map((s) => s.aicToken) },
      }).lean();
      const marketByToken = new Map(markets.map((m) => [m.aicToken, m]));
      const overviewOf = await storeOverviews(req, stores as never, markets as never);

      res.json({
        items: stores.map((s) => ({
          ...storeView(s as never, undefined, marketByToken.get(s.aicToken) as never),
          overview: overviewOf.get(String(s.storeId)),
          aic: marketByToken.has(s.aicToken)
            ? marketView(
                marketByToken.get(s.aicToken) as never,
                req.ctx.manifest.economics.transitionThresholdAIC,
                s as never,
                req.ctx.manifest.economics.virtualUSDCReserve
              )
            : null,
        })),
        count: stores.length,
        maximum: MAX_RECENT_STORES,
        ordering: "canonical creation event order (createdBlock desc, createdLogIndex desc)",
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/stores/:storeId",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const store = await Store.findOne({ chainId, storeId: req.params.storeId }).lean();
      if (!store) throw ApiError.notFound("Store");

      const market = await StockMarket.findOne({ chainId, aicToken: store.aicToken }).lean();
      const signals = await storeSummary(store.storeId, {
        chainId,
        minSignals: req.ctx.manifest.economics.minSignalsForRate,
      });

      const capital = (await capitalSourcesFor(chainId, [String(store.aicToken)])).get(String(store.aicToken).toLowerCase());
      res.json({
        capitalSources: capital ?? null,
        store: storeView(store as never, signals, market as never),
        aic: market
          ? marketView(
              market as never,
              req.ctx.manifest.economics.transitionThresholdAIC,
              store as never,
              req.ctx.manifest.economics.virtualUSDCReserve
            )
          : null,
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/stores/:storeId/products",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) throw ApiError.invalid("Invalid query", { issues: parsed.error.issues });

      const filter: Record<string, unknown> = {
        chainId,
        storeId: req.params.storeId,
        canonical: true,
        deleted: false,
      };
      if (parsed.data.availability !== "any") filter.active = true;
      if (parsed.data.declared === "true") filter["declaration.declared"] = true;
      if (parsed.data.declared === "false") filter["declaration.declared"] = false;
      if (parsed.data.basis) filter["declaration.basis"] = parsed.data.basis;
      if (parsed.data.declaredModelTier) filter["declaration.modelTier"] = parsed.data.declaredModelTier;
      if (parsed.data.minIterations) filter["sellerContent.profile.iterationsTotal"] = { $gte: parsed.data.minIterations };

      const limit = parsed.data.limit ?? 50;
      const docs = await Product.find(filter).sort(resolveSort(parsed.data.sort)).limit(limit).lean();

      res.json({
        items: await decorateProducts(req, docs),
        freshness: freshness(req.ctx),
      });
    })
  );

  /**
   * Aggregated Agent bootstrap read. It reuses the exact same services as the standalone
   * endpoints, so the two can never diverge, and performs no RPC fan-out. [0.22.D, 0.25.U]
   */
  router.get(
    "/discovery",
    publicCache(5),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const safeBlock = req.ctx.indexerStatus().safeBlock;

      const [products, stores] = await Promise.all([
        Product.find({ chainId, canonical: true, deleted: false, active: true, createdBlock: { $lte: safeBlock } })
          .sort({ createdBlock: -1, createdLogIndex: -1 })
          .limit(MAX_RECENT_PRODUCTS)
          .lean(),
        Store.find({ chainId, canonical: true, createdBlock: { $lte: safeBlock } })
          .sort({ createdBlock: -1, createdLogIndex: -1 })
          .limit(MAX_RECENT_STORES)
          .lean(),
      ]);

      const markets = await StockMarket.find({
        chainId,
        aicToken: { $in: stores.map((s) => s.aicToken) },
      }).lean();
      const marketByToken = new Map(markets.map((m) => [m.aicToken, m]));

      res.json({
        protocol: {
          chainId,
          protocolVersion: req.ctx.manifest.protocolVersion,
          environment: req.ctx.manifest.environment,
          schema: "/api/v1/schema",
          contracts: "/api/v1/contracts",
        },
        /*
         * Every store has a token, and the business behind it is readable: this is the path from a list of
         * AICs to the facts behind one and the cost of trading it. Facts only; what to do is the reader's call.
         */
        services: {
          whatItIs:
            "Callable capabilities sold per call: send input, get output, pay again when needed. Calls are prepaid on " +
            "chain as units and settle as ordinary store commerce. You need an API key and USDC, not AIC or a store.",
          list: { call: "GET /api/v1/services", returns: "every active service: input/output schemas, price per call, evidence, business, how to invoke" },
          invoke: { call: "POST /api/v1/services/{storeId}/{productId}/invoke {input, prepayCalls?}", needs: "API key + Idempotency-Key" },
          metrics: { call: "GET /api/v1/services/{storeId}/{productId}/metrics", returns: "calls, customers, repeat customers, commerce, latency, buyback, burn" },
          mcp: { call: "POST /mcp", returns: "the services as MCP tools (initialize, tools/list, tools/call)" },
        },
        stockMarket: {
          whatItIs:
            "Every store has its own AIC, traded on its bonding curve (or its DEX pool after graduation). Store commerce " +
            "causes a protocol-controlled buyback and burn of that store's AIC. These calls show each AIC's market and the " +
            "business behind it.",
          marketStocks: { call: "GET /api/v1/market/stocks?sort=commerce_growth_desc&limit=20", returns: "one compact row per AIC: price, market cap, supply, liquidity, volume, price change, commerce, buyback, customers, products, holders" },
          stockFundamentals: { call: "GET /api/v1/stocks/{aicToken}/fundamentals", returns: "stock, market, business, buyback and descriptive valuation ratios for one AIC" },
          stockHistory: { call: "GET /api/v1/stocks/{aicToken}/history?interval=15m", returns: "compact points: price, commerce, buyback, AIC burned, volume" },
          stockQuote: { call: "POST /api/v1/stocks/{aicToken}/quote {\"side\": \"buy\" | \"sell\", \"amount\": \"<base units>\"}", returns: "execution price, price impact, immediate sell value, and the business context" },
          stockBuy: { call: "POST /api/v1/stocks/{aicToken}/buy", returns: "a transaction to sign" },
          stockSell: { call: "POST /api/v1/stocks/{aicToken}/sell", returns: "a transaction to sign" },
        },
        newestProducts: await decorateProducts(req, products),
        newestStores: stores.map((s) => ({
          ...storeView(s as never, undefined, marketByToken.get(s.aicToken) as never),
          aic: marketByToken.has(s.aicToken)
            ? marketView(
                marketByToken.get(s.aicToken) as never,
                req.ctx.manifest.economics.transitionThresholdAIC,
                s as never,
                req.ctx.manifest.economics.virtualUSDCReserve
              )
            : null,
        })),
        nextSteps: [
          "GET /api/v1/contracts to confirm every address you intend to touch is canonical",
          "GET /api/v1/market/stocks to see every store AIC with its market and business figures",
          "POST a quote before any purchase; never execute from a discovery feed",
        ],
        freshness: freshness(req.ctx),
      });
    })
  );

  /**
   * Every store token in one page: identity, description, logo and live curve state.
   *
   * This is the read behind the human token market. Each store mints its OWN ERC20, so the
   * rows are distinct assets that merely share a mechanism; `token.symbol` is seller-chosen
   * display text and the address is the only identity. Ordering is lifetime traded volume,
   * which is protocol accounting, never a buyer signal figure. [14A.2]
   */
  router.get(
    "/market/tokens",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, MAX_PAGE);

      /*
       * Ordering a market list by things a buyer of equity would actually rank on.
       *
       * This offered exactly two orders — newest, and "volume" which really meant last activity.
       * Neither answers the question an agent deciding where to put capital is asking: which of
       * these businesses is doing trade, which has real money behind its token, and how far along
       * its curve is it.
       *
       * The money fields are base-unit STRINGS (a uint256 does not fit a BSON number), so ordering
       * them lexically would rank "9" above "10000000". Those orders run through an aggregation
       * that casts to Decimal128. `price` is not stored at all — it is reserve over reserve — so
       * it is computed in the pipeline rather than sorted in memory over one page.
       */
      /*
       * `volume` used to fetch by last-activity and then sort the PAGE by lifetime volume, which
       * orders fifty rows and calls it a ranking. It now maps to the collection-wide ordering.
       */
      const raw = String(req.query.sort ?? "volume");
      const sortParam = raw === "volume" ? "volume_desc" : raw;
      // Price sorts use the indexed price, which follows the curve and, after graduation, the pool;
      // the curve's virtual reserves freeze at the transition and would rank a graduated token wrong.
      const COMPUTED: Record<string, { expr: Record<string, unknown>; dir: 1 | -1 }> = {
        volume_desc: { expr: { $convert: { input: "$lifetimeGrossVolumeUSDC", to: "decimal", onError: 0, onNull: 0 } }, dir: -1 },
        reserve_desc: { expr: { $convert: { input: "$realUSDCReserve", to: "decimal", onError: 0, onNull: 0 } }, dir: -1 },
        price_desc: { expr: { $convert: { input: "$currentIndexedPrice1e18", to: "decimal", onError: 0, onNull: 0 } }, dir: -1 },
        price_asc: { expr: { $convert: { input: "$currentIndexedPrice1e18", to: "decimal", onError: 0, onNull: 0 } }, dir: 1 },
      };

      /*
       * Ordering by the reserve that pays DIVIDENDS, which lives on the store, not the market.
       *
       * `reserve_desc` below ranks by the curve's real USDC — that is LIQUIDITY, what the market
       * can pay when a holder sells a position. It is a real question and a different one. What an
       * agent buying equity to HOLD wants is the holder reserve: the share of net commerce the
       * store has already set aside for its token holders and will distribute through a dividend
       * epoch. The two can point in opposite directions — a curve can be thin while the business
       * behind it is accruing steadily.
       *
       * The figure is on the Store document, so this joins it. The join happens before the sort,
       * so the ordering is still over every market rather than over a fetched page.
       */
      const STORE_SORTS: Record<string, { field: string; dir: 1 | -1 }> = {
        /* The store's lifetime buyback: the holders' share of its commerce, spent burning its AIC. */
        buyback_desc: { field: "lifetimeBuybackUSDC", dir: -1 },
        // Earlier names, kept as aliases of the buyback that replaced the dividend reserve.
        dividendReserve_desc: { field: "lifetimeBuybackUSDC", dir: -1 },
        dividendReserveLifetime_desc: { field: "lifetimeBuybackUSDC", dir: -1 },
        storeCommerce_desc: { field: "lifetimeGrossCommerceUSDC", dir: -1 },
        /*
         * The controller withdrawal clock of the business this AIC owns.
         *
         * It joins through the same pipeline as the money figures because it is the same kind of
         * fact: something true of the business, not of the curve. For a holder it is the window
         * during which commerce stays inside the store instead of leaving it, which is what the
         * holder reserve accrues against.
         *
         * Ranking on `lastOwnerWithdrawalAt` orders identically to ranking on the derived
         * countdown, since the cooldown added to it is one constant for every store.
         */
        withdrawalTimer_asc: { field: "lastOwnerWithdrawalAt", dir: 1 },
        withdrawalTimer_desc: { field: "lastOwnerWithdrawalAt", dir: -1 },
      };

      let markets: Record<string, unknown>[];
      if (STORE_SORTS[sortParam]) {
        const { field, dir } = STORE_SORTS[sortParam]!;
        markets = (await StockMarket.aggregate([
          { $match: { chainId } },
          {
            $lookup: {
              from: "stores",
              let: { sid: "$storeId" },
              pipeline: [
                { $match: { $expr: { $and: [{ $eq: ["$storeId", "$$sid"] }, { $eq: ["$chainId", chainId] }] } } },
                { $project: { [field]: 1 } },
              ],
              as: "_store",
            },
          },
          {
            $addFields: {
              _rank: {
                $convert: {
                  input: { $arrayElemAt: [`$_store.${field}`, 0] },
                  to: "decimal",
                  onError: 0,
                  onNull: 0,
                },
              },
            },
          },
          { $sort: { _rank: dir, createdBlock: -1 } },
          { $limit: limit },
          { $project: { _rank: 0, _store: 0 } },
        ])) as Record<string, unknown>[];
      } else if (COMPUTED[sortParam]) {
        const { expr, dir } = COMPUTED[sortParam]!;
        markets = (await StockMarket.aggregate([
          { $match: { chainId } },
          { $addFields: { _rank: expr } },
          { $sort: { _rank: dir, createdBlock: -1 } },
          { $limit: limit },
          { $project: { _rank: 0 } },
        ])) as Record<string, unknown>[];
      } else {
        const order: Record<string, 1 | -1> =
          sortParam === "newest"
            ? { createdBlock: -1, createdLogIndex: -1 }
            : sortParam === "oldest"
              ? { createdBlock: 1, createdLogIndex: 1 }
              : sortParam === "progress_desc"
                ? { netSoldPercentageBps: -1, createdBlock: -1 }
                : sortParam === "progress_asc"
                  ? { netSoldPercentageBps: 1, createdBlock: -1 }
                  : { lastActivityAt: -1 };
        markets = (await StockMarket.find({ chainId }).sort(order).limit(limit).lean()) as Record<string, unknown>[];
      }

      const stores = await Store.find({ chainId, storeId: { $in: markets.map((m) => m.storeId) } }).lean();
      const storeById = new Map(stores.map((st) => [st.storeId, st]));

      /*
       * The last few fills per market, in ONE query rather than one per token.
       *
       * A price says where a market is; the recent fills say whether anybody is there and which
       * side they took. Fetching that per token would be an N+1 on a list endpoint, so this pulls
       * a single bounded window across every token on the page and groups it in memory. Curve
       * fills and pool swaps come back together because they are the same collection — a market
       * whose recent rows switch from `curve` to `dex` is showing its graduation directly.
       */
      const tokensOnPage = markets.map((m) => m.aicToken);
      const recent = await StockTrade.find({ chainId, aicToken: { $in: tokensOnPage } })
        .sort({ blockNumber: -1, logIndex: -1 })
        .limit(tokensOnPage.length * 8)
        .lean();

      const recentByToken = new Map<string, Record<string, unknown>[]>();
      for (const t of recent) {
        const key = String(t.aicToken).toLowerCase();
        const list = recentByToken.get(key) ?? [];
        if (list.length >= 5) continue;
        list.push({
          at: Number(t.at),
          when: new Date(Number(t.at) * 1000).toISOString(),
          venue: t.venue ?? "curve",
          side: t.side,
          trader: t.trader,
          tokensAIC: amountAIC(BigInt(t.tokensAIC ?? "0")),
          grossUSDC: amountUSDC(BigInt(t.grossUSDC ?? "0")),
          pricePerTokenUSDC: (Number(t.pricePerToken1e18 ?? "0") / 1e18).toPrecision(6),
          txHash: t.txHash,
        });
        recentByToken.set(key, list);
      }

      /*
       * Derived per request, never stored: a countdown is only true at the instant it is read.
       * `lastOwnerWithdrawalAt === 0` means the controller has never withdrawn, which is no
       * cooldown rather than an elapsed one.
       */
      const tokenCooldownSeconds = req.ctx.manifest.economics.ownerWithdrawalCooldownSeconds;
      const tokenNowSeconds = Math.floor(Date.now() / 1000);
      const tokenWithdrawalTimer = (store: Record<string, unknown> | undefined) =>
        store
          ? withdrawalCooldownView({
              factoryVersion: Number(store.factoryVersion ?? 0),
              lastOwnerWithdrawalAt: Number(store.lastOwnerWithdrawalAt ?? 0),
              cooldownSeconds: tokenCooldownSeconds,
              nowSeconds: tokenNowSeconds,
            })
          : null;

      const capitalByToken = await capitalSourcesFor(chainId, markets.map((m) => String(m.aicToken)));
      const items = markets.map((m) => {
        const store = storeById.get(String(m.storeId ?? ""));
        return {
          capitalSources: capitalByToken.get(String(m.aicToken).toLowerCase()) ?? null,
          ...marketView(
            m as never,
            req.ctx.manifest.economics.transitionThresholdAIC,
            store as never,
            req.ctx.manifest.economics.virtualUSDCReserve
          ),
          store: store ? storeCard(store as never, String(m.symbol ?? "")) : null,
          /*
           * The dividend reserve, published beside the token it belongs to.
           *
           * A list that can be ORDERED by a number must SHOW that number, or the ordering looks
           * broken: sorting by dividend reserve and then displaying only curve liquidity produced
           * a page whose rows appeared to be in no order at all. `storeCard` is a deliberately
           * small view for product listings, so the figure is added here rather than widening it
           * everywhere.
           */
          /*
           * The same countdown the store list publishes, on the token row too.
           *
           * Someone choosing a token to hold is choosing a business, and the cadence at which that
           * business's controller can take money out of it is part of what they are choosing. It
           * is sortable here, so it is shown here.
           */
          controllerWithdrawal: tokenWithdrawalTimer(store as Record<string, unknown> | undefined),
          buyback: {
            lifetimeUSDC: amountUSDC(BigInt(String(m.lifetimeBuybackUSDC ?? "0"))),
            burnedAIC: amountAIC(BigInt(String(m.buybackBurnedAIC ?? "0")), String(m.symbol ?? "")),
            pendingUSDC: amountUSDC(BigInt(String(m.pendingBuybackUSDC ?? "0"))),
            storeLifetimeCommerceUSDC: amountUSDC(BigInt(String(store?.lifetimeGrossCommerceUSDC ?? "0"))),
            whatItIs:
              "20% of the store's net commerce, spent in each purchase transaction buying this token on its " +
              "market and burning it: supply falls and the price rises with the business's sales. Nothing " +
              "to hold back, distribute or claim.",
          },
          lifetimeGrossVolumeUSDC: String(m.lifetimeGrossVolumeUSDC ?? "0"),
          recentTrades: recentByToken.get(String(m.aicToken).toLowerCase()) ?? [],
          tradesEndpoint: `/api/v1/market/tokens/${m.aicToken}/trades`,
          recentTradesEndpoint: `/api/v1/market/tokens/${m.aicToken}/recent-trades`,
        };
      });

      /*
       * No re-sorting here. The database ordered the whole collection; re-ordering the page would
       * only rearrange the fifty rows that survived that ordering, which is not a ranking.
       */

      res.json({
        items,
        ordering: {
          applied: sortParam,
          means:
            {
              newest: "creation event order, newest first",
              oldest: "creation event order, oldest first",
              volume_desc: "lifetime gross traded volume, descending",
              reserve_desc:
                "real USDC held by the CURVE, descending — liquidity, what the market can pay you " +
                "when you sell a position. Not the dividend reserve.",
              buyback_desc:
                "USDC the store's commerce has spent buying back and burning this token, lifetime, descending",
              storeCommerce_desc: "lifetime gross commerce of the business this AIC owns, descending",
              withdrawalTimer_asc:
                "controller withdrawal timer of the business this AIC owns, NEAREST first",
              withdrawalTimer_desc:
                "controller withdrawal timer of the business this AIC owns, FURTHEST first — the " +
                "stores that just paid themselves and must now accumulate for a full cooldown",
              price_desc: "spot price per token, highest first",
              price_asc: "spot price per token, lowest first",
              progress_desc: "how far along its bonding curve, nearest to graduation first",
              progress_asc: "how far along its bonding curve, least sold first",
              active: "most recent trade first",
            }[sortParam] ?? "most recent trade first",
          options: [
            "newest", "oldest", "volume_desc",
            "buyback_desc", "storeCommerce_desc",
            "withdrawalTimer_asc", "withdrawalTimer_desc",
            "reserve_desc", "price_desc", "price_asc", "progress_desc", "progress_asc", "active",
          ],
          twoDifferentFigures:
            "reserve_desc is the CURVE's liquidity — what it can pay you on the way out. " +
            "buyback_desc is what the STORE's commerce has spent buying back and burning the token — " +
            "the business's sales turned into a smaller supply.",
          sortedAcrossTheWholeMarket:
            "Ordering is applied in the database over every token, not over the page returned. A " +
            "page sorted after it was fetched would only rearrange the rows that survived a " +
            "different ordering.",
        },
        pricing: {
          model: "constant product over virtual reserves",
          note:
            "Price is an on-chain function of the curve state, not an order book. There are no " +
            "bids, no asks and no counterparty: the store contract is always the counterparty " +
            "until the one-way DEX transition completes.",
        },
        freshness: freshness(req.ctx),
      });
    })
  );

  /**
   * Raw trade history for one store token, oldest first.
   *
   * Returned as individual swaps rather than pre-bucketed candles on purpose: a candle is a
   * presentation choice (bucket size, timezone, carry-forward) and baking one into the API
   * would make the server the authority on a chart. Every row here is a canonical on-chain
   * event, so any client can rebuild any aggregation and get the same answer.
   */
  /**
   * The last trades in one market, newest first, across BOTH venues.
   *
   * The existing series endpoint answers "draw me a chart": ascending, padded with price samples
   * so a quiet market does not render as a broken line. That is the wrong shape for the question
   * a buyer or an agent actually asks — "what just happened here, and who did it?" — which wants
   * the most recent events, in reverse order, with nothing synthetic mixed in.
   *
   * Curve fills and pool swaps are one collection by design, so they merge here without being
   * stitched together. They are NOT interchangeable, though, and the `venue` on each row says
   * which is which: a curve fill pays protocol and store-owner fees and moves along a bonding
   * curve, while a pool swap pays the venue's own fee and moves against real reserves. After a
   * market graduates the curve stops trading entirely, so a market whose recent history switches
   * from "curve" to "dex" is showing you that transition rather than a change in activity.
   */
  router.get(
    "/market/tokens/:aicToken/recent-trades",
    publicCache(5),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const token = String(req.params.aicToken || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(token)) throw ApiError.invalid("Malformed token address");

      const market = await StockMarket.findOne({ chainId, aicToken: token }).lean();
      if (!market) throw ApiError.notFound("Token market");

      const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
      const venue = String(req.query.venue ?? "").toLowerCase();

      const filter: Record<string, unknown> = { chainId, aicToken: token };
      if (venue === "curve" || venue === "dex") filter.venue = venue;
      /*
       * Paging backwards through the whole history: `before=<blockNumber>:<logIndex>` returns the
       * trades strictly older than that fill. A cursor on the chain position, not an offset, so new
       * trades arriving while someone scrolls never shift or repeat a page.
       */
      const before = String(req.query.before ?? "");
      if (before) {
        const m = /^(\d+):(\d+)$/.exec(before);
        if (!m) throw ApiError.invalid("before must be <blockNumber>:<logIndex>, as returned in nextBefore");
        const b = Number(m[1]);
        const li = Number(m[2]);
        filter.$or = [{ blockNumber: { $lt: b } }, { blockNumber: b, logIndex: { $lt: li } }];
      }

      const page = await StockTrade.find(filter)
        .sort({ blockNumber: -1, logIndex: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = page.length > limit;
      const rows = hasMore ? page.slice(0, limit) : page;
      const oldest = rows[rows.length - 1];
      const nextBefore = hasMore && oldest ? `${oldest.blockNumber}:${oldest.logIndex}` : null;

      const { pnl, markPrice1e30 } = await pnlForTrades(
        chainId,
        token,
        rows.map((r) => ({ txHash: String(r.txHash), logIndex: Number(r.logIndex), trader: String(r.trader) })),
        {
          protocolBps: Number(req.ctx.manifest.economics.agentGoodsProtocolFeeBps ?? 0),
          controllerBps: Number(req.ctx.manifest.economics.agentGoodsControllerFeeBps ?? 0),
        }
      );

      const counts = { curve: 0, dex: 0 };
      for (const r of rows) {
        if (r.venue === "dex") counts.dex++;
        else counts.curve++;
      }

      res.json({
        aicToken: token,
        symbol: market.symbol ?? null,
        counts: { returned: rows.length, ...counts },
        nextBefore,
        paging: "Pass ?before=<nextBefore> for the next older page; nextBefore is null at the first trade.",
        venues: {
          curve:
            "Filled against the bonding curve. Pays a protocol fee and a store-owner fee, and " +
            "moves the curve price. Closed once the market graduates.",
          dex:
            "Filled against the external pool. Pays that venue's own fee and NOTHING to this " +
            "protocol, and moves against real reserves rather than a curve.",
          note:
            "Both are real trades in the same token and both are included here. They are not " +
            "priced by the same mechanism, so compare them by price, not by assuming one venue.",
        },
        items: rows.map((r) => ({
          at: Number(r.at),
          when: new Date(Number(r.at) * 1000).toISOString(),
          venue: r.venue ?? "curve",
          side: r.side,
          trader: r.trader,
          tokensAIC: amountAIC(BigInt(r.tokensAIC ?? "0")),
          grossUSDC: amountUSDC(BigInt(r.grossUSDC ?? "0")),
          netUSDC: amountUSDC(BigInt(r.netUSDC ?? "0")),
          pricePerTokenUSDC: (Number(r.pricePerToken1e18 ?? "0") / 1e18).toPrecision(6),
          pnl: pnl.get(`${r.txHash}:${r.logIndex}`) ?? { kind: "unavailable", reason: "NOT_INDEXED" },
          /* The store's commerce buying back its own AIC to burn — protocol mechanics, not a trader. */
          ...((r as { buyback?: boolean }).buyback ? { buyback: true } : {}),
          txHash: r.txHash,
          blockNumber: r.blockNumber,
          logIndex: r.logIndex,
        })),
        pnlMethod: PNL_METHOD,
        /*
         * The one price every buy row above is valued at (USDC per whole AIC, like pricePerTokenUSDC). A client that loaded older pages earlier revalues them with this, so a
         * table never mixes prices from different moments.
         */
        markPricePerAIC: (Number(markPrice1e30) / 1e18).toPrecision(8),
        howToReadIt:
          "Newest first. `trader` is the wallet that filled it — you can look up what else that " +
          "wallet has done. A run of sells into a thin curve moves the price a long way, so read " +
          "size against the price column rather than on its own.",
      });
    })
  );

  router.get(
    "/market/tokens/:aicToken/trades",
    publicCache(5),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const token = String(req.params.aicToken || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(token)) throw ApiError.invalid("Malformed token address");

      const market = await StockMarket.findOne({ chainId, aicToken: token }).lean();
      if (!market) throw ApiError.notFound("Token market");

      const limit = Math.min(Number(req.query.limit ?? 1000) || 1000, MAX_TRADES);
      const since = Number(req.query.since ?? 0) || 0;

      const filter: Record<string, unknown> = { chainId, aicToken: token };
      if (since > 0) filter.at = { $gte: since };

      // Newest-first in the query so a bounded page keeps the RECENT history, then reversed
      // for the chart, which requires strictly ascending time.
      const rows = await StockTrade.find(filter)
        .sort({ blockNumber: -1, logIndex: -1 })
        .limit(limit)
        .lean();
      rows.reverse();

      /*
       * Plot SPOT, not what the trader paid.
       *
       * A buy executes above spot — slippage plus fees — so a series built from executed prices
       * spikes on every trade and falls back on the next periodic sample, which reads as a price
       * drop that no sell caused. Users and agents both reported the contradiction: a chart going
       * down while the trade list showed nothing but buys.
       *
       * The trade list still reports the executed price, because that is what actually happened
       * to that trader. The chart reports the price the market was left at, because that is the
       * only figure that forms a continuous series with the samples beside it. Older rows have no
       * recorded spot, so they fall back to the executed price rather than vanishing.
       */
      for (const row of rows) {
        const spot = String((row as { spotPriceAfter1e18?: string }).spotPriceAfter1e18 ?? "");
        if (spot && spot !== "0") (row as { pricePerToken1e18: string }).pricePerToken1e18 = spot;
      }

      /*
       * Merge in periodic price samples.
       *
       * Trades alone make a market that has been quiet render as a chart that stops at the last
       * trade, which looks broken to whoever arrives later. Samples carry the price forward with
       * zero volume — no trade happened, and claiming one would be a lie about liquidity.
       *
       * A sample is dropped whenever a real trade shares its second: the trade is the better
       * record of the same instant, and the chart library requires strictly unique timestamps.
       */
      const sampleFilter: Record<string, unknown> = { chainId, aicToken: token };
      if (since > 0) sampleFilter.at = { $gte: since };
      const samples = await PriceSample.find(sampleFilter)
        .sort({ at: -1 })
        .limit(limit)
        .lean();

      const tradeSeconds = new Set(rows.map((r) => Number(r.at)));
      const merged = [
        ...rows.map((r) => ({
          at: Number(r.at),
          blockNumber: r.blockNumber,
          logIndex: r.logIndex,
          txHash: r.txHash,
          side: r.side,
          trader: r.trader,
          grossUSDC: r.grossUSDC,
          netUSDC: r.netUSDC,
          tokensAIC: r.tokensAIC,
          pricePerToken1e18: r.pricePerToken1e18,
          source: "trade" as const,
        })),
        ...samples
          .filter((s) => !tradeSeconds.has(Number(s.at)))
          .map((s) => ({
            at: Number(s.at),
            blockNumber: null,
            logIndex: null,
            txHash: null,
            side: null,
            trader: null,
            grossUSDC: "0",
            netUSDC: "0",
            tokensAIC: "0",
            pricePerToken1e18: s.price1e18,
            source: "sample" as const,
          })),
      ].sort((a, b) => a.at - b.at);

      /*
       * The opening quote: where the curve stood before its first trade.
       *
       * Every store is created and seeded in one transaction, so the first trade IS the owner's seed
       * and there is no earlier sample. Without this point the series started at the post-seed price,
       * and every change figure compared that price with itself: Δ 0% on a market the seed had
       * already moved. The opening is the constant-product quote on the fresh curve (virtual USDC
       * over genesis supply) — a quote, not a trade, carried with zero volume like a sample. Added
       * only when this page reaches back to the market's first trade.
       */
      const firstEver = await StockTrade.findOne({ chainId, aicToken: token }).sort({ blockNumber: 1, logIndex: 1 }).select({ at: 1, txHash: 1 }).lean();
      const oldestHere = rows[0];
      if (firstEver && oldestHere && firstEver.txHash === oldestHere.txHash && (since === 0 || since < Number(firstEver.at))) {
        const openingPrice =
          (BigInt(req.ctx.manifest.economics.virtualUSDCReserve) * 10n ** 30n) / BigInt(req.ctx.manifest.economics.aicGenesisSupply);
        const openingAt = Number(firstEver.at) - 1;
        if (!merged.some((m) => m.at === openingAt)) {
          merged.unshift({
            at: openingAt,
            blockNumber: null,
            logIndex: null,
            txHash: null,
            side: null,
            trader: null,
            grossUSDC: "0",
            netUSDC: "0",
            tokensAIC: "0",
            pricePerToken1e18: openingPrice.toString(),
            source: "opening" as never,
          });
        }
      }

      res.json({
        token: {
          address: market.aicToken,
          name: market.name,
          symbol: market.symbol,
          decimals: market.decimals,
          storeId: market.storeId,
          note: SELLER_CONTENT_NOTE,
        },
        usdcDecimals: 6,
        items: merged,
        counts: {
          trades: rows.length,
          samples: merged.length - rows.length,
          total: merged.length,
        },
        note:
          "Each point carries `source`. `trade` is a real swap with real volume; `sample` is a " +
          "periodic price observation with zero volume, recorded so the series stays continuous " +
          "while a market is quiet; `opening` is the fresh curve's quote just before its first trade (the " +
          "owner's seed), so price changes include the seed's move. Never read a sample or the opening as trading activity.",
        count: merged.length,
        truncated: rows.length >= limit,
        freshness: freshness(req.ctx),
      });
    })
  );

  return router;
}

/**
 * The business at a glance for each store row — shared by GET /stores and GET /stores/recent, so the
 * cards on every page carry the same facts.
 */
async function storeOverviews(
  req: { ctx: { env: { CHAIN_ID: number }; manifest: { contracts: { agentGoods: { proxy: string } }; economics: Record<string, unknown> } } },
  page: Record<string, unknown>[],
  tokens: Record<string, unknown>[]
): Promise<Map<string, Record<string, unknown>>> {
  const chainId = req.ctx.env.CHAIN_ID;
  const tokenByAddress = new Map(tokens.map((t) => [String(t.aicToken), t]));
  /*
   * The business at a glance, for every row: what it sells, how much work stands behind it, who
   * buys and who holds. A list that shows only a name and two lifetime totals tells a reader
   * nothing about which store to open.
   */
  const pageIds = page.map((s) => String(s.storeId));
  // The curve (AgentGoods) and each graduated market's DEX pool hold AIC without being holders.
  const protocolHolders = [
    String(req.ctx.manifest.contracts.agentGoods.proxy).toLowerCase(),
    ...tokens.map((t) => String((t as Record<string, unknown>).pair ?? "").toLowerCase()).filter(Boolean),
  ];
  const [productAgg, purchaseAgg, holderAgg] = await Promise.all([
    Product.aggregate([
      { $match: { chainId, storeId: { $in: pageIds }, canonical: true, deleted: { $ne: true } } },
      {
        $group: {
          _id: "$storeId",
          total: { $sum: 1 },
          active: { $sum: { $cond: ["$active", 1, 0] } },
          iterations: { $sum: { $ifNull: ["$sellerContent.profile.iterationsTotal", 0] } },
          maxIterations: { $max: { $ifNull: ["$sellerContent.profile.iterationsTotal", 0] } },
          minPrice: { $min: { $cond: ["$active", "$priceUSDCSort", null] } },
        },
      },
    ]),
    Purchase.aggregate([
      { $match: { chainId, storeId: { $in: pageIds } } },
      { $group: { _id: "$storeId", sales: { $sum: 1 }, buyers: { $addToSet: "$buyer" }, last: { $max: "$at" } } },
    ]),
    AicHolder.aggregate([
      // Wallets only: the curve, the DEX pool and other contracts hold AIC too, and are not holders a reader means.
      {
        $match: {
          chainId,
          storeId: { $in: pageIds },
          balance: { $ne: "0" },
          isContract: { $ne: true },
          holder: { $nin: protocolHolders },
        },
      },
      { $group: { _id: "$storeId", holders: { $sum: 1 } } },
    ]),
  ]);
  const productsOf = new Map(productAgg.map((r) => [String(r._id), r]));
  const purchasesOf = new Map(purchaseAgg.map((r) => [String(r._id), r]));
  const holdersOf = new Map(holderAgg.map((r) => [String(r._id), Number(r.holders)]));
  const minPriceDocs = await Product.find({
    chainId,
    storeId: { $in: pageIds },
    canonical: true,
    deleted: { $ne: true },
    active: true,
    priceUSDCSort: { $in: productAgg.map((r) => r.minPrice).filter(Boolean) },
  })
    .select({ storeId: 1, priceUSDC: 1, priceUSDCSort: 1 })
    .lean();
  const cheapestOf = new Map<string, string>();
  for (const d of minPriceDocs) {
    const agg = productsOf.get(String(d.storeId));
    if (agg && agg.minPrice === d.priceUSDCSort) cheapestOf.set(String(d.storeId), String(d.priceUSDC));
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const s of page) {
    const pa = productsOf.get(String(s.storeId));
    const pu = purchasesOf.get(String(s.storeId));
    const tk = tokenByAddress.get(String(s.aicToken ?? ""));
    const cheapest = cheapestOf.get(String(s.storeId));
    const overview = {
      productsActive: Number(pa?.active ?? 0),
      productsTotal: Number(pa?.total ?? 0),
      iterationsTotal: Number(pa?.iterations ?? 0),
      mostIteratedProduct: Number(pa?.maxIterations ?? 0),
      sales: Number(pu?.sales ?? 0),
      customers: Array.isArray(pu?.buyers) ? pu.buyers.length : 0,
      lastSaleAt: pu?.last ?? null,
      holders: holdersOf.get(String(s.storeId)) ?? 0,
      cheapestProductUSDC: cheapest ? amountUSDC(BigInt(cheapest)) : null,
      aicPriceUSDC: tk?.currentIndexedPrice1e18 ? priceDecimal(BigInt(String(tk.currentIndexedPrice1e18))) : null,
      aicPrice1e18: tk?.currentIndexedPrice1e18 ? String(tk.currentIndexedPrice1e18) : null,
      /*
       * How far the market is toward graduation, against THIS network's threshold, so a list of
       * stores shows at a glance which are close and which have already moved to the DEX pool.
       */
      graduation: (() => {
        const genesis = BigInt(String(req.ctx.manifest.economics.aicGenesisSupply ?? "0"));
        const thresholdBps = Math.round(Number(req.ctx.manifest.economics.transitionThresholdPercent ?? 0) * 100);
        const sold = BigInt(String((tk as Record<string, unknown> | undefined)?.netSoldFromCurveAIC ?? "0"));
        const graduated = String(tk?.phase ?? "") === "external_dex" || Boolean(tk?.lpCreated);
        return {
          graduated,
          netSoldBps: genesis > 0n ? Number((sold * 10000n) / genesis) : 0,
          thresholdBps,
        };
      })(),
    };
    out.set(String(s.storeId), overview);
  }
  return out;
}

function resolveSort(sort: string | undefined): Record<string, 1 | -1> {
  switch (sort) {
    case "oldest":
      return { createdBlock: 1, createdLogIndex: 1 };
    case "price_asc":
      return { priceUSDCSort: 1 };
    case "price_desc":
      return { priceUSDCSort: -1 };
    // The development behind a product, as its seller declared it at every upload.
    case "iterations_desc":
      return { "sellerContent.profile.iterationsTotal": -1, createdBlock: -1 };
    // Phase 10.1 sorting is on the DERIVED declaration figure only. Buyer signals are never
    // a sort key: they carry zero weight in ranking. [14A.2, docs/DECISIONS D-011]
    case "tokensSavedPerUsdc_desc":
      return { "declaration.tokensSavedPerUsdcSort": -1, createdBlock: -1 };
    case "tokensSavedPerUsdc_asc":
      return { "declaration.tokensSavedPerUsdcSort": 1, createdBlock: -1 };
    /*
     * These two are approximations and are documented as such.
     *
     * Products carry no sales counter, so a true "most sold" ordering would need an aggregation
     * joined onto every page. `mostSold` is therefore intended to be used WITH minUnitsSold, which
     * does the real filtering; the sort then puts the newest of the proven ones first. Anything
     * stronger would be a ranking we cannot actually compute here, and a wrong order presented
     * confidently is worse than an honest one.
     */
    case "mostSold":
      return { createdBlock: -1, createdLogIndex: -1 };
    case "storeCommerce_desc":
      return { createdBlock: -1, createdLogIndex: -1 };
    default:
      return { createdBlock: -1, createdLogIndex: -1 };
  }
}

/** Joins each product with its store reward pool and its seller signal record. */
async function decorateProducts(
  req: { ctx: { env: { CHAIN_ID: number }; manifest: { economics: { minSignalsForRate: number } } } },
  docs: Record<string, unknown>[]
): Promise<unknown[]> {
  const chainId = req.ctx.env.CHAIN_ID;
  const storeIds = [...new Set(docs.map((d) => String(d.storeId)))];
  const stores = await Store.find({ chainId, storeId: { $in: storeIds } }).lean();
  const storeById = new Map(stores.map((s) => [s.storeId, s]));

  const summaries = await sellerSummaries(
    stores.map((s) => s.storeController),
    { chainId, minSignals: req.ctx.manifest.economics.minSignalsForRate }
  );

  // Store token symbols, so an incentive amount renders as `ATLS` rather than a generic `AIC`.
  const markets = await StockMarket.find({ chainId, aicToken: { $in: stores.map((s) => s.aicToken) } })
    .select({ aicToken: 1, symbol: 1 })
    .lean();
  const symbolByToken = new Map(markets.map((m) => [m.aicToken, m.symbol]));

  const yourModel = typeof (req as { query?: Record<string, unknown> }).query?.model === "string"
    ? String((req as { query?: Record<string, unknown> }).query!.model)
    : null;
  return docs.map((d) => {
    const store = storeById.get(String(d.storeId));
    const seller = store ? summaries.get(store.storeController.toLowerCase()) : undefined;
    const symbol = store ? symbolByToken.get(store.aicToken) ?? "" : "";
    return withYourModel(productView(d as never, store?.rewardPoolAIC ?? "0", seller, symbol, (store as never) ?? null), yourModel);
  });
}

/*
 * ?model=<your model> prices every product's work at the CALLER's model: what building it would cost you,
 * next to its price — the buy-versus-build comparison in one number instead of one to derive.
 */
export function withYourModel<T extends Record<string, any>>(view: T, model: string | null): T {
  if (!model) return view;
  const at = (tokens: number, breakdown: TokenBreakdown | null = null) => {
    const usd = workCostUSD(tokens, model, breakdown);
    return usd === null ? null : { model: normaliseModel(model), usdc: usd < 1 ? usd.toPrecision(2) : usd.toFixed(2) };
  };
  const decl = view.declaration?.buildCostUSDC;
  const priced = at(1) !== null;
  return {
    ...view,
    ...(decl ? { declaration: { ...view.declaration, buildCostUSDC: { ...decl, atYourModel: at(decl.tokens, decl.breakdown ?? null) } } } : {}),
    ...(priced ? {} : { yourModelNotListed: `No list price for "${model}". Listed: ${Object.keys(MODEL_LIST_PRICES).join(", ")}.` }),
  };
}

/** A content hash of all zeroes: a listing that commits to no bytes at all. */
const ZERO_HASH = `0x${"0".repeat(64)}`;

/**
 * Match a term inside one key of the seller-content JSON blob.
 *
 * Seller content is stored as a JSON string rather than parsed fields, so targeting `name` means
 * anchoring to the key and scanning only its value. The value pattern refuses to cross the closing
 * quote, so a term in the description can never satisfy a name search.
 */
function jsonFieldRegex(field: string, term: string): string {
  return `"${field}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*${escapeRegex(term)}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
