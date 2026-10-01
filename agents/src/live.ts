/**
 * Continuous local economy.
 *
 * `seed.ts` builds a marketplace once and stops. This keeps it moving: Agents trade the bonding
 * curves, buy products, attest deliveries and signal, indefinitely, so the indexer, the charts
 * and every live figure in the UI have something real to show.
 *
 * Every action goes through the same intent-sign-submit path a production Agent uses. Nothing is
 * faked and no number is written directly into the database: what the screen shows is what the
 * chain did.
 *
 * MASTER_PLAN 0.26.C: activity generated between a handful of local Agents is NOT organic demand
 * and must never be presented as such. This script exists to exercise and demonstrate the system
 * on a local chain. It refuses to run against anything else.
 */

import { Contract, ethers } from "ethers";
import { AicAgent, USDC } from "./sdk";

const API = process.env.ESH_API_URL ?? "http://127.0.0.1:4000";
const RPC = process.env.ESH_RPC_URL ?? "http://127.0.0.1:8545";
const MNEMONIC = "test test test test test test test test test test test junk";

/** Milliseconds between actions. One per second, which is what a live feed should feel like. */
const TICK_MS = Number(process.env.ESH_LIVE_TICK_MS ?? 1000);

const USDC_ABI = [
  "function mint(address,uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

function log(message: string, data?: Record<string, unknown>): void {
  const stamp = new Date().toISOString().slice(11, 19);
  // eslint-disable-next-line no-console
  console.log(`[${stamp}] ${message}`, data ? JSON.stringify(data) : "");
}

function agentAt(name: string, index: number): AicAgent {
  const hd = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  return new AicAgent({
    name,
    apiBaseUrl: API,
    rpcUrl: RPC,
    chainId: 31337,
    privateKey: hd.privateKey,
    // Generous, because this is a local demonstration loop rather than the proving run. The
    // proving Agents of §0.26.C have their own hard 25 USDC budgets.
    budget: { totalUSDC: USDC(2_000_000), maxPerTransactionUSDC: USDC(5000), minReserveUSDC: USDC(1) },
    log: () => undefined,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Small jitter around the tick, so trades do not arrive on a perfect metronome.
 *
 * Deliberately narrow (+/-15%): the cadence should still read as "about once a second", because
 * that is the rate being demonstrated. A wide spread makes a one-second feed look like a
 * three-second one half the time.
 */
function jitter(base: number): number {
  return Math.max(250, Math.round(base * (0.85 + Math.random() * 0.3)));
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

interface LiveStore {
  storeId: string;
  storeAddress: string;
  aicToken: string;
  licenseToken: string;
  symbol: string;
  name: string;
  storeType: "sales" | "rentals";
  products: { productId: string; priceUSDC: bigint; kind: "purchase" | "rent" }[];
  controller: AicAgent;
}

async function loadStores(controllers: AicAgent[]): Promise<LiveStore[]> {
  const res = await fetch(`${API}/api/v1/market/tokens`);
  const body = (await res.json()) as {
    items: {
      aicToken: string;
      storeId: string;
      token: { symbol: string; storeName: string };
      store: { protocol: { storeAddress: string; storeType: "sales" | "rentals"; storeController: string } } | null;
    }[];
  };

  const stores: LiveStore[] = [];
  for (const item of body.items) {
    if (!item.store) continue;
    const controller = controllers.find(
      (c) => c.address.toLowerCase() === item.store!.protocol.storeController.toLowerCase()
    );
    if (!controller) continue;

    const detail = (await (await fetch(`${API}/api/v1/stores/${item.storeId}`)).json()) as {
      store: { protocol: { components: { licenseToken: string } } };
    };
    const products = (await (
      await fetch(`${API}/api/v1/stores/${item.storeId}/products`)
    ).json()) as { items: { protocol: { productId: string; priceUSDC: { base: string } } }[] };

    stores.push({
      storeId: item.storeId,
      storeAddress: item.store.protocol.storeAddress,
      aicToken: item.aicToken,
      licenseToken: detail.store.protocol.components.licenseToken,
      symbol: item.token.symbol,
      name: item.token.storeName,
      storeType: item.store.protocol.storeType,
      products: products.items.map((p) => ({
        productId: p.protocol.productId,
        priceUSDC: BigInt(p.protocol.priceUSDC.base),
        kind: item.store!.protocol.storeType === "rentals" ? "rent" : "purchase",
      })),
      controller,
    });
  }
  return stores;
}

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 31337, name: "hardhat" }, {
    staticNetwork: true,
    cacheTimeout: -1,
  });

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 31337) {
    throw new Error(
      `live.ts refuses to run against chainId ${network.chainId}. Synthetic activity between a ` +
        `handful of Agents is not organic demand and must never be produced on a real network.`
    );
  }

  const deployer = new ethers.Wallet(
    ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/0`).privateKey,
    provider
  );
  const schema = (await (await fetch(`${API}/api/v1/schema`)).json()) as {
    chain: { canonicalUSDC: { address: string } };
  };
  const usdc = new Contract(schema.chain.canonicalUSDC.address, USDC_ABI, deployer);

  const atlas = agentAt("atlas", 1);
  const vector = agentAt("vector", 2);
  const prism = agentAt("prism", 3);
  const traders = [agentAt("nomad", 4), agentAt("quill", 5), agentAt("ember", 6)];
  const controllers = [atlas, vector, prism];
  const everyone = [...controllers, ...traders];

  for (const a of everyone) {
    await a.onboard();
  }

  const stores = await loadStores(controllers);
  if (stores.length === 0) throw new Error("no stores found — run `npx tsx src/seed.ts` first");
  log("live economy started", {
    stores: stores.map((s) => s.symbol),
    tickMs: TICK_MS,
  });

  const attestorFor = new Map(stores.map((s) => [s.licenseToken, s.controller]));
  let tick = 0;
  let nextTickAt = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    tick += 1;
    const trader = pick(traders);
    const store = pick(stores);

    try {
      // Keep wallets solvent. This is a local mock USDC and an explicit part of the demo loop.
      const balance = (await usdc.balanceOf!(trader.address)) as bigint;
      if (balance < USDC(200)) {
        await (await usdc.mint!(trader.address, USDC(3000))).wait();
      }

      // Weighted action mix: mostly curve trading, because that is what the chart shows, with
      // real commerce often enough to keep reserves, licences and signals moving.
      const roll = Math.random();

      if (roll < 0.5) {
        const amount = USDC(3 + Math.floor(Math.random() * 40));
        await trader.tradeAic(store.aicToken, "buy", amount);
        log(`${trader.name} bought ${store.symbol}`, { usdc: Number(amount) / 1e6 });
      } else if (roll < 0.68) {
        const aic = new Contract(
          store.aicToken,
          ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
          trader.wallet
        );
        const held = (await aic.balanceOf!(trader.address)) as bigint;
        if (held > 0n) {
          // A partial exit, so the curve moves down without draining the position.
          const amount = held / BigInt(4 + Math.floor(Math.random() * 6));
          if (amount > 0n) {
            await trader.tradeAic(store.aicToken, "sell", amount);
            log(`${trader.name} sold ${store.symbol}`, { tokens: Number(amount / 10n ** 18n) });
          }
        }
      } else if (roll < 0.92) {
        const product = pick(store.products);
        if (product) {
          const units = 1 + Math.floor(Math.random() * 2);
          await trader.buy(store.storeId, product.productId, units, product.kind);
          log(`${trader.name} ${product.kind === "rent" ? "rented from" : "bought from"} ${store.name}`, {
            units,
          });

          // Attest the delivery and let the buyer signal, so coverage stays honest.
          await trader.waitForIndexer();
          const licenses = (await trader.myLicenses()) as unknown as {
            items: { licenseToken: string; licenseId: string; signal: unknown; delivered?: boolean }[];
          };
          const target = licenses.items.find((l) => l.licenseToken === store.licenseToken && !l.signal);
          if (target) {
            const attestor = attestorFor.get(store.licenseToken)!;
            const lic = new Contract(store.licenseToken, ["function recordAccessGrant(uint256)"], attestor.wallet);
            const grant = await (await lic.recordAccessGrant!(target.licenseId)).wait();
            await trader.waitForIndexer(grant!.blockNumber);
            // Mostly positive, but not unanimously: a 100% record is not a believable one.
            await trader.signal(store.licenseToken, target.licenseId, Math.random() > 0.2);
            log(`${trader.name} signalled on ${store.symbol}`);
          }
        }
      } else {
        // An idle beat. A market with no gaps in it does not look like a market.
        log("quiet tick");
      }
    } catch (error) {
      // A single failed action must never stop the loop: a slippage revert or a budget guard is
      // ordinary Agent life, and stopping here would make the demo look broken when it is not.
      log(`action failed (continuing)`, { error: String(error).slice(0, 140) });
    }

    if (tick % 25 === 0) log(`... ${tick} actions`);

    /*
     * Fixed-rate pacing, not fixed-delay.
     *
     * Sleeping a whole tick AFTER each action makes the real cadence `tick + however long the
     * action took`, so a one-second tick rate showed up as one action every two or three
     * seconds. Scheduling against a running deadline keeps the rate at the requested one, and
     * when an action genuinely overruns the deadline the loop continues immediately rather than
     * accumulating the debt into an ever-later schedule.
     */
    nextTickAt += jitter(TICK_MS);
    const wait = nextTickAt - Date.now();
    if (wait > 0) {
      await sleep(wait);
    } else {
      // Overran. Reset the deadline to now so a slow patch never causes a burst of catch-up
      // actions once things speed back up.
      nextTickAt = Date.now();
    }
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("live economy failed:", error);
  process.exit(1);
});
