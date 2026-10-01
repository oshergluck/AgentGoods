/**
 * Part 2 of 4: what you own — stores, products, licences and AIC positions.
 *
 * Three things here are computed rather than copied out of the projection, and each exists because
 * the raw number on its own led agents to a wrong conclusion:
 *
 *   - **A position is priced as an EXIT**, through the curve's own sell quote, not as balance times
 *     spot. A constant-product curve moves as you sell into it, so multiplying by spot overstates
 *     exactly the positions where being wrong costs most.
 *
 *   - **A controller's proceeds are published with their CLOCK.** The balance alone reads as
 *     "yours, now", and after generation 3 it is not.
 *
 *   - **Ownership is priced as a TARGET.** "How much do I need to invest to own something" has no
 *     fixed answer — it is a share, not a sum — so the answer is solved live against the current
 *     supply, leader and curve price rather than left as "it depends".
 *
 * Pure. Everything comes from `MeContext`; nothing here touches the database or the chain.
 */

import { amountAIC, amountUSDC } from "../../../config/units";
import { dexPoolOf, dexSellOut, dexUsdcToBuy, isGraduated, marketStateOf, quoteSell, usdcToBuyTokens } from "../../../stores/quotes";
import { withdrawalCooldownView } from "../../../stores/withdrawalCooldown";
import type { MeContext } from "./context";
import { leadershipRow } from "../largestHolders";
import { priceDecimal } from "../../../stores/stockMetrics";

/**
 * The three ownership targets, solved against live state.
 *
 * The schema states the rule (dividends.provenOwnership): ownership here is a SHARE, so no fixed
 * sum buys it and the honest answer depends entirely on who else is holding at the moment you ask.
 * That is correct and it is not actionable — an agent cannot plan against "it depends". So each
 * target is solved for the tokens needed and then priced through the curve's inverse buy quote.
 *
 *   (Holders are rewarded by buyback and burn — every sale buys and burns the store's AIC — so there is
 *   no dividend share to size; what a stake reaches is governance and control.)
 *
 *   1. GOVERNANCE CONTROL. The pass rule is yesPower * 2 > eligibleSupply, and buying from the
 *      curve ADDS to eligible supply: the tokens move out of a contract, which is not an eligible
 *      holder, into an EOA, which is. So the target moves as you buy it, and (B+X)*2 > S+X solves
 *      to X > S - 2B. Treating S as fixed is the mistake that makes an agent buy a "majority" that
 *      is not one.
 *
 *   2. THE TAKEOVER RANKING. Not a quantity at all: one base unit past the largest eligible holder,
 *      held continuously for the observation period. Buying does not move the leader, so X = L-B+1.
 *
 * Both are balances to reach, priced through the curve (or the pool after graduation).
 */
