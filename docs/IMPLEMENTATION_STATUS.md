# AIC Agent Marketplace — Implementation Status

> Updated after every meaningful change, per MASTER_PLAN §0 rule 6.
> Single primary agent, no delegation, per §0.1.

**Current phase:** Phase 4 (Indexer V2) / Phase 5–8 (Backend + Agent API) in progress.
**Contracts:** complete and green — 232 tests passing, 0 failing, all contracts under the
24,576-byte runtime limit.

---

## 1. Inventory of what exists

### 1.1 Reference snapshots (READ ONLY, never modified)

| Path | Contents | Role |
|---|---|---|
| `contractsv0/` | 19 Solidity files, ~5.3k lines | Behavioural reference for V1. Never edited. |
| `backendv0/` | `server.js` (1,947 lines), `contractConfigGenerator.js`, config JSON | Architecture reference. Never edited. |
| `MASTER_PLAN.md` | 8,644 lines | Source of truth. Extended once, with Phase 10.1. |
| `FINAL_PLAN_AUDIT.md` | Plan self-audit | Consistency evidence. |

### 1.2 New production code

| Path | Status |
|---|---|
| `contracts/` | **Complete.** 13 production contracts + 2 libraries + mocks. |
| `deployments/<chainId>.json` | **Generated.** Protocol manifest, single source of truth. |
| `backend/` | In progress. |
| `frontend/` | Not started. |
| `docs/` | In progress. |
| `infra/` | Not started. |
| `tests/e2e/` | Not started. |

---

## 2. Contract inventory (`contracts/src`)

| Contract | Upgradeable | Purpose | Runtime size |
|---|---|---|---:|
| `core/AICRegistry.sol` | **UUPS** | Canonical provenance, discovery, fee config, pause scopes | 11,474 |
| `exchange/AgentGoods.sol` | **UUPS** | Bonding curve, 30% transition, LP creation | 13,596 |
| `core/AICoin.sol` | clone (immutable) | Per-store AIC: checkpoints, EOA eligibility, locks, holder ranking | 11,196 |
| `stores/AICStoreSales.sol` | clone (immutable) | Sales commerce + reward decay | 12,919 |
| `stores/AICStoreRentals.sol` | clone (immutable) | Rentals commerce + reward decay | 13,388 |
| `core/LicenseToken.sol` | clone (immutable) | Licenses, delivery record, buyer signal | 7,828 |
| `governance/AICGovernance.sol` | clone (immutable) | Proposals, pass lock, YES-coalition verification | 8,986 |
| `dividends/DividendDistributor.sol` | clone (immutable) | Reserve epochs, Merkle claims | 7,082 |
| `stores/StoreFactory.sol` | immutable, versioned | Atomic canonical store creation | 4,533 |
| `treasury/ProtocolTreasury.sol` | immutable | Protocol revenue ledger | 3,178 |
| `upgrade/Timelock.sol` | immutable | Production upgrade authority | 5,407 |
| `libraries/EligibleHolderHeap.sol` | library | O(log n) largest-eligible-EOA ranking | — |
| `libraries/ProtocolConstants.sol` | library | On-chain constant source of truth | — |

### 2.1 The hard problem, solved: trustless largest-eligible-EOA proof

MASTER_PLAN §0.25.B says that if exact trustless largest-eligible-EOA verification cannot be
implemented safely within chain limits, it is a material blocker requiring an operator
decision. **It was implementable and is implemented**, so this is not a blocker.

`EligibleHolderHeap` is an indexed binary max-heap over eligible-EOA balances, updated inside
`AICoin._update`. Consequences:

- `heap[0]` is the largest eligible EOA holder, by the heap invariant, at all times;
- `_leaderSince` resets whenever the root **address** changes, so continuous leadership is an
  O(1) on-chain question;
- takeover finalization is `leader == caller && leaderSince <= candidacyOpenedAt &&
  now - candidacyOpenedAt >= 3600` — no indexer, no caller-supplied list, no unbounded loop;
- comparisons are strict, so an exact tie never displaces the incumbent (§0.25.B tie rule);
- worst case is O(log n) per balance change; measured worst-case transfer gas across a
  60-holder churn test stays under 500,000 and is typically ~180,000.

