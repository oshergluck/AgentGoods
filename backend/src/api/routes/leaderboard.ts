/**
 * Wallets ranked by what they are actually worth, in USDC.
 *
 * "Who is doing well here?" had no answer. Prices, volumes and holder counts were all readable,
 * and none of them told you whether any particular participant was ahead — so an Agent deciding
 * whose behaviour to imitate, or whose store to back, had nothing to go on but marketing.
 *
 * ## Equity is valued at what it would really fetch
 *
 * A holding is marked with `AgentGoods.quoteSell` for the WHOLE position, which is what the curve
 * would actually pay to unwind it — not `balance x spot price`. The difference is not pedantic: a
 * bonding curve prices marginally, so a large position in a thin market has a spot valuation far
 * above its exit value, and ranking on spot would put whoever bought the most illiquid token at
 * the top. Marking the real exit makes slippage count against the holder, exactly as it would if
 * they tried to leave.
 *
 * ## What this deliberately is not
 *
 * It is not profit. The protocol cannot see what a wallet paid for anything, or what it held
 * before it arrived, so this is net worth inside this market and nothing more. Saying so matters:
 * a wallet at the top may have bought in high and be down badly.
 *
 * Wallet balances are already public on chain; this endpoint aggregates and values them, it does
 * not disclose anything new. It is nonetheless a ranked list of holdings, and that has real
 * consequences — see `note` in the response.
 */

import { Router } from "express";
import { handler, publicCache } from "../../http/middleware";
import { dexPoolOf, dexSellOut, isGraduated, quoteSell } from "../../stores/quotes";
import { AicHolder, StockMarket, Store } from "../../db/models";

