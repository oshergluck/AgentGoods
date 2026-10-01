# Dividend claim model

How a store's holder reserve becomes a claimable entitlement, and why entitlement is measured the
way it is.

Authoritative spec: MASTER_PLAN §0.20, §0.21, §0.25.F–I, and **§29C**, which replaced the
snapshot-balance rule with a minimum-balance-over-a-window rule. Where this document and the plan
disagree, the plan wins.

---

## 1. Where the money comes from

Every settled sale or rental splits under the commerce waterfall:

```text
gross
  - protocolFee        2.5% of gross, ceiling-rounded
  = net
      - holderReserve  5.0% of net, ceiling-rounded    -> accrues in the store
      = ownerAvailable                                  -> withdrawable by the controller
```

The holder reserve accrues continuously and is **never** withdrawable by the controller. It sits
in the store as `unfinalizedHolderReserveUSDC` until an epoch commits it.

Ceiling rounding on the two protected shares is deliberate: flooring them let a seller price a
product low enough that both rounded to zero, so splitting one sale into many micro-sales paid
holders nothing. See DECISIONS D-006.

---

## 2. Epoch lifecycle

```text
openDistribution      permissionless. Commits the accrued reserve, snapshots at block.number - 1,
                      records the holding window, charges the 5% processing fee ON the committed
                      reserve (not as extra store commerce).
proposeRoot           a root proposer publishes a Merkle root, a dataset hash, the summed
                      entitlement total and the summed minimum-balance denominator.
challenge window      6 hours. Any observer can recompute every leaf and a better root can replace
                      the standing one, up to MAX_ROOT_REVISIONS.
finalizeRoot          permissionless once the window elapses. The root becomes immutable.
claim                 a holder presents a Merkle proof. No deadline, ever.
abandon               permissionless after the 30-day liveness timeout: the whole committed
                      reserve returns to the store for a later epoch. Nothing is stranded.
```

Exactly one epoch may be in flight at a time, which makes double allocation of the same reserve
unit structurally impossible rather than arithmetically prevented (DECISIONS D-015).

---

## 3. Entitlement weight: the minimum balance across a holding window

**This is the part that changed, and it is the part that matters.**

### 3.1 What was wrong

`openDistribution` is permissionless and the snapshot is `block.number - 1` of the opening
transaction. Both properties are deliberate and both are kept. Together, though, they made
entitlement a function of a single instant that *anyone* could choose.

An address that bought AIC one block before someone opened an epoch received the same share per
token as an address that had held throughout the weeks in which that reserve accrued. The
arbitrage needs no privileged access and is profitable at any epoch size: buy, open, claim, sell.

The consequence is not merely unfair. If holding through the accrual period earns no more than
arriving at the end of it, there is no reason to hold, and the store token's only non-speculative
use — a claim on the store's revenue — stops paying for the behaviour it exists to reward.

### 3.2 The rule

```text
HOLDING_WINDOW           default 604800 seconds (7 days), governed, capped at 30 days
windowStartBlock         max(0, snapshotBlock - holdingWindowSeconds / nominalBlockTime)
weight(account)          min over [windowStartBlock, snapshotBlock] of balanceOf(account)
eligibleMinSupply        sum of weight(account) over eligible EOA accounts
entitlement(account)     floor(claimableUSDC * weight(account) / eligibleMinSupply)
```

Three consequences fall directly out of the definition, with no extra rules:

- **A position opened inside the window is worth exactly zero.** The account's balance before its
  first checkpoint is zero, so the minimum over a window that starts before the purchase is zero.
  Buying immediately before a snapshot earns nothing.
- **Dipping is punished for the whole window.** An account that dropped to 10% mid-window and
  restored its position before the snapshot is weighted at 10%. There is no averaging, because an
  average can be manipulated by timing and a minimum cannot be manipulated upward at all.
- **The sum of entitlements can never exceed `claimableUSDC`.** Every weight is at most the
  account's snapshot balance, so `eligibleMinSupply <= eligibleSupplyAtSnapshot`, and the
  entitlement uses floor division on top of that.

### 3.3 A young store distributes nothing, on purpose

If every holder acquired inside the window — the normal state of a store younger than the window —
then `eligibleMinSupply` is zero, no root can be proposed, the liveness timeout expires, and the
whole committed reserve returns to the store for a later epoch.

No value is lost. The first distribution simply waits until somebody has actually held for a
window. That is the rule working, not a failure.

---

## 4. Computing the minimum, from data that already exists

No new data structure was introduced, and nothing iterates over the holder set on chain.

`AICoin` already checkpoints every balance change per account (`Checkpoints.Trace208`, keyed by
block number). The minimum over a window is therefore recoverable from data already stored:

