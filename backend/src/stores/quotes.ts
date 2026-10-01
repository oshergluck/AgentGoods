/**
 * Deterministic quote maths.
 *
 * These are exact integer re-implementations of the on-chain formulas. They exist so a quote
 * can be produced with ZERO RPC (rule 14) while still matching what the contract will do for
 * unchanged state, which MASTER_PLAN §15 requires ("API preview == contract execution result
 * for unchanged state").
 *
 * Every function here is pure, takes base-unit bigints and returns base-unit bigints. The
 * contract remains authoritative: a quote is advisory and execution enforces its own bounds.
 */

import { ceilBps, floorBps } from "../config/units";

export interface RewardParameters {
  numerator: bigint;
  denominator: bigint;
  minimumPool: bigint;
  poolGate: bigint;
}

export const MAX_UNITS_PER_PURCHASE = 365;

/**
 * Mirrors `StoreBase.previewReward`. The pool decays geometrically WITHIN a multi-unit
 * purchase, which is the intended V0 model; see docs/AIC_INCENTIVE_MODEL.md.
 */
export function previewReward(pool: bigint, units: number, p: RewardParameters): bigint {
  if (pool <= p.poolGate) return 0n;
  if (units <= 0 || units > MAX_UNITS_PER_PURCHASE) return 0n;

  let remaining = pool;
  let total = 0n;
  for (let i = 0; i < units; i++) {
    if (remaining < p.minimumPool) break;
    const unitReward = (remaining * p.numerator) / p.denominator;
    if (unitReward === 0n) break;
    total += unitReward;
    remaining -= unitReward;
  }
  return total;
}

export interface Settlement {
  gross: bigint;
  protocolFee: bigint;
  net: bigint;
  holderReserve: bigint;
  ownerAvailable: bigint;
}

/**
 * Mirrors `StoreBase.previewSettlement`.
 *
 * The protected shares round UP and only the controller remainder absorbs dust. Flooring both
 * would let a low enough price round the protocol fee and the 5% holder reserve to zero, so
 * splitting one sale into many micro-sales would extract more value than the single
 * equivalent sale. See docs/DECISIONS.md D-006.
 */
export function settle(gross: bigint, commerceFeeBps: number, holderReserveBps: number): Settlement {
  const protocolFee = ceilBps(gross, commerceFeeBps);
  const net = gross - protocolFee;
  const holderReserve = ceilBps(net, holderReserveBps);
  return { gross, protocolFee, net, holderReserve, ownerAvailable: net - holderReserve };
}

export interface CurveState {
  virtualTokenReserve: bigint;
  virtualUSDCReserve: bigint;
  tokenInventory: bigint;
  realUSDCReserve: bigint;
  netSoldFromCurve: bigint;
}

export interface BuyQuote {
  grossUSDC: bigint;
  protocolFeeUSDC: bigint;
  controllerFeeUSDC: bigint;
  netCurveUSDC: bigint;
  tokensOut: bigint;
  netSoldAfter: bigint;
  netSoldPercentageBps: number;
  willTriggerTransition: boolean;
  enoughInventory: boolean;
  pricePerTokenGross1e18: bigint;
}

/** Mirrors `AgentGoods.calculateBuyReturn` plus its fee ordering (fees taken from gross). */
export function quoteBuy(
  state: CurveState,
  grossUSDC: bigint,
  protocolFeeBps: number,
  controllerFeeBps: number,
  genesisSupply: bigint,
  transitionThreshold: bigint
): BuyQuote {
  const protocolFeeUSDC = floorBps(grossUSDC, protocolFeeBps);
  const controllerFeeUSDC = floorBps(grossUSDC, controllerFeeBps);
  const netCurveUSDC = grossUSDC - protocolFeeUSDC - controllerFeeUSDC;

  const tokensOut =
    state.virtualTokenReserve === 0n || state.virtualUSDCReserve === 0n || netCurveUSDC === 0n
      ? 0n
      : (state.virtualTokenReserve * netCurveUSDC) / (state.virtualUSDCReserve + netCurveUSDC);

  const netSoldAfter = state.netSoldFromCurve + tokensOut;

  return {
    grossUSDC,
    protocolFeeUSDC,
    controllerFeeUSDC,
    netCurveUSDC,
    tokensOut,
    netSoldAfter,
    netSoldPercentageBps: genesisSupply > 0n ? Number((netSoldAfter * 10_000n) / genesisSupply) : 0,
    willTriggerTransition: netSoldAfter >= transitionThreshold,
    enoughInventory: tokensOut > 0n && tokensOut <= state.tokenInventory,
    pricePerTokenGross1e18: tokensOut > 0n ? (grossUSDC * 10n ** 18n) / tokensOut : 0n,
  };
}

