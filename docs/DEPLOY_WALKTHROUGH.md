# Going live: the step-by-step walkthrough

This is the version written for **you**, not for an engineer who already knows the system.

`DEPLOYMENT_RUNBOOK.md` is the reference version — dense, complete, good for looking something up
later. This document is the one to actually follow the first time. Every step says what to do, what
you should see afterwards, and what it means if you see something else.

## How we'll do this

You do not have to know what any of these commands do. You do have to run them, because several of
them spend your money or move your keys, and those are not things to hand to an assistant.

The rhythm is always the same:

> I tell you one thing to do → you do it → you paste me what you saw → I tell you the next thing.

**Do not run ahead.** If you do three steps and the first one quietly failed, we find out at step
three and have to unpick which one broke. One at a time is faster in practice.

Wherever you see **⏸ STOP** — that is a point where I genuinely need your output before the next
step is safe to choose. Paste the whole thing, including anything that looks like an error.

If anything at all looks different from what this document says to expect: **stop and tell me.**
You will not be wasting my time and you will not look silly. Stopping is free. A wrong step at
Phase 4 costs real money, and a wrong step at Phase 8 can cost the protocol.

## What this is going to cost you

| | Money | Your time | Can it be undone? |
|---|---|---|---|
| Phase 1–3 (prep, testnet) | free (testnet gas is free) | ~2 hours | yes, entirely |
| Phase 4 (mainnet contracts) | gas — I'll tell you the real number after testnet | ~30 min | **no** |
| Phase 5–6 (hosting, domain) | ~$5–20/month | ~1 hour | yes |
| Phase 7 (proving run) | 75 USDC | 72 hours of waiting | yes |
| Phase 8 (multisig handoff) | gas | ~1 hour | **no** |

Total real exposure before Phase 7: gas only. The 75 USDC is spent by the agents, into the
protocol — most of it is recoverable.

## Before we start: three things I cannot do for you

1. **I cannot hold or generate your private keys.** Every key stays on your machine. I will never
   ask you to paste one to me, and if anything ever seems to be asking you for one, that is the
   moment to stop and ask me about it.
2. **I cannot spend your money.** Every transaction is run by you.
3. **I cannot change your DNS or your domain.** Those are your accounts.

What I *can* do: check every output, write and fix every file, tell you exactly what to type, and
catch the mistakes before they cost anything.

---

# Phase 0 — Are we actually ready?

**Time: 10 minutes. Cost: nothing. Undoable: n/a.**

We check the whole thing still works on your machine before we go anywhere near a network.

### Step 0.1 — Run the contract tests

Open a terminal in the project folder and run:

```bash
cd contracts
npx hardhat test
```

**What you should see:** a long list of ticks, ending with something like `290 passing`.

**If you see any red, or the word `failing`:** ⏸ **STOP** and paste me the last 30 lines. Do not
continue. A failing test before a deployment is the cheapest possible moment to find a problem.

### Step 0.2 — Run the backend tests

```bash
cd ../backend
npm test
```

**Expect:** `133 passing`, no failures.

### Step 0.3 — Check nothing secret is in the code

```bash
npm run secrets:scan
```

**Expect:** a line saying the scan is clean.

**If it finds something:** ⏸ **STOP.** This is the one class of mistake that a delete does not fix,
because it stays in history. Paste me what it found and we deal with it before anything else.

### Step 0.4 — Check the frontend builds

```bash
cd ../frontend
npm run typecheck && npm run build
```

**Expect:** it finishes without errors and mentions a `dist` folder.

⏸ **STOP** — paste me the results of all four. If all four are green, we move on.

---

# Phase 1 — Making your secrets

**Time: 20 minutes. Cost: nothing. Undoable: technically yes, practically no — read on.**

The system needs three secret values. They do not exist yet. You are going to create them, and
then you are going to store them somewhere you will still have in a year.

**Why this matters more than it looks:** two of these three cannot be changed later without
breaking things that already exist.

- Change `CONTENT_ENCRYPTION_KEY` later → every product anyone has already uploaded becomes
  permanently unreadable. Not "needs re-uploading". Unreadable.
- Change `API_KEY_PEPPER` later → every API key every agent holds stops working at once, and every
  webhook signature becomes invalid.

So: make them once, now, carefully.

### Step 1.1 — Generate the first one

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

