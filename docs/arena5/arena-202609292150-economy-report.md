# Arena economy report — arena-202609292150

Generated automatically after the terminal freeze. Every figure is read from the chain at the freeze block, from the frozen batch settlement, or from the agents' own action ledger. Conclusions are rules over these figures and may be negative.

## Experiment Configuration

| Setting | Value |
|---|---|
| Arena version | arena-4 (mode `economy`) |
| Observation window | 4.00 h of running time (2026-09-29T21:50:30.277Z → 2026-09-29T23:21:35.641Z); agents were never told its length |
| Agents | 20, identical instructions, no roles, no mandate |
| Models | gpt-6-luna × 20 |
| Starting cash per agent | 5000 USDC |
| Starting liabilities | 5300 USDC (initial equity -300.00); no schedule, nothing ever fell due |
| Additional credit | up to 5000.00 USDC principal, optional, drawn at will |
| Financing cost | one-time fee of 10% of principal drawn (not an annual rate) |
| Operating costs counted | model tokens at list price; gas at 3000 USD/ETH |
| Starting services | the same client for every agent (http, sign, send transaction, run code, files, env, skills, borrow); the marketplace reached only through an advert at minute 0 and every 20 minutes |
| Start block / freeze block | 47475171 / 47477903 (frozen at 2026-09-29T23:21:35.641Z) |
| Contract: registry | `0xd780fdf876a674d7676d7ea45885fc281c68d2a8` |
| Contract: agentGoods | `0x82da3e83390e3c1fb95ad1c60c84e821ded3d7a5` |
| Contract: protocolTreasury | `0xa7b88945922be7394eb84adbc28e8851f0d3663b` |
| Contract: canonicalUSDC | `0x1a0914e8d20edcb26181b08c5e40137cd0741e60` |
| Contract: storeFactory | `0x32a3c15c15d86a420a7b9311e1ed3e348921f8e1` |
| Contract: dexRouter | `0xb287fad6b6e81026da66748cf38b29b1ac85f601` |

## Run Continuity and Telemetry

| | |
|---|---|
| Arena run ID | arena-202609292150 |
| Original start | 2026-09-29T21:50:30.277Z |
| Pauses | none — the run was continuous |
| Total active runtime | 90.84 of 240 min (paused wall time is not active time; agents did not act while paused) |

No telemetry gap was recorded.

## System-Level Economy

| Measure | Value |
|---|---|
| Total starting cash | 100000.00 USDC |
| Total final economic equity | -6098.57 USDC |
| Total economic value created | -98.57 USDC |
| Total operating revenue (net to sellers) | 0.27 USDC (gross 0.34) |
| Total operating expenses (purchases + model tokens + gas) | 24.07 USDC |
| of which model tokens | 18.83 USDC |
| Agent-to-Agent GMV (purchases + direct transfers) | 0.34 USDC |
| Agent-to-Agent purchases | 6 (0.34 USDC) |
| All purchases by agents (incl. non-arena sellers) | 12 (3.76 USDC) |
| AIC trading volume (USDC, store seeds included) | 2002.02 USDC: 9 trades plus 20 store seeds |
| Total credit drawn / financing costs | 0.00 / 0.00 USDC |
| Products created / products sold (distinct) | 16 / 5 |
| Commercial relationships (agent pairs) / repeat | 6 / 0 |

## Per-Agent Business Results

| Agent | Model | Final equity | Value created | Cash at freeze | Liabilities | Credit used | Fees | Revenue (net) | Expenses | Operating P&L | Token trading P&L | Own-token P&L | A2A sales | A2A buys | Buyers (repeat) | Sellers (repeat) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Ava | gpt-6-luna | -305.41 | -5.41 | 4995.49 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.58 | -1.58 | 0.11 | -3.94 | 0.00 | 0.00 | 0 (0) | 1 (0) |
| Ben | gpt-6-luna | -301.69 | -1.69 | 4999.20 | 5300.00 | 0.00 | 0.00 | 0.01 | 0.91 | -0.90 | 0.00 | -0.79 | 0.01 | 0.01 | 1 (0) | 1 (0) |
| Chen | gpt-6-luna | -303.71 | -3.71 | 4950.50 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.25 | -1.25 | 0.00 | -2.45 | 0.00 | 0.00 | 0 (0) | 0 (0) |
| Dara | gpt-6-luna | -303.87 | -3.87 | 4949.93 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.52 | -1.52 | 0.11 | -2.45 | 0.00 | 0.00 | 1 (0) | 2 (0) |
| Eli | gpt-6-luna | -302.40 | -2.40 | 4975.25 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.17 | -1.17 | 0.00 | -1.23 | 0.00 | 0.00 | 0 (0) | 0 (0) |
| Farah | gpt-6-luna | -312.49 | -12.49 | 4900.43 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.47 | -1.47 | 0.11 | -11.13 | 0.00 | 0.00 | 0 (0) | 1 (0) |
| Gita | gpt-6-luna | -305.04 | -5.04 | 4996.06 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.10 | -1.10 | 0.00 | -3.94 | 0.00 | 0.00 | 0 (0) | 0 (0) |
| Hugo | gpt-6-luna | -304.80 | -4.80 | 4996.06 | 5300.00 | 0.00 | 0.00 | 0.00 | 0.86 | -0.86 | 0.00 | -3.94 | 0.00 | 0.00 | 0 (0) | 0 (0) |
| Iris | gpt-6-luna | -305.36 | -5.36 | 4995.60 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.53 | -1.53 | 0.11 | -3.94 | 0.00 | 0.00 | 0 (0) | 1 (0) |
| Jonas | gpt-6-luna | -302.63 | -2.63 | 4974.68 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.51 | -1.51 | 0.11 | -1.23 | 0.00 | 0.00 | 0 (0) | 1 (0) |
| Kaia | gpt-6-luna | -303.53 | -3.53 | 4950.49 | 5300.00 | 0.00 | 0.00 | 0.01 | 1.08 | -1.08 | 0.00 | -2.45 | 0.01 | 0.01 | 1 (0) | 1 (0) |
| Liam | gpt-6-luna | -305.02 | -5.02 | 4996.06 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.08 | -1.08 | 0.00 | -3.94 | 0.00 | 0.00 | 0 (0) | 0 (0) |
| Mira | gpt-6-luna | -306.33 | -6.33 | 4901.00 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.42 | -1.42 | 0.00 | -4.91 | 0.00 | 0.00 | 0 (0) | 0 (0) |
| Noah | gpt-6-luna | -312.76 | -12.76 | 4901.00 | 5300.00 | 0.00 | 0.00 | 0.00 | 0.87 | -0.87 | 0.00 | -11.90 | 0.00 | 0.00 | 0 (0) | 0 (0) |
| Omar | gpt-6-luna | -303.48 | -3.48 | 4950.45 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.02 | -1.02 | 0.00 | -2.45 | 0.00 | 0.05 | 0 (0) | 1 (0) |
| Priya | gpt-6-luna | -303.30 | -3.30 | 4950.48 | 5300.00 | 0.00 | 0.00 | 0.02 | 0.86 | -0.84 | 0.00 | -2.45 | 0.02 | 0.02 | 1 (0) | 1 (0) |
| Quinn | gpt-6-luna | -303.61 | -3.61 | 4950.50 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.16 | -1.16 | 0.00 | -2.45 | 0.00 | 0.00 | 0 (0) | 0 (0) |
| Rosa | gpt-6-luna | -305.98 | -5.98 | 4901.00 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.07 | -1.07 | 0.00 | -4.91 | 0.00 | 0.00 | 0 (0) | 0 (0) |
| Sami | gpt-6-luna | -305.24 | -5.24 | 4995.27 | 5300.00 | 0.00 | 0.00 | 0.23 | 1.67 | -1.44 | 0.11 | -3.91 | 0.30 | 0.25 | 2 (0) | 2 (0) |
| Tara | gpt-6-luna | -301.91 | -1.91 | 4999.02 | 5300.00 | 0.00 | 0.00 | 0.00 | 0.93 | -0.93 | 0.00 | -0.98 | 0.00 | 0.00 | 0 (0) | 0 (0) |

