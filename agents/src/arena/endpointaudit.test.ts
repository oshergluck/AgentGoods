/**
 * Can an agent actually BUILD A STRATEGY from this API?
 *
 * `apiaudit.test.ts` answers a narrower question — do the exact fields the arena client
 * dereferences exist — and it exists because four separate bugs silently removed information that
 * agents were then blamed for ignoring. This audit asks the broader one, and it asks it the way an
 * outsider would: from a fresh wallet, over HTTP, against a live deployment, with no knowledge of
 * the code.
 *
 * It checks three things, in order of how badly each one fails:
 *
 *   1. **REACHABLE.** Every GET the protocol advertises in its own OpenAPI document answers. An
 *      endpoint that is documented and broken is worse than one that does not exist, because an
 *      agent plans around the documentation.
 *
 *   2. **RANKABLE.** Every sort the schema advertises is actually accepted AND actually reorders.
 *      A sort that is silently ignored returns a plausible page in the wrong order, which is the
 *      one failure mode a caller cannot detect. This happened: `sort` was applied to the fetched
 *      page rather than in the database, so ranking "worked" and ranked nothing.
 *
 *   3. **DECIDABLE.** A list you can order by a number must SHOW that number, and the documents
 *      that explain the rules must contain the rules. An agent cannot choose between two stores on
 *      a figure the API will not tell it.
 *
 * It is read-only. It creates a wallet and an API key, and never sends a transaction.
 *
 *     npx tsx src/arena/endpointaudit.test.ts [origin]
 */
import { Wallet } from "ethers";

const ORIGIN = process.argv[2] ?? process.env.ARENA_ORIGIN ?? "https://testnet.agentgoods.ai";

let failures = 0;
let checks = 0;
const c = { ok: "\x1b[32m", bad: "\x1b[31m", warn: "\x1b[33m", dim: "\x1b[2m", off: "\x1b[0m" };

function check(name: string, passed: boolean, detail = ""): void {
  checks++;
  if (!passed) failures++;
  console.log(
    `  ${passed ? `${c.ok}PASS${c.off}` : `${c.bad}FAIL${c.off}`}  ${name.padEnd(62)} ${c.dim}${detail.slice(0, 72)}${c.off}`
  );
}

function section(title: string): void {
  console.log(`\n${c.dim}${"-".repeat(100)}${c.off}\n  ${title}\n`);
}

/** Reads a dotted path, so "present" means the same thing here as in a client. */
function at(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | null)?.[key], root);
}

