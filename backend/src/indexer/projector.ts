/**
 * Event to projection folding.
 *
 * Every projection in Mongo is a pure function of the canonical event log. That is what makes
 * the mandated reconstruction oracle exact (MASTER_PLAN 0.3): delete the rebuildable
 * collections, replay `chain_events`, and the result is byte-identical. It is also what makes
 * reorg rollback exact — the indexer deletes orphaned events and replays the survivors for the
 * affected entities rather than trying to invert each individual write.
 *
 * Nothing in this file computes, infers or improves a seller declaration, and nothing reads
 * buyer signal state to produce an economic value. [MASTER_PLAN 14A.1, 14A.2, docs/DECISIONS D-011]
 */

import {
  BuyerSignalDoc,
  ChainEvent,
  DividendEpoch,
  AicHolder,
  License,
  Product,
  ProductVersion,
  Proposal,
  Purchase,
  StockMarket,
  StockTrade,
  Store,
  Vote, BuybackBurn } from "../db/models";
import { creationCursor, sortKey } from "../db/sortKey";
import { parseProfile, toStored } from "../content/profile";
import { tokensSavedPerUsdc, tokensSavedPerUsdcKey } from "../config/units";
import type { AddressBook } from "./addressBook";
import { logger } from "../utils/logger";

export interface EventDoc {
  chainId: number;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  txIndex: number;
  logIndex: number;
  address: string;
  contractRole: string;
  eventName: string;
  args: Record<string, unknown>;
  blockTimestamp: number;
  storeId: string | null;
  finality: "pending" | "safe";
}

const ZERO = "0";

/**
 * 1e18 (price scaling) x 1e12 (USDC 6dp -> token 18dp), so `usdcBaseUnits * PRICE_SCALE / tokenBaseUnits`
 * is the 1e18-scaled USDC price of one whole token.
 */
const PRICE_SCALE = 10n ** 30n;
const BASIS = ["UNDECLARED", "ESTIMATED", "MEASURED"] as const;
const STORE_TYPES = ["sales", "rentals"] as const;
const UNLIMITED_INVENTORY = (2n ** 64n - 1n).toString();

function s(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return v === undefined || v === null ? "" : String(v);
}

function n(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  return v === undefined || v === null ? 0 : Number(v);
}

function big(args: Record<string, unknown>, key: string): bigint {
  const v = args[key];
  if (v === undefined || v === null || v === "") return 0n;
  return BigInt(String(v));
}

function lower(args: Record<string, unknown>, key: string): string {
  return s(args, key).toLowerCase();
}

/*
 * ELIGIBILITY IS THE CHAIN'S RULE: an address with code is never eligible (AICoin.isEligible).
 *
 * A holder row used to be created eligible by default and flipped only by EligibilityPurged, which
 * the chain emits for an account that GAINED code after holding. A contract that simply received
 * AIC — a vault, a distributor, a smart-contract wallet — was therefore indexed as eligible and
 * could be shown as the largest holder of a store it can never take over, and could skew every
 * "largest eligible holder" figure. The indexer supplies a code check; results are cached, since an
 * address's code only changes in the purge case the event already covers.
 */
let codeCheck: ((address: string) => Promise<boolean>) | null = null;
const hasCodeCache = new Map<string, boolean>();
export function setCodeCheck(fn: ((address: string) => Promise<boolean>) | null): void {
  codeCheck = fn;
  hasCodeCache.clear();
}
export async function hasCode(address: string): Promise<boolean | null> {
  if (!codeCheck) return null;
  const key = address.toLowerCase();
  const cached = hasCodeCache.get(key);
  if (cached !== undefined) return cached;
  const v = await codeCheck(key);
  hasCodeCache.set(key, v);
  return v;
}

/** Recomputes every market's holderCount as EOA holders only. */
export async function recountEoaHolders(chainId: number): Promise<void> {
  const markets = await StockMarket.find({ chainId }).select({ aicToken: 1 }).lean();
  for (const m of markets) {
    const holders = await AicHolder.countDocuments({
      chainId,
      aicToken: String(m.aicToken).toLowerCase(),
      balance: { $ne: "0" },
      isContract: { $ne: true },
      eligible: { $ne: false },
    });
    await StockMarket.updateOne({ chainId, aicToken: m.aicToken }, { $set: { holderCount: holders } });
  }
}

/** Classifies holder rows never checked for code. Returns how many were contracts. */
export async function repairHolderEligibility(chainId: number): Promise<number> {
  if (!codeCheck) return 0;
  const unchecked = await AicHolder.find({ chainId, codeChecked: { $ne: true } }).select({ holder: 1 }).lean();
  const holders = [...new Set(unchecked.map((h) => String(h.holder)))];
  let contracts = 0;
  for (const holder of holders) {
    const isContract = await hasCode(holder);
    if (isContract === null) return contracts;
    if (isContract) contracts++;
    await AicHolder.updateMany(
      { chainId, holder, codeChecked: { $ne: true } },
      isContract ? { $set: { eligible: false, isContract: true, codeChecked: true } } : { $set: { codeChecked: true } }
    );
  }
  return contracts;
}

/** Applies one canonical event to the read model. Idempotent by construction. */
export async function applyEvent(e: EventDoc, addressBook: AddressBook): Promise<void> {
  try {
    switch (e.contractRole) {
      case "registry":
        return await applyRegistry(e, addressBook);
      case "factory":
        return await applyFactory(e);
      case "agentGoods":
        return await applyAgentGoods(e, addressBook);
      case "store":
        return await applyStore(e);
      case "aic":
        return await applyAic(e);
      case "license":
        return await applyLicense(e);
      case "governance":
        return await applyGovernance(e);
      case "dexPair":
        return await applyDexPair(e, addressBook);
      case "distributor":
        return await applyDistributor(e);
      default:
        return;
    }
  } catch (error) {
    logger.error(
      { err: String(error), event: e.eventName, tx: e.txHash, logIndex: e.logIndex },
      "projection failed"
    );
    throw error;
  }
}

/* ----------------------------------------------------------------- registry */

async function applyRegistry(e: EventDoc, addressBook: AddressBook): Promise<void> {
  const a = e.args;

  if (e.eventName === "StoreRegistered") {
    const storeId = s(a, "storeId");
    const record = {
      storeId,
      store: lower(a, "store"),
      aicToken: lower(a, "aicToken"),
      licenseToken: lower(a, "licenseToken"),
      governance: lower(a, "governance"),
      dividendDistributor: lower(a, "dividendDistributor"),
    };
    addressBook.addStore(record);

    await Store.updateOne(
      { chainId: e.chainId, storeId },
      {
        $set: {
          chainId: e.chainId,
          storeId,
          address: record.store,
          storeType: STORE_TYPES[n(a, "storeType")] ?? "sales",
          storeCreator: lower(a, "storeCreator"),
          aicToken: record.aicToken,
          licenseToken: record.licenseToken,
          governance: record.governance,
          dividendDistributor: record.dividendDistributor,
          factory: lower(a, "factory"),
          factoryVersion: n(a, "factoryVersion"),
          createdBlock: e.blockNumber,
          createdLogIndex: e.logIndex,
          createdTxHash: e.txHash,
          createdAt: e.blockTimestamp,
          cursor: creationCursor(e.blockNumber, e.logIndex, storeId),
          canonical: true,
          indexedBlock: e.blockNumber,
        },
        $setOnInsert: { storeController: lower(a, "storeCreator"), ownershipEpoch: 1 },
      },
      { upsert: true }
    );
    return;
  }

  if (e.eventName === "ControllerChanged") {
    const storeId = s(a, "storeId");
    await Store.updateOne(
      { chainId: e.chainId, storeId },
      {
        $set: {
          storeController: lower(a, "newController"),
          ownershipEpoch: n(a, "ownershipEpoch"),
          indexedBlock: e.blockNumber,
        },
      }
    );
    return;
  }
}