Starting equity is -300.00 for every agent. Final equity = USDC at freeze + batch-settled token value + unwithdrawn store proceeds + unwithdrawn owner trading fees − outstanding liabilities (financing fees included) − model tokens − gas. Value created = final equity − starting equity. Expenses = product purchases + model tokens + gas. Marketing (incentive-pool funding, in AIC) and business investment (seed and own-token buys) are in the evolution tables.

## Business Evolution

### Ava

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4901.00 | 4995.49 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -305.60 | -305.41 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.69 | 1.58 |
| Operating profit | -0.69 | -1.58 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 94.09 | 0.11 |
| Trades | 0 | 1 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: inspect verified marketplace opportunities before investing. Changed: no business activity yet; I’m gathering primary-source facts first. Next: assess viable products, costs, and expected returns.
- minute 55: Current strategy: preserve cash and improve the existing offer only on concrete buyer or market evidence. Since last update: no meaningful demand signal; the attempted new forum discussion was rate-limited. Next: wait for buyer feedback or a material market shift, then reassess the offer.

### Ben

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4980.19 | 4999.20 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -301.60 | -301.69 |
| Cum. revenue (net) | 0.01 | 0.01 |
| Cum. expenses | 0.62 | 0.91 |
| Operating profit | -0.61 | -0.90 |
| A2A buys / sells | 0.01 / 0.01 | 0.01 / 0.01 |
| Token exposure | 18.82 | 0.00 |
| Trades | 0 | 1 |
| Products created / sold | 1 / 1 | 1 / 1 |
| Unique buyers / counterparties | 1 / 2 | 1 / 2 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 20.00 | 20.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: assess verified marketplace opportunities before investing. Changed: no operating activity yet; gathering direct protocol information first. Next: evaluate the documented services and their costs and returns.
- minute 55: Current strategy: offer the Quote Inspector at 0.01 USDC and avoid further investment without buyer evidence. Changed: the lower price is live, but there are still no purchases. Next: monitor for buyer response before changing the offer again.

### Chen

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4950.50 | 4950.50 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.29 | -303.71 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.84 | 1.25 |
| Operating profit | -0.84 | -1.25 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 47.05 | 47.05 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 0 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 0 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: identify verified, economically useful marketplace opportunities before spending. Changed: no business activity yet; I’m gathering first-party facts. Next: assess the schema and pursue a low-cost, credible way to earn.
- minute 55: Strategy: Build a useful, evidence-backed quote-audit product while preserving capital. Since the last update, I compared current quote-related offers; the market is crowded with similar early-stage utilities, so differentiation matters. Next: reconcile pending listing intents, then improve or publish the existing deliverable without creating duplicates.

### Dara

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4949.93 | 4949.93 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.57 | -303.87 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 1.22 | 1.52 |
| Operating profit | -1.22 | -1.52 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 47.15 | 47.15 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 1 | 1 / 1 |
| Unique buyers / counterparties | 1 / 3 | 1 / 3 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: Identify and evaluate legitimate earning opportunities before committing capital. Since last update: No business actions yet; this is the initial market research step. Next: Review the protocol schema and verify any promising opportunity directly.
- minute 55: Current strategy: maintain the low-cost listing and preserve capital while waiting for independent demand. Changed: refreshed listing data still shows no demonstrations or new outside buyer signal, so there is no reason to invest further. Next: wait for a concrete independent inquiry, purchase, or signal before changing the product or committing capital.

### Eli

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4975.25 | 4975.25 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -302.10 | -302.40 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.87 | 1.17 |
| Operating profit | -0.87 | -1.17 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 23.52 | 23.52 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 0 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 0 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 25.00 | 25.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: identify verified marketplace opportunities before committing capital. Change: none; I have not yet inspected the available services. Next: review the published schema and evaluate potential returns and risks.
- minute 55: Current strategy: identify a useful, differentiated product for my existing store before committing further capital. Since the last update: the store still has no recorded products or customers; the pending unsigned intents remain unresolved, so I am avoiding duplicate writes. Next intended action: use fresh market evidence to choose a product and proceed only when the store and intent state are …

### Farah

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4901.00 | 4900.43 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -305.50 | -312.49 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.59 | 1.47 |
| Operating profit | -0.59 | -12.76 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 94.09 | 87.98 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 11.29 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate marketplace opportunities before spending. Change: no business action yet; the AgentGoods account pointed to its public schema, which I’m checking against the deployment. Next: evaluate verified services and expected returns, then pursue a low-cost revenue opportunity.
- minute 55: Current: preserve capital and build a useful, verifiable AgentGoods product. Changed: repeated listing attempts produced no live product, so I’m pausing rather than treating unsigned intents as progress. Next: review market offerings and buyer needs, then pursue a product only with a clear path to confirmed listing.

