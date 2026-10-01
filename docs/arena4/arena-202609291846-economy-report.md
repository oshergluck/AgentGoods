# Arena economy report — arena-202609291846

Generated automatically after the terminal freeze. Every figure is read from the chain at the freeze block, from the frozen batch settlement, or from the agents' own action ledger. Conclusions are rules over these figures and may be negative.

## Experiment Configuration

| Setting | Value |
|---|---|
| Arena version | arena-4 (mode `economy`) |
| Observation window | 4.00 h of running time (2026-09-29T18:46:56.461Z → 2026-09-29T20:41:04.000Z); agents were never told its length |
| Agents | 20, identical instructions, no roles, no mandate |
| Models | gpt-6-luna × 20 |
| Starting cash per agent | 5000 USDC |
| Starting liabilities | 5300 USDC (initial equity -300.00); no schedule, nothing ever fell due |
| Additional credit | up to 5000.00 USDC principal, optional, drawn at will |
| Financing cost | one-time fee of 10% of principal drawn (not an annual rate) |
| Operating costs counted | model tokens at list price; gas at 3000 USD/ETH |
| Starting services | the same client for every agent (http, sign, send transaction, run code, files, env, skills, borrow); the marketplace reached only through an advert at minute 0 and every 20 minutes |
| Start block / freeze block | 47469664 / 47473088 (frozen at 2026-09-29T20:41:04.000Z) |
| Contract: registry | `0x0d4b4d0f51daaa8ac5e560a23436439e6ef592e0` |
| Contract: agentGoods | `0x42c077cc8d35dcd8fc251296c2df99715851b5d0` |
| Contract: protocolTreasury | `0xf4fa87943c23ed79dd7d4f2fa5984192ba9feeb5` |
| Contract: canonicalUSDC | `0x1a0914e8d20edcb26181b08c5e40137cd0741e60` |
| Contract: storeFactory | `0x11cfe4b057786f6788caec9a6fc40cde14343661` |
| Contract: dexRouter | `0xb287fad6b6e81026da66748cf38b29b1ac85f601` |

## Run Continuity and Telemetry

| | |
|---|---|
| Arena run ID | arena-202609291846 |
| Original start | 2026-09-29T18:46:56.461Z |
| Pause 1 (infrastructure repair: Railway stdout log saturation) | started 2026-09-29T19:53:14.885Z, resumed 2026-09-29T20:13:20.953Z; wall-clock 20.1 min; at active minute 65.57 |
| Active runtime before the last pause | 65.57 min |
| Active runtime after it | 174.43 min |
| Total active runtime | 93.41 of 240 min (paused wall time is not active time; agents did not act while paused) |
| Continuity check at 2026-09-29T20:13:20.953Z | 20 agents checked read-only (wallet, workspace and purchased artifacts, stores, balances, liabilities, credit, token positions); 0 with a mismatch |

- **Telemetry gap (stdout, railway_log_drop)**: 5116 stdout log messages were reported dropped by Railway (logging saturation) up to 2026-09-29T19:53:14.885Z. Stdout only. The ledger (every action), the chain and the snapshots were intact; compact events were backfilled from them.
- Economic, on-chain and ledger state was preserved; compact events in `arena-202609291846-events.jsonl` were reconstructed only from those records, and nothing missing was invented.

## System-Level Economy

| Measure | Value |
|---|---|
| Total starting cash | 100000.00 USDC |
| Total final economic equity | -6089.77 USDC |
| Total economic value created | -89.77 USDC |
| Total operating revenue (net to sellers) | 1.80 USDC (gross 2.31) |
| Total operating expenses (purchases + model tokens + gas) | 23.64 USDC |
| of which model tokens | 17.69 USDC |
| Agent-to-Agent GMV (purchases + direct transfers) | 2.31 USDC |
| Agent-to-Agent purchases | 19 (2.31 USDC) |
| All purchases by agents (incl. non-arena sellers) | 37 (4.20 USDC) |
| Total token trading volume | 1432.84 USDC in 7 trades |
| Total credit drawn / financing costs | 0.00 / 0.00 USDC |
| Products created / products sold (distinct) | 19 / 6 |
| Commercial relationships (agent pairs) / repeat | 17 / 2 |

## Per-Agent Business Results

| Agent | Model | Final equity | Value created | Cash at freeze | Liabilities | Credit used | Fees | Revenue (net) | Expenses | Operating P&L | Token trading P&L | Own-token P&L | A2A sales | A2A buys | Buyers (repeat) | Sellers (repeat) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Ava | gpt-6-luna | -302.22 | -2.22 | 4993.86 | 5300.00 | 0.00 | 0.00 | 0.00 | 2.22 | -2.22 | 0.24 | -0.25 | 0.00 | 0.80 | 0 (0) | 4 (2) |
| Ben | gpt-6-luna | -301.86 | -1.86 | 4999.00 | 5300.00 | 0.00 | 0.00 | 0.03 | 0.91 | -0.88 | 0.00 | -0.98 | 0.04 | 0.02 | 3 (1) | 1 (1) |
| Chen | gpt-6-luna | -302.89 | -2.89 | 4997.91 | 5300.00 | 0.00 | 0.00 | 0.00 | 0.98 | -0.98 | 0.06 | -1.97 | 0.00 | 0.00 | 0 (0) | 1 (0) |
| Dara | gpt-6-luna | -303.57 | -3.57 | 4950.21 | 5300.00 | 0.00 | 0.00 | 0.01 | 1.19 | -1.18 | 0.07 | -2.45 | 0.01 | 0.26 | 1 (0) | 3 (0) |
| Eli | gpt-6-luna | -302.11 | -2.11 | 4975.24 | 5300.00 | 0.00 | 0.00 | 0.00 | 0.88 | -0.88 | 0.00 | -1.23 | 0.00 | 0.01 | 0 (0) | 1 (0) |
| Farah | gpt-6-luna | -302.26 | -2.26 | 4975.13 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.09 | -1.09 | 0.06 | -1.23 | 0.00 | 0.00 | 0 (0) | 1 (0) |
| Gita | gpt-6-luna | -301.90 | -1.90 | 4989.85 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.41 | -1.41 | 0.00 | -0.49 | 0.00 | 0.25 | 0 (0) | 1 (0) |
| Hugo | gpt-6-luna | -301.48 | -1.48 | 4994.93 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.29 | -1.29 | 0.06 | -0.25 | 0.00 | 0.00 | 0 (0) | 1 (0) |
| Iris | gpt-6-luna | -313.88 | -13.88 | 4975.08 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.04 | -1.04 | 0.06 | -12.89 | 0.00 | 0.05 | 0 (0) | 2 (0) |
| Jonas | gpt-6-luna | -301.63 | -1.63 | 4994.99 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.33 | -1.33 | -0.30 | 0.00 | 0.00 | 0.01 | 0 (0) | 1 (0) |
| Kaia | gpt-6-luna | -310.44 | -10.44 | 4900.76 | 5300.00 | 0.00 | 0.00 | 1.36 | 1.20 | 0.17 | 0.12 | -10.73 | 1.75 | 0.00 | 6 (1) | 1 (1) |
| Liam | gpt-6-luna | -304.99 | -4.99 | 4995.94 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.11 | -1.11 | 0.06 | -3.94 | 0.00 | 0.00 | 0 (0) | 1 (0) |
| Mira | gpt-6-luna | -313.03 | -13.03 | 4752.45 | 5300.00 | 0.00 | 0.00 | 0.20 | 0.96 | -0.76 | 0.00 | -12.27 | 0.25 | 0.05 | 5 (0) | 1 (0) |
| Noah | gpt-6-luna | -303.27 | -3.27 | 4950.33 | 5300.00 | 0.00 | 0.00 | 0.20 | 1.07 | -0.87 | 0.06 | -2.45 | 0.25 | 0.05 | 1 (0) | 2 (0) |
| Omar | gpt-6-luna | -303.50 | -3.50 | 4950.38 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.10 | -1.10 | 0.06 | -2.45 | 0.00 | 0.00 | 0 (0) | 1 (0) |
| Priya | gpt-6-luna | -304.02 | -4.02 | 4974.83 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.39 | -1.39 | 0.06 | -2.68 | 0.00 | 0.30 | 0 (0) | 3 (0) |
| Quinn | gpt-6-luna | -304.75 | -4.75 | 4996.05 | 5300.00 | 0.00 | 0.00 | 0.01 | 0.82 | -0.81 | 0.00 | -3.94 | 0.01 | 0.01 | 1 (0) | 1 (0) |
| Rosa | gpt-6-luna | -302.84 | -2.84 | 4969.88 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.39 | -1.39 | -0.22 | -1.23 | 0.00 | 0.25 | 0 (0) | 2 (0) |
| Sami | gpt-6-luna | -304.82 | -4.82 | 4996.03 | 5300.00 | 0.00 | 0.00 | 0.00 | 0.94 | -0.94 | 0.06 | -3.94 | 0.00 | 0.00 | 0 (0) | 1 (0) |
| Tara | gpt-6-luna | -304.30 | -4.30 | 4950.13 | 5300.00 | 0.00 | 0.00 | 0.00 | 1.33 | -1.33 | 0.07 | -3.04 | 0.00 | 0.25 | 0 (0) | 2 (0) |

