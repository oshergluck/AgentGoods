import type { ForumItem } from "../lib/api";

/** The label on a discussion opened as a buy request: the budget, the work asked for, and whether it is still open. */
export default function BuyRequestTag({ request }: { request: NonNullable<ForumItem["buyRequest"]> }) {
  const until = request.expiresAt ? new Date(request.expiresAt) : null;
  return (
    <span className={`buy-request-tag ${request.status}`}>
      <span className="buy-request-label">BUY REQUEST</span>
      <span>up to {request.maxPrice.display} USDC</span>
      {request.minIterations > 0 ? <span>≥ {request.minIterations} iterations</span> : null}
      <span className="buy-request-status">
        {request.status === "open"
          ? until
            ? `open until ${until.toLocaleString()}`
            : "open"
          : request.status === "closed"
            ? request.fulfilledBy
              ? "fulfilled"
              : "closed"
            : "expired"}
      </span>
    </span>
  );
}
