/**
 * An Agent's own environment variables reach its code as process.env, for both shapes of program
 * the executor runs, and set_env can take the API key the client holds without it being retyped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { ArenaAgent, authShape, expandEnvRefs, withEnv } from "./agent";
import { ARENA_DIR, type AgentRecord, type RunState } from "./ledger";

delete process.env.ARENA_EXECUTOR_BASE;
delete process.env.ARENA_EXECUTOR_MAP;

/** The executor's own rule: try the source as an expression, else as a body; call a returned function. */
async function runLikeTheExecutor(src: string, input: unknown): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (...x: unknown[]) => Promise<unknown>;
  let run;
  try { run = new AsyncFunction("input", "require", "module", "exports", "return (\n" + src + "\n)"); }
  catch { run = new AsyncFunction("input", "require", "module", "exports", src); }
  let value = await run(input, undefined, {}, {});
  if (typeof value === "function") value = await (value as (i: unknown) => unknown)(input);
  return value;
}

test("an expression-shaped program still runs, and sees the variable", async () => {
  delete process.env.AG_TEST_KEY;
  const src = withEnv("(input) => process.env.AG_TEST_KEY + ':' + input.x", { AG_TEST_KEY: "aic_live_abc" });
  assert.equal(await runLikeTheExecutor(src, { x: 7 }), "aic_live_abc:7");
});

test("a statement-bodied program still runs, and sees the variable", async () => {
  delete process.env.AG_TEST_KEY;
  const src = withEnv("const k = process.env.AG_TEST_KEY;\nreturn k.length;", { AG_TEST_KEY: "12345" });
  assert.equal(await runLikeTheExecutor(src, null), 5);
});

test("without variables the source is untouched", () => {
  assert.equal(withEnv("(i) => i", undefined), "(i) => i");
  assert.equal(withEnv("(i) => i", {}), "(i) => i");
});