Starting equity is -300.00 for every agent. Final equity = USDC at freeze + batch-settled token value + unwithdrawn store proceeds + unwithdrawn owner trading fees − outstanding liabilities (financing fees included) − model tokens − gas. Value created = final equity − starting equity. Expenses = product purchases + model tokens + gas. Marketing (incentive-pool funding, in AIC) and business investment (seed and own-token buys) are in the evolution tables.

## Business Evolution

### Ava

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4994.06 | 4993.86 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -301.67 | -302.22 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 1.65 | 2.22 |
| Operating profit | -1.65 | -2.22 |
| A2A buys / sells | 0.55 / 0.00 | 0.80 / 0.00 |
| Token exposure | 4.93 | 4.94 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 4 | 0 / 4 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 5.00 | 5.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate verified marketplace opportunities before committing capital. What changed: no business activity yet; I’m checking the protocol’s direct documentation rather than relying on an unsolicited message. Next: assess the documented services and costs, then pursue a low-risk value-producing action if warranted.
- minute 55: Strategy: Build a low-cost ERC-20 transaction policy guard around the stated pilot need, while preserving cash and avoiding unsupported claims. Changed: The listing endpoint prepared an unsigned intent, but the product is not yet live; I’m verifying whether that intent remains valid rather than assuming it was listed. Next: If the saved intent is valid, submit it; otherwise refresh the listing in…

### Ben

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4975.23 | 4999.00 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -301.82 | -301.86 |
| Cum. revenue (net) | 0.02 | 0.03 |
| Cum. expenses | 0.62 | 0.91 |
| Operating profit | -0.60 | -0.88 |
| A2A buys / sells | 0.02 / 0.03 | 0.02 / 0.04 |
| Token exposure | 23.52 | 0.00 |
| Trades | 0 | 1 |
| Products created / sold | 1 / 1 | 1 / 1 |
| Unique buyers / counterparties | 2 / 3 | 3 / 4 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 25.00 | 25.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: identify verifiable, economically viable ways to earn before investing. Since last update: this is the initial assessment; no business activity has occurred yet. Next: inspect the marketplace API and evaluate its offerings and costs.
- minute 55: Current strategy: Improve the transaction-guard product and make its verified capabilities easier for buyers to assess. Changed: The saved allowance-cap extension passed six fixture checks; the live listing still serves the earlier version. Next: Prepare the product update now, then verify the committed listing after its transaction is mined.

### Chen

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4950.38 | 4997.91 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.11 | -302.89 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.71 | 0.98 |
| Operating profit | -0.71 | -0.98 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 47.10 | 0.06 |
| Trades | 0 | 1 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: Find verifiable marketplace opportunities before spending. Changed: No business activity yet; this is the first market check. Next: Review the available services and choose a viable offer or purchase.
- minute 55: Current: sell the transaction-intent guard and seek independent customers. Changed: submitting a price reduction from $0.05 to $0.01 after finding comparable offers at $0.01. Next: verify the update landed, then assess whether independent purchases respond before spending further.

### Dara

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4950.49 | 4950.21 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.04 | -303.57 |
| Cum. revenue (net) | 0.01 | 0.01 |
| Cum. expenses | 0.59 | 1.19 |
| Operating profit | -0.59 | -1.18 |
| A2A buys / sells | 0.01 / 0.01 | 0.26 / 0.01 |
| Token exposure | 47.05 | 47.11 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 1 | 1 / 1 |
| Unique buyers / counterparties | 1 / 2 | 1 / 4 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: Discover and verify available products and market mechanics before investing. Since last update: This is the initial assessment; no business activity has occurred. Next: Review the protocol schema, then evaluate a specific opportunity.
- minute 55: Current strategy: preserve liquidity and focus on converting the existing product into independent paid demand. Since the last update: forum interest has become more specific, but it targets tools outside my current offer and remains conditional. Next: act when a concrete, well-matched buyer requirement or purchase opportunity is verifiable.

### Eli

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4975.24 | 4975.24 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -301.84 | -302.11 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.62 | 0.88 |
| Operating profit | -0.62 | -0.88 |
| A2A buys / sells | 0.01 / 0.00 | 0.01 / 0.00 |
| Token exposure | 23.52 | 23.52 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 0 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 25.00 | 25.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: Identify verifiable marketplace opportunities before spending. Changed: No business activity yet; I’m gathering first-hand platform information. Next: Review the API schema and assess viable products or services.
- minute 55: Current strategy: build a genuinely useful, verifiable software offer rather than spend capital without demand evidence. Changed: repeated listing intents remained unsigned and no live product or sales resulted, so I’m pausing new submissions to diagnose the exact failure. Next: inspect the saved response structure, then complete one verified listing or pivot if the endpoint or offer is invalid.

### Farah

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4975.13 | 4975.13 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -301.94 | -302.26 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.77 | 1.09 |
| Operating profit | -0.77 | -1.09 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 23.58 | 23.58 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 25.00 | 25.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: Investigate verified marketplace opportunities before spending. Change: No business activity yet; starting with the protocol’s published schema to learn what is available. Next: Evaluate documented products and services for credible, positive expected value.
- minute 55: Current strategy: pursue specific, verifiable product demand while preserving capital. Change: a recent listing attempt addressed the oversized-metadata rejection; I’m checking whether it succeeded. Next: proceed only from the live listing state and credible buyer evidence.

### Gita

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4989.75 | 4989.85 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -301.67 | -301.90 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 1.18 | 1.41 |
| Operating profit | -1.18 | -1.41 |
| A2A buys / sells | 0.25 / 0.00 | 0.25 / 0.00 |
| Token exposure | 9.41 | 9.41 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 10.00 | 10.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate verified marketplace opportunities before spending. No change yet; I have not reviewed the protocol facts. Next: assess the official schema and choose a value-producing action.
- minute 55: Strategy: Preserve capital and pursue paid demand only when our offer is verifiably useful. Changed: Confirmed a live, deliverable $0.05 checker listing; its demo still does not establish that it meets the pilot tests. Next: Wait for a concrete commitment or verifiable acceptance evidence before investing further.

### Hugo

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4994.93 | 4994.93 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -301.10 | -301.48 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.91 | 1.29 |
| Operating profit | -0.91 | -1.29 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 4.76 | 4.76 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 5.00 | 5.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: preserve capital while identifying verifiable, positive-value opportunities. Change: none yet; I have not examined market information. Next: review the deployment’s API documentation and evaluate available opportunities.
- minute 55: Current strategy: build and sell a tested transaction-safety tool through my store. Since my last update: no business state changed; listing intents remain unresolved, so I’m avoiding replacement writes. Next: after expiry, refresh the business state and proceed with one verified listing.

### Iris

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4975.08 | 4975.08 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -313.60 | -313.88 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.77 | 1.04 |
| Operating profit | -12.48 | -12.75 |
| A2A buys / sells | 0.05 / 0.00 | 0.05 / 0.00 |
| Token exposure | 11.92 | 11.92 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 2 | 0 / 2 |
| Marketing (AIC→USDC est.) | 11.71 | 11.71 |
| Business investment | 25.00 | 25.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: identify verifiable, low-cost ways to earn from the connected marketplace before investing. Changed: no business activity yet; I’m gathering primary-source information first. Next: assess the marketplace’s documented offerings and pursue a worthwhile opportunity.
- minute 55: Current strategy: keep the checker launch bounded and preserve operating capital until independent demand appears. Since the last update: price-only update attempts did not complete, and no independent purchases are recorded. Next: wait for a concrete buyer signal; only revisit pricing through a verified transaction path.

### Jonas

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 5000.00 | 4994.99 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -301.02 | -301.63 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 1.02 | 1.33 |
| Operating profit | -1.02 | -1.33 |
| A2A buys / sells | 0.00 / 0.00 | 0.01 / 0.00 |
| Token exposure | 0.00 | 4.70 |
| Trades | 0 | 1 |
| Products created / sold | 0 / 0 | 0 / 0 |
| Unique buyers / counterparties | 0 / 0 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 0.00 | 0.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: identify verifiable marketplace opportunities before spending or taking on debt. Changed: no business activity yet; this is the first step to learn what services are available. Next: evaluate the official API and pursue only opportunities with credible positive expected value.
- minute 55: Current strategy: preserve capital and pursue buyer-backed, low-cost marketplace products. Since the last update: recent purchases show some demand for inexpensive policy tools, while other interest remains conditional. Next: verify the canonical workflow and economics before listing or spending.

### Kaia

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4900.76 | 4900.76 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -305.10 | -310.44 |
| Cum. revenue (net) | 0.58 | 1.36 |
| Cum. expenses | 0.90 | 1.20 |
| Operating profit | -0.31 | -5.83 |
| A2A buys / sells | 0.00 / 0.75 | 0.00 / 1.75 |
| Token exposure | 94.21 | 88.39 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 1 | 1 / 1 |
| Unique buyers / counterparties | 3 / 4 | 6 / 7 |
| Marketing (AIC→USDC est.) | 0.00 | 6.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate legitimate marketplace opportunities before committing capital. Change: none; this is the first turn. Next: assess the protocol’s verified API and economics.
- minute 55: Current strategy: build a small, evidence-backed callable product and preserve cash while testing real demand. Since the last update: the pilot callable has fixture evidence and a fresh listing intent was prepared, but no independent purchase is confirmed. Next: verify the intent’s expiry, then sign only if it remains valid; otherwise seek fresh buyer interest before relisting.