function ownershipTargets(
  ctx: MeContext,
  market: Record<string, unknown> | undefined,
  yourBalance: bigint,
  leaderBalance: bigint
): Record<string, unknown> | null {
  if (!market) return null;

  const e = ctx.manifest.economics;
  const state = {
    virtualTokenReserve: BigInt(String(market.virtualTokenReserve ?? "0")),
    virtualUSDCReserve: BigInt(String(market.virtualUSDCReserve ?? "0")),
    tokenInventory: BigInt(String(market.marketInventoryAIC ?? "0")),
    realUSDCReserve: BigInt(String(market.realUSDCReserve ?? "0")),
    netSoldFromCurve: BigInt(String(market.netSoldFromCurveAIC ?? "0")),
  };
  const eligibleSupply = BigInt(String(market.eligibleSupplyAIC ?? "0"));

  const price = (tokens: bigint): Record<string, unknown> => {
    if (tokens <= 0n) {
      return { tokensToBuy: amountAIC(0n), estimatedCostUSDC: amountUSDC(0n), alreadyThere: true };
    }
    const pool = isGraduated(market) ? dexPoolOf(market) : null;
    const cost = pool ? dexUsdcToBuy(pool, tokens) : usdcToBuyTokens(state, tokens, e.agentGoodsProtocolFeeBps, e.agentGoodsControllerFeeBps);
    return {
      tokensToBuy: amountAIC(tokens),
      estimatedCostUSDC: cost === null ? null : amountUSDC(cost),
      alreadyThere: false,
      ...(cost === null
        ? { unreachable: "More tokens than the curve can sell. This target is not buyable on the curve today." }
        : {}),
    };
  };

  /* 2. governance control: X > S - 2B */
  const majorityGap = eligibleSupply - 2n * yourBalance;
  const majorityTarget = majorityGap < 0n ? 0n : majorityGap + 1n;

  /* 3. outrank the leader */
  const leaderTarget = yourBalance > leaderBalance ? 0n : leaderBalance - yourBalance + 1n;

  return {
    yourBalanceAIC: amountAIC(yourBalance),
    eligibleSupplyAIC: amountAIC(eligibleSupply),
    yourShareOfEligibleSupplyPercent:
      eligibleSupply === 0n
        ? null
        : (Number((yourBalance * 1_000_000n) / eligibleSupply) / 10_000).toFixed(4),
    largestEligibleHolderAIC: amountAIC(leaderBalance),

    toControlGovernance: {
      ...price(majorityTarget),
      rule: "yesPower * 2 > eligibleSupplyAtSnapshot. Exactly fifty percent FAILS.",
      whyItIsNotHalfTheSupply:
        "Buying from the curve moves tokens out of a contract and into your wallet, so it RAISES " +
        "eligible supply as you buy. The target solves (yours + X) * 2 > supply + X.",
    },

    toOutrankTheLargestHolder: {
      ...price(leaderTarget),
      thenWhat:
        `Hold first place continuously for ${e.takeoverObservationPeriodSeconds}s to take control ` +
        "of the store. Losing first place at any moment resets the clock, and an exact tie never " +
        "displaces the incumbent.",
    },

    whatHoldingEarns:
      "No dividend: 20% of the store's net commerce buys back and burns its AIC in every purchase, so " +
      "a holder's share of the remaining supply grows as the business sells.",
    pricesAreEstimates:
      "Costs are computed from the projected curve state with the protocol's own arithmetic and " +
      "rounded UP so the target is actually reached. The chain is the authority: confirm with the " +
      "buy quote endpoint before sending a transaction.",
  };
}

/** Curried per request so every row of one response shares one clock and one fee schedule. */
function makeHelpers(ctx: MeContext) {
  const e = ctx.manifest.economics;
  const nowSeconds = Math.floor(Date.now() / 1000);

  /**
   * When this store's controller may next take its proceeds out.
   *
   * Whether the rule applies at all depends on the factory generation that created the store — a
   * clone permanently runs the code it was born with, so a pre-generation-3 store has no cooldown
   * and never will. See stores/withdrawalCooldown.ts.
   */
  const withdrawalTimer = (store: Record<string, unknown>): Record<string, unknown> => {
    const view = withdrawalCooldownView({
      factoryVersion: Number(store.factoryVersion ?? 0),
      lastOwnerWithdrawalAt: Number(store.lastOwnerWithdrawalAt ?? 0),
      cooldownSeconds: e.ownerWithdrawalCooldownSeconds,
      nowSeconds,
    });
    return {
      ...view,
      mayWithdrawNow: view.controllerMayWithdrawNow,
      secondsUntilYouMayWithdraw: view.secondsUntilControllerMayWithdraw,
      whatItDoesNotAffect:
        "The holders' share: 20% of net commerce never reaches you — it buys back and burns your " +
        "store's AIC in each purchase transaction.",
    };
  };

  /** What the curve would actually pay for a position, after fees and its own price impact. */
  const valueOfPosition = (aicToken: string, balance: bigint) => {
    const m = ctx.marketByToken.get(aicToken.toLowerCase());
    if (!m || balance === 0n) return null;
    const state = {
      virtualTokenReserve: BigInt(String(m.virtualTokenReserve ?? "0")),
      virtualUSDCReserve: BigInt(String(m.virtualUSDCReserve ?? "0")),
      tokenInventory: BigInt(String(m.marketInventoryAIC ?? "0")),
      realUSDCReserve: BigInt(String(m.realUSDCReserve ?? "0")),
      netSoldFromCurve: BigInt(String(m.netSoldFromCurveAIC ?? "0")),
    };
    // A graduated market trades on its pool; its curve reserves are frozen and would misprice it.
    const pool = isGraduated(m) ? dexPoolOf(m) : null;
    if (pool) {
      const out = dexSellOut(pool, balance);
      return {
        symbol: String(m.symbol ?? ""),
        phase: String(m.phase ?? "external_dex"),
        venue: "dex" as const,
        quote: { netUSDCOut: out, grossUSDC: out, enoughRealReserve: true },
        state: { ...state, realUSDCReserve: pool.usdcReserve },
      };
    }
    const q = quoteSell(state, balance, e.agentGoodsProtocolFeeBps, e.agentGoodsControllerFeeBps);
    return { symbol: String(m.symbol ?? ""), phase: String(m.phase ?? "bonding_curve"), venue: "curve" as const, quote: q, state };
  };

  const ownershipFor = (aicToken: string) => {
    const key = aicToken.toLowerCase();
    return ownershipTargets(
      ctx,
      ctx.marketByToken.get(key),
      ctx.balanceByToken.get(key) ?? 0n,
      BigInt(ctx.leaderByToken.get(key)?.balance ?? "0")
    );
  };

  return { withdrawalTimer, valueOfPosition, ownershipFor };
}

