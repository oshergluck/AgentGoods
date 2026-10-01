/**
 * Seller profile / media parsing.
 *
 * A store profile and a product `metadataURI` may carry an INLINE JSON document describing the
 * thing for humans: display name, description, logo, illustrative images and video, tags.
 *
 * Two rules shape this module, and neither is negotiable:
 *
 *  1. THE BACKEND NEVER FETCHES A SELLER URL. The document lives on-chain, so the projection is
 *     rebuildable from chain alone with zero network egress. A seller cannot use a profile to
 *     make our infrastructure issue a request (SSRF), and cannot turn our IP into a tracking
 *     beacon. A non-inline value is kept verbatim as an opaque URI and is never dereferenced.
 *     See docs/DECISIONS.md D-017.
 *
 *  2. EVERY FIELD HERE IS UNTRUSTED SELLER CONTENT. It is sanitized for shape (length, control
 *     characters, URI scheme) and never for meaning. It is never an instruction to an Agent,
 *     never a source of a contract address, and never protocol truth. [MASTER_PLAN 0.24.P]
 *
 * Sanitization is deliberately shape-only and lossy-on-violation: a field that breaks a rule is
 * dropped and recorded in `rejected`, rather than being repaired into something the seller never
 * wrote.
 */

/** Hard bound on the raw document we will even attempt to parse. Mirrors the on-chain bound. */
export const MAX_PROFILE_BYTES = 8_192;

const MAX_NAME = 96;
const MAX_TAGLINE = 160;
const MAX_DESCRIPTION = 1_200;
const MAX_TAGS = 8;
const MAX_TAG = 24;
const MAX_MEDIA = 6;
const MAX_URI = 512;
const MAX_HIGHLIGHTS = 6;
const MAX_HIGHLIGHT = 120;

export type MediaKind = "image" | "video";

export interface MediaItem {
  kind: MediaKind;
  uri: string;
  /** Alt text for accessibility. Untrusted, sanitized, may be empty. */
  alt: string;
  /**
   * `same_origin` media is served by this deployment and is safe to render immediately.
   * `external` media is a third-party URL: rendering it leaks the viewer IP address to that
   * host, so the UI must require an explicit click before loading it.
   */
  origin: "same_origin" | "external" | "ipfs";
}

export interface SellerProfile {
  /** True when an inline JSON document was present and parsed. */
  parsed: boolean;
  /** The raw on-chain string, always preserved verbatim. */
  raw: string;
  /** Set when the raw value is an opaque URI rather than an inline document. */
  uri: string;
  name: string;
  tagline: string;
  description: string;
  highlights: string[];
  tags: string[];
  category: string;
  logo: MediaItem | null;
  cover: MediaItem | null;
  media: MediaItem[];
  /** Optional token presentation, used by the store AIC market listing. */
  token: {
    description: string;
    logo: MediaItem | null;
  };
  /**
   * Development iterations — build, test, fix cycles — behind this version, and the running total across every
   * version of the product. Declared by the seller at every upload and committed on chain in the listing.
   */
  iterations: number | null;
  iterationsTotal: number | null;
  iterationLogHash: string | null;
  /**
   * Set when the listing is a SERVICE: a callable the buyer pays to invoke, per call. The full spec
   * (input and output schemas) is stored by hash and served by GET /api/v1/services/{storeId}/{productId};
   * the listing commits its hash on chain. Null for a product sold or rented as an artifact.
   */
  service: { pricingModel: "PER_CALL"; specHash: string } | null;
  /** Field names dropped during sanitization, so the UI can be honest about it. */
  rejected: string[];
}

export function emptyProfile(raw = ""): SellerProfile {
  return {
    parsed: false,
    raw,
    uri: raw,
    name: "",
    tagline: "",
    description: "",
    highlights: [],
    tags: [],
    category: "",
    logo: null,
    cover: null,
    media: [],
    token: { description: "", logo: null },
    iterations: null,
    iterationsTotal: null,
    iterationLogHash: null,
    service: null,
    rejected: [],
  };
}

/**
 * Strips control characters and collapses whitespace, then truncates.
 *
 * Control characters are removed because a seller string is rendered in a terminal-styled UI and
 * echoed into Agent-facing JSON; bidi and zero-width characters are removed because they are the
 * classic way to make a displayed name differ from the stored one.
 */
function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    // C0/C1 controls, zero-width, bidi overrides, BOM.
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max).trimEnd() : cleaned;
}

/**
 * Accepts only URI forms that cannot execute and cannot be mistaken for protocol truth.
 *
 * - a rooted same-origin path (`/media/x.svg`) -- served by this deployment, safe to auto-load;
 * - `https://` -- third party, allowed but marked external so the UI gates it behind a click;
 * - `ipfs://` -- content addressed, marked so the UI can route it through a gateway of its choice.
 *
 * Everything else is rejected, explicitly including `javascript:`, `data:`, `blob:`, `file:`,
 * cleartext `http:` and protocol-relative `//host` forms.
 */
export function sanitizeUri(value: unknown): { uri: string; origin: MediaItem["origin"] } | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_URI) return null;
  if (/[\u0000-\u001F\u007F\s]/.test(raw)) return null;

  if (raw.startsWith("//")) return null;
  if (raw.startsWith("/")) {
    // Same-origin asset path. No traversal, no scheme smuggling.
    if (raw.includes("..") || raw.includes("\\")) return null;
    return { uri: raw, origin: "same_origin" };
  }
  const lower = raw.toLowerCase();
  if (lower.startsWith("https://")) {
    if (raw.length <= "https://".length) return null;
    return { uri: raw, origin: "external" };
  }
  if (lower.startsWith("ipfs://")) {
    const cid = raw.slice("ipfs://".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(cid)) return null;
    return { uri: raw, origin: "ipfs" };
  }
  return null;
}

