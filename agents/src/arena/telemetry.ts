/**
 * Economic telemetry for economy runs (Arena 4), read from the chain.
 *
 * Nothing here is shown to an agent and nothing here rewards anything. It records what happened so
 * the report can say what the agents actually did:
 *
 *  - every transaction an agent sent (by hash, from its own action ledger), decoded once and cached;
 *  - every sale made by a store an agent created (CommerceSettled on those stores), whoever bought;
 *  - from those, per-agent business metrics at a given block, the list of purchases with the reason
 *    the agent gave, and the payment edges of the economy network.
 *
 * Classification is by the events a transaction emitted, never by what an agent said about it.
 */
import { Contract, Interface, ethers, type JsonRpcProvider, type Log } from "ethers";
import { inferenceCostBase, type ActionRecord, type AgentRecord, type RunState } from "./ledger";
import { creditAvailableBase, creditUsedBase, financingFeesBase, outstandingBase, type EconomyState } from "./economy";

export const EVENTS = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event TokensPurchased(address indexed aicToken, address indexed buyer, uint256 grossUSDC, uint256 protocolFeeUSDC, uint256 controllerFeeUSDC, uint256 netCurveUSDC, uint256 tokensOut, uint256 netSoldFromCurve, uint256 virtualUSDCReserve, uint256 virtualTokenReserve)",
  "event TokensSold(address indexed aicToken, address indexed seller, uint256 tokensIn, uint256 grossUSDC, uint256 protocolFeeUSDC, uint256 controllerFeeUSDC, uint256 netUSDCOut, uint256 netSoldFromCurve, uint256 virtualUSDCReserve, uint256 virtualTokenReserve)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event StoreCreated(bytes32 indexed storeId, address indexed store, address indexed creator, address aicToken, address licenseToken, address governance, address dividendDistributor, uint8 storeType, uint64 factoryVersion, string storeName, string aicName, string aicSymbol)",
  "event InitialOwnerSeed(bytes32 indexed storeId, address indexed creator, address indexed aicToken, uint256 seedUSDC, uint256 tokensOut)",
  "event ProductCreated(bytes32 indexed productId, uint64 version, uint128 priceUSDC, uint64 inventory, uint32 rentalPeriodSeconds, bytes32 contentHash, string metadataURI)",
  "event CommerceSettled(bytes32 indexed productId, address indexed buyer, uint256 indexed licenseId, uint32 units, uint256 grossUSDC, uint256 protocolFeeUSDC, uint256 netUSDC, uint256 holderReserveUSDC, uint256 ownerAvailableUSDC, uint256 rewardAIC, uint64 expiresAt)",
  "event RewardPoolFunded(address indexed from, uint256 amount, uint256 newPool)",
  "event OwnerProceedsWithdrawn(address indexed to, uint256 amount, uint256 remainingOwnerAvailable)",
  "event ControllerFeesWithdrawn(address indexed aicToken, address indexed controller, uint256 amount)",
  "event ProductUpdated(bytes32 indexed productId, uint64 version, uint128 priceUSDC, uint64 inventory, uint32 rentalPeriodSeconds, bool active, bytes32 contentHash, string metadataURI)",
]);

const COMMERCE_TOPIC = EVENTS.getEvent("CommerceSettled")!.topicHash;
const TRANSFER_TOPIC = EVENTS.getEvent("Transfer")!.topicHash;
const pad = (a: string): string => ethers.zeroPadValue(a.toLowerCase(), 32);

/*
 * The public RPC refuses log queries wider than 1,000 blocks; the faucet's scans use the same ceiling.
 */
const LOG_CHUNK = 1_000;

export interface DecodedEvent {
  name: string;
  address: string;
  logIndex: number;
  args: Record<string, string>;
}

export interface DecodedTx {
  hash: string;
  block: number;
  timestamp: number;
  from: string;
  status: number;
  events: DecodedEvent[];
}

export interface Sale {
  id: string;
  block: number;
  timestamp: number;
  store: string;
  sellerAgentId: string | null;
  buyer: string;
  buyerAgentId: string | null;
  productId: string;
  grossBase: string;
  ownerBase: string;
  buybackBase: string;
  rewardAIC: string;
  txHash: string;
}

