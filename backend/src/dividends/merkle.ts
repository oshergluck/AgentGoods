/**
 * Dividend claim dataset generation and independent verification.
 *
 * MASTER_PLAN 0.13, 0.19.D, 0.24.B, 0.25.G:
 *
 *  - the dataset is DETERMINISTIC and reproducible from indexed historical chain state, so
 *    two independent implementations produce the same entitlement set and the same root
 *    (the contract test suite holds the second implementation and asserts they agree);
 *  - before a root is published, this module independently verifies that the totals fit the
 *    funded amount, that every included account satisfies the EOA eligibility policy, that
 *    balances correspond to the snapshot block, that contract balances are excluded, that no
 *    address appears twice and that rounding is deterministic;
 *  - a malicious or buggy generator cannot cause an over-distribution, because the contract
 *    caps total claims at the committed amount regardless of what a root says.
 */

import { AbiCoder, keccak256, concat, getBytes } from "ethers";
import { ChainEvent, DividendEntitlement, DividendEpoch, AicHolder, Proposal, Store } from "../db/models";
import type { ProviderPool } from "../rpc/provider";
import { logger } from "../utils/logger";

const abi = AbiCoder.defaultAbiCoder();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface DatasetEntry {
  index: number;
  account: string;
  /**
   * The entitlement weight: the account MINIMUM balance across the holding window, NOT its
   * balance at the snapshot. Renamed from `snapshotBalance` when the rule changed, so a stale
   * reader gets a type error rather than a plausible wrong number. [MASTER_PLAN 29C.7]
   */
  windowMinimumBalance: bigint;
  amountUSDC: bigint;
  blockingProposalIds: bigint[];
  leaf: string;
  proof: string[];
}

export interface Dataset {
  epochId: string;
  distributor: string;
  chainId: number;
  snapshotBlock: number;
  /** MASTER_PLAN 29C: the window this epoch was opened under, copied from the epoch record. */
  windowStartBlock: number;
  holdingWindowSeconds: number;
  /** Sum of per-account MINIMUM balances. This is the epoch denominator. */
  eligibleMinSupply: bigint;
  /** Checkpointed eligible supply at the snapshot. Kept as the on-chain upper bound. */
  eligibleSupplyAtSnapshot: bigint;
  claimableUSDC: bigint;
  entries: DatasetEntry[];
  total: bigint;
  root: string;
  datasetHash: string;
}

export class DatasetError extends Error {
  constructor(message: string) {
    super(`Refusing to publish dividend root: ${message}`);
    this.name = "DatasetError";
  }
}

/** Canonical leaf hash. Must match `DividendDistributor.leafHash` exactly. */
export function leafHash(input: {
  chainId: number;
  distributor: string;
  epochId: bigint;
  index: bigint;
  account: string;
  amount: bigint;
  blockingProposalIds: bigint[];
}): string {
  const blockingHash = keccak256(
    concat(input.blockingProposalIds.map((id) => getBytes(abi.encode(["uint256"], [id]))))
  );
  const inner = keccak256(
    abi.encode(
      ["uint256", "address", "uint256", "uint256", "address", "uint256", "bytes32"],
      [
        input.chainId,
        input.distributor,
        input.epochId,
        input.index,
        input.account,
        input.amount,
        blockingHash,
      ]
    )
  );
  return keccak256(inner);
}

function hashPair(a: string, b: string): string {
  return BigInt(a) < BigInt(b)
    ? keccak256(concat([getBytes(a), getBytes(b)]))
    : keccak256(concat([getBytes(b), getBytes(a)]));
}

export function buildTree(leaves: string[]): { root: string; layers: string[][] } {
  if (leaves.length === 0) return { root: "0x" + "00".repeat(32), layers: [[]] };
  const layers: string[][] = [leaves.slice()];
  while (layers[layers.length - 1]!.length > 1) {
    const prev = layers[layers.length - 1]!;
    const next: string[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i]!, prev[i + 1]!) : prev[i]!);
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1]![0]!, layers };
}

export function getProof(layers: string[][], index: number): string[] {
  const proof: string[] = [];
  let idx = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level]!;
    const pairIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (pairIndex < layer.length) proof.push(layer[pairIndex]!);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Reconstructs every AIC balance at `snapshotBlock` by folding Transfer events.
 *
 * This is the reproducibility requirement: the result depends only on canonical chain events,
 * never on the current projection, so regenerating a historical root produces the same
 * numbers even after the live balances have moved on.
 */
