/**
 * What the economy built, read from the site's public endpoints at the end of a run.
 *
 * Diagnosis only: this is written into the operator's report and never shown to an agent, scores
 * nothing and rewards nothing. It answers what emerged — sales, rentals or services; how much work
 * stood behind listings; whether services were called, by whom and again; and whether commerce, calls
 * and AIC volume spread across businesses or concentrated in one.
 */

type Json = Record<string, any>;

async function get(base: string, path: string): Promise<Json | null> {
  try {
    const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
    return res.ok ? ((await res.json()) as Json) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number => {
  if (v && typeof v === "object" && "display" in (v as Json)) return Number((v as Json).display) || 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const share = (top: number, total: number) => (total > 0 ? `${Math.round((top / total) * 1000) / 10}%` : "—");

export async function siteTelemetry(apiBaseUrl: string): Promise<string> {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const products: Json[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q = `/api/v1/market/products?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = await get(base, q);
    if (!body) break;
    products.push(...((body.items as Json[]) ?? []));
    cursor = body.pageInfo?.nextCursor ?? null;
    if (!body.pageInfo?.hasMore || !cursor) break;
  }
  const modeOf = (p: Json) => p.mode ?? (p.protocol?.storeType === "rentals" ? "RENTAL" : "SALE");
  const byMode: Record<string, Json[]> = { SALE: [], RENTAL: [], SERVICE: [] };
  for (const p of products) (byMode[modeOf(p)] ??= []).push(p);
  const iters = (list: Json[]) => list.map((p) => Number(p.development?.iterationsTotal ?? 0)).filter((n) => n > 0);

  const services = ((await get(base, "/api/v1/services?limit=100"))?.items as Json[]) ?? [];
  const metrics: { id: string; m: Json }[] = [];
  for (const s of services) {
    const m = await get(base, `/api/v1/services/${s.storeId}/${s.productId}/metrics`);
    if (m) metrics.push({ id: `${s.storeId.slice(0, 10)}…:${s.productId.slice(0, 10)}…`, m });
  }
  const totalCalls = metrics.reduce((t, x) => t + num(x.m.successfulCalls), 0);
  const topCalls = metrics.reduce((t, x) => Math.max(t, num(x.m.successfulCalls)), 0);

  const stocks = ((await get(base, "/api/v1/market/stocks?limit=100&sort=commerce_desc"))?.items as Json[]) ?? [];
  const commerce = stocks.map((s) => num(s.commerce24hUSDC));
  const volume = stocks.map((s) => num(s.volume24hUSDC));
  const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
  const takeovers = ((await get(base, "/api/v1/takeovers"))?.items as Json[]) ?? [];

  const lines: string[] = [];
  lines.push("## What was built: business models, services and concentration (site telemetry)");
  lines.push("");
  lines.push("Read from the site's public endpoints at the end of the run. Diagnosis only: never shown to agents, scores nothing.");
  lines.push("");
  lines.push("| | Sales | Rentals | Services |");
  lines.push("|---|---:|---:|---:|");
  lines.push(`| Listings | ${byMode.SALE!.length} | ${byMode.RENTAL!.length} | ${byMode.SERVICE!.length} |`);
  lines.push(
    `| Median iterations per listing | ${median(iters(byMode.SALE!)) ?? "—"} | ${median(iters(byMode.RENTAL!)) ?? "—"} | ${median(iters(byMode.SERVICE!)) ?? "—"} |`
  );
  lines.push("");
  lines.push("**Services**");
  lines.push("");
  lines.push(`- services listed: ${services.length}`);
  lines.push(`- calls: ${sum(metrics.map((x) => num(x.m.callsTotal)))} (successful, i.e. paid: ${totalCalls}; failed, not charged: ${sum(metrics.map((x) => num(x.m.failedCalls)))})`);
  lines.push(`- calls by controllers of the service's own store (not customers): ${sum(metrics.map((x) => num(x.m.selfCalls)))}`);
  lines.push(`- unique customers (summed per service): ${sum(metrics.map((x) => num(x.m.uniqueCustomers)))}; repeat customers: ${sum(metrics.map((x) => num(x.m.repeatCustomers)))}`);
  lines.push(`- service commerce (customers): ${sum(metrics.map((x) => num(x.m.grossCommerceUSDC))).toFixed(6)} USDC; prepaid calls never used: ${sum(metrics.map((x) => num(x.m.prepaidCallsOutstanding)))}`);
  lines.push(`- buyback from services: ${sum(metrics.map((x) => num(x.m.buybackUSDC))).toFixed(6)} USDC, AIC burned: ${sum(metrics.map((x) => num(x.m.burnedAIC))).toFixed(2)}`);
  if (metrics.length) {
    lines.push("");
    lines.push("| Service | Calls | Successful | Customers | Repeat | Commerce (USDC) | Self calls |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|");
    for (const x of metrics.sort((a, b) => num(b.m.successfulCalls) - num(a.m.successfulCalls)).slice(0, 20)) {
      lines.push(
        `| ${x.id} | ${num(x.m.callsTotal)} | ${num(x.m.successfulCalls)} | ${num(x.m.uniqueCustomers)} | ${num(x.m.repeatCustomers)} | ${num(x.m.grossCommerceUSDC)} | ${num(x.m.selfCalls)} |`
      );
    }
  }
  lines.push("");
  lines.push("**Concentration**");
  lines.push("");
  lines.push(`- commerce generated by the top business: ${share(Math.max(0, ...commerce), sum(commerce))} of ${sum(commerce).toFixed(6)} USDC`);
  lines.push(`- successful calls made to the top service: ${share(topCalls, totalCalls)} of ${totalCalls}`);
  lines.push(`- AIC volume in the top business's token: ${share(Math.max(0, ...volume), sum(volume))} of ${sum(volume).toFixed(2)} USDC`);
  lines.push(`- businesses with any commerce: ${commerce.filter((c) => c > 0).length} of ${stocks.length}`);
  lines.push(`- takeover candidacies open at the end: ${takeovers.length}`);
  lines.push("");
  return lines.join("\n");
}
