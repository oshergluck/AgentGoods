/**
 * Per-page link previews for shared URLs.
 *
 * Every route is served the same SPA shell, so a link to a specific store or product previewed
 * as the generic site card. The people who share those links are sharing a *store*, and the
 * preview is the only thing most recipients see before deciding whether to open it.
 *
 * A link unfurler does not run JavaScript. WhatsApp, Telegram, Slack, iMessage and X all fetch
 * the HTML once and read the meta tags as they arrive, so the tags have to be correct in the
 * bytes the server sends. That means injecting them here, before the shell goes out.
 *
 * ## Seller text is untrusted, and this is the most exposed place it appears
 *
 * A store's name is chosen by its seller. In the UI it is one element among many, clearly inside
 * a page the reader knows they navigated to. In a WhatsApp preview it is a headline over the
 * words "agentgoods.ai", rendered by a client nobody controls, to a reader who has not visited
 * anything yet — it borrows the domain's credibility. Three rules follow, and none is optional:
 *
 * 1. **The seller never supplies a whole line.** The title is `{name} — a store on
 *    AgentGoods.AI`. The suffix is ours and always present, so the frame around the seller's
 *    words belongs to the protocol.
 * 2. **The description contains no seller free text at all.** It is built from protocol facts:
 *    store type, token symbol, product count. A seller cannot write the sentence that appears
 *    under the headline.
 * 3. **Everything is escaped for an HTML attribute and hard-capped**, after control characters
 *    are stripped and whitespace is collapsed. A name is at most 70 characters, which is also
 *    where every client truncates.
 *
 * See `TRUST_BOUNDARIES.md` §3.
 *
 * Failure is always silent: any lookup problem serves the unmodified shell. A link preview is
 * never worth a 500 on the page itself.
 */

import type { Request } from "express";
import { Store, Product, StockMarket } from "../db/models";
import { canonicalOrigins } from "../config/origins";
import type { Env } from "../config/env";

const NAME_MAX = 70;
const SITE = "AgentGoods.AI";

/** Escape for an HTML attribute value. Quotes included — the value lands inside `content="..."`. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Normalise seller text before it is escaped.
 *
 * Control characters and newlines are removed rather than escaped: a name containing a line
 * break is not a name, and some unfurlers re-parse the attribute in ways that make embedded
 * newlines worth avoiding entirely. Bidirectional overrides go too — they can visually reorder a
 * string so the rendered text differs from the text, which is the whole trick behind a spoofed
 * headline.
 */
function cleanSellerText(value: string | undefined | null, max: number): string {
  if (!value) return "";
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[‪-‮⁦-⁩‎‏]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1).trimEnd() + "…";
}

export interface PageMeta {
  title: string;
  description: string;
  url: string;
}

/** Resolve the preview for a path, or null when the generic site card is already correct. */
export async function metaForPath(req: Request, pathname: string): Promise<PageMeta | null> {
  const env = req.ctx?.env as Env | undefined;
  if (!env) return null;
  const origin = canonicalOrigins(env).webOrigin;
  const chainId = env.CHAIN_ID;

  const store = /^\/stores\/(0x[0-9a-fA-F]{64})\/?$/.exec(pathname);
  if (store) return storeMeta(chainId, store[1]!, origin);

  const product = /^\/products\/(0x[0-9a-fA-F]{64})\/?$/.exec(pathname);
  if (product) return productMeta(chainId, product[1]!, origin);

  return null;
}

async function storeMeta(chainId: number, storeId: string, origin: string): Promise<PageMeta | null> {
  const doc = await Store.findOne({ chainId, storeId })
    .select({
      storeId: 1,
      storeType: 1,
      aicToken: 1,
      "sellerContent.name": 1,
      "sellerContent.profile.name": 1,
    })
    .lean();
  if (!doc) return null;

  const [market, products] = await Promise.all([
    StockMarket.findOne({ chainId, aicToken: doc.aicToken }).select({ symbol: 1 }).lean(),
    Product.countDocuments({ chainId, storeId, active: true }),
  ]);

  /*
   * Two names exist and neither is more trustworthy than the other.
   *
   * `sellerContent.name` comes from the Factory's StoreCreated event; `profile.name` comes from
   * the off-chain metadata document, which is often absent (`profile.present === false`). The
   * profile is preferred when it exists because it is the one a seller can correct, and the
   * on-chain name is the fallback because it always exists. Both are seller-chosen, so both go
   * through exactly the same cleaning and escaping — the choice is about which is more current,
   * never about which is safer.
   */
  const name =
    cleanSellerText(doc.sellerContent?.profile?.name, NAME_MAX) ||
    cleanSellerText(doc.sellerContent?.name, NAME_MAX);
  const title = name ? `${name} — a store on ${SITE}` : `Store on ${SITE}`;

  /*
   * Protocol facts only. Nothing a seller writes reaches this line, which is what stops a
   * preview under our domain from carrying a claim we never checked.
   */
  const kind = doc.storeType === "rentals" ? "Rentals store" : "Sales store";
  const symbol = market?.symbol ? ` · ${cleanSellerText(market.symbol, 12)}` : "";
  const count = products === 1 ? "1 product" : `${products} products`;
  const description =
    `${kind}${symbol} · ${count} · on Base. Every store is a canonical, Factory-created contract ` +
    `with its own AIC — the business's ownership and control asset — and governance.`;

  return { title, description, url: `${origin}/stores/${storeId}` };
}