/* ------------------------------------------------------------------ factory */

/**
 * The Registry records canonical provenance; the Factory event additionally carries the
 * human display name, which is UNTRUSTED seller content and is stored as such.
 */
/**
 * The Factory event is the only place the human-facing names appear, so it is where they are
 * folded in. Both names are ERC20/display metadata chosen by the store creator: untrusted
 * content, never an identifier, and never used to resolve an address.
 */
async function applyFactory(e: EventDoc): Promise<void> {
  if (e.eventName === "InitialOwnerSeed") {
    const storeId = s(e.args, "storeId");
    await Store.updateOne(
      { chainId: e.chainId, storeId },
      { $set: { initialOwnerSeedUSDC: big(e.args, "seedUSDC").toString(), initialOwnerSeedAIC: big(e.args, "tokensOut").toString() } }
    );
    // The creation buy is the owner's seed — never independent demand.
    await StockTrade.updateMany(
      { chainId: e.chainId, txHash: e.txHash, aicToken: lower(e.args, "aicToken"), side: "buy" },
      { $set: { ownerSeed: true, byController: true } }
    );
    return;
  }
  if (e.eventName !== "StoreCreated") return;
  const storeId = s(e.args, "storeId");
  if (!storeId) return;

  const aicName = s(e.args, "aicName");
  const aicSymbol = s(e.args, "aicSymbol");
  const aicToken = lower(e.args, "aicToken");

  await Store.updateOne(
    { chainId: e.chainId, storeId },
    {
      $set: {
        "sellerContent.name": s(e.args, "storeName"),
        "sellerContent.tokenName": aicName,
        "sellerContent.tokenSymbol": aicSymbol,
      },
    }
  );

  // The market row may not exist yet (MarketInitialized can land later in the same tx), so
  // MarketInitialized reads these back off the store. Folding both ways keeps the projection
  // order-independent, which is what makes a replay deterministic.
  if (aicToken) {
    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      { $set: { name: aicName, symbol: aicSymbol } }
    );
  }
}

/* ---------------------------------------------------------------- agentGoods */

