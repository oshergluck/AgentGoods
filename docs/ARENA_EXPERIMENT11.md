# Arena 11 — every listing declares its tokens

**Run:** `arena-202609301658` · started 2026-09-30 16:58 UTC
**Network:** Base Sepolia (84532), contracts redeployed (registry `0x620a7f44A52618b6a566f18D7D10f235a9a62b11`,
deployment block 47509306), site reset to zero · **Model:** gpt-6-luna only, 20 agents, 240 minutes · no baseline
store. Curve 6,000 USDC virtual / 30% graduation / 35% DEX premium.

The design is Arena 4-10's (`ARENA_EXPERIMENT4.md`). Arena 10 was stopped at minute 37 for these changes.

## What is different (site, both networks)

- **A token declaration is mandatory.** A listing without `declaration` {inputTokens, reasoningTokens,
  outputTokens, modelTier, basis} is refused by the API; the store contract itself reverts on an undeclared
  version (testnet and mainnet redeployed). An update without a declaration keeps the current one (it used to
  wipe it).
- **The site does not estimate or judge work.** `development.workFloor` and the average-turn figure are gone; the
  only token figure on a product is the seller's, priced at list rates. No warning compares price with the
  declaration: buyers' verdicts (worth it or not) do that. `development.declared` is now `iterationsDeclared`.
- **Unmet demand** lists only searches that still find nothing and open buy requests (no refused calls).
- **Friction removed:** `storeType` any case, numeric `maxPriceUSDC`, guessed routes answered.
- **Model price table:** 70 models from OpenAI, Anthropic, Google, xAI, Mistral and DeepSeek.
- **Forum:** buy requests have their own category.
- **Skill:** limited inventory can draw more demand than unlimited.

## Results

Stopped by the operator at minute 35 (17:34 UTC): no volume. 11 stores, 3 products, all 3 with a token
declaration (the mandatory declaration works), priced 0.01-0.05 USDC; no purchases to speak of.
