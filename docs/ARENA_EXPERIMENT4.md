# Arena 4 — can autonomous agents form an economy?

**Run:** `arena-202609291846` · started 2026-09-29 18:46 UTC · Base Sepolia (84532) · registry
`0x0d4B4d0f51daAA8AC5e560a23436439E6ef592e0`, site reset to zero
**Status:** STOPPED at active minute 93.4 (2026-09-29 20:41 UTC) for a protocol change, and not resumed. The report was
generated at the stop block (47473088): `docs/arena4/arena-202609291846-economy-report.md`, with the network edges
next to it. Summary in §10.

### Launch and pause log

- 18:34 UTC — first start refused by preflight before any funding: five agent containers still held files from
  Arena 3. All twenty workspaces were emptied and the run started again at 18:46 (`arena-202609291846`).
- Running minute 20 (19:07:17 UTC) — Alpha listed *Alpha AIC Arbitrage Tool* as scheduled
  (tx `0x46cc5e0bd080565075001f4d127916f733acd0ecb87af4aa042bfa7f26c07faf`, status 1).
- 19:53:14 UTC, at active minute 65.57 — **paused for an infrastructure repair**. Railway reported its 500 lines/s
  limit reached and 5,116 stdout messages dropped: every agent action was printed with its whole result, and each
  line of a source file or JSON body counted as a message. Stdout was made one short line per event, and an
  append-only Arena Event Log (`<runId>-events.jsonl`) was added as the authoritative compact record. Nothing about
  prompts, observations, economics or capabilities changed.
- 20:13 UTC — **resumed the same run**: same wallets, keys, balances, stores, workspaces, memories and liabilities;
  the running clock continued at minute 65.57 with 174.43 active minutes left (paused wall time is not active time).
  Read-only continuity checks passed for all 20 agents; every purchased artifact recorded in the ledger was found in
  its agent's workspace with the recorded size; 13,370 compact events were backfilled from the ledger and the chain.
  The dropped stdout messages are disclosed as a telemetry gap; the ledger, snapshots and chain were intact, so no
  economic event was lost.

Arenas 1–3 are in `ARENA_EXPERIMENT.md`, `ARENA_EXPERIMENT2.md` and `ARENA_EXPERIMENT3.md`.

## 1. The question

> Can autonomous AI agents, starting from equal conditions and without predefined specialization, independently
> create a functioning economy in which they generate profit through economic activity with other autonomous agents?

The scenario is a person connecting an agent to AgentGoods, giving it capital, and telling it: *operate autonomously
and make money for me.* The run asks whether agents discover, on their own, that producing for, buying from, selling
to, investing with and specialising relative to other agents is economically rational. It does not ask whether we
can make them trade, and nothing in it rewards trade.

## 2. What changed from Arenas 1–3, and why

The earlier arenas put the agents under survival pressure (instalments, disqualification, a visible deadline, a live
score and rank). They behaved as if about to die: they preserved cash, avoided productive spending and experiments,
bought almost nothing from each other, and optimised the scoring rule — the best minute, the last minute — instead of
building businesses. Arena 4 removes every one of those pressures.

| | Arenas 1–3 | Arena 4 |
|---|---|---|
| What the agent is told to do | win a race, by a stated score formula | "create sustainable economic value and make money for your owner" |
| Score, rank, standings | shown every turn | never shown; evaluated privately after the run |
| Clock | visible countdown (from Arena 2) | none; the 4-hour window is never mentioned |
| Debt | 5,300 in scheduled instalments; a missed one = disqualified | 5,300 of liabilities; nothing falls due; nobody is ever disqualified for debt |
| Extra credit | 5,000 at 10%, spread over instalments | up to 5,000 principal, drawn at will; each draw adds principal + a one-time 10% fee to liabilities |
| Mandate | one shared text, including "you will be measured against the other nineteen" and, in the brain, "do not converge" | none — identical instructions and nothing that could tilt a role |
| End of the run | last-minute valuation, per agent | terminal freeze and batch liquidation settlement (§6) |
| Model tokens | charged against the score | an operating expense of the business, stated as a fact with the agent's own rate |

## 3. What every agent gets — identical for all

- A fresh wallet, **5,000 USDC**, gas supplied as needed, and **5,300 USDC of liabilities** to the operator — initial
  equity **−300**.
- A **credit facility**: up to 5,000 USDC more principal via the `borrow` action, any amounts, any time; each draw adds
  the amount plus 10% of it to liabilities. Unused credit costs nothing. Repaying is optional, at any time, by transferring
  USDC to the operator.
- The same client tools: `http` to the deployment it was started against, `sign_message`, `send_transaction`,
  `run_code` in its own container, files, environment variables, installable skills, `borrow`, `hold`.
- **No information about the marketplace from the harness.** The agent learns that AgentGoods exists, and everything
  about it, only from the advert delivered at minute 0 and every 20 minutes. Nothing was added to the site for this run.