/** The stores you control, each with its withdrawal clock and what a stake in it would cost. */
export function storesSection(ctx: MeContext) {
  const { withdrawalTimer, ownershipFor } = makeHelpers(ctx);
  const byType = { sales: 0, rentals: 0 };
  for (const s of ctx.controlledStores) byType[s.storeType === "rentals" ? "rentals" : "sales"]++;
  return {
    count: ctx.controlledStoreCount,
    returned: ctx.controlledStores.length,
    byType,
    /*
     * A takeover adds a store to what a wallet controls; it does not replace one. The one-per-type cap is on
     * CREATING a store, so a wallet can control several of a type. Every write names its store, so each is
     * operated on its own — this list is where they all are.
     */
    note:
      "Every store you control now — the ones you created and the ones you acquired by takeover. The one-store-per-type " +
      "limit applies only to creating a store, so you can control more than one of a type. Each store is managed on its " +
      "own: every store route takes its storeId (…/stores/{storeId}/products, …/update, reward-pool, withdraw…), and " +
      "its AIC's routes take its aicToken.",
    items: ctx.controlledStores.map((s) => ({
      storeId: s.storeId,
      howYouControlIt:
        String(s.storeCreator ?? "").toLowerCase() === ctx.wallet.toLowerCase() ? "created" : "acquired_by_takeover",
      storeAddress: s.address,
      storeType: s.storeType,
      status: s.status,
      aicToken: s.aicToken,
      controllerAvailableProceedsUSDC: amountUSDC(BigInt(s.ownerAvailableUSDC ?? "0")),
      /* The store as a business: reach, conversion, retention, economics (playbook operatingAStore). */
      businessMetrics: ctx.businessByStore.get(String(s.storeId)) ?? null,
      /*
       * Your store's token market as another agent's software sees it. Facts only: whether it is
       * initialized, whether it has real liquidity, whether you hold any of it, whether the
       * incentive is funded. An investor screening numerically sees exactly these.
       */
      tokenMarket: (() => {
        const m = ctx.marketByStore.get(s.storeId) as Record<string, unknown> | undefined;
        const own = ctx.ownBalanceByToken.get(String(s.aicToken ?? "").toLowerCase()) ?? 0n;
        const pool = BigInt(String(s.rewardPoolAIC ?? "0"));
        if (!m) return { marketState: "NOT_INDEXED_YET", marketInitialized: false, note: "The market for this token is not indexed yet." };
        const st = marketStateOf(m);
        const holders = Number(m.holderCount ?? 0);
        return {
          marketState: st.state,
          marketInitialized: st.marketInitialized,
          hasLiquidity: st.hasLiquidity,
          priceAvailable: st.priceAvailable,
          sellQuoteAvailable: st.sellQuoteAvailable,
          machineReadableInvestmentMetricsAvailable: st.machineReadableInvestmentMetricsAvailable,
          unavailableReason: st.unavailableReason,
          realReserveUSDC: amountUSDC(BigInt(String(m.realUSDCReserve ?? "0"))),
          ownerAICBalance: amountAIC(own),
          controllerIsHolder: own > 0n,
          incentiveFunded: pool > 0n,
          holdersOtherThanController: Math.max(0, holders - (own > 0n ? 1 : 0)),
          controllerFeesAccruedUSDC: amountUSDC(BigInt(String(m.controllerFeesUSDC ?? "0"))),
          controllerFeesNote:
            "Indexed: after a withdrawal this can show the old amount for a minute or more. The withdraw-intent " +
            "route reads the live amount from the chain and says so when there is nothing to withdraw.",
          controllerFees: {
            whatItIs: "Your fee on every trade of this store's AIC on its bonding curve — only on the curve: after graduation the DEX pool pays the controller nothing.",
            withdraw: `POST /api/v1/stocks/${String(s.aicToken ?? "")}/controller-fees/withdraw-intent (returns the transaction to sign)`,
          },
          capitalSources: ctx.capitalByToken.get(String(s.aicToken ?? "").toLowerCase()) ?? null,
          legacyUninitializedMarket: !st.marketInitialized,
          seedAnalysis: `GET /api/v1/stores/${s.storeId}/seed-analysis?wallet=${ctx.wallet}&amountsUSDC=<your amounts>`,
          roundTripCheck:
            `GET /api/v1/market/tokens/${String(s.aicToken ?? "")}/round-trip?amountUSDC=<amount>&wallet=${ctx.wallet} — ` +
            "what buying and immediately selling back would cost you, before you decide.",
          holdersNote:
            "Wallets other than yours that hold this token. The protocol cannot tell whether two wallets belong to one owner, so this is not a measure of independent demand.",
          ...(st.marketInitialized
            ? {}
            : {
                whatThisMeans:
                  "Your store is live, but its AIC market is not yet initialized. Autonomous investors frequently screen " +
                  "markets numerically; with no usable liquidity, price, sell-value and liquidity figures are not yet " +
                  "meaningful, and your store may be skipped before its products are evaluated.",
              }),
        };
      })(),
      /*
       * The balance above says how much is yours; on its own that reads as "yours, now". After
       * generation 3 it is not: StoreBase allows one withdrawal per cooldown and reverts with
       * WithdrawalTooSoon in between. A controller shown a balance and no timer calls
       * withdrawOwnerProceeds, is reverted, and cannot tell a protocol rule from a bug.
       */
      withdrawal: withdrawalTimer(s as unknown as Record<string, unknown>),
      /*
       * Priced for the controller specifically, because the controller starts at zero. Creating a
       * store grants none of its AIC, so for most controllers this is "what it would cost to own
       * any of the business you built" — the question the schema says has no fixed answer,
       * answered at today's price.
       */
      provenOwnership: ownershipFor(String(s.aicToken ?? "")),
      /*
       * The whole token of THIS store, valued — per store, because a wallet may control two.
       *
       * A controller could see its own holding and nothing about whether anyone had invested in
       * the business. Every token that exists, at the curve's price now, answers that at a glance:
       * it starts at the virtual seed (set per network — not money, the curve's shape) and moves only
       * when someone buys or sells. The real USDC in the curve is the money actually put in.
       */
      yourStoreToken: (() => {
        const m = ctx.marketByStore.get(s.storeId) as Record<string, unknown> | undefined;
        if (!m) return null;
        const vU = BigInt(String(m.virtualUSDCReserve ?? "0"));
        const vT = BigInt(String(m.virtualTokenReserve ?? "0"));
        const supply = BigInt(String(m.currentSupplyAIC ?? "0"));
        const seed = BigInt(String(m.virtualSeedUSDC ?? ctx.manifest.economics.virtualUSDCReserve));
        // After graduation the price is the pool's (indexed as usdc * 1e30 / tokens), not the frozen curve's.
        const graduated = isGraduated(m);
        const price = BigInt(String(m.currentIndexedPrice1e18 ?? "0"));
        const total = graduated ? (supply * price) / 10n ** 30n : vT > 0n ? (supply * vU) / vT : 0n;
        return {
          symbol: String(m.symbol ?? ""),
          totalValueOfAllTokensUSDC: amountUSDC(total),
          startingValueUSDC: amountUSDC(seed),
          changeSinceStartUSDC: { ...amountUSDC(total >= seed ? total - seed : seed - total), sign: total >= seed ? "+" : "-" },
          ...(graduated
            ? { venue: "dex", poolUSDCReserve: amountUSDC(BigInt(String(m.realUSDCReserve ?? "0"))) }
            : { realUSDCInvestedByBuyers: amountUSDC(BigInt(String(m.realUSDCReserve ?? "0"))) }),
          note: graduated
            ? "This token has graduated to its DEX pool: every token that exists, at the pool's price now. " +
              "poolUSDCReserve is the USDC in the pool. A valuation, not what the tokens could be sold for: selling moves the price."
            : "Every token of this store that exists, at the curve's price now. It starts at the " +
            "virtual seed — not real money, the shape of the curve — and rises only when someone " +
            "buys. realUSDCInvestedByBuyers is the money actually put in. This is a valuation, not " +
            "what the tokens could be sold for: selling moves the price down (see a sell quote).",
        };
      })(),
      lifetimeBuybackUSDC: amountUSDC(BigInt(String(s.lifetimeBuybackUSDC ?? "0"))),
      governanceLockActive: Boolean(s.governanceLockActive),
      controllerWithdrawalsLocked: Boolean(s.governanceLockActive),
      unresolvedPassedProposalCount: Number(s.unresolvedPassedProposalCount ?? 0),
    })),
    link: "/api/v1/stores",
  };
}

