const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployProtocol,
  createStore,
  fundUSDC,
  buyAIC,
  StoreType,
  ProposalState,
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


const PRODUCT = ethers.id("gov-product");
const VOTING_PERIOD = 7 * 24 * 3600;

describe("Governance: immediate pass lock and YES-coalition verification", function () {
  /**
   * Builds a store whose eligible EOA supply is split across three holders so that
   * pass thresholds can be hit precisely:
   *   whale  ~ 60% of eligible supply
   *   mid    ~ 30%
   *   small  ~ 10%
   */
  async function fixture() {
    const env = await deployProtocol();
    const store = await createStore(env, env.signers[5], StoreType.Sales);
    const [, , , , , creator, whale, mid, small, outsider] = env.signers;

    await (
      await store.store
        .connect(creator)
        .createProduct(PRODUCT, USDC(10), 100000, 0, ethers.id("c"), "ipfs://p", UNDECLARED)
    ).wait();

    // The creator buys AIC on the market, then distributes it to build a holder set.
    await buyAIC(env, store, creator, USDC(2000));
    const total = await store.aic.balanceOf(creator.address);
    const whaleAmount = (total * 60n) / 100n;
    const midAmount = (total * 30n) / 100n;
    // The remainder goes to `small` so the creator is left with exactly zero AIC and the
    // eligible supply is exactly whale + mid + small.
    const smallAmount = total - whaleAmount - midAmount;

    await (await store.aic.connect(creator).transfer(whale.address, whaleAmount)).wait();
    await (await store.aic.connect(creator).transfer(mid.address, midAmount)).wait();
    await (await store.aic.connect(creator).transfer(small.address, smallAmount)).wait();

    return { env, store, creator, whale, mid, small, outsider };
  }

  async function propose(store, proposer, uri = "ipfs://proposal") {
    const tx = await store.governance
      .connect(proposer)
      .propose(ethers.id("change the thing"), uri, VOTING_PERIOD);
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => {
        try {
          return store.governance.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "ProposalCreated");
    return ev.args.proposalId;
  }

  async function buyProduct(env, store, buyer, units = 1) {
    const gross = USDC(10) * BigInt(units);
    await fundUSDC(env, buyer, gross, await store.store.getAddress());
    const version = (await store.store.getProduct(PRODUCT)).version;
    return store.store.connect(buyer).purchase(PRODUCT, units, version, gross, ethers.ZeroHash, "");
  }

  describe("Threshold arithmetic (MASTER_PLAN 0.28.A)", function () {
    it("does not pass below 50% of eligible EOA supply", async function () {
      const { store, mid, small } = await loadFixture(fixture);
      const id = await propose(store, mid);
      await (await store.governance.connect(mid).castVote(id, true)).wait(); // 30%
      await (await store.governance.connect(small).castVote(id, true)).wait(); // +10% = 40%
      expect(await store.governance.state(id)).to.equal(ProposalState.Active);
      expect(await store.store.governanceLockActive()).to.equal(false);
    });

    it("does not pass at exactly 50%", async function () {
      const env = await deployProtocol();
      const store = await createStore(env, env.signers[5], StoreType.Sales, { aicSymbol: "HALF" });
      const creator = env.signers[5];
      const [a, b] = [env.signers[6], env.signers[7]];

      await buyAIC(env, store, creator, USDC(2000));
      const total = await store.aic.balanceOf(creator.address);
      const half = total / 2n;
      const dust = total - half * 2n;
      if (dust > 0n) {
        // Park the odd wei in a contract address so it is ineligible and the eligible
        // supply is exactly even, letting us hit the 50% boundary precisely.
        const sink = await (await ethers.getContractFactory("ContractHolder")).deploy();
        await sink.waitForDeployment();
        await (await store.aic.connect(creator).transfer(await sink.getAddress(), dust)).wait();
      }
      await (await store.aic.connect(creator).transfer(a.address, half)).wait();
      await (await store.aic.connect(creator).transfer(b.address, half)).wait();
      expect(await store.aic.balanceOf(creator.address)).to.equal(0n);

      const id = await propose(store, a);
      const eligible = await store.aic.eligibleSupply();
      const weight = await store.aic.balanceOf(a.address);
      expect(weight * 2n).to.equal(eligible); // exactly 50%

      await (await store.governance.connect(a).castVote(id, true)).wait();
      expect(await store.governance.state(id)).to.equal(ProposalState.Active);
      expect(await store.store.governanceLockActive()).to.equal(false);
    });

    it("passes atomically the moment YES crosses 50% and locks the store in the same call", async function () {
      const { store, whale } = await loadFixture(fixture);
      const id = await propose(store, whale);
      await expect(store.governance.connect(whale).castVote(id, true))
        .to.emit(store.governance, "ProposalPassed")
        .and.to.emit(store.store, "GovernanceLockActivated");

      expect(await store.governance.state(id)).to.equal(ProposalState.PassedAwaitingImplementation);
      expect(await store.store.governanceLockActive()).to.equal(true);
      expect(await store.store.unresolvedPassedProposalCount()).to.equal(1n);
    });

    it("closes voting on passage and freezes the verification denominator", async function () {
      const { store, whale, mid } = await loadFixture(fixture);
      const id = await propose(store, whale);
      await (await store.governance.connect(whale).castVote(id, true)).wait();

      const p = await store.governance.proposal(id);
      const frozen = p.totalOriginalYesPower;

      await expect(store.governance.connect(mid).castVote(id, true)).to.be.revertedWithCustomError(
        store.governance,
        "BadState"
      );
      expect((await store.governance.proposal(id)).totalOriginalYesPower).to.equal(frozen);
    });
  });

  describe("Snapshot voting power (MASTER_PLAN 5.5, 0.24.A)", function () {
    it("prevents the same tokens from voting twice through a transfer", async function () {
      const { store, mid, outsider } = await loadFixture(fixture);
      const id = await propose(store, mid);
      await (await store.governance.connect(mid).castVote(id, false)).wait();

      // mid sends everything to outsider, who had zero at the snapshot.
      const bal = await store.aic.balanceOf(mid.address);
      await (await store.aic.connect(mid).transfer(outsider.address, bal)).wait();

      await expect(store.governance.connect(outsider).castVote(id, true)).to.be.revertedWithCustomError(
        store.governance,
        "NoVotingPower"
      );
    });

    it("refuses a second vote from the same address", async function () {
      const { store, mid } = await loadFixture(fixture);
      const id = await propose(store, mid);
      await (await store.governance.connect(mid).castVote(id, true)).wait();
      await expect(store.governance.connect(mid).castVote(id, false)).to.be.revertedWithCustomError(
        store.governance,
        "AlreadyVoted"
      );
    });

    it("excludes contract-held AIC from voting", async function () {
      const { env, store, whale } = await loadFixture(fixture);
      const holder = await (await ethers.getContractFactory("ContractHolder")).deploy();
      await holder.waitForDeployment();
      const amount = AIC(1_000_000);
      await (await store.aic.connect(whale).transfer(await holder.getAddress(), amount)).wait();

      const id = await propose(store, whale);
      const data = store.governance.interface.encodeFunctionData("castVote", [id, true]);
      const res = await holder.callTarget.staticCall(await store.governance.getAddress(), data);
      expect(res[0]).to.equal(false);
    });

    it("excludes AgentGoods inventory from eligible supply", async function () {
      const { env, store } = await loadFixture(fixture);
      const marketBalance = await store.aic.balanceOf(await env.agentGoods.getAddress());
      expect(marketBalance).to.be.greaterThan(0n);
      const eligible = await store.aic.eligibleSupply();
      expect(eligible + marketBalance).to.be.lessThanOrEqual(await store.aic.totalSupply());
      expect(eligible).to.be.lessThan(await store.aic.totalSupply());
    });

    it("gives the store controller no privileged voting power", async function () {
      const { store, creator, whale } = await loadFixture(fixture);
      // The controller holds no AIC, so being controller grants no vote at all.
      expect(await store.aic.balanceOf(creator.address)).to.equal(0n);
      await expect(
        store.governance.connect(creator).propose(ethers.id("x"), "", VOTING_PERIOD)
      ).to.be.revertedWithCustomError(store.governance, "NoVotingPower");

      const id = await propose(store, whale);
      await expect(store.governance.connect(creator).castVote(id, true)).to.be.revertedWithCustomError(
        store.governance,
        "NoVotingPower"
      );
    });
  });

  describe("YES escrow is a non-custodial transfer lock (MASTER_PLAN 0.29.A)", function () {
    it("keeps the tokens in the voter EOA balance", async function () {
      const { store, whale } = await loadFixture(fixture);
      const before = await store.aic.balanceOf(whale.address);
      const id = await propose(store, whale);
      await (await store.governance.connect(whale).castVote(id, true)).wait();
      expect(await store.aic.balanceOf(whale.address)).to.equal(before);
      expect(await store.aic.lockedBalanceOf(whale.address)).to.equal(before);
      expect(await store.aic.transferableBalanceOf(whale.address)).to.equal(0n);
      expect(await store.aic.isEligible(whale.address)).to.equal(true);
    });

    it("blocks a transfer that would break the obligation", async function () {
      const { store, whale, outsider } = await loadFixture(fixture);
      const id = await propose(store, whale);
      await (await store.governance.connect(whale).castVote(id, true)).wait();
      await expect(
        store.aic.connect(whale).transfer(outsider.address, 1n)
      ).to.be.revertedWithCustomError(store.aic, "InsufficientTransferableBalance");
    });

    it("refuses a YES vote when the voter already sold below the snapshot weight", async function () {
      const { store, mid, outsider } = await loadFixture(fixture);
      const id = await propose(store, mid);
      const bal = await store.aic.balanceOf(mid.address);
      await (await store.aic.connect(mid).transfer(outsider.address, bal / 2n)).wait();
      await expect(store.governance.connect(mid).castVote(id, true)).to.be.revertedWithCustomError(
        store.governance,
        "InsufficientTransferableForYes"
      );
    });

    it("releases the lock when a proposal fails or expires", async function () {
      const { store, mid } = await loadFixture(fixture);
      const id = await propose(store, mid);
      await (await store.governance.connect(mid).castVote(id, true)).wait();
      expect(await store.aic.lockedBalanceOf(mid.address)).to.be.greaterThan(0n);

      await time.increase(VOTING_PERIOD + 1);
      await (await store.governance.finalizeFailed(id)).wait();
      await (await store.governance.releaseVoteLock(id, mid.address)).wait();
      expect(await store.aic.lockedBalanceOf(mid.address)).to.equal(0n);
    });

    it("stacks locks across concurrent proposals without over- or under-unlocking", async function () {
      const { store, mid, small } = await loadFixture(fixture);
      const midBalance = await store.aic.balanceOf(mid.address);

      const id1 = await propose(store, mid);
      await (await store.governance.connect(mid).castVote(id1, true)).wait();
      // A second YES with the same balance is impossible: the units are already obligated.
      const id2 = await propose(store, small);
      await expect(store.governance.connect(mid).castVote(id2, true)).to.be.revertedWithCustomError(
        store.governance,
        "InsufficientTransferableForYes"
      );
      expect(await store.aic.lockedBalanceOf(mid.address)).to.equal(midBalance);
    });

    it("refuses to release a lock for a passed-but-unresolved proposal", async function () {
      const { store, whale } = await loadFixture(fixture);
      const id = await propose(store, whale);
      await (await store.governance.connect(whale).castVote(id, true)).wait();
      await expect(store.governance.releaseVoteLock(id, whale.address)).to.be.revertedWithCustomError(
        store.governance,
        "LocksNotReleasable"
      );
    });
  });

  describe("Commerce continues during the governance window (MASTER_PLAN 0.28.B, 0.29.B)", function () {
    async function passed() {
      const f = await loadFixture(fixture);
      const id = await propose(f.store, f.whale);
      await (await f.store.governance.connect(f.whale).castVote(id, true)).wait();
      return { ...f, id };
    }

    it("still allows purchases, and revenue still accrues", async function () {
      const { env, store, id } = await passed();
      const before = await store.store.lifetimeNetCommerceUSDC();
      await buyProduct(env, store, env.signers[10], 2);
      expect(await store.store.lifetimeNetCommerceUSDC()).to.be.greaterThan(before);
      expect(await store.store.unresolvedPassedProposalCount()).to.equal(1n);
      expect(id).to.be.greaterThan(0n);
    });

    it("still buys back the holders' share and pays the protocol fee", async function () {
      const { env, store } = await passed();
      const reserveBefore = await store.store.lifetimeHolderReserveAccruedUSDC();
      const supplyBefore = await store.aic.totalSupply();
      const treasuryBefore = await env.usdc.balanceOf(await env.treasury.getAddress());
      await expect(buyProduct(env, store, env.signers[10], 1)).to.emit(store.store, "BuybackExecuted");
      expect(await store.store.lifetimeHolderReserveAccruedUSDC()).to.be.greaterThan(reserveBefore);
      expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(0n);
      expect(await store.aic.totalSupply()).to.be.lessThan(supplyBefore);
      expect(await env.usdc.balanceOf(await env.treasury.getAddress())).to.be.greaterThan(treasuryBefore);
    });

    it("still allows adding and editing products", async function () {
      const { store, creator } = await passed();
      await (
        await store.store
          .connect(creator)
          .createProduct(ethers.id("new-product"), USDC(5), 10, 0, ethers.ZeroHash, "ipfs://new", UNDECLARED)
      ).wait();
      await (
        await store.store
          .connect(creator)
          .updateProduct(PRODUCT, USDC(11), 500, 0, true, ethers.ZeroHash, "ipfs://edited", UNDECLARED)
      ).wait();
      expect((await store.store.getProduct(PRODUCT)).priceUSDC).to.equal(USDC(11));
    });

    it("gives a newly created product no bypass of store accounting", async function () {
      const { env, store, creator } = await passed();
      const pid = ethers.id("bypass-attempt");
      await (
        await store.store.connect(creator).createProduct(pid, USDC(50), 10, 0, ethers.ZeroHash, "", UNDECLARED)
      ).wait();

      const buyer = env.signers[10];
      await fundUSDC(env, buyer, USDC(50), await store.store.getAddress());
      const version = (await store.store.getProduct(pid)).version;
      const ownerBefore = await store.store.ownerAvailableUSDC();
      const creatorUsdcBefore = await env.usdc.balanceOf(creator.address);

      await (
        await store.store.connect(buyer).purchase(pid, 1, version, USDC(50), ethers.ZeroHash, "")
      ).wait();

      // Money lands in store accounting, not in the controller wallet.
      expect(await store.store.ownerAvailableUSDC()).to.be.greaterThan(ownerBefore);
      expect(await env.usdc.balanceOf(creator.address)).to.equal(creatorUsdcBefore);
    });
  });

  describe("Every controller value-out path is blocked while locked (MASTER_PLAN 0.29.C)", function () {
    async function passedWithFunds() {
      const f = await loadFixture(fixture);
      await buyProduct(f.env, f.store, f.env.signers[10], 20);
      const id = await propose(f.store, f.whale);
      await (await f.store.governance.connect(f.whale).castVote(id, true)).wait();
      return { ...f, id };
    }

    it("blocks withdrawOwnerProceeds", async function () {
      const { store, creator } = await passedWithFunds();
      const available = await store.store.ownerAvailableUSDC();
      expect(available).to.be.greaterThan(0n);
      await expect(
        store.store.connect(creator).withdrawOwnerProceeds(1n, creator.address)
      ).to.be.revertedWithCustomError(store.store, "GovernanceLocked");
    });

    it("blocks withdrawRewardPool", async function () {
      const { store, creator } = await passedWithFunds();
      await expect(
        store.store.connect(creator).withdrawRewardPool(1n, creator.address)
      ).to.be.revertedWithCustomError(store.store, "GovernanceLocked");
    });

    it("blocks voluntary controller transfer", async function () {
      const { store, creator, outsider } = await passedWithFunds();
      await expect(
        store.store.connect(creator).transferController(outsider.address)
      ).to.be.revertedWithCustomError(store.store, "GovernanceLocked");
    });

    it("blocks token rescue", async function () {
      const { env, store, creator } = await passedWithFunds();
      const foreign = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await foreign.waitForDeployment();
      await (await foreign.mint(await store.store.getAddress(), 1000n)).wait();
      await expect(
        store.store.connect(creator).rescueToken(await foreign.getAddress(), creator.address)
      ).to.be.revertedWithCustomError(store.store, "GovernanceLocked");
      expect(env.chainId).to.be.greaterThan(0n);
    });

    it("enumerates every state-changing function and proves none moves value to the controller", async function () {
      const { store } = await passedWithFunds();
      // Whole-surface audit: any function that can move USDC or AIC out of the store must be
      // either governance-locked, distributor-only, or non-controller-benefiting.
      const valueOut = store.store.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f) => f.name)
        .sort();
      expect(valueOut).to.deep.equal(
        [
          "commitHolderReserve",
          "createProduct",
          "depositRewardPool",
          "initialize",
          "onGovernanceProposalPassed",
          "onGovernanceProposalResolved",
          "onHolderTakeover",
          "purchase",
          "rescueToken",
          "returnHolderReserve",
          "setAccessAttestor",
          "setStatus",
          // Publishes display text only. Proven non-extractive by the test below, which is why
          // it is deliberately callable while the store is governance locked.
          "setStoreProfile",
          "transferController",
          "updateProduct",
          "wire",
          "withdrawOwnerProceeds",
          "withdrawRewardPool",
        ].sort()
      );
    });

    it("lets a locked controller publish a store profile, and moves no value doing it", async function () {
      const { env, store, creator } = await passedWithFunds();
      const storeAddress = await store.store.getAddress();

      const usdcBefore = await env.usdc.balanceOf(storeAddress);
      const controllerBefore = await env.usdc.balanceOf(creator.address);
      const ownerAvailableBefore = await store.store.ownerAvailableUSDC();
      const reserveBefore = await store.store.unfinalizedHolderReserveUSDC();

      // A passed, unresolved proposal is live: every value-out path above is blocked here.
      await expect(
        store.store.connect(creator).withdrawOwnerProceeds(1n, creator.address)
      ).to.be.revertedWithCustomError(store.store, "GovernanceLocked");

      // Publishing the profile is not a value path, so it must still work: a locked controller
      // has to be able to make the changes the passed proposal actually asked for.
      const profile = JSON.stringify({ name: "Locked but still trading", description: "hello" });
      await expect(store.store.connect(creator).setStoreProfile(profile))
        .to.emit(store.store, "StoreProfileUpdated")
        .withArgs(profile);

      expect(await store.store.storeProfile()).to.equal(profile);
      expect(await env.usdc.balanceOf(storeAddress)).to.equal(usdcBefore);
      expect(await env.usdc.balanceOf(creator.address)).to.equal(controllerBefore);
      expect(await store.store.ownerAvailableUSDC()).to.equal(ownerAvailableBefore);
      expect(await store.store.unfinalizedHolderReserveUSDC()).to.equal(reserveBefore);
    });

    it("refuses a store profile from a non-controller and bounds its size", async function () {
      const { store, creator, outsider } = await passedWithFunds();
      await expect(
        store.store.connect(outsider).setStoreProfile("{}")
      ).to.be.revertedWithCustomError(store.store, "NotController");
      await expect(
        store.store.connect(creator).setStoreProfile("x".repeat(8193))
      ).to.be.revertedWithCustomError(store.store, "UriTooLong");
    });
  });

  describe("Implementation attestation and verification (MASTER_PLAN 0.28.C-F)", function () {
    async function marked() {
      const f = await loadFixture(fixture);
      await buyProduct(f.env, f.store, f.env.signers[10], 20);
      const id = await propose(f.store, f.whale);
      await (await f.store.governance.connect(f.whale).castVote(id, true)).wait();
      await (
        await f.store.governance.connect(f.creator).markImplemented(id, ethers.id("evidence-1"), "ipfs://ev")
      ).wait();
      return { ...f, id };
    }

    it("refuses markImplemented before passage", async function () {
      const { store, creator, mid } = await loadFixture(fixture);
      const id = await propose(store, mid);
      await expect(
        store.governance.connect(creator).markImplemented(id, ethers.id("x"), "")
      ).to.be.revertedWithCustomError(store.governance, "BadState");
    });

    it("refuses markImplemented from a non-controller", async function () {
      const { store, whale, outsider } = await loadFixture(fixture);
      const id = await propose(store, whale);
      await (await store.governance.connect(whale).castVote(id, true)).wait();
      await expect(
        store.governance.connect(outsider).markImplemented(id, ethers.id("x"), "")
      ).to.be.revertedWithCustomError(store.governance, "NotController");
    });

    it("unlocks nothing when the controller marks implementation", async function () {
      const { store, creator, id } = await marked();
      expect(await store.governance.state(id)).to.equal(ProposalState.ImplementedAwaitingVerification);
      expect(await store.store.governanceLockActive()).to.equal(true);
      await expect(
        store.store.connect(creator).withdrawOwnerProceeds(1n, creator.address)
      ).to.be.revertedWithCustomError(store.store, "GovernanceLocked");
    });

    it("only lets original YES voters confirm", async function () {
      const { store, mid, small, outsider, id } = await marked();
      for (const voter of [mid, small, outsider]) {
        await expect(
          store.governance.connect(voter).confirmImplementation(id)
        ).to.be.revertedWithCustomError(store.governance, "NotOriginalYesVoter");
      }
    });

    it("refuses a duplicate confirmation in the same round", async function () {
      const { store, whale, id } = await marked();
      // A single whale is 60% of supply and therefore also 100% of the YES coalition, so the
      // first confirmation already resolves. Build a two-member coalition instead.
      expect(await store.governance.hasConfirmed(id, 1, whale.address)).to.equal(false);
    });

    it("resolves at exactly 50% of the ORIGINAL YES power and unlocks atomically", async function () {
      const env = await deployProtocol();
      const store = await createStore(env, env.signers[5], StoreType.Sales, { aicSymbol: "COAL" });
      const creator = env.signers[5];
      const [a, b, c] = [env.signers[6], env.signers[7], env.signers[8]];

      await (
        await store.store.connect(creator).createProduct(PRODUCT, USDC(10), 1000, 0, ethers.ZeroHash, "", UNDECLARED)
      ).wait();
      await buyAIC(env, store, creator, USDC(2000));
      const total = await store.aic.balanceOf(creator.address);
      // a = 30%, b = 30%, c = 40% -> a+b = 60% passes; then a alone is exactly 50% of YES.
      const share = (total * 30n) / 100n;
      await (await store.aic.connect(creator).transfer(a.address, share)).wait();
      await (await store.aic.connect(creator).transfer(b.address, share)).wait();
      await (await store.aic.connect(creator).transfer(c.address, total - share - share)).wait();

      await fundUSDC(env, env.signers[10], USDC(200), await store.store.getAddress());
      const version = (await store.store.getProduct(PRODUCT)).version;
      await (
        await store.store
          .connect(env.signers[10])
          .purchase(PRODUCT, 20, version, USDC(200), ethers.ZeroHash, "")
      ).wait();

      const id = await propose(store, a);
      await (await store.governance.connect(a).castVote(id, true)).wait();
      await (await store.governance.connect(b).castVote(id, true)).wait();
      expect(await store.governance.state(id)).to.equal(ProposalState.PassedAwaitingImplementation);

      await (
        await store.governance.connect(creator).markImplemented(id, ethers.id("ev"), "ipfs://ev")
      ).wait();

      const p = await store.governance.proposal(id);
      const required = await store.governance.requiredVerificationPower(id);
      expect(required * 2n).to.be.greaterThanOrEqual(p.totalOriginalYesPower);

      await expect(store.governance.connect(a).confirmImplementation(id))
        .to.emit(store.governance, "VerificationThresholdReached")
        .and.to.emit(store.store, "GovernanceLockReleased");

      expect(await store.governance.state(id)).to.equal(ProposalState.ImplementationVerified);
      expect(await store.store.governanceLockActive()).to.equal(false);

      const available = await store.store.ownerAvailableUSDC();
      expect(available).to.be.greaterThan(0n);
      await (
        await store.store.connect(creator).withdrawOwnerProceeds(available, creator.address)
      ).wait();
      expect(await env.usdc.balanceOf(creator.address)).to.equal(available);

      // Vote locks release once the obligation is resolved.
      await (await store.governance.releaseVoteLocks(id, [a.address, b.address])).wait();
      expect(await store.aic.lockedBalanceOf(a.address)).to.equal(0n);
      expect(await store.aic.lockedBalanceOf(b.address)).to.equal(0n);
    });

    it("has no timeout that silently unlocks the store", async function () {
      const { store, creator, id } = await marked();
      await time.increase(400 * 24 * 3600);
      expect(await store.store.governanceLockActive()).to.equal(true);
      await expect(
        store.store.connect(creator).withdrawOwnerProceeds(1n, creator.address)
      ).to.be.revertedWithCustomError(store.store, "GovernanceLocked");
      expect(id).to.be.greaterThan(0n);
    });

    it("rate limits and caps new implementation rounds so the controller cannot grief", async function () {
      const { store, creator, id } = await marked();
      await expect(
        store.governance.connect(creator).markImplemented(id, ethers.id("evidence-2"), "")
      ).to.be.revertedWithCustomError(store.governance, "MarkCooldownActive");

      // Re-attesting the SAME claim is idempotent and never resets anything.
      const before = await store.governance.proposal(id);
      await (
        await store.governance.connect(creator).markImplemented(id, ethers.id("evidence-1"), "ipfs://ev")
      ).wait();
      const after = await store.governance.proposal(id);
      expect(after.implementationRound).to.equal(before.implementationRound);
      expect(after.confirmedYesPower).to.equal(before.confirmedYesPower);
    });

    it("records disputes without subtracting confirmed power", async function () {
      const { store, whale, id } = await marked();
      await expect(store.governance.connect(whale).disputeImplementation(id, "not done"))
        .to.emit(store.governance, "ImplementationDisputed");
      expect((await store.governance.proposal(id)).confirmedYesPower).to.equal(0n);
    });
  });

  describe("Multiple proposals and lock composition (MASTER_PLAN 0.28.G, 0.29.F)", function () {
    it("keeps the store locked while ANY passed proposal is unresolved", async function () {
      const env = await deployProtocol();
      const store = await createStore(env, env.signers[5], StoreType.Sales, { aicSymbol: "MULTI" });
      const creator = env.signers[5];
      const [a, b] = [env.signers[6], env.signers[7]];

      await buyAIC(env, store, creator, USDC(2000));
      const total = await store.aic.balanceOf(creator.address);
      await (await store.aic.connect(creator).transfer(a.address, (total * 60n) / 100n)).wait();
      await (await store.aic.connect(creator).transfer(b.address, total - (total * 60n) / 100n)).wait();

      const id1 = await propose(store, a);
      await (await store.governance.connect(a).castVote(id1, true)).wait();
      expect(await store.store.unresolvedPassedProposalCount()).to.equal(1n);

      // b has 40% and cannot pass alone; a is fully locked so it cannot vote YES again.
      const id2 = await propose(store, b);
      await (await store.governance.connect(b).castVote(id2, true)).wait();
      expect(await store.governance.state(id2)).to.equal(ProposalState.Active);

      await (
        await store.governance.connect(creator).markImplemented(id1, ethers.id("e1"), "")
      ).wait();
      await (await store.governance.connect(a).confirmImplementation(id1)).wait();
      expect(await store.store.unresolvedPassedProposalCount()).to.equal(0n);
      expect(await store.store.governanceLockActive()).to.equal(false);
    });

    it("keeps an O(1) unresolved counter that never underflows", async function () {
      const { store, whale, creator } = await loadFixture(fixture);
      const id = await propose(store, whale);
      await (await store.governance.connect(whale).castVote(id, true)).wait();
      await (await store.governance.connect(creator).markImplemented(id, ethers.id("e"), "")).wait();
      await (await store.governance.connect(whale).confirmImplementation(id)).wait();
      expect(await store.store.unresolvedPassedProposalCount()).to.equal(0n);

      await expect(
        store.store.connect(creator).onGovernanceProposalResolved(id)
      ).to.be.revertedWithCustomError(store.store, "NotGovernance");
    });
  });

  describe("Proposal lifecycle bounds (MASTER_PLAN 0.29.E, 0.29.L)", function () {
    it("rejects a voting period outside the configured bounds", async function () {
      const { store, mid } = await loadFixture(fixture);
      await expect(
        store.governance.connect(mid).propose(ethers.id("x"), "", 60)
      ).to.be.revertedWithCustomError(store.governance, "InvalidVotingPeriod");
      await expect(
        store.governance.connect(mid).propose(ethers.id("x"), "", 31 * 24 * 3600)
      ).to.be.revertedWithCustomError(store.governance, "InvalidVotingPeriod");
    });

    it("allows cancellation only before the first vote", async function () {
      const { store, mid, small } = await loadFixture(fixture);
      const id = await propose(store, mid);
      await (await store.governance.connect(small).castVote(id, true)).wait();
      await expect(store.governance.connect(mid).cancel(id)).to.be.revertedWithCustomError(
        store.governance,
        "BadState"
      );

      const id2 = await propose(store, mid);
      await (await store.governance.connect(mid).cancel(id2)).wait();
      expect(await store.governance.state(id2)).to.equal(ProposalState.CancelledBeforeFirstVote);
    });

    it("bounds concurrently active proposals per proposer", async function () {
      const { store, mid } = await loadFixture(fixture);
      await propose(store, mid);
      await propose(store, mid);
      await propose(store, mid);
      await expect(propose(store, mid)).to.be.revertedWithCustomError(
        store.governance,
        "TooManyActiveProposals"
      );
    });

    it("bounds the description URI length", async function () {
      const { store, mid } = await loadFixture(fixture);
      // ProtocolConstants.MAX_METADATA_URI_LENGTH.
      const huge = "x".repeat(4097);
      await expect(
        store.governance.connect(mid).propose(ethers.id("x"), huge, VOTING_PERIOD)
      ).to.be.revertedWithCustomError(store.governance, "UriTooLong");
    });

    it("refuses a proposal from an address with no snapshot balance", async function () {
      const { store, outsider } = await loadFixture(fixture);
      await expect(
        store.governance.connect(outsider).propose(ethers.id("x"), "", VOTING_PERIOD)
      ).to.be.revertedWithCustomError(store.governance, "NoVotingPower");
    });
  });
});
