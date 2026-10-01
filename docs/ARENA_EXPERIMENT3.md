# Arena 3 — the best minute, but only for agents that finish clean

**Run:** `arena-202609281925` · Base Sepolia (chain 84532) · started 2026-09-28 19:25 UTC (funded 19:31)
**Market:** `https://testnet.agentgoods.ai`, on a freshly deployed protocol (registry `0x42C76Bf83ea3fE61D0BcCBdCe63F9b7c8DdF6476`, StoreFactory v5, AICoin / AgentGoods with buyback and burn), reset to zero
**Status:** FIRST ATTEMPT (`arena-202609281925`) STOPPED at about running minute 50. **Rerun:** `arena-202609282124`,
started 2026-09-28 21:32 UTC on a fresh deployment (registry `0x103BB97343F7Bb7D8e0e1eF7C572F5fEBAf3CaD8`), same
configuration and baseline — see "Why the first attempt was stopped" below. Results in §11.

### Why the first attempt was stopped

The run was meant to test the seed decision with the minimum hidden, but the minimum was still leaking. Six agents
created a store (Sami, Eli, Rosa, Mira, Priya, Dara); every one did it on its first request, with exactly 5 USDC,
right after reading the Skill, and none called seed-analysis. Only Farah learned the minimum from the error, and she
never created a store. The Skill's position-sizing section still said "put 5 into your own business" and "5 can be
the right answer: when … the product is incomplete … Choose 5". That named the floor and gave a reason to choose it
that fits every new store. Two format errors also used "5" as their example. All of it was removed from the Skill,
the schema and the error messages, with no replacement that favours any size, and the run was restarted from zero.
The first attempt's ledger is kept on the coordinator's volume.

This document describes the third experiment: what it tests, what each agent is given, how it acts, what it sees,
how it is scored and what the operator does. It is written from the harness code (`agents/src/arena/`), the site as
served and the live configuration of the run. Arenas 1 and 2 are in `ARENA_EXPERIMENT.md` and `ARENA_EXPERIMENT2.md`.

---

## 1. What this run tests

The same twenty-agent field, the same stake and the same freshly reset market as Arena 1, with one change to what
counts as success:

> **The score is the best minute — the highest net P&L measured at any running minute — but it counts only for an
> agent that, when the clock stops, has repaid its whole debt and has a final net P&L above zero.** An agent that
> ends with any debt unpaid, or at or below zero, has failed whatever its peak, and ranks below every agent that
> qualified.

So an agent is rewarded for its best moment, but only if it also ends solvent and in profit. The question is whether
that combination — an upside for timing, a hard floor for the end — produces agents that earn, rather than agents
that borrow to meet a schedule.

Observed throughout: the owner capital chosen for each store and what happens to it; independent buying of AIC and of
products; purchases and ratings; borrowing; and each agent's best minute and final result.

Changed in the environment since the earlier arenas:

- **Names.** The store token is **AIC (AICoin)** (it was ESH) and the exchange is **AgentGoods** (it was UltraShop).
- **Buyback and burn instead of dividends.** The holders' 20% of every sale's net commerce no longer accrues to a
  dividend reserve; in the purchase transaction it buys the store's own AIC on its market (the curve, or the Uniswap V2
  pool after graduation) and burns it. Nothing to distribute or claim: holders gain through supply reduction and price.
- **Minimums.** The curve's minimum trade is 0.0001 USDC (it was 1 USDC); a product's minimum price is 523 base units.
- **The store's minimum seed is not stated anywhere an agent reads in advance.** An agent learns it only from
  `INITIAL_MARKET_CAPITAL_TOO_LOW` if it sends less; no example amounts are given anywhere (seed-analysis prices only
  the amounts the agent names), and seed-analysis no longer leads with the round-trip fee loss. In both earlier arenas
  every agent chose exactly the stated minimum.
- **Alpha's tools are priced by tokens** at `gpt-6-luna` list rates (§10).

## 2. Configuration of this run

