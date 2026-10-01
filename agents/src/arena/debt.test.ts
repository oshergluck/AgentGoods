import { buildSchedule, debtStatus, applyPayment, applyBorrowing, DEBT_TOTAL_BASE, GRACE_MS, MAX_EXTRA_BORROW_BASE, simHours, MIN_INSTALMENTS, MAX_INSTALMENTS } from "./debt";
import { ethers } from "ethers";

const TOTAL = 4 * 60 * 60 * 1000;
let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { console.log("FAIL:", m); fails++; } };

// 1. every possible instalment count sums to exactly 1600
for (let n = MIN_INSTALMENTS; n <= MAX_INSTALMENTS; n++) {
  const d = buildSchedule(TOTAL, () => (n - MIN_INSTALMENTS) / (MAX_INSTALMENTS - MIN_INSTALMENTS + 1) + 1e-9);
  const sum = d.instalments.reduce((a, i) => a + BigInt(i.amountBase), 0n);
  ok(sum === DEBT_TOTAL_BASE, `count ${d.instalments.length}: sums to ${ethers.formatUnits(sum,6)} not 1600`);
}
// 2. counts stay inside 10..30 over many draws
let lo = 99, hi = 0;
for (let i = 0; i < 4000; i++) {
  const c = buildSchedule(TOTAL).instalments.length;
  lo = Math.min(lo, c); hi = Math.max(hi, c);
}
ok(lo >= MIN_INSTALMENTS && hi <= MAX_INSTALMENTS, `counts ranged ${lo}..${hi}`);
console.log(`instalment counts observed: ${lo}..${hi}`);

// 3. last instalment + grace must land before the run ends
for (let i = 0; i < 500; i++) {
  const d = buildSchedule(TOTAL);
  const last = d.instalments[d.instalments.length - 1]!.dueAtElapsedMs;
  ok(last + GRACE_MS < TOTAL, `last due ${last} + grace exceeds run`);
}

// 4. paying in full, instalment by instalment, clears everything and never over/under-counts
const d = buildSchedule(TOTAL, () => 0);   // MIN_INSTALMENTS equal instalments
ok(d.instalments.length === MIN_INSTALMENTS, `expected ${MIN_INSTALMENTS}, got ${d.instalments.length}`);
for (const inst of [...d.instalments]) {
  applyPayment(d, BigInt(inst.amountBase), "t");
}
ok(BigInt(d.repaidBase) === DEBT_TOTAL_BASE, `repaid ${ethers.formatUnits(BigInt(d.repaidBase),6)}`);
ok(debtStatus(d, TOTAL).outstandingBase === 0n, "outstanding not zero after paying all");
ok(debtStatus(d, TOTAL).failed === null, "fully paid agent still marked failed");

// 5. an unpaid instalment is a warning inside grace and fatal after it
const e = buildSchedule(TOTAL, () => 0);
const due = e.instalments[0]!.dueAtElapsedMs;
ok(debtStatus(e, due - 1).overdue === null, "overdue before due");
ok(debtStatus(e, due).overdue?.n === 1, "not overdue at due moment");
ok(debtStatus(e, due + GRACE_MS - 1000).failed === null, "killed inside grace");
ok(debtStatus(e, due + GRACE_MS + 1000).failed?.n === 1, "not killed after grace");

// 6. paying late-but-inside-grace saves it
const f = buildSchedule(TOTAL, () => 0);
applyPayment(f, BigInt(f.instalments[0]!.amountBase), "t");
ok(debtStatus(f, due + GRACE_MS + 1000).failed === null, "paid instalment still fatal");

/*
 * 7. overpay rolls forward, never lost — which is what this test was always called, and the
 * opposite of what it used to assert. It required repaidBase to be 320 after a payment of 400,
 * i.e. it pinned the 80 as DESTROYED while its own name said it rolled forward. The money had
 * really been transferred, so crediting 320 took 80 from the payer.
 */
const g = buildSchedule(TOTAL, () => 0);
/* One instalment plus a quarter of the next: clears exactly one, carries the rest as credit. */
const PER = DEBT_TOTAL_BASE / BigInt(MIN_INSTALMENTS);
const SENT = PER + PER / 4n;
const r = applyPayment(g, SENT, "t");
ok(r.cleared.length === 1, `${ethers.formatUnits(SENT,6)} should clear 1 instalment, cleared ${r.cleared.length}`);
ok(r.unallocatedBase === PER / 4n, `leftover ${ethers.formatUnits(r.unallocatedBase,6)}`);
ok(BigInt(g.repaidBase) === SENT, `repaid ${ethers.formatUnits(BigInt(g.repaidBase),6)} — every unit sent must be credited`);
ok(BigInt(g.creditBase ?? "0") === PER / 4n, `carried credit ${g.creditBase}, expected ${PER / 4n}`);

