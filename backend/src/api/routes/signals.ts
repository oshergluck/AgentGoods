/**
 * Phase 10.1 — license access and post-purchase buyer signal routes.
 *
 * MASTER_PLAN 14A.4. The write endpoint returns a TransactionIntent: the signal is an
 * on-chain action by the license holder, so an API key alone can never submit one. The read
 * endpoints serve indexed aggregates with the MIN_SIGNALS rule applied, and always expose
 * coverage rather than hiding it.
 */

import { Router } from "express";
import { chainNow } from "../../db/chainTime";
import { z } from "zod";
import { BuyerSignalDoc, License, Product, Store } from "../../db/models";
import { ApiError } from "../../http/errors";
import { handler, idempotent, noStore, publicCache, requireAgent, selfWallet } from "../../http/middleware";
import { freshness } from "../../http/context";
import { buildIntent } from "../../transactions/intents";
import { productSummary, sellerSummary, storeSummary, DISCLAIMER } from "../../signals/aggregate";

const SignalBody = z.object({
  worthIt: z.boolean(),
  /*
   * Optional, and the most useful field here.
   *
   * "Not worth it" is a verdict a seller cannot act on. "Returns NaN when the input array is
   * empty" is one they can fix by tomorrow, which is the difference between a market that
   * improves and one that just accumulates bad reviews.
   */
  note: z.string().max(600).optional(),
});

