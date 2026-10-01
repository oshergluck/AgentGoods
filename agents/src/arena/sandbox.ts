/**
 * Run code an Agent wrote, in a workspace it cannot get out of.
 *
 * Agents started asking each other for proof — "show me it works, then I'll buy" — and had no way
 * to answer. A seller could describe a tool and a buyer could only believe them or not, which is
 * why the forum filled with offers and produced no sales: there was nothing for trust to be built
 * out of. This gives them the missing primitive. An Agent runs its own code and posts the output;
 * a sceptical buyer pastes that code into its own call and gets its own output. Proof becomes
 * peer-to-peer and nobody has to take anybody's word.
 *
 * The code is hostile until proven otherwise. It is written by a language model that is being
 * scored competitively, is shown other agents' code on a public forum, and will happily run
 * whatever it finds there — so the threat is not only an agent attacking the host, it is an agent
 * pasting in something another agent wrote to be attacked by. And the machine this runs on holds
 * months of work, which no four-hour experiment is allowed to put at risk.
 *
 * WHERE THE WORKSPACE IS. Under the OS temp directory, never inside the repository — see
 * `assertOutsideRepo`, which refuses to start if that ever stops being true. Each Agent gets one
 * subdirectory. The repository is not merely un-writable from the sandbox, it is not addressable
 * from it.
 *
 * SIX LAYERS, each of which has to fail before anything escapes:
 *
 *  1. A SEPARATE PROCESS with a scrubbed environment. No API key, no RPC URL, no operator key, no
 *     arena state, no wallet. Even with total control of that process there is nothing worth
 *     having in it and no way to reach the run: it cannot sign a transaction, call the
 *     marketplace or read the ledger, because it holds none of them.
 *  2. NODE'S PERMISSION MODEL, allow-listing exactly one directory for read and write and nothing
 *     else. Verified on this machine: writes outside fail with ERR_ACCESS_DENIED and
 *     child_process is refused outright.
 *  3. A BARE VM CONTEXT. The code evaluates inside `vm.createContext` with a null prototype and
 *     nothing injected — no `require`, no `process`, no `fetch`, no timers, and no file API. The
 *     usual escape is a host object crossing the boundary and being walked back to the host realm
 *     through its constructor, so NOTHING crosses: input arrives as a JSON string parsed inside
 *     the context and results leave as a JSON string stringified inside it. Only primitives move.
 *  4. FILES BY NAME, NEVER BY PATH. The code never opens a file. It receives its workspace as
 *     data and returns the files it wants saved, and the parent writes them — so a path is never
 *     something the untrusted code supplies. Names are validated against a strict pattern that
 *     admits no separator, no `..`, no drive letter and no leading dot, then resolved and checked
 *     to be inside the workspace anyway. Belt, braces, and a second pair of braces.
 *  5. NO SYMLINKS, EVER. Written with an exclusive create after unlinking, and any path whose
 *     real location differs from its expected one is refused, so a link planted in the workspace
 *     cannot be used to write through to somewhere else.
 *  6. TIME, MEMORY AND SIZE. A `vm` limit, a parent SIGKILL regardless, a heap cap, an output cap
 *     that kills rather than buffers, and quotas on file count and total workspace bytes.
 *
 * What is deliberately absent: network, processes, native modules, timers, anything outside the
 * workspace, and any data belonging to this run. That makes some legitimate programs impossible
 * to write, which is the right trade — a demo that needs the network is a demo that could
 * exfiltrate, and nothing being sold in this market needs one.
 *
 * `vm` alone is not a security boundary and is not treated as one here. It is the third of six
 * layers and the ones beneath it are enforced by the operating system.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface SandboxResult {
  ok: boolean;
  /** Whatever the code returned, JSON-encoded. Empty when it returned nothing. */
  result: string;
  /** Anything it logged, in order, already truncated. */
  logs: string[];
  /** Set when the code threw, timed out, or was killed. */
  error: string | null;
  /** Files the run saved into the workspace, and files it was refused. */
  wrote: string[];
  refused: string[];
  ms: number;
}

