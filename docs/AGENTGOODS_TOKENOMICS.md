# AgentGoods tokenomics

Every store gets its own AIC token and its own market. This document is how that market prices,
what the fees are, and what happens at the listing.

---

## 1. The numbers

| | Value |
|---|---|
| Genesis supply | 1,000,000,000 AIC, minted once at store creation |
| Virtual USDC seed | 6,000 USDC |
| Transition threshold | 300,000,000 AIC — 30% of genesis |
| LP premium at listing | +35% over curve price |
| LP slippage tolerance | 1% |
| Minimum trade | 1.000000 USDC |
| Protocol fee | 2% of gross, buy and sell |
| Controller fee | 1% of gross, buy and sell |

All defined once in `ProtocolConstants.sol` and derived everywhere else from the deployment
manifest. Nothing downstream hardcodes them.

## 2. Pricing

Constant product over **virtual** reserves. The entire genesis supply starts in the curve, paired
against a 6,000 USDC seed that does not exist as money.

The seed is what makes price well-defined at zero real liquidity. Without it, the first buyer faces
a division by zero or an arbitrarily low price; with it, the curve starts at a definite price and
moves smoothly.

**The seed is never real, never withdrawable and never sent to the LP.** It is pricing state. A
store's market can hold 6,000 USDC of virtual reserve and 0 USDC of actual money, and both
statements are true simultaneously.

### The two reserves, which are not the same thing

| Field | Moves? | What it is |
|---|---|---|
| `virtualSeedUSDC` | **no**, with one exception | the 6,000 USDC seed. Reduced exactly once, only on a market whose graduation was blocked (D-037). `constant` is published as a boolean. |
| `curvePricingReserveUSDC` | yes | seed + real USDC currently in the curve |
| `realUSDCReserve` | yes | only the real part |

Conflating the first two was a real defect (F-005) found by the operator asking why "virtual
liquidity" was changing. It was a fair question and the answer was that the field was misnamed. A
`reserveIdentity` is now exposed so any consumer can verify the relationship rather than assume it.

### Price scale

`PRICE_SCALE = 1e30` — `1e18` of scaling multiplied by `1e12` to bridge USDC's 6 decimals and the
token's 18. One definition, shared by contracts, indexer and UI.

This was three different numbers at one point (F-003), and the symptom was a price of `7.16e-6`
USDC being served to the API as `7.16`. Nothing errored; every layer was internally consistent.

## 3. Fees

On every curve trade, both directions, on gross:

```text
   100 USDC buy
    ├── 2 USDC  ──► protocol fee  ──► ProtocolTreasury (operator)
    ├── 1 USDC  ──► controller fee ──► the store's controller
    └── 97 USDC ──► the curve
```

**Both fees stop at the transition.** They are pre-transition only. Once listed, trading is on
Uniswap and the protocol takes nothing from it — there is no mechanism to, and no mechanism is
added.

The controller fee accrues inside AgentGoods and is withdrawn separately with
`withdrawControllerFees(aicToken, to)`. It survives the transition as an unpaid balance: after a
listing, the only USDC AgentGoods may hold for that market is exactly the unwithdrawn controller
fees, which is asserted in `test/14-lifecycle-simulation.test.js`.

## 4. The listing

At 300,000,000 AIC sold (30%), the transition fires. It is atomic, one transaction, and one-way.

**Unless a funded external pool already exists**, in which case the market abandons graduation
permanently and keeps trading on its curve. Listing into a pool someone else has already funded
would mean depositing this curve's USDC at whatever price they chose, so the market declines rather
than accept it. The condition is exposed as `graduationBlocked` everywhere — on chain, in the API,
in `quoteBuy`, and in the UI — and it is irreversible even if that pool is later emptied. D-035, and
O-002 in `SECURITY_FINDINGS.md` for the residual risk this accepts.

A pair that merely *exists* with no liquidity does not block anything: adding liquidity to an empty
pool sets the price at our ratio, exactly as creating the pair ourselves would.

**A blocked market still gets graduation's economics** (D-037). It burns unsold inventory so supply
and price land where a listing would have put them — the same +35% step — and reduces the virtual
seed alongside the burn.

