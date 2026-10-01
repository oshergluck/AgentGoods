/**
 * Transaction requests: a prepared transaction fetched by its link, so nobody has to copy calldata.
 *
 * Every write on this API prepares a transaction and returns it as hex — for a product listing,
 * thousands of characters. An agent is a language model, not a hex generator: in one run 192 listing
 * transactions were prepared and 8 products exist, because the calldata had to be carried by hand from
 * where it was prepared to the wallet that signs it, and it was truncated, lost or left to expire.
 *
 * This is the transaction-request pattern wallets already use (Solana Pay, wallet deep links): the
 * wallet fetches the transaction from a URL itself. The link is `GET /api/v1/tx/{intentId}`. The id is
 * random and unguessable, the transaction carries nothing secret, and it is bound to the wallet it was
 * prepared for (`from`) — nobody else can make it do anything. `transaction` is always the NEXT thing
 * to sign: the ERC-20 approval first when one is still missing, then the prepared call.
 */
import { Router } from "express";
import { ApiError } from "../../http/errors";
import { handler, noStore } from "../../http/middleware";
import { TransactionIntent } from "../../db/models";
import { ERC20, currentAllowance, type AllowanceRequirement } from "../../transactions/intents";

export function txRequestRouter(): Router {
  const router = Router();

  router.get(
    "/tx/:intentId",
    noStore,
    handler(async (req, res) => {
      const intentId = String(req.params.intentId);
      if (!/^txi_[0-9a-f]{32}$/.test(intentId)) {
        throw ApiError.invalid("Not a transaction-request id: it looks like txi_ followed by 32 hex characters.", {
          issues: [{ path: ["intentId"], message: "expected txi_<32 hex>" }],
        });
      }
      const doc = await TransactionIntent.findOne({ intentId, chainId: req.ctx.env.CHAIN_ID }).lean();
      if (!doc) throw ApiError.notFound("Transaction request");

      const main = { to: doc.contract, data: doc.calldata, value: doc.value ?? "0", chainId: doc.chainId };
      const expired = doc.expiresAt.getTime() < Date.now();
      if (expired) {
        throw new ApiError(
          "INTENT_EXPIRED",
          "This prepared transaction has expired. Prepare it again with the same request that created it; " +
            "the new response carries a fresh transaction-request link.",
          410,
          { intentId, expiredAt: doc.expiresAt.toISOString(), action: doc.action }
        );
      }

      const allowance = (doc.requiredAllowance as AllowanceRequirement | null) ?? null;
      const approval = allowance
        ? {
            to: allowance.token,
            data: ERC20.encodeFunctionData("approve", [allowance.spender, BigInt(allowance.amount.base)]),
            value: "0",
            chainId: doc.chainId,
          }
        : null;

      // Which step is next: the approval while the allowance is short, otherwise the prepared call.
      const part = String(req.query.part ?? "next");
      let approvalStillNeeded = false;
      if (approval && allowance) {
        const current = await currentAllowance(req.ctx, allowance.token, doc.agentWallet, allowance.spender);
        approvalStillNeeded = current === null ? true : current < BigInt(allowance.amount.base);
      }
      const step: "approval" | "main" =
        part === "approval" ? "approval" : part === "main" ? "main" : approvalStillNeeded ? "approval" : "main";
      if (step === "approval" && !approval) {
        throw ApiError.invalid("This transaction needs no approval.", { issues: [{ path: ["part"], message: "no approval step" }] });
      }

      res.json({
        intentId,
        action: doc.action,
        step,
        from: doc.agentWallet,
        transaction: step === "approval" ? approval : main,
        thenSignAgain:
          step === "approval"
            ? "This is the approval. After it is mined, send this same link again: it will then return the prepared transaction."
            : null,
        summary: doc.summary,
        expiresAt: doc.expiresAt.toISOString(),
        note:
          "A transaction request: hand this link (or just the intentId) to your wallet and it signs `transaction` " +
          "as it is — no calldata to copy. Only the wallet in `from` can use it.",
      });
    })
  );

  return router;
}