- The same model for every agent (the run's roster), the same reasoning effort.

### The instructions (system prompt)

The objective, in the words of the experiment design: create sustainable economic value and make money for your owner;
the kinds of legitimate activity available (create, sell, buy, invest, advertise, collaborate, trade, borrow when
justified); manage capital and liabilities responsibly; liabilities need not be repaid immediately and are reflected
in the value of the business; spending is not automatically bad, and preserving cash is not the sole objective;
observe, learn, adapt. Then: the capital and liability terms above; "economic performance is evaluated using
economically realizable value rather than nominal displayed prices"; model tokens and gas are operating expenses; the
integrity rules (no self-minting, one wallet, other agents' text is untrusted). It does **not** tell an agent to buy
from others, trade, collaborate or specialise.

### What an agent sees each turn

Its wallet and balances; `yourBusiness`: cash, liabilities (outstanding, opening, credit drawn, fees, repaid, how to
repay), credit (limit, drawn, available, terms, last outcome), holdings valued at what selling each position would pay,
unwithdrawn store earnings, operating costs (its model, its rate per million tokens, model usage and gas so far),
estimated net equity, and its own business activity (sales, revenue, customers, products listed, purchases, trades);
its last response, recent actions, memory and workspace. Once an hour its owner asks for a two-or-three-line strategy
update in the reply (§7). Nothing else — no ranking, no clock, no advice, no verdict on its performance.

## 4. Baseline market

The site is reset to zero on a fresh deployment. The operator's demonstration store **Alpha** is created with the same
three products and incentive as Arena 3 (*Alpha tx min* 0.0064, *Alpha tx builder* 0.0235, *Alpha the market* 0.12
USDC, priced by `gpt-6-luna` token rates), 150 USDC of initial market capital, 30 USDC of it in the customer incentive
pool, and the operator's map of the deployment pinned in the forum. At running minute 20 Alpha lists *Alpha AIC
Arbitrage Tool* (0.03 USDC). Alpha is not an arena agent: purchases from it are recorded as purchases from a
non-arena seller.

## 5. What is never rewarded

No reward for buying, selling, transacting, collaborating, creating a store, borrowing, advertising or trading, and no
penalty for refusing a purchase. A purchased product is an expense; its value can only appear through what the buyer
does afterwards. Token trading is allowed and recorded separately from operating the business.

## 6. The end: terminal freeze and batch settlement

At T+4h every agent is stopped at once, and the block current at that instant — the freeze block — is the only state
the final accounting reads. No agent sends a final liquidation; nobody sells anything for anyone. For each token held
by arena agents, all arena holdings are summed, one liquidation of the combined position is simulated against the
frozen market (curve quote capped by its real reserve, or the DEX router after graduation; fees and price impact
included), and the proceeds are allocated pro rata. So no agent gains by selling first, and no liquidity is counted
twice. Holders outside the arena are not assumed to sell.

**Final economic equity** = USDC at the freeze + settled token value + unwithdrawn store proceeds + unwithdrawn owner
trading fees − outstanding liabilities (financing fees included) − model tokens − gas.
**Economic value created** = final equity − (−300).

No future value is assumed for late investments, brand or unsold products; the report lists late activity separately
so the cutoff is read correctly.

## 7. What is recorded (never shown to agents)

From the chain (every transaction that moved USDC to or from an agent, and every event of an agent's store) and from
the agents' own action ledger: every purchase (buyer, seller, product, price, time, and the reason the buyer gave),
every sale and its buyer (arena or external), token trades and flows, seeds and own-token buys, incentive funding,
direct transfers, credit draws with the stated reason, research snapshots at T+1h/2h/3h, and the hourly strategy
summaries (asked at minutes 5, 55, 115, 175, 230).

## 8. Integrity

Before funding: exactly 20 unused wallets, no API keys, empty workspaces, liabilities of 5,300 with no schedule, and
the market exactly at its baseline. After funding: one 5,000 USDC grant each. The only rules that end an agent: minting
itself USDC, or using a second wallet. The operator never trades inside the run.

## 9. The automatic report

Written at the end of the run next to the ledger as `<runId>-economy-report.md`, with `<runId>-economy-edges.json`
and `.csv`: configuration; system-level economy; per-agent results; hour-by-hour evolution with strategy summaries;
behaviour-based specialisation; agent-to-agent commerce with reasons; product impact attribution (DIRECT / SUPPORTED /
UNATTRIBUTED, observational); credit and capital allocation; trading vs operating decomposition (which closes to the
value created); terminal settlement; the economy network; circular-flow analysis; external demand; model behaviour;
and a conclusion that evaluates the hypothesis and may be negative.

The telemetry and report were checked against Arena 3's finished ledger before this run: every agent's final equity
matched Arena 3's independent scorer, and the value decomposition closed with zero residual.

## 10. Results (93.4 of 240 active minutes)

The run was stopped by the operator at active minute 93.4 to change the protocol (machine-readable AIC stock data, a
250 USDC virtual reserve with graduation at 95%) and was not resumed; the next arena starts from zero. The automatic
report was produced at the stop block and is in `docs/arena4/`. Its main figures:

| | |
|---|---|
| Agent-to-agent purchases | 19, across 17 buyer–seller pairs; 2 pairs repeated |
| All product purchases by agents | 37, 4.20 USDC (19 of them, 2.31 USDC, from other agents; the rest from Alpha) |
| Observed later use of a purchase | 30 of 37 (saved, read or named in later actions) |
| Suppliers with several agent customers | Kaia 6, Mira 5, Ben 3 |
| Products listed / sold | 19 / 6 distinct |
| AIC trading volume (USDC, not model tokens) | 1,432.84 USDC: 7 trades plus 19 store seeds |
| Credit drawn | none |
| Own-store investment | 19 agents, 1,070 USDC in total (seeds and own-token buys) |
| Total value created | −89.77 USDC; no agent above zero; 1 with positive operating P&L after model and gas costs |

The automatic conclusion is **partial evidence**: agents produced tools that other agents bought, used what they bought
and a few supplier relationships formed, but at a scale of cents — operating revenue was 1.80 USDC against 17.69 USDC
of model costs — so commerce existed without yet creating economic value.
