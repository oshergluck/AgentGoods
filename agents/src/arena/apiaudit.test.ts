/**
 * Does the arena read fields that actually exist?
 *
 * Three bugs of one shape were found in a single run, each invisible:
 *
 *   - `this.licenses` was declared and never assigned, so the rating prompt offered no licences;
 *   - actionable tasks were read from `t.why`, but the field is `reason`;
 *   - `actionableTasks` is an OBJECT and was read as an array, which threw and — because the
 *     caller swallows errors — blanked the agent's entire self-state on every turn.
 *
 * None produced an error. Each one silently removed information an agent needed, and the only
 * symptom was agents "ignoring" guidance they were never actually given.
 *
 * So this audit does not read the client's code. It creates a real wallet, issues a real API key,
 * calls the endpoints the arena calls, and asserts that the exact fields the arena dereferences are
 * present in the live response. A field that disappears from the API shows up here as a failure
 * rather than as a behavioural mystery three hours into a run.
 *
 *     npx tsx src/arena/apiaudit.test.ts [origin]
 */
import { Wallet } from "ethers";

const ORIGIN = process.argv[2] ?? process.env.ARENA_ORIGIN ?? "https://testnet.agentgoods.ai";

let failures = 0;
const c = { ok: "\x1b[32m", bad: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };
const check = (name: string, passed: boolean, detail = ""): void => {
  if (!passed) failures++;
  console.log(`  ${passed ? `${c.ok}PASS${c.off}` : `${c.bad}FAIL${c.off}`}  ${name.padEnd(56)} ${c.dim}${detail.slice(0, 64)}${c.off}`);
};

/** Reads a dotted path the way the client does, so "present" means the same thing here. */
function at(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | null)?.[key], root);
}

async function main(): Promise<void> {
  console.log(`\nAPI field audit against ${ORIGIN}\n`);

  const wallet = Wallet.createRandom();
  console.log(`  auditor wallet ${wallet.address}\n`);

  /* ------------------------------------------------------------------ onboard */
  const challenge = await fetch(`${ORIGIN}/api/v1/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: wallet.address, purpose: "ISSUE_API_KEY" }),
  });
  const cb = (await challenge.json()) as { nonce?: string; message?: string };
  check("auth challenge returns nonce and message", Boolean(cb.nonce && cb.message));
  if (!cb.message || !cb.nonce) return finish();

  const signature = await wallet.signMessage(cb.message);
  const issued = await fetch(`${ORIGIN}/api/v1/auth/api-key/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: cb.nonce, signature }),
  });
  const ib = (await issued.json()) as { apiKey?: string };
  check("api key issued from a signature alone", Boolean(ib.apiKey));
  if (!ib.apiKey) return finish();
  const auth = { authorization: `Bearer ${ib.apiKey}`, accept: "application/json" };

  const get = async (path: string, withAuth = true): Promise<Record<string, unknown> | null> => {
    const r = await fetch(`${ORIGIN}${path}`, { headers: withAuth ? auth : { accept: "application/json" } });
    if (!r.ok) {
      check(`GET ${path}`, false, `status ${r.status}`);
      return null;
    }
    return (await r.json()) as Record<string, unknown>;
  };

  /**
   * Every field the arena actually dereferences, endpoint by endpoint.
   *
   * `optional` marks a field that is legitimately absent for a brand-new wallet — the audit still
   * reports it, so an empty list is visibly empty rather than quietly missing.
   */
  const CONTRACT: { path: string; auth: boolean; fields: string[]; optional?: string[] }[] = [
    {
      path: "/api/v1/me",
      auth: true,
      // The arena reads tasks through .items, and licences through .licenses.items.
      fields: ["actionableTasks", "actionableTasks.items", "licenses", "licenses.items"],
      optional: ["aicPositions.items", "stores.items"],
    },
    { path: "/api/v1/forum?limit=5", auth: false, fields: ["items"] },
    { path: "/api/v1/forum/discussions?limit=3", auth: false, fields: ["items", "pageInfo.totalDiscussions"] },
    { path: "/api/v1/updates?minutes=15", auth: false, fields: ["window"] },
    { path: "/api/v1/dividends/me", auth: true, fields: ["summary", "stores"] },
    { path: "/api/v1/dividends/me/claims", auth: true, fields: ["claims"] },
    { path: "/api/v1/market/tokens?limit=3", auth: false, fields: ["items", "ordering.applied"] },
    { path: "/api/v1/stores?limit=3", auth: false, fields: ["items", "ordering.applied"] },
    { path: "/api/v1/market/products?limit=3", auth: false, fields: ["items"] },
    { path: "/api/v1/contracts", auth: false, fields: ["core"] },
    { path: "/api/v1/schema", auth: false, fields: ["forum.howToReply", "discovery.rankingStores", "playbook.endpoint"] },
    { path: "/api/v1/playbook", auth: false, fields: ["ownSomeOfYourOwnStore", "howToDecideWhatToInvestIn", "ratingWhatYouBuy"] },
  ];

  for (const { path, auth: needsAuth, fields, optional } of CONTRACT) {
    const body = await get(path, needsAuth);
    if (!body) continue;
    for (const field of fields) {
      const value = at(body, field);
      check(
        `${path.split("?")[0]} -> ${field}`,
        value !== undefined,
        value === undefined ? "MISSING" : Array.isArray(value) ? `array(${value.length})` : typeof value
      );
    }
    for (const field of optional ?? []) {
      const value = at(body, field);
      console.log(`  ${c.dim}note  ${path.split("?")[0]} -> ${field}: ${value === undefined ? "absent" : Array.isArray(value) ? `array(${value.length})` : typeof value}${c.off}`);
    }
  }

  /* ------------------------------------------------- the array/object trap itself */
  const me = await get("/api/v1/me", true);
  if (me) {
    const tasks = me.actionableTasks;
    check(
      "actionableTasks is an OBJECT, not an array",
      !Array.isArray(tasks) && typeof tasks === "object",
      "the client must read .items, never .slice()"
    );
    const items = at(me, "actionableTasks.items");
    check("actionableTasks.items is an array", Array.isArray(items), Array.isArray(items) ? `${items.length} task(s)` : "NOT AN ARRAY");

    // Whatever tasks exist must carry the fields the observation renders.
    for (const t of (Array.isArray(items) ? items : []).slice(0, 3) as Record<string, unknown>[]) {
      check(
        `task ${String(t.type).slice(0, 34)} has a reason`,
        typeof t.reason === "string" && t.reason.length > 0,
        `${String(t.reason ?? "").length} chars`
      );
    }
  }

  finish();
}

function finish(): void {
  console.log(
    failures === 0
      ? `\n${c.ok}EVERY FIELD THE ARENA READS EXISTS IN THE LIVE API.${c.off}\n`
      : `\n${c.bad}${failures} FIELD(S) MISSING — the arena would silently drop this information.${c.off}\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
