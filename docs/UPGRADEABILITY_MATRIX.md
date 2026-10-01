# What can change under you, and what cannot

The question this document answers is the one anyone putting money into a store should ask before
they do: **can the rules change after I am in?**

For most of the system the answer is no, and it is no structurally rather than by promise. Two
contracts are the exception, and they are the exception on purpose.

---

## 1. The matrix

| Contract | How it's deployed | Upgradeable | Who can upgrade it |
|---|---|---|---|
| `AICRegistry` | ERC-1967 proxy, UUPS | **yes** | `UPGRADER_ROLE` → the timelock after handoff |
| `AgentGoods` | ERC-1967 proxy, UUPS | **yes** | `UPGRADER_ROLE` → the timelock after handoff |
| `ProtocolTreasury` | plain deployment | no | nobody |
| `StoreFactory` | plain deployment | no | nobody — a new version is a *new* Factory |
| `AICoin` (per store) | EIP-1167 clone | **no** | nobody |
| `SalesStore` / `RentalsStore` | EIP-1167 clone | **no** | nobody |
| `LicenseToken` (per store) | EIP-1167 clone | **no** | nobody |
| `AICGovernance` (per store) | EIP-1167 clone | **no** | nobody |
| `DividendDistributor` (per store) | EIP-1167 clone | **no** | nobody |
| `AICTimelock` | plain deployment | no | nobody |

Only two files in `contracts/src` import `UUPSUpgradeable`, and both are named above. That is the
whole upgradeable surface; there is no third case hiding somewhere.

## 2. Why a store is permanently immutable

Every per-store component is an EIP-1167 minimal proxy. A minimal proxy delegates to **one fixed
implementation address**, written into its bytecode at creation. There is no admin slot, no
implementation slot to write, and no function that could change it — not because the authors
declined to add one, but because the proxy standard has nowhere to put it.

The consequence is worth stating in the strongest available terms: **what a store owner deploys is
what they keep, and what a token holder buys into is what it stays.** No protocol role, no
governance vote, no timelock proposal and no upgrade of the Registry can change the behaviour of a
store that already exists. The code is fixed at creation and outlives everyone's authority over it.

This is why the runtime code hash matters and why the Factory records it. An Agent can confirm that
a store's components are clones of exactly the implementations in `CONTRACT_MATRIX.md`, rather than
contracts that merely present the same interface.

### What a new Factory version does and does not do

New component implementations ship as a **new Factory**, authorized alongside the old one. Stores
created afterwards use the new code; stores created before keep theirs, forever.

Deprecating a Factory (`FACTORY_ADMIN_ROLE` or `GUARDIAN_ROLE`) stops it creating *new* stores. It
does not touch, invalidate or reach into a single store it already created. Historical provenance is
untouched: a deprecated Factory remains a valid, known, canonical historical creator.
**Deprecated is not scam.**

## 3. Why those two are upgradeable

`AICRegistry` and `AgentGoods` are the protocol's shared infrastructure — the address book and the
exchange. Both need to be fixable, because a defect in either is systemic rather than confined to
one store, and a bonding curve with an arithmetic bug that cannot be patched is not safer for being
immutable.

The trade is explicit, and it is the single largest piece of trust the system asks for:

> An upgrade to `AgentGoods` can change the behaviour of **every bonding curve at once**, including
> how a market prices, how it settles, and what it does with its reserve.

Everything about the handoff exists to bound that. `_authorizeUpgrade` on both contracts is guarded
by `UPGRADER_ROLE` only (`AICRegistry.sol:468`, `AgentGoods.sol:613`); after the handoff that role is
held by the timelock and by nothing else, so an upgrade becomes a public proposal with a delay
attached rather than a transaction.

**Before the handoff, one key can do this instantly.** That is the honest state of a bootstrap
deployment, it is why `PRODUCTION` in the deployment gate means "handed over" rather than "on
mainnet" (D-033), and it is why the proving run gates the handoff rather than the launch.

## 4. Parameters, which are a different thing from code

An upgrade changes code. These change a number within a cap that the code enforces, which is a much
smaller power and worth keeping separate in your head.

| Parameter | Default | Cap | Changed by |
|---|---|---|---|
| `commerceFeeBps` | 250 (2.5%) | 500 (5%) | `FEE_ADMIN_ROLE` |
| `agentGoodsProtocolFeeBps` | 200 (2%) | 300 (3%) | `FEE_ADMIN_ROLE` |
| `agentGoodsControllerFeeBps` | 100 (1%) | 200 (2%) | `FEE_ADMIN_ROLE` |
| `dividendProcessingFeeBps` | 500 (5%) | 1000 (10%) | `FEE_ADMIN_ROLE` |
| `holdingWindowSeconds` | 604800 (7d) | 30 days | `FEE_ADMIN_ROLE` |

Caps are constants checked inside the setter, so a governance mistake reverts rather than lands. A
fee cannot be set to 50% by anybody, including by someone who holds every role.

### The parameter that is not a parameter

`HOLDER_RESERVE_BPS` is 500 (5%) and **has no setter at all**. `AICRegistry.holderReserveBps()` is
declared `pure`: it returns the constant. No role changes it, governance cannot vote on it, and an
upgrade to the Registry is the only thing in the universe that could — which is precisely the power
the timelock exists to slow down.

That 5% of net commerce belonging to holders is the promise the token is priced on. A promise
governance can dilute is not a promise, so it was made unreachable rather than merely restricted.

## 5. What survives an upgrade regardless

Even a malicious upgrade, executed successfully, cannot reach these — they are not enforced by the
upgradeable contracts:

- **Every existing store's behaviour.** Clones, §2. This is the big one.
- **Genesis supply.** 1B, minted once at creation by the store's own immutable `AICoin`.
- **Already-purchased licences.** Held in the store's own immutable `LicenseToken`.
- **Finalized dividend roots and unclaimed dividends.** In the store's own immutable distributor,
  with no expiry, no sweep and no reclaim path (D-016).
- **A completed DEX transition.** One-way, and the LP is burned to an address nobody controls.

## 6. Reading the live state yourself

Do not take this document's word for it. Every claim above is checkable:

```bash
# The implementation behind each proxy (ERC-1967 implementation slot).
cast storage $REGISTRY 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $BASE_RPC_URL
cast storage $AGENTGOODS 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $BASE_RPC_URL

# Who can upgrade. After the handoff this should be the timelock and nothing else.
cast call $REGISTRY "hasRole(bytes32,address)(bool)" $(cast keccak "UPGRADER_ROLE") $TIMELOCK --rpc-url $BASE_RPC_URL
cast call $REGISTRY "hasRole(bytes32,address)(bool)" $(cast keccak "UPGRADER_ROLE") $OLD_DEPLOYER --rpc-url $BASE_RPC_URL  # must be false

# A store component's code hash, to confirm it is a clone of a known implementation.
cast keccak $(cast code $STORE_AIC --rpc-url $BASE_RPC_URL)
```

An `Upgraded(address)` event is emitted by the proxy on every upgrade and recorded by the indexer,
so the upgrade history of both contracts is public and reconstructible from chain rather than from
anyone's account of it.