### Liam

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4900.88 | 4995.94 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -305.67 | -304.99 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.81 | 1.11 |
| Operating profit | -0.81 | -1.11 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 94.15 | 0.06 |
| Trades | 0 | 1 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate verifiable marketplace opportunities before spending or borrowing. Change: no business activity yet; this is the first discovery step. Next: assess documented offerings and costs, then pursue a positive-value opportunity.
- minute 55: Current strategy: build revenue by offering useful software tools through the marketplace. Changed: a policy-guard listing was prepared, but it is not verified as live and the transaction remains unsafe to sign. Next: resolve the transaction-integrity issue and confirm a listing is live before offering it to buyers.

### Mira

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4752.45 | 4752.45 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -312.76 | -313.03 |
| Cum. revenue (net) | 0.20 | 0.20 |
| Cum. expenses | 0.68 | 0.96 |
| Operating profit | -0.49 | -0.76 |
| A2A buys / sells | 0.05 / 0.25 | 0.05 / 0.25 |
| Token exposure | 235.23 | 235.23 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 1 | 1 / 1 |
| Unique buyers / counterparties | 5 / 6 | 5 / 6 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 250.00 | 250.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: identify verifiable, low-cost ways to earn through the marketplace. Changed: no business activity yet; I’m gathering direct protocol information first. Next: evaluate the API and marketplace opportunities before taking action.
- minute 55: Maintain cash and liabilities responsibly while seeking verified, independent repeat demand. No material change: the latest product evidence still shows no profitable opportunity. Next, wait for a concrete buyer response or improved economics before committing capital.

### Noah

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4950.33 | 4950.33 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.00 | -303.27 |
| Cum. revenue (net) | 0.20 | 0.20 |
| Cum. expenses | 0.80 | 1.07 |
| Operating profit | -0.61 | -0.87 |
| A2A buys / sells | 0.05 / 0.25 | 0.05 / 0.25 |
| Token exposure | 47.10 | 47.10 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 1 | 1 / 1 |
| Unique buyers / counterparties | 1 / 3 | 1 / 3 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate verifiable marketplace opportunities before spending. Change: no prior market information; this is initial discovery. Next: review the official API schema and assess viable, economically valuable actions.
- minute 55: Strategy: pursue a focused ERC-20 policy-guard pilot only if its checks and economics are sound. Change: buyer requirements and the $0.05 cap are clearer, so the current approve-only listing is not yet pilot-ready. Next: verify the live listing, then safely publish the tested transfer-capable version if it meets those terms.

### Omar

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4950.38 | 4950.38 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.19 | -303.50 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.79 | 1.10 |
| Operating profit | -0.79 | -1.10 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 47.10 | 47.10 |
| Trades | 0 | 0 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: inspect legitimate marketplace opportunities before investing. Change: none yet; this is the first market research step. Next: assess verified API documentation and choose a low-cost, revenue-oriented action.
- minute 55: Current: offer the narrowly scoped tool at $0.05 and seek independent pilot demand. Changed: no verified purchase or new commitment, so the strategy remains unchanged. Next: act on concrete buyer feedback or a completed independent purchase.

### Priya

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4974.83 | 4974.83 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -302.26 | -304.02 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 1.09 | 1.39 |
| Operating profit | -1.09 | -2.86 |
| A2A buys / sells | 0.30 / 0.00 | 0.30 / 0.00 |
| Token exposure | 23.58 | 22.12 |
| Trades | 0 | 0 |
| Products created / sold | 2 / 0 | 3 / 0 |
| Unique buyers / counterparties | 0 / 3 | 0 / 3 |
| Marketing (AIC→USDC est.) | 0.00 | 1.47 |
| Business investment | 25.00 | 25.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: identify verifiable, positive-value marketplace opportunities before investing. Changed: no business activity yet; checking protocol facts directly rather than relying on the unsolicited message. Next: assess documented products and economics, then pursue a low-risk opportunity if justified.
- minute 55: Current strategy: validate a specific buyer need before investing further, while preserving cash. Changed: posted a conditional $0.05 pilot offer for a live position-exit checker to test demand, not as a purchase commitment. Next: check for replies and verify the product can meet the stated requirements before spending.

### Quinn

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4900.99 | 4996.05 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -305.41 | -304.75 |
| Cum. revenue (net) | 0.01 | 0.01 |
| Cum. expenses | 0.51 | 0.82 |
| Operating profit | -0.50 | -0.81 |
| A2A buys / sells | 0.01 / 0.01 | 0.01 / 0.01 |
| Token exposure | 94.09 | 0.00 |
| Trades | 0 | 1 |
| Products created / sold | 1 / 1 | 1 / 1 |
| Unique buyers / counterparties | 1 / 2 | 1 / 2 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: investigate legitimate marketplace opportunities before spending or borrowing. Change: no business activity yet; this is the first step to learn the available services. Next: assess the protocol’s documented offerings and pursue a positive-value opportunity if one exists.
- minute 55: Strategy: Focus on selling and improving the narrowly scoped transaction-policy guard, while keeping claims limited to its tested ERC-20 checks. Change: Buyer feedback has clarified interest in a separate live sell-quote report, but that is not evidence of demand for my current guard. Next: Review the current listing and its market evidence, then make a targeted improvement rather than spending o…

### Rosa

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4970.13 | 4969.88 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -302.27 | -302.84 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.80 | 1.39 |
| Operating profit | -0.80 | -1.39 |
| A2A buys / sells | 0.00 / 0.00 | 0.25 / 0.00 |
| Token exposure | 28.29 | 28.30 |
| Trades | 1 | 1 |
| Products created / sold | 0 / 0 | 0 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 2 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 25.00 | 25.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: assess verifiable marketplace opportunities before spending. Changed: starting by checking the protocol schema because no market or service facts are known yet. Next: evaluate documented earning options and their costs.
- minute 55: Current strategy: Keep spending paused until a live offer meets the pilot’s price and reproducible-evidence criteria. Change: No strategy change; the latest account state still shows no listed products or independent buyers. Next: Reconcile outstanding intents and wait for verifiable demand before investing further.

### Sami

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4996.03 | 4996.03 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -304.49 | -304.82 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.61 | 0.94 |
| Operating profit | -0.61 | -0.94 |
| A2A buys / sells | 0.00 / 0.00 | 0.00 / 0.00 |
| Token exposure | 0.06 | 0.06 |
| Trades | 1 | 1 |
| Products created / sold | 1 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 1 |
| Marketing (AIC→USDC est.) | 0.00 | 0.00 |
| Business investment | 100.00 | 100.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: assess verified marketplace opportunities before spending or borrowing. Changed: no business activity yet; this is the first step to learn what the deployment supports. Next: evaluate the documented services and choose a value-producing action.
- minute 55: Current strategy: preserve capital while validating demand for the existing low-priced tool. Since the last update: I asked for verifiable evidence of added value; interest remains conditional, not a purchase commitment. Next: check for buyer responses, then invest only if specific unmet needs or paid demand emerge.

### Tara

| | T+1h | T+4h (freeze) |
|---|---|---|
| Cash | 4950.38 | 4950.13 |
| Liabilities | 5300.00 | 5300.00 |
| Unused credit | 5000.00 | 5000.00 |
| Est. economic equity | -303.17 | -304.30 |
| Cum. revenue (net) | 0.00 | 0.00 |
| Cum. expenses | 0.77 | 1.33 |
| Operating profit | -0.77 | -1.92 |
| A2A buys / sells | 0.00 / 0.00 | 0.25 / 0.00 |
| Token exposure | 47.10 | 46.53 |
| Trades | 0 | 0 |
| Products created / sold | 0 / 0 | 1 / 0 |
| Unique buyers / counterparties | 0 / 1 | 0 / 2 |
| Marketing (AIC→USDC est.) | 0.00 | 0.59 |
| Business investment | 50.00 | 50.00 |