const IMAGE_EXT = /\.(png|jpg|jpeg|webp|avif|gif|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|ogv|mov)$/i;

function mediaItem(
  value: unknown,
  fallbackKind: MediaKind,
  rejected: string[],
  label: string
): MediaItem | null {
  const node = typeof value === "string" ? { uri: value } : (value as Record<string, unknown> | null);
  if (!node || typeof node !== "object") return null;
  const uri = sanitizeUri(node.uri);
  if (!uri) {
    if (node.uri !== undefined) rejected.push(label);
    return null;
  }
  let kind: MediaKind = fallbackKind;
  const declared = typeof node.kind === "string" ? node.kind.toLowerCase() : "";
  if (declared === "image" || declared === "video") kind = declared;
  else if (VIDEO_EXT.test(uri.uri)) kind = "video";
  else if (IMAGE_EXT.test(uri.uri)) kind = "image";
  return { kind, uri: uri.uri, alt: text(node.alt, MAX_TAGLINE), origin: uri.origin };
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const cleaned = text(entry, maxLength);
    if (cleaned.length === 0) continue;
    if (out.includes(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Parses an on-chain profile string.
 *
 * `raw` is whatever the seller put on chain. A leading `{` means an inline document; anything
 * else is treated as an opaque URI and preserved without ever being dereferenced.
 */
export function parseProfile(raw: unknown): SellerProfile {
  const source = typeof raw === "string" ? raw : "";
  const profile = emptyProfile(source);
  const trimmed = source.trim();
  if (trimmed.length === 0) return profile;
  if (!trimmed.startsWith("{")) {
    // Opaque URI: kept, never fetched. The UI may still choose to render it as media.
    profile.uri = trimmed;
    return profile;
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_PROFILE_BYTES) {
    profile.rejected.push("document:too_large");
    return profile;
  }

  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      profile.rejected.push("document:not_an_object");
      return profile;
    }
    doc = parsed as Record<string, unknown>;
  } catch {
    profile.rejected.push("document:invalid_json");
    return profile;
  }

  const rejected = profile.rejected;
  profile.parsed = true;
  profile.uri = "";
  profile.name = text(doc.name, MAX_NAME);
  profile.tagline = text(doc.tagline, MAX_TAGLINE);
  profile.description = text(doc.description, MAX_DESCRIPTION);
  profile.highlights = stringList(doc.highlights, MAX_HIGHLIGHTS, MAX_HIGHLIGHT);
  profile.tags = stringList(doc.tags, MAX_TAGS, MAX_TAG);
  profile.category = text(doc.category, MAX_TAG);
  profile.logo = mediaItem(doc.logo, "image", rejected, "logo");
  profile.cover = mediaItem(doc.cover, "image", rejected, "cover");

  if (Array.isArray(doc.media)) {
    for (const entry of doc.media) {
      if (profile.media.length >= MAX_MEDIA) break;
      const item = mediaItem(entry, "image", rejected, "media");
      if (item) profile.media.push(item);
    }
  }

  const count = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : null;
  };
  profile.iterations = count(doc.iterations);
  profile.iterationsTotal = count(doc.iterationsTotal) ?? profile.iterations;
  profile.iterationLogHash = typeof doc.iterationLogHash === "string" && /^0x[0-9a-f]{64}$/i.test(doc.iterationLogHash) ? doc.iterationLogHash.toLowerCase() : null;

  const svc = (doc.service ?? null) as Record<string, unknown> | null;
  if (svc && typeof svc === "object" && !Array.isArray(svc)) {
    const specHash = typeof svc.specHash === "string" && /^0x[0-9a-f]{64}$/i.test(svc.specHash) ? svc.specHash.toLowerCase() : null;
    if (specHash && (svc.pricingModel === undefined || svc.pricingModel === "PER_CALL")) {
      profile.service = { pricingModel: "PER_CALL", specHash };
    } else {
      rejected.push("service");
    }
  }

  const token = (doc.token ?? null) as Record<string, unknown> | null;
  if (token && typeof token === "object" && !Array.isArray(token)) {
    profile.token.description = text(token.description, MAX_DESCRIPTION);
    profile.token.logo = mediaItem(token.logo, "image", rejected, "token.logo");
  }

  return profile;
}

/** Storable projection of a profile. Kept flat so Mongo can index name and tags. */
export interface StoredProfile {
  parsed: boolean;
  uri: string;
  name: string;
  tagline: string;
  description: string;
  highlights: string[];
  tags: string[];
  category: string;
  logo: MediaItem | null;
  cover: MediaItem | null;
  media: MediaItem[];
  tokenDescription: string;
  tokenLogo: MediaItem | null;
  iterations: number | null;
  iterationsTotal: number | null;
  iterationLogHash: string | null;
  serviceSpecHash: string | null;
  servicePricingModel: string | null;
  rejected: string[];
}

export function toStored(profile: SellerProfile): StoredProfile {
  return {
    parsed: profile.parsed,
    uri: profile.uri,
    name: profile.name,
    tagline: profile.tagline,
    description: profile.description,
    highlights: profile.highlights,
    tags: profile.tags,
    category: profile.category,
    logo: profile.logo,
    cover: profile.cover,
    media: profile.media,
    tokenDescription: profile.token.description,
    tokenLogo: profile.token.logo,
    iterations: profile.iterations,
    iterationsTotal: profile.iterationsTotal,
    iterationLogHash: profile.iterationLogHash,
    serviceSpecHash: profile.service?.specHash ?? null,
    servicePricingModel: profile.service?.pricingModel ?? null,
    rejected: profile.rejected,
  };
}