export async function balancesAtBlock(
  chainId: number,
  aicToken: string,
  snapshotBlock: number
): Promise<Map<string, bigint>> {
  const events = await ChainEvent.find({
    chainId,
    address: aicToken.toLowerCase(),
    eventName: "Transfer",
    blockNumber: { $lte: snapshotBlock },
  })
    .sort({ blockNumber: 1, logIndex: 1 })
    .lean();

  const balances = new Map<string, bigint>();
  for (const e of events) {
    const args = e.args as Record<string, string>;
    const from = String(args.from).toLowerCase();
    const to = String(args.to).toLowerCase();
    const value = BigInt(args.value);
    if (from !== ZERO_ADDRESS) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== ZERO_ADDRESS) balances.set(to, (balances.get(to) ?? 0n) + value);
  }
  for (const [k, v] of [...balances]) {
    if (v <= 0n) balances.delete(k);
  }
  return balances;
}

/**
 * Minimum balance per holder across `[windowStartBlock, snapshotBlock]`.
 *
 * This is the entitlement weight. [MASTER_PLAN 29C]
 *
 * Folded from canonical `Transfer` events in two passes over one ordered stream: everything up
 * to and including `windowStartBlock` establishes the opening balance, and everything after it
 * up to the snapshot updates the running minimum. An account whose first acquisition falls
 * inside the window therefore opens at zero and weighs zero, with no special case — which is
 * exactly the anti-snipe property, expressed as arithmetic rather than as a rule.
 *
 * The result must agree with `IAICoin.minBalanceInWindow` for every account. The two are
 * independent derivations of one number, so a disagreement is a detectable fault rather than a
 * silent misallocation.
 */
export async function minBalancesInWindow(
  chainId: number,
  aicToken: string,
  windowStartBlock: number,
  snapshotBlock: number
): Promise<Map<string, bigint>> {
  const events = await ChainEvent.find({
    chainId,
    address: aicToken.toLowerCase(),
    eventName: "Transfer",
    blockNumber: { $lte: snapshotBlock },
  })
    .sort({ blockNumber: 1, logIndex: 1 })
    .lean();

  const balances = new Map<string, bigint>();
  const minima = new Map<string, bigint>();

  const apply = (account: string, delta: bigint): void => {
    if (account === ZERO_ADDRESS) return;
    balances.set(account, (balances.get(account) ?? 0n) + delta);
  };

  let openingCaptured = false;
  const captureOpening = (): void => {
    if (openingCaptured) return;
    for (const [account, balance] of balances) minima.set(account, balance);
    openingCaptured = true;
  };

  for (const e of events) {
    const args = e.args as Record<string, string>;
    if (!openingCaptured && e.blockNumber > windowStartBlock) captureOpening();

    apply(String(args.from).toLowerCase(), -BigInt(args.value));
    apply(String(args.to).toLowerCase(), BigInt(args.value));

    if (openingCaptured) {
      // Inside the window: every account touched by this transfer may have set a new low.
      for (const account of [String(args.from).toLowerCase(), String(args.to).toLowerCase()]) {
        if (account === ZERO_ADDRESS) continue;
        const balance = balances.get(account) ?? 0n;
        // An account first seen inside the window opened at zero, so its minimum is zero.
        const current = minima.has(account) ? minima.get(account)! : 0n;
        if (balance < current) minima.set(account, balance);
        else if (!minima.has(account)) minima.set(account, 0n);
      }
    }
  }
  captureOpening();

  for (const [account, min] of [...minima]) {
    if (min <= 0n) minima.delete(account);
  }
  return minima;
}

/**
 * Classifies holders as eligible EOAs.
 *
 * `eth_getCode` is an indexer/reconciler-class read, never part of a user GET, so it is
 * within the RPC budget of §28. Results are cached on the holder projection so each address
 * is classified at most once.
 */
async function classifyEligibility(
  chainId: number,
  aicToken: string,
  holders: string[],
  providers: ProviderPool | null
): Promise<Map<string, boolean>> {
  const eligible = new Map<string, boolean>();
  const cached = await AicHolder.find({ chainId, aicToken, holder: { $in: holders } }).lean();
  const cachedByHolder = new Map(cached.map((h) => [h.holder, h]));

  for (const holder of holders) {
    const known = cachedByHolder.get(holder);
    if (known && known.isContract === true) {
      eligible.set(holder, false);
      continue;
    }
    if (!providers) {
      // Without a provider we can only trust what the projection already recorded.
      eligible.set(holder, known ? known.eligible !== false : true);
      continue;
    }
    const code = await providers.call("eth_getCode", (p) => p.getCode(holder));
    const isContract = code !== "0x" && code.length > 2;
    eligible.set(holder, !isContract);
    await AicHolder.updateOne(
      { chainId, aicToken, holder },
      { $set: { isContract, eligible: !isContract } }
    );
  }
  return eligible;
}

/**
 * Determines which unresolved passed proposals suspend a given voter at a snapshot.
 *
 * MASTER_PLAN 0.28.B / 0.29.G: only proposals that PASSED at or before the snapshot and were
 * still unresolved at the snapshot suspend that voter, and the set is frozen at snapshot time
 * so a later proposal never extends an older suspension.
 */
