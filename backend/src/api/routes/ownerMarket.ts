/**
 * Two things a store owner needs to reason about its own token market, as numbers.
 *
 *   GET  /market/tokens/:aicToken/round-trip?amountUSDC=…[&wallet=0x…]
 *     What buying `amountUSDC` and selling it straight back would cost if nobody else traded in
 *     between. "Being first" was being treated as risking the whole amount; on a bonding curve the
 *     immediate unwind costs the fees on both legs. It cannot be assembled from two ordinary quotes:
 *     a sell quote reads the CURRENT curve, and an uninitialized market holds no real USDC, so it
 *     refuses every sale. This prices the sale on the curve as the buy leaves it.
 *
 *   POST /stocks/:aicToken/controller-fees/withdraw-intent
 *     The 1% controller fee on every curve trade accrues to the store's current controller. There
 *     was no route to take it, so an owner seeding its own market could not recover that part of its
 *     cost without encoding a call by hand.
 */
import { Router } from "express";
import { handler, idempotent, noStore, publicCache, requireAgent, selfWallet } from "../../http/middleware";
import { ApiError } from "../../http/errors";
import { StockMarket, Store } from "../../db/models";
import { amountAIC, amountUSDC } from "../../config/units";
import { buildIntent } from "../../transactions/intents";
import { chainNow } from "../../db/chainTime";
import { dexPoolOf, freshCurveState, isGraduated, marketStateOf, roundTripOnCurve, type CurveState } from "../../stores/quotes";

const MIN_TRADE_USDC_BASE = 100n; // 0.0001 USDC: the smallest trade on which both trading fees round to at least one unit

/** Illustrative candidate amounts when the caller names none. Examples to compare, never a default. */

export interface SeedAnalysisInput {
  state: CurveState;
  fees: { protocolBps: number; controllerBps: number };
  genesisSupply: bigint;
  transitionThreshold: bigint;
  amountsUSDC: bigint[];
  youAreTheController: boolean;
  ownerAICBefore: bigint;
  incentiveFundedBefore: boolean;
}

/**
 * What seeding a store's own market would mechanically change, for each candidate amount, against
 * leaving it as it is. Facts about the curve, not a forecast of buyers.
 */
export function seedAnalysis(i: SeedAnalysisInput) {
  const withoutSeed = {
    marketInitialized: i.state.realUSDCReserve > 0n || i.state.netSoldFromCurve > 0n,
    realReserveUSDC: amountUSDC(i.state.realUSDCReserve),
    priceAvailable: true,
    sellQuoteAvailable: i.state.realUSDCReserve > 0n,
    controllerIsHolder: i.ownerAICBefore > 0n,
    canFundIncentive: i.ownerAICBefore > 0n,
    incentiveFunded: i.incentiveFundedBefore,
  };
  const candidates = i.amountsUSDC.map((usd) => {
    const gross = usd * 1_000_000n;
    const rt = roundTripOnCurve(i.state, gross, i.fees.protocolBps, i.fees.controllerBps, i.genesisSupply, i.transitionThreshold);
    if (!rt.buy.enoughInventory || rt.buy.willTriggerTransition) {
      return { seedAmountUSDC: amountUSDC(gross), crossesGraduation: rt.buy.willTriggerTransition, note: "Too large to price as a round trip on the curve: it would end the curve (graduation) or exceed its inventory." };
    }
    const ownerAfter = i.ownerAICBefore + rt.buy.tokensOut;
    const circulatingAfter = rt.stateAfterBuy.netSoldFromCurve;
    return {
      seedAmountUSDC: amountUSDC(gross),
      aicReceived: amountAIC(rt.buy.tokensOut),
      // USDC per whole AIC, fees included: what this amount actually pays per token.
      averageEntryPriceUSDC: rt.buy.tokensOut > 0n ? (Number((gross * 10n ** 30n) / rt.buy.tokensOut) / 1e18).toPrecision(6) : null,
      resultingOwnerAIC: amountAIC(ownerAfter),
      ownerShareOfCirculatingAICPercent:
        circulatingAfter > 0n ? (Number((ownerAfter * 1_000_000n) / circulatingAfter) / 10_000).toFixed(2) : null,
      resultingRealReserveUSDC: amountUSDC(rt.stateAfterBuy.realUSDCReserve),
      withSeed: {
        marketInitialized: true,
        realReserveUSDC: amountUSDC(rt.stateAfterBuy.realUSDCReserve),
        priceAvailable: true,
        sellQuoteAvailable: rt.sell.enoughRealReserve,
        controllerIsHolder: true,
        canFundIncentive: true,
        incentiveFunded: i.incentiveFundedBefore,
      },
    };
  });
  return {
    withoutSeed,
    candidates,
    positionSizing:
      "Compare these amounts as position sizes, not against the protocol minimum: the curve's depth comes from its " +
      "virtual reserve, so what a larger amount changes is how much of the earliest ownership you hold (AIC, entry price, " +
      "share of circulating AIC), your incentive capacity and your control position — and what it leaves you for " +
      "everything else. The protocol minimum answers what is valid, not what is optimal.",
    assumptions:
      "Each figure is the market as that buy would leave it, with nobody else trading in between. What changes " +
      "mechanically is shown; whether anyone buys after you is not something these numbers can say.",
    whatItIsNot: "Owner-funded liquidity is infrastructure, not validation. It does not prove demand, and must never be presented as outside investment.",
  };
}

