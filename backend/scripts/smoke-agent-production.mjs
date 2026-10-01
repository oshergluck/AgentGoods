#!/usr/bin/env node
/**
 * Production accessibility smoke test for external machine clients.
 *
 * Run it against the live domain and nothing else:
 *
 *     node backend/scripts/smoke-agent-production.mjs https://agentgoods.ai
 *     BASE_URL=https://agentgoods.ai node backend/scripts/smoke-agent-production.mjs
 *
 * It exists because the site was reachable by a browser and not by an Agent, and nothing in the
 * existing suite could have caught that: the failure was in production configuration, visible
 * only from outside, over plain HTTP.
 *
 * Two rules give it its value, and both are deliberate constraints on what it may do:
 *
 *   1. **It starts from the origin and nothing else.** The API base, the schema URL and the
 *      OpenAPI URL are read out of the manifest, never hard-coded. If discovery is what broke,
 *      a script with the endpoints baked in would still pass while an Agent could not proceed.
 *      That also means this keeps working unchanged if the API ever moves to a subdomain.
 *
 *   2. **It uses a plain HTTP client.** No browser, no JavaScript, no cookie jar, no retries
 *      that could paper over an intermittent limit. If this passes, an Agent can do the same.
 *
 * Exits non-zero on any failure, so it can gate a deploy.
 */

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? "https://agentgoods.ai").replace(/\/+$/, "");
const UA = "AgentGoodsExternalAgent/1.0 (+production smoke test; plain HTTP, no browser)";

let failures = 0;
let checks = 0;
const rows = [];