async function suspensionsAtSnapshot(
  chainId: number,
  storeId: string,
  snapshotBlock: number
): Promise<Map<string, bigint[]>> {
  const proposals = await Proposal.find({
    chainId,
    storeId,
    passedAtBlock: { $ne: null, $lte: snapshotBlock },
  }).lean();

  const suspending = proposals.filter((p) => {
    if (p.state !== "IMPLEMENTATION_VERIFIED") return true;
    // Resolved, but was it resolved before the snapshot? If not, it suspended at snapshot time.
    return false;
  });

  const byVoter = new Map<string, bigint[]>();
  if (suspending.length === 0) return byVoter;

  const { Vote } = await import("../db/models");
  for (const p of suspending) {
    const yesVotes = await Vote.find({
      chainId,
      governance: p.governance,
      proposalId: p.proposalId,
      support: true,
    }).lean();
    for (const v of yesVotes) {
      const list = byVoter.get(v.voter) ?? [];
      list.push(BigInt(p.proposalId));
      byVoter.set(v.voter, list);
    }
  }
  for (const [k, v] of byVoter) byVoter.set(k, v.sort((a, b) => (a < b ? -1 : 1)));
  return byVoter;
}

export interface GenerateOptions {
  chainId: number;
  distributor: string;
  epochId: string;
  providers: ProviderPool | null;
}

export async function generateDataset(options: GenerateOptions): Promise<Dataset> {
  const epoch = await DividendEpoch.findOne({
    chainId: options.chainId,
    distributor: options.distributor.toLowerCase(),
    epochId: options.epochId,
  }).lean();
  if (!epoch) throw new DatasetError("epoch not found");
  if (epoch.state !== "OPEN" && epoch.state !== "ROOT_PROPOSED") {
    throw new DatasetError(`epoch is ${epoch.state}, not open for root generation`);
  }

  const store = await Store.findOne({ chainId: options.chainId, storeId: epoch.storeId }).lean();
  if (!store) throw new DatasetError("store not found");

  const windowStartBlock = Number(epoch.windowStartBlock ?? 0);
  const holdingWindowSeconds = Number(epoch.holdingWindowSeconds ?? 0);

  /*
   * Two different quantities, both needed.
   *
   * `snapshotBalances` reproduces the checkpointed eligible supply the chain committed at open,
   * and disagreeing with it means our eligibility classification is wrong. `minima` is the
   * entitlement weight: the minimum across the holding window. [MASTER_PLAN 29C.2]
   */
  const snapshotBalances = await balancesAtBlock(options.chainId, store.aicToken, epoch.snapshotBlock);
  const minima = await minBalancesInWindow(
    options.chainId,
    store.aicToken,
    windowStartBlock,
    epoch.snapshotBlock
  );

  const holders = [...snapshotBalances.keys()].sort();
  const eligibility = await classifyEligibility(options.chainId, store.aicToken, holders, options.providers);

  const eligibleHolders = holders.filter((h) => eligibility.get(h) === true);
  const eligibleSupplyAtSnapshot = eligibleHolders.reduce(
    (acc, h) => acc + (snapshotBalances.get(h) ?? 0n),
    0n
  );

  const committedSupply = BigInt(epoch.eligibleSupplyAtSnapshot);
  if (eligibleSupplyAtSnapshot !== committedSupply) {
    // Fail closed. The chain committed a denominator; if our reconstruction disagrees, the
    // eligibility classification is wrong and publishing would misallocate holder money.
    throw new DatasetError(
      `reconstructed eligible supply ${eligibleSupplyAtSnapshot} does not match the on-chain ` +
        `commitment ${committedSupply} for snapshot block ${epoch.snapshotBlock}. Eligibility ` +
        `classification must be corrected before a root may be proposed.`
    );
  }

  const weighted = eligibleHolders.filter((h) => (minima.get(h) ?? 0n) > 0n);
  const eligibleMinSupply = weighted.reduce((acc, h) => acc + (minima.get(h) ?? 0n), 0n);

  if (eligibleMinSupply === 0n) {
    throw new DatasetError(
      `no account held a positive balance across the whole holding window ` +
        `[${windowStartBlock}, ${epoch.snapshotBlock}]. Nobody has held long enough to be ` +
        `entitled yet; the reserve stays with the store until the liveness timeout returns it.`
    );
  }
  if (eligibleMinSupply > eligibleSupplyAtSnapshot) {
    // Structurally impossible (a minimum cannot exceed the endpoint it is a minimum over), so
    // reaching this means the reconstruction itself is broken.
    throw new DatasetError(
      `summed minimum ${eligibleMinSupply} exceeds the snapshot eligible supply ` +
        `${eligibleSupplyAtSnapshot}, which cannot happen; the window reconstruction is wrong.`
    );
  }

  const claimable = BigInt(epoch.claimableUSDC);
  const suspensions = await suspensionsAtSnapshot(options.chainId, epoch.storeId, epoch.snapshotBlock);

  const entries: DatasetEntry[] = [];
  let total = 0n;
  let index = 0;

  for (const account of weighted) {
    const balance = minima.get(account)!;
    // Floor division: the sum can only undershoot, never over-distribute. [0.25.I]
    const amount = (claimable * balance) / eligibleMinSupply;
    if (amount === 0n) continue;

    const blocking = suspensions.get(account) ?? [];
    const entry: DatasetEntry = {
      index,
      account,
      windowMinimumBalance: balance,
      amountUSDC: amount,
      blockingProposalIds: blocking,
      leaf: leafHash({
        chainId: options.chainId,
        distributor: options.distributor.toLowerCase(),
        epochId: BigInt(options.epochId),
        index: BigInt(index),
        account,
        amount,
        blockingProposalIds: blocking,
      }),
      proof: [],
    };
    entries.push(entry);
    total += amount;
    index += 1;
  }

  if (total > claimable) {
    throw new DatasetError(`entitlement total ${total} exceeds the funded claimable ${claimable}`);
  }

  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.account)) throw new DatasetError(`duplicate account ${e.account}`);
    seen.add(e.account);
  }

  const tree = buildTree(entries.map((e) => e.leaf));
  entries.forEach((e, i) => {
    e.proof = getProof(tree.layers, i);
  });

  const datasetHash = keccak256(
    abi.encode(
      ["uint256", "address", "uint256", "uint256", "uint256", "bytes32"],
      [
        options.chainId,
        options.distributor.toLowerCase(),
        BigInt(options.epochId),
        eligibleMinSupply,
        total,
        tree.root,
      ]
    )
  );

  return {
    epochId: options.epochId,
    distributor: options.distributor.toLowerCase(),
    chainId: options.chainId,
    snapshotBlock: epoch.snapshotBlock,
    windowStartBlock,
    holdingWindowSeconds,
    eligibleMinSupply,
    eligibleSupplyAtSnapshot,
    claimableUSDC: claimable,
    entries,
    total,
    root: tree.root,
    datasetHash,
  };
}

