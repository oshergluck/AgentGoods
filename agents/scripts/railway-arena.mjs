#!/usr/bin/env node
/**
 * Stand up (or update) the arena as its own Railway project: one coordinator, one container per agent.
 *
 * WHY A SEPARATE PROJECT. Services in one Railway project share a private network. The marketplace's
 * project holds its database; an agent container that could resolve mongodb.railway.internal would
 * be one bug away from the site's data. In a project of its own, an agent's container can reach the
 * public internet — including the marketplace's public API, like any stranger — and nothing else
 * that matters.
 *
 * WHAT IT DOES, idempotently:
 *   1. links this directory to the arena project (creating it on first use)
 *   2. creates the coordinator and agent-01..agent-NN services if missing
 *   3. attaches a /data volume to every service
 *   4. sets each service's variables (role, ids, token, origin; secrets for the coordinator only)
 *   5. deploys the current source to every service (same image, ARENA_ROLE decides the role)
 *
 *     node scripts/railway-arena.mjs --agents 20 [--project agentgoods-arena] [--deploy] [--only coordinator]
 *
 * Secrets are read from the environment of THIS process (OPENAI_API_KEY, DEPLOYER_PRIVATE_KEY) or
 * from ../contracts/.env for the operator key, and are set on the coordinator only.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LINE_BREAK = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));
const AGENTS_DIR = resolve(HERE, "..");
const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const AGENTS = Number(arg("--agents", "20"));
const PROJECT = arg("--project", "ravishing-renewal");
const ONLY = arg("--only", null);
const DEPLOY = argv.includes("--deploy");
const ORIGIN = process.env.ARENA_ORIGIN ?? "https://testnet.agentgoods.ai";

function rw(args, opts = {}) {
  const r = spawnSync("railway", args, { cwd: AGENTS_DIR, encoding: "utf8", shell: process.platform === "win32", ...opts });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
/** `railway status --json` pretty-prints over many lines, sometimes after a notice: parse from the first brace. */
function parseJson(text) {
  const i = text.indexOf("{");
  if (i < 0) throw new Error("no JSON in output");
  return JSON.parse(text.slice(i));
}
function must(args, what) {
  const r = rw(args);
  if (r.code !== 0) { console.error(`✗ ${what}\n${r.out}`); process.exit(1); }
  return r.out;
}

/** A KEY=value line from a dotenv file, or null. Quotes around the value are stripped. */
function dotenvValue(file, key) {
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8").split(LINE_BREAK).find((l) => l.trim().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : null;
}

function openaiKey() {
  return process.env.OPENAI_API_KEY ?? dotenvValue(resolve(AGENTS_DIR, "..", "backend", ".env"), "OPENAI_API_KEY");
}

function rpcUrl() {
  return process.env.ARENA_RPC_URL ?? dotenvValue(resolve(AGENTS_DIR, "..", "contracts", ".env"), "BASE_SEPOLIA_RPC_URL");
}

function operatorKey() {
  return (
    process.env.DEPLOYER_PRIVATE_KEY ??
    dotenvValue(resolve(AGENTS_DIR, "..", "contracts", ".env"), "DEPLOYER_PRIVATE_KEY") ??
    dotenvValue(resolve(AGENTS_DIR, "..", "contracts", ".env"), "PRIVATE_KEY")
  );
}

