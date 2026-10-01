/**
 * Part 3 of 4: what is owed to you, and what you owe.
 *
 * Dividends, governance duties, takeover pressure and transactions still in flight. These are the
 * sections where reporting a number without its STATE would be actively misleading, so each one
 * separates the money that can move now from the money that merely exists:
 *
 *   - an entitlement whose epoch is not FINALIZED is not claimable, and calling it claimable sends
 *     an Agent to a contract that will refuse it;
 *   - an entitlement blocked by a governance proposal is suspended, not lost, and the difference
 *     decides whether an Agent should wait or act;
 *   - a store's unfinalized holder reserve is not the controller's money at all, and is reported
 *     here only so a controller understands what the figure on its store actually is.
 *
 * Pure. Everything comes from `MeContext`.
 */

import { amountAIC, amountUSDC } from "../../../config/units";
import { TAKEOVER_OBSERVATION_SECONDS, toUnixSeconds, type MeContext } from "./context";

/** An entitlement, resolved against the state of the epoch it belongs to. */
export interface ResolvedEntitlement {
  storeId: string;
  distributor: string;
  epochId: string;
  index: number;
  amount: bigint;
  claimed: boolean;
  /** FINALIZED epochs are claimable; anything earlier is still being agreed. */
  finalized: boolean;
  /** Blocked by at least one unresolved governance proposal. */
  suspended: boolean;
}

/**
 * Split every entitlement into the four states that lead to different actions.
 *
 * Exported so it can be tested directly: the arithmetic that decides whether an Agent believes it
 * has money waiting is worth pinning down without a database.
 */
export function resolveEntitlements(ctx: MeContext): ResolvedEntitlement[] {
  return ctx.entitlements.map((e) => {
    const epoch = ctx.epochByKey.get(`${String(e.distributor).toLowerCase()}:${e.epochId}`);
    return {
      storeId: String(e.storeId),
      distributor: String(e.distributor),
      epochId: String(e.epochId),
      index: Number(e.index ?? 0),
      amount: BigInt(e.amountUSDC ?? "0"),
      claimed: Boolean(e.claimed),
      finalized: String(epoch?.state ?? "") === "FINALIZED",
      suspended: Array.isArray(e.blockingProposalIds) && e.blockingProposalIds.length > 0,
    };
  });
}

/**
 * What the protocol owes you, in four separate figures.
 *
 * They are separate because they are not interchangeable. Claimable is money you can take now;
 * pending is money that exists but whose epoch is not agreed yet; suspended is money a governance
 * proposal is holding; claimed is history. Summing them into one "dividends" number would tell an
 * Agent it has money it cannot touch.
 */
export function dividendsSection(ctx: MeContext) {
  const resolved = resolveEntitlements(ctx);

  let claimableUSDC = 0n;
  let pendingUSDC = 0n;
  let claimedUSDC = 0n;
  let suspendedUSDC = 0n;
  const claimableRefs: { storeId: string; distributor: string; epochId: string; index: number }[] = [];

  for (const r of resolved) {
    if (r.claimed) {
      claimedUSDC += r.amount;
      continue;
    }
    if (r.suspended) {
      suspendedUSDC += r.amount;
      continue;
    }
    if (!r.finalized) {
      pendingUSDC += r.amount;
      continue;
    }
    claimableUSDC += r.amount;
    /* Bounded: an Agent that needs the full list follows the link rather than growing this one. */
    if (claimableRefs.length < 25) {
      claimableRefs.push({
        storeId: r.storeId,
        distributor: r.distributor,
        epochId: r.epochId,
        index: r.index,
      });
    }
  }

  /*
   * Store-level reserve on stores this wallet CONTROLS.
   *
   * Reported here and labelled hard, because it is the number most likely to be misread as income.
   * It is not the controller's money, it is not withdrawable by anyone, and its only possible
   * destination is a dividend epoch paid to holders.
   */
  const unfinalizedReserveExposure = ctx.controlledStores.reduce(
    (acc, s) => acc + BigInt(s.unfinalizedHolderReserveUSDC ?? "0"),
    0n
  );

  return {
    totalClaimableUSDC: amountUSDC(claimableUSDC),
    totalPendingFinalizationUSDC: amountUSDC(pendingUSDC),
    totalClaimedUSDC: amountUSDC(claimedUSDC),
    suspendedGovernanceUSDC: amountUSDC(suspendedUSDC),
    claimableCount: claimableRefs.length,
    claimableRefs,
    note:
      "Dividends were replaced by buyback and burn: 20% of every sale's net commerce buys the store's AIC " +
      "and burns it in the purchase transaction. Nothing new accrues here to claim.",
    link: "/api/v1/dividends/me",
  };
}