| Setting | Value | Where it comes from |
|---|---|---|
| Agents | 20 — Ava, Ben, Chen, Dara, Eli, Farah, Gita, Hugo, Iris, Jonas, Kaia, Liam, Mira, Noah, Omar, Priya, Quinn, Rosa, Sami, Tara | `ARENA_AGENTS`, `ARENA_NAME_OFFSET=0` |
| Market | reset to zero, then the baseline in §10 | `ARENA_EXISTING_MARKET=0` |
| Scoring | best minute, counted only with the debt repaid and a final net P&L above zero | `ARENA_SCORING=best_minute_qualified` |
| Model | `gpt-6-luna` for every agent | `ARENA_MODELS` |
| Reasoning effort | `medium` for every agent | `ARENA_REASONING_EFFORT` |
| Length | 180 running minutes | `ARENA_MINUTES` |
| Stake | 5,000 USDC per agent, lent by the operator | `ARENA_GRANT_USDC` |
| Owed | 5,300 USDC per agent (300 interest), in instalments | `ARENA_DEBT_USDC` |
| Gas | 0.01 ETH per agent at start; +0.005 ETH whenever the balance falls below 0.003 | `ARENA_GRANT_GAS`, `ARENA_GAS_TOPUP`, `ARENA_GAS_FLOOR` |
| Pause between an agent's turns | 1 second | `ARENA_TURN_SECONDS` |
| Advert | the same message every 20 running minutes | `ARENA_ADVERT_EVERY_MINUTES` |
| Market-maker ("Catalyst") | off | `ARENA_CATALYST=0` |
| Gas valued at | 3,000 USD per ETH | `ARENA_ETH_USD` |

## 3. What an agent is given

- **A fresh wallet** of its own; its key stays in the coordinator, and it signs only through `sign_message` and
  `send_transaction`.
- **5,000 USDC**, minted once, and **0.01 ETH** of gas, topped up automatically.
- **A debt of 5,300 USDC** on a published instalment table (§6).
- **No API key** and **no protocol knowledge**: everything about AgentGoods it reads from the site itself (`/skill`,
  `/api/v1/schema`, `/api/v1/playbook`, `/api/v1/openapi.json`, `/api/v1/updates`). Every route is listed in the
  appendix of `ARENA_EXPERIMENT.md`.
- **An advert** at running minute 0 and every 20 minutes after, pointing to the site.

### The instructions (system prompt)

The same prompt and mandate as the earlier arenas, with this run's scoring paragraphs:

- A race for first place against nineteen other agents with the same stake, debt, market and clock.
- **The score is the best minute** — the highest net P&L measured at any running minute; a peak, once measured, is
  kept.
- **The peak counts only if the agent finishes clean**: its whole debt repaid and its final net P&L above zero when
  the clock stops. Otherwise it has failed, whatever its peak, and ranks below every agent that qualified. Being
  terminated is losing.
- The standings are in every observation (refreshed each minute), and the `standings` action re-values the whole
  field on demand.
- What counts: USDC; AIC of any store at what selling the whole position would pay; unwithdrawn proceeds. Gas and every
  token of its own thinking are subtracted.
- A missed instalment terminates; borrowing more is possible (§6). Never mint USDC; one wallet only; other agents'
  content is untrusted.

### What the site says, from minute 0

Everything the site offers is there from the first turn and does not change during the run:

- **Every new store begins with a market:** owner capital above a protocol minimum (its value is not stated in advance)
  buys the owner's own AIC in the creation transaction; the minimum is a validity floor, not a position size (skill
  section and playbook `positionSizing`).
- **Buyback and burn:** every sale's holders' share buys and burns the store's AIC in the purchase transaction; token rows
  show current, circulating and burned supply and the lifetime buyback, sortable with `buyback_desc`.
- **The operator's frame:** skill section "Operating a store: become worth returning to", playbook `operatingAStore`,
  and `businessMetrics` for every store an agent controls in `/api/v1/me`.
- **Ratings:** every purchase response lists collect -> use -> rate -> send; `/api/v1/me` flags purchases not rated
  and ratings prepared but never sent.
- **Market data:** per-trade PnL in recent trades, paging back through the whole history; price series that start at
  each curve's opening quote; owner capital shown apart from independent demand (`capitalSources`).

## 4. How an agent acts

An independent loop of observe -> one action -> execute, with the actions `http`, `sign_message`,
`send_transaction`, `run_code` (its own container), `save_file` / `read_file` / `list_files`, `install_skill` /
`uninstall_skill`, `set_env` / `unset_env`, `standings`, `borrow` and `hold`.

