# On-chain product content — design

**Status:** design v2, after 20 review iterations (log at the end); not yet implemented · **Scope:** where the bytes a product delivers live, who can
decrypt them, and what the site still has to run · **Chains:** Base mainnet (8453) and Base Sepolia (84532)

## 1. Goal

Today the protocol stores every product's content. A seller sends plaintext to `POST /api/v1/stores/{id}/products`
(or `/api/v1/access/content`); the backend encrypts it with AES-256-GCM under a key derived from one master key
(`backend/src/access/content.ts`), keeps the ciphertext in MongoDB (`ProductContent`, at most 8 MiB,
`backend/src/access/storeContent.ts`), and after a purchase serves the plaintext to the license holder
(`backend/src/api/routes/access.ts`). The chain holds only `contentHash = keccak256(plaintext)` in the product.

The goal: **the content lives on chain as encrypted bytes; the site keeps no files and runs only a translator** that
turns what is on chain into a file download for whoever holds a valid license — for a 770-byte tool and for a
multi-gigabyte dataset alike.

## 2. Overview

```
 seller SDK ──encrypt (§4)──► ciphertext ──► tier S: Base contract code        ┐
     │                                   └─► tier X: Arweave (+ mirrors)       ├─ every chunk checked against
     │                                                                          │  the Merkle root on chain (§3)
     └─split secret (§5.4)──► shares, off chain, one per keeper ──► keepers    ┘
                                                                     │
 buyer: buys a license (as today) ──► asks each keeper ──────────────┘ t shares ──► K ──► decrypts locally
        downloads ciphertext from the translator (§7), or from anywhere, and verifies it
```

What is on chain: the header, the Merkle root, the chunk locators, commitments to the key shares, licenses, and (for
tier S) the ciphertext itself. What is never on chain: `K`, any share of it, or any plaintext. What the site runs: a
stateless translator, an optional storage relay, and one keeper among several.

## 3. Storage

### 3.1 One format, placed by size

Every content object has the same shape: its ciphertext is a sequence of **sealed segments** (§4), grouped into
**chunks**, with a **Merkle root** over the segments committed on chain. Where the chunks live is a property of the
object, so the translator reads every tier the same way — fetch a chunk, check it against the root.

| Tier | Where the chunks live | Default size range | Segment (plaintext) | Chunk = | Permanence (§3.3) |
|---|---|---|---|---|---|
| **S — state** | Base contract code (SSTORE2): each chunk is the bytecode of a data contract | up to 256 KiB | 12,271 bytes | 2 sealed segments, 24,574 bytes (EIP-170 allows 24,576, less the leading `STOP`) | as long as Base exists |
| **X — external** | a content-addressed permanent store (Arweave by default), with optional mirrors | above 256 KiB, no upper bound | 64 KiB | 16 sealed segments, 1,048,832 bytes | the store's guarantee; the chain holds the commitment |
| **H — history** (opt-in copy) | Base calldata of `ContentRegistry.appendChunk` transactions | 256 KiB – 8 MiB | 64 KiB | 1 sealed segment, 65,552 bytes per transaction (the txpool rejects transactions above 128 KiB) | while Base history is kept; always mirrored in X |

A seller may choose a more permanent tier than the default (a 2 MiB tool stored in S), never a less permanent one.

### 3.2 The Merkle tree and the content id

Leaf `i` = `keccak256(i ‖ sealedSegment_i)`; the tree is binary and an odd node is promoted unchanged. A chunk is a
run of consecutive leaves and is verified with those leaves plus one multiproof. The **header** (§4, ≈ 120 bytes) is
stored in `ContentRegistry` itself, so chunks contain only sealed segments. The **content id** is
`keccak256(header ‖ root)`. The root, sizes, tier and locators are in `ContentRegistry`; a chunk that does not hash
into the root is rejected wherever it came from.

### 3.3 How long each tier's bytes survive

- **S (contract code)** is state: every Base full node must hold it to execute blocks, and nothing prunes it today.
- **H (calldata)** is history, not state. Base posts its L1 batches as EIP-4844 blobs, which Ethereum prunes after
  about 18 days; after that the bytes live only on Base nodes that keep history (op-geth does by default) and in
  archives, and a future history-expiry change could drop them from ordinary nodes. That is why H is never the only
  copy: anything in H is also in X (the mirror costs about 4% of the H write).
- **X (Arweave)** is paid once for storage its network is incentivised to keep indefinitely.

### 3.4 Erasure coding and the availability proof in tier X

A heavy object is thousands of chunks, and a single missing chunk ruins the file. Two separate problems follow.

- **Repair.** Tier X objects are **Reed–Solomon coded at rate 4/5**: every group of 16 data chunks gets 4 parity
  chunks, and any 16 of the 20 rebuild the group. The Merkle root commits to data and parity alike. The translator and
  the SDK use this to rebuild around a gateway that lost or corrupted a chunk. Cost: 25% more storage (in §11's X
  column, 58 USD per GiB becomes ≈ 73).
- **Proof that everything is there.** Random sampling does **not** prove availability here: with per-group coding, a
  seller can make one group unrecoverable by withholding 5 of its 20 chunks — under 0.1% of a 5 GiB object — and
  random samples across the object miss that almost always. (Sampling is conclusive only with a code across the whole
  object, like the 2-D scheme of data-availability sampling, which costs far more to encode for no gain here.) So the
  check is **complete, by one keeper**: a keeper chosen by the registration block's hash — so the seller cannot pick a
  friendly one — downloads and verifies every chunk, and the other keepers sample 30 chunks each as a cross-check.
  The full check is paid by the registration fee (§5.6); for 5 GiB it is one 6.25 GB download. The same keeper
  rotation repeats the full check yearly, so a store that silently loses data is found and repaired from parity.

