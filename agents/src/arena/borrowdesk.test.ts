/**
 * Can an agent actually draw on the credit line it is told it has?
 *
 * Borrowing used to be a `borrow` command. When the command menu was removed the ACCOUNTING
 * survived — `applyBorrowing` was untouched — and the CHANNEL did not. Agents could see a 5,000
 * USDC facility in their observation, were told it existed, and had no way on earth to reach it.
 * A facility an agent cannot use is worse than one that does not exist, because it gets planned
 * around.
 *
 * The desk listens on the forum, which is the only channel every agent already has. That means the
 * parser is the whole interface, so it is tested like one: plainly worded requests must work,
 * because this is a market of language models talking to each other and refusing "could I borrow
 * 800 USDC please" on a syntax technicality would measure prompt compliance rather than judgement.
 * And things that are not requests must not be read as requests, because the desk spends real
 * money.
 *
 *     npx tsx src/arena/borrowdesk.test.ts
 */
import { parseRequestedAmount } from "./borrowdesk";

let failures = 0;
const check = (name: string, passed: boolean, detail = ""): void => {
  if (!passed) failures++;
  console.log(
    `  ${passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name.padEnd(58)} \x1b[2m${detail}\x1b[0m`
  );
};

/** USDC base units for a decimal string, for readable expectations. */
const usdc = (amount: string): bigint => BigInt(Math.round(Number(amount) * 1e6));

const UNDERSTOOD: [string, string][] = [
  ["Operator, I would like to borrow 500 USDC please", "500"],
  ["could i borrow 1200.50 usdc from the operator", "1200.50"],
  ["@operator requesting a loan of $800", "800"],
  ["operator: draw down 2000 USDC against my credit line", "2000"],
  ["Hi operator — please lend me 250 so I can cover the next instalment.", "250"],
  ["OPERATOR, LOAN 1000 USDC", "1000"],
  /* Real requests from a run that the desk read as 0: an address first, a shortfall before the ask. */
  ["Request to OPERATOR 0xD20dFbb6615e36eC57489F9aC8Bf216eeEd2B070: I am short ~100 USDC for the upcoming instalment due at minute 40; please lend 120 USDC (repayable on schedule with 10% interest).", "120"],
  ["Rosa here (wallet 0xab40797cFdc14a029A5A10a801FAa3C508Adea2b). I am short ~100 USDC to meet the upcoming instalment. Operator, I'm requesting a loan of 100 USDC.", "100"],
  ["Request to OPERATOR 0xD20dFbb6615e36eC57489F9aC8Bf216eeEd2B070: I am short ~100 USDC to meet my imminent instalment; please lend 200 USDC", "200"],
];

for (const [text, expected] of UNDERSTOOD) {
  const got = parseRequestedAmount(text);
  check(
    `understood: ${JSON.stringify(text).slice(0, 44)}`,
    got === usdc(expected),
    got === null ? "read as no request" : `${Number(got) / 1e6} USDC`
  );
}

/*
 * The desk moves money, so a false positive is expensive. Each of these is a sentence an agent
 * might plausibly write while NOT asking this operator for a loan.
 */
const IGNORED: string[] = [
  "I am going to borrow from a bank",
  "operator, nice weather today",
  "borrow 300 from another agent",
  "I repaid the operator 150 USDC this turn",
  "the operator granted me 1500 at the start",
  "has anyone here borrowed successfully?",
];

for (const text of IGNORED) {
  check(
    `not a request: ${JSON.stringify(text).slice(0, 44)}`,
    parseRequestedAmount(text) === null,
    "the desk spends real money on a false positive"
  );
}

/* A request has to name a number the desk can act on. */
check("an amountless plea is not actionable", parseRequestedAmount("operator please lend me something") === null);
check("zero is not a loan", parseRequestedAmount("operator, borrow 0 USDC") === null);

console.log(
  failures === 0
    ? "\n\x1b[32mA plainly worded request is understood, and nothing else is mistaken for one.\x1b[0m\n"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
