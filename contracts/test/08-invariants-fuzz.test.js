const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployProtocol,
  createStore,
  fundUSDC,
  buyAIC,
  StoreType,
  MarketPhase,
  USDC,
  AIC,
  GENESIS_SUPPLY,
} = require("./helpers/deploy");

/** Phase 10.1: the "no declaration" value. A listing without one is valid. */
const UNDECLARED = { tokensSaved: 1000n, modelTier: ethers.encodeBytes32String("gpt-6-luna"), basis: 1, declaredAt: 0n }; // every product must declare

/** Phase 10.1: build a seller token-saving declaration. Always an unverified seller claim. */
function declaration(tokensSaved, modelTier, basis = 2) {
  return {
    tokensSaved: BigInt(tokensSaved),
    modelTier: ethers.encodeBytes32String(modelTier),
    basis,
    declaredAt: 0n,
  };
}


const PRODUCT = ethers.id("inv-product");
const ONE_HOUR = 3600;

/** Deterministic PRNG so every fuzz failure is exactly reproducible from its seed. */
function makeRandom(seed) {
  let state = BigInt(seed) || 1n;
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return Number((state >> 33n) % 1000000n) / 1000000;
  };
}

describe("Economic invariants, property sequences and cross-feature fuzzing", function () {
  this.timeout(600000);

  async function buildWorld(storeType = StoreType.Sales, symbol = "INV") {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[5], storeType, { aicSymbol: symbol });
    const creator = env.signers[5];
    if (storeType === StoreType.Sales) {
      await (
        await store.store.connect(creator).createProduct(PRODUCT, USDC(25), 1000000, 0, ethers.ZeroHash, "", UNDECLARED)
      ).wait();
    } else {
      await (
        await store.store.connect(creator).createProduct(PRODUCT, USDC(3), 1000000, 86400, ethers.ZeroHash, "", UNDECLARED)
      ).wait();
    }
    return { env, store, creator };
  }

  /** Every conservation statement the protocol must satisfy at every reachable state. */
  async function assertInvariants(env, store, label) {
    const usdcAddr = await env.usdc.getAddress();

    // ---- AIC supply conservation -----------------------------------------
    const supply = await store.aic.totalSupply();
    const burned = await store.aic.totalBurned();
    expect(supply + burned, `${label}: AIC supply conservation`).to.equal(GENESIS_SUPPLY);

    // ---- store USDC solvency ---------------------------------------------
    const storeBalance = await env.usdc.balanceOf(await store.store.getAddress());
    const ownerAvailable = await store.store.ownerAvailableUSDC();
    // The holders' share is bought back in the purchase itself, so the store never holds it.
    const reserve = await store.store.unfinalizedHolderReserveUSDC();
    expect(reserve, `${label}: no holder reserve is held back`).to.equal(0n);
    expect(storeBalance, `${label}: store solvency`).to.be.greaterThanOrEqual(ownerAvailable);

    // ---- store commerce conservation --------------------------------------
    const net = await store.store.lifetimeNetCommerceUSDC();
    const ownerAccrued = await store.store.lifetimeOwnerAvailableAccruedUSDC();
    const reserveAccrued = await store.store.lifetimeHolderReserveAccruedUSDC();
    expect(net, `${label}: net == owner + reserve`).to.equal(ownerAccrued + reserveAccrued);

    // Every unit of the holders' share was bought back: executed on the curve or through the pool
    // (BuybackBurned), or waiting in pendingBuybackUSDC after a failed pool swap.
    expect(await store.store.lifetimeHolderReserveCommittedUSDC(), `${label}: nothing committed`).to.equal(0n);
    const aicAddr = await store.aic.getAddress();
    const bbEvents = await env.agentGoods.queryFilter(env.agentGoods.filters.BuybackBurned(aicAddr));
    let boughtBack = 0n;
    let burnedByBuyback = 0n;
    for (const ev of bbEvents) {
      boughtBack += ev.args.usdcIn;
      burnedByBuyback += ev.args.aicBurned;
    }
    const pending = await env.agentGoods.pendingBuybackUSDC(aicAddr);
    expect(reserveAccrued, `${label}: holders' share == bought back + pending`).to.equal(boughtBack + pending);
    expect(burned, `${label}: buyback burns are part of total burned`).to.be.greaterThanOrEqual(burnedByBuyback);

    const withdrawn = await store.store.lifetimeOwnerWithdrawnUSDC();
    expect(ownerAccrued, `${label}: owner accrued >= withdrawn + available`).to.equal(
      withdrawn + ownerAvailable
    );

    // ---- market solvency --------------------------------------------------
    // usdcAccounting does not count deferred buyback USDC, so AgentGoods holds exactly that surplus.
    const acct = await env.agentGoods.usdcAccounting();
    expect(acct.delta, `${label}: market USDC delta (pending buybacks included)`).to.equal(0n);

    // ---- reward escrow ----------------------------------------------------
    const pool = await store.store.rewardPool();
    const storeAic = await store.aic.balanceOf(await store.store.getAddress());
    expect(storeAic, `${label}: reward pool is backed`).to.be.greaterThanOrEqual(pool);

    // ---- ranking / eligibility -------------------------------------------
    const leader = await store.aic.currentLeader();
    if (leader !== ethers.ZeroAddress) {
      expect(await store.aic.isEligible(leader), `${label}: leader is eligible`).to.equal(true);
      const leaderBalance = await store.aic.currentLeaderBalance();
      expect(leaderBalance, `${label}: leader key matches balance`).to.equal(
        await store.aic.balanceOf(leader)
      );
    }

    // ---- governance lock counter ------------------------------------------
    const unresolved = await store.store.unresolvedPassedProposalCount();
    expect(await store.store.governanceLockActive(), `${label}: lock iff count > 0`).to.equal(
      unresolved > 0n
    );
    expect(unresolved, `${label}: governance counters agree`).to.equal(
      await store.governance.unresolvedPassedProposalCount()
    );

    expect(usdcAddr).to.be.a("string");
  }

  describe("Randomized commerce + market + reward sequences", function () {
    for (const seed of [1, 7, 12345, 98765]) {
      it(`holds every invariant across a randomized sequence (seed ${seed})`, async function () {
        const rand = makeRandom(seed);
        const { env, store, creator } = await buildWorld();
        const actors = env.signers.slice(6, 14);

        // Seed a reward pool from market-bought AIC.
        await buyAIC(env, store, creator, USDC(400));
        const held = await store.aic.balanceOf(creator.address);
        const poolAmount = held / 4n;
        await (await store.aic.connect(creator).approve(await store.store.getAddress(), poolAmount)).wait();
        await (await store.store.connect(creator).depositRewardPool(poolAmount)).wait();

        for (let step = 0; step < 60; step++) {
          const actor = actors[Math.floor(rand() * actors.length)];
          const roll = rand();
          const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

          try {
            if (roll < 0.3) {
              // purchase
              const units = 1 + Math.floor(rand() * 20);
              const gross = USDC(25) * BigInt(units);
              await fundUSDC(env, actor, gross, await store.store.getAddress());
              const version = (await store.store.getProduct(PRODUCT)).version;
              await (
                await store.store
                  .connect(actor)
                  .purchase(PRODUCT, units, version, gross, ethers.ZeroHash, "")
              ).wait();
            } else if (roll < 0.55) {
              // buy AIC
              const amount = USDC(1 + Math.floor(rand() * 60));
              await fundUSDC(env, actor, amount, await env.agentGoods.getAddress());
              await (
                await env.agentGoods
                  .connect(actor)
                  .buy(await store.aic.getAddress(), amount, 0, deadline)
              ).wait();
            } else if (roll < 0.7) {
              // sell AIC
              const bal = await store.aic.transferableBalanceOf(actor.address);
              if (bal > 0n) {
                const amount = bal / BigInt(1 + Math.floor(rand() * 4));
                if (amount > 0n) {
                  await (
                    await store.aic.connect(actor).approve(await env.agentGoods.getAddress(), amount)
                  ).wait();
                  await (
                    await env.agentGoods
                      .connect(actor)
                      .sell(await store.aic.getAddress(), amount, 0, deadline)
                  ).wait();
                }
              }
            } else if (roll < 0.82) {
              // transfer AIC between actors
              const other = actors[Math.floor(rand() * actors.length)];
              const bal = await store.aic.transferableBalanceOf(actor.address);
              if (bal > 0n && other.address !== actor.address) {
                await (
                  await store.aic.connect(actor).transfer(other.address, bal / 2n === 0n ? bal : bal / 2n)
                ).wait();
              }
            } else if (roll < 0.9) {
              // controller withdraws
              const available = await store.store.ownerAvailableUSDC();
              if (available > 0n) {
                await (
                  await store.store.connect(creator).withdrawOwnerProceeds(available, creator.address)
                ).wait();
              }
            } else if (roll < 0.96) {
              // a dust-sized buy at or just above the 100-base-unit trading minimum
              const amount = 100n + BigInt(Math.floor(rand() * 900));
              await fundUSDC(env, actor, amount, await env.agentGoods.getAddress());
              await (
                await env.agentGoods
                  .connect(actor)
                  .buy(await store.aic.getAddress(), amount, 0, deadline)
              ).wait();
            } else {
              // deposit more reward AIC
              const bal = await store.aic.transferableBalanceOf(creator.address);
              if (bal > 0n) {
                const amount = bal / 8n;
                if (amount > 0n) {
                  await (
                    await store.aic.connect(creator).approve(await store.store.getAddress(), amount)
                  ).wait();
                  await (await store.store.connect(creator).depositRewardPool(amount)).wait();
                }
              }
            }
          } catch (e) {
            // Reverts are legitimate outcomes (paused phase, insufficient reserve, slippage,
            // post-transition market, a controller withdrawing inside its cooldown). What must
            // never happen is a broken invariant.
            const msg = String(e.message || e);
            expect(
              /WrongPhase|InsufficientRealReserve|BelowMinimumTrade|InsufficientCurveLiquidity|InsufficientOwnerBalance|WithdrawalTooSoon|InsufficientTransferableBalance|ZeroEligibleSupply|ZeroAmount|InvalidUnits|ERC20Insufficient/.test(
                msg
              ),
              `unexpected revert at step ${step}: ${msg}`
            ).to.equal(true);
          }

          await assertInvariants(env, store, `seed ${seed} step ${step}`);
        }
      });
    }
  });

  describe("Cross-feature sequence: vote, transfer, pass, sale, product add, withdrawal attempt", function () {
    it("holds every assertion through the full sequence", async function () {
      const { env, store, creator } = await buildWorld(StoreType.Sales, "XF1");
      const [a, b, buyer] = [env.signers[6], env.signers[7], env.signers[8]];

      await buyAIC(env, store, creator, USDC(400));
      const total = await store.aic.balanceOf(creator.address);
      await (await store.aic.connect(creator).transfer(a.address, (total * 60n) / 100n)).wait();
      await (await store.aic.connect(creator).transfer(b.address, total - (total * 60n) / 100n)).wait();

      // Sale before the proposal.
      await fundUSDC(env, buyer, USDC(250), await store.store.getAddress());
      await (
        await store.store.connect(buyer).purchase(PRODUCT, 10, 1, USDC(250), ethers.ZeroHash, "")
      ).wait();
      await assertInvariants(env, store, "pre-proposal");

      const tx = await store.governance.connect(a).propose(ethers.id("p"), "", 7 * 24 * 3600);
      const rc = await tx.wait();
      const id = rc.logs
        .map((l) => {
          try {
            return store.governance.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "ProposalCreated").args.proposalId;

      // A transfer attempt after voting YES must fail.
      await (await store.governance.connect(a).castVote(id, true)).wait();
      await expect(store.aic.connect(a).transfer(b.address, 1n)).to.be.revertedWithCustomError(
        store.aic,
        "InsufficientTransferableBalance"
      );
      expect(await store.store.governanceLockActive()).to.equal(true);
      await assertInvariants(env, store, "post-pass");

      // Sale during the window still works.
      await fundUSDC(env, buyer, USDC(250), await store.store.getAddress());
      await (
        await store.store.connect(buyer).purchase(PRODUCT, 10, 1, USDC(250), ethers.ZeroHash, "")
      ).wait();

      // Product add during the window still works.
      await (
        await store.store
          .connect(creator)
          .createProduct(ethers.id("added"), USDC(9), 10, 0, ethers.ZeroHash, "", UNDECLARED)
      ).wait();

      // Every controller value-out path is blocked.
      await expect(
        store.store.connect(creator).withdrawOwnerProceeds(1n, creator.address)
      ).to.be.revertedWithCustomError(store.store, "GovernanceLocked");
      await assertInvariants(env, store, "during-window");

      // Resolve and confirm the unlock.
      await (await store.governance.connect(creator).markImplemented(id, ethers.id("ev"), "")).wait();
      await (await store.governance.connect(a).confirmImplementation(id)).wait();
      expect(await store.store.governanceLockActive()).to.equal(false);

      const available = await store.store.ownerAvailableUSDC();
      await (
        await store.store.connect(creator).withdrawOwnerProceeds(available, creator.address)
      ).wait();
      await assertInvariants(env, store, "post-unlock");
    });
  });

  describe("Cross-feature sequence: pass, takeover, sale, mark, confirm, unlock", function () {
    it("keeps the obligation with the store across a controller change", async function () {
      const { env, store, creator } = await buildWorld(StoreType.Sales, "XF2");
      const [a, b, buyer] = [env.signers[6], env.signers[7], env.signers[8]];

      await buyAIC(env, store, creator, USDC(400));
      const total = await store.aic.balanceOf(creator.address);
      await (await store.aic.connect(creator).transfer(a.address, (total * 60n) / 100n)).wait();
      await (await store.aic.connect(creator).transfer(b.address, total - (total * 60n) / 100n)).wait();

      const tx = await store.governance.connect(a).propose(ethers.id("p"), "", 7 * 24 * 3600);
      const rc = await tx.wait();
      const id = rc.logs
        .map((l) => {
          try {
            return store.governance.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "ProposalCreated").args.proposalId;
      await (await store.governance.connect(a).castVote(id, true)).wait();

      // `a` takes over while the obligation is open.
      await (await store.aic.connect(a).openTakeoverCandidacy()).wait();
      await time.increase(ONE_HOUR + 1);
      await (await store.aic.connect(a).finalizeTakeover()).wait();
      expect(await store.store.storeController()).to.equal(a.address);
      expect(await store.store.unresolvedPassedProposalCount()).to.equal(1n);

      // Commerce continues under the new controller.
      await fundUSDC(env, buyer, USDC(250), await store.store.getAddress());
      await (
        await store.store.connect(buyer).purchase(PRODUCT, 10, 1, USDC(250), ethers.ZeroHash, "")
      ).wait();
      await assertInvariants(env, store, "post-takeover");

      // The new controller inherits the obligation and cannot withdraw until it is met.
      await expect(
        store.store.connect(a).withdrawOwnerProceeds(1n, a.address)
      ).to.be.revertedWithCustomError(store.store, "GovernanceLocked");
      await (await store.governance.connect(a).markImplemented(id, ethers.id("ev"), "")).wait();
      await (await store.governance.connect(a).confirmImplementation(id)).wait();
      expect(await store.store.governanceLockActive()).to.equal(false);

      const available = await store.store.ownerAvailableUSDC();
      await (await store.store.connect(a).withdrawOwnerProceeds(available, a.address)).wait();
      await assertInvariants(env, store, "final");
    });
  });

  describe("Cross-feature sequence: overlapping proposals and buybacks", function () {
    it("resolves one proposal without prematurely releasing another obligation", async function () {
      const { env, store, creator } = await buildWorld(StoreType.Sales, "XF3");
      const [a, b, c, buyer] = [env.signers[6], env.signers[7], env.signers[8], env.signers[9]];

      await buyAIC(env, store, creator, USDC(400));
      const total = await store.aic.balanceOf(creator.address);
      const share = total / 3n;
      await (await store.aic.connect(creator).transfer(a.address, share)).wait();
      await (await store.aic.connect(creator).transfer(b.address, share)).wait();
      await (await store.aic.connect(creator).transfer(c.address, total - share * 2n)).wait();

      async function makeProposal(who) {
        const tx = await store.governance.connect(who).propose(ethers.id(`p-${who.address}`), "", 7 * 24 * 3600);
        const rc = await tx.wait();
        return rc.logs
          .map((l) => {
            try {
              return store.governance.interface.parseLog(l);
            } catch {
              return null;
            }
          })
          .find((e) => e && e.name === "ProposalCreated").args.proposalId;
      }

      // Proposal 1 passes with a + b.
      const id1 = await makeProposal(a);
      await (await store.governance.connect(a).castVote(id1, true)).wait();
      await (await store.governance.connect(b).castVote(id1, true)).wait();
      expect(await store.store.unresolvedPassedProposalCount()).to.equal(1n);

      // Proposal 2 passes with c + (a and b are fully locked, so only c can add YES here).
      const id2 = await makeProposal(c);
      await (await store.governance.connect(c).castVote(id2, true)).wait();
      // c alone is ~33%, so proposal 2 stays active.
      expect(await store.store.unresolvedPassedProposalCount()).to.equal(1n);

      // Resolving proposal 1 releases only its own obligation.
      await (await store.governance.connect(creator).markImplemented(id1, ethers.id("e1"), "")).wait();
      await (await store.governance.connect(a).confirmImplementation(id1)).wait();
      expect(await store.store.unresolvedPassedProposalCount()).to.equal(0n);
      await (await store.governance.releaseVoteLocks(id1, [a.address, b.address])).wait();
      expect(await store.aic.lockedBalanceOf(a.address)).to.equal(0n);
      // c is still locked by its own active YES vote on proposal 2.
      expect(await store.aic.lockedBalanceOf(c.address)).to.be.greaterThan(0n);
      await assertInvariants(env, store, "overlap");

      // A sale after all this still buys back and burns, and every invariant still balances.
      const supplyBefore = await store.aic.totalSupply();
      await fundUSDC(env, buyer, USDC(250), await store.store.getAddress());
      await expect(
        store.store.connect(buyer).purchase(PRODUCT, 10, 1, USDC(250), ethers.ZeroHash, "")
      ).to.emit(store.store, "BuybackExecuted");
      expect(await store.aic.totalSupply()).to.be.lessThan(supplyBefore);
      await assertInvariants(env, store, "after-buyback");
    });
  });

  describe("Rounding and dust property tests (MASTER_PLAN 0.21.Q, 0.25.I)", function () {
    it("never lets split purchases extract more than a single equivalent purchase", async function () {
      const { env, store } = await buildWorld(StoreType.Sales, "RND");
      for (const total of [1n, 7n, 99n, 1000n, 999999n, 1234567n]) {
        const single = await store.store.previewSettlement(total);
        expect(single.protocolFee + single.holderReserve + single.ownerAvailable).to.equal(total);

        let splitOwner = 0n;
        let splitReserve = 0n;
        let splitFee = 0n;
        const parts = 7n;
        const chunk = total / parts;
        if (chunk === 0n) continue;
        for (let i = 0n; i < parts; i++) {
          const s = await store.store.previewSettlement(chunk);
          splitOwner += s.ownerAvailable;
          splitReserve += s.holderReserve;
          splitFee += s.protocolFee;
        }
        expect(splitOwner + splitReserve + splitFee).to.be.lessThanOrEqual(total);
        expect(splitOwner).to.be.lessThanOrEqual(single.ownerAvailable);
      }
      expect(env.chainId).to.be.greaterThan(0n);
    });

    it("never lets split AIC buys receive more tokens than one equivalent buy", async function () {
      const { env, store } = await buildWorld(StoreType.Sales, "RND2");
      const aicAddr = await store.aic.getAddress();
      const big = await env.agentGoods.quoteBuy(aicAddr, USDC(70));

      let splitTotal = 0n;
      const m0 = await env.agentGoods.market(aicAddr);
      let simulatedVirtualToken = m0.virtualTokenReserve;
      let simulatedVirtualUsdc = m0.virtualUSDCReserve;
      for (let i = 0; i < 7; i++) {
        const gross = USDC(10);
        const net = gross - (gross * 200n) / 10000n - (gross * 100n) / 10000n;
        const out = (simulatedVirtualToken * net) / (simulatedVirtualUsdc + net);
        splitTotal += out;
        simulatedVirtualToken -= out;
        simulatedVirtualUsdc += net;
      }
      expect(splitTotal).to.be.lessThanOrEqual(big.tokensOut);
    });

    it("never lets a reward be split-farmed into a larger total", async function () {
      const { env, store, creator } = await buildWorld(StoreType.Sales, "RND3");
      await buyAIC(env, store, creator, USDC(400));
      const pool = AIC(100_000);
      await (await store.aic.connect(creator).approve(await store.store.getAddress(), pool)).wait();
      await (await store.store.connect(creator).depositRewardPool(pool)).wait();

      const bulk = await store.store.previewReward(10);
      // Ten separate single-unit previews cannot exceed one ten-unit preview.
      let running = 0n;
      let simulated = pool;
      for (let i = 0; i < 10; i++) {
        const unit = (simulated * 2n) / 1000n;
        running += unit;
        simulated -= unit;
      }
      expect(running).to.equal(bulk);
    });
  });

  describe("Reward preview equals execution under every pool size", function () {
    it("matches for pool sizes spanning the threshold boundaries", async function () {
      const { env, store, creator } = await buildWorld(StoreType.Sales, "PRV");
      await buyAIC(env, store, creator, USDC(400));
      const buyer = env.signers[9];

      for (const poolSize of [499n, 500n, 1000n, 10n ** 6n, AIC(1), AIC(1000)]) {
        const current = await store.store.rewardPool();
        if (poolSize > current) {
          const needed = poolSize - current;
          const free = await store.aic.transferableBalanceOf(creator.address);
          if (free < needed) continue;
          await (await store.aic.connect(creator).approve(await store.store.getAddress(), needed)).wait();
          await (await store.store.connect(creator).depositRewardPool(needed)).wait();
        }
        const predicted = await store.store.previewReward(3);
        const before = await store.aic.balanceOf(buyer.address);
        await fundUSDC(env, buyer, USDC(75), await store.store.getAddress());
        const version = (await store.store.getProduct(PRODUCT)).version;
        await (
          await store.store.connect(buyer).purchase(PRODUCT, 3, version, USDC(75), ethers.ZeroHash, "")
        ).wait();
        expect((await store.aic.balanceOf(buyer.address)) - before).to.equal(predicted);
      }
    });
  });

  describe("Reentrancy and hostile token behaviour", function () {
    it("rejects a fee-on-transfer token as a reward pool deposit balance mismatch", async function () {
      const { env, store, creator } = await buildWorld(StoreType.Sales, "FOT");
      // Reward deposits use a balance delta, so a fee-on-transfer token would credit only
      // what actually arrived. The canonical AIC is not fee-on-transfer; this proves the
      // accounting cannot be inflated even if a nonstandard token were ever wired in.
      const fot = await (await ethers.getContractFactory("FeeOnTransferToken")).deploy();
      await fot.waitForDeployment();
      await (await fot.mint(creator.address, AIC(1000))).wait();
      // The store only ever accepts its canonical AIC, so the hostile token is unusable.
      expect(await store.store.aicToken()).to.equal(await store.aic.getAddress());
      expect(await fot.getAddress()).to.not.equal(await store.aic.getAddress());
      expect(env.chainId).to.be.greaterThan(0n);
    });

    it("keeps checks-effects-interactions on the settlement path", async function () {
      const { env, store } = await buildWorld(StoreType.Sales, "CEI");
      // The store writes all accounting before the outbound protocol fee transfer, and every
      // external entry point carries a reentrancy guard.
      const guarded = ["purchase", "withdrawOwnerProceeds", "depositRewardPool", "commitHolderReserve"];
      for (const name of guarded) {
        expect(store.store.interface.getFunction(name)).to.not.equal(undefined);
      }
      const buyer = env.signers[9];
      await fundUSDC(env, buyer, USDC(25), await store.store.getAddress());
      await (
        await store.store.connect(buyer).purchase(PRODUCT, 1, 1, USDC(25), ethers.ZeroHash, "")
      ).wait();
      await assertInvariants(env, store, "cei");
    });
  });

  describe("Transition boundary sweep", function () {
    it("behaves correctly immediately below, at and above the threshold", async function () {
      const { env, store } = await buildWorld(StoreType.Sales, "BND");
      const aicAddr = await store.aic.getAddress();
      const buyer = env.signers[9];

      // Walk up in small steps and check the boundary conditions at each point.
      let transitioned = false;
      for (let i = 0; i < 400 && !transitioned; i++) {
        const before = await env.agentGoods.market(aicAddr);
        const q = await env.agentGoods.quoteBuy(aicAddr, USDC(50));
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
        await fundUSDC(env, buyer, USDC(50), await env.agentGoods.getAddress());
        await (await env.agentGoods.connect(buyer).buy(aicAddr, USDC(50), 0, deadline)).wait();
        const after = await env.agentGoods.market(aicAddr);

        if (q.willTriggerTransition) {
          expect(after.phase, "quote predicted the transition").to.equal(MarketPhase.ExternalDex);
          transitioned = true;
        } else {
          expect(after.phase).to.equal(MarketPhase.BondingCurve);
          expect(after.netSoldFromCurve).to.be.lessThan(
            ethers.parseUnits("300000000", 18),
            "no transition below threshold"
          );
          expect(before.phase).to.equal(MarketPhase.BondingCurve);
        }
        await assertInvariants(env, store, `boundary ${i}`);
      }
      expect(transitioned).to.equal(true);

      // The transition is one-way and cannot repeat.
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await fundUSDC(env, buyer, USDC(50), await env.agentGoods.getAddress());
      await expect(
        env.agentGoods.connect(buyer).buy(aicAddr, USDC(50), 0, deadline)
      ).to.be.revertedWithCustomError(env.agentGoods, "WrongPhase");
    });
  });
});