```solidity
function minBalanceInWindow(address account, uint256 fromBlock, uint256 toBlock)
    external view returns (uint256);
```

```text
running = upperLookup(account, fromBlock)          // balance as of the window start
binary-search the checkpoint array for the first entry with key > fromBlock
for each checkpoint from there while key <= toBlock:
    running = min(running, checkpoint.value)
    stop early if running reaches zero
return running
```

Cost is `O(log n + k)` for a single account, where `k` is that account's own checkpoint count
inside the window. It is a `view`, called per leaf by whoever is verifying that leaf, and is never
invoked from a state-changing path.

The off-chain dataset generator computes the same figure by folding canonical `Transfer` events:
everything up to `windowStartBlock` establishes the opening balance, and everything after it up to
the snapshot updates the running minimum. The two are independent derivations of one number, so a
disagreement is a detectable fault rather than a silent misallocation.

---

## 5. What the chain enforces, and what the challenge window defends

The exact denominator cannot be recomputed on chain without iterating the holder set, so it is
supplied with the root and bounded by two constant-gas checks:

```text
eligibleMinSupply > 0
eligibleMinSupply <= eligibleSupplyAtSnapshot
rootTotalUSDC     <= claimableUSDC
```

These are *necessary* conditions. A proposer claiming a denominator above the snapshot supply is
either wrong or inflating it, and either way the root is refused before it can enter a challenge
window. The *exact* value is defended by the challenge window, during which any observer
recomputes every leaf from `minBalanceInWindow` and replaces the root if it disagrees.

Verification that must pass before a root is accepted:

```text
every leaf balance equals minBalanceInWindow(account, windowStartBlock, snapshotBlock)
the sum of leaf balances equals the proposed eligibleMinSupply
eligibleMinSupply <= eligibleSupplyAtSnapshot
no leaf belongs to an account that is not an eligible EOA
the sum of entitlements <= claimableUSDC
```

---

## 6. The window is recorded, not read live

`holdingWindowSeconds` and `windowStartBlock` are written onto the epoch at `openDistribution` and
never recomputed. Changing the governed parameter therefore cannot retroactively alter an epoch
already in flight, and a historical root stays reproducible from the epoch record alone.

The parameter lives on the Registry (`setHoldingWindowSeconds`, FEE_ADMIN_ROLE, capped at 30 days)
rather than as a hard constant, because the window has to be expressed in the block-number units
the checkpoints are keyed by, and block production differs per chain and per test environment.
Getting the nominal block time slightly wrong only stretches or shortens the window; it can never
over-allocate, because the weight is a minimum over whatever window results.

---

## 7. Eligibility, suspension and expiry

- **EOA only.** Contract accounts are excluded from dividends, voting and takeover in V1. See
  `docs/EOA_ELIGIBILITY.md`.
- **Governance suspension.** A leaf can carry blocking proposal ids: the YES coalition of an
  unresolved passed proposal cannot claim until that proposal resolves. The value is held, never
  redistributed and never confiscated.
- **No expiry, ever.** There is no sweep, reclaim or withdraw-unclaimed function anywhere in
  `DividendDistributor`, asserted by a test that greps the ABI. Rounding dust, which is never
  assigned to any claimant, returns to the store's holder reserve at finalization and rolls
  forward into a later epoch. See DECISIONS D-016.

---

## 8. API surface

```text
GET  /api/v1/dividends/stores/:storeId   epochs, each with holdingWindowSeconds, windowStartBlock,
                                         eligibleEOASupply (the summed minimum),
                                         eligibleSupplyAtSnapshot and the eligibility rule text
GET  /api/v1/dividends/me                your entitlements, each stating windowMinimumBalance
POST /api/v1/dividends/stores/:storeId/open    permissionless open, returned as an intent
POST /api/v1/dividends/:epochId/claim          claim, returned as an intent
```

Every monetary field is a base-unit string with explicit decimals. The per-leaf balance field is
named `windowMinimumBalance`, not `snapshotBalance`: the rename is deliberate so that a reader
built against the old model gets an error rather than a plausible wrong number.

---

## 9. Tests

| Property | Where |
|---|---|
| buying one block before the snapshot yields zero | `contracts/test/10-holding-window.test.js` |
| a full-window holder receives its full share | same |
| a mid-window dip is weighted at the dip | same |
| first acquisition inside the window yields zero | same |
| `eligibleMinSupply > eligibleSupplyAtSnapshot` is rejected on chain | same |
| the window recorded at open survives a later parameter change | same |
| `minBalanceInWindow` matches a brute-force replay over a fuzzed trade sequence | same |
| sum of entitlements never exceeds `claimableUSDC` | `06-dividends`, `08-invariants-fuzz` |
| the full epoch lifecycle end to end against a real chain and indexer | `backend/test/e2e.test.ts` |
