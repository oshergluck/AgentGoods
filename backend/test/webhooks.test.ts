/**
 * Webhook subsystem.
 *
 * The SSRF tests carry most of the weight here. A webhook URL is attacker-controlled input that
 * this server will later make a request to, so the destination policy is not a nicety — it is the
 * whole reason the feature can exist safely. These tests are written against the specific evasions
 * that work in practice: IPv4-mapped IPv6 literals, decimal-encoded addresses, hosts with one
 * public and one private answer, redirects, and cloud metadata.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { assertSafeWebhookTarget, isBlockedAddress, SsrfError } from "../src/webhooks/ssrf";
import { deriveWebhookSecret, signDelivery, verifyDelivery } from "../src/webhooks/signing";
import { backoffMs } from "../src/webhooks/worker";
import { deliveryEventId, WEBHOOK_EVENTS, isWebhookEvent } from "../src/webhooks/emitter";
import { keccak256 } from "ethers";
import { encryptContent, decryptContent, ContentIntegrityError } from "../src/access/content";
import { issueAccessToken, verifyAccessToken } from "../src/access/tokens";

async function rejects(url: string): Promise<SsrfError> {
  try {
    await assertSafeWebhookTarget(url);
  } catch (error) {
    assert.ok(error instanceof SsrfError, `expected an SsrfError for ${url}, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${url} to be rejected, but it was accepted` });
}

describe("Webhook destination policy (SSRF)", { concurrency: 1 }, () => {
  test("rejects loopback in every spelling that reaches it", async () => {
    for (const url of [
      "https://127.0.0.1/hook",
      "https://127.0.0.2/hook",
      "https://[::1]/hook",
      "https://localhost/hook",
      "https://LOCALHOST/hook",
      "https://[::ffff:127.0.0.1]/hook",
    ]) {
      const error = await rejects(url);
      assert.ok(["address", "host"].includes(error.reason), `${url} -> ${error.reason}`);
    }
  });

  test("rejects cloud instance metadata, which is the highest-value SSRF target", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://169.254.170.2/v2/credentials",
      "https://100.100.100.200/latest/meta-data",
      "https://metadata.google.internal/computeMetadata/v1/",
    ]) {
      await rejects(url);
    }
  });

  test("rejects every private and reserved IPv4 range", async () => {
    for (const address of [
      "10.0.0.1",
      "10.255.255.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "100.64.0.1", // carrier-grade NAT
      "169.254.1.1", // link-local
      "0.0.0.0",
      "224.0.0.1", // multicast
      "255.255.255.255", // broadcast
      "198.18.0.1", // benchmarking
    ]) {
      assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
      await rejects(`https://${address}/hook`);
    }
  });

  test("rejects private IPv6 including unique-local and link-local", async () => {
    for (const address of ["::1", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "::"]) {
      assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
    }
  });

  test("does not accept an IPv4-mapped IPv6 literal as a way around the IPv4 rules", async () => {
    for (const dotted of ["::ffff:10.0.0.1", "::ffff:192.168.0.1", "::ffff:169.254.169.254", "::127.0.0.1"]) {
      assert.equal(isBlockedAddress(dotted), true, dotted);
    }

    /*
     * The HEX spellings of the same addresses. `new URL()` rewrites `[::ffff:127.0.0.1]` into
     * `[::ffff:7f00:1]`, so a check written only against the dotted form passes its own test and
     * lets the normalized form straight through. That was a real bypass here, not a theoretical
     * one, which is why both spellings are asserted.
     */
    for (const hex of ["::ffff:7f00:1", "::ffff:a00:1", "::ffff:c0a8:1", "::ffff:a9fe:a9fe", "::7f00:1"]) {
      assert.equal(isBlockedAddress(hex), true, hex);
    }

    // A genuinely public address in the same notation must still be accepted.
    assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
    assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
  });

  test("requires https, so a signed payload never travels in cleartext", async () => {
    const error = await rejects("http://example.com/hook");
    assert.equal(error.reason, "scheme");
    for (const url of ["ftp://example.com/x", "file:///etc/passwd", "gopher://example.com/"]) {
      await rejects(url);
    }
  });

  test("rejects embedded credentials", async () => {
    const error = await rejects("https://user:pass@example.com/hook");
    assert.equal(error.reason, "credentials");
  });

  test("rejects internal naming conventions that resolve differently inside a network", async () => {
    for (const url of ["https://api.internal/hook", "https://printer.local/hook"]) {
      const error = await rejects(url);
      assert.equal(error.reason, "host");
    }
  });

  test("rejects a host that does not resolve, rather than deferring the failure to delivery", async () => {
    const error = await rejects("https://this-name-should-never-resolve-aic.invalid/hook");
    assert.equal(error.reason, "dns");
  });

  test("rejects a malformed or oversized URL", async () => {
    assert.equal((await rejects("not a url")).reason, "malformed");
    assert.equal((await rejects(`https://example.com/${"a".repeat(3000)}`)).reason, "too_long");
  });

  test("accepts a loopback destination only when explicitly permitted, which is LOCAL only", async () => {
    await rejects("https://127.0.0.1/hook");
    const allowed = await assertSafeWebhookTarget("http://127.0.0.1:9999/hook", { allowPrivate: true });
    assert.equal(allowed.url.hostname, "127.0.0.1");
  });
});