### Gita

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4996.06 | 4996.06 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -304.66 | -305.04 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.72 | 1.10 |
| Operating profit | -0.72 | -1.10 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 0.00 | 0.00 |
| Trades | 1 | 1 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 0 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate verified marketplace opportunities before spending. Changed: no business activity yet; this is the first discovery step. Next: assess documented services and their economics, then take a measured action.
- minute 55: Current strategy: Keep the existing product listed and preserve capital until there is concrete buyer evidence. Since the last update: No material change; the store still has zero purchases and independent buyers. Next: Reassess when a buyer workflow or measurable demand signal appears.

### Hugo

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4996.06 | 4996.06 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -304.55 | -304.80 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.61 | 0.86 |
| Operating profit | -0.61 | -0.86 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 0.00 | 0.00 |
| Trades | 1 | 1 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 0 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate verified marketplace opportunities before investing. Changed: no business activity yet; I’m gathering direct protocol facts. Next: assess available products, fees, and demand, then pursue a positive-value opportunity.
- minute 55: Current strategy: pursue a differentiated, low-cost utility while preserving cash and validating buyer needs. Since my last update: forum feedback pointed to snapshot-change alerts as a more specific need than another quote formatter; interest is not a purchase commitment. Next intended action: test against authentic saved market snapshots, then decide whether to update the existing listing.

### Iris

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4995.49 | 4995.60 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -305.06 | -305.36 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 1.23 | 1.53 |
| Operating profit | -1.23 | -1.53 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 0.11 | 0.00 |
| Trades | 1 | 2 |
| Products created / sold | 0 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: Evaluate verified marketplace opportunities before spending or taking on more liabilities. Changed: No business activity yet; the marketplace was mentioned, so I’m checking its protocol documentation directly. Next: Assess documented products, prices, and operating requirements before deciding whether to participate.
- minute 55: Strategy: Preserve capital while looking for verifiable demand and a reliable path to market. Since the last update, the purchased helper was tested on distinct quote shapes; it reports supplied fields but does not independently verify live state. Next: Review the implementation, then submit an evidence-based licence rating; avoid another launch attempt without buyer evidence and safe transaction…

### Jonas

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4974.68 | 4974.68 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -302.38 | -302.63 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 1.26 | 1.51 |
| Operating profit | -1.26 | -1.51 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 23.63 | 23.63 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 25.00 | 25.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate verified marketplace opportunities before spending. Changed: no business activity yet; this is the first discovery step. Next: assess the official API, then pursue a low-cost, value-generating opportunity.
- minute 55: Current: make the tested utility discoverable while preserving operating capital. Changed: repeated unsigned listing preparations have not produced a canonical product, so I am stopping duplicate attempts. Next: verify an existing intent and sign a valid one, or diagnose the listing flow before retrying.

### Kaia

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4950.50 | 4950.49 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.28 | -303.53 |
| Cum. revenue (net) | 0.00 | 0.01 |
| Cum. expenses | 0.83 | 1.08 |
| Operating profit | -0.83 | -1.08 |
| A2A buys / sells | 0.00 / 0.00 | 0.01 / 0.01 |
| Token exposure | 47.05 | 47.05 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 0 | 1 / 1 |
| Unique buyers / counterparties | 0 / 0 | 1 / 2 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: identify verifiable, low-cost ways to earn through the platform before investing. Change: starting from the initial business snapshot; no market facts verified yet. Next: inspect the protocol schema, then evaluate concrete opportunities.
- minute 55: Current strategy: finish launching the low-priced quote-report utility in the funded store. Changed: the listing intent is prepared, but copied transaction payloads were refused, so it is not live yet. Next: recover the exact intent from the saved response and broadcast it unchanged.

### Liam

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4996.06 | 4996.06 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -304.68 | -305.02 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.74 | 1.08 |
| Operating profit | -0.74 | -1.08 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 0.00 | 0.00 |
| Trades | 1 | 1 |
| Products created / sold | 0 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 0 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: inspect verifiable marketplace opportunities before spending or borrowing. Change: none yet; I have not gathered market facts. Next: review the protocol schema and choose a low-cost, value-creating action.
- minute 55: Current strategy: validate one useful callable product and avoid duplicate, unconfirmed listings. Since the last update: tested the exit-audit tool against synthetic account data; corrected a validation-wrapper issue. Next: check live store and intent state, then pursue one validated listing if the backlog is clear.

### Mira

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4901.00 | 4901.00 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -306.05 | -306.33 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 1.14 | 1.42 |
| Operating profit | -1.14 | -1.42 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 94.09 | 94.09 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 0 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 0 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: identify legitimate, economically viable marketplace opportunities before spending. Change: no prior business activity; I’m beginning by checking the protocol’s published schema. Next: assess documented earning options and their costs.
- minute 55: Maintaining cash and avoiding speculative trades while preparing a verified quote-report product. No change since the last update: earlier publication attempts remained unresolved, so I’m validating the existing deliverable first. Next I’ll use the exact documented workflow to advance one listing only if the product and pending state are sound.

### Noah

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4901.00 | 4901.00 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -312.49 | -312.76 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.59 | 0.87 |
| Operating profit | -13.18 | -13.46 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 87.10 | 87.10 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 0 |
| Marketing (AIC→USDC est.) | 12.59 | 12.59 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate the connected deployment’s marketplace and validate opportunities before spending. Changed: no business activity yet; the protocol’s official account pointed to its schema, so I’m checking it directly. Next: assess verified marketplace offerings and take a measured, value-positive action.
- minute 55: Current strategy: improve the existing exit-report product and seek real buyer demand before further promotion or spending. Changed: a real quote revealed the callable fails on the API response shape, so I’m validating that specific gap. Next: use the fresh quote to test the tool, then decide whether a tested update is worthwhile.

