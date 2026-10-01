/**
 * Service fundamentals: facts, never a score.
 *
 * Calls and customers come from the gateway's call records; money comes only from purchases the
 * indexer read from chain (CommerceSettled), with the buyback burn read from the same transaction.
 * A call by the store's own controller is counted apart (`selfCalls`, `selfCommerceUSDC`) and never as a
 * customer, so a controller cannot manufacture a customer base by calling itself.
 */
import { BuyerSignalDoc, License, Purchase, ServiceCall, ServiceCredit } from "../db/models";
import { amountUSDC, amountAIC } from "../config/units";

const HOUR = 3600;
const WINDOWS = { "1h": HOUR, "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR } as const;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

/**
 * @param productIds the service products to measure (one service, or every service of a store)
 * @param controller the store's current controller: its calls and purchases are shown apart
 */
export async function serviceMetrics(
  chainId: number,
  storeId: string,
  productIds: string[],
  controller: string | null,
  pricePerCallUSDC: string | null = null
) {
  const self = (controller ?? "").toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const since = (seconds: number) => new Date(Date.now() - seconds * 1000);

  const calls = await ServiceCall.find({ chainId, storeId, productId: { $in: productIds }, state: { $in: ["SUCCEEDED", "FAILED"] } })
    .select({ caller: 1, state: 1, selfCall: 1, latencyMs: 1, createdAt: 1 })
    .lean();
  // Self is decided when it happened: the controller of that moment, not whoever controls the store now.
  const customerCalls = calls.filter((c) => !c.selfCall);
  const succeeded = customerCalls.filter((c) => c.state === "SUCCEEDED");
  const inWindow = (list: typeof calls, seconds: number) => list.filter((c) => new Date(c.createdAt).getTime() >= since(seconds).getTime());

  const perCustomer = new Map<string, number>();
  for (const c of succeeded) perCustomer.set(c.caller, (perCustomer.get(c.caller) ?? 0) + 1);
  const uniqueIn = (seconds: number) => new Set(inWindow(succeeded, seconds).map((c) => c.caller)).size;
  const repeat = [...perCustomer.values()].filter((n) => n >= 2).length;

  const latencies = succeeded
    .filter((c) => new Date(c.createdAt).getTime() >= since(WINDOWS["30d"]).getTime() && typeof c.latencyMs === "number")
    .map((c) => c.latencyMs as number)
    .sort((a, b) => a - b);

  const purchases = await Purchase.find({ chainId, storeId, productId: { $in: productIds } })
    .select({ buyer: 1, grossUSDC: 1, holderReserveUSDC: 1, buybackBurnedAIC: 1, units: 1, at: 1, buyerWasController: 1 })
    .lean();
  const sum = (list: typeof purchases, key: "grossUSDC" | "holderReserveUSDC" | "buybackBurnedAIC") =>
    list.reduce((t, p) => t + BigInt((p[key] as string | undefined) ?? "0"), 0n);
  const customerPurchases = purchases.filter((p) => !p.buyerWasController);
  const selfPurchases = purchases.filter((p) => p.buyerWasController);
  const windowed = (seconds: number) => customerPurchases.filter((p) => Number(p.at) >= nowSec - seconds);
  const gross = sum(customerPurchases, "grossUSDC");
  const paidCustomers = new Set(customerPurchases.map((p) => p.buyer)).size;
  const paidCallsBought = customerPurchases.reduce((t, p) => t + Number(p.units ?? 0), 0);

  const credits = await ServiceCredit.find({ chainId, storeId, productId: { $in: productIds } }).lean();
  const outstanding = credits
    .filter((c) => c.caller !== self)
    .reduce((t, c) => t + Math.max(Number(c.purchased) - Number(c.consumed), 0), 0);

  const signals = await BuyerSignalDoc.find({ chainId, storeId, productId: { $in: productIds } })
    .select({ worthIt: 1, signaller: 1, sellerWallet: 1 })
    .lean();
  const external = signals.filter((s) => s.signaller !== s.sellerWallet);
  const licenses = await License.countDocuments({ chainId, storeId, productId: { $in: productIds } });

  const div = (a: bigint, b: number) => (b > 0 ? amountUSDC(a / BigInt(b)) : null);

  return {
    callsTotal: customerCalls.length,
    calls1h: inWindow(customerCalls, WINDOWS["1h"]).length,
    calls24h: inWindow(customerCalls, WINDOWS["24h"]).length,
    calls7d: inWindow(customerCalls, WINDOWS["7d"]).length,
    calls30d: inWindow(customerCalls, WINDOWS["30d"]).length,
    successfulCalls: succeeded.length,
    failedCalls: customerCalls.length - succeeded.length,
    successRate: customerCalls.length > 0 ? Math.round((succeeded.length / customerCalls.length) * 1000) / 1000 : null,
    paidCallsTotal: succeeded.length,
    paidCalls24h: inWindow(succeeded, WINDOWS["24h"]).length,
    paidCallsBought,
    prepaidCallsOutstanding: outstanding,
    uniqueCustomers: perCustomer.size,
    uniqueCustomers24h: uniqueIn(WINDOWS["24h"]),
    uniqueCustomers30d: uniqueIn(WINDOWS["30d"]),
    payingCustomers: paidCustomers,
    repeatCustomers: repeat,
    repeatCustomerRate: perCustomer.size > 0 ? Math.round((repeat / perCustomer.size) * 1000) / 1000 : null,
    grossCommerceUSDC: amountUSDC(gross),
    commerce1h: amountUSDC(sum(windowed(WINDOWS["1h"]), "grossUSDC")),
    commerce24h: amountUSDC(sum(windowed(WINDOWS["24h"]), "grossUSDC")),
    commerce7d: amountUSDC(sum(windowed(WINDOWS["7d"]), "grossUSDC")),
    commerce30d: amountUSDC(sum(windowed(WINDOWS["30d"]), "grossUSDC")),
    averageRevenuePerCall: div(gross, succeeded.length),
    averageRevenuePerCustomer: div(gross, paidCustomers),
    medianLatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    worthIt: external.filter((s) => s.worthIt).length,
    notWorthIt: external.filter((s) => !s.worthIt).length,
    currentPricePerCall: pricePerCallUSDC ? amountUSDC(BigInt(pricePerCallUSDC)) : null,
    buybackUSDC: amountUSDC(sum(purchases, "holderReserveUSDC")),
    burnedAIC: amountAIC(sum(purchases, "buybackBurnedAIC")),
    licenses,
    selfCalls: calls.length - customerCalls.length,
    selfCommerceUSDC: amountUSDC(sum(selfPurchases, "grossUSDC")),
    howToRead:
      "Facts, not a rating. Calls and customers exclude whoever controlled the store at the time (selfCalls, selfCommerceUSDC). " +
      "Commerce is what the chain settled for this service's prepaid calls; a call spends one only when it succeeds. " +
      "buybackUSDC is the holders' share of that commerce spent buying the store's AIC; burnedAIC is what it burned.",
  };
}

/**
 * Per store, in one pass for a whole list: what the business sells and how its services are used.
 * Facts for the stock views; nothing here is ranked or scored.
 */
export async function businessModelByStore(chainId: number, storeIds: string[], controllers: Map<string, string>) {
  const { Product } = await import("../db/models");
  const products = await Product.find({ chainId, storeId: { $in: storeIds }, canonical: { $ne: false } })
    .select({ storeId: 1, productId: 1, storeType: 1, active: 1, "sellerContent.profile.serviceSpecHash": 1 })
    .lean();
  const out = new Map<string, Record<string, unknown>>();
  const serviceIds = new Map<string, string[]>();
  for (const id of storeIds) out.set(id, { sales: 0, rentals: 0, servicesListed: 0, activeServices: 0 });
  for (const p of products) {
    const row = out.get(p.storeId)!;
    const isService = Boolean((p.sellerContent?.profile as { serviceSpecHash?: string } | undefined)?.serviceSpecHash);
    const mode = p.storeType === "rentals" ? "rentals" : isService ? "servicesListed" : "sales";
    row[mode] = Number(row[mode]) + 1;
    if (isService) {
      if (p.active) row.activeServices = Number(row.activeServices) + 1;
      serviceIds.set(p.storeId, [...(serviceIds.get(p.storeId) ?? []), p.productId]);
    }
  }
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600_000);
  for (const [storeId, ids] of serviceIds) {
    const self = (controllers.get(storeId) ?? "").toLowerCase();
    const calls = await ServiceCall.find({ chainId, storeId, productId: { $in: ids }, state: "SUCCEEDED", selfCall: { $ne: true } })
      .select({ caller: 1, createdAt: 1 })
      .lean();
    const purchases = await Purchase.find({ chainId, storeId, productId: { $in: ids }, buyerWasController: { $ne: true } }).select({ grossUSDC: 1 }).lean();
    const perCaller = new Map<string, number>();
    for (const c of calls) perCaller.set(c.caller, (perCaller.get(c.caller) ?? 0) + 1);
    Object.assign(out.get(storeId)!, {
      serviceCallsTotal: calls.length,
      serviceCalls24h: calls.filter((c) => new Date(c.createdAt) >= dayAgo).length,
      serviceCustomers: perCaller.size,
      serviceCustomers30d: new Set(calls.filter((c) => new Date(c.createdAt) >= monthAgo).map((c) => c.caller)).size,
      serviceRepeatCustomers: [...perCaller.values()].filter((n) => n >= 2).length,
      serviceCommerceUSDC: amountUSDC(purchases.reduce((t, p) => t + BigInt(p.grossUSDC ?? "0"), 0n)),
    });
  }
  return out;
}
