#!/usr/bin/env node
/**
 * Generates the reference matrices from the source of truth.
 *
 *     node infra/scripts/generate-docs.mjs
 *
 * `CONTRACT_MATRIX.md`, `EVENT_MATRIX.md` and `RPC_CALL_MAP.md` are all documents whose entire
 * value is being ACCURATE. A hand-maintained list of every event, or of every RPC call site, is
 * wrong within a week and then actively misleading — someone reads it, believes it, and makes a
 * decision on a list that stopped matching the code two features ago.
 *
 * So they are derived: from the deployment manifest, from the ABIs the deployment actually wrote,
 * from the indexer's watched-event map, and from the RPC call sites in the backend. Regenerating
 * is cheap and CI can assert they are current.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const DOCS = join(ROOT, "docs");
const ABI_DIR = join(ROOT, "deployments", "abi");

const GENERATED_NOTE = (source) =>
  `> **Generated file.** Produced by \`node infra/scripts/generate-docs.mjs\` from ${source}.\n` +
  `> Do not edit by hand: the next regeneration will overwrite it, and a hand-edited matrix that\n` +
  `> disagrees with the code is worse than no matrix at all.\n`;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function walk(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (["node_modules", "dist", "artifacts", "cache", ".git"].includes(entry)) continue;
      walk(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

/* ------------------------------------------------------------ contract matrix */

function generateContractMatrix() {
  const manifestFile = join(ROOT, "deployments", "31337.json");
  if (!existsSync(manifestFile)) return null;
  const m = readJson(manifestFile);
  const c = m.contracts;

  const lines = [];
  lines.push("# Contract matrix");
  lines.push("");
  lines.push(GENERATED_NOTE("`deployments/<chainId>.json` and `deployments/abi/`"));
  lines.push("");
  lines.push(
    "Every contract the protocol deploys, how it is deployed, whether it can be upgraded, and " +
      "what that means for anyone holding value in it."
  );
  lines.push("");
  lines.push(`Generated from the \`${m.chainId}\` manifest (${m.environment}), protocol version ${m.protocolVersion}.`);
  lines.push("");

  lines.push("## Upgradeable core");
  lines.push("");
  lines.push("| Contract | Proxy | Implementation | Standard | Upgradeable |");
  lines.push("|---|---|---|---|---|");
  for (const [name, entry] of Object.entries(c)) {
    if (!entry || typeof entry !== "object" || !entry.proxy) continue;
    lines.push(
      `| ${name} | \`${entry.proxy}\` | \`${entry.implementation}\` | ${entry.proxyStandard ?? "-"} | ${entry.upgradeable ? "yes" : "no"} |`
    );
  }
  lines.push("");
  lines.push(
    "An upgradeable contract can change behaviour under existing holders. Only the Registry and " +
      "AgentGoods are upgradeable, and both are behind a timelock in production. Everything a store " +
      "owns is immutable — see below."
  );
  lines.push("");

  lines.push("## Immutable singletons");
  lines.push("");
  lines.push("| Contract | Address | Runtime code hash |");
  lines.push("|---|---|---|");
  if (c.protocolTreasury) {
    lines.push(`| protocolTreasury | \`${c.protocolTreasury.address}\` | \`${c.protocolTreasury.runtimeCodeHash}\` |`);
  }
  for (const f of c.activeFactories ?? []) {
    lines.push(`| StoreFactory v${f.version} (${f.status}) | \`${f.address}\` | \`${f.runtimeCodeHash}\` |`);
  }
  for (const f of c.deprecatedFactories ?? []) {
    lines.push(`| StoreFactory v${f.version} (DEPRECATED) | \`${f.address}\` | \`${f.runtimeCodeHash}\` |`);
  }
  lines.push("");

  lines.push("## Per-store components (EIP-1167 clones)");
  lines.push("");
  lines.push(
    "Each store gets its own instance of every one of these, created atomically by the Factory in " +
      "a single transaction. They are minimal-proxy clones of a fixed implementation, so they are " +
      "cheap to create and **cannot be upgraded**: what a store owner deploys is what they keep."
  );
  lines.push("");
  lines.push("| Component | Contract | Implementation | Runtime code hash |");
  lines.push("|---|---|---|---|");
  for (const [label, entry] of Object.entries(c.componentImplementations ?? {})) {
    lines.push(`| ${label} | ${entry.contract} | \`${entry.address}\` | \`${entry.runtimeCodeHash}\` |`);
  }
  lines.push("");
  lines.push(
    "The runtime code hash is what makes provenance checkable: an Agent can confirm that a store " +
      "component is a clone of the exact implementation listed here, rather than a contract that " +
      "merely presents the same interface."
  );
  lines.push("");

  lines.push("## External dependencies");
  lines.push("");
  lines.push("| Role | Address | Notes |");
  lines.push("|---|---|---|");
  lines.push(`| canonical USDC | \`${m.external.canonicalUSDC}\` | ${m.external.usdcDecimals} decimals |`);
  lines.push(`| DEX router | \`${m.external.dexRouter}\` | UniswapV2-compatible |`);
  lines.push(`| DEX factory | \`${m.external.dexFactory}\` | |`);
  lines.push(`| LP burn address | \`${m.external.lpBurnAddress}\` | LP tokens are sent here at the transition and locked forever |`);
  lines.push(`| mock external infrastructure | ${m.external.isMockExternal ? "**YES — LOCAL ONLY**" : "no"} | the deployment gate refuses a true value off LOCAL |`);
  lines.push("");

  return lines.join("\n");
}

/* --------------------------------------------------------------- event matrix */