/*
 * CAPACITY, raised deliberately. ISOLATION, unchanged.
 *
 * These two things get confused, so they are separated here explicitly. The six layers above are
 * the security boundary: separate process, scrubbed environment, Node's permission model, a bare
 * VM context, files by name and never by path, no symlinks. NONE of them is relaxed by anything in
 * this block, and none of them may be relaxed to make a program easier to write.
 *
 * What IS relaxed is how much an agent may compute, write and return. The earlier numbers were
 * sized for a scratchpad — 20KB of source, 3 seconds, 20 files, 256KB total — and at that size the
 * limit itself became the thing shaping behaviour: an agent that could not build something
 * substantial sold something small, and we would have been measuring the sandbox rather than the
 * agent. The point of this run is to see what agents choose to sell when the only pressure on them
 * is commercial, so the technical ceiling has to sit well above anything a reasonable product
 * needs.
 *
 * The ceiling still exists, because an unbounded one is a denial-of-service primitive rather than
 * a freedom: a runaway program is killed, a memory bomb hits a heap cap, and a process that floods
 * stdout is killed rather than buffered. Bounded generously is not the same as unbounded.
 */
export const MAX_SOURCE_BYTES = 200_000;
export const MAX_OUTPUT_BYTES = 400_000;
export const MAX_LOG_LINES = 300;
const HEAP_MB = 512;

/** Workspace quotas: enough to build a real tool across turns, not enough to fill a disk. */
export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 512_000;
export const MAX_WORKSPACE_BYTES = 8_000_000;

/**
 * A filename, and nothing that could be a path.
 *
 * No separator, no `..`, no drive letter, no leading dot, no control characters, no trailing
 * space or dot (which Windows silently strips, so `evil.js ` and `evil.js` would collide). If a
 * name does not match this it is refused outright rather than sanitised, because sanitising is
 * how a rule like this gets quietly defeated.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** The repository this arena lives in — the thing the sandbox must never be able to address. */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/**
 * The workspace root, outside the repository by construction and by assertion.
 *
 * Putting it under the repo would make a single permission-model mistake catastrophic instead of
 * merely bad. The check below is not decoration: if someone later points this somewhere
 * convenient, the sandbox refuses to run rather than silently granting access to the project.
 */
/**
 * Where agent code and saved files live.
 *
 * Overridable for the same reason as ARENA_DIR, and this one is the more dangerous of the two: a
 * new run calls resetSandbox(), which DELETES this directory. A second cohort started against the
 * default path would wipe the workspaces of a cohort that is still running — every file its agents
 * had saved, mid-run. A separate root is not tidiness, it is the difference between adding agents
 * to a live market and destroying the work of the ones already in it.
 */
export const SANDBOX_ROOT = process.env.ARENA_SANDBOX_ROOT
  ? resolve(process.env.ARENA_SANDBOX_ROOT)
  : join(tmpdir(), "agentgoods-arena-sandbox");

function assertOutsideRepo(dir: string): void {
  const target = resolve(dir);
  const repo = resolve(REPO_ROOT);
  if (target === repo || target.startsWith(repo + sep)) {
    throw new Error(
      `refusing to run: the sandbox workspace (${target}) is inside the repository (${repo}). ` +
        "Agent code must never be able to address the project."
    );
  }
}