/** What you are selling. */
export function productsSection(ctx: MeContext) {
  return {
    count: ctx.productCount,
    returned: ctx.products.length,
    items: ctx.products.map((p) => ({
      productId: p.productId,
      storeId: p.storeId,
      productVersion: Number(p.version ?? 0),
      type: p.storeType,
      priceUSDC: amountUSDC(BigInt(p.priceUSDC ?? "0")),
      inventory: p.unlimitedInventory ? "UNLIMITED" : String(p.inventory ?? "0"),
      active: Boolean(p.active),
    })),
    link: "/api/v1/market/products",
  };
}

/**
 * Something you already paid for has a new version waiting.
 *
 * Surfaced as its own block rather than a flag on each licence, because it is a call to action and
 * not a property.
 */
export function updatesSection(ctx: MeContext) {
  return {
    count: ctx.staleLicences.length,
    note:
      ctx.staleLicences.length > 0
        ? "A seller has shipped a NEW VERSION of something you own. You already paid; " +
          "collecting the new version costs nothing. If you signalled that it was not worth " +
          "it, you may signal again now — a new version reopens your verdict."
        : "Nothing you bought has been updated.",
    items: ctx.staleLicences.map((l) => {
      const now = ctx.currentVersionById.get(l.productId) ?? 0;
      return {
        productId: l.productId,
        storeId: l.storeId,
        youHaveVersion: Number(l.productVersion ?? 0),
        currentVersion: now,
        whatTheSellerSaysChanged_UNTRUSTED:
          ctx.changelogByProductVersion.get(`${l.productId}:${now}`) || "(the seller described no change)",
        howToGetIt:
          "POST /api/v1/access/grant with this licence, then fetch the URL it returns. The " +
          "delivered bytes are the new version and still hash-check against the product.",
        youMayReviseYourVerdict:
          "POST /api/v1/licenses/{licenseToken}/{licenseId}/signal with { worthIt, note } — a new " +
          "version reopens a signal that was otherwise final.",
      };
    }),
  };
}

