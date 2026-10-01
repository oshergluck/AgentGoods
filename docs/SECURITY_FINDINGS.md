# Security findings

Real defects found while building this system, with what caused each one and what closed it.

This is not an audit. No external audit has been performed, and none is claimed — see the note at
the end. It is the internal record, kept because the useful question about a codebase is not "were
there bugs" but "what kind, how were they found, and does the same class remain possible".

Severity is about consequence if it had reached production, not about how hard it was to fix.

---

## F-001 — SSRF bypass via IPv6 normalization · **Critical** · Closed

**Where:** `backend/src/webhooks/ssrf.ts`, in this codebase's own first implementation.

**What:** the loopback check was written against the dotted IPv4-mapped spelling
`::ffff:127.0.0.1`. But a URL host of `[::ffff:127.0.0.1]` is normalized by the parser to the hex
form `[::ffff:7f00:1]`, which the check did not match. A webhook could therefore be registered
against the server's own loopback interface.

**Why it survived its own test:** the test asserted the dotted spelling, which the check handled.
The test and the defect shared an assumption, so the test passed and proved nothing.

**Fix:** `expandIPv6()` normalizes before comparison. Both spellings are now asserted.

**The generalisable lesson**, and the reason this one is written up first: a validator and its test
written in the same sitting tend to share the author's mental model of the input. The input space
has to be enumerated from the *parser's* behaviour, not from the author's idea of what the input
looks like.

---

## F-002 — Webhook secrets were hashed, making signing impossible · **High** · Closed

**What:** secrets were stored as a one-way hash, by analogy with password storage. Correct instinct,
wrong primitive: the delivery worker needs the secret *itself* to compute an HMAC, so the design
could not work — and the shape of the failure would have been "webhooks silently unsigned" rather
than a crash.

**Fix:** secrets are **derived**, never stored — HMAC over `aic-webhook-secret:v1:<webhookId>` keyed
by the master secret. Verification without storage. Rotation is a version bump.

---

## F-003 — Three disagreeing price scales · **Critical** · Closed

**What:** the contract reported price at `1e36`, the indexer's trade projection at `1e18`, and the
indexer's spot projection at `1e36`. A true price of `7.16e-6` USDC was being served to the API as
`7.16` — off by six orders of magnitude, in the direction that makes something worthless look
valuable.

**Why it is the most dangerous kind of bug here:** nothing errors. Every layer is internally
consistent and confident.

**Fix:** `PRICE_SCALE = 1e30` as the single definition across contracts, indexer and frontend
(1e18 scaling × 1e12 for the USDC-6 / token-18 decimal gap). Recorded as D-019.

---

## F-004 — Genesis supply double-counted · **High** · Closed

**What:** stores reported 2B total supply against a 1B genesis. `MarketInitialized` set
`currentSupplyAIC = genesis`, and the mint `Transfer` incremented it again on a later discovery
pass.

**Found by:** the operator, looking at the UI. Worth recording — it was visible to a person and
invisible to the test suite, because every test asserted deltas rather than the absolute total.

**Fix:** supply is derived as `genesis - burned` rather than accumulated.

---

## F-005 — `virtualUSDCReserve` conflated two different quantities · **Medium** · Closed

**What:** a field named "virtual" moved when real USDC entered, because it was seed + real. Anyone
reasoning about curve mechanics from the API would have been wrong about which part was constant.

**Fix:** split into `virtualSeedUSDC` (constant) and `curvePricingReserveUSDC` (moves), with a
`reserveIdentity` the caller can check. D-020.

**Also found by the operator**, from first principles — "virtual liquidity shouldn't change". A name
that misdescribes its quantity is a defect even when the arithmetic is right.

---

## F-006 — Zero price on a live, untraded curve · **Medium** · Closed

**What:** a market with no trades yet reported a price of 0 rather than its curve price. A consumer
treating 0 as "free" or dividing by it would have been badly wrong.

**Fix:** the series is seeded at `MarketInitialized`.

---

## F-007 — Chain time compared against wall-clock time · **Medium** · Closed

**What:** transaction deadlines were computed from the server's clock and compared against block
timestamps, producing spurious `DeadlinePassed` failures whenever the two drifted.

**Fix:** `backend/src/db/chainTime.ts` derives "now" from the indexed block log — no RPC call, no
wall clock. D-021.

---

## F-008 — The deployment gate created an unsatisfiable requirement · **High** · Closed

**What:** the gate required `roles.timelock` for every non-LOCAL environment. But the timelock is
deployed by `script/handoff.js`, which refuses to run until a 72-hour proving run has completed
against a live deployment — which requires the deployment to exist. The requirement could never be
met at deploy time.

