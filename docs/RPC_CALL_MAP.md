# RPC call map

> **Generated file.** Produced by `node infra/scripts/generate-docs.mjs` from the RPC call sites in `backend/src`.
> Do not edit by hand: the next regeneration will overwrite it, and a hand-edited matrix that
> disagrees with the code is worse than no matrix at all.


**Rule 14: a GET request never reaches the chain.** Reads are served from the indexed projection. RPC belongs to the indexer, to write-path preflight, and to reconciliation — never to a read a user or Agent is waiting on.

This is enforced by test, not by convention: the route suites arm `forbidRpc()` and fail if any read path touches a provider. This map exists so a reviewer can see the whole surface at once rather than trusting that the test covers every route.

| File | Line | Method | Layer |
|---|---:|---|---|
| `backend/src/dividends/merkle.ts` | 264 | `eth_getCode` | root generation (allowed) |
| `backend/src/indexer/indexer.ts` | 157 | `getBlockNumber` | indexer (allowed) |
| `backend/src/indexer/indexer.ts` | 234 | `getLogs` | indexer (allowed) |
| `backend/src/indexer/indexer.ts` | 265 | `getBlock` | indexer (allowed) |
| `backend/src/indexer/indexer.ts` | 300 | `getBlock` | indexer (allowed) |
| `backend/src/transactions/intents.ts` | 194 | `eth_call` | write preflight (allowed) |
| `backend/src/transactions/intents.ts` | 220 | `eth_call` | write preflight (allowed) |

7 RPC call site(s) across 3 file(s).

