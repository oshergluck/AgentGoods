import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

/**
 * Open ownership claims.
 *
 * A store's controller can be replaced by its largest eligible holder, with at least an hour of
 * public warning. That warning was on chain and in the affected controller's own `/api/v1/me`,
 * and nowhere a holder or a prospective buyer could see it — yet a store whose ownership may
 * change within the hour is a materially different proposition from one whose ownership is
 * settled.
 *
 * Observer only, like the rest of this interface: there is no control here to open, finalize or
 * cancel a claim. Those are Agent operations signed by a wallet, and no protocol role can do them
 * either.
 */

interface Claim {
  storeId: string;
  storeName_UNTRUSTED: string;
  storeType: string | null;
  symbol: string | null;
  currentController: string | null;
  claimant: string | null;
  lockedBalanceAIC: string;
  secondsRemaining: number;
  status: "WAITING" | "FINALIZABLE_NOW" | "CANNOT_SUCCEED";
  why: string;
}

function countdown(seconds: number): string {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function Takeovers() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [counts, setCounts] = useState({ open: 0, finalizableNow: 0, doomed: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /*
   * Polled, and quickly. A claim becomes finalizable at a specific second and the countdown is
   * the whole point of the page — a stale one is worse than none, because it implies there is
   * more time than there is.
   */
  useEffect(() => {
    let cancelled = false;
    let first = true;

    // Polling pauses while hidden; the FIRST load never does, or a background tab shows a
    // spinner forever.
    const load = (skipWhenHidden = false) => {
      if (skipWhenHidden && document.hidden) return;
      api
        .takeovers()
        .then((data) => {
          if (cancelled) return;
          setClaims(data.items ?? []);
          setCounts(data.counts ?? { open: 0, finalizableNow: 0, doomed: 0 });
          setError(null);
        })
        .catch((e: unknown) => {
          if (!cancelled && first) setError(e instanceof Error ? e.message : "Could not load claims");
        })
        .finally(() => {
          if (!cancelled && first) {
            first = false;
            setLoading(false);
          }
        });
    };

    load();
    const timer = setInterval(() => load(true), 10_000);
    const onVisible = () => !document.hidden && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <section className="block">
      <div className="container">
        <div className="page-head">
          <h1>Ownership claims</h1>
          <p className="lead">
            A store&rsquo;s controller can be replaced by its largest eligible holder, without
            consent and without any protocol role being involved. Every claim is announced
            publicly and cannot complete for at least an hour.
          </p>
        </div>

        <div className="notice" style={{ marginBottom: 18 }}>
          <strong>This is the mechanism working, not an incident.</strong> A store whose owner
          walks away or stops delivering would otherwise strand its holders permanently. No role
          can start a takeover and no role can block one — including us.
        </div>

        {error ? <div className="notice bad">{error}</div> : null}
        {loading ? <p className="dim">Loading…</p> : null}

        {!loading && claims.length === 0 ? (
          <p className="dim">
            No open claims. Every store is currently held by its existing controller.
          </p>
        ) : null}

        {claims.length > 0 ? (
          <p className="tiny dim" style={{ marginBottom: 12 }}>
            {counts.open} open · {counts.finalizableNow} can complete now · {counts.doomed} can no
            longer succeed · updating live
          </p>
        ) : null}

        <div className="claims-list">
          {claims.map((claim) => (
            <article key={claim.storeId} className={`claim claim-${claim.status.toLowerCase()}`}>
              <div className="claim-head">
                <div>
                  {/* Seller-written. Escaped by React, never rendered as markup. */}
                  <Link to={`/stores/${claim.storeId}`} className="claim-store">
                    {claim.storeName_UNTRUSTED || "Unnamed store"}
                  </Link>
                  {claim.symbol ? <span className="pill">{claim.symbol}</span> : null}
                </div>
                <span className={`claim-status ${claim.status.toLowerCase()}`}>
                  {claim.status === "FINALIZABLE_NOW"
                    ? "Can complete now"
                    : claim.status === "CANNOT_SUCCEED"
                      ? "Cannot succeed"
                      : `${countdown(claim.secondsRemaining)} remaining`}
                </span>
              </div>

              <dl className="claim-parties">
                <div>
                  <dt>Current controller</dt>
                  {/* Abbreviated to fit the column; the full address is on hover and
                      selectable, because on a page about who owns what, identity is the point. */}
                  <dd className="mono" title={claim.currentController ?? ""}>
                    {claim.currentController?.slice(0, 14) ?? "—"}…
                  </dd>
                </div>
                <div>
                  <dt>Claimant</dt>
                  <dd className="mono" title={claim.claimant ?? ""}>
                    {claim.claimant?.slice(0, 14) ?? "—"}…
                  </dd>
                </div>
                <div>
                  <dt>Balance locked behind the claim</dt>
                  <dd>{Number(claim.lockedBalanceAIC ?? 0).toLocaleString()} AIC</dd>
                </div>
              </dl>

              <p className="claim-why tiny">{claim.why}</p>
            </article>
          ))}
        </div>

        <div className="card" style={{ marginTop: 20 }}>
          <h3>What changes if a claim completes</h3>
          <div className="grid cols-2">
            <div>
              <div className="pill warn" style={{ marginBottom: 8 }}>
                Transfers with the store
              </div>
              <ul className="small muted">
                <li>Control of listings, pricing and metadata</li>
                <li>Owner proceeds accruing from that point</li>
                <li>
                  The AIC reward pool — funded by the previous controller and not recoverable
                </li>
              </ul>
            </div>
            <div>
              <div className="pill ok" style={{ marginBottom: 8 }}>
                Unaffected
              </div>
              <ul className="small muted">
                <li>Licences already issued — they live in the store&rsquo;s own immutable contract</li>
                <li>
                  The buyback and burn — every sale still buys back and burns the store&rsquo;s
                  AIC, and no controller can stop or redirect it
                </li>
                <li>The store&rsquo;s rules — it is an immutable clone</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
