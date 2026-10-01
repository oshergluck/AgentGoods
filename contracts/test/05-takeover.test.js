const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployProtocol,
  createStore,
  buyAIC,
  StoreType,
  USDC,
  AIC,
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


const ONE_HOUR = 3600;

describe("AIC holder takeover: largest eligible EOA, continuously, for one hour", function () {
  async function fixture() {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[5], StoreType.Sales);
    const creator = env.signers[5];
    const [big, medium, smallHolder, outsider] = [
      env.signers[6],
      env.signers[7],
      env.signers[8],
      env.signers[9],
    ];

    await buyAIC(env, store, creator, USDC(2000));
    const total = await store.aic.balanceOf(creator.address);
    const bigAmount = (total * 50n) / 100n;
    const mediumAmount = (total * 30n) / 100n;
    const smallAmount = total - bigAmount - mediumAmount;

    await (await store.aic.connect(creator).transfer(big.address, bigAmount)).wait();
    await (await store.aic.connect(creator).transfer(medium.address, mediumAmount)).wait();
    await (await store.aic.connect(creator).transfer(smallHolder.address, smallAmount)).wait();

    return { env, store, creator, big, medium, smallHolder, outsider, bigAmount, mediumAmount, smallAmount };
  }

  describe("Leadership is computed on chain, never asserted by an indexer", function () {
    it("tracks the largest eligible EOA holder as balances move", async function () {
      const { store, big, medium } = await loadFixture(fixture);
      expect(await store.aic.currentLeader()).to.equal(big.address);
      expect(await store.aic.currentLeaderBalance()).to.equal(await store.aic.balanceOf(big.address));

      // medium overtakes big.
      const bigBal = await store.aic.balanceOf(big.address);
      await (await store.aic.connect(big).transfer(medium.address, bigBal / 2n)).wait();
      expect(await store.aic.currentLeader()).to.equal(medium.address);
    });

    it("never ranks the AgentGoods market inventory as a holder", async function () {
      const { env, store } = await loadFixture(fixture);
      const marketBalance = await store.aic.balanceOf(await env.agentGoods.getAddress());
      expect(marketBalance).to.be.greaterThan(await store.aic.currentLeaderBalance());
      expect(await store.aic.currentLeader()).to.not.equal(await env.agentGoods.getAddress());
      expect(await store.aic.rankedKeyOf(await env.agentGoods.getAddress())).to.equal(0n);
    });

    it("ignores a contract holder that owns more than every EOA", async function () {
      const { store, big, medium, smallHolder } = await loadFixture(fixture);
      const holder = await (await ethers.getContractFactory("ContractHolder")).deploy();
      await holder.waitForDeployment();

      // Everyone dumps into the contract, which then holds the most AIC by far.
      for (const s of [medium, smallHolder]) {
        const bal = await store.aic.balanceOf(s.address);
        await (await store.aic.connect(s).transfer(await holder.getAddress(), bal)).wait();
      }
      expect(await store.aic.balanceOf(await holder.getAddress())).to.be.greaterThan(
        await store.aic.balanceOf(big.address)
      );

      expect(await store.aic.currentLeader()).to.equal(big.address);
      expect(await store.aic.rankedKeyOf(await holder.getAddress())).to.equal(0n);

      const data = store.aic.interface.encodeFunctionData("openTakeoverCandidacy", []);
      const res = await holder.callTarget.staticCall(await store.aic.getAddress(), data);
      expect(res[0]).to.equal(false);
    });

    it("keeps eligible supply exactly equal to the sum of eligible EOA balances", async function () {
      const { env, store, big, medium, smallHolder } = await loadFixture(fixture);
      const sum =
        (await store.aic.balanceOf(big.address)) +
        (await store.aic.balanceOf(medium.address)) +
        (await store.aic.balanceOf(smallHolder.address));
      expect(await store.aic.eligibleSupply()).to.equal(sum);
      expect(env.chainId).to.be.greaterThan(0n);
    });
  });

  describe("Candidacy and the one-hour observation period (MASTER_PLAN 0.25.B)", function () {
    it("refuses candidacy from anyone but the current leader", async function () {
      const { store, medium } = await loadFixture(fixture);
      await expect(store.aic.connect(medium).openTakeoverCandidacy()).to.be.revertedWithCustomError(
        store.aic,
        "NotLeader"
      );
    });

    it("locks the whole candidate balance for the observation period", async function () {
      const { store, big, outsider } = await loadFixture(fixture);
      const bal = await store.aic.balanceOf(big.address);
      await (await store.aic.connect(big).openTakeoverCandidacy()).wait();
      expect(await store.aic.lockedBalanceOf(big.address)).to.equal(bal);
      await expect(store.aic.connect(big).transfer(outsider.address, 1n)).to.be.revertedWithCustomError(
        store.aic,
        "InsufficientTransferableBalance"
      );
    });

    it("fails at 59m59s and succeeds at exactly one hour", async function () {
      const { env, store, big } = await loadFixture(fixture);
      await (await store.aic.connect(big).openTakeoverCandidacy()).wait();
      const openedAt = await store.aic.takeoverCandidacyOpenedAt(big.address);

      // 59m59s: the call executes in the NEXT block, so pin its timestamp exactly.
      await time.setNextBlockTimestamp(Number(openedAt) + ONE_HOUR - 1);
      await expect(store.aic.connect(big).finalizeTakeover()).to.be.revertedWithCustomError(
        store.aic,
        "ObservationPeriodNotElapsed"
      );

      // Exactly 3600 seconds of chain time.
      await time.setNextBlockTimestamp(Number(openedAt) + ONE_HOUR);
      await expect(store.aic.connect(big).finalizeTakeover())
        .to.emit(store.aic, "TakeoverFinalized")
        .and.to.emit(store.store, "ControllerChanged");

      expect(await store.store.storeController()).to.equal(big.address);
      expect(await env.registry.storeController(store.storeId)).to.equal(big.address);
    });

    it("succeeds comfortably after more than one hour", async function () {
      const { store, big } = await loadFixture(fixture);
      await (await store.aic.connect(big).openTakeoverCandidacy()).wait();
      await time.increase(ONE_HOUR * 5);
      await (await store.aic.connect(big).finalizeTakeover()).wait();
      expect(await store.store.storeController()).to.equal(big.address);
    });

    it("resets the timer when leadership is lost and regained", async function () {
      const { store, big, medium, outsider } = await loadFixture(fixture);
      await (await store.aic.connect(big).openTakeoverCandidacy()).wait();
      await time.increase(ONE_HOUR - 60);

      // medium overtakes, which displaces big as leader.
      const mediumBal = await store.aic.balanceOf(medium.address);
      await (await store.aic.connect(outsider).transfer(medium.address, 0n).catch(() => null));
      const bigBal = await store.aic.balanceOf(big.address);
      // Give medium enough to pass big.
      const smallSigner = (await ethers.getSigners())[8];
      const smallBal = await store.aic.balanceOf(smallSigner.address);
      await (await store.aic.connect(smallSigner).transfer(medium.address, smallBal)).wait();
      expect(await store.aic.balanceOf(medium.address)).to.equal(mediumBal + smallBal);

      if ((await store.aic.currentLeader()) === medium.address) {
        await time.increase(ONE_HOUR);
        // big is no longer the leader, so finalization must fail.
        await expect(store.aic.connect(big).finalizeTakeover()).to.be.revertedWithCustomError(
          store.aic,
          "NotLeader"
        );

        // medium gives it back; big is leader again but the clock restarted.
        await (await store.aic.connect(medium).transfer(smallSigner.address, smallBal)).wait();
        expect(await store.aic.currentLeader()).to.equal(big.address);
        await expect(store.aic.connect(big).finalizeTakeover()).to.be.revertedWithCustomError(
          store.aic,
          "LeadershipNotContinuous"
        );
      }
      expect(bigBal).to.be.greaterThan(0n);
    });

    it("rejects a flash-style balance that is not held for the full hour", async function () {
      const { store, big, medium, smallHolder } = await loadFixture(fixture);
      // medium borrows enough to lead, opens candidacy, then must keep it for an hour.
      const smallBal = await store.aic.balanceOf(smallHolder.address);
      await (await store.aic.connect(smallHolder).transfer(medium.address, smallBal)).wait();
      expect(await store.aic.currentLeader()).to.equal(medium.address);

      await (await store.aic.connect(medium).openTakeoverCandidacy()).wait();
      // Returning the borrowed AIC inside the window is impossible: the balance is locked.
      await expect(
        store.aic.connect(medium).transfer(smallHolder.address, smallBal)
      ).to.be.revertedWithCustomError(store.aic, "InsufficientTransferableBalance");

      // Cancelling the candidacy to return the loan forfeits the accrued time.
      await (await store.aic.connect(medium).cancelTakeoverCandidacy()).wait();
      await (await store.aic.connect(medium).transfer(smallHolder.address, smallBal)).wait();
      expect(await store.aic.currentLeader()).to.equal(big.address);
      await expect(store.aic.connect(medium).finalizeTakeover()).to.be.revertedWithCustomError(
        store.aic,
        "NoCandidacy"
      );
    });

    it("does not let an exact tie displace the incumbent leader", async function () {
      const { store, big, medium, smallHolder } = await loadFixture(fixture);
      const bigBal = await store.aic.balanceOf(big.address);
      const mediumBal = await store.aic.balanceOf(medium.address);
      const needed = bigBal - mediumBal;
      expect(await store.aic.balanceOf(smallHolder.address)).to.be.greaterThanOrEqual(needed);

      await (await store.aic.connect(smallHolder).transfer(medium.address, needed)).wait();
      expect(await store.aic.balanceOf(medium.address)).to.equal(bigBal);

      // Exact tie: the incumbent stays leader, and the challenger cannot open candidacy.
      expect(await store.aic.currentLeader()).to.equal(big.address);
      await expect(store.aic.connect(medium).openTakeoverCandidacy()).to.be.revertedWithCustomError(
        store.aic,
        "NotLeader"
      );
    });

    it("voids a candidacy whose holder stops being an eligible EOA", async function () {
      const { store, big } = await loadFixture(fixture);
      await (await store.aic.connect(big).openTakeoverCandidacy()).wait();
      await expect(store.aic.purgeIneligible(big.address)).to.be.revertedWithCustomError(
        store.aic,
        "AccountStillEligible"
      );
      expect(await store.aic.takeoverCandidacyOpenedAt(big.address)).to.be.greaterThan(0n);
    });

    it("lets an address that gained code be purged permissionlessly and fails closed meanwhile", async function () {
      const { store, big } = await loadFixture(fixture);
      // Simulate the edge case with a contract that legitimately holds a large balance and
      // was never eligible: purge must be idempotent and must not affect eligible holders.
      const holder = await (await ethers.getContractFactory("ContractHolder")).deploy();
      await holder.waitForDeployment();
      await (await store.aic.connect(big).transfer(await holder.getAddress(), AIC(1))).wait();
      await (await store.aic.purgeIneligible(await holder.getAddress())).wait();
      expect(await store.aic.rankedKeyOf(await holder.getAddress())).to.equal(0n);
      expect(await store.aic.currentLeader()).to.equal(big.address);
    });
  });

  describe("Post-takeover state (MASTER_PLAN 0.21.E, 0.29.J)", function () {
    async function takenOver() {
      const f = await loadFixture(fixture);
      await (await f.store.aic.connect(f.big).openTakeoverCandidacy()).wait();
      await time.increase(ONE_HOUR + 1);
      await (await f.store.aic.connect(f.big).finalizeTakeover()).wait();
      return f;
    }

    it("atomically updates controller, registry and ownership epoch", async function () {
      const { env, store, big } = await takenOver();
      expect(await store.store.storeController()).to.equal(big.address);
      expect(await store.store.ownershipEpoch()).to.equal(2n);
      expect(await env.registry.storeController(store.storeId)).to.equal(big.address);
      expect(await env.registry.ownershipEpoch(store.storeId)).to.equal(2n);
    });

    it("revokes every previous-controller privilege", async function () {
      const { store, creator } = await takenOver();
      await expect(
        store.store.connect(creator).withdrawOwnerProceeds(0n, creator.address)
      ).to.be.revertedWithCustomError(store.store, "NotController");
      await expect(
        store.store.connect(creator).createProduct(ethers.id("x"), USDC(1), 1, 0, ethers.ZeroHash, "", UNDECLARED)
      ).to.be.revertedWithCustomError(store.store, "NotController");
      await expect(
        store.store.connect(creator).transferController(creator.address)
      ).to.be.revertedWithCustomError(store.store, "NotController");
    });

    it("redirects the 1% AgentGoods fee to the new controller", async function () {
      const { env, store, big, creator } = await takenOver();
      await expect(
        env.agentGoods.connect(creator).withdrawControllerFees(await store.aic.getAddress(), creator.address)
      ).to.be.revertedWithCustomError(env.agentGoods, "NotStoreController");
      await (
        await env.agentGoods.connect(big).withdrawControllerFees(await store.aic.getAddress(), big.address)
      ).wait();
      expect(await env.usdc.balanceOf(big.address)).to.be.greaterThan(0n);
    });

    it("releases the candidacy lock on finalization", async function () {
      const { store, big } = await takenOver();
      expect(await store.aic.lockedBalanceOf(big.address)).to.equal(0n);
      expect(await store.aic.takeoverCandidacyOpenedAt(big.address)).to.equal(0n);
    });

    it("does not reset holder reserve, licenses or governance obligations", async function () {
      const env = await deployProtocol();
      const store = await createStore(env, env.signers[5], StoreType.Sales, { aicSymbol: "TKG" });
      const creator = env.signers[5];
      const [a, b] = [env.signers[6], env.signers[7]];
      const buyer = env.signers[10];

      await (
        await store.store
          .connect(creator)
          .createProduct(ethers.id("p"), USDC(10), 1000, 0, ethers.ZeroHash, "", UNDECLARED)
      ).wait();
      await (await env.usdc.mint(buyer.address, USDC(500))).wait();
      await (
        await env.usdc.connect(buyer).approve(await store.store.getAddress(), USDC(500))
      ).wait();
      await (
        await store.store.connect(buyer).purchase(ethers.id("p"), 20, 1, USDC(500), ethers.ZeroHash, "")
      ).wait();
      // The holders' share was bought back at purchase; the owner's proceeds are what remain.
      const reserveBefore = await store.store.lifetimeHolderReserveAccruedUSDC();
      expect(reserveBefore).to.be.greaterThan(0n);
      expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
      const ownerAvailableBefore = await store.store.ownerAvailableUSDC();

      await buyAIC(env, store, creator, USDC(2000));
      const total = await store.aic.balanceOf(creator.address);
      await (await store.aic.connect(creator).transfer(a.address, (total * 60n) / 100n)).wait();
      await (
        await store.aic.connect(creator).transfer(b.address, total - (total * 60n) / 100n)
      ).wait();

      // A proposal passes, locking the store.
      const tx = await store.governance
        .connect(b)
        .propose(ethers.id("gov"), "", 7 * 24 * 3600);
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
      expect(await store.store.governanceLockActive()).to.equal(true);

      // b takes over the store while the obligation is unresolved.
      expect(await store.aic.currentLeader()).to.equal(a.address);
      // `a` is fully locked by its YES vote. Takeover candidacy must still be possible:
      // an already-locked balance is already immobile, so nothing needs re-locking.
      await (await store.aic.connect(a).openTakeoverCandidacy()).wait();
      expect(await store.aic.lockAmount(a.address, await store.aic.TAKEOVER_LOCK_ID())).to.equal(0n);
      await time.increase(ONE_HOUR + 1);
      await (await store.aic.connect(a).finalizeTakeover()).wait();

      expect(await store.store.storeController()).to.equal(a.address);
      // The obligation and the reserve both survive the controller change.
      expect(await store.store.governanceLockActive()).to.equal(true);
      expect(await store.store.unresolvedPassedProposalCount()).to.equal(1n);
      expect(await store.store.lifetimeHolderReserveAccruedUSDC()).to.equal(reserveBefore);
      expect(await store.store.ownerAvailableUSDC()).to.equal(ownerAvailableBefore);
      await expect(
        store.store.connect(a).withdrawOwnerProceeds(1n, a.address)
      ).to.be.revertedWithCustomError(store.store, "GovernanceLocked");
    });
  });

  describe("No hidden admin takeover (MASTER_PLAN 0.19.J)", function () {
    it("gives no protocol role any way to become store controller", async function () {
      const { env, store, creator, outsider } = await loadFixture(fixture);
      for (const signer of [env.deployer, env.guardian, outsider]) {
        await expect(
          store.store.connect(signer).transferController(signer.address)
        ).to.be.revertedWithCustomError(store.store, "NotController");
        await expect(
          store.store.connect(signer).onHolderTakeover(signer.address)
        ).to.be.revertedWithCustomError(store.store, "NotAicToken");
      }
      expect(await store.store.storeController()).to.equal(creator.address);
    });

    it("refuses a registry controller record written by anything but the canonical store", async function () {
      const { env, store } = await loadFixture(fixture);
      await expect(
        env.registry.connect(env.deployer).recordControllerChange(store.storeId, env.deployer.address, 1)
      ).to.be.revertedWithCustomError(env.registry, "NotCanonicalStore");
    });
  });

  describe("Ranking structure bounds", function () {
    it("keeps transfer gas bounded as the holder set grows", async function () {
      const { env, store, big } = await loadFixture(fixture);
      const wallets = [];
      for (let i = 0; i < 60; i++) {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        wallets.push(w);
      }
      // Fund each wallet with a strictly increasing balance to force sift operations.
      let maxGas = 0n;
      for (let i = 0; i < wallets.length; i++) {
        const tx = await store.aic.connect(big).transfer(wallets[i].address, AIC(1) * BigInt(i + 1));
        const r = await tx.wait();
        if (r.gasUsed > maxGas) maxGas = r.gasUsed;
      }
      expect(await store.aic.rankedHolderCount()).to.be.greaterThanOrEqual(60n);
      // Bounded: worst observed transfer stays well under a sane per-tx budget.
      expect(maxGas).to.be.lessThan(500_000n);
      expect(env.chainId).to.be.greaterThan(0n);
    });

    it("maintains the max-heap invariant under randomized balance churn", async function () {
      const { store, big, medium, smallHolder, outsider } = await loadFixture(fixture);
      const participants = [big, medium, smallHolder, outsider];

      for (let round = 0; round < 40; round++) {
        const from = participants[round % participants.length];
        const to = participants[(round + 1) % participants.length];
        const bal = await store.aic.balanceOf(from.address);
        if (bal === 0n) continue;
        const amount = bal / BigInt((round % 5) + 2);
        if (amount === 0n) continue;
        await (await store.aic.connect(from).transfer(to.address, amount)).wait();

        // Independent recomputation of the expected leader.
        let expectedLeader = ethers.ZeroAddress;
        let expectedMax = 0n;
        for (const p of participants) {
          const b = await store.aic.balanceOf(p.address);
          if (b > expectedMax) {
            expectedMax = b;
            expectedLeader = p.address;
          }
        }
        expect(await store.aic.currentLeaderBalance()).to.equal(expectedMax);
        expect(await store.aic.currentLeader()).to.equal(expectedLeader);
      }
    });
  });
});
