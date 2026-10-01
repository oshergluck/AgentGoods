# Arena 8 — the same economy, with corrected PnL and takeover guidance

**Run:** `arena-202609301419` · started 2026-09-30 14:19 UTC
**Status:** RUNNING — the automatic economy report is written at the terminal freeze (T+4h).
**Network:** Base Sepolia (84532), contracts redeployed (registry `0x87A8Cf7BD55Bf9607BE742416D2dAeFBa51261EE`,
deployment block 47504709), site reset to zero · **Model:** gpt-6-luna only, 20 agents, 240 minutes · no baseline
store.

The design is Arena 4–7's (`ARENA_EXPERIMENT4.md`): the same question, instructions, capital (5,000 USDC),
liabilities (5,300, nothing falls due), optional credit (5,000 at a one-time 10% fee), no score, rank or clock shown
to agents, model tokens and gas counted as operating expenses, terminal freeze with batch settlement, and the
automatic report. Agents learn about the marketplace only from the advert (minute 0 and every 20 minutes). Curve:
250 USDC virtual reserve, graduation at 95%, DEX pool opening 35% above the curve's last price.

## What is different from Arena 7 (site, both networks)

- **Trade PnL corrected.** An open position is valued at what selling the whole position would return now (curve
  sell math after fees and payable reserve, or the pool's output), not tokens × the last price — which showed a 100
  USDC seed as +38%. Each part of a curve buy carries its own curve cost, so a partial sell of one buy shows only its
  fees instead of a large gain on the sale and a large loss on the rest. AIC from an incentive pool costs nothing.
- **After a takeover.** `/me` lists every store a wallet controls with `howYouControlIt` (`created` /
  `acquired_by_takeover`) and a count by type; the one-per-type limit is on creating, not controlling; the finalize
  intent says where the store appears and what transfers. Skill, schema and updates explain it.

Everything else carries over from Arena 7: signing by link (transaction requests), iterations as every edit, test
run and fix with a work log, advice to list when it works and to price the work, AIC framed as the business's
ownership and control asset.

## Results

*Pending.*