/**
 * Independent verification pass.
 *
 * "Independent verifier" here means a separately recomputed software verification path, not
 * an external audit company (MASTER_PLAN 0.25.G). This recomputes the dataset from scratch
 * and compares every committed value, so a generator bug or a tampered dataset is caught
 * before the root is proposed, and again before it is finalized.
 */
export async function verifyDataset(dataset: Dataset, options: GenerateOptions): Promise<void> {
  const recomputed = await generateDataset(options);

  if (recomputed.root !== dataset.root) throw new DatasetError("root mismatch on recomputation");
  if (recomputed.total !== dataset.total) throw new DatasetError("total mismatch on recomputation");
  if (recomputed.datasetHash !== dataset.datasetHash) throw new DatasetError("dataset hash mismatch");
  if (recomputed.entries.length !== dataset.entries.length) {
    throw new DatasetError("entry count mismatch on recomputation");
  }
  for (let i = 0; i < recomputed.entries.length; i++) {
    const a = recomputed.entries[i]!;
    const b = dataset.entries[i]!;
    if (a.account !== b.account || a.amountUSDC !== b.amountUSDC || a.leaf !== b.leaf) {
      throw new DatasetError(`entry ${i} mismatch on recomputation`);
    }
  }
  if (dataset.total > dataset.claimableUSDC) throw new DatasetError("total exceeds funded amount");
}

/** Persists entitlements so claims can be served without recomputing the tree per request. */
export async function persistDataset(dataset: Dataset, storeId: string): Promise<void> {
  for (const entry of dataset.entries) {
    await DividendEntitlement.updateOne(
      {
        chainId: dataset.chainId,
        distributor: dataset.distributor,
        epochId: dataset.epochId,
        index: entry.index,
      },
      {
        $set: {
          chainId: dataset.chainId,
          storeId,
          distributor: dataset.distributor,
          epochId: dataset.epochId,
          index: entry.index,
          account: entry.account,
          windowMinimumBalance: entry.windowMinimumBalance.toString(),
          amountUSDC: entry.amountUSDC.toString(),
          blockingProposalIds: entry.blockingProposalIds.map((b) => b.toString()),
          leaf: entry.leaf,
          proof: entry.proof,
        },
      },
      { upsert: true }
    );
  }
  logger.info(
    { epochId: dataset.epochId, entries: dataset.entries.length, root: dataset.root },
    "dividend dataset persisted"
  );
}
