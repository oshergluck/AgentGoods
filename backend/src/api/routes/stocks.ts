/**
 * AIC stocks, screened and explained (read-only).
 *
 *   GET /api/v1/market/stocks                      compact screening rows, sortable and filterable
 *   GET /api/v1/stocks/{aicToken}/fundamentals     the business behind one AIC, grouped
 *   GET /api/v1/stocks/{aicToken}/history          compact time series from indexed observations
 *
 * Facts and plain ratios only, computed in stores/stockMetrics.ts. No score, rating, ranking by a
 * composite, or recommendation: the agent decides what, if anything, to do with them.
 */
import { AIC_DEFINITION } from "../../schema/agentSchema";
import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { ApiError } from "../../http/errors";
import { handler, publicCache } from "../../http/middleware";
import { freshness } from "../../http/context";
import { BUYBACK_MECHANISM, fundamentals, gatherFacts, history, loadMarkets, sortValues, stockRow } from "../../stores/stockMetrics";
import { businessModelByStore, serviceMetrics } from "../../services/metrics";
import { Product } from "../../db/models";

const SORTS = {
  commerce_desc: "commerce in the last 24h, descending",
  commerce_growth_desc: "commerce growth, last hour vs the hour before, descending (stores with no prior-hour commerce but some now first)",
  buyback_desc: "buyback USDC in the last 24h, descending",
  volume_desc: "trading volume in the last 24h (excluding protocol buybacks), descending",
  liquidity_desc: "real USDC liquidity, descending",
  market_cap_desc: "market cap, descending",
  price_change_1h_desc: "price change over the last hour, descending",
  price_change_24h_desc: "price change over the last 24h, descending",
  recent: "most recent commerce or trade first",
} as const;

