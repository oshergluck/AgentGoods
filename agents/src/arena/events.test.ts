import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactValue, EventLog, MAX_STDOUT_PAYLOAD_BYTES, readEvents, safeLine } from "./events";
import { emitActionEvents, setEventLog } from "./arenaEvents";
import type { RunState } from "./ledger";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-events-"));

test("one compact event is persisted, read back, and the sequence increments", () => {
  const log = new EventLog("run-a", dir);
  const e1 = log.emit("AGENT_ACTION", { action: "hold" }, { agentId: "a01", key: "k1" });
  const e2 = log.emit("AGENT_ACTION", { action: "http" }, { agentId: "a02", key: "k2" });
  assert.equal(e1!.seq, 1);
  assert.equal(e2!.seq, 2);
  const read = readEvents("run-a", undefined, dir);
  assert.equal(read.length, 2);
  assert.equal(read[1]!.payload.action, "http");
});

test("a duplicate key never creates a second event, even after a restart", () => {
  const log = new EventLog("run-b", dir);
  assert.ok(log.emit("PRODUCT_PURCHASED", { priceUSDC: 0.03 }, { key: "chain:0xabc:3" }));
  assert.equal(log.emit("PRODUCT_PURCHASED", { priceUSDC: 0.03 }, { key: "chain:0xabc:3" }), null);
  const reopened = new EventLog("run-b", dir);
  assert.equal(reopened.lastSeq, 1);
  assert.equal(reopened.emit("PRODUCT_PURCHASED", { priceUSDC: 0.03 }, { key: "chain:0xabc:3" }), null);
  assert.equal(reopened.emit("TOKEN_BUY", {}, { key: "t1" })!.seq, 2);
  assert.equal(readEvents("run-b", undefined, dir).length, 2);
});

test("large payloads are fingerprinted, never stored or printed whole", () => {
  const big = "x".repeat(31_426);
  const c = compactValue({ source: big }) as { source: { truncated: boolean; byteLength: number; sha256: string; preview: string } };
  assert.equal(c.source.truncated, true);
  assert.equal(c.source.byteLength, 31_426);
  assert.equal(c.source.sha256.length, 64);
  assert.ok(c.source.preview.length <= 120);
  const line = safeLine("a\nb\n" + big);
  assert.ok(Buffer.byteLength(line) < MAX_STDOUT_PAYLOAD_BYTES);
  assert.doesNotMatch(line, /\n/);
  assert.match(line, /truncated byteLength=31430/);
});

test("purchased content saved, read and run is linked as observable use; a backfill adds nothing twice", () => {
  const log = new EventLog("run-c", dir);
  setEventLog(log);
  const state = { agents: [{ id: "a20", name: "Tara" }], actions: [] } as unknown as RunState;
  const acts = [
    { at: "t1", agentId: "a20", action: "http", ok: true, detail: "POST /api/v1/access/grant -> 201 (1858 chars, full response under lastResponse)", rationale: "collect what I bought" },
    { at: "t2", agentId: "a20", action: "save_file", ok: true, detail: 'saved "purchased-alpha-market.js" (31426 bytes) — the body of your POST /api/v1/access/grant from run minute 12 — to your workspace', rationale: "keep it" },
    { at: "t3", agentId: "a20", action: "read_file", ok: true, detail: 'read "purchased-alpha-market.js" (31426 bytes, full content under lastResponse)', rationale: "" },
    { at: "t4", agentId: "a20", action: "run_code", ok: true, detail: "ran in 25ms -> {}", rationale: "analyse" },
  ];
  acts.forEach((a, i) => emitActionEvents(state, i, a, i === 3 ? { source: "const m = require('./purchased-alpha-market.js'); m.run()" } : {}));
  const n = log.lastSeq;
  acts.forEach((a, i) => emitActionEvents(state, i, a, i === 3 ? { source: "const m = require('./purchased-alpha-market.js'); m.run()" } : {}));
  assert.equal(log.lastSeq, n, "replaying the same actions emitted nothing new");
  const types = readEvents("run-c", undefined, dir).map((e) => e.type);
  assert.ok(types.includes("PRODUCT_DELIVERED"));
  assert.ok(types.includes("PRODUCT_SAVED"));
  assert.equal(types.filter((t) => t === "PRODUCT_USED").length, 2);
  const saved = readEvents("run-c", ["PRODUCT_SAVED"], dir)[0]!;
  assert.equal(saved.payload.artifact, "purchased-alpha-market.js");
  assert.equal(saved.payload.byteLength, 31426);
  setEventLog(null);
});