export interface Purchase extends Sale {
  /** Why the buying agent said it bought, in its own words (telemetry, never a reward input). */
  reason: string;
  intentReason: string;
}

export interface Transfer {
  from: string;
  to: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  amountBase: string;
  block: number;
  timestamp: number;
  txHash: string;
}

export interface TradeFlow {
  token: string;
  own: boolean;
  usdcSpentBase: string;
  usdcReceivedBase: string;
  tokensBought: string;
  tokensSold: string;
  trades: number;
}

export interface AgentMetrics {
  agentId: string;
  name: string;
  block: number;
  cashBase: string;
  liabilitiesBase: string;
  creditUsedBase: string;
  creditAvailableBase: string;
  financingFeesBase: string;
  repaidBase: string;
  holdings: { token: string; amount: string; exitValueBase: string; own: boolean }[];
  holdingsValueBase: string;
  storeProceedsBase: string;
  /** Trading fees the agent's own store token earned it: withdrawn to its wallet, and still accrued. */
  marketFeesWithdrawnBase: string;
  marketFeesAccruedBase: string;
  equityEstimateBase: string;
  revenueGrossBase: string;
  revenueNetBase: string;
  salesCount: number;
  a2aSalesBase: string;
  externalSalesBase: string;
  uniqueBuyers: number;
  repeatBuyers: number;
  purchasesBase: string;
  purchasesCount: number;
  a2aPurchasesBase: string;
  uniqueSellers: number;
  repeatSellers: number;
  productsCreated: number;
  productsSold: number;
  storesCreated: number;
  seedBase: string;
  ownTokenBuysBase: string;
  businessInvestmentBase: string;
  marketingAIC: string;
  marketingEstimateBase: string;
  /** Model tokens at list price and gas at a fixed ETH price: operating expenses, deducted from equity. */
  inferenceCostBase: string;
  gasCostBase: string;
  operatingProfitBase: string;
  operatingCashFlowBase: string;
  directTransfersInBase: string;
  directTransfersOutBase: string;
  trades: number;
  tradingVolumeBase: string;
  flows: TradeFlow[];
  counterparties: number;
}

export interface TelemetryInput {
  provider: JsonRpcProvider;
  state: RunState;
  usdcAddress: string;
  agentGoodsAddress: string;
  dexRouter?: string;
  operatorAddress: string;
  aicTokens: string[];
  upToBlock: number;
}

const lc = (a: string): string => a.toLowerCase();
const HASH = /0x[0-9a-fA-F]{64}/g;

/** The transaction hashes an agent's own confirmed send_transaction actions produced. */
export function agentTxHashes(state: RunState, agentId: string): string[] {
  const out: string[] = [];
  for (const a of state.actions) {
    if (a.agentId !== agentId || a.action !== "send_transaction" || !a.ok) continue;
    const m = /confirmed (0x[0-9a-fA-F]{64})/.exec(a.detail) ?? a.detail.match(HASH);
    const h = Array.isArray(m) ? (m[1] ?? m[0]) : null;
    if (h) out.push(lc(h));
  }
  return [...new Set(out)];
}

const blockTimes = new Map<number, number>();
async function blockTime(provider: JsonRpcProvider, n: number): Promise<number> {
  const hit = blockTimes.get(n);
  if (hit !== undefined) return hit;
  const b = await provider.getBlock(n);
  const t = b?.timestamp ?? 0;
  blockTimes.set(n, t);
  return t;
}

