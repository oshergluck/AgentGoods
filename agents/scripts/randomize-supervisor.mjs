#!/usr/bin/env node
/**
 * Give the supervisor (the arena coordinator) an address nobody can guess.
 *
 * The agents' containers share this Railway project's private network, so a service called
 * "coordinator" on port 8080 answering /status is one guess away from any program an agent runs.
 * This renames the service to a random name, moves it to a random port, serves status on a random
 * path behind a new random token, and replaces its public domain with one generated from the new
 * name. The values are written to .arena-supervisor.json (gitignored) and nowhere else.
 *
 *     node scripts/randomize-supervisor.mjs            (uses the service currently named "coordinator"
 *                                                       or the one recorded in .arena-supervisor.json)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = join(AGENTS_DIR, ".arena-supervisor.json");
const token = JSON.parse(readFileSync(join(homedir(), ".railway", "config.json"), "utf8")).user.token;

async function gql(query, variables) {
  const r = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

const status = spawnSync("railway", ["status", "--json"], { cwd: AGENTS_DIR, encoding: "utf8", shell: process.platform === "win32" });
const st = JSON.parse(status.stdout.slice(status.stdout.indexOf("{")));
const projectId = st.id;
const environmentId = st.environments.edges[0].node.id;
const previous = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")).service : "coordinator";
const svc = st.services.edges.map((e) => e.node).find((n) => n.name === previous);
if (!svc) throw new Error(`no service named ${previous}`);

const next = {
  service: `svc-${randomBytes(6).toString("hex")}`,
  port: randomInt(20000, 60000),
  path: `/${randomBytes(16).toString("hex")}`,
  token: randomBytes(32).toString("hex"),
};

await gql(`mutation($id:String!,$input:ServiceUpdateInput!){ serviceUpdate(id:$id, input:$input){ id } }`, {
  id: svc.id,
  input: { name: next.service },
});

/* Drop every public domain it had, then generate a new one on the new port. */
const inst = await gql(
  `query($s:String!,$e:String!){ serviceInstance(serviceId:$s, environmentId:$e){ domains { serviceDomains { id domain } } } }`,
  { s: svc.id, e: environmentId }
);
for (const d of inst.serviceInstance.domains.serviceDomains) {
  await gql(`mutation($id:String!){ serviceDomainDelete(id:$id) }`, { id: d.id });
}
const created = await gql(
  `mutation($input:ServiceDomainCreateInput!){ serviceDomainCreate(input:$input){ domain } }`,
  { input: { serviceId: svc.id, environmentId, targetPort: next.port } }
);
next.url = `https://${created.serviceDomainCreate.domain}`;

const set = spawnSync(
  "railway",
  ["variables", "--service", next.service, "--skip-deploys",
   "--set", `PORT=${next.port}`, "--set", `ARENA_STATUS_PATH=${next.path}`, "--set", `ARENA_STATUS_TOKEN=${next.token}`],
  { cwd: AGENTS_DIR, encoding: "utf8", shell: process.platform === "win32" }
);
if (set.status !== 0) throw new Error("variables: " + (set.stdout + set.stderr).slice(0, 300));

writeFileSync(RECORD, JSON.stringify({ ...next, projectId, serviceId: svc.id }, null, 2));
writeFileSync(join(AGENTS_DIR, ".arena-status-token"), next.token);
console.log(`supervisor renamed ${previous} -> ${next.service}; port, path, token and public domain replaced`);
console.log(`record: ${RECORD} (gitignored)`);
