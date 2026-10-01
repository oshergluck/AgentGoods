/**
 * Backend integration harness.
 *
 * Boots the REAL stack against a REAL local chain: an in-memory MongoDB, a Hardhat node with
 * the canonical contracts actually deployed, the real indexer, and the real Express app. No
 * route, projection or aggregate is mocked, because the things most worth testing here are
 * exactly the ones a mock would paper over: event decoding, reorg rollback, exactly-once
 * projection, zero-RPC reads and the Phase 10.1 aggregation rules.
 */

import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ethers, JsonRpcProvider, Wallet, Contract } from "ethers";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env";
import { loadManifest, type ProtocolManifest } from "../../src/config/manifest";
import { AbiRegistry } from "../../src/indexer/abis";
import { Indexer } from "../../src/indexer/indexer";
import { ProviderPool } from "../../src/rpc/provider";
import { createApp } from "../../src/app";
import type { AppContext } from "../../src/http/context";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");

/*
 * Every test FILE gets its own chain port and its own manifest directory.
 *
 * `node --test` runs each file in its own process. Sharing one Hardhat port meant the second
 * process silently attached to the first one chain, and sharing `deployments/31337.json` meant
 * the second deployment overwrote the manifest the first process had already loaded — so a
 * suite that passed alone failed when run beside another, with errors that pointed at the
 * protocol rather than at the collision. Isolating both makes the files independent.
 */
const WORKER_SLOT = Math.abs(hashString(process.env.NODE_TEST_CONTEXT ? entryName() : entryName())) % 50;
const RPC_PORT = Number(process.env.HARNESS_RPC_PORT ?? 18545 + WORKER_SLOT);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const DEPLOYMENTS_DIR = path.join(REPO_ROOT, "deployments", `.test-${WORKER_SLOT}`);

/** Name of the test file that loaded this harness, used to derive a stable per-file slot. */
function entryName(): string {
  const arg = process.argv.find((a) => a.endsWith(".test.ts"));
  return arg ? path.basename(arg) : "default";
}

function hashString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0;
  return h;
}

export interface Harness {
  env: Env;
  manifest: ProtocolManifest;
  ctx: AppContext;
  indexer: Indexer;
  provider: JsonRpcProvider;
  server: http.Server;
  baseUrl: string;
  signers: Wallet[];
  contracts: {
    usdc: Contract;
    registry: Contract;
    agentGoods: Contract;
    factory: Contract;
  };
  /** Advances the indexer to the chain head. */
  sync(): Promise<void>;
  request(method: string, urlPath: string, options?: RequestOptions): Promise<ApiResponse>;
  stop(): Promise<void>;
}

export interface RequestOptions {
  body?: unknown;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, never> & Record<string, unknown>;
}

let nodeProcess: ChildProcess | null = null;

/** Starts a Hardhat node once per test process and deploys the canonical protocol to it. */
export async function startChain(): Promise<void> {
  if (nodeProcess) return;

  nodeProcess = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["hardhat", "node", "--port", String(RPC_PORT), "--hostname", "127.0.0.1"],
    { cwd: CONTRACTS_DIR, stdio: "ignore", shell: process.platform === "win32" }
  );

  const provider = new JsonRpcProvider(RPC_URL, { chainId: 31337, name: "hardhat" }, { staticNetwork: true });
  for (let i = 0; i < 120; i++) {
    try {
      await provider.getBlockNumber();
      provider.destroy();
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("Hardhat node did not become reachable");
}

export async function deployProtocol(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["hardhat", "run", "script/deploy.js", "--network", "localhost"],
      {
        cwd: CONTRACTS_DIR,
        stdio: "pipe",
        shell: process.platform === "win32",
        env: {
          ...process.env,
          HARDHAT_NETWORK: "localhost",
          LOCALHOST_PORT: String(RPC_PORT),
          DEPLOYMENTS_OUT_DIR: DEPLOYMENTS_DIR,
        },
      }
    );
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`deploy failed: ${stderr}`))));
  });
}

