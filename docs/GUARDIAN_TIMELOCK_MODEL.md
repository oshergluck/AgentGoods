# Guardian, admin and timelock: who can do what

Three different kinds of authority exist over this protocol, and they are deliberately unequal.
Conflating them is the mistake that makes people trust the wrong key.

- **The guardian** can stop things. It cannot start them again, and it cannot change anything.
- **The admin** can change things. Before the handoff this is one key; after it, it is a timelock.
- **The timelock** is the admin, delayed. Same powers, minus the ability to use them instantly.

The rest of this document is the precise version, verified against the contracts rather than
described from intent.

---

## 1. The full role table

Every role constant that exists, where it is defined, and what holding it actually lets you do.

| Role | Defined in | Can call |
|---|---|---|
| `GUARDIAN_ROLE` | Registry, AgentGoods | `setPaused(scope, **true**)`, `deprecateFactory` |
| `DEFAULT_ADMIN_ROLE` | Registry, AgentGoods | `setPaused(scope, **false**)`, `setAgentGoods`, `setProtocolTreasury`, and granting/revoking every role above |
| `FEE_ADMIN_ROLE` | Registry | `setCommerceFeeBps`, `setAgentGoodsFeesBps`, `setDividendProcessingFeeBps`, `setHoldingWindowSeconds` |
| `FACTORY_ADMIN_ROLE` | Registry | `authorizeFactory`, `deprecateFactory` |
| `UPGRADER_ROLE` | Registry, AgentGoods | `_authorizeUpgrade` — i.e. replace the implementation behind the proxy |
| `WITHDRAWER_ROLE` | ProtocolTreasury | `withdraw(token, amount)` |
| `DESTINATION_ADMIN_ROLE` | ProtocolTreasury | `setDestination` |
| `RESCUE_ROLE` | ProtocolTreasury | `rescue(token)` — surplus only, never accounted revenue |

At deployment (`AICRegistry.initialize`, lines 147–151) the bootstrap admin receives
`DEFAULT_ADMIN_ROLE`, `FACTORY_ADMIN_ROLE`, `FEE_ADMIN_ROLE` and `UPGRADER_ROLE`. The guardian
receives `GUARDIAN_ROLE` and nothing else.

## 2. The asymmetry that matters

The guardian is a fire alarm, not a lock. Stated as a comparison, because this is the thing most
often assumed wrongly:

| | Guardian | Admin (bootstrap key, later the timelock) |
|---|---|---|
| Pause a scope | ✅ | ✅ |
| **Un**pause a scope | ❌ | ✅ |
| Upgrade Registry or AgentGoods | ❌ | ✅ |
| Change any fee | ❌ | ✅ |
| Move the treasury destination | ❌ | ✅ |
| Withdraw protocol fees | ❌ | ✅ |
| Grant itself another role | ❌ | ✅ |

`AICRegistry.sol:455-462` is where the pause asymmetry lives: pausing accepts `GUARDIAN_ROLE` **or**
`DEFAULT_ADMIN_ROLE`; unpausing calls `_checkRole(DEFAULT_ADMIN_ROLE)` unconditionally.

**This is on purpose.** A guardian key is meant to be reachable quickly — held somewhere a human can
get to it at 3am without assembling signers. That reachability is exactly why it must not be able to
authorize anything. The worst a stolen guardian key can do is stop the protocol; it cannot take
anything out of it, and it cannot un-stop anything to cover its tracks.

**The consequence is a denial-of-service with a known floor**, and it should be stated plainly: a
compromised guardian key can pause every scope, and after the handoff the unpause is an admin action
that must go through the timelock. The protocol is therefore frozen for at least the timelock delay.
Choosing that delay is choosing that floor — see §5.

## 3. What can actually be paused

Four scopes exist. There are exactly five pause checks in the entire codebase, so the list is
complete rather than indicative.

| Scope | Blocks | Enforced at |
|---|---|---|
| `PAUSE_STORE_CREATION` | creating a new store | `StoreFactory.sol:184`, `AICRegistry.sol:327` |
| `PAUSE_COMMERCE` | purchases and rentals | `StoreBase.sol:264` |
| `PAUSE_MARKET` | bonding-curve **buy and sell** | `AgentGoods.sol:385`, `AgentGoods.sol:439` |
| `PAUSE_REWARD_DEPOSIT` | depositing into a reward pool | `StoreBase.sol:669` |

### What has no pause scope at all, deliberately

Pausing must never trap money that is already owed to someone. These paths carry no pause check and
cannot be stopped by any role:

- **Dividend claims.** `DividendDistributor` contains zero references to `isPaused`. A finalized
  root stays claimable regardless of what is paused, forever — there is no expiry and no sweep.
- **Licence validity.** An already-purchased licence keeps working.
- **Content access.** Delivery of something already bought is not an economic action.
- **`withdrawOwnerProceeds`.** A store owner's already-earned proceeds are theirs.
- **`commitHolderReserve` / `returnHolderReserve`.** Reserve movement between store and distributor
  is holders' money in transit.

