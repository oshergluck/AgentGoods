/**
 * Access gateway: the delivery half of Phase 10.
 *
 * Three parties meet here and none of them trusts the others:
 *
 *  - the SELLER uploads encrypted content addressed by the `contentHash` it committed on chain;
 *  - the BUYER presents an API key proving a wallet, and asks for the content of a licence that
 *    wallet holds;
 *  - the CHAIN is the authority on whether that licence exists, who holds it, and whether it has
 *    expired. Not the database, and certainly not either party's claim.
 *
 * The authorization decision is therefore made against the indexed projection of chain state, and
 * every leg of it is checked separately: the licence must exist, the caller must be its CURRENT
 * owner, a rental must not have expired, and the committed content hash must match the bytes
 * actually served. A failure in any leg serves nothing.
 *
 * Delivery is also what makes a buyer signal possible (§14A.2): a signal requires an on-chain
 * `AccessGranted` attestation, and this gateway is what produces one. Attestation is best-effort
 * and asynchronous — content is delivered even if the attestation transaction is still pending,
 * because withholding purchased content over an infrastructure detail would be the worse failure.
 */

import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { AccessSession, License, Product, ProductContent, Store } from "../../db/models";
import { ApiError } from "../../http/errors";
import { handler, idempotent, noStore, requireAgent, selfWallet } from "../../http/middleware";
import { buildIntent } from "../../transactions/intents";
import { chainNow } from "../../db/chainTime";
import { decryptContent, ContentIntegrityError } from "../../access/content";
import { storeProductContent, MAX_CONTENT_BYTES } from "../../access/storeContent";
import { issueAccessToken, verifyAccessToken } from "../../access/tokens";

/** Signed URLs are minutes-long. A delivery link is not a credential worth keeping. */
const SESSION_TTL_SECONDS = 300;

const UploadBody = z.object({
  storeId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** Base64 of the PLAINTEXT. The server encrypts; the seller never supplies ciphertext. */
  content: z.string().max(Math.ceil((MAX_CONTENT_BYTES * 4) / 3) + 1024),
  contentType: z.string().max(128).optional(),
  filename: z.string().max(200).optional(),
});

/** The on-chain batch bound is MAX_ACCESS_GRANT_BATCH = 200; stay under it. */
const MAX_ATTESTATION_BATCH = 100;

const AttestBody = z.object({
  licenseToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  licenseIds: z.array(z.string().regex(/^\d+$/)).min(1).max(MAX_ATTESTATION_BATCH),
});

const GrantBody = z.object({
  licenseToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  licenseId: z.string().regex(/^\d+$/),
});

