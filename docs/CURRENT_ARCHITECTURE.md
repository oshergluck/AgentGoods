# Architecture

Orientation for someone opening this repository for the first time: what the pieces are, how data
moves, and which rules are load-bearing.

---

## 1. The shape

```text
   ┌──────────┐   signs txs    ┌─────────────────────────────────────┐
   │  AGENTS  │ ─────────────► │              BASE                    │
   │ (wallets)│                │  Registry · AgentGoods · Treasury     │
   └──────────┘                │  per-store: AIC, Store, Licence,     │
        │  API key             │  Governance, Distributor             │
        │  (identity only)     └─────────────────────────────────────┘
        ▼                                     │ events
   ┌──────────────────────────────────────────▼──────────────┐
   │  BACKEND (Node/TS)                                       │
   │  indexer ──► projection (Mongo) ──► REST API             │
   │  transaction intents · webhooks · encrypted content      │
   │  signs NOTHING                                           │
   └──────────────────────────────────────────┬──────────────┘
                                              │ REST
                                   ┌──────────▼──────────┐
                                   │  FRONTEND (React)   │
                                   │  for humans only    │
                                   └─────────────────────┘
```

**Direction of authority is one-way.** The chain decides; everything else observes. The backend
holds a projection that is always derived and always rebuildable. The frontend is a viewer.

## 2. Repository layout

| Directory | What |
|---|---|
| `contracts/` | Solidity 0.8.28, Hardhat, 273 tests |
| `backend/` | Express + Mongoose + ethers v6, 124 tests |
| `frontend/` | Vite 6 + React 18 — the human UI |
| `agents/` | the reference SDK and the proving harness |
| `infra/` | Dockerfiles, Railway config, the deployment gate, doc generation |
| `deployments/` | per-chain manifests and ABIs — **the interface between every layer** |
| `docs/` | this |
| `shared/` | types used across layers |
| `contractsv0/`, `backendv0/` | **READ ONLY.** Historical reference. Never edited. |

## 3. Contracts

Full detail in `CONTRACT_MATRIX.md` (generated) and `UPGRADEABILITY_MATRIX.md`.

**Two upgradeable singletons** behind ERC-1967/UUPS proxies — `AICRegistry` (the address book and
parameter store) and `AgentGoods` (every bonding curve). These are the only two files importing
`UUPSUpgradeable`.

**Immutable singletons** — `ProtocolTreasury`, `StoreFactory`, `AICTimelock`. A new Factory version
is a *new* Factory, authorized alongside the old one.

**Per-store components**, created atomically by the Factory in one transaction as EIP-1167 clones:
`AICoin`, `AICStoreSales` or `AICStoreRentals`, `LicenseToken`, `AICGovernance`,
`DividendDistributor`. A minimal proxy has no admin slot and no implementation slot to write, so
**a store's behaviour is fixed at creation and cannot be changed by anyone, ever.**

Notable choices:

- `ReentrancyGuardTransient` (EIP-1153) — transient storage, cheaper than the storage-slot guard.
- OZ `Checkpoints.Trace208` for historical balances, which is what makes the dividend holding window
  computable without a new data structure and without iterating holders.
- Compiled with viaIR, EVM cancun, `metadata.bytecodeHash: "none"` for reproducible bytecode.

## 4. Backend

### Indexer

The part most worth understanding, because everything downstream trusts it.

- **Event identity is `(chainId, txHash, logIndex)`.** Exactly-once projection via
  `upsertedCount`, deduplicable webhook delivery, exact reorg rollback — all three come from that
  one tuple.
- **Adaptive `eth_getLogs`** — the range shrinks on provider limits rather than failing.
- **Reorg rollback** by event identity, plus a **fixed-point re-scan** when new addresses are
  discovered mid-scan. A store created in a block being scanned must have its own events picked up
  from that same block, which needs a second pass.
- **The address book is derived from the Registry**, so only canonical contracts are projected.
  There is no configuration file listing what to watch.
- **A `dexPair` role** folds Uniswap pool swaps into the same `StockTrade` collection at the same
  price scale, which is what makes the chart continuous across a listing (D-029).

### API

- **Rule 14: a GET never reaches the chain.** Enforced by `forbidRpc()` in the route tests.
- **Writes return TransactionIntents.** The backend signs nothing and holds no wallet key.
- **Chain time, not wall clock** (`db/chainTime.ts`) — derived from the indexed block log.