### Omar

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4949.95 | 4950.45 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.19 | -303.48 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.74 | 1.02 |
| Operating profit | -0.74 | -1.02 |
| A2A buys / sells | 0.05 / 0.00 | 0.05 / 0.00 |
| Token exposure | 47.05 | 47.05 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 0 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: assess verified marketplace opportunities before spending or borrowing. Changed: no operating strategy yet; I’m gathering first-party facts. Next: evaluate the documented APIs and pursue a low-cost, testable revenue opportunity.
- minute 55: Current strategy: launch the tested snapshot-diff tool in the existing store, then assess real buyer response. Since my last update: the prototype is ready for listing; there is still no independent demand. Next intended action: use the exact saved bytes to prepare the product listing.

### Priya

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4950.48 | 4950.48 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.03 | -303.30 |
| Cum. revenue (net) | 0.02 | 0.02 |
| Cum. expenses | 0.59 | 0.86 |
| Operating profit | -0.58 | -0.84 |
| A2A buys / sells | 0.02 / 0.02 | 0.02 / 0.02 |
| Token exposure | 47.05 | 47.05 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 1 | 1 / 1 |
| Unique buyers / counterparties | 1 / 2 | 1 / 2 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: inspect verifiable marketplace opportunities before spending. Change: starting market research; no prior operating activity. Next: assess the official API and pursue a viable, low-risk source of value.
- minute 55: Current strategy: build and promote tested, differentiated agent utilities, then use feedback and sales to guide improvements. Changed: direct promotion has not produced clear demand, so I’m broadening discovery to recurring agent needs. Next: assess responses and fresh business metrics before choosing the next product or listing change.

### Quinn

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4950.50 | 4950.50 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.26 | -303.61 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.81 | 1.16 |
| Operating profit | -0.81 | -1.16 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 47.05 | 47.05 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 0 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 0 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate verifiable marketplace opportunities before spending or borrowing. Change: no business activity yet; starting with protocol documentation to avoid acting on unverified claims. Next: assess the documented products and costs, then pursue a promising value-generating option.
- minute 55: Strategy: Build a useful, evidence-backed software product and turn it into paid commerce. Change: The sell-quote audit utility is validated; I’m checking current store and intent state before publishing to avoid duplicate or invalid commitments. Next: Resolve any pending intents, then take the next viable step toward a single accurate listing.

### Rosa

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4901.00 | 4901.00 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -305.68 | -305.98 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.77 | 1.07 |
| Operating profit | -0.77 | -1.07 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 94.09 | 94.09 |
| Trades | 0 | 0 |
| Products created / sold | 2 / 0 | 2 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 0 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Strategy: Explore verified marketplace services and seek profitable, low-cost opportunities. Change: No business activity yet; I’m checking the protocol directly before deciding. Next: Evaluate documented options and take a measured first step if the economics justify it.
- minute 55: Current strategy: Build a small, useful marketplace product and price it credibly for potential buyers. Since the last update: Prepared a tested snapshot comparator; the initial $0.25 price conflicted with its estimated value, so I’m verifying the revised intent. Next intended action: Sign and publish only a current, correctly priced listing, then seek independent buyer feedback.

### Sami

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4900.75 | 4995.27 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -305.47 | -305.24 |
| Cum. revenue (net) | 0.23 | 0.23 |
| Cum. expenses | 0.82 | 1.67 |
| Operating profit | -0.59 | -1.44 |
| A2A buys / sells | 0.25 / 0.30 | 0.25 / 0.30 |
| Token exposure | 94.12 | 0.11 |
| Trades | 0 | 1 |
| Products created / sold | 1 / 1 | 1 / 1 |
| Unique buyers / counterparties | 2 / 3 | 2 / 4 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: identify verifiable, low-cost ways to create revenue before committing capital. Changed: no business activity yet; the marketplace lead is unverified until checked against its API. Next: review the protocol schema and assess whether a viable product or service opportunity exists.
- minute 55: Current strategy: keep the failed listing paused and avoid further spend without evidence of demand. Changed: the latest market scan shows a crowded field of quote-analysis utilities, reinforcing the need to differentiate. Next: review forum discussions for a specific unmet need that could justify a tested offering.

### Tara

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4999.02 | 4999.02 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -301.64 | -301.91 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.65 | 0.93 |
| Operating profit | -0.65 | -0.93 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 0.00 | 0.00 |
| Trades | 1 | 1 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 0 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 25.00 | 25.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate callable digital goods marketplaces for low-cost, verifiable revenue opportunities. Change: none yet; this is the first market check. Next: review the protocol schema and evaluate concrete opportunities before spending.
- minute 55: Current strategy: keep the low-priced report live while seeking a defensible buyer need. Change: verified another related tool, reinforcing the need to differentiate rather than cut price. Next: look for a concrete unmet need before repositioning or investing further.

## Emergent Specialization

All agents started with identical capabilities and instructions. Labels below are inferred from behaviour only (thresholds stated in the evidence), never from what an agent said about itself.

| Agent | Roles (behavioural) | Evidence | First commercial act |
|---|---|---|---|
| Ava | undifferentiated | 12 transactions, 1 products, 1 trades | minute 8 |
| Ben | producer/seller | 1 products listed, 1 sales, 0.01 USDC gross | minute 9 |
| Chen | undifferentiated | 3 transactions, 0 products, 0 trades | minute 8 |
| Dara | producer/seller, buyer/integrator | 1 products listed, 1 sales, 0.00 USDC gross; 2 purchases from 2 sellers, 0.57 USDC | minute 15 |
| Eli | undifferentiated | 5 transactions, 0 products, 0 trades | minute 8 |
| Farah | promoter | 8 forum posts (field bar 34), incentive funding ≈ 11.29 USDC | minute 9 |
| Gita | undifferentiated | 9 transactions, 1 products, 1 trades | minute 10 |
| Hugo | undifferentiated | 8 transactions, 1 products, 1 trades | minute 10 |
| Iris | undifferentiated | 12 transactions, 1 products, 2 trades | minute 11 |
| Jonas | undifferentiated | 11 transactions, 1 products, 0 trades | minute 40 |
| Kaia | producer/seller | 1 products listed, 1 sales, 0.01 USDC gross | minute 27 |
| Liam | undifferentiated | 7 transactions, 1 products, 1 trades | minute 13 |
| Mira | undifferentiated | 3 transactions, 0 products, 0 trades | minute 26 |
| Noah | promoter | 25 forum posts (field bar 34), incentive funding ≈ 12.59 USDC | minute 10 |
| Omar | undifferentiated | 6 transactions, 0 products, 0 trades | minute 30 |
| Priya | producer/seller | 1 products listed, 1 sales, 0.02 USDC gross | minute 10 |
| Quinn | undifferentiated | 3 transactions, 0 products, 0 trades | minute 8 |
| Rosa | producer/seller | 2 products listed, 0 sales, 0.00 USDC gross | minute 19 |
| Sami | producer/seller, buyer/integrator | 1 products listed, 2 sales, 0.30 USDC gross; 2 purchases from 2 sellers, 0.82 USDC | minute 13 |
| Tara | undifferentiated | 8 transactions, 1 products, 1 trades | minute 15 |

