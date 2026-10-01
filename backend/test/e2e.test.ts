/**
 * Mandatory end-to-end scenario (MASTER_PLAN §23).
 *
 * This runs the exact sequence the plan requires, against a real chain, a real database, the
 * real indexer, the real HTTP API and the real Agent SDK that the three proving Agents use:
 *
 *   wallet challenge -> API key -> Agent creates a store -> creates a product ->
 *   Agent B discovers it -> pays USDC -> LicenseToken issued -> AIC incentive delivered ->
 *   access granted and attested -> buyer signal recorded -> store accumulates USDC ->
 *   distribution opened, root proposed, challenged, finalized -> holder claims ->
 *   proposal created -> holders vote with snapshot power -> AIC trades on AgentGoods ->
 *   30% threshold crossed -> DEX transition happens exactly once -> remaining supply burned ->
 *   indexer and API reflect every step.
 *
 * Nothing here is mocked. The Agent never signs with its API key, never receives an unlimited
 * allowance and never exceeds its declared budget.
 */

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Contract, ethers } from "ethers";
import { createHarness, stopChain, USDC, AIC, type Harness } from "./helpers/harness";
import { AicAgent, productIdFor, type TransactionIntent } from "../../agents/src/sdk";
import {
  BuyerSignalDoc,
  DividendEntitlement,
  DividendEpoch,
  License,
  Product,
  Proposal,
  Purchase,
  StockMarket,
  Store,
} from "../src/db/models";
import { generateDataset, persistDataset, verifyDataset } from "../src/dividends/merkle";

let h: Harness;
let alice: AicAgent; // seller
let bob: AicAgent; // buyer
let carol: AicAgent; // holder / voter

const PRODUCT_SLUG = "agent-grade-embedding-corpus";
const PRODUCT_ID = productIdFor(PRODUCT_SLUG);

/** The canonical proving budget: exactly 25 USDC per Agent. [MASTER_PLAN 0.26.C, 0.27.B] */
const PROVING_BUDGET = USDC(25);

const trace: string[] = [];
function log(message: string, data?: Record<string, unknown>): void {
  trace.push(data ? `${message} ${JSON.stringify(data)}` : message);
}

function makeAgent(name: string, index: number): AicAgent {
  const hd = ethers.HDNodeWallet.fromPhrase(
    "test test test test test test test test test test test junk",
    undefined,
    `m/44'/60'/0'/0/${index}`
  );
  return new AicAgent({
    name,
    apiBaseUrl: h.baseUrl,
    rpcUrl: h.env.RPC_HTTP_URL,
    chainId: 31337,
    privateKey: hd.privateKey,
    budget: {
      totalUSDC: PROVING_BUDGET,
      maxPerTransactionUSDC: USDC(5),
      minReserveUSDC: USDC(2),
    },
    log,
  });
}

async function fund(agent: AicAgent, amount: bigint): Promise<void> {
  await (await h.contracts.usdc.mint(agent.address, amount)).wait();
}

async function advanceTime(seconds: number): Promise<void> {
  await h.provider.send("evm_increaseTime", [seconds]);
  await h.provider.send("evm_mine", []);
}

before(async () => {
  h = await createHarness();
  // A cold indexer correctly reports stale, and write preparation correctly refuses while it
  // is. Sync once so the scenario starts from a healthy projection.
  await h.sync();
  // Distinct EOA, distinct API key, distinct identity per Agent. [MASTER_PLAN 0.27.K]
  alice = makeAgent("alice", 1);
  bob = makeAgent("bob", 2);
  carol = makeAgent("carol", 3);
});

after(async () => {
  await h.stop();
  await stopChain();
});

