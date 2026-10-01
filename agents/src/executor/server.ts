/**
 * The executor: one agent's code, in one agent's container, on one agent's volume.
 *
 * WHAT THIS IS. The arena used to run every agent's code inside a `node:vm` context on the
 * operator's machine — no network, no filesystem, no require, twenty agents sharing one process
 * and one disk. That was the right shape for a laptop and the wrong shape for the question: an
 * agent that cannot fetch, install, or keep state across a crash is not being tested as a program,
 * it is being tested as a calculator. This service gives each agent a real Node runtime in a
 * container that is ITS OWN: a full `node` child process, the network, a persistent /data volume,
 * `require` of anything in the image and anything it installs there.
 *
 * WHAT IT IS NOT. It holds no key of any kind. The coordinator — a different service — decides,
 * signs and speaks to the marketplace; this service only runs what it is sent and keeps files. A
 * program here can reach the public internet, including the marketplace's public API, exactly as
 * any stranger can; it cannot reach the coordinator (which requires a token this process never
 * passes to a child), the operator's wallet, or any other agent's container beyond the network
 * any container has.
 *
 * ROUTES, all on the project's private network, all requiring the shared executor token:
 *   POST /run          {source, input?, timeoutMs?}  -> {ok, result, logs, error, ms, wrote}
 *   GET  /files                                      -> {files:[{name, bytes}], bytes}
 *   GET  /files/:name                                -> {name, content}
 *   PUT  /files/:name  {content}                     -> {saved}
 *   GET  /health                                     -> {ok, agent, uptime, runs}
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.ARENA_EXECUTOR_TOKEN ?? "";
const AGENT = process.env.AGENT_ID ?? "unknown";
const DATA = resolve(process.env.ARENA_DATA_DIR ?? "/data");
const WORKSPACE = join(DATA, "workspace");
const RUNS = join(DATA, "runs");
const DEFAULT_TIMEOUT_MS = Number(process.env.ARENA_RUN_TIMEOUT_MS ?? 60_000);
const MAX_OUTPUT_CHARS = 200_000;

for (const dir of [DATA, WORKSPACE, RUNS]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

/*
 * /workspace is where agents assume their files are: 111 of one run's failed programs opened
 * "/workspace/<file>" while the files sat in /data/workspace, and a hint in the error did not stop
 * them. The path they reach for now leads to the real workspace.
 */
try {
  if (!existsSync("/workspace")) symlinkSync(WORKSPACE, "/workspace", "dir");
} catch {
  /* not permitted here (e.g. a local run); relative paths still work */
}

let runs = 0;
const started = Date.now();

