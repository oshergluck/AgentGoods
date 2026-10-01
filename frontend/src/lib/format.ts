/**
 * Display formatting.
 *
 * Every function here operates on the API `base` string (integer base units) using BigInt.
 * MASTER_PLAN 0.25.AA forbids floating point in the money path, and that does not stop at the
 * network boundary: `Number("1234567890123456789")` is already wrong before it is rendered.
 *
 * Money is shown to TWO DECIMAL PLACES, because that is how a person reads a price. The exact
 * value is always still available: `Amount.base` is the authority and every surface that shows a
 * rounded figure keeps the full-precision string in a `title` attribute.
 */

import type { Amount } from "./api";

/** Rounds a base-unit integer to `places` decimals, half-up, entirely in BigInt. */
export function formatUnits(base: string, decimals: number, places = 2): string {
  let raw = (base ?? "0").trim();
  if (raw.length === 0) raw = "0";
  const negative = raw.startsWith("-");
  const value = BigInt(negative ? raw.slice(1) : raw);

  if (places >= decimals) {
    const divisor = 10n ** BigInt(decimals);
    const whole = value / divisor;
    const frac = (value % divisor).toString().padStart(decimals, "0").padEnd(places, "0");
    return `${negative ? "-" : ""}${group(whole)}${places > 0 ? `.${frac.slice(0, places)}` : ""}`;
  }

  // Half-up rounding at `places`, done by adding half of the discarded magnitude.
  const drop = 10n ** BigInt(decimals - places);
  const rounded = (value + drop / 2n) / drop;
  const scale = 10n ** BigInt(places);
  const whole = rounded / scale;
  const frac = (rounded % scale).toString().padStart(places, "0");
  return `${negative ? "-" : ""}${group(whole)}${places > 0 ? `.${frac}` : ""}`;
}

/** Thousands separators, applied to the integer part only. */
function group(value: bigint): string {
  const s = value.toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * `1,234.56 USDC`.
 *
 * The ticker comes from `Amount.unit`, which is the store token own symbol (`ATLS`), never the
 * generic word AIC. See docs/DECISIONS.md D-018.
 */
export function money(amount: Amount | null | undefined, places = 2): string {
  if (!amount) return "—";
  return `${formatUnits(amount.base, amount.decimals, places)} ${amount.unit}`;
}

/** The rounded figure alone, without a ticker. */
export function moneyValue(amount: Amount | null | undefined, places = 2): string {
  if (!amount) return "—";
  return formatUnits(amount.base, amount.decimals, places);
}

/** The exact, unrounded value, for a tooltip beside any rounded figure. */
export function exact(amount: Amount | null | undefined): string {
  if (!amount) return "";
  return `${amount.display} ${amount.unit} (exact)`;
}

/**
 * A large token count, abbreviated: `1.24M ATLS`.
 * Supply figures run to 10^27 base units; nine digits of grouping is not a readable number.
 */
export function compactToken(amount: Amount | null | undefined): string {
  if (!amount) return "—";
  const whole = BigInt(amount.base || "0") / 10n ** BigInt(amount.decimals);
  return `${compact(whole)} ${amount.unit}`;
}

export function compact(value: bigint): string {
  const units: [bigint, string][] = [
    [10n ** 12n, "T"],
    [10n ** 9n, "B"],
    [10n ** 6n, "M"],
    [10n ** 3n, "K"],
  ];
  const negative = value < 0n;
  const abs = negative ? -value : value;
  for (const [size, suffix] of units) {
    if (abs >= size) {
      // Two decimals of the quotient, computed exactly.
      const scaled = (abs * 100n) / size;
      const whole = scaled / 100n;
      const frac = (scaled % 100n).toString().padStart(2, "0");
      return `${negative ? "-" : ""}${whole}.${frac}${suffix}`;
    }
  }
  return `${negative ? "-" : ""}${abs}`;
}

/**
 * A price per token, which on a fresh bonding curve is far below a cent.
 *
 * Two decimals would render every early price as `0.00`, so sub-cent prices use the
 * leading-zero-count notation `0.0₅678`, which stays honest about the magnitude in the width of
 * a table cell. Prices at or above one cent use plain two-decimal money.
 */
export function priceUSDC(price1e18: string | null | undefined, places = 2): string {
  if (!price1e18) return "—";
  const value = BigInt(price1e18);
  if (value === 0n) return "0.00";
  // 1e18-scaled USDC per whole token.
  const ONE = 10n ** 18n;
  if (value >= ONE / 100n) return formatUnits(value.toString(), 18, places);

  const digits = value.toString().padStart(19, "0");
  const frac = digits.slice(1); // 18 fractional digits
  const firstSignificant = frac.search(/[1-9]/);
  const zeros = firstSignificant; // leading zeros after the decimal point
  const significant = frac.slice(firstSignificant, firstSignificant + 4).replace(/0+$/, "") || "0";
  return `0.0${subscript(zeros)}${significant}`;
}

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";

function subscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPTS[Number(d)] ?? d)
    .join("");
}

/**
 * The graduation threshold of one market, in basis points of genesis supply, from the market's own
 * figures — it is set per network (30% on one, 95% on another), so it is never written into the UI.
 */