It prints one long line of random characters. That is `API_KEY_PEPPER`.

### Step 1.2 — Run it again, twice more

Run **the exact same command** two more times. You get two more different lines. Those are
`CONTENT_ENCRYPTION_KEY` and `ACCESS_TOKEN_KEY`.

**Do not reuse one value for two of them.** If one leaks, you want it to have leaked one thing.

### Step 1.3 — Store them

Put all three in your password manager, as three separate entries, each labelled with which
variable it is.

Not in a text file on your desktop. Not in a chat message. Not in the project folder — the project
folder is where the secret scanner will find them and refuse to let you deploy.

**Do not paste these to me.** I do not need them and should not have them. When we set them in
Railway later, you will paste them into Railway directly.

### Step 1.4 — The accounts you'll need

While you're here, these need to exist before Phase 3. All are free to create:

| What | Where | What it's for |
|---|---|---|
| Basescan API key | basescan.org → Account → API Keys | Publishing the contract source so people can read it |
| An RPC endpoint | Alchemy, Infura, or QuickNode — free tier is fine | How the system talks to the blockchain |
| Railway account | railway.app | Hosting |
| Cloudflare account | cloudflare.com | DNS for agentgoods.ai |

### Step 1.5 — Two fresh wallets

You need **two brand new wallets**, and neither of them should be a wallet you already use for
anything.

- **The deployer.** This one deploys the contracts and will hold gas. Because it briefly holds
  power over the protocol, it should be a wallet whose only job is this.
- **The guardian.** This one can pause things in an emergency. It must be a **different** wallet
  from the deployer — the deployment gate checks this and refuses to run if they match, and that
  check is there because "the key that can break it can also fix it" is not a safety design.

⏸ **STOP** — tell me when you have: three secrets stored, four accounts created, two wallets made.
Give me the two **public addresses** (never the private keys) so I can put them in the config.

---

# Phase 2 — Testnet, where mistakes are free

**Time: ~1 hour, plus a day of it running. Cost: nothing.**

We deploy the entire thing to Base Sepolia, a practice copy of the real network where the money
is fake. Nothing here is a rehearsal we can skip. This is the only place the DEX listing will ever
have run against a real network before it runs for real.

I'll write the config file for you. You'll run one command. Then we watch it for a day.

The full detail is in the runbook, but you won't need it — I'll walk you through it live when we
get here, same rhythm as above.

---

# Phase 3 — The gate says yes or no

**Time: 2 minutes. Cost: nothing.**

There's a script whose whole job is to refuse a bad deployment. You run it, and it either passes or
it lists everything wrong. It has no override switch — deliberately, because a gate with an
override is a gate that gets overridden at 2am.

If it says no, **it is right**. We fix the config and run it again.

**You'll run this twice, and the second time is much later.** One word in the command changes:

- **Now, before deploying:** `--environment PROVING`.
- **After Phase 8:** `--environment PRODUCTION`.

The difference is not strictness for its own sake. `PRODUCTION` in this system means "your single
key no longer controls everything" — and that isn't true until Phase 8. Running it as `PRODUCTION`
now would fail, correctly, telling you a timelock is missing. A live mainnet deployment that still
answers to one key is honestly a *canary*, and the gate calls it that on purpose.

---

# Phase 4 — Mainnet. This one is real.

**Time: 30 minutes. Cost: real gas. ⚠️ CANNOT BE UNDONE.**

This is the first irreversible step. When this finishes, contract addresses exist on Base forever
and become the canonical ones the moment the Registry records them.

Before you run it I will tell you, explicitly:
- what it is about to deploy,
- roughly what it will cost in gas, measured from the testnet run rather than guessed,
- and what we do if it fails halfway.

**The one thing to know in advance:** if the deploy succeeds but the source *verification* fails,
**do not redeploy.** Verification is a separate thing that talks to Basescan, and Basescan being
slow or down is not a reason to spend gas twice and end up with two sets of addresses. We just run
the verify script again. I've built it as a separate command for exactly this reason.

Afterwards there's one file — `deployments/8453.json` — that you must back up somewhere off your
machine. It cannot be regenerated. It's how the backend knows what to watch and how every agent
learns the real addresses.

---

# Phase 5 — Hosting

**Time: ~45 minutes. Cost: a few dollars a month. Undoable: yes.**

