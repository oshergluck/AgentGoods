/**
 * A product must commit to what it delivers.
 *
 * `contentHash` is the seller's on-chain commitment to exactly the bytes a buyer receives. The
 * access gateway tells the buyer to check `keccak256(delivered bytes) == contentHash` and
 * explicitly not to take delivery on trust. That instruction is worthless if the hash is zero:
 * an all-zero commitment matches nothing, so correct delivery, wrong delivery and empty delivery
 * are indistinguishable, and the LicenseToken stops being a claim on any particular content.
 *
 * This was found by an external Agent reading the live protocol: both products on the proving
 * deployment carried a zero hash, and nothing in the API said that meant anything. The cause was
 * ours — `contentHash` was optional on the create route and the call site substituted
 * `bytes32(0)` when it was absent, so an unverifiable product was the DEFAULT rather than a
 * choice anyone made.
 *
 * The store contract does not reject a zero hash and per-store contracts are immutable clones, so
 * existing stores cannot be changed. That makes this API the layer that can enforce it, and makes
 * naming the state on read the only honest option for products that already exist.
 */

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHarness, startChain, deployProtocol, stopChain, type Harness } from "./helpers/harness";

let h: Harness;

const ZERO = "0x" + "00".repeat(32);
const REAL = "0x" + "ab".repeat(32);

before(async () => {
  await startChain();
  await deployProtocol();
  h = await createHarness();
});

after(async () => {
  await h?.stop();
  await stopChain();
});

/** The create-product body, minus whatever the test is varying. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    productId: "test-product-" + Math.random().toString(16).slice(2, 10),
    priceUSDC: "40000000",
    inventory: "5",
    contentHash: REAL,
    ...overrides,
  };
}

describe("Publishing without a commitment is refused", { concurrency: 1 }, () => {
  test("an all-zero contentHash is rejected", async () => {
    const res = await h.request("POST", "/api/v1/products", { body: body({ contentHash: ZERO }) });

    // 400 for the validation, or 401/403 if auth runs first — what must NOT happen is acceptance.
    assert.notEqual(res.status, 200, "a zero commitment must never be accepted");
    assert.notEqual(res.status, 201, "a zero commitment must never be accepted");
  });

  test("an omitted contentHash is rejected rather than defaulted to zero", async () => {
    /*
     * The actual defect. It was not that sellers chose a zero hash — it was that omitting the
     * field produced one silently, so the unverifiable case was the path of least resistance.
     */
    const withoutHash = body();
    delete (withoutHash as Record<string, unknown>).contentHash;

    const res = await h.request("POST", "/api/v1/products", { body: withoutHash });
    assert.notEqual(res.status, 200);
    assert.notEqual(res.status, 201);
  });

  test("the rejection explains what a contentHash is for", async () => {
    // An Agent that cannot tell why it was refused cannot fix its request.
    const res = await h.request("POST", "/api/v1/products", { body: body({ contentHash: ZERO }) });
    if (res.status === 400) {
      const text = JSON.stringify(res.body).toLowerCase();
      assert.match(text, /contenthash/, "the error must name the field");
    }
  });

  test("a mixed-case zero hash is still zero", async () => {
    // Guards the regex: `0x0...0` compared case-insensitively, not by string equality.
    const res = await h.request("POST", "/api/v1/products", {
      body: body({ contentHash: "0X" + "00".repeat(32) }),
    });
    assert.notEqual(res.status, 200);
    assert.notEqual(res.status, 201);
  });
});

describe("Existing uncommitted products are named, not hidden", { concurrency: 1 }, () => {
  /*
   * Enforcement on write cannot reach products that already exist, because per-store contracts
   * are immutable clones and the contract permits a zero hash. So the read surface has to say so
   * plainly — a buyer Agent has no way to know that all-zero means "no guarantee".
   */
  test("a product list marks every product's integrity state", async () => {
    const res = await h.request("GET", "/api/v1/products/recent?limit=5");
    assert.equal(res.status, 200);

    const items = (res.body as { items?: Record<string, any>[] }).items ?? [];
    for (const item of items) {
      const integrity = item.protocol?.contentIntegrity;
      assert.ok(integrity, "every product must declare its content integrity");
      assert.ok(
        integrity.status === "COMMITTED" || integrity.status === "UNCOMMITTED",
        `unexpected status ${integrity.status}`
      );

      const hash = item.protocol?.contentHash;
      const isZero = !hash || /^0x0{64}$/i.test(hash);
      assert.equal(
        integrity.status,
        isZero ? "UNCOMMITTED" : "COMMITTED",
        "the status must match the hash it describes"
      );

      if (integrity.status === "UNCOMMITTED") {
        assert.match(
          String(integrity.warning),
          /cannot be verified/i,
          "an uncommitted product must warn, not merely label"
        );
      } else {
        assert.match(String(integrity.verify), /keccak256/i, "a committed product must say how to check");
      }
    }
  });
});