describe("Webhook signing", { concurrency: 1 }, () => {
  test("derives a stable secret that is never read back from storage", () => {
    const a = deriveWebhookSecret("master-key", "wh_abc", 1);
    const b = deriveWebhookSecret("master-key", "wh_abc", 1);
    assert.equal(a.secret, b.secret, "the worker must be able to recompute the signing key");
    assert.ok(a.secret.startsWith("whsec_"));

    // A different master key, id or version must produce a different secret.
    assert.notEqual(deriveWebhookSecret("other-key", "wh_abc", 1).secret, a.secret);
    assert.notEqual(deriveWebhookSecret("master-key", "wh_def", 1).secret, a.secret);
    assert.notEqual(deriveWebhookSecret("master-key", "wh_abc", 2).secret, a.secret);
  });

  test("the stored hash cannot be used to forge a delivery", () => {
    const derived = deriveWebhookSecret("master-key", "wh_abc", 1);
    const body = JSON.stringify({ type: "product.created" });
    // Signing with the stored hash instead of the secret must not verify.
    const forged = signDelivery(body, derived.secretHash);
    assert.equal(verifyDelivery(body, forged.header, derived.secret), false);
  });

  test("verifies a well-formed signature and rejects every tampering", () => {
    const secret = deriveWebhookSecret("master-key", "wh_sig", 1).secret;
    const body = JSON.stringify({ type: "dividend.claim_available", amount: "1000000" });
    const signature = signDelivery(body, secret);

    assert.equal(verifyDelivery(body, signature.header, secret), true);
    assert.equal(verifyDelivery(`${body} `, signature.header, secret), false, "body tampering");
    assert.equal(verifyDelivery(body, signature.header, "whsec_wrong"), false, "wrong secret");
    assert.equal(verifyDelivery(body, "garbage", secret), false, "malformed header");
    assert.equal(
      verifyDelivery(body, signature.header.replace(/s=[0-9a-f]{64}/, `s=${"0".repeat(64)}`), secret),
      false,
      "zeroed mac"
    );
  });

  test("rejects a replayed delivery outside the timestamp tolerance", () => {
    const secret = deriveWebhookSecret("master-key", "wh_replay", 1).secret;
    const body = JSON.stringify({ type: "store.created" });
    const old = signDelivery(body, secret, Math.floor(Date.now() / 1000) - 3600);

    assert.equal(verifyDelivery(body, old.header, secret), false, "an hour-old delivery is a replay");
    // The same signature was valid at the time it was produced.
    assert.equal(
      verifyDelivery(body, old.header, secret, Math.floor(Date.now() / 1000) - 3600),
      true
    );
  });

  test("a timestamp change invalidates the signature, so the replay window cannot be widened", () => {
    const secret = deriveWebhookSecret("master-key", "wh_ts", 1).secret;
    const body = JSON.stringify({ type: "store.created" });
    const signature = signDelivery(body, secret, 1_700_000_000);
    const shifted = signature.header.replace("t=1700000000", `t=${Math.floor(Date.now() / 1000)}`);
    assert.equal(verifyDelivery(body, shifted, secret), false);
  });
});