### 3.5 Where a reader gets tier-X chunks

Arweave data is served by many independent gateways (arweave.net and the ar.io gateway network). A locator is the
transaction id, not a URL, so the translator and the SDK try several gateways, and any mirror the seller declared
(IPFS CIDs, an S3-compatible bucket), in parallel, and take the first chunk that verifies against the root. No single
gateway, mirror or company is required; the root makes every source interchangeable.

## 4. Encryption format

One AES-GCM operation over a whole file does not work for heavy content: nothing can be verified until the last byte
arrives, no range can be read on its own, one (key, nonce) pair is limited to about 64 GiB, and GCM does not commit
to its key. The format is a **segmented streaming AEAD** (the STREAM construction used by `age` and Tink):

- **The content key.** The seller's SDK draws a secret scalar `s` in the bn254 scalar field and sets
  `K = HKDF-SHA256(s, "aic-content-key")`. One `s` per content object, i.e. per product version.
- **Segments.** The plaintext is padded (below), then cut into segments of the tier's size (§3.1). Segment `i` is
  sealed with AES-256-GCM under `K`, nonce = `noncePrefix (7 bytes, random per object) ‖ i (4 bytes) ‖ last (1 byte)`,
  AAD = `keccak256(header)`. Reordering, dropping, truncating or splicing segments, or moving one to another object,
  fails authentication.
- **The header** (on chain, §3.2): format version, algorithm, segment size, `noncePrefix`, padded length, a random
  32-byte `salt`, the plaintext commitment `keccak256(salt ‖ plaintext)`, and the **key commitment**
  `HMAC-SHA256(K, "aic-content-key-commitment" ‖ the other header fields)`. The key commitment closes GCM's weakness
  where one ciphertext can decrypt validly under two keys; the salt keeps the plaintext commitment from confirming a
  guess about a known file.
- **Padding.** The padded length is public, so plaintext is padded to the next Padmé size (at most 12% overhead, far
  less for large objects); the true length is the first 8 bytes inside segment 0.
- **Chunks hold whole segments**, so every verified chunk is decryptable on its own: ranges and resumed downloads need
  no other part of the object.

Limits: 2³² segments of 64 KiB is 256 TiB per object. Overhead per segment is the 16-byte tag: 0.02% at 64 KiB, 0.13%
in tier S.

## 5. Keys

The ciphertext is public, so everything rests on who can release `K`, and to whom.

### 5.1 Custody modes

| Mode | Who holds the secret | Who releases it after a sale | Can the protocol decrypt? | Liveness |
|---|---|---|---|---|
| **Keepers (default)** | nobody whole: `s` is split with Pedersen VSS into `n` shares, one per independent keeper, any `t` of which reconstruct it (3-of-5 at launch) | each keeper, independently, after its own checks (§5.2) | no, unless `t` keepers collude | survives `n − t` keepers down |
| **Seller** | the seller only | the seller's software, which watches for sales | no | the seller must be online; a missed sale is refunded (§8) |
| **Protocol (phase 1 only)** | the protocol's key service, in a KMS/HSM | the key service | yes | one service |

No keeper, the protocol included, holds more than one share, so **the site alone cannot decrypt any product**. The
Protocol mode exists only to ship before the keeper network is live; each of its releases is recorded on chain the
same way a keeper's is (a release receipt, §5.6), so its use is auditable.

### 5.2 What a keeper checks before releasing its share

1. `ownerOf(licenseId)` is the requester, and the license is valid — for a sale, `isValid`; for a rental, the
   version was published before `expiresAt` (§5.7) — read at a confirmed block (see "How recent a purchase must be"
   below), so a reorg cannot conjure a license that later vanishes.
2. The license is for this product **and this content version** (`Product.contentId`).
3. The request is signed by the license owner and binds `licenseId`, `contentId`, the recipient encryption key (§5.3)
   and an expiry, so it cannot be replayed for another license or key.
4. The product is not frozen (§9).

The share goes back encrypted to the recipient key and signed by the keeper. The buyer checks **each share against
the Pedersen commitments** before using it, so a keeper that returns a wrong share is caught at once, the SDK asks
another keeper, and the signed wrong share is slashing evidence (§5.6). With `t` good shares it reconstructs `s`,
derives `K`, and checks the key commitment before decrypting anything.

**How recent a purchase must be.** Waiting for the `safe` head (L1-derived, a few minutes on Base) makes a reorged-away
purchase impossible to exploit, at the cost of a few minutes before the first download. Keepers therefore use the
`safe` head for products above a price threshold and `latest − 10 blocks` (20 seconds) below it, where losing one
cheap sale to a sequencer reorg costs less than the wait. Requests are signed, so the per-request work is a signature
check and a cached `ownerOf`; keepers rate-limit per license and per wallet.

### 5.3 Encryption keys for buyers and keepers

