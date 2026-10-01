# Final implementation audit

A sweep over the whole system before deployment, recording what was verified, what was found, and —
in its own section, because it is the part that matters — what is **not** covered.

Date of sweep: 2026-09-23.

---

## 1. Verified state

Every one of these was run, not assumed:

| Check | Command | Result |
|---|---|---|
| Contracts | `npx hardhat test` | **281 passing** |
| Backend | `npm test` | **132 passing** |
| Backend types | `npm run typecheck` | clean |
| Frontend types | `npm run typecheck` | clean |
| Frontend build | `npm run build` | clean, 268 kB / 82 kB gzip |
| Agent SDK types | `npx tsc --noEmit` | clean |
| Secret scan | `npm run secrets:scan` | **clean, 198 files** |
| Deployment gate, LOCAL | `deploy-gate.mjs … LOCAL` | PASS |
| Deployment gate, PRODUCTION on a mock manifest | `deploy-gate.mjs … PRODUCTION` | **correctly REFUSED** |
| Generated docs | `generate-docs.mjs` | 3 regenerated, scan still clean afterwards |

That last row is a check rather than a formality: regenerating the matrices is what surfaced F-013.

## 2. What this sweep found

Four findings, all closed. Full write-ups in `SECURITY_FINDINGS.md`.

### F-013 — the secret scanner's own regex was corrupted · High

The most serious of the four, and the one worth reading in full. Two `\b` word boundaries in
`isHashContext()` had become literal `0x08` control characters, so the pattern matched an actual
backspace byte and the function could never return true. **Every hash-context suppression in the
scanner had been inert**, invisibly.

It stayed invisible because a broken suppression makes a scanner *noisier*, so it kept exiting zero.
The tempting repairs — widen a pattern, allow-list the values — would each have concealed a security
gate that had silently stopped doing half its job.

Now repaired, restructured into substring and word-boundary lists so camelCase works, made
markdown-table aware, and given **its own test suite** asserting both that it catches and that it
does not cry wolf.

### F-008 — the deployment gate created an unsatisfiable requirement · High

The gate demanded `roles.timelock` for every non-LOCAL environment. The timelock is deployed by
`handoff.js`, which refuses to run until a 72-hour proving run has completed against a live
deployment. Circular: the requirement could never be met at deploy time.

An unsatisfiable gate does not get satisfied, it gets bypassed. Scoped to `PRODUCTION`, which now
means "authority has been handed over" rather than "on mainnet" (D-033).

### F-011 — documentation claimed a test that did not exist · Medium

`OPERATOR_REVENUE.md` stated that a test proved the holder reserve unwithdrawable. The claim was
true; the test was not there, so nothing would have caught a future change making it false.

Now `contracts/test/12-holder-reserve-unreachable.test.js`, which sweeps the store's entire ABI and
fails on any value-moving function outside a reviewed allow-list.

### F-012 — wrong fee constants and a missing revenue stream · Low

The same document named fee types that do not exist and omitted the 5% `DIVIDEND_PROCESSING` fee
entirely. It also described five fee constants as governable when `HOLDER_RESERVE_BPS` has no setter
at all.

## 3. What was built during the sweep

| Added | Why |
|---|---|
| `contracts/script/handoff.js` | Phase 8 had **no tooling**. The timelock contract existed and nothing deployed it. |
| `contracts/test/13-handoff.test.js` (11 tests) | the handoff is the one operation with no recovery path |
| `contracts/test/12-holder-reserve-unreachable.test.js` (8 tests) | makes a documented invariant enforced rather than asserted |
| `contracts/test/14-lifecycle-simulation.test.js` (3 tests) | closed-system USDC conservation across a whole lifecycle |
| `backend/test/scan-secrets.test.ts` (8 tests) | the scanner is a security gate and had none |
| 3 gate tests for the staged PROVING/PRODUCTION flow | scoping one check must not silently scope its neighbours |
| `contracts/test/15-graduation-blocked.test.js` (9 tests) | graduation is abandoned, not reverted, when a funded pool pre-exists (D-035) |

### On the handoff script specifically

It is the most dangerous script in the repository, and the danger is not the obvious one. Revoking
`DEFAULT_ADMIN_ROLE` from the operator before the timelock demonstrably holds it produces a protocol
that **nobody can ever administer** — the roles are gone and the only function that could restore
them requires a role no address holds. Not recoverable with money, access or time.

So it grants everything, reads every role back from chain, and only then revokes. The worst
realistic outcome becomes "two administrators" rather than "none". It dry-runs by default, refuses
a proposer that is the bootstrap admin or the guardian, and checks the 72-hour proving gate itself
rather than trusting anyone's memory.

## 4. Invariants now enforced by test

Not claimed in prose — enforced, with the file that does it:

| Invariant | Enforced by |
|---|---|
| The holder reserve is unreachable by every role, including a successor controller | `12-holder-reserve-unreachable` |
| No value-moving function exists on a store outside a reviewed allow-list | `12-…` (ABI sweep) |
| A market with a pre-existing funded pool abandons graduation and keeps trading | `15-graduation-blocked` |
| An empty pair does NOT block graduation, so the mitigation cannot be weaponised | `15-…` |
| The DEX listing survives pair front-running | `11-dex-transition-real` |
| All LP and all leftover inventory are burned at the listing | `11-…` |
| Dividend entitlement is minimum-balance-in-window; a snipe earns zero | `10-holding-window` |
| USDC is conserved across a whole lifecycle including a real listing | `14-lifecycle-simulation` |
| Total AIC never exceeds genesis, at any point | `14-…` |
| The handoff never leaves a contract with no administrator | `13-handoff` |
| The gate cannot be talked out of a refusal | `deploy-gate.test.ts` |
| The secret scanner still catches real secrets | `scan-secrets.test.ts` |
| A GET never reaches the chain | route suites, via `forbidRpc()` |

## 5. What is NOT covered

The honest section. Everything above is true and none of it is the same as being audited.

**No external audit has been performed.** This is a deliberate operator decision — audit when there
are enough users to justify it — not an oversight, and nothing in this repository claims otherwise.

**Nothing has run on a real network.** Every test result above is from a local chain. The DEX
listing has been driven against the official Uniswap artifacts with the canonical init code hash
verified, which is the closest available substitute, but it has never executed against a real
explorer, a real RPC provider or real network timing. Base Sepolia first is not a formality.

**The 72-hour proving run has not happened.** That is Phase 7, it needs a live deployment, and it
gates the handoff.

**Mainnet gas costs are unmeasured.** They will be measured on testnet and reported before anything
is spent.

**O-001 remains open and accepted:** `PAUSE_MARKET` blocks `sell`, so a compromised guardian key
produces an outage during which holders cannot exit, with a floor equal to the timelock delay. It is
a deliberate trade — a pause that left selling open would let whoever noticed a pricing defect first
drain the reserve — and it is the main argument against a long delay. Documented rather than hidden.

**O-002 remains open and accepted:** anyone can permanently prevent a token from listing by funding
an external pool before it reaches 30%, for the cost of a dust seed. The token keeps trading on its
curve in both directions and nothing else about it changes, so the cost is "never lists" rather than
"breaks" — but it is a real griefing vector with no capital requirement, and the alternatives
(listing at the attacker's price, or reverting forever) are worse. D-035; full reasoning in
`SECURITY_FINDINGS.md`. **`GraduationBlocked` is indexed and worth watching on mainnet:** one
occurrence may be opportunism, a pattern across stores would be a campaign and would justify
revisiting the trade.

**Load and scale are untested.** The indexer, the API and the database have not been tested under
concurrent load.

## 6. Readiness

| Phase | State |
|---|---|
| 0 — local verification | ✅ everything green |
| 1 — secrets and accounts | ⏸ **needs the operator** |
| 2 — testnet | ready; needs Phase 1 |
| 3 — the gate | ready, tested in both directions |
| 4 — mainnet | ready; needs a clean testnet run |
| 5 — hosting | Dockerfiles and config ready |
| 6 — domain | checklist ready; needs Cloudflare/Namecheap access |
| 7 — proving run | harness ready; needs 75 USDC and a live deployment |
| 8 — handoff | script and tests ready; needs the multisig signer addresses |

**Nothing in the codebase blocks Phase 1.** The next move is the operator's.

## 7. Judgement calls worth recording

Several planned documents were not written, deliberately:

- **`TOKENOMICS_SIMULATION` and `ADVERSARIAL_SIMULATION`** were built as **runnable tests**
  (`14-lifecycle-simulation.test.js`, and the adversarial content folded into `11-` and `12-`)
  rather than as prose. A simulation described in a document proves nothing; one that runs in CI
  fails when the system changes.
- **`RAILWAY_PROVING_AND_CLOUDFLARE_CUTOVER`** would duplicate `DOMAIN_CUTOVER_CHECKLIST.md` and
  `DEPLOYMENT_RUNBOOK.md` §5–7. Two documents describing one procedure is how they drift apart.
- **`V0_V1_MIGRATION`** describes a migration that does not apply: no V0 is in production, and
  `contractsv0/` and `backendv0/` are read-only historical reference.
- **`MOLTBOOK_AGENT_LAUNCH`** is forward-looking rather than load-bearing and does not block launch.
  Worth writing once there is a launch to plan around.

**`FUTURE_NATIVE_DEX` was subsequently written** (D-036), because it stopped being speculative: it
is the permanent fix for O-002, and deferring it is now an active decision with a stated
precondition rather than an absence of one.

If any of these is wanted anyway, say so — the omission is a judgement about value, not a claim that
they could not be written.