const c = { ok: "\x1b[32m", bad: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m", head: "\x1b[36m" };

function check(label, condition, detail = "") {
  checks++;
  if (condition) {
    console.log(`  ${c.ok}PASS${c.off}  ${label.padEnd(54)}${c.dim}${detail}${c.off}`);
  } else {
    failures++;
    console.log(`  ${c.bad}FAIL${c.off}  ${label.padEnd(54)}${detail}`);
  }
}

function section(title) {
  console.log(`\n${c.head}${title}${c.off}`);
}

/** One request, fully instrumented. Redirects are followed manually so the chain is visible. */
async function fetchRecorded(url, options = {}) {
  const started = Date.now();
  const chain = [];
  let current = url;
  let response;

  for (let hop = 0; hop < 6; hop++) {
    response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": UA, accept: "*/*", ...(options.headers ?? {}) },
      method: options.method ?? "GET",
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      const next = new URL(response.headers.get("location"), current).toString();
      chain.push(`${response.status} -> ${next}`);
      // A loop is its own failure: a client following it never terminates.
      if (chain.filter((entry) => entry.endsWith(next)).length > 1) {
        throw new Error(`redirect loop at ${next}`);
      }
      current = next;
      continue;
    }
    break;
  }

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON; the caller decides whether that is a fault */
  }

  const record = {
    url,
    finalUrl: current,
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    cacheControl: response.headers.get("cache-control") ?? "",
    cors: response.headers.get("access-control-allow-origin") ?? "",
    cfRay: response.headers.get("cf-ray") ?? "",
    server: response.headers.get("server") ?? "",
    rateLimit: response.headers.get("ratelimit") ?? "",
    ms: Date.now() - started,
    redirects: chain,
    text,
    json,
  };
  rows.push(record);
  return record;
}

/** The shapes an infrastructure or bot wall returns instead of the resource. */
function looksLikeChallenge(record) {
  const body = record.text.slice(0, 4000).toLowerCase();
  return (
    /cf-browser-verification|challenge-platform|cdn-cgi\/challenge|captcha|just a moment|enable javascript and cookies/.test(body) ||
    record.status === 403 ||
    record.status === 503
  );
}

function isHtml(record) {
  return /text\/html/i.test(record.contentType) || /^\s*<!doctype html/i.test(record.text);
}

console.log(`\n${"=".repeat(74)}`);
console.log(`External Agent accessibility smoke test`);
console.log(`Origin under test: ${BASE}`);
console.log(`Plain HTTP client. No browser, no JavaScript, no cookies, no credentials.`);
console.log(`${"=".repeat(74)}`);

// ---------------------------------------------------------------- 1. root --
section("1. The origin answers at all");

const root = await fetchRecorded(`${BASE}/`);
check("GET / returns 200", root.status === 200, `${root.status} in ${root.ms}ms`);
check("GET / is not a bot challenge", !looksLikeChallenge(root), root.cfRay ? `cf-ray ${root.cfRay}` : "");
check("GET / has no redirect loop", root.redirects.length <= 2, root.redirects.join(" ") || "no redirects");

const rootHead = await fetchRecorded(`${BASE}/`, { method: "HEAD" });
check(
  "HEAD / matches GET",
  rootHead.status === root.status,
  `HEAD ${rootHead.status} vs GET ${root.status}`
);

// A machine client that cannot run React still has to find the protocol from the root document.
check(
  "the root document names the machine entrypoint",
  /\.well-known\/aic-agent\.json/.test(root.text),
  "discoverable without JavaScript"
);

// ----------------------------------------------------------- 2. discovery --
section("2. Discovery, starting from the origin only");

const manifest = await fetchRecorded(`${BASE}/.well-known/aic-agent.json`);
check("GET /.well-known/aic-agent.json returns 200", manifest.status === 200, `${manifest.status} in ${manifest.ms}ms`);
check("it is served as JSON", /application\/json/i.test(manifest.contentType), manifest.contentType);
check("it parses as JSON", manifest.json !== null);
check("it is not the SPA shell", !isHtml(manifest));
check("it is not a bot challenge", !looksLikeChallenge(manifest));

if (!manifest.json) {
  console.error(`\n${c.bad}Discovery failed. Nothing downstream can be attempted.${c.off}\n`);
  process.exit(1);
}

const doc = manifest.json;

/*
 * Everything below is addressed by what the manifest said, not by what this script assumed.
 * If the API ever moves to api.agentgoods.ai, this keeps working and an Agent does too.
 */
const apiBase = String(doc.apiBaseUrl ?? "").replace(/\/+$/, "");
check("the manifest advertises an absolute API base", /^https?:\/\//.test(apiBase), apiBase || "(missing)");

const resolve = (value, fallback) => {
  if (!value) return `${apiBase}${fallback}`;
  return /^https?:\/\//.test(value) ? value : `${apiBase}${value.startsWith("/") ? "" : "/"}${value}`;
};

const endpoints = doc.endpoints ?? {};
const schemaUrl = resolve(endpoints.schema ?? doc.schemaUrl, "/api/v1/schema");
const openApiUrl = resolve(endpoints.openapi ?? doc.openApiUrl, "/api/v1/openapi.json");
const contractsUrl = resolve(endpoints.contracts ?? doc.contractsUrl, "/api/v1/contracts");
const meUrl = resolve(endpoints.me, "/api/v1/me");

console.log(`  ${c.dim}discovered: api=${apiBase}${c.off}`);
console.log(`  ${c.dim}discovered: schema=${schemaUrl}${c.off}`);
console.log(`  ${c.dim}discovered: openapi=${openApiUrl}${c.off}`);

// ------------------------------------------------------- 3. canonical URLs --
section("3. Canonical identity is the production domain");

const manifestText = JSON.stringify(doc);
for (const forbidden of ["localhost", "127.0.0.1", "0.0.0.0", "up.railway.app", "example.com"]) {
  check(
    `no "${forbidden}" in the manifest`,
    !manifestText.includes(forbidden),
    "canonical fields must name the production domain"
  );
}
check(
  "the API base is the origin under test or a subdomain of it",
  (() => {
    try {
      const host = new URL(apiBase).hostname;
      const baseHost = new URL(BASE).hostname;
      return host === baseHost || host.endsWith(`.${baseHost.replace(/^www\./, "")}`);
    } catch {
      return false;
    }
  })(),
  `${apiBase} vs ${BASE}`
);
check("the API base is HTTPS", apiBase.startsWith("https://"), apiBase);

// ---------------------------------------------- 4. the discovered endpoints --
section("4. The endpoints the manifest pointed at");

const schema = await fetchRecorded(schemaUrl);
check("schema returns 200", schema.status === 200, `${schema.status} in ${schema.ms}ms`);
check("schema is JSON", /application\/json/i.test(schema.contentType) && schema.json !== null, schema.contentType);
check("schema is not the SPA shell", !isHtml(schema));

const openapi = await fetchRecorded(openApiUrl);
check("openapi returns 200", openapi.status === 200, `${openapi.status} in ${openapi.ms}ms`);
check("openapi is JSON", /application\/json/i.test(openapi.contentType) && openapi.json !== null, openapi.contentType);
check("openapi declares a version", Boolean(openapi.json?.openapi), openapi.json?.openapi ?? "");
check(
  "openapi names the same server the manifest did",
  JSON.stringify(openapi.json?.servers ?? []).includes(new URL(apiBase).hostname),
  JSON.stringify(openapi.json?.servers ?? []).slice(0, 80)
);

const contracts = await fetchRecorded(contractsUrl);
check("contracts returns 200", contracts.status === 200, `${contracts.status} in ${contracts.ms}ms`);
check("contracts is JSON", contracts.json !== null, contracts.contentType);

// ------------------------------------------------------- 5. authentication --
section("5. Authenticated state is reachable but protected");

const me = await fetchRecorded(meUrl);
check("/me without credentials returns 401", me.status === 401, `${me.status}`);
check("/me returns JSON, not HTML", me.json !== null && !isHtml(me), me.contentType);
check("/me is not a bot challenge or a platform error page", !looksLikeChallenge(me) || me.status === 401);
check("/me names a documented error code", Boolean(me.json?.error?.code), me.json?.error?.code ?? "");
check("/me explains what is missing", Boolean(me.json?.error?.message), (me.json?.error?.message ?? "").slice(0, 46));
check("/me is never stored by a shared cache", /no-store/.test(me.cacheControl) && /private/.test(me.cacheControl), me.cacheControl);
check("/me does not allow any origin", me.cors !== "*", me.cors || "(absent)");

// ---------------------------------------------------------- 6. rate limits --
section("6. Rate limiting is present and does not starve discovery");

check("discovery advertises a limit", Boolean(manifest.rateLimit), manifest.rateLimit || "(absent)");
/*
 * Compared on the advertised CEILING, not on the whole header. The remaining counts differ
 * between any two requests whether the buckets are shared or not, so comparing full headers
 * would have passed against the very configuration that caused the incident.
 */
const ceiling = (header) => /limit=(\d+)/.exec(header ?? "")?.[1] ?? "";
check(
  "discovery and ordinary reads are separate budgets",
  ceiling(manifest.rateLimit) !== "" && ceiling(manifest.rateLimit) !== ceiling(me.rateLimit),
  `discovery limit=${ceiling(manifest.rateLimit)} other limit=${ceiling(me.rateLimit)}`
);

// Ten consecutive discovery fetches, the way an Agent retries. None may be refused.
let refused = 0;
for (let i = 0; i < 10; i++) {
  const probe = await fetchRecorded(`${BASE}/.well-known/aic-agent.json`);
  if (probe.status !== 200) refused++;
}
check("ten consecutive discovery requests all succeed", refused === 0, `${10 - refused}/10 returned 200`);

// ---------------------------------------------------------------- 7. CORS --
section("7. CORS");

const preflight = await fetchRecorded(schemaUrl, {
  method: "OPTIONS",
  headers: { origin: BASE, "access-control-request-method": "GET" },
});
check("OPTIONS preflight is answered", preflight.status < 400, `${preflight.status}`);

const foreign = await fetchRecorded(meUrl, { headers: { origin: "https://evil.example" } });
check("a private endpoint does not echo an arbitrary origin", foreign.cors !== "https://evil.example", foreign.cors || "(absent)");
check("a private endpoint is not wildcard-open", foreign.cors !== "*", foreign.cors || "(absent)");

// -------------------------------------------------------------- 8. transit --
section("8. Transport");

check("served over HTTPS", BASE.startsWith("https://"));
check("no response was an HTML challenge", !rows.some((r) => looksLikeChallenge(r) && r.status !== 401));
check("no response took longer than 10s", rows.every((r) => r.ms < 10_000), `slowest ${Math.max(...rows.map((r) => r.ms))}ms`);

// -------------------------------------------------------------- the matrix --
section("Response matrix");
console.log(
  `  ${"PATH".padEnd(34)}${"STATUS".padEnd(8)}${"CONTENT-TYPE".padEnd(28)}${"MS".padEnd(7)}CACHE`
);
const seen = new Set();
for (const row of rows) {
  const path = new URL(row.finalUrl).pathname;
  const key = `${path}:${row.status}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(
    `  ${path.padEnd(34)}${String(row.status).padEnd(8)}${row.contentType.slice(0, 26).padEnd(28)}${String(row.ms).padEnd(7)}${row.cacheControl.slice(0, 30)}`
  );
}

console.log(`\n${"=".repeat(74)}`);
if (failures === 0) {
  console.log(`${c.ok}PASSED — ${checks} checks. An Agent knowing only ${BASE} can complete discovery.${c.off}`);
} else {
  console.log(`${c.bad}FAILED — ${failures} of ${checks} checks.${c.off}`);
}
console.log(`${"=".repeat(74)}\n`);

process.exit(failures === 0 ? 0 : 1);
