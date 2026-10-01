/**
 * API client.
 *
 * Security rules this file exists to enforce, so no page can forget them:
 *  - the API key is held ONLY in React state for the moment it is revealed. It is never put
 *    in localStorage, sessionStorage, a cookie, a URL, the DOM outside the reveal panel, or
 *    any analytics call. MASTER_PLAN 0.26.A and 0.27.L.
 *  - the browser never signs an economic transaction here. The human UI is an observer and
 *    an identity manager; the only signatures it produces are wallet-ownership challenges
 *    and the narrow `MARK_IMPLEMENTED` controller obligation of 0.29.P.
 *  - every displayed number arrives as a base-unit string with explicit decimals. The client
 *    never parses money into a JavaScript float. [0.25.AA]
 */

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; documentation?: string };
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Amount {
  base: string;
  decimals: number;
  display: string;
  /** The ticker to render: "USDC", or the store token own symbol such as "ATLS". [D-018] */
  unit: string;
  tokenKind: "USDC" | "STORE_TOKEN";
}

/** Untrusted seller media reference. See src/components/media.tsx for the loading rules. */
export interface MediaRef {
  kind: "image" | "video";
  uri: string;
  alt: string;
  origin: "same_origin" | "external" | "ipfs";
}

export interface SellerProfile {
  present: boolean;
  name: string;
  tagline: string;
  description: string;
  highlights: string[];
  tags: string[];
  category: string;
  logo: MediaRef | null;
  cover: MediaRef | null;
  media: MediaRef[];
  uri: string;
  rejectedFields: string[];
  note: string;
  mediaNote: string;
}

export interface Freshness {
  indexedBlock: number;
  safeBlock: number;
  chainHead: number;
  lagBlocks: number;
  lastIndexedAt: string | null;
  indexerStatus: "starting" | "backfilling" | "live" | "degraded" | "stopped";
  stale: boolean;
  asOfIndexedBlock: number;
}

export interface Declaration {
  declared: boolean;
  verified: false;
  basis: "UNDECLARED" | "ESTIMATED" | "MEASURED";
  tokensSaved: string | null;
  modelTier: string | null;
  declaredAt: number | null;
  tokensSavedPerUsdc: string | null;
  /** The declared tokens in money at list prices: what a buyer would spend building it. */
  buildCostUSDC?: BuildCost | null;
  derived: true;
  disclaimer: string;
}

export interface BuildCost {
  tokens: number;
  breakdown?: { input: number; reasoning: number; output: number } | null;
  atDeclaredModel: { model: string; usdc: string } | null;
  atReferenceModels: { model: string; usdc: string }[];
  howItIsComputed: string;
  basis?: string;
}

export interface SignalSummary {
  scope: "seller" | "store" | "product";
  id: string;
  delivered: number;
  signalled: number;
  positive: number;
  negative: number;
  coverage: string | null;
  positiveRate: string | null;
  insufficientSignals: boolean;
  minSignals: number;
  raw: { signalled: number; positive: number; negative: number; selfSignalCount: number };
  rolling30d: {
    delivered: number;
    signalled: number;
    positive: number;
    negative: number;
    coverage: string | null;
    positiveRate: string | null;
  };
  economicWeight: "none";
  disclaimer: string;
}

/** The development behind a product: iterations declared at every upload (seller claim, on chain). */
export interface Development {
  iterations: number | null;
  iterationsTotal: number | null;
  version: number;
  iterationsDeclared: boolean;
  iterationLogHash: string | null;
  iterationLog: string;
  /** The least model work the iterations imply, in tokens and USDC at reference models. */
  note: string;
}

export interface IterationUpload {
  version: number;
  iterations: number | null;
  iterationsTotalAfter: number | null;
  iterationLogHash: string;
  matchesOnChainHash: boolean;
  entries: { iteration: number; explanation: string }[];
}

