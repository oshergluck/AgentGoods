/**
 * The single source of truth for every public URL this deployment advertises.
 *
 * Canonical URLs leak into a lot of places — the Agent manifest, the schema, OpenAPI servers, CORS,
 * webhook callbacks, Moltbook posts. When each of those builds its own string, they drift, and the
 * drift is invisible until an Agent follows one of them to a host that no longer exists.
 *
 * So they are derived here, once, and validated at startup.
 *
 * **It fails closed.** A PRODUCTION deployment whose canonical origin is still `localhost` is not a
 * deployment with a cosmetic problem; it is one that publishes a machine-readable document telling
 * every Agent to call a host they cannot reach. Refusing to start is the only response that cannot
 * be ignored, and it happens before the process ever serves a request.
 */

import type { Env } from "./env";

export interface CanonicalOrigins {
  /** Where a human or an Agent starts. Serves the UI and, in a same-origin deployment, the API. */
  publicOrigin: string;
  /** Absolute base every API path hangs off. Same as `publicOrigin` when same-origin. */
  apiBaseUrl: string;
  /** Where the observer UI lives. Same as `publicOrigin` when same-origin. */
  webOrigin: string;
  /** True when the UI and API share one hostname, so an Agent needs exactly one. */
  sameOrigin: boolean;
  /** Browser origins allowed to call authenticated endpoints. Never `*`. */
  allowedOrigins: string[];
}

/** Hosts that must never appear in a canonical PRODUCTION URL. */
const NON_PRODUCTION_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local)$/i;

/** Platform-assigned hostnames: fine for a rehearsal, wrong to advertise as canonical. */
const EPHEMERAL_HOST = /\.(up\.railway\.app|onrender\.com|vercel\.app|herokuapp\.com|fly\.dev)$/i;

function normalise(raw: string, field: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${field} is not a valid absolute URL: "${raw}"`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${field} must be a bare origin with no path, got "${raw}"`);
  }
  return `${url.protocol}//${url.host}`;
}

export function canonicalOrigins(env: Env): CanonicalOrigins {
  const isProduction = env.ESH_ENVIRONMENT === "PRODUCTION";
  const publicOrigin = normalise(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL");
  const webOrigin = env.PUBLIC_WEB_URL ? normalise(env.PUBLIC_WEB_URL, "PUBLIC_WEB_URL") : publicOrigin;

  const problems: string[] = [];
  if (isProduction) {
    for (const [field, value] of [
      ["PUBLIC_BASE_URL", publicOrigin],
      ["PUBLIC_WEB_URL", webOrigin],
    ] as const) {
      const url = new URL(value);
      if (url.protocol !== "https:") {
        problems.push(`${field} must be https in PRODUCTION, got ${url.protocol}//`);
      }
      if (NON_PRODUCTION_HOST.test(url.hostname)) {
        problems.push(
          `${field} is ${url.hostname}, which no Agent outside this machine can reach. ` +
            `A production manifest that advertises it is worse than one that is missing.`
        );
      }
      if (EPHEMERAL_HOST.test(url.hostname)) {
        problems.push(
          `${field} is the platform-assigned hostname ${url.hostname}. It works, but it is not a ` +
            `canonical identity: it changes when the service is recreated, and every Agent that ` +
            `cached it would then be pointing at nothing.`
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `PRODUCTION canonical URL configuration refused:\n  - ${problems.join("\n  - ")}\n` +
        `Set PUBLIC_BASE_URL (and PUBLIC_WEB_URL if the UI is elsewhere) to the real domain.`
    );
  }

  const sameOrigin = publicOrigin === webOrigin;

  /*
   * In a same-origin deployment the browser sends no Origin header for its own API calls, so the
   * allow-list exists for anything else that legitimately needs cross-origin access. It is still
   * explicit: `*` would let any page on the internet make authenticated calls with a user's key.
   */
  const configured = env.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins = [...new Set([webOrigin, ...configured])];

  return { publicOrigin, apiBaseUrl: publicOrigin, webOrigin, sameOrigin, allowedOrigins };
}

/** Absolute URL for a protocol path, so nothing downstream concatenates its own. */
export function absoluteUrl(origins: CanonicalOrigins, path: string): string {
  return `${origins.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
