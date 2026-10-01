/**
 * Destination validation for outbound webhooks.
 *
 * A webhook URL is attacker-controlled input that this server will later make a request to. That
 * makes it a server-side request forgery primitive unless every one of these holds:
 *
 *  - the scheme is https (an http target leaks the signed payload on the wire);
 *  - the host does not resolve to a private, loopback, link-local, unique-local or reserved
 *    address, because those reach infrastructure that only this process can see;
 *  - cloud instance-metadata endpoints are rejected explicitly, since 169.254.169.254 is the
 *    single highest-value SSRF target on every major provider;
 *  - the check is repeated AT DELIVERY TIME against the address actually connected to, not only
 *    at registration. Checking once at registration is defeated by DNS rebinding: a name that
 *    resolved to a public address when it was registered can resolve to 127.0.0.1 a minute later.
 *
 * MASTER_PLAN 0.27.X and the `ssrfPolicy` clause the Agent schema publishes.
 */

import { lookup } from "node:dns/promises";
import net from "node:net";

export const MAX_WEBHOOK_URL_LENGTH = 2048;

export class SsrfError extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "SsrfError";
  }
}

/** Hostnames that are never acceptable regardless of what they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

/** Cloud instance metadata services. Rejected by address, before any range check. */
const METADATA_ADDRESSES = new Set([
  "169.254.169.254", // AWS, GCP, Azure, DigitalOcean, Oracle
  "169.254.170.2", // AWS ECS task metadata
  "100.100.100.200", // Alibaba Cloud
  "fd00:ec2::254", // AWS IMDSv6
]);

function ipv4ToInt(address: string): number {
  const parts = address.split(".").map((p) => Number(p));
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

/**
 * True for any IPv4 address outside the public unicast space.
 *
 * Listed explicitly rather than by a library, because each entry is a decision someone should be
 * able to review: these are the ranges that let a webhook reach something the caller could not
 * reach themselves.
 */
function isPrivateIPv4(address: string): boolean {
  const n = ipv4ToInt(address);
  const inRange = (cidrBase: string, bits: number): boolean => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(cidrBase) & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // "this" network
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // carrier-grade NAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local, includes instance metadata
    inRange("172.16.0.0", 12) || // private
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.0.2.0", 24) || // TEST-NET-1
    inRange("192.168.0.0", 16) || // private
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("198.51.100.0", 24) || // TEST-NET-2
    inRange("203.0.113.0", 24) || // TEST-NET-3
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved, includes broadcast
  );
}

/**
 * Expands an IPv6 address to its eight 16-bit groups.
 *
 * Needed because textual comparison is not enough: `::ffff:127.0.0.1` and `::ffff:7f00:1` are the
 * same address, and `new URL()` silently rewrites the first into the second. A check written
 * against the dotted spelling therefore passes its own unit test and lets the hex spelling
 * straight through, which is exactly the bug this replaced.
 */
function expandIPv6(address: string): number[] | null {
  let a = address.toLowerCase().split("%")[0]!;

  // A trailing dotted quad is the last two groups written in IPv4 notation.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    a = `${a.slice(0, dotted.index)}${hi}:${lo}`;
  }

  const halves = a.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":").filter((p) => p !== "") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter((p) => p !== "") : [];

  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const parsed = groups.map((g) => Number.parseInt(g, 16));
  if (parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return parsed;
}