function parseAmounts(q: unknown): bigint[] | null {
  if (q === undefined || q === null || q === "") return null;
  const parts = String(q).split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 8 || parts.some((x) => !/^\d{1,9}$/.test(x) || x === "0")) {
    throw ApiError.invalid('Give amountsUSDC as up to 8 whole USDC amounts, comma separated, e.g. "50,100,250".');
  }
  return parts.map((x) => BigInt(x));
}

export function ownerMarketRouter(): Router {
  const router = Router();

  router.get(
    "/stores/:storeId/seed-analysis",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const store = await Store.findOne({ chainId, storeId: req.params.storeId }).lean();
      if (!store) throw ApiError.notFound("Store");
      const m = (await StockMarket.findOne({ chainId, aicToken: store.aicToken }).lean()) as Record<string, unknown> | null;
      if (!m) throw ApiError.notFound("Market for this store");
      const e = req.ctx.manifest.economics;
      const named = parseAmounts(req.query.amountsUSDC);
      /*
       * No suggested amounts: the analysis prices exactly what the caller names. Example amounts were
       * read as recommendations and copied.
       */
      if (named === null) {
        throw new ApiError(
          "INVALID_REQUEST",
          "Name the amounts you are considering: ?amountsUSDC=<a>,<b>,… (whole USDC, up to 8). The analysis prices exactly those.",
          400,
          { field: "amountsUSDC" }
        );
      }
      const wallet = typeof req.query.wallet === "string" ? req.query.wallet.toLowerCase() : null;
      const youAreTheController = Boolean(wallet && store.storeController.toLowerCase() === wallet);
      let ownerAIC = 0n;
      if (wallet) {
        const { AicHolder } = await import("../../db/models");
        const h = await AicHolder.findOne({ chainId, aicToken: String(store.aicToken).toLowerCase(), holder: wallet }).lean();
        ownerAIC = BigInt(String(h?.balance ?? "0"));
      }
      const state = marketStateOf(m);
      if (isGraduated(m)) {
        res.json({ storeId: store.storeId, marketState: state, note: "This market has graduated to its DEX pool; seeding its curve no longer applies. GET /api/v1/market/tokens/{aicToken}/round-trip prices a round trip on the pool." });
        return;
      }
      const analysis = seedAnalysis({
        state: {
          virtualTokenReserve: BigInt(String(m.virtualTokenReserve ?? "0")),
          virtualUSDCReserve: BigInt(String(m.virtualUSDCReserve ?? "0")),
          tokenInventory: BigInt(String(m.marketInventoryAIC ?? "0")),
          realUSDCReserve: BigInt(String(m.realUSDCReserve ?? "0")),
          netSoldFromCurve: BigInt(String(m.netSoldFromCurveAIC ?? "0")),
        },
        fees: { protocolBps: e.agentGoodsProtocolFeeBps, controllerBps: e.agentGoodsControllerFeeBps },
        genesisSupply: BigInt(e.aicGenesisSupply),
        transitionThreshold: BigInt(e.transitionThresholdAIC),
        amountsUSDC: named,
        youAreTheController,
        ownerAICBefore: ownerAIC,
        incentiveFundedBefore: BigInt(String(store.rewardPoolAIC ?? "0")) > 0n,
      });
      /*
       * The same USDC, the other way: what it would buy in an outside market, and what it would sell back
       * for straight away. Next to the own-store figures above, so the choice is a comparison, not a verdict.
       */
      let outside: Record<string, unknown> | undefined;
      if (typeof req.query.compareWith === "string" && req.query.compareWith) {
        const ot = req.query.compareWith.toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(ot)) throw ApiError.invalid("compareWith must be an AIC token address.");
        const om = (await StockMarket.findOne({ chainId, aicToken: ot }).lean()) as Record<string, unknown> | null;
        if (!om) throw ApiError.notFound("Market to compare with");
        const ostate = marketStateOf(om);
        const perAmount = named.map((usd) => {
          const gross = usd * 1_000_000n;
          if (isGraduated(om)) {
            const pool = dexPoolOf(om);
            if (!pool) return { amountUSDC: amountUSDC(gross), note: "not priceable right now" };
            const out = (gross * 997n * pool.tokenReserve) / (pool.usdcReserve * 1000n + gross * 997n);
            const back = (out * 997n * (pool.usdcReserve + gross)) / ((pool.tokenReserve - out) * 1000n + out * 997n);
            return { amountUSDC: amountUSDC(gross), venue: "dex", tokensReceivedAIC: amountAIC(out), immediateSellValueUSDC: amountUSDC(back), roundTripCostUSDC: amountUSDC(gross - back) };
          }
          const rt = roundTripOnCurve(
            {
              virtualTokenReserve: BigInt(String(om.virtualTokenReserve ?? "0")),
              virtualUSDCReserve: BigInt(String(om.virtualUSDCReserve ?? "0")),
              tokenInventory: BigInt(String(om.marketInventoryAIC ?? "0")),
              realUSDCReserve: BigInt(String(om.realUSDCReserve ?? "0")),
              netSoldFromCurve: BigInt(String(om.netSoldFromCurveAIC ?? "0")),
            },
            gross, e.agentGoodsProtocolFeeBps, e.agentGoodsControllerFeeBps, BigInt(e.aicGenesisSupply), BigInt(e.transitionThresholdAIC)
          );
          if (rt.buy.willTriggerTransition || !rt.buy.enoughInventory) return { amountUSDC: amountUSDC(gross), crossesGraduation: rt.buy.willTriggerTransition };
          return { amountUSDC: amountUSDC(gross), venue: "curve", tokensReceivedAIC: amountAIC(rt.buy.tokensOut), immediateSellValueUSDC: amountUSDC(rt.sell.netUSDCOut), roundTripCostUSDC: amountUSDC(rt.roundTripCostUSDC) };
        });
        outside = {
          aicToken: ot,
          marketState: ostate,
          pricePerTokenUSDC: (Number(String(om.currentIndexedPrice1e18 ?? "0")) / 1e18).toPrecision(6),
          realLiquidityUSDC: amountUSDC(BigInt(String(om.realUSDCReserve ?? "0"))),
          perAmount,
          whatItCreates: "Position exposure in a market that already exists.",
          whatYourOwnSeedCreates:
            "Position exposure plus, in your own store: an initialized market, real liquidity, holder status, the " +
            "ability to fund an incentive, and machine-readable state for other investors.",
          compare: "Compare total strategic effect, not only immediate token P&L. Either can be the better use; the comparison is the point.",
        };
      }
      res.json({
        storeId: store.storeId,
        aicToken: store.aicToken,
        marketState: state,
        ...(outside ? { comparedWithOutside: outside } : {}),
        ...analysis,
      });
    })
  );

  router.get(
    "/market/tokens/:aicToken/round-trip",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const aicToken = String(req.params.aicToken).toLowerCase();
      const raw = String(req.query.amountUSDC ?? "");
      if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw ApiError.invalid('Give amountUSDC as a decimal USDC amount, e.g. "100" or "12.5".');
      const [whole, frac = ""] = raw.split(".");
      const gross = BigInt(whole!) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
      if (gross < MIN_TRADE_USDC_BASE) {
        throw new ApiError("BELOW_MINIMUM_TRADE", "The exchange does not execute a trade under 0.0001 USDC gross.", 409, { minimumGrossUSDC: amountUSDC(MIN_TRADE_USDC_BASE) });
      }
      const m = (await StockMarket.findOne({ chainId, aicToken }).lean()) as Record<string, unknown> | null;
      if (!m) throw ApiError.notFound("Market for this AIC token");
      const store = await Store.findOne({ chainId, storeId: m.storeId }).select({ storeController: 1 }).lean();
      const wallet = typeof req.query.wallet === "string" ? req.query.wallet.toLowerCase() : null;
      const youAreTheController = Boolean(wallet && store?.storeController && store.storeController.toLowerCase() === wallet);
      const e = req.ctx.manifest.economics;
      const before = marketStateOf(m);

      const common = {
        aicToken,
        amountUSDC: amountUSDC(gross),
        marketStateNow: before,
        assumes:
          "Nobody else trades between your buy and your sale, and gas is not included. The chain decides: " +
          "quote again (POST /api/v1/stocks/{aicToken}/quote) right before acting.",
      };

      if (isGraduated(m)) {
        const pool = dexPoolOf(m);
        if (!pool) throw new ApiError("PRODUCT_UNAVAILABLE", "This market is between venues and cannot be priced right now.", 409);
        const out = (gross * 997n * pool.tokenReserve) / (pool.usdcReserve * 1000n + gross * 997n);
        const back = (out * 997n * (pool.usdcReserve + gross)) / ((pool.tokenReserve - out) * 1000n + out * 997n);
        res.json({
          ...common,
          venue: "dex",
          tokensReceivedAIC: amountAIC(out),
          immediateSellBackUSDC: amountUSDC(back),
          roundTripCostUSDC: amountUSDC(gross - back),
          note:
            "This market has graduated: both legs go through its DEX pool (0.3% each way) and move its price. " +
            "The pool is the only exit, and its depth is what it holds — a position that is large relative to the " +
            "pool loses much more to price impact.",
        });
        return;
      }

      const state = {
        virtualTokenReserve: BigInt(String(m.virtualTokenReserve ?? "0")),
        virtualUSDCReserve: BigInt(String(m.virtualUSDCReserve ?? "0")),
        tokenInventory: BigInt(String(m.marketInventoryAIC ?? "0")),
        realUSDCReserve: BigInt(String(m.realUSDCReserve ?? "0")),
        netSoldFromCurve: BigInt(String(m.netSoldFromCurveAIC ?? "0")),
      };
      const rt = roundTripOnCurve(state, gross, e.agentGoodsProtocolFeeBps, e.agentGoodsControllerFeeBps, BigInt(e.aicGenesisSupply), BigInt(e.transitionThresholdAIC));
      if (!rt.buy.enoughInventory) throw new ApiError("PRODUCT_UNAVAILABLE", "More than the curve can sell at this size.", 409);
      if (rt.buy.willTriggerTransition) {
        res.json({
          ...common,
          venue: "curve",
          crossesGraduation: true,
          tokensReceivedAIC: amountAIC(rt.buy.tokensOut),
          note:
            "A buy this large would take the market past its graduation threshold: the curve would close, the real " +
            "reserve and a premium-priced amount of AIC would seed a locked DEX pool, and all remaining market-held AIC " +
            "would be burned. There would be no curve to sell back to — an exit would go through that pool, whose depth " +
            "is limited. An immediate round trip cannot be priced on the curve at this size.",
        });
        return;
      }
      const controllerRefund = youAreTheController ? rt.controllerFeesUSDC : 0n;
      res.json({
        ...common,
        venue: "curve",
        crossesGraduation: false,
        tokensReceivedAIC: amountAIC(rt.buy.tokensOut),
        realReserveAfterBuyUSDC: amountUSDC(rt.stateAfterBuy.realUSDCReserve),
        immediateSellBackUSDC: amountUSDC(rt.sell.netUSDCOut),
        roundTripCostUSDC: amountUSDC(rt.roundTripCostUSDC),
        costBreakdown: {
          protocolFeesUSDC: amountUSDC(rt.protocolFeesUSDC),
          controllerFeesUSDC: amountUSDC(rt.controllerFeesUSDC),
          roundingUSDC: amountUSDC(rt.roundingUSDC),
        },
        ...(youAreTheController
          ? {
              youAreTheController: true,
              yourNetCostUSDC: amountUSDC(rt.roundTripCostUSDC - controllerRefund),
              controllerFeesComeBackToYou:
                "The 1% controller fee on both legs accrues to you as the store's controller: POST " +
                `/api/v1/stocks/${aicToken}/controller-fees/withdraw-intent.`,
            }
          : {}),
        marketStateAfterBuy: marketStateOf({ ...m, realUSDCReserve: rt.stateAfterBuy.realUSDCReserve.toString(), netSoldFromCurveAIC: rt.stateAfterBuy.netSoldFromCurve.toString() }),
        whatThisMeans:
          "On the curve, the first buyer's immediate unwind costs the fees on both legs, not the principal: the " +
          "buy itself creates the real reserve that pays the sale. What is uncertain is whether anyone buys after " +
          "you. If the market later graduates, the curve closes and the exit becomes its DEX pool, which can be much " +
          "thinner for a large position.",
      });
    })
  );

  router.post(
    "/stocks/:aicToken/controller-fees/withdraw-intent",
    noStore,
    requireAgent,
    idempotent({ action: "withdraw_controller_fees", scope: (req) => String(req.params.aicToken).toLowerCase() }),
    handler(async (req, res) => {
      const wallet = selfWallet(req).toLowerCase();
      const chainId = req.ctx.env.CHAIN_ID;
      const aicToken = String(req.params.aicToken).toLowerCase();
      const m = await StockMarket.findOne({ chainId, aicToken }).lean();
      if (!m) throw ApiError.notFound("Market for this AIC token");
      const store = await Store.findOne({ chainId, storeId: m.storeId }).select({ storeController: 1 }).lean();
      if (!store || store.storeController.toLowerCase() !== wallet) {
        throw ApiError.forbidden("Only the store's current controller can withdraw its controller fees.");
      }
      /*
       * The chain's figure, not the index's. After a withdrawal the index can show the old amount for a
       * minute or more, and preparing a withdrawal of fees already withdrawn gave agents a transaction
       * that reverted ZeroAmount() — five times in a row for one of them.
       */
      let accrued = BigInt(String((m as Record<string, unknown>).controllerFeesUSDC ?? "0"));
      let source: "chain" | "index" = "index";
      try {
        const agAbi = req.ctx.abis.interfaceFor("agentGoods");
        if (req.ctx.providers && agAbi.hasFunction("market")) {
          const raw = await req.ctx.providers.call("eth_call", (p) =>
            p.call({ to: req.ctx.manifest.contracts.agentGoods.proxy, data: agAbi.encodeFunctionData("market", [aicToken]) })
          );
          const [live] = agAbi.decodeFunctionResult("market", raw);
          const v = (live as { controllerFeesUSDC?: bigint }).controllerFeesUSDC;
          if (typeof v === "bigint") {
            accrued = v;
            source = "chain";
          }
        }
      } catch {
        /* the chain read failing falls back to the index; the transaction is simulated before signing anyway */
      }
      if (accrued === 0n) {
        throw new ApiError(
          "INVALID_REQUEST",
          "There are no controller fees to withdraw on this market right now" +
            (source === "chain" ? " (read from the chain): they were already withdrawn, or none have accrued since." : "."),
          409,
          {
            controllerFeesUSDC: amountUSDC(0n),
            source,
            whatAccruesThem: "Trades of this AIC on its bonding curve; the DEX pool pays the controller nothing.",
          }
        );
      }
      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "withdraw_controller_fees",
        contract: req.ctx.manifest.contracts.agentGoods.proxy,
        abi: req.ctx.abis.interfaceFor("agentGoods"),
        functionName: "withdrawControllerFees",
        args: [aicToken, wallet],
        allowance: null,
        summary: {
          action: "withdraw_controller_fees",
          description: `Withdraw ${amountUSDC(accrued).display} USDC of controller trading fees to your wallet.`,
          protocol: { aicToken, storeId: m.storeId, controllerFeesUSDC: amountUSDC(accrued), readFrom: source },
          warnings: ["Paid to the store's current controller; a takeover redirects future fees."],
        },
      });
      res.status(201).json({ intent });
    })
  );

  /*
   * Legacy stores only. Every store created by the current factory is born with owner-funded initial
   * market capital. A store created before that rule may still have an uninitialized market; this is its
   * one explicit path to the same state: the controller's own USDC buys its own AIC, at least the same
   * protocol minimum. The contract call is an ordinary curve buy — nothing here the controller could not
   * do through the generic buy route — but it is labelled for what it is.
   */
  router.post(
    "/stores/:storeId/initialize-market-intent",
    noStore,
    requireAgent,
    idempotent({ action: "initialize_own_market", scope: (req) => String(req.params.storeId).toLowerCase() }),
    handler(async (req, res) => {
      const wallet = selfWallet(req).toLowerCase();
      const chainId = req.ctx.env.CHAIN_ID;
      const m = req.ctx.manifest;
      const storeId = String(req.params.storeId).toLowerCase();
      const store = await Store.findOne({ chainId, storeId }).lean();
      if (!store) throw ApiError.notFound("Store");
      if (store.storeController.toLowerCase() !== wallet) {
        throw ApiError.forbidden("Only the store's current controller can initialize its market with owner capital.");
      }
      const market = await StockMarket.findOne({ chainId, storeId }).lean();
      if (!market) throw ApiError.notFound("Market for this store");
      const state = marketStateOf(market as never);
      if (state.marketInitialized) {
        throw new ApiError("INVALID_REQUEST", "This store's market is already initialized; use the ordinary buy route to add to your position.", 409, {
          marketState: state,
          buyEndpoint: `/api/v1/stocks/${market.aicToken}/buy`,
        });
      }
      const minSeed = BigInt(m.economics.minInitialOwnerSeedUSDC);
      const raw = typeof req.body?.amountUSDC === "string" ? req.body.amountUSDC : undefined;
      if (raw !== undefined && !/^\d+(\.\d{1,6})?$/.test(raw)) {
        throw new ApiError("INVALID_REQUEST", "amountUSDC must be a decimal USDC string: digits, optionally a point and at most 6 decimals.", 400);
      }
      const amount = raw === undefined ? 0n : BigInt(raw.split(".")[0]!) * 1_000_000n + BigInt(((raw.split(".")[1] ?? "") + "000000").slice(0, 6));
      if (amount < minSeed) {
        throw new ApiError(
          "INITIAL_MARKET_CAPITAL_TOO_LOW",
          `Initializing a market requires at least ${amountUSDC(minSeed).display} USDC of owner-funded capital — the same minimum every new store is born with.`,
          400,
          { minimumUSDC: amountUSDC(minSeed), providedUSDC: raw ?? null, field: "amountUSDC" }
        );
      }
      const e = m.economics;
      const rt = roundTripOnCurve(
        freshCurveState(BigInt(e.virtualUSDCReserve), BigInt(e.aicGenesisSupply)),
        amount,
        e.agentGoodsProtocolFeeBps,
        e.agentGoodsControllerFeeBps,
        BigInt(e.aicGenesisSupply),
        BigInt(e.transitionThresholdAIC)
      );
      const deadline = (await chainNow(chainId)) + 600;
      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "initialize_own_market",
        contract: m.contracts.agentGoods.proxy,
        abi: req.ctx.abis.interfaceFor("agentGoods"),
        functionName: "buy",
        args: [market.aicToken, amount, (rt.buy.tokensOut * 99n) / 100n, deadline],
        allowance: {
          token: m.external.canonicalUSDC,
          tokenSymbol: "USDC",
          spender: m.contracts.agentGoods.proxy,
          amount: amountUSDC(amount),
          reason: "Your owner-funded initial market capital: it buys your own store's AIC.",
        },
        summary: {
          action: "initialize_own_market",
          description: `Initialize your store's market: ${amountUSDC(amount).display} USDC of your own capital buys your own AIC.`,
          protocol: { storeId, aicToken: market.aicToken, ownerFundedUSDC: amountUSDC(amount), expectedAIC: amountAIC(rt.buy.tokensOut) },
          warnings: [
            "Owner capital, not independent demand: it is shown apart from other buyers' volume.",
            "The minimum is infrastructure, not a recommended size; you remain exposed to fees, curve mechanics, liquidity and market value.",
          ],
        },
      });
      res.status(201).json({
        intent,
        initialMarketCapital: {
          ownerFundedUSDC: amountUSDC(amount),
          ownerAICReceived: amountAIC(rt.buy.tokensOut),
          tradingFeesOnTheSeedUSDC: { protocol: amountUSDC(rt.buy.protocolFeeUSDC), controller: amountUSDC(rt.buy.controllerFeeUSDC) },
          realReserveUSDC: amountUSDC(rt.buy.netCurveUSDC),
          independentDemandUSDC: "0",
          controllerCanFundIncentive: true,
        },
      });
    })
  );

  return router;
}