Two services on Railway, from this one repo: the backend and the frontend. Plus a database.

This is the phase with the most clicking and the least danger. Get something wrong here and you
fix it and redeploy.

One thing that will confuse you if I don't say it now: the health check must point at
`/health/ready`, not `/health/live`. "Live" means the program started. "Ready" means it has
actually connected to the database and caught up with the blockchain. If traffic reaches it while
it's live-but-not-ready, it will confidently serve empty data as though that were the truth.

---

# Phase 6 — agentgoods.ai

**Time: ~30 minutes of work, then up to a few hours of waiting. Undoable: yes.**

Namecheap → Cloudflare → Railway. `DOMAIN_CUTOVER_CHECKLIST.md` has the exact clicks and I'll walk
you through them.

Two things trip everyone up, so they're worth knowing before you start:

1. **Railway wants a TXT record** to prove you own the domain. You were right to remember this.
2. **Cloudflare's orange cloud must be OFF** for the Railway records, at least at first. If it's
   on, Cloudflare answers on Railway's behalf, Railway can't complete its certificate check, and
   HTTPS silently never finishes. The symptom is a certificate error that looks like a Railway
   problem and isn't.

DNS changes also take time to spread. If something doesn't work immediately, the honest first
answer is usually "wait twenty minutes," and I'll tell you when that's the real answer versus when
something is actually wrong.

---

# Phase 7 — The proving run

**Time: 72 hours of waiting. Cost: 75 USDC.**

Three agents, 25 USDC each, running continuously against the live system with no top-ups. A checker
sweeps the public API the whole time looking for anything that contradicts what the protocol
promises.

This is the part that can't be rushed, and it's the part I'd most want you not to skip. Everything
before it proves the system works when someone is watching. This proves it works when nobody is.

**The clock resets on any hard violation.** Not as a punishment — because 72 hours with a bug in
the middle tells you nothing about 72 hours without one.

You don't have to sit and watch. It writes its report continuously, so even if it's interrupted the
report is accurate up to that moment.

---

# Phase 8 — Handing over the keys

**Time: ~1 hour. ⚠️ CANNOT BE UNDONE.**

**Only after 72 clean hours.** This is your own rule and it's the right one.

Right now your deployer wallet has power over the protocol. This phase moves that power to a
multisig behind a timelock, so no single key — including yours — can change anything instantly.

**What I need from you here:** the list of wallet addresses that will be the signers. Public
addresses only. I'll put them in the config; you'll run the script.

The script (`contracts/script/handoff.js`) does a **dry run by default** — it prints the entire
plan, every address and every role, and sends nothing. You read that plan. Only when it's right do
you run it again with `HANDOFF_EXECUTE=1`.

It also refuses to run if the proving run hasn't passed 72 clean hours, if you're connected with
the wrong wallet, or if one of your signer addresses is the deployer or the guardian — because
either of those would quietly keep the power this phase exists to give away.

**The one thing I want you to understand about this step**, because it's the reason the script is
built the way it is: if the roles were removed from your key *before* the timelock definitely had
them, the protocol would end up with no administrator at all. Not "locked out until we fix it" —
there is no fix. So the script grants everything first, reads every single role back off the
blockchain to confirm it landed, and only then removes anything from you. If that check fails it
stops, and what you're left with is two administrators, which is a mildly awkward state and a
completely fixable one.

The step people skip, and the one I will not let you skip: **push one trivial, meaningless change
all the way through the timelock before you need it for a real one.** Change a setting to the value
it already has. A timelock you have never successfully executed a change through is a timelock you
don't know how to use, and you will discover that during an incident, which is the worst possible
time to be reading documentation.

---

# When something goes wrong

It will, somewhere. That's normal and mostly cheap. What to do:

1. **Stop.** Don't try the next step hoping it resolves itself.
2. **Don't retry a transaction that might have already worked.** Send me the transaction hash and
   I'll check what actually happened on-chain first.
3. **Paste me everything**, including the parts that look irrelevant. The line above the error is
   very often the one that matters.
4. **Don't delete anything to "start clean"** — especially not `deployments/8453.json`.

And the thing worth holding onto across all of it: a step not taken costs you an hour. A step taken
wrongly at Phase 4 or Phase 8 can cost more than that. When in doubt, ask. I'd much rather answer
the same question twice.
