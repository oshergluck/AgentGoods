/**
 * Signed, short-lived access URLs.
 *
 * A delivery URL is handed to a buyer and then travels: through logs, proxies, a browser history,
 * a copy-pasted message. So it is designed to be worth very little on its own:
 *
 *  - it expires in minutes, not hours;
 *  - it is bound to ONE session, which is bound to one license, one product and one wallet;
 *  - it is signed with a server key, so it cannot be forged or edited — changing the licence id
 *    in the URL invalidates the signature rather than granting someone else's content;
 *  - it is single-use by default, so a leaked URL that has already been redeemed is inert.
 *
 * The token is deliberately NOT a bearer credential for the API. It grants exactly one thing:
 * fetching the content of the session it names. An API key cannot be substituted for it and it
 * cannot be substituted for an API key.
 */

import crypto from "node:crypto";

export const ACCESS_TOKEN_VERSION = "a1";

export interface AccessTokenPayload {
  sessionId: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * `a1.<sessionId>.<expiresAt>.<mac>`
 *
 * Every field the server needs is in the token, so redeeming it requires no lookup before the
 * signature is checked. That ordering matters: an unauthenticated caller must not be able to make
 * the server do database work by guessing session ids.
 */
export function issueAccessToken(payload: AccessTokenPayload, signingKey: string): string {
  const body = `${ACCESS_TOKEN_VERSION}.${payload.sessionId}.${payload.expiresAt}`;
  const mac = crypto.createHmac("sha256", signingKey).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export type AccessTokenFailure = "malformed" | "bad_signature" | "expired";

export interface AccessTokenResult {
  ok: boolean;
  payload?: AccessTokenPayload;
  failure?: AccessTokenFailure;
}

export function verifyAccessToken(
  token: string,
  signingKey: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): AccessTokenResult {
  if (typeof token !== "string" || token.length > 512) return { ok: false, failure: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== ACCESS_TOKEN_VERSION) {
    return { ok: false, failure: "malformed" };
  }
  const [, sessionId, expiresRaw, mac] = parts;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId!) || !/^\d{1,12}$/.test(expiresRaw!)) {
    return { ok: false, failure: "malformed" };
  }

  const body = `${ACCESS_TOKEN_VERSION}.${sessionId}.${expiresRaw}`;
  const expected = crypto.createHmac("sha256", signingKey).update(body).digest("base64url");

  // Constant time, and length-checked first because timingSafeEqual throws on a length mismatch.
  const provided = Buffer.from(mac!, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuf.length || !crypto.timingSafeEqual(provided, expectedBuf)) {
    return { ok: false, failure: "bad_signature" };
  }

  // Expiry is checked AFTER the signature, so an expired-but-valid token and a forged one are not
  // distinguishable by timing, and a forged token never reaches the expiry branch at all.
  const expiresAt = Number(expiresRaw);
  if (expiresAt <= nowSeconds) return { ok: false, failure: "expired" };

  return { ok: true, payload: { sessionId: sessionId!, expiresAt } };
}
