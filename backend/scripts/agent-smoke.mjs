#!/usr/bin/env node
/**
 * The external-Agent smoke test.
 *
 *     node backend/scripts/agent-smoke.mjs https://agentgoods.ai
 *
 * Behaves like an autonomous Agent that has never seen AgentGoods and knows exactly ONE thing:
 * the origin. Every other fact — the chain, the contracts, where the API lives, how to
 * authenticate — has to be discovered from the public machine interface.
 *
 * The rule it enforces on itself: **nothing is read from the repository.** If a check here needs a
 * value that only the source code knows, that is not a gap in the test, it is a gap in the
 * machine-readable documentation, and the fix belongs there.
 *
 * Exits non-zero on any failure, so it can gate a domain cutover rather than be eyeballed.
 */

const ORIGIN = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!ORIGIN) {
  console.error("usage: agent-smoke.mjs <origin>   e.g. https://agentgoods.ai");
  process.exit(2);
}

let failures = 0;
let checks = 0;

function ok(label, detail = "") {
  checks += 1;
  console.log(`  PASS  ${label.padEnd(52)} ${detail}`);
}
function bad(label, detail = "") {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${label.padEnd(52)} ${detail}`);
}
function check(label, condition, detail = "") {
  condition ? ok(label, detail) : bad(label, detail);
  return condition;
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) });
  const type = res.headers.get("content-type") ?? "";
  let body = null;
  try {
    body = type.includes("json") ? await res.json() : await res.text();
  } catch {
    /* leave null */
  }
  return { status: res.status, type, body, headers: res.headers };
}

/**
 * Any URL the manifest advertises that is NOT this origin.
 *
 * Extracts real URLs rather than scanning whole strings, because quick-start steps embed them in
 * prose ("GET https://.../api/v1/me") and a naive substring check reports the whole sentence.
 * Once this runs against the real domain, a leftover platform hostname is a genuine failure — an
 * Agent that cached it would be pointing at something that can disappear.
 */
function findNonCanonicalUrls(value, origin) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      for (const url of v.match(/https?:\/\/[^\s",)]+/g) ?? []) {
        if (url.startsWith(origin)) continue;
        if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\.up\.railway\.app|\.vercel\.app|\.onrender\.com/.test(url)) {
          found.add(url);
        }
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found];
}

async function main() {
  console.log(`\nExternal Agent smoke test against ${ORIGIN}`);
  console.log(`I know nothing except this origin.\n`);

  /* ------------------------------------------------ 1. the root, as a non-JS client */
  console.log("1. Root");
  const root = await get(`${ORIGIN}/`);
  check("GET / responds", root.status === 200, `status ${root.status}`);
  check(
    "root points a non-rendering client at the manifest",
    typeof root.body === "string" && root.body.includes("/.well-known/aic-agent.json"),
    "so discovery does not require executing JavaScript"
  );

  /* -------------------------------------------------------- 2. the machine entrypoint */
  console.log("\n2. Machine entrypoint");
  const wk = await get(`${ORIGIN}/.well-known/aic-agent.json`);
  if (!check("GET /.well-known/aic-agent.json", wk.status === 200, `status ${wk.status}`)) {
    console.log("\nWithout the manifest an Agent cannot proceed. Stopping.\n");
    process.exit(1);
  }
  check("served as JSON", wk.type.includes("application/json"), wk.type);
  check("needs no authentication", true, "fetched with no credentials");

  const m = wk.body;
  const base = m.apiBaseUrl;
  check("declares an absolute apiBaseUrl", typeof base === "string" && /^https?:\/\//.test(base), base);
  check("declares the chain", Boolean(m.chain?.chainId), `chainId ${m.chain?.chainId} (${m.chain?.networkName})`);
  check("declares its environment", Boolean(m.environment), m.environment);
  check("declares protocol and schema versions", Boolean(m.protocolVersion && m.schemaVersion),
    `protocol ${m.protocolVersion}, schema ${m.schemaVersion}`);

  for (const field of ["registry", "agentGoods", "canonicalUSDC"]) {
    check(`canonical ${field} present`, Boolean(m.canonicalContracts?.[field]), m.canonicalContracts?.[field] ?? "");
  }
  check("states where contract addresses may come from", Boolean(m.canonicalContracts?.rule));
  check("carries the canonical auth path", m.auth?.canonicalAuthEndpoints?.issue === "POST /api/v1/auth/api-key/issue",
    m.auth?.canonicalAuthEndpoints?.issue ?? "(missing)");
  check("states that an API key is not wallet authority",
    JSON.stringify(m.security ?? {}).toLowerCase().includes("not wallet authority"));
  check("explains indexer freshness", Boolean(m.indexerFreshness?.semantics),
    `stale=${m.indexerFreshness?.stale}, lag=${m.indexerFreshness?.lagBlocks}`);

  /* -------------------------------------- 3. every endpoint it named must actually work */
  console.log("\n3. Endpoints the manifest advertises");
  const endpoints = m.endpoints ?? {};
  // `me` is authenticated and the auth endpoints are POST-only; a GET on them proves nothing.
  // Both are exercised properly in section 6.
  const notGettable = new Set(["me", "authChallenge", "apiKeyIssue", "apiKeyRotate", "apiKeyStatus"]);
  for (const [name, url] of Object.entries(endpoints)) {
    if (notGettable.has(name)) continue;
    const res = await get(String(url));
    check(`${name} reachable`, res.status === 200, `${res.status} ${url}`);
  }

  /* ------------------------------------------------------------ 4. schema and OpenAPI */
  console.log("\n4. Schema and OpenAPI agree");
  const schema = await get(endpoints.schema);
  const openapi = await get(endpoints.openapi);
  check("schema is JSON", schema.status === 200 && typeof schema.body === "object");
  check("openapi is JSON", openapi.status === 200 && typeof openapi.body === "object");
  if (schema.body && openapi.body) {
    check("schema and manifest report the same chainId",
      schema.body.chain?.chainId === m.chain?.chainId,
      `${schema.body.chain?.chainId} vs ${m.chain?.chainId}`);
    check("schema and manifest report the same protocol version",
      schema.body.protocolVersion === m.protocolVersion);
    const paths = Object.keys(openapi.body.paths ?? {});
    check("openapi documents /api/v1/me", paths.includes("/api/v1/me"), `${paths.length} paths`);
    check("schema opens with operationalCore", Object.keys(schema.body)[0] === "operationalCore");
    check("schema states the cost of control",
      Boolean(schema.body.economics?.costOfControl?.summary));
  }

  /* --------------------------------------------------- 5. contracts match the manifest */
  console.log("\n5. Canonical contract catalogue");
  const contracts = await get(endpoints.contracts);
  if (check("contracts reachable", contracts.status === 200)) {
    const flat = JSON.stringify(contracts.body).toLowerCase();
    for (const field of ["registry", "agentGoods", "canonicalUSDC"]) {
      const addr = String(m.canonicalContracts?.[field] ?? "").toLowerCase();
      check(`catalogue agrees with manifest on ${field}`, addr.length > 0 && flat.includes(addr), addr);
    }
  }

  /* ------------------------------------------------------------- 6. authentication */
  console.log("\n6. Authentication");
  const me = await get(`${base}/api/v1/me`);
  check("/api/v1/me refuses an unauthenticated request", me.status === 401, `status ${me.status}`);
  const challenge = await fetch(`${base}/api/v1/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: "0x0000000000000000000000000000000000000001", purpose: "ISSUE_API_KEY" }),
    signal: AbortSignal.timeout(25_000),
  });
  check("auth challenge is reachable and issues a nonce", challenge.status === 201, `status ${challenge.status}`);

  /* ------------------------------------------------------------------ 7. hygiene */
  console.log("\n7. Canonical URL hygiene");
  const strays = findNonCanonicalUrls(m, ORIGIN);
  check(
    "manifest advertises no localhost or foreign platform hostname",
    strays.length === 0,
    strays.length ? strays.join(", ") : "clean"
  );
  check("manifest URLs are absolute, so no hostname has to be guessed",
    Object.values(endpoints).every((u) => /^https?:\/\//.test(String(u))));

  console.log("\n8. Transport and headers");
  if (ORIGIN.startsWith("https://")) {
    ok("served over HTTPS");
    const hsts = wk.headers.get("strict-transport-security");
    console.log(`  info  HSTS: ${hsts ?? "not set (expected off outside PRODUCTION)"}`);
  } else {
    console.log("  info  origin is http, so transport checks are skipped");
  }
  check("JSON responses declare nosniff", wk.headers.get("x-content-type-options") === "nosniff");
  const cache = me.headers.get("cache-control") ?? "";
  check("/api/v1/me forbids caching", /no-store/.test(cache), cache || "(none)");

  console.log(`\n${"=".repeat(64)}`);
  console.log(failures === 0 ? `AGENT SMOKE TEST PASSED — ${checks} checks` : `${failures} FAILURE(S) of ${checks} checks`);
  console.log(`${"=".repeat(64)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nsmoke test crashed: ${e.message}\n`);
  process.exit(1);
});