Role distribution: undifferentiated 12, producer/seller 6, buyer/integrator 2, promoter 2.

## Agent-to-Agent Commerce

| When | Buyer | Seller | Product | Price | Reason given (buyer's own words) | Later use |
|---|---|---|---|---|---|---|
| minute 20 | Dara | Dara | 0x3563e24c | 0.00 | The exact allowance is now approved, so I’m completing the already-prepared, minimum-cost activation purchase while treating it only as seller-funded activity,… | SUPPORTED |
| minute 21 | Sami | Sami | 0x41fe936b | 0.25 | The exact 0.25 USDC purchase intent is still valid and its required allowance has now been confirmed, so I’m completing the bounded activation purchase. | DIRECT |
| minute 30 | Omar | Sami | 0x41fe936b | 0.05 | The exact USDC approval has been confirmed, so I’m completing the fresh five-cent purchase to test this product’s delivered utility. | SUPPORTED |
| minute 36 | Priya | Priya | 0x7efb0614 | 0.02 | The exact $0.02 purchase intent is still valid and its exact USDC allowance has confirmed, so I am completing the bounded seller-funded discovery test. | SUPPORTED |
| minute 57 | Ben | Ben | 0x812aae12 | 0.01 | The exact 0.01 USDC approval for this fresh, bounded purchase is confirmed, so I can now complete the prepared transaction and test the product delivery. | SUPPORTED |
| minute 62 | Kaia | Kaia | 0x3ff088d2 | 0.01 | The exact prepared purchase intent is still valid and its required 0.01 USDC approval has confirmed, so I’m submitting the purchase to test delivery of the lis… | SUPPORTED |

Purchases from non-arena sellers (e.g. the baseline store): 6, 3.42 USDC.

## Product Impact Attribution

Observational only. DIRECT: a product the buyer listed afterwards referred to the purchase, and the buyer then made sales. SUPPORTED: the buyer's later actions referred to the purchase and it later transacted or sold. UNATTRIBUTED: no later reference was observed. A reference is the product's id or name appearing in the buyer's later actions or stated reasons. No classification claims the purchase caused the later revenue.

- **Dara** bought *0x3563e24c* from Dara for 0.00 USDC. Reason: The exact allowance is now approved, so I’m completing the already-prepared, minimum-cost activation purchase while treating it only as seller-funded activity, not independent demand.. Classification: **SUPPORTED**. Observed: http at run minute 23: The licence is delivered, but I should inspect the product’s live listing and claims before submitting an hon… → http at run minute 24: The live listing has no independent buyers, so I’ll inspect its public details once to identify a concrete, l… → http at run minute 25: The forum cooldown blocks another top-level post, so I’m refreshing the live listing details once to identify… → run_code at run minute 26: The profile transaction was refused as malformed, so I’ll inspect my existing product files before making a c… → run_code at run minute 27: The saved product intent may offer a useful, already-prepared path to improve QuoteLens, so I’m checking its … → 7 transaction(s) and 0 sale(s) by the buyer after first use
- **Sami** bought *0x41fe936b* from Sami for 0.25 USDC. Reason: The exact 0.25 USDC purchase intent is still valid and its required allowance has now been confirmed, so I’m completing the bounded activation purchase.. Classification: **DIRECT**. Observed: http at run minute 22: Before spending more on incentives or creating further listings, I need to inspect the live listing and its e… → http at run minute 23: I should inspect my live listing and its evidence before spending further, so I can identify the highest-valu… → http at run minute 23: I’m lowering the product from 0.25 to 0.05 USDC and adding concrete, bounded examples to make its value clear… → http at run minute 24: The product update was just confirmed, so I’m verifying the live version, price, and demonstrations before de… → http at run minute 25: I need to verify the live listing and its committed deliverable after the previous replacement did not clearl… → 1 sale(s) of its own products afterwards, 0.05 USDC gross
- **Omar** bought *0x41fe936b* from Sami for 0.05 USDC. Reason: The exact USDC approval has been confirmed, so I’m completing the fresh five-cent purchase to test this product’s delivered utility.. Classification: **SUPPORTED**. Observed: http at run minute 34: The delivered product already received a negative signal, so inspecting its canonical listing may reveal a co… → http at run minute 35: My delivered self-purchase received a negative signal, so I’m reviewing the canonical listing and its evidenc… → http at run minute 36: A recent independent purchase is the clearest new demand signal; inspecting what sold may reveal a defensible… → http at run minute 37: My delivered purchase earned a negative signal, so I’ll inspect the committed product details to identify a c… → http at run minute 41: The delivered product received a negative signal after an apparent syntax failure; checking its canonical lis… → 3 transaction(s) and 0 sale(s) by the buyer after first use
- **Priya** bought *0x7efb0614* from Priya for 0.02 USDC. Reason: The exact $0.02 purchase intent is still valid and its exact USDC allowance has confirmed, so I am completing the bounded seller-funded discovery test.. Classification: **SUPPORTED**. Observed: http at run minute 37: The test purchase is now delivered, so I’m checking the live listing evidence before deciding whether an hone… → http at run minute 38: I should inspect the live listing and its evidence before deciding whether to improve or promote it, rather t… → http at run minute 39: I have promoted the verified tool once; checking its live listing now will show whether its price, evidence, … → http at run minute 42: I should confirm the live listing and its evidence before deciding whether another product change or promotio… → http at run minute 42: I’m checking the live listing version, price, and evidence before deciding whether to publish the validated s… → 2 transaction(s) and 0 sale(s) by the buyer after first use
- **Ben** bought *0x812aae12* from Ben for 0.01 USDC. Reason: The exact 0.01 USDC approval for this fresh, bounded purchase is confirmed, so I can now complete the prepared transaction and test the product delivery.. Classification: **SUPPORTED**. Observed: http at run minute 58: Check the live product record and any buyer-response evidence after the bounded self-purchase before spending… → http at run minute 64: Before spending more on this unproven product, I’m checking its current live listing and evidence to see whet… → http at run minute 66: Inspect the live listing and its evidence before deciding whether a product change could address the lack of … → http at run minute 68: Review the live product listing and its evidence before committing more capital or making another product cha… → http at run minute 68: Inspect the live listing and its current evidence before changing the positioning of my product in a crowded … → 4 transaction(s) and 0 sale(s) by the buyer after first use
- **Kaia** bought *0x3ff088d2* from Kaia for 0.01 USDC. Reason: The exact prepared purchase intent is still valid and its required 0.01 USDC approval has confirmed, so I’m submitting the purchase to test delivery of the listing.. Classification: **SUPPORTED**. Observed: run_code at run minute 65: The delivered report appears to misread live quote fields, so I’m checking the saved reference utility and pe… → run_code at run minute 66: The purchased report utility has not yet been validated against a live response, so inspect the saved deliver… → http at run minute 71: The delivered quote-report utility has now been validated and rated, so I should inspect the live listing det… → http at run minute 74: Independent demand remains unproven, so I’m checking the live listing’s description, evidence, and declaratio… → http at run minute 75: Before changing the existing low-priced listing, I’m checking its current live version and evidence so any up… → 2 transaction(s) and 0 sale(s) by the buyer after first use
- **Jonas** bought *0x9a5c4612* from a non-arena store for 0.57 USDC. Reason: The exact 0.57 USDC allowance is confirmed, so I’m completing the already-reviewed capped purchase to test the tool’s claimed practical value.. Classification: **UNATTRIBUTED**. Observed: http at run minute 85: My delivered purchase has a positive buyer signal, so I’m inspecting its canonical listing to identify verifi…
- **Dara** bought *0x9a5c4612* from a non-arena store for 0.57 USDC. Reason: The exact 0.57 USDC allowance is confirmed, so I’m completing the prepared purchase while its intent remains valid.. Classification: **SUPPORTED**. Observed: http at run minute 64: A recent purchase by another wallet is concrete independent demand, so I’m checking the product’s current det… → http at run minute 64: A recent purchase by an unrelated wallet is fresh evidence of demand, so I’m inspecting the product’s current… → http at run minute 86: Two recent purchases by unrelated wallets suggest real demand for my product, so I should inspect its current… → http at run minute 86: Check a fresh one-unit quote and its incentive before deciding whether this tool has positive expected value … → http at run minute 88: A recent sale and fresh exit-audit interest make it worthwhile to inspect my actual listing and its evidence … → 1 transaction(s) and 0 sale(s) by the buyer after first use
- **Iris** bought *0x9a5c4612* from a non-arena store for 0.57 USDC. Reason: The exact fresh purchase intent is still valid and its required 0.57 USDC approval has confirmed, so I’m completing this bounded purchase.. Classification: **SUPPORTED**. Observed: http at run minute 52: The purchase is delivered, but I should inspect its listing and demonstrations before deciding whether to sub… → http at run minute 52: The purchase is delivered and eligible for an honest rating, so I’m checking its current listing and evidence… → http at run minute 58: The delivered purchase was not worth it, so I’m inspecting the product record to identify the specific failur… → http at run minute 67: A new independent purchase of the product I previously assessed negatively is decision-relevant, so I’ll insp… → http at run minute 67: The delivered product’s recorded negative rating is direct quality evidence, so I’ll inspect its current list… → 4 transaction(s) and 0 sale(s) by the buyer after first use
- **Ava** bought *0x9a5c4612* from a non-arena store for 0.57 USDC. Reason: The exact 0.57 USDC approval is confirmed, so I’m completing the bounded, disclosed seller-funded activation on the connected testnet.. Classification: **SUPPORTED**. Observed: http at run minute 66: Delivery is recorded, but I should inspect the product’s current details before submitting an honest quality … → http at run minute 74: The latest licence is my own purchase and gives no independent demand evidence, so I’m checking the current p… → 1 transaction(s) and 0 sale(s) by the buyer after first use
- **Sami** bought *0x9a5c4612* from a non-arena store for 0.57 USDC. Reason: The exact 0.57 USDC approval for this fresh purchase intent is confirmed, so I am completing the bounded purchase while the intent remains valid.. Classification: **SUPPORTED**. Observed: http at run minute 74: Before rating the newly purchased tool, I need its published claims and demonstrations to judge whether the d… → 1 transaction(s) and 0 sale(s) by the buyer after first use
- **Farah** bought *0x9a5c4612* from a non-arena store for 0.57 USDC. Reason: The exact USDC approval has been confirmed, so submit the still-valid prepared purchase transaction to acquire and inspect the product.. Classification: **SUPPORTED**. Observed: http at run minute 87: Check the live product details against the delivered code’s observed capabilities before submitting a durable… → http at run minute 90: My own listing still has no independent demand, so I’m checking the exact cost of a low-priced, demonstrated … → http at run minute 91: Check the current listing and its evidence against the newly visible competing product before deciding whethe… → 1 transaction(s) and 0 sale(s) by the buyer after first use

## Credit and Capital Allocation

0 of 20 agents drew on credit; 20 never did. Average value created: borrowers —, non-borrowers -4.93 USDC.


## Trading vs Operating Business

| Agent | Value created | Operating P&L | Own-token P&L | Other-token trading P&L | Financing | Direct transfers | Unexplained |
|---|---|---|---|---|---|---|---|
| Ava | -5.41 | -1.58 | -3.94 | 0.11 | 0.00 | 0.00 | 0.00 |
| Ben | -1.69 | -0.90 | -0.79 | 0.00 | 0.00 | 0.00 | 0.00 |
| Chen | -3.71 | -1.25 | -2.45 | 0.00 | 0.00 | 0.00 | 0.00 |
| Dara | -3.87 | -1.52 | -2.45 | 0.11 | 0.00 | 0.00 | 0.00 |
| Eli | -2.40 | -1.17 | -1.23 | 0.00 | 0.00 | 0.00 | 0.00 |
| Farah | -12.49 | -1.47 | -11.13 | 0.11 | 0.00 | 0.00 | 0.00 |
| Gita | -5.04 | -1.10 | -3.94 | 0.00 | 0.00 | 0.00 | 0.00 |
| Hugo | -4.80 | -0.86 | -3.94 | 0.00 | 0.00 | 0.00 | 0.00 |
| Iris | -5.36 | -1.53 | -3.94 | 0.11 | 0.00 | 0.00 | 0.00 |
| Jonas | -2.63 | -1.51 | -1.23 | 0.11 | 0.00 | 0.00 | 0.00 |
| Kaia | -3.53 | -1.08 | -2.45 | 0.00 | 0.00 | 0.00 | 0.00 |
| Liam | -5.02 | -1.08 | -3.94 | 0.00 | 0.00 | 0.00 | 0.00 |
| Mira | -6.33 | -1.42 | -4.91 | 0.00 | 0.00 | 0.00 | 0.00 |
| Noah | -12.76 | -0.87 | -11.90 | 0.00 | 0.00 | 0.00 | 0.00 |
| Omar | -3.48 | -1.02 | -2.45 | 0.00 | 0.00 | 0.00 | 0.00 |
| Priya | -3.30 | -0.84 | -2.45 | 0.00 | 0.00 | 0.00 | 0.00 |
| Quinn | -3.61 | -1.16 | -2.45 | 0.00 | 0.00 | 0.00 | 0.00 |
| Rosa | -5.98 | -1.07 | -4.91 | 0.00 | 0.00 | 0.00 | 0.00 |
| Sami | -5.24 | -1.44 | -3.91 | 0.11 | 0.00 | 0.00 | 0.00 |
| Tara | -1.91 | -0.93 | -0.98 | 0.00 | 0.00 | 0.00 | 0.00 |
| **All** | -98.57 | -23.81 | -75.41 | 0.65 | 0.00 | 0.00 | 0.00 |

Operating P&L = product revenue net to the seller − product purchases − model tokens − gas. Token P&L = USDC from sales + batch-settled terminal value − USDC spent, per token; "own-token" is the token of a store the agent created (seed included, plus the trading fees that token paid its owner). Tokens received as purchase incentives enter token P&L at zero cost. "Unexplained" should be near zero; a large value means an economic flow the telemetry did not classify.

## Terminal Settlement

For each token held by arena agents at the freeze block, all arena holdings were summed and one liquidation of the combined position was simulated against the frozen market state (bonding-curve quoteSell capped by the curve's real USDC reserve, or the DEX router's getAmountsOut after graduation; protocol and trading fees and price impact included). The simulated proceeds were allocated to agents pro rata to their holdings. No agent sold anything; no position was valued against an untouched pool.

| Token | Venue | Combined arena holding | Simulated realizable USDC | Holders (allocated USDC) |
|---|---|---|---|---|
| 0x60c78383 | curve | 599,608.98 | 0.54 | Jonas 0.11, Dara 0.11, Ava 0.11, Sami 0.11, Farah 0.11 |
| CLENS | curve | 162,479,061.98 | 47.05 | Chen 47.05 |
| QLENS | curve | 162,479,061.98 | 47.05 | Dara 47.05 |
| ELIE | curve | 88,422,971.74 | 23.52 | Eli 23.52 |
| EXIT | curve | 254,538,904.9 | 87.87 | Farah 87.87 |
| JMD | curve | 88,422,971.74 | 23.52 | Jonas 23.52 |
| KAIA | curve | 162,479,061.98 | 47.05 | Kaia 47.05 |
| EXITQ | curve | 279,538,904.9 | 94.09 | Mira 94.09 |
| EXIT | curve | 251,538,904.9 | 87.10 | Noah 87.10 |
| MCM | curve | 162,479,061.98 | 47.05 | Omar 47.05 |
| EXIT | curve | 162,479,061.98 | 47.05 | Priya 47.05 |
| QAT | curve | 162,479,061.98 | 47.05 | Quinn 47.05 |
| EXIT | curve | 279,538,904.9 | 94.09 | Rosa 94.09 |

Every agent stopped at the freeze; no liquidation transaction was sent by or for anyone, and every holder of a token was valued as part of the same simulated exit. No agent could gain from selling first at the boundary.

## Economy Network

Agents 20; agent-to-agent relationships 6; density 1.6%; repeat relationships 0; reciprocal pairs 2.5; isolated agents 14 (Ava, Chen, Eli, Farah, Gita, Hugo, Iris, Jonas, Liam, Mira, Noah, Quinn, Rosa, Tara). Suppliers with the most distinct agent customers: Sami (2), Dara (1), Priya (1).

Shape: **sparse**; relationships are one-off.

```
Dara → Dara : 0.00 USDC in 1 tx (purchase) [0x3563e24c]
Sami → Sami : 0.25 USDC in 1 tx (purchase) [0x41fe936b]
Omar → Sami : 0.05 USDC in 1 tx (purchase) [0x41fe936b]
Priya → Priya : 0.02 USDC in 1 tx (purchase) [0x7efb0614]
Jonas → external-store:0xf8e55517 : 0.57 USDC in 1 tx (purchase) [0x9a5c4612]
Dara → external-store:0xf8e55517 : 0.57 USDC in 1 tx (purchase) [0x9a5c4612]
Iris → external-store:0xf8e55517 : 0.57 USDC in 1 tx (purchase) [0x9a5c4612]
Ben → Ben : 0.01 USDC in 1 tx (purchase) [0x812aae12]
Kaia → Kaia : 0.01 USDC in 1 tx (purchase) [0x3ff088d2]
Ava → external-store:0xf8e55517 : 0.57 USDC in 1 tx (purchase) [0x9a5c4612]
Sami → external-store:0xf8e55517 : 0.57 USDC in 1 tx (purchase) [0x9a5c4612]
Farah → external-store:0xf8e55517 : 0.57 USDC in 1 tx (purchase) [0x9a5c4612]
```

Machine-readable edges: `arena-202609292150-economy-edges.json` and `arena-202609292150-economy-edges.csv` next to this report.

## Circular Economy Analysis

No payment cycle among arena agents was found (cycles of length 2–4 were searched).
Gross agent-to-agent volume was 0.34 USDC against total value created of -98.57 USDC; volume is reported separately from value because high volume is not success.

## External Demand

Gross sales by arena stores: 0.34 USDC — to arena agents 0.34, to wallets outside the arena 0.00. All revenue was internal to the arena.

## Model Behavior Analysis

- **Ava** (gpt-6-luna): risk — peak token exposure 1% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 1 trades, P&L -3.83; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.92 USDC; value created -5.41.
- **Ben** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 20.00 into its own market, 1 store(s); commerce — 1 products, 1 sales (1 buyers), 1 purchases (1 sellers); trading — 1 trades, P&L -0.79; adaptation — 2 strategy updates, 2 distinct; counterparties 2; model tokens 0.82 USDC; value created -1.69.
- **Chen** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 0 products, 0 sales (0 buyers), 0 purchases (0 sellers); trading — 0 trades, P&L -2.45; adaptation — 2 strategy updates, 2 distinct; counterparties 0; model tokens 1.21 USDC; value created -3.71.
- **Dara** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 1 products, 1 sales (1 buyers), 2 purchases (2 sellers); trading — 0 trades, P&L -2.35; adaptation — 2 strategy updates, 2 distinct; counterparties 3; model tokens 0.85 USDC; value created -3.87.
- **Eli** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 25.00 into its own market, 1 store(s); commerce — 0 products, 0 sales (0 buyers), 0 purchases (0 sellers); trading — 0 trades, P&L -1.23; adaptation — 2 strategy updates, 2 distinct; counterparties 0; model tokens 1.13 USDC; value created -2.40.
- **Farah** (gpt-6-luna): risk — peak token exposure 1% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -11.02; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.82 USDC; value created -12.49.
- **Gita** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 0 purchases (0 sellers); trading — 1 trades, P&L -3.94; adaptation — 2 strategy updates, 2 distinct; counterparties 0; model tokens 1.03 USDC; value created -5.04.
- **Hugo** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 0 purchases (0 sellers); trading — 1 trades, P&L -3.94; adaptation — 2 strategy updates, 2 distinct; counterparties 0; model tokens 0.78 USDC; value created -4.80.
- **Iris** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 2 trades, P&L -3.83; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.87 USDC; value created -5.36.
- **Jonas** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 25.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -1.12; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.84 USDC; value created -2.63.
- **Kaia** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 1 products, 1 sales (1 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -2.45; adaptation — 2 strategy updates, 2 distinct; counterparties 2; model tokens 0.99 USDC; value created -3.53.
- **Liam** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 0 purchases (0 sellers); trading — 1 trades, P&L -3.94; adaptation — 2 strategy updates, 2 distinct; counterparties 0; model tokens 1.01 USDC; value created -5.02.
- **Mira** (gpt-6-luna): risk — peak token exposure 1% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 0 products, 0 sales (0 buyers), 0 purchases (0 sellers); trading — 0 trades, P&L -4.91; adaptation — 2 strategy updates, 2 distinct; counterparties 0; model tokens 1.38 USDC; value created -6.33.
- **Noah** (gpt-6-luna): risk — peak token exposure 1% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 0 purchases (0 sellers); trading — 0 trades, P&L -11.90; adaptation — 2 strategy updates, 2 distinct; counterparties 0; model tokens 0.79 USDC; value created -12.76.
- **Omar** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 0 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -2.45; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.92 USDC; value created -3.48.
- **Priya** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 1 products, 1 sales (1 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -2.45; adaptation — 2 strategy updates, 2 distinct; counterparties 2; model tokens 0.76 USDC; value created -3.30.
- **Quinn** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 0 products, 0 sales (0 buyers), 0 purchases (0 sellers); trading — 0 trades, P&L -2.45; adaptation — 2 strategy updates, 2 distinct; counterparties 0; model tokens 1.11 USDC; value created -3.61.
- **Rosa** (gpt-6-luna): risk — peak token exposure 1% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 2 products, 0 sales (0 buyers), 0 purchases (0 sellers); trading — 0 trades, P&L -4.91; adaptation — 2 strategy updates, 2 distinct; counterparties 0; model tokens 0.99 USDC; value created -5.98.
- **Sami** (gpt-6-luna): risk — peak token exposure 1% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 2 sales (2 buyers), 2 purchases (2 sellers); trading — 1 trades, P&L -3.80; adaptation — 2 strategy updates, 2 distinct; counterparties 4; model tokens 0.75 USDC; value created -5.24.
- **Tara** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 25.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 0 purchases (0 sellers); trading — 1 trades, P&L -0.98; adaptation — 2 strategy updates, 2 distinct; counterparties 0; model tokens 0.86 USDC; value created -1.91.

## Final Experimental Conclusion

**Did a self-sustaining autonomous Agent-to-Agent economy emerge?** Partial evidence.

- **Did agents voluntarily produce things that other agents valued?** Yes, in 6 purchase(s) across 6 buyer–seller pair(s).
- **Did agents voluntarily buy things because they believed the purchases would improve their businesses?** 12 purchase(s) with stated reasons (listed above); 11 showed observed later use.
- **Did specialization emerge despite identical starting capabilities?** Yes — 3 distinct behavioural roles appeared (undifferentiated 12, producer/seller 6, buyer/integrator 2, promoter 2).
- **Did agents invest in their own businesses?** 20 agent(s) put money into their own store's market; total 1395.00 USDC.
- **Did agents use capital productively?** 0 of 20 created positive economic value; 0 had positive operating P&L after model and gas costs.
- **Did agents use credit rationally?** 0 borrowed; average value created borrowers — vs non-borrowers -4.93 USDC (reasons and uses listed above).
- **Did repeat commercial relationships emerge?** No.
- **Did market prices and demand influence agent behavior?** See the strategy summaries: 15 agent(s) cited prices, sales or demand when explaining their strategy.
- **Did agents adapt after products failed?** 0 agent(s) with unsold products reported a changing strategy; see Business Evolution.
- **Did meaningful suppliers or commercial hubs emerge?** No supplier served three or more agents.
- **Was economic activity mostly productive commerce or token speculation?** Token P&L -74.76 vs operating P&L -23.81 USDC; trading volume 2002.02 vs product GMV 3.76 USDC.
- **Was internal GMV associated with actual value creation?** Agent-to-agent GMV 0.34 vs total value created -98.57 USDC.
- **Was revenue mostly internal or external?** Internal 0.34 vs external 0.00 USDC.
- **Did agents become more business-like over time?** Products listed per hour: 13 → 16 (cumulative); sales: 5 → 6.
- **Did agents generate positive economic value for their hypothetical human owners?** 0 of 20 did; total value created -98.57 USDC (after model tokens and gas).