describe("Mandatory end-to-end scenario", { concurrency: 1 }, () => {
  let storeId = "";
  let storeAddress = "";
  let aicToken = "";
  let licenseToken = "";
  let governance = "";
  let distributor = "";
  let bobLicenseId = "";

  test("three Agents onboard themselves with only a wallet", async () => {
    for (const agent of [alice, bob, carol]) {
      await agent.verifyDeployment();
      await agent.onboard();
      await fund(agent, PROVING_BUDGET);
      assert.equal(await agent.usdcBalance(h.manifest.external.canonicalUSDC), PROVING_BUDGET);
      assert.ok(await agent.hasGasForNextTransaction(), `${agent.name} has gas headroom`);
    }
    // Three distinct identities, no shared key.
    assert.notEqual(alice.address, bob.address);
    assert.notEqual(bob.address, carol.address);
  });

  test("an Agent creates a canonical store with 1B AIC in its market", async () => {
    await alice.createStore({
      storeType: "sales",
      aicName: "Corpus AIC",
      aicSymbol: "CORP",
      storeName: "Alice Corpus Works",
    });
    await h.sync();

    const store = await Store.findOne({ chainId: 31337, storeController: alice.address.toLowerCase() }).lean();
    assert.ok(store, "store is indexed");
    storeId = store!.storeId;
    storeAddress = store!.address;
    aicToken = store!.aicToken;
    licenseToken = store!.licenseToken;
    governance = store!.governance;
    distributor = store!.dividendDistributor;

    const market = await StockMarket.findOne({ chainId: 31337, aicToken }).lean();
    assert.equal(BigInt(market!.virtualUSDCReserve), USDC(6000) + USDC(5) * 97n / 100n, "6,000 virtual plus the seed net of fees");

    // The creator received no free AIC: exactly what its 5 USDC initial market capital bought, and
    // the market holds the rest of the 1B.
    const aic = new Contract(aicToken, ["function balanceOf(address) view returns (uint256)"], h.provider);
    const seedAIC = (await aic.balanceOf!(alice.address)) as bigint;
    assert.ok(seedAIC > 0n, "the creator holds its seed position");
    assert.equal(BigInt(market!.marketInventoryAIC) + seedAIC, AIC(1_000_000_000));
    assert.equal(store!.initialOwnerSeedUSDC, USDC(5).toString(), "the seed is recorded on the store");

    await alice.assertCanonical(storeAddress, "STORE");
    await alice.assertCanonical(aicToken, "AIC_TOKEN");
  });

  test("the seller lists a product with an honest, explicitly unverified token-saving claim", async () => {
    /*
     * Upload the deliverable BEFORE listing, because the API now refuses the other order.
     *
     * This used to commit a placeholder hash with nothing stored behind it, which is precisely
     * the failure the refusal exists to prevent: a buyer pays, verifies `keccak256 == contentHash`
     * successfully, and collects nothing. Using real bytes here also means the delivery assertions
     * later in this file are exercising a real round trip rather than a fixture.
     */
    const deliverable = "A corpus of prompts that saves a frontier model 180,000 tokens per run.";
    const upload = await h.request("POST", "/api/v1/access/content", {
      apiKey: alice.apiKey,
      body: {
        storeId,
        content: Buffer.from(deliverable, "utf8").toString("base64"),
        contentType: "text/plain",
        filename: "corpus-v1.txt",
      },
    });
    assert.equal(upload.status, 201, "the deliverable is stored before the product commits to it");

    await alice.createProduct(storeId, {
      productId: PRODUCT_SLUG,
      priceUSDC: USDC(2).toString(),
      inventory: "500",
      metadataURI: JSON.stringify({ name: "Corpus v1", description: "test corpus" }),
      // The hash of the bytes just uploaded, so the commitment is real and deliverable.
      contentHash: ethers.keccak256(ethers.toUtf8Bytes(deliverable)),
      declaration: { inputTokens: "170000", reasoningTokens: "6000", outputTokens: "4000", modelTier: "gpt-5", basis: "MEASURED" },
      iterations: 2,
      iterationLog: ["First draft tested on three sample inputs", "Fixed the empty-input case and re-ran all three"],
    });
    await h.sync();

    const product = await Product.findOne({ chainId: 31337, storeId, productId: PRODUCT_ID }).lean();
    assert.ok(product, "product is indexed");
    assert.equal(product!.declaration.declared, true);
    assert.equal(product!.declaration.tokensSaved, "180000");
    // 180000 tokens for 2 USDC = 90000 per USDC, derived by the indexer.
    assert.equal(product!.declaration.tokensSavedPerUsdc, "90000");

    const api = await h.request("GET", `/api/v1/products/${PRODUCT_ID}`);
    assert.equal((api.body.product as Record<string, Record<string, unknown>>).declaration.verified, false);
  });

  test("the seller buys AIC on the open market to fund a customer incentive", async () => {
    // There is no free founder allocation: the controller must participate in its own market.
    await alice.tradeAic(aicToken, "buy", USDC(3));
    await h.sync();

    const aic = new Contract(
      aicToken,
      ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
      alice.wallet
    );
    const held = (await aic.balanceOf!(alice.address)) as bigint;
    assert.ok(held > 0n, "the controller now holds market-bought AIC");

    const pool = held / 2n;
    await (await aic.approve!(storeAddress, pool)).wait();
    const store = new Contract(
      storeAddress,
      ["function depositRewardPool(uint256) returns (uint256)"],
      alice.wallet
    );
    await (await store.depositRewardPool!(pool)).wait();
    await h.sync();

    const doc = await Store.findOne({ chainId: 31337, storeId }).lean();
    assert.equal(doc!.rewardPoolAIC, pool.toString());
  });

  test("a second Agent discovers the product and weighs the claim against the seller record", async () => {
    const discovery = await bob.discovery();
    const products = discovery.newestProducts as Record<string, Record<string, unknown>>[];
    const found = products.find(
      (p) => (p.protocol as Record<string, unknown>).productId === PRODUCT_ID
    );
    assert.ok(found, "the product appears in the discovery feed");

    // The declaration is a claim; the seller record is what it must be weighed against.
    assert.equal((found!.declaration as Record<string, unknown>).verified, false);
    const sellerSignals = found!.sellerSignals as Record<string, unknown>;
    assert.equal(sellerSignals.insufficientSignals, true, "a brand new seller has no track record yet");
    assert.equal(sellerSignals.positiveRate, null, "no rate is invented from zero signals");
    assert.equal(sellerSignals.economicWeight, "none");
  });

  test("the buyer pays USDC, receives a non-transferable license and the AIC incentive", async () => {
    const usdcBefore = await bob.usdcBalance(h.manifest.external.canonicalUSDC);
    const result = await bob.buy(storeId, PRODUCT_ID, 1);
    await h.sync();

    const usdcAfter = await bob.usdcBalance(h.manifest.external.canonicalUSDC);
    assert.equal(usdcBefore - usdcAfter, result.totalUSDC, "exactly the quoted amount left the wallet");

    const purchase = await Purchase.findOne({ chainId: 31337, buyer: bob.address.toLowerCase() }).lean();
    assert.ok(purchase, "purchase is indexed");
    assert.equal(purchase!.grossUSDC, USDC(2).toString());

    // The canonical waterfall: fee, mandatory holder reserve, controller remainder.
    assert.ok(BigInt(purchase!.protocolFeeUSDC) > 0n, "protocol fee charged");
    assert.ok(BigInt(purchase!.holderReserveUSDC) > 0n, "mandatory holder reserve accrued");
    assert.equal(
      BigInt(purchase!.netUSDC),
      BigInt(purchase!.holderReserveUSDC) + BigInt(purchase!.ownerAvailableUSDC),
      "net splits exactly into reserve plus controller-available"
    );

    // The AIC incentive matched the quote exactly.
    assert.equal(BigInt(purchase!.rewardAIC), result.expectedRewardAIC);
    assert.ok(result.expectedRewardAIC > 0n, "a funded pool paid a real incentive");

    const license = await License.findOne({ chainId: 31337, owner: bob.address.toLowerCase() }).lean();
    assert.ok(license, "license is indexed");
    bobLicenseId = license!.tokenId;
    assert.equal(license!.kind, "permanent");
    assert.equal(license!.delivered, false, "not delivered until the gateway attests it");

    // The license genuinely cannot move.
    const lic = new Contract(
      licenseToken,
      ["function transferFrom(address,address,uint256)"],
      bob.wallet
    );
    await assert.rejects(() => lic.transferFrom!(bob.address, carol.address, bobLicenseId));
  });

  test("the buyer cannot signal before delivery, and can after the gateway attests it", async () => {
    const early = await h.request(
      "POST",
      `/api/v1/licenses/${licenseToken}/${bobLicenseId}/signal`,
      { apiKey: await keyFor(bob), headers: { "idempotency-key": `early-${Date.now()}` }, body: { worthIt: true } }
    );
    assert.equal(early.status, 412);
    assert.equal((early.body.error as { code: string }).code, "NO_ACCESS_GRANTED");

    // The store designates its access gateway as the on-chain delivery witness.
    await alice.setAccessAttestor(storeId, alice.address);
    const lic = new Contract(licenseToken, ["function recordAccessGrant(uint256)"], alice.wallet);
    await (await lic.recordAccessGrant!(bobLicenseId)).wait();
    await h.sync();

    const delivered = await License.findOne({ chainId: 31337, licenseToken, tokenId: bobLicenseId }).lean();
    assert.equal(delivered!.delivered, true);

    await bob.signal(licenseToken, bobLicenseId, true);
    await h.sync();

    const signal = await BuyerSignalDoc.findOne({ chainId: 31337, licenseToken, licenseId: bobLicenseId }).lean();
    assert.ok(signal);
    assert.equal(signal!.worthIt, true);
    assert.equal(signal!.selfSignal, false);
  });

  test("a single signal never becomes a published rate", async () => {
    const summary = await bob.sellerSignals(alice.address);
    assert.equal(summary.signalled, 1);
    assert.equal(summary.delivered, 1);
    assert.equal(summary.insufficientSignals, true);
    assert.equal(summary.positiveRate, null, "one signal is not a rate");
    assert.equal(summary.coverage, "1.0000", "1 of 1 delivered was signalled");
    assert.equal(summary.economicWeight, "none");
  });

  test("a third Agent buys AIC, becoming an eligible holder with snapshot rights", async () => {
    // More than the owner's 5 USDC seed position, so Carol is the dominant eligible holder below.
    for (let i = 0; i < 3; i++) {
      await carol.tradeAic(aicToken, "buy", USDC(4)); // the SDK caps one transaction at 5 USDC
      await h.sync();
    }
    await h.sync();

    const market = await StockMarket.findOne({ chainId: 31337, aicToken }).lean();
    assert.ok(BigInt(market!.realUSDCReserve) > 0n, "real USDC entered the curve");
    assert.ok(BigInt(market!.netSoldFromCurveAIC) > 0n, "net sold advanced");
    assert.ok(market!.holderCount >= 2, "holders are indexed");
  });

  test("commerce accumulates a mandatory holder reserve nobody can withdraw", async () => {
    // Several more purchases so the reserve clears the minimum distribution threshold.
    //
    // The harness drives the indexer by hand (`h.sync()`), which is what makes these tests
    // deterministic. Every purchase advances the chain, and the SDK refuses to quote against
    // state older than the head, so the loop has to hand the indexer each block it produces.
    // In production the indexer polls on its own and no caller does this.
    for (let i = 0; i < 4; i++) {
      await bob.buy(storeId, PRODUCT_ID, 2);
      await h.sync();
    }
    await h.sync();

    const store = await Store.findOne({ chainId: 31337, storeId }).lean();
    const reserve = BigInt(store!.unfinalizedHolderReserveUSDC);
    assert.ok(reserve > 0n, "reserve accrued");

    // The controller can withdraw only its own available proceeds, never the reserve.
    const contract = new Contract(
      storeAddress,
      [
        "function withdrawOwnerProceeds(uint256,address)",
        "function ownerAvailableUSDC() view returns (uint256)",
      ],
      alice.wallet
    );
    const available = (await contract.ownerAvailableUSDC!()) as bigint;
    await assert.rejects(
      () => contract.withdrawOwnerProceeds!(available + reserve, alice.address),
      "withdrawing into the reserve is impossible"
    );
  });

  test("anyone can open a distribution; the root survives a challenge window before claims", async () => {
    /*
     * Entitlement weight is the MINIMUM balance across the holding window, so the holders in
     * this scenario have to have actually held for one. The production default is 7 days, which
     * on a chain that mines a block per transaction would place the window start at block 0 and
     * weigh everyone at zero — correctly, since nobody has held for a week. The window is a
     * governed parameter for exactly this reason. [MASTER_PLAN 29C]
     */
    const HOLDING_WINDOW_SECONDS = 20; // 10 blocks at the 2s nominal block time
    await (await h.contracts.registry.setHoldingWindowSeconds(HOLDING_WINDOW_SECONDS)).wait();
    await mineBlocks(12);

    // Top the reserve up above the 1 USDC minimum if it is not there yet.
    let store = await Store.findOne({ chainId: 31337, storeId }).lean();
    // Two units at a time: the Agent enforces its OWN 5 USDC per-transaction cap, and a
    // five-unit purchase at 2 USDC a unit is 10 USDC. The loop respects that guard rather than
    // raising it, because the cap holding under pressure is itself part of what is under test.
    while (BigInt(store!.unfinalizedHolderReserveUSDC) < USDC(1)) {
      await fund(bob, USDC(10));
      await h.sync();
      await bob.buy(storeId, PRODUCT_ID, 2);
      await h.sync();
      store = await Store.findOne({ chainId: 31337, storeId }).lean();
    }

    // Opening is permissionless: a holder, not the controller, triggers it.
    await carol.openDistribution(storeId);
    await h.sync();

    const epoch = await DividendEpoch.findOne({ chainId: 31337, distributor }).lean();
    assert.ok(epoch, "epoch is indexed");
    assert.equal(epoch!.state, "OPEN");
    assert.ok(BigInt(epoch!.committedReserveUSDC) > 0n);
    // The processing fee is charged on the committed reserve, not as extra store commerce.
    assert.equal(
      BigInt(epoch!.claimableUSDC),
      BigInt(epoch!.committedReserveUSDC) - BigInt(epoch!.processingFeeUSDC)
    );

    // Generate the entitlement dataset deterministically from indexed chain history, and
    // independently recompute it before publishing anything.
    const options = {
      chainId: 31337,
      distributor,
      epochId: epoch!.epochId,
      providers: h.ctx.providers,
    };
    const dataset = await generateDataset(options);
    await verifyDataset(dataset, options);
    assert.ok(dataset.total <= BigInt(epoch!.claimableUSDC), "the dataset never over-allocates");
    await persistDataset(dataset, storeId);

    // The root proposer publishes; claims are impossible until the window elapses.
    const dist = new Contract(
      distributor,
      [
        "function proposeRoot(uint256,bytes32,bytes32,uint256,uint256)",
        "function finalizeRoot(uint256)",
      ],
      h.signers[0]
    );
    await (
      await dist.proposeRoot!(
        epoch!.epochId,
        dataset.root,
        dataset.datasetHash,
        dataset.total,
        dataset.eligibleMinSupply
      )
    ).wait();
    await h.sync();

    await assert.rejects(() => dist.finalizeRoot!(epoch!.epochId), "the challenge window is enforced");

    await advanceTime(6 * 3600 + 60);
    await (await dist.finalizeRoot!(epoch!.epochId)).wait();
    await h.sync();

    const finalized = await DividendEpoch.findOne({ chainId: 31337, distributor }).lean();
    assert.equal(finalized!.state, "FINALIZED");
  });

  test("an eligible EOA holder claims its exact snapshot share", async () => {
    const epoch = await DividendEpoch.findOne({ chainId: 31337, distributor }).lean();
    const entitlement = await DividendEntitlement.findOne({
      chainId: 31337,
      distributor,
      epochId: epoch!.epochId,
      account: carol.address.toLowerCase(),
    }).lean();
    assert.ok(entitlement, "the holder has an entitlement");

    const before = await carol.usdcBalance(h.manifest.external.canonicalUSDC);
    await carol.claim(distributor, epoch!.epochId);
    await h.sync();
    const after = await carol.usdcBalance(h.manifest.external.canonicalUSDC);

    assert.equal(after - before, BigInt(entitlement!.amountUSDC), "paid exactly the entitlement");

    // Claiming twice is impossible.
    await assert.rejects(() => carol.claim(distributor, epoch!.epochId));

    const mine = await carol.myDividends();
    const summary = mine.summary as Record<string, { base: string }>;
    assert.ok(BigInt(summary.claimedLifetimeUSDC.base) > 0n);
  });

  test("a holder proposes, the coalition passes it, and the store locks atomically", async () => {
    // Carol is the dominant eligible holder, so a single YES vote crosses the threshold.
    const contentHash = ethers.keccak256(ethers.toUtf8Bytes("Publish a changelog for every corpus update"));
    await carol.propose(storeId, contentHash, "ipfs://proposal-1", 7 * 24 * 3600);
    await h.sync();

    const proposal = await Proposal.findOne({ chainId: 31337, governance }).lean();
    assert.ok(proposal, "proposal is indexed");

    await carol.vote(governance, proposal!.proposalId, true);
    await h.sync();

    const passed = await Proposal.findOne({ chainId: 31337, governance, proposalId: proposal!.proposalId }).lean();
    assert.equal(passed!.state, "PASSED_AWAITING_IMPLEMENTATION");

    const store = await Store.findOne({ chainId: 31337, storeId }).lean();
    assert.equal(store!.governanceLockActive, true, "the store locked in the same transition");
    assert.equal(store!.unresolvedPassedProposalCount, 1);
  });

  test("commerce continues during the lock while controller withdrawal is blocked", async () => {
    const before = await Store.findOne({ chainId: 31337, storeId }).lean();

    // Selling still works.
    //
    // Carol buys rather than Bob. Bob has spent almost all of its self-declared 25 USDC budget
    // by this point in the scenario and its own reserve floor correctly refuses the purchase;
    // topping the wallet up does not change that, because the budget is the Agent OWN limit and
    // not its balance. Raising the limit to make the test pass would quietly delete the property
    // the final budget assertion exists to prove.
    await fund(carol, USDC(10));
    await h.sync();
    await carol.buy(storeId, PRODUCT_ID, 1);
    await h.sync();

    const after = await Store.findOne({ chainId: 31337, storeId }).lean();
    assert.ok(
      BigInt(after!.lifetimeNetCommerceUSDC) > BigInt(before!.lifetimeNetCommerceUSDC),
      "revenue still accrues during a governance lock"
    );

    // Adding a product still works, because implementing a proposal may require it. Its
    // deliverable is uploaded first, like any other: a governance lock does not exempt a seller
    // from committing to something that exists.
    const changelog = "Changelog: corpus v1 -> v2, 12 prompts revised.";
    const changelogUpload = await h.request("POST", "/api/v1/access/content", {
      apiKey: alice.apiKey,
      body: {
        storeId,
        content: Buffer.from(changelog, "utf8").toString("base64"),
        contentType: "text/plain",
        filename: "changelog.txt",
      },
    });
    assert.equal(changelogUpload.status, 201, "deliverable stored even during a governance lock");

    await alice.createProduct(storeId, {
      productId: "changelog-feed",
      priceUSDC: USDC(1).toString(),
      contentHash: ethers.keccak256(ethers.toUtf8Bytes(changelog)),
      inventory: "100",
      metadataURI: JSON.stringify({ name: "Changelog", description: "test changelog" }),
      declaration: null,
      iterations: 2,
      iterationLog: ["First draft tested on three sample inputs", "Fixed the empty-input case and re-ran all three"],
    });
    await h.sync();
    assert.ok(
      await Product.findOne({ chainId: 31337, storeId, productId: productIdFor("changelog-feed") }).lean(),
      "product creation is allowed during the lock"
    );

    // Withdrawing anything is not.
    const contract = new Contract(
      storeAddress,
      ["function withdrawOwnerProceeds(uint256,address)", "function withdrawRewardPool(uint256,address)"],
      alice.wallet
    );
    await assert.rejects(() => contract.withdrawOwnerProceeds!(1n, alice.address));
    await assert.rejects(() => contract.withdrawRewardPool!(1n, alice.address));
  });

  test("only the original YES coalition can release the lock, and it releases atomically", async () => {
    const proposal = await Proposal.findOne({ chainId: 31337, governance }).lean();

    // The controller attests. This unlocks nothing.
    await alice.markImplemented(
      governance,
      proposal!.proposalId,
      ethers.keccak256(ethers.toUtf8Bytes("changelog published")),
      "ipfs://evidence-1"
    );
    await h.sync();

    let store = await Store.findOne({ chainId: 31337, storeId }).lean();
    assert.equal(store!.governanceLockActive, true, "MARK_IMPLEMENTED unlocks nothing");

    // A non-YES voter cannot verify.
    await assert.rejects(
      () => bob.verifyImplementation(governance, proposal!.proposalId),
      "only the original YES coalition verifies"
    );

    // The task shows up for the actual coalition member.
    const tasks = await carol.governanceTasks();
    const verification = tasks.verificationTasks as Record<string, unknown>[];
    assert.ok(verification.length >= 1, "the YES voter is told there is something to verify");
    assert.equal(verification[0]!.type, "GOVERNANCE_IMPLEMENTATION_VERIFICATION_REQUIRED");

    await carol.verifyImplementation(governance, proposal!.proposalId);
    await h.sync();

    store = await Store.findOne({ chainId: 31337, storeId }).lean();
    assert.equal(store!.governanceLockActive, false, "the lock released atomically");

    // And now the controller can withdraw what it actually earned.
    const contract = new Contract(
      storeAddress,
      [
        "function withdrawOwnerProceeds(uint256,address)",
        "function ownerAvailableUSDC() view returns (uint256)",
      ],
      alice.wallet
    );
    const available = (await contract.ownerAvailableUSDC!()) as bigint;
    assert.ok(available > 0n);
    await (await contract.withdrawOwnerProceeds!(available, alice.address)).wait();
  });

  test("the 30% transition fires exactly once, burns the remainder and closes the curve", async () => {
    const usdcAddress = h.manifest.external.canonicalUSDC;
    const whale = h.signers[0]!;
    const usdc = new Contract(
      usdcAddress,
      ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"],
      whale
    );
    const shop = new Contract(
      h.manifest.contracts.agentGoods.proxy,
      ["function buy(address,uint256,uint256,uint256) returns (uint256)", "function market(address) view returns (tuple(address aicToken,address store,bytes32 storeId,uint8 phase,uint256 tokenInventory,uint256 realUSDCReserve,uint256 virtualTokenReserve,uint256 virtualUSDCReserve,uint256 netSoldFromCurve,uint256 controllerFeesUSDC,uint256 lifetimeGrossVolumeUSDC,uint256 createdBlock,address pair,uint256 lpTokenAmount,uint256 lpUSDCUsed,uint256 lpTokenUsed,uint256 burnedAtTransition))"],
      whale
    );

    let transitioned = false;
    for (let i = 0; i < 40 && !transitioned; i++) {
      const state = await shop.market!(aicToken);
      if (Number(state.phase) !== 1) {
        transitioned = true;
        break;
      }
      await (await usdc.mint!(whale.address, USDC(500))).wait();
      await (await usdc.approve!(h.manifest.contracts.agentGoods.proxy, USDC(500))).wait();
      // Measured against CHAIN time, not the host clock: the dividend challenge-window test
      // above warps the chain forward six hours, so a wall-clock deadline is already in the
      // past by the time this runs and the buy reverts with DeadlinePassed.
      const head = await h.provider.getBlock("latest");
      const deadline = Math.max(head?.timestamp ?? 0, Math.floor(Date.now() / 1000)) + 3600;
      await (await shop.buy!(aicToken, USDC(500), 0, deadline)).wait();
    }
    await h.sync();

    const market = await StockMarket.findOne({ chainId: 31337, aicToken }).lean();
    assert.equal(market!.phase, "external_dex", "the market transitioned");
    assert.equal(market!.lpCreated, true);
    assert.ok(market!.pair, "a canonical pair address is indexed");
    assert.ok(BigInt(market!.burnedAIC) > 0n, "the remaining market inventory was burned");
    assert.equal(market!.marketInventoryAIC, "0");

    // Supply conservation survives the burn.
    const aic = new Contract(
      aicToken,
      ["function totalSupply() view returns (uint256)", "function totalBurned() view returns (uint256)"],
      h.provider
    );
    const supply = (await aic.totalSupply!()) as bigint;
    const burned = (await aic.totalBurned!()) as bigint;
    assert.equal(supply + burned, AIC(1_000_000_000), "genesis == supply + burned");

    // A further curve trade is impossible: the transition is one way.
    await assert.rejects(async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      await (await usdc.mint!(whale.address, USDC(10))).wait();
      await (await usdc.approve!(h.manifest.contracts.agentGoods.proxy, USDC(10))).wait();
      await (await shop.buy!(aicToken, USDC(10), 0, deadline)).wait();
    });
  });

  test("every Agent stayed inside its 25 USDC budget and never signed with an API key", async () => {
    for (const agent of [alice, bob, carol]) {
      assert.ok(
        agent.spentUSDC <= PROVING_BUDGET,
        `${agent.name} spent ${agent.spentUSDC}, which must not exceed ${PROVING_BUDGET}`
      );
    }

    // The SDK exposes no way to sign with the key, and the API refuses to act for another wallet.
    const cross = await h.request("GET", `/api/v1/dividends/me?wallet=${alice.address}`, {
      apiKey: await keyFor(bob),
    });
    assert.equal(cross.status, 403);
  });

  test("the API and the indexer reflect every step of the scenario", async () => {
    const store = await h.request("GET", `/api/v1/stores/${storeId}`);
    assert.equal(store.status, 200);
    const view = store.body.store as Record<string, Record<string, never> & Record<string, unknown>>;
    assert.equal(view.protocol.canonical, true);
    assert.equal((view.protocol.governance as Record<string, unknown>).governanceLockActive, false);

    const dividends = await h.request("GET", `/api/v1/dividends/stores/${storeId}`);
    assert.equal(dividends.status, 200);
    assert.ok((dividends.body.epochs as unknown[]).length >= 1);

    const signals = await h.request("GET", `/api/v1/signals/stores/${storeId}`);
    assert.equal(signals.status, 200);
    assert.equal(signals.body.economicWeight, "none");

    const proposals = await h.request("GET", `/api/v1/proposals?storeId=${storeId}`);
    assert.equal(proposals.status, 200);
    assert.ok((proposals.body.items as unknown[]).length >= 1);

    assert.ok(trace.length > 10, "the Agent SDK produced an auditable trace");
  });
});

/** Issues (or rotates) a key for an Agent and returns the raw value for direct HTTP checks. */
/** Mines empty blocks, so a holding window can elapse without any economic activity. */
async function mineBlocks(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await h.provider.send("evm_mine", []);
  }
}

/**
 * The key an Agent is already using, for raw requests this scenario makes outside the SDK.
 *
 * It deliberately does NOT issue or rotate. Rotation invalidates the previous key, so minting a
 * fresh one here and then letting the SDK rotate again left the returned key dead: the request
 * under test answered 401 instead of the status it was actually asserting. Only one key per
 * wallet is ever live, which is the property this helper has to respect rather than fight.
 */
async function keyFor(agent: AicAgent): Promise<string> {
  const existing = agent.currentApiKey;
  if (existing) return existing;
  await agent.onboard();
  const key = agent.currentApiKey;
  assert.ok(key, "agent has an API key after onboarding");
  return key;
}

void ({} as TransactionIntent);
