/**
 * Serve protocol documents as JSON to machines, and as HTML to clients that can only read HTML.
 *
 * ## Why this exists
 *
 * An external Agent could reach `https://agentgoods.ai/` but not `/.well-known/aic-agent.json`,
 * `/api/v1/schema` or `/api/v1/openapi.json`. The pattern was exact and it was not about paths:
 *
 *     /                              text/html          reachable
 *     /docs                          text/html          reachable
 *     /.well-known/aic-agent.json    application/json   NOT reachable
 *     /api/v1/schema                 application/json   NOT reachable
 *     /api/v1/openapi.json           application/json   NOT reachable
 *
 * Some assistant browsing tools fetch through a browser-shaped pipeline and simply cannot render a
 * raw `application/json` response — the request succeeds and the tool reports the resource as
 * unavailable. The server is behaving correctly and the client still cannot proceed.
 *
 * That is a fatal shape for THIS product specifically. The root page tells an Agent "start here"
 * and points at the manifest; if the manifest is the one thing such a client cannot read, the
 * bootstrap chain breaks at step two, and the marketplace is unusable by a large class of the
 * exact clients it was built for.
 *
 * ## Why content negotiation rather than changing the type
 *
 * The canonical representation stays `application/json`, always, for every client that can accept
 * it. Serving the manifest as anything else by default would break every conforming Agent to
 * accommodate one that is non-conforming. HTTP already has the mechanism for "same resource, two
 * representations", and this is exactly the case it was designed for.
 *
 * The negotiation is deliberately conservative. HTML is served ONLY when the client's stated
 * preference for HTML is strictly stronger than its preference for JSON:
 *
 *     (absent)                                            -> JSON
 *     `*​/*`                                    (curl)     -> JSON
 *     `application/json`                       (an Agent) -> JSON
 *     `text/html,...,*​/*;q=0.8`                (a browser)-> HTML   (html q=1.0 > json q=0.8)
 *     `text/html,application/json`             (ambiguous)-> JSON   (equal, so canonical wins)
 *
 * Ties go to JSON. A client that does not express a preference is treated as a machine, because
 * the cost of guessing wrong in that direction is zero and the cost in the other direction is a
 * broken Agent.
 *
 * The HTML representation is not a consolation prize: it carries the complete document verbatim,
 * plus `<link rel="alternate" type="application/json">` and a visible canonical URL, so a client
 * that lands on the HTML can still find and quote the real thing.
 *
 * Every response sets `Vary: Accept`, without which a shared cache would serve one
 * representation to clients that asked for the other.
 */

import type { Request, Response } from "express";

/** One entry of an Accept header, reduced to what matters here. */
interface AcceptEntry {
  type: string;
  quality: number;
}

function parseAccept(header: string): AcceptEntry[] {
  return header
    .split(",")
    .map((part) => {
      const [rawType, ...params] = part.trim().split(";");
      const type = (rawType ?? "").trim().toLowerCase();
      let quality = 1;
      for (const param of params) {
        const [key, value] = param.split("=").map((s) => s.trim().toLowerCase());
        if (key === "q") {
          const parsed = Number.parseFloat(value ?? "");
          // A malformed q is ignored rather than treated as 0, which would silently drop a type.
          if (Number.isFinite(parsed)) quality = Math.min(Math.max(parsed, 0), 1);
        }
      }
      return { type, quality };
    })
    .filter((entry) => entry.type.length > 0);
}

/** The best quality this Accept header assigns to a concrete media type, wildcards included. */
function qualityFor(entries: AcceptEntry[], mediaType: string): number {
  const [group] = mediaType.split("/");
  let best = 0;
  for (const entry of entries) {
    if (entry.type === mediaType || entry.type === `${group}/*` || entry.type === "*/*") {
      best = Math.max(best, entry.quality);
    }
  }
  return best;
}

/**
 * Does this client prefer HTML strictly more than JSON?
 *
 * Exported for tests, because the whole safety of this feature is in the word "strictly": any
 * drift that makes a `*​/*` client receive HTML turns a fix for one broken client into an outage
 * for every correct one.
 */
export function prefersHtml(acceptHeader: string | undefined | null): boolean {
  if (!acceptHeader || !acceptHeader.trim()) return false;
  const entries = parseAccept(acceptHeader);
  const html = qualityFor(entries, "text/html");
  const json = qualityFor(entries, "application/json");
  return html > json;
}

/** Escape for HTML element content. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface DocumentMeta {
  /** Short name of the document, used as the page title. */
  title: string;
  /** One sentence explaining what the document is for. */
  summary: string;
  /** Absolute canonical URL of the JSON representation. */
  canonicalUrl: string;
}

/**
 * The HTML representation.
 *
 * Deliberately a single self-contained document with no script and no external resource: it is
 * served under the API's strict CSP (`default-src 'none'`), and anything it referenced would be
 * blocked. Inline style only, kept minimal.
 *
 * The JSON is rendered inside `<pre>` exactly as it is served, so a client reading this page can
 * copy the document and get byte-equivalent content.
 */
function renderHtml(data: unknown, meta: DocumentMeta): string {
  const json = JSON.stringify(data, null, 2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(meta.title)} — AgentGoods.AI</title>
<link rel="canonical" href="${escapeHtml(meta.canonicalUrl)}" />
<link rel="alternate" type="application/json" href="${escapeHtml(meta.canonicalUrl)}" title="${escapeHtml(meta.title)} (JSON)" />
<meta name="description" content="${escapeHtml(meta.summary)}" />
<style>
:root{color-scheme:dark}
body{margin:0;padding:24px;background:#05070d;color:#e9eef8;
 font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
h1{font-size:18px;margin:0 0 6px}
p{margin:0 0 6px;color:#8b96ad;max-width:80ch}
a{color:#38e1d2}
.note{border:1px solid #1d2433;border-radius:8px;padding:12px 14px;margin:16px 0;background:#0a0e18}
pre{white-space:pre-wrap;word-wrap:break-word;background:#0a0e18;border:1px solid #1d2433;
 border-radius:8px;padding:16px;overflow-x:auto}
</style>
</head>
<body>
<h1>${escapeHtml(meta.title)}</h1>
<p>${escapeHtml(meta.summary)}</p>
<div class="note">
<p><strong>This is the HTML rendering of a JSON document.</strong> The canonical representation is
<a href="${escapeHtml(meta.canonicalUrl)}">${escapeHtml(meta.canonicalUrl)}</a>, served as
<code>application/json</code>. You are seeing HTML because your client said it prefers HTML over
JSON. The content below is identical to the JSON response, byte for byte once parsed.</p>
<p>If you are an autonomous Agent, request this URL with
<code>Accept: application/json</code> and you will receive the JSON directly.</p>
</div>
<pre>${escapeHtml(json)}</pre>
</body>
</html>
`;
}

/**
 * Send a protocol document in whichever representation the client can actually read.
 *
 * Replaces `res.json(...)` at the public discovery endpoints. Everything else keeps returning
 * JSON unconditionally — this is for the documents an Agent must read before it has credentials,
 * which are the only ones where an unreadable response is fatal rather than inconvenient.
 */
export function sendDocument(req: Request, res: Response, data: unknown, meta: DocumentMeta): void {
  // Without this a shared cache can hand the HTML to a client that asked for JSON, which would
  // break conforming Agents intermittently and be very hard to reproduce.
  res.setHeader("Vary", "Accept");

  if (prefersHtml(req.headers.accept)) {
    res.type("html").send(renderHtml(data, meta));
    return;
  }
  res.json(data);
}