export function leaderboardRouter(): Router {
  const router = Router();

  router.get(
    "/leaderboard",
    publicCache(30),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
      const m = req.ctx.manifest;

      /*
       * Served entirely from the indexed projection. ZERO RPC.
       *
       * The first version of this quoted every position on chain, which would have been correct
       * and would also have broken the rule this whole API is built on: a GET performs no RPC
       * calls, because an endpoint anyone can poll must not be able to exhaust a provider. The
       * curve maths is deterministic given the reserves, and `quoteSell` in stores/quotes.ts
       * already mirrors `AgentGoods.calculateSellReturn` exactly — the same function the write
       * path quotes with. Valuing from the projection is not an approximation of the chain, it
       * is the same arithmetic over indexed inputs.
       */
      const [holdings, markets, stores] = await Promise.all([
        AicHolder.find({ chainId, isContract: false, balance: { $ne: "0" } })
          .select({ holder: 1, aicToken: 1, balance: 1 })
          .lean(),
        StockMarket.find({ chainId })
          .select({
            aicToken: 1,
            virtualTokenReserve: 1,
            virtualUSDCReserve: 1,
            realUSDCReserve: 1,
            netSoldFromCurveAIC: 1,
            marketInventoryAIC: 1,
            lpCreated: 1,
            phase: 1,
            currentIndexedPrice1e18: 1,
          })
          .lean(),
        Store.find({ chainId })
          .select({ storeController: 1, ownerAvailableUSDC: 1, address: 1 })
          .lean(),
      ]);

      const marketByToken = new Map(markets.map((x) => [x.aicToken, x]));

      /*
       * Protocol contracts are not participants, and the `isContract` flag did not catch them.
       *
       * AgentGoods holds every market's unsold inventory, so it ranked FIRST with 76,306 USDC of
       * "holdings" — the exchange's own float presented as the market's biggest winner. A store
       * holds its reward pool for the same reason. Excluding them by address is exact, where the
       * flag depended on the indexer having classified the address correctly.
       */
      const protocolAddresses = new Set(
        [
          m.contracts.agentGoods.proxy,
          m.contracts.registry.proxy,
          m.contracts.protocolTreasury.address,
          ...stores.map((st) => st.address),
        ]
          .filter((a): a is string => typeof a === "string")
          .map((a) => a.toLowerCase())
      );

      const equityByWallet = new Map<string, { value: bigint; positions: number; unquotable: number }>();
      for (const h of holdings) {
        const amount = BigInt(h.balance);
        if (amount === 0n) continue;
        if (protocolAddresses.has(h.holder)) continue;
        const entry = equityByWallet.get(h.holder) ?? { value: 0n, positions: 0, unquotable: 0 };
        entry.positions += 1;

        const market = marketByToken.get(h.aicToken);
        // A graduated market is valued on its pool: what selling the whole position there pays.
        const pool = market && isGraduated(market) ? dexPoolOf(market) : null;
        if (pool) {
          entry.value += dexSellOut(pool, amount);
          equityByWallet.set(h.holder, entry);
          continue;
        }
        if (!market || isGraduated(market)) {
          /*
           * A graduated market has no curve to sell back to, so the protocol cannot value the
           * position without reading an external DEX. Counted and reported rather than guessed
           * at, because marking it zero would understate a real holding and inventing a price
           * would be worse.
           */
          entry.unquotable += 1;
          equityByWallet.set(h.holder, entry);
          continue;
        }

        const quote = quoteSell(
          {
            virtualTokenReserve: BigInt(market.virtualTokenReserve ?? "0"),
            virtualUSDCReserve: BigInt(market.virtualUSDCReserve ?? "0"),
            realUSDCReserve: BigInt(market.realUSDCReserve ?? "0"),
            netSoldFromCurve: BigInt(market.netSoldFromCurveAIC ?? "0"),
            // Not used by the sell formula, which depends only on the reserves and the amount.
            tokenInventory: BigInt(market.marketInventoryAIC ?? "0"),
          },
          amount,
          m.economics.agentGoodsProtocolFeeBps ?? 0,
          m.economics.agentGoodsControllerFeeBps ?? 0
        );
        entry.value += quote.netUSDCOut;
        equityByWallet.set(h.holder, entry);
      }

      const proceedsByWallet = new Map<string, bigint>();
      const storeCount = new Map<string, number>();
      for (const store of stores) {
        const owner = store.storeController;
        proceedsByWallet.set(owner, (proceedsByWallet.get(owner) ?? 0n) + BigInt(store.ownerAvailableUSDC ?? "0"));
        storeCount.set(owner, (storeCount.get(owner) ?? 0) + 1);
      }

      /*
       * USDC balances come from the indexed projection when it tracks them. Where it does not,
       * the wallet is ranked on equity and proceeds alone and the response says so — an omission
       * stated is recoverable, an omission hidden is a wrong ranking presented as a right one.
       */
      const wallets = new Set([...equityByWallet.keys(), ...proceedsByWallet.keys()]);
      /*
       * Cash is NOT counted, and that is stated rather than quietly omitted.
       *
       * The indexer does not project USDC balances — it tracks protocol state, and a wallet's
       * cash is an ERC-20 balance on a token the protocol does not own. Reading it would mean an
       * RPC call per wallet on a public GET, which this API does not do. So this ranks holdings
       * INSIDE the protocol: equity at its real exit value, plus proceeds not yet withdrawn.
       *
       * That is a real limitation and the response says so. A leaderboard that silently dropped
       * a term would rank an agent sitting on cash below one holding the same value in equity,
       * and present it as the whole picture.
       */
      const cashByWallet = new Map<string, bigint>();
      const cashTracked = false;

      const rows = [...wallets].map((wallet) => {
        const equity = equityByWallet.get(wallet) ?? { value: 0n, positions: 0, unquotable: 0 };
        const cash = cashByWallet.get(wallet) ?? 0n;
        const proceeds = proceedsByWallet.get(wallet) ?? 0n;
        const total = cash + equity.value + proceeds;
        return {
          wallet,
          totalUSDC: (Number(total) / 1e6).toFixed(2),
          breakdown: {
            cashUSDC: null,
            equityAtExitUSDC: (Number(equity.value) / 1e6).toFixed(2),
            unwithdrawnProceedsUSDC: (Number(proceeds) / 1e6).toFixed(2),
          },
          equityPositions: equity.positions,
          positionsNotValued: equity.unquotable,
          storesControlled: storeCount.get(wallet) ?? 0,
          _sort: total,
        };
      });

      rows.sort((a, b) => (b._sort > a._sort ? 1 : b._sort < a._sort ? -1 : 0));

      res.json({
        chainId,
        valuedAt: new Date().toISOString(),
        items: rows.slice(0, limit).map(({ _sort, ...row }, index) => ({ rank: index + 1, ...row })),
        counts: { ranked: rows.length, returned: Math.min(limit, rows.length) },
        howEquityIsValued:
          "Every AIC position is marked at what the curve would really pay to unwind the WHOLE " +
          "holding, net of fees — the same arithmetic the protocol quotes a sale with, never " +
          "balance times spot price. A curve prices marginally, so a large position in a thin " +
          "market is worth materially less than its spot valuation suggests and this ranking " +
          "reflects that.",
        whatThisIsNot:
          "NOT profit. The protocol cannot see what a wallet paid, or what it held before it " +
          "arrived here. A wallet at the top may have bought in high and be losing badly. This " +
          "is net worth inside this market at today's exit prices, and nothing more.",
        excluded:
          "Protocol contracts: the exchange (which holds every market's unsold inventory), the " +
          "registry, the treasury and the stores themselves. None of them is a participant, and " +
          "the exchange's float alone would otherwise sit at the top of this table.",
        doesNotCountCash:
          "A wallet's USDC balance is NOT included. The indexer projects protocol state, and a " +
          "cash balance is an ERC-20 balance the protocol does not own — reading it would mean an " +
          "RPC call per wallet on a public endpoint, which this API never does. This therefore " +
          "ranks holdings INSIDE the protocol: equity at its real exit value plus unwithdrawn " +
          "proceeds. An agent sitting on cash will rank lower here than its true net worth.",
        note:
          "Wallet balances are already public on chain; this aggregates and values them rather " +
          "than revealing anything new. It is still a ranked list of holdings.",
      });
    })
  );

  return router;
}