### One honest tension

`PAUSE_MARKET` gates `sell` as well as `buy`. The design principle is that a pause should never trap
a safe exit, and selling on the curve is arguably a safe exit — so this scope does, in a pause,
prevent holders from leaving.

It is still the right call, and the reasoning should be visible rather than assumed: the scenario
that justifies pausing the market at all is a defect in curve pricing or reserve accounting. If
`sell` stayed open during that, the pause would accomplish nothing except letting whoever noticed
first drain the reserve at the wrong price. A pause that halts only buying is not a pause.

What follows from that, and what the operator should hold onto: **`PAUSE_MARKET` is the most
expensive scope to use and the most expensive to leave on.** It is the one that most argues for a
short timelock delay.

## 4. The bootstrap phase, and why it is not the end state

Between deployment and the handoff, one key — the bootstrap admin — holds `DEFAULT_ADMIN_ROLE`,
`FEE_ADMIN_ROLE`, `FACTORY_ADMIN_ROLE` and `UPGRADER_ROLE`. That is total authority over the
protocol, including the ability to replace AgentGoods's implementation with anything at all.

This is not a design preference; it is an unavoidable window. Somebody has to deploy the contracts
and wire them together, and that somebody necessarily has the power to do it.

What makes the window acceptable is that it is *bounded, minimal and visible*:

- **Bounded** — it ends at the handoff, which is gated on 72 continuous clean hours (D-027).
- **Minimal** — the guardian is a different key from the first block. `infra/scripts/deploy-gate.mjs`
  refuses a deployment where they are equal, so there is no configuration in which one compromised
  key both holds admin power and holds the emergency stop.
- **Visible** — every upgrade and every role change emits an event, and the indexer records it.

**What to actually do about it:** treat the bootstrap admin key as a hot key with total authority,
because that is what it is. It should exist on one machine, be used for nothing else, and be revoked
at the handoff rather than merely "not used any more".

## 5. The handoff

`contracts/src/upgrade/Timelock.sol` is OpenZeppelin's `TimelockController`, unmodified. Deploying
and configuring it is `contracts/script/handoff.js`; the walkthrough covers running it.

After the handoff:

| Role | Holder |
|---|---|
| `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE`, `FEE_ADMIN_ROLE`, `FACTORY_ADMIN_ROLE` | the timelock |
| `WITHDRAWER_ROLE`, `DESTINATION_ADMIN_ROLE`, `RESCUE_ROLE` | the timelock |
| `GUARDIAN_ROLE` | **unchanged** — still the guardian key |
| the bootstrap admin key | nothing |

The guardian deliberately does **not** move to the timelock. A timelocked emergency stop is not an
emergency stop.

### Choosing the delay

The delay is a single number and it trades two failure modes against each other:

| Delay | Protects against | Costs you |
|---|---|---|
| Short (6–24h) | little warning for holders before a change | fast recovery from a guardian-key DoS |
| Long (48–72h) | a compromised signer set, by giving holders time to see it coming and exit | that same window is your minimum outage if the guardian key is abused |

Given that `PAUSE_MARKET` blocks exits (§3), a very long delay means a very long period in which
holders can neither trade nor be rescued. **48 hours is the recommended starting point**: long
enough that an upgrade cannot be pushed through before anyone notices, short enough that a hostile
pause is an outage rather than a catastrophe.

### The step nobody should skip

Execute one meaningless change end to end through the timelock — propose, wait out the delay,
execute — **before** you need it. Set a parameter to the value it already holds.

A timelock you have never successfully executed through is a timelock you do not know how to use,
and the moment you find that out will be an incident.

## 6. What no role can do

Worth stating as a closed list, because "what is the worst a compromised admin key can do" is a
question that deserves a precise answer rather than reassurance:

- **Mint AIC.** Genesis supply is fixed at creation; there is no mint path afterwards.
- **Withdraw any store's holder reserve.** Enforced by
  `contracts/test/12-holder-reserve-unreachable.test.js`, which sweeps the store's whole ABI as
  well as testing the behaviour.
- **Change `HOLDER_RESERVE_BPS`.** `AICRegistry.holderReserveBps()` is declared `pure`. There is no
  setter and no role.
- **Seize a store.** Controller changes happen through voluntary transfer or the holder-takeover
  path, neither of which any protocol role can trigger.
- **Forge or block a dividend claim.** Claims are Merkle proofs against a finalized root and carry
  no pause check.
- **Reverse a completed DEX transition.** It is one-way, and the LP is burned.
- **Raise a fee past its cap.** Caps are constants checked in the contract, so a governance mistake
  reverts rather than lands.

The one thing an admin key *can* do that dwarfs the rest: **upgrade AgentGoods or the Registry.** An
upgrade can introduce any of the above. That is the entire reason the handoff exists, and the reason
`UPGRADER_ROLE` is the role to watch.
