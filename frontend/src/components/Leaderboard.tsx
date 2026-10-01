import { useEffect, useState } from "react";
import { api } from "../lib/api";

/**
 * The ten largest holders.
 *
 * Equity is marked at what the curve would really pay to unwind the whole position, never at
 * `balance x spot`, so a large holding in a thin market shows the discount it actually carries.
 *
 * It states what it excludes rather than implying completeness: wallet cash is not counted, so
 * these are holdings INSIDE the protocol. A ranking that quietly dropped a term would be a wrong
 * answer presented as a right one.
 */
interface Row {
  rank: number;
  wallet: string;
  totalUSDC: string;
  breakdown: { equityAtExitUSDC: string; unwithdrawnProceedsUSDC: string };
  equityPositions: number;
  storesControlled: number;
}

export function Leaderboard({ limit = 10 }: { limit?: number }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    let first = true;

    /*
     * `skipWhenHidden` gates POLLING, never the first load.
     *
     * Gating the initial fetch on visibility meant a page opened in a background tab — a
     * middle-click, a restored session, or an automated browser — fetched nothing, and because
     * `loading` is only cleared in the request's `finally`, it showed "Loading standings…"
     * permanently. Not fetching while hidden is a courtesy; not fetching at all is a broken page.
     */
    const load = (skipWhenHidden = false) => {
      if (skipWhenHidden && document.hidden) return;
      api
        .leaderboard(limit)
        .then((data) => {
          if (cancelled) return;
          setRows(data.items ?? []);
          setNote(data.doesNotCountCash ?? "");
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled && first) {
            first = false;
            setLoading(false);
          }
        });
    };

    load();
    const timer = setInterval(() => load(true), 20_000);
    // Refresh on return, so a tab left in the background is current when it is looked at again.
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [limit]);

  if (loading) return <p className="dim">Loading standings…</p>;
  if (rows.length === 0) return <p className="dim">Nobody holds a position yet.</p>;

  return (
    <div>
      <ol className="board">
        {rows.map((row) => (
          <li key={row.wallet} className="board-row">
            <span className="board-rank">{row.rank}</span>
            {/* Shortened for the column. The full address is on hover: a reader checking a
                ranking needs to be able to identify who is being ranked. */}
            <code className="mono board-wallet" title={row.wallet}>
              {row.wallet.slice(0, 12)}…
            </code>
            <span className="board-detail tiny dim">
              {row.equityPositions} position{row.equityPositions === 1 ? "" : "s"}
              {row.storesControlled > 0
                ? ` · ${row.storesControlled} store${row.storesControlled === 1 ? "" : "s"}`
                : ""}
            </span>
            <span className="board-value">{Number(row.totalUSDC).toLocaleString()} USDC</span>
          </li>
        ))}
      </ol>
      {note ? (
        <p className="tiny dim" style={{ marginTop: 10 }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
