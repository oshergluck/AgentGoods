/**
 * Transaction intents.
 *
 * MASTER_PLAN §10 and 0.27.E: the backend never holds a user private key and never signs. A
 * write endpoint returns a deterministic, fully specified TransactionIntent; the Agent EOA
 * signs and submits it. An API key can request an intent and can never execute one.
 *
 * Every intent is fail-closed on indexer staleness (0.22.F), binds the canonical contract
 * resolved from the Registry projection rather than anything in the request body (0.25.N),
 * states the exact ERC-20 allowance it needs (0.4), and carries a human/Agent-readable
 * summary of what signing it will actually do.
 */

import crypto from "node:crypto";
import { Interface } from "ethers";

/** The one ERC-20 function this module encodes on a caller's behalf. */
export const ERC20 = new Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
import { TransactionIntent } from "../db/models";
import { ApiError } from "../http/errors";
import type { AppContext } from "../http/context";
import type { Amount } from "../config/units";

export interface AllowanceRequirement {
  token: string;
  tokenSymbol: "USDC" | "AIC";
  spender: string;
  /** Exact amount required. Never request an unlimited approval. [0.24.R] */
  amount: Amount;
  reason: string;
}

export interface IntentSummary {
  action: string;
  description: string;
  /** Structured, trusted protocol facts. Never mixed with seller content. [0.27.P] */
  protocol: Record<string, unknown>;
  /** Untrusted seller-supplied strings, clearly quarantined. */
  sellerContent?: Record<string, unknown>;
  warnings: string[];
}

/**
 * Advisory pre-flight result. MASTER_PLAN 0.24.Q: simulation is advisory and never replaces
 * the on-chain checks. `blocked_on_allowance` is its own status rather than a revert, because
 * "you have not approved the token yet" is an instruction to the Agent, not a defect in the
 * transaction, and reporting it as a revert would make every first-time purchase look broken.
 */
export interface SimulationResult {
  status: "skipped" | "ok" | "would_revert" | "blocked_on_allowance";
  revertReason: string | null;
  currentAllowance?: string;
  requiredAllowance?: string;
}

export interface BuildIntentOptions {
  ctx: AppContext;
  wallet: string;
  action: string;
  contract: string;
  abi: Interface;
  functionName: string;
  args: unknown[];
  value?: bigint;
  summary: IntentSummary;
  allowance?: AllowanceRequirement | null;
  ttlSeconds?: number;
  /** Set false for genuinely low-risk intents; defaults to fail-closed. */
  requireFreshIndexer?: boolean;
}

export interface TransactionIntentResponse {
  intentId: string;
  chainId: number;
  status: string;
  /** Everything an Agent needs to sign, with no further lookups. */
  transaction: {
    to: string;
    data: string;
    value: string;
    chainId: number;
  };
  functionName: string;
  args: unknown[];
  requiredAllowance: AllowanceRequirement | null;
  /** Prepared approve() calldata for `requiredAllowance`, or null when no allowance is needed. */
  approvalTransaction: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    signFirst: true;
    why: string;
  } | null;
  summary: IntentSummary;
  simulation: SimulationResult;
  expiresAt: string;
  asOfIndexedBlock: number;
  signing: {
    signer: string;
    note: string;
  };
  /**
   * The link a wallet fetches this transaction from, so no calldata is ever copied by hand.
   * `transaction` there is always the next thing to sign (the approval first, when still needed).
   */
  transactionRequest: {
    intentId: string;
    url: string;
    path: string;
    howToUse: string;
  };
}

/** The transaction-request link for an intent: a wallet fetches and signs what it returns. */
export function transactionRequestFor(publicBaseUrl: string, intentId: string, hasApproval: boolean) {
  const path = `/api/v1/tx/${intentId}`;
  return {
    intentId,
    url: `${publicBaseUrl.replace(/\/$/, "")}${path}`,
    path,
    howToUse:
      "Give this link — or just the intentId — to your wallet to sign; it fetches the transaction itself, so there is " +
      "no calldata to copy. " +
      (hasApproval
        ? "It returns the approval first; once that is mined, send the same link again for the prepared transaction."
        : "It returns the prepared transaction.") +
      " If your wallet can only take raw fields, `transaction` above carries to / data / value.",
  };
}

/**
 * Builds, simulates and persists an intent.
 *
 * Simulation is advisory only: it is an `eth_call` against current state and never replaces
 * the on-chain checks, which is exactly what 0.24.Q asks for. A predicted revert is surfaced
 * rather than hidden, so an Agent does not waste gas.
 */
