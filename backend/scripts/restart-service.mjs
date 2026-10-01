#!/usr/bin/env node
/**
 * Restart a Railway service's running deployment WITHOUT rebuilding it.
 *
 * `railway redeploy` rebuilds the whole image — about seven minutes for the backend — which a
 * database wipe does not need: the code is unchanged, only the process has to start again so the
 * indexer rebuilds from the deployment block. This asks the API to restart the latest successful
 * deployment instead, which takes seconds.
 *
 *     node scripts/restart-service.mjs backend          (run from backend/, linked to its project)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const serviceName = process.argv[2];
if (!serviceName) {
  console.error("usage: restart-service.mjs <service name>");
  process.exit(1);
}
const token = JSON.parse(readFileSync(`${homedir()}/.railway/config.json`, "utf8")).user.token;
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

const out = spawnSync("railway", ["status", "--json"], { encoding: "utf8", shell: process.platform === "win32" }).stdout;
const status = JSON.parse(out.slice(out.indexOf("{")));
const environmentId = status.environments.edges[0].node.id;
const service = status.services.edges.map((e) => e.node).find((n) => n.name === serviceName);
if (!service) throw new Error(`no service named ${serviceName} in this project`);

const list = await gql(
  `query($s:String!,$e:String!){ deployments(first:10, input:{serviceId:$s, environmentId:$e}){ edges{ node{ id status createdAt } } } }`,
  { s: service.id, e: environmentId }
);
const live = list.deployments.edges.map((e) => e.node).find((d) => d.status === "SUCCESS");
if (!live) throw new Error(`${serviceName} has no successful deployment to restart`);
await gql(`mutation($id:String!){ deploymentRestart(id:$id) }`, { id: live.id });
console.log(`restarted ${serviceName} deployment ${live.id} (from ${live.createdAt}) without a rebuild`);