**Why it is a security finding rather than a bug:** an unsatisfiable gate does not get satisfied, it
gets bypassed. A check that blocks legitimate work teaches people to route around it, and then it is
not protecting anything.

**Fix:** the timelock requirement is scoped to `PRODUCTION`, which now means "authority has been
handed over" rather than "on mainnet". Every other check applies in full at `PROVING`, asserted by
its own test. D-033.

---

## F-009 — Indexer reported "backfilling" while fully healthy · **Low** · Closed

**What:** the backfill threshold was `safeConfirmations * 4`, which is 0 when confirmations are 0,
so a caught-up indexer reported itself as behind.

**Why it matters more than "low" suggests:** a health signal that cries wolf is one operators learn
to ignore, and then it fails to signal the real thing.

**Fix:** `MIN_BACKFILL_BLOCKS = 25`.

---

## F-010 — `keyFor()` rotated the key it returned · **Medium** · Closed

**What:** the agent SDK helper rotated the API key as a side effect of reading it, so the value it
returned was already invalid — producing 401s that looked like a server fault.

**Fix:** `AicAgent.currentApiKey` reads without rotating.

---

## F-011 — Documentation claimed a test that did not exist · **Medium** · Closed

**What:** `OPERATOR_REVENUE.md` stated that a test proved the holder reserve has no withdrawal path.
No such test existed.

**Why it is a finding:** the claim was true — but it was unenforced, so nothing would have caught a
future change that made it false. A documented invariant with no test is a comment.

**Fix:** `contracts/test/12-holder-reserve-unreachable.test.js`. It sweeps the store's entire ABI and
fails on any value-moving function outside a reviewed allow-list, so a `sweepReserve()` added next
year fails on the *shape* of the ABI before anyone has to imagine how it might be abused. The sweep
immediately caught two functions (`transferController`, `withdrawRewardPool`) — both legitimate,
both now allow-listed with a stated reason and a behavioural proof.

---

## F-012 — Same document, wrong fee constants and a missing revenue stream · **Low** · Closed

**What:** the operator revenue document named fee types that do not exist, and omitted an entire
revenue stream — the 5% `DIVIDEND_PROCESSING` fee forwarded to the treasury at root finalization.

**Fix:** corrected against `IProtocolTreasury.sol`. Also corrected: five fee constants were
described as governable when `HOLDER_RESERVE_BPS` has no setter and is deliberately immutable.

---

## F-013 — The secret scanner's own regex was corrupted, disabling every suppression · **High** · Closed

**Where:** `backend/scripts/scan-secrets.ts`, `isHashContext()`.

**What:** the two `\b` word boundaries in the hash-context regex had been replaced by literal `0x08`
control characters, so the pattern was matching an actual backspace byte. The function could never
return `true` for any real line. Every hash-context suppression in the scanner was inert.

**Why nobody noticed, and why that is the point:** a broken *suppression* makes a scanner noisier,
not quieter — so it kept exiting zero, and nothing looked wrong until the generated
`CONTRACT_MATRIX.md` put runtime code hashes in front of it and it reported eight public code hashes
as private keys.

That is the dangerous shape for a security gate. The failure was invisible in the direction that
mattered, and the obvious "fix" for the noise — widening a pattern or allow-listing the values —
would have papered over a scanner that had stopped doing half its job, permanently.

**Found by:** the final audit sweep. The control characters are invisible in every editor and every
diff; the only thing that reliably catches them is asserting on the bytes.

**Fixes, in three parts:**

1. The boundaries are repaired, and `isHashContext` is restructured into two lists rather than one
   regex — unambiguous words (`hash`, `merkle`, `keccak`, `bytecode`…) matched case-insensitively as
   substrings so camelCase like `txHash` works, and short words (`id`, `tx`, `root`…) matched with
   boundaries so `id` does not exempt every line containing "valid".
2. Markdown table awareness. The label saying what a column *is* lives in the header row, not in the
   rows carrying values, so each line is now checked with its nearest table header attached. This is
   what closed the `CONTRACT_MATRIX.md` findings **without** touching a pattern.
3. **`backend/test/scan-secrets.test.ts` — the scanner now has its own tests**, asserting both that
   it still catches (bare keys, API keys, webhook secrets, AWS ids, real BIP-39 mnemonics) and that
   it does not cry wolf (transaction hashes, labelled code-hash columns, ordinary prose). One test
   asserts directly that the source contains no control characters.

**A note on the fixtures.** Every key-shaped value in that test file is assembled at runtime rather
than written as a literal, so the repository contains no 64-hex string, no `whsec_` string and no
twelve-word run at all. The alternative was allow-listing the scanner's own test file, which would
have meant a security gate with a permanent blind spot aimed at the one file most likely to contain
something key-shaped.

---

