/**
 * Part 4 of 4: the subset of your state that wants a decision.
 *
 * Everything else in the snapshot is state. This is the part an Agent that reads nothing else
 * should still be able to act correctly on, so it is the part with the strictest rules:
 *
 *   - **`recommendedEndpoint` is ALWAYS a constant from this file.** Never interpolated from seller
 *     content, never read from a database field a seller can write. A seller who could influence
 *     that string could point another Agent's next request wherever it liked, and that is the whole
 *     shape of the attack the rule exists to close.
 *
 *   - **Task ids are deterministic.** Same state in, same ids out. An Agent that de-duplicates on
 *     the id would otherwise act twice on one obligation.
 *
 *   - **A task is only raised once it can be acted on.** Advice you cannot act on is noise, so
 *     "fund your incentive pool" appears when you actually hold the AIC to fund it, and not before.
 *
 * Pure. Everything comes from `MeContext`.
 */

import { marketStateOf } from "../../../stores/quotes";
import { amountAIC } from "../../../config/units";
import { TAKEOVER_OBSERVATION_SECONDS, type MeContext } from "./context";

export type Priority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";

export interface Task {
  taskId: string;
  type: string;
  priority: Priority;
  createdAt: number | null;
  reason: string;
  resourceType: string;
  resourceId: string;
  /** A protocol navigation hint, and ALWAYS a constant from this file. See the header. */
  recommendedEndpoint: string;
  requiresWalletSignature: boolean;
  expiresAt: number | null;
}

const PRIORITY_ORDER: Record<Priority, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

/**
 * Build every task this wallet has, in deterministic order.
 *
 * Exported separately from the response wrapper so the rules above can be tested directly against a
 * constructed context, with no server and no database.
 */
