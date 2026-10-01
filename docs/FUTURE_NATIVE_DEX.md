# Future: a protocol-owned DEX

**Status: design intent. Not funded, not scheduled, may never ship.**

Nothing in this document is a commitment, and nothing in the running system depends on it. It exists
because the current graduation behaviour is a trade-off rather than an ideal, and the better answer
is already known — writing it down now means the decision is deliberate rather than something
rediscovered later under pressure.

---

## 1. The problem it would solve

Anyone can create and fund a Uniswap pool for a store's AIC before its bonding curve reaches 30%.
When that happens the market abandons graduation permanently (D-035) and trades on its curve forever.

The current behaviour is the least-bad of three options, not a good one:

| Option | Outcome |
|---|---|
| List anyway | deposits the curve's whole USDC reserve at a price the attacker chose — **the only genuinely dangerous outcome** |
| Revert | funds safe, but every purchase past 30% fails forever and the token is stranded with no explanation |
| **Abandon graduation** (current) | the token never lists; everything else keeps working |

The cost of the current choice is real: **an attacker can permanently deny any token a listing for
the price of a dust-seeded pool.** That is O-002 in `SECURITY_FINDINGS.md`, open and accepted.

## 2. The fix

Deploy a protocol-owned AMM — our own factory and router — in which **pool creation for a store's
AIC is restricted to `AgentGoods`**. Graduation targets that venue instead of a public one.

```text
   today                              with a protocol-owned venue

   curve ──► Uniswap pair             curve ──► our factory
             ▲                                  ▲
             │ anyone can create               │ only AgentGoods can create
             │ and fund it first               │ a pool for this token
             │                                  │
          attacker                          nobody else
```

**Why it is a genuine fix rather than a better defence:** every version of this attack depends on
someone being able to create or fund the pool the protocol is about to list into. Remove that
ability and there is nothing to pre-seed and nothing to detect. The hazard stops existing instead of
being guarded against, and `graduationBlocked` becomes vestigial.

An attacker could still open a Uniswap pool for the same token. It would simply be irrelevant — an
unrelated market competing with the canonical one, which is an ordinary fact of open markets rather
than an attack on the listing.

## 3. Why it has not been built

**The blocker is cost, not engineering.** A constant-product AMM is a well-understood contract; the
expensive part is everything around it.

A new venue's liquidity is only reachable in practice once price aggregators and market-data sites
list it, and once routers and wallets integrate it. Until then:

- the pool does not appear where people look for prices
- aggregators do not route trades into it
- wallets cannot swap against it without manual configuration
- the chart, the price feed and the "buy" button all stop working the way they do today

**So a self-built DEX that nobody can find would be worse for holders than an established one that
carries a known, bounded griefing risk.** That is the whole argument for waiting, and it is an
argument about users rather than about code.

**Precondition:** enough real usage to justify the listing and integration cost. Not a date.

## 4. What it would have to preserve

If this is ever built, these are the properties that must survive — they are what make the current
listing trustworthy:

| Property | Why it cannot be dropped |
|---|---|
| **All LP burned** | "there is no rug" is the strongest guarantee in the token model. A protocol-owned venue must not become a protocol-owned LP position. |
| **All leftover inventory burned** | otherwise unsold supply hangs over the market permanently |
| **One-way, irreversible** | a venue the protocol controls must not be a venue the protocol can unwind |
| **No protocol fee after listing** | post-graduation trading takes nothing today; owning the venue must not quietly change that |
| **Continuous price series** | the chart must still cross the listing with no visible break (D-029) |
| **Real swap semantics** | the same k-invariant, `MINIMUM_LIQUIDITY` and reserve bounds. The mock router this project started with computed `liquidity = amountA + amountB` and would have passed tests the real thing fails. |

The last row is the one to hold onto. Writing our own AMM means losing the thing that makes the
current listing tests credible — that they run against **official Uniswap artifacts** with the
canonical init code hash asserted. A protocol-owned venue would need adversarial test coverage at
least as strong as `11-dex-transition-real.test.js`, written from scratch, with no battle-tested
reference implementation behind it.

**That is a real argument against building it**, not just a task. Uniswap V2 has secured very large
sums for years. A new AMM has secured nothing, and "we wrote it carefully" is not equivalent.

## 5. Open questions, if it is ever revisited

Recorded now because they are the parts most likely to be underestimated:

1. **Migration.** Would markets already `graduationBlocked` become eligible? They are blocked by a
   permanent on-chain flag, so this needs a deliberate mechanism, not an assumption. Doing nothing
   is a legitimate answer.
2. **Liquidity fragmentation.** Two venues for one token means two prices. Which one does the API,
   the chart and the schema treat as canonical?
3. **Upgrade surface.** A protocol-owned venue is more code behind `UPGRADER_ROLE`. See
   `UPGRADEABILITY_MATRIX.md` §3 — the trade there is already the largest piece of trust the system
   asks for.
4. **Existing listed tokens.** Markets already on Uniswap stay there. The protocol would permanently
   operate across two venues.
5. **Audit.** This is the point at which an external audit stops being optional. A novel AMM holding
   real liquidity is exactly the code that should not be first-audited by its users.

## 6. Until then

The current behaviour stands, and it is honest about what it costs:

- a funded pre-existing pool means the token never lists
- the curve keeps working in both directions, permanently, so nobody is trapped
- commerce, the 5% holder reserve, dividends and governance are unaffected
- it is reported explicitly through `graduationBlocked` everywhere rather than failing silently

**`GraduationBlocked` is indexed and worth watching.** One occurrence may be opportunism or a
mistake. A pattern across stores would be a deliberate campaign, and that — rather than a date — is
what should trigger revisiting this.