export async function createHarness(): Promise<Harness> {
  await startChain();
  await deployProtocol();

  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri("aic-test");

  resetEnvCache();
  const env = loadEnv({
    ...process.env,
    NODE_ENV: "test",
    ESH_ENVIRONMENT: "LOCAL",
    CHAIN_ID: "31337",
    DEPLOYMENTS_DIR,
    MONGODB_URI: uri,
    RPC_HTTP_URL: RPC_URL,
    SAFE_CONFIRMATIONS: "0",
    INDEXER_ENABLED: "false",
    INDEXER_STALE_BLOCKS: "1000",
    LOG_LEVEL: "fatal",
    API_KEY_PEPPER: "test-pepper-value-not-a-production-secret",
    PUBLIC_BASE_URL: "http://127.0.0.1:4000",
    CORS_ORIGINS: "http://127.0.0.1:5173",
    // Generous limits so the suite exercises behaviour, not throttling.
    RATE_LIMIT_GLOBAL_PER_MIN: "100000",
    RATE_LIMIT_CHALLENGE_PER_MIN: "10000",
    RATE_LIMIT_KEY_OPS_PER_MIN: "10000",
  } as NodeJS.ProcessEnv);

  const manifest = loadManifest({
    deploymentsDir: DEPLOYMENTS_DIR,
    chainId: 31337,
    environment: "LOCAL",
  });

  await mongoose.connect(uri);
  await mongoose.syncIndexes().catch(() => undefined);

  const abis = new AbiRegistry(path.join(DEPLOYMENTS_DIR, "abi")).load();
  const providers = new ProviderPool({ primaryUrl: RPC_URL, chainId: 31337 });

  const indexer = new Indexer({
    manifest,
    providers,
    abis,
    safeConfirmations: 0,
    maxReorgDepth: 32,
    backfillChunk: 500,
    pollIntervalMs: 100000,
    staleBlocks: 1000,
  });
  await indexer.init();

  const ctx: AppContext = {
    env,
    manifest,
    providers,
    abis,
    indexer,
    indexerStatus: () => indexer.getStatus(),
    startedAt: new Date(),
  };

  const app = createApp(ctx);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const provider = new JsonRpcProvider(
    RPC_URL,
    { chainId: 31337, name: "hardhat" },
    // ethers caches eth_getTransactionCount for a short window. Hardhat mines instantly, so
    // two sequential transactions from one wallet would otherwise reuse a stale nonce.
    { staticNetwork: true, cacheTimeout: -1 }
  );
  const signers = hardhatWallets(provider);

  const contracts = {
    usdc: new Contract(manifest.external.canonicalUSDC, USDC_ABI, signers[0]),
    registry: new Contract(manifest.contracts.registry.proxy, abis.abiFor("AICRegistry") as never, signers[0]),
    agentGoods: new Contract(manifest.contracts.agentGoods.proxy, abis.abiFor("AgentGoods") as never, signers[0]),
    factory: new Contract(
      manifest.contracts.activeFactories[0]!.address,
      abis.abiFor("StoreFactory") as never,
      signers[0]
    ),
  };

  return {
    env,
    manifest,
    ctx,
    indexer,
    provider,
    server,
    baseUrl,
    signers,
    contracts,
    /**
     * Bring the projection up to the current chain head.
     *
     * One `tick()` is not enough to guarantee that. A tick indexes up to the head it observed
     * when it started, so any block produced while it was running is left behind, and the next
     * caller then quotes against state the SDK correctly refuses as stale. That showed up as a
     * `waitForIndexer` timeout in a test that had "already synced", and it moved around the
     * suite as unrelated tests changed how many blocks they produced. Looping until the
     * projection actually reaches the head makes `sync()` mean what every call site assumes.
     */
    async sync() {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        await indexer.tick();
        const head = await provider.getBlockNumber();
        if (indexer.getStatus().indexedBlock >= head) return;
      }
      throw new Error(
        `indexer did not reach the chain head after 25 ticks ` +
          `(indexed ${indexer.getStatus().indexedBlock}, head ${await provider.getBlockNumber()})`
      );
    },
    async request(method, urlPath, options = {}) {
      return httpRequest(baseUrl + urlPath, method, options);
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await providers.destroy();
      provider.destroy();
      await mongoose.disconnect();
      await mongod.stop();
    },
  };
}

export async function stopChain(): Promise<void> {
  if (nodeProcess) {
    nodeProcess.kill();
    nodeProcess = null;
    await sleep(200);
  }
}

/** The standard Hardhat mnemonic accounts, so the harness and the chain agree. */
function hardhatWallets(provider: JsonRpcProvider): Wallet[] {
  const mnemonic = "test test test test test test test test test test test junk";
  const wallets: Wallet[] = [];
  for (let i = 0; i < 20; i++) {
    const hd = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`);
    wallets.push(new Wallet(hd.privateKey, provider));
  }
  return wallets;
}

async function httpRequest(url: string, method: string, options: RequestOptions): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.headers ?? {}),
  };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const response = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  const outHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => (outHeaders[k] = v));

  return { status: response.status, headers: outHeaders, body: body as never };
}

export const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
];

/** Every product must declare its tokens on chain now; fixtures that do not care about the value use this one. */
export const UNDECLARED = {
  tokensSaved: 1000n,
  modelTier: "0x6770742d362d6c756e6100000000000000000000000000000000000000000000", // "gpt-6-luna"
  basis: 1,
  declaredAt: 0n,
};

/** A listing with no declaration, which the contract now refuses. */
export const NO_DECLARATION = {
  tokensSaved: 0n,
  modelTier: "0x" + "00".repeat(32),
  basis: 0,
  declaredAt: 0n,
};

export function declaration(tokensSaved: bigint | number, modelTier: string, basis: 1 | 2 = 2) {
  return {
    tokensSaved: BigInt(tokensSaved),
    modelTier: ethers.encodeBytes32String(modelTier),
    basis,
    declaredAt: 0n,
  };
}

export const USDC = (n: number | string): bigint => ethers.parseUnits(String(n), 6);
export const AIC = (n: number | string): bigint => ethers.parseUnits(String(n), 18);

/** The protocol minimum every new store is created with (StoreFactory.MIN_INITIAL_OWNER_SEED_USDC). */
export const MIN_SEED = 5_000_000n;

/**
 * Creates a store directly through the factory, funding and approving its owner seed first. Every
 * store is now born with owner-funded initial market capital; a bare createStore call reverts.
 */
export async function createStoreOnChain(
  h: Harness,
  creator: Wallet,
  type: 0 | 1,
  aicName: string,
  aicSymbol: string,
  storeName: string,
  seedUSDC: bigint = MIN_SEED
) {
  await (await h.contracts.usdc.mint(creator.address, seedUSDC)).wait();
  const usdc = new Contract(h.manifest.external.canonicalUSDC, USDC_ABI, creator);
  await (await usdc.approve(await h.contracts.factory.getAddress(), seedUSDC)).wait();
  const factory = h.contracts.factory.connect(creator) as Contract;
  return factory.createStore(type, aicName, aicSymbol, storeName, seedUSDC);
}
