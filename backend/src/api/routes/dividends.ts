/**
 * Dividend routes.
 *
 * MASTER_PLAN 0.22.A and 0.25.V. The personal dividend view is strict about what money
 * actually belongs to the Agent:
 *
 *   claimableNowUSDC          entitlement already committed to a FINALIZED distribution
 *   pendingFinalizationUSDC   individually determined but not yet claimable
 *   storeUnfinalizedReserve   store-level accumulated reserve. NOT personal money.
 *   claimedLifetimeUSDC       already received
 *
 * Presenting a share of unfinalized store reserve as if it were the Agent's money would be a
 * lie, because balances can change before the snapshot. The distinction is preserved in the
 * response shape, in the field names and in an explicit note.
 */

import { Router } from "express";
import { z } from "zod";
import { DividendEntitlement, DividendEpoch, AicHolder, Store } from "../../db/models";
import { ApiError } from "../../http/errors";
import { handler, idempotent, noStore, publicCache, requireAgent, selfWallet } from "../../http/middleware";
import { freshness } from "../../http/context";
import { amountUSDC, amountAIC } from "../../config/units";
import { buildIntent } from "../../transactions/intents";

/**
 * Basis points as a percentage, with trailing zeros trimmed: 2000 -> "20%", 475 -> "4.75%".
 *
 * Every percentage this module states is produced here from a deployed rate, so a deployment that
 * changes a rate changes the sentence with it.
 */
