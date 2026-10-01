/**
 * Monetary types.
 *
 * MASTER_PLAN 0.25.AA forbids JavaScript floating point anywhere in USDC/AIC accounting and
 * requires API monetary fields to be strings with explicit decimals. 0.27.J forbids mixing
 * base units with display units and basis points with percentages.
 *
 * Every amount in this backend is a `bigint` of BASE UNITS, branded with its token so the
 * compiler rejects passing AIC where USDC is expected. Conversion to a human string happens
 * exactly once, at the serialization boundary, and always alongside its `decimals`.
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/** USDC amount in base units (6 decimals). */
export type Usdc = Brand<bigint, "Usdc">;
/** AIC amount in base units (18 decimals). */
export type Aic = Brand<bigint, "Aic">;

export const USDC_DECIMALS = 6;
export const AIC_DECIMALS = 18;
export const BPS_DENOMINATOR = 10_000n;

export function usdc(value: bigint | string | number): Usdc {
  return toBigInt(value) as Usdc;
}

export function aic(value: bigint | string | number): Aic {
  return toBigInt(value) as Aic;
}

function toBigInt(value: bigint | string | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(`Refusing to build a monetary value from a non-integer number: ${value}`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new TypeError(`Refusing to build a monetary value from "${value}": expected base units`);
  }
  return BigInt(trimmed);
}

/**
 * The canonical serialized shape for every monetary field in every API response.
 * MASTER_PLAN 0.27.J: an Agent must never have to guess whether a number is base units.
 */
export interface Amount {
  /** Integer base units as a decimal string. This is the authoritative value. */
  readonly base: string;
  readonly decimals: number;
  /** Human-readable rendering, for display only. Never parse this back into money. */
  readonly display: string;
  /**
   * Ticker to render next to the amount.
   *
   * For a store token this is the token OWN symbol (`ATLS`, `VCTR`), not the generic word
   * "AIC": every store mints a distinct token, and showing them all as "AIC" would imply one
   * fungible asset where there are many. The symbol is on-chain ERC20 metadata chosen by the
   * store creator, so it is display text and NOT an identifier: two stores may legitimately
   * pick the same symbol. Address identity is in `tokenAddress` / the protocol block.
   */
  readonly unit: string;
  /** Machine-readable class of the amount. An Agent keys on this, never on `unit`. */
  readonly tokenKind: "USDC" | "STORE_TOKEN";
}

export function amountUSDC(value: bigint): Amount {
  return {
    base: value.toString(),
    decimals: USDC_DECIMALS,
    display: format(value, USDC_DECIMALS),
    unit: "USDC",
    tokenKind: "USDC",
  };
}

/**
 * A store token amount.
 *
 * `symbol` is the store ERC20 symbol when the caller knows it. It falls back to `AIC`, which is
 * the protocol generic name for the store token class, only when the symbol is not available.
 */
export function amountAIC(value: bigint, symbol?: string | null): Amount {
  const ticker = typeof symbol === "string" && symbol.trim().length > 0 ? symbol.trim() : "AIC";
  return {
    base: value.toString(),
    decimals: AIC_DECIMALS,
    display: format(value, AIC_DECIMALS),
    unit: ticker,
    tokenKind: "STORE_TOKEN",
  };
}

/** Exact decimal rendering of a base-unit integer. No floating point anywhere. */
export function format(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const fraction = abs % divisor;
  if (fraction === 0n) return `${negative ? "-" : ""}${whole}`;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${fractionStr}`;
}

/** Parses a human decimal string into base units exactly, rejecting excess precision. */
export function parseDecimal(value: string, decimals: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new TypeError(`Invalid decimal amount: "${value}"`);
  const [, sign, whole, fractionRaw = ""] = match;
  if (fractionRaw.length > decimals) {
    throw new TypeError(`Amount "${value}" has more than ${decimals} decimal places`);
  }
  const fraction = fractionRaw.padEnd(decimals, "0");
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || "0");
  return sign === "-" ? -result : result;
}

/** floor(amount * bps / 10000). Matches the on-chain floor paths. */
export function floorBps(amount: bigint, bps: number | bigint): bigint {
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

/**
 * ceil(amount * bps / 10000), saturating at `amount`.
 * Mirrors `StoreBase._ceilBps`, which protects the commerce fee and the holder reserve
 * from micro-purchase rounding evasion. See docs/DECISIONS.md D-006.
 */
export function ceilBps(amount: bigint, bps: number | bigint): bigint {
  const b = BigInt(bps);
  if (amount === 0n || b === 0n) return 0n;
  const result = (amount * b + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  return result > amount ? amount : result;
}

/**
 * Derived, read-only comparison figure for Phase 10.1: declared model tokens saved per
 * whole USDC of price. Never stored as truth; recomputed from canonical on-chain values.
 * Returned as a fixed-precision decimal string so no float ever touches it.
 */
export function tokensSavedPerUsdc(declaredTokensSaved: bigint, priceUSDCBaseUnits: bigint): string | null {
  if (declaredTokensSaved <= 0n || priceUSDCBaseUnits <= 0n) return null;
  // tokensSaved / (price / 1e6) == tokensSaved * 1e6 / price, kept to 6 decimal places.
  const scaled = (declaredTokensSaved * 10n ** BigInt(USDC_DECIMALS) * 10n ** 6n) / priceUSDCBaseUnits;
  return format(scaled, 6);
}

/** Sortable integer key for the derived figure, so Mongo can index and range-query it. */
export function tokensSavedPerUsdcKey(declaredTokensSaved: bigint, priceUSDCBaseUnits: bigint): string | null {
  if (declaredTokensSaved <= 0n || priceUSDCBaseUnits <= 0n) return null;
  const scaled = (declaredTokensSaved * 10n ** BigInt(USDC_DECIMALS) * 10n ** 6n) / priceUSDCBaseUnits;
  return scaled.toString();
}
