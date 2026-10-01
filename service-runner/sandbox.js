/**
 * The inner layer: seller code runs inside QuickJS, a separate JavaScript engine compiled to WASM.
 *
 * The engine has no host bindings unless they are handed in, and none are: no require, no process,
 * no fs, no network, no timers, no environment. The seller's function receives the buyer's input as
 * a JSON string parsed inside the engine and must return something JSON can express. Nothing from
 * this Node process ever crosses into the engine as an object, so there is no host reference to
 * climb out through.
 *
 * Limits: a memory cap on the engine's heap, a stack cap, an interrupt deadline that stops runaway
 * loops, and an output cap applied before the result leaves this layer.
 */
"use strict";

const { getQuickJS, shouldInterruptAfterDeadline } = require("quickjs-emscripten");

const ENTRY_NAMES = ["tool", "run", "handler", "main", "invoke"];

/*
 * Accepts the shapes sellers actually write: `function tool(input) {}`, `const tool = (input) => …`,
 * `module.exports = (input) => …`, `export default function (input) {}` and a bare function
 * expression. `export default` is rewritten to a CommonJS assignment, since the code runs as a script.
 */
function wrap(code) {
  const body = String(code).replace(/^\s*export\s+default\s+/m, "module.exports = ");
  return `
"use strict";
var module = { exports: {} };
var exports = module.exports;
var console = { log: function () {}, error: function () {}, warn: function () {}, info: function () {} };
var __entry = null;
// Top level, not inside a block: in strict mode a function declared in a block is scoped to it.
${body}
;
${ENTRY_NAMES.map((n) => `if (!__entry && typeof ${n} === "function") __entry = ${n};`).join("\n")}
if (!__entry && typeof module.exports === "function") __entry = module.exports;
if (!__entry && module.exports && typeof module.exports.default === "function") __entry = module.exports.default;
${ENTRY_NAMES.map((n) => `if (!__entry && module.exports && typeof module.exports.${n} === "function") __entry = module.exports.${n};`).join("\n")}
globalThis.__entry = __entry;
`;
}

function bareExpression(code) {
  return `"use strict"; globalThis.__entry = (${String(code).trim().replace(/;\s*$/, "")});`;
}

/**
 * @param {{ code: string, input: unknown, timeoutMs: number, memoryBytes: number, maxOutputBytes: number }} job
 * @returns {Promise<{ ok: true, output: unknown, outputBytes: number } | { ok: false, code: string, message: string }>}
 */
async function runInSandbox(job) {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(job.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + job.timeoutMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const ctx = runtime.newContext();
  const fail = (code, message) => ({ ok: false, code, message: String(message).slice(0, 500) });
  const errText = (handle) => {
    const e = ctx.dump(handle);
    handle.dispose();
    if (e && typeof e === "object") return `${e.name ?? "Error"}: ${e.message ?? JSON.stringify(e)}`;
    return String(e);
  };
  const classify = (message) =>
    /interrupted/i.test(message) ? "TIMEOUT" : /out of memory|memory/i.test(message) ? "MEMORY_LIMIT" : null;
  try {
    let loaded = ctx.evalCode(wrap(job.code), "service.js");
    if (loaded.error) {
      const first = errText(loaded.error);
      // Maybe the code is a bare function expression rather than a script.
      loaded = ctx.evalCode(bareExpression(job.code), "service.js");
      if (loaded.error) {
        const message = errText(loaded.error);
        return fail(classify(first) ?? "CODE_INVALID", first.length ? first : message);
      }
    }
    loaded.value.dispose();
    // A bare function expression is a valid script that defines nothing; evaluate it as an expression.
    const entry = ctx.getProp(ctx.global, "__entry");
    const hasEntry = ctx.typeof(entry) === "function";
    entry.dispose();
    if (!hasEntry) {
      const bare = ctx.evalCode(bareExpression(job.code), "service.js");
      if (bare.error) bare.error.dispose();
      else bare.value.dispose();
    }

    const inputJson = JSON.stringify(job.input === undefined ? null : job.input);
    const call = ctx.evalCode(
      `(function () {
        if (typeof globalThis.__entry !== "function") throw new Error("NO_ENTRY");
        var input = JSON.parse(${JSON.stringify(inputJson)});
        globalThis.__done = false;
        Promise.resolve().then(function () { return globalThis.__entry(input); }).then(
          function (v) {
            var s = JSON.stringify(v === undefined ? null : v);
            globalThis.__result = s === undefined ? "null" : s;
            globalThis.__done = true;
          },
          function (e) { globalThis.__error = String(e && e.stack ? e.message : e); globalThis.__done = true; }
        );
      })()`,
      "invoke.js"
    );
    if (call.error) {
      const message = errText(call.error);
      if (/NO_ENTRY/.test(message)) {
        return fail("CODE_INVALID", `The service code defines no callable. Define one of: ${ENTRY_NAMES.join(", ")}, or module.exports = (input) => …`);
      }
      return fail(classify(message) ?? "SERVICE_ERROR", message);
    }
    call.value.dispose();

    // Drive the promise chain; the interrupt handler still bounds it.
    for (let i = 0; i < 10_000; i++) {
      const done = ctx.getProp(ctx.global, "__done");
      const isDone = ctx.dump(done);
      done.dispose();
      if (isDone) break;
      if (Date.now() > deadline) return fail("TIMEOUT", `The service did not finish within ${job.timeoutMs} ms.`);
      const pending = runtime.executePendingJobs();
      if (pending.error) {
        const message = errText(pending.error);
        return fail(classify(message) ?? "SERVICE_ERROR", message);
      }
      if (pending.value === 0) {
        const again = ctx.getProp(ctx.global, "__done");
        const finished = ctx.dump(again);
        again.dispose();
        if (!finished) return fail("SERVICE_ERROR", "The service returned a promise that never settled.");
        break;
      }
    }
    const errHandle = ctx.getProp(ctx.global, "__error");
    const error = ctx.dump(errHandle);
    errHandle.dispose();
    if (typeof error === "string") return fail(classify(error) ?? "SERVICE_ERROR", error);

    const resHandle = ctx.getProp(ctx.global, "__result");
    const serialized = ctx.dump(resHandle);
    resHandle.dispose();
    if (typeof serialized !== "string") return fail("SERVICE_ERROR", "The service produced no result.");
    const outputBytes = Buffer.byteLength(serialized, "utf8");
    if (outputBytes > job.maxOutputBytes) {
      return fail("OUTPUT_TOO_LARGE", `The service returned ${outputBytes} bytes; the limit is ${job.maxOutputBytes}.`);
    }
    return { ok: true, output: JSON.parse(serialized), outputBytes };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    return fail(classify(message) ?? "SERVICE_ERROR", message);
  }
  /*
   * No dispose: each job runs in its own short-lived process (child.js), which exits right after and
   * frees everything. Freeing a runtime that a failed job left holding objects aborts the WASM module.
   */
}

module.exports = { runInSandbox, ENTRY_NAMES };
