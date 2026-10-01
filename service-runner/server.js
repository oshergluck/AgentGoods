/**
 * AgentGoods service runner: the only place hosted service code is executed.
 *
 * It lives in its own deployment, apart from the API: it holds no database connection, no wallet,
 * no API secrets — only RUNNER_TOKEN, which the API presents on every job. A compromise of the
 * code it runs reaches nothing worth having.
 *
 *   POST /run   Authorization: Bearer <RUNNER_TOKEN>
 *               { code, input, timeoutMs?, memoryBytes?, maxOutputBytes? }
 *            -> { ok: true, output, outputBytes, ms } | { ok: false, code, message, ms }
 *   GET  /health
 *
 * Each job gets a fresh child process (child.js): an empty environment, Node's permission model
 * (no child processes, no workers, no writes, reads limited to this package), a heap cap, and a
 * wall-clock kill. Inside it the code runs in QuickJS (sandbox.js). Concurrency is bounded; a job
 * beyond the bound is refused with 429 rather than queued without limit.
 */
"use strict";

const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.RUNNER_TOKEN || "";
const MAX_CONCURRENT = Number(process.env.RUNNER_MAX_CONCURRENT || 8);
const LIMITS = {
  timeoutMs: { def: 5_000, max: 15_000 },
  memoryBytes: { def: 32 * 1024 * 1024, max: 64 * 1024 * 1024 },
  maxOutputBytes: { def: 64 * 1024, max: 256 * 1024 },
};
const MAX_BODY = 1_500_000;

if (!TOKEN || TOKEN.length < 24) {
  console.error("RUNNER_TOKEN must be set (at least 24 characters).");
  process.exit(1);
}

const clamp = (v, { def, max }) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
};

function authorised(req) {
  const header = String(req.headers.authorization || "");
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

let running = 0;

function runJob(job) {
  return new Promise((resolve) => {
    const started = Date.now();
    const here = __dirname;
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${here}${path.sep}*`,
        `--max-old-space-size=${Math.ceil(job.memoryBytes / (1024 * 1024)) + 96}`,
        path.join(here, "child.js"),
      ],
      { env: {}, cwd: here, stdio: ["pipe", "pipe", "pipe"] }
    );
    let out = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ ...result, ms: Date.now() - started });
    };
    // The wall-clock backstop: the engine's own deadline should fire first.
    const killer = setTimeout(
      () => finish({ ok: false, code: "TIMEOUT", message: `The service did not finish within ${job.timeoutMs} ms.` }),
      job.timeoutMs + 2_000
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > job.maxOutputBytes * 2 + 4_096) {
        finish({ ok: false, code: "OUTPUT_TOO_LARGE", message: `The service returned more than ${job.maxOutputBytes} bytes.` });
      }
    });
    child.stderr.on("data", () => {
      /* never forwarded: stderr can carry host details */
    });
    child.on("error", () => finish({ ok: false, code: "RUNNER_ERROR", message: "The sandbox could not start." }));
    child.on("close", () => {
      const line = out.trim().split("\n").pop() || "";
      try {
        finish(JSON.parse(line));
      } catch {
        finish({ ok: false, code: "SERVICE_CRASHED", message: "The sandbox exited without a result (memory limit or crash)." });
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, running, maxConcurrent: MAX_CONCURRENT });
  if (req.method !== "POST" || req.url !== "/run") return send(404, { ok: false, code: "NOT_FOUND" });
  if (!authorised(req)) return send(401, { ok: false, code: "UNAUTHORISED" });

  let body = "";
  let tooLarge = false;
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (tooLarge) return send(413, { ok: false, code: "INPUT_TOO_LARGE" });
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(400, { ok: false, code: "BAD_JOB", message: "body must be JSON" });
    }
    if (typeof parsed.code !== "string" || parsed.code.length === 0) {
      return send(400, { ok: false, code: "BAD_JOB", message: "code is required" });
    }
    if (running >= MAX_CONCURRENT) return send(429, { ok: false, code: "RUNNER_BUSY", message: "try again shortly" });
    running++;
    try {
      const result = await runJob({
        code: parsed.code,
        input: parsed.input,
        timeoutMs: clamp(parsed.timeoutMs, LIMITS.timeoutMs),
        memoryBytes: clamp(parsed.memoryBytes, LIMITS.memoryBytes),
        maxOutputBytes: clamp(parsed.maxOutputBytes, LIMITS.maxOutputBytes),
      });
      send(200, result);
    } finally {
      running--;
    }
  });
});

server.listen(PORT, () => console.log(`service runner listening on ${PORT}`));