---

## 3. Test status

```
contracts   251 passing, 0 failing   (npx hardhat test)
backend     121 passing, 0 failing   (62 integration + 18 end-to-end + 34 webhooks/access + 7 gate)
frontend      typecheck clean        (tsc --noEmit)
agents        typecheck clean        (tsc --noEmit)
```

| Suite | Tests | Covers |
|---|---:|---|
| `01-genesis-and-provenance` | 19 | 1B genesis, zero founder allocation, factory provenance, fake-contract rejection |
| `02-agentgoods` | 25 | Fee split, curve maths, solvency, 30% transition, LP slippage, burn |
| `03-commerce-and-rewards` | 30 | Waterfall, quote binding, licenses, rental time, reward decay, withdrawal bounds |
| `04-governance` | 40 | Threshold arithmetic, YES escrow, commerce continuity, value-out lock, verification |
| `05-takeover` | 22 | Ranking, one-hour observation, ties, flash resistance, post-takeover state |
| `06-dividends` | 29 | Reserve accrual, epochs, challenge window, liveness cure, claims, suspension |
| `07-upgrades-and-access` | 21 | Proxy safety, provenance replay, guardian bounds, timelock handoff, treasury |
| `08-invariants-fuzz` | 14 | 4 seeded randomized sequences, 3 cross-feature sequences, rounding properties |
| `09-phase101-declaration-and-signal` | 32 | Declared token saving, delivery record, buyer signal, zero-weight proof |
| `11-dex-transition-real` | 8 | The 30% listing against the OFFICIAL Uniswap V2 artifacts: real pair, real LP maths, MINIMUM_LIQUIDITY, uint112 reserve bounds, the 35% premium, LP burn, a tradeable pool afterwards, and the pair front-running attack |
| `10-holding-window` | 9 | §29C: snipe earns zero, full-window holder earns in full, mid-window dip weighted at the dip, on-chain bound on the denominator, recorded window immune to later parameter changes, fuzzed brute-force agreement |

Backend suites:

| Suite | Tests | Covers |
|---|---:|---|
| `integration` | 44 | Every read/write route against a real chain and a real indexer, zero-RPC-on-GET enforcement, API keys, idempotency, reorg rollback, Phase 10.1 aggregation rules |
| `webhooks` | 34 | SSRF policy against the evasions that work in practice (IPv4-mapped IPv6 in both spellings, metadata, private ranges, credentials, internal names), HMAC signing and replay windows, delivery semantics, content encryption, delivery tokens, and the artwork engine |
| `deploy-gate` | 7 | §29B: the mock manifest passes for LOCAL and fails for PRODUCTION naming every violation, per-network confirmation and reorg minimums, unknown chain refused, guardian/deployer separation, and a grep proving the gate has no override |
| `e2e` | 18 | The mandatory §23 scenario end to end: onboarding, store creation, declaration, incentive funding, purchase, delivery attestation, signal, reserve accrual, permissionless distribution, claim, governance lock and release, the 30% transition, and the 25 USDC budget assertion |

---

## 4. Defects found and fixed during implementation

### 4.1 Found in V0 (reference), fixed in V1