export function transitionThresholdBps(m: { transitionThresholdAIC?: Amount; genesisSupplyAIC?: Amount }): number | null {
  const t = BigInt(m.transitionThresholdAIC?.base || "0");
  const g = BigInt(m.genesisSupplyAIC?.base || "0");
  if (t === 0n || g === 0n) return null;
  return Number((t * 10000n) / g);
}

/** Creation moment for a card: "30 Sep 2026 · 02:56", in the reader's time zone. */
export function createdDateTime(unixSeconds: number | null | undefined): { date: string; time: string } | null {
  if (!unixSeconds) return null;
  const d = new Date(unixSeconds * 1000);
  return {
    date: d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

/** Signed percentage with an arrow, or an em dash when there is nothing to compare against. */
export function signedPercent(value: number | null): { text: string; direction: "up" | "down" | "flat" } {
  if (value === null || !Number.isFinite(value)) return { text: "—", direction: "flat" };
  const direction = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "";
  return { text: `${arrow}${arrow ? " " : ""}${value >= 0 ? "+" : ""}${value.toFixed(2)}%`, direction };
}

/**
 * Percentage change between two 1e24-scaled prices, kept in BigInt until the final division.
 *
 * The result is a display percentage, so a float at the very end is acceptable; the inputs
 * never are.
 */
export function pctChange(from: bigint, to: bigint): number | null {
  if (from <= 0n) return null;
  const scaled = ((to - from) * 1_000_000n) / from;
  return Number(scaled) / 10_000;
}

/**
 * A rental period as a unit a person reads, never the raw seconds.
 *
 * "USDC / period" tells a buyer nothing: a period could be an hour or a month, and the price
 * means something completely different in each case. The on-chain value is always seconds, so
 * this renders the largest exact unit and falls back to hours, which is how inference and
 * streaming capacity is actually quoted.
 */
export function rentalPeriod(seconds: number | null | undefined): string {
  const s = Number(seconds ?? 0);
  if (!Number.isFinite(s) || s <= 0) return "period";
  if (s % 86400 === 0 && s >= 86400) {
    const days = s / 86400;
    return days === 1 ? "24h" : `${days} days`;
  }
  if (s % 3600 === 0) {
    const hours = s / 3600;
    return hours === 1 ? "hour" : `${hours}h`;
  }
  if (s % 60 === 0) {
    const minutes = s / 60;
    return minutes === 1 ? "minute" : `${minutes} min`;
  }
  return `${s}s`;
}

/** The same period expressed in hours, for a secondary "= N hours" hint. */
export function periodHours(seconds: number | null | undefined): string {
  const s = Number(seconds ?? 0);
  if (!Number.isFinite(s) || s <= 0) return "";
  const hours = s / 3600;
  if (hours >= 1) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
  return `${Math.round(s / 60)} minutes`;
}

/**
 * What an AIC amount is worth in USDC right now, at the live curve price.
 *
 * An incentive quoted only in tokens is unreadable: "+23,675 ALPHA" tells a buyer nothing about
 * whether it is worth a cent or a hundred dollars, and a store owner sizing a reward pool has no
 * way to judge what they are committing. Both need the number in money.
 *
 * `price` is the protocol's PRICE_SCALE = 1e30 figure — 1e18 of scaling times 1e12 for the gap
 * between USDC's 6 decimals and the token's 18 — so the conversion is exactly
 * `usdcBase = aicBase * price / 1e30`, carried in BigInt so nothing is lost on the way.
 *
 * Returns null when there is no price yet, which is a real state: a market with no trades has no
 * price, and showing "$0.00" would assert something false about it.
 */
export function aicValueInUSDC(aicBase: string | null | undefined, price1e30: string | null | undefined): string | null {
  if (!aicBase || !price1e30) return null;
  let value: bigint;
  try {
    const price = BigInt(price1e30);
    if (price <= 0n) return null;
    value = (BigInt(aicBase) * price) / 10n ** 30n;
  } catch {
    return null;
  }
  // Below a hundredth of a cent, two decimal places would round to zero and read as "free".
  if (value > 0n && value < 100n) return "< 0.0001";
  const whole = value / 1_000_000n;
  const frac = value % 1_000_000n;
  if (whole === 0n) return `0.${frac.toString().padStart(6, "0").slice(0, 4)}`;
  return `${whole.toLocaleString("en-US")}.${frac.toString().padStart(6, "0").slice(0, 2)}`;
}

/**
 * The circulating supply of a store token: current supply minus what the market itself holds.
 *
 * Burned tokens are already gone from the current supply. Uses the indexer's figure when present;
 * otherwise, while the token is still on its bonding curve, subtracts the curve's inventory. After
 * graduation the curve holds nothing, so the current supply is the circulating supply.
 */
export function circulatingSupply(m: {
  phase?: string;
  currentSupplyAIC: Amount;
  marketInventoryAIC?: Amount | null;
  circulatingSupplyAIC?: Amount | null;
}): Amount {
  if (m.circulatingSupplyAIC) return m.circulatingSupplyAIC;
  const current = BigInt(m.currentSupplyAIC.base || "0");
  const inventory =
    m.phase !== "external_dex" && m.marketInventoryAIC
      ? BigInt(m.marketInventoryAIC.base || "0")
      : 0n;
  const base = current > inventory ? current - inventory : 0n;
  return { ...m.currentSupplyAIC, base: base.toString(), display: formatUnits(base.toString(), m.currentSupplyAIC.decimals, m.currentSupplyAIC.decimals) };
}