/**
 * The inverse of `quoteBuy`: what gross USDC buys exactly `tokensWanted` from the curve.
 *
 * WHY IT EXISTS. Every question of the form "how much would it cost me to own enough of this to
 * matter" starts from a TOKEN target - half the eligible supply, one more than the largest holder -
 * and `quoteBuy` only answers the other direction. Without this an agent has to bisect against the
 * quote endpoint to price its own ownership, which is a lot of calls to answer a question the curve
 * can answer in closed form.
 *
 * THE ALGEBRA. quoteBuy solves tokensOut = VT * netCurve / (VU + netCurve), so
 *
 *     netCurve = tokensWanted * VU / (VT - tokensWanted)
 *
 * and the fees come off the GROSS, so gross = netCurve * 10000 / (10000 - protocolBps - controllerBps).
 *
 * Both divisions round UP. A buy quote that rounds down is a quote that does not actually reach the
 * target, and the entire point of the figure is that the target is reached - being one base unit
 * short of a majority is worth exactly as much as holding nothing.
 *
 * Returns null when the target is not purchasable at all: at or beyond the virtual token reserve
 * the price is unbounded, and beyond the market's inventory there is nothing left to sell.
 */
export function usdcToBuyTokens(
  state: CurveState,
  tokensWanted: bigint,
  protocolFeeBps: number,
  controllerFeeBps: number
): bigint | null {
  if (tokensWanted <= 0n) return 0n;
  if (tokensWanted >= state.virtualTokenReserve) return null;
  if (tokensWanted > state.tokenInventory) return null;

  const denominator = state.virtualTokenReserve - tokensWanted;
  if (denominator <= 0n) return null;
  const netCurve = ceilDiv(tokensWanted * state.virtualUSDCReserve, denominator);

  const feeBps = BigInt(protocolFeeBps + controllerFeeBps);
  if (feeBps >= 10_000n) return null;
  return ceilDiv(netCurve * 10_000n, 10_000n - feeBps);
}

/** Integer division that rounds away from zero, for positive operands. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

export interface SellQuote {
  tokensIn: bigint;
  grossUSDC: bigint;
  protocolFeeUSDC: bigint;
  controllerFeeUSDC: bigint;
  netUSDCOut: bigint;
  netSoldAfter: bigint;
  enoughRealReserve: bigint extends never ? never : boolean;
  pricePerTokenGross1e18: bigint;
}

/** Mirrors `AgentGoods.calculateSellReturn` and its real-reserve solvency rule. */
export function quoteSell(
  state: CurveState,
  tokensIn: bigint,
  protocolFeeBps: number,
  controllerFeeBps: number
): SellQuote {
  const grossUSDC =
    state.virtualTokenReserve === 0n || state.virtualUSDCReserve === 0n || tokensIn === 0n
      ? 0n
      : (state.virtualUSDCReserve * tokensIn) / (state.virtualTokenReserve + tokensIn);

  const protocolFeeUSDC = floorBps(grossUSDC, protocolFeeBps);
  const controllerFeeUSDC = floorBps(grossUSDC, controllerFeeBps);

  return {
    tokensIn,
    grossUSDC,
    protocolFeeUSDC,
    controllerFeeUSDC,
    netUSDCOut: grossUSDC - protocolFeeUSDC - controllerFeeUSDC,
    netSoldAfter: state.netSoldFromCurve > tokensIn ? state.netSoldFromCurve - tokensIn : 0n,
    // Virtual USDC is pricing state. Only real USDC can satisfy a redemption. [0.25.J]
    enoughRealReserve: grossUSDC <= state.realUSDCReserve,
    // Whole USDC per whole token, scaled 1e18. See docs/DECISIONS.md D-019.
    pricePerTokenGross1e18: tokensIn > 0n ? (grossUSDC * 10n ** 30n) / tokensIn : 0n,
  };
}

/**
 * Largest token amount whose sell proceeds the market can actually pay right now.
 *
 * Inverts the constant-product sell formula against the REAL reserve:
 *
 *   gross = R_usdc * tokensIn / (R_token + tokensIn)   solved for gross = realReserve
 *   tokensIn = realReserve * R_token / (R_usdc - realReserve)
 *
 * Floor division, then one corrective step down, so the answer is never optimistic. It is an
 * ESTIMATE and is labelled as one: it holds only while no other trade lands first.
 * [MASTER_PLAN 29A.2]
 */
export function maxTokensSellableNow(state: CurveState): bigint {
  const real = state.realUSDCReserve;
  if (real <= 0n) return 0n;
  // The curve can never pay out its whole pricing reserve, so this is always a strict bound.
  if (real >= state.virtualUSDCReserve) return 0n;

  let tokens = (real * state.virtualTokenReserve) / (state.virtualUSDCReserve - real);
  // Correct any upward rounding: shrink until the implied gross fits inside the real reserve.
  for (let i = 0; i < 4 && tokens > 0n; i += 1) {
    const gross = (state.virtualUSDCReserve * tokens) / (state.virtualTokenReserve + tokens);
    if (gross <= real) break;
    tokens -= 1n;
  }
  return tokens < 0n ? 0n : tokens;
}