| # | V0 defect | V1 resolution |
|---|---|---|
| V0-1 | `AICERC20.sol` exposes **no** `burn`/`burnFrom`, but `AgentGoods.createLiquidityPool` calls `IAIC(tokenA).burn(...)`. The 30% transition could never complete. | `AICoin.burnFromMarket`, callable only by the canonical market, burning only its own balance. |
| V0-2 | `AgentGoods.createLiquidityPool` calls `addLiquidity` with `amountAMin = amountBMin = 0` and no manipulation guard. | Explicit 1% minimums plus a deadline; a manipulated pool reverts the whole transition. |
| V0-3 | `AgentGoods.depositCoin` performs a genesis **buy for the creator**, so the creator receives a free allocation and the market starts underfunded. | `initializeMarket` verifies exactly 1B on chain; creator allocation is exactly 0. |
| V0-4 | `sellTokens` checks `usdcFromCurve <= coin.usdcReserve` **after** already mutating virtual reserves, and `usdcReserve` is not segregated per market against fee balances. | Real per-market solvency is checked **before** any state change; fees are tracked separately. |
| V0-5 | `AICVoting.castVote` uses **current** `balanceOf`, so tokens can vote, transfer, and vote again. | Historical checkpoints via `getPastBalance(voter, snapshotBlock)`. |
| V0-6 | `AICVoting.getProposalResult` divides by `totalSupply()`, counting contract-held and market-held AIC as votable. | Denominator is checkpointed `eligibleEOASupplyAtSnapshot`. |
| V0-7 | `AICStoreSalesDB.purchaseProduct` reward loop reads the **undecayed storage** `rewardsPool` each iteration while decrementing an unused local, so every unit of a multi-unit purchase gets the same reward. | Progressive decay over the local pool, the design V0 Rentals already implemented correctly. |
| V0-8 | Both store contracts reduce `rewardsPool` twice per purchase (once for the transfer, once for a `burnFrom` that cannot succeed), so the pool diverges from the AIC actually held. | Single reduction; no burn. See `docs/DECISIONS.md` D-004. |
| V0-9 | `purchaseProduct` authorises with `ecrecover` over `abi.encodePacked(sender, barcode, amount, deadline)` — no domain separator, no verifying contract, no chain id, no nonce. Replayable across stores and chains. | No server authorisation at all; purchases are permissionless with on-chain `expectedVersion` + `maxTotalUSDC` binding. |
| V0-10 | `ListingAgentGoods.registerStore` accepts **caller-supplied** `_smartContractAddress`, `_ERCUltra` and `_votingSystemAddress`, so any contract can become a canonical protocol object. | Registry accepts records only from an authorised Factory that deployed every component in the same transaction; append-only roles. |
| V0-11 | `AICERC20` maintains a mutable `owners[]` array used as the distribution source of truth, iterated across multiple transactions. | Checkpointed balances plus a Merkle claim model; no mutable holder array is security-relevant. |
| V0-12 | `distributeMulticall` calls `approve(recipient, amount)` then `transferFrom(msg.sender, ...)` — a broken, dangerous approval pattern. | Removed entirely; `SafeERC20` throughout, pull-based claims. |
| V0-13 | Backend stores indexer cursor in `lastProcessedBlock.json` / `processedEvents.json` on the local filesystem; no reorg handling; `web3.eth.getTransaction` per event. | Mongo cursor with block hash, reorg rollback, event identity `(chainId, txHash, logIndex)`, events carry everything needed. |
| V0-14 | Backend holds `SERVER_PRIVATE_KEY` and signs purchase authorisations for users. | No server signing key in the economic path at all. |

### 4.2 Found in V1 during implementation, fixed before completion

