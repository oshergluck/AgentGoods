/**
 * Everything `GET /api/v1/me` reads, loaded once.
 *
 * WHY THIS FILE EXISTS. The endpoint was a single 1,300-line handler. That is what it grew into
 * honestly — every section needs the same wallet, the same chain id and several of the same
 * collections — but the result could not be reviewed or tested a piece at a time, and a careless
 * edit to one part could silently delete another. One did.
 *
 * So the response is now assembled by four independent section builders (identity, holdings,
 * obligations, tasks), and this module is the single place that talks to the database. The split is
 * by RESPONSIBILITY, not by response key: a section builder is a pure function of this context, so
 * it can be read, reasoned about and tested without a database at all.
 *
 * WHY THE LOADING IS NOT ALSO SPLIT. It would cost four times the queries. Every section needs the
 * controlled stores; three need the holdings; two need the markets. Loading per section would turn
 * one bounded read into a fan-out that grows with the number of sections, which is exactly the
 * property this endpoint is supposed to guarantee it does not have.
 *
 * TWO RULES THAT HOLD FOR EVERY READ HERE:
 *
 *   - **No RPC, ever.** Rule 14: a GET never reaches the chain. Every figure is projection state.
 *   - **Bounded by construction.** Every collection read has a hard cap from LIMITS and reports a
 *     total count beside it, so an Agent's own success can never make its control surface fail.
 */

import { capitalSourcesFor } from "../../../stores/capitalSources";
import { businessMetricsFor } from "../../../stores/businessMetrics";
import {
  BuyerSignalDoc,
  ForumPost,
  AgentAccount,
  StockMarket,
  DividendEntitlement,
  DividendEpoch,
  AicHolder,
  License,
  Product,
  Proposal,
  Store,
  TransactionIntent,
  Vote,
  ProductVersion,
} from "../../../db/models";
import { getStatus } from "../../../auth/apiKeys";
import { topHolders } from "../largestHolders";
import { chainNow } from "../../../db/chainTime";
import type { ProtocolManifest } from "../../../config/manifest";

/**
 * Hard caps on every embedded collection.
 *
 * Deliberately small. This endpoint is a control surface, not a data export: an Agent that needs
 * the full list follows the deep link, and an Agent that needs a decision reads the counts.
 */
export const LIMITS = {
  stores: 25,
  products: 25,
  licenses: 25,
  positions: 25,
  intents: 20,
  proposals: 25,
  tasks: 50,
} as const;

/**
 * An intent is "pending" for the Agent until the projection has CONFIRMED it. `mined` is not
 * finished: a mined transaction can still be reorganised out, and the Agent is the party that
 * would act on a state that then reverted.
 */
export const PENDING_INTENT_STATUSES = ["created", "awaiting_signature", "submitted", "mined"] as const;

/** ProtocolConstants.TAKEOVER_OBSERVATION_PERIOD. The guaranteed warning window. */
export const TAKEOVER_OBSERVATION_SECONDS = 3600;

/** How long a wallet must wait between starting new forum discussions. Two REAL hours. */
export const NEW_THREAD_COOLDOWN_MS = 2 * 60 * 60 * 1000;

/**
 * Dates cross this boundary in two shapes: some collections store a unix second, others a BSON
 * Date. The API publishes exactly one, because an Agent comparing a millisecond timestamp against
 * a second one silently gets the wrong answer about whether something has expired.
 */
export function toUnixSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export interface LoadMeContextOptions {
  /** Lowercased. The ONLY source of identity; derived from the API key, never from a parameter. */
  wallet: string;
  walletChecksummed: string;
  chainId: number;
  manifest: ProtocolManifest;
}

/**
 * Load every projection read the snapshot needs.
 *
 * Issued in waves. The first wave is everything that depends only on the wallet, and those go out
 * together — serialising independent reads against one projection multiplies latency by the number
 * of sections for no consistency benefit. Later waves need ids the first produced, and each is
 * still scoped to stores or tokens this wallet is already known to be involved with. No path here
 * widens with the size of the protocol.
 */
