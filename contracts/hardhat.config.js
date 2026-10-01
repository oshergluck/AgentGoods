require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/**
 * Reproducible build settings. These values are part of the deployment manifest
 * (docs/DEPLOYMENT_RUNBOOK.md) and must not be changed without re-verifying
 * deployed bytecode. See MASTER_PLAN §0.3 "Reproducible contracts".
 */
const SOLC_VERSION = "0.8.28";
const OPTIMIZER_RUNS = 200;
const EVM_VERSION = "cancun";

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      optimizer: { enabled: true, runs: OPTIMIZER_RUNS },
      evmVersion: EVM_VERSION,
      viaIR: true,
      metadata: { bytecodeHash: "none" },
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata", "storageLayout"] }
      }
    }
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
      blockGasLimit: 30_000_000
    },
    localhost: {
      // Port is configurable so the backend integration harness can run its own node
      // without colliding with a developer's default 8545 instance.
      url: `http://127.0.0.1:${process.env.LOCALHOST_PORT || 8545}`,
      chainId: 31337
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "",
      chainId: 84532,
    /*
     * Pad every gas estimate by 50%.
     *
     * ESHCoin maintains an indexed max-heap of eligible holders, so the gas a transfer costs
     * depends on the heap's SHAPE at execution time, not just on the call. An estimate taken a
     * block or two earlier — which is what a load-balanced RPC returns — can therefore be too
     * small by the time the transaction is mined, and the shortfall surfaces as a plain revert
     * rather than an out-of-gas error.
     *
     * Observed on Base Sepolia: `depositRewardPool` estimated 210,226, reverted at 202,526, and
     * re-estimating afterwards returned 258,768 for the identical call. Padding costs nothing —
     * unused gas is refunded — and the alternative is a deployment step that fails intermittently
     * for reasons that look like a contract bug.
     *
     * 3x rather than something tighter, because of the 63/64 rule. A contract forwards at most
     * 63/64 of its remaining gas to an inner call, so when the shortfall lands inside `_update`
     * the inner frame runs out while the outer frame keeps its 1/64 — and the receipt shows
     * `gasUsed` just BELOW `gasLimit` with no revert reason and no logs. It does not look like an
     * out-of-gas failure, which is exactly why it is worth over-padding to avoid.
     * A `sell` reverted this way at 274,824 used against a 278,729 limit.
     */
    /*
     * A FIXED limit, because this endpoint's `eth_estimateGas` cannot be trusted here.
     *
     * Padding the estimate was not enough: a buy estimated ~182k and needed >526k, a 3.4x miss,
     * and the shortfall lands inside an inner call so the receipt shows `gasUsed` just under
     * `gasLimit` with no reason and no logs (the 63/64 rule). Estimates that wrong cannot be
     * multiplied into safety.
     *
     * A high fixed limit costs nothing: EIP-1559 charges for gas USED, not gas requested, and
     * unused gas is never billed. Base Sepolia blocks are far larger than this.
     *
     * What it gives up, and this is a real trade: skipping estimation also skips the free
     * "this call would revert" warning, so a doomed transaction is now actually sent and reverts
     * on chain. For a rehearsal that is the better trade; for mainnet it is not, which is why
     * `base` below keeps estimation with a multiplier instead.
     */
    /*
     * NOTE: hardhat's network-level `gas` is NOT honoured here. `hardhat-ethers` builds and signs
     * the transaction itself and calls `estimateGas` directly, so only `gasMultiplier` is applied
     * to the result. Setting `gas: 12_000_000` looked correct and silently did nothing — the
     * receipts still showed `estimate x 3`.
     *
     * 6x because the observed miss was 2.9x (estimate 181,754, actual need > 526,308) and the
     * shortfall lands inside an inner call, where the 63/64 rule disguises it as a plain revert.
     * Over-padding is free: EIP-1559 bills gas USED, never gas requested.
     */
    gasMultiplier: 6,

      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    },
    base: {
      url: process.env.BASE_RPC_URL || "",
      chainId: 8453,
      // Same reason as baseSepolia above: heap-dependent gas plus a lagging estimate.
      gasMultiplier: 3,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    }
  },
  /*
   * Etherscan V2: ONE key, every chain, chain selected by a `chainid` query parameter.
   *
   * `apiKey` MUST be a plain string. The plugin decides which API generation to speak with
   * `const isV2 = typeof apiKey === "string"` (hardhat-verify/internal/etherscan.js), so the
   * older per-network object form silently selects V1 — deprecated since 2025-08-15, and not
   * what a current Etherscan key is issued for. The failure would appear at verification time,
   * after the contracts are already deployed and the addresses already canonical.
   */
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY || ""
  },
  gasReporter: { enabled: process.env.REPORT_GAS === "true" },
  mocha: { timeout: 300000 }
};