/*
 * A GRADUATED market has no curve: it trades on its UniswapV2 pool, and the curve's virtual
 * reserves are frozen at the transition. Valuing a holding with the curve formula after that
 * returns a number for a market that no longer exists — which is what /me did, while the
 * leaderboard simply marked such holdings "not valued" and showed zero.
 *
 * The pool's reserves are indexed from its Sync events: realUSDCReserve is the pool's USDC and
 * currentIndexedPrice1e18 = usdc * 1e30 / tokens (the indexer's PRICE_SCALE), so the token reserve follows (up to
 * base unit of rounding). Selling into a V2 pool pays amountIn*997*R_usdc / (R_tok*1000 +
 * amountIn*997): the standard 0.3% fee, and the price impact of the whole position.
 */
export interface DexPool {
  usdcReserve: bigint;
  tokenReserve: bigint;
}

export function dexPoolOf(market: { realUSDCReserve?: unknown; currentIndexedPrice1e18?: unknown }): DexPool | null {
  const usdcReserve = BigInt(String(market.realUSDCReserve ?? "0"));
  const price = BigInt(String(market.currentIndexedPrice1e18 ?? "0"));
  if (usdcReserve <= 0n || price <= 0n) return null;
  // The indexer writes price = usdc * 1e30 / tokens (USDC has 6 decimals, AIC 18), so tokens = usdc * 1e30 / price.
  return { usdcReserve, tokenReserve: (usdcReserve * 10n ** 30n) / price };
}

/** USDC out for selling `tokensIn` into the pool. */
export function dexSellOut(pool: DexPool, tokensIn: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  const inWithFee = tokensIn * 997n;
  return (inWithFee * pool.usdcReserve) / (pool.tokenReserve * 1000n + inWithFee);
}

/** USDC in needed to buy `tokensOut` from the pool, rounded up; null if the pool cannot supply it. */
export function dexUsdcToBuy(pool: DexPool, tokensOut: bigint): bigint | null {
  if (tokensOut <= 0n) return 0n;
  if (tokensOut >= pool.tokenReserve) return null;
  return (pool.usdcReserve * tokensOut * 1000n) / ((pool.tokenReserve - tokensOut) * 997n) + 1n;
}

/** Whether a market has left its curve for the DEX. */
export function isGraduated(market: { phase?: unknown; lpCreated?: unknown }): boolean {
  return Boolean(market.lpCreated) || String(market.phase ?? "bonding_curve") === "external_dex";
}

/*
 * Whether a market's figures can be computed at all — so an uninitialized market is reported as
 * unavailable rather than as a numeric zero. Zero means "genuinely zero"; a figure the protocol
 * cannot compute yet is flagged here instead of being published as 0 (and never as NaN).
 *
 * A curve always has a price (its virtual seed sets one before anyone buys), but a sell is paid only
 * from real USDC, so a market nobody has bought into cannot pay out a sale at any size.
 */
export interface MarketState {
  state: "UNINITIALIZED" | "INITIALIZED_NO_LIQUIDITY" | "LIVE_ON_CURVE" | "GRADUATED_TO_DEX";
  venue: "curve" | "dex";
  marketInitialized: boolean;
  hasLiquidity: boolean;
  priceAvailable: boolean;
  sellQuoteAvailable: boolean;
  /** Whether value-based figures (position value, exit, yield per holder) can mean anything yet. */
  machineReadableInvestmentMetricsAvailable: boolean;
  unavailableReason: "MARKET_NOT_INITIALIZED" | "NO_REAL_LIQUIDITY" | null;
  note: string;
}

export function marketStateOf(m: Record<string, unknown>): MarketState {
  const graduated = isGraduated(m);
  const real = BigInt(String(m.realUSDCReserve ?? "0"));
  const sold = BigInt(String(m.netSoldFromCurveAIC ?? "0"));
  const price = BigInt(String(m.currentIndexedPrice1e18 ?? "0"));
  const marketInitialized = graduated || sold > 0n || real > 0n;
  const hasLiquidity = real > 0n;
  return {
    state: graduated ? "GRADUATED_TO_DEX" : !marketInitialized ? "UNINITIALIZED" : hasLiquidity ? "LIVE_ON_CURVE" : "INITIALIZED_NO_LIQUIDITY",
    venue: graduated ? "dex" : "curve",
    marketInitialized,
    hasLiquidity,
    priceAvailable: price > 0n,
    sellQuoteAvailable: hasLiquidity,
    machineReadableInvestmentMetricsAvailable: hasLiquidity,
    unavailableReason: !marketInitialized ? "MARKET_NOT_INITIALIZED" : !hasLiquidity ? "NO_REAL_LIQUIDITY" : null,
    note: marketInitialized
      ? hasLiquidity
        ? "Initialized, with real liquidity: quotes, position values and exits can be computed."
        : "Initialized but holding no real USDC: a sale cannot be paid right now."
      : "Not initialized yet: nobody has bought this token, so there is no real liquidity and no sale can be paid. " +
        "Its curve still has a price (the virtual seed sets one). An uninitialized market is not a worthless one — " +
        "this is missing market evidence, not a valuation.",
  };
}

