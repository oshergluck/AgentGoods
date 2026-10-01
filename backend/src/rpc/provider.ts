/**
 * RPC provider management and cost accounting.
 *
 * MASTER_PLAN 0.3 requires a primary provider plus at least one failover, and forbids
 * double-calling providers for normal reads. §28 makes RPC cost an architecture test: public
 * GET endpoints must perform ZERO RPC calls, and the indexer must be the primary consumer.
 *
 * Every provider call in the whole backend goes through `rpc()` so the counters are
 * authoritative, and `assertNoRpc()` lets route tests fail if a handler ever reaches for the
 * chain. That is the automated guard §28.16 asks for.
 */

import { JsonRpcProvider, WebSocketProvider, type Provider } from "ethers";
import { logger } from "../utils/logger";

export interface RpcMetrics {
  requestsTotal: number;
  byMethod: Record<string, number>;
  errorsTotal: number;
  failoverCount: number;
  totalLatencyMs: number;
  cacheHits: number;
  cacheMisses: number;
  wsReconnects: number;
}

const metrics: RpcMetrics = {
  requestsTotal: 0,
  byMethod: {},
  errorsTotal: 0,
  failoverCount: 0,
  totalLatencyMs: 0,
  cacheHits: 0,
  cacheMisses: 0,
  wsReconnects: 0,
};

export function rpcMetrics(): RpcMetrics {
  return { ...metrics, byMethod: { ...metrics.byMethod } };
}

export function resetRpcMetrics(): void {
  metrics.requestsTotal = 0;
  metrics.byMethod = {};
  metrics.errorsTotal = 0;
  metrics.failoverCount = 0;
  metrics.totalLatencyMs = 0;
  metrics.cacheHits = 0;
  metrics.cacheMisses = 0;
  metrics.wsReconnects = 0;
}

/**
 * When armed, any RPC call throws. Route-level tests arm this to prove that a GET served
 * from the indexed projection never touches the chain. [MASTER_PLAN rule 14, §28]
 */
let rpcForbidden: string | null = null;

export function forbidRpc(reason: string): void {
  rpcForbidden = reason;
}

export function allowRpc(): void {
  rpcForbidden = null;
}

export class RpcForbiddenError extends Error {
  constructor(method: string, reason: string) {
    super(
      `RPC call "${method}" attempted while RPC is forbidden (${reason}). ` +
        `Reads must come from the indexed projection. [MASTER_PLAN rule 14]`
    );
    this.name = "RpcForbiddenError";
  }
}

export interface ProviderPoolOptions {
  primaryUrl: string;
  secondaryUrl?: string | undefined;
  wsUrl?: string | undefined;
  chainId: number;
}

export class ProviderPool {
  readonly primary: JsonRpcProvider;
  readonly secondary: JsonRpcProvider | null;
  private ws: WebSocketProvider | null = null;
  private readonly options: ProviderPoolOptions;

  constructor(options: ProviderPoolOptions) {
    this.options = options;
    const network = { chainId: options.chainId, name: `chain-${options.chainId}` };
    this.primary = new JsonRpcProvider(options.primaryUrl, network, { staticNetwork: true });
    this.secondary = options.secondaryUrl
      ? new JsonRpcProvider(options.secondaryUrl, network, { staticNetwork: true })
      : null;
  }

  /**
   * Executes one logical read. The secondary provider is used ONLY on primary failure or when
   * the caller explicitly asks for a reconciliation cross-check; it is never called in
   * parallel for a normal read. [MASTER_PLAN 0.3 "Do not double-call providers"]
   */
  async call<T>(method: string, fn: (provider: Provider) => Promise<T>): Promise<T> {
    if (rpcForbidden) throw new RpcForbiddenError(method, rpcForbidden);

    metrics.requestsTotal += 1;
    metrics.byMethod[method] = (metrics.byMethod[method] ?? 0) + 1;
    const started = Date.now();

    try {
      const result = await fn(this.primary);
      metrics.totalLatencyMs += Date.now() - started;
      return result;
    } catch (primaryError) {
      metrics.errorsTotal += 1;
      if (!this.secondary) throw primaryError;

      logger.warn({ method, err: String(primaryError) }, "primary RPC failed, failing over");
      metrics.failoverCount += 1;
      try {
        const result = await fn(this.secondary);
        metrics.totalLatencyMs += Date.now() - started;
        return result;
      } catch (secondaryError) {
        metrics.errorsTotal += 1;
        throw secondaryError;
      }
    }
  }

  /** Explicit cross-check against the secondary provider, used only by the reconciler. */
  async reconcile<T>(method: string, fn: (provider: Provider) => Promise<T>): Promise<T | null> {
    if (!this.secondary) return null;
    if (rpcForbidden) throw new RpcForbiddenError(method, rpcForbidden);
    metrics.requestsTotal += 1;
    metrics.byMethod[`${method}:reconcile`] = (metrics.byMethod[`${method}:reconcile`] ?? 0) + 1;
    return fn(this.secondary);
  }

  /** Optional websocket provider for live head notifications. Never the only source. */
  websocket(): WebSocketProvider | null {
    if (!this.options.wsUrl) return null;
    if (!this.ws) {
      this.ws = new WebSocketProvider(this.options.wsUrl, {
        chainId: this.options.chainId,
        name: `chain-${this.options.chainId}`,
      });
    }
    return this.ws;
  }

  noteWsReconnect(): void {
    metrics.wsReconnects += 1;
  }

  async destroy(): Promise<void> {
    try {
      this.primary.destroy();
      this.secondary?.destroy();
      if (this.ws) await this.ws.destroy();
    } catch {
      // Provider teardown is best effort; a failure here must never mask a real error.
    }
  }
}

/**
 * Cache for values that are immutable or event-driven: chain id, token decimals, names,
 * symbols and known contract relationships. [MASTER_PLAN 8.9]
 */
const staticCache = new Map<string, unknown>();

export async function cachedStatic<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (staticCache.has(key)) {
    metrics.cacheHits += 1;
    return staticCache.get(key) as T;
  }
  metrics.cacheMisses += 1;
  const value = await load();
  staticCache.set(key, value);
  return value;
}

export function clearStaticCache(): void {
  staticCache.clear();
}
