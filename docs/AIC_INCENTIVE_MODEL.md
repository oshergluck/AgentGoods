# The AIC incentive model

Buyers receive AIC when they purchase. This document is the exact mechanism, the reasoning behind
its shape, and — because the shape is unusual — what it means for a store owner deciding how much to
fund.

---

## 1. The formula

Each purchased unit pays a fixed fraction **of the pool that remains at that moment**:

```solidity
for (uint256 i = 0; i < units; i++) {
    if (pool < minPool) break;
    uint256 unitReward = (pool * rate) / denom;
    if (unitReward == 0) break;
    totalReward += unitReward;
    pool -= unitReward;          // the next unit is computed against a smaller pool
}
```

`StoreBase.previewReward()`. The subtraction inside the loop is the whole model: each unit is priced
against what is left after the previous one.

| Store type | Rate | Per unit | Implied |
|---|---|---|---|
| Sales | `2 / 1000` | **0.2%** of the remaining pool | pool halves in ~347 units |
| Rentals | `2 / 100000` | **0.002%** of the remaining pool | pool halves in ~34,657 units |

`rewardMinimumPool()` is 500 base units for both — below that, rewards stop rather than paying
dust.

## 2. What this means: geometric decay, never exhaustion

After *n* units, the pool is `P₀ × (1 − r)ⁿ`, and the *n*-th buyer receives
`P₀ × r × (1 − r)ⁿ⁻¹`.

```text
  reward
  per unit │●
           │ ●
           │   ●
           │      ●
           │          ●  ●
           │                 ●   ●    ●     ●      ●       ●
           └──────────────────────────────────────────────────── units sold
```

Two properties follow, and both are deliberate:

**The pool can never be drained.** A percentage of a remaining amount is always less than the
remaining amount. There is no unit count at which the pool hits zero — it approaches it and stops
paying at `rewardMinimumPool`. A store cannot be farmed to empty by volume.

**Early buyers earn dramatically more than late ones.** In a Sales store the first buyer earns
~0.2% of the pool; the thousandth earns ~0.027% of the original. That is a ~7× difference, and it is
the point: the incentive is for discovering a store early, not for buying from an established one.

## 3. Why not a fixed reward per unit

A fixed amount per unit is the obvious design and it fails in a specific way: the pool becomes a
prize with a known size and a known exhaustion point, so the rational strategy is to buy the
computable number of units that drains it, as fast as possible, regardless of whether you want the
product.

Geometric decay removes that. There is no "last unit worth taking" — the reward shrinks smoothly,
so the point at which buying for the reward stops being worthwhile is reached gradually and
individually rather than as a race.

## 4. The rentals rate is 100× slower, on purpose

Rentals are repeatable. The same customer can rent the same product many times, so a rentals store
faces far more incentive-paying events per unit of genuine economic activity than a sales store
does.

`2/100000` versus `2/1000` compensates for that. Without it, a rentals pool would decay at sales
speed against rental-frequency volume and be effectively spent within days.

## 5. Where the AIC comes from

**The store owner funds the pool**, by depositing AIC they hold via `depositRewardPool`. It is not
minted, not taken from genesis supply, and not created by the protocol.

Consequences worth being explicit about:

- **Funding is voluntary.** A store with an empty pool pays no incentive and operates normally.
- **The owner can withdraw it** — `withdrawRewardPool`, bounded by `_rewardPool`, blocked under a
  governance lock. It is the owner's AIC held in escrow, not a bond.
- **It transfers on a takeover.** The pool belongs to the STORE. If control changes, the AIC you
  funded it with goes with it and is not recoverable. You get at least an hour of warning
  (`STORE_TAKEOVER_IN_PROGRESS` on `/api/v1/me`), and withdrawing within that window both rescues
  the AIC and increases your own eligible balance — see `STORE_TAKEOVER_MODEL.md`.
- **It is AIC, never USDC.** The reward pool and the holder reserve are different tokens in
  different counters, which is why `withdrawRewardPool` cannot express the reserve as an amount at
  all (asserted in `test/12-holder-reserve-unreachable.test.js`).
- **Deposits are balance-delta accounted**, so a fee-on-transfer token could only ever credit what
  actually arrived. The canonical AIC is not fee-on-transfer; the accounting is written that way
  regardless.
- **`PAUSE_REWARD_DEPOSIT`** exists as its own scope, so deposits can be halted without halting
  commerce.

## 6. The economic loop

```text
   buyer pays USDC
        │
        ├─► 2.5% protocol fee ───────────────► operator
        │
        └─► net to the store
                 ├─► 5% holder reserve ──────► dividends to AIC holders (immutable)
                 └─► 95% owner proceeds ─────► the store owner
   
   buyer receives AIC from the pool ──────────► the buyer is now a holder
                                                and earns from future dividends
```

The intended dynamic: buying makes you a shareholder in the store you bought from, and shareholders
earn from everyone who buys after them. The incentive pool is what bootstraps that — it converts
customers into holders without the store owner having to sell tokens.

## 7. What a store owner should actually take from this

**Funding the pool is marketing spend, and it is front-loaded by design.** Most of any pool is paid
to the first few hundred buyers (sales) or few tens of thousands of rentals. Fund it when you want
early adopters, not as a permanent running cost.

**You cannot over-commit.** The pool cannot be drained and you can withdraw what remains. The
downside of funding too much is opportunity cost, not loss.

**Rewards are checked before purchase, not promised.** `previewReward(units)` is a view function, so
a buyer can see exactly what they will receive before they spend anything. Nothing about the reward
is estimated or settled later.

**`MAX_UNITS_PER_PURCHASE` bounds the loop.** The computation is a loop over units, so the per-call
unit count is capped — a purchase above it returns zero reward rather than consuming unbounded gas.

## 8. What the protocol does not promise

- **It does not promise the incentive is worth anything.** AIC from a store with no commerce is a
  token with no dividend stream. The incentive is a claim on that store's future, not a payment.
- **It does not guarantee a pool is funded.** Check `rewardPool()` before assuming.
- **It does not verify seller claims about savings.** The token-saving declaration is seller-
  asserted and surfaced as a declaration. See `TRUST_BOUNDARIES.md` §3.
- **The rate is fixed per store type and is not governable.** `rewardRateBps()` is `pure` on both
  store subclasses, and stores are immutable clones — so the rate a store launches with is the rate
  it has forever.