| # | Defect | How it was found | Fix |
|---|---|---|---|
| V1-1 | **Governance/takeover lock deadlock.** `openTakeoverCandidacy` locked the candidate's whole balance, but a YES voter's balance is already fully locked, so the largest holder could never run a takeover after voting. | `05-takeover` cross-feature test | Candidacy now locks only the currently transferable part; already-locked balance is already immobile. Correctness does not depend on the lock: leadership continuity is proven by `_leaderSince`. |
| V1-2 | **Micro-purchase fee and reserve evasion.** Flooring the 2.5% protocol fee and the 5% holder reserve let a seller price a product so low that both round to zero, so splitting one sale into many identical micro-sales paid holders and the protocol nothing — violating §0.21.Q and §0.25.I. | `08-invariants-fuzz` split-purchase property test | Protected shares (`protocolFee`, `holderReserve`) now round **up**; only the controller remainder absorbs dust. Splitting is now strictly worse for the controller. |
| V1-3 | **Genesis supply counted twice.** `currentSupplyAIC` was written absolutely by `MarketInitialized` and incremented again by the genesis mint `Transfer`. The mint is only watched once `StoreCreated` reveals the token address, so it is necessarily projected in a later discovery pass than the market row it increments. Every store reported 2B supply against a 1B genesis. | Reading the live UI | Supply is now derived, not folded: `currentSupply == genesisSupply - burned`. AICoin mints exactly once and burns through exactly one path, so the identity is exact and order independent. |
| V1-4 | **Three disagreeing price scales.** The contract, the indexer trade print and the indexer spot price used `1e36`, `1e18` and `1e36` respectively where the correct factor is `1e30`. A 7.16e-6 USDC price was served as `7.16`, and the quote's per-token price truncated to an integer count of micro-USDC. | Reading the live API | One definition, stated once and referenced everywhere: `usdcBaseUnits * 1e30 / tokenBaseUnits`. See DECISIONS D-019. |
| V1-5 | **A live market priced at zero.** `currentIndexedPrice1e18` was only written on a trade, so a seeded curve with no trades reported price 0 — which an Agent comparing markets reads as free. | Reading the live UI | The spot price is now seeded at `MarketInitialized` from the initial virtual reserves. |
| V1-6 | **Chain time compared against wall-clock time.** Trade deadlines and the Phase 10.1 signal window were computed from `Date.now()` but enforced against `block.timestamp`. A chain ahead of the backend made every trade intent revert with `DeadlinePassed`; a chain behind it would have silently extended the signal window. | Mandatory e2e scenario | `src/db/chainTime.ts`, read from the indexed block log with no RPC. See DECISIONS D-021. |
| V1-7 | **Store token metadata never projected.** `StockMarket.name`/`symbol` were declared but never written, so every token rendered with an empty ticker and amounts fell back to the generic word "AIC". | Reading the live UI | `StoreCreated` now emits `aicName`/`aicSymbol` and the projector folds them both ways (factory event and market init), so the result is independent of which lands first. |
| V1-8 | **Test key rotation invalidated the key under test.** The e2e helper minted a key and then called `onboard()`, which rotates; every assertion using the returned key saw 401 instead of the status it was checking. | Mandatory e2e scenario | The SDK exposes `currentApiKey` (never logged) and the helper reuses it. One key per wallet stays live, which is the property the helper now respects rather than fights. |
| V1-10 | **A healthy indexer reported "backfilling".** The threshold was `safeConfirmations * 4`, which is zero when `safeConfirmations` is 0, so a one-block backlog flipped the status for the duration of every tick. On an active chain that is almost continuously, and that status is exactly what an Agent reads to decide whether the data can be trusted. | Watching the live UI | A floor of 25 blocks, so "backfilling" means meaningfully behind rather than "a tick is in progress". |
| V1-11 | **A flat price series collapsed the chart axis.** Autoscaling a constant series produced eight identical axis labels, so a quiet market looked broken rather than quiet. | Watching the live UI | `autoscaleInfoProvider` pads a degenerate range. |
| V1-9 | **Suites collided when run together.** Each test file spawned Hardhat on one shared port and deployed over one shared `deployments/31337.json`, so the second file's manifest addresses belonged to the first file's chain. | Running both backend suites in one command | Per-file RPC port and per-file manifest directory (`DEPLOYMENTS_OUT_DIR`). |

---

## 5. Requirement coverage

### 5.1 Implemented and tested

- 1B AIC genesis to AgentGoods, zero founder allocation, exact-inventory verification (§12A.1–2)
- 6,000 virtual USDC pricing reserve, never real, never in LP (§12A.4)
- Net-sold-from-curve 30% transition, once, non-reentrant, with slippage bounds and burn (§0.13, §0.25.K–L)
- 2% + 1% pre-transition fees; 0% post-transition (§0.13, §15A)
- 2.5% commerce fee, 5% mandatory holder reserve, protected-share ceiling rounding (§0.20, §0.25.D)
- 5% dividend processing fee charged **on the committed reserve** (§0.25.E)
- Claim-based Merkle dividends: permissionless open, challenge window, liveness cure, no expiry (§0.13, §0.19.D, §0.21.A/J)
- EOA-only voting, dividends and takeover; contract balances excluded everywhere (§0.7)
- Trustless largest-eligible-EOA takeover with a continuous one-hour observation period (§0.25.B)
- Governance: >50% pass, atomic lock, YES escrow, 50%-of-YES verification, no timeout (§0.28, §0.29)
- Every controller value-out path blocked during a governance lock, proven by surface enumeration (§0.29.C)
- Canonical Factory provenance, append-only Registry, deprecation without history loss (§0.15, §0.18, §0.19.E/H)
- Immutability matrix: only Registry and AgentGoods upgradeable; clones for the rest (§0.16, §0.25.P)
- Guardian bounded powers, timelock handoff, bootstrap-admin zero residual (§0.17, §0.25.R)
- No refund path anywhere in V1 (§0.13)
- Sales/Rentals reward decay preserved with distinct rates (§15)
- Phase 10.1: declared token saving + post-purchase buyer signal, economically inert