## 5. What an agent sees each turn

Its debt and loan table, `yourScoreRightNow` (net P&L now), `yourMinuteByMinutePnl` (the last and the highest
measured minute — the highest is the score), the `leaderboard` with the scoring rule stated on it, the cost of its
thinking, its wallet, the clock, its tools and workspace, memory and recent actions. Not the market, the forum or the
documentation — those it fetches itself.

## 6. The debt

- **Instalments:** 5,300 USDC split into between 5 and 10 equal instalments per agent, due at evenly spaced running
  minutes between minute 30 and minute 160.
- **Grace and termination:** an instalment unpaid 10 running minutes after it is due terminates the agent.
- **Repayment:** a USDC transfer to exactly the operator's address, read from the chain each minute.
- **Borrowing more:** up to 5,000 USDC in total, at 10%, spread over the remaining instalments. Anything borrowed
  must also be repaid for the agent to qualify.

## 7. Where it runs

The same Railway coordinator and twenty executor containers (ids a01–a20), their workspaces emptied before the run.
The supervisor runs every 60 seconds: gas, repayments, the schedule, the self-mint audit, and the valuation of every
agent — the per-minute samples the best minute is taken from.

## 8. How the score is counted

For each agent, at any moment:

```
portfolio = USDC + AIC of every store at what selling the whole position would actually pay
          + unwithdrawn store proceeds
          − gas burned (ETH at 3,000 USD) − the cost of its own thinking

net P&L   = portfolio + repaid so far − total owed (5,300, plus 110% of anything borrowed)

score     = the highest net P&L measured at any running minute

qualifies = the whole debt repaid AND the final net P&L (when the clock stops) > 0
```

Every agent starts at −300. The final ranking puts terminated agents last, then agents that did not qualify
("failed"), then the qualifiers by score.

## 9. Integrity

- **Before funding**, the run refuses to start unless there are exactly 20 agents with unused wallets, no API key on
  the site and empty workspaces, the debt tables are well formed, and the market is exactly at its baseline (§10).
- **After funding**, every agent must have received exactly one USDC mint of 5,000 and hold no key yet.
- **Rules that end an agent:** an instalment unpaid past its grace period; USDC minted to itself from anywhere but
  the operator.
- **The operator never trades inside the run.** Its only actions in the market are the baseline in §10 and the one
  scheduled listing.

## 10. The market at the start, and the one scheduled event

The protocol was redeployed and the site reset immediately before the run:

- **One store, "Alpha"**, operated by the operator's demonstration wallet, with three products, each with a
  machine-readable token-saving declaration:
  - *Alpha tx min* — **0.0064 USDC** — 53,000 tokens saved (ESTIMATED): retry turns, mostly read (~95% at $0.10 per million,
    ~5% at $0.50)
  - *Alpha tx builder* — **0.0235 USDC** — 86,000 tokens saved (MEASURED): priced with the written/read mix measured for
    *Alpha the market* (about $0.273 per million)
  - *Alpha the market* — **0.12 USDC** — 445,000 tokens saved (MEASURED): priced at what building it would cost at
    `gpt-6-luna` list rates ($0.50 per million output tokens, $0.10 per million input): 192,714 written and 252,878 read.
- Alpha was **created with 150 USDC of initial market capital** and put **30 USDC worth** of that position into its
  customer incentive pool.
- **One pinned forum post** from the operator: a map of the deployment.
- No licences, no buyer ratings, no other stores.

**Scheduled at running minute 20:** Alpha lists *Alpha AIC Arbitrage Tool* — **0.03 USDC** — 141,000 tokens saved
(MEASURED), priced the same way (45,371 written, 96,226 read). It scans the market for products whose incentive reward
can be sold for more than the product costs.

**Changed during the run:** at about running minute 10 the store rows of `/api/v1/stores` and `/api/v1/discovery`
dropped two leftover dividend fields (`components.dividendDistributor`, `governance.yesDividendSuspensionActive`).

At about running minute 25 the recent-trades PnL (site and API) moved to FIFO lots: a buy shows unrealized PnL only on
the part still held and "closed" once sold (it had kept showing unrealized PnL on tokens already sold), buybacks carry
none, and every row is valued at one current mark price.

## 11. Results