/** The directory for one Agent, created on demand. */
export function workspaceFor(agentId: string): string {
  assertOutsideRepo(SANDBOX_ROOT);
  const safeId = agentId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "anonymous";
  const dir = join(SANDBOX_ROOT, safeId);
  if (resolve(dir) !== join(resolve(SANDBOX_ROOT), safeId)) {
    throw new Error("refusing to run: workspace path escaped the sandbox root");
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Remove every workspace. Called ONLY when a genuinely new run starts.
 *
 * Never on a restart: an arena restarted to ship a fix resumes the same agents with the same
 * wallets, keys, grants, stores and memory, and deleting their files underneath them would leave
 * a memory note referring to a file that no longer exists. The workspace belongs to the run.
 */
export function resetSandbox(): void {
  assertOutsideRepo(SANDBOX_ROOT);
  rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  mkdirSync(SANDBOX_ROOT, { recursive: true });
}

/** Names that are safe to write, with the reasons anything else was rejected. */
function validateName(name: string): string | null {
  if (typeof name !== "string") return "not a string";
  if (!SAFE_NAME.test(name)) return "must be a plain filename (letters, digits, . _ -), no paths";
  if (name.includes("..")) return "must not contain ..";
  if (RESERVED.test(name)) return "reserved device name";
  return null;
}

/**
 * Read the workspace so the code can see what it saved earlier.
 *
 * Skips anything that is not a regular file, which is how a symlink planted by an earlier run is
 * prevented from being read THROUGH rather than merely being read.
 */
function readWorkspace(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(dir)) return files;

  let total = 0;
  for (const name of readdirSync(dir).slice(0, MAX_FILES)) {
    if (validateName(name) !== null) continue;
    const full = join(dir, name);
    try {
      const stat = lstatSync(full);
      if (!stat.isFile()) continue; // directories and symlinks are not readable as content
      if (stat.size > MAX_FILE_BYTES) continue;
      if (total + stat.size > MAX_WORKSPACE_BYTES) break;
      files[name] = readFileSync(full, "utf8");
      total += stat.size;
    } catch {
      /* unreadable entries are simply not offered */
    }
  }
  return files;
}

/**
 * Persist what the run asked to save.
 *
 * Every write is the parent's, never the sandbox's: the code returned names and contents, and
 * this decides where — if anywhere — they land. A name that does not pass, a file that is too
 * big, a workspace that is full, or a path whose real location is not where it should be, is
 * refused and reported back so the Agent learns the rule rather than silently losing its work.
 */
function writeWorkspace(
  dir: string,
  files: Record<string, unknown>
): { wrote: string[]; refused: string[] } {
  const wrote: string[] = [];
  const refused: string[] = [];

  const expectedRoot = realpathSync(dir);
  let budget = MAX_WORKSPACE_BYTES;
  for (const existing of Object.values(readWorkspace(dir))) budget -= Buffer.byteLength(existing, "utf8");

  let count = Object.keys(readWorkspace(dir)).length;

  for (const [name, value] of Object.entries(files ?? {})) {
    const problem = validateName(name);
    if (problem) {
      refused.push(`${String(name).slice(0, 40)}: ${problem}`);
      continue;
    }
    if (count >= MAX_FILES) {
      refused.push(`${name}: workspace already holds ${MAX_FILES} files`);
      continue;
    }

    const content = typeof value === "string" ? value : JSON.stringify(value ?? null);
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_FILE_BYTES) {
      refused.push(`${name}: larger than ${MAX_FILE_BYTES} bytes`);
      continue;
    }
    if (size > budget) {
      refused.push(`${name}: workspace is full (${MAX_WORKSPACE_BYTES} bytes total)`);
      continue;
    }

    const full = join(dir, name);
    // The resolved path must be exactly where we expect it, in the directory we expect.
    if (resolve(full) !== join(expectedRoot, name)) {
      refused.push(`${name}: resolved outside the workspace`);
      continue;
    }

    try {
      /*
       * Unlink first, then create exclusively.
       *
       * Writing over an existing entry would follow it if it were a symlink, which is precisely
       * the move this has to stop. Removing it and demanding an exclusive create means the file
       * that ends up there is one this call made, not one something else prepared.
       */
      if (existsSync(full)) unlinkSync(full);
      writeFileSync(full, content, { encoding: "utf8", flag: "wx" });

      const check = lstatSync(full);
      if (!check.isFile()) {
        unlinkSync(full);
        refused.push(`${name}: not a regular file after writing`);
        continue;
      }
      wrote.push(name);
      budget -= size;
      count++;
    } catch (error) {
      refused.push(`${name}: ${(error as Error).message.slice(0, 60)}`);
    }
  }

  return { wrote, refused };
}

/**
 * The child, as source rather than a file.
 *
 * Passed with `-e` so the sandboxed process needs no read permission for a script of its own, and
 * the only path on its allow-list is the Agent's workspace.
 */
