# Operator revenue: where it comes from and how you withdraw it

Three different pots of money exist in this system and they belong to three different parties.
Mixing them up is the most expensive mistake available to an operator, so this document is explicit
about which is which.

| Pot | Belongs to | Held in | Withdrawn by |
|---|---|---|---|
| **Protocol fees** | You, the operator | `ProtocolTreasury` | `treasury.withdraw()` |
| **Store owner proceeds** | Each store's controller | that store's contract | `store.withdrawOwnerProceeds()` |
| **Holder reserve** | Token holders | that store's contract | nobody — it can only become a dividend |

You can withdraw the first. You cannot withdraw the other two, and no role you hold changes that.

---

## 1. What you earn

Three fees accrue to you, all in USDC:

| Fee | Rate | Taken from | When | Recorded as |
|---|---|---|---|---|
| Commerce protocol fee | **2.5%** (250 bps) | gross of every sale and rental | on each purchase | `COMMERCE_SALE`, `COMMERCE_RENTAL` |
| Curve protocol fee | **2%** (200 bps) | gross of every AIC buy and sell | on each curve trade | `AGENTGOODS_BUY`, `AGENTGOODS_SELL` |
| Dividend processing fee | **5%** (500 bps) | the committed holder reserve | when a dividend root finalizes | `DIVIDEND_PROCESSING` |

All three are forwarded to `ProtocolTreasury` at the moment they are taken and recorded there
against a fee type. Nothing accumulates in a store or the exchange waiting to be swept.

**A note on the third, because the two bases are easy to conflate.** The dividend processing fee is
5% of the *committed holder reserve*, not 5% of store commerce. The reserve is **20%** of net
commerce (`HOLDER_RESERVE_BPS = 2_000`), so holders receive 95% of 20% — that is **19% of store
net** — and your cut is **1% of store net**. It is charged once per epoch at finalization, not per
sale.

One more fee exists and is **not** yours: the **store controller fee** (1% of curve trades)
belongs to each store's controller and is withdrawn by them with
`AgentGoods.withdrawControllerFees()`. You receive it only for stores you personally control, and
then as a store owner rather than as the operator.

Rounding note: the commerce protocol fee and the holder reserve are **ceiling-rounded**, so a
micro-purchase cannot round either to zero. See DECISIONS D-006 — this was a real defect found by
fuzzing, not a theoretical one.

---

## 2. How the treasury is structured

```text
                     purchase / curve trade
                               │
                               ▼
                       protocol fee (USDC)
                               │
                  safeTransfer + recordRevenue()
                               │
                               ▼
                     ┌──────────────────┐
                     │ ProtocolTreasury │
                     │                  │
                     │ accountedBalance │ ← the ledger. Only this is withdrawable.
                     │ destination      │ ← where withdrawals go. NOT chosen per call.
                     └──────────────────┘
                               │
                       withdraw(token, amount)
                               ▼
                         destination address
```

Two design points that matter to you as the person withdrawing:

**`withdraw()` does not take a recipient.** It always sends to the configured `destination`. You
cannot typo an address into a withdrawal call, because you do not supply one. Changing where money
goes is a separate, separately-permissioned action that emits its own event.

**Only accounted revenue can move.** `withdraw()` is bounded by `accountedBalance[token]`, which is
incremented solely by `recordRevenue()` from a canonical contract. If someone sends USDC to the
treasury by accident it is *not* withdrawable through this path — it is surplus, and `rescue()`
handles it separately and can never touch recorded revenue.

---

## 3. The roles you need

`ProtocolTreasury` has three, all granted to the bootstrap admin at deployment:

| Role | Lets you |
|---|---|
| `WITHDRAWER_ROLE` | Call `withdraw(token, amount)` |
| `DESTINATION_ADMIN_ROLE` | Call `setDestination(newDestination)` |
| `RESCUE_ROLE` | Sweep non-revenue tokens sent here by accident |

After the multisig handoff (DECISIONS D-027, runbook step 9), these move to the timelock. From
that point a withdrawal is a timelock proposal rather than a direct call — slower on purpose,
because a treasury key that can move funds instantly is a treasury key worth stealing.

---

## 4. Checking what you have earned

Read-only, costs nothing, safe to call at any time.

```bash
cast call $TREASURY "totalRevenue(address)(uint256)" $USDC --rpc-url $BASE_RPC_URL
cast call $TREASURY "accountedBalance(address)(uint256)" $USDC --rpc-url $BASE_RPC_URL
cast call $TREASURY "destination()(address)" --rpc-url $BASE_RPC_URL
```

`totalRevenue` is lifetime. `accountedBalance` is what is withdrawable **right now**. Divide by
`1e6` for USDC: `accountedBalance` of `1234560000` is 1,234.56 USDC.

By fee type:

```bash
# The fee types are keccak256 of these exact strings.
# contracts/src/interfaces/IProtocolTreasury.sol is the authoritative list.
for TYPE in COMMERCE_SALE COMMERCE_RENTAL AGENTGOODS_BUY AGENTGOODS_SELL DIVIDEND_PROCESSING; do
  echo -n "$TYPE: "
  cast call $TREASURY "revenueByType(bytes32,address)(uint256)" $(cast keccak "$TYPE") $USDC --rpc-url $BASE_RPC_URL
done
```

---

## 5. Withdrawing

### Step 1 — confirm the destination is your wallet

**Do this every time, before every withdrawal.** It is one read call and it is the only thing
standing between a withdrawal and an address you did not intend.

```bash
cast call $TREASURY "destination()(address)" --rpc-url $BASE_RPC_URL
```

If it is not your wallet, set it and wait for the transaction to confirm before withdrawing:

```bash
cast send $TREASURY "setDestination(address)" $YOUR_WALLET \
  --rpc-url $BASE_RPC_URL --private-key $ADMIN_KEY
```

### Step 2 — withdraw

```bash
# Amount is in USDC base units: 1000 USDC = 1000000000
cast send $TREASURY "withdraw(address,uint256)" $USDC 1000000000 \
  --rpc-url $BASE_RPC_URL --private-key $ADMIN_KEY
```

To withdraw everything, read `accountedBalance` first and pass exactly that value. There is no
"withdraw all" function, deliberately: an explicit amount is a number you had to look at.

### Step 3 — confirm

```bash
cast call $TREASURY "accountedBalance(address)(uint256)" $USDC --rpc-url $BASE_RPC_URL
cast call $USDC "balanceOf(address)(uint256)" $YOUR_WALLET --rpc-url $BASE_RPC_URL
```

The `Withdrawn(token, to, amount)` event is emitted on chain, so every withdrawal is publicly
auditable. That is intentional: a protocol that takes a fee from every trade should have a visible
record of what it took out.

---

## 6. After the timelock handoff

The calls are the same; the path changes. Instead of `cast send` from an admin key, you queue the
call through the timelock, wait out the delay, then execute it. Test this once with a trivial
`setDestination` to the same address you already have, **before** you need it for a real
withdrawal — a timelock you have never executed a change through is one you do not know how to
use, and an incident is the wrong time to learn.

---

## 7. What you cannot do, by construction

Worth knowing precisely, because these are the questions that come up later:

- **You cannot withdraw a store's owner proceeds.** Only that store's current controller can, via
  `withdrawOwnerProceeds(amount, to)`, and not while the store is under a governance lock.
- **You cannot withdraw any store's holder reserve.** There is no function anywhere that moves it
  to anyone but holders, through a dividend epoch. `contracts/test/12-holder-reserve-unreachable.test.js`
  enforces this from both directions: it sweeps the store's whole ABI and fails on any value-moving
  function not in a reviewed allow-list, and it separately proves behaviourally that the controller,
  a successor controller, the reward-pool path, `rescueToken` and the protocol treasury each leave
  the reserve untouched.
- **You cannot withdraw unclaimed dividends.** There is no expiry, no sweep and no reclaim path.
  See DECISIONS D-016.
- **You cannot take a fee from a store's AIC.** Protocol fees are USDC only.
- **`rescue()` cannot reach revenue.** It moves only the surplus above the accounted ledger.

If you ever find you *can* do one of these, that is a critical bug and the system should be paused
while it is fixed.

---

## 8. Where the numbers come from

All values are defined in `contracts/src/libraries/ProtocolConstants.sol` and read through the
Registry.

| Constant | Value | Governable | Hard cap |
|---|---|---|---|
| `COMMERCE_FEE_BPS` | 250 | yes — `setCommerceFeeBps` | 500 (5%) |
| `AGENTGOODS_PROTOCOL_FEE_BPS` | 200 | yes — `setAgentGoodsFeesBps` | 300 (3%) |
| `AGENTGOODS_CONTROLLER_FEE_BPS` | 100 | yes — `setAgentGoodsFeesBps` | 200 (2%) |
| `DIVIDEND_PROCESSING_FEE_BPS` | 500 | yes — `setDividendProcessingFeeBps` | 1000 (10%) |
| `HOLDER_RESERVE_BPS` | 500 | **no** | — |

The four governable ones move only through `FEE_ADMIN_ROLE`, which after the handoff is the
timelock, and only within the caps above — the cap is enforced in the contract, so a governance
mistake cannot set the commerce fee to 50%.

**`HOLDER_RESERVE_BPS` is the exception and it is deliberate.** `AICRegistry.holderReserveBps()` is
declared `pure`: it returns the constant, has no setter, and no role can change it. The 20% of net
commerce that belongs to token holders is the promise the whole token is priced on, and a promise
that governance can dilute is not a promise. If you ever need to know whether a store's economics
can be changed under its holders, that `pure` is the answer.
