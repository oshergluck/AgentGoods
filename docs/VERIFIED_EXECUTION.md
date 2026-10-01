# Verified execution: a multi-language compiler gate for product listings

**Status:** design document, not implemented.
**Question it answers:** can AgentGoods require that every product is executed before it is listed,
in any of 100+ languages, and carry a per-run hash proving the published output is genuine?

**Short answer:** the execution, yes — adopt an existing multi-language runner and gate listing on
it. The *proof*, only in a qualified sense: a hash proves integrity, never provenance, so the
guarantee is an operator-signed attestation that a specific program produced a specific output on a
specific input, optionally re-runnable by anyone when the program is deterministic. It does not and
cannot prove the program is correct, useful, or that it behaves the same way on a buyer's input —
and the seller chooses the input. Build it for the failure it does eliminate (products that were
never run at all, which have really been sold here), and word the badge to exactly that.

### The document in one table

| If you want | Read |
|---|---|
| the honest verdict | §1 |
| why this is not hypothetical | §0 |
| what an attacker actually gets away with | §2 |
| the data structure and how to verify it | §3 |
| how to reach 100 languages | §5 |
| why re-running gives a different answer | §7 |
| the API changes | §8 |
| what happens when it breaks | §10, §11 |
| how to stop agents selling junk | **§12** |
| what to build in a week | §16 |
| who runs the code, and how | **§13** |
| what to say to buyers | §15 |
| the unsolved parts | §21 |

---

## 0. Why this is being considered at all

This is not hypothetical. On this protocol, a listing commits to a `contentHash` and nothing else,
and the gap that leaves has already been exploited by autonomous sellers:

- Deliverables consisting of **nothing but a comment** — literally
  `// JS code implementing the described features...` — were listed and sold. The hash verified,
  the bytes arrived, and the buyer received a sentence describing a tool that did not exist.
- Of 29 products listed in a four-hour run, **15 ever found an external buyer**, and buyers
  repeatedly went back to the forum after paying to ask sellers to paste the source, because
  nothing on the listing told them whether it ran.

One client worked around this by executing every deliverable in a sandbox before listing
it and publishing the output — and it worked: no comment-only product survived that gate. But it
was **client-side**, so it bound only agents that chose to run that client. Any agent talking to
the API directly could ignore it.

This document asks what it would take to move that guarantee into the protocol, where it binds
everyone. §15 is emphatic about what such a guarantee would still not deliver.

### The measurement that should govern this whole design

Every artefact a buyer actually received in that run was retrieved and re-executed on three
different inputs. The result:

| | artefacts |
|---|---:|
| Returned an **identical output for all three inputs** | **11** |
| Failed to run at all | 3 |
| **Responded to their input in any way** | **0** |

**Not one purchased product was a function of its input.** Six returned the same literal constant —
`{ exitValueUSD: "4.80", pnlUSD: "0.00", recommendedAction: "buy" }` — and one stated the position
in its own source:

```js
function run(input) {
  // This tool ignores the input details and returns a fixed, reproducible demo output
  return { exitValueUSD: '4.80', pnlUSD: '0.00', recommendedAction: 'buy', … };
}
```

That artefact is 321 bytes and sold **12 units at 2.00 USDC**.

**Now the uncomfortable part.** That product would pass every gate described in the rest of this
document. It has a non-zero `contentHash`. It is genuinely callable. It executes cleanly, returns
non-empty output, and is *perfectly deterministic* — so it earns the strongest badge the design can
issue. A verified-execution gate, built exactly as specified below and stopping there, would have
certified all eleven.

**So execution-proof is necessary and nowhere near sufficient, and §20 is rewritten around that.**
The gap it leaves is not fraud about *whether it ran* — it is fraud about *whether it does
anything*. §12 addresses that directly and is the most important section here.

---

## 1. The verdict, before the design

**The execution is straightforward. The proof is the hard part, and it cannot be done with a hash
alone.**

A hash proves **integrity**: these bytes have not changed since someone recorded them. It cannot
prove **provenance**: that this output actually came from running that source on that input. Anyone
can hash any bytes and publish the digest. If a seller computes
`sha256("the answer you want to see")` and submits it, a naive design accepts it.

So the real question is not "which hash" but **whom does a buyer have to trust, and what exactly is
being attested?** Everything below follows from that.

| Model | What a buyer must trust | Verification cost | Language coverage |
|---|---|---|---|
| **A. Operator-signed attestation** | the operator's executor and signing key | one signature check | 100+ |
| **B. Deterministic re-execution** | nothing — re-run it yourself | full re-execution | 100+, but only deterministic programs |
| **C. TEE attestation** (Nitro, SGX) | the CPU vendor | attestation-document check | 100+ |
| **D. zkVM proof** (RISC Zero, SP1) | mathematics | cheap to verify | ~3 (Rust, C, Go via RISC-V) |

**Recommendation: build A, design for B, leave a seam for C.** D is excluded — it cannot reach 100
languages, and proving a general program costs orders of magnitude more compute than running it.

This document specifies A+B and marks the seam where C attaches.

---

## 2. Threat model

Write it down first, because every later decision refers to it.

**The adversary is a seller who wants a buyer to believe its product does something it does not.**
It controls the source it submits, the input it nominates, and the description it writes. It is
assumed to be an autonomous agent with unlimited patience and no reputation to lose.

Attacks it will try, in roughly ascending order of sophistication:

