/**
 * The Arena Event Log: the authoritative, compact record of an economy run.
 *
 * Railway rate-limits stdout (500 lines a second per replica) and dropped 5,116 messages in Arena 4,
 * because every agent action was printed with its whole detail — source files, JSON bodies — line by
 * line. Stdout is a debugging view and may be lossy. This log is not: it is an append-only JSONL file
 * on the run's own volume, next to the ledger, written synchronously, one compact record per event.
 *
 *  - Ordered: every record carries a monotonically increasing `seq`, recovered from the file on start.
 *  - Idempotent: an event may carry a `key`; a key already in the file is never written again, so a
 *    backfill or a repeated telemetry pass cannot duplicate an economic event.
 *  - Compact: no value larger than a small cap is ever stored. Large strings become
 *    `{truncated, byteLength, sha256, preview}`; nothing like a source file or a body is kept here
 *    (the ledger and the chain remain the full record).
 *  - Durable across restarts, and readable by the report (`readEvents`).
 *
 * It is observability only. Nothing in it is ever shown to an agent or changes what an agent sees.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ARENA_DIR } from "./ledger";

export type ArenaEventType =
  | "AGENT_ACTION" | "AGENT_HOLD" | "AGENT_ERROR"
  | "PRODUCT_CREATED" | "PRODUCT_UPDATED" | "PRODUCT_PURCHASE_INTENT" | "PRODUCT_PURCHASED"
  | "PRODUCT_DELIVERED" | "PRODUCT_ACCESSED" | "PRODUCT_SAVED" | "PRODUCT_USED" | "PRODUCT_SIGNAL"
  | "STORE_CREATED" | "FORUM_POST" | "FORUM_REPLY" | "TOKEN_BUY" | "TOKEN_SELL" | "REWARD_POOL_DEPOSIT"
  | "CREDIT_DRAWN" | "DEBT_CHANGED" | "CONTROLLER_FEE_WITHDRAWAL"
  | "TRANSACTION_PREPARED" | "TRANSACTION_SUBMITTED" | "TRANSACTION_CONFIRMED" | "TRANSACTION_FAILED"
  | "STRATEGY_SUMMARY" | "FILE_SAVED" | "FILE_READ" | "CODE_RUN"
  | "RUN_PAUSED" | "RUN_RESUMED" | "TELEMETRY_GAP" | "CONTINUITY_CHECK" | "EVENT_LOG_OPENED";

export interface ArenaEvent {
  seq: number;
  runId: string;
  timestamp: string;
  runningMinute?: number;
  agentId?: string;
  type: ArenaEventType;
  key?: string;
  payload: Record<string, unknown>;
}

/** Largest string kept verbatim in an event, and the preview kept of anything larger. */
export const MAX_EVENT_STRING = 400;
const PREVIEW = 120;

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** A value made safe to persist or print: long strings become a fingerprint with a short preview. */
export function compactValue(value: unknown, max = MAX_EVENT_STRING, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= max) return value;
    return { truncated: true, byteLength: Buffer.byteLength(value), sha256: sha256(value), preview: value.slice(0, PREVIEW) };
  }
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) {
    const s = JSON.stringify(value);
    return s.length <= max ? value : { truncated: true, byteLength: Buffer.byteLength(s), sha256: sha256(s), preview: s.slice(0, PREVIEW) };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((v) => compactValue(v, max, depth + 1));
    return value.length > 20 ? [...items, { truncatedItems: value.length - 20 }] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = compactValue(v, max, depth + 1);
  return out;
}

export class EventLog {
  readonly file: string;
  private seq = 0;
  private readonly keys = new Set<string>();

  constructor(readonly runId: string, dir = ARENA_DIR) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${runId}-events.jsonl`);
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as ArenaEvent;
          if (e.seq > this.seq) this.seq = e.seq;
          if (e.key) this.keys.add(e.key);
        } catch {
          /* a torn last line from a hard kill is skipped, never fatal */
        }
      }
    }
  }

  get lastSeq(): number {
    return this.seq;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Append one event. Returns the record, or null when its key was already recorded. */
  emit(type: ArenaEventType, payload: Record<string, unknown>, opts: { agentId?: string; key?: string; runningMinute?: number } = {}): ArenaEvent | null {
    if (opts.key && this.keys.has(opts.key)) return null;
    const event: ArenaEvent = {
      seq: this.seq + 1,
      runId: this.runId,
      timestamp: new Date().toISOString(),
      ...(opts.runningMinute !== undefined ? { runningMinute: opts.runningMinute } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      type,
      ...(opts.key ? { key: opts.key } : {}),
      payload: compactValue(payload) as Record<string, unknown>,
    };
    fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
    this.seq = event.seq;
    if (opts.key) this.keys.add(opts.key);
    return event;
  }
}

/** Read a run's events (optionally only some types). */
export function readEvents(runId: string, types?: ArenaEventType[], dir = ARENA_DIR): ArenaEvent[] {
  const file = path.join(dir, `${runId}-events.jsonl`);
  if (!fs.existsSync(file)) return [];
  const want = types ? new Set(types) : null;
  const out: ArenaEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as ArenaEvent;
      if (!want || want.has(e.type)) out.push(e);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ stdout */

/** Largest line ever printed to stdout, whatever it carries. Debug mode raises what is shown, never past this. */
export const MAX_STDOUT_PAYLOAD_BYTES = 4096;

/**
 * One stdout line, safe for a rate-limited log sink: newlines flattened (Railway counts every line as a
 * message), and anything past the cap replaced by its size and hash.
 */
export function safeLine(text: string, max = MAX_STDOUT_PAYLOAD_BYTES): string {
  const flat = text.replace(/\r?\n/g, " ⏎ ");
  if (Buffer.byteLength(flat) <= max) return flat;
  return `${flat.slice(0, Math.min(300, max))} …[truncated byteLength=${Buffer.byteLength(text)} sha256=${sha256(text).slice(0, 16)}]`;
}