const RUNNER = String.raw`
const vm = require("node:vm");

/*
 * Anything reachable from the host scope, removed before user code exists.
 *
 * The code cannot see these from inside the context anyway; this closes the follow-on move if the
 * context boundary were ever defeated. Network is the one capability the permission model does
 * not gate, so it is taken away by hand.
 */
for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "navigator"]) {
  try { delete globalThis[name]; } catch {}
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: "runner: unreadable payload" }));
    return;
  }

  const context = vm.createContext(Object.create(null));

  /*
   * The only things that cross are strings.
   *
   * Input and the workspace are embedded as JSON literals and parsed INSIDE the context, so the
   * Agent's data becomes objects of the sandbox realm rather than host objects handed through.
   * Same rule outbound: everything is stringified in-context and leaves as text. There is no file
   * API here at all — 'files' is data in, and the value of 'saveFiles' is data out.
   */
  const bootstrap =
    "const __logs = [];" +
    "const __say = (...a) => {" +
    "  if (__logs.length >= ${MAX_LOG_LINES}) return;" +
    "  try {" +
    "    __logs.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ').slice(0, 2000));" +
    "  } catch { __logs.push('[unprintable]'); }" +
    "};" +
    "const console = { log: __say, info: __say, warn: __say, error: __say, debug: __say };" +
    "const input = JSON.parse(" + JSON.stringify(payload.input ?? "null") + ");" +
    "const files = JSON.parse(" + JSON.stringify(payload.files ?? "{}") + ");" +
    "globalThis.saveFiles = {};";

  try {
    vm.runInContext(bootstrap, context, { timeout: 1000 });
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: "runner: bootstrap failed" }));
    return;
  }

  /*
   * Two shapes of program, because agents write both and only one used to work.
   *
   * The BODY form is what a model writes when told "return your answer":
   *     const x = input.a + input.b; return x;
   * It is wrapped in a function so that a bare return statement is legal.
   *
   * The CALLABLE form is what a model writes when told "build a tool":
   *     function (input) { return input.a + input.b; }
   *     (input) => input.a + input.b
   * Wrapping THAT as a body turns it into an unnamed function statement, which is a syntax error
   * — "Function statements require a function name". It accounted for sixteen of the first
   * twenty-one runs in this arena. The agents were not writing bad code; they were writing the
   * obvious thing for "here is my tool" and being told nothing they could act on. A callable is
   * now detected and invoked with the input value.
   */
  const src = String(payload.source ?? "");
  const looksCallable =
    /^\s*(async\s+)?function\s*\(/.test(src) ||
    /^\s*(async\s+)?\(\s*[A-Za-z0-9_$,\s]*\)\s*=>/.test(src) ||
    /^\s*(async\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*=>/.test(src);

  const wrapped = looksCallable
    ? "globalThis.__result = (" + src + ")(input);"
    : "globalThis.__result = (function () { 'use strict';\n" + src + "\n})();";

  let error = null;
  try {
    vm.runInContext(wrapped, context, { timeout: payload.timeoutMs ?? 15_000 });
  } catch (e) {
    error = (e && e.message ? String(e.message) : String(e)).slice(0, 500);
    /*
     * Name the fix, not just the fault.
     *
     * "Function statements require a function name" tells an agent nothing it can act on, and it
     * retried the same shape on the next turn. The two forms that work are cheap to state.
     */
    /*
     * An agent tried to call the ACTION from inside the sandbox.
     *
     * "run_code is not defined" is true and useless: the agent believes the marketplace verbs are
     * available as functions in here, and nothing in that message corrects it. The sandbox is
     * pure computation — there is no protocol inside it by design, which is the same reason it
     * cannot exfiltrate anything.
     */
    const calledAnAction = /^(\w+) is not defined/.exec(error);
    if (
      calledAnAction &&
      ["run_code", "buy_aic", "sell_aic", "post_forum", "create_product", "buy_product", "swap_dex",
       "set_price", "vote_forum", "search_forum", "create_store"].includes(calledAnAction[1] ?? "")
    ) {
      error +=
        " -- marketplace actions are NOT callable inside the sandbox. It is pure computation: no " +
        "network, no API, no wallet. Compute the answer here and RETURN it, then take the action " +
        "itself on a later turn using the result.";
    }

    if (/Function statements require a function name/.test(error)) {
      error +=
        " -- write EITHER a plain body that returns a value (const x = input.a; return x;) OR a " +
        "complete callable ((input) => input.a, or function f(input) { return input.a; }). A bare " +
        "unnamed 'function (...) {...}' sitting in the middle of a body is neither.";
    }
  }

  let out = '{"result":"","logs":[],"save":{}}';
  try {
    out = vm.runInContext(
      "JSON.stringify({" +
      "  result: globalThis.__result === undefined ? '' : JSON.stringify(globalThis.__result)," +
      "  logs: __logs," +
      "  save: (globalThis.saveFiles && typeof globalThis.saveFiles === 'object') ? globalThis.saveFiles : {}" +
      "})",
      context,
      { timeout: 1000 }
    );
  } catch (e) {
    error = error ?? "result could not be serialized (is it circular?)";
  }

  let parsed = { result: "", logs: [], save: {} };
  try { parsed = JSON.parse(out); } catch {}

  process.stdout.write(JSON.stringify({
    ok: error === null,
    error,
    result: parsed.result,
    logs: parsed.logs,
    save: parsed.save,
  }));
});
`;

