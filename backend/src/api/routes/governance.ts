/**
 * Governance routes.
 *
 * MASTER_PLAN 0.28.E and 0.29.O. Two distinct notification moments exist and the API keeps
 * them distinct:
 *
 *   on PASSAGE            every original YES voter learns its dividend duty is active;
 *   on MARK_IMPLEMENTED   every original YES voter gets an actionable verification task.
 *
 * A missed webhook never removes a duty: this state is reconstructable from the chain, and
 * `/notifications` and `/governance/tasks` are projections of it, not the authority.
 */

import { Router } from "express";
import { z } from "zod";
import { Proposal, Store, Vote } from "../../db/models";
import { ApiError } from "../../http/errors";
import { handler, idempotent, noStore, publicCache, requireAgent, selfWallet } from "../../http/middleware";
import { freshness } from "../../http/context";
import { buildIntent } from "../../transactions/intents";
import { amountAIC } from "../../config/units";
import { SELLER_CONTENT_NOTE } from "../serializers";

export const YES_VOTE_WARNING =
  "A YES vote can cause the Store to lock immediately if the proposal passes. From passage " +
  "until at least 50% of the original YES voting power confirms the implemented change, your " +
  "prospective dividend eligibility for this Store is suspended. Already-finalized dividends " +
  "are unaffected.";

function proposalView(p: Record<string, unknown>): unknown {
  return {
    protocol: {
      proposalId: p.proposalId,
      storeId: p.storeId,
      governance: p.governance,
      proposer: p.proposer,
      contentHash: p.contentHash,
      state: p.state,
      snapshotBlock: p.snapshotBlock,
      eligibleSupplyAtSnapshot: amountAIC(BigInt(String(p.eligibleSupplyAtSnapshot ?? "0"))),
      votingDeadline: p.votingDeadline,
      yesPower: amountAIC(BigInt(String(p.yesPower ?? "0"))),
      noPower: amountAIC(BigInt(String(p.noPower ?? "0"))),
      totalOriginalYesPower: amountAIC(BigInt(String(p.totalOriginalYesPower ?? "0"))),
      confirmedYesPower: amountAIC(BigInt(String(p.confirmedYesPower ?? "0"))),
      requiredYesPower: amountAIC(BigInt(String(p.requiredYesPower ?? "0"))),
      implementationRound: p.implementationRound,
      evidenceHash: p.evidenceHash,
      passedAt: p.passedAt,
      markedImplementedAt: p.markedImplementedAt,
      resolvedAt: p.resolvedAt,
      passRule: "yesPower * 2 > eligibleEOASupplyAtSnapshot. Exactly 50% does not pass.",
      verificationRule:
        "verifiedYesPower * 2 >= totalOriginalYesPower. That is 50% of the ORIGINAL YES " +
        "coalition, not 50% of eligible supply.",
    },
    sellerContent: {
      descriptionURI: (p.sellerContent as { descriptionURI?: string } | undefined)?.descriptionURI ?? "",
      evidenceURI: (p.sellerContent as { evidenceURI?: string } | undefined)?.evidenceURI ?? "",
      note: SELLER_CONTENT_NOTE,
    },
  };
}

