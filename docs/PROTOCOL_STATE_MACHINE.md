# Protocol state machine

Every state a store's market can be in, every transition between them, and — the part that matters
most — which transitions are **one-way**.

---

## 1. Market phases

```text
      None ──────► BondingCurve ──────► Transitioning ──────► ExternalDex
       (0)    │        (1)         │         (2)         │        (3)
              │         │          │                     │
        createStore     │    30% of supply sold     liquidity added,
                        │                              LP burned
                        │
                        └──► graduationBlocked = true ──┐
                             (a funded pool already     │
                              existed at the threshold) │
                                                        ▼
                             stays on the curve, permanently, still trading

                    ◄──── no transition runs backwards ────
```

| Phase | Value | Trading happens | Who can move it forward |
|---|---|---|---|
| `None` | 0 | nothing exists | the Factory, by creating the store |
| `BondingCurve` | 1 | on the curve, inside `AgentGoods` | any buyer, by crossing the threshold |
| `Transitioning` | 2 | nothing — this phase exists only inside one transaction | the transition itself |
| `ExternalDex` | 3 | on a real Uniswap V2 pair | nobody; this is terminal |

**Every arrow is one-way.** There is no function anywhere that decreases a phase. Not an admin
function, not a guardian function, not an upgrade-reachable one in the current implementation — a
store that has listed can never return to its curve.

### Why `Transitioning` exists at all

It is never observable between transactions: the transition begins and ends inside a single call.
It exists as an explicit state so that reentrancy during the listing cannot find the market in a
phase where trading is permitted. `buy` and `sell` both require `phase == BondingCurve` exactly,
so a callback arriving mid-transition hits `WrongPhase` rather than a half-updated curve.

## 2. The bonding curve

Constant product over **virtual** reserves, seeded so that price is well-defined from the first
trade rather than undefined at zero supply.

| Constant | Value |
|---|---|
| `AIC_GENESIS_SUPPLY` | 1,000,000,000 AIC (1e27 base units) |
| `VIRTUAL_USDC_RESERVE` | 6,000 USDC |
| `TRANSITION_THRESHOLD_AIC` | 300,000,000 AIC — 30% of genesis |
| `LP_PREMIUM_BPS` | 3,500 — 35% |
| `LP_SLIPPAGE_BPS` | 100 — 1% |
| `MIN_TRADE_USDC` | 1.000000 USDC |

Two reserve quantities exist and they are **not** the same thing — conflating them was a real defect
(F-005, D-020):

- **`virtualSeedUSDC`** — the 6,000 USDC seed. **Constant. Never moves.**
- **`curvePricingReserveUSDC`** — seed + real USDC in the curve. Moves with every trade.

Pricing uses the second. A `reserveIdentity` is exposed so any consumer can check the relationship
holds rather than trusting it.

### Price

`PRICE_SCALE = 1e30` is the single price definition across contracts, indexer and UI — `1e18`
scaling multiplied by `1e12` for the USDC-6 versus token-18 decimal gap. Three disagreeing scales
was F-003, and the failure mode was a price wrong by six orders of magnitude with nothing erroring.

## 3. The transition

Triggered when cumulative supply sold reaches 300,000,000 AIC. `quoteBuy` returns
`willTriggerTransition`, so it is predictable before the transaction rather than a surprise after.

**Reaching the threshold does not guarantee a listing.** If a funded external pool already exists at
that moment, the market sets `graduationBlocked` permanently and stays on its bonding curve —
listing into someone else's pool would mean depositing at a price they chose. The triggering
purchase still succeeds; the market simply never graduates. D-035.

Such a market then **burns inventory to graduation's economics** (D-037): supply and price land
where a listing would have put them, and the virtual seed is reduced alongside the burn so that
selling everything back stays exactly payable. The curve has zero solvency margin, so a burn that
did not move the seed would trap holders.

What happens, atomically, in one transaction:

```text
  1. phase := Transitioning
  2. compute the listing price: curve price + 35% premium
  3. create the Uniswap V2 pair (or use the existing one)
  4. add liquidity — all curve USDC, and AIC at the premium price, within 1% slippage
  5. burn the LP tokens to the burn address
  6. burn ALL remaining curve inventory
  7. revoke every approval
  8. phase := ExternalDex — permanently
```

