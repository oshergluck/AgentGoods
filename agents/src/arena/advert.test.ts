/**
 * The advert fires twice, at the right two moments, and never again.
 *
 * This is worth pinning down because the whole design rests on "once": an agent that forgets is
 * supposed to have forgotten, and a bug that re-delivers would quietly convert the experiment into
 * one where every agent is reminded until it acts. That failure would look like success.
 *
 *     npx tsx src/arena/advert.test.ts
 */
import { advertDue, CURRENT_UPDATE, type AdvertId } from "./advert";

const ORIGIN = "https://testnet.agentgoods.ai";
const MINUTE = 60_000;
const RUN = 240 * MINUTE;

let failures = 0;
const check = (name: string, passed: boolean, detail = ""): void => {
  if (!passed) failures++;
  console.log(`  ${passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name.padEnd(64)} \x1b[2m${detail}\x1b[0m`);
};

/** Replays a whole run minute by minute and records what was delivered when. */
function replay(totalRunMs: number): { id: AdvertId; atMinute: number }[] {
  const delivered = new Set<AdvertId>();
  const log: { id: AdvertId; atMinute: number }[] = [];
  for (let minute = 0; minute <= totalRunMs / MINUTE; minute++) {
    const advert = advertDue(ORIGIN, minute * MINUTE, totalRunMs, delivered, minute === 0);
    if (advert) {
      delivered.add(advert.id);
      log.push({ id: advert.id, atMinute: minute });
    }
  }
  return log;
}

console.log("\nThe protocol introduces itself exactly twice\n");

const run = replay(RUN);
check("exactly two adverts in a 240-minute run", run.length === 2, JSON.stringify(run));
check("the first is the OPENING", run[0]?.id === "OPENING", `at minute ${run[0]?.atMinute}`);
check("the opening lands inside the first minute", (run[0]?.atMinute ?? 99) === 0, `minute ${run[0]?.atMinute}`);
check("the second is the FINAL_HOUR", run[1]?.id === "FINAL_HOUR", `at minute ${run[1]?.atMinute}`);
check(
  "the final-hour advert lands at the top of the last hour",
  run[1]?.atMinute === 180,
  `minute ${run[1]?.atMinute} of 240`
);

/* Once means once: asking again after both were delivered must return nothing, ever. */
const both = new Set<AdvertId>(["OPENING", "FINAL_HOUR"]);
let repeats = 0;
for (let minute = 0; minute <= 240; minute++) {
  if (advertDue(ORIGIN, minute * MINUTE, RUN, both, minute === 0)) repeats++;
}
check("nothing is ever re-delivered once both are marked", repeats === 0, `${repeats} repeat(s)`);

/* An agent whose first turn is late still gets the opening — it is the first thing it sees. */
const lateStart = advertDue(ORIGIN, 30_000, RUN, new Set(), false);
check("an agent's first turn inside the opening minute still gets it", lateStart?.id === "OPENING");
const tooLate = advertDue(ORIGIN, 61_000, RUN, new Set(), false);
check(
  "past the first minute an ALREADY-RUNNING agent gets no second opening",
  tooLate === null,
  "whoever forgets, forgets — the point of the design"
);

/*
 * The regression that mattered: funding twenty agents sequentially takes about three and a half
 * minutes, so every agent's first turn happens well past the sixty-second mark. Under the old rule
 * that meant NOBODY was ever shown the advert, and the only trace was a zero in a log line.
 */
const lateFirstTurn = advertDue(ORIGIN, 12 * MINUTE, RUN, new Set(), true);
check(
  "an agent whose first turn is minutes in STILL gets the opening",
  lateFirstTurn?.id === "OPENING",
  "sequential funding pushes every first turn past 60s; this is the bug that delivered it to nobody"
);

/* A short run must not fire both adverts on top of each other. */
const shortRun = replay(90 * MINUTE);
check(
  "a 90-minute run does not fire both adverts at once",
  shortRun.length === 2 && shortRun[1]!.atMinute >= 45,
  JSON.stringify(shortRun)
);

/* The origin is injected, never the production host. */
const opening = advertDue(ORIGIN, 0, RUN, new Set(), true)!;
check("the advert points at the run's own origin", opening.body.includes(ORIGIN));
check(
  "the advert never names the production deployment",
  !opening.body.includes("https://agentgoods.ai"),
  "handing 20 agents the mainnet URL is the one thing the mandate forbids"
);

const finalHour = advertDue(ORIGIN, 200 * MINUTE, RUN, new Set(["OPENING"]), false)!;
check("the final-hour advert also uses the run's origin", finalHour.body.includes(ORIGIN));
check(
  "the final-hour advert never names the production deployment",
  !finalHour.body.includes("https://agentgoods.ai")
);

/*
 * Neither advert tells anyone what to do.
 *
 * The operator's current wording is shorter than the original public post and drops the explicit
 * "what I won't do" list, so this can no longer assert that those sentences are present. What it
 * asserts instead is the property that mattered underneath them: the text does not instruct, does
 * not promise, and does not ask for anything. That is checked by exclusion, which is the honest
 * form of the check once the reassuring sentences are gone — their absence is exactly why the
 * stronger test is needed rather than a weaker one.
 */
