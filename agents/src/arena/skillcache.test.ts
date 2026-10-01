/**
 * An Agent can keep public documentation it fetched itself, and the arena counts how.
 *
 *   fetch once -> optionally persist -> reuse locally
 *
 * Asserted through the real action code with a stubbed network: GET /skill, then
 * save_file {fromLastResponse}, then read_file. Nothing is preloaded, the saved bytes are exactly
 * what arrived, a note records where they came from, and the telemetry separates the remote fetch
 * from the local read. Nothing here touches the site.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { ArenaAgent } from "./agent";
import { ARENA_DIR, type AgentRecord, type RunState } from "./ledger";

delete process.env.ARENA_EXECUTOR_BASE;
delete process.env.ARENA_EXECUTOR_MAP;

const SKILL = "# AgentGoods skill\n\nThe protocol, as one file.\n";

function makeAgent(): { agent: any; rec: AgentRecord; cleanup: () => void } {
  const runId = `skillcache-${crypto.randomUUID()}`;
  const id = `sc-${crypto.randomUUID().slice(0, 8)}`;
  const rec = { id, name: "Tester", memory: [], tokensUsed: { input: 0, output: 0 } } as unknown as AgentRecord;
  const state = { runId, agents: [rec], actions: [] } as unknown as RunState;
  const agent: any = new ArenaAgent({
    origin: "https://example.invalid",
    rpcUrl: "http://127.0.0.1:1",
    state,
    record: rec,
    brain: {} as never,
    faucet: {} as never,
    archetype: "test",
    turnSeconds: 1,
    elapsedMs: () => 7 * 60_000,
    log: () => undefined,
  });
  agent.manifest = { apiBaseUrl: "https://example.invalid" };
  agent.sdk = { currentApiKey: "", adoptApiKey: () => undefined };
  const cleanup = () => {
    for (const f of [path.join(ARENA_DIR, `${runId}.json`), path.join(ARENA_DIR, `${runId}.json.tmp`)]) {
      try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    }
    try { fs.rmSync(path.join(ARENA_DIR, "sandbox", id), { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(path.join(ARENA_DIR, "workspaces", id), { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { agent, rec, cleanup };
}

const act = (agent: any, action: string, args: Record<string, unknown>) =>
  agent.actResolved({ action, args, rationale: "test" }, args) as Promise<string>;

test("nothing is saved until the agent fetches and asks", async () => {
  const { agent, rec, cleanup } = makeAgent();
  try {
    const refused = await act(agent, "save_file", { name: "skill-cache.md", fromLastResponse: true });
    assert.match(refused, /REFUSED/);
    assert.equal(rec.docMemory, undefined, "no telemetry without any use");
  } finally {
    cleanup();
  }
});

test("GET /skill -> save_file fromLastResponse -> read_file", async () => {
  const { agent, rec, cleanup } = makeAgent();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SKILL, { status: 200 })) as typeof fetch;
  try {
    const fetched = await act(agent, "http", { method: "GET", path: "/skill" });
    assert.match(fetched, /GET \/skill -> 200/);
    assert.equal(rec.docMemory?.skillFetchedFromSite, 1);

    const saved = await act(agent, "save_file", { name: "skill-cache.md", fromLastResponse: true });
    assert.match(saved, /saved "skill-cache\.md"/, saved);
    assert.match(saved, /skill-cache\.md\.source\.json/);
    assert.equal(rec.docMemory?.skillSavedToWorkspace, 1);
    assert.equal(rec.docMemory?.skillCacheBytes, Buffer.byteLength(SKILL));
    assert.deepEqual(rec.docMemory?.skillCacheFiles, ["skill-cache.md"]);

    const read = await act(agent, "read_file", { name: "skill-cache.md" });
    assert.match(read, /read "skill-cache\.md"/);
    assert.equal((rec.lastResponse?.data as string), SKILL, "the bytes are exactly what arrived");
    assert.equal(rec.docMemory?.skillReadFromWorkspace, 1);
    assert.equal(rec.docMemory?.skillFetchedFromSite, 1, "a local read is not a remote fetch");

    await act(agent, "read_file", { name: "skill-cache.md.source.json" });
    const meta = JSON.parse(String(rec.lastResponse?.data));
    assert.equal(meta.source, "https://example.invalid/skill");
    assert.equal(meta.sha256, crypto.createHash("sha256").update(SKILL).digest("hex"));
    assert.equal(meta.fetchedAtRunMinute, 7);

    await act(agent, "save_file", { name: "skill-notes.md", content: "auth: challenge -> issue" });
    assert.equal(rec.docMemory?.skillSummarySaved, 1, "an agent-written summary is counted separately");
  } finally {
    globalThis.fetch = realFetch;
    cleanup();
  }
});