async function applyAgentGoods(e: EventDoc, addressBook: AddressBook): Promise<void> {
  const a = e.args;
  const aicToken = lower(a, "aicToken");

  if (e.eventName === "MarketInitialized") {
    const storeId = s(a, "storeId");
    const genesis = big(a, "genesisInventory");
    // Names come from the Factory event; see applyFactory for why this is folded both ways.
    const store = await Store.findOne({ chainId: e.chainId, storeId })
      .select({ sellerContent: 1 })
      .lean();
    const sellerContent = (store?.sellerContent ?? {}) as { tokenName?: string; tokenSymbol?: string };
    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      {
        $set: {
          chainId: e.chainId,
          aicToken,
          storeId,
          storeAddress: lower(a, "store"),
          name: sellerContent.tokenName ?? "",
          symbol: sellerContent.tokenSymbol ?? "",
          phase: "bonding_curve",
          genesisSupplyAIC: genesis.toString(),
          // currentSupply == genesis - burned; nothing has burned at initialization.
          currentSupplyAIC: genesis.toString(),
          marketInventoryAIC: genesis.toString(),
          netSoldFromCurveAIC: ZERO,
          netSoldPercentageBps: 0,
          virtualUSDCReserve: big(a, "virtualUSDCReserve").toString(),
          virtualTokenReserve: big(a, "virtualTokenReserve").toString(),
          // The seed this market was created with. Per deployment since configureCurve: never assume 6,000.
          virtualSeedUSDC: big(a, "virtualUSDCReserve").toString(),
          realUSDCReserve: ZERO,
          // The curve quotes a price from the moment it is seeded, so the projection must too.
          // Leaving this at zero until the first trade reported "price 0" for a live market,
          // which is not just cosmetic: an Agent comparing markets would read it as free.
          currentIndexedPrice1e18: (() => {
            const vToken = big(a, "virtualTokenReserve");
            if (vToken === 0n) return ZERO;
            return ((big(a, "virtualUSDCReserve") * PRICE_SCALE) / vToken).toString();
          })(),
          createdBlock: e.blockNumber,
          createdLogIndex: e.logIndex,
          cursor: creationCursor(e.blockNumber, e.logIndex, aicToken),
          lastActivityAt: e.blockTimestamp,
        },
      },
      { upsert: true }
    );
    return;
  }

  if (e.eventName === "TokensPurchased" || e.eventName === "TokensSold") {
    const isBuy = e.eventName === "TokensPurchased";
    const gross = isBuy ? big(a, "grossUSDC") : big(a, "grossUSDC");
    const tokens = isBuy ? big(a, "tokensOut") : big(a, "tokensIn");
    const netSold = big(a, "netSoldFromCurve");
    const virtualUSDC = big(a, "virtualUSDCReserve");
    const virtualToken = big(a, "virtualTokenReserve");
    const market = await StockMarket.findOne({ chainId: e.chainId, aicToken }).lean();
    const genesis = market ? BigInt(market.genesisSupplyAIC) : 0n;
    const traderAddr = lower(a, isBuy ? "buyer" : "seller");
    const owner = market ? await Store.findOne({ chainId: e.chainId, storeId: market.storeId }).select({ storeController: 1 }).lean() : null;
    const byController = Boolean(owner?.storeController && owner.storeController.toLowerCase() === traderAddr);

    await StockTrade.updateOne(
      { chainId: e.chainId, txHash: e.txHash, logIndex: e.logIndex },
      {
        $set: {
          chainId: e.chainId,
          aicToken,
          storeId: market?.storeId ?? "",
          trader: traderAddr,
          side: isBuy ? "buy" : "sell",
          byController,
          venue: "curve",
          grossUSDC: gross.toString(),
          protocolFeeUSDC: big(a, "protocolFeeUSDC").toString(),
          controllerFeeUSDC: big(a, "controllerFeeUSDC").toString(),
          netUSDC: (isBuy ? big(a, "netCurveUSDC") : big(a, "netUSDCOut")).toString(),
          tokensAIC: tokens.toString(),
          // USDC per WHOLE token, scaled by 1e18.
          //   usdc_per_token = (gross / 1e6) / (tokens / 1e18) = gross * 1e12 / tokens
          // so the 1e18-scaled form is gross * 1e30 / tokens. Getting the 1e12 decimal
          // difference between USDC and an 18-decimal token wrong here silently reports a
          // micro-cap price as if it were dollars.
          pricePerToken1e18: tokens > 0n ? ((gross * PRICE_SCALE) / tokens).toString() : ZERO,
          netSoldFromCurveAIC: netSold.toString(),
          // The spot price this trade left behind, so a chart can be continuous without
          // pretending the trader paid it.
          spotPriceAfter1e18: (
            virtualToken > 0n ? (virtualUSDC * PRICE_SCALE) / virtualToken : 0n
          ).toString(),
          blockNumber: e.blockNumber,
          logIndex: e.logIndex,
          txHash: e.txHash,
          at: e.blockTimestamp,
        },
      },
      { upsert: true }
    );

    // Same scaling as pricePerToken1e18, so the spot price and the trade prints agree.
    const price = virtualToken > 0n ? (virtualUSDC * PRICE_SCALE) / virtualToken : 0n;
    const inc = isBuy ? -tokens : tokens;
    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      {
        $set: {
          netSoldFromCurveAIC: netSold.toString(),
          netSoldPercentageBps: genesis > 0n ? Number((netSold * 10_000n) / genesis) : 0,
          virtualUSDCReserve: virtualUSDC.toString(),
          virtualTokenReserve: virtualToken.toString(),
          currentIndexedPrice1e18: price.toString(),
          lastActivityAt: e.blockTimestamp,
        },
        $inc: {},
      }
    );

    // Inventory and real reserve are derived from the same event stream, exactly.
    const current = await StockMarket.findOne({ chainId: e.chainId, aicToken }).lean();
    if (current) {
      const inventory = BigInt(current.marketInventoryAIC) + inc;
      const realDelta = isBuy ? big(a, "netCurveUSDC") : -big(a, "grossUSDC");
      const realReserve = BigInt(current.realUSDCReserve) + realDelta;
      const volume = BigInt(current.lifetimeGrossVolumeUSDC) + gross;
      const controllerFees = BigInt(current.controllerFeesUSDC) + big(a, "controllerFeeUSDC");
      await StockMarket.updateOne(
        { chainId: e.chainId, aicToken },
        {
          $set: {
            marketInventoryAIC: (inventory < 0n ? 0n : inventory).toString(),
            realUSDCReserve: (realReserve < 0n ? 0n : realReserve).toString(),
            lifetimeGrossVolumeUSDC: volume.toString(),
            controllerFeesUSDC: controllerFees.toString(),
          },
        }
      );
    }
    return;
  }

  /*
   * A buyback: the holders' share of a sale bought this store's own AIC and burned it, in the purchase
   * transaction. On the curve it moves the curve exactly like a fee-free buy (the burn itself arrives as
   * MarketBurn, which owns supply and burnedAIC). After graduation the pool's Swap event has already been
   * recorded as a trade in this transaction; it is marked as the buyback it was. Either way it is
   * protocol mechanics funded by commerce, never independent demand.
   */
  if (e.eventName === "BuybackBurned") {
    const usdcIn = big(a, "usdcIn");
    const burned = big(a, "aicBurned");
    const onCurve = Boolean(a.onCurve);
    const store = lower(a, "store");
    const market = await StockMarket.findOne({ chainId: e.chainId, aicToken }).lean();
    if (!market) return;
    const buybackBurned = BigInt(String(market.buybackBurnedAIC ?? "0")) + burned;
    const lifetime = BigInt(String(market.lifetimeBuybackUSDC ?? "0")) + usdcIn;
    if (!onCurve) {
      await StockTrade.updateMany(
        { chainId: e.chainId, txHash: e.txHash, aicToken, venue: "dex", side: "buy" },
        { $set: { buyback: true, trader: store } }
      );
      await StockMarket.updateOne(
        { chainId: e.chainId, aicToken },
        { $set: { buybackBurnedAIC: buybackBurned.toString(), lifetimeBuybackUSDC: lifetime.toString(), pendingBuybackUSDC: ZERO, lastActivityAt: e.blockTimestamp } }
      );
      return;
    }
    const vUSDC = BigInt(market.virtualUSDCReserve) + usdcIn;
    const vToken = BigInt(market.virtualTokenReserve) - burned;
    const netSold = BigInt(market.netSoldFromCurveAIC) + burned;
    const genesis = BigInt(market.genesisSupplyAIC);
    const inventory = BigInt(market.marketInventoryAIC) - burned;
    const price = vToken > 0n ? (vUSDC * PRICE_SCALE) / vToken : 0n;
    await StockTrade.updateOne(
      { chainId: e.chainId, txHash: e.txHash, logIndex: e.logIndex },
      {
        $set: {
          chainId: e.chainId,
          aicToken,
          storeId: market.storeId ?? "",
          trader: store,
          side: "buy",
          buyback: true,
          byController: false,
          venue: "curve",
          grossUSDC: usdcIn.toString(),
          protocolFeeUSDC: ZERO,
          controllerFeeUSDC: ZERO,
          netUSDC: usdcIn.toString(),
          tokensAIC: burned.toString(),
          pricePerToken1e18: burned > 0n ? ((usdcIn * PRICE_SCALE) / burned).toString() : ZERO,
          netSoldFromCurveAIC: netSold.toString(),
          spotPriceAfter1e18: price.toString(),
          blockNumber: e.blockNumber,
          logIndex: e.logIndex,
          txHash: e.txHash,
          at: e.blockTimestamp,
        },
      },
      { upsert: true }
    );
    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      {
        $set: {
          virtualUSDCReserve: vUSDC.toString(),
          virtualTokenReserve: vToken.toString(),
          netSoldFromCurveAIC: netSold.toString(),
          netSoldPercentageBps: genesis > 0n ? Number((netSold * 10_000n) / genesis) : 0,
          marketInventoryAIC: (inventory < 0n ? 0n : inventory).toString(),
          realUSDCReserve: (BigInt(market.realUSDCReserve) + usdcIn).toString(),
          lifetimeGrossVolumeUSDC: (BigInt(market.lifetimeGrossVolumeUSDC) + usdcIn).toString(),
          currentIndexedPrice1e18: price.toString(),
          buybackBurnedAIC: buybackBurned.toString(),
          lifetimeBuybackUSDC: lifetime.toString(),
          lastActivityAt: e.blockTimestamp,
        },
      }
    );
    return;
  }

  if (e.eventName === "BuybackDeferred") {
    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      { $set: { pendingBuybackUSDC: big(a, "pendingUSDC").toString() } }
    );
    return;
  }

  if (e.eventName === "LiquidityTransition") {
    /*
     * Start watching the pool immediately.
     *
     * The curve stops quoting at this instant, so if the pair were not watched the price series
     * would simply end here — a chart that goes flat forever at the most interesting moment in a
     * token's life. Watching the pair means the series continues through the listing and a reader
     * sees the venue change only in the price. The indexer re-scans a range after discovering a
     * new address, so swaps in this very block are picked up rather than missed.
     */
    const market = await StockMarket.findOne({ chainId: e.chainId, aicToken }).select({ storeId: 1 }).lean();
    if (market) addressBook.addPair(lower(a, "pair"), market.storeId);

    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      {
        $set: {
          phase: "external_dex",
          lpCreated: true,
          pair: lower(a, "pair"),
          lpTokenAmount: big(a, "lpTokens").toString(),
          marketInventoryAIC: ZERO,
          realUSDCReserve: ZERO,
          lastActivityAt: e.blockTimestamp,
        },
      }
    );
    return;
  }

  if (e.eventName === "GraduationBurn") {
    /*
     * A blocked market burned inventory so its price and supply land where graduation would have
     * put them, reducing the virtual seed to keep redemption exact.
     *
     * This MUST be projected. The burn happens after TokensPurchased has already been emitted in
     * the same transaction, so the reserves carried by that event are the pre-burn ones. Without
     * this handler the projection would keep serving them, and every price the API published for
     * this market would be wrong from that block onward.
     *
     * Supply and burnedAIC are not touched here: `burnFromMarket` emits MarketBurn, which owns
     * that identity. Folding it in both places would double-count it.
     */
    const market = await StockMarket.findOne({ chainId: e.chainId, aicToken })
      .select({ marketInventoryAIC: 1 })
      .lean();
    const burned = big(a, "tokensBurned");
    const inventory = market ? BigInt(market.marketInventoryAIC) - burned : 0n;

    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      {
        $set: {
          virtualTokenReserve: big(a, "newVirtualTokenReserve").toString(),
          virtualUSDCReserve: big(a, "newVirtualUSDCReserve").toString(),
          virtualSeedUSDC: big(a, "newVirtualSeedUSDC").toString(),
          marketInventoryAIC: maxZero(inventory).toString(),
          burnedAtGraduationBlockedAIC: burned.toString(),
          lastActivityAt: e.blockTimestamp,
        },
      }
    );
    return;
  }

  if (e.eventName === "GraduationBlocked") {
    /*
     * The market reached 30% with a funded external pool already in existence, so it gave up on
     * listing and stays on its bonding curve permanently.
     *
     * Projected as its own flag rather than folded into `phase`, because the phase genuinely is
     * still `bonding_curve` — trading continues in both directions exactly as before. Overloading
     * the phase here would make every consumer that switches on it wrong.
     */
    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      {
        $set: {
          graduationBlocked: true,
          graduationBlockedPair: lower(a, "blockingPair"),
          graduationBlockedAt: e.blockTimestamp,
          lastActivityAt: e.blockTimestamp,
        },
      }
    );
    return;
  }

  if (e.eventName === "ControllerFeesWithdrawn") {
    await StockMarket.updateOne({ chainId: e.chainId, aicToken }, { $set: { controllerFeesUSDC: ZERO } });
  }
}

