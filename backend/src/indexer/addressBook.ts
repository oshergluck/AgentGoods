/**
 * Watched address set.
 *
 * MASTER_PLAN 8.6: prefer narrow address/topic filters, discover new store/token/voting/
 * license addresses from Registry/Factory events, and never run one polling loop per store.
 *
 * The address book is rebuilt from the canonical Registry `StoreRegistered` events already in
 * `chain_events`, so it survives a restart with zero RPC and is exact after a reorg rollback.
 */

import type { ContractRole } from "./abis";
import { StockMarket, ChainEvent, Store } from "../db/models";
import type { ProtocolManifest } from "../config/manifest";

export interface WatchedAddress {
  address: string;
  role: ContractRole;
  storeId: string | null;
}

export class AddressBook {
  private readonly byAddress = new Map<string, WatchedAddress>();

  constructor(private readonly manifest: ProtocolManifest) {
    this.addCore();
  }

  private addCore(): void {
    this.put(this.manifest.contracts.registry.proxy, "registry", null);
    this.put(this.manifest.contracts.agentGoods.proxy, "agentGoods", null);
    this.put(this.manifest.contracts.protocolTreasury.address, "treasury", null);
    for (const f of this.manifest.contracts.activeFactories) this.put(f.address, "factory", null);
    for (const f of this.manifest.contracts.deprecatedFactories) this.put(f.address, "factory", null);
  }

  put(address: string | null | undefined, role: ContractRole, storeId: string | null): void {
    // A record missing an address (e.g. written by an older schema) is skipped rather than crashing
    // startup: the indexer rebuilds it from chain events.
    if (typeof address !== "string" || address.length === 0) return;
    this.byAddress.set(address.toLowerCase(), { address: address.toLowerCase(), role, storeId });
  }

  /** Registers the full canonical component set of a store in one step. */
  addStore(record: {
    storeId: string;
    store: string;
    aicToken: string;
    licenseToken: string;
    governance: string;
    dividendDistributor: string;
  }): void {
    this.put(record.store, "store", record.storeId);
    this.put(record.aicToken, "aic", record.storeId);
    this.put(record.licenseToken, "license", record.storeId);
    this.put(record.governance, "governance", record.storeId);
    this.put(record.dividendDistributor, "distributor", record.storeId);
  }

  /**
   * Starts watching the external DEX pair a market listed into.
   *
   * Called when `LiquidityTransition` is projected, and again on hydration from the persisted
   * market row, so a restart does not lose the pair and silently stop recording trades.
   */
  addPair(pair: string, storeId: string): void {
    if (!pair || /^0x0+$/.test(pair)) return;
    this.put(pair, "dexPair", storeId);
  }

  /** The canonical USDC address, needed to tell which side of a pool is money. */
  usdcAddress(): string {
    return this.manifest.external.canonicalUSDC.toLowerCase();
  }

  remove(address: string): void {
    this.byAddress.delete(address.toLowerCase());
  }

  get(address: string): WatchedAddress | undefined {
    return this.byAddress.get(address.toLowerCase());
  }

  addresses(): string[] {
    return [...this.byAddress.keys()];
  }

  size(): number {
    return this.byAddress.size;
  }

  /**
   * Rebuilds the store portion of the book from persisted state. Uses the Store projection
   * when it exists and falls back to the raw Registry events, which is what makes a full
   * projection wipe recoverable without any RPC. [MASTER_PLAN 0.3 chain reconstruction]
   */
  async hydrate(chainId: number): Promise<void> {
    const stores = await Store.find({ chainId }).lean();
    for (const s of stores) {
      this.addStore({
        storeId: s.storeId,
        store: s.address,
        aicToken: s.aicToken,
        licenseToken: s.licenseToken,
        governance: s.governance,
        dividendDistributor: s.dividendDistributor,
      });
    }

    if (stores.length === 0) {
      const events = await ChainEvent.find({ chainId, eventName: "StoreRegistered" }).lean();
      for (const e of events) {
        const a = e.args as Record<string, string>;
        this.addStore({
          storeId: a.storeId,
          store: a.store,
          aicToken: a.aicToken,
          licenseToken: a.licenseToken,
          governance: a.governance,
          dividendDistributor: a.dividendDistributor,
        });
      }
    }

    /*
     * Re-learn every DEX pair a market has already listed into.
     *
     * Without this a restart stops recording post-transition trades: the pair is not part of any
     * store record, so nothing else would put it back in the watch set, and the price series
     * would simply stop at the restart with no error anywhere.
     */
    const listed = await StockMarket.find({ chainId, pair: { $nin: [null, ""] } })
      .select({ pair: 1, storeId: 1 })
      .lean();
    for (const market of listed) {
      if (market.pair) this.addPair(market.pair, market.storeId);
    }
  }
}