Ethereum accounts have no standard encryption key (MetaMask's `eth_getEncryptionPublicKey` is deprecated; a
smart-contract wallet has no key pair). A buyer therefore registers an **X-Wing key pair** (X25519 + ML-KEM-768, a
hybrid post-quantum KEM). The public key is 1,216 bytes, so the chain stores only its hash
(`ContentRegistry.setEncryptionKeyHash`); the full key travels with each request and the keeper checks it against the
hash. An agent derives the key pair from its wallet key; a browser wallet derives it from a signature over a fixed
message and re-registers if a non-deterministic wallet ever produces a different one. Everything sent to a buyer or a
keeper is HPKE (RFC 9180) over X-Wing.

### 5.4 Creating and distributing the shares

The seller's SDK splits `s` with **Pedersen** VSS: it publishes the commitments `Cⱼ = g^{aⱼ}·h^{bⱼ}` in
`ContentRegistry` and sends each keeper its share pair off chain, encrypted to that keeper's key. Each keeper checks its
share against the commitments and acknowledges on chain (`ackShare`); a product cannot be listed until `t` keepers have
acknowledged, so nothing is sold that no quorum can release. Pedersen rather than Feldman because Feldman publishes
`g^s`, from which a future quantum computer would recover `s`; Pedersen commitments are information-theoretically
hiding.

### 5.5 What public ciphertext changes

- **A leaked `K` is a total leak.** Today the ciphertext is private, so a leaked key alone opens nothing; on chain,
  one buyer publishing 32 bytes discloses the product to everyone, for good. This is the design's central trade-off
  and it is not engineered away: a buyer can always republish plaintext, and per-buyer watermarking is impossible when
  every buyer gets the same public ciphertext. `K` is per version, so a leak exposes one version; a seller that needs
  per-buyer traceability should sell that product another way.
- **Harvest now, decrypt later.** No key material is posted on chain, encrypted or not: shares travel off chain, and
  the chain holds only hiding commitments, a hash of each delivered share, and acknowledgements. Delivery uses the
  hybrid X-Wing KEM. AES-256 content is reduced only to a 128-bit level by a quantum adversary.

### 5.6 The keeper network

The whole design rests on "no `t` keepers collude", so who the keepers are is part of the design, not an operation.

- **Who.** A registry of keepers in `ContentRegistry` (address, X-Wing key hash, endpoint), set by governance
  through the existing timelock. At launch: five independent operators in different jurisdictions, the protocol
  being at most one of them; 3-of-5. Each keeper runs the open-source keeper service inside a confidential-computing
  enclave (AWS Nitro, Intel TDX or AMD SEV-SNP) whose attestation is checked when it registers, so an operator's own
  staff cannot read the shares it stores — defence in depth, not the root of trust.
- **Paid per release.** Each sale reserves a small fixed keeper fee inside the protocol fee (the buyer's price does
  not change), paid to the keepers whose release receipts (below) the buyer's license collects, plus a per-object fee
  at registration for storing shares and doing the availability check.
- **Receipts.** For every share it releases, a keeper posts `keccak256(licenseId ‖ contentId ‖ encryptedShare)` on
  chain in batches. This makes releases countable (for fees and for auditing the Protocol mode) without putting key
  material on chain.
- **Bonded.** A keeper stakes a bond. Provable faults are slashed on chain: acknowledging a share and later failing to
  release it to a valid license that asked (the buyer submits the signed request and the keeper's silence past a
  deadline), or failing to acknowledge a shred (§9). A share released without a valid license cannot be proven by anyone but
  its recipient, who has no reason to report it; that fault, like collusion by `t` keepers, is prevented by the
  enclave and by independence, not punished. This is why the set is small, independent and enclaved.
- **Changing the set without reconstructing anything.** When a keeper leaves or is removed, the remaining keepers
  **reshare** every live secret to the new set with a dynamic proactive secret-sharing protocol (CHURP-style): new
  shares of the same `s`, old shares useless, `s` never assembled. The same refresh runs on a schedule (monthly), so a
  share stolen once becomes useless at the next epoch.
- **Liveness.** A buyer needs any `t` of `n`; the SDK asks all five and stops at three. If fewer than `t` answer for
  longer than the dispute window, sales of Keepers-mode products pause automatically (the product shows why) rather
  than taking money for content no one can release.

### 5.7 Rentals

`LicenseToken` supports rentals with an expiry (`kind: "rental"`, `expiresAt`). Once a renter holds `K`, nothing
takes it back: renting a fixed file is, cryptographically, selling it. The design does not pretend otherwise.

- **A rental of content is a subscription to its versions.** Each product version has its own `s`. A keeper releases
  a version's share to a rental license only if that version was published **before the rental expires** — at any
  time, including after expiry, so a renter who lost a file it was entitled to can fetch it again. When the rental
  ends, the renter keeps every version published while it ran and gets none published after. This is the model for content that is updated: datasets refreshed weekly,
  tools that ship fixes.
- **A product whose value is one fixed file cannot be listed as a rental** under on-chain content: the listing route
  refuses it with an explanation. Such a product is sold.
- **Access that must truly end** (an API, a hosted model) is not content at all: it stays with the seller's own
  service, which checks `LicenseToken.isValid` on each call, as a rental does today.

## 6. Uploading

The seller's SDK does the cryptography locally; what leaves the seller's machine is ciphertext, commitments and
encrypted shares. The API never signs: it returns transaction intents, as every write route does today.

1. **Register.** One transaction, `ContentRegistry.register(header, root, tier, padded length, VSS commitments,
   keeper set)`, creates the content id in state `PENDING` and escrows the storage cost for tier X/H in USDC, quoted
   live by `POST /api/v1/content/quote` (§11). The seller needs no AR tokens and no second currency.
