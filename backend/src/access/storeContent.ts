/**
 * Store the bytes a product will deliver, and return the commitment to them.
 *
 * WHY THIS IS SHARED. Uploading used to live only inside POST /api/v1/access/content, and listing a
 * product required its result: upload, carry a 66-character hash to a second request, list. Watching
 * sixteen agents try to sell for an hour, not one upload happened — the refusal for a missing
 * contentHash never said where one came from, and the two-step shape was one step more than anyone
 * completed. So the product route now takes the bytes directly and does this itself, and both
 * routes call the one function so that "what it means to store content" is written once.
 *
 * Nothing here decides what is worth selling. It encrypts, records, and hands back the hash.
 */

import { ProductContent } from "../db/models";
import { ApiError } from "../http/errors";
import { encryptContent } from "./content";

/** Bound on an uploaded object. Large media belongs behind a seller's own CDN, referenced by URI. */
export const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

export interface StoreContentInput {
  chainId: number;
  storeId: string;
  /** The wallet doing the uploading — recorded, never trusted for anything else. */
  wallet: string;
  /** Base64 of the PLAINTEXT. The server encrypts; a seller never supplies ciphertext. */
  contentBase64: string;
  contentType?: string;
  filename?: string;
  encryptionKey: string;
}

export interface StoredContent {
  contentHash: string;
  byteLength: number;
}

/**
 * Decode, bound, encrypt, record. Throws an ApiError that names the field for anything a caller
 * can fix, so the same sentence reaches them whichever route they came through.
 */
export async function storeProductContent(input: StoreContentInput): Promise<StoredContent> {
  let plaintext: Buffer;
  try {
    plaintext = Buffer.from(input.contentBase64, "base64");
  } catch {
    throw ApiError.invalid("`content` must be base64.", {
      issues: [{ path: ["content"], message: "not base64" }],
    });
  }
  if (plaintext.byteLength === 0) {
    throw ApiError.invalid("`content` is empty: nothing to deliver.", {
      issues: [{ path: ["content"], message: "empty" }],
    });
  }
  if (plaintext.byteLength > MAX_CONTENT_BYTES) {
    throw ApiError.invalid(`\`content\` exceeds ${MAX_CONTENT_BYTES} bytes.`, {
      issues: [{ path: ["content"], message: `larger than ${MAX_CONTENT_BYTES} bytes` }],
      remedy: "Host large media yourself and reference it from the product metadata URI.",
    });
  }

  const encrypted = encryptContent(plaintext, input.encryptionKey, input.storeId);
  const contentHash = encrypted.contentHash.toLowerCase();

  await ProductContent.updateOne(
    { chainId: input.chainId, storeId: input.storeId, contentHash },
    {
      $set: {
        chainId: input.chainId,
        storeId: input.storeId,
        contentHash,
        blob: encrypted.blob,
        contentType: input.contentType ?? "application/octet-stream",
        filename: input.filename ?? "",
        byteLength: encrypted.byteLength,
        uploadedBy: input.wallet.toLowerCase(),
      },
    },
    { upsert: true }
  );

  return { contentHash: encrypted.contentHash, byteLength: encrypted.byteLength };
}