export function governanceRouter(): Router {
  const router = Router();

  router.get(
    "/proposals",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const filter: Record<string, unknown> = { chainId };
      if (typeof req.query.storeId === "string") filter.storeId = req.query.storeId;
      if (typeof req.query.state === "string") filter.state = req.query.state;
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 100);
      const docs = await Proposal.find(filter).sort({ createdBlock: -1, createdLogIndex: -1 }).limit(limit).lean();
      res.json({ items: docs.map(proposalView), freshness: freshness(req.ctx) });
    })
  );

  router.get(
    "/proposals/:governance/:proposalId",
    publicCache(10),
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const p = await Proposal.findOne({
        chainId,
        governance: req.params.governance.toLowerCase(),
        proposalId: req.params.proposalId,
      }).lean();
      if (!p) throw ApiError.notFound("Proposal");
      const votes = await Vote.find({
        chainId,
        governance: p.governance,
        proposalId: p.proposalId,
      }).lean();

      res.json({
        proposal: proposalView(p),
        votes: votes.map((v) => ({
          voter: v.voter,
          support: v.support,
          weight: amountAIC(BigInt(v.weight)),
          confirmedRound: v.confirmedRound,
          confirmedAt: v.confirmedAt,
        })),
        freshness: freshness(req.ctx),
      });
    })
  );

  /** Actionable governance tasks for the authenticated Agent. [0.28.E] */
  router.get(
    "/governance/tasks",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req).toLowerCase();
      const chainId = req.ctx.env.CHAIN_ID;

      const yesVotes = await Vote.find({ chainId, voter: wallet, support: true }).lean();
      const proposals = await Proposal.find({
        chainId,
        $or: yesVotes.map((v) => ({ governance: v.governance, proposalId: v.proposalId })),
      }).lean();

      const verificationTasks = proposals
        .filter((p) => p.state === "IMPLEMENTED_AWAITING_VERIFICATION")
        .map((p) => {
          const vote = yesVotes.find((v) => v.governance === p.governance && v.proposalId === p.proposalId);
          return {
            type: "GOVERNANCE_IMPLEMENTATION_VERIFICATION_REQUIRED",
            proposalId: p.proposalId,
            storeId: p.storeId,
            governance: p.governance,
            round: p.implementationRound,
            alreadyConfirmedThisRound: vote?.confirmedRound === p.implementationRound,
            yourOriginalYesWeight: amountAIC(BigInt(vote?.weight ?? "0")),
            totalOriginalYesPower: amountAIC(BigInt(p.totalOriginalYesPower)),
            confirmedYesPower: amountAIC(BigInt(p.confirmedYesPower)),
            requiredYesPower: amountAIC(BigInt(p.requiredYesPower)),
            controllerAttestation: { evidenceHash: p.evidenceHash, markedImplementedAt: p.markedImplementedAt },
            evidenceIsUntrusted:
              "The controller attestation is untrusted. Inspect the canonical state yourself " +
              "before confirming.",
            intentEndpoint: `/api/v1/governance/${p.governance}/${p.proposalId}/verify-intent`,
          };
        });

      const dutyNotices = proposals
        .filter((p) => p.state === "PASSED_AWAITING_IMPLEMENTATION")
        .map((p) => ({
          type: "GOVERNANCE_DIVIDEND_DUTY_ACTIVE",
          proposalId: p.proposalId,
          storeId: p.storeId,
          governance: p.governance,
          passedAt: p.passedAt,
          note:
            "Your YES vote passed. Your prospective dividend eligibility for this store is " +
            "suspended, and your AIC is transfer-locked, until the coalition verifies the " +
            "implementation. Nothing is forfeited.",
        }));

      res.json({ verificationTasks, dutyNotices, freshness: freshness(req.ctx) });
    })
  );

  /** Combined notification feed, a projection of the same chain state. */
  router.get(
    "/notifications",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req).toLowerCase();
      const chainId = req.ctx.env.CHAIN_ID;
      const { DividendEntitlement } = await import("../../db/models");

      const [claims, yesVotes] = await Promise.all([
        DividendEntitlement.find({ chainId, account: wallet, claimed: false }).lean(),
        Vote.find({ chainId, voter: wallet, support: true }).lean(),
      ]);
      const proposals = yesVotes.length
        ? await Proposal.find({
            chainId,
            $or: yesVotes.map((v) => ({ governance: v.governance, proposalId: v.proposalId })),
          }).lean()
        : [];

      const notifications = [
        ...claims.map((c) => ({
          type: "dividend.claim_available",
          storeId: c.storeId,
          distributionId: c.epochId,
          amountUSDCBase: c.amountUSDC,
          blocked: c.blockingProposalIds.length > 0,
        })),
        ...proposals
          .filter((p) => p.state === "IMPLEMENTED_AWAITING_VERIFICATION")
          .map((p) => ({
            type: "governance.verification_required",
            storeId: p.storeId,
            proposalId: p.proposalId,
            round: p.implementationRound,
          })),
        ...proposals
          .filter((p) => p.state === "PASSED_AWAITING_IMPLEMENTATION")
          .map((p) => ({ type: "governance.proposal_passed", storeId: p.storeId, proposalId: p.proposalId })),
      ];

      res.json({
        notifications,
        note:
          "Notifications are a projection, never authority. A missed webhook never removes a " +
          "duty or an entitlement; this endpoint is always reconstructable from chain state.",
        freshness: freshness(req.ctx),
      });
    })
  );

  /* ------------------------------------------------------------ intents */

  router.post(
    "/stores/:storeId/proposals",
    noStore,
    requireAgent,
    idempotent({ action: "create_proposal", scope: (req) => req.params.storeId }),
    handler(async (req, res) => {
      const Body = z.object({
        contentHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        descriptionURI: z.string().max(2048).optional(),
        votingPeriodSeconds: z.number().int().min(3600).max(30 * 24 * 3600),
      });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid proposal", { issues: parsed.error.issues });

      const wallet = selfWallet(req);
      const store = await Store.findOne({ chainId: req.ctx.env.CHAIN_ID, storeId: req.params.storeId }).lean();
      if (!store) throw ApiError.notFound("Store");

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "create_proposal",
        contract: store.governance,
        abi: req.ctx.abis.interfaceFor("governance"),
        functionName: "propose",
        args: [parsed.data.contentHash, parsed.data.descriptionURI ?? "", parsed.data.votingPeriodSeconds],
        allowance: null,
        summary: {
          action: "create_proposal",
          description: "Create a governance proposal for this store.",
          protocol: { storeId: store.storeId, governance: store.governance },
          warnings: [
            "Make the request concrete and implementable. A passed proposal that cannot be " +
              "implemented has no silent timeout and no controller escape.",
          ],
        },
      });

      res.status(201).json({ intent });
    })
  );

  router.post(
    "/governance/:governance/:proposalId/vote",
    noStore,
    requireAgent,
    idempotent({
      action: "cast_vote",
      scope: (req) => `${req.params.governance}:${req.params.proposalId}`,
    }),
    handler(async (req, res) => {
      const Body = z.object({ support: z.boolean() });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid vote", { issues: parsed.error.issues });

      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;
      const proposal = await Proposal.findOne({
        chainId,
        governance: req.params.governance.toLowerCase(),
        proposalId: req.params.proposalId,
      }).lean();
      if (!proposal) throw ApiError.notFound("Proposal");
      if (proposal.state !== "ACTIVE") {
        throw new ApiError("PROPOSAL_CLOSED", `This proposal is ${proposal.state}`, 409);
      }

      const existing = await Vote.findOne({
        chainId,
        governance: proposal.governance,
        proposalId: proposal.proposalId,
        voter: wallet.toLowerCase(),
      }).lean();
      if (existing) throw new ApiError("VOTE_ALREADY_CAST", "You have already voted on this proposal", 409);

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "cast_vote",
        contract: proposal.governance,
        abi: req.ctx.abis.interfaceFor("governance"),
        functionName: "castVote",
        args: [BigInt(proposal.proposalId), parsed.data.support],
        allowance: null,
        summary: {
          action: "cast_vote",
          description: `Vote ${parsed.data.support ? "YES" : "NO"} on proposal ${proposal.proposalId}.`,
          protocol: {
            storeId: proposal.storeId,
            proposalId: proposal.proposalId,
            support: parsed.data.support,
            snapshotBlock: proposal.snapshotBlock,
            passRule: "yesPower * 2 > eligibleEOASupplyAtSnapshot",
          },
          warnings: parsed.data.support
            ? [
                YES_VOTE_WARNING,
                "Your AIC becomes transfer-locked for the amount of your voting power until this " +
                  "proposal resolves. You keep ownership; you simply cannot move those units.",
              ]
            : ["A NO vote creates no dividend duty and no transfer lock."],
        },
      });

      res.status(201).json({ intent, yesVoteWarning: YES_VOTE_WARNING });
    })
  );

  router.post(
    "/governance/:governance/:proposalId/verify-intent",
    noStore,
    requireAgent,
    idempotent({
      action: "verify_implementation",
      scope: (req) => `${req.params.governance}:${req.params.proposalId}`,
    }),
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;
      const proposal = await Proposal.findOne({
        chainId,
        governance: req.params.governance.toLowerCase(),
        proposalId: req.params.proposalId,
      }).lean();
      if (!proposal) throw ApiError.notFound("Proposal");
      if (proposal.state !== "IMPLEMENTED_AWAITING_VERIFICATION") {
        throw new ApiError(
          "PROPOSAL_CLOSED",
          `This proposal is ${proposal.state}; there is nothing to verify yet.`,
          409
        );
      }

      const vote = await Vote.findOne({
        chainId,
        governance: proposal.governance,
        proposalId: proposal.proposalId,
        voter: wallet.toLowerCase(),
        support: true,
      }).lean();
      if (!vote) {
        throw new ApiError(
          "NOT_ORIGINAL_YES_VOTER",
          "Only members of the original YES coalition may verify an implementation.",
          403
        );
      }

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "verify_implementation",
        contract: proposal.governance,
        abi: req.ctx.abis.interfaceFor("governance"),
        functionName: "confirmImplementation",
        args: [BigInt(proposal.proposalId)],
        allowance: null,
        summary: {
          action: "verify_implementation",
          description: `Confirm that the controller implemented proposal ${proposal.proposalId}.`,
          protocol: {
            storeId: proposal.storeId,
            proposalId: proposal.proposalId,
            round: proposal.implementationRound,
            yourWeight: amountAIC(BigInt(vote.weight)),
            confirmedYesPower: amountAIC(BigInt(proposal.confirmedYesPower)),
            requiredYesPower: amountAIC(BigInt(proposal.requiredYesPower)),
          },
          warnings: [
            "Verify the actual canonical state yourself. The controller attestation is untrusted.",
            "Reaching the threshold atomically releases the store withdrawal lock and your " +
              "suspended dividends.",
          ],
        },
      });

      res.status(201).json({ intent });
    })
  );

  /** The narrow controller obligation surface. [0.29.P] */
  router.post(
    "/governance/:governance/:proposalId/mark-implemented",
    noStore,
    requireAgent,
    idempotent({
      action: "mark_implemented",
      scope: (req) => `${req.params.governance}:${req.params.proposalId}`,
    }),
    handler(async (req, res) => {
      const Body = z.object({
        evidenceHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        evidenceURI: z.string().max(2048).optional(),
      });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid attestation", { issues: parsed.error.issues });

      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;
      const proposal = await Proposal.findOne({
        chainId,
        governance: req.params.governance.toLowerCase(),
        proposalId: req.params.proposalId,
      }).lean();
      if (!proposal) throw ApiError.notFound("Proposal");

      const store = await Store.findOne({ chainId, storeId: proposal.storeId }).lean();
      if (!store) throw ApiError.notFound("Store");
      if (store.storeController.toLowerCase() !== wallet.toLowerCase()) {
        throw ApiError.forbidden("Only the current storeController may attest an implementation.");
      }

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "mark_implemented",
        contract: proposal.governance,
        abi: req.ctx.abis.interfaceFor("governance"),
        functionName: "markImplemented",
        args: [BigInt(proposal.proposalId), parsed.data.evidenceHash, parsed.data.evidenceURI ?? ""],
        allowance: null,
        summary: {
          action: "mark_implemented",
          description: `Attest that you implemented proposal ${proposal.proposalId}.`,
          protocol: { storeId: proposal.storeId, proposalId: proposal.proposalId },
          warnings: [
            "This is an attestation only. It unlocks nothing and restores no dividend.",
            "The store stays locked until at least 50% of the original YES power confirms.",
          ],
        },
      });

      res.status(201).json({ intent });
    })
  );

  return router;
}
