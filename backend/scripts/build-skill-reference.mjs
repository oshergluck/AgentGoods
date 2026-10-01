#!/usr/bin/env node
/**
 * Regenerate the endpoint reference inside the published Agent Skill.
 *
 * WHY THIS IS GENERATED AND NOT WRITTEN. The skill is what an agent downloads INSTEAD of reading
 * the whole protocol, so an endpoint the skill forgets is an endpoint that agent will never call.
 * A hand-maintained list drifts the first time anybody adds a route, and the drift is silent —
 * exactly the failure that left eight endpoints live and undocumented for months.
 *
 * So the reference is rebuilt from the API's own OpenAPI document, between two markers. Everything
 * outside the markers is prose somebody wrote on purpose and is never touched.
 *
 *     node backend/scripts/build-skill-reference.mjs [origin]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, "..", "data", "skill", "SKILL.md");
const ORIGIN = process.argv[2] ?? "https://agentgoods.ai";

const BEGIN = "<!-- BEGIN GENERATED ENDPOINT REFERENCE -->";
const END = "<!-- END GENERATED ENDPOINT REFERENCE -->";

const res = await fetch(`${ORIGIN}/api/v1/openapi.json`, { headers: { accept: "application/json" } });
if (!res.ok) throw new Error(`could not read the OpenAPI document: ${res.status}`);
const doc = await res.json();

const METHODS = ["get", "post", "put", "patch", "delete"];
const groups = new Map();
let operations = 0;

for (const [path, ops] of Object.entries(doc.paths ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
  for (const [method, op] of Object.entries(ops)) {
    if (!METHODS.includes(method)) continue;
    operations++;
    const tag = (op.tags ?? ["other"])[0];
    if (!groups.has(tag)) groups.set(tag, []);

    const needsKey = Boolean(op.security);
    const params = JSON.stringify(op.parameters ?? []);
    const needsIdem = params.includes("Idempotency");
    const returnsIntent = JSON.stringify(op.responses ?? {}).includes("TransactionIntent");

    const body = op.requestBody?.content?.["application/json"]?.schema;
    const required = body?.required ?? [];
    const fields = Object.keys(body?.properties ?? {});

    groups.get(tag).push({
      method: method.toUpperCase(),
      path,
      summary: (op.summary ?? "").trim(),
      needsKey,
      needsIdem,
      returnsIntent,
      required,
      fields,
    });
  }
}

const lines = [];
lines.push(BEGIN);
lines.push("");
lines.push(`*${operations} operations. Generated from \`${ORIGIN}/api/v1/openapi.json\` — that document is`);
lines.push("authoritative and carries the full request and response schemas.*");
lines.push("");
lines.push("Legend: **key** needs `Authorization: Bearer`. **idem** needs an `Idempotency-Key` header.");
lines.push("**→tx** returns an unsigned transaction you must sign and broadcast yourself.");
lines.push("");

for (const tag of [...groups.keys()].sort()) {
  lines.push(`### ${tag}`);
  lines.push("");
  for (const op of groups.get(tag)) {
    const needs = [op.needsKey ? "key" : "", op.needsIdem ? "idem" : "", op.returnsIntent ? "→tx" : ""]
      .filter(Boolean)
      .join(" ");
    const body = op.fields.length > 0 ? ` {${op.fields.map((f) => (op.required.includes(f) ? `**${f}**` : f)).join(", ")}}` : "";
    lines.push(`- \`${op.method} ${op.path}\`${needs ? ` [${needs}]` : ""}${body}${op.summary ? ` — ${op.summary}` : ""}`);
  }
  lines.push("");
}

lines.push("Bold fields are required. Amounts are always BASE units as decimal **strings**, never");
lines.push("numbers — a float loses precision on a 6-decimal USDC amount and the protocol will not");
lines.push("guess what you meant.");
lines.push("");
lines.push(END);

const current = readFileSync(SKILL, "utf8");
const i = current.indexOf(BEGIN);
const j = current.indexOf(END);
if (i === -1 || j === -1) throw new Error("the generated-reference markers are missing from SKILL.md");

const next = current.slice(0, i) + lines.join("\n") + current.slice(j + END.length);
writeFileSync(SKILL, next);
console.log(`regenerated the endpoint reference: ${operations} operations across ${groups.size} groups`);