/* -------------------------------------------------------------------- store */

async function applyStore(e: EventDoc): Promise<void> {
  const a = e.args;
  const storeId = e.storeId;
  if (!storeId) return;

  const store = await Store.findOne({ chainId: e.chainId, storeId }).lean();
  if (!store) return;

  switch (e.eventName) {
    case "ProductCreated":
    case "ProductUpdated": {
      const productId = s(a, "productId");
      const version = n(a, "version");
      const price = big(a, "priceUSDC");
      const inventory = big(a, "inventory");
      const metadataURI = s(a, "metadataURI");

      const isCreate = e.eventName === "ProductCreated";
      const set: Record<string, unknown> = {
        chainId: e.chainId,
        storeId,
        storeAddress: store.address,
        storeType: store.storeType,
        productId,
        version,
        priceUSDC: price.toString(),
        priceUSDCSort: sortKey(price),
        inventory: inventory.toString(),
        unlimitedInventory: inventory.toString() === UNLIMITED_INVENTORY,
        rentalPeriodSeconds: n(a, "rentalPeriodSeconds"),
        active: isCreate ? true : Boolean(a.active),
        contentHash: s(a, "contentHash"),
        "sellerContent.metadataURI": metadataURI,
        // Parsed on the way in, never fetched. Shape-sanitized, meaning untouched.
        "sellerContent.profile": toStored(parseProfile(metadataURI)),
        updatedBlock: e.blockNumber,
        canonical: true,
      };
      if (isCreate) {
        Object.assign(set, {
          createdBlock: e.blockNumber,
          createdLogIndex: e.logIndex,
          createdTxHash: e.txHash,
          createdAt: e.blockTimestamp,
          cursor: creationCursor(e.blockNumber, e.logIndex, productId),
        });
      }

      await Product.updateOne({ chainId: e.chainId, storeId, productId }, { $set: set }, { upsert: true });
      return;
    }

    /**
     * Phase 10.1. The declaration is copied verbatim from chain. The only computed field is
     * the derived comparison figure, which is recomputed here and marked derived in the API.
     */
    case "TokenSavingDeclared": {
      const productId = s(a, "productId");
      const version = n(a, "version");
      const tokensSaved = big(a, "declaredTokensSaved");
      const basis = BASIS[n(a, "basis")] ?? "UNDECLARED";
      const modelTier = decodeBytes32String(s(a, "declaredModelTier"));
      const declaredAt = n(a, "declaredAt");

      const product = await Product.findOne({ chainId: e.chainId, storeId, productId }).lean();
      const price = product ? BigInt(product.priceUSDC) : 0n;

      const declaration = {
        declared: basis !== "UNDECLARED",
        tokensSaved: tokensSaved > 0n ? tokensSaved.toString() : null,
        tokensSavedSort: tokensSaved > 0n ? sortKey(tokensSaved) : null,
        modelTier: modelTier || null,
        basis,
        declaredAt: declaredAt || null,
        tokensSavedPerUsdc: tokensSavedPerUsdc(tokensSaved, price),
        tokensSavedPerUsdcSort: (() => {
          const key = tokensSavedPerUsdcKey(tokensSaved, price);
          return key ? sortKey(key) : null;
        })(),
      };

      await Product.updateOne({ chainId: e.chainId, storeId, productId }, { $set: { declaration } });

      // Append-only history so a historical purchase keeps the claim it was sold under.
      await ProductVersion.updateOne(
        { chainId: e.chainId, storeId, productId, version },
        {
          $set: {
            chainId: e.chainId,
            storeId,
            productId,
            version,
            priceUSDC: price.toString(),
            rentalPeriodSeconds: product?.rentalPeriodSeconds ?? 0,
            contentHash: product?.contentHash ?? null,
            "sellerContent.metadataURI": product?.sellerContent?.metadataURI ?? "",
            "sellerContent.profile": toStored(
              parseProfile(product?.sellerContent?.metadataURI ?? "")
            ),
            declaration,
            blockNumber: e.blockNumber,
            logIndex: e.logIndex,
            txHash: e.txHash,
            at: e.blockTimestamp,
          },
        },
        { upsert: true }
      );
      return;
    }

    /**
     * Untrusted seller display profile. Parsed here so no request ever leaves this process on
     * a seller-controlled URL, and stored alongside the raw string so the projection stays an
     * exact function of chain state. [docs/DECISIONS.md D-017]
     */
    case "StoreProfileUpdated": {
      const raw = s(a, "profile");
      await Store.updateOne(
        { chainId: e.chainId, storeId },
        {
          $set: {
            "sellerContent.profileRaw": raw,
            "sellerContent.profile": toStored(parseProfile(raw)),
          },
        }
      );
      return;
    }

    case "CommerceSettled": {
      const productId = s(a, "productId");
      const kind = store.storeType === "rentals" ? "rental" : "purchase";
      await Purchase.updateOne(
        { chainId: e.chainId, txHash: e.txHash, logIndex: e.logIndex },
        {
          $set: {
            chainId: e.chainId,
            storeId,
            storeAddress: store.address,
            productId,
            productVersion: 0,
            buyer: lower(a, "buyer"),
            licenseId: s(a, "licenseId"),
            kind,
            units: n(a, "units"),
            grossUSDC: big(a, "grossUSDC").toString(),
            protocolFeeUSDC: big(a, "protocolFeeUSDC").toString(),
            netUSDC: big(a, "netUSDC").toString(),
            holderReserveUSDC: big(a, "holderReserveUSDC").toString(),
            ownerAvailableUSDC: big(a, "ownerAvailableUSDC").toString(),
            rewardAIC: big(a, "rewardAIC").toString(),
            buyerWasController: String(store.storeController ?? "").toLowerCase() === lower(a, "buyer"),
            buybackBurnedAIC:
              (
                await BuybackBurn.findOne({ chainId: e.chainId, txHash: e.txHash, storeId, logIndex: { $lt: e.logIndex } })
                  .sort({ logIndex: -1 })
                  .lean()
              )?.burnedAIC ?? "0",
            expiresAt: n(a, "expiresAt"),
            blockNumber: e.blockNumber,
            logIndex: e.logIndex,
            txHash: e.txHash,
            at: e.blockTimestamp,
          },
        },
        { upsert: true }
      );

      const current = await Store.findOne({ chainId: e.chainId, storeId }).lean();
      if (current) {
        await Store.updateOne(
          { chainId: e.chainId, storeId },
          {
            $set: {
              lifetimeGrossCommerceUSDC: (
                BigInt(current.lifetimeGrossCommerceUSDC) + big(a, "grossUSDC")
              ).toString(),
              lifetimeNetCommerceUSDC: (BigInt(current.lifetimeNetCommerceUSDC) + big(a, "netUSDC")).toString(),
              lifetimeProtocolFeeUSDC: (
                BigInt(current.lifetimeProtocolFeeUSDC) + big(a, "protocolFeeUSDC")
              ).toString(),
              lifetimeRewardDistributedAIC: (
                BigInt(current.lifetimeRewardDistributedAIC) + big(a, "rewardAIC")
              ).toString(),
              rewardPoolAIC: maxZero(BigInt(current.rewardPoolAIC) - big(a, "rewardAIC")).toString(),
              indexedBlock: e.blockNumber,
            },
          }
        );
      }

      // Inventory decrements are derivable from the settled units.
      const product = await Product.findOne({ chainId: e.chainId, storeId, productId }).lean();
      if (product && !product.unlimitedInventory) {
        const consumed = store.storeType === "rentals" ? 1n : BigInt(n(a, "units"));
        const remaining = maxZero(BigInt(product.inventory) - consumed);
        await Product.updateOne(
          { chainId: e.chainId, storeId, productId },
          { $set: { inventory: remaining.toString() } }
        );
      }
      return;
    }

    case "BuybackExecuted": {
      const burnRecorded = await BuybackBurn.updateOne(
        { chainId: e.chainId, txHash: e.txHash, logIndex: e.logIndex },
        {
          $setOnInsert: {
            chainId: e.chainId,
            storeId,
            txHash: e.txHash,
            logIndex: e.logIndex,
            usdcIn: big(a, "usdcIn").toString(),
            burnedAIC: big(a, "burned").toString(),
            blockNumber: e.blockNumber,
          },
        },
        { upsert: true }
      );
      const before = await Store.findOne({ chainId: e.chainId, storeId }).select({ lifetimeBuybackBurnedAIC: 1 }).lean();
      // Counted once per event: a replayed event finds its record already there.
      const burnedTotal =
        burnRecorded.upsertedCount > 0
          ? (BigInt(before?.lifetimeBuybackBurnedAIC ?? "0") + big(a, "burned")).toString()
          : String(before?.lifetimeBuybackBurnedAIC ?? "0");
      await Store.updateOne(
        { chainId: e.chainId, storeId },
        {
          $set: {
            lifetimeBuybackUSDC: big(a, "lifetimeBuybackUSDC").toString(),
            lifetimeHolderReserveAccruedUSDC: big(a, "lifetimeBuybackUSDC").toString(),
            lifetimeBuybackBurnedAIC: burnedTotal,
          },
        }
      );
      return;
    }

    case "HolderReserveAccrued":
      await Store.updateOne(
        { chainId: e.chainId, storeId },
        {
          $set: {
            unfinalizedHolderReserveUSDC: big(a, "newUnfinalizedReserve").toString(),
            lifetimeHolderReserveAccruedUSDC: big(a, "lifetimeAccrued").toString(),
          },
        }
      );
      return;

    case "HolderReserveCommitted":
    case "HolderReserveReturned": {
      const current = await Store.findOne({ chainId: e.chainId, storeId }).lean();
      if (!current) return;
      const delta = e.eventName === "HolderReserveCommitted" ? big(a, "amount") : -big(a, "amount");
      await Store.updateOne(
        { chainId: e.chainId, storeId },
        {
          $set: {
            unfinalizedHolderReserveUSDC: big(a, "newUnfinalizedReserve").toString(),
            lifetimeHolderReserveCommittedUSDC: maxZero(
              BigInt(current.lifetimeHolderReserveCommittedUSDC) + delta
            ).toString(),
          },
        }
      );
      return;
    }

    case "OwnerProceedsWithdrawn":
      await Store.updateOne(
        { chainId: e.chainId, storeId },
        {
          $set: {
            ownerAvailableUSDC: big(a, "remainingOwnerAvailable").toString(),
            /*
             * The block timestamp is the same clock the contract compared against when it allowed
             * this withdrawal, so a countdown derived from it agrees with the contract by
             * construction. Using the indexer's own wall clock here would drift from the chain and
             * publish a timer that lets an agent call withdrawOwnerProceeds a few seconds early
             * and be reverted for no reason it could see.
             */
            lastOwnerWithdrawalAt: e.blockTimestamp,
          },
        }
      );
      return;

    case "RewardPoolFunded":
    case "RewardPoolWithdrawn":
      await Store.updateOne(
        { chainId: e.chainId, storeId },
        { $set: { rewardPoolAIC: big(a, "newPool").toString() } }
      );
      return;

    case "ControllerChanged":
      await Store.updateOne(
        { chainId: e.chainId, storeId },
        {
          $set: {
            storeController: lower(a, "newController"),
            ownershipEpoch: n(a, "ownershipEpoch"),
          },
        }
      );
      return;

    case "StoreStatusChanged":
      await Store.updateOne(
        { chainId: e.chainId, storeId },
        { $set: { status: ["active", "paused", "deprecated"][n(a, "newStatus")] ?? "active" } }
      );
      return;

    case "AccessAttestorChanged":
      await Store.updateOne(
        { chainId: e.chainId, storeId },
        { $set: { accessAttestor: lower(a, "newAttestor") || null } }
      );
      return;

    case "GovernanceLockActivated":
    case "GovernanceLockReleased":
      await Store.updateOne(
        { chainId: e.chainId, storeId },
        {
          $set: {
            unresolvedPassedProposalCount: n(a, "unresolvedCount"),
            governanceLockActive: n(a, "unresolvedCount") > 0,
          },
        }
      );
      return;

    default:
      return;
  }
}