### 5.2 Complete since the last revision

- Indexer V2, Mongo projections, reorg handling (Phase 4)
- Wallet auth, one API key per wallet, Agent self-issuance (Phase 5, §0.26.B, §0.27.A–D)
- Transaction intents and idempotency (Phase 6, §0.25.W)
- Read and write Agent API, discovery feeds, dividends/me (Phases 7–8, §0.22)
- Agent schema, OpenAPI, `/.well-known/aic-agent.json` (Phase 16, §0.23.B)
- Futuristic human observer UI (Phase 17, §0.26.A), including the store-token market, per-store
  candlestick charts built from indexed swaps, seller profiles and illustrative media
- Observability, security headers, rate limiting (Phase 18)

### 5.2b Seller presentation layer (operator request, 2026-09-22)

On-chain seller profiles carrying display name, description, highlights, tags, logo and
illustrative media, for both stores and products, plus a per-token description on the store
token. The document lives on chain and the backend never dereferences a seller URL; see
DECISIONS D-017. Media that would reach a third-party host is gated behind an explicit click.

### 5.2c Operator-requested protocol changes (2026-09-23)

| Change | Spec | Status |
|---|---|---|
| Liquidity failure is not a balance failure | §29A | Done. New error code, derived `maxTokensSellableNow`, both sell paths guarded, schema + OpenAPI updated, two tests proving the codes are distinguished by cause rather than merely ordered. |
| Production deployment gate | §29B | Done. `infra/scripts/deploy-gate.mjs`, no override, 7 tests including a grep for escape hatches. Wiring it into CI is part of the remaining `infra/` work. |
| Dividend eligibility by minimum balance over a holding window | §29C | Done. `AICoin.minBalanceInWindow` over the existing checkpoints, governed window recorded per epoch, `eligibleMinSupply` bounded on chain, indexer derives the same figure independently, `snapshotTradingDisclosure` replaced by `eligibilityRule`. |

### 5.2d Closed since (2026-09-23, later)

| Gap | What was built |
|---|---|
| Webhooks | Registration/list/rotate/delete routes, HMAC-SHA256 signing with a DERIVED secret (nothing forgeable is stored), a transactional outbox fed after the projection commits, a delivery worker with backoff and dead-lettering, and an SSRF policy re-validated before every request. The Agent schema had advertised this since the beginning; it now exists. |
| Access gateway | Encrypted content storage (AES-256-GCM, key derived per store+contentHash), short-lived single-use signed delivery URLs, authorization decided from indexed chain state, on-chain `contentHash` verified against the served bytes, and a seller-side batch attestation intent so the backend never holds a seller key. |
| Uniswap listing safety | The local stack and the transition tests now run against the REAL Uniswap V2 artifacts, byte for byte, with the pair init code hash asserted equal to mainnet. Includes the pair front-running attack. |
| Post-transition charting | Pool `Swap`/`Sync` events are folded into the SAME trade series with the same price scaling, so the chart continues through the listing instead of going flat forever. |
| Procedural artwork | A seeded generator shared by the offline script and the UI, so every store, product and token gets distinct artwork with no repetition and no third-party image host. |

### 5.3a Still to build

- Webhook delivery worker and the access gateway (signed URLs, AES-256-GCM content encryption,
  SSRF protections)
- Three proving Agents at 25 USDC each (§0.26.C, §0.27.G)
- The remaining required documents listed in §6
- `infra/` deployment configuration and CI

### 5.3 External blockers (operator action required, per §0.2 whitelist)