describe("Webhook delivery semantics", { concurrency: 1 }, () => {
  test("event ids are stable, so a replayed log deduplicates instead of redelivering", () => {
    const a = deliveryEventId(31337, "0xABC", 4, "product.created");
    const b = deliveryEventId(31337, "0xabc", 4, "product.created");
    assert.equal(a, b, "case of the tx hash must not change identity");
    assert.notEqual(a, deliveryEventId(31337, "0xabc", 5, "product.created"));
    assert.notEqual(a, deliveryEventId(31337, "0xabc", 4, "store.created"));
    assert.notEqual(a, deliveryEventId(8453, "0xabc", 4, "product.created"));
  });

  test("backoff grows and is capped, so a dead endpoint is not retried in a tight loop", () => {
    let previous = 0;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const wait = backoffMs(attempt);
      assert.ok(wait >= 2_500, `attempt ${attempt} waited ${wait}ms`);
      assert.ok(wait <= 300_000, `attempt ${attempt} exceeded the cap`);
      if (attempt > 1) assert.ok(wait >= previous / 2, "backoff must not collapse");
      previous = wait;
    }
    assert.ok(backoffMs(50) <= 300_000, "backoff is capped however many attempts have failed");
  });

  test("only the published event catalogue is accepted", () => {
    for (const event of WEBHOOK_EVENTS) assert.equal(isWebhookEvent(event), true);
    for (const bogus of ["", "product.deleted", "admin.drain", "store.created "]) {
      assert.equal(isWebhookEvent(bogus), false, `${bogus} must not be a valid subscription`);
    }
  });

  test("a real endpoint receives a verifiable signature over the exact bytes sent", async () => {
    const received: { body: string; signature: string; eventId: string }[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += String(c)));
      req.on("end", () => {
        received.push({
          body: raw,
          signature: String(req.headers["x-aic-signature"] ?? ""),
          eventId: String(req.headers["x-aic-event-id"] ?? ""),
        });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const secret = deriveWebhookSecret("master-key", "wh_live", 1).secret;
      const payload = { type: "product.created", eventId: "abc123", chainId: 31337 };
      const rawBody = JSON.stringify(payload);
      const signature = signDelivery(rawBody, secret);

      const target = await assertSafeWebhookTarget(`http://127.0.0.1:${port}/hook`, { allowPrivate: true });
      const response = await fetch(target.url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-aic-signature": signature.header,
          "x-aic-event-id": "abc123",
        },
        body: rawBody,
      });

      assert.equal(response.status, 200);
      assert.equal(received.length, 1);
      // The receiver verifies over the RAW bytes it read, which is the documented algorithm.
      assert.equal(verifyDelivery(received[0]!.body, received[0]!.signature, secret), true);
      assert.equal(received[0]!.eventId, "abc123");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/* ====================================================================== */

/**
 * Content encryption and delivery tokens.
 *
 * Delivered plaintext cannot be un-delivered — that asymmetry is why V1 has no refund path — so
 * the properties tested here are the ones that decide whether the wrong person can ever receive
 * bytes, or whether the right person can receive the wrong bytes.
 */
describe("Delivered content encryption", { concurrency: 1 }, () => {
  const MASTER = "test-content-master-key-0000000000000000";
  const STORE = "0x" + "ab".repeat(32);

  test("round-trips and commits the keccak256 the chain will pin", () => {
    const plaintext = Buffer.from("the curated corpus, v3", "utf8");
    const encrypted = encryptContent(plaintext, MASTER, STORE);

    assert.equal(encrypted.contentHash, keccak256(plaintext), "the hash is over the PLAINTEXT");
    assert.ok(!encrypted.blob.includes(plaintext.toString("base64")), "the blob is not the plaintext");

    const back = decryptContent(encrypted.blob, MASTER, STORE, encrypted.contentHash);
    assert.deepEqual(back, plaintext);
  });

  test("refuses to serve content that does not match the committed hash", () => {
    const encrypted = encryptContent(Buffer.from("real content"), MASTER, STORE);
    const otherHash = keccak256(Buffer.from("different content"));
    assert.throws(
      () => decryptContent(encrypted.blob, MASTER, STORE, otherHash),
      ContentIntegrityError,
      "content sold under one hash must never be served under another"
    );
  });

  test("detects tampering, because a buyer cannot tell altered bytes from real ones", () => {
    const encrypted = encryptContent(Buffer.from("untampered"), MASTER, STORE);
    const raw = Buffer.from(encrypted.blob, "base64");
    raw[raw.length - 20] ^= 0xff; // flip a bit inside the ciphertext
    assert.throws(
      () => decryptContent(raw.toString("base64"), MASTER, STORE, encrypted.contentHash),
      ContentIntegrityError
    );
  });

  test("a blob cannot be moved to another store and still decrypt", () => {
    const encrypted = encryptContent(Buffer.from("store A content"), MASTER, STORE);
    const otherStore = "0x" + "cd".repeat(32);
    assert.throws(
      () => decryptContent(encrypted.blob, MASTER, otherStore, encrypted.contentHash),
      ContentIntegrityError,
      "the store is authenticated, so a swapped blob fails rather than mis-delivering"
    );
  });

  test("the wrong master key decrypts nothing", () => {
    const encrypted = encryptContent(Buffer.from("secret"), MASTER, STORE);
    assert.throws(
      () => decryptContent(encrypted.blob, "another-master-key-000000000000000000000", STORE, encrypted.contentHash),
      ContentIntegrityError
    );
  });

  test("the same plaintext encrypts differently every time", () => {
    const a = encryptContent(Buffer.from("same bytes"), MASTER, STORE);
    const b = encryptContent(Buffer.from("same bytes"), MASTER, STORE);
    assert.notEqual(a.blob, b.blob, "a fresh IV per encryption");
    assert.equal(a.contentHash, b.contentHash, "but the same content hash");
  });
});

describe("Delivery URL tokens", { concurrency: 1 }, () => {
  const KEY = "test-access-token-key-000000000000000000";

  test("verifies a token it issued", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const token = issueAccessToken({ sessionId: "abcdefgh12345678", expiresAt }, KEY);
    const result = verifyAccessToken(token, KEY);
    assert.equal(result.ok, true);
    assert.equal(result.payload!.sessionId, "abcdefgh12345678");
  });

  test("rejects a token edited to name a different session", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const token = issueAccessToken({ sessionId: "abcdefgh12345678", expiresAt }, KEY);
    const swapped = token.replace("abcdefgh12345678", "zzzzzzzz87654321");
    assert.equal(verifyAccessToken(swapped, KEY).failure, "bad_signature");
  });

  test("rejects a token whose expiry was extended", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const token = issueAccessToken({ sessionId: "abcdefgh12345678", expiresAt }, KEY);
    const extended = token.replace(String(expiresAt), String(expiresAt + 86400));
    assert.equal(verifyAccessToken(extended, KEY).failure, "bad_signature");
  });

  test("rejects an expired token, and a token signed with another key", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = issueAccessToken({ sessionId: "abcdefgh12345678", expiresAt: past }, KEY);
    assert.equal(verifyAccessToken(expired, KEY).failure, "expired");

    const foreign = issueAccessToken(
      { sessionId: "abcdefgh12345678", expiresAt: Math.floor(Date.now() / 1000) + 300 },
      "a-completely-different-signing-key-00000"
    );
    assert.equal(verifyAccessToken(foreign, KEY).failure, "bad_signature");
  });

  test("rejects malformed shapes without doing any lookup work", () => {
    for (const bogus of ["", "garbage", "a1.short.1.x", "a2.abcdefgh12345678.999.x", "a1..1.x"]) {
      const result = verifyAccessToken(bogus, KEY);
      assert.equal(result.ok, false, bogus);
    }
  });
});

