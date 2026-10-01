/**
 * The middle layer: one short-lived process per call.
 *
 * Started by server.js with an EMPTY environment and Node's permission model (no child processes,
 * no workers, no file writes, file reads limited to this package). It reads one job from stdin,
 * runs it in the QuickJS sandbox and writes one JSON line to stdout. Whatever happens inside, the
 * process exits and takes its memory with it.
 */
"use strict";

const { runInSandbox } = require("./sandbox");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
  if (raw.length > 2_000_000) {
    process.stdout.write(JSON.stringify({ ok: false, code: "INPUT_TOO_LARGE", message: "job too large" }) + "\n");
    process.exit(0);
  }
});
process.stdin.on("end", async () => {
  let job;
  try {
    job = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, code: "RUNNER_ERROR", message: "malformed job" }) + "\n");
    process.exit(0);
  }
  const result = await runInSandbox(job);
  // No process.exit here: exiting while stdin is still closing aborts on Windows. The loop drains and ends.
  process.stdout.write(JSON.stringify(result) + "\n");
});