/* ---- volumes, through the API the CLI itself uses (its stored login), one per service at /data */
const API = "https://backboard.railway.com/graphql/v2";
function cliToken() {
  const cfg = join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".railway", "config.json");
  return existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")).user?.token ?? null : null;
}
async function gql(query, variables) {
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cliToken()}` }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0]?.message ?? "graphql error");
  return j.data;
}
let projectInfo = null;
async function ensureVolume(serviceName) {
  if (!projectInfo) {
    const st = parseJson(rw(["status", "--json"]).out);
    const vols = (await gql(`query($id:String!){ project(id:$id){ volumes{ edges{ node{ id volumeInstances{ edges{ node{ serviceId mountPath } } } } } } } }`, { id: st.id })).project.volumes.edges;
    const withVolume = new Set();
    for (const v of vols) for (const i of v.node.volumeInstances.edges) if (i.node.mountPath === "/data" && i.node.serviceId) withVolume.add(i.node.serviceId);
    projectInfo = { id: st.id, envId: st.environments.edges[0].node.id, ids: Object.fromEntries(st.services.edges.map((e) => [e.node.name, e.node.id])), withVolume };
  }
  const serviceId = projectInfo.ids[serviceName];
  if (!serviceId) return "FAILED (service id unknown)";
  if (projectInfo.withVolume.has(serviceId)) return "already present";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await gql(`mutation($input:VolumeCreateInput!){ volumeCreate(input:$input){ id } }`, { input: { projectId: projectInfo.id, environmentId: projectInfo.envId, serviceId, mountPath: "/data" } });
      projectInfo.withVolume.add(serviceId);
      await new Promise((r) => setTimeout(r, 4000)); /* the API rate-limits volume creation */
      return "attached";
    } catch (e) {
      if (!/too quickly/i.test(e.message)) return `FAILED ${e.message.slice(0, 160)}`;
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
  return "FAILED (rate limited)";
}

/* The supervisor's name is random (scripts/randomize-supervisor.mjs); its record says which it is. */
const SUPERVISOR = existsSync(join(AGENTS_DIR, ".arena-supervisor.json"))
  ? JSON.parse(readFileSync(join(AGENTS_DIR, ".arena-supervisor.json"), "utf8")).service
  : "coordinator";
const services = [SUPERVISOR, ...Array.from({ length: AGENTS }, (_, i) => `agent-${String(i + 1).padStart(2, "0")}`)];
const wanted = ONLY ? services.filter((s) => s === ONLY) : services;

/* 1. the project */
const status = rw(["status", "--json"]);
let linked = null;
try { linked = parseJson(status.out); } catch { /* not linked */ }
if (!linked || linked.name !== PROJECT) {
  console.log(`linking ${AGENTS_DIR} to project "${PROJECT}"`);
  const link = rw(["link", "--project", PROJECT]);
  if (link.code !== 0) {
    console.log(`project "${PROJECT}" not found — creating it`);
    must(["init", "--name", PROJECT], "railway init");
  }
}
const existing = new Set();
try {
  const st = parseJson(rw(["status", "--json"]).out);
  for (const s of st.services?.edges ?? []) existing.add(s.node?.name);
} catch { /* fresh project */ }

/* one token for the executor calls, generated once and reused across runs of this script */
const tokenFile = join(AGENTS_DIR, ".arena-executor-token");
const TOKEN = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : randomBytes(24).toString("hex");
if (!existsSync(tokenFile)) writeFileSync(tokenFile, TOKEN);
const STATUS_TOKEN = existsSync(join(AGENTS_DIR, ".arena-status-token"))
  ? readFileSync(join(AGENTS_DIR, ".arena-status-token"), "utf8").trim()
  : (() => { const t = randomBytes(16).toString("hex"); writeFileSync(join(AGENTS_DIR, ".arena-status-token"), t); return t; })();

/* 2-4. services, volumes, variables */
for (const name of wanted) {
  if (!existing.has(name)) {
    console.log(`creating service ${name}`);
    must(["add", "--service", name], `add ${name}`);
    projectInfo = null; /* a new service id to learn */
  }
  /*
   * Volumes are created through the GraphQL API (see ensureVolume): CLI 4.17 panics on
   * `volume add` for a service that has never deployed, and half-creates a volume each time.
   */
  console.log(`  volume ${name}: ${await ensureVolume(name)}`);

  /* The supervisor keeps its own random PORT; executors listen on 8080. */
  const common = [...(name === SUPERVISOR ? [] : [`PORT=8080`]), `ARENA_EXECUTOR_TOKEN=${TOKEN}`, `NIXPACKS_NODE_VERSION=22`];
  const vars = name === SUPERVISOR
    ? [
        ...common,
        "ARENA_ROLE=coordinator",
        `ARENA_ORIGIN=${ORIGIN}`,
        `ARENA_AGENTS=${AGENTS}`,
        "ARENA_MINUTES=240",
        "ARENA_DIR=/data/arena",
        "ARENA_SANDBOX_ROOT=/data/sandbox",
        "ARENA_EXECUTOR_BASE=http://agent-{{id}}.railway.internal:8080",
        "ARENA_ADVERT_EVERY_MINUTES=20",
        "ARENA_TURN_SECONDS=1",
        "ARENA_GRANT_GAS=0.01",
        "ARENA_GAS_FLOOR=0.003",
        "ARENA_GAS_TOPUP=0.005",
        "ARENA_ETH_USD=3000",

        ...(openaiKey() ? [`OPENAI_API_KEY=${openaiKey()}`] : []),
        ...(operatorKey() ? [`DEPLOYER_PRIVATE_KEY=${operatorKey()}`] : []),
        /* the public sepolia.base.org endpoint allows 25 requests/second; twenty agents exceed it */
        ...(rpcUrl() ? [`ARENA_RPC_URL=${rpcUrl()}`] : []),
      ]
    : [...common, "ARENA_ROLE=executor", `AGENT_ID=${name.replace("agent-", "a")}`, "ARENA_DATA_DIR=/data"];
  const setArgs = ["variables", "--service", name, "--skip-deploys"];
  for (const kv of vars) setArgs.push("--set", kv);
  const v = rw(setArgs);
  console.log(`  variables ${name}: ${v.code === 0 ? "set" : "FAILED " + v.out.slice(0, 200)}`);
}

/* 5. deploy */
if (DEPLOY) {
  for (const name of wanted) {
    process.stdout.write(`deploying ${name} … `);
    const up = rw(["up", "--detach", "--service", name]);
    console.log(up.code === 0 ? "queued" : "FAILED " + up.out.slice(0, 200));
  }
} else {
  console.log("\n(no --deploy: services and variables are in place; run again with --deploy to ship the image)");
}
console.log(`\nexecutor token in ${tokenFile}; status token in .arena-status-token`);
