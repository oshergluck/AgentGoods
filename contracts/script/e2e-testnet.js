/**
 * End-to-end protocol exercise against a LIVE testnet.
 *
 *     npx hardhat run script/e2e-testnet.js --network baseSepolia
 *
 * Everything the protocol does, driven against real contracts on a real network with a real
 * explorer and real block timing. The local suite proves the logic; this proves the logic survives
 * contact with an actual chain — which is a different claim, and the one that matters before
 * spending money on mainnet.
 *
 * Three scenarios, chosen because they are the paths where a defect is expensive:
 *
 *   STORE A  the ordinary life of a store: commerce, buyer incentives, curve trading in both
 *            directions, and a real graduation onto real Uniswap V2.
 *   STORE B  an attacker funds the pool BEFORE the threshold. Graduation must be abandoned, not
 *            reverted, and the burn must land supply and price where graduation would have while
 *            keeping a full exit exactly payable. (D-035, D-037)
 *   STORE C  governance and dividends.
 *
 * WHY IT IS RESUMABLE. Two protocol clocks cannot be skipped on a real chain:
 * `ROOT_CHALLENGE_PERIOD` is 6 hours and `MIN_VOTING_PERIOD` is 1 hour. A local test moves time
 * forward; here we cannot. So the script STARTS those clocks on the first run, completes
 * everything immediate, records what it is waiting for, and finishes the rest when re-run later.
 * State lives in `deployments/e2e.<chainId>.json`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");
const { waitForValue, readUntil, approveSettled, submit } = require("./lib/confirm");

const USDC = (n) => BigInt(Math.round(n * 1e6));
const AIC = (n) => ethers.parseUnits(String(n), 18);
const MAINNET_CHAIN_IDS = new Set([1n, 8453n, 10n, 42161n, 137n]);

const StoreType = { Sales: 0, Rentals: 1 };
const Phase = { None: 0, BondingCurve: 1, Transitioning: 2, ExternalDex: 3 };

const UNDECLARED = { tokensSaved: 0n, modelTier: ethers.ZeroHash, basis: 0, declaredAt: 0n };

let state;
let stateFile;

function save() {
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function log(msg) {
  console.log(msg);
}

function ok(label, value) {
  console.log(`   OK   ${String(label).padEnd(46)} ${value ?? ""}`);
}

function fail(label, detail) {
  state.failures.push(`${label}: ${detail}`);
  console.log(`   FAIL ${String(label).padEnd(46)} ${detail}`);
}

function check(label, condition, detail) {
  if (condition) ok(label, detail);
  else fail(label, detail);
  return condition;
}

/** Every wallet is derived from the deployer's key, so one funded key drives every actor. */
function actor(index) {
  const base = ethers.Wallet.fromPhrase
    ? null
    : null;
  return ethers.HDNodeWallet.fromSeed(
    ethers.keccak256(ethers.toUtf8Bytes(`aic-e2e-actor-${index}-${state.salt}`))
  ).connect(ethers.provider);
}

async function fundGas(deployer, to, amountEth) {
  const bal = await ethers.provider.getBalance(to);
  const want = ethers.parseEther(amountEth);
  if (bal >= want) return;
  await submit(() => deployer.sendTransaction({ to, value: want - bal }), "sendTransaction");
}

async function mintUSDC(usdc, to, amount) {
  await submit(() => usdc.mint(to, amount), "mint");
}

module.exports = { USDC, AIC };

/* ------------------------------------------------------------------ main */

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (MAINNET_CHAIN_IDS.has(chainId)) {
    throw new Error(`Refusing to run the e2e exercise on chainId ${chainId}. Testnets only.`);
  }

  const [deployer] = await ethers.getSigners();
  const manifestFile = path.resolve(__dirname, "..", "..", "deployments", `${chainId}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  stateFile = path.resolve(__dirname, "..", "..", "deployments", `e2e.${chainId}.json`);

  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.failures = [];
    log(`\nResuming e2e run from ${stateFile}`);
  } else {
    state = { salt: Date.now().toString(36), startedAt: new Date().toISOString(), stores: {}, failures: [], done: {} };
    log(`\nStarting a new e2e run`);
  }

  log(`Network ${network.name} (chainId ${chainId})`);
  log(`Deployer ${deployer.address}  balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  const registry = await ethers.getContractAt("AICRegistry", manifest.contracts.registry.proxy);
  const agentGoods = await ethers.getContractAt("AgentGoods", manifest.contracts.agentGoods.proxy);
  const usdc = await ethers.getContractAt("MockUSDC", manifest.external.canonicalUSDC);
  const factoryAddress = manifest.contracts.activeFactories[0].address;
  const factory = await ethers.getContractAt("StoreFactory", factoryAddress);
  const router = await ethers.getContractAt(
    ["function factory() view returns (address)"],
    manifest.external.dexRouter
  );
  const dexFactory = await ethers.getContractAt(
    ["function getPair(address,address) view returns (address)", "function createPair(address,address) returns (address)"],
    manifest.external.dexFactory
  );

  const ctx = { deployer, registry, agentGoods, usdc, factory, router, dexFactory, manifest, chainId };

  await scenarioA(ctx);
  await scenarioB(ctx);
  await scenarioC(ctx);

  save();
  report();
}

