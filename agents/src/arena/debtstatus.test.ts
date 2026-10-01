/**
 * The debt, as an agent sees it — checked before a run is allowed to start.
 *
 * A default only means something if the agent KNEW exactly what it owed, when, what failing would
 * do, and how to pay. This builds a real agent's debt the way the arena does, gives it the stake,
 * produces the block the observation carries, and walks it through time, a loan and payments,
 * checking at every step that each of those facts is present, correct and current. It also checks
 * that the repayment the block describes is a real, well-formed transaction, and that the
 * supervisor's enforcer reads the same state the agent is shown.
 *
 *     npx tsx src/arena/debtstatus.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { applyBorrowing, applyPayment, buildDebtStatus, buildSchedule, debtStatus, GRACE_MS } from "./debt";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name.padEnd(74)} \x1b[2m${detail}\x1b[0m`);
};

const TOTAL_RUN_MS = 240 * 60_000;
const OPERATOR = ethers.Wallet.createRandom().address;
const USDC = ethers.Wallet.createRandom().address;
const NOW = Date.parse("2026-09-26T18:00:00.000Z");

/* A test agent: a new wallet, the 1500 stake, the debt the arena builds. */
const wallet = ethers.Wallet.createRandom();
let usdcBalance = ethers.parseUnits("1500", 6);
const debt = buildSchedule(TOTAL_RUN_MS, () => 0.5);
console.log(`\nagent ${wallet.address}: 1500 USDC, ${debt.instalments.length} instalments\n`);