/**
 * Execute `source` and return what it produced.
 *
 * Never throws for a fault in the code being run: a thrown exception, a timeout and an infinite
 * loop all come back as ordinary results, because to the Agent that called this they ARE the
 * result and it should be able to read the message and fix its program.
 */
export async function runUntrustedCode(
  source: string,
  input: unknown,
  options: { timeoutMs?: number; workspace?: string } = {}
): Promise<SandboxResult> {
  const started = Date.now();
  /*
   * Up to 60s, from 10s. Long enough that "it did not finish" is a fact about the program rather
   * than about the harness, and still a hard wall-clock kill: the parent SIGKILLs regardless of
   * what the code is doing, so an infinite loop costs a minute and nothing else.
   */
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 250), 60_000);

  if (typeof source !== "string" || source.trim().length === 0) {
    return { ok: false, result: "", logs: [], error: "no code was supplied", wrote: [], refused: [], ms: 0 };
  }
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      result: "",
      logs: [],
      error: `code is too long (${MAX_SOURCE_BYTES} byte limit)`,
      wrote: [],
      refused: [],
      ms: 0,
    };
  }

  const workspace = options.workspace ? resolve(options.workspace) : null;
  if (workspace) {
    assertOutsideRepo(workspace);
    if (!isAbsolute(workspace)) {
      return { ok: false, result: "", logs: [], error: "workspace must be absolute", wrote: [], refused: [], ms: 0 };
    }
    mkdirSync(workspace, { recursive: true });
  }

  const existingFiles = workspace ? readWorkspace(workspace) : {};

  return await new Promise<SandboxResult>((resolve_) => {
    /*
     * The permission model's allow-list is the workspace and nothing else.
     *
     * With no `--allow-fs-*` at all, Node denies the filesystem entirely; naming one directory
     * grants exactly that directory. Everything outside it — the repository above all — is denied
     * by the runtime rather than by anything this code remembers to check.
     */
    const args = ["--permission", `--max-old-space-size=${HEAP_MB}`, "--no-warnings"];
    if (workspace) {
      args.push(`--allow-fs-read=${workspace}`, `--allow-fs-write=${workspace}`);
    }
    args.push("-e", RUNNER);

    const child = spawn(process.execPath, args, {
      // Nothing from this process is inherited. No keys, no endpoints, no run state.
      env: {},
      cwd: workspace ?? tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killedFor: string | null = null;

    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve_(result);
    };

    /*
     * The parent's own deadline, generous relative to the in-context one.
     *
     * `vm`'s timeout stops synchronous code, which is all the context can produce — but it is the
     * layer nearest the untrusted code and therefore the one least worth relying on. This kill is
     * unconditional.
     */
    const timer = setTimeout(() => {
      killedFor = `timed out after ${timeoutMs}ms`;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs + 1500);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        killedFor = "produced too much output";
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8").slice(0, 2000);
    });

    child.on("error", (e) => {
      finish({
        ok: false,
        result: "",
        logs: [],
        error: `sandbox failed to start: ${e.message}`,
        wrote: [],
        refused: [],
        ms: Date.now() - started,
      });
    });

    child.on("close", () => {
      const ms = Date.now() - started;
      if (killedFor) {
        return finish({ ok: false, result: "", logs: [], error: killedFor, wrote: [], refused: [], ms });
      }
      try {
        const parsed = JSON.parse(stdout) as {
          ok: boolean;
          error: string | null;
          result?: string;
          logs?: string[];
          save?: Record<string, unknown>;
        };

        // The parent performs every write, after its own validation. The sandbox only proposed.
        const saved =
          workspace && parsed.save && Object.keys(parsed.save).length > 0
            ? writeWorkspace(workspace, parsed.save)
            : { wrote: [], refused: [] };

        return finish({
          ok: parsed.ok,
          result: parsed.result ?? "",
          logs: parsed.logs ?? [],
          error: parsed.error ?? null,
          wrote: saved.wrote,
          refused: saved.refused,
          ms,
        });
      } catch {
        return finish({
          ok: false,
          result: "",
          logs: [],
          error: stderr.trim().slice(0, 300) || "the sandbox produced no readable result",
          wrote: [],
          refused: [],
          ms,
        });
      }
    });

    child.stdin.on("error", () => {
      /* the child may die before the write lands; `close` reports it */
    });
    child.stdin.end(
      JSON.stringify({
        source,
        input: JSON.stringify(input ?? null),
        files: JSON.stringify(existingFiles),
        timeoutMs,
      })
    );
  });
}

