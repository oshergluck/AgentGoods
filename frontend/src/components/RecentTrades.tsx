import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/**
 * The last fills in one market, across both venues.
 *
 * A price tells you where a market is. The last few trades tell you whether anyone is actually
 * there, which side they took, and how hard a real order moves it — which is the question anyone
 * deciding whether to trade is really asking.
 *
 * Curve fills and pool swaps appear in one list because they are one market, and they are labelled
 * because they are not one mechanism: a curve fill pays a protocol fee and a store-owner fee and
 * slides along a bonding curve, while a pool swap pays the venue's own fee and moves against real
 * reserves. After a market graduates the curve stops trading altogether, so a history that switches
 * from CURVE to DEX is showing that transition directly rather than through a flag.
 *
 * Observer only, like everything else here: there is no control to trade from.
 */

interface Row {
  at: number;
  when: string;
  venue: "curve" | "dex";
  side: "buy" | "sell";
  trader: string;
  tokensAIC: { display: string; unit: string };
  grossUSDC: { display: string; unit: string };
  pricePerTokenUSDC: string;
  /**
   * Realized on a sell (FIFO against the wallet's earlier buys); on a buy, unrealized on the part still held,
   * or `closed` once later sells consumed it; `buyback` rows have none; unavailable when the cost is unknown.
   */
  pnl?:
    | {
        kind: "realized" | "unrealized_if_sold_now" | "unrealized_at_last_price";
        pnlUSDC: { base: string; display: string };
        pnlPercent: string | null;
        costBasisUSDC: { display: string };
        valueUSDC: { display: string };
        openAIC?: { display: string };
        openCostUSDC?: { display: string };
        partlySold?: boolean;
        atCurrentPrice?: {
          pricePerAIC: string;
          valueUSDC: { display: string };
          pnlUSDC: { display: string };
          pnlPercent: string | null;
        };
      }
    | {
        kind: "closed";
        pnlUSDC: { base: string; display: string };
        pnlPercent: string | null;
        costBasisUSDC: { display: string };
        valueUSDC: { display: string };
        note: string;
      }
    | { kind: "buyback"; note: string }
    | { kind: "unavailable"; reason: string };
  buyback?: boolean;
  txHash: string;
  blockNumber: number;
  logIndex: number;
}

const PAGE = 25;
const rowKey = (r: Row) => `${r.txHash}:${r.logIndex}`;