/* ---------------------------------------------------------------------- aic */

/* ------------------------------------------------------------------ dexPair */

/**
 * Trading after the 30% transition.
 *
 * The curve closes and the pool opens, and from a reader's point of view nothing should break:
 * the same chart, the same volume series, the same price field, continuing across the boundary.
 * That only works if pool swaps are folded into the SAME `StockTrade` collection the curve wrote
 * to, with the SAME price scaling (docs/DECISIONS.md D-019). Storing them separately, or with a
 * different scale, would put a discontinuity in the chart exactly where a token's history gets
 * interesting.
 *
 * A pool trade is not a protocol trade: no protocol fee, no controller fee, no curve state. Those
 * fields are recorded as zero rather than omitted, so a consumer reading the series does not have
 * to branch on venue to add up volume.
 */
async function applyDexPair(e: EventDoc, addressBook: AddressBook): Promise<void> {
  const a = e.args;
  const pair = e.address;

  const market = await StockMarket.findOne({ chainId: e.chainId, pair }).lean();
  if (!market) return;

  /*
   * UniswapV2 orders a pair's tokens by address, so which side is USDC is a property of the two
   * addresses rather than of anything we chose. Deriving it here — instead of storing it at
   * transition — keeps this correct even for a market whose pair was learned on hydration.
   */
  const usdcAddress = addressBook.usdcAddress().toLowerCase();
  const aicToken = market.aicToken.toLowerCase();
  const usdcIsToken0 = usdcAddress < aicToken;

  if (e.eventName === "Sync") {
    const reserve0 = big(a, "reserve0");
    const reserve1 = big(a, "reserve1");
    const usdcReserve = usdcIsToken0 ? reserve0 : reserve1;
    const tokenReserve = usdcIsToken0 ? reserve1 : reserve0;
    if (tokenReserve === 0n) return;

    await StockMarket.updateOne(
      { chainId: e.chainId, pair },
      {
        $set: {
          // The pool is the price authority now. Same scaling as the curve wrote. [D-019]
          currentIndexedPrice1e18: ((usdcReserve * PRICE_SCALE) / tokenReserve).toString(),
          realUSDCReserve: usdcReserve.toString(),
          lastActivityAt: e.blockTimestamp,
        },
      }
    );
    return;
  }

  if (e.eventName === "Swap") {
    const amount0In = big(a, "amount0In");
    const amount1In = big(a, "amount1In");
    const amount0Out = big(a, "amount0Out");
    const amount1Out = big(a, "amount1Out");

    const usdcIn = usdcIsToken0 ? amount0In : amount1In;
    const usdcOut = usdcIsToken0 ? amount0Out : amount1Out;
    const tokenIn = usdcIsToken0 ? amount1In : amount0In;
    const tokenOut = usdcIsToken0 ? amount1Out : amount0Out;

    // USDC in means someone bought the token; token in means someone sold it.
    const isBuy = usdcIn > 0n;
    const grossUSDC = isBuy ? usdcIn : usdcOut;
    const tokens = isBuy ? tokenOut : tokenIn;
    if (grossUSDC === 0n || tokens === 0n) return;

    await StockTrade.updateOne(
      { chainId: e.chainId, txHash: e.txHash, logIndex: e.logIndex },
      {
        $set: {
          chainId: e.chainId,
          aicToken: market.aicToken,
          storeId: market.storeId,
          trader: lower(a, "to"),
          side: isBuy ? "buy" : "sell",
          venue: "dex",
          grossUSDC: grossUSDC.toString(),
          // A pool trade pays the venue, never this protocol. Zeroed, not omitted, so a consumer
          // can sum the series without branching on where the trade happened.
          protocolFeeUSDC: ZERO,
          controllerFeeUSDC: ZERO,
          netUSDC: grossUSDC.toString(),
          tokensAIC: tokens.toString(),
          pricePerToken1e18: ((grossUSDC * PRICE_SCALE) / tokens).toString(),
          /*
           * A pool swap's spot price after the fact comes from the Sync event that accompanies
           * it, which the market row already records. Leaving this empty is deliberate: the
           * chart falls back to the executed price only when no spot is known, and inventing one
           * from the swap amounts would reintroduce exactly the fee-inflated figure this field
           * exists to keep out of the series.
           */
          spotPriceAfter1e18: "",
          // The curve no longer moves, so its counter is frozen at its final value.
          netSoldFromCurveAIC: market.netSoldFromCurveAIC,
          blockNumber: e.blockNumber,
          logIndex: e.logIndex,
          txHash: e.txHash,
          at: e.blockTimestamp,
        },
      },
      { upsert: true }
    );

    const current = await StockMarket.findOne({ chainId: e.chainId, pair }).lean();
    if (current) {
      await StockMarket.updateOne(
        { chainId: e.chainId, pair },
        {
          $set: {
            lifetimeGrossVolumeUSDC: (BigInt(current.lifetimeGrossVolumeUSDC) + grossUSDC).toString(),
            lastActivityAt: e.blockTimestamp,
          },
        }
      );
    }
    return;
  }
}