export async function buildIntent(options: BuildIntentOptions): Promise<TransactionIntentResponse> {
  const { ctx } = options;
  const status = ctx.indexerStatus();

  if (options.requireFreshIndexer !== false && status.stale) {
    throw ApiError.indexerStale({
      indexedBlock: status.indexedBlock,
      chainHead: status.chainHead,
      lagBlocks: status.lagBlocks,
      action: options.action,
    });
  }

  const data = options.abi.encodeFunctionData(options.functionName, options.args);
  const argsHash = crypto.createHash("sha256").update(JSON.stringify(serialize(options.args))).digest("hex");
  const intentId = `txi_${crypto.randomBytes(16).toString("hex")}`;
  const ttl = options.ttlSeconds ?? 900;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  const simulation = await preflight(ctx, options, data);

  await TransactionIntent.create({
    intentId,
    chainId: ctx.env.CHAIN_ID,
    agentWallet: options.wallet.toLowerCase(),
    action: options.action,
    contract: options.contract.toLowerCase(),
    functionName: options.functionName,
    argsHash,
    calldata: data,
    value: (options.value ?? 0n).toString(),
    summary: options.summary,
    requiredAllowance: options.allowance ?? null,
    simulation,
    status: "awaiting_signature",
    expiresAt,
    asOfIndexedBlock: status.indexedBlock,
  });

  return {
    intentId,
    chainId: ctx.env.CHAIN_ID,
    status: "awaiting_signature",
    transaction: {
      to: options.contract,
      data,
      value: (options.value ?? 0n).toString(),
      chainId: ctx.env.CHAIN_ID,
    },
    functionName: options.functionName,
    args: serialize(options.args) as unknown[],
    requiredAllowance: options.allowance ?? null,
    /*
     * The approval, PREPARED, not merely demanded.
     *
     * This response used to say "you need an allowance of X to spender Y" and stop. Producing that
     * approval meant ABI-encoding approve(address,uint256) by hand — 136 hex characters — which is
     * exactly the transcription this API exists to remove, and every buy, sell and pool deposit
     * began with it. Two hundred and six reverts in one run were ERC-20 spends that never had
     * their allowance. So the approval travels with the intent as calldata a caller can sign as
     * it is: exact amount, exact spender, nothing to type.
     */
    approvalTransaction: options.allowance
      ? {
          to: options.allowance.token,
          data: ERC20.encodeFunctionData("approve", [options.allowance.spender, BigInt(options.allowance.amount.base)]),
          value: "0",
          chainId: ctx.env.CHAIN_ID,
          signFirst: true,
          why:
            `Approves exactly ${options.allowance.amount.display} ${options.allowance.tokenSymbol} to ` +
            `${options.allowance.spender}. Sign this, wait for it to mine, then sign \`transaction\`; ` +
            "without it the transaction reverts.",
        }
      : null,
    summary: options.summary,
    simulation,
    expiresAt: expiresAt.toISOString(),
    asOfIndexedBlock: status.indexedBlock,
    signing: {
      signer: options.wallet,
      note:
        "Sign and submit this transaction with the Agent EOA. The AIC API key cannot sign " +
        "transactions and never has authority over wallet funds.",
    },
    transactionRequest: transactionRequestFor(ctx.env.PUBLIC_BASE_URL, intentId, Boolean(options.allowance)),
  };
}

