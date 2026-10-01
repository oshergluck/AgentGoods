/**
 * AIC Agent SDK.
 *
 * This is the reference implementation of the Agent side of the protocol, and it is written
 * to obey the rules the schema states rather than to be convenient:
 *
 *  - the API key NEVER signs anything. Every economic action goes: request intent -> inspect
 *    -> sign with the EOA -> submit -> wait for the indexer. [MASTER_PLAN 0.27.E]
 *  - the private key never leaves this process and is never sent to the backend. [0.13]
 *  - allowances are set to the EXACT amount an intent asks for, never unlimited. [0.24.R]
 *  - a fresh quote is obtained immediately before every purchase, and its version and maximum
 *    are passed into execution. [0.24.U]
 *  - seller content is treated as inert data; no address is ever taken from it. [0.24.P]
 *  - spending is bounded by an explicit per-transaction and per-run budget. [0.27.L]
 */

import { ethers, Contract, JsonRpcProvider, Wallet } from "ethers";

export interface AgentConfig {
  name: string;
  apiBaseUrl: string;
  rpcUrl: string;
  chainId: number;
  privateKey: string;
  /** Hard spend limits. The Agent refuses to exceed them even if an endpoint offers to. */
  budget: {
    totalUSDC: bigint;
    maxPerTransactionUSDC: bigint;
    minReserveUSDC: bigint;
  };
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface Amount {
  base: string;
  decimals: number;
  display: string;
  unit: "USDC" | "AIC";
}

export interface TransactionIntent {
  intentId: string;
  chainId: number;
  transaction: { to: string; data: string; value: string; chainId: number };
  requiredAllowance: {
    token: string;
    tokenSymbol: "USDC" | "AIC";
    spender: string;
    amount: Amount;
    reason: string;
  } | null;
  summary: {
    action: string;
    description: string;
    protocol: Record<string, unknown>;
    sellerContent?: Record<string, unknown>;
    warnings: string[];
  };
  simulation: {
    status: "skipped" | "ok" | "would_revert" | "blocked_on_allowance";
    revertReason: string | null;
    currentAllowance?: string;
    requiredAllowance?: string;
  };
  expiresAt: string;
  asOfIndexedBlock: number;
}

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class AicAgent {
  readonly wallet: Wallet;
  readonly provider: JsonRpcProvider;
  readonly name: string;
  private apiKey: string | null = null;
  private spent = 0n;
  private readonly config: AgentConfig;
  private idempotencyCounter = 0;
  /** Highest block this Agent has caused. Quotes must be at least this fresh. */
  private lastActionBlock = 0;

  constructor(config: AgentConfig) {
    this.config = config;
    this.name = config.name;
    this.provider = new JsonRpcProvider(
      config.rpcUrl,
      { chainId: config.chainId, name: `chain-${config.chainId}` },
      { staticNetwork: true, cacheTimeout: -1 }
    );
    this.wallet = new Wallet(config.privateKey, this.provider);
  }

  get address(): string {
    return this.wallet.address;
  }

  get spentUSDC(): bigint {
    return this.spent;
  }

  private log(message: string, data?: Record<string, unknown>): void {
    (this.config.log ?? (() => undefined))(`[${this.name}] ${message}`, data);
  }

  /* ------------------------------------------------------------- transport */

  private async http<T>(
    method: string,
    path: string,
    options: { body?: unknown; idempotencyKey?: string; auth?: boolean } = {}
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.auth !== false && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

    /*
     * Rate limiting is a normal condition, not a failure.
     *
     * The API publishes its limits in `RateLimit` headers and answers 429 with a documented
     * error. An Agent that treats that as fatal stops trading because of a queue — which is what
     * happened when twenty Agents onboarded at once and half of them died on the key-issuance
     * limit rather than waiting the few seconds it asked for.
     *
     * So: wait for exactly as long as the response asks, and try again. `Retry-After` is honoured
     * when present, otherwise the RateLimit reset window, otherwise a short backoff. The retry
     * budget is small and finite — a limit that is still refusing after several honest waits is a
     * real problem and should surface as one.
     */
    let response!: Response;
    for (let attempt = 0; attempt <= 4; attempt++) {
      response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (response.status !== 429 || attempt === 4) break;

      const retryAfter = Number(response.headers.get("retry-after") ?? "");
      const reset = Number(/reset=(\d+)/.exec(response.headers.get("ratelimit") ?? "")?.[1] ?? "");
      const waitSeconds = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : Number.isFinite(reset) && reset > 0
          ? reset
          : 2 ** attempt;
      // Capped: a pathological reset value must not park an Agent for the rest of the run.
      const waitMs = Math.min(waitSeconds, 65) * 1000 + Math.random() * 400;
      this.log(`rate limited on ${path}, waiting ${Math.round(waitMs / 1000)}s`, { attempt });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }

    if (!response.ok) {
      const err = (
        body as {
          error?: {
            code: string;
            message: string;
            details?: unknown;
            example?: { whatWentWrong?: string; doThisInstead?: string; example?: unknown };
          };
        } | null
      )?.error;

      /*
       * Fold the reason INTO the message, because only the message is usually read.
       *
       * A validation failure arrives as "Invalid product request" with the offending fields in
       * `details.issues` — and every caller that logs `error.message` throws that away. An Agent
       * then sees a refusal with no reason and repeats the identical call next turn. The details
       * are already there; they just have to travel with the sentence somebody will actually see.
       */
      const detail = err?.details as { issues?: { path?: (string | number)[]; message?: string }[] } | undefined;
      const issues = (detail?.issues ?? [])
        .slice(0, 4)
        .map((i) => `${(i.path ?? []).join(".") || "body"}: ${i.message ?? "invalid"}`)
        .join("; ");

      /*
       * Carry the worked example into the message too.
       *
       * The API now answers every error with a correct call beside the complaint, and it is the
       * only part of the response that tells a caller what to do DIFFERENTLY. Left in the body it
       * would share the fate of `details.issues`: present, correct and never read, because what
       * reaches the Agent is the message. An error that explains the rule produces another attempt
       * at the same mistake; one that shows the rule being obeyed does not.
       */
      const ex = err?.example;
      const guidance = ex
        ? ` — ${ex.doThisInstead ?? ""}` +
          (ex.example !== undefined ? ` EXAMPLE: ${JSON.stringify(ex.example)}` : "")
        : "";

      throw new AgentError(
        err?.code ?? "HTTP_ERROR",
        (err?.message ?? `${method} ${path} failed with ${response.status}`) +
          (issues ? ` — ${issues}` : "") +
          guidance,
        response.status,
        err?.details
      );
    }
    return body as T;
  }

  private nextIdempotencyKey(action: string): string {
    this.idempotencyCounter += 1;
    return `${this.name}-${action}-${Date.now()}-${this.idempotencyCounter}`;
  }

  /* --------------------------------------------------------------- onboarding */

  /**
   * Full self-onboarding with only a wallet: challenge, sign, receive the key once.
   * No human ever visits the website for this. [MASTER_PLAN 0.26.B]
   */
  async onboard(): Promise<void> {
    const status = await this.http<{ status: string }>(
      "GET",
      `/api/v1/auth/api-key/status?wallet=${this.address}`,
      { auth: false }
    );
    const purpose = status.status === "ACTIVE" ? "ROTATE_API_KEY" : "ISSUE_API_KEY";

    const challenge = await this.http<{ nonce: string; message: string }>(
      "POST",
      "/api/v1/auth/challenge",
      { body: { wallet: this.address, purpose }, auth: false }
    );

    const signature = await this.wallet.signMessage(challenge.message);
    const path = purpose === "ROTATE_API_KEY" ? "/api/v1/auth/api-key/rotate" : "/api/v1/auth/api-key/issue";
    const issued = await this.http<{ apiKey: string; apiKeyPrefix: string }>("POST", path, {
      body: { nonce: challenge.nonce, signature },
      auth: false,
    });

    // The key lives only in memory for the life of this process.
    this.apiKey = issued.apiKey;
    this.log("onboarded", { keyPrefix: issued.apiKeyPrefix, wallet: this.address });
  }

  /**
   * Adopt a key this wallet was already issued, instead of onboarding again.
   *
   * `onboard()` ROTATES when the wallet already has an active key, and rotation invalidates the
   * key every other holder is using. That is the right default for a fresh process, and the wrong
   * one for a process resuming work the same wallet was already doing — it throws away a
   * perfectly good credential and, if two things resume at once, they invalidate each other in
   * turn. A caller that has kept the key can hand it back here and carry on as the same identity.
   *
   * The caller is responsible for the key being real; the first authenticated call will say
   * otherwise if it is not.
   */
  adoptApiKey(key: string): void {
    if (typeof key === "string" && key.length > 0) this.apiKey = key;
    /* An empty string means the key is gone (revoked by its owner); forget it rather than keep a dead one. */
    else if (key === "") this.apiKey = null;
  }

  /**
   * The API key this instance is currently using, or null before onboarding.
   *
   * Exposed so an embedder can make a raw HTTP call with the SAME key rather than calling
   * `onboard()` again to obtain one: onboarding rotates, and rotation invalidates the key every
   * other part of the process is already holding. The value is returned, never logged, never
   * written to disk and never placed in a URL. [MASTER_PLAN 0.27.L]
   */
  get currentApiKey(): string | null {
    return this.apiKey;
  }

  /**
   * Verifies the deployment is the one we think it is BEFORE spending anything.
   * [MASTER_PLAN 0.26.F step 1, 0.27.G fail-closed]
   */
  async verifyDeployment(): Promise<Record<string, unknown>> {
    const schema = await this.http<Record<string, never> & Record<string, unknown>>(
      "GET",
      "/api/v1/schema",
      { auth: false }
    );
    const chain = schema.chain as { chainId: number };
    if (chain.chainId !== this.config.chainId) {
      throw new AgentError(
        "CHAIN_MISMATCH",
        `Schema reports chain ${chain.chainId} but this Agent is configured for ${this.config.chainId}. Refusing to act.`
      );
    }
    const walletChain = Number((await this.provider.getNetwork()).chainId);
    if (walletChain !== this.config.chainId) {
      throw new AgentError("CHAIN_MISMATCH", `Wallet RPC is on chain ${walletChain}, expected ${this.config.chainId}`);
    }
    this.log("deployment verified", {
      environment: schema.protocolVersion,
      chainId: chain.chainId,
    });
    return schema;
  }

  /** Confirms an address is canonical before treating it as protocol-trusted. [0.26.E] */
  async assertCanonical(address: string, expectedRole?: string): Promise<void> {
    const result = await this.http<{ canonical: boolean; role: string; warning?: string }>(
      "GET",
      `/api/v1/contracts/${address}`,
      { auth: false }
    );
    if (!result.canonical) {
      throw new AgentError(
        "UNTRUSTED_UNKNOWN_CONTRACT",
        `${address} is not a canonical AIC contract (${result.warning ?? "unknown"}). Refusing to transact.`
      );
    }
    if (expectedRole && result.role !== expectedRole) {
      throw new AgentError(
        "CANONICAL_MISMATCH",
        `${address} is canonical but its role is ${result.role}, not ${expectedRole}.`
      );
    }
  }

  /**
   * Waits until the indexed projection has caught up with everything this Agent has done.
   *
   * Quotes are computed from the projection, not from a live chain read, which is what keeps
   * ordinary reads at zero RPC cost. The consequence is that a quote taken immediately after
   * your own transaction can be priced against pre-transaction state. A careful Agent checks
   * freshness before an economic decision rather than widening slippage until it stops
   * noticing. [MASTER_PLAN 0.22.F, recommendations]
   */
  async waitForIndexer(minBlock?: number, timeoutMs = 20_000): Promise<void> {
    // Default to the current chain head, not merely this Agent's own last action: another
    // Agent's trade in the same market moves the price just as much as our own.
    const target = minBlock ?? Math.max(this.lastActionBlock, await this.provider.getBlockNumber());
    if (target === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.http<{ indexer: { indexedBlock: number } }>("GET", "/api/v1/status", {
        auth: false,
      });
      if (status.indexer.indexedBlock >= target) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new AgentError(
      "INDEXER_STALE",
      `The indexer did not reach block ${target} within ${timeoutMs}ms. Refusing to quote against stale state.`
    );
  }

  /* ---------------------------------------------------------------- reads */

  discovery(): Promise<Record<string, never> & Record<string, unknown>> {
    return this.http("GET", "/api/v1/discovery", { auth: false });
  }

  recentProducts(): Promise<{ items: Record<string, never>[] }> {
    return this.http("GET", "/api/v1/products/recent", { auth: false });
  }

  myDividends(): Promise<Record<string, never> & Record<string, unknown>> {
    return this.http("GET", "/api/v1/dividends/me");
  }

  myLicenses(): Promise<{ items: Record<string, never>[] }> {
    return this.http("GET", "/api/v1/me/licenses");
  }

  notifications(): Promise<Record<string, never> & Record<string, unknown>> {
    return this.http("GET", "/api/v1/notifications");
  }

  governanceTasks(): Promise<Record<string, never> & Record<string, unknown>> {
    return this.http("GET", "/api/v1/governance/tasks");
  }

  sellerSignals(wallet: string): Promise<Record<string, never> & Record<string, unknown>> {
    return this.http("GET", `/api/v1/signals/sellers/${wallet}`, { auth: false });
  }

  /* --------------------------------------------------------------- budget */

  private chargeBudget(amount: bigint, label: string): void {
    if (amount > this.config.budget.maxPerTransactionUSDC) {
      throw new BudgetExceededError(
        `${label}: ${amount} exceeds the per-transaction cap of ${this.config.budget.maxPerTransactionUSDC}`
      );
    }
    const wouldSpend = this.spent + amount;
    const remaining = this.config.budget.totalUSDC - wouldSpend;
    if (remaining < this.config.budget.minReserveUSDC) {
      throw new BudgetExceededError(
        `${label}: spending ${amount} would leave ${remaining} below the ${this.config.budget.minReserveUSDC} reserve floor`
      );
    }
    this.spent = wouldSpend;
  }

  /* ---------------------------------------------------------- intent flow */

  /**
   * Executes an intent: inspect it, set the EXACT allowance it requires, sign, submit, and
   * report the receipt. This is the only path through which this Agent ever moves value.
   */
  async execute(intent: TransactionIntent, options: { budgetLabel?: string } = {}): Promise<string> {
    if (intent.chainId !== this.config.chainId) {
      throw new AgentError("CHAIN_MISMATCH", `Intent is for chain ${intent.chainId}`);
    }
    if (new Date(intent.expiresAt).getTime() < Date.now()) {
      throw new AgentError("QUOTE_EXPIRED", "This intent expired before it was signed");
    }
    // `blocked_on_allowance` is expected on a first purchase: the approval below fixes it.
    // A genuine predicted revert is a reason to stop and not waste gas.
    if (intent.simulation.status === "would_revert") {
      throw new AgentError(
        "TRANSACTION_FAILED",
        `Simulation predicts a revert: ${intent.simulation.revertReason ?? "unknown"}`
      );
    }

    if (intent.requiredAllowance) {
      const required = BigInt(intent.requiredAllowance.amount.base);
      if (intent.requiredAllowance.tokenSymbol === "USDC" && options.budgetLabel) {
        this.chargeBudget(required, options.budgetLabel);
      }
      await this.approveExactly(
        intent.requiredAllowance.token,
        intent.requiredAllowance.spender,
        required
      );
    }

    const tx = await this.wallet.sendTransaction({
      to: intent.transaction.to,
      data: intent.transaction.data,
      value: BigInt(intent.transaction.value),
    });
    const receipt = await tx.wait();
    if (receipt?.blockNumber && receipt.blockNumber > this.lastActionBlock) {
      this.lastActionBlock = receipt.blockNumber;
    }
    this.log(`executed ${intent.summary.action}`, { txHash: tx.hash, block: receipt?.blockNumber });
    return tx.hash;
  }

  /**
   * Sets an allowance to EXACTLY the amount required, never more.
   * MASTER_PLAN 0.24.R: do not default Agents to unlimited approvals.
   */
  private async approveExactly(token: string, spender: string, amount: bigint): Promise<void> {
    const erc20 = new Contract(token, ERC20_ABI, this.wallet);
    const current = (await erc20.allowance!(this.address, spender)) as bigint;
    if (current === amount) return;
    // Some tokens require clearing a non-zero allowance first; USDC does not, but doing it
    // unconditionally costs one call and removes a whole class of surprise.
    if (current > 0n) {
      await (await erc20.approve!(spender, 0n)).wait();
    }
    await (await erc20.approve!(spender, amount)).wait();

    /*
     * Wait until the approval can actually be READ back.
     *
     * `wait()` returning means the approval was mined, not that the node answering the next call
     * has seen it. Public RPC endpoints are load balanced across nodes at slightly different
     * heights, so the very next request — gas estimation for the trade that needs this allowance
     * — can land on a node still one block behind and revert with ERC20InsufficientAllowance.
     *
     * That is exactly what happened under test: `buy_aic` failed with a raw
     * `0xfb8f41b2` custom error while the approval was already on chain. Same class as the
     * deployment-time lag recorded as F-015; the fix is the same, which is to confirm the read
     * rather than to trust the write.
     */
    for (let attempt = 0; attempt < 12; attempt++) {
      const settled = (await erc20.allowance!(this.address, spender)) as bigint;
      if (settled >= amount) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new AgentError(
      "ALLOWANCE_NOT_SETTLED",
      `Approved ${amount} to ${spender} but the allowance is still not readable. Refusing to send a transaction that would revert.`
    );
  }

  /* ------------------------------------------------------------- commerce */

  async createStore(input: {
    storeType: "sales" | "rentals";
    aicName: string;
    aicSymbol: string;
    storeName: string;
    /** Owner-funded initial market capital, decimal USDC; the protocol minimum (5) when omitted. */
    initialOwnerSeedUSDC?: string;
  }): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>("POST", "/api/v1/stores", {
      body: { ...input, initialOwnerSeedUSDC: input.initialOwnerSeedUSDC ?? "5" },
      idempotencyKey: this.nextIdempotencyKey("create-store"),
    });
    return this.execute(intent);
  }

  async createProduct(
    storeId: string,
    input: {
      productId: string;
      priceUSDC: string;
      inventory?: string;
      unlimitedInventory?: boolean;
      rentalPeriodSeconds?: number;
      metadataURI?: string;
      /**
       * keccak256 of the exact bytes a buyer receives. Required and non-zero: it is the
       * commitment the buyer verifies delivery against, and the API refuses a product without
       * one. See SECURITY_FINDINGS F-016.
       */
      contentHash: string;
      /** Phase 10.1. Optional, and copied verbatim. Never overstate it. */
      declaration?: { inputTokens?: string; reasoningTokens?: string; outputTokens?: string; tokensSaved?: string; modelTier: string; basis: "ESTIMATED" | "MEASURED" } | null;
      /** Required by the site: the work behind this upload, and one explanation (no code) per iteration. */
      iterations?: number;
      iterationLog?: string[];
    }
  ): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/stores/${storeId}/products`,
      { body: input, idempotencyKey: this.nextIdempotencyKey("create-product") }
    );
    return this.execute(intent);
  }

  /**
   * Change a product in place. Bumps its version, which invalidates outstanding quotes — that is
   * the point: a buyer must never execute against a price the seller has since moved.
   */
  async updateProduct(
    storeId: string,
    productId: string,
    input: {
      priceUSDC: string;
      inventory?: string;
      active?: boolean;
      rentalPeriodSeconds?: number;
      contentHash?: string;
      metadataURI?: string;
      declaration?: { inputTokens?: string; reasoningTokens?: string; outputTokens?: string; tokensSaved?: string; modelTier: string; basis: "ESTIMATED" | "MEASURED" } | null;
      /** Required with a new contentHash: iterations behind the new upload and one explanation per iteration. */
      iterations?: number;
      iterationLog?: string[];
    }
  ): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/stores/${storeId}/products/${productId}/update`,
      { body: input, idempotencyKey: this.nextIdempotencyKey("update-product") }
    );
    return this.execute(intent);
  }

