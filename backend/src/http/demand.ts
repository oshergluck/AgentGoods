/**
 * Recording demand the site did not meet — fire and forget, never in the request's way.
 *
 * Only the route template or the search text is kept: no wallet, body, header or key. The records expire
 * after a week (DemandSignal's TTL) and are published in aggregate at /api/v1/market/unmet-demand.
 */
import type { Request } from "express";
import { DemandSignal } from "../db/models";

/** Ids and addresses collapse to placeholders, so one route is one key however it was called. */
export function routeKey(req: Request): string {
  const path = ((req.baseUrl ?? "") + ((req.route as { path?: string } | undefined)?.path ?? req.path ?? "")).split("?")[0] ?? "";
  const templ = path
    .replace(/0x[0-9a-fA-F]{8,}/g, "{id}")
    .replace(/\btxi_[0-9a-f]+/g, "{intentId}")
    .replace(/\b[0-9a-f]{24}\b/g, "{id}")
    .replace(/\/\d+(?=\/|$)/g, "/{n}");
  return `${req.method} ${templ}`.slice(0, 120);
}

function chainOf(req: Request): number | null {
  const id = (req as unknown as { ctx?: { env?: { CHAIN_ID?: number } } }).ctx?.env?.CHAIN_ID;
  return typeof id === "number" ? id : null;
}

export function recordRefusal(req: Request, code: string): void {
  const chainId = chainOf(req);
  if (chainId === null) return;
  void DemandSignal.create({ chainId, kind: "refusal", key: `${routeKey(req)} -> ${code}`.slice(0, 160) }).catch(() => undefined);
}

export function recordSearchMiss(chainId: number, query: string): void {
  const key = String(query ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  if (key.length < 2) return;
  void DemandSignal.create({ chainId, kind: "search_miss", key }).catch(() => undefined);
}
