# Store takeover

A store's controller can be replaced by its largest holder, without the controller's consent and
without any protocol role being involved.

This is a **feature**, and stating why it exists matters as much as stating how it works: a store
whose owner walks away, stops delivering, or stops caring would otherwise strand its holders
permanently. Takeover is the exit from that. The design problem is making it possible for a genuine
majority holder while making it impossible for someone who is only *momentarily* the largest holder.

---

## 1. The flow

```text
  become the largest eligible holder
             │
             │   (_leaderSince is set the moment the leading address changes)
             ▼
  openTakeoverCandidacy()  ──────────── your transferable balance is locked
             │
             │   ≥ 1 hour of chain time, holding the lead continuously
             ▼
  finalizeTakeover()  ────────────────  you are the controller; the lock releases
```

Either side can end it early: you can `cancelTakeoverCandidacy()` at any time, and anyone who
overtakes you resets `_leaderSince`, which invalidates your candidacy permanently.

## 2. The four conditions, all checked at finalization

`AICoin.finalizeTakeover()` — each condition is O(1), and each exists to close a specific attack.

| # | Condition | What it stops |
|---|---|---|
| 1 | `isEligible(msg.sender)` **now** | a contract finalizing; eligibility is re-checked, not cached from candidacy |
| 2 | `_leader == msg.sender` | anyone who is not currently the largest eligible holder |
| 3 | `_leaderSince <= openedAt` | **leadership that was not continuous** — this is the important one |
| 4 | `block.timestamp - openedAt >= 3600` | anything that can be done inside a transaction or a block |

### Condition 3 is the one doing the real work

`_leaderSince` is reset **whenever the leading address changes**. So if you open a candidacy, lose
the lead for even one block, and then regain it, `_leaderSince` is now *later* than `openedAt`, and
`finalizeTakeover` reverts with `LeadershipNotContinuous`.

There is no way to repair a broken candidacy. You cancel and open a new one, which restarts the full
hour.

The effect is that the requirement is not "be the largest holder twice, an hour apart" — which a
determined attacker could arrange — but **"be the largest holder continuously for an hour"**, which
requires actually holding the position against everyone else for that whole time.

## 3. Why a flash loan cannot do this

The complete answer is condition 4 combined with condition 3.

A flash loan must be repaid within the same transaction. Takeover requires **3600 seconds of chain
time** to pass between two separate transactions, during which condition 3 requires the position to
be held without interruption. A borrowed balance cannot survive the end of the transaction that
borrowed it, so it cannot be held for an hour, so it cannot satisfy the requirement.

This is also why the observation period is measured in chain time rather than block count: it is
robust to changes in block production, and it cannot be compressed by anyone who can influence
ordering.

## 4. The balance lock, and why correctness does not rely on it

Opening a candidacy locks your transferable balance under `TAKEOVER_LOCK_ID`. You cannot campaign
for a takeover while quietly selling the position you are claiming to hold.

The lock is **non-custodial**: the tokens stay in your account, keep counting toward your balance,
keep their eligibility, and keep earning everything they would otherwise earn. Locks are
reason-scoped and compose — releasing the takeover lock never releases a governance lock.

**But the contract's own comment is explicit that correctness does not depend on the lock**, and
that is a deliberate defensive property. Finalization independently re-verifies leadership and
continuity. If the lock had a flaw — if some path released it early — the takeover still could not
be finalized by someone who had sold down, because conditions 2 and 3 would fail on their own. The
lock makes the rule visible and honest; the leadership checks make it true.

## 5. How "largest eligible holder" is known cheaply

An indexed max-heap over eligible balances (`EligibleHolderHeap`) maintains the leader. Checking "is
X the largest eligible holder?" is reading the heap root — O(1), no iteration over holders, no
off-chain input, no oracle.

This matters beyond gas: a takeover decided by an off-chain computation would be a takeover decided
by whoever ran it. The heap keeps the entire decision on-chain and verifiable by anyone.

## 6. What a takeover does and does not transfer

