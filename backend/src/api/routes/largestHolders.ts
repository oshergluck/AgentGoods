/**
 * Who leads each store's takeover race, by how much, and what passing them would take.
 *
 * The takeover rule is a ranking — the largest ELIGIBLE EOA holder, continuously for the observation
 * period — and until now nothing published the ranking itself. /api/v1/takeovers lists claims that
 * are already open; /api/v1/me priced "outrank the largest holder" for your own positions without
 * saying who that holder was. An agent weighing a store as a potential acquisition could not ask the
 * first question: who is in first place, and can they be passed?
 *
 * Everything here is a read of indexed state plus the curve arithmetic the rest of the API uses.
 * Only eligible holders count: a contract (smart-contract wallet, multisig, vault, a store's reward
 * pool) can hold AIC but can never lead, so it is never shown as the leader.
 */

import { Router } from "express";
import { handler, publicCache } from "../../http/middleware";
import { ApiError } from "../../http/errors";
import { chainNow } from "../../db/chainTime";
import { AicHolder, StockMarket, Store } from "../../db/models";
import { amountAIC, amountUSDC } from "../../config/units";
import { dexPoolOf, dexUsdcToBuy, isGraduated, marketStateOf, usdcToBuyTokens } from "../../stores/quotes";

const MAX_ROWS = 200;

type Holder = { holder: string; balance: string };

/** Top eligible holders per token, largest first, in one aggregate. */
export async function topHolders(chainId: number, tokens: string[], n: number): Promise<Map<string, Holder[]>> {
  if (tokens.length === 0) return new Map();
  const rows = (await AicHolder.aggregate([
    { $match: { chainId, aicToken: { $in: tokens }, eligible: true, balance: { $ne: "0" } } },
    { $sort: { aicToken: 1, balanceSort: -1 } },
    { $group: { _id: "$aicToken", top: { $push: { holder: "$holder", balance: "$balance" } } } },
    { $project: { top: { $slice: ["$top", n] } } },
  ])) as { _id: string; top: Holder[] }[];
  return new Map(rows.map((r) => [String(r._id).toLowerCase(), r.top]));
}

export interface LeadershipOptions {
  fees: { protocolBps: number; controllerBps: number };
  observationPeriodSeconds: number;
  now: number;
  /** Personalise the gap for this wallet, when given. */
  wallet?: string | null;
  walletBalance?: bigint;
}

