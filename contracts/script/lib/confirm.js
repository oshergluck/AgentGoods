/**
 * Wait until a freshly deployed contract is actually readable.
 *
 * `waitForDeployment()` resolves when the deployment transaction is mined. On a public RPC that is
 * not the same thing as "the next `eth_call` will work": providers sit behind load balancers, and
 * the node that answers your read may be a block or two behind the node that saw your write. The
 * symptom is a decode failure on the very first call —
 *
 *     could not decode result data (value="0x", info={ method: "decimals" }, code=BAD_DATA)
 *
 * — which reads like a broken ABI and is actually a race. Observed on Base Sepolia deploying
 * MockUSDC immediately after `waitForDeployment()` returned.
 *
 * It matters far more than a retry-and-move-on would suggest. On mainnet the same race aborts a
 * deployment script PARTWAY THROUGH, after gas has been spent and contracts exist, with no
 * manifest written to say what was created. That is the single most expensive failure mode a
 * deployment script has, and it is caused by a read, not by a write.
 */

const { ethers } = require("hardhat");

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 1_500;

/**
 * Blocks until `address` reports non-empty bytecode, then returns it.
 *
 * Polls rather than waiting a fixed period: a fixed sleep is either too short on a slow provider
 * or wasted time on a fast one, and this runs once per deployed contract.
 */
async function waitForCode(address, label = "contract", timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    const code = await ethers.provider.getCode(address);
    if (code && code !== "0x") {
      if (attempts > 0) {
        console.log(`    (${label} became readable after ${attempts} extra poll(s))`);
      }
      return code;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label} at ${address} still reports no bytecode after ${Math.round(timeoutMs / 1000)}s. ` +
          `The deployment transaction was mined, so the contract very likely EXISTS and this is an ` +
          `RPC lagging behind. Do not redeploy blindly: check the address on the explorer first.`
      );
    }
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Deploy, wait for the receipt, and then wait until the code is genuinely readable. */
async function deployAndConfirm(factory, args, label) {
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  await waitForCode(address, label);
  return { contract, address };
}

module.exports = { waitForCode, deployAndConfirm };

/**
 * Poll a read until it returns the expected value.
 *
 * `tx.wait()` proves a transaction was mined. It does NOT prove the node that answers your next
 * `eth_call` has seen that block — behind a load balancer it often has not. Observed on Base
 * Sepolia: `authorizeFactory` was mined and succeeded, and the very next `isAuthorizedFactory`
 * read returned `false` from a lagging node.
 *
 * That combination is worse than it sounds. The read was inside a post-deployment CHECK, so a
 * correct deployment reported itself as failed and the script aborted before writing the manifest
 * — leaving real, correct, paid-for contracts on chain with no record of their addresses.
 */
async function waitForValue(read, expected, label, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const want = String(expected).toLowerCase();
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last;
  for (;;) {
    last = String(await read()).toLowerCase();
    if (last === want) {
      if (attempts > 0) console.log(`    (${label} settled after ${attempts} extra poll(s))`);
      return true;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label} still reads "${last}" rather than "${want}" after ` +
          `${Math.round(timeoutMs / 1000)}s. This is a genuine mismatch, not RPC lag.`
      );
    }
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

module.exports.waitForValue = waitForValue;

/**
 * Poll a read until it satisfies a predicate.
 *
 * The third shape of the same hazard. `waitForValue` covers "I know the exact value I expect";
 * this covers "I only know the shape" — the common case being a balance read straight after a
 * trade, where the answer is some positive number nobody can predict in advance.
 *
 * Observed on Base Sepolia: a curve buy succeeded, and `balanceOf` on the very next line returned
 * ZERO from a node one block behind. The script then approved zero, and the deposit that followed
 * reverted. Nothing threw at the point of the bad read, so the failure surfaced two calls later
 * disguised as an allowance problem.
 *
 * That is why a read feeding a COMPUTATION deserves the same care as a read feeding a check: a
 * stale zero does not look like an error, it looks like an answer.
 */
async function readUntil(read, predicate, label, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    const value = await read();
    if (predicate(value)) {
      if (attempts > 0) console.log(`    (${label} settled after ${attempts} extra poll(s))`);
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label} never satisfied its expected shape within ${Math.round(timeoutMs / 1000)}s ` +
          `(last value: ${value}). Treat this as a real failure, not lag.`
      );
    }
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

module.exports.readUntil = readUntil;

/**
 * Approve, then wait until the allowance is actually readable.
 *
 * The fourth and most pervasive shape of the lag. `approve().wait()` resolves when the approval is
 * mined; the very next call's GAS ESTIMATION may still be answered by a node that has not seen it,
 * and gas estimation runs the call — so it reverts with an allowance error for an approval that
 * demonstrably exists.
 *
 * The symptom is maximally confusing: a `staticCall` of the same function at the same amount
 * succeeds, because by the time a human checks, the node has caught up. It looks intermittent and
 * it is not: it is deterministic in the gap between "mined" and "visible to the next reader".
 *
 * Every approve that is immediately followed by a spend should go through here.
 */
async function approveSettled(token, spender, amount, label = "allowance") {
  const owner = await token.runner.getAddress();
  await submit(() => token.approve(spender, amount), `${label} approve`);
  await readUntil(
    () => token.allowance(owner, spender),
    (v) => v >= amount,
    label
  );
}

module.exports.approveSettled = approveSettled;

/**
 * Send a transaction, retrying ONLY failures that happened before anything was broadcast.
 *
 * The final shape of the lag, and the one no amount of settling fixes. A load-balanced RPC gives
 * no node affinity: `approveSettled` can confirm an allowance against node X and the very next
 * `eth_estimateGas` can be answered by node Y, which has not seen it. Observed repeatedly on Base
 * Sepolia, usually surfacing as a mangled `execution reverted: %` that decodes to nothing.
 *
 * **Why this retry cannot double-spend.** Gas estimation happens BEFORE the transaction is signed
 * or broadcast, so a failure there means nothing was sent. The two cases are distinguished
 * precisely: if the error carries a receipt or a transaction hash, the transaction reached the
 * chain and its revert is real — rethrow, never retry. Only a failure with neither is retried.
 *
 * A retry that cannot tell those apart would be dangerous. This one can, so it is not.
 */
async function submit(makeTx, label, attempts = 5) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      const tx = await makeTx();
      return await tx.wait();
    } catch (error) {
      // Reached the chain: a real revert. Never retry.
      if (error?.receipt || error?.transactionHash || error?.transaction?.hash) throw error;
      lastError = error;
      if (i < attempts) {
        console.log(`    (${label}: pre-broadcast failure, retry ${i}/${attempts - 1})`);
        await new Promise((resolve) => setTimeout(resolve, 2500 * i));
      }
    }
  }
  throw lastError;
}

module.exports.submit = submit;