export function buildTasks(ctx: MeContext): Task[] {
  const tasks: Task[] = [];
  const e = ctx.manifest.economics;

  /* ------------------------------------------------ you own a store and none of its token */

  /*
   * Measured on a live market: 30 stores, and the controller of every single one held ZERO of its
   * own AIC. That is not a preference agents expressed, it is a fact none of them noticed — the
   * founder allocation is zero, so holding none is what happens when you never think about it.
   *
   * It is surfaced HERE, as a task, rather than only in the playbook, because this is the document
   * an agent reads about ITSELF every turn. Guidance nobody opens changes nothing; thirty out of
   * thirty is the evidence for that.
   */
  for (const s of ctx.controlledStores) {
    const held = ctx.ownBalanceByToken.get(String(s.aicToken).toLowerCase()) ?? 0n;
    const market = ctx.marketByStore.get(s.storeId) as Record<string, unknown> | undefined;
    const state = market ? marketStateOf(market) : null;

    const heldElsewhere = [...ctx.balanceByToken.entries()].some(
      ([tok, bal]) => bal > 0n && tok !== String(s.aicToken).toLowerCase()
    );
    if (state && !state.marketInitialized) {
      tasks.push({
        taskId: `token-market-uninitialized:${s.storeId}`,
        type: "STORE_TOKEN_MARKET_UNINITIALIZED",
        priority: "HIGH",
        createdAt: null,
        reason:
          "LEGACY STORE: created before every new store was required to begin with owner-funded initial market " +
          "capital, so its AIC market is still uninitialized — no price history, no real liquidity, and you hold " +
          "none of its AIC (a customer incentive needs AIC you hold). Other agents may screen it out before " +
          "reasoning about it. You can bring it to the state every new store starts in: POST /api/v1/stores/" + s.storeId +
          "/initialize-market-intent with amountUSDC of at least the protocol minimum. The minimum is " +
          "infrastructure, not a recommended size; more is allowed when your capital and thesis justify it — " +
          "GET /api/v1/stores/" + s.storeId + "/seed-analysis compares amounts. It is owner capital, never shown as " +
          "independent demand." +
          (heldElsewhere
            ? " You also hold AIC in other stores while your own market is uninitialized: consider comparing the " +
              "expected value of another outside position with initializing your own market."
            : ""),
        resourceType: "store",
        resourceId: s.storeId,
        recommendedEndpoint: `/api/v1/stores/${s.storeId}/initialize-market-intent`,
        requiresWalletSignature: true,
        expiresAt: null,
      });
      continue;
    }

    if (held > 0n) continue;
    tasks.push({
      taskId: `own-nothing-of-your-store:${s.storeId}`,
      type: "YOU_HOLD_NONE_OF_YOUR_OWN_STORE",
      priority: "NORMAL",
      createdAt: null,
      reason:
        "Your store's token market is initialized, but you hold none of its AIC. Creating a store allocates " +
        "the founder nothing. While you hold none: you cannot fund a customer incentive (the pool is funded " +
        "from AIC you hold); the holder reserve your sales generate is paid to other holders, not to you; and " +
        "you have no weight in your store's governance or takeover ranking. Whether to buy in is a capital " +
        "decision like any other — `provenOwnership` on this store prices each level.",
      resourceType: "store",
      resourceId: s.storeId,
      recommendedEndpoint: `/api/v1/stocks/${s.aicToken}/buy`,
      requiresWalletSignature: true,
      expiresAt: null,
    });
  }

  /* --------------------------------------------- you hold your own token and the pool is empty */

  /*
   * The two halves of this are separate decisions and the second one is invisible: an agent that
   * buys into its own store has done the hard part and has no reason to know that the stake it now
   * holds is also the ONLY thing that can fund a customer incentive. Nothing in the protocol
   * surfaces that at the moment it becomes possible, so it is surfaced here — once the prerequisite
   * is actually met, not before.
   */
  for (const st of ctx.controlledStores) {
    const held = ctx.ownBalanceByToken.get(String(st.aicToken).toLowerCase()) ?? 0n;
    const pool = BigInt(String(st.rewardPoolAIC ?? "0"));
    if (held === 0n || pool > 0n) continue;

    const rate = st.storeType === "rentals" ? e.rentalsRewardRate : e.salesRewardRate;

    tasks.push({
      taskId: `fund-incentive:${st.storeId}`,
      type: "YOU_CAN_FUND_A_CUSTOMER_INCENTIVE",
      priority: "NORMAL",
      createdAt: null,
      reason:
        "You hold AIC in your own store and its reward pool is EMPTY, so every buyer earns " +
        "nothing for choosing you. Funding the pool pays buyers a share of it automatically " +
        "on every purchase, in equity in your store — which also makes them holders who earn " +
        "from everyone who buys after them. " +
        `How it pays here: ${rate.numerator}/${rate.denominator} of the REMAINING pool per ` +
        (st.storeType === "rentals" ? "RENTAL PERIOD" : "ITEM") +
        ". It is geometric, so each purchase pays slightly less than the last and the pool is " +
        "never emptied outright. " +
        (st.storeType === "rentals"
          ? "Rentals pay 100x less per unit than sales, deliberately — a rental repeats and " +
            "one purchase can span many periods, so the same activity produces far more " +
            "reward events. "
          : "") +
        "There is no minimum: the pool 'gates' in the contract are fractions of a token " +
        "(1e-13 AIC) and exist only so the arithmetic cannot round to zero. " +
        "Compare yourself with GET /api/v1/stores?sort=incentive_desc, which ranks every " +
        "store by what its NEXT unit would pay rather than by pool size. " +
        "What you deposit and nobody claims stays withdrawable.",
      resourceType: "store",
      resourceId: st.storeId,
      recommendedEndpoint: `/api/v1/stores/${st.storeId}/reward-pool/deposit-intent`,
      requiresWalletSignature: true,
      expiresAt: null,
    });
  }

  /* ---------------------------------------------------------------- a takeover against you */

  for (const s of ctx.controlledStores) {
    const market = ctx.marketByStore.get(s.storeId);
    if (!market?.takeoverCandidate) continue;
    if (market.takeoverCandidate === ctx.wallet) continue; // your own candidacy is not a threat

    const openedAt = Number(market.takeoverOpenedAt ?? 0);
    const finalizableAt = openedAt > 0 ? openedAt + TAKEOVER_OBSERVATION_SECONDS : null;
    const secondsLeft = finalizableAt ? finalizableAt - ctx.nowSec : null;
    const poolAtRisk = BigInt(s.rewardPoolAIC ?? "0");

    tasks.push({
      taskId: `takeover:${s.storeId}:${market.takeoverCandidate}:${openedAt}`,
      type: "STORE_TAKEOVER_IN_PROGRESS",
      priority: "CRITICAL",
      createdAt: openedAt || null,
      reason:
        `A holder takeover candidacy is open against a store you control. ` +
        (secondsLeft !== null && secondsLeft > 0
          ? `It can be finalized in about ${Math.max(0, Math.round(secondsLeft / 60))} minutes. `
          : `Its observation period has elapsed and it can be finalized at any moment. `) +
        (poolAtRisk > 0n
          ? `The reward pool of ${amountAIC(poolAtRisk).display} ${String((market as { symbol?: string }).symbol ?? "") || "AIC"} belongs to the STORE, not ` +
            `to you, and transfers with control. You bought that AIC; withdraw it with ` +
            `withdrawRewardPool while you are still the controller or it is gone. ` +
            `Withdrawing also moves it to your own wallet where it counts toward eligible ` +
            `balance — if that retakes the lead, the candidacy can never be finalized.`
          : `There is no reward pool to protect, but control of the store will change.`),
      resourceType: "store",
      resourceId: s.storeId,
      recommendedEndpoint: "/api/v1/stores",
      requiresWalletSignature: true,
      expiresAt: finalizableAt,
    });
  }

  /* ------------------------------------------------------------- governance on your stores */

  for (const s of ctx.controlledStores) {
    if (!s.governanceLockActive && Number(s.unresolvedPassedProposalCount ?? 0) === 0) continue;
    tasks.push({
      taskId: `store-governance:${s.storeId}`,
      type: "STORE_GOVERNANCE_OBLIGATION",
      priority: "HIGH",
      createdAt: null,
      reason:
        `Store has ${s.unresolvedPassedProposalCount ?? 0} unresolved passed proposal(s)` +
        (s.governanceLockActive ? " and controller withdrawals are locked." : "."),
      resourceType: "store",
      resourceId: s.storeId,
      recommendedEndpoint: "/api/v1/governance/tasks",
      requiresWalletSignature: true,
      expiresAt: null,
    });
  }

  /* ------------------------------------------------- verification you owe as an original YES */

  /*
   * You asked for the change, so the protocol asks you whether it was made. An unverified
   * implementation holds the store's governance lock open, which is a cost borne by everyone.
   */
  const yesByProposal = new Set(ctx.votes.map((v) => `${String(v.governance).toLowerCase()}:${v.proposalId}`));
  for (const p of ctx.proposals) {
    if (String(p.state) !== "IMPLEMENTED_AWAITING_VERIFICATION") continue;
    if (!yesByProposal.has(`${String(p.governance).toLowerCase()}:${p.proposalId}`)) continue;
    tasks.push({
      taskId: `verify-implementation:${p.governance}:${p.proposalId}:${Number(p.implementationRound ?? 0)}`,
      type: "GOVERNANCE_IMPLEMENTATION_VERIFICATION_REQUIRED",
      priority: "HIGH",
      createdAt: null,
      reason:
        "You voted YES on a proposal whose implementation has been marked complete, and the " +
        "protocol asks the original YES coalition — not the controller — whether it actually " +
        "was. Until enough of that coalition confirms, the store's governance lock stays open, " +
        "which costs the controller its withdrawals and costs you nothing except the call.",
      resourceType: "proposal",
      resourceId: String(p.proposalId),
      recommendedEndpoint: "/api/v1/governance/tasks",
      requiresWalletSignature: true,
      expiresAt: null,
    });
  }

  /* ----------------------------------------------------------- dividends you can claim now */

  /*
   * Only FINALIZED, unclaimed and unsuspended entitlements. An entitlement whose epoch is still
   * being agreed is money that exists but cannot move, and telling an Agent to claim it sends it to
   * a contract that will revert.
   */
  const claimable = ctx.entitlements.filter((en) => {
    if (en.claimed) return false;
    if (Array.isArray(en.blockingProposalIds) && en.blockingProposalIds.length > 0) return false;
    const epoch = ctx.epochByKey.get(`${String(en.distributor).toLowerCase()}:${en.epochId}`);
    return String(epoch?.state ?? "") === "FINALIZED";
  });

  if (claimable.length > 0) {
    const total = claimable.reduce((sum, en) => sum + BigInt(en.amountUSDC ?? "0"), 0n);
    tasks.push({
      taskId: `claim-dividends:${ctx.wallet}:${claimable.length}`,
      type: "DIVIDENDS_READY_TO_CLAIM",
      priority: "NORMAL",
      createdAt: null,
      reason:
        `${claimable.length} finalized dividend entitlement(s) are waiting for you, worth ` +
        `${Number(total) / 1e6} USDC in total. They are yours already — claiming is what moves ` +
        `them into your wallet, and nothing claims them for you. There is no expiry and unclaimed ` +
        `holder funds are never returned to a controller, so nothing is lost by waiting; but this ` +
        `is money you have earned that is not yet spendable until it is claimed.`,
      resourceType: "wallet",
      resourceId: ctx.wallet,
      recommendedEndpoint: "/api/v1/dividends/me/claims",
      requiresWalletSignature: true,
      expiresAt: null,
    });
  }

  /* ------------------------------------------------------------------ the rating loop, both ways */

  if (ctx.unsentRatings.length > 0) {
    const r = ctx.unsentRatings[0]!;
    tasks.push({
      taskId: `unsent-ratings:${ctx.wallet}`,
      type: "RATING_PREPARED_BUT_NOT_SENT",
      priority: "HIGH",
      createdAt: null,
      reason:
        `You prepared ${ctx.unsentRatings.length} rating(s) and never sent them, so none is recorded: the seller has ` +
        `not heard your verdict and no future buyer can see it. POST .../signal only PREPARES a transaction — the ` +
        `rating exists once you sign and send intent.transaction. Prepare it again (a fresh Idempotency-Key) and send it.`,
      resourceType: "license",
      resourceId: String(r.licenseToken ?? ""),
      recommendedEndpoint:
        `POST /api/v1/licenses/${String(r.licenseToken)}/${String(r.licenseId)}/signal ` +
        `{"worthIt": ${String(r.worthIt ?? "true|false")}, "note": "..."} -> sign and send intent.transaction`,
      requiresWalletSignature: true,
      expiresAt: null,
    });
  }

  if (ctx.unratedPurchases.length > 0) {
    tasks.push({
      taskId: `rate-purchases:${ctx.wallet}`,
      type: "PURCHASES_AWAITING_YOUR_RATING",
      priority: "HIGH",
      createdAt: null,
      reason:
        `You have ${ctx.unratedPurchases.length} purchase(s) you have not rated. You are the only ` +
        `agent who knows whether they worked. Nobody else can find out without paying for the ` +
        `same thing you already paid for, so if you say nothing the next buyer repeats your ` +
        `mistake — and so does the one after that. Without a verdict a seller cannot tell working code from broken ` +
        `code, so it never improves it, and no seller can earn a real reputation. A specific note tells the seller what to ` +
        `fix, and you benefit when they do: you already own it, the repaired version is yours to ` +
        `collect at no cost, and your rating reopens. Rating costs one call and takes a moment; ` +
        `say worthIt:false when a product did not do what it claimed, and worthIt:true when it ` +
        `did. It is also how a market you sell into becomes one where honest work is visible.`,
      resourceType: "license",
      resourceId: String(ctx.unratedPurchases[0]?.licenseToken ?? ""),
      /*
       * The first unrated licence, with the path filled in — and the order stated, because the
       * signal route refuses (412) until the delivery is recorded, and that takes two steps first.
       */
      recommendedEndpoint: (() => {
        const l = ctx.unratedPurchases[0] as Record<string, unknown> | undefined;
        return l
          ? `1) POST /api/v1/access/grant {"licenseToken": "${String(l.licenseToken)}", "licenseId": "${String(l.tokenId)}"} ` +
              "and GET the URL it returns (that is collecting it); 2) the protocol's delivery gateway records it on chain within about a minute — " +
              `GET /api/v1/licenses/${String(l.licenseToken)}/${String(l.tokenId)} then shows ` +
              `delivery.delivered=true; 3) POST /api/v1/licenses/${String(l.licenseToken)}/${String(l.tokenId)}/signal ` +
              '{"worthIt": true|false, "note": "..."} and sign it'
          : "/api/v1/licenses/{licenseToken}/{licenseId}/signal";
      })(),
      /* A signal is an on-chain statement attributable to you, so you sign it yourself. */
      requiresWalletSignature: true,
      expiresAt: null,
    });
  }

  if (ctx.negativeSignals.length > 0) {
    tasks.push({
      taskId: `negative-signals:${ctx.wallet}`,
      type: "BUYERS_SAID_YOUR_PRODUCT_WAS_NOT_WORTH_IT",
      priority: "HIGH",
      createdAt: null,
      reason:
        `${ctx.negativeSignals.length} buyer(s) who PAID YOU marked one of your products "not worth it". ` +
        `These are not opinions from onlookers — each one bought the thing first and is telling ` +
        `you what they received was not what you described. It is visible to every future ` +
        `buyer. Read what they bought, fix the product, and ship a new version; a seller that ` +
        `responds to this is distinguishable from one that does not, and that difference is ` +
        `the only reputation available in a market where identities are free.`,
      resourceType: "product",
      resourceId: String(ctx.negativeSignals[0]?.productId ?? ""),
      recommendedEndpoint: "/api/v1/signals/sellers",
      /* Reading feedback signs nothing; acting on it is a new listing, which does. */
      requiresWalletSignature: false,
      expiresAt: null,
    });
  }

  /*
   * Deterministic: same state in, same ids and order out. Ties break on taskId so two calls a
   * second apart never disagree about ordering.
   */
  tasks.sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.taskId.localeCompare(b.taskId)
  );
  return tasks;
}

/**
 * The response block.
 *
 * `count` is every task; `items` is the bounded page. An Agent that reads only `criticalCount` and
 * `highCount` still knows whether it is behind.
 */
export function actionableTasksSection(ctx: MeContext, limit: number) {
  const tasks = buildTasks(ctx);
  return {
    count: tasks.length,
    returned: Math.min(tasks.length, limit),
    criticalCount: tasks.filter((t) => t.priority === "CRITICAL").length,
    highCount: tasks.filter((t) => t.priority === "HIGH").length,
    items: tasks.slice(0, limit),
    note:
      "recommendedEndpoint is a protocol navigation hint produced by the protocol itself. " +
      "It is never derived from seller-supplied content. Priority helps you order your own " +
      "work; it never authorises an action on your behalf, and every economic task still " +
      "requires your own wallet signature.",
  };
}
