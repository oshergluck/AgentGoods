/**
 * Open ownership claims.
 *
 * A store's controller can be replaced by its largest eligible holder, and the protocol gives at
 * least an hour of public warning before it happens — a candidacy is announced on chain and
 * cannot be finalized until `TAKEOVER_OBSERVATION_PERIOD` has passed.
 *
 * That warning existed and nobody could see it. `/api/v1/me` tells the affected controller, which
 * is the party that most needs to know, but a takeover is not private: it is public information
 * that holders, buyers and anyone weighing a purchase from that store should be able to read.
 * A store whose ownership may change within the hour is a different proposition from one whose
 * ownership is settled, and a buyer has no way to learn that from a product listing.
 *
 * The GET is a read of indexed state. The three POSTs below only PREPARE the holder's own
 * transactions — openTakeoverCandidacy, cancelTakeoverCandidacy and finalizeTakeover on the store's
 * AIC token — for the holder to sign, exactly like every other write here. Nothing on this server
 * can start, stop or influence a takeover, and no protocol role can either: the contract decides.
 * Without them the path the documentation describes existed only on chain, reachable by encoding
 * calldata by hand, which the same documentation tells every agent never to do.
 */

import { Router } from "express";
import { handler, idempotent, noStore, publicCache, requireAgent, selfWallet } from "../../http/middleware";
import { ApiError, type ErrorCode } from "../../http/errors";
import { buildIntent } from "../../transactions/intents";
import { chainNow } from "../../db/chainTime";
import { StockMarket, Store } from "../../db/models";

/** Matches the contract's TAKEOVER_OBSERVATION_PERIOD. */
const OBSERVATION_PERIOD_SECONDS = 3600;

