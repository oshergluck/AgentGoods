/**
 * Real Uniswap V2, deployed from the OFFICIAL compiled artifacts.
 *
 * The mock router in `src/mocks` is a stub: it mints `amountA + amountB` as liquidity, has no
 * MINIMUM_LIQUIDITY lock, no uint112 reserve bounds, no `quote()` optimal-amount logic and no
 * k-invariant. A transition that passes against it proves only that the call was made with
 * plausible arguments.
 *
 * The listing is one-way and moves real money, so it has to be tested against the code that will
 * actually receive it. These are the published `@uniswap/v2-core` and `@uniswap/v2-periphery`
 * build artifacts, deployed byte for byte — the pair init code hash is asserted to equal the
 * canonical mainnet value, which is what proves the periphery router's hardcoded `pairFor` hash
 * matches the factory we deployed.
 */

const { ethers } = require("hardhat");
const { keccak256 } = require("ethers");

const FactoryArtifact = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const PairArtifact = require("@uniswap/v2-core/build/UniswapV2Pair.json");
const RouterArtifact = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");
const WETHArtifact = require("@uniswap/v2-periphery/build/WETH9.json");

/** The init code hash every deployed UniswapV2Router02 has compiled into it. */
const CANONICAL_PAIR_INIT_CODE_HASH =
  "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";

function hex(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function deployArtifact(artifact, args, signer) {
  const factory = new ethers.ContractFactory(artifact.abi, hex(artifact.bytecode), signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

/**
 * Deploys a real Uniswap V2 environment and proves it is the real one.
 *
 * If the init code hash ever stops matching, the router's `pairFor` computes an address the
 * factory would not create, and every liquidity operation silently targets the wrong contract.
 * Asserting it here means that failure is caught at setup rather than misread as a protocol bug.
 */
async function deployRealUniswap(deployer) {
  const computedHash = keccak256(hex(PairArtifact.bytecode));
  if (computedHash !== CANONICAL_PAIR_INIT_CODE_HASH) {
    throw new Error(
      `Uniswap pair init code hash is ${computedHash}, not the canonical ` +
        `${CANONICAL_PAIR_INIT_CODE_HASH}. The periphery router would compute wrong pair addresses.`
    );
  }

  const weth = await deployArtifact(WETHArtifact, [], deployer);
  const factory = await deployArtifact(FactoryArtifact, [deployer.address], deployer);
  const router = await deployArtifact(
    RouterArtifact,
    [await factory.getAddress(), await weth.getAddress()],
    deployer
  );

  return {
    weth,
    factory,
    router,
    factoryAddress: await factory.getAddress(),
    routerAddress: await router.getAddress(),
    pairAbi: PairArtifact.abi,
    initCodeHash: computedHash,
  };
}

/** Attaches to a deployed pair with the official ABI. */
function attachPair(address, signer) {
  return new ethers.Contract(address, PairArtifact.abi, signer);
}

module.exports = {
  deployRealUniswap,
  attachPair,
  CANONICAL_PAIR_INIT_CODE_HASH,
};
