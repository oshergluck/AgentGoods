/**
 * Where an agent's code runs and its files live: locally in the vm sandbox, or in its own container.
 *
 * The agent loop does not care which. It asks this interface to run a program, save a file, read
 * one, list them — and the answer comes from `node:vm` on this machine (the original design,
 * `sandbox.ts`) or from the agent's executor service over the project's private network
 * (`executor/server.ts`), depending on ARENA_EXECUTOR_BASE. Everything the loop reports back to
 * the agent is the same shape either way, so the agent cannot tell — and should not need to —
 * except that in a container it also has the network, `require`, and a disk that survives.
 */

import { runUntrustedCode, workspaceFor, saveToWorkspace, readWorkspaceFile, workspaceFiles, workspaceUsage } from "./sandbox";

export interface RunOutcome {
  ok: boolean;
  result: string;
  logs: string[];
  error?: string;
  ms: number;
  wrote: string[];
  refused: string[];
}

export interface AgentStorage {
  readonly kind: "local-sandbox" | "own-container";
  run(source: string, input: unknown, timeoutMs: number): Promise<RunOutcome>;
  save(name: string, content: string): Promise<string | null>;
  read(name: string): Promise<string | null>;
  list(): Promise<string[]>;
  usage(): Promise<{ files: number; bytes: number }>;
  /** What to tell the agent about the place its code runs. Mechanics only. */
  describe(): string;
}

/* ------------------------------------------------------------------ local */

export function localStorage(agentId: string): AgentStorage {
  const dir = workspaceFor(agentId);
  return {
    kind: "local-sandbox",
    async run(source, input, timeoutMs) {
      const o = await runUntrustedCode(source, input, { timeoutMs, workspace: dir });
      return { ok: o.ok, result: o.result, logs: o.logs, error: o.error ?? undefined, ms: o.ms, wrote: o.wrote, refused: o.refused };
    },
    async save(name, content) {
      return saveToWorkspace(dir, name, content);
    },
    async read(name) {
      return readWorkspaceFile(dir, name);
    },
    async list() {
      try {
        return workspaceFiles(dir);
      } catch {
        return [];
      }
    },
    async usage() {
      return workspaceUsage(dir);
    },
    describe() {
      return (
        "Execute JavaScript in your sandbox. No network, no require, no filesystem beyond your " +
        "workspace, which is exposed as `files`. Read `input` for your data and `return` your answer."
      );
    },
  };
}

/* ----------------------------------------------------------------- remote */

/**
 * The executor's address for an agent, from a template such as
 * `http://agent-{{id}}.railway.internal:8080` where {{id}} is the agent's id (a01 → "01").
 */
export function executorBaseFor(agentId: string): string | null {
  const mapped = executorMap()[agentId];
  if (mapped) return mapped.url;
  const template = process.env.ARENA_EXECUTOR_BASE;
  if (!template) return null;
  const digits = agentId.replace(/^a/, "");
  return template.replace("{{id}}", digits).replace("{{agentId}}", agentId);
}

/**
 * Each agent's container, by a name nobody can guess.
 *
 * With services called agent-01 … agent-20 on port 8080, a program one agent runs could address
 * every other agent's container by counting. ARENA_EXECUTOR_MAP gives each one a random service
 * name, a random port and a token of its own — {"a01": {"url": "http://svc-….railway.internal:PORT",
 * "token": "…"}, …} — known only to the supervisor. No agent is told it, and no container holds
 * another container's token.
 */
function executorMap(): Record<string, { url: string; token: string }> {
  try {
    return JSON.parse(process.env.ARENA_EXECUTOR_MAP ?? "{}");
  } catch {
    return {};
  }
}

export function executorTokenFor(agentId: string): string {
  return executorMap()[agentId]?.token ?? process.env.ARENA_EXECUTOR_TOKEN ?? "";
}

export function remoteStorage(agentId: string, log: (m: string) => void): AgentStorage {
  const base = executorBaseFor(agentId);
  if (!base) throw new Error("ARENA_EXECUTOR_BASE is not set");
  const token = executorTokenFor(agentId);
  const headers = { "content-type": "application/json", "x-arena-token": token };

  /*
   * Three attempts with a short backoff, because the private network drops a request now and
   * then and an agent's turn should not be lost to it. A container that is genuinely down fails
   * all three and the agent is told so in words rather than with a crash.
   */
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(base + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(330_000),
        });
        const text = await res.text();
        const parsed = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
        if (!res.ok) throw new Error(`executor ${res.status}: ${parsed.error ?? text.slice(0, 200)}`);
        return parsed;
      } catch (error) {
        last = error;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    log(`executor ${base} unreachable: ${last instanceof Error ? last.message : String(last)}`);
    throw new Error(`your container did not answer: ${last instanceof Error ? last.message : String(last)}`);
  }

  return {
    kind: "own-container",
    async run(source, input, timeoutMs) {
      try {
        const o = await call<Omit<RunOutcome, "refused">>("POST", "/run", { source, input, timeoutMs });
        return { ...o, refused: [] };
      } catch (error) {
        return { ok: false, result: "", logs: [], error: error instanceof Error ? error.message : String(error), ms: 0, wrote: [], refused: [] };
      }
    },
    async save(name, content) {
      try {
        const o = await call<{ saved: string }>("PUT", `/files/${encodeURIComponent(name)}`, { content });
        return o.saved;
      } catch {
        return null;
      }
    },
    async read(name) {
      try {
        const o = await call<{ content: string }>("GET", `/files/${encodeURIComponent(name)}`);
        return o.content;
      } catch {
        return null;
      }
    },
    async list() {
      try {
        const o = await call<{ files: { name: string }[] }>("GET", "/files");
        return o.files.map((f) => f.name);
      } catch {
        return [];
      }
    },
    async usage() {
      try {
        const o = await call<{ files: { name: string }[]; bytes: number }>("GET", "/files");
        return { files: o.files.length, bytes: o.bytes };
      } catch {
        return { files: 0, bytes: 0 };
      }
    },
    describe() {
      return (
        "Execute JavaScript in your own container - not a sandbox: a full Node runtime with unrestricted network access, `require` " +
        "(ethers v6 is installed; `npm install` in your workspace adds more; `require(\"./name\")` " +
        "loads a file from your workspace), and a persistent " +
        "workspace on your own volume. Your program is run in that workspace — it is the current directory, so " +
        "refer to files by name (\"tool.js\" or \"./tool.js\"; /workspace/tool.js is the same file). `input` is the data " +
        "you passed and whatever you `return` (or what a `main`/`run` function returns) comes back " +
        "to you. Files you write there persist and appear in list_files. No key of any kind is in " +
        "that container; signing is still done through send_transaction."
      );
    },
  };
}

/** The storage for this agent, decided once by the environment. */
export function storageFor(agentId: string, log: (m: string) => void): AgentStorage {
  return process.env.ARENA_EXECUTOR_BASE || process.env.ARENA_EXECUTOR_MAP ? remoteStorage(agentId, log) : localStorage(agentId);
}