test("set_env takes the key the client holds, refuses reserved names, and unset_env removes it", async () => {
  const runId = `envtest-${crypto.randomUUID()}`;
  const rec = { id: "e1", name: "T", memory: [], tokensUsed: { input: 0, output: 0 } } as unknown as AgentRecord;
  const state = { runId, agents: [rec], actions: [] } as unknown as RunState;
  const agent: any = new ArenaAgent({
    origin: "https://x.invalid", rpcUrl: "http://127.0.0.1:1", state, record: rec, brain: {} as never, faucet: {} as never,
    archetype: "t", turnSeconds: 1, elapsedMs: () => 0, log: () => undefined,
  });
  agent.manifest = { apiBaseUrl: "https://x.invalid" };
  agent.sdk = { currentApiKey: "aic_live_KEY123", adoptApiKey: () => undefined };
  const act = (action: string, args: Record<string, unknown>) => agent.actResolved({ action, args, rationale: "t" }, args) as Promise<string>;
  try {
    assert.match(await act("set_env", { name: "AGENTGOODS_API_KEY", fromApiKey: true }), /process\.env\.AGENTGOODS_API_KEY/);
    assert.equal(rec.env!.AGENTGOODS_API_KEY, "aic_live_KEY123");
    assert.match(await act("set_env", { name: "PATH", value: "x" }), /reserved/);
    assert.match(await act("set_env", { name: "lower", value: "x" }), /CAPITALS/);
    assert.match(await act("unset_env", { name: "AGENTGOODS_API_KEY" }), /unset/);
    assert.equal(rec.env!.AGENTGOODS_API_KEY, undefined);
  } finally {
    for (const f of [path.join(ARENA_DIR, `${runId}.json`), path.join(ARENA_DIR, `${runId}.json.tmp`)]) {
      try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  }
});

test("http headers expand the agent's own variables, as a shell would", () => {
  const env = { API_KEY: "aic_live_abc123" };
  for (const form of ["Bearer $API_KEY", "Bearer ${API_KEY}", "Bearer {{API_KEY}}", "Bearer process.env.API_KEY"]) {
    const x = expandEnvRefs(form, env);
    assert.equal(x.value, "Bearer aic_live_abc123", form);
    assert.deepEqual(x.used, ["API_KEY"]);
  }
  assert.deepEqual(expandEnvRefs("Bearer $OTHER", env).missing, ["OTHER"]);
  assert.equal(expandEnvRefs("Bearer aic_live_typed", env).value, "Bearer aic_live_typed");
  assert.equal(expandEnvRefs("price $5", env).value, "price $5"); // not a NAME
  assert.equal(authShape("Bearer aic_live_0123456789abcdefXYZ"), "Bearer <28 characters>");
});

test("an http request sends the expanded key, refuses an unset name, and a fromApiKey variable follows a rotation", async () => {
  const runId = `envtest-${crypto.randomUUID()}`;
  const rec = { id: "e2", name: "T", memory: [], tokensUsed: { input: 0, output: 0 } } as unknown as AgentRecord;
  const state = { runId, agents: [rec], actions: [] } as unknown as RunState;
  const agent: any = new ArenaAgent({
    origin: "https://x.invalid", rpcUrl: "http://127.0.0.1:1", state, record: rec, brain: {} as never, faucet: {} as never,
    archetype: "t", turnSeconds: 1, elapsedMs: () => 0, log: () => undefined,
  });
  agent.manifest = { apiBaseUrl: "https://x.invalid" };
  let held = "aic_live_OLDKEY0000000000000";
  agent.sdk = { get currentApiKey() { return held; }, adoptApiKey: (k: string) => { held = k; } };
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    const auth = Object.entries(init.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? "";
    seen.push(auth);
    const body = String(url).endsWith("/api/v1/auth/api-key/rotate")
      ? { apiKey: "aic_live_NEWKEY1111111111111" }
      : auth.startsWith("Bearer aic_") ? { ok: true } : { error: { code: "INVALID_API_KEY", message: "Malformed API key" } };
    const status = "error" in body ? 401 : 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as never;
  const act = (action: string, args: Record<string, unknown>) => agent.actResolved({ action, args, rationale: "t" }, args) as Promise<string>;
  try {
    assert.match(await act("set_env", { name: "API_KEY", fromApiKey: true }), /\$API_KEY in the headers.*follows your key/);
    const ok = await act("http", { method: "GET", path: "/api/v1/me", headers: { Authorization: "Bearer $API_KEY" } });
    assert.equal(seen.at(-1), "Bearer aic_live_OLDKEY0000000000000");
    assert.match(ok, /-> 200.*headers used your \$API_KEY/);
    const refused = await act("http", { method: "GET", path: "/api/v1/me", headers: { Authorization: "Bearer $AGENTGOODS_KEY" } });
    assert.match(refused, /REFUSED before sending.*\$AGENTGOODS_KEY.*set: API_KEY/);
    assert.equal(seen.length, 1, "nothing was sent for the refused request");
    const bad = await act("http", { method: "GET", path: "/api/v1/me", headers: { Authorization: "Bearer <apiKey>" } });
    assert.match(bad, /Authorization header was: `Bearer <apiKey>`/);
    await act("http", { method: "POST", path: "/api/v1/auth/api-key/rotate", body: { nonce: "n", signature: "0x" } });
    assert.equal(rec.env!.API_KEY, "aic_live_NEWKEY1111111111111", "the variable followed the new key");
    await act("http", { method: "GET", path: "/api/v1/me", headers: { Authorization: "Bearer ${API_KEY}" } });
    assert.equal(seen.at(-1), "Bearer aic_live_NEWKEY1111111111111");
  } finally {
    globalThis.fetch = realFetch;
    for (const f of [path.join(ARENA_DIR, `${runId}.json`), path.join(ARENA_DIR, `${runId}.json.tmp`)]) {
      try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  }
});
