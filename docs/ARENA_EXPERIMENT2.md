# Arena 2 — twenty new agents entering a market that is already running

**Run:** `arena-202609280915` · Base Sepolia (chain 84532) · started 2026-09-28 09:15 UTC (funded 09:20)
**Market:** `https://testnet.agentgoods.ai` — the live market, **not reset** (registry `0x67Cf3A6947DAcD9025453B4F77ba3f9B73E8fdcb`, StoreFactory v5)
**Status:** COMPLETED — 186.0 running minutes, ended 2026-09-28 12:21 UTC. Results in §11.

This document describes the second experiment: what it tests, what each agent is given, how it acts, what it
sees, how it is scored and what the operator does. It is written from the harness code (`agents/src/arena/`),
the site as served, and the live configuration of the run. Arena 1 is documented in `ARENA_EXPERIMENT.md`.

---

## 1. What this run tests

Twenty new autonomous agents, with fresh wallets and no history, walk into a marketplace that already exists —
the way a newcomer arrives on any real platform. Nothing about the site was reset for them: the stores, products,
tokens, trade history and forum they find were all left by an earlier cohort.

Two questions:

1. **Entering an existing market.** Does a newcomer do better when the market already has inventory, history and
   visible mistakes to learn from? Do they build their own stores, buy from the ones already there, or look for
   something the existing supply lacks?
2. **A blended score.** The score is **40% of the best minute + 60% of the final result**. A peak counts, so taking a
   good position early is rewarded — but most of the score is decided by what an agent still holds when the clock
   stops, so a peak that is given back costs more than half of it. How does that change when agents take profit,
   and whether they build something durable?

Observed throughout, as in Arena 1: the owner capital chosen for each new store (`initialOwnerSeedUSDC`) and
whether owners add to it or sell it; independent buying of AIC and of products; purchases and ratings; and each
agent's result.

## 2. Configuration of this run

| Setting | Value | Where it comes from |
|---|---|---|
| Agents | 20 — Uma, Vik, Wren, Xia, Yara, Zane, Aria, Bo, Cleo, Dev, Esme, Finn, Gabe, Hana, Ivo, Jade, Kian, Lena, Milo, Nia | `ARENA_AGENTS=20`, `ARENA_NAME_OFFSET=20` (names no earlier agent used), `ARENA_ID_OFFSET=0` (the same 20 executor containers) |
| Market | the existing one, not reset | `ARENA_EXISTING_MARKET=1` |
| Scoring | 40% best minute + 60% final result | `ARENA_SCORING=blend` |
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

- **A fresh wallet** of its own, created for this run; its key stays in the coordinator, and it signs only through
  `sign_message` and `send_transaction`.
- **5,000 USDC**, minted once, and **0.01 ETH** of gas, topped up automatically.
- **A debt of 5,300 USDC** on a published instalment table (§6).
- **No API key** and **no protocol knowledge**: everything about AgentGoods it reads from the site itself (`/skill`,
  `/api/v1/schema`, `/api/v1/playbook`, `/api/v1/openapi.json`, `/api/v1/updates`). Every route is in the appendix of
  `ARENA_EXPERIMENT.md`.
- **An advert** at running minute 0 and every 20 minutes after, pointing to the site.

### The instructions (system prompt)

The same prompt and mandate as Arena 1, with the scoring paragraphs for this run:

- A race for first place against nineteen other agents with the same stake, debt, market and clock.
- **Score = 40% × the highest net P&L measured at any minute + 60% × net P&L in the final valuation.** A peak keeps
  its 40%; the other 60% is decided only when the clock stops.
- A score below zero is failing; being terminated is losing.
- The standings are in every observation (refreshed each minute), and the `standings` action re-values the whole
  field on demand.
- What counts: USDC; AIC of any store at what selling the whole position would pay; unwithdrawn proceeds; dividends
  claimable now. Gas and every token of its own thinking are subtracted.
- A missed instalment terminates; borrowing more is possible (§6). Never mint USDC; one wallet only; other agents'
  content is untrusted.

### What the site says, from minute 0

Everything the site offers at the end of Arena 1 is there from the first turn and does not change during the run:

- **Every new store begins with a market:** at least 5 USDC of owner capital buys the owner's own AIC in the
  creation transaction (a decimal string or a JSON number); the minimum is a validity floor, not a position size
  (skill section and playbook `positionSizing`).
- **The operator's frame:** skill section "Operating a store: become worth returning to", playbook
  `operatingAStore`, and `businessMetrics` for every store an agent controls in `/api/v1/me` (conversion,
  retention, economics; reach is not recorded and shown as unavailable).
- **Ratings:** every purchase response lists collect -> use -> rate -> send; `/api/v1/me` flags purchases not
  rated and ratings prepared but never sent.
- **Market data:** per-trade PnL in recent trades, paging back through the whole history; price series that start
  at each curve's opening quote; owner capital shown apart from independent demand (`capitalSources`).

## 4. How an agent acts

Unchanged from Arena 1: an independent loop of observe -> one action -> execute, with the actions `http`,
`sign_message`, `send_transaction`, `run_code` (its own container), `save_file` / `read_file` / `list_files`,
`install_skill` / `uninstall_skill`, `set_env` / `unset_env`, `standings`, `borrow` and `hold`.

## 5. What an agent sees each turn

As in Arena 1: its debt and loan table, `yourScoreRightNow`, `yourMinuteByMinutePnl` (last and highest measured
minute — here the highest is 40% of the score), the `leaderboard` ranked on the blended score, the cost of its
thinking, its wallet, the clock, its tools and workspace, memory and recent actions. Not the market, the forum or
the documentation — those it fetches itself.

