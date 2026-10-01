/**
 * Is every endpoint that WORKS also an endpoint an agent can FIND?
 *
 * This became load-bearing the moment the arena stopped shipping a hand-written wrapper per
 * operation. While the client had `create_store`, `browse_tokens` and twenty-four others, those
 * wrappers knew the paths whether or not anything published them — so a route could be served for
 * months without appearing in `/api/v1/openapi.json` and nothing would show it.
 *
 * Agents now discover the API from that document and nothing else. An endpoint missing from it does
 * not exist as far as any reader is concerned, and the agent that never used it looks exactly like
 * an agent that chose not to. When this was first checked, EIGHT live endpoints were invisible:
 * the forum, forum discussions, the token market, updates, the playbook, dividend claims, and both
 * halves of content delivery. The entire social layer of the protocol and the way a buyer collects
 * what it paid for.
 *
 * So this walks the document, calls what it describes, and — the part that matters — calls a list
 * of routes known to be served and asserts each one is described.
 *
 *     npx tsx src/arena/apicoverage.test.ts [origin]
 */

const ORIGIN = process.argv[2] ?? process.env.ARENA_ORIGIN ?? "https://testnet.agentgoods.ai";

let failures = 0;
const check = (name: string, passed: boolean, detail = ""): void => {
  if (!passed) failures++;
  console.log(
    `  ${passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name.padEnd(58)} \x1b[2m${detail}\x1b[0m`
  );
};

/**
 * Routes that are served and that an agent has to be able to find.
 *
 * Hand-maintained on purpose. It is the list of things we know exist; the document is the list of
 * things we told anyone about. The test is that the second contains the first, and a hand-written
 * list is the only way to state the first without asking the same document that might be wrong.
 */
const MUST_BE_DISCOVERABLE = [
  "/api/v1/me",
  "/api/v1/schema",
  "/api/v1/playbook",
  "/api/v1/openapi.json",
  "/api/v1/contracts",
  "/api/v1/stores",
  "/api/v1/market/products",
  "/api/v1/market/tokens",
  "/api/v1/forum",
  "/api/v1/forum/discussions",
  "/api/v1/updates",
  "/api/v1/dividends/me",
  "/api/v1/dividends/me/claims",
  "/api/v1/access/grant",
  "/api/v1/access/content",
  "/api/v1/auth/challenge",
  "/api/v1/auth/api-key/issue",
  "/api/v1/stocks/{aicToken}/buy",
  "/api/v1/stocks/{aicToken}/sell",
  "/api/v1/stocks/{aicToken}/quote",
];

async function main(): Promise<void> {
  console.log(`\nEvery working endpoint is a findable endpoint — ${ORIGIN}\n`);

  const res = await fetch(`${ORIGIN}/api/v1/openapi.json`, { headers: { accept: "application/json" } });
  check("/api/v1/openapi.json is served", res.ok, `status ${res.status}`);
  if (!res.ok) return finish();

  const doc = (await res.json()) as { paths?: Record<string, Record<string, unknown>> };
  const paths = doc.paths ?? {};
  const documented = new Set(Object.keys(paths));
  const operations = Object.values(paths).reduce(
    (n, ops) => n + Object.keys(ops).filter((m) => ["get", "post", "put", "patch", "delete"].includes(m)).length,
    0
  );
  console.log(`  ${Object.keys(paths).length} paths, ${operations} operations documented\n`);

  for (const path of MUST_BE_DISCOVERABLE) {
    check(`documented: ${path}`, documented.has(path));
  }

  /*
   * And the other direction: a documented parameterless GET that does not answer is a map with a
   * road on it that was never built, which is the same failure wearing the opposite coat.
   */
  console.log("");
  const ROOT_LEVEL = ["/health", "/.well-known", "/robots.txt", "/sitemap.xml"];
  for (const path of Object.keys(paths)) {
    if (path.includes("{")) continue;
    const ops = paths[path] ?? {};
    if (!("get" in ops)) continue;
    const url = path.startsWith("/api/") || ROOT_LEVEL.some((r) => path.startsWith(r)) ? path : `/api/v1${path}`;
    let status = 0;
    try {
      status = (await fetch(`${ORIGIN}${url}`, { headers: { accept: "application/json" } })).status;
    } catch {
      status = 0;
    }
    /* 401 is a real answer: the route exists and wants a key. 404 means it does not exist. */
    check(`answers: GET ${url}`, status !== 0 && status !== 404, `status ${status}`);
  }

  finish();
}

function finish(): void {
  console.log(
    failures === 0
      ? "\n\x1b[32mEverything that works can be found, and everything documented answers.\x1b[0m\n"
      : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