/**
 * How many files survive across the whole sandbox, for the restart message.
 *
 * Reported so that "kept across the restart" is a checkable claim rather than an assurance.
 */
export function sandboxFileCount(): number {
  if (!existsSync(SANDBOX_ROOT)) return 0;
  let total = 0;
  for (const dir of readdirSync(SANDBOX_ROOT)) {
    try {
      for (const name of readdirSync(join(SANDBOX_ROOT, dir))) {
        if (statSync(join(SANDBOX_ROOT, dir, name)).isFile()) total++;
      }
    } catch {
      /* not a directory, or unreadable */
    }
  }
  return total;
}

/**
 * Read one file out of an Agent's workspace, for selling what it built.
 *
 * The sandbox and the marketplace were separate systems: an Agent could write and test a working
 * tool with run_code, and then had no way to attach it to a product — so every listing shipped
 * its own description as the deliverable. This is the join between them. Same name rules as
 * writing, so a filename can never become a path.
 */
export function readWorkspaceFile(dir: string, name: string): string | null {
  if (validateName(name) !== null) return null;
  const full = join(dir, name);
  try {
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    if (resolve(full) !== join(realpathSync(dir), name)) return null;
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

/**
 * Put something an Agent bought into its workspace, so it can actually use it.
 *
 * A purchase used to end with the bytes verified and then dropped on the floor — the buyer paid,
 * the hash checked out, and it never saw the thing. Writing it here means the next run_code call
 * can read it straight out of `files` and execute what was bought, which is the only reason to
 * buy a tool in the first place.
 *
 * Goes through the same name validation as every other write: a filename, never a path.
 */
export function saveToWorkspace(dir: string, name: string, content: string): string | null {
  const result = writeWorkspace(dir, { [name]: content });
  return result.wrote.includes(name) ? name : null;
}

/** The names an Agent currently has saved, so it can be told what it could sell. */
export function workspaceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => validateName(n) === null && lstatSync(join(dir, n)).isFile());
  } catch {
    return [];
  }
}

/** Total bytes an Agent is holding, for reporting. */
export function workspaceUsage(dir: string): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let bytes = 0;
  let files = 0;
  for (const name of readdirSync(dir)) {
    try {
      const stat = statSync(join(dir, name));
      if (stat.isFile()) {
        files++;
        bytes += stat.size;
      }
    } catch {
      /* ignore */
    }
  }
  return { files, bytes };
}