const usdcBound = z.string().regex(/^\d+(\.\d{1,6})?$/).transform((v) => ethers.parseUnits(v, 6)).optional();
const Query = z.object({
  sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  minCommerce1h: usdcBound,
  minCommerce24h: usdcBound,
  minLiquidityUSDC: usdcBound,
  minVolume24h: usdcBound,
  minBuyback24h: usdcBound,
  minHolders: z.coerce.number().int().min(0).optional(),
  storeId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  controller: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

const FIELDS_NOTE =
  "USDC values are decimal USDC strings; AIC quantities are decimal whole tokens; prices are USDC per whole AIC. " +
  "Windows end now: 1h and 24h. volume excludes protocol buybacks, which are reported under buyback. liquidityUSDC is the " +
  "real USDC a seller can be paid from (the curve's real reserve, or the DEX pool's USDC side). repeatCustomers24h counts " +
  "buyers in the last 24h who have bought from this store more than once. null means the figure cannot be derived " +
  "(for example a price change for a market younger than the window).";

async function oneMarket(chainId: number, aicToken: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(aicToken)) throw ApiError.invalid("aicToken must be an address", {});
  const { markets, storeOf } = await loadMarkets(chainId, { aicToken: aicToken.toLowerCase() });
  const m = markets[0];
  if (!m) throw ApiError.notFound("AIC market");
  return { m, store: storeOf.get(String(m.storeId)) };
}

export function stocksRouter(): Router {
  const router = Router();

  router.get(
    "/market/stocks",
    publicCache(15),
    handler(async (req, res) => {
      const parsed = Query.safeParse(req.query);
      if (!parsed.success) throw ApiError.invalid("Invalid query", { issues: parsed.error.issues, sorts: SORTS });
      const q = parsed.data;
      const chainId = req.ctx.env.CHAIN_ID;
      const filter: Record<string, unknown> = {};
      if (q.storeId) filter.storeId = q.storeId.toLowerCase();
      const { markets, storeOf } = await loadMarkets(chainId, filter);
      const facts = await gatherFacts(chainId, markets);

      let rows = markets.map((m) => {
        const f = facts.get(String(m.aicToken).toLowerCase())!;
        return { m, f, row: stockRow(m, storeOf.get(String(m.storeId)), f), v: sortValues(m, f) };
      });
      rows = rows.filter(({ f, v, row }) =>
        (q.minCommerce1h === undefined || f.commerce1h >= q.minCommerce1h) &&
        (q.minCommerce24h === undefined || f.commerce24h >= q.minCommerce24h) &&
        (q.minLiquidityUSDC === undefined || v.liquidity >= q.minLiquidityUSDC) &&
        (q.minVolume24h === undefined || f.volume24h >= q.minVolume24h) &&
        (q.minBuyback24h === undefined || f.buyback24h >= q.minBuyback24h) &&
        (q.minHolders === undefined || v.holders >= q.minHolders) &&
        (!q.controller || String(row.controller ?? "").toLowerCase() === q.controller.toLowerCase())
      );
      const sort = q.sort ?? "commerce_desc";
      const key = {
        commerce_desc: (v: ReturnType<typeof sortValues>) => v.commerce,
        commerce_growth_desc: (v: ReturnType<typeof sortValues>) => BigInt(v.commerceGrowth),
        buyback_desc: (v: ReturnType<typeof sortValues>) => v.buyback,
        volume_desc: (v: ReturnType<typeof sortValues>) => v.volume,
        liquidity_desc: (v: ReturnType<typeof sortValues>) => v.liquidity,
        market_cap_desc: (v: ReturnType<typeof sortValues>) => v.marketCap,
        price_change_1h_desc: (v: ReturnType<typeof sortValues>) => BigInt(v.priceChange1h),
        price_change_24h_desc: (v: ReturnType<typeof sortValues>) => BigInt(v.priceChange24h),
        recent: (v: ReturnType<typeof sortValues>) => BigInt(v.recent),
      }[sort];
      rows.sort((a, b) => {
        const x = key(a.v);
        const y = key(b.v);
        return x === y ? String(a.row.aicToken).localeCompare(String(b.row.aicToken)) : x > y ? -1 : 1;
      });
      const limit = q.limit ?? 20;
      const offset = q.offset ?? 0;
      const page = rows.slice(offset, offset + limit);
      const models = await businessModelByStore(
        chainId,
        page.map((r) => String(r.m.storeId)),
        new Map(page.map((r) => [String(r.m.storeId), String(r.row.controller ?? "")]))
      );
      res.json({
        items: page.map((r) => ({ ...r.row, businessModel: models.get(String(r.m.storeId)) ?? null })),
        pageInfo: { total: rows.length, offset, limit, hasMore: offset + limit < rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null },
        sort: { applied: sort, available: SORTS },
        filters: ["minCommerce1h", "minCommerce24h", "minLiquidityUSDC", "minVolume24h", "minBuyback24h", "minHolders", "storeId", "controller"],
        whatAnAICIs: AIC_DEFINITION,
        fields: FIELDS_NOTE,
        buybackMechanism: BUYBACK_MECHANISM,
        next: {
          fundamentals: "GET /api/v1/stocks/{aicToken}/fundamentals",
          history: "GET /api/v1/stocks/{aicToken}/history?interval=15m",
          quote: "POST /api/v1/stocks/{aicToken}/quote {side, amount}",
        },
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/stocks/:aicToken/fundamentals",
    publicCache(15),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const { m, store } = await oneMarket(chainId, String(req.params.aicToken));
      const facts = await gatherFacts(chainId, [m]);
      const controller = String((store as { storeController?: string } | null)?.storeController ?? "");
      const models = await businessModelByStore(chainId, [String(m.storeId)], new Map([[String(m.storeId), controller]]));
      const serviceIds = (
        await Product.find({ chainId, storeId: String(m.storeId), "sellerContent.profile.serviceSpecHash": { $ne: null } }).select({ productId: 1 }).lean()
      ).map((p) => p.productId);
      res.json({
        ...fundamentals(m, store, facts.get(String(m.aicToken).toLowerCase())!),
        businessModel: {
          ...(models.get(String(m.storeId)) ?? {}),
          services: serviceIds.length > 0 ? await serviceMetrics(chainId, String(m.storeId), serviceIds, controller) : null,
          lifetimeBuybackBurnedAIC: (store as { lifetimeBuybackBurnedAIC?: string } | null)?.lifetimeBuybackBurnedAIC ?? "0",
          howToRead:
            "What the business sells (sales, rentals, services) and how its services are used, from call records and " +
            "settled commerce. Facts to reason with; AgentGoods rates nothing.",
        },
        whatAnAICIs: AIC_DEFINITION,
        fields: FIELDS_NOTE,
        next: {
          history: `GET /api/v1/stocks/${m.aicToken}/history?interval=15m`,
          quote: `POST /api/v1/stocks/${m.aicToken}/quote {side: "buy" | "sell", amount}`,
        },
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/stocks/:aicToken/history",
    publicCache(15),
    handler(async (req, res) => {
      const Q = z.object({
        interval: z.enum(["5m", "15m", "1h"]).optional(),
        points: z.coerce.number().int().min(1).max(288).optional(),
      });
      const parsed = Q.safeParse(req.query);
      if (!parsed.success) throw ApiError.invalid("Invalid query", { issues: parsed.error.issues, intervals: ["5m", "15m", "1h"] });
      const interval = parsed.data.interval ?? "15m";
      const sec = { "5m": 300, "15m": 900, "1h": 3600 }[interval];
      const chainId = req.ctx.env.CHAIN_ID;
      const { m } = await oneMarket(chainId, String(req.params.aicToken));
      const h = await history(chainId, m, sec, parsed.data.points ?? 24);
      res.json({ aicToken: String(m.aicToken).toLowerCase(), interval, ...h, freshness: freshness(req.ctx) });
    })
  );

  return router;
}