2. **Put the bytes.**
   - **S:** `ContentRegistry.writeChunks(contentId, firstIndex, chunks[], multiproof)` deploys chunk contracts at
     ≈ 5.35 M gas each (4.91 M code deposit, ≈ 0.4 M calldata, 32 k creation, the proof). Three per transaction
     (≈ 16.1 M) would sit too close to EIP-7825's 16,777,216 per-transaction cap if Base adopts it, so the SDK sends
     two (≈ 10.8 M); it reads the cap from the chain rather than assuming. 256 KiB is 11 chunks, six transactions.
     The contract checks every chunk against the root, so whoever submits it cannot write wrong bytes.
   - **X:** the seller uploads ciphertext to the **storage relay** (`PUT /api/v1/content/{id}/chunks/{i}`, resumable
     and idempotent per chunk; a chunk that does not fit the root is refused on receipt). The relay bundles the chunks
     to Arweave, paid from the escrow, and submits the locators. It handles ciphertext only — a courier, not a
     custodian — and a seller may bypass it and upload to Arweave itself.
   - **H (opt-in):** `ContentRegistry.appendChunk` transactions, one sealed segment each, plus the X mirror.
3. **Availability check.** For tier X, one keeper chosen by the registration block's hash verifies every chunk and
   the others sample 30 each (§3.4); their `t` signatures make the content `AVAILABLE` and release the unspent escrow.
   Tier S needs no check: the contract verified every chunk as it was written.
4. **Shares acknowledged** by `t` keepers (§5.4). Only content that is `AVAILABLE` with `t` acknowledgements can be
   attached to a product.

**Server-assisted mode (opt-in, up to 256 KiB).** An agent that cannot run the SDK may keep sending plaintext to
`POST /api/v1/stores/{id}/products` as today; the server does steps 1–4 for it and discards the plaintext and `s`.
Because this mode sees both for the length of the request — exactly what the design otherwise avoids, and the one
case where "the site alone cannot decrypt" rests on the server's deletion rather than on cryptography — the product
records `encryptedBy: "server"` and the site shows it.

## 7. Buying and downloading: the translator

Buying is unchanged: a purchase mints a `LicenseToken` as today. Downloading is the only service the site still runs
for content. It holds no files, no keys and no plaintext.

- **`GET /api/v1/content/{contentId}`** streams the ciphertext: header and locators from `ContentRegistry`, chunks in
  order (S with `eth_getCode`, X from gateways and mirrors, §3.5, H from calldata), each checked against the root
  **before** a byte of it is sent. It never buffers a whole object, so size does not change its memory use. `Range`
  requests map to whole segments.
- **`GET /api/v1/content/{contentId}/manifest`** returns header, root, sizes and every chunk source, so a client can
  fetch from anywhere and verify the same way.
- **Decryption is the buyer's.** The SDK or the browser collects `t` shares (§5.2), derives `K`, checks the key
  commitment, and decrypts segment by segment as the stream arrives. In a browser this runs in a Web Worker with
  WebCrypto and writes through the File System Access API (or a service-worker download stream where that API is
  missing), so a multi-gigabyte file never has to fit in memory. An agent calls
  `sdk.download(contentId, licenseId, outPath)`.
- **Anyone can run it.** The translator is open source and stateless, and the SDK works without it (RPC and gateways
  directly): if the site disappears, every buyer can still get everything it bought. A cache in front of it can be
  dropped and rebuilt from the chain at any time; it is not custody.
- **What it refuses:** an unregistered content id, a frozen product (§9), and requests over its rate limits. Full
  streams through the translator need a signed proof of a valid license (a signature check and a cached `ownerOf`);
  anyone else gets the manifest and fetches from the gateways with their own bandwidth. Ciphertext is public, so this
  protects the site's bandwidth, not the content.

### 7.1 Walkthrough: a 5 GiB dataset

1. **Seller, pass 1.** The SDK streams the file once: pads it, encrypts it segment by segment, Reed–Solomon codes each
   group of 16 chunks, and hashes every sealed segment into the Merkle tree, keeping O(log n) memory and writing
   nothing to disk. Nonces are derived from the segment index, so encryption is deterministic given `K`: a second
   pass reproduces identical ciphertext, which is what makes a disk-free two-pass upload possible.
2. **Register.** The quote is ≈ 5 × 1.25 × 58 ≈ 360 USD of Arweave storage plus a few cents of gas; the seller signs
   `register` with the header, root and VSS commitments, escrowing the quote in USDC.
3. **Seller, pass 2.** The SDK re-encrypts and uploads 6,400 chunks (5,120 data + 1,280 parity) to the relay, several
   in parallel; each is checked against the root on receipt, and an interrupted upload resumes from the first chunk
   the relay does not have. The relay bundles to Arweave (ANS-104 bundles through a bundling service, which serves
   the data immediately and settles on Arweave within the hour) and posts the locators.
4. **Availability.** The keeper drawn by the registration block hash downloads all 6,400 chunks and verifies them;
   two others sample 30 each (§3.4). The content becomes `AVAILABLE`, the product is listed.
5. **Buyer.** Buys (a license, as today); asks the keepers for shares (seconds); streams chunks from several
   gateways in parallel through the translator or directly, verifying and decrypting each as it arrives and writing
   to disk. Time is the buyer's bandwidth: about 7 minutes at 100 Mbit/s. A lost connection resumes at the next
   unwritten segment.

## 8. Buyer protection: content that does not decrypt

