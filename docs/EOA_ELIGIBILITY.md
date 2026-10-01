# EOA eligibility: what it checks, and what it honestly does not

Several protocol powers — voting, dividend entitlement, store takeover — are restricted to
"eligible" holders. This document states exactly what that word means in the code, and is deliberate
about the gap between what the check proves and what it is used to imply.

---

## 1. The rule

```solidity
function isEligible(address account) public view returns (bool) {
    return account != address(0) && account.code.length == 0;
}
```

An eligible holder is a **non-zero address with no code at the current block**. That is the whole
policy. `AICoin.sol:218`.

## 2. What this actually proves — and what it does not

**It proves:** at this block, that address is not a deployed contract.

**It does not prove** that anyone holds the private key, that a human is behind it, that it is not
one of a thousand addresses controlled by the same person, or that it will still have no code later.

Calling it "EOA eligibility" is therefore slightly generous, and the code says so in its own
comments rather than only here: *"this is a policy check and not cryptographic proof of key
custody"*. It is a filter, not an identity system.

### The three specific ways it can be wrong

| | What happens | Handled by |
|---|---|---|
| **Sybil** | One person splits a balance across many fresh addresses, all eligible | **Not prevented.** See §5 — the powers gated by eligibility are balance-weighted, which is what blunts it. |
| **Counterfactual contract** | An address with no code today can have a contract deployed to it tomorrow (`CREATE2`), turning an eligible holder into a contract | `purgeIneligible`, §4 |
| **Deployment in the same transaction** | During its own constructor, a contract has `code.length == 0` | Real, and the reason the takeover path has an **observation period** rather than trusting a point-in-time check |

The third one is the interesting one, and it is why the takeover design is shaped the way it is. A
single `isEligible` call inside one transaction can be satisfied by a contract under construction.
An hour of continuous chain time cannot.

## 3. Why the restriction exists at all

Without it, the largest holder of a store's token would usually be a contract — very often the
bonding curve itself, which holds the entire unsold genesis supply. Governance and takeover would be
decided by whichever pool happened to be holding the most, which is not a meaningful expression of
anything.

The eligibility filter is a blunt way of asking *"is this a participant rather than a mechanism?"*
It answers that question imperfectly and answers it cheaply, on-chain, with no oracle and no
registry.

## 4. `purgeIneligible` — permissionless, fail-closed

Eligibility is checked when it matters, but eligible *supply* is a running total, so an address that
becomes a contract after acquiring tokens would otherwise keep contributing to it.

```solidity
function purgeIneligible(address account) external {
    if (isEligible(account)) revert AccountStillEligible();
    ...
}
```

**Anyone may call it, and it cannot do harm.** It only succeeds on an address that is *already*
ineligible — so a griefer calling it on everyone achieves nothing except paying gas to correct the
protocol's bookkeeping.

Two consequences the design leans on:

- It removes the account's contribution from `_eligibleSupply` and pushes a checkpoint, so
  historical snapshots stay accurate rather than retroactively changing.
- **It voids any takeover candidacy held by that address.** `AICoin.sol:311-312`. This is the
  fail-closed direction: a permissionless call can *stop* a takeover but can never *cause* one.

That asymmetry is the whole safety argument for making it permissionless. The worst a hostile caller
can do is enforce the rules.

## 5. Sybil, stated plainly

Splitting a balance across many addresses **is not prevented**, and no on-chain check could prevent
it without an identity system this protocol deliberately does not have.

What limits its usefulness is that the powers gated by eligibility are **balance-weighted**, not
per-address:

- **Dividends** are weighted by the minimum balance held across the holding window. Splitting a
  balance across ten addresses yields ten smaller entitlements summing to the same total — minus ten
  times the gas.
- **Takeover** requires being the single largest eligible holder. Splitting a balance makes you
  smaller, not larger. It is strictly counterproductive.
- **Governance** is balance-weighted for the same reason.

So the honest position is: Sybil is possible, and it buys nothing except gas costs. That is a
weaker claim than "prevented", and it is the true one.

## 6. Where eligibility is enforced

| Power | Check |
|---|---|
| Counted in `eligibleSupply` | at transfer, plus `purgeIneligible` for later changes |
| Dividend entitlement | eligible supply at snapshot; minimum balance across the holding window |
| Open a takeover candidacy | `isEligible(msg.sender)` **and** being the current leader |
| Finalize a takeover | `isEligible` again, leader again, leadership continuous, one hour elapsed |
| Governance | balance-weighted among eligible holders |

The pattern worth noticing: eligibility is re-checked at **every** step of a multi-step flow, not
cached from the first. A candidacy opened while eligible and finalized while ineligible fails at
finalization.

## 7. This is the V1 policy, and it is replaceable

`isEligible` is one small function with one clear job. If a future version wants attestation-based
eligibility, a proof of key custody, or a different definition entirely, this is the seam.

What makes replacing it a real change rather than a config edit: per-store contracts are immutable
clones (`UPGRADEABILITY_MATRIX.md` §2). A new policy ships as new component implementations behind a
new Factory, and applies to stores created afterwards. **Existing stores keep the policy they were
created with, permanently** — which is the correct behaviour, because changing the eligibility rule
under a store would change who controls it.