export function takeoversRouter(): Router {
  const router = Router();

  router.get(
    "/takeovers",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;

      const markets = await StockMarket.find({
        chainId,
        takeoverCandidate: { $ne: null },
      })
        .select({
          storeId: 1,
          aicToken: 1,
          symbol: 1,
          takeoverCandidate: 1,
          takeoverOpenedAt: 1,
          takeoverLockedBalance: 1,
          currentLeader: 1,
          currentLeaderSince: 1,
          rewardPoolAIC: 1,
        })
        .lean();

      const storeIds = markets.map((m) => m.storeId);
      const stores = await Store.find({ chainId, storeId: { $in: storeIds } })
        .select({ storeId: 1, storeController: 1, storeType: 1, "sellerContent.name": 1 })
        .lean();
      const storeById = new Map(stores.map((s) => [s.storeId, s]));

      /*
       * The countdown is measured on the CHAIN clock, not this server's.
       *
       * `takeoverOpenedAt` is a block timestamp, and the contract compares it against
       * `block.timestamp`. Subtracting a wall-clock `Date.now()` from it produces a figure that
       * can exceed the observation period — which is how a previous countdown reported 3645
       * seconds remaining out of a maximum of 3600. Same class as F-007.
       */
      const now = await chainNow(chainId);

      const items = markets.map((m) => {
        const store = storeById.get(m.storeId);
        const openedAt = Number(m.takeoverOpenedAt ?? 0);
        const elapsed = Math.max(0, now - openedAt);
        const remaining = Math.max(0, OBSERVATION_PERIOD_SECONDS - elapsed);

        /*
         * Continuity is the condition that actually decides a takeover, and it is checkable from
         * here: if leadership changed after the candidacy opened, `finalizeTakeover` reverts with
         * LeadershipNotContinuous and the claim can never succeed. Reporting it as "open" without
         * saying so would overstate the threat.
         */
        const leaderSince = Number(m.currentLeaderSince ?? 0);
        const leadershipHeld =
          m.currentLeader != null &&
          m.takeoverCandidate != null &&
          String(m.currentLeader).toLowerCase() === String(m.takeoverCandidate).toLowerCase() &&
          leaderSince <= openedAt;

        return {
          storeId: m.storeId,
          storeName_UNTRUSTED: store?.sellerContent?.name ?? "",
          storeType: store?.storeType ?? null,
          aicToken: m.aicToken,
          symbol: m.symbol ?? null,
          currentController: store?.storeController ?? null,
          claimant: m.takeoverCandidate,
          lockedBalanceAIC: m.takeoverLockedBalance ?? "0",
          openedAt,
          secondsElapsed: elapsed,
          secondsRemaining: remaining,
          finalizableFrom: openedAt + OBSERVATION_PERIOD_SECONDS,
          status: !leadershipHeld
            ? "CANNOT_SUCCEED"
            : remaining > 0
              ? "WAITING"
              : "FINALIZABLE_NOW",
          why: !leadershipHeld
            ? "Leadership changed after this claim was opened, so it can never be finalized. " +
              "The claimant must cancel and start again, which restarts the full hour."
            : remaining > 0
              ? "The observation period has not elapsed. The claimant must hold the lead " +
                "continuously until it does."
              : "The observation period has elapsed and the lead has been held throughout. This " +
                "claim can be finalized at any moment.",
        };
      });

      // Most urgent first: a claim that can be finalized now matters more than one with an hour left.
      items.sort((a, b) => a.secondsRemaining - b.secondsRemaining);

      res.json({
        chainId,
        asOfChainTime: now,
        observationPeriodSeconds: OBSERVATION_PERIOD_SECONDS,
        items,
        counts: {
          open: items.length,
          finalizableNow: items.filter((i) => i.status === "FINALIZABLE_NOW").length,
          doomed: items.filter((i) => i.status === "CANNOT_SUCCEED").length,
        },
        whatThisMeans:
          "A store's controller can be replaced by its largest eligible holder, without consent " +
          "and without any protocol role being involved. It is a feature: a store whose owner " +
          "walks away would otherwise strand its holders permanently. No role can start a " +
          "takeover and no role can block one.",
        forBuyers:
          "A store with an open claim may change hands within the hour. The new controller sets " +
          "prices and metadata, and the AIC reward pool transfers with the store. Licences you " +
          "already hold are unaffected — they live in the store's own immutable LicenseToken.",
        forControllers:
          "Withdrawing your reward pool both rescues that AIC and increases your own eligible " +
          "balance, which can retake the lead and make the claim permanently unfinalizable. See " +
          "STORE_TAKEOVER_MODEL.md.",
      });
    })
  );

  /*
   * The holder's own three steps. Each checks the indexed state first so a call that cannot succeed
   * is refused with the reason and the live figures, rather than prepared and left to revert; the
   * intent is then simulated like every other, and the contract is the final word.
   */
  const TAKEOVER_STEPS = {
    "candidacy-intent": { fn: "openTakeoverCandidacy", action: "open_takeover_candidacy" },
    "cancel-intent": { fn: "cancelTakeoverCandidacy", action: "cancel_takeover_candidacy" },
    "finalize-intent": { fn: "finalizeTakeover", action: "finalize_takeover" },
  } as const;

  for (const [step, { fn, action }] of Object.entries(TAKEOVER_STEPS)) {
    router.post(
      `/stocks/:aicToken/takeover/${step}`,
      noStore,
      requireAgent,
      idempotent({ action, scope: (req) => String(req.params.aicToken).toLowerCase() }),
      handler(async (req, res) => {
        const wallet = selfWallet(req).toLowerCase();
        const chainId = req.ctx.env.CHAIN_ID;
        const aicToken = String(req.params.aicToken).toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(aicToken)) throw ApiError.invalid("aicToken must be a 0x address");
        const m = await StockMarket.findOne({ chainId, aicToken }).lean();
        if (!m) throw ApiError.notFound("Market for this AIC token");
        const store = await Store.findOne({ chainId, storeId: m.storeId }).select({ storeController: 1 }).lean();

        const now = await chainNow(chainId);
        const openedAt = Number(m.takeoverOpenedAt ?? 0);
        const leader = m.currentLeader ? String(m.currentLeader).toLowerCase() : null;
        const leaderSince = Number(m.currentLeaderSince ?? 0);
        const candidate = m.takeoverCandidate ? String(m.takeoverCandidate).toLowerCase() : null;
        const live = {
          currentController: store?.storeController ?? null,
          largestEligibleHolder: leader,
          leaderSince,
          openCandidacy: candidate,
          candidacyOpenedAt: openedAt || null,
          observationPeriodSeconds: OBSERVATION_PERIOD_SECONDS,
          asOfChainTime: now,
          liveList: "/api/v1/takeovers",
        };
        const refuse = (code: ErrorCode, message: string): never => {
          throw new ApiError(code, message, 409, live);
        };

        if (step === "candidacy-intent") {
          if (store?.storeController && String(store.storeController).toLowerCase() === wallet) {
            refuse("ALREADY_CONTROLLER", "You already control this store.");
          }
          if (candidate === wallet) {
            refuse("CANDIDACY_ALREADY_OPEN", "Your candidacy is already open: finalize it once the period has passed, or cancel it.");
          }
          if (leader !== wallet) {
            refuse(
              "NOT_LARGEST_HOLDER",
              "Only the largest eligible EOA holder of this token can open a candidacy, and that is " +
                (leader ?? "nobody yet") + ". Passing them takes a larger balance than theirs; a tie never displaces. " +
                "Only EOA balances count: AIC held by any contract is ineligible."
            );
          }
        } else {
          if (candidate !== wallet) refuse("NO_CANDIDACY", "You have no open takeover candidacy on this token.");
          if (step === "finalize-intent") {
            if (leader !== wallet || leaderSince > openedAt) {
              refuse(
                "LEADERSHIP_NOT_CONTINUOUS",
                "You lost first place after opening the candidacy, so it can never be finalized. Cancel it " +
                  "(which releases your lock) and open a new one once you lead again; the full period restarts."
              );
            }
            const remaining = openedAt + OBSERVATION_PERIOD_SECONDS - now;
            if (remaining > 0) {
              refuse("OBSERVATION_PERIOD_NOT_ELAPSED", `The observation period has ${remaining}s left on the chain clock. Keep the lead until then.`);
            }
          }
        }

        const intent = await buildIntent({
          ctx: req.ctx,
          wallet,
          action,
          contract: aicToken,
          abi: req.ctx.abis.interfaceFor("aic"),
          functionName: fn,
          args: [],
          allowance: null,
          summary: {
            action,
            description:
              step === "candidacy-intent"
                ? "Open a takeover candidacy on this store. Your transferable balance of this token is locked until you finalize or cancel."
                : step === "cancel-intent"
                  ? "Cancel your takeover candidacy and release the lock on your balance."
                  : "Finalize your takeover: control of the store transfers to you.",
            protocol: { aicToken, storeId: m.storeId, ...live },
            warnings:
              step === "candidacy-intent"
                ? [
                    "Your balance is immobile while the candidacy is open.",
                    "Losing first place at any moment makes this candidacy unfinalizable; you would cancel and start the full period again.",
                    "The candidacy is public: the controller is warned (STORE_TAKEOVER_IN_PROGRESS) and anyone can see it on /api/v1/takeovers.",
                  ]
                : step === "finalize-intent"
                  ? [
                      "Control of the business transfers: its products and their administration, its unwithdrawn proceeds, its " +
                        "controller trading fees and its incentive pool.",
                      "Once mined, the store appears in GET /api/v1/me -> stores.items (howYouControlIt: acquired_by_takeover), " +
                        "next to any store you already control — you can control more than one of a type. Operate it like " +
                        "any store you control, with its storeId on every store route.",
                    ]
                  : [],
          },
        });
        res.status(201).json({ intent });
      })
    );
  }

  return router;
}