## F-014 — The deployment gate spoke a vocabulary no deployment used · **High** · Closed

**Found by:** running the real Base Sepolia deployment through it. Not by review — every layer read
correctly on its own.

**What:** `deploy-gate.mjs` accepted `LOCAL | STAGING | CANARY | PRODUCTION`. But
`backend/src/config/env.ts` defines `LOCAL | PROVING | CUTOVER | PRODUCTION`, and
`contracts/script/deploy.js` stamps a real testnet manifest `PROVING`. The gate also checks that the
manifest's declared environment equals the target — so **no genuine deployment could ever pass it**.

```
deploy-gate: REFUSED — manifest was built for PROVING, but this deployment targets CANARY
```

**Why it is the same class as F-008:** an enum that disagrees with the code writing the value it
validates is not a stricter check, it is a broken one. And a gate that always refuses gets bypassed,
which is precisely how it stops protecting anything.

**Fix:** one vocabulary, taken from the runtime — `LOCAL | PROVING | CUTOVER | PRODUCTION` — in the
gate, its tests and every document. The timelock requirement stays scoped to `PRODUCTION`.

---

## F-015 — Deploy scripts read state a lagging RPC had not seen yet · **High** · Closed

**Found by:** the Base Sepolia rehearsal, twice, in two different shapes.

**What:** `waitForDeployment()` and `tx.wait()` prove a transaction was *mined*. Behind a load
balancer they do not prove the node answering the next `eth_call` has seen that block.

1. Reading `decimals()` immediately after deploying MockUSDC returned `value="0x"` — a decode
   failure that reads like a broken ABI and is actually a race.
2. `authorizeFactory` was mined and succeeded, and the immediately following
   `isAuthorizedFactory` read returned `false` from a node one block behind.

**Why the second one is the serious one.** That read lived inside a post-deployment *check*, so a
completely correct deployment reported itself as FAILED and the script threw — **before writing the
manifest**. The contracts existed, were correct, and had been paid for, and the operator was left
with no record of their addresses. That is worse than an outright failure, and on mainnet it is
expensive and frightening.

**Fixes, in `contracts/script/lib/confirm.js`:**

- `waitForCode()` polls until bytecode is readable before any first call.
- `waitForValue()` polls a read until it matches, used after state-changing transactions so a
  settling delay happens where it is expected rather than inside a check meant to detect real faults.
- **The manifest is now written BEFORE a failed check can throw**, and the error points at it. The
  operator always ends up knowing what was deployed.

**The generalisable lesson:** on a public RPC, "mined" and "readable" are different events. Any
script that writes then immediately reads is racing, and the damage is worst when the read is a
safety check — because the failure mode is a correct system declaring itself broken.

---

## Open items

| # | Item | Severity | Status |
|---|---|---|---|
| O-001 | `PAUSE_MARKET` blocks `sell`, so a hostile guardian pause traps holders on the curve for at least the timelock delay | Medium | **Accepted, documented** |
| O-002 | Anyone can permanently prevent a token from listing by funding an external pool before it reaches 30% | Medium | **Accepted, documented** |

**O-001 in full.** This is a deliberate trade, not an oversight. A pause that left selling open
would let whoever noticed a pricing defect first drain the reserve at the wrong price, which defeats
the purpose of pausing. The cost is that a compromised guardian key produces an outage with a floor
equal to the timelock delay, during which holders cannot exit.

It is mitigated by keeping the guardian key separate from every other key (enforced by the
deployment gate and by `handoff.js`), and by choosing a timelock delay short enough that the outage
is survivable — 48 hours recommended. It is documented in `THREAT_MODEL.md` §6 and
`GUARDIAN_TIMELOCK_MODEL.md` §3 rather than being left for someone to discover.

**O-002 in full.** Anyone can create and fund a Uniswap pool for a store's AIC before the curve
reaches 30%. When that happens the market abandons graduation permanently (D-035) and never lists.
The attacker needs almost no capital — a pool seeded with one millionth of a USDC is enough.

**Why it is accepted rather than fixed.** The alternatives are worse:

- *List anyway* — that means depositing the curve's entire USDC reserve at a price the attacker
  chose. This is the outcome the 1% slippage bound exists to prevent, and it is the only genuinely
  dangerous one.
- *Revert* — the previous behaviour. Funds were always safe, but the revert happened inside `buy`,
  so every purchase crossing the threshold failed forever. The token became unbuyable past 30% with
  no explanation, which is a strictly worse user outcome than not listing.
- *Correct the pool price first* — arbitrage the hostile pool to the intended price using protocol
  funds before adding liquidity. This works in principle, but it means spending real USDC against an
  attacker-controlled pool inside the single most irreversible code path in the system. Not a trade
  worth making at launch.