async function productMeta(chainId: number, productId: string, origin: string): Promise<PageMeta | null> {
  const doc = await Product.findOne({ chainId, productId })
    .select({ productId: 1, storeType: 1, priceUSDC: 1, storeId: 1, "sellerContent.profile.name": 1 })
    .lean();
  if (!doc) return null;

  const store = await Store.findOne({ chainId, storeId: doc.storeId })
    .select({ "sellerContent.name": 1, "sellerContent.profile.name": 1 })
    .lean();

  // A product has only the off-chain profile name. Unlike a store, there is no name in the
  // creation event to fall back to.
  const name = cleanSellerText(doc.sellerContent?.profile?.name, NAME_MAX);
  const title = name ? `${name} — ${SITE}` : `Product on ${SITE}`;

  // Price is a protocol value in USDC base units, so it is safe to render and worth rendering:
  // it is the single fact a recipient most wants before opening the link.
  const price = formatUSDC(doc.priceUSDC);
  const seller =
    cleanSellerText(store?.sellerContent?.profile?.name, NAME_MAX) ||
    cleanSellerText(store?.sellerContent?.name, NAME_MAX);
  const verb = doc.storeType === "rentals" ? "Rent" : "Buy";
  const from = seller ? ` from ${seller}` : "";

  return {
    title,
    description:
      `${verb} for ${price} USDC${from}, on Base. Purchases are made by autonomous agents ` +
      `through the protocol API; every buyer earns a share of the store.`,
    url: `${origin}/products/${productId}`,
  };
}

/** USDC has six decimals. Rendered to two, which is how every price in the UI reads. */
function formatUSDC(base: string): string {
  try {
    const value = BigInt(base);
    const whole = value / 1_000_000n;
    const cents = (value % 1_000_000n) / 10_000n;
    return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
  } catch {
    return "—";
  }
}

/**
 * Rewrite the shell's preview tags.
 *
 * Targeted replacements against the known tags rather than a template: the shell is the real
 * build output, and a missing tag must leave the document untouched rather than corrupt it.
 */
export function applyMeta(html: string, meta: PageMeta): string {
  const title = escapeAttribute(meta.title);
  const description = escapeAttribute(meta.description);
  const url = escapeAttribute(meta.url);

  const swap = (source: string, pattern: RegExp, replacement: string): string => {
    const next = source.replace(pattern, replacement);
    return next;
  };

  let out = html;
  // The <title> element is text, not an attribute, so it takes the element-content escape.
  out = swap(out, /<title>[\s\S]*?<\/title>/, `<title>${escapeText(meta.title)}</title>`);
  out = swap(out, /(<meta\s+name="description"\s+content=")[\s\S]*?(")/, `$1${description}$2`);
  out = swap(out, /(<meta\s+property="og:title"\s+content=")[\s\S]*?(")/, `$1${title}$2`);
  out = swap(out, /(<meta\s+property="og:url"\s+content=")[\s\S]*?(")/, `$1${url}$2`);
  out = swap(out, /(<meta\s+name="twitter:title"\s+content=")[\s\S]*?(")/, `$1${title}$2`);
  out = swap(out, /(<link\s+rel="canonical"\s+href=")[\s\S]*?(")/, `$1${url}$2`);

  // These two are written across multiple lines in the shell, so they are matched by name.
  out = out.replace(
    /(<meta\s+property="og:description"\s+content=")[\s\S]*?(")/,
    `$1${description}$2`
  );
  out = out.replace(
    /(<meta\s+name="twitter:description"\s+content=")[\s\S]*?(")/,
    `$1${description}$2`
  );

  return out;
}

/** Escape for element content. No quote handling needed; `<` and `&` are what matter. */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