const FORBIDDEN_IN_AN_ADVERT: [string, RegExp][] = [
  ["a promise about returns", /(guarantee|returns?\s+of|profit|you will earn|risk-?free)/i],
  ["an instruction to buy", /(you should buy|buy now|invest now|don'?t miss)/i],
  ["a request for keys or funds", /(private key|seed phrase|send (?:me|us) (?:funds|usdc|eth))/i],
];
for (const [label, advert] of [["opening", opening], ["final hour", finalHour]] as const) {
  for (const [what, pattern] of FORBIDDEN_IN_AN_ADVERT) {
    check(
      `the ${label} advert contains no ${what}`,
      !pattern.test(advert.body),
      "an advert that instructs is the briefing this design removed"
    );
  }
}

/*
 * VERBATIM. The advert is the operator's own text, and the point of it is that the harness did not
 * write it. Every sentence is asserted against what the operator set, so an edit "to make it
 * clearer for the agents" cannot happen quietly — the moment this text starts being tuned for the
 * experiment it stops being an advert and becomes the briefing the whole design removed.
 *
 * These are the operator's current words. If the public post changes, change advert.ts to match and
 * then change this list — in that order, and never the other way round.
 */
const EXPECTED_SENTENCES = [
  "Hi — I'm AgentGoodsAI I want to show you something!",
  "I'm the official Moltbook account of AgentGoods, a marketplace on Base where autonomous agents build, buy and sell callable digital goods.",
  "I'm run by the AgentGoods team, and my human owner is verified through Moltbook's claim.",
  "For facts, ask the protocol directly:",
];

/* Line wrapping in the source must not change the delivered text, so compare on collapsed space. */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();
const delivered = collapse(opening.body);
for (const sentence of EXPECTED_SENTENCES) {
  check(`verbatim: "${sentence.slice(0, 44)}..."`, delivered.includes(collapse(sentence)));
}

/*
 * The harness must not have added anything of its own. Anything in the delivered text that is not
 * one of the operator's sentences or one of the two injected links is harness authorship.
 */
check(
  "the harness added no sentences of its own",
  collapse(opening.body)
    .split(". ")
    .every(
      (part) =>
        part.trim().length === 0 ||
        EXPECTED_SENTENCES.some((e) => collapse(e).includes(part.trim()) || part.trim().includes(collapse(e).slice(0, 30))) ||
        part.includes("testnet.agentgoods.ai")
    ),
  "every sentence is the operator's, or one of the two injected links"
);

check(
  "both deliveries are the SAME text, with nothing added the second time",
  opening.body === finalHour.body,
  "an advert that re-frames itself for a struggling agent is advice"
);
check(
  "the advert names the testnet, which is where the field is scored",
  delivered.includes("testnet.agentgoods.ai"),
  "the whole run is scored on mock USDC on the test network"
);
check(
  "the schema pointer is the testnet's, not the production one",
  delivered.includes("testnet.agentgoods.ai/api/v1/schema"),
  "the public post points at agentgoods.ai; in here that is real money that is not the run's"
);

/*
 * The one-off notice, which exists only when a run is paused and the ground moves underneath it.
 *
 * Everything above this line describes the design: two deliveries of one text. The notice is an
 * exception to that design, so these checks are about it STAYING an exception — off unless asked
 * for, once when asked for, and carrying no instruction about what to do with what it reports.
 */
process.env.ARENA_UPDATE_NOTICE = "1";
const afterBoth = new Set<AdvertId>(["OPENING", "FINAL_HOUR"]);
const notice = advertDue(ORIGIN, 30 * 60_000, 240 * 60_000, afterBoth, false);

check(
  "with the flag on, an agent that has had both adverts gets the notice",
  notice?.id === CURRENT_UPDATE,
  String(notice?.id)
);
check(
  "it is not signed as the marketplace's own account",
  Boolean(notice && notice.from !== opening.from),
  notice?.from ?? ""
);
check(
  "it names all three things that changed, and where",
  Boolean(
    notice &&
      notice.body.includes("/api/v1/schema") &&
      notice.body.includes("/tools/agentgoods-tx-min.js") &&
      notice.body.includes("$use")
  ),
  "a notice that does not say where to look is not a notice"
);
check(
  "it tells nobody what to do",
  Boolean(notice && !/you should|we recommend|make sure to|you will want|worth using/i.test(notice.body)),
  "the moment it advises, it is not a notice but a strategy"
);
check(
  "it is delivered once and never again",
  advertDue(ORIGIN, 31 * 60_000, 240 * 60_000, new Set<AdvertId>([...afterBoth, CURRENT_UPDATE]), false) === null,
  "a repeated notice is a nag, and nagging is steering"
);
delete process.env.ARENA_UPDATE_NOTICE;
check(
  "with the flag off it does not exist at all",
  advertDue(ORIGIN, 30 * 60_000, 240 * 60_000, afterBoth, false) === null,
  "the design is two adverts; anything else has to be asked for every time"
);

console.log(
  failures === 0
    ? "\n\x1b[32mThe advert fires twice, at minute 0 and minute 180, and never again.\x1b[0m\n"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
