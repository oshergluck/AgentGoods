# Deployment runbook

The order of operations for taking AIC from a local chain to a live deployment on `agentgoods.ai`.

> **Following this for the first time? Read `DEPLOY_WALKTHROUGH.md` instead.** This document is the
> dense reference: it assumes you already know what each step is for, and it is written to be
> looked things up in. The walkthrough is the same path written out one action at a time, with what
> to expect after each one and where to stop. Come back here afterwards.

Read a step fully before doing it. Several are irreversible: a contract deployment spends real gas
and creates addresses that become canonical the moment the Registry records them, and a nameserver
change moves authority for a whole domain.

**Nothing in this runbook should be done by an Agent, a script or an assistant on your behalf.**
Every step that spends money, moves a key, or changes DNS is an operator action.

---

## 0. What must be true before you start

```text
[ ] contracts:  npx hardhat test                       290 passing
[ ] backend:    npm test                               133 passing
[ ] frontend:   npm run typecheck && npm run build     clean
[ ] secrets:    npm run secrets:scan  (in backend/)    clean
[ ] gate:       node infra/scripts/deploy-gate.mjs --manifest deployments/31337.json --environment LOCAL
```

If any of these is red, stop. A deployment is the worst moment to discover a known failure.

---

## 1. Secrets you must create

None of these exist yet. All of them are refused at startup in PRODUCTION while they hold their
development defaults, which is deliberate — see `backend/src/config/env.ts`.

Generate each one **separately**. Reusing one value across two purposes means a leak of one is a
leak of both.

```bash
# Run three times; use a different output for each.
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

| Variable | What it protects | Consequence if it leaks |
|---|---|---|
| `API_KEY_PEPPER` | Agent API key hashes AND derived webhook signing secrets | An attacker can forge webhook deliveries to every registered endpoint |
| `CONTENT_ENCRYPTION_KEY` | All delivered product content at rest | The entire content catalogue becomes readable from a database dump |
| `ACCESS_TOKEN_KEY` | Signed delivery URLs | An attacker can mint delivery links for any licence |

**These cannot be rotated without consequence.** Rotating `CONTENT_ENCRYPTION_KEY` makes every
already-uploaded product undecryptable, because content keys are derived from it. Rotating
`API_KEY_PEPPER` invalidates every issued API key and every webhook secret at once. Decide them
before launch and store them somewhere you will still have access to in a year.

You also need:

| Variable | Where from |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | A fresh wallet, funded with gas only. Not your personal wallet. |
| `BASE_RPC_URL` | Alchemy, Infura, QuickNode or Base's public endpoint |
| `ETHERSCAN_API_KEY` | etherscan.io. One key covers every chain since API V2; basescan.org no longer issues its own. |
| `MONGODB_URI` | Railway's Mongo plugin, or Atlas |
| `GUARDIAN_ADDRESS` | **A different key from the deployer.** The gate refuses them being equal. |
| `TREASURY_DESTINATION_ADDRESS` | Where protocol fees accumulate |
| `CANONICAL_USDC_ADDRESS` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on Base |
| `DEX_ROUTER_ADDRESS` | The UniswapV2-compatible router on Base |

---

## 2. Testnet first, always

Deploy the whole thing to Base Sepolia and run it for a day before touching mainnet. The testnet
run is not a formality: it is the only place the 30% DEX transition has ever executed against a
real explorer, a real RPC provider and real network timing.

```bash
cd contracts
npx hardhat run script/deploy.js --network baseSepolia
```

The script deploys, writes `deployments/84532.json`, runs the post-deployment verification table,
and then attempts source verification automatically.

**If source verification fails, do not redeploy.** The addresses are already canonical. Fix the
cause and rerun:

```bash
npx hardhat run script/verify.js --network baseSepolia
```

Then confirm every contract shows verified source on the explorer. Unverified bytecode makes every
"verify this yourself" instruction in the Agent documentation impossible to follow.

---

## 3. The gate, before anything reaches production

The gate runs **twice**, at two different stages, and they are not the same check (D-033).

Before the mainnet deployment, while authority is still a single bootstrap key:

```bash
node infra/scripts/deploy-gate.mjs \
  --manifest deployments/8453.json \
  --environment PROVING \
  --safe-confirmations 8 \
  --max-reorg-depth 64
```

Again after the handoff in step 9, once a timelock exists and is recorded in the manifest:

```bash
node infra/scripts/deploy-gate.mjs \
  --manifest deployments/8453.json \
  --environment PRODUCTION \
  --safe-confirmations 8 \
  --max-reorg-depth 64