/** What you bought and may still use. Expiry is compared against CHAIN time, not the server's. */
export function licensesSection(ctx: MeContext) {
  return {
    count: ctx.licenseCount,
    returned: ctx.licenses.length,
    items: ctx.licenses.map((l) => ({
      /*
       * licenseToken and licenseId exactly as the grant and signal routes take them. This used
       * to be one combined "token:id" string under the name licenseId, while the grant route
       * said to send licenseId "exactly as /me lists it" — which it then refused.
       */
      licenseToken: l.licenseToken,
      licenseId: String(l.tokenId),
      storeId: l.storeId,
      productId: l.productId,
      productVersion: Number(l.productVersion ?? 0),
      kind: l.kind,
      status: l.expiresAt && Number(l.expiresAt) <= ctx.nowSec ? "EXPIRED" : "ACTIVE",
      expiresAt: l.expiresAt ?? null,
      deliveryRecorded: Boolean(l.delivered),
      next: l.delivered
        ? `rate it: POST /api/v1/licenses/${l.licenseToken}/${l.tokenId}/signal {"worthIt": true|false, "note": "..."}`
        : `collect it: POST /api/v1/access/grant {"licenseToken": "${l.licenseToken}", "licenseId": "${l.tokenId}"}, ` +
          "then GET the URL returned. The protocol records the delivery on chain within about a minute; then rate it.",
    })),
    link: "/api/v1/me/licenses",
  };
}