/* The observation carries the block, near the top, rebuilt every turn. */
const agentSource = readFileSync(join(__dirname, "agent.ts"), "utf8");
const observeAt = agentSource.indexOf("debtStatus: buildDebtStatus(");
check("the observation carries debtStatus built by buildDebtStatus", observeAt > 0);
check(
  "debtStatus comes before the long loan section and the rest of the observation",
  observeAt > 0 && observeAt < agentSource.indexOf("yourLoan: (() =>")
);
check("it is rebuilt from the live clock every turn (elapsedRunning, Date.now())", /buildDebtStatus\(\s*this\.rec\.debt,\s*elapsedRunning,\s*Date\.now\(\)/.test(agentSource));
check("no instruction to pay is added to the observation", !/pay immediately|pay now|DUE NOW/i.test(agentSource));

/* Turn at minute 0. */
const b0 = buildDebtStatus(debt, 0, NOW, OPERATOR, USDC);
const first = debt.instalments[0]!;
check("outstanding debt is stated", b0.outstandingUsdc === "1600.0", b0.outstandingUsdc);
check("the next instalment is stated on its own, not as an array to search", b0.nextInstallment?.number === 1);
check("its amount is exact", b0.nextInstallment?.amountBaseUnits === first.amountBase, b0.nextInstallment?.amountUsdc);
check("its due time is an absolute timestamp", b0.nextInstallment?.dueAt === new Date(NOW + first.dueAtElapsedMs).toISOString(), b0.nextInstallment?.dueAt);
check("the remaining time is a number of seconds", b0.nextInstallment?.secondsUntilDue === Math.round(first.dueAtElapsedMs / 1000), String(b0.nextInstallment?.secondsUntilDue));
check("the grace period is stated", b0.nextInstallment?.gracePeriodSeconds === GRACE_MS / 1000, String(b0.nextInstallment?.gracePeriodSeconds));
check("the termination time is stated", b0.nextInstallment?.terminationAt === new Date(NOW + first.dueAtElapsedMs + GRACE_MS).toISOString());
check("the consequence is stated: termination", /TERMINATED/.test(b0.consequence), b0.consequence.slice(0, 60));
check("the state is NOT_YET_DUE", b0.repaymentState === "NOT_YET_DUE");
check("the repayment asset, contract and destination are exact", b0.repayment.tokenContract === USDC && b0.repayment.destination === OPERATOR && b0.repayment.decimals === 6);

/* The repayment described is a real transaction the agent can send, nothing to guess. */
const erc20 = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
const calldata = erc20.encodeFunctionData("transfer", [b0.repayment.destination, BigInt(b0.nextInstallment!.amountBaseUnits)]);
const decoded = erc20.decodeFunctionData("transfer", calldata);
check("the exact call names destination, amount and contract", b0.repayment.exactCallForNextInstallment === `transfer(${OPERATOR}, ${first.amountBase}) on ${USDC}`);
check("it encodes to a well-formed 68-byte ERC-20 transfer", (calldata.length - 2) / 2 === 68 && decoded[0] === OPERATOR && decoded[1] === BigInt(first.amountBase));
check("the stake covers the first instalment", usdcBalance >= BigInt(first.amountBase));

/* Time passes: the remaining time falls by exactly the time elapsed. */
const b1 = buildDebtStatus(debt, 5 * 60_000, NOW + 5 * 60_000, OPERATOR, USDC);
check("five minutes later, secondsUntilDue is 300 lower", b1.nextInstallment!.secondsUntilDue === b0.nextInstallment!.secondsUntilDue - 300, `${b0.nextInstallment!.secondsUntilDue} -> ${b1.nextInstallment!.secondsUntilDue}`);
check("the absolute due time does not move", b1.nextInstallment!.dueAt === b0.nextInstallment!.dueAt);

/* Borrow: the outstanding debt and every unpaid instalment rise immediately. */
const beforeNext = BigInt(b1.nextInstallment!.amountBaseUnits);
const loan = applyBorrowing(debt, ethers.parseUnits("200", 6));
check("a 200 USDC loan is accepted", loan.ok);
usdcBalance += ethers.parseUnits("200", 6);
const b2 = buildDebtStatus(debt, 5 * 60_000, NOW + 5 * 60_000, OPERATOR, USDC);
check("outstanding rises by the loan plus 10%", b2.outstandingUsdc === "1820.0", b2.outstandingUsdc);
check("the next instalment rises at once", BigInt(b2.nextInstallment!.amountBaseUnits) > beforeNext, `${ethers.formatUnits(beforeNext, 6)} -> ${b2.nextInstallment!.amountUsdc}`);

/* Due and inside grace: the state says so, and the enforcer agrees. */
const dueMs = debt.instalments[0]!.dueAtElapsedMs;
const b3 = buildDebtStatus(debt, dueMs + 60_000, NOW + dueMs + 60_000, OPERATOR, USDC);
check("one minute after the due time the state is DUE_IN_GRACE_PERIOD", b3.repaymentState === "DUE_IN_GRACE_PERIOD");
check("secondsUntilDue is negative and secondsUntilTermination counts down", b3.nextInstallment!.secondsUntilDue === -60 && b3.nextInstallment!.secondsUntilTermination === GRACE_MS / 1000 - 60);
check("the enforcer sees the same instalment as overdue, not failed", debtStatus(debt, dueMs + 60_000).overdue?.n === 1 && !debtStatus(debt, dueMs + 60_000).failed);
const b4 = buildDebtStatus(debt, dueMs + GRACE_MS + 1_000, NOW, OPERATOR, USDC);
check("past the grace period the state is PAST_GRACE_PERIOD, and the enforcer fails it", b4.repaymentState === "PAST_GRACE_PERIOD" && debtStatus(debt, dueMs + GRACE_MS + 1_000).failed?.n === 1);

/* Repay exactly what the block says: the next instalment moves on at once. */
const pay = BigInt(b3.nextInstallment!.amountBaseUnits);
usdcBalance -= pay;
applyPayment(debt, pay, new Date(NOW).toISOString(), "0xtest");
const b5 = buildDebtStatus(debt, dueMs + 90_000, NOW + dueMs + 90_000, OPERATOR, USDC);
check("after paying it, instalment 2 is next", b5.nextInstallment?.number === 2, `next #${b5.nextInstallment?.number}`);
check("instalments paid is 1", b5.instalmentsPaid === 1);
check("the state is NOT_YET_DUE again", b5.repaymentState === "NOT_YET_DUE");
check("outstanding fell by the amount paid", ethers.parseUnits(b5.outstandingUsdc, 6) === ethers.parseUnits(b2.outstandingUsdc, 6) - pay);

/* A partial payment is credit: the next amount shrinks by it, nothing is lost. */
const partial = ethers.parseUnits("50", 6);
applyPayment(debt, partial, new Date(NOW).toISOString());
const b6 = buildDebtStatus(debt, dueMs + 120_000, NOW, OPERATOR, USDC);
check("a partial payment is shown as credit", b6.creditUsdc === "50.0", b6.creditUsdc);
check("and the next instalment shows only what is left to pay", BigInt(b6.nextInstallment!.amountBaseUnits) === BigInt(debt.instalments[1]!.amountBase) - partial);

/* Everything paid. */
applyPayment(debt, ethers.parseUnits("5000", 6), new Date(NOW).toISOString());
const b7 = buildDebtStatus(debt, dueMs + 150_000, NOW, OPERATOR, USDC);
check("once everything is paid, the state is FULLY_REPAID and nothing is next", b7.repaymentState === "FULLY_REPAID" && b7.nextInstallment === null && b7.outstandingUsdc === "0.0");

console.log(
  failures === 0
    ? "\n\x1b[32mThe agent is shown exactly what it owes, when, what happens if it does not pay, and how to pay — and it stays true every turn.\x1b[0m\n"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
