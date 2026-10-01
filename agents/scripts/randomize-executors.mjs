#!/usr/bin/env node
/**
 * Give every agent's container a name, a port and a token nobody else can guess.
 *
 * Services called agent-01 … agent-20 on port 8080 are addressable by counting from inside any of
 * them. This renames each to svc-<random>, renames its private DNS name to match, moves it to a
 * random port, gives it a token of its own, and writes the map the supervisor uses
 * (ARENA_EXECUTOR_MAP, set on the supervisor only) plus a local record, .arena-executors.json,
 * which is gitignored. Idempotent: a service already in the record is re-randomized in place.
 *
 *     node scripts/randomize-executors.mjs --agents 20
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = join(AGENTS_DIR, ".arena-executors.json");
const SUPERVISOR = JSON.parse(readFileSync(join(AGENTS_DIR, ".arena-supervisor.json"), "utf8")).service;
const argv = process.argv.slice(2);
const AGENTS = Number(argv[argv.indexOf("--agents") + 1] ?? 20);
const cliToken = JSON.parse(readFileSync(join(homedir(), ".railway", "config.json"), "utf8")).user.token;

async function gql(query, variables) {
  const r = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cliToken}` },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}
function rw(args) {
  const r = spawnSync("railway", args, { cwd: AGENTS_DIR, encoding: "utf8", shell: process.platform === "win32" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const st = JSON.parse(rw(["status", "--json"]).out.replace(/^[^{]*/, ""));
const environmentId = st.environments.edges[0].node.id;
const byName = Object.fromEntries(st.services.edges.map((e) => [e.node.name, e.node.id]));
const previous = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : {};
const net = (await gql(`query($e:String!){ privateNetworks(environmentId:$e){ publicId } }`, { e: environmentId })).privateNetworks[0].publicId;

const record = {};
for (let i = 1; i <= AGENTS; i++) {
  const agentId = `a${String(i).padStart(2, "0")}`;
  const currentName = previous[agentId]?.service ?? `agent-${String(i).padStart(2, "0")}`;
  const serviceId = byName[currentName];
  if (!serviceId) throw new Error(`no service ${currentName} for ${agentId}`);
  const next = {
    service: `svc-${randomBytes(6).toString("hex")}`,
    port: randomInt(20000, 60000),
    token: randomBytes(32).toString("hex"),
    serviceId,
  };
  await gql(`mutation($id:String!,$input:ServiceUpdateInput!){ serviceUpdate(id:$id, input:$input){ id } }`, { id: serviceId, input: { name: next.service } });
  const ep = await gql(
    `query($e:String!,$n:String!,$s:String!){ privateNetworkEndpoint(environmentId:$e, privateNetworkId:$n, serviceId:$s){ publicId } }`,
    { e: environmentId, n: net, s: serviceId }
  );
  await gql(`mutation($d:String!,$id:String!,$n:String!){ privateNetworkEndpointRename(dnsName:$d, id:$id, privateNetworkId:$n) }`, {
    d: next.service, id: ep.privateNetworkEndpoint.publicId, n: net,
  });
  const v = rw(["variables", "--service", next.service, "--skip-deploys",
    "--set", `PORT=${next.port}`, "--set", `ARENA_EXECUTOR_TOKEN=${next.token}`, "--set", `AGENT_ID=${agentId}`]);
  if (v.code !== 0) throw new Error(`variables for ${next.service}: ${v.out.slice(0, 200)}`);
  record[agentId] = { ...next, url: `http://${next.service}.railway.internal:${next.port}` };
  console.log(`${agentId}: ${currentName} -> ${next.service}`);
}

const map = Object.fromEntries(Object.entries(record).map(([id, r]) => [id, { url: r.url, token: r.token }]));
/* Through the API, not the CLI: on Windows the shell strips the JSON's quotes on the way in. */
const supervisorId = byName[SUPERVISOR];
await gql(`mutation($input:VariableUpsertInput!){ variableUpsert(input:$input) }`, {
  input: { projectId: st.id, environmentId, serviceId: supervisorId, name: "ARENA_EXECUTOR_MAP", value: JSON.stringify(map), skipDeploys: true },
});
writeFileSync(RECORD, JSON.stringify(record, null, 2));
console.log(`map set on the supervisor; record in ${RECORD} (gitignored)`);