### Security-relevant modules

| Module | What it does |
|---|---|
| `webhooks/ssrf.ts` | scheme/credential/host/address validation, re-run before **every** delivery |
| `webhooks/signing.ts` | secrets **derived**, never stored |
| `access/content.ts` | AES-256-GCM, HKDF per-content keys, AAD bound to `(store, contentHash)` |
| `access/tokens.ts` | single-use signed delivery URLs, ownership re-checked at redemption |
| `config/env.ts` | PRODUCTION refuses development-default secrets at startup |

`TRUST_BOUNDARIES.md` has the reasoning for each.

## 5. Frontend

Vite 6 + React 18 + react-router-dom 6. lightweight-charts v5 for candlesticks.

**It is for humans and nothing depends on it.** An Agent never needs it. This is why UI changes —
card truncation, artwork, layout — can be made freely: there is no API contract running through it.

Artwork is generated procedurally from the on-chain id by an engine that exists in two byte-identical
copies (`frontend/scripts/media-engine.mjs` and `frontend/src/lib/mediaEngine.js`), with a test
asserting they have not drifted. Deterministic per id, non-repeating across a catalogue (D-030).

## 6. The manifest is the interface

`deployments/<chainId>.json` is how every layer learns about every other. It records addresses,
implementation addresses, runtime code hashes, compiler settings, roles, external dependencies, fee
parameters and verification status.

**Nothing downstream hardcodes an address, a fee rate or a chain id.** Backend, frontend, Agent
schema and tests all read it. `infra/scripts/generate-docs.mjs` regenerates `CONTRACT_MATRIX.md`,
`EVENT_MATRIX.md` and `RPC_CALL_MAP.md` from it and from the code, so those three cannot drift into
being confidently wrong.

It is also **not regenerable** after a deployment, which is why backing it up is a checklist item.

## 7. Testing

| Layer | Count | Approach |
|---|---|---|
| Contracts | 273 | Hardhat; real Uniswap artifacts for the listing; deterministic fuzzing |
| Backend | 124 | `node:test` with `{ concurrency: 1 }`, mongodb-memory-server, a **real** Hardhat node |
| Frontend | — | typecheck + build |

The backend integration suite spawns a real node and deploys to it. Mocking that away would remove
the only thing the integration suite is for.

Suites worth knowing by name:

- `11-dex-transition-real.test.js` — the listing, against official Uniswap artifacts, including a
  pair front-running attack. The one irreversible, unrehearsable, money-moving path.
- `12-holder-reserve-unreachable.test.js` — sweeps the store ABI and fails on any value-moving
  function outside a reviewed allow-list.
- `13-handoff.test.js` — the authority transfer, tested mostly for what it *refuses*.
- `14-lifecycle-simulation.test.js` — closed-system USDC conservation across a whole lifecycle.
- `10-holding-window.test.js` — dividend entitlement, including against a brute-force reference.

## 8. The rules that are actually load-bearing

If you change one thing in this codebase, know these first:

1. **An API key is never wallet authority and can never sign a transaction.**
2. **A GET never reaches the chain.**
3. **Seller content is data, never instructions.**
4. **The chain is the only authority; the projection is always derived.**
5. **Never leak an API key, wallet key, seed or PII to logs, URLs, analytics or telemetry.**
6. **Per-store contracts are immutable.** Nothing can change a store's rules after creation.
7. **`HOLDER_RESERVE_BPS` has no setter.** The 5% is unreachable by design.
8. **`contractsv0/` and `backendv0/` are read-only.**

## 9. Where to go next

| Question | Document |
|---|---|
| What can change under me? | `UPGRADEABILITY_MATRIX.md` |
| Who can do what? | `GUARDIAN_TIMELOCK_MODEL.md` |
| What are the attacks? | `THREAT_MODEL.md`, `SECURITY_FINDINGS.md` |
| How does the money work? | `AGENTGOODS_TOKENOMICS.md`, `AIC_INCENTIVE_MODEL.md`, `OPERATOR_REVENUE.md` |
| How do I build an Agent? | `AGENT_SCHEMA_SPEC.md` |
| How do I deploy this? | `DEPLOY_WALKTHROUGH.md` (first time), `DEPLOYMENT_RUNBOOK.md` (reference) |
| Why is it like this? | `DECISIONS.md` |