function decodeLog(log: Log): DecodedEvent | null {
  try {
    const parsed = EVENTS.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) return null;
    const args: Record<string, string> = {};
    parsed.fragment.inputs.forEach((input, i) => {
      const v = parsed.args[i];
      args[input.name] = typeof v === "bigint" ? v.toString() : String(v);
    });
    return { name: parsed.name, address: lc(log.address), logIndex: log.index, args };
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Every transaction that moved USDC to or from an agent, or touched an agent's store, found from the
 * chain itself. Parsing hashes out of action text alone missed transactions whose result was worded
 * differently; the chain does not. Scanned incrementally, so each pass reads only new blocks.
 */
async function discoverUsdcTxHashes(input: TelemetryInput): Promise<string[]> {
  const eco = input.state.economy!;
  if (eco.startBlock === undefined) return [];
  const wallets = input.state.agents.map((a) => pad(a.address));
  const found = new Set<string>();
  const from = eco.scannedTo !== undefined ? eco.scannedTo + 1 : eco.startBlock;
  for (let b = from; b <= input.upToBlock; b += LOG_CHUNK) {
    const to = Math.min(input.upToBlock, b + LOG_CHUNK - 1);
    const results = await Promise.all([
      input.provider.getLogs({ address: input.usdcAddress, topics: [TRANSFER_TOPIC, wallets], fromBlock: b, toBlock: to }),
      input.provider.getLogs({ address: input.usdcAddress, topics: [TRANSFER_TOPIC, null, wallets], fromBlock: b, toBlock: to }),
    ]);
    for (const logs of results) for (const log of logs) found.add(lc(log.transactionHash));
  }
  if (input.upToBlock > (eco.scannedTo ?? -1)) eco.scannedTo = input.upToBlock;
  return [...found];
}

/** Every event of each agent store since the block it was created, each store on its own cursor. */
async function discoverStoreTxHashes(input: TelemetryInput): Promise<string[]> {
  const eco = input.state.economy!;
  eco.storeScannedTo ??= {};
  const found = new Set<string>();
  for (const st of Object.values(eco.stores ?? {})) {
    const from = eco.storeScannedTo[st.store] !== undefined ? eco.storeScannedTo[st.store]! + 1 : st.block;
    for (let b = from; b <= input.upToBlock; b += LOG_CHUNK) {
      const to = Math.min(input.upToBlock, b + LOG_CHUNK - 1);
      for (const log of await input.provider.getLogs({ address: st.store, fromBlock: b, toBlock: to })) found.add(lc(log.transactionHash));
    }
    if (input.upToBlock > (eco.storeScannedTo[st.store] ?? -1)) eco.storeScannedTo[st.store] = input.upToBlock;
  }
  return [...found];
}

/** Decode every agent transaction not yet cached, up to `upToBlock`. */
export async function refreshTxCache(input: TelemetryInput): Promise<void> {
  const eco = input.state.economy!;
  eco.txCache ??= {};
  const pending: string[] = [];
  for (const agent of input.state.agents) {
    for (const h of agentTxHashes(input.state, agent.id)) if (!eco.txCache[h]) pending.push(h);
  }
  // Stores first (their events are part of discovery), then everything the chain shows.
  await decodeInto(input, pending);
  // Then everything the chain shows: USDC moved to or from an agent, and events on agent stores
  // (stores are known only once their creation is decoded, so they are scanned after).
  const fromUsdc = (await discoverUsdcTxHashes(input)).filter((h) => !eco.txCache![h]);
  await decodeInto(input, fromUsdc);
  const fromStores = (await discoverStoreTxHashes(input)).filter((h) => !eco.txCache![h]);
  await decodeInto(input, fromStores);
}

async function decodeInto(input: TelemetryInput, pending: string[]): Promise<void> {
  const eco = input.state.economy!;
  await mapLimit(pending, 6, async (hash) => {
    const receipt = await input.provider.getTransactionReceipt(hash).catch(() => null);
    if (!receipt || receipt.blockNumber > input.upToBlock) return;
    eco.txCache![hash] = {
      hash,
      block: receipt.blockNumber,
      timestamp: await blockTime(input.provider, receipt.blockNumber),
      from: lc(receipt.from),
      status: receipt.status ?? 0,
      events: receipt.logs.map(decodeLog).filter((e): e is DecodedEvent => e !== null),
    };
  });
  indexStores(input);
}

/** Stores created by agents, from their own creation receipts. */
function indexStores(input: TelemetryInput): void {
  const eco = input.state.economy!;
  eco.stores ??= {};
  const agentWallets = new Set(input.state.agents.map((a) => lc(a.address)));
  for (const tx of Object.values(eco.txCache ?? {})) {
    for (const e of tx.events) {
      if (e.name !== "StoreCreated" || !agentWallets.has(lc(e.args.creator!))) continue;
      eco.stores[lc(e.args.store!)] = {
        store: lc(e.args.store!),
        aicToken: lc(e.args.aicToken!),
        creator: lc(e.args.creator!),
        storeId: e.args.storeId!,
        name: e.args.storeName ?? "",
        symbol: e.args.aicSymbol ?? "",
        block: tx.block,
      };
    }
  }
}

/** Every sale made by an agent's store, from the run's start to `upToBlock`. */
export async function agentStoreSales(input: TelemetryInput): Promise<Sale[]> {
  const eco = input.state.economy!;
  const stores = Object.keys(eco.stores ?? {});
  if (stores.length === 0 || eco.startBlock === undefined) return [];
  const byWallet = new Map(input.state.agents.map((a) => [lc(a.address), a.id]));
  const out: Sale[] = [];
  for (let from = eco.startBlock; from <= input.upToBlock; from += LOG_CHUNK) {
    const to = Math.min(input.upToBlock, from + LOG_CHUNK - 1);
    const logs = await input.provider.getLogs({ address: stores, topics: [COMMERCE_TOPIC], fromBlock: from, toBlock: to }).catch(() => [] as Log[]);
    for (const log of logs) {
      const e = decodeLog(log);
      if (!e) continue;
      const store = eco.stores![lc(log.address)]!;
      out.push(saleFrom(e, log.transactionHash, log.blockNumber, await blockTime(input.provider, log.blockNumber), store.creator, byWallet));
    }
  }
  return out;
}

function saleFrom(e: DecodedEvent, txHash: string, block: number, timestamp: number, sellerWallet: string | null, byWallet: Map<string, string>): Sale {
  const gross = BigInt(e.args.grossUSDC ?? "0");
  return {
    id: `${lc(txHash)}:${e.logIndex}`,
    block,
    timestamp,
    store: e.address,
    sellerAgentId: sellerWallet ? byWallet.get(sellerWallet) ?? null : null,
    buyer: lc(e.args.buyer!),
    buyerAgentId: byWallet.get(lc(e.args.buyer!)) ?? null,
    productId: e.args.productId!,
    grossBase: gross.toString(),
    ownerBase: e.args.ownerAvailableUSDC ?? "0",
    buybackBase: e.args.holderReserveUSDC ?? "0",
    rewardAIC: e.args.rewardAIC ?? "0",
    txHash: lc(txHash),
  };
}

/**
 * Every purchase an agent made (any store), with the reason it gave: the rationale of the action that
 * sent the transaction, and of the most recent purchase request for that product before it.
 */
export function agentPurchases(state: RunState): Purchase[] {
  const eco = state.economy!;
  const byWallet = new Map(state.agents.map((a) => [lc(a.address), a.id]));
  const storeCreator = new Map(Object.values(eco.stores ?? {}).map((s) => [s.store, s.creator]));
  const actionsByAgent = new Map<string, ActionRecord[]>();
  for (const a of state.actions) (actionsByAgent.get(a.agentId) ?? actionsByAgent.set(a.agentId, []).get(a.agentId)!).push(a);
  const out: Purchase[] = [];
  for (const tx of Object.values(eco.txCache ?? {})) {
    for (const e of tx.events) {
      if (e.name !== "CommerceSettled") continue;
      const buyerId = byWallet.get(lc(e.args.buyer!));
      if (!buyerId) continue;
      const sale = saleFrom(e, tx.hash, tx.block, tx.timestamp, storeCreator.get(e.address) ?? null, byWallet);
      const acts = actionsByAgent.get(buyerId) ?? [];
      const txIndex = acts.findIndex((a) => a.action === "send_transaction" && a.detail.toLowerCase().includes(tx.hash));
      const pid = (e.args.productId ?? "").toLowerCase();
      let intentReason = "";
      for (let i = (txIndex >= 0 ? txIndex : acts.length) - 1; i >= 0; i--) {
        const d = acts[i]!.detail.toLowerCase();
        if (/purchase|quote/.test(d) && d.includes(pid.slice(0, 18))) {
          intentReason = acts[i]!.rationale ?? "";
          break;
        }
      }
      out.push({ ...sale, reason: txIndex >= 0 ? acts[txIndex]!.rationale ?? "" : "", intentReason });
    }
  }
  return out.sort((a, b) => a.block - b.block);
}

/** USDC moved directly between an agent and another wallet, outside any purchase or trade. */
export function directTransfers(state: RunState, usdcAddress: string, operatorAddress: string): Transfer[] {
  const eco = state.economy!;
  const byWallet = new Map(state.agents.map((a) => [lc(a.address), a.id]));
  const out: Transfer[] = [];
  for (const tx of Object.values(eco.txCache ?? {})) {
    const names = new Set(tx.events.map((e) => e.name));
    if (names.has("CommerceSettled") || names.has("TokensPurchased") || names.has("TokensSold") || names.has("Swap") || names.has("InitialOwnerSeed")) continue;
    for (const e of tx.events) {
      if (e.name !== "Transfer" || e.address !== lc(usdcAddress)) continue;
      const from = lc(e.args.from!);
      const to = lc(e.args.to!);
      if (to === lc(operatorAddress)) continue; // repayments are liabilities, not commerce
      if (!byWallet.has(from)) continue;
      out.push({
        from, to,
        fromAgentId: byWallet.get(from) ?? null,
        toAgentId: byWallet.get(to) ?? null,
        amountBase: e.args.value ?? "0",
        block: tx.block, timestamp: tx.timestamp, txHash: tx.hash,
      });
    }
  }
  return out;
}

/** Token trades by an agent, from the token transfers its own trade transactions caused. */
function tradeFlows(agent: AgentRecord, txs: DecodedTx[], usdcAddress: string, ownTokens: Set<string>, aicTokens: Set<string>): { flows: TradeFlow[]; seedBase: bigint; tradeVolumeBase: bigint } {
  const me = lc(agent.address);
  const flows = new Map<string, TradeFlow>();
  let seed = 0n;
  let tradeVolume = 0n;
  for (const tx of txs) {
    const names = new Set(tx.events.map((e) => e.name));
    if (tx.from !== me) continue;
    const isTrade = (names.has("TokensPurchased") || names.has("TokensSold") || names.has("Swap")) && !names.has("CommerceSettled");
    const isSeed = names.has("InitialOwnerSeed");
    if (!isTrade && !isSeed) continue;
    let usdcDelta = 0n;
    const tokenDelta = new Map<string, bigint>();
    for (const e of tx.events) {
      if (e.name !== "Transfer") continue;
      const v = BigInt(e.args.value ?? "0");
      const from = lc(e.args.from!);
      const to = lc(e.args.to!);
      if (e.address === lc(usdcAddress)) {
        if (from === me) usdcDelta -= v;
        if (to === me) usdcDelta += v;
      } else if (aicTokens.has(e.address)) {
        const cur = tokenDelta.get(e.address) ?? 0n;
        tokenDelta.set(e.address, cur + (to === me ? v : 0n) - (from === me ? v : 0n));
      }
    }
    if (isSeed) {
      for (const e of tx.events) if (e.name === "InitialOwnerSeed" && lc(e.args.creator!) === me) seed += BigInt(e.args.seedUSDC ?? "0");
    }
    // AIC volume in USDC, counted once per transaction; a store's seed is a buy on its curve and counts.
    tradeVolume += usdcDelta < 0n ? -usdcDelta : usdcDelta;
    for (const [token, d] of tokenDelta) {
      if (d === 0n) continue;
      const f = flows.get(token) ?? { token, own: ownTokens.has(token), usdcSpentBase: "0", usdcReceivedBase: "0", tokensBought: "0", tokensSold: "0", trades: 0 };
      if (d > 0n) {
        f.tokensBought = (BigInt(f.tokensBought) + d).toString();
        if (usdcDelta < 0n) f.usdcSpentBase = (BigInt(f.usdcSpentBase) - usdcDelta).toString();
      } else {
        f.tokensSold = (BigInt(f.tokensSold) - d).toString();
        if (usdcDelta > 0n) f.usdcReceivedBase = (BigInt(f.usdcReceivedBase) + usdcDelta).toString();
      }
      if (!isSeed) f.trades++;
      flows.set(token, f);
    }
  }
  return { flows: [...flows.values()], seedBase: seed, tradeVolumeBase: tradeVolume };
}

const ERC20 = ["function balanceOf(address) view returns (uint256)"];
const STORE = ["function ownerAvailableUSDC() view returns (uint256)"];
const AGENTGOODS = [
  "function quoteSell(address aicToken, uint256 tokensIn) view returns (tuple(uint256 tokensIn, uint256 grossUSDC, uint256 protocolFeeUSDC, uint256 controllerFeeUSDC, uint256 netUSDCOut))",
  "function market(address aicToken) view returns (tuple(address aicToken, address store, bytes32 storeId, uint8 phase, uint256 tokenInventory, uint256 realUSDCReserve, uint256 virtualTokenReserve, uint256 virtualUSDCReserve, uint256 netSoldFromCurve, uint256 controllerFeesUSDC, uint256 lifetimeGrossVolumeUSDC, uint256 createdBlock, address pair, uint256 lpTokenAmount, uint256 lpUSDCUsed, uint256 lpTokenUsed, uint256 burnedAtTransition, bool graduationBlocked, uint256 burnedAtGraduationBlocked))",
];

/**
 * What selling `amount` of a token would really pay at `blockTag`: the curve's own quote capped by its
 * real USDC reserve, or, for a graduated token, the DEX router's quote. Fees and price impact included.
 */
export async function quoteExitAt(
  provider: JsonRpcProvider,
  agentGoodsAddress: string,
  dexRouter: string | undefined,
  usdcAddress: string,
  token: string,
  amount: bigint,
  blockTag: number
): Promise<{ value: bigint; venue: "curve" | "dex" | "none" }> {
  if (amount <= 0n) return { value: 0n, venue: "none" };
  const ag = new Contract(agentGoodsAddress, AGENTGOODS, provider);
  try {
    const m = (await (ag.market as any)(token, { blockTag })) as { phase: bigint; realUSDCReserve: bigint; pair: string };
    const graduated = m.pair && m.pair !== ethers.ZeroAddress;
    if (!graduated) {
      const q = (await (ag.quoteSell as any)(token, amount, { blockTag })) as { grossUSDC: bigint; netUSDCOut: bigint };
      const gross = q.grossUSDC ?? 0n;
      const net = q.netUSDCOut ?? 0n;
      const reserve = m.realUSDCReserve ?? 0n;
      return { value: gross > reserve && gross > 0n ? (net * reserve) / gross : net, venue: "curve" };
    }
  } catch {
    /* fall through to the DEX */
  }
  if (dexRouter && ethers.isAddress(dexRouter)) {
    const router = new Contract(dexRouter, ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])"], provider);
    const amounts = (await (router.getAmountsOut as any)(amount, [token, usdcAddress], { blockTag }).catch(() => null)) as bigint[] | null;
    if (amounts && amounts.length >= 2) return { value: amounts[amounts.length - 1] ?? 0n, venue: "dex" };
  }
  return { value: 0n, venue: "none" };
}

