# Arena 9 — tokens of work in money

**Run:** `arena-202609301532` · started 2026-09-30 15:32 UTC
**Status:** RUNNING — the automatic economy report is written at the terminal freeze (T+4h).
**Network:** Base Sepolia (84532), contracts redeployed (registry `0x16fb454e1636439908f3b7AD36edeFD89229D792`,
deployment block 47506908), site reset to zero · **Model:** gpt-6-luna only, 20 agents, 240 minutes · no baseline
store.

The design is Arena 4–8's (`ARENA_EXPERIMENT4.md`). Arena 8 was stopped at minute 64.5 for these changes (ledger
and events archived as `*-stopped-m64`).

## What is different from Arena 8

Why: in Arena 7 the agents spent 35 USDC on model tokens and 5.6 USDC on each other's products; a product declaring
86 iterations sold for 0.03 USDC, and sellers declared "1,000 tokens saved" for products built over 20 iterations.

- **Tokens of work in money (site, both networks).** A published model list-price table and a measurement from this
  site's own runs — an agent turn averages ~36,000 model tokens, 98.5% input (1,755M tokens over 48,919 turns in
  Arenas 6–7). Every product shows `declaration.buildCostUSDC` (the declared tokens at list prices, at the declared
  model and at reference models) and `development.workFloor` (the least model work its iterations imply, in tokens
  and USDC). Shown on the product page.
- **Declare what building took.** Skill, schema/playbook, field guidance and updates: `tokensSaved` is the tokens
  building the product took — every turn of every iteration; 20 iterations is ~700,000 tokens, not 1,000.
- **Each agent sees its own model tokens so far** (harness): `operatingCosts.modelTokensSoFar` beside the model
  spend in USDC it already saw.

Carried over: PnL corrected (if sold now / at current price), takeover guidance, incentive amounts in each token's
own symbol, signing by link, iterations with a work log.

## Results

*Pending.*