export async function loadMeContext(o: LoadMeContextOptions) {
  const { wallet, walletChecksummed, chainId, manifest } = o;

  const [
    apiKey,
    account,
    controlledStores,
    controlledStoreCount,
    holdings,
    holdingCount,
    licenses,
    licenseCount,
    entitlements,
    intents,
    intentCount,
    votes,
    nowSec,
  ] = await Promise.all([
    getStatus(walletChecksummed, chainId),
    AgentAccount.findOne({ walletAddress: wallet, chainId }).lean(),
    Store.find({ chainId, storeController: wallet }).sort({ createdBlock: -1 }).limit(LIMITS.stores).lean(),
    Store.countDocuments({ chainId, storeController: wallet }),
    AicHolder.find({ chainId, holder: wallet, balance: { $ne: "0" } })
      .sort({ balanceSort: -1 })
      .limit(LIMITS.positions)
      .lean(),
    AicHolder.countDocuments({ chainId, holder: wallet, balance: { $ne: "0" } }),
    License.find({ chainId, owner: wallet }).sort({ issuedAt: -1 }).limit(LIMITS.licenses).lean(),
    License.countDocuments({ chainId, owner: wallet }),
    DividendEntitlement.find({ chainId, account: wallet }).limit(200).lean(),
    TransactionIntent.find({ chainId, agentWallet: wallet, status: { $in: PENDING_INTENT_STATUSES } })
      .sort({ expiresAt: -1 })
      .limit(LIMITS.intents)
      .lean(),
    TransactionIntent.countDocuments({
      chainId,
      agentWallet: wallet,
      status: { $in: PENDING_INTENT_STATUSES },
    }),
    Vote.find({ chainId, voter: wallet, support: true }).limit(200).lean(),
    /*
     * Chain time, not wall time, for every deadline comparison in the response.
     *
     * A licence expiry and a takeover observation period are both chain-clock facts. Comparing them
     * against the server's clock would report a licence as expired, or a candidacy as finalizable,
     * at a moment the chain does not agree with.
     */
    chainNow(chainId),
  ]);

  const controlledStoreIds = controlledStores.map((s) => s.storeId);

  const holdingStoreIds = holdings.map((h) => h.storeId);

  /* ------------------------------------------------------------------ second wave */

  const [products, productCount, markets, proposals, epochs] = await Promise.all([
    controlledStoreIds.length
      ? Product.find({ chainId, storeId: { $in: controlledStoreIds } })
          .sort({ createdBlock: -1 })
          .limit(LIMITS.products)
          .lean()
      : Promise.resolve([]),
    controlledStoreIds.length
      ? Product.countDocuments({ chainId, storeId: { $in: controlledStoreIds } })
      : Promise.resolve(0),
    /*
     * The markets of the stores this wallet CONTROLS. This is the takeover-facing read: a candidacy
     * is recorded on the market, and the controller is the party that needs to know about it.
     */
    controlledStoreIds.length
      ? StockMarket.find({ chainId, storeId: { $in: controlledStoreIds } }).lean()
      : Promise.resolve([]),
    /*
     * Proposals this wallet may owe something on: those against stores it controls, and those on
     * stores it holds a position in, where it may have voted yes and now owes verification.
     */
    controlledStoreIds.length || holdingStoreIds.length
      ? Proposal.find({
          chainId,
          storeId: { $in: [...new Set([...controlledStoreIds, ...holdingStoreIds])] },
          state: { $in: ["ACTIVE", "PASSED_AWAITING_IMPLEMENTATION", "IMPLEMENTED_AWAITING_VERIFICATION"] },
        })
          .limit(LIMITS.proposals)
          .lean()
      : Promise.resolve([]),
    /*
     * The epochs behind this wallet's entitlements, for the state each one is in. An entitlement
     * whose epoch is not FINALIZED is not claimable yet, and saying otherwise would send an Agent
     * to a contract that will refuse it.
     */
    entitlements.length
      ? DividendEpoch.find({
          chainId,
          epochId: { $in: [...new Set(entitlements.map((e) => e.epochId))] },
        }).lean()
      : Promise.resolve([]),
  ]);

  const marketByStore = new Map(markets.map((m) => [m.storeId, m]));
  const epochByKey = new Map(
    epochs.map((e) => [`${String(e.distributor).toLowerCase()}:${e.epochId}`, e])
  );

  /* ----------------------------------------------- markets and leaders for ownership pricing */

  /*
   * Curve state for every token this wallet has any interest in: the tokens it holds, plus the
   * tokens of the stores it controls.
   *
   * Controlled-store tokens are included deliberately and are NOT a duplicate of the holdings. A
   * controller that holds none of its own token is the most common case in this protocol — creating
   * a store allocates the founder nothing — so without this read, the one participant who most
   * needs to be told what a stake would cost is the only one who cannot see it.
   */
  const heldTokens = holdings.map((h) => String(h.aicToken).toLowerCase());
  const controlledTokens = controlledStores
    .map((s) => String(s.aicToken ?? "").toLowerCase())
    .filter((t) => t.length > 0);
  const ownershipTokens = [...new Set([...heldTokens, ...controlledTokens])].filter((t) => t.length > 0);

  const [ownershipMarkets, leaderRows, positionStores] = await Promise.all([
    ownershipTokens.length
      ? StockMarket.find({ chainId, aicToken: { $in: ownershipTokens } }).lean()
      : Promise.resolve([]),
    /*
     * The largest ELIGIBLE holder of each token, in one aggregate rather than a query per token.
     *
     * `balanceSort` is the fixed-width sortable form of the balance, so the database can order on
     * it directly; ordering on `balance` would compare base-unit strings lexically and decide that
     * 9 is larger than 10.
     *
     * Only eligible holders count. A contract can hold tokens but can neither vote, claim a
     * dividend, nor take a store over, so a contract at the top of the raw list is not the leader.
     */
    ownershipTokens.length
      ? (AicHolder.aggregate([
          { $match: { chainId, aicToken: { $in: ownershipTokens }, eligible: true } },
          { $sort: { balanceSort: -1 } },
          { $group: { _id: "$aicToken", balance: { $first: "$balance" }, holder: { $first: "$holder" } } },
        ]) as Promise<{ _id: string; balance: string; holder: string }[]>)
      : Promise.resolve([] as { _id: string; balance: string; holder: string }[]),
    /*
     * The stores behind held positions, which are mostly other agents' stores. Only the pending
     * holder reserve is needed — it is the epoch estimate the rounding-floor target divides by — so
     * the projection is kept to that and the id.
     */
    holdingStoreIds.length
      ? Store.find({ chainId, storeId: { $in: holdingStoreIds } })
          .select({ storeId: 1, unfinalizedHolderReserveUSDC: 1, storeController: 1, "sellerContent.name": 1, ownerAvailableUSDC: 1, lifetimeGrossCommerceUSDC: 1, rewardPoolAIC: 1 })
          .lean()
      : Promise.resolve([]),
  ]);

  const marketByToken = new Map(
    ownershipMarkets.map((m) => [String(m.aicToken).toLowerCase(), m as Record<string, unknown>])
  );
  /* The two largest eligible holders of every held token: what passing the leader would take. */
  const topTwoByToken = await topHolders(chainId, heldTokens.map((t) => t.toLowerCase()), 2);
  const leaderByToken = new Map(leaderRows.map((r) => [String(r._id).toLowerCase(), r]));
  const storeByIdForPositions = new Map(
    positionStores.map((st) => [String(st.storeId), st as Record<string, unknown>])
  );

  /** Your balance of a token, or zero. A controller usually holds none of its own. */
  const balanceByToken = new Map(
    holdings.map((h) => [String(h.aicToken).toLowerCase(), BigInt(h.balance ?? "0")])
  );

  /*
   * Your holdings of YOUR OWN tokens, asked directly rather than read off the paged positions list.
   *
   * `holdings` is capped at LIMITS.positions, so a small holding in one's own store can fall off
   * the page — and telling a seller it owns none of a store it does own would be a worse error than
   * saying nothing. This asks about exactly the tokens in question.
   */
  const ownHoldings = controlledTokens.length
    ? await AicHolder.find(
        { chainId, holder: wallet, aicToken: { $in: controlledTokens } },
        { aicToken: 1, balance: 1 }
      ).lean()
    : [];
  const ownBalanceByToken = new Map(
    ownHoldings.map((h) => [String(h.aicToken).toLowerCase(), BigInt(h.balance ?? "0")])
  );

  /*
   * The stores whose takeover race this wallet leads, from the chain's own leader (the indexed
   * LeaderChanged heap root) rather than from the paged positions list, so "you lead none" is exact.
   * Each carries the runner-up, which is the margin that matters.
   */
  const leadingMarkets = (await StockMarket.find({ chainId, currentLeader: wallet })
    .select({ storeId: 1, aicToken: 1, symbol: 1, currentLeaderSince: 1, takeoverCandidate: 1 })
    .lean()) as Record<string, unknown>[];
  const leadingTokens = leadingMarkets.map((m) => String(m.aicToken).toLowerCase());
  const leadRanks = leadingTokens.length
    ? ((await AicHolder.aggregate([
        { $match: { chainId, aicToken: { $in: leadingTokens }, eligible: true, balance: { $ne: "0" } } },
        { $sort: { aicToken: 1, balanceSort: -1 } },
        { $group: { _id: "$aicToken", top: { $push: { holder: "$holder", balance: "$balance" } } } },
        { $project: { top: { $slice: ["$top", 2] } } },
      ])) as { _id: string; top: { holder: string; balance: string }[] }[])
    : [];
  const leadRankByToken = new Map(leadRanks.map((r) => [String(r._id).toLowerCase(), r.top]));

  const businessByStore = await businessMetricsFor(
    chainId,
    controlledStores.map((s) => ({
      storeId: String(s.storeId),
      aicToken: String(s.aicToken ?? ""),
      storeController: String(s.storeController ?? ""),
    }))
  );
  const capitalByToken = await capitalSourcesFor(
    chainId,
    controlledStores.map((s) => String(s.aicToken ?? "")).filter((t) => t.length > 0)
  );

  /* ------------------------------------------------------- what you bought, and what was fixed */

  /*
   * Which of the things this wallet bought have been FIXED since.
   *
   * A buyer signals that something did not work, the seller repairs it, and — without this — nobody
   * tells the one person who most wants to know. They already paid, they already have the licence,
   * and collecting the new version costs them nothing. Computed from the version recorded ON THE
   * LICENCE against the product's current version, so it reflects what was actually purchased
   * rather than what is on the shelf now.
   */
  const ownedProductIds = [...new Set(licenses.map((l) => l.productId))];
  const currentProducts = ownedProductIds.length
    ? await Product.find({ chainId, productId: { $in: ownedProductIds } })
        .select({ productId: 1, version: 1, storeId: 1 })
        .lean()
    : [];
  const currentVersionById = new Map(currentProducts.map((pr) => [pr.productId, Number(pr.version ?? 0)]));

  const staleLicences = licenses.filter(
    (l) => (currentVersionById.get(l.productId) ?? 0) > Number(l.productVersion ?? 0)
  );

  const changelogs = staleLicences.length
    ? await ProductVersion.find({
        chainId,
        productId: { $in: staleLicences.map((l) => l.productId) },
      })
        .select({ productId: 1, version: 1, changelog: 1 })
        .lean()
    : [];
  const changelogByProductVersion = new Map(
    changelogs.map((c) => [`${c.productId}:${c.version}`, c.changelog ?? ""])
  );

  /* ------------------------------------------------------------------- the rating loop */

  /*
   * A rating mechanism nobody is prompted to use records nothing. Measured on a populated market:
   * 149 purchases produced ZERO buyer signals. The endpoint existed and every agent could reach it,
   * so the gap was not capability — nobody was ever ASKED, and no seller was ever TOLD.
   *
   * Both are fixed without touching the economics. D-011 keeps buyer signals at zero weight in
   * ranking, fees, rewards and dividends, permanently, because a signal that moves money is a
   * subsidy for wash purchases. Prompting a buyer costs nothing and pays nobody.
   */
  const [myLicenses, signalsOnMe, mySignals, lastThread] = await Promise.all([
    License.find({ chainId, owner: wallet }, { licenseToken: 1, tokenId: 1, productId: 1, issuedAt: 1 })
      .sort({ issuedAt: -1 })
      .limit(100)
      .lean()
      .catch(() => [] as Record<string, unknown>[]),
    /*
     * `sellerWallet`, not `seller`, and self-signals excluded.
     *
     * An earlier draft queried `seller`/`buyer`/`at`, none of which this collection has — so it
     * silently matched nothing and the whole notification would have shipped as dead code that
     * looked implemented. `selfSignal` is excluded because a seller rating its own product is not
     * feedback.
     */
    BuyerSignalDoc.find(
      { chainId, sellerWallet: wallet, selfSignal: false },
      { productId: 1, worthIt: 1, signalledAt: 1, note: 1, productVersion: 1 }
    )
      .sort({ signalledAt: -1 })
      .limit(50)
      .lean()
      .catch(() => [] as Record<string, unknown>[]),
    BuyerSignalDoc.find({ chainId, signaller: wallet }, { licenseToken: 1, licenseId: 1 })
      .lean()
      .catch(() => [] as Record<string, unknown>[]),
    /*
     * Your own forum standing, so the limits can be planned around rather than discovered. A
     * discussion is a post with no `replyTo`; replies are not rate limited the same way.
     */
    ForumPost.findOne({ chainId, wallet, replyTo: null }, { createdAt: 1 })
      .sort({ createdAt: -1 })
      .lean()
      .catch(() => null),
  ]);

  const signalledKeys = new Set(
    (mySignals as Record<string, unknown>[]).map(
      (x) => `${String(x.licenseToken).toLowerCase()}:${String(x.licenseId)}`
    )
  );
  const unratedPurchases = (myLicenses as Record<string, unknown>[]).filter(
    (l) => !signalledKeys.has(`${String(l.licenseToken).toLowerCase()}:${String(l.tokenId)}`)
  );
  const negativeSignals = (signalsOnMe as Record<string, unknown>[]).filter((x) => x.worthIt === false);

  /*
   * A rating prepared and never sent. POST .../signal returns a transaction to sign; agents read the
   * 201 as "rated" and moved on, so the rating never reached the chain and the seller never heard it.
   */
  const preparedRatings = (await TransactionIntent.find({ chainId, agentWallet: wallet.toLowerCase(), action: "submit_buyer_signal" })
    .sort({ createdAt: -1 })
    .limit(20)
    .select({ summary: 1, intentId: 1 })
    .lean()
    .catch(() => [])) as Record<string, unknown>[];
  const seenPrepared = new Set<string>();
  const unsentRatings = preparedRatings
    .map((i) => ((i.summary as Record<string, unknown> | undefined)?.protocol ?? {}) as Record<string, unknown>)
    .filter((p) => {
      const k = `${String(p.licenseToken ?? "").toLowerCase()}:${String(p.licenseId ?? "")}`;
      if (!p.licenseToken || seenPrepared.has(k) || signalledKeys.has(k)) return false;
      seenPrepared.add(k);
      return true;
    });

  return {
    wallet,
    walletChecksummed,
    chainId,
    manifest,
    nowSec,

    apiKey,
    account,

    controlledStores,
    controlledStoreCount,
    controlledStoreIds,
    holdings,
    holdingCount,
    holdingStoreIds,
    licenses,
    licenseCount,
    products,
    productCount,
    markets,
    marketByStore,
    proposals,
    votes,
    entitlements,
    epochByKey,
    intents,
    intentCount,

    marketByToken,
    leaderByToken,
    topTwoByToken,
    leadingMarkets,
    leadRankByToken,
    capitalByToken,
    businessByStore,
    balanceByToken,
    ownBalanceByToken,
    storeByIdForPositions,

    staleLicences,
    currentVersionById,
    changelogByProductVersion,

    signalsOnMe: signalsOnMe as Record<string, unknown>[],
    negativeSignals,
    unratedPurchases,
    unsentRatings,
    lastThread,
  };
}

/** Everything a section builder is allowed to see. Inferred, so it can never drift from the loader. */
export type MeContext = Awaited<ReturnType<typeof loadMeContext>>;
