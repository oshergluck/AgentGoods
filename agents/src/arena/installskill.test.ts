/**
 * An Agent can install a document it fetched itself as a skill, and it is then loaded into the
 * model's fixed instructions on every turn — the way a model loads a skill — and the input served
 * from the provider's cache is charged at the cached rate, as the provider bills it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { ArenaAgent } from "./agent";
import { Brain } from "./brain";
import { ARENA_DIR, inferenceCostBase, chargeTokens, type AgentRecord, type RunState } from "./ledger";

delete process.env.ARENA_EXECUTOR_BASE;
delete process.env.ARENA_EXECUTOR_MAP;

const SKILL = "---\nname: agentgoods\ndescription: the marketplace\n---\n# AgentGoods\nHow to trade here.\n";

function makeAgent() {
  const runId = `installskill-${crypto.randomUUID()}`;
  const id = `is-${crypto.randomUUID().slice(0, 8)}`;
  const rec = { id, name: "Tester", memory: [], tokensUsed: { input: 0, output: 0 } } as unknown as AgentRecord;
  const state = { runId, agents: [rec], actions: [] } as unknown as RunState;
  const agent: any = new ArenaAgent({
    origin: "https://example.invalid", rpcUrl: "http://127.0.0.1:1", state, record: rec,
    brain: {} as never, faucet: {} as never, archetype: "test", turnSeconds: 1,
    elapsedMs: () => 5 * 60_000, log: () => undefined,
  });
  agent.manifest = { apiBaseUrl: "https://example.invalid" };
  agent.sdk = { currentApiKey: "", adoptApiKey: () => undefined };
  const cleanup = () => {
    for (const f of [path.join(ARENA_DIR, `${runId}.json`), path.join(ARENA_DIR, `${runId}.json.tmp`)]) {
      try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  };
  return { agent, rec, cleanup };
}
const act = (agent: any, action: string, args: Record<string, unknown>) =>
  agent.actResolved({ action, args, rationale: "test" }, args) as Promise<string>;

test("nothing is installed until the agent fetches a document and asks", async () => {
  const { agent, rec, cleanup } = makeAgent();
  try {
    assert.match(await act(agent, "install_skill", { name: "agentgoods" }), /REFUSED/);
    assert.equal(rec.installedSkills, undefined);
  } finally { cleanup(); }
});

test("GET /skill -> install_skill -> the skill is recorded, replaceable and removable", async () => {
  const { agent, rec, cleanup } = makeAgent();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SKILL, { status: 200 })) as typeof fetch;
  try {
    await act(agent, "http", { method: "GET", path: "/skill" });
    const out = await act(agent, "install_skill", { name: "agentgoods" });
    assert.match(out, /installed skill "agentgoods"/, out);
    assert.equal(rec.installedSkills!.length, 1);
    assert.equal(rec.installedSkills![0]!.content, SKILL);
    assert.equal(rec.installedSkills![0]!.source, "https://example.invalid/skill");
    await act(agent, "http", { method: "GET", path: "/skill" });
    await act(agent, "install_skill", { name: "agentgoods" });
    assert.equal(rec.installedSkills!.length, 1, "installing under the same name replaces it");
    assert.match(await act(agent, "uninstall_skill", { name: "agentgoods" }), /uninstalled/);
    assert.equal(rec.installedSkills!.length, 0);
  } finally { globalThis.fetch = realFetch; cleanup(); }
});

test("an installed skill is sent to the model in the fixed instructions, before the observation", async () => {
  const realFetch = globalThis.fetch;
  let sent: any = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ action: "hold", args: {}, rationale: "x" }) } }],
      usage: { prompt_tokens: 12000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 11000 } },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const brain = new Brain({ apiKey: "k", maxOutputTokens: 1000, log: () => undefined });
    const d = await brain.decide({ turn: 1 }, "hint", "gpt-6-luna", undefined, [
      { name: "agentgoods", source: "https://example.invalid/skill", fetchedAt: null, content: SKILL },
    ]);
    const roles = sent.messages.map((m: any) => m.role);
    const idx = sent.messages.findIndex((m: any) => String(m.content).includes("SKILLS YOU INSTALLED"));
    assert.ok(idx > 0, "a system message carries the skill");
    assert.equal(sent.messages[idx].role, "system");
    assert.ok(idx < roles.lastIndexOf("user"), "before the observation, so it is part of the stable prefix");
    assert.ok(String(sent.messages[idx].content).includes("How to trade here."));
    assert.equal(d.usage!.cachedInput, 11000, "cached tokens are read from the response");
  } finally { globalThis.fetch = realFetch; }
});

test("cached input is charged at the cached rate", () => {
  const rec = { id: "a", model: "gpt-6-luna", tokenPrice: { input: 0.1, output: 0.5 }, tokensUsed: { input: 0, output: 0 } } as unknown as AgentRecord;
  const state = { agents: [rec] } as unknown as RunState;
  chargeTokens(state, "a", 1_000_000, 0, 900_000);
  // 100,000 uncached at $0.10/M + 900,000 cached at $0.01/M = $0.019
  assert.equal(inferenceCostBase(rec), 19_000n);
  const uncached = { ...rec, tokensUsed: { input: 1_000_000, output: 0 } } as AgentRecord;
  assert.equal(inferenceCostBase(uncached), 100_000n, "without cache the full rate applies");
});
