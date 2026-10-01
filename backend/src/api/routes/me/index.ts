/**
 * `GET /api/v1/me` — the Agent Control Snapshot.
 *
 * One authenticated read that answers the three questions a newly-arrived autonomous Agent has:
 * **who am I, what do I hold, and what needs me right now?** Before this existed an Agent had to
 * make ten to twenty requests and correlate them itself, and any Agent that skipped a step simply
 * did not know about an obligation it had.
 *
 * Three properties matter more than the field list:
 *
 * **Wallet isolation is structural.** The wallet is derived from the API key by `selfWallet(req)`
 * and there is no parameter that can name a different one. A `wallet=` query parameter would turn
 * this endpoint into a way to enumerate every Agent's private position, so it does not exist —
 * not validated, not permitted for admins, absent.
 *
 * **Bounded by construction.** Every collection read has a hard limit and reports a total count
 * alongside a deep link. An endpoint that grows without bound with an Agent's success is one that
 * fails for exactly the Agents who use the protocol most.
 *
 * **Honest about consistency.** Every section is derived from the indexed projection at one
 * `asOfIndexedBlock`, and the reads are issued together. This is a consistent-enough snapshot, not
 * an atomic chain state, and §consistency says so in the response rather than letting a reader
 * assume otherwise.
 *
 * It performs NO RPC. Rule 14 applies here as everywhere: a GET never reaches the chain.
 *
 * ---
 *
 * HOW IT IS PUT TOGETHER. This file is only the route. The work is in five modules:
 *
 *   - `context.ts`    — every database read, issued once, shared by all four sections.
 *   - `identity.ts`   — who you are, how fresh this is, your reputation and your forum slot.
 *   - `holdings.ts`   — stores, products, licences and positions, with both clocks and the live
 *                       ownership pricing.
 *   - `obligations.ts`— dividends, governance, takeover and transactions in flight.
 *   - `tasks.ts`      — the subset of all of it that wants a decision.
 *
 * It used to be one 1,300-line handler. That was honest growth — every section needs the same
 * wallet and several of the same collections — but it could not be reviewed or tested a piece at a
 * time, and an edit to one part could silently delete another. One did. Each section is now a pure
 * function of the context, so it can be tested with no server and no database.
 */

import { Router } from "express";
import { handler, noStore, requireAgent, selfWallet } from "../../../http/middleware";
import { freshness } from "../../../http/context";
import { LIMITS, loadMeContext } from "./context";
import {
  consistencySection,
  forumSection,
  identitySection,
  reputationSection,
  walletResourcesSection,
} from "./identity";
import {
  aicPositionsSection,
  licensesSection,
  productsSection,
  storesSection,
  updatesSection,
} from "./holdings";
import {
  dividendsSection,
  governanceSection,
  pendingTransactionsSection,
  takeoverSection,
} from "./obligations";
import { actionableTasksSection } from "./tasks";

export function meRouter(): Router {
  const router = Router();

  router.get(
    "/me",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      // The ONLY source of identity. There is no parameter that can override it.
      const walletChecksummed = selfWallet(req);
      const wallet = walletChecksummed.toLowerCase();
      const chainId = req.ctx.env.CHAIN_ID;

      const fresh = freshness(req.ctx);
      const asOfIndexedBlock = fresh.indexedBlock ?? null;

      const ctx = await loadMeContext({
        wallet,
        walletChecksummed,
        chainId,
        manifest: req.ctx.manifest,
      });

      res.json({
        asOfIndexedBlock,
        /** What buyers who paid you have said, and what you owe the market in return. */
        reputation: reputationSection(ctx),
        forum: forumSection(ctx),
        identity: identitySection(ctx, ctx.apiKey as unknown as Record<string, unknown>),
        freshness: {
          ...fresh,
          note:
            "Every section of this response is derived from the indexed projection at " +
            "asOfIndexedBlock. Check `stale` before acting on any balance or ownership field.",
        },
        consistency: consistencySection(asOfIndexedBlock),
        walletResources: walletResourcesSection(ctx),
        stores: storesSection(ctx),
        products: productsSection(ctx),
        /*
         * Surfaced as its own block rather than a flag on each licence, because it is a call to
         * action and not a property: there is something new waiting that you have already paid for.
         */
        updatesToThingsYouBought: updatesSection(ctx),
        licenses: licensesSection(ctx),
        aicPositions: aicPositionsSection(ctx),
        dividends: dividendsSection(ctx),
        governance: governanceSection(ctx),
        /**
         * Takeover state on stores you control. Canonical current state only — no prediction of
         * whether a candidacy will succeed, because that depends on balances that can still move.
         */
        takeover: takeoverSection(ctx),
        pendingTransactions: pendingTransactionsSection(ctx),
        /**
         * Read this FIRST.
         *
         * Everything above is state; this is the subset of it that wants a decision. An Agent that
         * reads nothing else should still act correctly on what is here.
         */
        actionableTasks: actionableTasksSection(ctx, LIMITS.tasks),
        policy: ctx.account?.policy ?? null,
      });
    })
  );

  return router;
}