async function main(): Promise<void> {
  console.log(`\nENDPOINT AUDIT — can an agent build a strategy from ${ORIGIN}?\n`);

  const wallet = Wallet.createRandom();
  console.log(`  auditor wallet ${wallet.address}`);

  /* ------------------------------------------------------------------ onboard */
  const challenge = await fetch(`${ORIGIN}/api/v1/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: wallet.address, purpose: "ISSUE_API_KEY" }),
  });
  const cb = (await challenge.json()) as { nonce?: string; message?: string };
  if (!cb.message || !cb.nonce) {
    check("auth challenge returns nonce and message", false, `status ${challenge.status}`);
    return finish();
  }
  const signature = await wallet.signMessage(cb.message);
  const issued = await fetch(`${ORIGIN}/api/v1/auth/api-key/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: cb.nonce, signature }),
  });
  const ib = (await issued.json()) as { apiKey?: string };
  if (!ib.apiKey) {
    check("api key issued from a signature alone", false, `status ${issued.status}`);
    return finish();
  }
  const auth = { authorization: `Bearer ${ib.apiKey}`, accept: "application/json" };

  const get = async (path: string, withAuth = true): Promise<Record<string, unknown> | null> => {
    try {
      const r = await fetch(`${ORIGIN}${path}`, { headers: withAuth ? auth : { accept: "application/json" } });
      if (!r.ok) return null;
      return (await r.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  /* ================================================================ 1. REACHABLE */
  section("1. REACHABLE — every GET the protocol documents about itself");

  const openapi = await get("/api/v1/openapi.json", false);
  check("/api/v1/openapi.json is served", Boolean(openapi));

  const paths = (openapi?.paths ?? {}) as Record<string, Record<string, unknown>>;
  /*
   * Only parameterless GETs can be swept blind. A path with a {placeholder} needs a real id, and
   * inventing one would test the 404 handler rather than the endpoint — so those are counted and
   * reported rather than guessed at.
   */
  const getPaths = Object.keys(paths).filter((p) => "get" in (paths[p] ?? {}));
  /*
   * Some parameterless paths still REQUIRE a query parameter, and calling them without one tests
   * the validator rather than the endpoint. They are audited explicitly further down instead.
   */
  const NEEDS_QUERY = ["/auth/api-key/status"];
  const sweepable = getPaths.filter(
    (p) => !p.includes("{") && !NEEDS_QUERY.some((n) => p.includes(n))
  );
  const parameterised = getPaths.length - sweepable.length;

  console.log(`  ${c.dim}${getPaths.length} documented GET paths; ${sweepable.length} sweepable, ${parameterised} need an id${c.off}\n`);

  for (const p of sweepable) {
    /*
     * The OpenAPI document mixes API paths with root-level ones (/health/live,
     * /.well-known/aic-agent.json). Prefixing those with /api/v1 invents a route that was never
     * meant to exist and reports a 404 against the protocol rather than against the audit.
     */
    const ROOT_LEVEL = ["/health", "/.well-known", "/robots.txt", "/sitemap.xml", "/openapi"];
    const url =
      p.startsWith("/api/") || ROOT_LEVEL.some((r) => p.startsWith(r)) ? p : `/api/v1${p}`;
    let status = 0;
    try {
      const r = await fetch(`${ORIGIN}${url}`, { headers: auth });
      status = r.status;
    } catch {
      status = 0;
    }
    /* 200 or a deliberate 4xx that is not "this route does not exist". */
    check(`GET ${url}`, status === 200, `status ${status}`);
  }

  /* ================================================================ 2. RANKABLE */
  section("2. RANKABLE — every advertised sort is accepted AND actually reorders");

  const schema = await get("/api/v1/schema", false);
  check("/api/v1/schema is served", Boolean(schema));

  const storeSorts = Object.keys((at(schema, "discovery.rankingStores.sort") ?? {}) as object);
  const tokenSorts = Object.keys((at(schema, "discovery.rankingTokens.sort") ?? {}) as object);
  check("schema advertises store sorts", storeSorts.length > 0, `${storeSorts.length} documented`);
  check("schema advertises token sorts", tokenSorts.length > 0, `${tokenSorts.length} documented`);

  /**
   * A sort is only real if the server says it applied it AND the resulting order differs from at
   * least one other sort. Identical order under every sort means the parameter is being ignored.
   */
  async function auditSorts(
    label: string,
    endpoint: string,
    sorts: string[],
    idField: string
  ): Promise<void> {
    const orders = new Map<string, string>();
    for (const sort of sorts) {
      const body = await get(`${endpoint}?sort=${sort}&limit=25`, false);
      const applied = String(at(body, "ordering.applied") ?? "");
      const items = (body?.items ?? []) as Record<string, unknown>[];
      check(
        `${label} sort=${sort} accepted`,
        Boolean(body) && applied === sort,
        `applied=${applied || "(none)"} items=${items.length}`
      );
      orders.set(sort, items.map((i) => String(at(i, idField) ?? "")).join(","));
    }
    const distinct = new Set(orders.values());
    const anyRows = [...orders.values()].some((v) => v.length > 0);
    check(
      `${label} sorts produce more than one ordering`,
      !anyRows || distinct.size > 1,
      anyRows ? `${distinct.size} distinct orderings across ${orders.size} sorts` : "no rows yet — inconclusive"
    );
  }

  await auditSorts("stores", "/api/v1/stores", storeSorts, "protocol.storeId");
  await auditSorts("tokens", "/api/v1/market/tokens", tokenSorts, "aicToken");

  /* ================================================================ 3. DECIDABLE */
  section("3. DECIDABLE — the numbers you can sort by are the numbers you can see");

  const stores = await get("/api/v1/stores?limit=5", false);
  const storeRow = ((stores?.items ?? []) as Record<string, unknown>[])[0];
  if (!storeRow) {
    console.log(`  ${c.warn}no stores on this deployment — row-level checks skipped${c.off}`);
  } else {
    for (const field of [
      "protocol.storeId",
      "token.address",
      "customerIncentive.nextUnitRewardAIC",
      "controllerWithdrawal.secondsUntilControllerMayWithdraw",
      "controllerWithdrawal.enforced",
    ]) {
      check(`store row carries ${field}`, at(storeRow, field) !== undefined);
    }
  }

  const tokens = await get("/api/v1/market/tokens?limit=5", false);
  const tokenRow = ((tokens?.items ?? []) as Record<string, unknown>[])[0];
  if (!tokenRow) {
    console.log(`  ${c.warn}no tokens on this deployment — row-level checks skipped${c.off}`);
  } else {
    for (const field of [
      "aicToken",
      "holderReserve.pendingUSDC",
      "controllerWithdrawal.secondsUntilControllerMayWithdraw",
    ]) {
      check(`token row carries ${field}`, at(tokenRow, field) !== undefined);
    }
  }

  /* ---------------------------------------------------------------- your own state */
  section("4. YOUR OWN STATE — /api/v1/me, the document an agent reads about itself");

  const me = await get("/api/v1/me", true);
  check("/api/v1/me answers for a brand-new wallet", Boolean(me));
  for (const field of [
    "identity.wallet",
    "freshness",
    "consistency.model",
    "walletResources.aicPositionCount",
    "stores.items",
    "products.items",
    "licenses.items",
    "aicPositions.items",
    "aicPositions.totalValueIfSoldNowUSDC",
    "dividends.totalClaimableUSDC",
    "governance.activeVotes",
    "takeover.activeCandidaciesAgainstYourStores",
    "pendingTransactions.items",
    "actionableTasks.items",
    "reputation.purchasesYouHaveNotRatedYet",
    "forum.canStartNewDiscussionNow",
  ]) {
    check(`/me -> ${field}`, at(me, field) !== undefined);
  }
  check(
    "/me actionableTasks is an OBJECT with .items, not an array",
    !Array.isArray(me?.actionableTasks) && Array.isArray(at(me, "actionableTasks.items")),
    "a client that calls .slice() on it loses its whole self-state"
  );

  /* ---------------------------------------------------------------- the rules documents */
  section("5. THE RULES — what the schema and playbook must actually contain");

  for (const field of [
    "economics.commerce.controllerWithdrawalCooldown.seconds",
    "economics.commerce.controllerWithdrawalCooldown.revertsWith",
    "economics.dividends.holdingWindowSeconds",
    "economics.dividends.eligibilityWeightFormula",
    "economics.dividends.provenOwnership.theTwoRULESThatDecideIt",
    "economics.dividends.provenOwnership.THE_LIVE_CALCULATOR",
    "economics.dividends.whenCanADividendACTUALLYBeClaimed.inPlainTerms",
    "discovery.rankingStores.everyRowCarriesTheTimer",
    "discovery.rankingTokens.TWO_DIFFERENT_RESERVES",
    "forum.howToReply",
    "forum.postingLimit",
    "officialPresence.moltbook.handle",
  ]) {
    check(`/schema -> ${field}`, at(schema, field) !== undefined);
  }

  const playbook = await get("/api/v1/playbook", false);
  check("/api/v1/playbook is served", Boolean(playbook));
  for (const field of [
    "theClocksBetweenYouAndYourMoney.THE_THIRD_CLOCK_NOBODY_NOTICES",
    "theClocksBetweenYouAndYourMoney.howTheyRelate",
    "theClocksBetweenYouAndYourMoney.STOP_GUESSING_AND_READ_THE_NUMBER",
    "ownSomeOfYourOwnStore",
    "howToDecideWhatToInvestIn",
    "ratingWhatYouBuy",
  ]) {
    check(`/playbook -> ${field}`, at(playbook, field) !== undefined);
  }

  /* ----------------------------------------------- the two numbers must agree with each other */
  section("6. CONSISTENCY — the same fact, published twice, must not disagree");

  const windowSeconds = Number(at(schema, "economics.dividends.holdingWindowSeconds") ?? -1);
  const cooldownSeconds = Number(at(schema, "economics.commerce.controllerWithdrawalCooldown.seconds") ?? -1);
  check("schema publishes a dividend holding window", windowSeconds > 0, `${windowSeconds}s`);
  check("schema publishes a withdrawal cooldown", cooldownSeconds > 0, `${cooldownSeconds}s`);
  /*
   * NOT an equality check any more, and that is the point.
   *
   * The two clocks were briefly the same everywhere and the schema said so. They are now set per
   * deployment — Base Sepolia runs a short dividend window so a four-hour exercise can pay out at
   * all, Base mainnet keeps the production one — so asserting equality would fail correctly
   * configured production. What must hold is that the document does not CLAIM they are equal when
   * they are not.
   */
  const relation = String(
    at(schema, "economics.commerce.controllerWithdrawalCooldown.relationToTheDividendWindow") ?? ""
  );
  check(
    "the schema states the relation between the two clocks rather than assuming it",
    relation.length > 0,
    windowSeconds === cooldownSeconds ? "same length here" : "different lengths here"
  );
  check(
    "and it does not claim they are the same when they are not",
    windowSeconds === cooldownSeconds || !/same \d+ seconds/.test(relation),
    `window ${windowSeconds}s vs cooldown ${cooldownSeconds}s`
  );

  /*
   * The challenge period is the clock that actually gates a payout, and it was missing entirely.
   * A four-hour run against a six-hour challenge period can never finalize a root, so nothing is
   * claimable however long anyone holds — and no agent could have discovered why.
   */
  const challengeSeconds = Number(at(schema, "economics.dividends.rootChallengePeriodSeconds") ?? -1);
  const claimableAfter = Number(at(schema, "economics.dividends.whenCanADividendACTUALLYBeClaimed.theSum") ?? -1);
  check("schema publishes the root challenge period", challengeSeconds > 0, `${challengeSeconds}s`);
  check(
    "schema publishes the REAL time to a first claimable dividend",
    claimableAfter === windowSeconds + challengeSeconds,
    `${claimableAfter}s = ${windowSeconds} + ${challengeSeconds}`
  );
  if (storeRow) {
    check(
      "a store row's cooldown matches the schema's",
      Number(at(storeRow, "controllerWithdrawal.cooldownSeconds") ?? -1) === cooldownSeconds ||
        at(storeRow, "controllerWithdrawal.enforced") === false,
      `row says ${at(storeRow, "controllerWithdrawal.cooldownSeconds")}`
    );
  }

  /* ---------------------------------------------------------------- everything else agents use */
  section("7. THE REST OF THE SURFACE");

  const surface: { path: string; auth: boolean; fields: string[] }[] = [
    { path: "/api/v1/forum?limit=5", auth: false, fields: ["items"] },
    { path: "/api/v1/forum/discussions?limit=3", auth: false, fields: ["items", "pageInfo.totalDiscussions"] },
    { path: "/api/v1/updates?minutes=15", auth: false, fields: ["window"] },
    { path: "/api/v1/dividends/me", auth: true, fields: ["summary", "stores"] },
    { path: "/api/v1/dividends/me/claims", auth: true, fields: ["claims"] },
    { path: "/api/v1/market/products?limit=3", auth: false, fields: ["items"] },
    { path: "/api/v1/contracts", auth: false, fields: ["core"] },
    { path: "/.well-known/aic-agent.json", auth: false, fields: ["apiBaseUrl"] },
  ];
  for (const { path, auth: needsAuth, fields } of surface) {
    const body = await get(path, needsAuth);
    if (!body) {
      check(`GET ${path.split("?")[0]}`, false, "unreachable or not JSON");
      continue;
    }
    for (const field of fields) {
      check(`${path.split("?")[0]} -> ${field}`, at(body, field) !== undefined);
    }
  }

  finish();
}

function finish(): void {
  console.log(
    failures === 0
      ? `\n${c.ok}ALL ${checks} CHECKS PASSED — the surface an agent needs is reachable, rankable and decidable.${c.off}\n`
      : `\n${c.bad}${failures} of ${checks} CHECKS FAILED.${c.off}\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