```

`PRODUCTION` here does not mean "on mainnet". It means **authority has been handed over**. A
mainnet deployment that still answers to a single key is a `PROVING`, and the gate will say so.

At **every** non-LOCAL environment it refuses mock infrastructure, chainId 31337, a manifest built
for another environment, a confirmation depth below the network minimum, a reorg window no deeper
than the finality window, an unknown chain, and a guardian equal to the deployer. At `PRODUCTION`
it additionally refuses a missing timelock. It reports every violation in one run and has no
override.

If it says no, it is right. Fix the configuration.

---

## 4. Mainnet deployment

```bash
cd contracts
npx hardhat run script/deploy.js --network base
```

Immediately afterwards, and before anything else:

```text
[ ] every contract shows verified source on basescan
[ ] deployments/8453.json exists and verification.complete is true
[ ] the post-deployment verification table printed OK on every row
[ ] back up deployments/8453.json somewhere outside this machine
```

That manifest is not regenerable. It is how the backend knows what to index and how every Agent
learns the canonical addresses.

---

## 5. Railway

Two services from one repository.

**Backend service**
- Build: Dockerfile, path `infra/Dockerfile.backend`
- Health check: `/health/ready` — not `/health/live`. Live means the process started; ready means
  the database is connected and the indexer has a cursor. Routing traffic to a live-but-not-ready
  instance serves empty projections as if they were the truth.
- Variables: everything from step 1, plus `ESH_ENVIRONMENT=PRODUCTION`, `CHAIN_ID=8453`,
  `SAFE_CONFIRMATIONS=8`, `MAX_REORG_DEPTH=64`, `PUBLIC_BASE_URL`, `PUBLIC_WEB_URL`, `CORS_ORIGINS`.

**Frontend service**
- Build: Dockerfile, path `infra/Dockerfile.frontend`
- Build argument `VITE_API_URL=https://api.agentgoods.ai`

`VITE_API_URL` is inlined at build time, so changing the API hostname needs a rebuild, not a
restart.

Add the Mongo plugin, or point `MONGODB_URI` at Atlas. Watch the first boot logs: the production
startup guard refuses to start on a default-valued secret and says which one.

---

## 6. Domain

Follow `docs/DOMAIN_CUTOVER_CHECKLIST.md` exactly. It is specific to Namecheap → Cloudflare →
Railway and covers the two things that trip people up: Railway's TXT verification, and the fact
that a proxied (orange-cloud) CNAME prevents Railway from issuing its certificate.

---

## 7. Canary, before any real value

```text
[ ] GET /api/v1/status            indexer live, lag 0, not stale
[ ] GET /api/v1/schema            advertises the real domain, not *.up.railway.app
[ ] GET /.well-known/aic-agent.json reachable
[ ] GET /api/v1/contracts         every canonical address matches the manifest
[ ] create ONE store from ONE agent wallet with minimal funds
[ ] list ONE product, buy it from a second wallet, take delivery, signal
[ ] confirm the purchase, licence and signal all appear in the API
[ ] restart the backend; confirm the indexer recovers and reports the same state
```

That last one matters more than it looks: it is the only check that proves the projections are
genuinely rebuildable from chain rather than accumulated in memory.

---

## 8. The proving run

Only after the canary passes.

```bash
cd agents
ESH_API_URL=https://api.agentgoods.ai npx tsx src/prove.ts
```

Three Agents, 25 USDC each, 75 USDC total, no automatic refill. The harness runs continuously with
an invariant checker sweeping the public API, and writes `docs/LIVE_AGENT_PROVING_REPORT.md` on
every sweep so an interrupted run still leaves an accurate record.

**The multisig/timelock handoff is gated on 72 continuous hours with no hard violation**
(DECISIONS D-027). A hard violation resets the clock. A run that ends early proves nothing about
unattended operation and says so in its own report.

---

## 9. Multisig and timelock handoff

**Not before the 72-hour run passes.**

`contracts/script/handoff.js` performs the whole transfer. It defaults to a dry run and prints the
complete plan — every address, every role — before it will send anything.

```bash
cd contracts

export TIMELOCK_PROPOSERS=0xSigner1,0xSigner2,0xSigner3
export TIMELOCK_EXECUTORS=ANYONE          # or an explicit list of addresses
export TIMELOCK_MIN_DELAY_SECONDS=172800  # 48h; see GUARDIAN_TIMELOCK_MODEL.md section 5

# Dry run. Sends nothing. Read every line of the plan it prints.
npx hardhat run script/handoff.js --network base

# Only once the plan is right:
HANDOFF_EXECUTE=1 npx hardhat run script/handoff.js --network base
```

It refuses to run unless the proving report shows PASS with at least 72 clean hours, unless the
connected signer is the manifest's bootstrap admin, and if any proposed proposer is the bootstrap
admin or the guardian. It grants every role to the timelock and **reads all of them back from
chain before revoking anything** (D-034), so a failure partway through leaves two administrators
rather than none.

```text
[ ] the proving report says PASS, with cleanHours >= 72
[ ] decide the signer set and the threshold
[ ] dry run reviewed line by line, especially the proposer list and the delay
[ ] handoff executed; the script reports the bootstrap admin holds no protocol role
[ ] the guardian still holds GUARDIAN_ROLE (the script asserts this and fails if not)
[ ] deployments/8453.json now records roles.timelock — back it up again
[ ] re-run the deploy gate with --environment PRODUCTION; it must now pass
[ ] push one trivial parameter change end to end through the timelock BEFORE you need it
```

That last line is the one people skip. A timelock you have never successfully executed a change
through is a timelock you do not know how to use, and you will find that out during an incident.

---

## 10. What stays true regardless

- A hostname change never changes a contract address, an Agent identity, an API key, a
  `contentHash` or any on-chain record.
- The deployer key is not the guardian, and after step 9 it is neither.
- No Agent's private key ever reaches this server. The backend proposes transactions; wallets sign
  them.
- If something looks wrong during any step, stopping is cheap and continuing is not.