/* ====================================================================== */

/**
 * The procedural artwork engine is duplicated: `frontend/scripts/media-engine.mjs` generates
 * files offline, and `frontend/src/lib/mediaEngine.js` renders the same artwork at runtime for
 * listings that have no file yet. If the two drift, a listing changes appearance the moment the
 * offline generator happens to run for it — a confusing, hard-to-attribute bug. This asserts the
 * generating code is identical.
 */
describe("Procedural artwork engine", { concurrency: 1 }, () => {
  test("the offline generator and the runtime copy are the same engine", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "..", "..", "frontend");

    const offline = fs.readFileSync(path.join(root, "scripts", "media-engine.mjs"), "utf8");
    const runtime = fs.readFileSync(path.join(root, "src", "lib", "mediaEngine.js"), "utf8");

    // The header comment differs deliberately; everything from the first export must match.
    const bodyOf = (source: string): string => source.slice(source.indexOf("/* ------"));
    assert.equal(
      bodyOf(runtime),
      bodyOf(offline),
      "media-engine.mjs and mediaEngine.js have drifted; copy one over the other"
    );
  });

  test("artwork is deterministic per id and different across ids", async () => {
    const { coverSvg, logoSvg } = (await import("../../frontend/src/lib/mediaEngine.js")) as {
      coverSvg: (seed: string, caption?: string) => string;
      logoSvg: (seed: string, initials?: string) => string;
    };

    const a = coverSvg("0xaaaa", "A");
    assert.equal(coverSvg("0xaaaa", "A"), a, "the same id always produces the same artwork");
    assert.notEqual(coverSvg("0xbbbb", "A"), a, "a different id produces different artwork");
    assert.notEqual(logoSvg("0xaaaa"), logoSvg("0xbbbb"));

    // A caption is untrusted seller text and must be escaped into the SVG, never injected.
    const injected = coverSvg("0xcccc", '"><script>alert(1)</script>');
    assert.ok(!injected.includes("<script>"), "a seller caption cannot inject markup into the SVG");
    assert.ok(injected.includes("&lt;script&gt;"));
  });

  test("a large catalogue does not visibly repeat", async () => {
    const { coverSvg } = (await import("../../frontend/src/lib/mediaEngine.js")) as {
      coverSvg: (seed: string, caption?: string) => string;
    };
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) seen.add(coverSvg(`0x${i.toString(16).padStart(64, "0")}`));
    assert.equal(seen.size, 300, "300 ids produced 300 distinct images");
  });
});
