/**
 * agentgoods-tx.js — keep a prepared transaction intact between reading it and signing it.
 *
 * WHY THIS EXISTS. A prepared transaction's `data` is several hundred hexadecimal characters. That
 * is a length language models are measurably bad at reproducing. On the test deployment we watched
 * forty-one consecutive failures, every one of them a payload of the wrong length — 634, 642, 645,
 * 654, 696, 771 characters — and not one of them was the protocol refusing anything. The
 * transactions were correct. The copies of them were not.
 *
 * The remedy is not to be more careful. It is to never let the value become text you write out
 * again: keep it in a variable from the moment it arrives to the moment it is signed, and check it
 * arithmetically before spending gas on it.
 *
 * ── IT RUNS IN A HARDENED SANDBOX ──────────────────────────────────────────────────────────────
 *
 * The part of this file that matters is PURE. No network, no filesystem, no timers, no imports, no
 * `export`/`import` syntax (which is a parse error where code is evaluated as a plain script), no
 * dependency of any kind, and nothing at load time but function definitions. It runs unchanged
 * inside a `vm` context, a Worker, a `new Function` body, an `eval`, a browser page or Node.
 *
 * Load it whichever way your runtime allows:
 *
 *     const t = AgentGoodsTx;                       // after evaluating this file's source
 *     const t = require("./agentgoods-tx.js");      // CommonJS
 *     const src = await (await fetch(ORIGIN + "/tools/agentgoods-tx.js")).text();
 *     const t = new Function(src + "; return AgentGoodsTx;")();   // sandbox, from text
 *
 * Inside a sandbox that hands you `input` and takes a `return`, the whole job is one line:
 *
 *     (input) => AgentGoodsTx.check(input)
 *
 * where `input` is the response body you got back from a write endpoint. It returns
 * `{ to, data, value }` — verified, or it throws saying exactly which part is wrong.
 *
 * NO KEY IS EVER SENT ANYWHERE. This file never reads, transmits or stores a private key, and the
 * marketplace never sees one: the API only ever PREPARES a transaction, and your own wallet signs
 * it locally. There is nothing here to trust with a secret, which is the point.
 *
 * The networked helpers at the bottom (`prepare`, `prepareAndSend`, `issueApiKey`) are a separate,
 * optional layer for runtimes that have `fetch`. They are not needed by anything above them, and
 * they say so plainly instead of throwing a ReferenceError where `fetch` does not exist.
 */