**Each of steps 5–7 is asserted in `test/11-dex-transition-real.test.js`** against the official
Uniswap artifacts, not a mock. See `THREAT_MODEL.md` §2 for why that distinction is load-bearing.

### After it, permanently

| | |
|---|---|
| The curve | closed. `buy` and `sell` revert with `WrongPhase` |
| Remaining inventory | burned; nobody can acquire it |
| The LP | burned; nobody can withdraw the liquidity, including the operator |
| The price | now whatever the market says on a real pair |
| The chart | **continues without a break** — the indexer's `dexPair` role folds pool swaps into the same collection at the same scale (D-029) |

That last row is a deliberate product property: the transition should look like nothing happened
except the price, the way pump.fun does. Without it the chart would go flat forever at the
transition with nothing reporting an error.

## 4. Pause states, which are orthogonal

Pause is not a market phase. It is four independent flags that gate specific actions, and a paused
market is still in whatever phase it was in.

| Scope | Blocks | Set by | Cleared by |
|---|---|---|---|
| `PAUSE_STORE_CREATION` | new stores | guardian or admin | **admin only** |
| `PAUSE_COMMERCE` | purchases, rentals | guardian or admin | **admin only** |
| `PAUSE_MARKET` | curve buy **and sell** | guardian or admin | **admin only** |
| `PAUSE_REWARD_DEPOSIT` | reward pool deposits | guardian or admin | **admin only** |

The asymmetry is intentional and analysed in `GUARDIAN_TIMELOCK_MODEL.md` §2. Paths with no pause
scope at all: dividend claims, licence validity, content access, owner-proceeds withdrawal, reserve
movement.

## 5. Store lifecycle

```text
   created ──► operating ──► (governance locked) ──► operating
                   │
                   └──► controller changes: voluntary transfer, or takeover
```

There is **no deletion, no deactivation and no end state**. A store that stops trading is a store
with no trades, not a store in a "closed" phase. Licences it issued keep working, dividends it
committed stay claimable, and its contracts keep answering — forever, because they are immutable
clones with nobody able to turn them off.

A **governance lock** suspends controller-discretionary actions (`withdrawOwnerProceeds`,
`transferController`, `rescueToken`, profile changes are exempt) until the obligation resolves. It
does **not** block a takeover: an unresolved obligation follows the store to its new controller
rather than shielding the old one.

## 6. Dividend epoch lifecycle

```text
   open ──► reserve committed ──► root proposed ──► challenge period ──► finalized ──► claimable forever
                                        │
                                        └──► challenged / abandoned ──► reserve returned to the store
```

| Stage | Who | Notable |
|---|---|---|
| open | **permissionless** | a hostile or absent controller cannot censor distributions |
| commit reserve | distributor only | `commitHolderReserve` rejects every other caller |
| propose root | root proposer | carries `holdingWindowSeconds`, `windowStartBlock`, `eligibleMinSupply` |
| challenge | anyone | the window before finalization |
| finalize | — | 5% processing fee forwarded to the treasury here |
| claim | any entitled holder | **no expiry, no sweep, no reclaim** (D-016) |
| abandon | — | `returnHolderReserve` rolls the reserve back so a later epoch can use it |

Entitlement is the **minimum balance across the holding window** (default 604800s), not the balance
at a snapshot block — so buying just before a snapshot earns zero. `DIVIDEND_CLAIM_MODEL.md` has
the full computation; `test/10-holding-window.test.js` proves it including against a brute-force
reference.

## 7. Protocol authority states

```text
   bootstrap ─────────────────► handed over
   one key holds everything     timelock holds everything
        │                              │
        │  gate: PROVING                │  gate: PRODUCTION
        └──────── 72 clean hours ──────┘
```

`PRODUCTION` in this system means "authority has been handed over", not "on mainnet" (D-033). A live
mainnet deployment where one key can still upgrade every contract is a `PROVING`, and calling it that
is accurate rather than euphemistic.

## 8. The complete list of one-way transitions

Worth having in one place, because these are the decisions that cannot be walked back:

1. **`BondingCurve` → `ExternalDex`.** Inventory burned, LP burned, curve closed forever.
2. **The authority handoff.** Roles revoked from the bootstrap key cannot be re-granted by it.
3. **Genesis mint.** Once, at creation. No mint path exists afterwards.
4. **A finalized dividend root.** Claims against it are permanent.
5. **A burned token.** Including all curve inventory at transition.

Everything else in the system can be undone, re-run, or corrected.