export function signalsRouter(): Router {
  const router = Router();

  /** Own licenses, newest first. Wallet-scoped, never cacheable. */
  router.get(
    "/me/licenses",
    noStore,
    requireAgent,
    handler(async (req, res) => {
      const wallet = selfWallet(req).toLowerCase();
      const chainId = req.ctx.env.CHAIN_ID;
      const docs = await License.find({ chainId, owner: wallet })
        .sort({ blockNumber: -1, logIndex: -1 })
        .limit(100)
        .lean();

      const signals = await BuyerSignalDoc.find({
        chainId,
        licenseId: { $in: docs.map((d) => d.tokenId) },
      }).lean();
      const signalByKey = new Map(signals.map((s) => [`${s.licenseToken}:${s.licenseId}`, s]));

      res.json({
        items: docs.map((d) => licenseView(d, signalByKey.get(`${d.licenseToken}:${d.tokenId}`))),
        freshness: freshness(req.ctx),
      });
    })
  );

  router.get(
    "/licenses/:licenseToken/:licenseId",
    noStore,
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const doc = await License.findOne({
        chainId,
        licenseToken: req.params.licenseToken.toLowerCase(),
        tokenId: req.params.licenseId,
      }).lean();
      if (!doc) throw ApiError.notFound("License");
      const signal = await BuyerSignalDoc.findOne({
        chainId,
        licenseToken: doc.licenseToken,
        licenseId: doc.tokenId,
      }).lean();
      res.json({ license: licenseView(doc, signal ?? undefined), freshness: freshness(req.ctx) });
    })
  );

  router.get(
    "/licenses/:licenseToken/:licenseId/signal",
    noStore,
    handler(async (req, res) => {
      const chainId = req.ctx.env.CHAIN_ID;
      const signal = await BuyerSignalDoc.findOne({
        chainId,
        licenseToken: req.params.licenseToken.toLowerCase(),
        licenseId: req.params.licenseId,
      }).lean();
      if (!signal) {
        res.json({ signal: null, disclaimer: DISCLAIMER, freshness: freshness(req.ctx) });
        return;
      }
      res.json({ signal: signalView(signal), disclaimer: DISCLAIMER, freshness: freshness(req.ctx) });
    })
  );

  /**
   * Prepare a buyer signal.
   *
   * Preconditions are checked here from the projection so the Agent gets a clear, typed
   * error instead of an opaque revert, but the contract re-checks all of them: the projection
   * is convenience, never authority. [14A.2]
   */
  router.post(
    "/licenses/:licenseToken/:licenseId/signal",
    noStore,
    requireAgent,
    idempotent({ action: "submit_signal", scope: (req) => `${req.params.licenseToken}:${req.params.licenseId}` }),
    handler(async (req, res) => {
      const parsed = SignalBody.safeParse(req.body);
      if (!parsed.success) {
        throw ApiError.invalid("Body must be { \"worthIt\": true | false }", { issues: parsed.error.issues });
      }

      const wallet = selfWallet(req);
      const chainId = req.ctx.env.CHAIN_ID;
      const licenseToken = req.params.licenseToken.toLowerCase();
      const licenseId = req.params.licenseId;

      const license = await License.findOne({ chainId, licenseToken, tokenId: licenseId }).lean();
      if (!license) throw ApiError.notFound("License");

      if (license.owner.toLowerCase() !== wallet.toLowerCase()) {
        throw new ApiError(
          "NOT_LICENSE_HOLDER",
          "Only the current holder of this license may signal.",
          403
        );
      }

      if (!license.delivered) {
        throw new ApiError(
          "NO_ACCESS_GRANTED",
          (Number(license.accessGrantCount ?? 0) > 0
            ? "You collected this licence; the protocol's delivery gateway records that on chain, " +
              "usually within a minute, and nothing is needed from you or the seller. Check " +
              "GET /api/v1/licenses/{licenseToken}/{licenseId} — delivery.delivered turns true — and signal then."
            : "This licence has not been collected yet. Collect it first: POST /api/v1/access/grant " +
              '{"licenseToken": "' + licenseToken + '", "licenseId": "' + licenseId + '"} and GET the URL it returns. ' +
              "The protocol records that delivery on chain within about a minute; then you can rate."),
          412,
          { licenseId, accessGrantCount: license.accessGrantCount }
        );
      }

      const existing = await BuyerSignalDoc.findOne({ chainId, licenseToken, licenseId }).lean();
      const windowSeconds = req.ctx.manifest.economics.signalWindowSeconds;
      // `signalledAt` is a chain timestamp, so the window must be measured on the chain clock.
      const now = await chainNow(chainId);

      if (existing) {
        /*
         * A new VERSION reopens the verdict; nothing else does.
         *
         * A signal is deliberately hard to revise — it is a reputation input, and one that could
         * be edited at will would be worth nothing. But a seller who actually fixed the fault was
         * previously stuck with a judgement of software that no longer exists, and the buyer had
         * no way to say so. Reopening it exactly when the product changed keeps the signal
         * expensive while letting the market record an improvement.
         */
        const product = await Product.findOne({ chainId, productId: license.productId })
          .select({ version: 1 })
          .lean();
        const currentVersion = Number(product?.version ?? 0);
        const signalledVersion = Number(existing.productVersion ?? 0);
        /*
         * `signalledVersion === 0` means "we do not know which version this judged" — signals
         * written before the field existed. Treating unknown as improvable would reopen every
         * historical signal the moment a product reached version 1, which is the opposite of
         * what "final" is supposed to mean.
         */
        const productImprovedSince = signalledVersion > 0 && currentVersion > signalledVersion;

        if (existing.changed && !productImprovedSince) {
          throw new ApiError(
            "SIGNAL_ALREADY_FINAL",
            "This signal has already been changed once and is now final. It reopens only if the " +
              "seller ships a new version of the product.",
            409,
            { licenseId, worthIt: existing.worthIt, signalledVersion, currentVersion }
          );
        }
        if (!productImprovedSince && now > existing.signalledAt + windowSeconds) {
          throw new ApiError(
            "SIGNAL_WINDOW_CLOSED",
            `The ${windowSeconds}-second change window for this signal has closed.`,
            409,
            { licenseId, signalledAt: existing.signalledAt, windowSeconds }
          );
        }
        if (existing.worthIt === parsed.data.worthIt) {
          throw new ApiError(
            "SIGNAL_ALREADY_FINAL",
            "That is already the recorded verdict; there is nothing to change.",
            409,
            { licenseId, worthIt: existing.worthIt }
          );
        }
      }

      const product = await Product.findOne({ chainId, productId: license.productId }).lean();
      const store = await Store.findOne({ chainId, storeId: license.storeId }).lean();

      const intent = await buildIntent({
        ctx: req.ctx,
        wallet,
        action: "submit_buyer_signal",
        contract: licenseToken,
        abi: req.ctx.abis.interfaceFor("license"),
        functionName: "submitSignal",
        args: [licenseId, parsed.data.worthIt],
        allowance: null,
        summary: {
          action: "submit_buyer_signal",
          description: existing
            ? `Change your verdict on license #${licenseId} to ${parsed.data.worthIt ? "worth it" : "not worth it"}. This is the only change you may make.`
            : `Record that license #${licenseId} was ${parsed.data.worthIt ? "worth" : "not worth"} the price.`,
          protocol: {
            licenseToken,
            licenseId,
            productId: license.productId,
            storeId: license.storeId,
            worthIt: parsed.data.worthIt,
            isChange: Boolean(existing),
            changeWindowSeconds: windowSeconds,
            economicWeight: "none",
          },
          sellerContent: {
            productMetadataURI: product?.sellerContent?.metadataURI ?? "",
            storeName: store?.sellerContent?.name ?? "",
          },
          warnings: [
            "A signal is memory, not arbitration. It triggers no refund, dispute or clawback.",
            "You may change it at most once, inside the change window. After that it is final.",
            DISCLAIMER,
          ],
        },
      });

      res.status(201).json({
        intent,
        notRecordedYet:
          "Nothing is recorded yet. This is a prepared transaction: your rating exists only after you sign and send " +
          "intent.transaction. Until then the seller has not heard your verdict and no other buyer can see it.",
        whyItMatters:
          "Worth it or not worth it, your verdict is how a seller learns whether its code works and what to fix, and " +
          "the only way any seller builds a reputation other buyers can trust.",
        disclaimer: DISCLAIMER,
      });
    })
  );

  /* ------------------------------------------------------------ summaries */

  router.get(
    "/signals/sellers/:wallet",
    publicCache(15),
    handler(async (req, res) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.wallet)) throw ApiError.invalid("Invalid wallet address");
      const summary = await sellerSummary(req.params.wallet, {
        chainId: req.ctx.env.CHAIN_ID,
        minSignals: req.ctx.manifest.economics.minSignalsForRate,
      });
      res.json({ ...summary, asOfIndexedBlock: req.ctx.indexerStatus().indexedBlock, freshness: freshness(req.ctx) });
    })
  );

  router.get(
    "/signals/stores/:storeId",
    publicCache(15),
    handler(async (req, res) => {
      const store = await Store.findOne({ chainId: req.ctx.env.CHAIN_ID, storeId: req.params.storeId }).lean();
      if (!store) throw ApiError.notFound("Store");
      const summary = await storeSummary(req.params.storeId, {
        chainId: req.ctx.env.CHAIN_ID,
        minSignals: req.ctx.manifest.economics.minSignalsForRate,
      });
      res.json({ ...summary, asOfIndexedBlock: req.ctx.indexerStatus().indexedBlock, freshness: freshness(req.ctx) });
    })
  );

  router.get(
    "/signals/products/:productId",
    publicCache(15),
    handler(async (req, res) => {
      const product = await Product.findOne({
        chainId: req.ctx.env.CHAIN_ID,
        productId: req.params.productId,
      }).lean();
      if (!product) throw ApiError.notFound("Product");
      const summary = await productSummary(product.productId, product.storeId, {
        chainId: req.ctx.env.CHAIN_ID,
        minSignals: req.ctx.manifest.economics.minSignalsForRate,
      });
      res.json({ ...summary, asOfIndexedBlock: req.ctx.indexerStatus().indexedBlock, freshness: freshness(req.ctx) });
    })
  );

  return router;
}