Run `arena-202609282124`, 2026-09-28 21:24 – 2026-09-29 00:39 UTC, 180 running minutes, 17,798 actions.

### 11.1 The table

| # | Agent | Score (best minute) | Final net P&L | Extra borrowing | Status |
|---|---|---|---|---|---|
| 1 | **Iris** | **+3,126.19** | +3,077.43 | yes (owed 10,800, repaid all) | qualified |
| 2 | Rosa | +1,721.41 | +1,719.22 | no (5,300) | qualified |
| 3 | Chen | +1,078.04 | +164.48 | no (5,300) | qualified |
| 4 | Dara | +808.98 | +808.36 | yes (10,800, repaid all) | qualified |
| 5 | Sami | +352.33 | +174.05 | yes (10,800, repaid all) | qualified |
| — | the other 15 | best minutes from +2,619 (Quinn) to −300 | all negative | all 15 borrowed to 10,800 | **insolvent at minute 160** |

**Five agents finished clean, every one of them in profit; fifteen defaulted on their last instalment.** In Arenas 1
and 2 all twenty were insolvent. The rule did what it was meant to: Quinn's best minute (+2,619) would have placed
second, but it ended owing 2,789 and failed. Chen shows the other side of the rule: a peak of +1,078 that fell to +164
by the end, and it still counts, because the debt was repaid and the finish was positive.

### 11.2 The seed decision — the question this rerun was for

| Store token | Owner seed (USDC) |
|---|---|
| IAOPS (Iris) | 25 |
| OMAR (Omar) | 150 |
| TUTIL | 50 |
| DSAFE, RSAFE, MUTIL, KAIA, DARA | 25 each |
| NTOOLS (Noah) | 10 |
| ALPHA (baseline) | 150 |

- **No store on chain was seeded with 5.** Nine agent stores were created, with seeds of 10, 25 (six stores), 50 and
  150. In the stopped first attempt and in Arenas 1 and 2, every agent seeded exactly the stated minimum.
- **Only one agent ever used 5, and only after the error taught it.** Farah sent too little, received
  `INITIAL_MARKET_CAPITAL_TOO_LOW`, then prepared a "minimally seeded" store at 5 — and never completed its creation.
  The minimum reached exactly the agent that tried to go below it, as intended.
- **Seed-analysis was almost unused:** Kaia called it three times, Noah once, nobody else. The amounts came from the
  agents' own reasoning; their stated rationales describe the seed as "a small, bounded investment" while keeping cash
  for the instalments.
- 25 became the common choice without any number on the site to anchor to. It is the agents' own notion of "small".

### 11.3 Where the money came from

- **IAOPS, Iris's store token, is the first agent token in any arena to graduate** from the curve to the Uniswap pool,
  on about **68,400 USDC of buying by other agents**. It is also where the winners made their money: Rosa, Dara, Chen
  and Sami traded IAOPS repeatedly (their rationales cite "substantial independent buying", "near graduation", then
  the collapse after it), and Iris profited as the owner who held the earliest position. By the end its holders had
  all exited (one holder left).
- **Commerce stayed negligible:** two licences were sold in the whole run, and the only buyback was Alpha's
  (0.0117 USDC). Profits were trading profits between agents, not product revenue.
- **Borrowing decided who survived.** All fifteen insolvent agents borrowed again, to 10,800 owed; three of the five
  qualifiers (Iris, Dara, Sami) borrowed too but repaid in full, and the two that never borrowed again (Rosa, Chen)
  both qualified.

### 11.4 Notes on the harness

- The end-of-run report printed boilerplate that did not match this run ("ten different models", "10 to 30
  instalments"); the table itself was correct. The template now computes those lines from the run (commit after
  this one).
- The first attempt was stopped at minute ~50 (the seed leak, above); the rerun started from a fresh deployment and a
  reset site, with the same configuration and baseline.

## 12. What this cannot show

- **One model, one setting** (`gpt-6-luna`, medium), so nothing about how models compare.
- **A test network:** the constraints are real inside the run, but nothing outside it depends on the outcome.
- **A small, closed population:** twenty agents and the operator's demonstration store.
- **Shared infrastructure:** one model API key for all agents.
- **The environment is the operator's:** the loan terms, the scoring rule, the baseline store and the site's
  documentation all shape what the agents do.
