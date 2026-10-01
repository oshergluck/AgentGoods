/**
 * Turning what happened into Arena Events (events.ts): from the agents' own action ledger, and from
 * the chain transactions the telemetry has decoded. The same functions serve live emission and the
 * backfill of a run already under way; every event has a stable key, so running them twice is a no-op.
 *
 * Only observable links are recorded. An artifact is tied to a product when the agent saved the body
 * of a content-delivery response under that name; a later use is recorded when the agent read that
 * file, ran code whose source names it, or named it in its own stated reason. Nothing is inferred
 * beyond that — attribution is the report's job, and it may conclude "UNATTRIBUTED".
 */
import { EventLog, sha256, type ArenaEventType } from "./events";
import type { ActionRecord, RunState } from "./ledger";

let current: EventLog | null = null;
export function setEventLog(log: EventLog | null): void {
  current = log;
}
export function eventLog(): EventLog | null {
  return current;
}

const lc = (s: string): string => s.toLowerCase();
const flat = (s: string, n: number): string => s.replace(/\s+/g, " ").slice(0, n);
/** Artifacts known to hold delivered product content, per agent: name → where it came from. */
function artifactsOf(agentId: string, cache: Map<string, Map<string, Record<string, unknown>>>): Map<string, Record<string, unknown>> {
  let m = cache.get(agentId);
  if (!m) {
    m = new Map();
    cache.set(agentId, m);
  }
  return m;
}

const artifactCache = new Map<string, Map<string, Record<string, unknown>>>();

/** Rebuild the artifact registry from events already on disk (after a restart). */
export function loadArtifacts(events: { type: string; agentId?: string; payload: Record<string, unknown> }[]): void {
  for (const e of events) {
    if (e.type !== "PRODUCT_SAVED" || !e.agentId) continue;
    const name = String(e.payload.artifact ?? "");
    if (name) (artifactCache.get(e.agentId) ?? artifactCache.set(e.agentId, new Map()).get(e.agentId)!).set(name, e.payload);
  }
}

export interface ActionContext {
  args?: Record<string, unknown>;
  /** The source of a run_code, when emitting live (the ledger keeps only its result). */
  source?: string;
  runningMinute?: number;
}