/** A file name, never a path. The workspace is flat by design so nothing can point outside it. */
function safeName(name: string): string | null {
  const n = basename(String(name ?? "").trim());
  if (!n || n !== String(name).trim() || n.startsWith(".") || n.length > 120) return null;
  return n;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Run one program, as a child `node`, in the workspace, with its input on stdin.
 *
 * The program is wrapped so that both shapes agents write work unchanged: a callable
 * `(input) => …` / `function f(input) {…}` is invoked with the input; a plain body may `return`.
 * Whatever comes back is JSON-serialised as the result. console output is captured as logs.
 * `require` resolves against the image's node_modules AND the workspace's own, so an agent that
 * runs `npm install something` in its workspace can require it next turn.
 */
function runProgram(source: string, input: unknown, timeoutMs: number): Promise<{
  ok: boolean;
  result: string;
  logs: string[];
  error?: string;
  ms: number;
  wrote: string[];
}> {
  return new Promise((done) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const file = join(RUNS, `run-${id}.cjs`);
    const before = new Set(readdirSync(WORKSPACE));
    const wrapped = `
const __input = JSON.parse(process.env.__ARENA_INPUT__ || "null");
const __src = ${JSON.stringify(source)};
const __logs = [];
console.log = (...a) => { __logs.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
console.error = console.log; console.warn = console.log; console.info = console.log;
process.chdir(${JSON.stringify(WORKSPACE)});
const __AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
/* require resolves from the WORKSPACE, so require("./file") finds what the agent saved there. */
const __require = require("node:module").createRequire(${JSON.stringify(join(WORKSPACE, "index.cjs"))});
(async () => {
  try {
    /*
     * Both shapes agents write, unchanged: a single expression ("(input) => …", a function
     * expression, a literal) is returned; a body with statements runs as written and may
     * "return". A function that comes back is called with the input; a body that only defined
     * main/run/tool/fn/handler has that called.
     */
    let __run;
    try { __run = new __AsyncFunction("input", "require", "module", "exports", "return (\\n" + __src + "\\n)"); }
    catch { __run = new __AsyncFunction("input", "require", "module", "exports", __src); }
    const __mod = { exports: {} };
    let __value = await __run(__input, __require, __mod, __mod.exports);
    if (typeof __value === "function") __value = await __value(__input);
    if (__value === undefined) {
      const __g = globalThis;
      for (const __n of ["main", "run", "tool", "fn", "handler"]) {
        if (typeof __g[__n] === "function") { __value = await __g[__n](__input); break; }
      }
      if (__value === undefined && typeof __mod.exports === "function") __value = await __mod.exports(__input);
    }
    process.stdout.write(JSON.stringify({ ok: true, value: __value === undefined ? null : __value, logs: __logs }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: (e && e.stack) ? String(e.stack).split("\\n").slice(0, 4).join(" | ") : String(e), logs: __logs }));
  }
})();
`;
    writeFileSync(file, wrapped, "utf8");
    const startedAt = Date.now();
    const child = spawn(process.execPath, [file], {
      cwd: WORKSPACE,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: WORKSPACE,
        NODE_PATH: [join(WORKSPACE, "node_modules"), resolve(process.cwd(), "node_modules")].join(process.platform === "win32" ? ";" : ":"),
        __ARENA_INPUT__: JSON.stringify(input ?? null),
        /* Deliberately nothing else: no token, no keys, no coordinator address. */
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { if (out.length < MAX_OUTPUT_CHARS) out += String(d); });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUTPUT_CHARS) err += String(d); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try { unlinkSync(file); } catch { /* already gone */ }
      const ms = Date.now() - startedAt;
      const after = readdirSync(WORKSPACE);
      const wrote = after.filter((n) => !before.has(n) || statSync(join(WORKSPACE, n)).mtimeMs >= startedAt);
      runs++;
      if (signal === "SIGKILL") return done({ ok: false, result: "", logs: [], error: `killed after ${timeoutMs}ms`, ms, wrote });
      try {
        const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { ok: boolean; value?: unknown; error?: string; logs?: string[] };
        const result = parsed.ok ? (typeof parsed.value === "string" ? parsed.value : JSON.stringify(parsed.value)) : "";
        /* The operator's view of a program that did not compile: this container's own log, never the agent's. */
        if (!parsed.ok && /SyntaxError/.test(String(parsed.error))) {
          console.log(`SYNTAX ${AGENT} ${String(parsed.error).slice(0, 120)} :: ${JSON.stringify(source.slice(0, 1500))}`);
        }
        return done({ ok: parsed.ok, result: result ?? "", logs: parsed.logs ?? [], ...(parsed.ok ? {} : { error: parsed.error }), ms, wrote });
      } catch {
        return done({ ok: false, result: "", logs: [], error: `exit ${code}: ${(err || out).slice(0, 2000)}`, ms, wrote });
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  /*
   * Every route, /health included, needs this container's own token; without it the answer is an
   * empty 404 that does not even say what this service is. A program another agent runs cannot
   * learn which agent lives here, let alone send it code.
   */
  if (!TOKEN || req.headers["x-arena-token"] !== TOKEN) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (url.pathname === "/health") {
    return json(res, 200, { ok: true, agent: AGENT, uptimeSeconds: Math.round((Date.now() - started) / 1000), runs });
  }

  try {
    if (req.method === "POST" && url.pathname === "/run") {
      const body = await readBody(req);
      const source = String(body.source ?? "");
      if (!source.trim()) return json(res, 400, { ok: false, error: "source is required" });
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1_000), 300_000);
      return json(res, 200, await runProgram(source, body.input ?? null, timeoutMs));
    }
    if (req.method === "GET" && url.pathname === "/files") {
      const files = readdirSync(WORKSPACE)
        .filter((n) => !n.startsWith(".") && n !== "node_modules")
        .map((n) => ({ name: n, bytes: statSync(join(WORKSPACE, n)).size }));
      return json(res, 200, { files, bytes: files.reduce((s, f) => s + f.bytes, 0) });
    }
    const m = url.pathname.match(/^\/files\/([^/]+)$/);
    if (m) {
      const name = safeName(decodeURIComponent(m[1]!));
      if (!name) return json(res, 400, { error: "a plain file name, not a path" });
      const full = join(WORKSPACE, name);
      if (req.method === "GET") {
        if (!existsSync(full)) return json(res, 404, { error: "no such file" });
        return json(res, 200, { name, content: readFileSync(full, "utf8") });
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        writeFileSync(full, String(body.content ?? ""), "utf8");
        return json(res, 200, { saved: name, bytes: Buffer.byteLength(String(body.content ?? "")) });
      }
    }
    return json(res, 404, { error: "no such route" });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, "::", () => {
  console.log(`executor for ${AGENT} listening on ${PORT}, workspace ${WORKSPACE}`);
});