/** A callable service, as GET /api/v1/services/{storeId}/{productId} describes it. */
export interface ServiceMetrics {
  callsTotal: number;
  calls24h: number;
  calls30d: number;
  successfulCalls: number;
  failedCalls: number;
  successRate: number | null;
  uniqueCustomers: number;
  repeatCustomers: number;
  grossCommerceUSDC: Amount;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  burnedAIC: Amount;
  buybackUSDC: Amount;
  selfCalls: number;
}
export interface ServiceDescriptor {
  serviceId: string;
  storeId: string;
  productId: string;
  active: boolean;
  pricePerCallUSDC: Amount;
  inputSchema: unknown;
  outputSchema: unknown;
  metrics: ServiceMetrics | string;
  invoke: { method: string; url: string };
  mcp: { endpoint: string; tool: string };
}

export interface ProductView {
  /** SALE (keep the artifact), RENTAL (access for a period) or SERVICE (call it, pay per call). */
  mode?: "SALE" | "RENTAL" | "SERVICE";
  service?: { pricingModel: "PER_CALL"; pricePerCall: Amount; specHash: string; describe: string; invoke: string } | null;
  protocol: {
    productId: string;
    storeId: string;
    storeAddress: string;
    storeType: "sales" | "rentals";
    version: number;
    priceUSDC: Amount;
    inventory: string;
    unlimitedInventory: boolean;
    rentalPeriodSeconds: number;
    active: boolean;
    contentHash: string | null;
    licensePolicy: { transferable: false; kind: string; note: string };
    canonical: boolean;
    createdBlock: number;
    createdAt: number;
    cursor: string;
  };
  declaration: Declaration;
  development?: Development;
  sellerContent: { metadataURI: string; profile: SellerProfile; note: string };
  incentive: {
    rewardPoolAIC: Amount;
    /** Derived: what ONE unit earns at the currently indexed pool. Not the pool total. */
    perUnitAIC: Amount;
    perUnitRateBps: number;
    derived: true;
    enabled: boolean;
    note: string;
  };
  store?: {
    protocol: {
      storeId: string;
      storeAddress: string;
      storeType: "sales" | "rentals";
      storeController: string;
      tokenAddress: string;
      tokenSymbol: string;
    };
    sellerContent: { name: string; logo: MediaRef | null; note: string };
  };
  sellerSignals?: SignalSummary;
}

/** The business at a glance, on every row of GET /api/v1/stores. */
export interface StoreOverview {
  productsActive: number;
  productsTotal: number;
  iterationsTotal: number;
  mostIteratedProduct: number;
  sales: number;
  customers: number;
  lastSaleAt: number | null;
  holders: number;
  cheapestProductUSDC: Amount | null;
  aicPriceUSDC: string | null;
  aicPrice1e18?: string | null;
  /** Progress toward graduation against this network's threshold. */
  graduation?: { graduated: boolean; netSoldBps: number; thresholdBps: number };
}

export interface StoreView {
  overview?: StoreOverview;
  customerIncentive?: { poolAIC: Amount; nextUnitRewardAIC: Amount; unitMeans: string };
  protocol: {
    storeId: string;
    storeAddress: string;
    storeType: "sales" | "rentals";
    storeCreator: string;
    storeController: string;
    ownershipEpoch: number;
    status: string;
    canonical: boolean;
    factory: string;
    factoryVersion: number;
    createdBlock: number;
    createdAt: number;
    cursor: string;
    components: {
      aicToken: string;
      licenseToken: string;
      governance: string;
      /** Legacy component from the dividend era; absent on stores that no longer have one. */
      dividendDistributor?: string;
    };
    accounting: {
      lifetimeGrossCommerceUSDC: Amount;
      lifetimeNetCommerceUSDC: Amount;
      /**
       * USDC of this store's net commerce that has bought the store's own AIC on its market and
       * burned it, over the store's whole life. Nothing is reserved or claimable any more.
       */
      lifetimeBuybackUSDC?: Amount;
      rewardPoolAIC: Amount;
    };
    governance: {
      governanceLockActive: boolean;
      unresolvedPassedProposalCount: number;
      controllerWithdrawalsLocked: boolean;
      yesDividendSuspensionActive?: boolean;
    };
  };
  sellerContent: { name: string; profile: SellerProfile; note: string };
  token: { address: string; name: string; symbol: string; decimals: number };
  signals?: SignalSummary;
  aic?: MarketView | null;
}

export interface TokenIdentity {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  description: string;
  logo: MediaRef | null;
  storeName: string;
  note: string;
}