function isPrivateIPv6(address: string): boolean {
  const groups = expandIPv6(address);
  if (!groups) return true; // unparseable: fail closed

  const isZero = (upTo: number): boolean => groups.slice(0, upTo).every((g) => g === 0);

  // Unspecified :: and loopback ::1
  if (isZero(7) && (groups[7] === 0 || groups[7] === 1)) return true;

  /*
   * IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses carry an IPv4 address
   * in the low 32 bits. They must be judged by the IPv4 rules, or every private IPv4 range is
   * reachable simply by writing it as IPv6.
   */
  const embedsIPv4 = (isZero(5) && groups[5] === 0xffff) || isZero(6);
  if (embedsIPv4) {
    const a = groups[6]! >> 8;
    const b = groups[6]! & 0xff;
    const c = groups[7]! >> 8;
    const d = groups[7]! & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  const first = groups[0]!;
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (first === 0x0064 && groups[1] === 0xff9b) return true; // NAT64 well-known prefix
  return false;
}

/** True when this address must never be the target of an outbound webhook. */
export function isBlockedAddress(address: string): boolean {
  if (METADATA_ADDRESSES.has(address.toLowerCase())) return true;
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  // Not an IP literal at all: fail closed rather than guess.
  return true;
}

export interface ValidatedTarget {
  url: URL;
  /** The address the destination resolved to at validation time. */
  address: string;
}

export interface SsrfOptions {
  /**
   * Permits loopback and private destinations, and http.
   *
   * LOCAL only. It exists solely so the development stack can deliver to a listener on the same
   * machine, and it is not reachable from configuration in any other environment.
   *
   * It deliberately does NOT relax everything: cloud instance metadata and embedded credentials
   * stay refused. Nothing about local development requires reaching 169.254.169.254, so the
   * highest-value SSRF target has no reason to be exempt in any environment, and keeping it
   * refused means the test suite exercises that rule rather than skipping it.
   */
  allowPrivate?: boolean;
}

/** Refused in every environment, including LOCAL. */
function isAlwaysBlockedAddress(address: string): boolean {
  return METADATA_ADDRESSES.has(address.toLowerCase());
}

/** Refused in every environment, including LOCAL. */
function isAlwaysBlockedHostname(hostname: string): boolean {
  return hostname === "metadata" || hostname === "metadata.google.internal" || hostname === "instance-data";
}

/**
 * Validates a webhook destination, resolving DNS and checking the resulting address.
 *
 * Call this at registration AND immediately before every delivery. Registration-time validation
 * alone is a DNS rebinding hole.
 */
export async function assertSafeWebhookTarget(
  raw: string,
  options: SsrfOptions = {}
): Promise<ValidatedTarget> {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new SsrfError("empty", "A webhook URL is required.");
  }
  if (raw.length > MAX_WEBHOOK_URL_LENGTH) {
    throw new SsrfError("too_long", `A webhook URL may be at most ${MAX_WEBHOOK_URL_LENGTH} characters.`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("malformed", "The webhook URL could not be parsed.");
  }

  const httpsRequired = !options.allowPrivate;
  if (httpsRequired && url.protocol !== "https:") {
    throw new SsrfError(
      "scheme",
      "A webhook URL must use https. The delivery carries a signed payload and must not travel in cleartext."
    );
  }
  if (!httpsRequired && url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SsrfError("scheme", "A webhook URL must use https (http is permitted only in LOCAL).");
  }

  if (url.username !== "" || url.password !== "") {
    throw new SsrfError(
      "credentials",
      "A webhook URL must not embed credentials. Use the signing secret to authenticate the delivery."
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isAlwaysBlockedHostname(hostname)) {
    throw new SsrfError("host", `The destination host ${hostname} is never permitted, in any environment.`);
  }
  if (!options.allowPrivate && BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SsrfError("host", `The destination host ${hostname} is not permitted.`);
  }
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    throw new SsrfError("host", `The destination host ${hostname} is an internal name and is not permitted.`);
  }

  // An IP literal needs no resolution, and resolving it would only add a failure mode.
  if (net.isIP(hostname)) {
    if (isAlwaysBlockedAddress(hostname)) {
      throw new SsrfError("address", `The destination address ${hostname} is instance metadata and is never permitted.`);
    }
    if (!options.allowPrivate && isBlockedAddress(hostname)) {
      throw new SsrfError("address", `The destination address ${hostname} is private, reserved or metadata.`);
    }
    return { url, address: hostname };
  }

  let resolved: { address: string }[];
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    throw new SsrfError("dns", `The destination host ${hostname} does not resolve.`);
  }
  if (resolved.length === 0) {
    throw new SsrfError("dns", `The destination host ${hostname} does not resolve.`);
  }

  // EVERY resolved address must be acceptable. A host that returns one public and one private
  // address would otherwise be reachable by retrying until the private one is selected.
  for (const entry of resolved) {
    if (isAlwaysBlockedAddress(entry.address)) {
      throw new SsrfError(
        "address",
        `The destination host ${hostname} resolves to ${entry.address}, which is instance metadata.`
      );
    }
    if (!options.allowPrivate && isBlockedAddress(entry.address)) {
      throw new SsrfError(
        "address",
        `The destination host ${hostname} resolves to ${entry.address}, which is private, reserved or metadata.`
      );
    }
  }

  return { url, address: resolved[0]!.address };
}