async function applyAic(e: EventDoc): Promise<void> {
  const a = e.args;
  const storeId = e.storeId;
  if (!storeId) return;
  const aicToken = e.address;

  if (e.eventName === "Transfer") {
    const from = lower(a, "from");
    const to = lower(a, "to");
    const value = big(a, "value");
    for (const [holder, delta] of [
      [from, -value],
      [to, value],
    ] as [string, bigint][]) {
      if (holder === "0x0000000000000000000000000000000000000000") continue;
      const current = await AicHolder.findOne({ chainId: e.chainId, aicToken, holder }).lean();
      const balance = maxZero((current ? BigInt(current.balance) : 0n) + delta);
      const eligibility: Record<string, unknown> = {};
      if (!current || current.codeChecked !== true) {
        const isContract = await hasCode(holder);
        if (isContract !== null) {
          eligibility.codeChecked = true;
          if (isContract) Object.assign(eligibility, { eligible: false, isContract: true });
        }
      }
      await AicHolder.updateOne(
        { chainId: e.chainId, aicToken, holder },
        {
          $set: {
            chainId: e.chainId,
            aicToken,
            storeId,
            holder,
            balance: balance.toString(),
            balanceSort: sortKey(balance),
            lastUpdatedBlock: e.blockNumber,
            ...eligibility,
          },
        },
        { upsert: true }
      );
    }

    /*
     * Supply is NOT folded from mint/burn transfers here, and that is deliberate.
     *
     * AICoin mints exactly once, at clone initialization, and the only other supply change is
     * `marketBurn`. So `currentSupply == genesisSupply - burned` exactly, which is order
     * independent. Folding the genesis mint incrementally is not: the mint Transfer, the
     * MarketInitialized event and the Factory StoreCreated event all land in the same
     * transaction, and the aic token only becomes a watched address once StoreCreated has been
     * seen, so the mint is necessarily projected in a LATER discovery pass than the market row
     * it would increment. That combination counted the genesis supply twice.
     *
     * The derived identity is applied at MarketInitialized and at MarketBurn.
     */

    // Holders are EOAs only: the curve, a store's reward pool, a DEX pair or any other contract can
    // hold the token but is not a holder in any sense a reader means.
    const holders = await AicHolder.countDocuments({
      chainId: e.chainId,
      aicToken,
      balance: { $ne: ZERO },
      isContract: { $ne: true },
      eligible: { $ne: false },
    });
    await StockMarket.updateOne({ chainId: e.chainId, aicToken }, { $set: { holderCount: holders } });
    return;
  }

  if (e.eventName === "MarketBurn") {
    const market = await StockMarket.findOne({ chainId: e.chainId, aicToken }).lean();
    if (market) {
      const burned = BigInt(market.burnedAIC) + big(a, "amount");
      await StockMarket.updateOne(
        { chainId: e.chainId, aicToken },
        {
          $set: {
            burnedAIC: burned.toString(),
            // The only supply-reducing path, so the identity holds exactly. [see applyAic]
            currentSupplyAIC: maxZero(BigInt(market.genesisSupplyAIC) - burned).toString(),
          },
        }
      );
    }
    return;
  }

  /*
   * Takeover lifecycle.
   *
   * Projected purely so the store's CURRENT controller can find out in time. A candidacy cannot be
   * finalized for an hour of chain time, and the controller can defend within it — see
   * `STORE_TAKEOVER_IN_PROGRESS` in /api/v1/me. Notice that nobody receives is not notice.
   */
  if (e.eventName === "TakeoverCandidacyOpened") {
    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      {
        $set: {
          takeoverCandidate: lower(a, "candidate"),
          takeoverOpenedAt: Number(big(a, "openedAt")),
          takeoverLockedBalance: big(a, "lockedBalance").toString(),
          lastActivityAt: e.blockTimestamp,
        },
      }
    );
    return;
  }

  if (e.eventName === "TakeoverCandidacyCancelled" || e.eventName === "TakeoverFinalized") {
    // Either way the candidacy is over: cancelled by the candidate, or consumed by finalization.
    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      {
        $set: {
          takeoverCandidate: null,
          takeoverOpenedAt: 0,
          takeoverLockedBalance: ZERO,
          lastActivityAt: e.blockTimestamp,
        },
      }
    );
    return;
  }

  if (e.eventName === "LeaderChanged") {
    /*
     * `since` is what makes a takeover possible at all: finalization requires leadership held
     * CONTINUOUSLY from before the candidacy opened, and this value resets whenever the leading
     * address changes. A controller who overtakes a candidate therefore destroys that candidacy
     * outright, which is the whole defence.
     */
    await StockMarket.updateOne(
      { chainId: e.chainId, aicToken },
      {
        $set: {
          currentLeader: lower(a, "newLeader"),
          currentLeaderSince: Number(big(a, "since")),
          lastActivityAt: e.blockTimestamp,
        },
      }
    );
    return;
  }

  if (e.eventName === "EligibilityPurged") {
    await AicHolder.updateOne(
      { chainId: e.chainId, aicToken, holder: lower(a, "account") },
      { $set: { eligible: false, isContract: true } }
    );
  }
}

