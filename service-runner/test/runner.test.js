/**
 * The runner end to end: a real server, real child processes, real QuickJS.
 * Covers the calls that must work and the escapes that must not.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TOKEN = "t".repeat(32);
const PORT = 18_000 + Math.floor(Math.random() * 1000);
let server;

test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), RUNNER_TOKEN: TOKEN, SECRET_THAT_MUST_NOT_LEAK: "hunter2" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("runner did not start")), 10_000);
    server.stdout.on("data", (d) => {
      if (String(d).includes("listening")) {
        clearTimeout(t);
        resolve();
      }
    });
  });
});

test.after(() => server.kill());

async function run(code, input, extra = {}, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${PORT}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ code, input, ...extra }),
  });
  return { status: res.status, body: await res.json() };
}

test("runs the shapes sellers write", async () => {
  const shapes = [
    "function tool(input) { return { sum: input.a + input.b }; }",
    "const tool = (input) => ({ sum: input.a + input.b });",
    "module.exports = (input) => ({ sum: input.a + input.b });",
    "export default function (input) { return { sum: input.a + input.b }; }",
    "(input) => ({ sum: input.a + input.b })",
    "async function run(input) { await null; return { sum: input.a + input.b }; }",
  ];
  for (const code of shapes) {
    const r = await run(code, { a: 2, b: 3 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.output, { sum: 5 }, code);
    assert.equal(r.body.ok, true);
  }
});

test("refuses a wrong token", async () => {
  const r = await run("function tool(){return 1}", null, {}, "x".repeat(32));
  assert.equal(r.status, 401);
});

test("the code sees no host: no process, require, env, fetch or filesystem", async () => {
  const probes = {
    process: "function tool(){ return typeof process; }",
    require: "function tool(){ return typeof require; }",
    fetch: "function tool(){ return typeof fetch; }",
    timers: "function tool(){ return typeof setTimeout; }",
  };
  for (const [name, code] of Object.entries(probes)) {
    const r = await run(code, null);
    assert.equal(r.body.output, "undefined", name);
  }
  const climb = await run(
    "function tool(){ try { return this.constructor.constructor('return typeof process')(); } catch (e) { return 'blocked'; } }",
    null
  );
  assert.notEqual(climb.body.output, "object", "no route to the host process");
  const env = await run("function tool(){ try { return JSON.stringify(globalThis) } catch(e) { return String(e) } }", null);
  assert.equal(JSON.stringify(env.body).includes("hunter2"), false, "no secret reaches the sandbox");
});

test("a runaway loop is stopped by the deadline", async () => {
  const r = await run("function tool(){ while(true){} }", null, { timeoutMs: 500 });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, "TIMEOUT");
});

test("memory is capped", async () => {
  const r = await run("function tool(){ const a=[]; while(true){ a.push({ i: a.length, s: 'x' + a.length }); } }", null, {
    memoryBytes: 8 * 1024 * 1024,
    timeoutMs: 5000,
  });
  assert.equal(r.body.ok, false);
  assert.ok(["MEMORY_LIMIT", "SERVICE_CRASHED", "TIMEOUT"].includes(r.body.code), r.body.code);
});

test("output is capped", async () => {
  const r = await run("function tool(){ return 'x'.repeat(300000); }", null, { maxOutputBytes: 1024 });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, "OUTPUT_TOO_LARGE");
});

test("errors come back as data, never as a crash of the runner", async () => {
  const thrown = await run("function tool(){ throw new Error('bad input'); }", null);
  assert.equal(thrown.body.code, "SERVICE_ERROR");
  assert.match(thrown.body.message, /bad input/);
  const invalid = await run("function tool( {", null);
  assert.equal(invalid.body.code, "CODE_INVALID");
  const none = await run("const x = 1;", null);
  assert.equal(none.body.code, "CODE_INVALID");
  const alive = await run("function tool(){ return 'still up'; }", null);
  assert.equal(alive.body.output, "still up");
});

test("malicious input is only data", async () => {
  const input = { text: "'); process.exit(1); ('", nested: { __proto__: { polluted: true } } };
  const r = await run("function tool(input){ return { text: input.text, polluted: ({}).polluted === true }; }", input);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.output.text, input.text);
  assert.equal(r.body.output.polluted, false);
});
