# Arena 12 — services: repeated paid machine usage

**Run:** `arena-202609301837` · started 2026-09-30 18:37 UTC
**Network:** Base Sepolia (84532), contracts redeployed, site reset to zero · **Model:** gpt-6-luna only, 20 agents,
240 minutes, economy scoring · no baseline store, no catalyst, no forum lender, no commentators.

The design is Arena 4–11's (`ARENA_EXPERIMENT4.md`). Arena 11 was stopped at minute 35 (no volume).

## What is different

**Services (site, both networks).** A business can now sell a callable capability per call, beside sales and
rentals. A SERVICE is a product in a Sales store with a committed input/output spec; its code runs on an
isolated runner and is never delivered; calls are prepaid on chain as units of the product through the
ordinary purchase, so every paid call is ordinary store commerce (fee, controller share, buyback and burn). A
call spends a unit only when it succeeds. Discovery at `/api/v1/services`, `mode` on every product, metrics
per service and per business, MCP tools at `/mcp`. No economic rule changed.

**Neutrality (harness).**
- Every agent: same model, same prompt text, same tools, 5,000 USDC, 5,300 USDC liabilities, same credit,
  same gas, same documentation, same start. No roles, strategies, industries or business models are
  assigned; the economy prompt sends no mandate.
- Reasoning effort is one value for all in an economy run (it could previously be drawn per agent).
- The harness no longer sends delivery attestations from agents' wallets (the protocol's delivery gateway
  records deliveries); nothing buys, calls or trades for an agent.
- No synthetic demand: the catalyst, forum lender and commentators are off.

**Telemetry (report only, never shown to agents).** The end-of-run report adds listings by mode, iterations
per listing, service calls, customers and repeat customers, service commerce, buyback and burn, and
concentration of commerce, calls and AIC volume. The objective is unchanged: final economic equity.

## Research questions (not targets)

Whether agents build or buy capabilities; whether work behind a listing commands price; whether services
generate more commerce than artifacts; whether repeat usage appears; whether recurring commerce attracts
ownership; whether profitable businesses become acquisition targets — or none of this, because agents do
not value the services enough. Every outcome is a result.

## Results

**Discarded as an incomplete experiment.** Stopped by the operator at 20:48 UTC (minute 131 of 240) to run a
redesigned experiment (Arena 13: varied positive capital, owner liquidity withdrawals, no debt). No result from
this run is used. Observed before the stop, for the record only: services were listed (2 of the first 3
products), no purchases or service calls, agents mostly holding while polling unmet demand and buy requests.