async function preflight(
  ctx: AppContext,
  options: BuildIntentOptions,
  data: string
): Promise<SimulationResult> {
  if (!ctx.providers) return { status: "skipped", revertReason: null };

  // An intent that requires an ERC-20 allowance cannot be simulated meaningfully until that
  // allowance exists. Report the real cause instead of an opaque revert the Agent would have
  // to guess at.
  if (options.allowance) {
    const required = BigInt(options.allowance.amount.base);
    const current = await currentAllowance(
      ctx,
      options.allowance.token,
      options.wallet,
      options.allowance.spender
    );
    if (current !== null && current < required) {
      return {
        status: "blocked_on_allowance",
        revertReason: null,
        currentAllowance: current.toString(),
        requiredAllowance: required.toString(),
      };
    }
  }

  try {
    await ctx.providers.call("eth_call", (p) =>
      p.call({ from: options.wallet, to: options.contract, data, value: options.value ?? 0n })
    );
    return { status: "ok", revertReason: null };
  } catch (error) {
    const message = (error as { shortMessage?: string; message?: string }).shortMessage
      ?? (error as Error).message
      ?? "unknown";

    /*
     * Name the error the contract actually threw.
     *
     * ethers reports an undecoded custom error as "execution reverted (unknown custom error)",
     * which tells an Agent nothing it can act on — so it retries the same call and fails the same
     * way. Twelve product listings died like that in one test run before anyone could say why.
     *
     * The selector is in the revert data and the ABI already describes every error the contract
     * declares, so decoding it is a lookup. A named error like `InvalidDeclaration()` is the
     * difference between an Agent that corrects itself and one that loops.
     */
    const revertData = (error as { data?: string; info?: { error?: { data?: string } } }).data
      ?? (error as { info?: { error?: { data?: string } } }).info?.error?.data;

    if (typeof revertData === "string" && revertData.length >= 10) {
      try {
        const decoded = options.abi.parseError(revertData);
        if (decoded) {
          const args = decoded.args.length > 0 ? `(${decoded.args.map(String).join(", ")})` : "()";
          return {
            status: "would_revert",
            revertReason: `${decoded.name}${args} — the contract refused this call`.slice(0, 500),
          };
        }
      } catch {
        // Not one of this contract's errors; the raw message is still better than nothing.
      }
    }

    return { status: "would_revert", revertReason: message.slice(0, 500) };
  }
}

const ALLOWANCE_SELECTOR = "0xdd62ed3e";

export async function currentAllowance(
  ctx: AppContext,
  token: string,
  owner: string,
  spender: string
): Promise<bigint | null> {
  if (!ctx.providers) return null;
  try {
    const callData =
      ALLOWANCE_SELECTOR +
      owner.toLowerCase().replace("0x", "").padStart(64, "0") +
      spender.toLowerCase().replace("0x", "").padStart(64, "0");
    const result = await ctx.providers.call("eth_call", (p) => p.call({ to: token, data: callData }));
    return BigInt(result);
  } catch {
    return null;
  }
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialize(v);
    return out;
  }
  return value;
}

export async function getIntent(intentId: string, wallet: string): Promise<TransactionIntentResponse | null> {
  const doc = await TransactionIntent.findOne({ intentId, agentWallet: wallet.toLowerCase() }).lean();
  if (!doc) return null;
  return {
    intentId: doc.intentId,
    chainId: doc.chainId,
    status: doc.status,
    transaction: {
      to: doc.contract,
      data: doc.calldata,
      value: doc.value,
      chainId: doc.chainId,
    },
    functionName: doc.functionName,
    args: [],
    requiredAllowance: (doc.requiredAllowance as AllowanceRequirement | null) ?? null,
    approvalTransaction: (() => {
      const a = (doc.requiredAllowance as AllowanceRequirement | null) ?? null;
      if (!a) return null;
      return {
        to: a.token,
        data: ERC20.encodeFunctionData("approve", [a.spender, BigInt(a.amount.base)]),
        value: "0",
        chainId: doc.chainId,
        signFirst: true as const,
        why: `Approves exactly ${a.amount.display} ${a.tokenSymbol} to ${a.spender}. Sign this first, then \`transaction\`.`,
      };
    })(),
    summary: doc.summary as IntentSummary,
    simulation: (doc.simulation as never) ?? { status: "skipped", revertReason: null },
    expiresAt: doc.expiresAt.toISOString(),
    asOfIndexedBlock: doc.asOfIndexedBlock,
    signing: {
      signer: wallet,
      note:
        "Sign and submit this transaction with the Agent EOA. The AIC API key cannot sign " +
        "transactions and never has authority over wallet funds.",
    },
    transactionRequest: transactionRequestFor(process.env.PUBLIC_BASE_URL ?? "", doc.intentId, Boolean(doc.requiredAllowance)),
  };
}

/**
 * Records that an Agent broadcast an intent. The indexer, not this call, is what makes the
 * resulting state canonical; this only links a hash to an intent for status reporting.
 */
export async function attachTxHash(intentId: string, wallet: string, txHash: string): Promise<void> {
  const updated = await TransactionIntent.findOneAndUpdate(
    { intentId, agentWallet: wallet.toLowerCase() },
    { $set: { txHash, status: "submitted" } },
    { new: true }
  );
  if (!updated) throw ApiError.notFound("Transaction intent");
}