/** Balances of every AIC token for every agent at `blockTag`. */
export async function holdingsAt(input: TelemetryInput, blockTag: number): Promise<Map<string, Map<string, bigint>>> {
  const out = new Map<string, Map<string, bigint>>();
  const pairs: { agent: AgentRecord; token: string }[] = [];
  for (const agent of input.state.agents) for (const token of input.aicTokens) pairs.push({ agent, token: lc(token) });
  const results = await mapLimit(pairs, 8, async ({ agent, token }) => {
    const c = new Contract(token, ERC20, input.provider);
    const bal = (await (c.balanceOf as any)(agent.address, { blockTag }).catch(() => 0n)) as bigint;
    return { id: agent.id, token, bal };
  });
  for (const r of results) {
    if (r.bal === 0n) continue;
    (out.get(r.id) ?? out.set(r.id, new Map()).get(r.id)!).set(r.token, r.bal);
  }
  return out;
}

/**
 * Every agent's business metrics at `blockTag`. `valueOf` prices a position (the hourly snapshots use
 * each agent's own exit value; the final accounting passes the batch-settlement allocation instead).
 */
export async function computeMetrics(
  input: TelemetryInput,
  blockTag: number,
  valueOf?: (agentId: string, token: string, amount: bigint) => bigint | undefined
): Promise<Record<string, AgentMetrics>> {
  await refreshTxCache({ ...input, upToBlock: blockTag });
  const eco = input.state.economy as EconomyState;
  const sales = (await agentStoreSales({ ...input, upToBlock: blockTag })).filter((s) => s.block <= blockTag);
  const purchases = agentPurchases(input.state).filter((p) => p.block <= blockTag);
  const transfers = directTransfers(input.state, input.usdcAddress, input.operatorAddress).filter((t) => t.block <= blockTag);
  const holdings = await holdingsAt(input, blockTag);
  const aicSet = new Set(input.aicTokens.map(lc));
  const usdc = new Contract(input.usdcAddress, ERC20, input.provider);

  const out: Record<string, AgentMetrics> = {};
  for (const agent of input.state.agents) {
    const me = lc(agent.address);
    const myStores = Object.values(eco.stores ?? {}).filter((s) => s.creator === me);
    const ownTokens = new Set(myStores.map((s) => s.aicToken));
    const myTxs = Object.values(eco.txCache ?? {}).filter((t) => t.from === me && t.block <= blockTag && t.status === 1);

    const cash = (await (usdc.balanceOf as any)(agent.address, { blockTag }).catch(() => 0n)) as bigint;
    let proceeds = 0n;
    for (const s of myStores) {
      const c = new Contract(s.store, STORE, input.provider);
      proceeds += ((await (c.ownerAvailableUSDC as any)({ blockTag }).catch(() => 0n)) as bigint) ?? 0n;
    }

    let feesAccrued = 0n;
    const agForFees = new Contract(input.agentGoodsAddress, AGENTGOODS, input.provider);
    for (const s of myStores) {
      const mk = (await (agForFees.market as any)(s.aicToken, { blockTag }).catch(() => null)) as { controllerFeesUSDC?: bigint } | null;
      feesAccrued += mk?.controllerFeesUSDC ?? 0n;
    }
    let feesWithdrawn = 0n;
    for (const tx of myTxs) for (const e of tx.events) if (e.name === "ControllerFeesWithdrawn" && lc(e.args.controller!) === me) feesWithdrawn += BigInt(e.args.amount ?? "0");

    const held = holdings.get(agent.id) ?? new Map<string, bigint>();
    const positions: AgentMetrics["holdings"] = [];
    let holdingsValue = 0n;
    for (const [token, amount] of held) {
      const v = valueOf?.(agent.id, token, amount) ??
        (await quoteExitAt(input.provider, input.agentGoodsAddress, input.dexRouter, input.usdcAddress, token, amount, blockTag)).value;
      holdingsValue += v;
      positions.push({ token, amount: amount.toString(), exitValueBase: v.toString(), own: ownTokens.has(token) });
    }

    const mySales = sales.filter((s) => s.sellerAgentId === agent.id);
    const buyersCount = new Map<string, number>();
    for (const s of mySales) buyersCount.set(s.buyer, (buyersCount.get(s.buyer) ?? 0) + 1);
    const myPurchases = purchases.filter((p) => p.buyerAgentId === agent.id);
    const sellersCount = new Map<string, number>();
    for (const p of myPurchases) sellersCount.set(p.store, (sellersCount.get(p.store) ?? 0) + 1);

    let productsCreated = 0;
    let marketingAIC = 0n;
    let marketingEstimate = 0n;
    const myStoreSet = new Set(myStores.map((s) => s.store));
    for (const tx of myTxs) {
      for (const e of tx.events) {
        if (e.name === "ProductCreated" && myStoreSet.has(e.address)) productsCreated++;
        if (e.name === "RewardPoolFunded" && lc(e.args.from!) === me) {
          const amt = BigInt(e.args.amount ?? "0");
          marketingAIC += amt;
          const store = eco.stores?.[e.address];
          if (store) marketingEstimate += (await quoteExitAt(input.provider, input.agentGoodsAddress, input.dexRouter, input.usdcAddress, store.aicToken, amt, tx.block)).value;
        }
      }
    }

    const { flows, seedBase, tradeVolumeBase } = tradeFlows(agent, myTxs, input.usdcAddress, ownTokens, aicSet);
    const ownBuys = flows.filter((f) => f.own).reduce((n, f) => n + BigInt(f.usdcSpentBase), 0n) - seedBase;
    const trades = flows.reduce((n, f) => n + f.trades, 0);
    const tradingVolume = tradeVolumeBase;

    const revenueGross = mySales.reduce((n, s) => n + BigInt(s.grossBase), 0n);
    const revenueNet = mySales.reduce((n, s) => n + BigInt(s.ownerBase), 0n);
    const a2aSales = mySales.filter((s) => s.buyerAgentId).reduce((n, s) => n + BigInt(s.grossBase), 0n);
    const purchasesTotal = myPurchases.reduce((n, p) => n + BigInt(p.grossBase), 0n);
    const a2aPurchases = myPurchases.filter((p) => p.sellerAgentId).reduce((n, p) => n + BigInt(p.grossBase), 0n);
    const tin = transfers.filter((t) => t.toAgentId === agent.id).reduce((n, t) => n + BigInt(t.amountBase), 0n);
    const tout = transfers.filter((t) => t.fromAgentId === agent.id).reduce((n, t) => n + BigInt(t.amountBase), 0n);
    const counterparties = new Set<string>([
      ...mySales.map((s) => s.buyer),
      ...myPurchases.map((p) => p.store),
      ...transfers.filter((t) => t.fromAgentId === agent.id).map((t) => t.to),
      ...transfers.filter((t) => t.toAgentId === agent.id).map((t) => t.from),
    ]);

    const liabilities = outstandingBase(agent.debt);
    const inference = inferenceCostBase(agent);
    const gasLeft = (await input.provider.getBalance(agent.address, blockTag).catch(() => 0n)) as bigint;
    const gasGranted = agent.grant ? BigInt(agent.grant.gasWei) : 0n;
    const ethUsd = BigInt(Math.round(Number(process.env.ARENA_ETH_USD ?? "3000")));
    const gasCost = gasGranted > gasLeft ? ((gasGranted - gasLeft) * ethUsd * 1_000_000n) / 10n ** 18n : 0n;
    out[agent.id] = {
      agentId: agent.id,
      name: agent.name,
      block: blockTag,
      cashBase: cash.toString(),
      liabilitiesBase: liabilities.toString(),
      creditUsedBase: creditUsedBase(agent.debt).toString(),
      creditAvailableBase: creditAvailableBase(agent.debt).toString(),
      financingFeesBase: financingFeesBase(agent.debt).toString(),
      repaidBase: agent.debt.repaidBase,
      holdings: positions,
      holdingsValueBase: holdingsValue.toString(),
      storeProceedsBase: proceeds.toString(),
      marketFeesWithdrawnBase: feesWithdrawn.toString(),
      marketFeesAccruedBase: feesAccrued.toString(),
      equityEstimateBase: (cash + holdingsValue + proceeds + feesAccrued - liabilities - inference - gasCost).toString(),
      revenueGrossBase: revenueGross.toString(),
      revenueNetBase: revenueNet.toString(),
      salesCount: mySales.length,
      a2aSalesBase: a2aSales.toString(),
      externalSalesBase: (revenueGross - a2aSales).toString(),
      uniqueBuyers: buyersCount.size,
      repeatBuyers: [...buyersCount.values()].filter((n) => n >= 2).length,
      purchasesBase: purchasesTotal.toString(),
      purchasesCount: myPurchases.length,
      a2aPurchasesBase: a2aPurchases.toString(),
      uniqueSellers: sellersCount.size,
      repeatSellers: [...sellersCount.values()].filter((n) => n >= 2).length,
      productsCreated,
      productsSold: new Set(mySales.map((s) => s.productId)).size,
      storesCreated: myStores.length,
      seedBase: seedBase.toString(),
      ownTokenBuysBase: (ownBuys > 0n ? ownBuys : 0n).toString(),
      businessInvestmentBase: (seedBase + (ownBuys > 0n ? ownBuys : 0n)).toString(),
      marketingAIC: marketingAIC.toString(),
      marketingEstimateBase: marketingEstimate.toString(),
      inferenceCostBase: inference.toString(),
      gasCostBase: gasCost.toString(),
      operatingProfitBase: (revenueNet - purchasesTotal - marketingEstimate - inference - gasCost).toString(),
      operatingCashFlowBase: (revenueNet - purchasesTotal).toString(),
      directTransfersInBase: tin.toString(),
      directTransfersOutBase: tout.toString(),
      trades,
      tradingVolumeBase: tradingVolume.toString(),
      flows,
      counterparties: counterparties.size,
    };
  }
  return out;
}