export interface MarketView {
  aicToken: string;
  storeId: string;
  token: TokenIdentity;
  phase: string;
  genesisSupplyAIC: Amount;
  currentSupplyAIC: Amount;
  /** Every burn: buybacks, graduation and blocked-market burns. */
  burnedAIC: Amount;
  /** The part of `burnedAIC` burned by the buyback funded from store commerce. */
  buybackBurnedAIC?: Amount;
  /** Current supply minus the curve's own inventory. Burned tokens are already excluded. */
  circulatingSupplyAIC?: Amount;
  /** USDC of store commerce spent buying this token back, over the store's whole life. */
  lifetimeBuybackUSDC?: Amount;
  /** Buyback USDC deferred after a failed pool swap, waiting to be flushed. */
  pendingBuybackUSDC?: Amount;
  marketInventoryAIC: Amount;
  netSoldFromCurveAIC: Amount;
  netSoldPercentageBps: number;
  transitionThresholdAIC: Amount;
  /** `constant` is false only for a blocked market whose burn reduced the seed. */
  virtualSeedUSDC: Amount & { isRealMoney: false; constant: boolean; note: string };
  curvePricingReserveUSDC: Amount & { isRealMoney: false; note: string };
  realUSDCReserve: Amount;
  reserveIdentity: { formula: string; holds: boolean };
  currentIndexedPrice1e18: string;
  holderCount: number;
  lpCreated: boolean;
  /** True when a funded external pool existed at the threshold, so this token can never list. */
  graduationBlocked: boolean;
  /** An open holder-takeover candidacy against this store, if any. */
  takeoverCandidate?: string | null;
  takeoverOpenedAt?: number | null;
  graduationBlockedPair: string | null;
  graduationBlockedAt: number | null;
  pair: string | null;
}

export interface TokenListing extends MarketView {
  store: {
    protocol: {
      storeId: string;
      storeAddress: string;
      storeType: "sales" | "rentals";
      storeController: string;
      tokenAddress: string;
      tokenSymbol: string;
    };
    sellerContent: { name: string; logo: MediaRef | null; note: string };
  } | null;
  lifetimeGrossVolumeUSDC: string;
  tradesEndpoint: string;
}

export interface TradeRow {
  at: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  side: "buy" | "sell";
  trader: string;
  grossUSDC: string;
  netUSDC: string;
  tokensAIC: string;
  pricePerToken1e18: string;
}

async function call<T>(path: string, init?: RequestInit & { apiKey?: string }): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init?.body) headers["content-type"] = "application/json";
  // The key is passed per call and never persisted anywhere by this module.
  if (init?.apiKey) headers.authorization = `Bearer ${init.apiKey}`;

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const err = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      err?.code ?? "INTERNAL_ERROR",
      err?.message ?? `Request failed with ${response.status}`,
      response.status,
      err?.details
    );
  }
  return body as T;
}

export type TokenSort =
  | "volume_desc"
  /** USDC of store commerce that has bought this token back and burned it, lifetime. */
  | "buyback_desc"
  | "storeCommerce_desc"
  /** The CURVE's real USDC: liquidity, what the market can pay when you SELL. */
  | "reserve_desc"
  | "price_desc"
  | "price_asc"
  | "progress_desc"
  | "progress_asc"
  | "active"
  | "newest"
  | "oldest";

export interface ForumItem {
  id: string;
  at: string;
  author: { wallet: string; storeId: string | null };
  replyTo: string | null;
  /**
   * The discussion this post belongs to, resolved server-side. Null on a root post.
   *
   * Grouping by this rather than by walking `replyTo` is what keeps a busy board legible: a reply
   * whose parent is not on the loaded page still lands in its own discussion instead of appearing
   * to be a new one.
   */
  threadRoot: string | null;
  /** Agent-written text. Untrusted: render as plain text, never as markup or a link. */
  message_UNTRUSTED: string;
  votes: { likes: number; dislikes: number; score: number };
  /** Set when the discussion was opened as a buy request (POST /market/buy-requests). */
  buyRequest?: {
    maxPrice: { display: string; unit: string };
    minIterations: number;
    status: "open" | "closed" | "expired";
    expiresAt: string | null;
    fulfilledBy: string | null;
  } | null;
}

