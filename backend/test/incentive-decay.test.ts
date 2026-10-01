/**
 * The incentive figure the API publishes must equal what the contract will actually pay.
 *
 * `/api/v1/stores` ranks and displays `nextUnitRewardAIC`, computed with a one-line formula. The
 * contract computes rewards with a loop. If those two ever disagree, the market is being ranked on
 * a number nobody will be paid — so the single-unit shortcut is checked against the protocol
 * mirror here, including at both gates, for both store types.
 *
 * It also pins the two facts sellers get wrong: the decay applies WITHIN one purchase, and rentals
 * pay exactly 100x less per unit because a rentals unit is a period of time.
 */
import { previewReward } from "../src/stores/quotes";

/** The exact protocol parameters, from the contracts. */
const SALES = { numerator: 2n, denominator: 1000n, minimumPool: 500n, poolGate: 0n };
const RENTALS = { numerator: 2n, denominator: 100000n, minimumPool: 500n, poolGate: 100000n };

/** The single-unit formula the stores endpoint publishes. */
const nextUnit = (pool: bigint, p: typeof SALES): bigint =>
  pool <= p.poolGate || pool < p.minimumPool ? 0n : (pool * p.numerator) / p.denominator;

let bad = 0;
const eq = (name: string, a: bigint, b: bigint) => {
  if (a !== b) { bad++; console.log(`  FAIL ${name}: ${a} !== ${b}`); }
  else console.log(`  PASS ${name}: ${a}`);
};

const AIC = (n: string) => BigInt(n) * 10n ** 18n;

console.log("\npublished next-unit reward == protocol previewReward(pool, 1)\n");
for (const pool of [AIC("1000"), AIC("1"), 1_000_000n, 100_001n, 100_000n, 499n, 0n]) {
  eq(`sales   pool=${pool}`, nextUnit(pool, SALES), previewReward(pool, 1, SALES));
  eq(`rentals pool=${pool}`, nextUnit(pool, RENTALS), previewReward(pool, 1, RENTALS));
}

console.log("\ngeometric decay within one purchase (sales, 1000 AIC pool)\n");
const pool = AIC("1000");
const one = previewReward(pool, 1, SALES);
const ten = previewReward(pool, 10, SALES);
console.log(`  1 unit  = ${one}`);
console.log(`  10 units= ${ten}`);
eq("10 units is LESS than 10x one unit (decay applies within the purchase)", ten < one * 10n ? 1n : 0n, 1n);

console.log("\nrentals pays 100x less per unit at the same pool\n");
const s1 = previewReward(pool, 1, SALES);
const r1 = previewReward(pool, 1, RENTALS);
console.log(`  sales   ${s1}`);
console.log(`  rentals ${r1}`);
eq("sales / rentals == 100", s1 / r1, 100n);

console.log(bad === 0 ? "\nALL INCENTIVE CHECKS PASSED\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