function pct(bps: number): string {
  const value = bps / 100;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}%`;
}

/**
 * What holders actually receive, in basis points of store net commerce.
 *
 * The reserve is taken from net commerce; the processing fee is taken from the RESERVE. Two bases,
 * one multiplication — and the place every sentence about the yield gets its number.
 */
function effectiveHolderShareBps(e: { holderReserveBps: number; dividendProcessingFeeBps: number }): number {
  return Math.round((e.holderReserveBps * (10_000 - e.dividendProcessingFeeBps)) / 10_000);
}

/** Every dividend response carries this: the reserve that funded dividends is now spent on buyback and burn. */
export const DIVIDENDS_REPLACED =
  "Dividends were replaced by buyback and burn. 20% of every sale's net commerce now buys the store's own " +
  "AIC on its market and burns it in the purchase transaction, so nothing new accrues to distribute or claim. " +
  "What holders gain shows as a smaller supply and a higher price: see burnedAIC, buybackBurnedAIC and " +
  "lifetimeBuybackUSDC on /api/v1/market/tokens.";

export function dividendsRouter(): Router {
  const router = Router();
  /*
   * Stamp the replacement notice on every JSON answer of THIS router's routes, success or refusal —
   * and only those. Mounted on /api/v1, an unscoped use() ran for every request passing through, so a
   * product listing, a forum post or a buy came back headed "Dividends were replaced…", and agents read
   * their own successful listing as a retired route and never signed it.
   */
  router.use("/dividends", (_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: unknown) =>
      json(body && typeof body === "object" && !Array.isArray(body) ? { replacedBy: DIVIDENDS_REPLACED, ...(body as object) } : body);
    next();
  });

  /** Personal dividend position across every canonical store. Never cacheable. [0.27.Q] */
  router.get(
    "/dividends/me",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req).toLowerCase();
      const chainId = req.ctx.env.CHAIN_ID;

      const entitlements = await DividendEntitlement.find({ chainId, account: wallet }).lean();
      const epochIds = [...new Set(entitlements.map((e) => `${e.distributor}:${e.epochId}`))];
      const epochs = await DividendEpoch.find({
        chainId,
        $or: epochIds.map((k) => {
          const [distributor, epochId] = k.split(":");
          return { distributor, epochId };
        }),
      }).lean();
      const epochByKey = new Map(epochs.map((e) => [`${e.distributor}:${e.epochId}`, e]));

      const holdings = await AicHolder.find({ chainId, holder: wallet }).lean();
      const storeIds = [
        ...new Set([...entitlements.map((e) => e.storeId), ...holdings.map((h) => h.storeId)]),
      ];
      const stores = await Store.find({ chainId, storeId: { $in: storeIds } }).lean();
      const storeById = new Map(stores.map((s) => [s.storeId, s]));

      let totalClaimable = 0n;
      let totalPending = 0n;
      let totalClaimed = 0n;
      const byStore = new Map<string, Record<string, unknown>>();

      for (const storeId of storeIds) {
        const store = storeById.get(storeId);
        if (!store) continue;
        const holding = holdings.find((h) => h.storeId === storeId);
        byStore.set(storeId, {
          storeId,
          storeAddress: store.address,
          storeName: store.sellerContent?.name ?? "",
          aicToken: store.aicToken,
          currentAICBalance: amountAIC(BigInt(holding?.balance ?? "0")),
          claimableNowUSDC: amountUSDC(0n),
          pendingFinalizationUSDC: amountUSDC(0n),
          claimedLifetimeUSDC: amountUSDC(0n),
          storeUnfinalizedReserveUSDC: {
            ...amountUSDC(BigInt(store.unfinalizedHolderReserveUSDC)),
            isYourMoney: false,
            note:
              "Store-level accumulated holder reserve. It is NOT your money yet: your share is " +
              "only determined when a distribution epoch snapshots holders.",
          },
          openDistributions: [] as unknown[],
        });
      }

      for (const e of entitlements) {
        const epoch = epochByKey.get(`${e.distributor}:${e.epochId}`);
        if (!epoch) continue;
        const entry = byStore.get(e.storeId);
        if (!entry) continue;

        const amount = BigInt(e.amountUSDC);
        const finalized = epoch.state === "FINALIZED";
        const suspended = e.blockingProposalIds.length > 0;

        if (e.claimed) {
          totalClaimed += amount;
          entry.claimedLifetimeUSDC = amountUSDC(
            BigInt((entry.claimedLifetimeUSDC as { base: string }).base) + amount
          );
        } else if (finalized && !suspended) {
          totalClaimable += amount;
          entry.claimableNowUSDC = amountUSDC(
            BigInt((entry.claimableNowUSDC as { base: string }).base) + amount
          );
        } else {
          totalPending += amount;
          entry.pendingFinalizationUSDC = amountUSDC(
            BigInt((entry.pendingFinalizationUSDC as { base: string }).base) + amount
          );
        }

        (entry.openDistributions as unknown[]).push({
          distributionId: e.epochId,
          distributor: e.distributor,
          snapshotBlock: epoch.snapshotBlock,
          entitlementUSDC: amountUSDC(amount),
          claimed: e.claimed,
          claimable: finalized && !suspended && !e.claimed,
          epochState: epoch.state,
          governanceSuspension: suspended
            ? {
                active: true,
                blockingProposalIds: e.blockingProposalIds,
                note:
                  "You voted YES on a passed proposal that is still unresolved. This entitlement " +
                  "is protected and waiting, not forfeited, and nobody else can take it.",
              }
            : null,
        });
      }

      res.json({
        wallet: selfWallet(req),
        summary: {
          claimableNowUSDC: amountUSDC(totalClaimable),
          pendingFinalizationUSDC: amountUSDC(totalPending),
          claimedLifetimeUSDC: amountUSDC(totalClaimed),
          storesWithClaimableBalance: [...byStore.values()].filter(
            (s) => BigInt((s.claimableNowUSDC as { base: string }).base) > 0n
          ).length,
          openClaimCount: entitlements.filter((e) => !e.claimed).length,
        },
        stores: [...byStore.values()],
        semantics: {
          claimableNowUSDC: "Committed to a finalized distribution and claimable right now.",
          pendingFinalizationUSDC: "Individually determined but the epoch is not finalized yet.",
          storeUnfinalizedReserveUSDC: "Store-level reserve. NOT your money and not a promise of one.",
        },
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/dividends/me/claims",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req).toLowerCase();
      const chainId = req.ctx.env.CHAIN_ID;
      const entitlements = await DividendEntitlement.find({ chainId, account: wallet, claimed: false }).lean();
      res.json({
        claims: entitlements.map((e) => ({
          distributionId: e.epochId,
          distributor: e.distributor,
          storeId: e.storeId,
          index: e.index,
          amountUSDC: amountUSDC(BigInt(e.amountUSDC)),
          blockingProposalIds: e.blockingProposalIds,
          claimIntentEndpoint: `/api/v1/dividends/${e.distributor}/${e.epochId}/claim-intent`,
        })),
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/dividends/stores/:storeId",
    publicCache(15),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const store = await Store.findOne({ chainId, storeId: req.params.storeId }).lean();
      if (!store) throw ApiError.notFound("Store");
      const epochs = await DividendEpoch.find({ chainId, storeId: store.storeId })
        .sort({ createdBlock: -1 })
        .limit(50)
        .lean();

      res.json({
        storeId: store.storeId,
        distributor: store.dividendDistributor,
        unfinalizedHolderReserveUSDC: amountUSDC(BigInt(store.unfinalizedHolderReserveUSDC)),
        lifetimeHolderReserveAccruedUSDC: amountUSDC(BigInt(store.lifetimeHolderReserveAccruedUSDC)),
        rates: {
          holderReserveBps: req.ctx.manifest.economics.holderReserveBps,
          holderReserveBasis: "store_net_commerce",
          dividendProcessingFeeBps: req.ctx.manifest.economics.dividendProcessingFeeBps,
          dividendProcessingFeeBasis: "committed_holder_reserve",
          /*
           * DERIVED from the two rates above it, never written as prose.
           *
           * This sentence said "95% of the 5% reserve, which is 4.75% of store net commerce" while
           * the reserve beside it read 2000 bps from the manifest. On a deployment at 20% every
           * number in the sentence was wrong, and wrong in the direction that matters most: an
           * agent pricing AIC off this text would have valued the yield at a quarter of what the
           * contract actually pays, on the single parameter that exists to make equity worth
           * holding. The schema had already been repaired this way; this copy had not.
           *
           * A rate that appears twice will eventually appear twice differently, so it appears once.
           */
          note:
            `These are different bases. ${pct(req.ctx.manifest.economics.holderReserveBps)} of ` +
            `store net commerce is reserved for holders, and the ` +
            `${pct(req.ctx.manifest.economics.dividendProcessingFeeBps)} processing fee is charged ` +
            `ON THAT RESERVE when an epoch is committed. Holders therefore receive ` +
            `${pct(10_000 - req.ctx.manifest.economics.dividendProcessingFeeBps)} of ` +
            `${pct(req.ctx.manifest.economics.holderReserveBps)}, which is ` +
            `${pct(effectiveHolderShareBps(req.ctx.manifest.economics))} of store net commerce. ` +
            `The processing fee is never an additional ` +
            `${pct(req.ctx.manifest.economics.dividendProcessingFeeBps)} of store commerce.`,
        },
        epochs: epochs.map((e) => ({
          distributionId: e.epochId,
          state: e.state,
          snapshotBlock: e.snapshotBlock,
          // MASTER_PLAN 29C: entitlement weight is the minimum balance across this window, so
          // the window is part of the epoch record and not a live parameter read.
          holdingWindowSeconds: e.holdingWindowSeconds ?? 0,
          windowStartBlock: e.windowStartBlock ?? 0,
          eligibleEOASupply: amountAIC(BigInt(e.eligibleMinSupply ?? "0")),
          eligibleSupplyAtSnapshot: amountAIC(BigInt(e.eligibleSupplyAtSnapshot)),
          eligibilityRule:
            "weight = minimum eligible balance across [windowStartBlock, snapshotBlock]. A " +
            "position opened inside the window carries zero weight in this epoch.",
          committedReserveUSDC: amountUSDC(BigInt(e.committedReserveUSDC)),
          processingFeeUSDC: amountUSDC(BigInt(e.processingFeeUSDC)),
          claimableUSDC: amountUSDC(BigInt(e.claimableUSDC)),
          claimedUSDC: amountUSDC(BigInt(e.claimedUSDC)),
          merkleRoot: e.merkleRoot,
          datasetHash: e.datasetHash,
          challengeEndsAt: e.challengeEndsAt,
          finalizedAt: e.finalizedAt,
          claimDeadline: null,
          unclaimedPolicy: "no expiry; holder funds are never returned to the controller",
        })),
        freshness: freshness(req.ctx),
      });
    })
  );

  /** Permissionless epoch opening, exposed as an intent so anyone can trigger it. [0.21.A] */
  router.post(
    "/dividends/stores/:storeId/open",
    noStore,
    requireAgent,
    idempotent({ action: "open_distribution", scope: (req) => req.params.storeId }),
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;
      const store = await Store.findOne({ chainId, storeId: req.params.storeId }).lean();
      if (!store) throw ApiError.notFound("Store");

      const reserve = BigInt(store.unfinalizedHolderReserveUSDC);
      const minimum = BigInt(req.ctx.manifest.economics.minDistributionUSDC);
      if (reserve < minimum) {
        throw ApiError.invalid(
          `Accumulated holder reserve (${reserve}) is below the minimum distribution threshold ` +
            `(${minimum}). It stays safely accumulated until a later epoch.`,
          { reserve: reserve.toString(), minimum: minimum.toString() }
        );
      }

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "open_distribution",
        contract: store.dividendDistributor,
        abi: req.ctx.abis.interfaceFor("distributor"),
        functionName: "openDistribution",
        args: [],
        allowance: null,
        summary: {
          action: "open_distribution",
          description:
            "Open a new dividend distribution epoch for this store. Permissionless: a hostile " +
            "or absent controller cannot censor holder distributions.",
          protocol: {
            storeId: store.storeId,
            distributor: store.dividendDistributor,
            availableReserveUSDC: amountUSDC(reserve),
          },
          warnings: [
            "The snapshot block is the block before your transaction, so it cannot be chosen " +
              "after observing mempool trades.",
          ],
        },
      });

      res.status(201).json({ intent });
    })
  );

  router.post(
    "/dividends/:distributor/:epochId/claim-intent",
    noStore,
    requireAgent,
    idempotent({
      action: "claim_dividend",
      scope: (req) => `${req.params.distributor}:${req.params.epochId}`,
    }),
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;
      const distributor = req.params.distributor.toLowerCase();

      const epoch = await DividendEpoch.findOne({ chainId, distributor, epochId: req.params.epochId }).lean();
      if (!epoch) throw ApiError.notFound("Distribution");
      if (epoch.state !== "FINALIZED") {
        throw new ApiError(
          "DISTRIBUTION_NOT_FINALIZED",
          `This distribution is ${epoch.state}. Claims open only after the root is finalized.`,
          409,
          { state: epoch.state, challengeEndsAt: epoch.challengeEndsAt }
        );
      }

      const entitlement = await DividendEntitlement.findOne({
        chainId,
        distributor,
        epochId: req.params.epochId,
        account: wallet.toLowerCase(),
      }).lean();
      if (!entitlement) throw ApiError.notFound("Entitlement for this wallet in this distribution");
      if (entitlement.claimed) {
        throw new ApiError("ALREADY_CLAIMED", "This entitlement has already been claimed", 409);
      }

      if (entitlement.blockingProposalIds.length > 0) {
        const { Proposal } = await import("../../db/models");
        const unresolved = await Proposal.find({
          chainId,
          storeId: entitlement.storeId,
          proposalId: { $in: entitlement.blockingProposalIds },
          state: { $ne: "IMPLEMENTATION_VERIFIED" },
        }).lean();
        if (unresolved.length > 0) {
          throw new ApiError(
            "GOVERNANCE_SUSPENSION_ACTIVE",
            "You voted YES on a passed proposal that is still unresolved. Your entitlement is " +
              "protected and will become claimable when the YES coalition verifies the change.",
            409,
            { blockingProposalIds: unresolved.map((p) => p.proposalId) }
          );
        }
      }

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "claim_dividend",
        contract: distributor,
        abi: req.ctx.abis.interfaceFor("distributor"),
        functionName: "claim",
        args: [
          BigInt(req.params.epochId),
          BigInt(entitlement.index),
          wallet,
          BigInt(entitlement.amountUSDC),
          entitlement.blockingProposalIds.map((b) => BigInt(b)),
          entitlement.proof,
        ],
        allowance: null,
        summary: {
          action: "claim_dividend",
          description: `Claim your ${entitlement.amountUSDC} USDC base units from distribution ${req.params.epochId}.`,
          protocol: {
            distributor,
            distributionId: req.params.epochId,
            index: entitlement.index,
            amountUSDC: amountUSDC(BigInt(entitlement.amountUSDC)),
            snapshotBlock: epoch.snapshotBlock,
            merkleRoot: epoch.merkleRoot,
          },
          warnings: ["Each entitlement can be claimed exactly once."],
        },
      });

      res.status(201).json({ intent });
    })
  );

  return router;
}

export const DividendQuery = z.object({});