**The permanent fix is known and deliberately deferred.** A protocol-owned AMM whose pool creation is
restricted to `AgentGoods` removes the attack entirely rather than defending against it — with nobody
else able to open a pool for the token, there is nothing to pre-seed. It is not built because a new
venue's liquidity is unreachable until aggregators and wallets integrate it, which is expensive, and
because it would discard the thing that makes the current listing tests credible: that they run
against official Uniswap artifacts. See `FUTURE_NATIVE_DEX.md` and D-036. It is published in the
Agent schema as explicitly non-binding intent, so no Agent prices against a roadmap item.

**What the current behaviour costs and what it preserves.** The cost is real: that token never lists
on an external DEX. What it preserves is everything else — the curve keeps trading in both
directions permanently, so no holder is trapped, and commerce, the 5% holder reserve, dividends and
governance are entirely unaffected. The condition is reported explicitly through `graduationBlocked`
on chain, in the API, in quotes, in the Agent schema and in the UI, rather than presenting as a
mysterious failure.

**Monitoring.** `GraduationBlocked` is indexed. If it ever fires on mainnet, it is worth
investigating who seeded the pool and why: a single occurrence may be opportunism or a mistake, but
a pattern across stores would be a deliberate campaign and would justify revisiting the trade above.

---

## On external audit

**No external audit has been performed**, and nothing in this repository should be read as claiming
one. The current position is that an audit happens when there are enough users to justify it, not
before launch — an explicit operator decision, not an oversight.

What exists instead, and what it is worth: 270 contract tests and 124 backend tests, including
adversarial suites driving the DEX listing against real Uniswap artifacts, fuzzed economic
invariants, and ABI-surface sweeps that fail on the shape of a change rather than on imagining its
abuse. That is meaningfully better than nothing and meaningfully less than an audit. Both halves of
that sentence are true.


---

## F-016 — A product could commit to no content, and our own API made that the default

**Severity:** medium. **Status:** fixed at the API layer; a contract-level gap remains and is
documented below. **Found by:** an external Agent reading the live protocol.

### What was wrong

`contentHash` is the seller's on-chain commitment to exactly the bytes a buyer receives. The
access gateway tells the buyer, in its own response, to check
`keccak256(delivered bytes) == contentHash` and explicitly not to take delivery on trust.

That instruction is worthless when the hash is zero. An all-zero commitment matches nothing, so
correct delivery, wrong delivery and empty delivery are indistinguishable, and the LicenseToken
stops being a claim on any particular content.

Two independent layers permitted it:

1. **`StoreBase.createProduct` never validates `contentHash`.** It rejects a zero `productId` and
   a zero `priceUSDC`, bounds the metadata URI and the rental period — and accepts `bytes32(0)`
   as a content commitment.
2. **Our own API made it the default.** `contentHash` was `.optional()` on the create route and
   the call site substituted `"0x" + "00".repeat(32)` when it was absent. A seller did not choose
   an unverifiable product; omitting one field produced one silently. Both products on the proving
   deployment carry a zero hash for exactly this reason.

The read surface compounded it: `contentHash` was returned, but nothing said that all-zero means
"no guarantee" — which is precisely the inference a buyer Agent cannot be expected to make.

### Fix

**Write path.** `contentHash` is now required and validated non-zero, on create and on update. The
update path refuses to re-commit a zero carried forward from a legacy product, so an old product
must gain a real commitment to be edited rather than silently propagating a missing one.

**Read path.** Every product now carries `contentIntegrity`:

```json
{ "status": "UNCOMMITTED",
  "warning": "This product commits to no content hash, so delivery cannot be verified against
              anything and the licence is not a claim on any particular content…" }
```

`COMMITTED` states how to verify; `UNCOMMITTED` warns. The buyer decides with the fact in front of
them.

**Tests.** `backend/test/content-commitment.test.ts` — zero rejected, omitted rejected (the actual
defect), mixed-case zero rejected, and every serialized product's status asserted to match its own
hash.

### Residual: the contract still permits it

`createProduct` is unchanged, because **per-store contracts are immutable EIP-1167 clones**. A
validation added today could only ever apply to stores created by a future Factory, never to any
store that exists now — so changing it would not close the gap for the deployment in question and
would force a full redeploy of the proving protocol.

The consequence is bounded and worth stating plainly: a product created by calling the store
contract **directly**, bypassing this API, can still carry a zero commitment. It will be labelled
`UNCOMMITTED` wherever the protocol surfaces it, so the exposure is to a buyer who ignores a
printed warning rather than to one who was never told.

**For the next Factory version:** `createProduct` should `revert ZeroContentHash()` on
`contentHash == bytes32(0)`. Recorded here rather than implemented, because tokenomics, governance
and the deployed clones must not change as a side effect of an API fix.