function generateEventMatrix() {
  if (!existsSync(ABI_DIR)) return null;

  // The indexer's watched set, read from its source so the doc cannot claim to watch an event the
  // indexer ignores.
  const abisSource = readFileSync(join(ROOT, "backend", "src", "indexer", "abis.ts"), "utf8");
  const watchedBlock = abisSource.slice(
    abisSource.indexOf("WATCHED_EVENTS"),
    abisSource.indexOf("};", abisSource.indexOf("WATCHED_EVENTS"))
  );
  const watched = new Set([...watchedBlock.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]));

  const lines = [];
  lines.push("# Event matrix");
  lines.push("");
  lines.push(GENERATED_NOTE("`deployments/abi/*.json` and `backend/src/indexer/abis.ts`"));
  lines.push("");
  lines.push(
    "Every event the contracts emit, and whether the indexer watches it. An unwatched event is " +
      "not a bug by itself — plenty of events exist for on-chain consumers or for explorers — but " +
      "an event that a projection depends on and that nobody watches is exactly the failure that " +
      "produces a silently stale read model."
  );
  lines.push("");

  const files = readdirSync(ABI_DIR).filter((f) => f.endsWith(".json")).sort();
  let total = 0;
  let watchedCount = 0;

  for (const file of files) {
    const abi = readJson(join(ABI_DIR, file));
    const events = abi.filter((f) => f.type === "event");
    if (events.length === 0) continue;

    lines.push(`## ${file.replace(".json", "")}`);
    lines.push("");
    lines.push("| Event | Indexed by | Signature |");
    lines.push("|---|---|---|");
    for (const e of events.sort((a, b) => a.name.localeCompare(b.name))) {
      total += 1;
      const isWatched = watched.has(e.name);
      if (isWatched) watchedCount += 1;
      const args = e.inputs
        .map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`)
        .join(", ");
      lines.push(`| \`${e.name}\` | ${isWatched ? "**yes**" : "no"} | \`(${args})\` |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(`${watchedCount} of ${total} events are watched by the indexer.`);
  lines.push("");
  lines.push(
    "Event identity is `(chainId, txHash, logIndex)` everywhere: that tuple is what makes " +
      "projection exactly-once, what makes webhook delivery deduplicate, and what makes a reorg " +
      "rollback exact rather than approximate."
  );
  lines.push("");

  return lines.join("\n");
}

/* -------------------------------------------------------------- RPC call map */

function generateRpcCallMap() {
  const backendSrc = join(ROOT, "backend", "src");
  const files = walk(backendSrc, (f) => f.endsWith(".ts"));

  const callSites = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      // Every RPC path in this backend goes through the provider pool or an ethers Contract read.
      const match =
        /providers\.call\(\s*"([a-zA-Z_]+)"/.exec(line) ??
        /provider\.(getBlockNumber|getBlock|getLogs|getCode|call|getTransactionReceipt|send)\(/.exec(line);
      if (!match) continue;
      callSites.push({
        file: relative(ROOT, file).replace(/\\/g, "/"),
        line: index + 1,
        method: match[1],
      });
    }
  }

  const byFile = new Map();
  for (const site of callSites) {
    const list = byFile.get(site.file) ?? [];
    list.push(site);
    byFile.set(site.file, list);
  }

  const lines = [];
  lines.push("# RPC call map");
  lines.push("");
  lines.push(GENERATED_NOTE("the RPC call sites in `backend/src`"));
  lines.push("");
  lines.push(
    "**Rule 14: a GET request never reaches the chain.** Reads are served from the indexed " +
      "projection. RPC belongs to the indexer, to write-path preflight, and to reconciliation — " +
      "never to a read a user or Agent is waiting on."
  );
  lines.push("");
  lines.push(
    "This is enforced by test, not by convention: the route suites arm `forbidRpc()` and fail if " +
      "any read path touches a provider. This map exists so a reviewer can see the whole surface " +
      "at once rather than trusting that the test covers every route."
  );
  lines.push("");
  lines.push("| File | Line | Method | Layer |");
  lines.push("|---|---:|---|---|");

  const layerOf = (file) => {
    if (file.includes("/indexer/")) return "indexer (allowed)";
    if (file.includes("/rpc/")) return "provider pool";
    if (file.includes("/transactions/")) return "write preflight (allowed)";
    if (file.includes("/dividends/")) return "root generation (allowed)";
    if (file.includes("/api/routes/")) return "**API route — must be a write path**";
    return "other";
  };

  for (const [file, sites] of [...byFile.entries()].sort()) {
    for (const site of sites) {
      lines.push(`| \`${file}\` | ${site.line} | \`${site.method}\` | ${layerOf(file)} |`);
    }
  }
  lines.push("");
  lines.push(`${callSites.length} RPC call site(s) across ${byFile.size} file(s).`);
  lines.push("");

  return lines.join("\n");
}

/* --------------------------------------------------------------------- main */

const outputs = [
  ["CONTRACT_MATRIX.md", generateContractMatrix()],
  ["EVENT_MATRIX.md", generateEventMatrix()],
  ["RPC_CALL_MAP.md", generateRpcCallMap()],
];

let written = 0;
for (const [name, content] of outputs) {
  if (!content) {
    // eslint-disable-next-line no-console
    console.warn(`  skipped ${name}: inputs not available (deploy locally first)`);
    continue;
  }
  writeFileSync(join(DOCS, name), `${content}\n`, "utf8");
  written += 1;
  // eslint-disable-next-line no-console
  console.log(`  wrote docs/${name}`);
}

// eslint-disable-next-line no-console
console.log(`generate-docs: ${written} document(s) regenerated from source.`);