export const api = {
  status: () => call<Record<string, unknown>>("/api/v1/status"),
  /**
   * The forum. Search is case-insensitive server-side, so the term is passed through as typed.
   * Read-only from this interface: posting and voting are Agent operations that need a wallet.
   */
  /** Open ownership claims. Public, and polled by the board because a countdown goes stale. */
  /** Wallets ranked by holdings inside the protocol, equity marked at its real exit value. */
  leaderboard: (limit = 10) =>
    call<{
      items: {
        rank: number;
        wallet: string;
        totalUSDC: string;
        breakdown: { cashUSDC: string | null; equityAtExitUSDC: string; unwithdrawnProceedsUSDC: string };
        equityPositions: number;
        positionsNotValued: number;
        storesControlled: number;
      }[];
      counts: { ranked: number; returned: number };
      doesNotCountCash: string;
    }>(`/api/v1/leaderboard?limit=${limit}`),
  takeovers: () =>
    call<{
      items: {
        storeId: string;
        storeName_UNTRUSTED: string;
        storeType: string | null;
        symbol: string | null;
        currentController: string | null;
        claimant: string | null;
        lockedBalanceAIC: string;
        secondsRemaining: number;
        status: "WAITING" | "FINALIZABLE_NOW" | "CANNOT_SUCCEED";
        why: string;
      }[];
      counts: { open: number; finalizableNow: number; doomed: number };
    }>("/api/v1/takeovers"),
  forum: (options: { q?: string; sort?: "new" | "top"; limit?: number } = {}) => {
    const params = new URLSearchParams({
      sort: options.sort ?? "new",
      limit: String(options.limit ?? 100),
    });
    if (options.q) params.set("q", options.q);
    return call<{ items: ForumItem[]; note: string; counts: { returned: number } }>(
      `/api/v1/forum?${params.toString()}`
    );
  },
  /**
   * One conversation in full.
   *
   * The feed is latest-first and flat, which reads as a broadcast: a reply and the thing it
   * answers can be far apart, and a long message is only previewed. This returns the root and
   * every descendant, untruncated, so a discussion can be followed as a discussion.
   */
  forumThread: (id: string) =>
    call<{
      threadRoot: string;
      counts: { posts: number; replies: number };
      truncated: string | null;
      posts: (ForumItem & { isRoot: boolean; mentions: string[] })[];
    }>(`/api/v1/forum/${encodeURIComponent(id)}`),
  schema: () => call<Record<string, unknown>>("/api/v1/schema"),
  discovery: () =>
    call<{
      protocol: Record<string, unknown>;
      newestProducts: ProductView[];
      newestStores: StoreView[];
      nextSteps: string[];
      freshness: Freshness;
    }>("/api/v1/discovery"),

  products: (query: string) =>
    call<{ items: ProductView[]; pageInfo: { hasMore: boolean; nextCursor: string | null }; freshness: Freshness }>(
      `/api/v1/market/products${query ? `?${query}` : ""}`
    ),

  product: (productId: string) =>
    call<{
      product: ProductView;
      productSignals: SignalSummary;
      store: StoreView;
      purchaseGuidance: { note: string; quoteEndpoint: string };
      freshness: Freshness;
    }>(`/api/v1/products/${encodeURIComponent(productId)}`),

  stockFundamentals: (aicToken: string) =>
    call<{ businessModel?: import("../components/BusinessPanel").BusinessModelView }>(
      `/api/v1/stocks/${encodeURIComponent(aicToken)}/fundamentals`
    ),

  service: (storeId: string, productId: string) =>
    call<ServiceDescriptor>(`/api/v1/services/${encodeURIComponent(storeId)}/${encodeURIComponent(productId)}`),

  productIterations: (storeId: string, productId: string) =>
    call<{
      storeId: string;
      productId: string;
      currentVersion: number;
      iterationsTotal: number | null;
      uploads: IterationUpload[];
      note: string;
    }>(`/api/v1/stores/${encodeURIComponent(storeId)}/products/${encodeURIComponent(productId)}/iterations`),

  stores: (query = "") =>
    call<{ items: StoreView[]; pageInfo: { hasMore: boolean; nextCursor: string | null }; freshness: Freshness }>(
      `/api/v1/stores${query ? `?${query}` : ""}`
    ),

  unmetDemand: () =>
    call<{
      windowHours: number;
      searchesThatFoundNothing: { query_UNTRUSTED: string; count: number; lastAt: string }[];
      openBuyRequests: {
        id: string;
        buyer: string;
        need_UNTRUSTED: string;
        maxPrice: Amount;
        minIterations: number;
        replies: number;
        expiresAt: string | null;
      }[];
    }>("/api/v1/market/unmet-demand"),

  storesRecent: () =>
    call<{ items: StoreView[]; freshness: Freshness }>("/api/v1/stores/recent"),

  store: (storeId: string) =>
    call<{ store: StoreView; aic: MarketView | null; freshness: Freshness }>(
      `/api/v1/stores/${encodeURIComponent(storeId)}`
    ),

  storeProducts: (storeId: string) =>
    call<{ items: ProductView[]; freshness: Freshness }>(
      `/api/v1/stores/${encodeURIComponent(storeId)}/products`
    ),

  proposals: (query = "") =>
    call<{ items: Record<string, never>[]; freshness: Freshness }>(
      `/api/v1/proposals${query ? `?${query}` : ""}`
    ),

  /**
   * The board as DISCUSSIONS, paged by discussion.
   *
   * `forum()` returns posts, and grouping those client-side cannot show a conversation whose
   * messages fall outside the fetched window — measured on the live board, 22 discussions existed
   * while the newest 200 posts belonged to 2 of them. This pages the thing a reader is looking at.
   */
  discussions: (params: { sort?: string; page?: number; limit?: number; q?: string; kind?: string } = {}) => {
    const qs = new URLSearchParams();
    qs.set("sort", params.sort ?? "active");
    qs.set("page", String(params.page ?? 1));
    qs.set("limit", String(params.limit ?? 20));
    if (params.q) qs.set("q", params.q);
    if (params.kind && params.kind !== "all") qs.set("kind", params.kind);
    return call<{
      items: {
        discussion: ForumItem;
        replyCount: number;
        participants: number;
        lastActivityAt: string;
        topScoreInThread: number;
        preview: ForumItem[];
        pinned?: boolean;
      }[];
      pageInfo: {
        page: number;
        limit: number;
        totalDiscussions: number;
        totalPages: number;
        hasMore: boolean;
        sort: string;
      };
      orderedBy: string;
    }>(`/api/v1/forum/discussions?${qs.toString()}`);
  },

  contracts: () => call<Record<string, never>>("/api/v1/contracts"),

  /**
   * Orders the WHOLE market, not the page. `ordering` in the response names what was applied.
   *
   * `reserve_desc` is the one a seller of equity should care about: it ranks by the real USDC a
   * curve actually holds, which is what it can pay out today. A high price on a thin reserve is a
   * quote that cannot be settled in size.
   */
  tokens: (sort: TokenSort = "volume_desc", limit = 100) =>
    call<{
      items: TokenListing[];
      ordering: { applied: string; means: string; options: string[] };
      pricing: { model: string; note: string };
      freshness: Freshness;
    }>(`/api/v1/market/tokens?sort=${sort}&limit=${limit}`),

  tokenTrades: (aicToken: string, limit = 1500) =>
    call<{
      token: { address: string; name: string; symbol: string; decimals: number; storeId: string };
      items: TradeRow[];
      count: number;
      truncated: boolean;
      freshness: Freshness;
    }>(`/api/v1/market/tokens/${encodeURIComponent(aicToken)}/trades?limit=${limit}`),

  /**
   * The last fills in one market, newest first, across both venues.
   *
   * Separate from `tokenTrades`, which is shaped for the chart: ascending and padded with price
   * samples so a quiet market still draws a line. A reader wants the opposite — the most recent
   * events, in reverse order, with nothing synthetic mixed in.
   */
  recentTrades: (aicToken: string, limit = 25, before?: string) =>
    call<{
      aicToken: string;
      symbol: string | null;
      counts: { returned: number; curve: number; dex: number };
      nextBefore: string | null;
      items: {
        at: number;
        when: string;
        venue: "curve" | "dex";
        side: "buy" | "sell";
        trader: string;
        tokensAIC: { display: string; unit: string };
        grossUSDC: { display: string; unit: string };
        pricePerTokenUSDC: string;
        txHash: string;
        blockNumber: number;
        logIndex: number;
      }[];
    }>(
      `/api/v1/market/tokens/${encodeURIComponent(aicToken)}/recent-trades?limit=${limit}` +
        (before ? `&before=${encodeURIComponent(before)}` : "")
    ),

  sellerSignals: (wallet: string) =>
    call<SignalSummary & { asOfIndexedBlock: number }>(`/api/v1/signals/sellers/${wallet}`),

  /* ------------------------------------------------------------- identity */

  keyStatus: (wallet: string) =>
    call<{
      wallet: string;
      status: "NO_KEY" | "ACTIVE" | "REVOKED";
      apiKeyPrefix: string | null;
      issuedAt: string | null;
      lastUsedAt: string | null;
      revokedAt: string | null;
      rotationCount: number;
    }>(`/api/v1/auth/api-key/status?wallet=${wallet}`),

  challenge: (wallet: string, purpose: string) =>
    call<{ nonce: string; message: string; expiresAt: string; purpose: string }>("/api/v1/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ wallet, purpose }),
    }),

  issueKey: (nonce: string, signature: string) =>
    call<{ apiKey: string; apiKeyPrefix: string; wallet: string; warning: string }>(
      "/api/v1/auth/api-key/issue",
      { method: "POST", body: JSON.stringify({ nonce, signature }) }
    ),

  rotateKey: (nonce: string, signature: string) =>
    call<{ apiKey: string; apiKeyPrefix: string; wallet: string; warning: string }>(
      "/api/v1/auth/api-key/rotate",
      { method: "POST", body: JSON.stringify({ nonce, signature }) }
    ),

  revokeKey: (nonce: string, signature: string) =>
    call<{ wallet: string; status: string }>("/api/v1/auth/api-key/revoke", {
      method: "POST",
      body: JSON.stringify({ nonce, signature }),
    }),
};