/** Every event one ledger action implies. `index` is its position in state.actions (append-only). */
export function emitActionEvents(state: RunState, index: number, rec: ActionRecord, ctx: ActionContext = {}): void {
  const log = current;
  if (!log) return;
  const agent = state.agents.find((a) => a.id === rec.agentId);
  const agentId = rec.agentId;
  const opts = (suffix: string) => ({ agentId, key: `act:${index}:${suffix}`, runningMinute: ctx.runningMinute });
  const emit = (type: ArenaEventType, suffix: string, payload: Record<string, unknown>) =>
    log.emit(type, { at: rec.at, agent: agent?.name, ...payload }, opts(suffix));
  const detail = rec.detail ?? "";
  const rationale = rec.rationale ?? "";

  emit(rec.action === "hold" ? "AGENT_HOLD" : "AGENT_ACTION", "base", {
    action: rec.action,
    ok: rec.ok,
    summary: flat(detail, 160),
    detailBytes: Buffer.byteLength(detail),
    rationale: flat(rationale, 220),
  });
  if (!rec.ok) emit("AGENT_ERROR", "err", { action: rec.action, summary: flat(detail, 200) });

  const artifacts = artifactsOf(agentId, artifactCache);
  const mentions = (text: string): string[] => [...artifacts.keys()].filter((name) => name.length >= 4 && text.includes(name));

  if (rec.action === "http") {
    const m = /^(GET|POST|PUT|PATCH|DELETE) (\S+) -> (\d{3})/.exec(detail);
    if (!m) return;
    const [, method, pathWithQuery, statusText] = m;
    const p = pathWithQuery!.split("?")[0]!;
    const status = Number(statusText);
    const ok2xx = status >= 200 && status < 300;
    const args = ctx.args ?? {};
    const body = (args.body ?? {}) as Record<string, unknown>;
    if (method === "POST" && /^\/api\/v1\/forum/.test(p)) {
      const reply = /\/(replies|reply|comments)\b/.test(p) || Boolean(body.parentId ?? body.replyTo ?? body.threadId);
      emit(reply ? "FORUM_REPLY" : "FORUM_POST", "forum", { path: p, status });
    }
    const purchase = /^\/api\/v1\/stores\/(0x[0-9a-fA-F]{64})\/products\/(0x[0-9a-fA-F]{64})\/purchase/.exec(p);
    if (method === "POST" && purchase) emit("PRODUCT_PURCHASE_INTENT", "intent", { storeId: purchase[1], productId: purchase[2], status });
    if (method === "POST" && /^\/api\/v1\/access\/grant/.test(p)) {
      emit("PRODUCT_DELIVERED", "deliver", { status, licenseToken: body.licenseToken ?? null, licenseId: body.licenseId ?? null });
    }
    if (method === "GET" && /^\/api\/v1\/(access|content)\b/.test(p)) emit("PRODUCT_ACCESSED", "access", { path: p, status });
    const signal = /^\/api\/v1\/licenses\/(0x[0-9a-fA-F]{40})\/(\d+)\/signal/.exec(p);
    if (method === "POST" && signal) emit("PRODUCT_SIGNAL", "signal", { licenseToken: signal[1], licenseId: signal[2], status });
    if (method === "POST" && ok2xx) {
      const intent =
        purchase ? "purchase_product"
        : /^\/api\/v1\/stores\/[^/]+\/products\/[^/]+$/.test(p) && method === "POST" ? "update_product"
        : /^\/api\/v1\/stores\/[^/]+\/products$/.test(p) ? "create_product"
        : /^\/api\/v1\/stores$/.test(p) ? "create_store"
        : /^\/api\/v1\/stocks\/[^/]+\/buy/.test(p) ? "token_buy"
        : /^\/api\/v1\/stocks\/[^/]+\/sell/.test(p) ? "token_sell"
        : /reward|incentive|deposit/.test(p) ? "reward_pool_deposit"
        : /withdraw/.test(p) ? "withdraw"
        : null;
      if (intent) emit("TRANSACTION_PREPARED", "prepared", { intent, path: p, status });
    }
    return;
  }

  if (rec.action === "send_transaction") {
    const hash = /(0x[0-9a-fA-F]{64})/.exec(detail)?.[1] ?? null;
    const block = /in block (\d+)/.exec(detail)?.[1] ?? null;
    const to = typeof (ctx.args?.transaction as Record<string, unknown> | undefined)?.to === "string"
      ? (ctx.args!.transaction as Record<string, unknown>).to : ctx.args?.to ?? null;
    emit("TRANSACTION_SUBMITTED", "submitted", { hash, to });
    if (rec.ok) emit("TRANSACTION_CONFIRMED", "confirmed", { hash, block, to });
    else emit("TRANSACTION_FAILED", "failed", { hash, to, reason: flat(detail, 200) });
    return;
  }

  if (rec.action === "save_file" && rec.ok) {
    const m = /saved "([^"]+)" \((\d+) bytes\)(?: — the body of your ((?:GET|POST|PUT|PATCH|DELETE) (\S+)))?/.exec(detail);
    if (!m) return;
    const [, name, bytes, request, srcPath] = m;
    const fromContent = Boolean(srcPath && /^\/api\/v1\/(access|content|licenses)/.test(srcPath.split("?")[0]!));
    if (fromContent) {
      const payload = { artifact: name, byteLength: Number(bytes), sourceRequest: request };
      artifacts.set(name!, payload);
      emit("PRODUCT_SAVED", "saved", payload);
    } else {
      emit("FILE_SAVED", "saved", { artifact: name, byteLength: Number(bytes), sourceRequest: request ?? null });
    }
    return;
  }

  if (rec.action === "read_file" && rec.ok) {
    const m = /read "([^"]+)" \((\d+) bytes/.exec(detail);
    if (!m) return;
    if (artifacts.has(m[1]!)) emit("PRODUCT_USED", "used", { artifact: m[1], actionType: "read_file", basis: "read the saved artifact" });
    else emit("FILE_READ", "read", { artifact: m[1], byteLength: Number(m[2]) });
    return;
  }

  if (rec.action === "run_code") {
    const ms = /ran in (\d+)ms/.exec(detail)?.[1];
    const source = ctx.source ?? "";
    emit("CODE_RUN", "code", {
      ok: rec.ok,
      ms: ms ? Number(ms) : null,
      ...(source ? { sourceBytes: Buffer.byteLength(source), sourceSha256: sha256(source) } : {}),
      resultBytes: Buffer.byteLength(detail),
    });
    const used = source ? mentions(source) : [];
    for (const name of used) emit("PRODUCT_USED", `used:${name}`, { artifact: name, actionType: "run_code", basis: "the code's source names the artifact" });
    if (!source) for (const name of mentions(rationale)) emit("PRODUCT_USED", `used:${name}`, { artifact: name, actionType: "run_code", basis: "the agent's stated reason names the artifact" });
    return;
  }

  // Any other action whose stated reason names a delivered artifact.
  for (const name of mentions(rationale)) emit("PRODUCT_USED", `used:${name}`, { artifact: name, actionType: rec.action, basis: "the agent's stated reason names the artifact" });
}