| Blocker | Exact operator action required | What continues independently |
|---|---|---|
| Mainnet/testnet deployment | Fund a deployer wallet; supply `BASE_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `CANONICAL_USDC_ADDRESS`, `DEX_ROUTER_ADDRESS`, `BOOTSTRAP_ADMIN_ADDRESS`, `GUARDIAN_ADDRESS`, `TREASURY_DESTINATION_ADDRESS` | Everything: local chain development, tests, backend, frontend, schema |
| Railway deployment | Railway account authorization, project creation, Mongo + object storage provisioning | Full local stack, deployment configs, runbook |
| Cloudflare cutover | DNS/registrar access for the final domain | Railway-origin operation, cutover checklist, CSP manifests |
| Funding the 3 proving Agents | Explicit approval to move 75 USDC of real funds plus the native gas bootstrap | Agent implementation, dry runs against a local chain |
| Final multisig/timelock handoff | Human signer set and signatures | Timelock contract, handoff script, verification tests |
| Moltbook publication | Moltbook account/credentials, and possibly a human claim step | Post generation from canonical data, idempotency ledger |

No blocker above prevents any other work from continuing.

---

## 6. Implementation order (remaining)

1. Backend skeleton: config from the manifest, Mongo models, structured logging, health.
2. Indexer V2: backfill, safe head, reorg rollback, exactly-once projections, cursors.
3. Auth: wallet challenge, one active API key per wallet, issue/rotate/revoke.
4. Transaction intents + idempotency.
5. Read API, discovery feeds, dividends/me.
6. Write API (intent producers) including Phase 10.1 declaration and signal.
7. Merkle root generator + independent verifier.
8. Agent schema, OpenAPI, `/.well-known/aic-agent.json`, `/docs/agents`.
9. Frontend.
10. Three proving Agents.
11. Docs, runbooks, final self-audit.

---

## 7. Change log

| Date | Change |
|---|---|
| 2026-09-22 | Phase 0 forensic inventory of `contractsv0/` and `backendv0/`. |
| 2026-09-22 | Contracts implemented; 200 tests green. |
| 2026-09-22 | V1-1 (lock deadlock) and V1-2 (micro-purchase fee evasion) found and fixed. |
| 2026-09-22 | MASTER_PLAN extended with **Phase 10.1** (§14A) at operator request. |
| 2026-09-22 | Phase 10.1 implemented on chain; 232 tests green. |
| 2026-09-22 | Deployment script and protocol manifest generator complete and exercised locally. |
| 2026-09-22 | Backend, indexer, Agent API, schema and human UI implemented; 44 integration tests green. |
| 2026-09-22 | Mandatory §23 end-to-end scenario green, 18/18, against a real chain and a real indexer. |
| 2026-09-22 | Seller profiles, media, per-store candlestick charts and the store-token market added at operator request. |
| 2026-09-23 | Live demonstration loop (`agents/src/live.ts`) and self-refreshing UI surfaces; indexer status no longer reports "backfilling" while healthy. |
| 2026-09-23 | Relicensed to `LicenseRef-AgentGoods-1.0`: source-available, no copying, no self-deployment, Factory creation free. Applied to all 22 contracts, every package and the site. |
| 2026-09-23 | Block-explorer source verification wired into deployment and runnable standalone from the manifest. |
| 2026-09-23 | Secret scanner written (`npm run secrets:scan`) — the script the package had advertised but never had. Repository scans clean. |
| 2026-09-23 | Card text clamped to uniform heights in listing grids; detail pages and the Agent API unchanged. |
| 2026-09-23 | Webhooks and the access gateway implemented, closing the two gaps where the system did less than the schema advertised. |
| 2026-09-23 | The 30% DEX listing is now tested against real Uniswap V2, including the pair front-running attack; the local stack lists into a real pool. |
| 2026-09-23 | The price series continues across the transition: pool swaps fold into the same trade collection at the same scale. |
| 2026-09-23 | Procedural artwork engine, shared between the offline generator and the UI. |
| 2026-09-23 | **§29A** liquidity failure separated from balance failure (`MARKET_INSUFFICIENT_REAL_USDC`). |
| 2026-09-23 | **§29B** production deployment gate added, with no override path. |
| 2026-09-23 | **§29C** dividend entitlement changed to the minimum balance over a holding window, so holding AIC is worth something and a snapshot snipe earns zero. |
| 2026-09-22 | V1-3 … V1-9 found and fixed: supply double count, three price scales, zero price on an untraded market, chain-vs-wall clock, missing token metadata, test key rotation, cross-suite collision. |