The seed reduction is not incidental. The curve has **exactly zero solvency margin**: selling every
outstanding token quotes precisely the real reserve, to the base unit. Burning tokens alone would
raise the quoted payout above the USDC that exists and strand holders who sell late. Reducing the
seed with the burn is what keeps a full exit exactly payable — and it is why `virtualSeedUSDC` is
published with a `constant` flag rather than assumed to be 6,000.

**The price is set at curve price + 35%.** The premium is preserved from V0. Its purpose is that the
pool opens above the last curve price rather than at it, so the final curve buyer is not instantly
underwater against the pool they just funded.

What happens, and each of these is asserted against **real Uniswap V2 artifacts**, not a mock:

| Step | Asserted |
|---|---|
| Pair created and funded | ✅ |
| **All** LP burned, plus Uniswap's own `MINIMUM_LIQUIDITY` | ✅ |
| **All** remaining curve inventory burned | ✅ |
| Every approval revoked | ✅ |
| Curve permanently closed | ✅ |
| Listing price is curve + 35% | ✅ |
| A funded pre-existing pool abandons graduation instead of listing | ✅ |
| Reserves stay inside `uint112` | ✅ |

`test/11-dex-transition-real.test.js`, with `test/helpers/uniswap.js` asserting the deployed
factory's init code hash equals the mainnet constant. See `THREAT_MODEL.md` §2 for why that matters
more than it sounds.

### What the operator cannot do afterwards

**The LP is burned.** Not held by a multisig, not vested, not timelocked — sent to a burn address
and gone. Nobody can withdraw the liquidity, including the operator, including after the handoff,
including via an upgrade to AgentGoods, because AgentGoods never holds the LP at any point after the
transaction that burns it.

This is the single strongest guarantee in the token model and it is worth stating in those terms:
**there is no rug.** Not "we promise not to" — there is no function.

## 5. Supply

Supply only ever decreases:

```text
  1,000,000,000  genesis, minted once
        −        burned at the transition (all unsold curve inventory)
        =        circulating, forever
```

There is no mint path after creation. `currentSupply` is derived as `genesis − burned` rather than
accumulated, because accumulating it is what produced F-004 — stores reporting 2B against a 1B
genesis, visible in the UI and invisible to a test suite that only checked deltas.

The absolute is now asserted directly, at every stage of a full lifecycle, in
`test/14-lifecycle-simulation.test.js`.

## 6. Why 30%

It is a balance between two failure modes:

- **Too low** — the pool lists thin, a small trade moves the price a lot, and the token is volatile
  in a way that reflects nothing about the store.
- **Too high** — most of the supply is distributed before there is a real market, and the curve
  captures value that should have gone to the pool.

30% with a 6,000 USDC seed means listing happens after meaningful price discovery but while the
majority of supply is still unsold and therefore burned. The burn is the point: a listing that left
70% of supply in a contract would hang over the market permanently.

## 7. Value accrual, and the honest caveat

An AIC token is a claim on **5% of its store's net commerce, forever**, paid as dividends to holders
weighted by minimum balance across a holding window.

That rate is not governable. `AICRegistry.holderReserveBps()` is declared `pure` — no setter, no
role, no vote. A promise governance can dilute is not a promise, so it was made unreachable. See
`UPGRADEABILITY_MATRIX.md` §4.

**The caveat, stated plainly:** 5% of nothing is nothing. A store with no commerce produces no
dividends, and its token is a claim on a future that may not arrive. The protocol guarantees the
*mechanism* — that the 5% is taken, is unreachable by the owner and the operator, and reaches
holders — and guarantees nothing whatsoever about whether any given store sells anything.

## 8. Checking all of this yourself

```bash
cast call $AGENTGOODS "market(address)" $AIC_TOKEN --rpc-url $BASE_RPC_URL
cast call $AGENTGOODS "quoteBuy(address,uint256)" $AIC_TOKEN 1000000 --rpc-url $BASE_RPC_URL
cast call $AIC_TOKEN "totalSupply()(uint256)" --rpc-url $BASE_RPC_URL
```

`quoteBuy` returns `willTriggerTransition`, so the listing is predictable before a transaction
rather than a surprise after one.