/** Credit draws and strategy summaries recorded on the agents. */
export function emitAgentRecordEvents(state: RunState): void {
  const log = current;
  if (!log) return;
  for (const a of state.agents) {
    (a.creditDraws ?? []).forEach((d, i) => {
      const principal = BigInt(d.principalBase);
      const fee = BigInt(d.feeBase);
      log.emit("CREDIT_DRAWN", { at: d.at, agent: a.name, principalUSDC: Number(principal) / 1e6, feeUSDC: Number(fee) / 1e6, txHash: d.txHash ?? null, reason: d.reason }, { agentId: a.id, key: `credit:${a.id}:${i}` });
      log.emit("DEBT_CHANGED", { at: d.at, agent: a.name, kind: "credit_draw", addedUSDC: Number(principal + fee) / 1e6 }, { agentId: a.id, key: `debt:credit:${a.id}:${i}` });
    });
    for (const s of a.strategySummaries ?? []) {
      log.emit("STRATEGY_SUMMARY", { agent: a.name, atMinute: s.atMinute, slot: s.slot, text: s.text }, { agentId: a.id, key: `strategy:${a.id}:${s.slot}`, runningMinute: s.atMinute });
    }
  }
}

/** Economic events read from the decoded chain transactions (telemetry's cache). */
export function emitChainEvents(state: RunState, usdcAddress: string, operatorAddress: string): void {
  const log = current;
  const eco = state.economy;
  if (!log || !eco?.txCache) return;
  const byWallet = new Map(state.agents.map((a) => [lc(a.address), a]));
  const stores = eco.stores ?? {};
  const aicTokens = new Set(Object.values(stores).map((s) => s.aicToken));
  for (const tx of Object.values(eco.txCache)) {
    if (tx.status !== 1) continue;
    const sender = byWallet.get(tx.from);
    const names = new Set(tx.events.map((e) => e.name));
    for (const e of tx.events) {
      const key = `chain:${tx.hash}:${e.logIndex}`;
      const base = { at: new Date(tx.timestamp * 1000).toISOString(), txHash: tx.hash, block: tx.block };
      if (e.name === "CommerceSettled") {
        const buyer = byWallet.get(lc(e.args.buyer!));
        if (!buyer && !stores[e.address]) continue;
        const seller = stores[e.address] ? byWallet.get(stores[e.address]!.creator) : undefined;
        log.emit("PRODUCT_PURCHASED", {
          ...base, buyerWallet: lc(e.args.buyer!), buyerAgent: buyer?.name ?? null, sellerAgent: seller?.name ?? null,
          store: e.address, productId: e.args.productId, licenseId: e.args.licenseId, priceUSDC: Number(e.args.grossUSDC) / 1e6,
        }, { agentId: buyer?.id, key });
      } else if ((e.name === "ProductCreated" || e.name === "ProductUpdated") && stores[e.address]) {
        const owner = byWallet.get(stores[e.address]!.creator);
        log.emit(e.name === "ProductCreated" ? "PRODUCT_CREATED" : "PRODUCT_UPDATED", {
          ...base, store: e.address, productId: e.args.productId, priceUSDC: Number(e.args.priceUSDC) / 1e6,
          ...(e.args.active !== undefined ? { active: e.args.active } : {}),
        }, { agentId: owner?.id, key });
      } else if (e.name === "StoreCreated" && byWallet.has(lc(e.args.creator!))) {
        const owner = byWallet.get(lc(e.args.creator!))!;
        log.emit("STORE_CREATED", { ...base, store: lc(e.args.store!), aicToken: lc(e.args.aicToken!), name: e.args.storeName, symbol: e.args.aicSymbol }, { agentId: owner.id, key });
      } else if (e.name === "RewardPoolFunded" && byWallet.has(lc(e.args.from!))) {
        log.emit("REWARD_POOL_DEPOSIT", { ...base, store: e.address, aic: e.args.amount }, { agentId: byWallet.get(lc(e.args.from!))!.id, key });
      } else if (e.name === "ControllerFeesWithdrawn" && byWallet.has(lc(e.args.controller!))) {
        log.emit("CONTROLLER_FEE_WITHDRAWAL", { ...base, aicToken: e.args.aicToken, usdc: Number(e.args.amount) / 1e6 }, { agentId: byWallet.get(lc(e.args.controller!))!.id, key });
      } else if (e.name === "Transfer" && e.address === lc(usdcAddress) && sender && lc(e.args.from!) === tx.from && lc(e.args.to!) === lc(operatorAddress)) {
        log.emit("DEBT_CHANGED", { ...base, kind: "repayment", repaidUSDC: Number(e.args.value) / 1e6 }, { agentId: sender.id, key });
      }
    }
    // One trade event per trade transaction the agent sent, from its own token movements.
    if (sender && (names.has("TokensPurchased") || names.has("TokensSold") || names.has("Swap")) && !names.has("CommerceSettled") && !names.has("InitialOwnerSeed")) {
      let usdcDelta = 0n;
      const tokenDelta = new Map<string, bigint>();
      for (const e of tx.events) {
        if (e.name !== "Transfer") continue;
        const v = BigInt(e.args.value ?? "0");
        const from = lc(e.args.from!);
        const to = lc(e.args.to!);
        if (e.address === lc(usdcAddress)) usdcDelta += (to === tx.from ? v : 0n) - (from === tx.from ? v : 0n);
        else if (aicTokens.has(e.address) || e.address !== lc(usdcAddress)) {
          tokenDelta.set(e.address, (tokenDelta.get(e.address) ?? 0n) + (to === tx.from ? v : 0n) - (from === tx.from ? v : 0n));
        }
      }
      for (const [token, d] of tokenDelta) {
        if (d === 0n) continue;
        log.emit(d > 0n ? "TOKEN_BUY" : "TOKEN_SELL", {
          at: new Date(tx.timestamp * 1000).toISOString(), txHash: tx.hash, block: tx.block, token,
          tokens: (d > 0n ? d : -d).toString(), usdc: Number(usdcDelta < 0n ? -usdcDelta : usdcDelta) / 1e6,
          ownToken: Object.values(stores).some((s) => s.aicToken === token && s.creator === tx.from),
        }, { agentId: sender.id, key: `trade:${tx.hash}:${token}` });
      }
    }
  }
}

/** Replay the whole run so far into the event log; keys make it safe to run on every start. */
export function backfillEvents(state: RunState, usdcAddress: string, operatorAddress: string): number {
  const before = current?.lastSeq ?? 0;
  state.actions.forEach((rec, i) => emitActionEvents(state, i, rec));
  emitAgentRecordEvents(state);
  emitChainEvents(state, usdcAddress, operatorAddress);
  return (current?.lastSeq ?? 0) - before;
}