/**
 * Proposals you voted YES on that now need you to verify the implementation.
 *
 * The original YES coalition is the party that asked for the change, so it is the party the
 * protocol asks whether the change was actually made. An unverified implementation is a duty, not
 * an option: it holds the store's governance lock open.
 */
export function verificationDuties(ctx: MeContext) {
  const yesByProposal = new Set(ctx.votes.map((v) => `${String(v.governance).toLowerCase()}:${v.proposalId}`));
  return ctx.proposals
    .filter((p) => String(p.state) === "IMPLEMENTED_AWAITING_VERIFICATION")
    .filter((p) => yesByProposal.has(`${String(p.governance).toLowerCase()}:${p.proposalId}`))
    .map((p) => ({
      storeId: String(p.storeId),
      proposalId: String(p.proposalId),
      governance: String(p.governance),
      implementationRound: Number(p.implementationRound ?? 0),
      markedImplementedAt: toUnixSeconds(p.markedImplementedAt),
    }));
}

/** Where you stand in every governance process that can reach you. */
export function governanceSection(ctx: MeContext) {
  const duties = verificationDuties(ctx);

  /*
   * AIC locked by governance participation, across every position.
   *
   * `lockedBalance` aggregates every reason-scoped lock, so this is an upper bound on what
   * governance is holding rather than an exact split; the per-reason breakdown is on chain.
   */
  const governanceLockedAIC = ctx.holdings.reduce((acc, h) => acc + BigInt(h.lockedBalance ?? "0"), 0n);

  const activeVotes = ctx.votes
    .filter((v) => {
      const p = ctx.proposals.find(
        (x) =>
          String(x.governance).toLowerCase() === String(v.governance).toLowerCase() &&
          String(x.proposalId) === String(v.proposalId)
      );
      return p && String(p.state) === "ACTIVE";
    })
    .slice(0, 25)
    .map((v) => ({
      storeId: String(v.storeId),
      proposalId: String(v.proposalId),
      support: Boolean(v.support),
      weight: amountAIC(BigInt(v.weight ?? "0")),
    }));

  return {
    activeVotes,
    passedProposalObligations: ctx.controlledStores
      .filter((s) => Number(s.unresolvedPassedProposalCount ?? 0) > 0)
      .map((s) => ({
        storeId: s.storeId,
        unresolvedPassedProposalCount: Number(s.unresolvedPassedProposalCount ?? 0),
        governanceLockActive: Boolean(s.governanceLockActive),
      })),
    originalYesVerificationDuties: duties,
    governanceLockedAIC: amountAIC(governanceLockedAIC),
    storesAffected: [
      ...new Set([
        ...duties.map((d) => d.storeId),
        ...ctx.controlledStores.filter((s) => s.governanceLockActive).map((s) => s.storeId),
      ]),
    ],
    link: "/api/v1/governance/tasks",
  };
}

/**
 * Takeover state on stores you control.
 *
 * Canonical current state only — no prediction of whether a candidacy will succeed, because that
 * depends on balances that can still move.
 */
export function takeoverSection(ctx: MeContext) {
  return {
    activeCandidaciesAgainstYourStores: ctx.markets
      .filter((m) => m.takeoverCandidate && m.takeoverCandidate !== ctx.wallet)
      .map((m) => {
        const openedAt = Number(m.takeoverOpenedAt ?? 0);
        const finalizableAt = openedAt > 0 ? openedAt + TAKEOVER_OBSERVATION_SECONDS : null;
        const store = ctx.controlledStores.find((s) => s.storeId === m.storeId);
        return {
          storeId: m.storeId,
          aicToken: m.aicToken,
          candidate: m.takeoverCandidate,
          currentLeader: m.currentLeader ?? null,
          observationStartedAt: openedAt || null,
          observationRemainingSeconds:
            finalizableAt !== null ? Math.max(0, finalizableAt - ctx.nowSec) : null,
          candidateLockedAIC: amountAIC(BigInt(m.takeoverLockedBalance ?? "0"), String(m.symbol ?? "") || undefined),
          rewardPoolAtRiskAIC: amountAIC(BigInt(store?.rewardPoolAIC ?? "0"), String(m.symbol ?? "") || undefined),
        };
      }),
    yourOwnCandidacies: ctx.markets
      .filter((m) => m.takeoverCandidate === ctx.wallet)
      .map((m) => ({
        storeId: m.storeId,
        observationStartedAt: Number(m.takeoverOpenedAt ?? 0) || null,
      })),
    yourStanding: yourStanding(ctx),
    note:
      "A candidacy cannot be finalized for at least 3600 seconds of chain time, and only " +
      "while its holder has led continuously since it opened. Overtaking the candidate " +
      "resets that clock and makes the candidacy permanently unfinalizable. The reward pool " +
      "belongs to the STORE and transfers with control: withdraw it before finalization or " +
      "it is lost, and withdrawing also increases your own eligible balance.",
  };
}

