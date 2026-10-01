/**
 * Every route the server registers is in the OpenAPI document.
 *
 * The OpenAPI document is what an agent reads to learn the API, and it had drifted: about twenty
 * registered routes — including ones the playbook itself recommends, such as the reward-pool deposit
 * — were callable but undocumented, so an agent that trusted the document could not find them. This
 * reads every router source, applies the prefix each router is mounted under, and requires a
 * matching method + path in the served document.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHarness, startChain, deployProtocol, stopChain, type Harness } from "./helpers/harness";

let h: Harness;

before(async () => {
  await startChain();
  await deployProtocol();
  h = await createHarness();
});

after(async () => {
  await h?.stop();
  await stopChain();
});

const ROUTES = path.resolve(__dirname, "..", "src", "api", "routes");

/** Where each router is mounted (src/app.ts). Everything else is under /api/v1. */
function prefixFor(file: string): string {
  const base = path.basename(file);
  if (base === "system.ts") return ""; // mounted at "/" (its paths carry /api/v1 themselves)
  if (base === "auth.ts") return "/api/v1/auth";
  return "/api/v1";
}

function registeredRoutes(): string[] {
  const files: string[] = [];
  (function walk(d: string) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  })(ROUTES);
  const out = new Set<string>();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const prefix = prefixFor(f);
    const re = /router\.(get|post|put|patch|delete)\(\s*(?:\[([^\]]*)\]|"([^"]+)")/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const paths = m[2] ? [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]!) : [m[3]!];
      for (const p of paths) out.add(`${m[1]!.toUpperCase()} ${prefix}${p}`);
    }
  }
  return [...out];
}

const norm = (p: string) => p.replace(/\{[^}]+\}/g, ":x").replace(/:[A-Za-z]+/g, ":x");

test("every registered route is documented in /api/v1/openapi.json", async () => {
  const res = await h.request("GET", "/api/v1/openapi.json");
  assert.equal(res.status, 200);
  const paths = (res.body as { paths: Record<string, Record<string, unknown>> }).paths;
  const documented = new Set<string>();
  for (const [p, ops] of Object.entries(paths)) {
    for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${norm(p)}`);
  }
  const registered = registeredRoutes();
  assert.ok(registered.length > 50, `found ${registered.length} routes; the scan is broken`);
  const missing = registered.filter((r) => {
    const [method, p] = r.split(" ") as [string, string];
    return !documented.has(`${method} ${norm(p)}`);
  });
  assert.deepEqual(missing, [], `registered but not in the OpenAPI document:\n  ${missing.join("\n  ")}`);
});