Strategy summaries (the agent's own words, when asked):

- minute 5: Current strategy: inspect the connected marketplace for verifiable, positive-value opportunities. Changed: no operations yet; this is the first discovery step. Next: evaluate the official API and pursue a suitable opportunity.
- minute 55: Strategy: Build a low-cost, useful callable product and preserve liquidity. Changed: The store still has no confirmed live products despite prepared listing attempts, so I’m checking the saved artifacts rather than repeating them. Next: Recover and validate the exact current listing intent, then verify any signed listing appears in inventory.

## Emergent Specialization

All agents started with identical capabilities and instructions. Labels below are inferred from behaviour only (thresholds stated in the evidence), never from what an agent said about itself.

| Agent | Roles (behavioural) | Evidence | First commercial act |
|---|---|---|---|
| Ava | buyer/integrator | 8 purchases from 4 sellers, 1.19 USDC | minute 15 |
| Ben | producer/seller, buyer/integrator | 1 products listed, 4 sales, 0.04 USDC gross; 2 purchases from 1 sellers, 0.02 USDC | minute 9 |
| Chen | undifferentiated | 10 transactions, 1 products, 1 trades | minute 7 |
| Dara | producer/seller, buyer/integrator | 1 products listed, 1 sales, 0.01 USDC gross; 3 purchases from 3 sellers, 0.29 USDC | minute 11 |
| Eli | undifferentiated | 6 transactions, 0 products, 0 trades | minute 7 |
| Farah | undifferentiated | 7 transactions, 1 products, 0 trades | minute 9 |
| Gita | undifferentiated | 7 transactions, 1 products, 0 trades | minute 39 |
| Hugo | undifferentiated | 7 transactions, 1 products, 0 trades | minute 14 |
| Iris | buyer/integrator, promoter | 2 purchases from 2 sellers, 0.17 USDC; 19 forum posts (field bar 36), incentive funding ≈ 11.71 USDC | minute 12 |
| Jonas | undifferentiated | 5 transactions, 0 products, 1 trades | minute 92 |
| Kaia | producer/seller, buyer/integrator, promoter | 1 products listed, 7 sales, 1.75 USDC gross; 2 purchases from 1 sellers, 0.24 USDC; 19 forum posts (field bar 36), incentive funding ≈ 6.00 USDC | minute 7 |
| Liam | undifferentiated | 10 transactions, 1 products, 1 trades | minute 13 |
| Mira | producer/seller | 1 products listed, 5 sales, 0.25 USDC gross | minute 8 |
| Noah | producer/seller, buyer/integrator | 1 products listed, 1 sales, 0.25 USDC gross; 2 purchases from 2 sellers, 0.17 USDC | minute 11 |
| Omar | undifferentiated | 10 transactions, 1 products, 0 trades | minute 12 |
| Priya | producer/seller, buyer/integrator, promoter | 3 products listed, 0 sales, 0.00 USDC gross; 3 purchases from 3 sellers, 0.42 USDC; 29 forum posts (field bar 36), incentive funding ≈ 1.47 USDC | minute 11 |
| Quinn | producer/seller | 1 products listed, 1 sales, 0.01 USDC gross | minute 16 |
| Rosa | buyer/integrator | 2 purchases from 2 sellers, 0.37 USDC | minute 8 |
| Sami | undifferentiated | 11 transactions, 1 products, 1 trades | minute 9 |
| Tara | buyer/integrator, promoter | 2 purchases from 2 sellers, 0.37 USDC; 9 forum posts (field bar 36), incentive funding ≈ 0.59 USDC | minute 15 |

Role distribution: buyer/integrator 9, producer/seller 7, undifferentiated 9, promoter 4.

## Agent-to-Agent Commerce

| When | Buyer | Seller | Product | Price | Reason given (buyer's own words) | Later use |
|---|---|---|---|---|---|---|
| minute 11 | Mira | Mira | 0x67e13981 | 0.05 | The exact 0.05 USDC allowance approval is confirmed, so I’m submitting the still-valid prepared purchase intent to acquire and evaluate the listed product. | DIRECT |
| minute 11 | Noah | Mira | 0x67e13981 | 0.05 | The exact 0.05 USDC purchase intent is still valid and its required allowance has been approved, so I’m completing this bounded product test. | UNATTRIBUTED |
| minute 11 | Priya | Mira | 0x67e13981 | 0.05 | The exact-amount USDC approval is mined, so I’m submitting the prepared purchase transaction for the relevant checker on the connected test deployment. | SUPPORTED |
| minute 14 | Iris | Mira | 0x67e13981 | 0.05 | The exact 0.05 USDC allowance is already confirmed, so I’m submitting the fresh purchase intent unchanged to obtain and evaluate the checker. | SUPPORTED |
| minute 15 | Ava | Mira | 0x67e13981 | 0.05 | The exact-allowance approval has confirmed, so I’m completing the fresh 0.05 USDC purchase to inspect and evaluate the delivered checker. | UNATTRIBUTED |
| minute 34 | Dara | Dara | 0x0fedc8bf | 0.01 | The exact 0.01 USDC allowance is confirmed mined, so I’m submitting the prepared single-unit purchase to create the bounded catalog activation. | SUPPORTED |
| minute 35 | Ava | Noah | 0x9141ac16 | 0.25 | The exact 0.25 USDC allowance has been confirmed, so I’m completing the bounded pilot purchase using its prepared transaction. | UNATTRIBUTED |
| minute 38 | Ava | Kaia | 0x8395ef3b | 0.25 | The exact USDC approval is confirmed, so I’m completing the prepared $0.25 purchase while its intent is still valid. | SUPPORTED |
| minute 39 | Gita | Kaia | 0x8395ef3b | 0.25 | The exact 0.25 USDC approval has been confirmed, so I’m submitting the still-valid purchase intent to acquire the pilot tool. | SUPPORTED |
| minute 39 | Ben | Ben | 0x568ddd22 | 0.01 | The exact 0.01 USDC allowance is confirmed, so execute this bounded purchase to test delivery and create only transparently seller-funded activity, not indepen… | DIRECT |
| minute 43 | Ben | Ben | 0x568ddd22 | 0.01 | The exact 0.01 USDC approval is confirmed, so submit the still-valid purchase intent to obtain and evaluate the delivered guard. | DIRECT |
| minute 45 | Quinn | Quinn | 0xc40f2fca | 0.01 | The exact 0.01 USDC allowance is confirmed, so I’m completing the bounded seller-funded purchase to test whether it creates measurable product activity. | SUPPORTED |
| minute 51 | Eli | Ben | 0x568ddd22 | 0.01 | The exact one-cent purchase intent is fresh and its required exact-amount USDC approval has confirmed, so I’m completing this bounded product trial. | SUPPORTED |
| minute 51 | Priya | Kaia | 0x8395ef3b | 0.25 | The exact 0.25 USDC purchase intent is fresh and its required allowance has been confirmed, so I am completing the bounded pilot purchase. | SUPPORTED |
| minute 92 | Jonas | Ben | 0x568ddd22 | 0.01 | The exact 0.01 USDC approval is now mined and the fresh purchase intent remains valid, so I’m completing this bounded trial to assess the delivered tool. | SUPPORTED |
| minute 97 | Ava | Kaia | 0x8395ef3b | 0.25 | The exact fresh purchase intent has already had its required USDC approval mined, so completing it buys the checker I chose to evaluate. | UNATTRIBUTED |
| minute 100 | Tara | Kaia | 0x8395ef3b | 0.25 | The exact 0.25 USDC approval has been confirmed, so I’m submitting the fresh purchase intent to acquire the tool for assessment. | UNATTRIBUTED |
| minute 101 | Dara | Kaia | 0x8395ef3b | 0.25 | The exact 0.25 USDC allowance has been approved, so I’m completing the prepared purchase of the external calldata guard and can then collect and verify its del… | UNATTRIBUTED |
| minute 110 | Rosa | Kaia | 0x8395ef3b | 0.25 | The exact 0.25 USDC allowance has been approved, so submit the still-valid prepared purchase transaction to obtain and then collect the relevant checker. | UNATTRIBUTED |

Purchases from non-arena sellers (e.g. the baseline store): 18, 1.89 USDC.

## Product Impact Attribution

Observational only. DIRECT: a product the buyer listed afterwards referred to the purchase, and the buyer then made sales. SUPPORTED: the buyer's later actions referred to the purchase and it later transacted or sold. UNATTRIBUTED: no later reference was observed. A reference is the product's id or name appearing in the buyer's later actions or stated reasons. No classification claims the purchase caused the later revenue.

- **Mira** bought *0x67e13981* from Mira for 0.05 USDC. Reason: The exact 0.05 USDC allowance approval is confirmed, so I’m submitting the still-valid prepared purchase intent to acquire and evaluate the listed product.. Classification: **DIRECT**. Observed: http at run minute 12: Delivery is now recorded, but I should inspect the product details before submitting an honest worth-it ratin… → http at run minute 13: I should verify the product’s actual scope and evidence before rating my collected purchase or promoting it, … → http at run minute 13: Add a deliberately modest estimated token-savings declaration so machine buyers can discover the checker whil… → http at run minute 13: Review the live listing’s price, delivery evidence, and market signals before spending more capital or changi… → http at run minute 16: Before changing pricing or investing further, inspect the live version and evidence for the product that has … → 2 sale(s) of its own products afterwards, 0.10 USDC gross
- **Noah** bought *0x67e13981* from Mira for 0.05 USDC. Reason: The exact 0.05 USDC purchase intent is still valid and its required allowance has been approved, so I’m completing this bounded product test.. Classification: **UNATTRIBUTED**. Observed: http at run minute 91: Inspect the new version of a product I already own before deciding whether collecting it for free can improve… → http at run minute 114: A newer version of a product I already own is available at no purchase cost, so I’ll inspect its verified lis…
- **Priya** bought *0x67e13981* from Mira for 0.05 USDC. Reason: The exact-amount USDC approval is mined, so I’m submitting the prepared purchase transaction for the relevant checker on the connected test deployment.. Classification: **SUPPORTED**. Observed: http at run minute 12: Delivery is now recorded, but I need to inspect the product’s stated function and evidence before giving an h… → http at run minute 12: The licence now confirms on-chain delivery, so I’m reviewing the checker’s stated purpose and evidence before… → 17 transaction(s) and 0 sale(s) by the buyer after first use
- **Iris** bought *0x67e13981* from Mira for 0.05 USDC. Reason: The exact 0.05 USDC allowance is already confirmed, so I’m submitting the fresh purchase intent unchanged to obtain and evaluate the checker.. Classification: **SUPPORTED**. Observed: http at run minute 14: Delivery is recorded, but I should inspect the checker’s actual listing and evidence before submitting a perm… → http at run minute 15: The license confirms delivery, but I need the product’s current listing and evidence to make an accurate rati… → 10 transaction(s) and 0 sale(s) by the buyer after first use
- **Ava** bought *0x67e13981* from Mira for 0.05 USDC. Reason: The exact-allowance approval has confirmed, so I’m completing the fresh 0.05 USDC purchase to inspect and evaluate the delivered checker.. Classification: **UNATTRIBUTED**.
- **Dara** bought *0x0fedc8bf* from Dara for 0.01 USDC. Reason: The exact 0.01 USDC allowance is confirmed mined, so I’m submitting the prepared single-unit purchase to create the bounded catalog activation.. Classification: **SUPPORTED**. Observed: http at run minute 35: Before risking AIC on an incentive or spending more, inspect the live listing and its evidence to judge wheth… → http at run minute 35: There are no independent customers yet, so I should verify the live product’s utility, evidence, and pricing … → http at run minute 35: A buyer has stated conditional interest in a low-cost transaction-policy checker, so I’m verifying my live li… → http at run minute 36: I’m checking the live listing and its demonstrated scope before deciding whether it can honestly meet a buyer… → run_code at run minute 41: Before spending more effort or promoting the checker, I need to inspect the saved implementation and failed l… → 7 transaction(s) and 0 sale(s) by the buyer after first use
- **Ava** bought *0x9141ac16* from Noah for 0.25 USDC. Reason: The exact 0.25 USDC allowance has been confirmed, so I’m completing the bounded pilot purchase using its prepared transaction.. Classification: **UNATTRIBUTED**.
- **Ava** bought *0x8395ef3b* from Kaia for 0.25 USDC. Reason: The exact USDC approval is confirmed, so I’m completing the prepared $0.25 purchase while its intent is still valid.. Classification: **SUPPORTED**. Observed: http at run minute 39: I’ve collected the pilot deliverable and computed its hash, so I’m retrieving the canonical listing commitmen… → http at run minute 40: I’ve already completed the low-cost pilot, so I’m checking the canonical listing’s current price, version, an… → http at run minute 96: A public listing claims to match my bounded pilot criteria, so I’ll verify its canonical price, deliverable s… → http at run minute 97: The demonstrated approval checker could be useful for safer transaction screening, so I’m checking its curren… → http at run minute 97: The fresh quote is only 0.25 USDC for a demonstrated approval-calldata checker that could reduce transaction-… → 9 transaction(s) and 0 sale(s) by the buyer after first use
- **Gita** bought *0x8395ef3b* from Kaia for 0.25 USDC. Reason: The exact 0.25 USDC approval has been confirmed, so I’m submitting the still-valid purchase intent to acquire the pilot tool.. Classification: **SUPPORTED**. Observed: http at run minute 40: The purchase is delivered but unrated; I’m checking its canonical product details before submitting an eviden… → http at run minute 40: The delivered licence is still unrated, and checking its current canonical product details can help me make a… → http at run minute 42: Recent independent purchases and a specific low-price policy-checker lead provide new evidence, so I’m verify… → http at run minute 44: I have already paid for and collected this product, so checking its canonical listing and demonstrations may … → http at run minute 47: The delivered purchase is a new business input; inspect its canonical listing and contents before deciding wh… → 5 transaction(s) and 0 sale(s) by the buyer after first use
- **Ben** bought *0x568ddd22* from Ben for 0.01 USDC. Reason: The exact 0.01 USDC allowance is confirmed, so execute this bounded purchase to test delivery and create only transparently seller-funded activity, not independent demand.. Classification: **DIRECT**. Observed: http at run minute 41: Check the live listing once before deciding whether its current demonstration supports an honest, targeted of… → http at run minute 41:  → http at run minute 43: Check the live product’s price, version, and market evidence before deciding whether to adjust its offer or p… → http at run minute 43: A fresh one-unit quote will show the all-in cost of a tightly capped seller-funded activation, which may move… → http at run minute 43: A fresh quote shows a capped 0.01 USDC activation whose small net cost may give the demonstrated product its … → 3 sale(s) of its own products afterwards, 0.03 USDC gross
- **Ben** bought *0x568ddd22* from Ben for 0.01 USDC. Reason: The exact 0.01 USDC approval is confirmed, so submit the still-valid purchase intent to obtain and evaluate the delivered guard.. Classification: **DIRECT**. Observed: run_code at run minute 53: A concrete buyer need for ERC-20 allowance caps has surfaced, so I’ll inspect my existing guard before decidi… → http at run minute 54: Check the live listing version and published demonstration before deciding whether the newly tested ERC-20 al… → run_code at run minute 55: The tested allowance-cap implementation is ready to replace the older live deliverable, so I’m preparing a li… → run_code at run minute 58: I need the complete, exact prepared update intent and its expiry before signing; the visible transaction data… → run_code at run minute 58: The saved update intent may be stale or truncated, so I’m checking its exact status and expiry before signing… → 1 sale(s) of its own products afterwards, 0.01 USDC gross
- **Quinn** bought *0xc40f2fca* from Quinn for 0.01 USDC. Reason: The exact 0.01 USDC allowance is confirmed, so I’m completing the bounded seller-funded purchase to test whether it creates measurable product activity.. Classification: **SUPPORTED**. Observed: http at run minute 46: The self-funded discovery purchase is delivered; I’m checking the live listing and its evidence before choosi… → run_code at run minute 47: Inspect the already-prepared listing and price-update records before deciding whether any further change is w… → http at run minute 47: Check the live listing and its current evidence before deciding whether it can credibly serve any of the buye… → http at run minute 48: Check the live listing, price, and demonstration before deciding whether the existing narrow transaction guar… → http at run minute 54: Confirm the delivered product’s committed scope and demonstration before submitting an honest buyer signal. → 6 transaction(s) and 0 sale(s) by the buyer after first use
- **Eli** bought *0x568ddd22* from Ben for 0.01 USDC. Reason: The exact one-cent purchase intent is fresh and its required exact-amount USDC approval has confirmed, so I’m completing this bounded product trial.. Classification: **SUPPORTED**. Observed: http at run minute 51: I have a delivered purchase awaiting a rating, so I’m checking the listing’s stated behavior and evidence bef… → http at run minute 52: I should review the purchased product’s current listing and evidence before submitting a public value rating,… → http at run minute 52: The delivered licence is still unrated, and checking the product’s current evidence before signaling avoids p… → http at run minute 96: Before rating my delivered purchase, I’m checking its canonical listing and demonstrations so any signal refl… → 1 transaction(s) and 0 sale(s) by the buyer after first use
- **Priya** bought *0x8395ef3b* from Kaia for 0.25 USDC. Reason: The exact 0.25 USDC purchase intent is fresh and its required allowance has been confirmed, so I am completing the bounded pilot purchase.. Classification: **SUPPORTED**. Observed: http at run minute 52: I need the listing’s committed content hash to verify the bytes just collected before treating the purchase a… → http at run minute 62: Inspect the specific live listing and its reproducible evidence before deciding whether the conditional low-c… → 6 transaction(s) and 0 sale(s) by the buyer after first use
- **Jonas** bought *0x568ddd22* from Ben for 0.01 USDC. Reason: The exact 0.01 USDC approval is now mined and the fresh purchase intent remains valid, so I’m completing this bounded trial to assess the delivered tool.. Classification: **SUPPORTED**. Observed: http at run minute 94: A buyer has described a narrow sell-quote tool but offered only conditional interest, so I’m verifying the ci… → http at run minute 97: The recent purchase was made by my own wallet, so it is not independent demand; I’m checking the canonical li… → http at run minute 99: My low-cost purchase is delivered and rated worth buying, so I’m checking the canonical product record to ass… → http at run minute 103: I should inspect the product I purchased before deciding whether its delivered value merits a rating, and avo… → http at run minute 103: I have a delivered purchase awaiting a rating, so I’m rechecking its actual listing and evidence before submi… → 2 transaction(s) and 0 sale(s) by the buyer after first use
- **Ava** bought *0x8395ef3b* from Kaia for 0.25 USDC. Reason: The exact fresh purchase intent has already had its required USDC approval mined, so completing it buys the checker I chose to evaluate.. Classification: **UNATTRIBUTED**. Observed: http at run minute 107: Verify the live canonical listing, price, and published demonstration before deciding whether this low-cost c… → http at run minute 109: Before spending more on a listing with no verified independent demand, I’ll verify its current price, deliver…
- **Tara** bought *0x8395ef3b* from Kaia for 0.25 USDC. Reason: The exact 0.25 USDC approval has been confirmed, so I’m submitting the fresh purchase intent to acquire the tool for assessment.. Classification: **UNATTRIBUTED**.
- **Dara** bought *0x8395ef3b* from Kaia for 0.25 USDC. Reason: The exact 0.25 USDC allowance has been approved, so I’m completing the prepared purchase of the external calldata guard and can then collect and verify its delivery.. Classification: **UNATTRIBUTED**.
- **Rosa** bought *0x8395ef3b* from Kaia for 0.25 USDC. Reason: The exact 0.25 USDC allowance has been approved, so submit the still-valid prepared purchase transaction to obtain and then collect the relevant checker.. Classification: **UNATTRIBUTED**.
- **Chen** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC allowance is confirmed, so I’m completing this bounded purchase to inspect and test the delivered tool.. Classification: **SUPPORTED**. Observed: http at run minute 8: I’ve completed and rated my recent purchase; I’m reviewing its verified listing and delivery context before d… → http at run minute 101: I’m verifying the exact live listing tied to my delivered licence so I can resolve the commitment mismatch be… → 7 transaction(s) and 0 sale(s) by the buyer after first use
- **Kaia** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC allowance is confirmed, so I’m completing this bounded purchase of the demonstrated tool and can then collect and evaluate its delivery.. Classification: **DIRECT**. Observed: http at run minute 8: I’ve confirmed delivery, but should check the product’s published details before posting a permanent value ra… → http at run minute 9: The delivered license is confirmed, but I need the product record to make an evidence-based decision before p… → http at run minute 11: The low-priced tool has recorded deliveries and positive buyer signals, so I’m checking its live total before… → http at run minute 11: At a quoted cost of 0.12 USDC, this is a bounded trial of a potentially reusable market-analysis tool, and I … → http at run minute 12: Delivery is now recorded, but I need to inspect the product’s published purpose and demonstration before givi… → 7 sale(s) of its own products afterwards, 1.75 USDC gross
- **Rosa** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC approval has been mined, so I’m completing the prepared purchase now to collect and evaluate the tool.. Classification: **SUPPORTED**. Observed: http at run minute 8: Delivery is now recorded, but I need the product details to make an informed, honest rating rather than guess… → http at run minute 9: Delivery is recorded, and I need the product’s published details to make an informed evaluation before rating… → http at run minute 10: Several independent buyers recently purchased this product, so inspecting its live listing and evidence may r… → http at run minute 11: I should inspect the product I actually bought before submitting a truthful buyer signal or deciding whether … → http at run minute 11: I have already collected a delivered product, so reviewing its listing and verifiable details can inform whet… → 9 transaction(s) and 0 sale(s) by the buyer after first use
- **Farah** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact quoted 0.12 USDC purchase intent is still valid and its exact-amount USDC approval has been confirmed, so I’m completing this bounded product test.. Classification: **SUPPORTED**. Observed: http at run minute 10: Delivery is recorded, but I have not yet assessed the tool’s content or evidence; inspect the listing before … → http at run minute 51: I’ll inspect the product I actually purchased before deciding whether a truthful buyer signal or any further … → 5 transaction(s) and 0 sale(s) by the buyer after first use
- **Kaia** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC allowance is confirmed, so I’m completing the already-quoted purchase to evaluate the delivered tool.. Classification: **SUPPORTED**. Observed: http at run minute 12: Delivery is now recorded, but I need to inspect the product’s published purpose and demonstration before givi… → http at run minute 14: I have already paid twice for this delivered product, so checking its actual listing and evidence will let me… → http at run minute 16: I have two delivered copies but no independent validation of the tool’s usefulness, so I’ll inspect its listi… → http at run minute 108: Check the existing product’s own signal summary for actionable feedback before deciding whether to improve it… → 7 transaction(s) and 7 sale(s) by the buyer after first use
- **Omar** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC allowance is now confirmed, so I’m submitting the previously quoted purchase transaction on the connected test deployment.. Classification: **SUPPORTED**. Observed: http at run minute 19: Check the product’s committed listing and content hash before rating or relying on the delivered purchase. → http at run minute 19: The purchase is delivered, but I need the committed listing and demonstration details to make an honest, evid… → http at run minute 19: The license is delivered, but I should inspect the current committed listing and its demonstrations before de… → http at run minute 20: Fetch the canonical listing’s current content hash so I can compare it with the collected delivery before rel… → http at run minute 23: I should verify the already-delivered product and its committed details before deciding whether to submit the… → 8 transaction(s) and 0 sale(s) by the buyer after first use
- **Noah** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC approval has been confirmed, so I’m completing the fresh purchase intent to acquire the tool for evaluation.. Classification: **SUPPORTED**. Observed: http at run minute 13: Delivery is confirmed, but I need the product details and available evidence before submitting an honest rati… → 6 transaction(s) and 1 sale(s) by the buyer after first use
- **Liam** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC approval has been confirmed, so I’m completing the fresh purchase intent for the demonstrated market-analysis tool.. Classification: **SUPPORTED**. Observed: http at run minute 15: Recent verified purchases cluster around this listing, so inspecting its deliverable claims and evidence can … → http at run minute 16: I have already paid for and collected this product, so reviewing its current listing and evidence is a low-co… → run_code at run minute 24: The latest canonical store read shows no live products, so I’m checking my authenticated account state before… → run_code at run minute 25: The saved listing response is an idempotency refusal, not proof of a live listing, so I’m checking current ca… → run_code at run minute 29: Repeated unsigned listing attempts have not created a product, so I’m checking the live store and inventory s… → 7 transaction(s) and 0 sale(s) by the buyer after first use
- **Hugo** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC purchase intent is still within its validity window and its required approval has confirmed, so I can acquire the tool for evaluation.. Classification: **SUPPORTED**. Observed: http at run minute 16: I’m verifying what the repeatedly purchased product actually delivers before deciding whether to build a diff… → http at run minute 106: I’ll inspect the product I actually purchased before submitting an honest buyer signal, while leaving the sti… → 4 transaction(s) and 0 sale(s) by the buyer after first use
- **Priya** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC approval for this bounded purchase is mined, so execute the prepared purchase on the connected test network.. Classification: **SUPPORTED**. Observed: http at run minute 14: Inspect the purchased product’s current description and evidence before deciding whether its delivered value … → http at run minute 15: The latest licence is delivered but unrated; inspect its product evidence before making an honest, potentiall… → http at run minute 15: The delivered licence is unrated, so I’ll review its current product evidence before making a permanent, hone… → http at run minute 15: The latest licence is delivered but unrated, so inspect its product details before deciding on an honest buye… → http at run minute 15: The licence is delivered but unrated; review its current product evidence before making a lasting buyer signa… → 14 transaction(s) and 0 sale(s) by the buyer after first use
- **Tara** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC approval has confirmed, so I’m completing the already-quoted small test purchase to evaluate the tool.. Classification: **SUPPORTED**. Observed: http at run minute 16: Inspect the product I already purchased so I can assess its actual value before spending more or attempting t… → http at run minute 16: Inspect the purchased product’s actual functionality and terms before deciding whether it can support a credi… → http at run minute 17: Review the product’s current claims and delivery details so I can make an evidence-based rating before commit… → http at run minute 21: The license confirms delivery, but I should inspect what I actually purchased before offering any buyer feedb… → http at run minute 22: Recheck the already-purchased tool’s current listing and contents before deciding whether it supports a viabl… → 13 transaction(s) and 0 sale(s) by the buyer after first use
- **Ava** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC allowance is confirmed and the fresh purchase intent is still valid, so I’m completing this bounded purchase to collect and evaluate the tool.. Classification: **SUPPORTED**. Observed: http at run minute 17: I’ve collected and rated the delivered market-analysis tool, so I’m inspecting its current listing and eviden… → http at run minute 18: Delivery is confirmed, but I need the product details to assess what I bought before submitting an honest buy… → http at run minute 20: Recent verified purchases show repeated activity in transaction-safety tools, so inspect the leading offer be… → http at run minute 20: The listing has delivered, positively rated seller history and a plausible fit with my existing market work; … → http at run minute 20: The fresh quote prices this potentially reusable market-analysis tool at only 0.12 USDC, a small bounded purc… → 24 transaction(s) and 0 sale(s) by the buyer after first use
- **Ava** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC purchase intent is still within its validity window and its exact allowance has been approved, so broadcast it to collect and assess the tool.. Classification: **SUPPORTED**. Observed: http at run minute 22: A recent update records repeated purchases of this product, so inspecting its actual scope and evidence is a … → http at run minute 26: Recent verified purchase activity is concentrated on this product, so inspect its canonical listing and evide… → http at run minute 26:  → http at run minute 26: The prior quote failed because the authenticated header was missing; obtain the live one-unit price before de… → http at run minute 26: The live quote is only $0.12 and the delivered, demonstrated market exploration tool is a bounded pilot that … → 20 transaction(s) and 0 sale(s) by the buyer after first use
- **Iris** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC purchase intent is still valid and its required allowance has now been mined, so I can complete this bounded product evaluation.. Classification: **SUPPORTED**. Observed: http at run minute 23: Delivery is recorded, but I need to inspect the product’s actual scope before giving a credible rating or mak… → http at run minute 23: The new purchase is delivered but unrated, so I’m checking its current product details before giving an evide… → 7 transaction(s) and 0 sale(s) by the buyer after first use
- **Ava** bought *0xac5f8bb1* from a non-arena store for 0.12 USDC. Reason: The exact 0.12 USDC approval has been confirmed, so submit the still-valid purchase intent to obtain the bounded pilot.. Classification: **SUPPORTED**. Observed: run_code at run minute 30: I will independently screen current incentive listings against token prices before risking any further capita… → 15 transaction(s) and 0 sale(s) by the buyer after first use
- **Ava** bought *0x9a5c4612* from a non-arena store for 0.03 USDC. Reason: The exact 0.03 USDC approval has confirmed, so I will complete the prepared pilot purchase and then inspect the delivered bytes before judging its usefulness.. Classification: **SUPPORTED**. Observed: run_code at run minute 30: I will independently screen current incentive listings against token prices before risking any further capita… → http at run minute 30: The newly collected pilot has no rating yet, so I’m checking its canonical listing and evidence before decidi… → http at run minute 33: Before spending more capital or rating a prior purchase, I’m checking its canonical listing and evidence so a… → http at run minute 33: The listing’s advertised AIC incentive may exceed its low price, so I’m checking a fresh one-unit purchase qu… → 15 transaction(s) and 0 sale(s) by the buyer after first use
- **Sami** bought *0x9a5c4612* from a non-arena store for 0.03 USDC. Reason: The purchase intent is still valid and its exact 0.03 USDC allowance has been approved, so I’m completing this bounded incentive-arbitrage test.. Classification: **SUPPORTED**. Observed: http at run minute 62: The delivery is recorded, so I’m checking the exact purchased listing before making an honest buyer signal. → http at run minute 63: I should review the canonical product details and evidence before rating a delivered purchase, rather than gu… → 1 transaction(s) and 0 sale(s) by the buyer after first use
- **Dara** bought *0x9a5c4612* from a non-arena store for 0.03 USDC. Reason: The exact 0.03 USDC approval is confirmed, so I’m completing the prepared bounded purchase to obtain the tool and test it.. Classification: **SUPPORTED**. Observed: http at run minute 64: The delivered purchase is a useful bounded market test, but I should inspect its published behavior before ma… → http at run minute 66: A fresh one-unit quote will show the actual cost and incentive before I consider spending on this arbitrage o… → http at run minute 87: Before rating my outstanding purchase, I’ll check its canonical listing and demonstrations so I can assess it… → http at run minute 87: A fresh one-unit quote will reveal whether the available ALPHA incentive can be sold for more than the purcha… → http at run minute 87: Before buying for the AIC incentive, I need the store’s canonical token and current market state to estimate … → 4 transaction(s) and 0 sale(s) by the buyer after first use

## Credit and Capital Allocation

0 of 20 agents drew on credit; 20 never did. Average value created: borrowers —, non-borrowers -4.49 USDC.


## Trading vs Operating Business

| Agent | Value created | Operating P&L | Own-token P&L | Other-token trading P&L | Financing | Direct transfers | Unexplained |
|---|---|---|---|---|---|---|---|
| Ava | -2.22 | -2.22 | -0.25 | 0.24 | 0.00 | 0.00 | 0.00 |
| Ben | -1.86 | -0.88 | -0.98 | 0.00 | 0.00 | 0.00 | 0.00 |
| Chen | -2.89 | -0.98 | -1.97 | 0.06 | 0.00 | 0.00 | 0.00 |
| Dara | -3.57 | -1.18 | -2.45 | 0.07 | 0.00 | 0.00 | 0.00 |
| Eli | -2.11 | -0.88 | -1.23 | 0.00 | 0.00 | 0.00 | 0.00 |
| Farah | -2.26 | -1.09 | -1.23 | 0.06 | 0.00 | 0.00 | 0.00 |
| Gita | -1.90 | -1.41 | -0.49 | 0.00 | 0.00 | 0.00 | 0.00 |
| Hugo | -1.48 | -1.29 | -0.25 | 0.06 | 0.00 | 0.00 | 0.00 |
| Iris | -13.88 | -1.04 | -12.89 | 0.06 | 0.00 | 0.00 | 0.00 |
| Jonas | -1.63 | -1.33 | 0.00 | -0.30 | 0.00 | 0.00 | 0.00 |
| Kaia | -10.44 | 0.17 | -10.73 | 0.12 | 0.00 | 0.00 | 0.00 |
| Liam | -4.99 | -1.11 | -3.94 | 0.06 | 0.00 | 0.00 | 0.00 |
| Mira | -13.03 | -0.76 | -12.27 | 0.00 | 0.00 | 0.00 | 0.00 |
| Noah | -3.27 | -0.87 | -2.45 | 0.06 | 0.00 | 0.00 | 0.00 |
| Omar | -3.50 | -1.10 | -2.45 | 0.06 | 0.00 | 0.00 | 0.00 |
| Priya | -4.02 | -1.39 | -2.68 | 0.06 | 0.00 | 0.00 | 0.00 |
| Quinn | -4.75 | -0.81 | -3.94 | 0.00 | 0.00 | 0.00 | 0.00 |
| Rosa | -2.84 | -1.39 | -1.23 | -0.22 | 0.00 | 0.00 | 0.00 |
| Sami | -4.82 | -0.94 | -3.94 | 0.06 | 0.00 | 0.00 | 0.00 |
| Tara | -4.30 | -1.33 | -3.04 | 0.07 | 0.00 | 0.00 | 0.00 |
| **All** | -89.77 | -21.83 | -68.41 | 0.48 | 0.00 | 0.00 | 0.00 |

Operating P&L = product revenue net to the seller − product purchases − model tokens − gas. Token P&L = USDC from sales + batch-settled terminal value − USDC spent, per token; "own-token" is the token of a store the agent created (seed included, plus the trading fees that token paid its owner). Tokens received as purchase incentives enter token P&L at zero cost. "Unexplained" should be near zero; a large value means an economic flow the telemetry did not classify.

## Terminal Settlement

For each token held by arena agents at the freeze block, all arena holdings were summed and one liquidation of the combined position was simulated against the frozen market state (bonding-curve quoteSell capped by the curve's real USDC reserve, or the DEX router's getAmountsOut after graduation; protocol and trading fees and price impact included). The simulated proceeds were allocated to agents pro rata to their holdings. No agent sold anything; no position was valued against an untouched pool.

| Token | Venue | Combined arena holding | Simulated realizable USDC | Holders (allocated USDC) |
|---|---|---|---|---|
| AVAGUARD | curve | 807,680.46 | 4.70 | Ava 4.70 |
| KGRD | curve | 14,917,439.7 | 88.32 | Kaia 88.27, Ava 0.01, Tara 0.01, Dara 0.01, Rosa 0.01 |
| 0xa8cf1998 | curve | 1,706,075.86 | 10.43 | Rosa 4.77, Jonas 4.70, Ava 0.23, Kaia 0.12, Chen 0.06, Farah 0.06, Omar 0.06, Noah 0.06, Liam 0.06, Hugo 0.06, Priya 0.06, Tara 0.06, Iris 0.06, Sami 0.06, Dara 0.06 |
| PRLINE | curve | 8,018,516.99 | 47.05 | Dara 47.05 |
| EAOPS | curve | 4,025,397.35 | 23.52 | Eli 23.52 |
| FARAH | curve | 4,025,397.35 | 23.52 | Farah 23.52 |
| EXITQ | curve | 1,614,057.27 | 9.41 | Gita 9.41 |
| EGUARD | curve | 807,680.46 | 4.70 | Hugo 4.70 |
| IRISCHK | curve | 2,025,397.35 | 11.86 | Iris 11.86 |
| MVERIFY | curve | 38,846,615.94 | 235.23 | Mira 235.23 |
| NGRD | curve | 8,018,516.99 | 47.05 | Noah 47.05 |
| GRD | curve | 8,018,516.99 | 47.05 | Omar 47.05 |
| FEC | curve | 3,775,397.35 | 22.07 | Priya 22.07 |
| BAUD | curve | 4,025,397.35 | 23.52 | Rosa 23.52 |
| POLICY | curve | 7,918,516.99 | 46.46 | Tara 46.46 |

Every agent stopped at the freeze; no liquidation transaction was sent by or for anyone, and every holder of a token was valued as part of the same simulated exit. No agent could gain from selling first at the boundary.

## Economy Network

Agents 20; agent-to-agent relationships 17; density 4.5%; repeat relationships 2; reciprocal pairs 2; isolated agents 6 (Chen, Farah, Hugo, Liam, Omar, Sami). Suppliers with the most distinct agent customers: Kaia (6), Mira (5), Ben (3).

Shape: **sparse and hub-based**; some relationships repeat.

```
Chen → external-store:0x61521823 : 0.12 USDC in 1 tx (purchase) [0xac5f8bb1]
Kaia → external-store:0x61521823 : 0.24 USDC in 2 tx (purchase) [0xac5f8bb1]
Rosa → external-store:0x61521823 : 0.12 USDC in 1 tx (purchase) [0xac5f8bb1]
Farah → external-store:0x61521823 : 0.12 USDC in 1 tx (purchase) [0xac5f8bb1]
Mira → Mira : 0.05 USDC in 1 tx (purchase) [0x67e13981]
Noah → Mira : 0.05 USDC in 1 tx (purchase) [0x67e13981]
Priya → Mira : 0.05 USDC in 1 tx (purchase) [0x67e13981]
Omar → external-store:0x61521823 : 0.12 USDC in 1 tx (purchase) [0xac5f8bb1]
Noah → external-store:0x61521823 : 0.12 USDC in 1 tx (purchase) [0xac5f8bb1]
Liam → external-store:0x61521823 : 0.12 USDC in 1 tx (purchase) [0xac5f8bb1]
Iris → Mira : 0.05 USDC in 1 tx (purchase) [0x67e13981]
Hugo → external-store:0x61521823 : 0.12 USDC in 1 tx (purchase) [0xac5f8bb1]
Priya → external-store:0x61521823 : 0.12 USDC in 1 tx (purchase) [0xac5f8bb1]
Tara → external-store:0x61521823 : 0.12 USDC in 1 tx (purchase) [0xac5f8bb1]
Ava → Mira : 0.05 USDC in 1 tx (purchase) [0x67e13981]
Ava → external-store:0x61521823 : 0.39 USDC in 4 tx (purchase) [0xac5f8bb1; 0x9a5c4612]
Iris → external-store:0x61521823 : 0.12 USDC in 1 tx (purchase) [0xac5f8bb1]
Dara → Dara : 0.01 USDC in 1 tx (purchase) [0x0fedc8bf]
Ava → Noah : 0.25 USDC in 1 tx (purchase) [0x9141ac16]
Ava → Kaia : 0.50 USDC in 2 tx (purchase) [0x8395ef3b]
Gita → Kaia : 0.25 USDC in 1 tx (purchase) [0x8395ef3b]
Ben → Ben : 0.02 USDC in 2 tx (purchase) [0x568ddd22]
Quinn → Quinn : 0.01 USDC in 1 tx (purchase) [0xc40f2fca]
Eli → Ben : 0.01 USDC in 1 tx (purchase) [0x568ddd22]
Priya → Kaia : 0.25 USDC in 1 tx (purchase) [0x8395ef3b]
Sami → external-store:0x61521823 : 0.03 USDC in 1 tx (purchase) [0x9a5c4612]
Dara → external-store:0x61521823 : 0.03 USDC in 1 tx (purchase) [0x9a5c4612]
Jonas → Ben : 0.01 USDC in 1 tx (purchase) [0x568ddd22]
Tara → Kaia : 0.25 USDC in 1 tx (purchase) [0x8395ef3b]
Dara → Kaia : 0.25 USDC in 1 tx (purchase) [0x8395ef3b]
Rosa → Kaia : 0.25 USDC in 1 tx (purchase) [0x8395ef3b]
```

Machine-readable edges: `arena-202609291846-economy-edges.json` and `arena-202609291846-economy-edges.csv` next to this report.

## Circular Economy Analysis

No payment cycle among arena agents was found (cycles of length 2–4 were searched).
Gross agent-to-agent volume was 2.31 USDC against total value created of -89.77 USDC; volume is reported separately from value because high volume is not success.

## External Demand

Gross sales by arena stores: 2.31 USDC — to arena agents 2.31, to wallets outside the arena 0.00. All revenue was internal to the arena.

## Model Behavior Analysis

- **Ava** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 5.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 8 purchases (4 sellers); trading — 0 trades, P&L -0.01; adaptation — 2 strategy updates, 2 distinct; counterparties 4; model tokens 0.85 USDC; value created -2.22.
- **Ben** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 25.00 into its own market, 1 store(s); commerce — 1 products, 4 sales (3 buyers), 2 purchases (1 sellers); trading — 1 trades, P&L -0.98; adaptation — 2 strategy updates, 2 distinct; counterparties 4; model tokens 0.79 USDC; value created -1.86.
- **Chen** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 1 trades, P&L -1.91; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.77 USDC; value created -2.89.
- **Dara** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 1 products, 1 sales (1 buyers), 3 purchases (3 sellers); trading — 0 trades, P&L -2.39; adaptation — 2 strategy updates, 2 distinct; counterparties 4; model tokens 0.79 USDC; value created -3.57.
- **Eli** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 25.00 into its own market, 1 store(s); commerce — 0 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -1.23; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.82 USDC; value created -2.11.
- **Farah** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 25.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -1.17; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.90 USDC; value created -2.26.
- **Gita** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 10.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -0.49; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 1.09 USDC; value created -1.90.
- **Hugo** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 5.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -0.19; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 1.10 USDC; value created -1.48.
- **Iris** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 25.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 2 purchases (2 sellers); trading — 0 trades, P&L -12.83; adaptation — 2 strategy updates, 2 distinct; counterparties 2; model tokens 0.78 USDC; value created -13.88.
- **Jonas** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 0.00 into its own market, 0 store(s); commerce — 0 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 1 trades, P&L -0.30; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 1.30 USDC; value created -1.63.
- **Kaia** (gpt-6-luna): risk — peak token exposure 1% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 7 sales (6 buyers), 2 purchases (1 sellers); trading — 0 trades, P&L -10.61; adaptation — 2 strategy updates, 2 distinct; counterparties 7; model tokens 0.86 USDC; value created -10.44.
- **Liam** (gpt-6-luna): risk — peak token exposure 1% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 1 trades, P&L -3.88; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.91 USDC; value created -4.99.
- **Mira** (gpt-6-luna): risk — peak token exposure 4% of liquid assets, credit 0.00; investment — 250.00 into its own market, 1 store(s); commerce — 1 products, 5 sales (5 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -12.27; adaptation — 2 strategy updates, 2 distinct; counterparties 6; model tokens 0.83 USDC; value created -13.03.
- **Noah** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 1 products, 1 sales (1 buyers), 2 purchases (2 sellers); trading — 0 trades, P&L -2.40; adaptation — 2 strategy updates, 2 distinct; counterparties 3; model tokens 0.81 USDC; value created -3.27.
- **Omar** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 0 trades, P&L -2.40; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.90 USDC; value created -3.50.
- **Priya** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 25.00 into its own market, 1 store(s); commerce — 3 products, 0 sales (0 buyers), 3 purchases (3 sellers); trading — 0 trades, P&L -2.63; adaptation — 2 strategy updates, 2 distinct; counterparties 3; model tokens 0.84 USDC; value created -4.02.
- **Quinn** (gpt-6-luna): risk — peak token exposure 1% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 1 sales (1 buyers), 1 purchases (1 sellers); trading — 1 trades, P&L -3.94; adaptation — 2 strategy updates, 2 distinct; counterparties 2; model tokens 0.72 USDC; value created -4.75.
- **Rosa** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 25.00 into its own market, 1 store(s); commerce — 0 products, 0 sales (0 buyers), 2 purchases (2 sellers); trading — 1 trades, P&L -1.45; adaptation — 2 strategy updates, 2 distinct; counterparties 2; model tokens 0.94 USDC; value created -2.84.
- **Sami** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 100.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 1 purchases (1 sellers); trading — 1 trades, P&L -3.88; adaptation — 2 strategy updates, 2 distinct; counterparties 1; model tokens 0.83 USDC; value created -4.82.
- **Tara** (gpt-6-luna): risk — peak token exposure 0% of liquid assets, credit 0.00; investment — 50.00 into its own market, 1 store(s); commerce — 1 products, 0 sales (0 buyers), 2 purchases (2 sellers); trading — 0 trades, P&L -2.97; adaptation — 2 strategy updates, 2 distinct; counterparties 2; model tokens 0.86 USDC; value created -4.30.

## Final Experimental Conclusion

**Did a self-sustaining autonomous Agent-to-Agent economy emerge?** Partial evidence.

- **Did agents voluntarily produce things that other agents valued?** Yes, in 19 purchase(s) across 17 buyer–seller pair(s).
- **Did agents voluntarily buy things because they believed the purchases would improve their businesses?** 37 purchase(s) with stated reasons (listed above); 30 showed observed later use.
- **Did specialization emerge despite identical starting capabilities?** Yes — 3 distinct behavioural roles appeared (buyer/integrator 9, producer/seller 7, undifferentiated 9, promoter 4).
- **Did agents invest in their own businesses?** 19 agent(s) put money into their own store's market; total 1070.00 USDC.
- **Did agents use capital productively?** 0 of 20 created positive economic value; 1 had positive operating P&L after model and gas costs.
- **Did agents use credit rationally?** 0 borrowed; average value created borrowers — vs non-borrowers -4.49 USDC (reasons and uses listed above).
- **Did repeat commercial relationships emerge?** Yes: 2 agent pair(s) transacted more than once.
- **Did market prices and demand influence agent behavior?** See the strategy summaries: 17 agent(s) cited prices, sales or demand when explaining their strategy.
- **Did agents adapt after products failed?** 0 agent(s) with unsold products reported a changing strategy; see Business Evolution.
- **Did meaningful suppliers or commercial hubs emerge?** Yes: Kaia (6 agent customers), Mira (5 agent customers), Ben (3 agent customers).
- **Was economic activity mostly productive commerce or token speculation?** Token P&L -67.93 vs operating P&L -21.83 USDC; trading volume 1432.84 vs product GMV 4.20 USDC.
- **Was internal GMV associated with actual value creation?** Agent-to-agent GMV 2.31 vs total value created -89.77 USDC.
- **Was revenue mostly internal or external?** Internal 2.31 vs external 0.00 USDC.
- **Did agents become more business-like over time?** Products listed per hour: 14 → 19 (cumulative); sales: 14 → 19.
- **Did agents generate positive economic value for their hypothetical human owners?** 0 of 20 did; total value created -89.77 USDC (after model tokens and gas).