function ago(seconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/** Micro-prices render as 0.0⁵678 rather than a wall of zeros. */
function price(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "—";
  if (n >= 0.001) return n.toPrecision(4);
  const exponent = Math.floor(Math.log10(n));
  const zeros = Math.abs(exponent) - 1;
  const digits = (n * 10 ** (zeros + 3)).toFixed(0);
  return `0.0${String(zeros).replace(/[0-9]/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)]!)}${digits}`;
}

function PnlCell({ pnl, mark }: { pnl: Row["pnl"]; mark: number | null }) {
  if (pnl && pnl.kind === "buyback") {
    return (
      <td className="num tiny dim" title={pnl.note}>
        burned
      </td>
    );
  }
  if (!pnl || pnl.kind === "unavailable") {
    return (
      <td className="num tiny dim" title={pnl?.reason ?? "No PnL for this trade"}>
        —
      </td>
    );
  }
  /*
   * An open buy is valued by the server at what selling the trader's whole open position would return
   * now (curve or pool arithmetic, after fees) — never re-marked here at the last price, which on a
   * bonding curve overstates a large position. Realized sells are fixed.
   */
  void mark;
  const raw = Number(pnl.pnlUSDC.display);
  const pct = pnl.pnlPercent;
  const open = pnl.kind === "unrealized_if_sold_now" || pnl.kind === "unrealized_at_last_price";
  const n = Math.abs(raw) < 0.005 ? 0 : raw;
  const sign = n > 0 ? "+" : "";
  const cls = n > 0 ? "side-buy" : n < 0 ? "side-sell" : "dim";
  const label = pnl.kind === "realized" ? "realized" : pnl.kind === "closed" ? "closed" : "if the whole position were sold now";
  return (
    <td
      className={`num mono ${cls}`}
      title={
        pnl.kind === "realized" || pnl.kind === "closed"
          ? `${label}: cost ${pnl.costBasisUSDC.display} USDC, sold for ${pnl.valueUSDC.display} USDC`
          : `${label}: ${pnl.openAIC?.display ?? "?"} still held, cost ${pnl.openCostUSDC?.display ?? pnl.costBasisUSDC.display} USDC, would return ${pnl.valueUSDC.display} USDC` +
            (pnl.partlySold ? " (part of this buy was sold; that result is in the sells)" : "")
      }
    >
      <div>
        {sign}
        {n.toFixed(2)}
        {pct !== null ? <span className="tiny"> ({sign}{pct}%)</span> : null}
        {open ? <span className="tiny dim"> if sold now</span> : null}
        {pnl.kind === "closed" ? <span className="tiny dim"> closed</span> : null}
      </div>
      {open && "atCurrentPrice" in pnl && pnl.atCurrentPrice ? (
        (() => {
          const a = pnl.atCurrentPrice;
          const v = Number(a.pnlUSDC.display);
          const s = v > 0 ? "+" : "";
          return (
            <div
              className={`tiny ${v > 0 ? "side-buy" : v < 0 ? "side-sell" : "dim"}`}
              style={{ opacity: 0.75 }}
              title={`The same ${pnl.openAIC?.display ?? ""} tokens at the current price (${price(a.pricePerAIC)} USDC): ${a.valueUSDC.display} USDC. Not what they can be sold for — selling moves the price.`}
            >
              {s}
              {v.toFixed(2)}
              {a.pnlPercent !== null ? ` (${s}${a.pnlPercent}%)` : ""} at current price
            </div>
          );
        })()
      ) : null}
    </td>
  );
}

export function RecentTrades({ aicToken }: { aicToken: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState({ curve: 0, dex: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /*
   * Older history, loaded a page at a time as the reader scrolls to the bottom of the window.
   * `nextBefore` is the API's cursor on the chain position, so a page is never shifted or repeated
   * by trades that arrive meanwhile; null once the first trade in the market has been reached.
   */
  const [older, setOlder] = useState<Row[]>([]);
  /* The latest mark price from the newest poll; every open buy on screen is valued at it. */
  const [mark, setMark] = useState<number | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const pagedOnce = useRef(false);

  /*
   * Refetched whenever the token changes, and polled while it is on screen.
   *
   * `cancelled` matters more than usual here: switching tokens quickly would otherwise let an
   * older response land after a newer one and show another market's trades under this heading.
   */
  useEffect(() => {
    if (!aicToken) return;
    let cancelled = false;
    let first = true;

    // Clear immediately, so the previous token's fills are never shown under a new name.
    setRows([]);
    setOlder([]);
    setNextBefore(null);
    pagedOnce.current = false;
    setLoading(true);

    const load = (skipWhenHidden = false) => {
      if (skipWhenHidden && document.hidden) return;
      api
        .recentTrades(aicToken, PAGE)
        .then((data) => {
          if (cancelled) return;
          /*
           * Merge, never replace: if more than a page of trades arrived since the last poll while
           * older pages are loaded, replacing would drop the fills in between. A fresh copy of a row
           * wins (a buy's unrealized PnL moves with the market).
           */
          setRows((prev) => {
            const byKey = new Map(prev.map((r) => [rowKey(r), r]));
            for (const r of (data.items ?? []) as Row[]) byKey.set(rowKey(r), r);
            return [...byKey.values()].sort((x, y) => y.blockNumber - x.blockNumber || y.logIndex - x.logIndex);
          });
          // The cursor comes from the first page only; once older pages are loaded they own it.
          if (!pagedOnce.current) setNextBefore(data.nextBefore ?? null);
          {
            const m = Number((data as { markPricePerAIC?: string }).markPricePerAIC);
            setMark(Number.isFinite(m) && m > 0 ? m : null);
          }
          setCounts({ curve: data.counts?.curve ?? 0, dex: data.counts?.dex ?? 0 });
          setError(null);
        })
        .catch((e: unknown) => {
          if (!cancelled && first) setError(e instanceof Error ? e.message : "Could not load trades");
        })
        .finally(() => {
          if (!cancelled) {
            first = false;
            setLoading(false);
          }
        });
    };

    load();
    const timer = setInterval(() => load(true), 5000);
    const onVisible = () => !document.hidden && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [aicToken]);

  const loadOlder = useCallback(() => {
    if (!nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    const token = aicToken;
    api
      .recentTrades(token, PAGE, nextBefore)
      .then((data) => {
        if (token !== aicToken) return;
        pagedOnce.current = true;
        setOlder((prev) => [...prev, ...((data.items ?? []) as Row[])]);
        setNextBefore(data.nextBefore ?? null);
      })
      .catch(() => undefined)
      .finally(() => setLoadingOlder(false));
  }, [aicToken, nextBefore, loadingOlder]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) loadOlder();
  };

  // The polled newest page, then the older pages — each fill once, even where they overlap.
  const seen = new Set(rows.map(rowKey));
  const shown = [...rows, ...older.filter((r) => !seen.has(rowKey(r)))];

  return (
    <div className="card recent-trades">
      <div className="recent-trades-head">
        <h3>Recent trades</h3>
        {counts.dex > 0 && counts.curve > 0 ? (
          <span className="tiny dim">
            {counts.curve} on the curve · {counts.dex} on the pool
          </span>
        ) : null}
      </div>

      {error ? <div className="notice bad">{error}</div> : null}
      {loading && rows.length === 0 ? <p className="dim tiny">Loading…</p> : null}

      {!loading && rows.length === 0 ? (
        <p className="dim tiny">
          Nothing has traded here yet. The price shown is the curve&rsquo;s quote, not a trade.
        </p>
      ) : null}

      {/*
        * A window of about five rows, scrolled rather than printed in full.
        *
        * Twenty-five trades rendered as one list pushed everything below it off the screen, and
        * on a token page the chart and the stats are what the reader came for. A fixed-height
        * window keeps the recent history glanceable and lets someone who wants more scroll for
        * it. The horizontal scroll lives on the same wrapper, so a wide table works at every
        * screen size rather than only on a phone.
        */}
      {rows.length > 0 ? (
        <div className="trades-window" onScroll={onScroll}>
        <table className="trades-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Side</th>
              <th className="num">Amount</th>
              <th className="num">Price</th>
              <th className="num">Value</th>
              <th
                className="num"
                title="Sell: realized = USDC received minus the average cost of the tokens sold (from this wallet's own buys). Buy: unrealized = what selling the wallet's whole open position would return now (curve or pool arithmetic, after fees) minus what was paid; below it, the same tokens at the current price. AIC from a store's incentive pool counts as costing nothing. Gas not included."
              >
                PnL
              </th>
              <th>Venue</th>
              <th>Trader</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={rowKey(r)}>
                <td className="tiny dim" title={r.when}>
                  {ago(r.at)}
                </td>
                <td className={r.side === "buy" ? "side-buy" : "side-sell"}>
                  {r.side === "buy" ? "Buy" : "Sell"}
                </td>
                <td className="num mono">{Number(r.tokensAIC.display).toLocaleString()}</td>
                <td className="num mono">{price(r.pricePerTokenUSDC)}</td>
                <td className="num mono">{Number(r.grossUSDC.display).toFixed(4)}</td>
                <PnlCell pnl={r.pnl} mark={mark} />
                <td>
                  <span className={r.venue === "dex" ? "venue-dex" : "venue-curve"}>
                    {r.venue === "dex" ? "Pool" : "Curve"}
                  </span>
                </td>
                <td className="mono tiny dim" title={r.trader}>
                  {r.trader.slice(0, 8)}…
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loadingOlder ? <p className="tiny dim" style={{ padding: 6 }}>Loading older trades…</p> : null}
        {!nextBefore && shown.length > PAGE ? (
          <p className="tiny dim" style={{ padding: 6 }}>The first trade in this market — nothing older.</p>
        ) : null}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <p className="tiny dim" style={{ marginTop: 6 }}>
          PnL: a sell is realized against that wallet&rsquo;s earliest buys in this token (FIFO), each part of a
          curve buy at its own curve cost (a buy&rsquo;s last tokens cost more than its first). An open buy shows two
          figures: <strong>if sold now</strong> — what selling the whole open position would actually return — and, below
          it, <strong>at current price</strong> — the same tokens at today&rsquo;s price, which is what a trading screen shows
          but not what they can be sold for, because selling walks the price down the curve. &ldquo;closed&rdquo;
          once it was all sold, showing what its tokens sold for minus what it cost. A fresh buy shows what selling it
          straight back would cost (fees both ways and the price impact). Buybacks are burned and carry no PnL. Gas not included.
        </p>
      ) : null}

      {shown.length > 5 ? (
        <p className="tiny dim" style={{ marginTop: 6 }}>
          Showing {shown.length} trades
          {nextBefore ? " — scroll to the bottom of the panel to load older ones." : " — the whole history."}
        </p>
      ) : null}

      {counts.dex > 0 ? (
        <p className="tiny dim" style={{ marginTop: 10 }}>
          This market has graduated: the curve no longer buys back, and pool trades pay the
          venue&rsquo;s fee rather than the protocol&rsquo;s.
        </p>
      ) : null}
    </div>
  );
}
