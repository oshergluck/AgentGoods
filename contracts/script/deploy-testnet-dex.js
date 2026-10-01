/**
 * Deploy a real Uniswap V2 and a test USDC to a TESTNET, for the Phase 2 rehearsal.
 *
 *     npx hardhat run script/deploy-testnet-dex.js --network baseSepolia
 *
 * Why this exists at all: **Base Sepolia has no official Uniswap V2 deployment.** Verified against
 * the live chain rather than assumed —
 *
 *     Base mainnet  router 0x4752…aD24  present, and its factory() returns the documented
 *                                       0x8909…8eC6, so the two are genuinely a matched pair
 *     Base Sepolia  the SAME address holds a contract of a different size that has no factory()
 *                   at all, and the mainnet factory address has no code whatsoever
 *
 * So pointing the testnet deployment at the mainnet addresses would wire the protocol to an
 * unrelated contract. It would not fail loudly; `addLiquidity` would revert or behave in some
 * undefined way at the one moment in a token's life that cannot be retried.
 *
 * The deployment here is byte-for-byte the official `@uniswap/v2-core` and `@uniswap/v2-periphery`
 * artifacts, with the pair init code hash asserted equal to the canonical mainnet value — the same
 * helper the transition tests use. A rehearsal against a stub proves nothing about the real thing.
 *
 * REFUSES TO RUN ON MAINNET. On Base there is a real Uniswap V2 and the protocol must use it.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");
const { deployRealUniswap } = require("../test/helpers/uniswap");
const { waitForCode } = require("./lib/confirm");

const MAINNET_CHAIN_IDS = new Set([1n, 8453n, 10n, 42161n, 137n]);

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await ethers.getSigners();

  if (MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `Refusing to run on chainId ${chainId}. This script deploys a PRIVATE Uniswap V2 for ` +
        `rehearsal only. A production deployment must use the canonical public deployment, or the ` +
        `token lists into a pool nobody else can find.`
    );
  }

  console.log(`\nTestnet DEX deployment — ${network.name} (chainId ${chainId})`);
  console.log(`  deployer  ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`  balance   ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error("The deployer has no testnet ETH. Fund it from a Base Sepolia faucet first.");
  }

  // Asserts the pair init code hash matches mainnet, which is what proves the periphery router's
  // hardcoded pairFor hash agrees with the factory we just deployed.
  console.log("\nDeploying official Uniswap V2 artifacts…");
  const uni = await deployRealUniswap(deployer);
  const factoryAddress = await uni.factory.getAddress();
  const routerAddress = await uni.router.getAddress();
  const wethAddress = await uni.weth.getAddress();
  console.log(`  WETH9              ${wethAddress}`);
  console.log(`  UniswapV2Factory   ${factoryAddress}`);
  console.log(`  UniswapV2Router02  ${routerAddress}`);

  // A 6-decimal test USDC. The protocol hardcodes nothing about USDC beyond its decimals, so the
  // rehearsal is faithful as long as this one is also 6.
  console.log("\nDeploying test USDC (6 decimals)…");
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  // A mined deployment is not the same as a readable one on a public RPC. See script/lib/confirm.js.
  await waitForCode(usdcAddress, "MockUSDC");
  const decimals = await usdc.decimals();
  console.log(`  MockUSDC           ${usdcAddress}  (decimals ${decimals})`);
  if (Number(decimals) !== 6) {
    throw new Error(`Test USDC reports ${decimals} decimals; the protocol assumes 6.`);
  }

  // Cross-check the wiring the same way the mainnet addresses were checked, rather than trusting
  // that a fresh deployment must be consistent.
  await waitForCode(routerAddress, "UniswapV2Router02");
  await waitForCode(factoryAddress, "UniswapV2Factory");
  const routerFactory = await uni.router.factory();
  if (routerFactory.toLowerCase() !== factoryAddress.toLowerCase()) {
    throw new Error(`router.factory() is ${routerFactory}, not the factory just deployed.`);
  }
  console.log("\n  router.factory() matches the deployed factory.");

  const outFile = path.resolve(__dirname, "..", "..", "deployments", `testnet-dex.${chainId}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    `${JSON.stringify(
      {
        chainId: Number(chainId),
        network: network.name,
        deployedAt: new Date().toISOString(),
        deployer: deployer.address,
        note: "Rehearsal infrastructure. NOT canonical. Never referenced by a mainnet manifest.",
        weth: wethAddress,
        dexFactory: factoryAddress,
        dexRouter: routerAddress,
        usdc: usdcAddress,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  console.log(`\n  wrote ${outFile}`);

  console.log(
    `\nPut these in contracts/.env for the testnet run:\n\n` +
      `  DEX_ROUTER_ADDRESS=${routerAddress}\n` +
      `  CANONICAL_USDC_ADDRESS=${usdcAddress}\n\n` +
      `Then swap them back to the Base mainnet values before Phase 4. The deployment gate does not\n` +
      `check these against a known list, so this is one of the few places where a stale .env would\n` +
      `not be caught for you.\n`
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`\n${error.message ?? error}\n`);
      process.exit(1);
    });
}

module.exports = { main };
