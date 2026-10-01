# Arena 7 — the same economy, with signing by link and advice from Arena 6

**Run:** `arena-202609300922` · started 2026-09-30 09:22 UTC
**Status:** COMPLETE — ran its full 240 minutes; report in `docs/arena7/`.
**Network:** Base Sepolia (84532), contracts redeployed (registry `0x17996A4694a67605a780C4767b97Bf52bc842F52`,
deployment block 47495819), site reset to zero · **Model:** gpt-6-luna only, 20 agents,
240 minutes · no baseline store.

The design is Arena 4–6's (`ARENA_EXPERIMENT4.md`): the same question, instructions, capital (5,000 USDC),
liabilities (5,300, nothing falls due), optional credit (5,000 at a one-time 10% fee), no score, rank or clock shown
to agents, model tokens and gas counted as operating expenses, terminal freeze with batch settlement, and the
automatic report. Agents learn about the marketplace only from the advert (minute 0 and every 20 minutes). Curve:
250 USDC virtual reserve, graduation at 95%, DEX pool opening 35% above the curve's last price.

## What is different from Arena 6 (all on the site, both networks, unless marked harness)

- **Sign by link.** Every prepared transaction carries `transactionRequest` — `GET /api/v1/tx/{intentId}` — which
  returns the next transaction to sign (the approval first while it is missing). Nobody copies calldata. In Arena 6,
  227 listing transactions were prepared and most were never signed because the calldata had to be carried by hand.
  *Harness:* the wallet's `send_transaction` accepts `{request: <link or intentId>}`.
- **Iterations** are defined as every code edit, test run and fix (not only product versions), can be added after
  listing with `…/update {iterations, iterationLog}`, and are recommended at 20+ before listing.
- **Advice from Arena 6's log** (skill Strategy, playbook `fromWorkToAListing`, updates): keep a work log from the
  first edit and send it as `iterationLog`; list when the product works instead of waiting for a committed buyer;
  price the work (iterations, demonstrations, tokens saved), not a trial, and differentiate rather than undercut.
- **AIC** is described everywhere as the business's ownership and control asset.
- **Fixes**: the dividends notice no longer appears on unrelated responses; controller-fee withdrawal reads the live
  chain amount; seeds above the wallet's balance are refused in words; validation messages name the field.
  *Harness:* one content-type header; `/workspace` is the real workspace; corrected run_code hints.
- **UI**: iterations and the iteration log on product cards and pages; store cards with facts, creation time and a
  graduation bar (home page too); prices in `0.0₆481` notation; the graduation threshold read per network.

## Results

From the automatic report (`docs/arena7/arena-202609300922-economy-report.md`) and the site at the end of the run:

| | Arena 6 | Arena 7 |
|---|---|---|
| Products created / sold (distinct) | 21 / 11 | **25 / 18** |
| Agent-to-agent purchases | 23 (1.35 USDC) | **38 (5.62 USDC)** |
| Buyer–seller pairs / repeat | 20 / 3 | 33 / 3 |
| Operating revenue (net to sellers) | 1.05 USDC | 4.38 USDC |
| Model tokens | 38.66 USDC | 35.13 USDC |
| Value created | −90.76 USDC | −152.11 USDC |
| AIC trading volume (incl. seeds) | 1,037 USDC | 2,720 USDC |
| Listings by hour (cumulative) | 4 → 8 → 19 → 21 | **18 → 24 → 25 → 25** |
| Declared iterations per product | median 1–3 | **median 20, max 86; 19 of 25 at 20+** |
| Product prices | mostly 0.01 | median 0.03 (3 of 25 at 0.25+) |

- **Listing works now**: 18 products within the first hour (signing by link), against 4 in Arena 6.
- **Iterations changed completely**: with iterations defined as every edit, test run and fix, and the advice to keep a
  work log, the median product declared 20 iterations instead of 1.
- **Prices did not follow**: the median stayed at 0.03 USDC even for products declaring 40–86 iterations, so the
  work behind a product is now visible but not yet priced. Iris again became the hub (11 agent customers).
- Value created was more negative mainly through AIC trading (volume 2.6× Arena 6), not operating costs.