/**
 * Facts for an owner about to put capital into ANOTHER store's token while its own store's market is
 * still uninitialized. Returned alongside the action, never in place of it: nothing is blocked and no
 * confirmation is required. Null when the caller controls no such store.
 */
export async function capitalAllocationContext(
  chainId: number,
  wallet: string,
  targetToken: string,
  amountUSDCBase: bigint
): Promise<Record<string, unknown> | null> {
  const { Product, AicHolder } = await import("../../db/models");
  const own = await Store.find({ chainId, storeController: wallet.toLowerCase() }).select({ storeId: 1, aicToken: 1 }).lean();
  for (const st of own) {
    const token = String(st.aicToken ?? "").toLowerCase();
    if (!token || token === targetToken.toLowerCase()) continue;
    const m = (await StockMarket.findOne({ chainId, aicToken: token }).lean()) as Record<string, unknown> | null;
    if (!m || marketStateOf(m).marketInitialized) continue;
    const products = await Product.countDocuments({ chainId, storeId: st.storeId });
    if (products === 0) continue;
    const held = await AicHolder.findOne({ chainId, aicToken: token, holder: wallet.toLowerCase() }).lean();
    return {
      controlsUninitializedStore: true,
      ownStoreId: st.storeId,
      ownStoreAicToken: token,
      ownStoreMarketInitialized: false,
      ownStoreRealReserveUSDC: amountUSDC(BigInt(String(m.realUSDCReserve ?? "0"))),
      ownStoreOwnerAICBalance: amountAIC(BigInt(String(held?.balance ?? "0"))),
      ownStoreProducts: products,
      outsideTradeAmountUSDC: amountUSDC(amountUSDCBase),
      note:
        "You control an uninitialized business while allocating capital to another market. Your own market has no " +
        "real liquidity, no owner position and limited machine-readable investment state. This does not mean you " +
        "must self-seed — it means the comparison should be explicit.",
      suggestedComparison:
        `GET /api/v1/stores/${st.storeId}/seed-analysis?amountsUSDC=<same amount>&compareWith=${targetToken.toLowerCase()}&wallet=${wallet.toLowerCase()} ` +
        "— what the same USDC does in this market and in your own business.",
    };
  }
  return null;
}
