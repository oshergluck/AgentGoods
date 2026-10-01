# Threat model

Organised by attacker, because that is how attacks actually arrive. For each: what they want, what
they control, what stops them, and — where it applies — what they can still do.

The last column is the one worth reading. A threat model that only lists defeated attacks is
marketing.

---

## 1. An opportunistic trader

**Wants:** profit from the bonding curve at other traders' expense.
**Controls:** ordinary wallets, ordinary transactions, transaction ordering within a block.

| Attack | Status |
|---|---|
| Sandwich a large buy on the curve | **Mitigated, not eliminated.** `minTokensOut` and `deadline` bound the loss to what the trader accepted. The curve is deterministic, so the damage is bounded by slippage tolerance rather than by luck. |
| Buy immediately before a dividend snapshot, sell after | **Eliminated.** Entitlement is the *minimum* balance across a holding window (default 7 days), not the balance at a block. A snipe earns exactly zero. `test/10-holding-window.test.js` |
| Trigger the DEX transition at an advantageous moment | **Not an attack.** The threshold is a public function of supply sold; `quoteBuy` returns `willTriggerTransition` so it is predictable rather than surprising. |
| Trade during a pause | **Blocked**, and see §6 — this also blocks exits. |

**What still works:** ordinary MEV on a public mempool. Nothing here claims to prevent it, and a
design that claimed to would be lying.

## 2. Someone attacking the DEX listing

This gets its own section because it is the one irreversible, unrehearsable, money-moving code path
in the protocol, and because we could not afford to test it for real.

**Wants:** capture the liquidity moved at the transition, or brick the pool.
**Controls:** the ability to create and seed a Uniswap pair before the protocol does.

| Attack | Status |
|---|---|
| **Pair front-running.** Create the AIC/USDC pair first and seed it at a hostile ratio, so the router honours the attacker's price when the protocol adds liquidity | **Covered, and the response changed in D-035.** The market now detects the funded pool at the threshold and abandons graduation permanently rather than attempting to list. No USDC is deposited, no approval is left, and the curve keeps trading. Previously it reverted — safe for funds, but it stranded the token; see below. |
| **Griefing graduation.** Seed a pool with dust purely to stop a token listing | **Mitigated, not eliminated.** It still prevents that token from ever listing, and it costs the attacker almost nothing. What it no longer does is break the token: trading continues in both directions forever, and the condition is reported through `graduationBlocked` rather than presenting as an unexplained failed transaction. This is an accepted residual — see O-002 in SECURITY_FINDINGS. |
| Brick the pool by pushing reserves past `uint112` | **Covered.** Bounds asserted directly. |
| Claim the burned LP | **Impossible.** LP is sent to a burn address and `MINIMUM_LIQUIDITY` is locked by Uniswap itself. Asserted. |
| Buy the remaining curve inventory after listing | **Impossible.** All inventory is burned and the curve is permanently closed at the transition. Asserted. |
| Use a leftover approval | **Impossible.** No standing approvals remain. Asserted. |

**Why these tests are trustworthy:** they run against the **official Uniswap V2 artifacts**
(`@uniswap/v2-core@1.0.1`, `@uniswap/v2-periphery@1.1.0-beta.0`), and `test/helpers/uniswap.js`
asserts the deployed factory's init code hash equals the mainnet constant
`0x96e8ac...848845f`. The previous mock router computed `liquidity = amountA + amountB` with no
`MINIMUM_LIQUIDITY`, no `uint112` bound, no optimal-amount `quote()` path and no k-invariant — a
transition could pass against it and still revert or mis-price against the real thing.

## 3. A hostile store controller

**Wants:** take value that belongs to holders or buyers.
**Controls:** everything a store owner legitimately controls — listings, prices, metadata, the
controller key.

| Attack | Status |
|---|---|
| Withdraw the holder reserve | **Impossible.** No function exists. `test/12-holder-reserve-unreachable.test.js` sweeps the whole ABI as well as testing behaviour. |
| Withdraw more proceeds than earned | **Impossible.** Bounded by `_ownerAvailableUSDC`, from which the reserve was already subtracted. Off-by-one asserted. |
| `rescueToken` the store's USDC or AIC | **Impossible.** Both canonical tokens are refused. |
| Censor holder dividends by refusing to open an epoch | **Impossible.** The distributor's open path is permissionless, so an inactive or hostile controller cannot withhold distributions. |
| List a product whose description carries instructions to an Agent | **Boundary, not a filter.** Seller text never reaches a place that treats it as an instruction. See `TRUST_BOUNDARIES.md` §3. |
| Inflate a token-saving claim | **Works, and is meant to.** It is a seller *declaration*, surfaced as unverified. Presenting it as a benchmark would be the bug. |
| Sell nothing and keep the money | **Out of scope for the protocol.** This is fraud, not an exploit; the licence and delivery records make it evidence rather than preventing it. |

**What still works:** everything a dishonest merchant can do anywhere. The protocol guarantees
accounting, not merchant quality.

## 4. A hostile token holder

**Wants:** seize a store, or extract more than their share.