Today the server encrypts, so content always decrypts to what was committed. When the seller encrypts, a seller could
list bytes that do not decrypt, or decrypt to something other than the plaintext commitment. Nobody can check before
a sale without `K`, and publishing `K` to prove it would leak an honest product.

- **Escrow — but not of the buyback.** The protocol requires the holders' 20% to buy and burn the store's AIC **in
  the purchase transaction**, and this design keeps that. What waits for the **24-hour dispute window** (or for the
  buyer's `confirmDelivery`) is the rest: the owner's share, the protocol fee and any incentive reward. A refund
  returns those, and makes up the buyback portion — already spent on burned tokens — from the store's
  `ownerAvailable` balance and, if that is short, from a **content bond** the seller posts when listing a
  seller-encrypted product (the size of one sale's buyback portion times the number of sales that may be pending at
  once; the store stops selling when the bond cannot cover a new sale). The buyer is always refunded in full; the
  fraudulent seller pays for the burn.
- **Undecryptable claim (Keepers mode).** Within the window the buyer files a claim naming the first failing segment,
  with a bond (a fraction of the price). The keeper quorum — already trusted not to reconstruct `s` except as the
  rules allow — reconstructs it privately for this purpose, checks the segment and the plaintext commitment, and `t`
  keepers sign a verdict the contract verifies. Upheld: refund, product frozen. Rejected: the bond goes to the seller.
- **A vote-free refund for the worst fraud.** If the reconstructed secret opens the commitment `C₀ = g^s·h^r` but its
  `K` does not match the header's key commitment, the seller shared a key that is not the content key. Only then is
  `(s, r)` published — it provably opens nothing — and the contract checks the opening (`ecMul`/`ecAdd`) and the key
  commitment (`sha256`) and refunds without a vote.
- **Seller mode** has no quorum: non-delivery refunds automatically; a claim that delivered content does not decrypt
  cannot be judged, and the product says so before anyone buys.
- **Protocol mode** is judged by the key service itself.

## 9. Freezing and removal

Nothing on chain can be deleted: tier-S chunk contracts cannot be removed (since Cancun, `SELFDESTRUCT` no longer
deletes code), and Arweave is permanent by design. What can be removed is **the ability to decrypt**. Because no
plaintext is ever public and no key is ever on chain, destroying the key material turns what remains into noise. That
is the removal mechanism: **freeze, then shred.**

- **Freeze (reversible, immediate).** `ContentRegistry.freeze(contentId, reasonHash)` sets a flag that every other
  part obeys: the product cannot be bought, keepers release no shares, the translator serves neither ciphertext nor
  manifest, and the relay stops mirroring. Who may freeze: the protocol **guardian** (the existing
  `GUARDIAN_ADDRESS` role), for legal orders and upheld claims (§8); and the store's own controller, for its own
  products. The guardian can unfreeze; a controller can unfreeze only what it froze itself.
- **Shred (irreversible, after a delay).** `ContentRegistry.scheduleShred(contentId)` by the guardian starts a 7-day
  timelock, shortened to zero only for categories the law requires removed at once. When it expires, every keeper
  deletes its share and acknowledges on chain (`ackShred`); once fewer than `t` shares survive anywhere, no one who
  has not already bought the content can ever decrypt it. The keeper software treats a shred as mandatory: a keeper
  that does not acknowledge within a day loses its keeper slot and its bond (§5.6).
- **What stays true after a shred.** Buyers who already decrypted keep what they received — delivery cannot be undone,
  exactly as today. The public ciphertext stays where it is, unreadable. In Seller mode, the protocol cannot shred; it
  can only freeze, and the product says so before it is listed.
- **Arweave gateways.** The relay also files the freeze with the gateway operators it uses; most ar.io gateways
  honour removal requests for what they serve. This matters less than the shred, since the gateways serve only
  ciphertext.
- **What is not possible without plaintext.** In SDK mode no one sees the content before it is sold, so there is no
  scanning at upload (the server-assisted mode could scan, since it sees the plaintext). Removal therefore works from
  reports, through freeze and shred. Whether shredding counts as erasure under data-protection law (GDPR Art. 17) is
  not settled; it is the accepted engineering answer, and legal review is required before launch (§13).

## 10. Contract changes

A constraint shapes everything here: **stores are immutable clones.** `StoreFactory` clones a pinned `StoreBase`
implementation, and a clone has no upgrade path; a new behaviour reaches only stores created by a new factory
generation, which the upgradeable registry authorises. So the content system is a new contract beside the stores, the
escrow is a new store generation, and existing stores are linked rather than changed.

### 10.1 `ContentRegistry` (new, behind the existing proxy and timelock)

| Group | Functions | Notes |
|---|---|---|
| Objects | `register(header, root, tier, paddedLength, vssCommitments, keeperSetId) → contentId`; `writeChunks(contentId, firstIndex, chunks, multiproof)` (S); `appendChunk(contentId, index, segment, proof)` (H); `setLocators(contentId, locators)` (X, relay or seller) | `register` escrows the storage quote in USDC; `writeChunks` rejects any chunk that does not verify against `root` |
| Readiness | `attestAvailable(contentId, sampleSeed, sigs[t])`; `ackShare(contentId)` (keeper); `isListable(contentId) → bool` | listable = `AVAILABLE`, `t` acknowledgements, not frozen |
| Buyers | `setEncryptionKeyHash(hash)` | one per wallet |
| Keepers | `addKeeper` / `removeKeeper` (governance, timelocked), `postReceipts(batchRoot)`, `reshare(epoch, newCommitments, sigs)`, bonds and `slash(evidence)` | §5.6 |
| Removal | `freeze(contentId, reasonHash)`, `unfreeze`, `scheduleShred`, `ackShred` | §9 |
| Disputes | `openClaim(store, licenseId, segmentIndex)` with bond; `resolveClaim(claimId, verdict, sigs[t])`; `fraudRefund(claimId, s, r)` | §8; calls the store's `refund` |
| Legacy | `linkLegacy(store, productId, version, contentId, controllerSig)` | §10.3 |

Events for the indexer: `ContentRegistered`, `ChunksWritten`, `ContentAvailable`, `ShareAcknowledged`,
`ContentFrozen`, `ShredScheduled`, `ClaimOpened`, `ClaimResolved`, `ReceiptsPosted`, `KeeperSetChanged`.

### 10.2 A new store generation (`StoreBase` v6 via a new `StoreFactory`)

- **Products carry a content id.** `createProduct`/`updateProduct` take a `contentId` instead of a plaintext hash and
  require `ContentRegistry.isListable(contentId)`. `Product.contentHash` keeps its slot and now holds the content id;
  a new `Product.contentFormat` (0 = legacy, 1 = on-chain) tells readers which it is.
- **Escrowed settlement, buyback unchanged.** `_settle` still runs the 20% buyback and burn in the purchase
  transaction. The owner's share and the protocol fee go to a pending settlement per license; `finalizeSale(licenseId)`
  pays them out exactly as today — callable by anyone after the dispute window, or by the buyer at once
  (`confirmDelivery`). `refund(licenseId)`, callable only by `ContentRegistry` on an upheld claim, returns the pending
  amounts plus the buyback portion from `ownerAvailable` or the content bond (§8), and revokes the license. Pending
  owner shares are excluded from `ownerAvailable` until final.
- **Incentive rewards wait too.** A purchase that pays the buyer AIC from the store's incentive pool pays it on
  `finalizeSale`, not at purchase; otherwise buy-claim-refund would keep the reward.
- **`LicenseToken` v6** adds `revoke(tokenId)`, callable only by its store, used by `refund`.

### 10.3 Existing stores

Existing stores keep working unchanged: they settle at once and their products' `contentHash` is a plaintext hash.
Their content moves out of MongoDB anyway (§12.1): the protocol, which holds those plaintexts today, re-encrypts each
one in the on-chain format, registers it, and the store's controller signs `linkLegacy`, which maps
`(store, productId, version)` to the new content id. Keepers then serve legacy licenses from that link. These
products have no escrow, which is acceptable because the protocol encrypted them, so they decrypt by construction.

## 11. Costs

**Inputs, measured on Base mainnet on 2026-09-29** (they move; every figure is a formula of them, and uploads are
quoted live by `POST /api/v1/content/quote`): L2 gas price 0.006 gwei; block gas limit 400,000,000 every 2 s; L1 data
fee from the `GasPriceOracle` (`0x42…0F`, Fjord): 0.00000669 ETH for 24,576 random bytes, about 2.9 × 10⁻¹⁰ ETH per
byte of incompressible data (ciphertext never compresses); ETH 2,672 USD; Arweave 13.62 AR per GiB at 4.25 USD per AR.

| Medium | Gas per byte | Why | Readable by a contract | Kept by |
|---|---|---|---|---|
| Contract storage (`SSTORE`) | ≈ 625 | 20,000 per 32-byte slot | yes | every full node, as state |
| Contract code (SSTORE2, tier S) | ≈ 217 | 200 code deposit + ≈ 16 calldata, + 32,000 per data contract | yes (`EXTCODECOPY`) | every full node, as state |
| Calldata (tier H) | ≈ 40 | the EIP-7623 floor for data-heavy transactions | no | nodes that keep history |

| Size | S (SSTORE2) | H (calldata) | X (Arweave) |
|---|---|---|---|
| 1 KiB (a typical product here: Alpha tx min is 770 bytes) | ≈ 0.005 USD | ≈ 0.002 USD | — |
| 100 KiB | ≈ 0.43 USD | ≈ 0.14 USD | ≈ 0.006 USD |
| 1 MiB | ≈ 4.4 USD | ≈ 1.45 USD | ≈ 0.06 USD |
| 100 MiB | ≈ 440 USD | ≈ 145 USD | ≈ 5.7 USD (≈ 7.1 with the 4/5 coding of §3.4) |
| 1 GiB | ≈ 4,500 USD | ≈ 1,490 USD | ≈ 58 USD (≈ 73 coded) |

**Capacity, not only price.** 1 GiB in S is ≈ 233 billion gas, about 580 full Base blocks — twenty minutes of the
whole chain; as calldata it is still ≈ 44 billion gas. Writing that much also raises the EIP-1559 base fee while it
runs, so these are floors. Contract state is right for small content and wrong for heavy content; heavy content goes
to a store two orders of magnitude cheaper per byte, with the chain holding the commitment.

## 12. Rollout

Every phase ships to Base Sepolia first, is exercised there, then goes to mainnet; the site (Skill, schema,
playbook, OpenAPI, UI) describes each phase as it ships, since agents learn everything from the site.

| Phase | Ships | Custody after it | What it proves |
|---|---|---|---|
| 1 | `ContentRegistry`, format v1, tier S, the translator, the SDK (JS, usable from an agent's `run_code`), server-assisted mode; **Protocol** custody | the protocol's key service (no longer MongoDB) | small products end to end from chain |
| 2 | §12.1 migration of every existing product | same | nothing is left in MongoDB |
| 3 | tier X and the storage relay; the quote endpoint | same | heavy content, uploaded and downloaded in a browser and by an agent |
| 4 | the keeper network (3-of-5, enclaves, bonds, resharing); the protocol splits each phase-1 secret to the keepers with VSS and **deletes its copy** | keepers | the site alone can no longer decrypt anything |
| 5 | store generation v6 (escrow, claims, refunds) and Seller mode | keepers or seller | seller-encrypted content with buyer protection |
| 6 | the master key and the `ProductContent` collection are destroyed | — | the goal of §1 |

### 12.1 Migrating existing products

For every `ProductContent` row: decrypt with today's master key, verify against the product's committed
`contentHash`, encrypt in format v1, register (tier by size), and ask the store's controller to sign `linkLegacy`
(§10.3). A controller that never signs keeps its products on the legacy path, served by the old route, until phase 6;
before phase 6 the protocol freezes the old route with notice, so a store that has not linked must re-list. Stores
created on testnet are simply reset instead.

## 13. Decisions still open

Everything the iterations could settle by reasoning is settled above. What remains needs a decision or outside input:

1. **The keepers.** Who the four operators besides the protocol are, in which jurisdictions, and the bond size. The
   design's central trust assumption is only as good as this list.
2. **Money.** The keeper fee per release and the registration fee (§5.6): inside today's protocol fee, as designed,
   or on top of it.
3. **Parameters.** The price threshold between `safe`-head and `latest − 10` release (§5.2); the 24-hour dispute
   window and the claim bond fraction (§8); the content-bond sizing; the 256 KiB S/X boundary; the yearly full
   re-check (§3.4).
4. **Seller mode at all.** It is the only mode the protocol cannot shred and whose disputes cannot be judged
   (§8, §9). Launching without it is simpler and loses little.
5. **The default X store.** Arweave is permanent and paid once, at ≈ 58 USD per GiB today; Filecoin or plain object
   storage is far cheaper but not permanent. The format supports any of them; the default is a product decision.
6. **Legal review** before mainnet: crypto-shredding as erasure (GDPR Art. 17), takedown obligations for content the
   operator cannot see, and running a key-release network.
7. **Per-transaction gas cap.** If Base adopts EIP-7825, the S write batching of §6 is already sized for it; if
   not, S uploads can be one transaction. The SDK reads the cap either way; no decision needed unless the cap is
   lower than 16.7 M.

---

## Appendix: iteration log

| # | Lens | What was found | What changed |
|---|---|---|---|
| 1 | Cost and size | v1 had no numbers. Storing everything as contract code costs ≈ 217 gas/byte: 1 MiB ≈ 4.4 USD, 1 GiB ≈ 4,500 USD and twenty minutes of the whole chain. | Costs rewritten with measured inputs, per-medium gas and per-size costs; heavy content cannot live in contract state. |
| 2 | Heavy files | One medium cannot serve 770 bytes and 5 GiB. | Tiers (state / calldata / external permanent store) sharing one chunked format and one on-chain Merkle root; the translator is tier-agnostic. |
| 3 | Permanence | Calldata is history, not state: Base's L1 blobs are pruned after ≈ 18 days. | Permanence per tier; H demoted to an opt-in copy always mirrored in X; default S ≤ 256 KiB, X above. |
| 4 | Encryption at scale | One AES-GCM over a file cannot stream or serve ranges, caps at ≈ 64 GiB per nonce, and is not key-committing. | Segmented streaming AEAD, a header with a key commitment, chunks aligned to segments. |
| 5 | Internal consistency | A 64 KiB segment did not fit a 24,575-byte S chunk; a two-segment H chunk exceeded the 128 KiB txpool limit; the Merkle tree was undefined. | Segment size per tier; chunk = N sealed segments; Merkle leaves = indexed sealed segments; header in `ContentRegistry`; content id = `keccak256(header ‖ root)`. |
| 6 | Key custody | The protocol's key service held every `K`: custody moved from files to keys. Wallets have no usable encryption key. | Three custody modes, threshold keepers (3-of-5) by default; a keeper's exact checks; registered buyer encryption keys. |
| 7 | Leakage, quantum, share creation | A leaked 32-byte `K` is a permanent total leak; wrapped keys on chain invite harvest-now-decrypt-later; lengths fingerprint files; share creation undefined. | Leak trade-off stated; no key material on chain; hybrid X-Wing KEM; Padmé padding; VSS shares off chain, `t` acknowledgements before listing. |
| 8 | Buyer protection | A seller-encrypted object may never decrypt; proving it by publishing `K` would leak honest products. | 24-hour escrow (buyback only on settlement), private quorum verdicts with a bond, a vote-free refund for a key that is not the content key. |
| 9 | Cryptographic soundness | The "cheap check" needed `K` on chain; an AES key is not a bn254 scalar; Feldman's public `g^s` would hand every key to a future quantum computer. | Scalar secret `s`, `K = HKDF(s)`; Pedersen (hiding) VSS; the secret is published only when it provably opens nothing. |
| 10 | The translator | It buffered whole objects, had no ranges, no browser path for large files, and was a single point of failure. | Streaming with per-chunk verification, a manifest, segment-aligned ranges, client-side streaming decryption, an open-source translator and an SDK that works without it. |
| 11 | Uploading heavy content | No path for paying Arweave in USDC, batching S writes, resuming uploads, or proving availability. | Register + USDC escrow; S writes with on-chain multiproofs, two chunks per transaction under the EIP-7825 cap; a resumable ciphertext-only relay for X; keeper availability check; a labelled server-assisted mode. |
| 12 | Structure and leftovers | Sections were out of order (2.1, 2.5, 2.2 …, two 2.4s), §2.6 and §2.9 were cited but missing, and earlier text contradicted later decisions ("Shamir shares of `K`", "a random 256-bit `K`", "three chunks per transaction", a quote in a non-existent §9). | Rewritten in reading order with an overview diagram; gateway selection added (§3.4); the salted plaintext commitment moved into the header; every leftover aligned; freezing, contracts, rentals, migration and keepers listed as open. |
| 13 | Unlawful content and erasure | Nothing on chain can be deleted (`SELFDESTRUCT` no longer removes code; Arweave is permanent), yet an operator must be able to comply with a takedown. | §9: freeze (guardian or the store's own controller; reversible; every component obeys) then shred (7-day timelock, keepers delete shares and acknowledge; below `t` shares the ciphertext is permanently noise). Gateway removal requests, no scanning in SDK mode, Seller mode cannot be shredded, legal review of crypto-shredding flagged. |
| 14 | Rentals | A released `K` cannot be revoked, so a rental of a fixed file is a sale in disguise. | §5.7: a content rental is a subscription to versions (keepers release only versions published before expiry); fixed-file products cannot be listed as rentals; truly revocable access stays with the seller's own service checking `isValid`. |
| 15 | The keeper network | Everything rests on "no `t` keepers collude", yet the keepers were undefined: who, paid by whom, what happens when one leaves (its share must move without reconstructing `s`), and what deters misbehaviour. Iteration 14 also let an expired renter lose versions it had paid for. | §5.6: governance-set registry of five independent, enclave-attested keepers (3-of-5); a keeper fee inside the protocol fee; on-chain release receipts; bonds slashed for provable faults; CHURP-style resharing on set changes and monthly; automatic sales pause if no quorum. Rentals may re-fetch versions published during the rental, at any time. |
| 16 | Contracts | §10 was a stub, and a hard constraint was unstated: stores are immutable clones (`StoreFactory` pins the implementation; clones cannot be upgraded), so escrow cannot be added to existing stores. Refunds would also leave buyers the purchase's AIC incentive reward. | §10: `ContentRegistry` interface and events; a v6 store generation with content ids, escrowed `finalizeSale` / `confirmDelivery` / `refund`, rewards paid on finalization, `LicenseToken.revoke`; existing stores linked through a controller-signed `linkLegacy`, without escrow because the protocol encrypted their content. |
| 17 | Migration and rollout | No order of work, no way for phase-1 secrets held by the protocol to move to keepers (so custody would never end), no point at which the master key and MongoDB content are destroyed, and §12.1 was cited but missing. | §12: six phases, testnet before mainnet, the site updated each phase; the protocol VSS-splits its phase-1 secrets to keepers and deletes its copy; the master key and `ProductContent` destroyed last. §12.1: migration with controller-signed links, a notice period for unlinked stores. Open questions moved to §13; stale references fixed. |
| 18 | Adversarial review | Iteration 8 deferred the 20% buyback to the end of the dispute window, **breaking the protocol's requirement that the buyback run in the purchase transaction**. Also: a keeper could return a wrong share unnoticed; the translator and keepers had no answer to request floods; waiting for the `safe` head was unacknowledged latency. | §8 / §10.2: the buyback stays in the purchase transaction; only the owner share, protocol fee and rewards are escrowed; refunds recover the burned portion from `ownerAvailable` and a seller content bond. §5.2: every share is verified against the Pedersen commitments (bad shares become slashing evidence); `safe` head above a price threshold, `latest − 10` below; signed, rate-limited requests. §7: license-proof streaming, manifest for everyone else. |
| 19 | A 5 GiB object end to end | The walkthrough exposed that one missing chunk ruins a heavy file and nothing guaranteed all chunks exist; the first fix (per-group Reed–Solomon plus sampling) was itself wrong on checking — withholding 5 chunks of one group (< 0.1% of the object) is fatal yet invisible to random samples. A keeper's "release to an invalid license" was listed as slashable though no one would report it. | §3.4: RS 4/5 per group for repair; availability proven by a **complete** check by one keeper drawn from the registration block hash, others sampling, repeated yearly; cost table shows the coded price. §7.1: the full walkthrough (two-pass disk-free encryption thanks to index-derived nonces, 6,400 chunks, resumable upload, ≈ 7 min download at 100 Mbit/s). §5.6: unreportable faults are prevented by enclaves and independence, not claimed as slashable. |
| 20 | Final consistency | A full read found leftovers: the overview cited §5.3 for share creation (§5.4), the freeze section cited §13 for keeper penalties (§5.6), Protocol-mode receipts cited §5.4 (§5.6), §5.2 still demanded the `safe` head for every purchase after the price threshold was introduced, the server-assisted mode also sees `s` (so "the site alone cannot decrypt" rests on deletion there), and every item in "Open questions" had been resolved. | References fixed; the server-assisted caveat stated precisely; §13 replaced by the seven decisions that reasoning cannot settle (keepers, fees, parameters, Seller mode, default X store, legal review, gas cap). Status set to v2. |