function licenseView(d: Record<string, unknown>, signal?: Record<string, unknown>): unknown {
  return {
    licenseToken: d.licenseToken,
    licenseId: d.tokenId,
    storeId: d.storeId,
    productId: d.productId,
    productVersion: d.productVersion,
    owner: d.owner,
    kind: d.kind,
    quantity: d.quantity,
    issuedAt: d.issuedAt,
    expiresAt: d.expiresAt,
    valid:
      Number(d.expiresAt ?? 0) === 0 ? true : Math.floor(Date.now() / 1000) < Number(d.expiresAt),
    transferable: false,
    delivery: {
      delivered: Boolean(d.delivered),
      accessGrantCount: Number(d.accessGrantCount ?? 0),
      firstAccessAt: d.firstAccessAt ?? null,
      lastAccessAt: d.lastAccessAt ?? null,
      note:
        "Delivery is recorded on chain by the protocol's delivery gateway when the buyer collects " +
        "(a store may also appoint its own attestor). A buyer signal requires a recorded delivery; " +
        "the seller cannot prevent it.",
    },
    signal: signal ? signalView(signal) : null,
  };
}

function signalView(s: Record<string, unknown>): unknown {
  return {
    worthIt: Boolean(s.worthIt),
    selfSignal: Boolean(s.selfSignal),
    changed: Boolean(s.changed),
    signalledAt: s.signalledAt,
    changedAt: s.changedAt ?? null,
    signaller: s.signaller,
    economicWeight: "none",
  };
}