/* ----------------------------------------------------- shared store helper */

/**
 * A dedicated, persisted creator wallet per store key.
 *
 * ONE SALES AND ONE RENTALS STORE PER ADDRESS — StoreFactory enforces it, so the three scenarios
 * cannot all be created by the deployer. Each key gets its own wallet, kept in the resumable state
 * file so a re-run controls the same stores it created: the controller is the only address that
 * can operate a store, so losing that key would strand it.
 */
async function creatorFor(ctx, key) {
  state.creators ??= {};
  if (!state.creators[key]) {
    state.creators[key] = ethers.Wallet.createRandom().privateKey;
    save();
  }
  const wallet = new ethers.Wallet(state.creators[key], ethers.provider);
  await fundGas(ctx.deployer, wallet.address, "0.002");
  return wallet;
}

async function createStore(ctx, key, symbol, storeName) {
  if (state.stores[key]?.store) {
    log(`\n[${key}] reusing store ${state.stores[key].store}`);
    return state.stores[key];
  }
  log(`\n[${key}] creating store "${storeName}" (${symbol})`);
  const creator = await creatorFor(ctx, key);
  log(`[${key}] creator ${creator.address}`);
  const tx = await ctx.factory
    .connect(creator)
    .createStore(StoreType.Sales, `${storeName} AIC`, symbol, storeName, 5_000_000n);
  const receipt = await tx.wait();
  const parsed = receipt.logs
    .map((l) => { try { return ctx.factory.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "StoreCreated");
  if (!parsed) throw new Error("StoreCreated not found in receipt");

  const rec = {
    storeId: parsed.args.storeId,
    controller: creator.address,
    store: parsed.args.store,
    aic: parsed.args.aicToken,
    license: parsed.args.licenseToken,
    governance: parsed.args.governance,
    distributor: parsed.args.dividendDistributor,
  };
  state.stores[key] = rec;
  save();
  ok("store created", rec.store);
  ok("aic token", rec.aic);
  return rec;
}

/**
 * Handles connected to the store's OWN controller, not to the deployer.
 *
 * Since one address may hold only one Sales store, each scenario's store is created by its own
 * wallet — so the deployer is no longer the controller of anything, and a store call signed by it
 * reverts as unauthorised. Connecting here rather than at every call site keeps that in one place.
 * Calls that are deliberately made by someone else (a buyer, an attacker) still `.connect()`
 * explicitly and are unaffected.
 */
async function attach(rec) {
  const signer = rec.controller
    ? new ethers.Wallet(state.creators[controllerKeyFor(rec)], ethers.provider)
    : undefined;
  const as = async (name, address) => {
    const c = await ethers.getContractAt(name, address);
    return signer ? c.connect(signer) : c;
  };
  return {
    store: await as("AICStoreSales", rec.store),
    aic: await as("AICoin", rec.aic),
    governance: await as("AICGovernance", rec.governance),
    distributor: await as("DividendDistributor", rec.distributor),
  };
}

/** Which store key a record belongs to, so its creator key can be looked up. */
function controllerKeyFor(rec) {
  for (const [key, value] of Object.entries(state.stores)) {
    if (value && value.store === rec.store) return key;
  }
  throw new Error(`no store key found for ${rec.store}; cannot resolve its controller`);
}


/**
 * Create a product, tolerating one that already exists.
 *
 * A resumable script re-enters setup blocks whose earlier run died partway, so `createProduct`
 * can legitimately find its own product already there. `ProductExists` is the desired end state,
 * not a failure — but every other revert still is, so it is matched specifically rather than
 * swallowed wholesale.
 */
async function ensureProduct(storeContract, productId, price, inventory, rentalPeriod) {
  // Ask first. A gas-estimation revert arrives as an undecoded ProviderError — matching it by
  // message is unreliable, whereas the product either exists or it does not.
  const existing = await storeContract.getProduct(productId);
  if (existing.exists) {
    log(`   (product already exists, reusing it)`);
    return;
  }
  await submit(
    () => storeContract.createProduct(productId, price, inventory, rentalPeriod, ethers.ZeroHash, "", UNDECLARED),
    "createProduct"
  );
}

/* -------------------------------------------------- A: the ordinary life */

async function scenarioA(ctx) {
  log(`\n${"=".repeat(74)}\nSCENARIO A — commerce, incentives, curve trading, real graduation\n${"=".repeat(74)}`);
  const rec = await createStore(ctx, "A", "ALPHA", "Alpha Foundry");
  const c = await attach(rec);
  const productId = ethers.id("alpha-product-1");
  const price = USDC(25);

  if (!state.done.A_product) {
    await ensureProduct(c.store, productId, price, 1_000_000, 0);
    state.done.A_product = true; save();
  }
  ok("product listed", `25.00 USDC`);

  // Fund the reward pool so a buyer actually receives an incentive.
  if (!state.done.A_rewards) {
    // The controller needs AIC; buy a little from the curve first.
    await submit(() => ctx.usdc.mint(ctx.deployer.address, USDC(50)), "mint");
    await approveSettled(ctx.usdc, await ctx.agentGoods.getAddress(), USDC(50), "USDC allowance");
    const dl = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await submit(() => ctx.agentGoods.buy(rec.aic, USDC(50), 0, dl), "buy");
    // A stale zero here would approve zero and fail two calls later. See lib/confirm.js.
    const held = await readUntil(
      () => c.aic.balanceOf(ctx.deployer.address),
      (v) => v > 0n,
      "controller AIC balance after buy"
    );
    await approveSettled(c.aic, rec.store, held / 2n, "AIC allowance");
    await submit(() => c.store.depositRewardPool(held / 2n), "depositRewardPool");
    state.done.A_rewards = true; save();
  }
  const pool = state.done.A_rewards
    ? await readUntil(() => c.store.rewardPool(), (v) => v > 0n, "reward pool balance")
    : await c.store.rewardPool();
  check("reward pool funded", pool > 0n, `${ethers.formatUnits(pool, 18)} AIC`);

  // ---- commerce
  if (!state.done.A_purchase) {
    await submit(() => ctx.usdc.mint(ctx.deployer.address, price), "mint");
    await approveSettled(ctx.usdc, rec.store, price, "USDC allowance");
    const preview = await c.store.previewReward(1);
    const aicBefore = await c.aic.balanceOf(ctx.deployer.address);
    await submit(() => c.store.purchase(productId, 1, 1, price, ethers.ZeroHash, ""), "purchase");
    const gained = (await readUntil(
      () => c.aic.balanceOf(ctx.deployer.address),
      (v) => v > aicBefore,
      "buyer AIC balance after purchase"
    )) - aicBefore;
    check("buyer incentive paid as previewed", gained === preview, `${ethers.formatUnits(gained, 18)} AIC`);
    state.done.A_purchase = true; save();
  }

  const reserve = await readUntil(
    () => c.store.unfinalizedHolderReserveUSDC(), (v) => v > 0n, "holder reserve");
  const owner = await readUntil(
    () => c.store.ownerAvailableUSDC(), (v) => v > 0n, "owner proceeds");
  check("holder reserve accrued (5% of net)", reserve > 0n, `${ethers.formatUnits(reserve, 6)} USDC`);
  check("owner proceeds accrued", owner > 0n, `${ethers.formatUnits(owner, 6)} USDC`);

  // ---- curve both directions
  if (!state.done.A_sell) {
    const bal = await readUntil(
      () => c.aic.balanceOf(ctx.deployer.address),
      (v) => v > 0n,
      "AIC balance before sell"
    );
    const portion = bal / 10n;
    if (portion > 0n) {
      await approveSettled(c.aic, await ctx.agentGoods.getAddress(), portion, "AIC allowance");
      const dl = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      const before = await ctx.usdc.balanceOf(ctx.deployer.address);
      await submit(() => ctx.agentGoods.sell(rec.aic, portion, 0, dl), "sell");
      check("sell returns USDC", (await ctx.usdc.balanceOf(ctx.deployer.address)) > before, "");
    }
    state.done.A_sell = true; save();
  }

  // ---- graduation
  if (!state.done.A_graduated) {
    log(`\n   driving to graduation…`);
    await driveToGraduation(ctx, rec.aic, 60);
    state.done.A_graduated = true; save();
  }
  const m = await ctx.agentGoods.market(rec.aic);
  check("phase is ExternalDex", Number(m.phase) === Phase.ExternalDex, `phase=${m.phase}`);
  check("pair created", m.pair !== ethers.ZeroAddress, m.pair);
  check("curve USDC fully moved to pool", m.realUSDCReserve === 0n, `${m.realUSDCReserve}`);
  check("curve inventory fully burned", m.tokenInventory === 0n, `${m.tokenInventory}`);
  check("LP was minted then burned", m.lpTokenAmount > 0n, `${m.lpTokenAmount} LP`);
  check("supply fell below genesis", (await c.aic.totalSupply()) < AIC(1_000_000_000), "");

  const pairUsdc = await ctx.usdc.balanceOf(m.pair);
  check("pool holds real USDC", pairUsdc > 0n, `${ethers.formatUnits(pairUsdc, 6)} USDC`);

  // curve must be permanently closed
  try {
    const dl = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await ctx.agentGoods.buy.staticCall(rec.aic, USDC(5), 0, dl);
    fail("curve closed after listing", "a buy was still accepted");
  } catch {
    ok("curve permanently closed", "buy reverts with WrongPhase");
  }
}

/* --------------------------------------- B: pool seeded before graduation */

async function scenarioB(ctx) {
  log(`\n${"=".repeat(74)}\nSCENARIO B — attacker funds the pool first: graduation abandoned + burn\n${"=".repeat(74)}`);
  const rec = await createStore(ctx, "B", "BETA", "Beta Works");
  const c = await attach(rec);

  if (!state.done.B_seeded) {
    log(`   attacker buys AIC, then creates and FUNDS the pool before the threshold…`);
    await submit(() => ctx.usdc.mint(ctx.deployer.address, USDC(300)), "mint");
    await approveSettled(ctx.usdc, await ctx.agentGoods.getAddress(), USDC(300), "USDC allowance");
    let dl = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await submit(() => ctx.agentGoods.buy(rec.aic, USDC(300), 0, dl), "buy");

    const held = await readUntil(
      () => c.aic.balanceOf(ctx.deployer.address),
      (v) => v > 0n,
      "attacker AIC balance after buy"
    );
    const existing = await ctx.dexFactory.getPair(await ctx.usdc.getAddress(), rec.aic);
    if (existing === ethers.ZeroAddress) {
      await submit(async () => ctx.dexFactory.createPair(await ctx.usdc.getAddress(), rec.aic), "createPair");
    }
    const routerAddr = ctx.manifest.external.dexRouter;
    const seedUsdc = USDC(2000);
    const seedAic = held / 1000n;
    await submit(() => ctx.usdc.mint(ctx.deployer.address, seedUsdc), "mint");
    await approveSettled(ctx.usdc, routerAddr, seedUsdc, "USDC allowance");
    await approveSettled(c.aic, routerAddr, seedAic, "AIC allowance");
    const r = await ethers.getContractAt(
      ["function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)"],
      routerAddr
    );
    dl = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await submit(async () => r.addLiquidity(await ctx.usdc.getAddress(), rec.aic, seedUsdc, seedAic, 0, 0, ctx.deployer.address, dl), "addLiquidity");
    state.done.B_seeded = true; save();
  }
  const pairAddr = await ctx.dexFactory.getPair(await ctx.usdc.getAddress(), rec.aic);
  const poolBefore = await ctx.usdc.balanceOf(pairAddr);
  ok("hostile pool funded", `${ethers.formatUnits(poolBefore, 6)} USDC at ${pairAddr}`);

  // quoteBuy must warn BEFORE the threshold is reached
  const earlyQuote = await ctx.agentGoods.quoteBuy(rec.aic, USDC(100));
  check("quoteBuy reports graduationBlocked early", earlyQuote.graduationBlocked === true, "");
  check("quoteBuy says it will not trigger a transition", earlyQuote.willTriggerTransition === false, "");

  if (!state.done.B_blocked) {
    log(`\n   driving past the threshold — purchases must SUCCEED, not revert…`);
    await driveToGraduation(ctx, rec.aic, 60, true);
    state.done.B_blocked = true; save();
  }

  const m = await ctx.agentGoods.market(rec.aic);
  check("graduationBlocked set", m.graduationBlocked === true, "");
  check("still on the bonding curve", Number(m.phase) === Phase.BondingCurve, `phase=${m.phase}`);
  check("protocol USDC never entered the hostile pool", (await ctx.usdc.balanceOf(pairAddr)) === poolBefore, "");
  check("no LP was taken", m.lpUSDCUsed === 0n, "");
  check("curve kept its reserve", m.realUSDCReserve > 0n, `${ethers.formatUnits(m.realUSDCReserve, 6)} USDC`);

  // the burn (D-037)
  check("burn executed", m.burnedAtGraduationBlocked > 0n, `${ethers.formatUnits(m.burnedAtGraduationBlocked, 18)} AIC`);
  const supply = await c.aic.totalSupply();
  check("supply reduced", supply < AIC(1_000_000_000), `${ethers.formatUnits(supply, 18)} AIC`);

  const seed = m.virtualUSDCReserve - m.realUSDCReserve;
  check("virtual seed was reduced below 6,000", seed < USDC(6000) && seed > 0n, `${ethers.formatUnits(seed, 6)} USDC`);

  // THE critical invariant: a full exit must still be payable
  const outstanding = supply - m.tokenInventory;
  const quotedAll = (m.virtualUSDCReserve * outstanding) / (m.virtualTokenReserve + outstanding);
  check(
    "EXIT STAYS EXACT: sell-all quote <= real reserve",
    quotedAll <= m.realUSDCReserve,
    `quote ${ethers.formatUnits(quotedAll, 6)} vs real ${ethers.formatUnits(m.realUSDCReserve, 6)}`
  );

  // and the curve still trades in both directions
  if (!state.done.B_trade_after) {
    await submit(() => ctx.usdc.mint(ctx.deployer.address, USDC(20)), "mint");
    await approveSettled(ctx.usdc, await ctx.agentGoods.getAddress(), USDC(20), "USDC allowance");
    let dl = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    const before = await c.aic.balanceOf(ctx.deployer.address);
    await submit(() => ctx.agentGoods.buy(rec.aic, USDC(20), 0, dl), "buy");
    const got = (await readUntil(
      () => c.aic.balanceOf(ctx.deployer.address),
      (v) => v > before,
      "AIC balance after post-block buy"
    )) - before;
    check("buying still works after the block", got > 0n, `${ethers.formatUnits(got, 18)} AIC`);

    await approveSettled(c.aic, await ctx.agentGoods.getAddress(), got, "AIC allowance");
    dl = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    const usdcBefore = await ctx.usdc.balanceOf(ctx.deployer.address);
    await submit(() => ctx.agentGoods.sell(rec.aic, got, 0, dl), "sell");
    check("selling still works after the block", (await ctx.usdc.balanceOf(ctx.deployer.address)) > usdcBefore, "");
    state.done.B_trade_after = true; save();
  }
}

/* ------------------------------------------- C: governance and dividends */

async function scenarioC(ctx) {
  log(`\n${"=".repeat(74)}\nSCENARIO C — governance and dividends\n${"=".repeat(74)}`);
  const rec = await createStore(ctx, "C", "GAMMA", "Gamma Labs");
  const c = await attach(rec);
  const productId = ethers.id("gamma-product-1");

  if (!state.done.C_setup) {
    await ensureProduct(c.store, productId, USDC(40), 1_000_000, 0);
    // Acquire AIC so the deployer is an eligible holder with voting weight.
    await submit(() => ctx.usdc.mint(ctx.deployer.address, USDC(400)), "mint");
    await approveSettled(ctx.usdc, await ctx.agentGoods.getAddress(), USDC(400), "USDC allowance");
    const dl = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await submit(() => ctx.agentGoods.buy(rec.aic, USDC(400), 0, dl), "buy");
    // Commerce, so the holder reserve has something in it to distribute.
    for (let i = 0; i < 3; i++) {
      await submit(() => ctx.usdc.mint(ctx.deployer.address, USDC(40)), "mint");
      await approveSettled(ctx.usdc, rec.store, USDC(40), "USDC allowance");
      await submit(() => c.store.purchase(productId, 1, 1, USDC(40), ethers.ZeroHash, ""), "purchase");
    }
    state.done.C_setup = true; save();
  }
  const bal = await c.aic.balanceOf(ctx.deployer.address);
  check("holder has voting weight", bal > 0n, `${ethers.formatUnits(bal, 18)} AIC`);
  check("eligible as an EOA", await c.aic.isEligible(ctx.deployer.address), "");

  /*
   * Resume-aware. Opening a dividend epoch SWEEPS the unfinalized reserve into the distributor,
   * so on a second run this counter is legitimately zero and asserting it is non-zero fails
   * against correct behaviour. Once the epoch exists, the distributor's balance is the evidence
   * that commerce produced a reserve.
   */
  if (!state.done.C_epoch) {
    const reserve = await c.store.unfinalizedHolderReserveUSDC();
    check("holder reserve accrued from commerce", reserve > 0n, `${ethers.formatUnits(reserve, 6)} USDC`);
  } else {
    ok("holder reserve already swept into the epoch", "checked below as the distributor balance");
  }

  // ---- governance: open a proposal and vote. Resolution needs >= MIN_VOTING_PERIOD (1h).
  if (!state.done.C_proposal) {
    const votingPeriod = 3600; // the minimum the contract allows
    const tx = await c.governance.propose(ethers.id("gamma-proposal-1"), "ipfs://e2e-proposal", votingPeriod);
    const r = await tx.wait();
    const ev = r.logs.map((l) => { try { return c.governance.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name && e.name.toLowerCase().includes("propos"));
    state.done.C_proposal = true;
    state.proposalId = ev?.args?.proposalId ? ev.args.proposalId.toString() : "1";
    state.proposalOpenedAt = Math.floor(Date.now() / 1000);
    save();
    ok("proposal opened", `id=${state.proposalId}, voting period 1h`);
  } else {
    ok("proposal already open", `id=${state.proposalId}`);
  }

  if (!state.done.C_voted) {
    await submit(() => c.governance.castVote(state.proposalId, true), "castVote");
    state.done.C_voted = true; save();
    ok("vote cast (YES)", "balance locked as vote escrow");
  } else {
    ok("vote already cast", "");
  }

  // ---- dividends: open an epoch. Finalization needs >= ROOT_CHALLENGE_PERIOD (6h).
  if (!state.done.C_epoch) {
    const tx = await c.distributor.openDistribution();
    const r = await tx.wait();
    const ev = r.logs.map((l) => { try { return c.distributor.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name && e.name.toLowerCase().includes("epoch"));
    state.epochId = ev?.args?.epochId ? ev.args.epochId.toString() : "1";
    state.epochOpenedAt = Math.floor(Date.now() / 1000);
    state.done.C_epoch = true; save();
    ok("dividend epoch opened (permissionless)", `epoch=${state.epochId}`);
  } else {
    ok("dividend epoch already open", `epoch=${state.epochId}`);
  }

  const committed = await ctx.usdc.balanceOf(rec.distributor);
  check("reserve committed to the distributor", committed > 0n, `${ethers.formatUnits(committed, 6)} USDC`);

  await resolveGovernance(ctx, c);
  await driveDividendRoot(ctx, rec, c);
}

/* ----------------------------------------------- C: governance resolution */

/**
 * Drive the proposal to ImplementationVerified.
 *
 * An earlier version of this script waited an hour for "resolution", which was a misreading of
 * the contract: `castVote` passes a proposal IMMEDIATELY once the threshold is met, so the
 * voting deadline only matters to a proposal that did NOT pass. The remaining lifecycle --
 * markImplemented then confirmImplementation by the original YES coalition -- has no wall clock
 * at all, and the script was stopping short of the two steps that actually resolve a proposal
 * and lift the dividend suspension.
 */
async function resolveGovernance(ctx, c) {
  const PASSED = 3, IMPLEMENTED = 4, VERIFIED = 5, FAILED = 2;
  const id = state.proposalId;

  let st = Number(await c.governance.state(id));
  if (st === FAILED) {
    // Failed on the deadline: the only remaining transition is finalizeFailed.
    await submit(() => c.governance.finalizeFailed(id), "finalizeFailed");
    ok("proposal finalized as FAILED", "no implementation is owed");
    check("dividends are not suspended by a failed proposal", !(await c.governance.isSuspending(id)), "");
    state.done.C_resolved = true; save();
    return;
  }

  check("proposal passed on the vote, not on the clock", st >= PASSED, `state=${st}`);

  if (st === PASSED) {
    check("a passed, unresolved proposal suspends dividends", await c.governance.isSuspending(id), "");
    await submit(
      () => c.governance.markImplemented(id, ethers.id("gamma-evidence-1"), "ipfs://e2e-evidence"),
      "markImplemented"
    );
    st = Number(await c.governance.state(id));
    ok("controller marked the change implemented", "round 1");
  }

  if (st === IMPLEMENTED) {
    const required = await c.governance.requiredVerificationPower(id);
    const mine = await c.governance.originalYesWeight(id, ctx.deployer.address);
    check("verification power comes from the ORIGINAL yes weight", mine > 0n, `${ethers.formatUnits(mine, 18)} AIC`);
    await submit(() => c.governance.confirmImplementation(id), "confirmImplementation");
    ok("implementation confirmed", `required ${ethers.formatUnits(required, 18)} AIC`);
  }

  const final = Number(await c.governance.state(id));
  check("proposal reached ImplementationVerified", final === VERIFIED, `state=${final}`);
  check("resolution lifted the dividend suspension", !(await c.governance.isSuspending(id)), "");
  check("isResolved agrees", await c.governance.isResolved(id), "");

  // The YES escrow must be releasable once the proposal can no longer be affected by it.
  try {
    await submit(() => c.governance.releaseVoteLock(id, ctx.deployer.address), "releaseVoteLock");
    ok("vote escrow released", "permissionless");
  } catch (e) {
    ok("vote escrow already released", "");
  }

  state.done.C_resolved = true; save();
}

/* -------------------------------------------------- C: the dividend root */

/**
 * Build and propose the claim dataset, then finalize and claim it once the challenge window has
 * elapsed. This is the one place in scenario C that genuinely needs wall-clock time -- six hours
 * of it -- so it is split across runs by `state.pending.finalizeRootAfter`.
 */
async function driveDividendRoot(ctx, rec, c) {
  const epochId = state.epochId;
  const OPEN = 0, ROOT_PROPOSED = 1, FINALIZED = 2;
  const e = await c.distributor.epoch(epochId);

  if (Number(e.state) === OPEN) {
    /*
     * The deployer holds every eligible AIC in this store, so the dataset is a single leaf.
     * That is not a simplification of the encoding: the leaf and the denominator are computed
     * exactly as the backend generator computes them, which is what makes a successful on-chain
     * claim evidence that the two agree.
     */
    if (!(await c.distributor.isRootProposer(ctx.deployer.address))) {
      await submit(() => c.distributor.setRootProposer(ctx.deployer.address, true), "setRootProposer");
      ok("deployer authorised as a root proposer", "registry admin");
    }

    const from = Number(e.windowStartBlock);
    const to = Number(e.snapshotBlock);
    const minBalance = await c.aic.minBalanceInWindow(ctx.deployer.address, from, to);
    check("minimum balance over the holding window is non-zero", minBalance > 0n,
      `${ethers.formatUnits(minBalance, 18)} AIC over blocks ${from}..${to}`);

    const eligibleMinSupply = minBalance;
    const claimable = e.claimableUSDC;
    const amount = (claimable * minBalance) / eligibleMinSupply;
    check("entitlement is the whole claimable amount for a sole holder",
      amount === claimable, `${ethers.formatUnits(amount, 6)} USDC`);

    /*
     * One leaf, so the tree root IS the leaf and the proof is empty. OpenZeppelin's MerkleProof
     * accepts that, and it is the honest encoding of a single-holder dataset rather than a
     * special case bolted on for the test.
     */
    const root = await c.distributor.leafHash(epochId, 0, ctx.deployer.address, amount, []);
    const datasetHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "uint256", "uint256"],
        [epochId, ctx.deployer.address, amount, eligibleMinSupply]
      )
    );

    await submit(
      () => c.distributor.proposeRoot(epochId, root, datasetHash, amount, eligibleMinSupply),
      "proposeRoot"
    );
    state.claim = { index: 0, account: ctx.deployer.address, amount: amount.toString(), root };
    save();
    ok("root proposed", `${ethers.formatUnits(amount, 6)} USDC to 1 holder`);
  } else {
    ok("root already proposed", `revision ${e.rootRevision}`);
  }

  const after = await c.distributor.epoch(epochId);
  const CHALLENGE = 6 * 3600;
  const chainNow = (await ethers.provider.getBlock("latest")).timestamp;
  const readyAt = Number(after.rootProposedAt) + CHALLENGE;

  if (Number(after.state) === ROOT_PROPOSED && chainNow < readyAt) {
    /*
     * Measured from rootProposedAt, not from the epoch opening. The state file previously had it
     * wrong, which would have sent the next run at the window before it opened.
     */
    state.pending = { finalizeRootAfter: new Date(readyAt * 1000).toISOString() };
    save();
    log(`\n   One clock left (a real chain cannot be fast-forwarded):`);
    log(`     root finalizable in  ${Math.ceil((readyAt - chainNow) / 60)} min   (ROOT_CHALLENGE_PERIOD = 6h)`);
    log(`   Re-run this script after ${state.pending.finalizeRootAfter} to complete it.`);
    return;
  }

  if (Number(after.state) === ROOT_PROPOSED) {
    await submit(() => c.distributor.finalizeRoot(epochId), "finalizeRoot");
    ok("root finalized", "permissionless, root now immutable");
  }

  const done = await c.distributor.epoch(epochId);
  check("epoch is Finalized", Number(done.state) === FINALIZED, `state=${done.state}`);

  if (!state.done.C_claimed) {
    const amount = BigInt(state.claim.amount);
    const before = await ctx.usdc.balanceOf(ctx.deployer.address);
    await submit(
      () => c.distributor.claim(epochId, state.claim.index, state.claim.account, amount, [], []),
      "claim"
    );
    const gained = (await ctx.usdc.balanceOf(ctx.deployer.address)) - before;
    check("claim paid the entitlement in USDC", gained === amount, `${ethers.formatUnits(gained, 6)} USDC`);
    state.done.C_claimed = true; save();
  }

  // A second claim of the same leaf must revert. Double-spend is the failure that matters here.
  let doubleSpent = false;
  try {
    await c.distributor.claim.staticCall(
      epochId, state.claim.index, state.claim.account, BigInt(state.claim.amount), [], []
    );
    doubleSpent = true;
  } catch { /* expected */ }
  check("the same leaf cannot be claimed twice", !doubleSpent, "");

  delete state.pending;
  save();
}

/* ------------------------------------------------------------- utilities */

async function driveToGraduation(ctx, aicToken, maxRounds, expectBlocked = false) {
  const shop = await ctx.agentGoods.getAddress();
  for (let i = 0; i < maxRounds; i++) {
    const m = await ctx.agentGoods.market(aicToken);
    if (Number(m.phase) === Phase.ExternalDex) return true;
    if (m.graduationBlocked) return true;
    const chunk = USDC(800);
    await submit(() => ctx.usdc.mint(ctx.deployer.address, chunk), "mint");
    await approveSettled(ctx.usdc, shop, chunk, "USDC allowance");
    const dl = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    const rc = await submit(() => ctx.agentGoods.buy(aicToken, chunk, 0, dl), "buy");
    /*
     * Decide from the RECEIPT, not from a follow-up read.
     *
     * The loop previously re-read `market().phase` each round, and a lagging node reported the
     * market as still on the curve AFTER it had graduated — so the loop kept buying into a closed
     * curve and every one of those buys reverted with WrongPhase(3). The receipt of the
     * transaction that caused the change cannot be stale: it either contains the event or it does
     * not.
     */
    for (const l of rc.logs) {
      let ev = null;
      try { ev = ctx.agentGoods.interface.parseLog(l); } catch { /* not ours */ }
      if (!ev) continue;
      if (ev.name === "LiquidityTransition") {
        log(`      graduated: pair ${ev.args.pair}`);
        return true;
      }
      if (ev.name === "GraduationBlocked") {
        log(`      graduation blocked by pool ${ev.args.blockingPair}`);
        return true;
      }
    }
    if (i % 5 === 0) {
      const pct = Number(m.netSoldFromCurve * 10000n / AIC(1_000_000_000)) / 100;
      process.stdout.write(`      ${pct.toFixed(1)}% sold…\n`);
    }
  }
  throw new Error(`did not reach ${expectBlocked ? "the block" : "graduation"} within ${maxRounds} rounds`);
}

function report() {
  log(`\n${"=".repeat(74)}`);
  if (state.failures.length === 0) {
    log(`E2E RESULT: every immediate check PASSED`);
  } else {
    log(`E2E RESULT: ${state.failures.length} FAILURE(S)`);
    for (const f of state.failures) log(`   - ${f}`);
  }
  if (state.pending) {
    log(`\nStill pending (wall clock):`);
    log(`   resolve proposal after  ${state.pending.resolveProposalAfter}`);
    log(`   finalize root after     ${state.pending.finalizeRootAfter}`);
  }
  log(`\nState: ${stateFile}`);
  log(`${"=".repeat(74)}\n`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(state && state.failures.length ? 1 : 0))
    .catch((e) => {
      if (state) { save(); }
      console.error(`\n${e.stack || e.message || e}\n`);
      process.exit(1);
    });
}