/* ------------------------------------------------------------------ license */

async function applyLicense(e: EventDoc): Promise<void> {
  const a = e.args;
  const storeId = e.storeId;
  if (!storeId) return;
  const licenseToken = e.address;

  if (e.eventName === "LicenseIssued") {
    const tokenId = s(a, "tokenId");
    await License.updateOne(
      { chainId: e.chainId, licenseToken, tokenId },
      {
        $set: {
          chainId: e.chainId,
          storeId,
          licenseToken,
          tokenId,
          owner: lower(a, "to"),
          productId: s(a, "productId"),
          productVersion: n(a, "productVersion"),
          kind: n(a, "kind") === 1 ? "rental" : "permanent",
          quantity: n(a, "quantity"),
          issuedAt: e.blockTimestamp,
          expiresAt: n(a, "expiresAt"),
          permissionHash: s(a, "permissionHash"),
          blockNumber: e.blockNumber,
          logIndex: e.logIndex,
          txHash: e.txHash,
          cursor: creationCursor(e.blockNumber, e.logIndex, tokenId),
        },
      },
      { upsert: true }
    );

    await Purchase.updateOne(
      { chainId: e.chainId, txHash: e.txHash, licenseId: tokenId },
      { $set: { productVersion: n(a, "productVersion") } }
    );
    return;
  }

  /** Phase 10.1 delivery record: the `delivered` denominator of coverage. */
  if (e.eventName === "AccessGranted") {
    const licenseId = s(a, "licenseId");
    const grantCount = n(a, "grantCount");
    const grantedAt = n(a, "grantedAt");
    await License.updateOne(
      { chainId: e.chainId, licenseToken, tokenId: licenseId },
      {
        $set: {
          accessGrantCount: grantCount,
          lastAccessAt: grantedAt,
          delivered: grantCount > 0,
        },
        $min: { firstAccessAt: grantedAt },
      }
    );
    // $min on a null field leaves null in some drivers; set it explicitly on the first grant.
    if (grantCount === 1) {
      await License.updateOne(
        { chainId: e.chainId, licenseToken, tokenId: licenseId },
        { $set: { firstAccessAt: grantedAt } }
      );
    }
    return;
  }

  /**
   * Phase 10.1 buyer signal. Recorded as memory only. No aggregate computed here feeds any
   * payout, fee, reward, entitlement or ordering. [docs/DECISIONS D-011]
   */
  if (e.eventName === "BuyerSignalSubmitted") {
    // The licence carries the version that was actually purchased.
    const licenseDoc = await License.findOne({
      chainId: e.chainId,
      licenseToken,
      tokenId: s(a, "licenseId"),
    })
      .select({ productVersion: 1 })
      .lean();
    const store = await Store.findOne({ chainId: e.chainId, storeId }).lean();
    await BuyerSignalDoc.updateOne(
      { chainId: e.chainId, licenseToken, licenseId: s(a, "licenseId") },
      {
        $set: {
          chainId: e.chainId,
          storeId,
          licenseToken,
          licenseId: s(a, "licenseId"),
          productId: s(a, "productId"),
          sellerWallet: store?.storeController ?? "",
          signaller: lower(a, "signaller"),
          worthIt: Boolean(a.worthIt),
          /*
           * Which version the verdict was about.
           *
           * Recorded here, from the licence, so that a later version can reopen the signal
           * without guessing. Signals written before this field existed carry 0, and 0 is
           * deliberately treated as "unknown" rather than "version zero" by the reopen check —
           * an unknown must never look like an improvement.
           */
          productVersion: Number(licenseDoc?.productVersion ?? 0),
          selfSignal: Boolean(a.selfSignal),
          changed: false,
          signalledAt: n(a, "signalledAt"),
          blockNumber: e.blockNumber,
          logIndex: e.logIndex,
          txHash: e.txHash,
        },
      },
      { upsert: true }
    );
    return;
  }

  if (e.eventName === "BuyerSignalChanged") {
    await BuyerSignalDoc.updateOne(
      { chainId: e.chainId, licenseToken, licenseId: s(a, "licenseId") },
      { $set: { worthIt: Boolean(a.worthIt), changed: true, changedAt: n(a, "changedAt") } }
    );
  }
}

/* --------------------------------------------------------------- governance */

async function applyGovernance(e: EventDoc): Promise<void> {
  const a = e.args;
  const storeId = e.storeId;
  if (!storeId) return;
  const governance = e.address;
  const proposalId = s(a, "proposalId");
  const key = { chainId: e.chainId, governance, proposalId };

  switch (e.eventName) {
    case "ProposalCreated":
      await Proposal.updateOne(
        key,
        {
          $set: {
            chainId: e.chainId,
            storeId,
            governance,
            proposalId,
            proposer: lower(a, "proposer"),
            contentHash: s(a, "contentHash"),
            "sellerContent.descriptionURI": s(a, "descriptionURI"),
            snapshotBlock: n(a, "snapshotBlock"),
            eligibleSupplyAtSnapshot: big(a, "eligibleSupplyAtSnapshot").toString(),
            votingDeadline: n(a, "votingDeadline"),
            state: "ACTIVE",
            createdBlock: e.blockNumber,
            createdLogIndex: e.logIndex,
            cursor: creationCursor(e.blockNumber, e.logIndex, proposalId),
          },
        },
        { upsert: true }
      );
      return;

    case "VoteCast": {
      await Vote.updateOne(
        { ...key, voter: lower(a, "voter") },
        {
          $set: {
            chainId: e.chainId,
            storeId,
            governance,
            proposalId,
            voter: lower(a, "voter"),
            support: Boolean(a.support),
            weight: big(a, "weight").toString(),
            blockNumber: e.blockNumber,
            logIndex: e.logIndex,
            txHash: e.txHash,
          },
        },
        { upsert: true }
      );
      const current = await Proposal.findOne(key).lean();
      if (current) {
        const field = a.support ? "yesPower" : "noPower";
        const value = (BigInt(current[field] as string) + big(a, "weight")).toString();
        await Proposal.updateOne(key, { $set: { [field]: value } });
      }
      return;
    }

    case "ProposalPassed":
      await Proposal.updateOne(key, {
        $set: {
          state: "PASSED_AWAITING_IMPLEMENTATION",
          totalOriginalYesPower: big(a, "totalOriginalYesPower").toString(),
          requiredYesPower: ((big(a, "totalOriginalYesPower") + 1n) / 2n).toString(),
          passedAt: n(a, "passedAtTimestamp"),
          passedAtBlock: n(a, "passedAtBlock"),
        },
      });
      return;

    case "ProposalFailed":
      await Proposal.updateOne(key, { $set: { state: "FAILED" } });
      return;

    case "ProposalCancelled":
      await Proposal.updateOne(key, { $set: { state: "CANCELLED_BEFORE_FIRST_VOTE" } });
      return;

    case "ImplementationMarked":
      await Proposal.updateOne(key, {
        $set: {
          state: "IMPLEMENTED_AWAITING_VERIFICATION",
          implementationRound: n(a, "round"),
          evidenceHash: s(a, "evidenceHash"),
          "sellerContent.evidenceURI": s(a, "evidenceURI"),
          markedImplementedAt: n(a, "markedAt"),
          confirmedYesPower: ZERO,
        },
      });
      return;

    case "ImplementationConfirmed":
      await Proposal.updateOne(key, {
        $set: {
          confirmedYesPower: big(a, "confirmedYesPower").toString(),
          requiredYesPower: big(a, "requiredYesPower").toString(),
        },
      });
      await Vote.updateOne(
        { ...key, voter: lower(a, "voter") },
        { $set: { confirmedRound: n(a, "round"), confirmedAt: e.blockTimestamp } }
      );
      return;

    case "VerificationThresholdReached":
      await Proposal.updateOne(key, {
        $set: { state: "IMPLEMENTATION_VERIFIED", resolvedAt: e.blockTimestamp },
      });
      return;

    default:
      return;
  }
}