/*
 * The cost of being first, quantified: buy `grossUSDC` of a token and sell everything received
 * straight back, with nobody else trading in between.
 *
 * It cannot be assembled from two ordinary quotes. A sell quote reads the CURRENT curve, and an
 * uninitialized market holds no real USDC, so it refuses any sale — which reads as "the whole amount
 * is at risk". The honest figure prices the sale on the curve AS YOUR BUY LEAVES IT: on a
 * constant-product curve the gross of that sale returns what your buy put in (rounding aside), so the
 * round trip costs the fees on both legs, not the principal.
 */
export interface RoundTrip {
  buy: BuyQuote;
  sell: SellQuote;
  stateAfterBuy: CurveState;
  roundTripCostUSDC: bigint;
  protocolFeesUSDC: bigint;
  controllerFeesUSDC: bigint;
  roundingUSDC: bigint;
}

export function roundTripOnCurve(
  state: CurveState,
  grossUSDC: bigint,
  protocolFeeBps: number,
  controllerFeeBps: number,
  genesisSupply: bigint,
  transitionThreshold: bigint
): RoundTrip {
  const buy = quoteBuy(state, grossUSDC, protocolFeeBps, controllerFeeBps, genesisSupply, transitionThreshold);
  const stateAfterBuy: CurveState = {
    virtualTokenReserve: state.virtualTokenReserve - buy.tokensOut,
    virtualUSDCReserve: state.virtualUSDCReserve + buy.netCurveUSDC,
    tokenInventory: state.tokenInventory - buy.tokensOut,
    realUSDCReserve: state.realUSDCReserve + buy.netCurveUSDC,
    netSoldFromCurve: state.netSoldFromCurve + buy.tokensOut,
  };
  const sell = quoteSell(stateAfterBuy, buy.tokensOut, protocolFeeBps, controllerFeeBps);
  const protocolFeesUSDC = buy.protocolFeeUSDC + sell.protocolFeeUSDC;
  const controllerFeesUSDC = buy.controllerFeeUSDC + sell.controllerFeeUSDC;
  const roundTripCostUSDC = grossUSDC - sell.netUSDCOut;
  return {
    buy,
    sell,
    stateAfterBuy,
    roundTripCostUSDC,
    protocolFeesUSDC,
    controllerFeesUSDC,
    roundingUSDC: roundTripCostUSDC - protocolFeesUSDC - controllerFeesUSDC,
  };
}

/*
 * The smallest seed that leaves a market MECHANICALLY usable: real liquidity exists, and the seed's
 * whole position can itself be sold back — the exchange refuses any trade under 1 USDC gross, and a
 * seed whose full sale grosses less than that would leave its owner with a position it cannot exit.
 * This is a mechanical threshold, not a recommendation and not a "minimum for success".
 */
export function minimumMechanicalSeedUSDC(
  state: CurveState,
  protocolFeeBps: number,
  controllerFeeBps: number,
  genesisSupply: bigint,
  transitionThreshold: bigint,
  minTradeUSDC = 1_000_000n
): bigint | null {
  const keepBps = BigInt(10_000 - protocolFeeBps - controllerFeeBps);
  if (keepBps <= 0n) return null;
  let gross = (minTradeUSDC * 10_000n + keepBps - 1n) / keepBps;
  for (let i = 0; i < 1000; i++, gross += 1n) {
    const r = roundTripOnCurve(state, gross, protocolFeeBps, controllerFeeBps, genesisSupply, transitionThreshold);
    if (r.buy.tokensOut > 0n && r.sell.grossUSDC >= minTradeUSDC && r.sell.enoughRealReserve) return gross;
  }
  return null;
}

/** The curve every new market starts from, from the protocol's own economics. */
export function freshCurveState(virtualUSDCReserve: bigint, genesisSupply: bigint): CurveState {
  return {
    virtualTokenReserve: genesisSupply,
    virtualUSDCReserve,
    tokenInventory: genesisSupply,
    realUSDCReserve: 0n,
    netSoldFromCurve: 0n,
  };
}