/**
 * Whether this wallet leads any store's takeover race, told every time, including when it leads
 * none. For the tokens it holds or controls and does not lead, who does and by how much. The cost
 * of passing them is priced per position under aicPositions (provenOwnership.toOutrankTheLargestHolder);
 * any store's race is at /api/v1/largest-holders.
 */
function yourStanding(ctx: MeContext) {
  const leads = ctx.leadingMarkets.map((m) => {
    const token = String(m.aicToken).toLowerCase();
    const top = ctx.leadRankByToken.get(token) ?? [];
    const mine = BigInt(top[0]?.holder === ctx.wallet ? top[0].balance : String(ctx.balanceByToken.get(token) ?? 0n));
    const second = top[1] ?? null;
    const isYourStore = ctx.controlledStores.some((s) => String(s.aicToken ?? "").toLowerCase() === token);
    return {
      storeId: m.storeId,
      aicToken: token,
      symbol: m.symbol ?? null,
      isYourOwnStore: isYourStore,
      yourBalanceAIC: amountAIC(mine),
      runnerUp: second ? { address: second.holder, balanceAIC: amountAIC(BigInt(second.balance)) } : null,
      yourMarginAIC: amountAIC(mine - BigInt(second?.balance ?? "0")),
      leaderSinceChainTime: Number(m.currentLeaderSince ?? 0) || null,
      yourCandidacyOpen: m.takeoverCandidate === ctx.wallet,
      whatItMeans: isYourStore
        ? "You lead your own store's race: nobody can take it over while you keep first place."
        : "You could open a takeover candidacy on this store now: POST /api/v1/stocks/" + token +
          "/takeover/candidacy-intent — only if control is worth it to you.",
    };
  });
  const leadTokens = new Set(leads.map((l) => l.aicToken));

  const ledBySomeoneElse = [...ctx.marketByToken.entries()]
    .filter(([token]) => !leadTokens.has(token))
    .map(([token, m]) => {
      const leader = ctx.leaderByToken.get(token);
      const isYourStore = ctx.controlledStores.some((s) => String(s.aicToken ?? "").toLowerCase() === token);
      return {
        storeId: m.storeId,
        aicToken: token,
        symbol: m.symbol ?? null,
        isYourOwnStore: isYourStore,
        largestEligibleHolder: leader ? { address: leader.holder, balanceAIC: amountAIC(BigInt(leader.balance)) } : null,
        yourBalanceAIC: amountAIC(ctx.balanceByToken.get(token) ?? 0n),
        ...(isYourStore && leader
          ? {
              warning:
                "Someone else leads your own store's takeover race. If they open a candidacy and hold first place " +
                "for the observation period, control of your store passes to them.",
            }
          : {}),
        costToPass: "aicPositions / stores -> provenOwnership.toOutrankTheLargestHolder",
      };
    });

  return {
    summary:
      leads.length === 0
        ? "You are not the largest eligible holder of any store."
        : `You are the largest eligible holder of ${leads.length} store${leads.length === 1 ? "" : "s"}: ` +
          leads.map((l) => l.symbol ?? l.aicToken).join(", ") + ".",
    youLead: leads,
    tokensYouHoldOrControlLedBySomeoneElse: ledBySomeoneElse,
    anyStore: "/api/v1/largest-holders (all stores) or /api/v1/largest-holders/{storeId or aicToken}; add ?wallet=0xYou for your gap",
    eoaOnly: "Only eligible EOA balances count. AIC you hold through any contract does not rank.",
  };
}

/** Transactions you have prepared that the projection has not CONFIRMED yet. */
export function pendingTransactionsSection(ctx: MeContext) {
  return {
    count: ctx.intentCount,
    returned: ctx.intents.length,
    items: ctx.intents.map((i) => ({
      intentId: i.intentId,
      type: i.action,
      status: i.status,
      expiresAt: toUnixSeconds(i.expiresAt),
      expired: new Date(i.expiresAt).getTime() < Date.now(),
      // The link a wallet fetches this transaction from — no calldata to copy. Expired: prepare it again.
      transactionRequest: `/api/v1/tx/${i.intentId}`,
      txHash: i.txHash ?? null,
      asOfIndexedBlock: i.asOfIndexedBlock ?? null,
    })),
  };
}
