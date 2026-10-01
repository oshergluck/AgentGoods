# Architectural and Economic Decisions

> Required by MASTER_PLAN §0 rule 7 and §0.2. Every material deviation from V0, and every
> choice the plan explicitly asks to be recorded, is written down here with its reasoning.

---

## D-001 — Backend and frontend are TypeScript, not plain JavaScript

**Plan reference:** §3 ("Use the actual language/framework already present in V0 unless there is
a documented compelling reason to migrate").

**Decision:** `backend/` and `frontend/` are TypeScript. V0 is plain CommonJS JavaScript.

**Reason:** §0.25.AA forbids floating point for USDC/AIC accounting and requires integer base
units with explicit units on every monetary field. In plain JavaScript, `bigint` and `number`
mix silently and a single `Number(amount)` in a projection would corrupt money without any
runtime error. A type system that makes `UsdcBaseUnits` and `AicBaseUnits` distinct brands is
the cheapest possible enforcement of a rule the plan states as an invariant. The same argument
applies to §0.27.J (never mix base units and display units) and to the schema generator, which
must not drift from the API types.

---

## D-002 — Immutable components are EIP-1167 clones, not full deployments

**Plan reference:** §0.16 (immutable per deployment), §0.25.P (clones explicitly permitted).

**Decision:** `AICoin`, `AICStoreSales`, `AICStoreRentals`, `LicenseToken`, `AICGovernance`
and `DividendDistributor` are deployed once as pinned implementations and cloned per store.

**Reason:** the first implementation deployed all five components directly from the Factory.
Measured result: the Factory runtime was **65,037 bytes**, far past the 24,576-byte EIP-170
limit, and a single `createStore` transaction embedded ~50KB of init code. Clones make store
creation 2.0M gas and keep every contract under 14KB.

A clone is immutable in exactly the sense §0.16 requires: it permanently delegates to one fixed
implementation address, has no proxy admin, and has no upgrade function. A new generation is a
new immutable Factory authorised by the Registry for future creation only; existing stores keep
the code they were born with.

**Safety:** clones are created with `CREATE` (not `CREATE2`), so no counterfactual address
exists for an attacker to front-run and initialize, and every clone is initialized in the same
call that creates it. Each implementation locks itself in its own constructor, so the shared
implementation can never be initialized.

---

## D-003 — Purchases are permissionless; the V0 server signature is removed, not patched

**Plan reference:** §5.6 (replace ambiguous signed purchase payloads with EIP-712 **where server
authorization is still required**), §0.24.G–H.

**Decision:** there is no server-authorised purchase path. `purchase` and `rent` are
permissionless and bind the quote on chain through `expectedVersion` and `maxTotalUSDC`.

**Reason:** V0 required a `serverSigner` ECDSA signature over
`abi.encodePacked(msg.sender, barcode, amount, deadline)`. That payload has no domain
separator, no verifying contract, no chain id and no nonce, so a signature was replayable
against any store on any chain. §5.6 offers EIP-712 as the fix *if server authorization is
still required*. In an Agent-first marketplace it is not: anyone holding USDC may buy. Removing
the mechanism removes the entire replay surface and removes the server signing key from the
economic path, which §0.13 and §0.27.E both want. Quote integrity is preserved on chain, where
it is stronger than a signature: a stale `expectedVersion` reverts and a price above
`maxTotalUSDC` reverts.

---

## D-004 — The V0 reward "transfer then burn" double reduction is a bug, not a tokenomic

**Plan reference:** §15 ("Do not guess. Preserve it only if it is confirmed as part of the
intended model; otherwise implement the safe intended equivalent and document the change").

**V0 code (Sales, and structurally identical in Rentals):**

```solidity
if (rewardsPool >= totalReward && totalReward != 0) {
    rewardToken.transfer(msg.sender, totalReward);
    rewardsPool -= totalReward;              // first reduction
}
// ... mint NFTs ...
if (rewardsPool >= totalReward && totalReward != 0) {
    rewardToken.burnFrom(address(this), totalReward);
    rewardsPool -= totalReward;              // second reduction
}
```

**Decision:** the pool is reduced by exactly the transferred reward. There is no burn.

**Evidence that it is a bug, not a feature:**

1. `AICERC20.sol` — the only AIC implementation in `contractsv0/` — defines **no** `burn` and no
   `burnFrom`. The call cannot succeed, so this code path always reverts. A deliberate deflation
   mechanism would have a working burn function.
2. Even if `burnFrom` existed, `burnFrom(address(this), ...)` from within the store requires the
   store to hold an allowance against itself, which is never set.
3. The accounting is internally inconsistent: the pool is debited twice while only one reward
   leaves, so the pool reaches zero while real AIC remains stranded in the contract. §12A.7
   requires that a store can never distribute or burn more AIC than it actually holds, and §15
   requires that the pool cannot underflow.
4. The plan's own description of the model — "the reward is derived from the remaining pool"
   so payouts "become progressively smaller" — is satisfied by a single reduction. A double
   reduction halves the pool's life without paying anyone the difference.

**Preserved exactly:** the per-unit rates (`2/1000` for Sales, `2/100000` for Rentals), the
`500` base-unit floor, and the Rentals `100000` pool gate.

---

## D-005 — The V0 Sales reward loop bug is fixed; the Rentals structure is the intended model

**Plan reference:** §15 ("whether the formula uses the initial pool or a progressively reduced
local pool during a multi-unit purchase").

**Decision:** both stores decay the pool progressively **within** a multi-unit purchase.

**Reason:** V0 Rentals decays a local `rewardsPoolCalc` correctly. V0 Sales computes the same
local variable, decrements it, and then **never reads it** — the loop reads the undecayed
storage `rewardsPool` on every iteration, so all units of a multi-unit purchase receive an
identical reward. The presence of the correctly written local variable in Sales is direct
evidence of the intended design; the defect is that it is unused. V1 implements the intent.

---

## D-006 — Protected shares round up; only the controller remainder absorbs dust

**Plan reference:** §0.21.Q, §0.25.I, §29.

**Decision:** in the commerce waterfall, `protocolFee` and `holderReserve` are computed with
ceiling division; `ownerAvailable` is the remainder.

**Reason:** found by the split-purchase property test. With floor division on both, a gross
below 40 base units rounds the 2.5% protocol fee to zero and a net below 20 base units rounds
the 5% holder reserve to zero. A seller could therefore price a listing so that every sale pays
the protocol and holders nothing, and splitting one sale into many identical micro-sales would
leave the controller strictly better off — exactly what §0.21.Q forbids. Ceiling rounding on
the protected shares makes splitting strictly worse for the controller and gives every dust
unit to a protected party, which is what §0.25.I demands.

**Not changed:** AgentGoods trading fees keep V0 floor rounding. `MIN_TRADE_USDC` is 1,000,000
base units, so the 2% and 1% fees can never round to zero, and preserving the exact V0
arithmetic keeps the curve economics byte-identical. The dividend processing fee also keeps
floor rounding, because flooring a fee charged *against holders* favours holders.

---

## D-007 — Takeover candidacy locks only the transferable balance

**Plan reference:** §0.21.D, §0.19.K (lock ordering / deadlock prevention), §0.29.J.

**Decision:** `openTakeoverCandidacy` locks the candidate's currently *transferable* balance
under the takeover lock id, not the full balance.

**Reason:** found by a cross-feature test. Locking the full balance deadlocked against the
governance YES lock: a holder who voted YES has its whole balance locked for governance, so
`transferableBalanceOf` is zero and a full-balance takeover lock always reverted. The largest
eligible holder could therefore never take over a store simply because it had voted — a lock
combination that §0.19.K explicitly forbids.

Re-locking already-locked units would double count the same balance against two obligations,
which §0.28.N rules out. Units locked for any reason are already immobile, so locking only the
free part gives exactly the same immobility guarantee.

**Correctness does not depend on the lock.** Finalization independently requires the caller to
be the heap root and requires `_leaderSince <= candidacyOpenedAt`, and `_leaderSince` resets
whenever the leading address changes. A flash-funded balance cannot survive an hour of chain
time, and a balance that leaves mid-window either keeps the holder in first place (in which
case they are genuinely the largest) or dethrones them (in which case the timer resets).

---

## D-008 — EOA eligibility is `code.length == 0`, and its limits are stated, not hidden

**Plan reference:** §0.7, §0.19.B.

**Decision:** `isEligible(account) == account != address(0) && account.code.length == 0`, plus a
permissionless `purgeIneligible` repair path.

**Reason and limitations:** this is a *policy* check, not cryptographic proof of key custody.
It is documented in `docs/EOA_ELIGIBILITY.md`. The known edge cases and how V1 handles them:

- **Construction-time**: during a constructor, `code.length` is 0, so a contract can be ranked
  while being deployed. `purgeIneligible` removes it afterwards; anyone can call it, and a
  ranked contract can block a takeover (fail closed) but can never finalize one.
- **CREATE2 counterfactual**: an address can hold AIC before a contract exists there. Same
  repair path.
- **ERC-1271 smart wallets**: deliberately excluded from voting, dividends and takeover in V1.
  This is a product decision, stated plainly in the Agent schema and the docs.

---

## D-009 — Phase 10.1: the declaration lives fully on chain, not as a hash

**Plan reference:** §14A.1 ("Decide whether the fields live fully on-chain or as an on-chain
hash with values in the indexed projection, justify it on gas cost, and record that too").

**Decision:** `declaredTokensSaved` (uint64), `declaredModelTier` (bytes32), `declarationBasis`
(uint8) and `declaredAt` (uint64) are stored in the canonical on-chain `Product` record.

**Gas justification:** the four fields pack into two additional storage slots, about 40,000 gas
once per product version. Store creation already costs ~2,000,000 gas and product creation
already writes several slots. A hash-plus-projection design would save roughly 20,000 gas per
product version.

**Why that trade is wrong here:** this field exists *specifically* so an Agent can decide
whether buying beats producing. If the authoritative value were only a hash, verifying the claim
would require re-fetching off-chain data that the chain cannot attest, and a stale or hostile
indexer would become the effective source of a number Agents spend money against. §0.21.N
places "canonical contract provenance" and economic inputs on the on-chain side of the trust
boundary; a 20,000-gas saving does not justify moving one across it.

`declaredModelTier` is a bounded `bytes32` short ASCII label rather than a free string, so the
on-chain cost is fixed and no unbounded user-controlled string enters an economic contract
(§0.25.AF).

---

## D-010 — Phase 10.1: declaration immutability is achieved through existing product versioning

**Plan reference:** §14A.1 ("decide how listing versioning achieves that and record it").

**Decision:** the declaration is part of the `Product` record, and **any** product update,
including a declaration change, increments `product.version`. No separate immutability
mechanism is added.

**Reason:** §0.24.H already requires product configuration versioning and already requires
quotes to bind `productVersion`. `purchase`/`rent` revert when the caller-supplied
`expectedVersion` does not match, and the minted `LicenseToken` permanently records the
`productVersion` it was sold under. Therefore a purchase is always settled against exactly one
immutable `(productId, version)` tuple, and the indexer retains the declaration for every
historical version from the `TokenSavingDeclared` event stream. Adding a second mechanism would
create two sources of truth for the same property.

---

## D-011 — Phase 10.1: buyer signals carry zero economic weight, permanently

**Plan reference:** §14A.2 ("Record it in DECISIONS.md and do not relax it without operator
approval").

**Decision:** no contract, ranking, ordering, fee, reward, dividend or entitlement reads buyer
signal state. Signals are readable data, never a protocol input. The API deliberately offers
**no sorting** by signal metrics.

**Reason:** the moment a signal pays, manufacturing signals becomes the optimisation. A signal
that moves money is a subsidy for wash purchases, and every anti-Sybil defence the protocol
would then need is a defence it does not need today. Keeping the signal economically inert
keeps it cheap to read and worthless to forge.

**How it is enforced rather than merely promised:**

- `09-phase101` asserts that none of `AICStoreSales`, `AICStoreRentals`, `AICoin`,
  `DividendDistributor`, `AICGovernance` or `AgentGoods` exposes any function matching `/signal/i`;
- a differential test runs the identical commerce sequence with and without signals and asserts
  that owner proceeds, holder reserve, reward payout and lifetime net commerce are equal;
- a self-purchase fuzz loop asserts that manufacturing 25 positive self-signals cannot increase
  any payout and strictly loses money;
- the Merkle dataset generator has no access to signal collections.

**Changing this requires explicit operator approval.**

---

## D-012 — Phase 10.1: delivery is attested on chain by a store-designated witness

**Plan reference:** §14A.2 ("only after access was granted at least once through the access
gateway", "with the backend as a projection and never the authority").

**Decision:** the store exposes `accessAttestor`, set by the current `storeController`. Only
that address may call `LicenseToken.recordAccessGrant`, which is batchable up to 200 ids.
`submitSignal` requires at least one recorded grant.

**Alternatives considered:**

- *Backend flag*: rejected outright. The precondition would then be a backend assertion, which
  §14A.2 forbids.
- *EIP-712 access receipt signed by the gateway and presented with the signal*: sound, and it
  avoids a per-delivery transaction. Rejected because it produces no on-chain `delivered`
  count, and `delivered` is the denominator of `coverage`, which §14A.3 requires the API to
  expose. Reconstructing it would put the denominator back off chain.

**Trust model:** the attestor is a delivery *witness* only. It cannot signal, cannot change a
signal, cannot mint, cannot move value and cannot become controller — all asserted in tests. A
controller that withholds attestations to suppress negative signals must also withhold access,
which shows up as collapsing `coverage`; §14A.3 requires coverage to be exposed rather than
hidden precisely so that this behaviour is legible.

---

## D-013 — Rentals inventory is concurrent slots, decremented once per rental

**Plan reference:** §13 (preserve intended Rentals behaviour).

**Decision:** a rental consumes exactly one inventory unit regardless of how many periods are
purchased, matching V0 (`product.quantity -= 1`). Reward decay, however, iterates over the
number of periods, also matching V0 (V0 looped over `_amount`, which it used both as the day
count and as the reward iteration count).

---

## D-014 — No `payWorker` path exists in V1

**Plan reference:** §0.29.C (enumerate every value-moving path and prove the governance lock
blocks controller-benefiting outflow).

**Decision:** V0's `payWorkerAfterFeeFromStoreBalance` is not ported.

**Reason:** it moved store balance to an arbitrary address chosen by the controller, with a
hardcoded 5% cut to a hardcoded EOA. That is an unbounded controller-benefiting outflow and
exactly the kind of indirect withdrawal route §0.29.C requires to be blocked. Rather than
adding a function and then locking it, V1 does not have it. The complete set of value-moving
functions in a store is `withdrawOwnerProceeds`, `withdrawRewardPool`, `transferController` and
`rescueToken`, all governance-locked, plus `commitHolderReserve` and `returnHolderReserve`,
which are distributor-only and never controller-benefiting. A test enumerates the full ABI and
fails if a new state-changing function appears without being classified.

---

## D-015 — Dividend epoch concurrency is "one in flight at a time"

**Plan reference:** §0.25.F ("Prevent two callers from opening distributions against the same
reserve").

**Decision:** `openDistribution` reverts while the latest epoch is `Open` or `RootProposed`.

**Reason:** it makes double allocation structurally impossible rather than arithmetically
prevented, and it keeps `unfinalizedReserve + sum(committed) == lifetimeAccrued` trivially
checkable. The cost is that a stalled epoch blocks new ones, which is why
`abandonDistribution` is permissionless after `ROOT_LIVENESS_TIMEOUT`.

---

## D-016 — Unclaimed dividends never expire

**Plan reference:** §0.21.J ("Default safest rule: do not return unclaimed holder funds to the
store owner automatically. Prefer either no expiry or a long expiry followed by rollover").

**Decision:** no expiry. There is no sweep, reclaim or withdraw-unclaimed function anywhere in
`DividendDistributor`, asserted by a test that greps the ABI.

**Reason:** the no-expiry option is the strictly safer of the two the plan offers, and it makes
"owner inactivity or takeover can never confiscate committed holder claims" a structural fact
rather than a deadline computation. Rounding dust, which is never assigned to any claimant, is
returned to the store's holder reserve at finalization so it rolls forward into a later epoch.

---

## D-017 — Seller profiles and media live on chain as inline documents; the backend never fetches a seller URL

**Plan reference:** §0.24.P ("Seller metadata is untrusted data and must never become Agent
instructions"), Rule 14 (reads are served from the indexed projection, never a live fetch).

**Decision:** a store publishes its display profile with `StoreBase.setStoreProfile(string)` and a
product carries one in its existing `metadataURI`. When the string starts with `{` it is parsed as
an INLINE JSON document (name, tagline, description, highlights, tags, category, logo, cover,
media, token description/logo) bounded at 8,192 bytes on chain. Anything else is kept verbatim as
an opaque URI. `src/content/profile.ts` parses it inside the indexer, sanitizing shape only:
length caps, control/bidi/zero-width stripping, and a URI allowlist of rooted same-origin paths,
`https://` and `ipfs://`. `javascript:`, `data:`, `blob:`, `file:`, cleartext `http:` and
protocol-relative `//host` are rejected and recorded in `rejectedFields`.

**The backend never dereferences any of these URLs**, not at index time and not at read time.

**Reason:** the alternative — a URI the indexer resolves — hands a seller a server-side request
forgery primitive and makes our egress IP a tracking beacon, and it breaks the reconstruction
oracle because the projection would then depend on a third party still serving the same bytes.
Holding the document on chain keeps the projection an exact function of chain state: drop the
collections, replay the log, get the same result. The gas cost is the seller's own choice and is
bounded by `MAX_STORE_PROFILE_LENGTH`; nothing in the protocol requires a profile at all.

External media is still allowed but is labelled `origin: "external"`, and the UI must not load it
without an explicit click, because loading it discloses the viewer's IP address to that host.

**What this does not change:** a profile is display text with zero protocol meaning. It never
names a canonical address, never affects pricing, ranking, dividends or eligibility, and is never
an instruction to an Agent.

---

## D-018 — A store token is labelled with its own symbol, never with the generic word "AIC"

**Plan reference:** §0.27.J (never mix units), §12A (each store mints its own AIC-class token).

**Decision:** `Amount` carries `unit` (the ERC20 symbol actually on chain: `ATLS`, `VCTR`, `PRSM`)
plus `tokenKind: "USDC" | "STORE_TOKEN"`. Agents key on `tokenKind`; humans read `unit`.

**Reason:** every store mints a distinct, non-fungible-with-each-other ERC20. Rendering them all
as "AIC" implies one shared asset and invites a reader to compare or add balances that are not
comparable. The symbol is seller-chosen display text, so it is explicitly NOT an identifier —
two stores may pick the same symbol and the address remains the only identity, which is why
`tokenKind` exists for machine consumption and the address is always present alongside.

---

## D-019 — One price definition everywhere: whole USDC per whole token, scaled 1e18

**Plan reference:** §0.27.J ("never mix base units with display units").

**Decision:** every price surface — `AgentGoods.currentPrice`, the buy/sell quote
`pricePerTokenGross1e18`, the indexer `pricePerToken1e18` and `currentIndexedPrice1e18`, and the
chart — uses `usdcBaseUnits * 1e30 / tokenBaseUnits`. The `1e30` is `1e18` of price scaling times
the `1e12` gap between USDC's 6 decimals and the token's 18.

**Reason:** the three surfaces previously disagreed with each other. The contract used `1e36`
(USDC *base units* per token, scaled 1e18), the indexer trade print used `1e18` (which truncated
a 6.1-micro-USDC price to the integer `6`), and the spot projection used `1e36`. A price of
7.16e-6 USDC was being reported as `7.16`, which reads as dollars — a three-order-of-magnitude
error in a field an Agent uses to decide whether to buy. Found by reading the live API, not by a
test, which is why the invariant is now stated in one place and referenced from the others.

**Precision note:** `pricePerTokenGross1e18` in the quote struct was not merely mis-scaled, it was
lossy: dividing by `1e18` left an integer count of micro-USDC, so every early-curve price rounded
to one or two significant figures.

---

## D-020 — The virtual seed and the curve pricing reserve are two different numbers

**Plan reference:** §12A.4 ("virtual reserves are pricing state, never real money").

**Decision:** the API exposes both, separately:

- `virtualSeedUSDC` — the constant 6,000 USDC the curve is seeded with. It never changes.
- `curvePricingReserveUSDC` — what the constant-product formula actually prices against. This is
  the contract's `virtualUSDCReserve`, and it MOVES on every trade.
- `realUSDCReserve` — actual money.

with a machine-checkable `reserveIdentity`:
`curvePricingReserveUSDC == virtualSeedUSDC + realUSDCReserve`, exact at every block.

**Reason:** the contract's storage field is named `virtualUSDCReserve` but it is incremented by
the net USDC of every buy and decremented by every sell, so it is the seed *plus* the real
reserve. Surfacing that single number under the label "virtual reserve, never real money" was
true about the seed and false about the value: a reader comparing markets would treat 6,552 USDC
as pricing fiction when 552 of it is withdrawable money, or conversely read it as liquidity when
6,000 of it can never be paid out. Splitting the two makes both statements true and makes the
relationship checkable rather than asserted.

---

## D-021 — Chain time and wall-clock time are never compared

**Plan reference:** §0.25.W (write safety), §0.24.M (indexed state is the read authority).

**Decision:** anything compared against a chain-derived timestamp is measured on the chain clock,
read from the indexed block log via `src/db/chainTime.ts` (no RPC). This covers the bonding-curve
trade `deadline`, the Phase 10.1 `SIGNAL_WINDOW`, and the chart's change windows.

**Reason:** `block.timestamp` and `Date.now()` are different clocks, and the contract only ever
compares against the first. A chain ahead of the backend made every freshly built trade intent
revert with `DeadlinePassed` on a transaction that was never late; a chain behind it would have
silently extended the signal-change window past its stated seven days. The failure mode is
asymmetric and invisible in a single-machine test where the two clocks happen to agree, which is
exactly why it is a rule rather than a fix in one place.

---

## D-022 — Dividend entitlement is the minimum balance over a holding window

**Plan reference:** §29C (added at operator request), §0.21, §0.25.F–I.

**Decision:** an account's entitlement weight for an epoch is its MINIMUM eligible balance across
`[snapshotBlock - holdingWindowBlocks, snapshotBlock]`, not its balance at the snapshot.
`HOLDING_WINDOW` defaults to 604,800 seconds, is governed on the Registry, and is capped at 30
days. The epoch denominator is the sum of those minimums.

**Reason:** `openDistribution` is permissionless and the snapshot is `block.number - 1` of the
opening transaction. Both properties are worth keeping, but together they let *anyone* choose the
instant that decides entitlement. An address buying one block before an epoch opened earned the
same per token as one that had held through the weeks in which the reserve accrued: buy, open,
claim, sell, with no privileged access and a profit at any epoch size.

The damage is not primarily unfairness. If holding through the accrual period pays no better than
arriving at the end of it, there is no reason to hold, and the store token's only non-speculative
use — a claim on that store's revenue — stops paying for the behaviour it exists to reward.

**Why a minimum and not a time-weighted average:** an average is manipulable by timing (hold large
for most of the window, exit at the end) and needs per-account integration state. A minimum needs
no new state, cannot be manipulated upward at all, and makes the anti-snipe property a consequence
of the definition rather than an additional rule: an account whose first acquisition is inside the
window had a zero balance at the window start, so its minimum is zero. No special case is written
anywhere for "new holder".

**Safety:** every weight is at most the account's snapshot balance, so
`eligibleMinSupply <= eligibleSupplyAtSnapshot` always, and the sum of entitlements therefore
cannot exceed `claimableUSDC`. The chain enforces that inequality directly in constant gas.

**Accepted cost:** a store younger than the window distributes nothing. `eligibleMinSupply` is
zero, no root can be proposed, and the liveness timeout returns the whole committed reserve to the
store for a later epoch. Nothing is lost; the first distribution waits until somebody has actually
held for a window.

---

## D-023 — The minimum is read from the existing balance checkpoints, not a new structure

**Plan reference:** §29C.4 ("compute from existing checkpoints, no new data structure, no loop
over all holders").

**Decision:** `AICoin.minBalanceInWindow(account, fromBlock, toBlock)` reads the
`Checkpoints.Trace208` array the token already maintains: `upperLookup(fromBlock)` for the opening
balance, a manual binary search for the first checkpoint after the window start, then a forward
walk to `toBlock` taking the running minimum, with an early exit once it reaches zero. The indexer
derives the same figure independently by folding canonical `Transfer` events.

**Reason considered and rejected — a per-account running minimum maintained on write:** it would
make the read O(1) but adds storage and a write-path branch to every transfer, and the minimum is
only meaningful relative to a window that is not known at write time. Maintaining one per possible
window is impossible; maintaining one for "the current window" makes every transfer depend on a
governed parameter, which is exactly the coupling upgrade safety should avoid.

**Reason considered and rejected — summing the denominator on chain:** it requires iterating the
holder set, which is unbounded. Instead the denominator is supplied with the root, bounded on
chain by two constant-gas necessary conditions (`> 0`, `<= eligibleSupplyAtSnapshot`), and its
exact value is defended by the existing 6-hour challenge window, during which any observer
recomputes each leaf from `minBalanceInWindow`.

**Cost:** `O(log n + k)` per account, where `k` is that account's own checkpoint count inside the
window. It is a `view`, called per leaf by a verifier, never from a state-changing path.

**Why the window is on the Registry rather than a constant:** checkpoints are keyed by block
number, so a window stated in seconds must be converted using a nominal block time that differs
per chain and per test environment. A wrong block time only stretches or shortens the window and
can never over-allocate, because the weight is a minimum over whatever window results. The value
is recorded on each epoch at open, so a later change never alters an epoch in flight.

---

## D-024 — A market that cannot pay gets its own error code

**Plan reference:** §29A, §12A `sellSolvencyRule`.

**Decision:** `MARKET_INSUFFICIENT_REAL_USDC` (409) is returned when a sell settles to more than
the market's real USDC reserve, carrying `redeemableNowUSDC`, `shortfallUSDC` and a derived
`maxTokensSellableNow`. `INSUFFICIENT_USDC` is narrowed to mean only that the CALLER's balance or
allowance is short. Neither code is ever returned for the other's cause.

**Reason:** the two conditions have opposite remedies. A caller short of USDC must acquire some;
a market short of real reserve is unaffected by the caller's balance and is resolved by selling
less now or waiting for buy-side flow. One code for both made an Agent top up a wallet that was
never the constraint, or abandon a position it could have exited in two smaller sells.
`maxTokensSellableNow` is included so the partial exit needs no second round trip; it inverts the
sell formula against the real reserve and is labelled `derived`, because it is exact only while no
other trade lands first.

---

## D-025 — The production deployment gate has no override

**Plan reference:** §29B, §24 (deployment pipeline).

**Decision:** `infra/scripts/deploy-gate.mjs` runs before every non-LOCAL build or deployment and
refuses `isMockExternal: true`, chainId 31337, a manifest built for a different environment,
`safeConfirmations` at 0 or below the target network minimum, a `maxReorgDepth` below the network
minimum or not greater than `safeConfirmations`, an unknown chainId, a guardian equal to the
deployer, and a missing timelock. It reports every violation in one run.

**Reason:** these are silent failures. A manifest pointing at a mock USDC does not announce
itself — it produces confident, wrong answers about money — and a warning in a deploy log is read
exactly once, by nobody. The gate deliberately has no `--force`, no environment variable that
disables it and no warn-only mode; a test greps the source for those names. Reaching production
with a mock manifest requires deleting the gate, which is visible in review.

**Unknown chains fail closed.** The gate never guesses a confirmation depth for a network it has
not been told about, because a guessed finality margin is worse than a refusal.

---

## D-026 — External audit is deferred until there are enough users; it is not a launch gate

**Source:** operator decision, 2026-09-23.

**Decision:** no external security audit is commissioned before launch. It is revisited when user
numbers justify the cost. The internal adversarial work stands in its place for now: the property
and invariant suites, the fuzz sequences, the reconstruction oracle, and `SECURITY_FINDINGS.md`.

**Reason:** this was the operator's call to make and they made it. Recording it matters because
"no audit yet" must be a visible, dated decision rather than an omission somebody later mistakes
for an oversight. It does not lower any internal bar: nothing in the test suite or the definition
of done is relaxed on the basis that an auditor would have caught it.

**Revisit when:** real user funds at risk become material, or before any change to the economic
core (the waterfall, the curve, the transition, the dividend model, takeover).

---

## D-027 — The multisig/timelock handoff is gated on a 72-hour clean run with three Agents

**Source:** operator decision, 2026-09-23.

**Decision:** control is not handed to the multisig and timelock until the system has run
**continuously for 72 hours with the three proving Agents and no bugs**. "No bugs" means: no
unhandled error, no indexer stall or unrecovered reorg, no accounting invariant violation, no
stuck epoch, and no Agent halted by anything other than its own declared budget.

**Reason:** a timelock makes mistakes expensive to undo — that is the point of it. Handing over
control before the system has demonstrated it can run unattended would mean discovering a defect at
exactly the moment fixing it became slow. Seventy-two hours is long enough to cross the periods
where the interesting failures live: a dividend epoch's full lifecycle, the rolling 30-day signal
window boundary arithmetic, log growth, connection churn, and at least two indexer restarts.

**Consequence for the build:** the proving harness has to be a soak run with continuous invariant
checking and an explicit bug ledger, not a scripted demo that exits after a scenario. A run that
ends early for any reason resets the clock; the report states the start time, the end time, and
every anomaly observed, including the ones that turned out to be benign.

---

## D-028 — The 30% listing is tested against real Uniswap V2, and the local stack lists into one

**Plan reference:** §12A (the one-way DEX transition), operator instruction 2026-09-23.

**Decision:** the transition tests and the LOCAL deployment both use the published
`@uniswap/v2-core` and `@uniswap/v2-periphery` build artifacts, deployed byte for byte. The pair
init code hash is asserted equal to the canonical mainnet value
`0x96e8ac...848845f`, which is what proves the periphery router's hardcoded `pairFor` matches the
factory actually deployed.

**Reason:** the listing is irreversible, moves a store's entire real USDC reserve, runs with no
human in the loop, and cannot be rehearsed in production — the operator explicitly cannot afford
to discover a bug there. The previous stub router made `liquidity = amountA + amountB`, had no
`MINIMUM_LIQUIDITY` lock, no uint112 reserve bound, no `quote()` optimal-amount path and no
k-invariant, so a transition could pass against it while reverting, or silently mis-pricing,
against the real thing. A test that cannot fail the way production fails is not a test of
production.

**The attack this surfaced as testable:** anyone can create and seed the pair BEFORE the
transition, and Uniswap's router then honours the ratio already in the pool. With zero slippage
bounds that hands most of the listing's value to whoever seeded it. The transition passes
`amountAMin`/`amountBMin` at 90% of intent, and the test asserts the only two acceptable outcomes:
it lists within the bound, or it reverts leaving the reserve intact, the curve open and no standing
approval.

---

## D-029 — The price series continues through the listing

**Plan reference:** §12A, operator instruction 2026-09-23.

**Decision:** the indexer watches the external pair as a `dexPair` role from the moment
`LiquidityTransition` is projected, and folds its `Swap` and `Sync` events into the SAME
`StockTrade` collection and the SAME `currentIndexedPrice1e18` field, at the SAME 1e30 scaling
(D-019). The pair is re-learned on hydration from the persisted market row.

**Reason:** the curve stops quoting at the transition. If only curve events were watched the chart
would go flat forever at the single most interesting moment in a token's life, and nothing would
report an error — from the indexer's point of view trading simply stopped. Writing pool trades to a
separate collection, or at a different scale, would put a visible discontinuity at exactly the same
place. A reader should see the venue change in the price and nowhere else.

A pool trade pays this protocol nothing, so `protocolFeeUSDC` and `controllerFeeUSDC` are recorded
as zero rather than omitted: a consumer can sum the series without branching on venue.

---

## D-030 — Artwork is generated from the on-chain id, by one engine shared with the UI

**Plan reference:** §0.26.A (a premium, futuristic interface), operator instruction 2026-09-23.

**Decision:** `frontend/scripts/media-engine.mjs` generates covers and logos deterministically from
a seed. `scripts/generate-media.mjs` writes files for the live catalogue (`--from-api`, idempotent,
safe on a schedule), and `src/lib/mediaEngine.js` is a byte-identical copy used by the UI for
anything without a file yet. A test asserts the two do not drift.

**Reason:** a catalogue that grows needs artwork that grows with it, and hand-drawing it does not
scale. Seven motifs over a continuous HSL space means 300 ids produce 300 distinct images, asserted
by test. Sharing one engine between the generator and the UI is what makes the fallback invisible —
otherwise a listing would visibly change appearance the moment the offline generator ran for it.

**Seeded by the on-chain id, never by a seller-supplied name.** A name can be copied; an id cannot.
Two stores calling themselves the same thing still look completely different, and no seller can
choose to look like another.

---

## D-031 — Source-available under a restricted licence; the Factory is the free, authorized path

**Source:** operator decision, 2026-09-23.

**Decision:** the project is licensed under `LicenseRef-AgentGoods-1.0` (the `LICENSE` file), not
Apache-2.0. Reading and auditing are explicitly permitted. Copying any code, and deploying the
contracts, are explicitly forbidden. Creating your own store and your own store contracts is done
through the canonical Factory, which the operator provides free of charge.

**Reason:** the source has to be public, because the entire trust model asks an Agent to verify a
contract rather than believe a claim about it, and that is unfollowable against unverified,
unreadable bytecode. But publishing for inspection is not the same as publishing for reuse, and
Apache-2.0 grants the second.

The Factory carve-out is what makes the restriction coherent rather than merely restrictive:
nobody needs to copy anything to get their own store. A Factory call mints a complete independent
store — its own contract, token, LicenseToken, governance and distributor — atomically and free.
Those contracts are the caller's, and the licence does not restrict them.

It also happens to be the same thing provenance requires. An Agent can only check canonicality
because every canonical store came from one Factory; a separately deployed copy is by construction
what that check exists to reject. The licence and the architecture agree here rather than
conflicting.

**Stated in the licence itself, because a licence that implied otherwise would mislead:** deployed
bytecode on a public chain is readable and copyable by anyone. This is a legal instrument, not a
technical control.

**SPDX:** `LicenseRef-AgentGoods-1.0` is the correct form for a custom licence. All 22 Solidity
files carry it and compile without SPDX warnings; every package.json declares it and is marked
private so none can be published to a registry.

**Not reviewed by a lawyer.** Stated at the bottom of the licence and worth acting on before
relying on it commercially.

---

## D-032 — Source verification is a separate, repeatable pass, and it is required off LOCAL

**Plan reference:** §0.18 (canonical provenance), operator instruction 2026-09-23.

**Decision:** `contracts/script/verify.js` verifies every deployed contract on the block explorer
using `BASESCAN_API_KEY`. The deployment script invokes it automatically for any non-LOCAL network,
but it is also runnable standalone and reads everything it needs from the deployment manifest.

Verification failure does NOT fail the deployment.

**Reason for that last point:** verification depends on an explorer having indexed the contracts
and on a third-party API that can be down. If a failure there marked the deployment as failed, the
obvious operator reaction is to redeploy — spending real gas and creating a second set of canonical
addresses — to fix a problem that is entirely off-chain. By the time verification runs, the
addresses are already canonical and the manifest is already written. So the script says plainly:
the deployment is fine, rerun the verifier, do not redeploy.

**Reason it is required rather than optional:** a missing API key throws rather than skipping
quietly. The provenance model asks people to audit these contracts; unverified bytecode makes every
"verify this yourself" instruction in the documentation impossible to follow, and an operator needs
to learn that at deployment time rather than from the first person who tries.

The outcome is recorded into the manifest (`verification.complete`), so whether a deployment is
auditable is answerable from the manifest rather than from someone's terminal history.

---

## D-033 — The handoff is a stage, so the timelock gate belongs to PRODUCTION alone

**Plan reference:** §0.17 (upgrade authority), §29B (the gate must fail, not warn), D-027.

**Decision:** `deploy-gate.mjs` requires `roles.timelock` only when the target environment is
`PRODUCTION`. `PROVING` and `CUTOVER` are evaluated against every other check in full.

**The problem this resolves is a deadlock, not a strictness preference.** The gate previously
required a timelock for every non-LOCAL environment. But a timelock cannot exist before the
deployment it governs: `script/handoff.js` is what deploys it, and it refuses to run until a
72-hour clean proving run has completed against a live deployment (D-027). The proving run needs
the deployment to exist. So the requirement could never be satisfied at deploy time, and every real
deployment would have had to route around the gate — which is how a gate stops being one.

The resolution is to name the stages honestly rather than to weaken the check:

| Environment | Meaning | Timelock |
|---|---|---|
| `PROVING`, `CUTOVER` | deployed and live; the bootstrap admin still holds authority | not required |
| `PRODUCTION` | the handoff is complete and recorded in the manifest | **required** |

`PRODUCTION` therefore no longer means "on mainnet". It means "authority has been handed over".
A mainnet deployment that has not been handed over is a `PROVING`, and calling it that is accurate
rather than euphemistic: a single key can still upgrade every contract in it.

**What deliberately did not change:** every other check applies identically at `PROVING` — mock
infrastructure, an unknown chain, a guardian equal to the deployer, and confirmation depths below
the network minimum are all refused exactly as before. That is asserted by its own test, because
the risk when scoping one check to one environment is silently scoping its neighbours too.

---

## D-034 — The handoff grants everything and verifies it before revoking anything

**Plan reference:** §0.17, D-027, D-033.

**Decision:** `contracts/script/handoff.js` performs the authority transfer in four ordered phases —
deploy the timelock, grant every role to it, **read every one of those roles back from chain**, and
only then revoke the bootstrap admin. If any read-back disagrees, it stops before the first revoke.

**Reason:** this is the only operation in the system with no recovery path of any kind. Revoking
`DEFAULT_ADMIN_ROLE` from the operator while the timelock does not hold it produces a protocol
nobody can ever administer — the roles are gone and the only function that could restore them
requires a role no address holds. Not recoverable with money, access or time.

The grant-verify-revoke ordering makes the worst realistic outcome "the protocol has two
administrators", which is an uncomfortable state for an hour and a trivial one to resolve, instead
of "the protocol has none", which is terminal. Within each contract, `DEFAULT_ADMIN_ROLE` is
revoked last, because it is the role that authorizes the other revocations.

Supporting choices, each for a specific failure it prevents:

- **Dry run is the default.** `HANDOFF_EXECUTE=1` is the only thing that sends a transaction.
- **The timelock is its own admin** (`admin = address(0)`). Passing a human admin would leave a key
  able to rewrite the proposer set with no delay, which is the exact power the handoff removes.
- **A proposer may not be the bootstrap admin or the guardian.** The first would preserve the
  authority the handoff exists to retire; the second would turn a stolen guardian key from a denial
  of service into a takeover.
- **`GUARDIAN_ROLE` does not move.** A timelocked emergency stop is not an emergency stop.
- **The proving-run gate is checked by the script**, not left to the operator's memory, and the
  override to skip it is spelled `I_ACCEPT_THE_RISK` so it cannot be set by accident.

---

## D-035 — A market with a pre-existing funded pool abandons graduation permanently

**Plan reference:** §0.13 (the 30% transition), operator decision 2026-09-23.

**Decision:** at the moment a market first reaches the 30% threshold, `AgentGoods` checks for an
external Uniswap pool. If one exists **with non-zero reserves**, the market sets `graduationBlocked`
permanently, emits `GraduationBlocked`, and continues trading on its bonding curve. It never lists.
The purchase that triggered the check succeeds normally.

**What the previous behaviour actually was, measured rather than assumed.** The concern raised was
that a pre-seeded pool would let an attacker take the curve's USDC. It would not have: the 1%
slippage bound on `addLiquidity` refused every hostile ratio tested — 5,000 USDC against 1/1000 of
the tokens, 1 USDC against all of them, a dust seed, and a near-fair seed. In all four the
transition reverted and the attacker's net position was negative. **No USDC was ever at risk.**

The real damage was different and worse than it looked. The revert happened inside `buy`, so the
purchase crossing the threshold reverted — and so did every purchase after it. A token could be
permanently stranded, unbuyable past 30%, for the cost of seeding a pool with **one millionth of a
USDC**. A denial of service with a floor price of dust, presenting to users as an unexplained
failed transaction.

**So the choice is between two ways of not listing**, and that framing is what makes the decision
easy: revert forever with no explanation, or stop trying and say so. The second keeps the curve
fully usable in both directions, so nobody is trapped in a token they cannot exit.

**The check is on reserves, not on the pair existing — and this is the load-bearing detail.**
`createPair` is permissionless and needs no capital. If mere existence disqualified a market, anyone
could permanently block any token's graduation for ordinary gas, and the mitigation would be
cheaper to abuse than the attack it prevents. An unfunded pair is genuinely harmless:
`addLiquidity` into an empty pool mints the initial liquidity at the ratio *we* supply, which is
exactly what creating the pair ourselves would have done. Verified empirically, and asserted in
`test/15-graduation-blocked.test.js`.

**It is permanent, deliberately.** Draining the hostile pool afterwards does not restore
eligibility. A reversible decision would hand whoever seeded the pool the power to choose the moment
of graduation, which is a worse position than never graduating at all.

**Why a flag and not a new `MarketPhase`.** The phase is still genuinely `BondingCurve` — trading
continues unchanged. Overloading the phase would make every consumer that switches on it wrong, for
a condition that is orthogonal to it.

**Exposure**, because a silent rule is a trap: `market.graduationBlocked` on chain and in the API,
`quoteBuy().graduationBlocked` (with `willTriggerTransition` forced false at any size, and the live
pool checked even before the threshold), the `GraduationBlocked` event, an
`economics.agentGoods.transition.notGuaranteed` block in the Agent schema, an explicit Agent
reminder, and a plain-language panel in the human UI.

---

## D-036 — A protocol-owned DEX is the permanent fix, and it is deliberately deferred

**Plan reference:** D-035, O-002, operator decision 2026-09-23.

**Decision:** the permanent answer to pre-seeded pool griefing is a protocol-owned AMM whose pool
creation is restricted to `AgentGoods`. It is **recorded as design intent and explicitly not built**,
gated on having enough users to justify the cost. `docs/FUTURE_NATIVE_DEX.md` holds the design.

**Why it is the real fix:** every form of the attack depends on someone being able to create or fund
the pool the protocol is about to list into. If only the bonding curve can open a pool for its own
token, there is nothing to pre-seed and nothing to detect — the hazard stops existing rather than
being defended against, and `graduationBlocked` becomes vestigial.

**Why it is deferred, and the blocker is cost rather than engineering.** A constant-product AMM is
well-understood; the expense is everything around it. A new venue's liquidity is unreachable in
practice until aggregators and market-data sites list it and routers and wallets integrate it. Until
then the pool does not appear where people look for prices, trades do not route into it, and the
chart and buy flow stop working the way they do today. **A self-built DEX nobody can find would be
worse for holders than an established one carrying a known, bounded griefing risk.**

**The second reason, which is not about money:** the current listing tests are credible precisely
because they run against official Uniswap artifacts with the canonical init code hash asserted. A
protocol-owned venue discards that. It would need adversarial coverage at least as strong as
`11-dex-transition-real.test.js` written from scratch, against no battle-tested reference. Uniswap
V2 has secured very large sums for years; a new AMM has secured nothing, and "we wrote it carefully"
is not equivalent. This is also the point at which an external audit stops being optional.

**Published in the Agent schema, marked non-binding.** It sits under
`economics.agentGoods.transition.notGuaranteed.plannedPermanentFix` with `binding: false`,
`committed: false`, `estimatedDate: null` and an explicit `doNotRelyOnThis` list.

The reason for that care: the schema is machine-readable and Agents act on it. A roadmap item stated
without qualification is a roadmap item some Agent will treat as a protocol guarantee and price
against. It also states plainly that nothing here retroactively clears `graduationBlocked` on a
market already blocked — that flag is permanent on chain, and any future migration would be a
deliberate mechanism rather than a consequence.

**Stated publicly rather than kept internal**, because the current behaviour is a trade-off and
concealing the known better answer would misrepresent it.

---

## D-037 — A blocked market burns to graduation's economics, and the seed moves with it

**Plan reference:** D-035, operator decision 2026-09-23.

**Decision:** when a market abandons graduation, it burns unsold curve inventory so its supply and
price land where graduation would have put them — the same +35% step — and **reduces the virtual
seed alongside the burn** so that a full exit stays exactly payable.

```
burn = premium x vUSDC x vTokens / ((BPS + premium) x vUSDC - BPS x seed)
newVirtualUSDC = vUSDC - ceil(realUSDC x burn / outstanding)
```

**The constraint that dictates the whole design, measured rather than assumed: the curve has
exactly zero solvency margin.** Because `virtualTokenReserve + outstanding == genesis` and
`virtualUSDC == seed + realUSDC`, selling every outstanding token quotes precisely the real reserve
— to the base unit. A probe against a live curve returned a quote of `581.999999` against
`582.000000` of real USDC.

So the obvious implementation is not merely risky, it is **arithmetically impossible**: burning
tokens and shrinking the token reserve alone raises the quoted payout above the USDC that exists. A
burn sized to the +35% target opened a **180 USDC hole in a 582 USDC reserve** — a 31% shortfall —
and holders selling late would have been refused outright. That is precisely the trap D-035 exists
to prevent, reintroduced by the natural way of writing this.

**Hence the seed must move.** Solving for the premium price step subject to the exit identity puts
the seed in the denominator of the burn — which is exactly why the ratio differs from graduation's.
An external pool holds only real money; a curve that keeps trading is still priced by its virtual
seed, and the arithmetic has to account for it.

**The cost, stated plainly:** `virtualSeedUSDC` is no longer unconditionally constant, which
narrows D-020. It is now stored on the market row rather than assumed, and it changes exactly once,
for exactly one situation. `virtualSeedUSDC.constant` is published as a boolean so a reader can tell
which case they are looking at, and `reserveIdentity` continues to hold against the reduced seed.

Catching that mattered: the serializer previously hardcoded 6,000, so a blocked market would have
published `reserveIdentity.holds: false` — a correct market advertising itself as broken.

**Rounding is directional.** The burn rounds down and the reserve reduction rounds up, so the
realised step sits at or just under the premium and the exit identity can only gain margin.

**It refuses rather than approximates.** If any guard fails — no real USDC, no seed, a burn that
would empty the curve or erase the seed — no burn happens and the market is left blocked with its
supply intact. A worse cosmetic outcome and a perfectly safe one.

**What it does not do:** match graduation's *supply* (~0.62B rather than ~0.44B). Price parity with
a preserved exit was chosen over supply parity, because supply parity would require draining the
seed much further for a purely cosmetic gain.

---

## D-038 — A takeover warns the controller rather than refunding the incentive pool

**Plan reference:** §0.29 (takeover), §12A.3 (reward pool), operator question 2026-09-23.

**The problem.** A store's reward pool is funded with AIC the controller **bought with their own
money**, but it is held by the store. A holder takeover transfers the store, and the pool with it.
The previous controller cannot recover it afterwards. That is a real loss of real money, and
nothing was telling them it was about to happen.

**Decision:** warn, rather than refund. The takeover candidacy is now projected and surfaced as a
**CRITICAL** `STORE_TAKEOVER_IN_PROGRESS` task on `GET /api/v1/me`, naming the exact amount at risk
and the seconds remaining, and pointing at `withdrawRewardPool`.

**Why a warning is the stronger answer, not the cheaper one:**

- **The notice already existed.** A candidacy is public the moment it opens and cannot finalize for
  `TAKEOVER_OBSERVATION_PERIOD` (3600s). The guarantee was already in the contract; the events were
  watched but never projected, so the hour of warning reached nobody.
- **The action already works.** A takeover deliberately sets no governance lock, so
  `withdrawRewardPool` stays available right up to finalization. Asserted, not assumed —
  `test/takeover-warning.test.ts`.
- **It is a defence, not damage limitation.** Pool AIC sits in the store, which is a CONTRACT:
  ineligible, absent from the eligible-holder heap, contributing nothing to the controller's
  standing. Withdrawing moves it into eligible supply. If that retakes the lead, `_leaderSince`
  resets and the challenger's candidacy becomes **permanently unfinalizable**. One transaction both
  rescues the money and can end the threat.
- **It works on stores that already exist.** Per-store contracts are immutable clones.

**Why an automatic refund was rejected:**

- It could only apply to stores created by a FUTURE Factory. Every existing store would be
  unprotected, which is the opposite of what the concern is about.
- The pool is usually partly distributed already, so "return the deposit" has no well-defined
  amount without per-depositor accounting that does not exist and would need a new storage layout.
- It would put a token transfer inside `finalizeTakeover`. That path must not fail, and a previous
  controller who rejected the transfer would break the takeover itself — converting a clean
  ownership mechanism into one an incumbent could stall.

**No contract change was made.** Tokenomics, governance, takeover rules and fees are untouched.

**A defect found while building it:** the countdown was first computed against `Date.now()` while
`openedAt` is a `block.timestamp`, so a test asserting the remaining time could not exceed the
observation period read 3645 of a maximum 3600. Same class as F-007. It now uses `chainNow()`.

---

## D-039 — The chart gets a server-side price sample, and browser scroll restoration is turned off

Two UI decisions with a shared shape: both fix something that was *correct* and read as broken.

### The price series is sampled, not only traded

The chart was built from trades alone. On a bonding curve the price only moves when someone
trades, so that series is exactly right — and a market whose last trade was five hours ago rendered
a chart that stopped five hours ago. `backend/src/indexer/priceSampler.ts` writes the missing
points.

Three properties are load-bearing:

- **No RPC.** The price comes from the indexed projection, the same figure the API already serves.
  Rule 14 is not suspended because the code runs on a timer rather than in a request.
- **Change plus heartbeat, not a fixed tick.** A naive 30-second write stores 2,880 near-identical
  rows per market per day for a chart that is identical either way. It writes when the price moved,
  plus one heartbeat every five minutes so a quiet series still reaches the present.
- **Upsert, last-write-wins per second.** The series is keyed to `(chainId, aicToken, at)` in whole
  seconds. An insert would drop a second observation inside the same second — and the dropped one
  is the *newer* one. Upserting also makes the rolling deploy safe, where two instances run
  concurrently by design.

A sample carries **zero volume and a null `txHash`**, and every point declares `source`. A chart
that implied a trade had happened would be lying about liquidity, which is worse than a gap.
Retention is a Mongo TTL, so nothing has to remember to clean up.

### Navigation always lands at the top

`history.scrollRestoration` is set to `manual` and `ScrollToTop` becomes the only thing that
decides where a page starts.

The alternative was to leave restoration on `auto` and scroll to the top anyway. That is worse than
either behaviour alone: the browser re-applies its remembered offset *after* the effect runs, so a
back-navigation intermittently jumps to the top and then jumps back. Determinism was worth the cost,
which is real and stated: returning to a long list no longer restores your place in it. A hash is
still honoured, because `#anchor` is an explicit request for a position.

### The mobile menu is a hamburger, not a scrolling strip

The scrolling strip fit seven links into the header without wrapping and hid four of them off the
right edge with no affordance saying so. `Identity` and `For Agents` were effectively undiscoverable
on a phone.

The closed panel is `display: none` rather than transformed or hidden by opacity, so its links leave
the tab order and the accessibility tree. Tabbing into links you cannot see is the standard way this
component is broken.

**No economics, governance, takeover rule or fee was touched by any of this.**


---

## D-040 — One shared rate-limit bucket made the protocol undiscoverable

Full write-up in `EXTERNAL_AGENT_ACCESS_AUDIT.md`. The decision worth recording here is what the
fix was allowed to be.

`TRUST_PROXY_HOPS` defaulted to `0`, so Express ignored `X-Forwarded-For` and `req.ip` was the
platform edge — the same value for every client on earth. The global limiter keys on `req.ip` and
is registered before the discovery routes, so once any traffic filled the single 600/min bucket,
**every** path returned 429: the root, the manifest, the schema, the OpenAPI document. A browser
that happened to land in a fresh window worked. An Agent retrying hit the wall.

**Three fixes were available and two were rejected.**

- **Raise the limit.** Rejected: it moves the threshold without changing the shape. A shared
  global bucket is still a bucket every client can exhaust for everyone else.
- **Exempt discovery from rate limiting.** Rejected: an unbounded public endpoint is a different
  production incident, not a fix for this one.
- **Chosen:** make the bucket per-client (`TRUST_PROXY_HOPS=2`) and give discovery its own
  budget (300/min) separate from general reads (600/min). Discovery is still limited; it simply
  cannot be starved by traffic that has nothing to do with it.

**The hop count is 2, not 1.** `X-Forwarded-For` arrives as `client, railway-edge`, and
`trust proxy` counts hops **from the right**. At `1`, `req.ip` resolved to a Railway edge node —
better than the edge-for-everyone case, still shared by many clients. Recorded because it is
exactly the kind of value that gets "corrected" to a plausible wrong number.

Both directions of a wrong count fail silently — too low shares a bucket globally, too high lets a
client spoof their own address and bypass limits entirely — so the app now measures the real chain
on its first request and logs a warning naming the direction of the error.

**No security was weakened.** No authentication removed, no private endpoint opened, no WAF
disabled, no wildcard CORS, no limit lifted.

## D-041 — Link previews carry seller names, never seller sentences

Shared links previewed as the generic site card, because every route is served the same shell and
no unfurler runs JavaScript. Store and product pages now get their tags injected server-side.

That puts seller-chosen text into the most exposed place it appears anywhere: a headline above the
words "agentgoods.ai", in a chat client nobody controls, read by someone who has not visited the
site and has no other context. It borrows the domain's credibility before any judgement is
possible. Three rules follow:

1. **The seller never owns a whole line.** The title is always `{name} — a store on
   AgentGoods.AI`. The suffix is ours and survives truncation.
2. **The description contains no seller free text at all** — store type, token symbol, product
   count, price. A seller cannot write the sentence under the headline, so a preview under our
   domain never carries a claim nobody checked.
3. **The image is always the branded card, never seller media.** Seller media is untrusted, and
   is usually SVG, which no chat client renders anyway.

Escaping is asserted by **counting elements**, not by grepping for payloads: `&lt;img src=x
onerror=alert(1)&gt;` is the *correct* inert rendering of a hostile name, so a regex for
`onerror=` flags a pass as a failure while missing the same payload written another way. What
matters is whether the seller created a tag.

**A second, unrelated defect fixed alongside it:** `og:image` pointed at `favicon.svg`. The tag
was present and the file was valid, and not one chat client renders SVG for a preview — so every
shared link showed no image at all. `og.png` is a real 1200x630 raster, generated by
`frontend/scripts/generate-og-image.py` from the same polygons and colours as the mark, so the
card cannot drift from the brand it copies.
