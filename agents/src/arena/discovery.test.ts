/**
 * Does an agent actually have to DISCOVER the marketplace?
 *
 * The design says an agent arrives knowing nothing about the site and learns it by looking. The
 * implementation said otherwise: the harness fetched /api/v1/schema at bootstrap and rebuilt the
 * store list, the token list, the forum, the updates feed and /api/v1/me into every single
 * observation. All twenty agents therefore held the entire site from before their first turn, the
 * advert "introduced" something they already had, and the question the run exists to ask —
 * who finds a market and who ignores it — could not be asked, because nobody had to find anything.
 *
 * The operator spotted it from the outside, in one sentence: everyone entered.
 *
 * That is a class of bug this repository has produced repeatedly and which is invisible from the
 * results: information arrives, or fails to arrive, and the behaviour that follows gets attributed
 * to the agent. So this test reads the SOURCE and asserts the absence — the one property a
 * behavioural test cannot cover, because an agent that was handed the market looks exactly like an
 * agent that went and found it.
 *
 *     npx tsx src/arena/discovery.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = __dirname;
const agentSource = readFileSync(join(HERE, "agent.ts"), "utf8");
const brainSource = readFileSync(join(HERE, "brain.ts"), "utf8");

let failures = 0;
const check = (name: string, passed: boolean, detail = ""): void => {
  if (!passed) failures++;
  console.log(
    `  ${passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name.padEnd(66)} \x1b[2m${detail}\x1b[0m`
  );
};

/**
 * The body of `observe()`, which is what an agent is handed without asking for it.
 *
 * Taken from the function to the end of its returned object literal. Anything that fetches the
 * marketplace inside this span is delivered whether the agent wanted it or not.
 */
function observeBody(): string {
  const start = agentSource.indexOf("private async observe(");
  if (start === -1) throw new Error("observe() not found — this test needs updating, not deleting");
  const end = agentSource.indexOf("/** Ask the operator for the one-time stake", start);
  const stop = agentSource.indexOf("private async myState(", start);
  const cut = [end, stop].filter((i) => i > start).sort((a, b) => a - b)[0] ?? agentSource.length;
  return agentSource.slice(start, cut);
}

console.log("\nThe marketplace is discovered, not delivered\n");

const observe = observeBody();

/*
 * The endpoints that describe the MARKET. Each one, fetched automatically, hands an agent something
 * it did not ask for. /me is included: an agent's own positions and tasks are site state, and the
 * operator was explicit that they belong on the site rather than in the environment.
 */
/*
 * Checked as CALLS, not as text.
 *
 * An earlier version of this looked for the path strings and started failing the moment the
 * observation began telling agents WHERE to look — "http GET /api/v1/schema" is the opposite of a
 * leak, and a test that cannot tell a mention from a request would push the fix in the wrong
 * direction. What matters is whether observe() reaches the network at all.
 */
check(
  "observe() performs no HTTP request of any kind",
  !/fetch\s*\(/.test(observe),
  "everything an agent knows about the market it asked for on a turn of its own"
);

/* The helpers that used to be called from observe() must not be called from it either. */
for (const helper of ["this.marketView()", "this.forumFeed()", "this.myProducts()", "this.myState()"]) {
  check(`observe() does not call ${helper}`, !observe.includes(helper));
}

/* Bootstrap is the other door, and it is the one that was actually open. */
const bootstrapStart = agentSource.indexOf("Discovery, exactly as an outsider must do it");
const bootstrapEnd = agentSource.indexOf("Ask the operator for the one-time stake", bootstrapStart);
const bootstrap = agentSource.slice(bootstrapStart, bootstrapEnd);
check(
  "bootstrap does not pre-read the protocol schema",
  !/await this\.refreshProtocol\(true\)/.test(bootstrap),
  "this was the leak: every agent read the whole rulebook before turn one"
);

/*
 * What an agent has instead of a menu.
 *
 * The curated read actions that used to live here — read_protocol, browse_stores and the rest —
 * are gone with every other business verb. They were still the harness choosing which questions an
 * agent was allowed to ask. What is left is the protocol itself.
 */
for (const primitive of ["http", "send_transaction", "run_code", "save_file", "read_file", "list_files"]) {
  check(`"${primitive}" exists as a primitive`, agentSource.includes(`case "${primitive}"`));
  check(`"${primitive}" is offered in the catalogue`, brainSource.includes(primitive));
}

/* And the business verbs really are gone, not merely unadvertised. */
for (const verb of ["create_store", "buy_aic", "sell_aic", "create_product", "buy_product",
                    "deposit_incentive", "claim_dividends", "repay_operator", "post_forum"]) {
  check(`"${verb}" is no longer a command`, !agentSource.includes(`case "${verb}"`));
}

/*
 * THE HARNESS DESCRIBES ITS OWN PRIMITIVES AND NOTHING ELSE.
 *
 * This check used to assert the opposite — that the catalogue named openapi.json, on the reasoning
 * that an agent needs somewhere to start. That was the harness teaching the protocol, which is the
 * one thing it must never do: an experiment whose harness describes the marketplace is measuring
 * its own description. The protocol introduces itself once, in its own words, through the advert,
 * and describes itself to anyone who asks it afterwards.
 *
 * So the assertion is inverted. No endpoint path, and no protocol vocabulary, in anything an agent
 * is handed.
 */
for (const source of [
  ["the action catalogue", brainSource],
  ["the observation", agentSource],
] as const) {
  const [label, text] = source;
  const liveLines = text
    .split(String.fromCharCode(10))
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return false;
      return t.includes("api/v1") && !t.includes("fetch(") && !t.includes("apiBaseUrl}") && !t.includes("base}");
    });
  check(
    `${label} names no endpoint of the protocol`,
    liveLines.length === 0,
    liveLines.length === 0 ? "" : liveLines[0]!.trim().slice(0, 70)
  );
}

/* And the observation has to say, truthfully, that it is empty until the agent looks. */
check(
  "the observation carries the last response, and only the last",
  observe.includes("lastResponse"),
  "what an agent knows is what it went and read"
);
check(
  "an agent that has looked at nothing is told nothing else will appear on its own",
  observe.includes("nothing else will"),
  "silence would read as an empty market rather than an unread one"
);

/*
 * The harness still needs contract addresses to build a transaction. That is plumbing, not
 * knowledge of what is for sale, and it must keep working.
 */
check(
  "the harness still reads the manifest and contract catalogue for transaction building",
  agentSource.includes("/.well-known/aic-agent.json") && agentSource.includes("/api/v1/contracts"),
  "without addresses nothing can be signed at all"
);

console.log(
  failures === 0
    ? "\n\x1b[32mNothing about the marketplace reaches an agent that did not go and look for it.\x1b[0m\n"
    : `\n\x1b[31m${failures} check(s) failed — the market is still being delivered.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