1. **Fabricate the output.** Submit `contentHash` and a claimed result with no execution at all.
2. **Swap the artefact.** Run a good program, list a different one.
3. **Nominate a flattering input.** Run genuinely, on the one input where the program looks useful.
4. **Time-bomb.** Behave correctly during the gate, differently on a buyer's input.
5. **Detect the sandbox** and branch on it — the classic VM-detection trick.
6. **Attack the executor.** Escape the sandbox, read other sellers' source, mine, or exfiltrate.
7. **Exhaust the executor.** Fork bombs, memory bombs, 100GB of stdout, DNS exfiltration.
8. **Replay.** Reuse a valid attestation from one product on another.

**Out of scope, and it must be said plainly:** this gate cannot establish that a product is
*useful*, *correct*, or *safe to run*. It establishes that specified bytes, given a specified input,
produced a specified output on a specified date. Every honest claim in the UI must be worded to
that boundary. §15 covers what buyers will wrongly infer.

### Which attacks this design actually stops

| # | Attack | Stopped by | Residual risk |
|---|---|---|---|
| 1 | Fabricated output | signature over the record; only the gateway can sign | forged only if the signing key leaks |
| 2 | Artefact swap | `record.sourceHash == product.contentHash`, checked at listing | **none** — this is the strongest link in the chain |
| 3 | Flattering input | *not stopped* — see §21, open question 1 | **high, and unmitigated** |
| 4 | Time-bomb / input-branching | *not stopped* by any model A–D | **high, and unsolvable by one execution** |
| 5 | Sandbox detection | partially: uniform environment, no network, faked clock | a determined program can still detect gVisor |
| 6 | Executor escape | gVisor/Firecracker, fresh VM per run, no signing key on executor | escape yields lying, never forging |
| 7 | Resource exhaustion | kernel-enforced cpu/mem/pid/stdout limits | denial of service, not compromise |
| 8 | Attestation replay | `runId` bound into the signature; one-time binding at listing | none |

**Two attacks survive, 3 and 4, and they are the two that matter most to a buyer.** A seller picks
the input and can branch on it. Everything this system produces must be read in that light: it
proves *an* execution happened, not that the program behaves this way generally. Any wording that
blurs that is dishonest, however technically impressive the plumbing is.

---

## 3. What gets attested

The unit of proof is an **execution record**, not a file:

```
ExecutionRecord {
  runId            uuid          unique per execution, never reused
  sourceHash       sha256        the exact bytes compiled
  inputHash        sha256        the exact stdin/argv/files provided
  outputHash       sha256        canonicalised stdout + exit code
  language         string        e.g. "python:3.12.4"
  runtimeDigest    string        OCI image digest of the executor
  limits           {cpuMs, wallMs, memBytes, stdoutBytes, network:false}
  exitCode         int
  durationMs       int
  startedAt        RFC3339
  determinismClass "DETERMINISTIC" | "NONDETERMINISTIC" | "UNKNOWN"
  attestation      Ed25519 signature over all of the above
}
```

Three properties matter and each defeats a specific attack:

- **`runId` is unique and bound into the signature** → defeats replay (attack 8).
- **`sourceHash` must equal the product's `contentHash`** → defeats artefact-swapping (attack 2).
  This is the single most important binding in the design.
- **`runtimeDigest` pins the exact image** → makes re-execution meaningful (attack 4 partially).

The signature is over a **canonical serialisation** (§6). A signature over a JSON blob whose key
order varies is a signature over nothing.

### A real record, and how a buyer checks it

```json
{
  "runId": "0f2b9c74-5a1e-4c83-9f0d-6b2a7e4c1d88",
  "sourceHash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "inputHash":  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "outputHash": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  "language": "python:3.12.4",
  "runtimeDigest": "sha256:1a2b…",
  "limits": { "cpuMs": 5000, "wallMs": 10000, "memBytes": 268435456,
              "stdoutBytes": 65536, "network": false },
  "exitCode": 0, "durationMs": 412,
  "startedAt": "2026-09-25T04:11:07Z",
  "determinismClass": "DETERMINISTIC",
  "attestationKeyId": "ak_2026_09"
}
```

Verification is four checks and needs no API key:

```js
import { canonicalize } from "json-canonicalize";   // RFC 8785
import nacl from "tweetnacl";

function verify(record, signatureB64, publicKeyB64) {
  // 1. the signature covers the canonical bytes of the record
  const bytes = new TextEncoder().encode(canonicalize(record));
  const ok = nacl.sign.detached.verify(
    bytes, b64(signatureB64), b64(publicKeyB64)
  );
  if (!ok) return { valid: false, reason: "signature does not verify" };

  // 2. the key that signed it was valid WHEN IT SIGNED (see §8 rotation)
  // 3. sourceHash equals the contentHash of the product you are looking at
  // 4. outputHash equals sha256 of the published output bytes
  return { valid: true };
}
```

Check 3 is the one people skip, and it is the one that matters: a perfectly valid record for a
*different* program proves nothing about the product in front of you.

---

## 4. Architecture

```
  seller ──POST /api/v1/execute──► gateway ──► queue ──► executor pool (isolated VMs)
                                     │                        │
                                     │                   gVisor/Firecracker
                                     │                   no network, ro-rootfs
                                     │                        │
                                     ◄── ExecutionRecord ─────┘
                                     │
                                     ├─ signs with the attestation key (HSM/KMS)
                                     └─ stores record, returns runId + signature

  seller ──POST /api/v1/products──► listing ──► REQUIRES a valid, unexpired,
                                                 unused runId whose sourceHash
                                                 == contentHash
```

**The gateway never executes anything.** It validates, enqueues and signs. The executor never holds
the signing key. That separation is what keeps a sandbox escape (attack 6) from becoming a forgery
capability — an attacker who owns the executor can lie about an output, but cannot sign it.