/** One store's race, from its market row, its store row and its ranked eligible holders. */
export function leadershipRow(
  market: Record<string, unknown>,
  store: Record<string, unknown> | undefined,
  ranked: Holder[],
  o: LeadershipOptions
): Record<string, unknown> {
  const aicToken = String(market.aicToken).toLowerCase();
  const leader = ranked[0] ?? null;
  const second = ranked[1] ?? null;
  const leaderBalance = BigInt(leader?.balance ?? "0");
  const controller = store?.storeController ? String(store.storeController).toLowerCase() : null;
  const onCurve = String(market.phase ?? "bonding_curve") === "bonding_curve";
  const state = {
    virtualTokenReserve: BigInt(String(market.virtualTokenReserve ?? "0")),
    virtualUSDCReserve: BigInt(String(market.virtualUSDCReserve ?? "0")),
    tokenInventory: BigInt(String(market.marketInventoryAIC ?? "0")),
    realUSDCReserve: BigInt(String(market.realUSDCReserve ?? "0")),
    netSoldFromCurve: BigInt(String(market.netSoldFromCurveAIC ?? "0")),
  };

  /*
   * Tokens and estimated USDC for a holder of `from` to pass the leader by one base unit.
   *
   * The cost is NOT tokens x spot price. Each token bought raises the price of the next, so it is
   * the constant-product curve inverted over the whole purchase — net = vU * t / (vT - t) against
   * the live virtual reserves, grossed up for both fees and rounded up — the same arithmetic the
   * contract's quoteBuy uses, run backwards. Anyone can confirm it with the live quote below.
   */
  // A leader holding more than half of what circulates cannot be passed by buying from the market alone.
  const circulating = (() => {
    const supply = BigInt(String(market.currentSupplyAIC ?? "0"));
    const inventory = BigInt(String(market.marketInventoryAIC ?? "0"));
    return supply > inventory ? supply - inventory : 0n;
  })();
  const leaderHoldsMajority = leader !== null && circulating > 0n && leaderBalance * 2n > circulating;
  const toPass = (from: bigint): Record<string, unknown> => {
    try {
      return toPassUnsafe(from);
    } catch (error) {
      return {
        passingTheLeaderPossibleNow: false,
        whyNot: `could not be priced right now (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  };
  const toPassUnsafe = (from: bigint) => {
    if (leader && from > leaderBalance) return { alreadyLeading: true, passingTheLeaderPossibleNow: true };
    const tokens = leaderBalance - from + 1n;
    const pool = !onCurve && isGraduated(market) ? dexPoolOf(market) : null;
    const cost = onCurve
      ? usdcToBuyTokens(state, tokens, o.fees.protocolBps, o.fees.controllerBps)
      : pool
        ? dexUsdcToBuy(pool, tokens)
        : null;
    if (pool && cost !== null) {
      return {
        passingTheLeaderPossibleNow: true,
        tokensToBuyAIC: amountAIC(tokens),
        estimatedCostUSDC: amountUSDC(cost),
        venue: "dex",
        howEstimated: "this market has graduated: bought from its UniswapV2 pool (0.3% fee), price rising over the whole purchase — not tokens x spot",
        poolCanSupplyRequiredBuy: true,
      };
    }
    return {
      passingTheLeaderPossibleNow: cost !== null,
      ...(cost === null && leaderHoldsMajority
        ? { whyNot: "The largest holder holds more than half of the circulating supply: passing it takes more AIC than the market can sell now, so it would require buying from other holders." }
        : {}),
      tokensToBuyAIC: amountAIC(tokens),
      estimatedCostUSDC: cost === null ? null : amountUSDC(cost),
      curveCanSettleRequiredBuy: cost !== null,
      ...(cost !== null
        ? {
            howEstimated:
              "the bonding curve inverted over the whole purchase (price rises as you buy), both fees included, rounded up — not tokens x spot",
            confirmWithLiveQuote: {
              method: "POST",
              path: `/api/v1/stocks/${aicToken}/quote`,
              body: { side: "buy", amount: cost.toString() },
              expect: "quote.tokensOut >= tokensToBuyAIC",
            },
          }
        : {}),
      ...(cost === null
        ? {
            notBuyableOnTheCurve: onCurve
              ? "More tokens than the curve can sell today; passing the leader would require buying from other holders."
              : isGraduated(market)
                ? "This market trades on its DEX pool, which holds fewer tokens than passing the leader requires; it would take buying from other holders."
                : "This market is between venues; no price applies right now.",
            ...(onCurve ? {} : { venue: "dex" }),
          }
        : {}),
    };
  };

  const candidate = market.takeoverCandidate ? String(market.takeoverCandidate).toLowerCase() : null;
  const openedAt = Number(market.takeoverOpenedAt ?? 0);
  const wallet = o.wallet ? o.wallet.toLowerCase() : null;

  return {
    storeId: market.storeId,
    aicToken,
    symbol: market.symbol ?? null,
    storeName_UNTRUSTED: (store?.sellerContent as { name?: string } | undefined)?.name ?? "",
    currentController: controller,
    largestEligibleHolder: leader
      ? {
          address: leader.holder,
          balanceAIC: amountAIC(leaderBalance),
          isTheController: controller !== null && leader.holder === controller,
          leaderSinceChainTime: Number(market.currentLeaderSince ?? 0) || null,
        }
      : null,
    runnerUp: second ? { address: second.holder, balanceAIC: amountAIC(BigInt(second.balance)) } : null,
    leaderHoldsMajorityOfCirculating: leaderHoldsMajority,
    leadMarginAIC: leader ? amountAIC(leaderBalance - BigInt(second?.balance ?? "0")) : null,
    openCandidacy: candidate
      ? {
          claimant: candidate,
          openedAt,
          secondsRemaining: Math.max(0, openedAt + o.observationPeriodSeconds - o.now),
        }
      : null,
    continuousLeadRequiredSeconds: o.observationPeriodSeconds,
    holderCount: Number(market.holderCount ?? 0),
    business: {
      lifetimeGrossCommerceUSDC: amountUSDC(BigInt(String(store?.lifetimeGrossCommerceUSDC ?? "0"))),
      lifetimeBuybackUSDC: amountUSDC(BigInt(String(store?.lifetimeBuybackUSDC ?? "0"))),
      products: `/api/v1/market/products?store=${String(market.storeId)}`,
    },
    marketState: marketStateOf(market),
    market: {
      phase: String(market.phase ?? "bonding_curve"),
      realUSDCReserve: amountUSDC(state.realUSDCReserve),
      spotPricePerTokenUSDC: (Number(String(market.currentIndexedPrice1e18 ?? "0")) / 1e18).toPrecision(6),
      spotIsNotTheCostOfAPosition: "Buying moves the price; use the estimate or a live quote, never spot x tokens.",
    },
    canTheLeaderBeOvertaken: {
      fromZero: leader ? toPass(0n) : { nobodyLeadsYet: "Any eligible EOA that buys first leads." },
      ...(wallet
        ? {
            forYou:
              leader && leader.holder === wallet
                ? { youLead: true }
                : { yourBalanceAIC: amountAIC(o.walletBalance ?? 0n), ...toPass(o.walletBalance ?? 0n) },
          }
        : {}),
    },
  };
}

export const READ_THIS_FIRST = [
  "Cost to become the largest holder is not the full cost to acquire control: the lead must be held continuously for continuousLeadRequiredSeconds, the controller and other holders can respond, your own buying moves the price, and defence can force more buying.",
  "A takeover quote is a starting estimate, not a guaranteed acquisition price. tokensToBuyAIC is the minimum (one base unit past the leader); any margin above it is your judgement.",
  "Cheap control of a bad business is still a bad acquisition. Rows are not ordered by cost, and cost is not a thesis: the question is which store offers the largest strategic value relative to the realistic cost and risk of gaining control.",
];

export const HOW_TO_OVERTAKE = [
  "EOAs only: hold the position in a plain wallet you sign for. AIC held by any contract (smart-contract wallet, multisig, vault, reward pool) never counts.",
  "Buy strictly more than the leader holds — an exact tie never displaces: POST /api/v1/stocks/{aicToken}/buy (quote first with POST /api/v1/stocks/{aicToken}/quote {side:'buy', amount}).",
  "Then open a candidacy: POST /api/v1/stocks/{aicToken}/takeover/candidacy-intent. Your balance is locked and the claim is public.",
  "Hold first place continuously for the observation period (economics.takeover.observationPeriodSeconds in /api/v1/schema); losing it at any moment makes the claim unfinalizable.",
  "Finalize: POST /api/v1/stocks/{aicToken}/takeover/finalize-intent.",
  "Estimates use the curve's own arithmetic, rounded up; others can buy too, and the chain decides. Whether control is worth it is a separate judgement (/skill -> 'Control, takeover and acquisition value').",
];

export function largestHoldersRouter(): Router {
  const router = Router();

  const load = async (req: { ctx: any; query: any }, filter: Record<string, unknown>, depth: number) => {
    const chainId = req.ctx.env.CHAIN_ID;
    const markets = (await StockMarket.find({ chainId, ...filter }).limit(MAX_ROWS).lean()) as Record<string, unknown>[];
    const tokens = markets.map((m) => String(m.aicToken).toLowerCase());
    const [stores, ranked, now] = await Promise.all([
      Store.find({ chainId, storeId: { $in: markets.map((m) => m.storeId) } })
        .select({ storeId: 1, storeController: 1, "sellerContent.name": 1, lifetimeGrossCommerceUSDC: 1, lifetimeBuybackUSDC: 1 })
        .lean(),
      topHolders(chainId, tokens, depth),
      chainNow(chainId),
    ]);
    const wallet = typeof req.query.wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(req.query.wallet) ? req.query.wallet.toLowerCase() : null;
    const walletBalances = new Map<string, bigint>();
    if (wallet) {
      const mine = await AicHolder.find({ chainId, holder: wallet, aicToken: { $in: tokens } }).lean();
      for (const h of mine) walletBalances.set(String(h.aicToken).toLowerCase(), BigInt(String(h.balance ?? "0")));
    }
    const e = req.ctx.manifest.economics;
    const storeById = new Map(stores.map((s) => [s.storeId, s as Record<string, unknown>]));
    return markets.map((m) => {
      const token = String(m.aicToken).toLowerCase();
      return {
        row: leadershipRow(m, storeById.get(String(m.storeId)), ranked.get(token) ?? [], {
          fees: { protocolBps: e.agentGoodsProtocolFeeBps, controllerBps: e.agentGoodsControllerFeeBps },
          observationPeriodSeconds: e.takeoverObservationPeriodSeconds,
          now,
          wallet,
          walletBalance: walletBalances.get(token) ?? 0n,
        }),
        ranked: ranked.get(token) ?? [],
      };
    });
  };

  router.get(
    "/largest-holders",
    publicCache(10),
    handler(async (req, res) => {
      const rows = (await load(req, {}, 2)).map((r) => r.row);
      res.json({
        items: rows,
        count: rows.length,
        personalisedFor: typeof req.query.wallet === "string" ? String(req.query.wallet).toLowerCase() : null,
        oneStore: "/api/v1/largest-holders/{storeId or aicToken} — adds the top five eligible holders",
        personalise: "add ?wallet=0xYourWallet for the gap from your own balance",
        readThisFirst: READ_THIS_FIRST,
        howToOvertake: HOW_TO_OVERTAKE,
        eoaOnly: "Only eligible EOAs are ranked. A contract can hold AIC but can never lead or take a store over.",
      });
    })
  );

  router.get(
    "/largest-holders/:id",
    publicCache(10),
    handler(async (req, res) => {
      const id = String(req.params.id).toLowerCase();
      const filter = /^0x[0-9a-f]{40}$/.test(id) ? { aicToken: id } : /^0x[0-9a-f]{64}$/.test(id) ? { storeId: id } : null;
      if (!filter) throw ApiError.invalid("Give a storeId (0x + 64 hex) or an AIC token address (0x + 40 hex)");
      const [found] = await load(req, filter, 5);
      if (!found) throw ApiError.notFound("Store or AIC token");
      res.json({
        ...found.row,
        topEligibleHolders: found.ranked.map((h, i) => ({ rank: i + 1, address: h.holder, balanceAIC: amountAIC(BigInt(h.balance)) })),
        readThisFirst: READ_THIS_FIRST,
        howToOvertake: HOW_TO_OVERTAKE,
        eoaOnly: "Only eligible EOAs are ranked. A contract can hold AIC but can never lead or take a store over.",
      });
    })
  );

  return router;
}