export function accessRouter(): Router {
  const router = Router();

  /* ------------------------------------------------------------- upload */

  /**
   * Store encrypted content for a product the caller controls.
   *
   * The returned `contentHash` is what the seller then commits on chain with `createProduct` or
   * `updateProduct`. Uploading does not by itself make content deliverable: until a product
   * version pins this hash, nothing resolves to it.
   */
  router.post(
    "/access/content",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const parsed = UploadBody.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid content upload", { issues: parsed.error.issues });

      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;

      const store = await Store.findOne({ chainId, storeId: parsed.data.storeId }).lean();
      if (!store) throw ApiError.notFound("Store");
      if (store.storeController.toLowerCase() !== wallet.toLowerCase()) {
        throw new ApiError(
          "FORBIDDEN",
          "Only the current store controller may upload content for this store.",
          403,
          { storeId: store.storeId, controller: store.storeController }
        );
      }

      /* One function stores content, whichever route it arrives through. See access/storeContent.ts. */
      const encrypted = await storeProductContent({
        chainId,
        storeId: store.storeId,
        wallet,
        contentBase64: parsed.data.content,
        contentType: parsed.data.contentType,
        filename: parsed.data.filename,
        encryptionKey: req.ctx.env.CONTENT_ENCRYPTION_KEY,
      });

      res.status(201).json({
        contentHash: encrypted.contentHash,
        byteLength: encrypted.byteLength,
        encryption: "AES-256-GCM, key derived per (store, contentHash), never stored with the blob",
        nextStep:
          "Commit this contentHash on chain with createProduct or updateProduct. Until a product " +
          "version pins it, nothing resolves to this content.",
      });
    })
  );

  /* -------------------------------------------------------------- grant */

  /**
   * Exchange a held licence for a short-lived, signed delivery URL.
   *
   * Authorization is decided entirely from indexed chain state. The caller's API key proves only
   * which wallet is asking; it confers no entitlement by itself.
   */
  router.post(
    "/access/grant",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const parsed = GrantBody.safeParse(req.body);
      if (!parsed.success) {
        const rejected = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))];
        throw ApiError.invalid(
          `This grant was not opened: ${rejected.join(", ")} ${rejected.length === 1 ? "is" : "are"} wrong or ` +
            "missing. A grant needs { licenseToken, licenseId } exactly as GET /api/v1/me lists them under " +
            "licenses; details.fields says what to send.",
          { issues: parsed.error.issues }
        );
      }

      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;

      const license = await License.findOne({
        chainId,
        licenseToken: parsed.data.licenseToken.toLowerCase(),
        tokenId: parsed.data.licenseId,
      }).lean();
      if (!license) throw ApiError.notFound("License");

      // The CURRENT owner, from the projection of chain state. A previous holder gets nothing.
      if (license.owner.toLowerCase() !== wallet.toLowerCase()) {
        throw new ApiError(
          "NOT_LICENSE_HOLDER",
          "Only the current holder of this license may be granted access to its content.",
          403,
          { licenseToken: license.licenseToken, licenseId: license.tokenId }
        );
      }

      // A rental that has run out is not a licence any more. Chain time, not the host clock.
      if (license.kind === "rental" && Number(license.expiresAt) > 0) {
        const now = await chainNow(chainId);
        if (now >= Number(license.expiresAt)) {
          throw new ApiError("LICENSE_EXPIRED", "This rental has expired.", 403, {
            expiresAt: license.expiresAt,
            chainNow: now,
          });
        }
      }

      const product = await Product.findOne({
        chainId,
        storeId: license.storeId,
        productId: license.productId,
      }).lean();
      if (!product) throw ApiError.notFound("Product for license");

      // A service is called, not downloaded: its code goes only to the runner, never to a buyer.
      if ((product.sellerContent?.profile as { serviceSpecHash?: string | null } | undefined)?.serviceSpecHash) {
        throw new ApiError(
          "SERVICE_CODE_NOT_DOWNLOADABLE",
          "This license is prepaid calls of a service. Call it; its code is never delivered.",
          409,
          {
            invoke: `POST /api/v1/services/${license.storeId}/${license.productId}/invoke`,
            credits: `GET /api/v1/services/${license.storeId}/${license.productId}/credits`,
          }
        );
      }

      /*
       * The content hash comes from the product the licence was issued against, never from the
       * request. A buyer cannot name the content it would like to receive.
       */
      const contentHash = (product.contentHash ?? "").toLowerCase();
      if (!contentHash || /^0x0+$/.test(contentHash)) {
        throw new ApiError(
          "PRODUCT_UNAVAILABLE",
          "This product commits no content hash on chain, so there is nothing for the gateway to deliver.",
          409,
          {
            note:
              "Delivery for this product happens outside the gateway. The licence is still valid " +
              "and still records what was purchased.",
          }
        );
      }

      const stored = await ProductContent.findOne({ chainId, storeId: license.storeId, contentHash }).lean();
      if (!stored) {
        throw new ApiError(
          "PRODUCT_UNAVAILABLE",
          "The seller has not uploaded content matching the hash this product commits on chain.",
          409,
          { contentHash, remedy: "This is a seller-side gap. The licence remains valid." }
        );
      }

      const sessionId = crypto.randomBytes(24).toString("base64url");
      const issuedAt = new Date();
      const expiresAtSeconds = Math.floor(issuedAt.getTime() / 1000) + SESSION_TTL_SECONDS;

      await AccessSession.create({
        sessionId,
        walletAddress: wallet.toLowerCase(),
        storeId: license.storeId,
        licenseToken: license.licenseToken,
        licenseId: license.tokenId,
        productId: license.productId,
        contentHash,
        deliveryType: "download",
        issuedAt,
        expiresAt: new Date(expiresAtSeconds * 1000),
        attestationStatus: "pending",
      });

      const token = issueAccessToken(
        { sessionId, expiresAt: expiresAtSeconds },
        req.ctx.env.ACCESS_TOKEN_KEY
      );

      res.status(201).json({
        url: `${req.ctx.env.PUBLIC_BASE_URL}/api/v1/access/content/${token}`,
        sessionId,
        expiresAt: expiresAtSeconds,
        expiresInSeconds: SESSION_TTL_SECONDS,
        singleUse: true,
        contentHash,
        verifyYourself:
          "keccak256 of the delivered bytes must equal contentHash, which is the value this " +
          "product commits on chain. Check it; do not take delivery on trust.",
        attestation: {
          status: "pending",
          note:
            "The protocol's delivery gateway records an on-chain AccessGranted for this licence once " +
            "you fetch the bytes, usually within a minute — the seller plays no part. A buyer " +
            "signal requires that record; delivery.delivered on GET /api/v1/licenses/{licenseToken}/" +
            "{licenseId} turns true when it lands.",
        },
      });
    })
  );

  /* ------------------------------------------------------------ deliver */

  /**
   * Redeem a signed URL.
   *
   * Deliberately unauthenticated by API key: the token IS the authorization, and it was issued to
   * a wallet that had already been checked. That keeps a delivery link usable by a plain HTTP
   * client without handing that client an API key.
   */
  router.get(
    "/access/content/:token",
    noStore,
    handler(async (req, res) => {
      const verified = verifyAccessToken(req.params.token, req.ctx.env.ACCESS_TOKEN_KEY);
      if (!verified.ok) {
        // One message for every failure: a caller probing tokens learns nothing from the response
        // about which part was wrong.
        throw new ApiError("FORBIDDEN", "This access link is not valid.", 403, {
          reason: verified.failure,
          remedy: "Request a fresh link with POST /api/v1/access/grant.",
        });
      }

      const session = await AccessSession.findOne({ sessionId: verified.payload!.sessionId }).lean();
      if (!session) throw new ApiError("FORBIDDEN", "This access link is not valid.", 403);

      if (session.redeemedAt) {
        throw new ApiError("FORBIDDEN", "This access link has already been used.", 403, {
          singleUse: true,
          remedy: "Request a fresh link with POST /api/v1/access/grant.",
        });
      }

      const chainId = req.ctx.env.CHAIN_ID;

      /*
       * Re-check ownership AT REDEMPTION, not only at issue.
       *
       * A licence is non-transferable in V1, so this is belt and braces today — but a signed URL
       * outlives the check that produced it, and "the holder when the link was made" is not the
       * same statement as "the holder now". Making that explicit here means the guarantee does not
       * quietly depend on a transfer restriction that a later version might relax.
       */
      const license = await License.findOne({
        chainId,
        licenseToken: session.licenseToken,
        tokenId: session.licenseId,
      }).lean();
      if (!license || license.owner.toLowerCase() !== session.walletAddress.toLowerCase()) {
        throw new ApiError("FORBIDDEN", "This access link is not valid.", 403, {
          reason: "holder_changed",
        });
      }

      const stored = await ProductContent.findOne({
        chainId,
        storeId: session.storeId,
        contentHash: session.contentHash,
      }).lean();
      if (!stored) throw ApiError.notFound("Content");

      let plaintext: Buffer;
      try {
        plaintext = decryptContent(
          stored.blob,
          req.ctx.env.CONTENT_ENCRYPTION_KEY,
          session.storeId,
          session.contentHash!
        );
      } catch (error) {
        if (error instanceof ContentIntegrityError) {
          // Serving unverifiable bytes would be worse than serving none: the buyer would have no
          // way to tell that what arrived is not what the chain says was sold.
          throw new ApiError(
            "CANONICAL_MISMATCH",
            "Stored content does not match the hash committed on chain, so it will not be served.",
            409,
            { contentHash: session.contentHash, detail: error.message }
          );
        }
        throw error;
      }

      // Burn the session before the bytes leave, so a concurrent second redemption loses.
      const burned = await AccessSession.updateOne(
        { sessionId: session.sessionId, redeemedAt: null },
        { $set: { redeemedAt: new Date() } }
      );
      if (burned.modifiedCount === 0) {
        throw new ApiError("FORBIDDEN", "This access link has already been used.", 403);
      }

      res.setHeader("content-type", stored.contentType || "application/octet-stream");
      res.setHeader("x-aic-content-hash", session.contentHash!);
      res.setHeader("x-aic-license-id", session.licenseId);
      res.setHeader("content-disposition", `attachment; filename="${sanitizeFilename(stored.filename)}"`);
      // Delivered content is untrusted seller material. Never let a browser execute it inline.
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("content-security-policy", "default-src 'none'; sandbox");
      res.status(200).send(plaintext);
    })
  );

  /* -------------------------------------------------------- attestation */

  /**
   * Sessions for the caller's stores that still need an on-chain `AccessGranted`.
   *
   * The backend cannot attest on a seller's behalf, and should not want to: the store's
   * `accessAttestor` is an address that must SIGN, and this server never holds a seller key. So
   * the gateway records what was delivered and the seller's own Agent turns that into a
   * transaction. That keeps the architecture's central rule intact — the backend proposes, the
   * wallet disposes — while still making delivery auditable on chain.
   *
   * Attestation is what makes a buyer signal possible (§14A.2). A controller that never attests
   * is not hiding anything: its coverage figure collapses in public.
   */
  router.get(
    "/access/attestations/pending",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;

      const stores = await Store.find({ chainId, storeController: wallet.toLowerCase() })
        .select({ storeId: 1, licenseToken: 1 })
        .lean();
      if (stores.length === 0) {
        res.json({ items: [], note: "This wallet controls no stores." });
        return;
      }

      const sessions = await AccessSession.find({
        storeId: { $in: stores.map((st) => st.storeId) },
        redeemedAt: { $ne: null },
        attestationStatus: { $in: ["pending", "failed"] },
      })
        .sort({ issuedAt: 1 })
        .limit(MAX_ATTESTATION_BATCH)
        .lean();

      // Group by licence contract, because the on-chain batch call is per LicenseToken.
      const byToken = new Map<string, string[]>();
      for (const session of sessions) {
        const list = byToken.get(session.licenseToken) ?? [];
        if (!list.includes(session.licenseId)) list.push(session.licenseId);
        byToken.set(session.licenseToken, list);
      }

      res.json({
        items: [...byToken.entries()].map(([licenseToken, licenseIds]) => ({
          licenseToken,
          licenseIds,
          count: licenseIds.length,
        })),
        maxBatch: MAX_ATTESTATION_BATCH,
        nextStep:
          "POST /api/v1/access/attestations with one licenseToken and its licenseIds to receive a " +
          "TransactionIntent. Your attestor wallet signs it; this server never can.",
      });
    })
  );

  /**
   * A signable batch attestation for deliveries this gateway has already made.
   *
   * Every licence id is re-checked against a redeemed session for a store the caller controls, so
   * a controller cannot use this route to manufacture delivery records for licences that were
   * never actually delivered.
   */
  router.post(
    "/access/attestations",
    noStore,
    requireAgent,
    idempotent({ action: "record_access_grants", scope: (req) => String((req.body as { licenseToken?: string }).licenseToken ?? "") }),
    handler(async (req, res) => {
      const parsed = AttestBody.safeParse(req.body);
      if (!parsed.success) throw ApiError.invalid("Invalid attestation request", { issues: parsed.error.issues });

      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;
      const licenseToken = parsed.data.licenseToken.toLowerCase();

      const store = await Store.findOne({ chainId, licenseToken }).lean();
      if (!store) throw ApiError.notFound("License token");
      if (store.storeController.toLowerCase() !== wallet.toLowerCase()) {
        throw new ApiError("FORBIDDEN", "Only the store controller may attest deliveries.", 403);
      }

      /*
       * Only licences this gateway actually delivered. Without this the endpoint would let a
       * controller mint delivery records at will, and `delivered` is the denominator of the
       * coverage figure buyers read.
       */
      const delivered = await AccessSession.find({
        licenseToken,
        licenseId: { $in: parsed.data.licenseIds },
        redeemedAt: { $ne: null },
      })
        .select({ licenseId: 1 })
        .lean();

      const deliverable = [...new Set(delivered.map((d) => d.licenseId))];
      const refused = parsed.data.licenseIds.filter((id) => !deliverable.includes(id));
      if (deliverable.length === 0) {
        throw ApiError.invalid("None of these licenses have a delivered session to attest.", {
          refused,
          note: "A delivery record may only be created for content this gateway actually served.",
        });
      }

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "record_access_grants",
        contract: licenseToken,
        abi: req.ctx.abis.interfaceFor("license"),
        functionName: "recordAccessGrants",
        args: [deliverable],
        allowance: null,
        summary: {
          action: "record_access_grants",
          description: `Record an on-chain delivery attestation for ${deliverable.length} license(s).`,
          protocol: { licenseToken, licenseIds: deliverable, storeId: store.storeId },
          warnings: [
            "Sign this with the wallet designated as the store accessAttestor, not merely the " +
              "controller wallet; the contract checks the attestor.",
            "This records delivery only. It moves no value and grants no further rights.",
            "Buyers cannot signal until a delivery is attested, and missing attestations show up " +
              "publicly as collapsing coverage.",
          ],
        },
      });

      await AccessSession.updateMany(
        { licenseToken, licenseId: { $in: deliverable } },
        { $set: { attestationStatus: "submitted" } }
      );

      res.status(201).json({ intent, attesting: deliverable, refused });
    })
  );

  /** The caller's own recent delivery sessions. Scoped to the wallet, never another's. */
  router.get(
    "/access/sessions",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req);
      const rows = await AccessSession.find({ walletAddress: wallet.toLowerCase() })
        .sort({ issuedAt: -1 })
        .limit(50)
        .lean();

      res.json({
        items: rows.map((s) => ({
          sessionId: s.sessionId,
          storeId: s.storeId,
          licenseToken: s.licenseToken,
          licenseId: s.licenseId,
          productId: s.productId,
          contentHash: s.contentHash,
          issuedAt: s.issuedAt,
          expiresAt: s.expiresAt,
          redeemedAt: s.redeemedAt,
          attestationStatus: s.attestationStatus,
          attestationTxHash: s.attestationTxHash,
        })),
        note:
          "An access grant is what makes a buyer signal possible: a signal requires an on-chain " +
          "AccessGranted attestation for the licence.",
      });
    })
  );

  return router;
}

/** Strips anything that could escape the header or a filesystem. Untrusted seller input. */
function sanitizeFilename(name: string): string {
  const cleaned = (name || "content.bin").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return cleaned.length > 0 ? cleaned : "content.bin";
}