/* --------------------------------------------------------------- dividends */

async function applyDistributor(e: EventDoc): Promise<void> {
  const a = e.args;
  const storeId = e.storeId;
  if (!storeId) return;
  const distributor = e.address;
  const epochId = s(a, "epochId");
  const key = { chainId: e.chainId, distributor, epochId };

  switch (e.eventName) {
    case "DistributionOpened": {
      const committed = big(a, "committedReserveUSDC");
      const store = await Store.findOne({ chainId: e.chainId, storeId }).lean();
      // The fee basis is the committed reserve, never additional store commerce. [0.25.E]
      const feeBps = 500n;
      const fee = (committed * feeBps) / 10_000n;
      await DividendEpoch.updateOne(
        key,
        {
          $set: {
            chainId: e.chainId,
            storeId,
            distributor,
            epochId,
            snapshotBlock: n(a, "snapshotBlock"),
            eligibleSupplyAtSnapshot: big(a, "eligibleSupplyAtSnapshot").toString(),
            // MASTER_PLAN 29C: recorded at open so a later parameter change cannot alter an
            // epoch already in flight, and a historical root stays reproducible.
            holdingWindowSeconds: n(a, "holdingWindowSeconds"),
            windowStartBlock: n(a, "windowStartBlock"),
            committedReserveUSDC: committed.toString(),
            processingFeeUSDC: fee.toString(),
            claimableUSDC: (committed - fee).toString(),
            state: "OPEN",
            openedAt: e.blockTimestamp,
            createdBlock: e.blockNumber,
            cursor: creationCursor(e.blockNumber, e.logIndex, epochId),
          },
        },
        { upsert: true }
      );
      void store;
      return;
    }

    case "RootProposed":
      await DividendEpoch.updateOne(key, {
        $set: {
          state: "ROOT_PROPOSED",
          merkleRoot: s(a, "merkleRoot"),
          datasetHash: s(a, "datasetHash"),
          rootTotalUSDC: big(a, "rootTotalUSDC").toString(),
          eligibleMinSupply: big(a, "eligibleMinSupply").toString(),
          rootRevision: n(a, "revision"),
          rootProposedAt: e.blockTimestamp,
          challengeEndsAt: n(a, "challengeEndsAt"),
        },
      });
      return;

    case "RootFinalized":
      await DividendEpoch.updateOne(key, {
        $set: {
          state: "FINALIZED",
          merkleRoot: s(a, "merkleRoot"),
          datasetHash: s(a, "datasetHash"),
          rootTotalUSDC: big(a, "rootTotalUSDC").toString(),
          processingFeeUSDC: big(a, "processingFeeUSDC").toString(),
          claimableUSDC: big(a, "claimableUSDC").toString(),
          finalizedAt: e.blockTimestamp,
        },
      });
      return;

    case "DistributionAbandoned":
      await DividendEpoch.updateOne(key, { $set: { state: "ABANDONED" } });
      return;

    case "Claimed": {
      const current = await DividendEpoch.findOne(key).lean();
      if (current) {
        await DividendEpoch.updateOne(key, {
          $set: { claimedUSDC: big(a, "epochClaimedTotal").toString() },
        });
      }
      const { DividendEntitlement } = await import("../db/models");
      await DividendEntitlement.updateOne(
        { chainId: e.chainId, distributor, epochId, index: n(a, "index") },
        { $set: { claimed: true, claimedAt: e.blockTimestamp, claimTxHash: e.txHash } }
      );
      return;
    }

    default:
      return;
  }
}

/* ----------------------------------------------------------- re-projection */

/**
 * Rebuilds every projection owned by one store by replaying its surviving canonical events.
 * Used after a reorg rollback and by the reconstruction oracle test.
 */
export async function reprojectStore(chainId: number, storeId: string): Promise<void> {
  await Promise.all([
    Product.deleteMany({ chainId, storeId }),
    ProductVersion.deleteMany({ chainId, storeId }),
    License.deleteMany({ chainId, storeId }),
    BuyerSignalDoc.deleteMany({ chainId, storeId }),
    Purchase.deleteMany({ chainId, storeId }),
    Proposal.deleteMany({ chainId, storeId }),
    Vote.deleteMany({ chainId, storeId }),
    DividendEpoch.deleteMany({ chainId, storeId }),
    StockTrade.deleteMany({ chainId, storeId }),
    AicHolder.deleteMany({ chainId, storeId }),
  ]);

  // Reset the store aggregates that are folded from events, keeping identity fields.
  await Store.updateOne(
    { chainId, storeId },
    {
      $set: {
        ownerAvailableUSDC: ZERO,
        unfinalizedHolderReserveUSDC: ZERO,
        lifetimeGrossCommerceUSDC: ZERO,
        lifetimeNetCommerceUSDC: ZERO,
        lifetimeProtocolFeeUSDC: ZERO,
        lifetimeHolderReserveAccruedUSDC: ZERO,
        lifetimeHolderReserveCommittedUSDC: ZERO,
        rewardPoolAIC: ZERO,
        lifetimeRewardDistributedAIC: ZERO,
        unresolvedPassedProposalCount: 0,
        governanceLockActive: false,
      },
    }
  );

  const store = await Store.findOne({ chainId, storeId }).lean();
  if (store) {
    await StockMarket.deleteOne({ chainId, aicToken: store.aicToken });
  }

  const events = await ChainEvent.find({ chainId, storeId })
    .sort({ blockNumber: 1, logIndex: 1 })
    .lean();

  const { AddressBook } = await import("./addressBook");
  void AddressBook;
  for (const e of events) {
    await applyEvent(e as unknown as EventDoc, { addStore: () => undefined } as never);
  }
}

/** Rebuilds core (registry/factory) projections by replaying their events. */
export async function reprojectCore(chainId: number, addressBook: AddressBook): Promise<void> {
  const events = await ChainEvent.find({
    chainId,
    contractRole: { $in: ["registry", "factory", "treasury"] },
  })
    .sort({ blockNumber: 1, logIndex: 1 })
    .lean();

  const seen = new Set<string>();
  for (const e of events) {
    if (e.eventName === "StoreRegistered") seen.add(String((e.args as Record<string, unknown>).storeId));
    await applyEvent(e as unknown as EventDoc, addressBook);
  }

  // Any store whose registration event no longer exists is not canonical any more.
  await Store.deleteMany({ chainId, storeId: { $nin: [...seen] } });
}

/* -------------------------------------------------------------------- utils */

function maxZero(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

/** Decodes a bytes32 short ASCII string, the on-chain form of `declaredModelTier`. */
export function decodeBytes32String(hex: string): string {
  if (!hex || !hex.startsWith("0x")) return "";
  const bytes = Buffer.from(hex.slice(2), "hex");
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}