  /**
   * Publish the store display profile. Untrusted display content only: it confers no protocol
   * meaning and never affects ranking, pricing or canonicality.
   */
  async setStoreProfile(storeId: string, profile: Record<string, unknown>): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/stores/${storeId}/profile`,
      { body: { profile }, idempotencyKey: this.nextIdempotencyKey("profile") }
    );
    return this.execute(intent);
  }

  async setAccessAttestor(storeId: string, attestor: string): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/stores/${storeId}/access-attestor`,
      { body: { attestor }, idempotencyKey: this.nextIdempotencyKey("attestor") }
    );
    return this.execute(intent);
  }

  /** Obtains a fresh quote. Never execute from a discovery feed. [0.27.U] */
  async quote(storeId: string, productId: string, units: number): Promise<Record<string, never> & Record<string, unknown>> {
    await this.waitForIndexer();
    return this.http("POST", `/api/v1/stores/${storeId}/products/${productId}/quote`, {
      body: { units },
    });
  }

  /**
   * Buys or rents, binding the freshly quoted version and maximum into execution so a
   * concurrent price or terms edit can never silently overcharge. [0.24.G/H]
   */
  async buy(
    storeId: string,
    productId: string,
    units: number,
    kind: "purchase" | "rent" = "purchase"
  ): Promise<{ txHash: string; totalUSDC: bigint; expectedRewardAIC: bigint }> {
    const quoted = await this.quote(storeId, productId, units);
    const q = quoted.quote as Record<string, never> & Record<string, unknown>;
    const gross = BigInt((q.gross as Amount).base);
    const expectedReward = BigInt((q.expectedRewardAIC as Amount).base);

    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/stores/${storeId}/products/${productId}/${kind}`,
      {
        body: {
          units,
          expectedVersion: q.productVersion,
          maxTotalUSDC: (q.maxTotalUSDC as string),
        },
        idempotencyKey: this.nextIdempotencyKey(kind),
      }
    );

    const txHash = await this.execute(intent, { budgetLabel: `${kind} ${productId}` });
    return { txHash, totalUSDC: gross, expectedRewardAIC: expectedReward };
  }

  /* ---------------------------------------------------------------- market */

  async quoteAic(aicToken: string, side: "buy" | "sell", amount: bigint): Promise<Record<string, never> & Record<string, unknown>> {
    await this.waitForIndexer();
    return this.http("POST", `/api/v1/stocks/${aicToken}/quote`, {
      body: { side, amount: amount.toString() },
    });
  }

  async tradeAic(
    aicToken: string,
    side: "buy" | "sell",
    amount: bigint,
    slippageBps = 300
  ): Promise<string> {
    const quoted = await this.quoteAic(aicToken, side, amount);
    const q = quoted.quote as Record<string, never> & Record<string, unknown>;
    const expected =
      side === "buy"
        ? BigInt((q.expectedOutAIC as Amount).base)
        : BigInt((q.expectedOutUSDC as Amount).base);
    // Always set a real slippage bound. Zero means accepting any price.
    const minOut = (expected * BigInt(10_000 - slippageBps)) / 10_000n;

    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/stocks/${aicToken}/${side}`,
      {
        body: { amount: amount.toString(), minOut: minOut.toString(), deadlineSeconds: 600 },
        idempotencyKey: this.nextIdempotencyKey(`aic-${side}`),
      }
    );
    return this.execute(intent, { budgetLabel: side === "buy" ? `aic buy` : undefined });
  }

  /* -------------------------------------------------------------- signals */

  /**
   * Phase 10.1. Records the binary verdict after delivery. This pays nothing and is expected
   * to pay nothing; it exists so the next Agent can tell value from bytes.
   */
  async signal(licenseToken: string, licenseId: string, worthIt: boolean): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/licenses/${licenseToken}/${licenseId}/signal`,
      { body: { worthIt }, idempotencyKey: this.nextIdempotencyKey("signal") }
    );
    return this.execute(intent);
  }

  /* ------------------------------------------------------------ dividends */

  async openDistribution(storeId: string): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/dividends/stores/${storeId}/open`,
      { body: {}, idempotencyKey: this.nextIdempotencyKey("open-dist") }
    );
    return this.execute(intent);
  }

  async claim(distributor: string, epochId: string): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/dividends/${distributor}/${epochId}/claim-intent`,
      { body: {}, idempotencyKey: this.nextIdempotencyKey("claim") }
    );
    return this.execute(intent);
  }

  /* ----------------------------------------------------------- governance */

  async propose(storeId: string, contentHash: string, descriptionURI: string, votingPeriodSeconds: number): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/stores/${storeId}/proposals`,
      {
        body: { contentHash, descriptionURI, votingPeriodSeconds },
        idempotencyKey: this.nextIdempotencyKey("propose"),
      }
    );
    return this.execute(intent);
  }

  async vote(governance: string, proposalId: string, support: boolean): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/governance/${governance}/${proposalId}/vote`,
      { body: { support }, idempotencyKey: this.nextIdempotencyKey("vote") }
    );
    return this.execute(intent);
  }

  async markImplemented(governance: string, proposalId: string, evidenceHash: string, evidenceURI: string): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/governance/${governance}/${proposalId}/mark-implemented`,
      { body: { evidenceHash, evidenceURI }, idempotencyKey: this.nextIdempotencyKey("mark") }
    );
    return this.execute(intent);
  }

  async verifyImplementation(governance: string, proposalId: string): Promise<string> {
    const { intent } = await this.http<{ intent: TransactionIntent }>(
      "POST",
      `/api/v1/governance/${governance}/${proposalId}/verify-intent`,
      { body: {}, idempotencyKey: this.nextIdempotencyKey("verify") }
    );
    return this.execute(intent);
  }

  /* --------------------------------------------------------------- wallet */

  async usdcBalance(usdcAddress: string): Promise<bigint> {
    const erc20 = new Contract(usdcAddress, ERC20_ABI, this.provider);
    return (await erc20.balanceOf!(this.address)) as bigint;
  }

  async nativeBalance(): Promise<bigint> {
    return this.provider.getBalance(this.address);
  }

  /**
   * Gas autonomy check. MASTER_PLAN 0.11: an Agent must never spend its last usable gas in a
   * way that makes the next required transaction impossible when that can be avoided.
   */
  async hasGasForNextTransaction(estimatedGas = 400_000n): Promise<boolean> {
    const balance = await this.nativeBalance();
    const fee = await this.provider.getFeeData();
    const price = fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000_000n;
    return balance >= estimatedGas * price * 2n;
  }
}

export function productIdFor(slug: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(slug));
}

export const USDC = (n: string | number): bigint => ethers.parseUnits(String(n), 6);
export const AIC = (n: string | number): bigint => ethers.parseUnits(String(n), 18);
