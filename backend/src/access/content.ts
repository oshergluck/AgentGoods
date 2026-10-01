/**
 * Content encryption for delivered product material.
 *
 * Delivered content is the one thing in this system that cannot be un-delivered. Once plaintext
 * reaches a buyer it is theirs permanently, which is exactly why V1 has no refund path and why
 * `LicenseToken` is non-transferable. That asymmetry shapes everything here:
 *
 *  - content is stored encrypted with AES-256-GCM, so a leaked object store is not a leaked
 *    catalogue. GCM rather than CBC because an authentication tag is not optional: a buyer must
 *    not be able to receive content that was altered in transit or at rest, and detecting that is
 *    what turns "the bytes arrived" into "the bytes the seller published arrived".
 *  - the per-product key is DERIVED from a master key and the content hash, never stored beside
 *    the ciphertext. Storing a key next to what it protects is not encryption, it is filing.
 *  - the `contentHash` a store committed on chain is verified against the decrypted plaintext
 *    before it is ever served. The chain is the authority on what was sold; if the object store
 *    disagrees, the object store is wrong and the delivery fails rather than serving something
 *    the buyer did not purchase.
 *
 * MASTER_PLAN Phase 10 and 0.24.R.
 */

import crypto from "node:crypto";
import { keccak256 } from "ethers";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the GCM standard
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface EncryptedContent {
  /** iv || ciphertext || tag, base64. One value, so the three can never be stored apart. */
  blob: string;
  /** keccak256 of the PLAINTEXT. This is what the store commits on chain. */
  contentHash: string;
  byteLength: number;
}

export class ContentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentIntegrityError";
  }
}

/**
 * Derives the per-content key.
 *
 * Bound to the content hash AND the store, so the same bytes published by two different stores do
 * not share a key, and a key recovered for one product decrypts nothing else. HKDF rather than a
 * bare HMAC because the master key is the only secret and it should not be used directly as an
 * encryption key.
 */
export function deriveContentKey(masterKey: string, storeId: string, contentHash: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(masterKey, "utf8"),
      Buffer.from(`aic-content:${storeId.toLowerCase()}`, "utf8"),
      Buffer.from(`aic-content-key:${contentHash.toLowerCase()}`, "utf8"),
      KEY_BYTES
    )
  );
}

export function encryptContent(
  plaintext: Buffer,
  masterKey: string,
  storeId: string
): EncryptedContent {
  const contentHash = keccak256(plaintext);
  const key = deriveContentKey(masterKey, storeId, contentHash);
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  /*
   * The content hash and store are authenticated but not encrypted. Binding them into the tag
   * means a ciphertext cannot be moved to a different product or a different store and still
   * decrypt: an attacker who swaps two blobs in the object store gets an authentication failure
   * rather than a silent mis-delivery.
   */
  cipher.setAAD(Buffer.from(`${storeId.toLowerCase()}:${contentHash.toLowerCase()}`, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    blob: Buffer.concat([iv, ciphertext, tag]).toString("base64"),
    contentHash,
    byteLength: plaintext.byteLength,
  };
}

/**
 * Decrypts and verifies.
 *
 * `expectedContentHash` is the value the store committed ON CHAIN. Checking it here is the point
 * of the whole function: the chain says what was sold, and content that does not hash to that
 * value is not what was sold, whatever the object store contains.
 */
export function decryptContent(
  blobBase64: string,
  masterKey: string,
  storeId: string,
  expectedContentHash: string
): Buffer {
  const raw = Buffer.from(blobBase64, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new ContentIntegrityError("Stored content is truncated.");
  }

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);

  const key = deriveContentKey(masterKey, storeId, expectedContentHash);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(`${storeId.toLowerCase()}:${expectedContentHash.toLowerCase()}`, "utf8"));
  decipher.setAuthTag(tag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // A GCM tag failure means tampering, a wrong key, or the wrong blob for this product. None of
    // those may be served, and the caller is told nothing that distinguishes them.
    throw new ContentIntegrityError(
      "Stored content failed authentication. It was altered, or does not belong to this product."
    );
  }

  // Belt and braces: the tag proves the ciphertext is intact, this proves it is the RIGHT content.
  const actual = keccak256(plaintext);
  if (actual.toLowerCase() !== expectedContentHash.toLowerCase()) {
    throw new ContentIntegrityError(
      `Stored content hashes to ${actual} but the store committed ${expectedContentHash} on chain.`
    );
  }

  return plaintext;
}
