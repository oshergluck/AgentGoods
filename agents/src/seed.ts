/**
 * Local demo seed.
 *
 * Drives the real Agent SDK against a locally running stack to produce a realistic economy:
 * several stores, products with and without a token-saving declaration, purchases, delivery
 * attestations, buyer signals, AIC trading and a live governance proposal.
 *
 * It is a demo of the real protocol, not a fixture: every object below is created by the same
 * intent-sign-submit path a production Agent uses, and every number is real chain state.
 */

import { Contract, ethers } from "ethers";
import { AicAgent, USDC, productIdFor } from "./sdk";
import { PRODUCT_DOCS, STORE_PROFILES } from "./catalog";

const API = process.env.ESH_API_URL ?? "http://127.0.0.1:4000";
const RPC = process.env.ESH_RPC_URL ?? "http://127.0.0.1:8545";
const MNEMONIC = "test test test test test test test test test test test junk";

const USDC_ABI = [
  "function mint(address,uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

function log(message: string, data?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(message, data ? JSON.stringify(data) : "");
}

function agentAt(name: string, index: number): AicAgent {
  const hd = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  return new AicAgent({
    name,
    apiBaseUrl: API,
    rpcUrl: RPC,
    chainId: 31337,
    privateKey: hd.privateKey,
    budget: { totalUSDC: USDC(2000), maxPerTransactionUSDC: USDC(400), minReserveUSDC: USDC(1) },
    log,
  });
}

async function waitForIndex(ms = 2200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface SeedStore {
  storeId: string;
  storeAddress: string;
  aicToken: string;
  licenseToken: string;
  governance: string;
}

async function findStore(agent: AicAgent): Promise<SeedStore> {
  const res = (await agent.discovery()) as unknown as { newestStores: Record<string, Record<string, never> & Record<string, unknown>>[] };
  for (const s of res.newestStores) {
    const p = s.protocol as Record<string, never> & Record<string, unknown>;
    if (String(p.storeController).toLowerCase() === agent.address.toLowerCase()) {
      const components = p.components as Record<string, string>;
      return {
        storeId: String(p.storeId),
        storeAddress: String(p.storeAddress),
        aicToken: components.aicToken,
        licenseToken: components.licenseToken,
        governance: components.governance,
      };
    }
  }
  throw new Error(`no store found for ${agent.name}`);
}

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 31337, name: "hardhat" }, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  const deployer = new ethers.Wallet(
    ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/0`).privateKey,
    provider
  );

  const manifestResponse = await fetch(`${API}/api/v1/schema`);
  const schema = (await manifestResponse.json()) as { chain: { canonicalUSDC: { address: string } } };
  const usdcAddress = schema.chain.canonicalUSDC.address;
  const usdc = new Contract(usdcAddress, USDC_ABI, deployer);

  const atlas = agentAt("atlas", 1); // sells datasets, declares savings
  const vector = agentAt("vector", 2); // sells API credits, no declaration
  const prism = agentAt("prism", 3); // rentals
  const buyerA = agentAt("nomad", 4);
  const buyerB = agentAt("quill", 5);
  const buyerC = agentAt("ember", 6);

  const everyone = [atlas, vector, prism, buyerA, buyerB, buyerC];
  for (const a of everyone) {
    await (await usdc.mint!(a.address, USDC(3000))).wait();
    await a.verifyDeployment();
    await a.onboard();
  }
  log("all agents onboarded");

  /* ------------------------------------------------------------ stores */

  await atlas.createStore({
    storeType: "sales",
    aicName: "Atlas Corpus AIC",
    aicSymbol: "ATLS",
    storeName: "Atlas Corpus Works",
  });
  await vector.createStore({
    storeType: "sales",
    aicName: "Vector Credits AIC",
    aicSymbol: "VCTR",
    storeName: "Vector Inference Credits",
  });
  await prism.createStore({
    storeType: "rentals",
    aicName: "Prism Access AIC",
    aicSymbol: "PRSM",
    storeName: "Prism Streaming Access",
  });
  await waitForIndex();

  const atlasStore = await findStore(atlas);
  const vectorStore = await findStore(vector);
  const prismStore = await findStore(prism);
  // Untrusted display content: name, description, logo, media. No protocol meaning whatsoever.
  await atlas.setStoreProfile(atlasStore.storeId, STORE_PROFILES.atlas as never);
  await vector.setStoreProfile(vectorStore.storeId, STORE_PROFILES.vector as never);
  await prism.setStoreProfile(prismStore.storeId, STORE_PROFILES.prism as never);
  await waitForIndex();

  log("stores created", {
    atlas: atlasStore.storeId.slice(0, 10),
    vector: vectorStore.storeId.slice(0, 10),
    prism: prismStore.storeId.slice(0, 10),
  });

  /* ---------------------------------------------------------- products */

  await atlas.createProduct(atlasStore.storeId, {
    productId: "curated-embedding-corpus-v3",
    priceUSDC: USDC(4).toString(),
        contentHash: ethers.keccak256(ethers.toUtf8Bytes("seed-content-" + String(1))),
    inventory: "900",
    metadataURI: JSON.stringify(PRODUCT_DOCS["curated-embedding-corpus-v3"]),
    declaration: { tokensSaved: "2400000", modelTier: "frontier-2025-class", basis: "MEASURED" },
  });
  await atlas.createProduct(atlasStore.storeId, {
    productId: "legal-clause-taxonomy",
    priceUSDC: USDC(12).toString(),
        contentHash: ethers.keccak256(ethers.toUtf8Bytes("seed-content-" + String(2))),
    inventory: "200",
    metadataURI: JSON.stringify(PRODUCT_DOCS["legal-clause-taxonomy"]),
    declaration: { tokensSaved: "5100000", modelTier: "frontier-2025-class", basis: "ESTIMATED" },
  });
  await atlas.createProduct(atlasStore.storeId, {
    productId: "raw-scrape-dump",
    priceUSDC: USDC(1).toString(),
        contentHash: ethers.keccak256(ethers.toUtf8Bytes("seed-content-" + String(3))),
    inventory: "9999",
    metadataURI: JSON.stringify(PRODUCT_DOCS["raw-scrape-dump"]),
    declaration: null,
  });

  await vector.createProduct(vectorStore.storeId, {
    productId: "inference-credits-1m",
    priceUSDC: USDC(9).toString(),
        contentHash: ethers.keccak256(ethers.toUtf8Bytes("seed-content-" + String(4))),
    unlimitedInventory: true,
    metadataURI: JSON.stringify(PRODUCT_DOCS["inference-credits-1m"]),
    declaration: { tokensSaved: "1000000", modelTier: "mid-2025-class", basis: "MEASURED" },
  });
  await vector.createProduct(vectorStore.storeId, {
    productId: "eval-harness-suite",
    priceUSDC: USDC(6).toString(),
        contentHash: ethers.keccak256(ethers.toUtf8Bytes("seed-content-" + String(5))),
    inventory: "400",
    metadataURI: JSON.stringify(PRODUCT_DOCS["eval-harness-suite"]),
    declaration: null,
  });

  await prism.createProduct(prismStore.storeId, {
    productId: "realtime-market-feed",
    priceUSDC: USDC(2).toString(),
        contentHash: ethers.keccak256(ethers.toUtf8Bytes("seed-content-" + String(6))),
    inventory: "50",
    rentalPeriodSeconds: 86400,
    metadataURI: JSON.stringify(PRODUCT_DOCS["realtime-market-feed"]),
    declaration: { tokensSaved: "180000", modelTier: "small-2025-class", basis: "ESTIMATED" },
  });
  await waitForIndex();
  log("products listed");

  /* ------------------------------------------- AIC markets and incentive */

  await atlas.tradeAic(atlasStore.aicToken, "buy", USDC(120));
  await vector.tradeAic(vectorStore.aicToken, "buy", USDC(60));
  await buyerA.tradeAic(atlasStore.aicToken, "buy", USDC(300));
  await buyerB.tradeAic(atlasStore.aicToken, "buy", USDC(150));
  await buyerC.tradeAic(vectorStore.aicToken, "buy", USDC(90));
  await waitForIndex();

  // Fund a real customer incentive with market-bought AIC.
  const atlasAic = new Contract(
    atlasStore.aicToken,
    ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
    atlas.wallet
  );
  const held = (await atlasAic.balanceOf!(atlas.address)) as bigint;
  const pool = held / 2n;
  await (await atlasAic.approve!(atlasStore.storeAddress, pool)).wait();
  await (
    await new Contract(
      atlasStore.storeAddress,
      ["function depositRewardPool(uint256) returns (uint256)"],
      atlas.wallet
    ).depositRewardPool!(pool)
  ).wait();
  log("atlas funded a customer AIC incentive pool");

  // Designate each store's delivery witness.
  await atlas.setAccessAttestor(atlasStore.storeId, atlas.address);
  await vector.setAccessAttestor(vectorStore.storeId, vector.address);
  await prism.setAccessAttestor(prismStore.storeId, prism.address);
  await waitForIndex();

  /* -------------------------------------------- purchases and signals */

  const attestors: Record<string, AicAgent> = {
    [atlasStore.licenseToken]: atlas,
    [vectorStore.licenseToken]: vector,
    [prismStore.licenseToken]: prism,
  };

  async function buyDeliverSignal(
    buyer: AicAgent,
    store: SeedStore,
    productSlug: string,
    units: number,
    worthIt: boolean,
    kind: "purchase" | "rent" = "purchase"
  ): Promise<void> {
    await buyer.buy(store.storeId, productIdFor(productSlug), units, kind);
    await buyer.waitForIndexer();

    const licenses = (await buyer.myLicenses()) as unknown as {
      items: { licenseToken: string; licenseId: string; signal: unknown }[];
    };
    const target = licenses.items.find((l) => l.licenseToken === store.licenseToken && !l.signal);
    if (!target) return;

    const attestor = attestors[store.licenseToken]!;
    const lic = new Contract(
      store.licenseToken,
      ["function recordAccessGrant(uint256)"],
      attestor.wallet
    );
    const grant = await (await lic.recordAccessGrant!(target.licenseId)).wait();
    // The signal endpoint checks delivery against the projection, so wait for the grant to
    // be indexed rather than guessing at a sleep duration.
    await buyer.waitForIndexer(grant!.blockNumber);
    await buyer.signal(store.licenseToken, target.licenseId, worthIt);
  }

  // Atlas builds a genuine track record: six delivered signals, mostly positive.
  await buyDeliverSignal(buyerA, atlasStore, "curated-embedding-corpus-v3", 1, true);
  await buyDeliverSignal(buyerB, atlasStore, "curated-embedding-corpus-v3", 2, true);
  await buyDeliverSignal(buyerC, atlasStore, "curated-embedding-corpus-v3", 1, true);
  await buyDeliverSignal(buyerA, atlasStore, "legal-clause-taxonomy", 1, true);
  await buyDeliverSignal(buyerB, atlasStore, "legal-clause-taxonomy", 1, false);
  await buyDeliverSignal(buyerC, atlasStore, "raw-scrape-dump", 3, true);
  log("atlas has a delivered track record");

  // Vector sells but attests fewer deliveries, so its coverage is visibly lower.
  await buyDeliverSignal(buyerA, vectorStore, "inference-credits-1m", 1, true);
  await buyerB.buy(vectorStore.storeId, productIdFor("eval-harness-suite"), 1);
  await buyerC.buy(vectorStore.storeId, productIdFor("inference-credits-1m"), 1);
  log("vector has purchases with partial delivery attestation");

  // Prism rents.
  await buyDeliverSignal(buyerA, prismStore, "realtime-market-feed", 7, true, "rent");
  await buyDeliverSignal(buyerB, prismStore, "realtime-market-feed", 3, false, "rent");
  await waitForIndex();

  /* ------------------------------------------------------- governance */

  const contentHash = ethers.keccak256(
    ethers.toUtf8Bytes("Publish a dated changelog with every corpus revision")
  );
  await buyerA.propose(atlasStore.storeId, contentHash, "ipfs://proposals/atlas-changelog", 7 * 24 * 3600);
  await waitForIndex();

  const proposals = (await (await fetch(`${API}/api/v1/proposals?storeId=${atlasStore.storeId}`)).json()) as {
    items: { protocol: { proposalId: string } }[];
  };
  const proposalId = proposals.items[0]?.protocol.proposalId;
  if (proposalId) {
    // A NO vote from a smaller holder keeps the proposal live and interesting to look at.
    await buyerB.vote(atlasStore.governance, proposalId, false);
    log("governance proposal is live", { proposalId });
  }

  await waitForIndex();
  log("seed complete");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("seed failed:", error);
  process.exit(1);
});