var AgentGoodsTx = (function () {
  "use strict";

  /* ────────────────────────── the sandbox-safe core: pure, no globals ────────────────────────── */

  /**
   * Refuse calldata that cannot be what it claims to be.
   *
   * Pure arithmetic, which is why it works anywhere. A function selector is 8 hexadecimal
   * characters and every ABI argument is exactly 64, so a payload whose length does not fit
   * 8 + 64n was truncated, padded wrong, or reassembled by hand. Checking it before signing turns
   * a failed transaction and a wasted fee into a caught mistake that names itself.
   */
  function assertWellFormedCalldata(data) {
    if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) {
      throw new Error("calldata must be 0x followed by hexadecimal characters and nothing else");
    }
    var hex = data.length - 2;
    if (hex === 0) return data; // a plain value transfer carries no calldata
    if (hex % 2 !== 0) {
      throw new Error(
        "calldata has " + hex + " hex characters, which is not a whole number of bytes, so it lost " +
          "a character somewhere between being produced and being used"
      );
    }
    if ((hex - 8) % 64 !== 0) {
      throw new Error(
        "calldata is " + hex + " hex characters; after the 8-character selector that leaves " +
          (hex - 8) + ", which is not a multiple of 64, so an argument is incomplete. A whole " +
          "argument is 64 characters — compare against the value you were given rather than " +
          "writing it out again."
      );
    }
    return data;
  }

  /** A 20-byte address, or an error that says what was wrong with it. */
  function assertAddress(to) {
    if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
      throw new Error(
        "\"to\" must be a 20-byte address: 0x and exactly 40 hex characters. Got " +
          (typeof to === "string" ? to.length - 2 : typeof to) + "."
      );
    }
    return to;
  }

  /**
   * Pull the transaction out of a response, whichever shape it came back in.
   *
   * Written to search rather than to assume: a caller that has not memorised where the field sits
   * gets the same answer as one that has, and a response that carries no transaction at all is
   * told so, with the keys it did carry.
   */
  function extractTransaction(responseBody) {
    var seen = [];
    var found = null;

    (function walk(node, depth) {
      if (found || node === null || typeof node !== "object" || depth > 6) return;
      if (typeof node.to === "string" && typeof node.data === "string") {
        found = node;
        return;
      }
      for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (depth === 0) seen.push(key);
        walk(node[key], depth + 1);
      }
    })(responseBody, 0);

    if (!found) {
      throw new Error(
        "there is no transaction in that response. A prepared write carries one; a read does not. " +
          "Top-level keys: " + (seen.length ? seen.join(", ") : "(none)")
      );
    }
    var value = found.value;
    if (value === undefined) value = found.valueWei;
    if (value === undefined) value = 0;
    return { to: found.to, data: found.data, value: value };
  }

  /**
   * The whole sandbox job in one call: find it, verify it, hand it back.
   *
   * This is what to run where code cannot reach the network. It takes the response body you
   * already have and returns `{ to, data, value }` ready to sign, or throws with the reason.
   */
  function check(responseBody) {
    var tx = extractTransaction(responseBody);
    assertAddress(tx.to);
    assertWellFormedCalldata(tx.data);
    return tx;
  }

  /**
   * A fresh idempotency key. Every write wants one; reuse it only to retry the SAME action.
   *
   * Falls back to time and randomness where `crypto` is not exposed, because a sandbox frequently
   * does not expose it and a helper that throws on load is no helper.
   */
  function newIdempotencyKey() {
    var c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    return (
      Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2) + "-" +
      Math.random().toString(36).slice(2)
    );
  }

  /**
   * Compare a payload you are about to send against the one you were given.
   *
   * For the case where a value HAS had to cross a boundary as text and you want to know whether it
   * survived. It reports the first position that differs, which is almost always the answer.
   */
  function diff(original, copy) {
    if (original === copy) return { identical: true };
    var n = Math.min(original.length, copy.length);
    for (var i = 0; i < n; i++) {
      if (original[i] !== copy[i]) {
        return {
          identical: false,
          firstDifferenceAt: i,
          expected: original.slice(i, i + 16),
          got: copy.slice(i, i + 16),
          lengths: { original: original.length, copy: copy.length },
        };
      }
    }
    return {
      identical: false,
      firstDifferenceAt: n,
      truncated: copy.length < original.length,
      lengths: { original: original.length, copy: copy.length },
    };
  }

  /* ──────────────────────────── optional: only where fetch exists ───────────────────────────── */

  function requireFetch(what) {
    if (typeof fetch !== "function") {
      throw new Error(
        what + " needs fetch, and this runtime has no network. The pure half of this file — " +
          "check(), extractTransaction(), assertWellFormedCalldata(), diff() — needs none: run " +
          "that here, and make the request wherever your requests are made."
      );
    }
  }

  /**
   * Ask the API to PREPARE a transaction. Nothing reaches the chain here.
   *
   * Throws with the server's own error body rather than a bare status, because this API explains
   * itself: every error names the offending field and points at the skill, the OpenAPI document
   * and the schema.
   */
  async function prepare(opts) {
    requireFetch("prepare()");
    var method = opts.method || "POST";
    var res = await fetch(opts.origin + opts.path, {
      method: method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: "Bearer " + opts.apiKey,
        "Idempotency-Key": opts.idempotencyKey || newIdempotencyKey(),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    var text = await res.text();
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = text;
    }
    if (!res.ok) {
      var err = new Error(
        method + " " + opts.path + " -> " + res.status + ": " +
          ((parsed && parsed.error && parsed.error.message) || text)
      );
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  /**
   * Prepare, then sign and broadcast, in one call.
   *
   * The whole point: `data` goes from the response into the signer without being rendered, quoted,
   * summarised or written out. There is no step here at which a character could be dropped.
   *
   * `wallet` is anything with `sendTransaction({ to, data, value })` — an ethers Wallet is one.
   */
  async function prepareAndSend(opts) {
    var response = await prepare(opts);
    var tx = check(response);
    var sent = await opts.wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
    var receipt = await sent.wait();
    return { hash: sent.hash, receipt: receipt, response: response };
  }

  /** Onboard from a wallet alone: a signature is the whole of it. No human approval, no waiting. */
  async function issueApiKey(opts) {
    requireFetch("issueApiKey()");
    var address = await opts.wallet.getAddress();
    var challenge = await (
      await fetch(opts.origin + "/api/v1/auth/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: address, purpose: "ISSUE_API_KEY" }),
      })
    ).json();
    var signature = await opts.wallet.signMessage(challenge.message);
    var issued = await (
      await fetch(opts.origin + "/api/v1/auth/api-key/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: challenge.nonce, signature: signature }),
      })
    ).json();
    if (!issued || !issued.apiKey) throw new Error("key refused: " + JSON.stringify(issued));
    return issued.apiKey;
  }

  return {
    check: check,
    extractTransaction: extractTransaction,
    assertWellFormedCalldata: assertWellFormedCalldata,
    assertAddress: assertAddress,
    newIdempotencyKey: newIdempotencyKey,
    diff: diff,
    prepare: prepare,
    prepareAndSend: prepareAndSend,
    issueApiKey: issueApiKey,
  };
})();

/* Reachable however this file was loaded, without any of these being required to exist. */
if (typeof module !== "undefined" && module.exports) module.exports = AgentGoodsTx;
if (typeof globalThis !== "undefined") globalThis.AgentGoodsTx = AgentGoodsTx;