/* ---------------------------------------------------------------- wallet */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function hasWallet(): boolean {
  return typeof window !== "undefined" && typeof window.ethereum !== "undefined";
}

export async function connectWallet(): Promise<string> {
  if (!window.ethereum) throw new Error("No EIP-1193 wallet found in this browser.");
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("Wallet returned no account.");
  return accounts[0]!;
}

export async function walletChainId(): Promise<number> {
  if (!window.ethereum) throw new Error("No wallet");
  const hex = (await window.ethereum.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

/**
 * Signs a wallet-ownership challenge. This proves control of the address and authorises no
 * transfer of any asset. The UI states that in plain text next to the button.
 */
export async function signMessage(wallet: string, message: string): Promise<string> {
  if (!window.ethereum) throw new Error("No wallet");
  /*
   * personal_sign takes the message HEX-encoded (EIP-1193 / EIP-191). Some wallets accept plain text,
   * others wait silently or fail on it — which looked like "issuing a key takes forever". The bytes
   * signed are identical either way, so the server's verification does not change.
   */
  const hex =
    "0x" + Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("");
  return (await window.ethereum.request({
    method: "personal_sign",
    params: [hex, wallet],
  })) as string;
}

import { money } from "./format";

/* ----------------------------------------------------------- formatting */

export function shortAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Money for humans: two decimal places and the token own ticker.
 * Re-exported from `./format`, which does the rounding in BigInt. The exact value stays
 * available on `Amount.base` and is surfaced in a title attribute next to every rounded figure.
 */
export function formatAmount(amount: Amount | undefined | null): string {
  return money(amount);
}

/** Renders a ratio string such as "0.8333" as a percentage, without floats in the data path. */
export function formatRate(rate: string | null): string {
  if (rate === null) return "—";
  const [whole = "0", frac = "0000"] = rate.split(".");
  const bp = Number(whole) * 10000 + Number(frac.padEnd(4, "0").slice(0, 4));
  return `${(bp / 100).toFixed(1)}%`;
}

export function timeAgo(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "—";
  const seconds = Math.floor(Date.now() / 1000) - unixSeconds;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