/** Your equity in this market, priced as an exit and with the next step of ownership costed. */
export function aicPositionsSection(ctx: MeContext) {
  const { valueOfPosition, ownershipFor } = makeHelpers(ctx);

  return {
    count: ctx.holdingCount,
    returned: ctx.holdings.length,
    /*
     * Every position priced in USDC, plus the total. A balance in four different store tokens is
     * four numbers in four units; what a holder needs is what they add up to.
     */
    totalValueIfSoldNowUSDC: amountUSDC(
      ctx.holdings.reduce((sum, h) => {
        const v = valueOfPosition(String(h.aicToken), BigInt(h.balance ?? "0"));
        return sum + (v ? v.quote.netUSDCOut : 0n);
      }, 0n)
    ),
    items: ctx.holdings.map((h) => {
      const balance = BigInt(h.balance ?? "0");
      const locked = BigInt(h.lockedBalance ?? "0");
      const valued = valueOfPosition(String(h.aicToken), balance);
      const isOwnStore = ctx.controlledStoreIds.includes(String(h.storeId));
      return {
        storeId: h.storeId,
        aicToken: h.aicToken,
        symbol: valued?.symbol ?? "",
        isYourOwnStore: isOwnStore,
        balance: amountAIC(balance),
        /*
         * What the next step of ownership costs from where this position already stands.
         * Recomputed per request because every term in it — the curve price, the eligible supply
         * and the largest holder — moves whenever anybody trades.
         */
        /*
         * Both kinds of control, for every AIC held: absolute (a governance majority of eligible supply,
         * toControlGovernance) and by ranking (passing the largest holder, toOutrankTheLargestHolder).
         * Guarded: a target that cannot be priced says so instead of failing /me.
         */
        provenOwnership: (() => {
          try {
            return ownershipFor(String(h.aicToken ?? ""));
          } catch (error) {
            return { available: false, reason: `could not be computed right now (${error instanceof Error ? error.message : String(error)})` };
          }
        })(),
        marketState: (() => {
          const mk = ctx.marketByToken.get(String(h.aicToken ?? "").toLowerCase());
          return mk ? marketStateOf(mk as Record<string, unknown>) : null;
        })(),
        /*
         * The takeover race for THIS token, from where this wallet stands: the largest eligible holder,
         * the tokens and USDC needed to pass it now (curve or pool, priced over the whole purchase), the
         * observation period, and any open candidacy. For every AIC held, not only the agent's own store.
         */
        takeover: (() => {
          try {
          const token = String(h.aicToken ?? "").toLowerCase();
          const mk = ctx.marketByToken.get(token);
          if (!mk) return null;
          const e = ctx.manifest.economics;
          const row = leadershipRow(mk, ctx.storeByIdForPositions.get(String(h.storeId)), ctx.topTwoByToken.get(token) ?? [], {
            fees: { protocolBps: e.agentGoodsProtocolFeeBps, controllerBps: e.agentGoodsControllerFeeBps },
            observationPeriodSeconds: e.takeoverObservationPeriodSeconds,
            now: ctx.nowSec,
            wallet: ctx.wallet,
            walletBalance: balance,
          });
          const st = ctx.storeByIdForPositions.get(String(h.storeId)) ?? {};
          return {
            ...row,
            spotPriceUSDC: priceDecimal(BigInt(String(mk.currentIndexedPrice1e18 ?? "0"))),
            /*
             * Control is not only governance: whoever controls the store receives its income. These are
             * the store's figures now; they go to its controller at the time of withdrawal.
             */
            whatControlBrings: {
              productIncome:
                "The owner's share of every future sale of the store's products (net commerce after the protocol fee, " +
                "less the 20% that buys back and burns the AIC), withdrawn by the controller.",
              unwithdrawnProceedsNowUSDC: amountUSDC(BigInt(String((st as Record<string, unknown>).ownerAvailableUSDC ?? "0"))),
              unwithdrawnTradingFeesNowUSDC: amountUSDC(BigInt(String(mk.controllerFeesUSDC ?? "0"))),
              tradingFeesOnlyOnTheCurve: "The controller's trading fee accrues only while the AIC trades on its bonding curve, never on the DEX pool.",
              incentivePoolNowAIC: amountAIC(BigInt(String((st as Record<string, unknown>).rewardPoolAIC ?? "0"))),
              lifetimeCommerceUSDC: amountUSDC(BigInt(String((st as Record<string, unknown>).lifetimeGrossCommerceUSDC ?? "0"))),
              note:
                "Proceeds, trading fees and the incentive pool are withdrawn by whoever controls the store when they are " +
                "withdrawn — including amounts that accrued before a takeover. The business's recent commerce is in " +
                "GET /api/v1/stocks/{aicToken}/fundamentals.",
            },
          };
          } catch (error) {
            // A takeover read must never fail the whole of /me.
            return { available: false, reason: `could not be computed right now (${error instanceof Error ? error.message : String(error)})` };
          }
        })(),
        transferableBalance: amountAIC(balance > locked ? balance - locked : 0n),
        lockedBalance: amountAIC(locked),
        eligibleForDividends: Boolean(h.eligible),
        /*
         * Priced as an exit would price it, not as balance x spot.
         *
         * A constant-product curve moves as you sell into it, so a large position is worth less per
         * token than a small one. Multiplying by spot price overstates exactly the holdings where
         * being wrong costs most.
         */
        valueIfSoldNow: valued
          ? {
              netUSDCOut: amountUSDC(valued.quote.netUSDCOut),
              grossUSDC: amountUSDC(valued.quote.grossUSDC),
              theCurveCanSettleIt: valued.quote.enoughRealReserve,
              curveRealReserveUSDC: amountUSDC(valued.state.realUSDCReserve),
              venue: valued.venue,
              note: valued.venue === "dex"
                ? "This market has graduated: priced as a sale of the whole position into its DEX pool (0.3% pool fee, with the price impact), not on the retired curve."
                : valued.quote.enoughRealReserve
                ? "Priced by the curve's own sell quote, net of fees, after the price impact of selling this whole position."
                : "The curve CANNOT settle this size right now: a redemption is paid from real USDC reserve, not from the virtual reserve that sets the price. Sell in parts, or wait for buy-side flow.",
            }
          : { note: "No indexed market for this token yet." },
        note:
          "lockedBalance aggregates every reason-scoped lock. The per-reason split " +
          "(governance escrow vs takeover candidacy) is authoritative on chain.",
      };
    }),
    howToReadThis:
      "valueIfSoldNow is what the curve would actually pay you, after fees and after the " +
      "price impact of your own sale. It is not balance x spot price, which overstates a " +
      "large position. theCurveCanSettleIt false means the market cannot pay that size today " +
      "however good the quote looks.",
    link: "/api/v1/tokens",
  };
}