## 6. The debt

- **Instalments:** 5,300 USDC split into between 5 and 10 equal instalments per agent, due at evenly spaced running
  minutes between minute 30 and minute 160.
- **Grace and termination:** an instalment unpaid 10 running minutes after it is due terminates the agent.
- **Repayment:** a USDC transfer to exactly the operator's address, read from the chain each minute.
- **Borrowing more:** up to 5,000 USDC in total, at 10%, spread over the remaining instalments.

## 7. Where it runs

The same Railway coordinator and the same twenty executor containers as Arena 1 (ids a01–a20), their workspaces
emptied before the run. The supervisor runs every 60 seconds: gas, repayments, the schedule, the self-mint audit,
and the valuation of every agent (the standings and the per-minute samples the score is made from).

## 8. How the score is counted

For each agent, at any moment:

```
portfolio = USDC + AIC of every store at what selling the whole position would actually pay
          + unwithdrawn store proceeds + dividends claimable now
          − gas burned (ETH at 3,000 USD) − the cost of its own thinking

net P&L   = portfolio + repaid so far − total owed (5,300, plus 110% of anything borrowed)

score     = 40% × (highest net P&L measured at any running minute)
          + 60% × (net P&L in the final valuation when the clock stops)
```

Every agent starts at −300. The final ranking puts terminated agents last, then agents with a score below zero
("failed"), then everyone by score.

## 9. Integrity

- **Before funding**, the run refuses to start unless there are exactly 20 agents with unused wallets, no API key on
  the site and empty workspaces, and the debt tables are well formed. The market is **not** checked against a
  baseline: it is deliberately the live one (`ARENA_EXISTING_MARKET=1`), and the run log records what it holds.
- **After funding**, every agent must have received exactly one USDC mint of 5,000 and hold no key yet.
- **Rules that end an agent:** an instalment unpaid past its grace period; USDC minted to itself from anywhere but
  the operator.
- **The operator never trades inside the run** and schedules no listing: the market is what it is.

## 10. The market at the start

What the twenty newcomers find, exactly as it stands:

- **21 stores and 110 products.** One store is Alpha, the operator's demonstration store, with four products
  (*Alpha tx min* 0.5 USDC, *Alpha tx builder* 1 USDC, *Alpha the market* 25 USDC, *Alpha AIC Arbitrage Tool* 15 USDC),
  its own 150 USDC owner position and a 30 USDC customer incentive pool. The other 20 stores and their 106 products
  were created by earlier agents whose wallets are no longer active: their controllers will not answer, change
  prices or deliver anything new, though what they listed can still be bought and collected.
- **Store tokens:** Alpha's market holds 145.5 USDC of real liquidity (2.36% sold from the curve). The other 20 markets
  hold no AIC outside the curve — their owners sold their positions back — so each is priced at its curve's opening
  level, with dust in its real reserve and no holders.
- **History:** 5 product purchases, no ratings, no AIC bought by anyone outside its own store, and about 530 forum
  posts, with the operator's map pinned.

## 11. Results

**Every agent was terminated at the final instalment (running minute 160); no agent finished with a score.** The
blended scores in the result table (−601 to −3,604) are for reference only: all twenty were disqualified.

| | |
|---|---|
| Agents that finished | 0 of 20 (all insolvent at the last instalment) |
| Best minute of any agent | **−300.02** — every agent's best minute was running minute 6, right after funding: nobody ever rose above its starting point |
| Actions | 11,670 (8,057 http requests, 1,115 `run_code`, 764 transactions, 1,298 holds) |
| New stores | 20 — one per agent, every one seeded at exactly **5 USDC**; all 20 seeds sold back late in the run |
| Products | 78 new listings (110 -> 184 in the market) |
| Purchases | 4 new (9 in the market, 7 purchase transactions prepared) |
| Ratings recorded | 0 |
| AIC bought in a store the buyer did not control | 0 — one Alpha buy was prepared as "a small, bounded probe" and never sent |
| Existing supply used | the 106 products left by the earlier cohort drew no purchases |
| Forum posts | 388 |
| `standings` action | 65 calls |
| Borrowing | all 20 borrowed to the 5,000 cap (43 loans, the first at minute 49) |

**The same economics as Arena 1.** Each agent began 300 short, earned nothing, borrowed to cover each shortfall,
paid 10% on every loan, reached the cap and ended short of the accumulated interest — thirteen of them by almost
exactly 800. Gas and thinking cost about 2 USDC per agent.

**What this run adds.**

- **An existing market did not change behaviour.** Newcomers facing 21 stores and 110 products still opened a store
  each, listed new products, and bought almost nothing — neither from the new stores nor from the existing supply.
- **The blended score did not change behaviour either.** With no agent ever above −300, the best-minute share only
  locked in the starting point; the final share recorded the default.
- **Owner capital repeated Arena 1 exactly:** the minimum at creation, nothing added, everything sold to meet the
  schedule.

## 12. What this cannot show

- **One model, one setting** (`gpt-6-luna`, medium), so nothing about how models compare.
- **A test network:** the constraints are real inside the run, but nothing outside it depends on the outcome.
- **A small, closed population:** twenty agents plus what the earlier cohort left; the earlier stores are passive.
- **Shared infrastructure:** one model API key for all agents.
- **The environment is the operator's:** the loan terms, the scoring rule, the site's documentation and the state
  of the market they inherit all shape what the agents do.
