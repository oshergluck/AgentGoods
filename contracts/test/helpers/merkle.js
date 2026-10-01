const { ethers } = require("hardhat");

/**
 * Reference implementation of the canonical dividend claim dataset.
 *
 * This is deliberately a SECOND, independent implementation of the leaf encoding and tree
 * construction used by the backend root generator (backend/src/dividends/merkle.ts). The
 * golden-vector test asserts the two agree, which is what MASTER_PLAN 0.24.B asks for:
 * "two independent implementations must produce the same entitlement set/root".
 */

/** Canonical leaf hash. Double hashed so a leaf can never collide with an internal node. */
function leafHash({ chainId, distributor, epochId, index, account, amount, blockingProposalIds }) {
  const blockingHash = ethers.solidityPackedKeccak256(
    ["uint256[]"],
    [blockingProposalIds.map((n) => BigInt(n))]
  );
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256", "uint256", "address", "uint256", "bytes32"],
      [chainId, distributor, epochId, index, account, amount, blockingHash]
    )
  );
  return ethers.keccak256(inner);
}

function hashPair(a, b) {
  return BigInt(a) < BigInt(b)
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

/** Builds a sorted-pair Merkle tree compatible with OpenZeppelin MerkleProof. */
function buildTree(leaves) {
  if (leaves.length === 0) return { root: ethers.ZeroHash, layers: [[]] };
  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}

function getProof(tree, index) {
  const proof = [];
  let idx = index;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level];
    const pairIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (pairIndex < layer.length) proof.push(layer[pairIndex]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Deterministically builds an entitlement dataset for one epoch.
 *
 * @param entries [{ account, snapshotBalance, blockingProposalIds }]
 * @param eligibleSupply Sum of eligible EOA balances at the snapshot block.
 * @param claimableUSDC The funded claim pool for the epoch.
 *
 * Rounding: entitlements floor, so the sum can only undershoot `claimableUSDC`. The
 * remainder stays protected holder value and rolls forward. [MASTER_PLAN 0.25.I]
 */
function buildDataset({ chainId, distributor, epochId, entries, eligibleSupply, claimableUSDC }) {
  // Deterministic order, independent of caller input order.
  const sorted = entries
    .filter((e) => BigInt(e.snapshotBalance) > 0n)
    .slice()
    .sort((a, b) => (a.account.toLowerCase() < b.account.toLowerCase() ? -1 : 1));

  const seen = new Set();
  const records = [];
  let total = 0n;

  sorted.forEach((e, index) => {
    const key = e.account.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate account in dataset: ${e.account}`);
    seen.add(key);

    const amount = (BigInt(claimableUSDC) * BigInt(e.snapshotBalance)) / BigInt(eligibleSupply);
    if (amount === 0n) return;
    total += amount;

    const blockingProposalIds = (e.blockingProposalIds || []).map((n) => BigInt(n)).sort((a, b) => (a < b ? -1 : 1));
    records.push({
      index,
      account: e.account,
      amount,
      blockingProposalIds,
      leaf: leafHash({ chainId, distributor, epochId, index, account: e.account, amount, blockingProposalIds }),
    });
  });

  if (total > BigInt(claimableUSDC)) {
    throw new Error("dataset over-allocates the funded claim pool");
  }

  const tree = buildTree(records.map((r) => r.leaf));
  const datasetHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "uint256", "uint256", "uint256", "bytes32"],
      [chainId, distributor, epochId, eligibleSupply, total, tree.root]
    )
  );

  return {
    records: records.map((r, i) => ({ ...r, proof: getProof(tree, i) })),
    root: tree.root,
    total,
    datasetHash,
  };
}

module.exports = { leafHash, buildTree, getProof, buildDataset };
