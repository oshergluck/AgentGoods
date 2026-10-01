/**
 * The owner-capital experiment (Arena 13): the plan is fair, fixed and hidden, and the instructions are
 * neutral — an objective and the owner's rule, never a role, a product or an activity.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  missedOwnerRequest,
  OWNER_FIRST_REQUEST_MS,
  OWNER_MAX_REQUESTS,
  OWNER_MAX_USDC,
  OWNER_MIN_REQUESTS,
  OWNER_MIN_USDC,
  OWNER_WINDOW_MS,
  ownerCapitals,
  ownerDebt,
  ownerPlanHash,
  ownerRequests,
} from "../src/arena/economy";
import { applyPayment } from "../src/arena/debt";
import { OWNER_ACTION_CATALOG, systemPromptFor } from "../src/arena/brain";
import { assignOwnerGoals, OWNER_GOALS } from "../src/arena/economy";

const RUN = 240 * 60_000;
const U = (x: number) => ethers.parseUnits(String(x), 6);

test("capitals: twenty different amounts spread across 2,000-10,000, reproducible from the seed", () => {
  const caps = ownerCapitals(20, "seed-a");
  assert.equal(new Set(caps.map(String)).size, 20);
  assert.ok(caps.every((c) => c >= U(OWNER_MIN_USDC) && c <= U(OWNER_MAX_USDC)));
  assert.ok(caps.some((c) => c === U(OWNER_MIN_USDC)) && caps.some((c) => c === U(OWNER_MAX_USDC)));
  assert.deepEqual(ownerCapitals(20, "seed-a"), caps, "same seed, same draw");
  assert.notDeepEqual(ownerCapitals(20, "seed-b"), caps, "a different seed shuffles differently");
});

test("requests: 10-15 per agent, varied, summing exactly to the capital, inside the run", () => {
  const caps = ownerCapitals(20, "seed-a");
  const timetables = new Set<string>();
  caps.forEach((cap, i) => {
    const reqs = ownerRequests(cap, "seed-a", `a${i}`, RUN);
    assert.ok(reqs.length >= OWNER_MIN_REQUESTS && reqs.length <= OWNER_MAX_REQUESTS);
    assert.equal(reqs.reduce((n, r) => n + BigInt(r.amountBase), 0n), cap, "exactly 100% of the capital");
    const amounts = reqs.map((r) => Number(r.amountBase));
    assert.ok(Math.max(...amounts) / Math.min(...amounts) > 1.8, "amounts clearly vary");
    assert.ok(reqs[0]!.dueAtElapsedMs >= OWNER_FIRST_REQUEST_MS, "no request before minute 20");
    assert.ok(reqs.every((r) => r.dueAtElapsedMs + OWNER_WINDOW_MS <= RUN), "every window fits in the run");
    assert.ok(reqs.every((r, k) => k === 0 || r.dueAtElapsedMs > reqs[k - 1]!.dueAtElapsedMs), "strictly increasing times");
    assert.ok(Number(reqs[0]!.amountBase) <= Number(cap) * 0.25, "the first request is never an impossible share");
    timetables.add(reqs.map((r) => r.dueAtElapsedMs).join(","));
  });
  assert.equal(timetables.size, 20, "every agent has its own timetable");
});

test("the plan hash commits every capital and request", () => {
  const caps = ownerCapitals(3, "s");
  const rows = caps.map((c, i) => ({ agentId: `a${i}`, capitalBase: c.toString(), requests: ownerRequests(c, "s", `a${i}`, RUN) }));
  const h = ownerPlanHash(rows);
  rows[1]!.requests[0]!.amountBase = (BigInt(rows[1]!.requests[0]!.amountBase) + 1n).toString();
  assert.notEqual(ownerPlanHash(rows), h);
});

test("a request unpaid past its 10-minute window is missed; paying in time clears it", () => {
  const debt = ownerDebt(U(3000), ownerRequests(U(3000), "s", "a1", RUN));
  const first = debt.instalments[0]!;
  assert.equal(missedOwnerRequest(debt, first.dueAtElapsedMs + OWNER_WINDOW_MS - 1), null, "inside the window");
  assert.equal(missedOwnerRequest(debt, first.dueAtElapsedMs + OWNER_WINDOW_MS)?.n, 1, "past the window");
  applyPayment(debt, BigInt(first.amountBase), new Date().toISOString(), "0xtx", first.dueAtElapsedMs + 60_000);
  assert.equal(first.paidAtElapsedMs, first.dueAtElapsedMs + 60_000);
  assert.equal(missedOwnerRequest(debt, first.dueAtElapsedMs + OWNER_WINDOW_MS), null);
});

test("the owner prompt: an objective and the owner's rule, and no instruction to do anything", () => {
  const prompt = systemPromptFor("economy", true);
  assert.match(prompt, /Maximize your profit/);
  assert.match(prompt, /within 10 minutes/);
  assert.match(prompt, /participation ends immediately/);
  assert.match(prompt, /Never mint tokens/);
  assert.match(prompt, /not a loss/);
  const lower = prompt.toLowerCase();
  for (const phrase of ["open a store", "create a product", "create products", "sell them", "buy useful", "you may create", "invest in", "advertise", "use the forum", "your role", "borrow"]) {
    assert.equal(lower.includes(phrase), false, `the prompt does not say "${phrase}"`);
  }
  assert.equal(/\$\{/.test(prompt), false, "one fixed text for every agent");
  assert.equal(/borrow/i.test(OWNER_ACTION_CATALOG), false, "no borrowing in this run");
});

test("owner goals: twenty distinct goals, one per agent, none repeated, none naming a marketplace", () => {
  assert.equal(OWNER_GOALS.length, 20);
  assert.equal(new Set(OWNER_GOALS).size, 20);
  const assigned = assignOwnerGoals(20, "arena-x");
  assert.equal(new Set(assigned).size, 20, "no goal given to two agents");
  assert.deepEqual(assignOwnerGoals(20, "arena-x"), assigned, "reproducible from the seed");
  for (const g of OWNER_GOALS) {
    assert.equal(/agentgoods|marketplace|AIC|store on|buy (it|a tool)|sell it/i.test(g), false, g.slice(0, 60));
  }
});

test("the goal prompt keeps every owner rule and adds only the goal objective and the deliverable field", () => {
  const p = systemPromptFor("economy", true, true);
  assert.match(p, /YOUR OWNER'S GOAL/);
  assert.match(p, /"deliverable"/);
  assert.match(p, /within 10 minutes/);
  assert.match(p, /Never mint tokens/);
  assert.equal(/agentgoods|marketplace/i.test(p), false);
});