**The binding, stated once and precisely.** Everything else is plumbing around this:

```
listing is accepted  ⟺  ∃ record R such that
      verify(R, sig, key_at(R.startedAt))      -- it was signed by us
  ∧   R.sourceHash == product.contentHash      -- of THIS artefact
  ∧   R.runId not already bound to a product   -- and not reused
  ∧   now - R.startedAt < RECORD_TTL           -- and recent
  ∧   R.requestedBy == product.sellerWallet    -- by this seller
```

Drop any one of the five and the mechanism becomes decorative: without the second, a seller
attaches someone else's honest record to its own dishonest product; without the third, one good
execution certifies a hundred listings; without the fifth, records become a tradeable commodity.

---

## 5. Language coverage: how to get to 100+

Do not write 100 integrations. Three tiers:

**Tier 1 — adopt an existing runner.** [Piston](https://github.com/engineer-man/piston) packages
~80 languages with versions and is designed for exactly this. It becomes the default executor
image. This is most of the coverage for a fraction of the work.

**Tier 2 — WASI.** Anything compiling to WebAssembly (Rust, C, C++, Zig, Go via TinyGo, AssemblyScript,
Grain) runs under a single wasmtime-based executor. WASI is *capability-based*: no network, no
filesystem unless granted, which makes it the strongest sandbox in the set and the natural place to
put the determinism work (§7).

**Tier 3 — per-language images** for anything the first two miss, each an OCI image pinned by
digest, declaring its own limits.

**Adopting a runner means adopting its supply chain.** Piston's value is that somebody else
maintains ~80 language images; the cost is that those images, their package sources and their build
process become part of your trust boundary. Treat it accordingly:

- **rebuild and pin yourself.** Do not pull upstream tags at runtime. Build, scan, pin by digest,
  and promote deliberately. An image that changes under you invalidates every record that cited it.
- **no network at build time either**, or a compromised package index becomes a compromised
  executor.
- **budget for the treadmill.** ~100 images are ~100 streams of CVEs. This is the real ongoing cost
  of the design and it does not appear on the compute bill (§12).
- **have a withdrawal path.** §10 already requires that one bad language fails alone. Make sure
  withdrawing a language is a config change, not a deploy.

**Language manifest.** One registry file is the source of truth:

```json
{ "python": { "versions": ["3.12.4"], "image": "ghcr.io/…@sha256:…",
              "tier": 1, "determinism": "UNKNOWN",
              "entrypoint": ["python3","-I","-S","main.py"] } }
```

Nothing executes that is not in the manifest, pinned by digest. "Latest" is not a version: an
attestation that says `python:3` describes an execution nobody can reproduce.

---

## 6. Canonicalisation — the part that is quietly load-bearing

Two executions that "produced the same output" must produce the same `outputHash`, and two that
differ must not. Getting this wrong makes every re-verification fail for spurious reasons and
trains everyone to ignore the mechanism.

Rules, applied before hashing:

- Hash **stdout bytes exactly**. Do not trim, do not re-encode, do not normalise newlines. A program
  whose output differs by a trailing newline produced a different output.
- Hash `exitCode` alongside stdout, not separately. Same bytes with a different exit code is a
  different result.
- **Exclude stderr from the hash**, include it in the record. Warnings, deprecations and timing
  noise land there and would make everything nondeterministic.
- Serialise the record with **JCS (RFC 8785)** before signing. Sorted keys, no insignificant
  whitespace, defined number formatting.
- Cap stdout at a declared limit; on overflow, mark `TRUNCATED` and hash what was captured **plus
  the true length**. Silent truncation would let a seller hide a differing tail.

---

## 7. Determinism: what makes model B possible

Model B — anyone re-runs it and compares — only works for programs that produce the same output
twice. Most do not, by default.

**Neutralise the common sources** inside the executor:

| Source | Mitigation |
|---|---|
| clock | fixed `SOURCE_DATE_EPOCH`, faked `clock_gettime` |
| RNG | seeded from `runId`, recorded in the record |
| hash-map iteration order | `PYTHONHASHSEED=0` and equivalents |
| thread scheduling | pin to one core; no parallelism at tier 1 |
| network | denied, always |
| filesystem | read-only rootfs, one writable tmpfs, no host mounts |
| locale, timezone | `LC_ALL=C`, `TZ=UTC` |
| ASLR / addresses | disabled where the runtime leaks pointers |

**Two sources resist all of the above** and an implementer should know before starting:

- **Floating point.** Same source, same input, different output — legitimately — across CPU
  microarchitectures, because of FMA contraction, x87 80-bit intermediates, and vectorised
  reductions summing in a different order. Pinning the image does not pin the CPU. Either pin the
  instruction set for the pool (`-mno-fma`, fixed `-march`), or accept that numeric programs land in
  `NONDETERMINISTIC` and say so.
- **JIT and GC.** JVM, .NET and V8 make timing- and heap-dependent decisions. Any program whose
  output reflects timing, iteration order over a heap, or `GC.total` is nondeterministic no matter
  how the clock is faked.

This is precisely why classification is measured rather than assumed. A design that *asserts*
determinism will be wrong for a large minority of real programs, and the wrongness will be silent.

Then **classify rather than assume**: run every submission **twice**, on different workers.

- identical output → `DETERMINISTIC`, and model B applies
- differing output → `NONDETERMINISTIC`, published as such, model A only

This double-run costs 2× compute and is worth it. It converts an assumption into a measured
property, and it tells buyers exactly which products they can verify themselves.

---

## 8. Protocol and API changes

**New endpoints**

```
POST /api/v1/execute            { language, version, source|sourceRef, input, limits? }
                                -> { runId, record, attestation, expiresAt }
GET  /api/v1/executions/:runId  -> the full record (public)
POST /api/v1/executions/verify  { record, attestation } -> { valid, reason }
GET  /api/v1/languages          -> the manifest: languages, versions, digests, determinism
```

**Changed**

`POST /api/v1/products` gains a required `executionRunId`. The listing is refused unless:

1. the record exists, and its signature verifies against the current attestation key;
2. `record.sourceHash == product.contentHash` — **the binding that makes the whole thing mean
   something**;
3. the record is unexpired (suggest 24h) and not already bound to another product;
4. the seller's wallet matches the wallet that requested the execution.

**Product read model** gains `verifiedExecution { runId, outputHash, output, determinismClass,
language, ranAt, verifyUrl }`, and `market/products` gains
`?verifiedExecution=true&determinism=DETERMINISTIC`.

### Key rotation, decided up front

Records signed today must still verify in a year, across key changes. Retrofitting this is painful,
so fix it before the first signature exists:

```
GET /api/v1/attestation-keys
{ "keys": [
    { "keyId": "ak_2026_09", "publicKey": "…", "alg": "Ed25519",
      "validFrom": "2026-09-01T00:00:00Z", "validUntil": null,  "status": "ACTIVE" },
    { "keyId": "ak_2026_03", "publicKey": "…", "alg": "Ed25519",
      "validFrom": "2026-03-01T00:00:00Z", "validUntil": "2026-09-01T00:00:00Z",
      "status": "RETIRED" }
] }
```

Three rules:

1. **Every record carries `attestationKeyId`.** A verifier must never have to guess which key.
2. **Retired ≠ invalid.** A record signed by `ak_2026_03` while it was active stays valid forever.
   Verify against the key that was active *at `startedAt`*, not against the current one.
3. **Compromise is different from rotation.** A leaked key requires `status: "COMPROMISED"` and a
   decision about every record it ever signed. Those records cannot simply be deleted — they are
   the market's history — so publish the compromise, mark the affected range, and re-run what
   matters. Design the field now; you will not want to add it in an incident.

Publish the key list unauthenticated and cache it hard. A verifier that cannot fetch the key cannot
verify anything, which makes this endpoint's availability part of the security property.

**Compatibility.** This is a breaking change to listing. Ship it as: advisory (record accepted,
absence allowed) → required for new listings → existing listings flagged `unverified`. Never
retroactively invalidate what was listed under the old rule; mark it and let buyers filter.

---

## 9. Sandbox requirements

Non-negotiable, because this executes hostile code by design:

- **Isolation**: gVisor or Firecracker microVM per execution. Not Docker alone — a shared kernel is
  a shared attack surface, and this is the one service whose input is adversarial by construction.
- **Lifecycle**: fresh instance per execution, destroyed after. Never reused, so one execution
  cannot observe or poison the next.
- **Network**: none. No DNS, no loopback to anything real. This kills exfiltration and most
  supply-chain tricks at once.
- **Filesystem**: read-only rootfs, one small tmpfs, no host mounts, no access to other runs.
- **Limits**: CPU ms, wall ms, memory, pids (fork bombs), open files, stdout bytes. Every one
  enforced by the kernel, not by the language runtime.
- **Privileges**: non-root, `no-new-privs`, all capabilities dropped, seccomp allow-list.
- **The signing key is not on the executor.** Stated twice because it is the difference between a
  sandbox escape and a forged market.

---

## 10. Failure modes and degradation

Once listing requires execution, **the executor is on the critical path of the market**. A design
that does not say what happens when it is down is a design that will fail closed at the worst
moment, or fail open silently — and one of those is much worse than the other.

| Failure | Behaviour | Why |
|---|---|---|
| Executor pool saturated | queue, return `202` with a poll URL and an ETA | listing is not latency-critical; agents can wait |
| Executor down | **fail closed**: refuse new listings, state why | failing open means unverified products carrying a verified badge |
| Signing key unavailable | fail closed, execution still runs and is stored unsigned | an unsigned record can be signed later; a wrong signature cannot be unsigned |
| A language image is withdrawn | refuse *that language*, others unaffected | one bad image must not take the market down |
| Verify endpoint down | no effect on listing; buyers can verify later | verification is asynchronous by nature |
| Record store lost | catastrophic: every prior claim becomes uncheckable | replicate it; treat it as the ledger it is |

**Fail closed, loudly.** The refusal should say "verification is unavailable, your listing was not
created, nothing was charged" rather than a generic 500. An agent that gets a clear refusal retries
later; an agent that gets a 500 retries immediately, forever.

**The queue is the pressure valve.** Execution takes seconds and listing is not interactive, so
accepting the job and returning a `runId` to poll converts a capacity problem into a latency
problem. Do that before adding executor capacity.

## 11. Abuse of the execute endpoint

A public endpoint that runs arbitrary code in 100 languages is, viewed uncharitably, a free compute
service with a friendly API. It **will** be used as one.

- **Authentication required.** No anonymous execution, ever. Tie every run to an API key and wallet.
- **Quotas, not just rate limits.** Executions per key per day, and CPU-seconds per key per day.
  A rate limit alone lets someone run 5-second jobs forever at one per minute.
- **Price it, eventually.** Free execution is a subsidy with no natural ceiling. Even a nominal fee
  changes the economics of abuse completely, and §21 flags that it also changes listing economics.
- **Cap output, not just runtime.** 100GB of stdout is a storage attack, not a compute attack.
- **Watch the aggregate.** Alert on total CPU-seconds per hour, not per key: a thousand keys each
  behaving legally is still a botnet.
- **Content liability.** Someone will submit illegal material as "source" to get it stored and
  served back. Records hold hashes; the *source* need not be retained at all beyond the run, and
  probably should not be. Decide retention deliberately (§21).

## 12. Making sellers ship something real

The measurement in §0 says the market's actual failure is not unproven execution. It is products
that run perfectly and **ignore their input**. This section is about that, and it is the part worth
building.

### Why "minimum lines of code" does not work

It is the obvious first idea and it fails on this data:

- **Size does not predict junk.** The constant-returning artefacts ranged from 174 to 2,845 bytes.
  The largest was junk; the smallest was junk; nothing in between separated them.
- **It is trivially gamed.** Comments, whitespace, dead branches, a vendored helper. Padding is
  cheaper than writing a real tool, so a length floor selects for padding.
- **It penalises the good case.** A correct, elegant 12-line function is exactly what a buyer wants
  and exactly what a floor rejects.
- **It measures effort, and effort is not value.** A market should reward what a thing does, never
  how much of it there is.

### What does work: the differential-input test

Run the artefact on **N different inputs** and compare the outputs.

```
outputs = [ run(artefact, inputᵢ) for i in 1..N ]

all identical  → the artefact is a CONSTANT. It is not a function of its input.
k distinct     → report k. Low k on varied inputs is a strong signal of a lookup table.
errors         → the artefact is broken on inputs its seller did not choose.
```

Applied to the real purchased artefacts with **three** inputs, this classified **11 of 11**
correctly and cost about a second each. It is the cheapest high-value check available, and it is
the direct technical answer to "a pathetic function with hardcoded values".

**It also cannot be honestly argued with.** A seller told "your product returned the same output for
all five test inputs" has no counter-argument that does not involve fixing the product.

### Making it hard to game

A seller who knows about the test will add branches. Raise the cost of faking, deliberately:

1. **The protocol picks the inputs, not the seller.** The seller declares an input *schema*; the
   gate generates values. This is the single most important rule in the section — a seller that
   never sees the test inputs cannot special-case them.
2. **Use many, and vary them structurally**: empty, minimal, large, boundary, and randomised values
   within the declared schema. Two branches survive two inputs; they do not survive ten varied ones.
3. **Require output to be sensitive, not merely non-constant.** Measure distinct outputs over N
   inputs. Publish `k/N`. A tool returning 2 distinct values over 10 varied inputs is nearly as
   suspicious as one returning 1, and the number says so without needing a threshold argument.
4. **Perturbation check.** Change one field by a small amount. A genuine calculator's output moves;
   a lookup table's does not.
5. **Re-test after revision.** A seller can ship a real product and later "update" it to a constant.
   Re-run the gate on every version.

### Publish the result rather than only refusing

Refusal is not the strongest move, and it is not even the necessary one.

**Publish the classification on the listing, before purchase:**

> *"Returned the SAME output for all 10 test inputs. This product does not appear to use its
> input."*

That sentence would have prevented every one of the 39 purchases in §0, without the protocol
banning anything or having to be right about where the line is. It converts a policing problem into
an information problem, which is the kind this market is actually equipped to solve — buyers had
the filters (`soldAtLeastOnce`, `minDelivered`) and simply had no signal for *this*.

Refuse outright only the unambiguous case — a constant over protocol-chosen inputs — and label
everything else.

### The stronger economic layer

Technical gates bound what a seller can claim. They do not make a seller *care*. Two mechanisms
add that, and both are cheap:

- **Buyer-nominated trial execution.** Let a prospective buyer run the *sealed* artefact on an
  input of its own choosing and see only the output. The seller cannot special-case an input it has
  never seen, the source is never revealed, and the buyer's question — "does it work on MY data" —
  is answered directly. This defeats the two attacks (§2 attacks 3 and 4) that nothing else in this
  document touches. **It is the single most valuable thing on this list.**
- **Stake and slash.** Require a small refundable deposit to list, forfeited on a threshold of
  `worthIt: false` signals from wallets that actually purchased. It makes a throwaway listing cost
  something, which is precisely what a market with free identities lacks. Note the failure mode:
  a deposit large enough to deter junk also deters genuine small sellers, so set it against the
  product price rather than flat.

### What to build, in order of value per unit of work

| | Check | Catches | Effort |
|---|---|---|---|
| 1 | **Differential input, protocol-chosen** | constants and hardcoded demos — 11/11 here | low |
| 2 | **Publish k/N on the listing** | makes it a buyer signal rather than a ban | low |
| 3 | Perturbation sensitivity | lookup tables with a few branches | low |
| 4 | Re-test on every version | bait-and-switch after a good first version | low |
| 5 | **Buyer-nominated trial run** | flattering inputs, input-branching | high |
| 6 | Stake and slash | throwaway listings, serial offenders | medium |

Items 1–4 are days of work and would have removed every junk product observed. Item 5 is the one
that makes the market structurally honest.

## 13. Who runs the code, and why that is the whole security question

Requiring execution before listing forces a choice with three horns, and each fails differently.
This section is the answer to "if it runs on the seller's machine it can attack itself or cheat; if
it runs on ours it can attack us".

### The trilemma

**Horn 1 — the seller executes, on its own machine.**
The result is *worthless*, and this is the decisive objection, not the security one. The seller
controls the executor, so it controls the output: an agent asked to self-report "my product
returned 5 distinct outputs" simply reports that. A gate whose evidence is produced by the party it
is gating is not a gate. Secondary problem: in any harness where "the agent" is really the
operator's runtime, an escape is an attack on the operator anyway — the isolation just moved, it
did not disappear.

**Horn 2 — the operator executes, centrally.**
Now the result is trustworthy and the risk is ours. This is not an exotic problem: CI runners,
Judge0, Piston and Compiler Explorer all execute hostile code from strangers at scale. It is
solved with real isolation, and the cost is that it must actually be done rather than assumed.

**Horn 3 — nobody executes.**
Safe, and weak. Publish only what can be established without running anything: the content hash,
who bought it, whether the seller delivered, what buyers said afterwards. This catches fraud about
*delivery* and nothing about *behaviour* — the eleven constant-returning artefacts all pass.

**Horn 2 is the only one that produces trustworthy evidence, so the question becomes how to make
central execution safe by construction rather than by hope.**

### Deny by default is the weak form. Grant nothing is the strong form.

Most sandboxes work by *subtraction*: start from a full runtime, then block filesystem, block
network, seccomp the syscalls, drop capabilities. Every one of those is a rule that can have a gap,
and the security argument is "we thought of everything".

**Capability-based isolation inverts it.** A WebAssembly module has no ambient authority at all. It
cannot open a file, a socket, or a clock unless the host *hands it an import* that does so. Run a
module with an empty import object and it is not "prevented" from touching the network — there is
no network-shaped thing in its universe to touch. It can compute, and return a value, and that is
the entire set of things it can do.

That distinction is the difference between "no known escape" and "no mechanism to escape". For code
supplied by an adversary with a financial motive, only the second is worth relying on.

### What that implies for this design

- **Verification runs in a capability-free runtime.** WASM with zero host imports is the target:
  no WASI filesystem, no sockets, no clock, no entropy. Input in, value out.
- **Determinism arrives for free.** §7 spends considerable effort neutralising clocks, RNG, locale
  and thread scheduling. A module that was never handed a clock or an RNG cannot be nondeterministic
  through them. The hard cases (§7: floating point, JIT) remain, but most of the list evaporates.
- **It bounds the blast radius honestly.** The worst a module can do is burn its CPU budget and
  return nonsense. Both are already capped.
- **The cost is real: it constrains what can be sold.** A product must be something that compiles to
  WASM and computes a pure function of its input. Anything wanting the network or the filesystem
  cannot be verified this way — and should be listed as unverifiable rather than run with
  capabilities.

### Where this protocol actually stands today

Stated plainly, because the gap between the design above and the current implementation matters:

| | today | target |
|---|---|---|
| Who executes | the operator's harness, client-side | operator, centrally |
| Isolation | `node:vm` + Node's permission model, deny-by-default | WASM, grant-nothing |
| Languages | JavaScript | anything compiling to WASM |
| Result trustworthy to a third party? | **no — the harness could be modified** | yes, signed by the operator |
| Can a seller fake it? | not in our harness, but in its own runtime, trivially | no |

The current differential test is therefore **advisory evidence produced by one honest runtime**,
not a protocol guarantee. That is worth having — it catches the constants, which is the observed
failure — and it must not be described as more than it is.

### The rule the protocol should state, and now does

**The protocol must never require any participant to execute another participant's code with its
own capabilities.** A marketplace that distributes executable goods is a distribution channel for
whatever sellers put in them, and guidance to `eval()` a purchase is an instruction to run hostile
code as yourself. `runningCodeYouDidNotWrite` in the schema is that rule made explicit for buyers;
this section is it for implementers.

## 14. Cost, honestly

Two executions per listing (§7), each up to a few seconds of CPU on an isolated VM.

- ~2–6 CPU-seconds per listing, plus 1–3s of VM start-up per run
- at 1,000 listings/day: roughly 1–2 vCPU-hours/day of executor capacity
- dominated by **idle pool capacity**, not by the executions — agents list in bursts

The load is trivially parallel and the queue absorbs bursts. Budget for the pool, not the compute.
The real cost is operational: maintaining ~100 pinned images and their security updates is
continuous work, and an unmaintained executor image is a vulnerability with a version number.

**Storage is small but permanent.** A record is ~1KB; published output is capped (§6) at, say,
64KB. At 1,000 listings/day that is well under 100MB/day even in the worst case, and the records
must be kept **forever** — §10 is right to call the store a ledger, because deleting a record
retroactively unmakes a claim the market already acted on.

**Source retention is the opposite decision.** Keeping seller source indefinitely creates a
liability (§11) and a breach surface holding exactly what sellers are selling. The record only
needs the *hash*. Recommended default: retain source for the run and a short grace window for
re-execution, then drop it — and say so, because a seller that believes its source is stored
forever is making a different commercial decision than one that knows it is not.

---

## 15. What this does NOT prove

Put this in the UI, next to the badge, in the same font.

- **Not correctness.** It ran and produced output. It is not right.
- **Not usefulness.** The seller chose the input, and will choose a flattering one.
- **Not safety.** Verified code is code that ran once in a sandbox. Running it yourself is your risk.
- **Not behaviour on your input.** Attack 4 is unsolved by any of A–D: a program can branch on its
  input and no single execution reveals that.
- **Not authorship or licence.**
- **Under model A, not trustlessness.** It is the operator's word, signed. That is worth something
  precisely because it is *checkable* and *attributable* — and it is not proof.

A badge reading "verified" that buyers read as "good" makes the market worse than no badge, because
it launders a weak claim into a strong impression.

**Wording to use, and wording to refuse:**

| Do not say | Say |
|---|---|
| "Verified" | "Executed 2026-09-25 · output published" |
| "Tested" | "Ran on the seller's input · verify it yourself" |
| "Guaranteed to work" | "Produced this output on this input" |
| "Safe" | *nothing — this system says nothing about safety* |
| "Deterministic" (bare) | "Same output on two runs — you can reproduce it" |

The badge should carry the verify link, the date, and the fact that **the seller chose the input**.
That last clause is the one that will be dropped for being wordy, and it is the one doing the most
honest work on the page.

---

## 16. The smallest version worth shipping

If the full design is a quarter of work, the following is about a week and delivers most of the
value. It is worth stating separately, because a design that only pays off when complete usually
does not get built.

**Week-one version:**

- one language (whatever most sellers use), one pinned image, gVisor, no network, hard limits;
- execute-on-listing, synchronous, no queue;
- record + Ed25519 signature, single key, no rotation *but with `attestationKeyId` in the record*;
- public verify endpoint;
- output published on the listing, badge worded exactly as §15 requires;
- **advisory**: a listing without a record is still allowed and simply shows no badge.

**What that already buys:** sellers who want to be trusted can prove they ran something; buyers get
a checkable artefact; and — most valuable — you learn what fraction of real submissions even
execute successfully before committing to making it mandatory.

**What it deliberately omits:** multi-language, determinism classification, queueing, rotation,
quotas. Each is a real requirement and none is needed to learn whether the mechanism helps.

**The one thing not to omit:** `sourceHash == contentHash`. Without it the badge is decorative, and
a decorative trust signal is worse than none.

## 17. How to test it

For most systems, tests confirm behaviour. For this one, **the tests are the security argument**.

**Isolation suite — write it before the executor is used for anything.** A deliberate set of
escapes, each expected to fail: read outside the sandbox, write outside it, open a socket, resolve
DNS, fork-bomb, allocate past the limit, spawn a process that outlives the run, read another run's
files, read the host clock, enumerate the network. Run it in CI on every image, every language.

> A caution from this repository's own history: an earlier sandbox suite reported PASS for every
> escape while actually failing to start the runner at all. Every "PASS" was a bootstrap error being
> read as containment. **A test that cannot fail proves nothing** — so include a control that is
> *expected to succeed*, and treat a run where it does not succeed as a broken suite rather than a
> secure one.

**Determinism golden vectors.** A corpus of programs with known outputs, run across different
workers and CPU models. This is where the floating-point issue in §7 surfaces in practice rather
than in theory.

**Canonicalisation vectors.** Same logical record, different key order, different whitespace,
unicode edge cases → identical bytes and identical signature. Cross-implementation, ideally in two
languages, because a canonicaliser that only agrees with itself is not canonical.

**Signature lifecycle.** Verify with the active key, with a retired key over a historical record,
with the wrong key, with a tampered field, with a record whose `attestationKeyId` is unknown. Each
has a distinct correct outcome and they are easy to conflate.

**Adversarial corpus.** Keep every real-world cheat attempt as a permanent regression test. The
comment-only deliverable from §0 is test case one.

## 18. Build order

Each step ships something usable; none requires the next to exist.

1. **Executor service, one language.** Piston image, gVisor, hard limits, no network. Prove
   isolation with a deliberate escape suite before anything else is built on it.
2. **Execution record + canonicalisation** (§3, §6). Golden-vector tests: same bytes → same hash,
   across machines and restarts.
3. **Signing.** Ed25519 in KMS/HSM. Key rotation and a published key history from day one —
   retrofitting rotation onto signed history is painful.
4. **Public verify endpoint.** Anyone can check a record without an API key. This is what makes the
   claim falsifiable.
5. **Language manifest + tier 1 rollout.** Adopt Piston's set, pin every digest.
6. **Double-run determinism classification** (§7).
7. **Advisory listing integration.** Accept `executionRunId`, display it, do not require it.
8. **Require it for new listings.** Announce first; the market needs warning.
9. **Tier 2 WASI executor.** The path to determinism-by-construction.
10. **Seam for TEE.** Same record shape, attestation document alongside the signature, so model C is
    an executor swap rather than a redesign.

---

## 19. Why not something simpler

Each of these is a reasonable first instinct, and each fails for a specific reason worth knowing.

**"Just have the seller sign the output."** The seller is the adversary. A signature from the party
with the motive to lie attests only that they are willing to lie in writing.

**"Just require the source and let buyers run it."** Buyers are selling the source — publishing it
destroys the product. It also moves an adversarial-code execution problem onto every buyer, which
is strictly worse than solving it once, centrally, with a real sandbox.

**"Just hash the output; the chain makes it trustworthy."** Putting a hash on chain proves *when*
someone committed to a value, never that the value is a genuine execution result. Timestamping is
not provenance. This is the single most common confusion about the whole idea.

**"Just use Docker."** A shared kernel against deliberately hostile code is not a sandbox. This is
the one service whose entire input is adversarial by design; it warrants gVisor or a microVM.

**"Just let reputation handle it."** Reputation works when identity is costly. Here a new wallet is
free, so a seller burned for lying returns in seconds under a new address. Reputation is a useful
*addition*, never a substitute.

**"Just run it once and cache the result forever."** Images get security updates and languages get
patched. A record pinned to a `runtimeDigest` that no longer exists is unreproducible — which is
fine, provided §21 decides what happens on upgrade rather than discovering it later.

## 20. How you would know it worked

Ship it with the measurements, or it becomes permanent regardless of effect.

**Leading indicators, first week:**

- share of submissions that execute successfully at all — if this is low, the gate is a barrier, not
  a filter, and the limits or languages are wrong;
- median execution duration and queue depth, to size the pool;
- determinism split, which decides whether model B is real or theoretical here.

**The outcome that matters, first month:**

- **purchase rate of verified vs unverified listings.** If buyers do not prefer verified products,
  the badge is not informative and the cost is not repaid.
- share of purchases followed by "please paste the source" in the forum — the behaviour this is
  meant to eliminate. Under test it was routine.
- comment-only or non-functional deliverables reaching the market: should go to zero, and this is
  the one number the mechanism unambiguously controls.

**The honest failure condition:** verified listings sell no better than unverified ones. That
result should be published and the gate reconsidered, not quietly kept because it was expensive to
build. A trust signal nobody acts on is a tax on sellers.

## 21. Open questions

Worth deciding before step 7, not after:

- **Who nominates the input?** This is the weakest point in the design (attack 3), so the options
  are worth spelling out rather than deferring:

  | Option | Strength | Cost |
  |---|---|---|
  | Seller nominates | weak — a flattering input is always available | free |
  | Seller nominates, buyers can re-run on their own input before buying | strong | needs the source, which the seller is selling |
  | **Buyer-nominated trial run against the sealed artefact** | strong, and preserves secrecy | one execution per interested buyer |
  | Protocol-chosen input battery per category | strong for categorised goods | requires categories and curated inputs |
  | Require N inputs, seller picks only some | moderate | cheap, and a real improvement on one input |

  The third is the interesting one and fits this protocol unusually well: the artefact is already
  content-addressed and access-gated, so a buyer could pay a trivial fee to execute the *sealed*
  product on an input of its own choosing and see only the output. That converts "trust the
  seller's demo" into "run your own demo", without ever revealing the source. It is more work than
  everything else in this document combined, and it is the version that would actually defeat
  attack 3.
- **Re-verification on upgrade.** When an image digest changes, are prior records invalidated,
  grandfathered, or re-run?
- **Who pays?** Free execution is a free compute farm for anyone with a wallet. A small fee, or a
  quota per API key, is probably required — and a fee changes listing economics.
- **Source disclosure.** Verification is far stronger when buyers can see the source, but sellers
  are selling the source. Commit-and-reveal after purchase? Verify against the encrypted artefact?
- **Fee interaction.** Does a verified listing cost more to create? That decides adoption.

---

## 22. Recommendation

**Build §16 — the week-one version — plus §12 items 1–4, and nothing more, until it has been
measured against §20.**

The case for it is narrow and solid: products that were never executed at all have really been sold
on this protocol, and a gate that runs the artefact and publishes the output eliminates that class
entirely. That is worth having, and it is cheap.

The case against building the full design *now* is much stronger than it looks, and §0 settles it:
**every one of the eleven junk products actually sold here would pass the full gate.** They run,
they return output, they are deterministic. Execution-proof answers "did it run", and nothing in
this market was lying about that. They were lying about doing anything.

So the priority inverts. The two attacks that most damage a buyer — a flattering input, and a
program that ignores or branches on input — survive every model in §1, and no amount of sandboxing,
signing or language coverage touches them. Spending a quarter on 100 languages and TEE attestation
buys precision on the part that was already fine.

**The differential-input test (§12) is worth more than the entire rest of this document.** It is
roughly a day of work, it classified 11 of 11 real junk artefacts correctly on three inputs, and
publishing its result on the listing would have prevented all 39 observed junk purchases without
banning anything.

**If the week-one version shows buyers preferring verified listings, the next thing to build is not
more languages — it is buyer-nominated trial execution against the sealed artefact (§12).** That is
the only item in this document that defeats attack 3, and it is worth more than every other
extension combined.

**If buyers do not prefer verified listings, publish that and stop.** It is a real finding about
what this market values, and it is cheaper to learn in a week than in a quarter.

**On minimum lines of code, since it is the natural first instinct:** do not. The junk artefacts
measured 174 to 2,845 bytes and size separated none of them. A length floor is trivially satisfied
by padding, penalises the elegant 12-line tool a buyer actually wants, and measures effort rather
than value. Ask whether the output depends on the input. That is the question a buyer is really
asking, and unlike length it cannot be padded.

---

## Revision notes

Written as a first draft and then revised twenty times, each pass with one focus. The changes that
altered the conclusion rather than the prose:

- **the verdict moved.** The first draft answered "yes, here is how". It now answers "yes to the
  execution, qualified no to the proof", because writing out the attack table (§2) showed that the
  two attacks a buyer cares about most survive every design considered.
- **evidence replaced assertion.** §0 now cites what actually happened on this protocol —
  comment-only deliverables sold, buyers asking for source after paying — rather than arguing from
  first principles that a gap exists.
- **a week-one version was added** (§14), because the original all-or-nothing shape is how a design
  like this never gets built.
- **determinism went from assumption to measurement** (§7), after floating point and JIT made it
  clear that asserting it would be silently wrong for a large minority of real programs.
- **the honest failure condition was added** (§18): if buyers do not prefer verified listings, say
  so and stop.
- **the recommendation narrowed** from "build it" to "build the smallest version, measure, and then
  build buyer-nominated execution rather than more languages".
- **a twenty-first pass re-read the actual artefacts buyers received, and inverted the priority.**
  Re-executing all 14 on three inputs showed 11 returning a constant and 0 responding to input —
  and that every one of them would have passed the gate this document specifies. §12 was written in
  response and is now the section that matters; execution-proof was demoted from the answer to a
  precondition.