// 8. the clock maps correctly
ok(simHours(0, TOTAL) === 0, "sim 0");
ok(Math.abs(simHours(TOTAL, TOTAL) - 72) < 1e-9, "sim end != 72");
ok(Math.abs(simHours(TOTAL/2, TOTAL) - 36) < 1e-9, "sim half != 36");
ok(Math.abs(simHours(GRACE_MS, TOTAL) - 3) < 1e-9, `grace should be 3 sim hours, is ${simHours(GRACE_MS, TOTAL)}`);

// ---------------------------------------------------------------- borrowing
// 9. borrowing adds principal + 10% and spreads it over UNPAID instalments only
{
  const b = buildSchedule(TOTAL, () => 0);                    // MIN_INSTALMENTS x (1600 / MIN_INSTALMENTS)
  applyPayment(b, BigInt(b.instalments[0]!.amountBase), "t"); // pay #1, leaving 9 unpaid
  const beforeTotal = BigInt(b.totalBase);

  const r = applyBorrowing(b, ethers.parseUnits("900", 6));
  ok(r.ok, "borrow 900 refused");
  if (r.ok) {
    ok(r.addedToObligationBase === ethers.parseUnits("990", 6),
       "900 at 10% should add 990, added " + ethers.formatUnits(r.addedToObligationBase, 6));
    ok(r.spreadOver === MIN_INSTALMENTS - 1, `should spread over ${MIN_INSTALMENTS - 1} unpaid, spread over ` + r.spreadOver);
  }
  ok(BigInt(b.totalBase) === beforeTotal + ethers.parseUnits("990", 6), "total not inflated correctly");
  ok(b.instalments[0]!.amountBase === (DEBT_TOTAL_BASE / BigInt(MIN_INSTALMENTS)).toString(), "a PAID instalment was inflated");

  const sum = b.instalments.reduce((a, i) => a + BigInt(i.amountBase), 0n);
  ok(sum === BigInt(b.totalBase), "table sums " + ethers.formatUnits(sum, 6) + " but owes " + ethers.formatUnits(BigInt(b.totalBase), 6));

  const st = debtStatus(b, 0);
  ok(st.outstandingBase === BigInt(b.totalBase) - BigInt(b.repaidBase), "outstanding does not reconcile with total - repaid");
}

// 10. the 5000 ceiling holds, cumulatively
{
  const c = buildSchedule(TOTAL, () => 0);
  ok(applyBorrowing(c, ethers.parseUnits("5001", 6)).ok === false, "borrowed over the limit in one go");
  ok(applyBorrowing(c, ethers.parseUnits("3000", 6)).ok === true, "3000 refused");
  ok(applyBorrowing(c, ethers.parseUnits("2001", 6)).ok === false, "cumulative limit not enforced");
  ok(applyBorrowing(c, ethers.parseUnits("2000", 6)).ok === true, "exactly 5000 refused");
  ok(BigInt(c.borrowedExtraBase!) === MAX_EXTRA_BORROW_BASE, "borrowed total wrong");
  ok(applyBorrowing(c, ethers.parseUnits("1", 6)).ok === false, "borrowed past a full ceiling");
  ok(BigInt(c.totalBase) === ethers.parseUnits("7100", 6),
     "total should be 7100, is " + ethers.formatUnits(BigInt(c.totalBase), 6));
  const sum = c.instalments.reduce((a, i) => a + BigInt(i.amountBase), 0n);
  ok(sum === BigInt(c.totalBase), "table does not sum to total after max borrowing");
}

// 11. borrowing is refused when nothing is left to spread it onto
{
  const d2 = buildSchedule(TOTAL, () => 0);
  for (const inst of [...d2.instalments]) applyPayment(d2, BigInt(inst.amountBase), "t");
  ok(applyBorrowing(d2, ethers.parseUnits("100", 6)).ok === false, "borrowed with no unpaid instalments");
}

// 12. a borrowed, fully-repaid loan reconciles exactly
{
  const e2 = buildSchedule(TOTAL, () => 0);
  applyBorrowing(e2, ethers.parseUnits("1000", 6));   // owes 1600 + 1100 = 2700
  ok(BigInt(e2.totalBase) === ethers.parseUnits("2700", 6), "total after borrow 1000 wrong");
  for (const inst of [...e2.instalments]) applyPayment(e2, BigInt(inst.amountBase), "t");
  ok(BigInt(e2.repaidBase) === ethers.parseUnits("2700", 6),
     "repaid " + ethers.formatUnits(BigInt(e2.repaidBase), 6) + " not 2700");
  ok(debtStatus(e2, TOTAL).outstandingBase === 0n, "still owes after paying the inflated table");
}

console.log(fails === 0 ? "\nALL DEBT TESTS PASSED" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