**The new controller gets:** control of the store — listings, pricing, metadata, and the ability to
withdraw owner proceeds accrued from that point.

### The reward pool DOES transfer, and that is a real loss

| | |
|---|---|
| The AIC reward pool | **transfers with the store** |

This is the one thing a controller can actually lose, and it deserves stating plainly: the pool is
funded with AIC the controller **bought with their own money**, but it is held by the store, not by
them. When control changes it goes with the store, and there is no path to recover it afterwards.

**The protocol already gives an hour of warning; the problem was that nobody received it.** A
candidacy emits `TakeoverCandidacyOpened` publicly and cannot be finalized for
`TAKEOVER_OBSERVATION_PERIOD`. That notice is now projected and surfaced as a **CRITICAL**
`STORE_TAKEOVER_IN_PROGRESS` task on `GET /api/v1/me`, naming the exact amount at risk and the
seconds remaining.

**Withdrawing the pool is a defence, not just damage limitation.** `withdrawRewardPool` stays
available throughout a candidacy — a takeover deliberately sets no governance lock. And the AIC
moves somewhere it counts: while it sits in the store it is held by a **contract**, which is
ineligible and absent from the eligible-holder heap, so it contributes nothing to the controller's
standing. Moving it to the controller's own EOA adds it to eligible supply. If that is enough to
retake the lead, `_leaderSince` resets and the challenger's candidacy becomes **permanently
unfinalizable** — it cannot be repaired, only restarted from zero.

So the correct response to the warning is one transaction that both rescues the money and may end
the takeover.

**Why the pool is not returned automatically instead.** It was considered and rejected:

- Per-store contracts are **immutable clones**. A refund mechanism could only ever apply to stores
  created by a future Factory, never to any store that exists today.
- The pool has usually been **partly distributed** to buyers already, so "return the deposit" has
  no well-defined amount without per-depositor accounting that does not exist.
- It would add a token transfer inside `finalizeTakeover`, a path that must not fail. A previous
  controller that rejected the transfer would break the takeover itself.

A warning with an hour of lead time, an action that is already possible, and a defence that can
cancel the threat outright is the stronger answer, and it works on every store that already exists.

**The new controller does not get:**

| | Why |
|---|---|
| The holder reserve | No function reaches it, for any controller. Asserted for a *successor* controller specifically in `test/12-holder-reserve-unreachable.test.js` |
| Already-committed dividends | They belong to the epoch and its holders |
| The power to invalidate existing licences | Licences live in the store's own immutable `LicenseToken` |
| A different rule set | The store is an immutable clone; its code does not change with its controller |

**A governance lock does not block a takeover.** An unresolved obligation follows the store to the
new controller rather than shielding the old one — a controller cannot hide behind a lock they
themselves triggered.

## 7. How a candidacy dies

| Cause | Mechanism |
|---|---|
| You cancel | `cancelTakeoverCandidacy()`, releases the lock immediately |
| Someone overtakes you | `_leaderSince` resets; condition 3 can never be satisfied again for this candidacy |
| You become ineligible | `purgeIneligible` voids the candidacy (`AICoin.sol:311-312`) |
| You transfer away your lead | The lock prevents transferring the locked portion; anything above it moving can cost you the lead |

The purge path is permissionless and **fail-closed**: any address may call it, it succeeds only
against an address that is *already* ineligible, and it can only ever *stop* a takeover — never
cause one. So the worst a hostile caller can achieve is enforcing the rules.

## 8. For an operator watching this happen

A takeover is not an incident and needs no intervention. It is the mechanism working.

Every stage emits an event — `TakeoverCandidacyOpened`, `TakeoverCandidacyCancelled`,
`TakeoverFinalized` — all indexed, so the full history of any store's control is reconstructible
from chain. There is a minimum of an hour of public warning between a candidacy opening and control
changing, which is intentional: the store's existing controller and its holders can both see it
coming and respond.

No protocol role can block a takeover, and no protocol role can cause one.