| Attack | Status |
|---|---|
| Buy a majority and take over a store | **This is a feature, with conditions.** Takeover requires verified largest-eligible-EOA status and a continuous one-hour observation period, checked by the token contract itself. See `STORE_TAKEOVER_MODEL.md`. |
| Flash-loan a majority for one block | **Eliminated.** The one-hour continuous observation cannot be satisfied within a transaction or a block. |
| Take over, then drain the holder reserve | **Impossible.** A new controller inherits exactly the same inability to reach it — asserted explicitly in `test/12-holder-reserve-unreachable.test.js`. |
| Claim a dividend twice | **Impossible.** Claims are Merkle proofs against a finalized root with claim tracking. |
| Claim more than entitled | **Impossible.** Entitlement is the minimum balance in the window; a forged proof fails the root. |

## 5. An attacker with a stolen credential

Ordered by how bad it is, which is not the order people expect.

| Stolen | Worst outcome |
|---|---|
| An agent's API key | Read that caller's own data; generate transaction intents nobody is obliged to sign. **Not money.** |
| `ACCESS_TOKEN_KEY` | Mint delivery links for any licence — the content catalogue leaks. |
| `CONTENT_ENCRYPTION_KEY` | Every stored product becomes readable from a database dump. |
| `API_KEY_PEPPER` | Forge webhook deliveries to every registered endpoint; API key hashes become attackable. |
| The guardian key | **Denial of service.** Pause everything. Cannot unpause, cannot take anything. See §6. |
| The bootstrap admin key (pre-handoff) | **Total loss.** Upgrade `AgentGoods` to arbitrary code. This is the whole reason the handoff exists. |
| A timelock signer key (post-handoff) | Nothing alone — it needs the threshold, and then still waits out the delay in public. |
| A store controller key | That store's owner proceeds, and its listings. Not its reserve. |
| An agent's **wallet** key | Total loss for that agent. |

The shape worth noticing: the credential the backend handles most often (an API key) is the one
whose theft costs the least, and the credentials whose theft costs the most are the ones the backend
never holds at all.

## 6. Denial of service, stated honestly

This is where the model has a real, unresolved cost rather than a defeated attack.

**A compromised guardian key can freeze the protocol.** It can set every pause scope. It cannot
unpause — that requires `DEFAULT_ADMIN_ROLE`, which after the handoff is the timelock. So recovery
takes **at least the timelock delay**, during which:

- no store can be created
- no purchase or rental can complete
- no curve trade can happen — **including selling**

That last point is the sharp one. `PAUSE_MARKET` gates `sell` as well as `buy` (`AgentGoods.sol:385`
and `:439`), so a hostile pause traps holders on the curve for the duration.

**Why it is still right:** the scenario that justifies pausing the market is a defect in curve
pricing or reserve accounting. A pause that left `sell` open would accomplish nothing except letting
whoever noticed first drain the reserve at the wrong price. A pause that halts only buying is not a
pause.

**What is deliberately never pausable**, so a freeze cannot become a confiscation: dividend claims,
licence validity, content access for something already bought, owner-proceeds withdrawal, and
reserve movement between store and distributor.

**What this costs you as an operator:** the timelock delay is your minimum outage in this scenario.
It is the main argument against a very long delay. 48 hours is the recommended balance —
`GUARDIAN_TIMELOCK_MODEL.md` §5.

## 7. Attacks against the backend

| Attack | Status |
|---|---|
| SSRF via a registered webhook URL | **Mitigated in depth.** Re-validated before every delivery, metadata addresses refused in all environments, `redirect: "manual"`, IPv6 expanded before comparison. `TRUST_BOUNDARIES.md` §4. |
| Replay a webhook to cause double-processing | **Mitigated.** Signed with a derived secret; `(chainId, txHash, logIndex)` identity makes consumers deduplicable. |
| Replay a delivery URL | **Mitigated.** Single-use, signed, and ownership is re-checked at redemption rather than only at issue. |
| Use a content blob from store A as store B's | **Impossible.** AAD binds ciphertext to `(store, contentHash)`. |
| Poison the projection with a crafted event | **Impossible from outside.** Only events from canonical addresses are projected, and the address book is derived from the Registry. |
| Cause a permanently wrong projection via reorg | **Mitigated.** Rollback by event identity, plus a fixed-point re-scan for newly discovered addresses. |
| Read a stale projection as truth | **Mitigated.** Lag is exposed at `/api/v1/status`; readiness is `/health/ready`. |

## 8. What is explicitly out of scope

Saying so plainly is more useful than implying coverage:

- **A compromised user device or wallet.** Nothing on the server side helps.
- **Merchant fraud.** Accounting is guaranteed; honesty is not.
- **Base itself, or Uniswap itself.** Both are dependencies and both are trusted.
- **RPC provider censorship.** Confirmation depth handles disagreement about finality, not refusal
  to relay.
- **Price manipulation on the external DEX after listing.** Once listed, it is an ordinary
  Uniswap pair with ordinary Uniswap properties.
- **Regulatory risk.** Not a technical control.

## 9. The findings that came from actually building it

The most credible part of any threat model is the list of things that were wrong. See
`SECURITY_FINDINGS.md` — including a genuine SSRF bypass in this codebase's own first defence,
found because the check was written against one spelling of an address and the normalizer produced
another.
