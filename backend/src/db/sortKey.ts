/**
 * Lexicographically sortable keys for arbitrary-precision integers.
 *
 * Mongo cannot range-query a decimal string correctly ("9" > "10" lexicographically) and
 * MASTER_PLAN 0.25.AA forbids storing money as a double. Every sortable monetary or
 * quantity field is therefore stored twice: the exact base-unit string, and a zero-padded
 * fixed-width key used only for `$gte` / `$lte` / `$sort`.
 *
 * 48 digits comfortably covers 1e27 base units of AIC and every USDC amount that can exist.
 */

export const SORT_KEY_WIDTH = 48;

export function sortKey(value: bigint | string): string {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) throw new RangeError("sortKey does not support negative values");
  const s = v.toString();
  if (s.length > SORT_KEY_WIDTH) {
    throw new RangeError(`value ${s} exceeds the ${SORT_KEY_WIDTH}-digit sort key width`);
  }
  return s.padStart(SORT_KEY_WIDTH, "0");
}

export function fromSortKey(key: string): bigint {
  return BigInt(key);
}

/**
 * Deterministic descending cursor for creation-ordered feeds.
 * MASTER_PLAN 0.22.E requires stable cursors that tolerate reorg replay and never
 * duplicate or skip while new objects are being indexed, and 0.27.I fixes the definition
 * of "new" as canonical creation event order, never a mutable `updatedAt`.
 */
export function creationCursor(blockNumber: number, logIndex: number, id: string): string {
  return Buffer.from(
    `${String(blockNumber).padStart(12, "0")}:${String(logIndex).padStart(6, "0")}:${id}`
  ).toString("base64url");
}

export interface DecodedCursor {
  blockNumber: number;
  logIndex: number;
  id: string;
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [block, log, ...rest] = raw.split(":");
    if (!block || !log || rest.length === 0) return null;
    const blockNumber = Number(block);
    const logIndex = Number(log);
    if (!Number.isInteger(blockNumber) || !Number.isInteger(logIndex)) return null;
    return { blockNumber, logIndex, id: rest.join(":") };
  } catch {
    return null;
  }
}
