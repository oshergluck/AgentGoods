/**
 * Store-token price chart: candlesticks + volume, built from raw on-chain swaps.
 *
 * The API returns individual trades, never candles, because a candle is a presentation choice
 * (bucket size, carry-forward, timezone) and the server is not the authority on a chart. This
 * component does the bucketing, so any other client can reproduce it exactly from the same rows.
 *
 * Uses TradingView lightweight-charts v5 (open source), so the series API is
 * `chart.addSeries(CandlestickSeries, …)` rather than the v4 `addCandlestickSeries`.
 *
 * Price math is done on BigInt scaled integers. A store token trades at ~1e-6 USDC early on the
 * curve, where float arithmetic loses the digits that matter. Floats appear only at the final
 * hand-off to the chart library, which takes numbers.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  CandlestickSeries,
  createChart,
  HistogramSeries,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { priceUSDC, pctChange, signedPercent, compact } from "../lib/format";

export interface Trade {
  at: number;
  side: "buy" | "sell";
  grossUSDC: string;
  netUSDC: string;
  tokensAIC: string;
  pricePerToken1e18: string;
  txHash: string;
}

/** Candle width in pixels. Constant by design; see the timeScale options below. */
const BAR_SPACING = 7;
/** Empty bars kept to the right of the newest candle, so the live bar is never flush. */
const RIGHT_OFFSET = 6;

export const TIMEFRAMES: { label: string; seconds: number }[] = [
  { label: "1s", seconds: 1 },
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
  { label: "4h", seconds: 14400 },
];


/**
 * Pick a candle width that actually shows the history this token has.
 *
 * The default used to be a fixed 15 minutes regardless of the data. A store whose entire trading
 * history spans eight minutes then rendered as ONE candle pinned to the right edge with 95% of the
 * chart empty — technically correct and useless to look at.
 *
 * So the initial timeframe is derived from the span of real trades: the largest bucket that still
 * produces a readable number of candles. A quiet new market gets seconds, an established one gets
 * hours, and neither needs the reader to go hunting in the toolbar first.
 *
 * Only ever used as an INITIAL value. Once a human picks a timeframe, their choice stands.
 */
export function suggestBucketSeconds(trades: Trade[]): number {
  const rows = normalize(trades);
  if (rows.length < 2) return 60;
  const span = rows[rows.length - 1]!.time - rows[0]!.time;
  if (span <= 0) return 1;

  /*
   * Choose the timeframe whose candle count lands nearest TARGET, compared in LOG space.
   *
   * Linear "largest bucket under span/30" was the first attempt and it failed in both directions:
   * the offered timeframes jump 1s -> 60s, so an eight-minute history snapped all the way down to
   * 1s and drew 480 buckets of which 9 held a trade. Comparing ratios instead treats "10x too many
   * candles" and "10x too few" as equally bad, which is what actually matters to a reader.
   */
  const TARGET = 40;
  let best = TIMEFRAMES[0]!.seconds;
  let bestScore = Infinity;
  for (const tf of TIMEFRAMES) {
    const count = span / tf.seconds;
    if (count < 2) continue; // never collapse the whole history into one or two candles
    const score = Math.abs(Math.log(count / TARGET));
    if (score < bestScore) {
      bestScore = score;
      best = tf.seconds;
    }
  }
  return best;
}

interface Row {
  time: number;
  /** USDC per whole token, scaled by 1e18 exactly as the indexer stores it. */
  price1e18: bigint;
  /** USDC base units moved in this trade. */
  volume: bigint;
}

function normalize(trades: Trade[]): Row[] {
  const rows: Row[] = [];
  for (const t of trades) {
    const time = Number(t.at);
    if (!Number.isFinite(time) || time <= 0) continue;
    let price: bigint;
    try {
      price = BigInt(t.pricePerToken1e18 || "0");
    } catch {
      continue;
    }
    if (price <= 0n) continue;
    rows.push({ time, price1e18: price, volume: BigInt(t.grossUSDC || "0") });
  }
  // lightweight-charts requires strictly ascending, unique times.
  rows.sort((a, b) => a.time - b.time);

  /*
   * Drop prices wildly away from the median, because one of them ruins the whole chart.
   *
   * A price axis is scaled to fit its extremes, so a single bad point — a fat-fingered swap into
   * an almost-empty pool, a sample taken mid-transition — flattens every real candle into a line
   * at the bottom of the panel. The reader then sees a market that looks dead when it is not.
   *
   * A factor of five either side of the median is deliberately loose: it removes the impossible
   * without touching genuine volatility, and a market that really does move five-fold has done
   * something a reader should see rather than something to hide. Dropping is display-only; the
   * API still reports every trade, and the trade list beside the chart shows them all.
   */
  if (rows.length >= 5) {
    const sorted = [...rows].map((r) => r.price1e18).sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median > 0n) {
      const ceiling = median * 5n;
      const floor = median / 5n;
      return rows.filter((r) => r.price1e18 <= ceiling && r.price1e18 >= floor);
    }
  }

  return rows;
}

interface Bucket {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** USDC per token as a display float. Only ever used for the chart surface. */
function toFloat(price1e18: bigint): number {
  return Number(price1e18) / 1e18;
}

/**
 * Buckets trades into OHLC with carry-forward: an empty bucket after the first trade inherits
 * the previous close as all four values, so a quiet period reads as a flat line rather than a
 * gap the eye interprets as a crash.
 */
function bucketize(rows: Row[], bucketSeconds: number, maxBars: number): Bucket[] {
  const now = Math.floor(Date.now() / 1000);
  const align = (t: number) => Math.floor(t / bucketSeconds) * bucketSeconds;
  if (rows.length === 0) return [];

  const start = align(Math.max(rows[0]!.time, now - maxBars * bucketSeconds));
  const end = align(now);

  const grouped = new Map<number, Row[]>();
  for (const row of rows) {
    const key = align(row.time);
    if (key < start) continue;
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }

  // Everything before the window start still sets the opening carry-forward price.
  let carry: number | null = null;
  for (const row of rows) {
    if (align(row.time) < start) carry = toFloat(row.price1e18);
    else break;
  }

  const out: Bucket[] = [];
  for (let t = start; t <= end; t += bucketSeconds) {
    const bucket = grouped.get(t);
    if (!bucket || bucket.length === 0) {
      if (carry === null) continue; // no trade yet: do not draw a flat line out of nothing
      out.push({ time: t as UTCTimestamp, open: carry, high: carry, low: carry, close: carry, volume: 0 });
      continue;
    }
    const prices = bucket.map((r) => toFloat(r.price1e18));
    const open = carry ?? prices[0]!;
    const close = prices[prices.length - 1]!;
    const high = Math.max(open, ...prices);
    const low = Math.min(open, ...prices);
    let volume = 0n;
    for (const r of bucket) volume += r.volume;
    out.push({ time: t as UTCTimestamp, open, high, low, close, volume: Number(volume) / 1e6 });
    carry = close;
  }
  return out;
}

/** Superscript-zero price formatting, wired into both the axis and the crosshair. */
function tinyPrice(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0.00";
  if (value >= 0.01) return value.toFixed(value >= 100 ? 2 : 4);
  const text = value.toFixed(18);
  const frac = text.split(".")[1] ?? "";
  const firstSignificant = frac.search(/[1-9]/);
  if (firstSignificant < 0) return "0.00";
  const significant = frac.slice(firstSignificant, firstSignificant + 4).replace(/0+$/, "") || "0";
  const subs = "₀₁₂₃₄₅₆₇₈₉";
  const zeros = String(firstSignificant)
    .split("")
    .map((d) => subs[Number(d)] ?? d)
    .join("");
  return `0.0${zeros}${significant}`;
}

/**
 * How far back to draw, per timeframe.
 *
 * The window is a fixed number of BARS, not a fixed number of hours: at a 1s bucket a 24h
 * window would be 86,400 carry-forward candles, nearly all of them empty, which is both slow
 * and unreadable. 600 bars keeps the series bounded whatever the timeframe.
 */
const MAX_BARS = 600;

export function TokenChart({
  trades,
  bucketSeconds,
  height = 360,
  seriesKey,
}: {
  trades: Trade[];
  bucketSeconds: number;
  height?: number;
  /**
   * Which token these trades belong to.
   *
   * The chart seeds once and thereafter updates only the newest candle, so that polling does not
   * throw away the viewer's zoom and scroll position. That optimisation cannot tell "new data for
   * the same token" from "a different token entirely" — switching tokens took the update path and
   * left the previous token's candles on screen with one new bar grafted onto the end.
   *
   * Passing the token's identity here is what makes the difference visible. When it changes,
   * every bar is replaced.
   */
  seriesKey?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const seededRef = useRef(false);
  /** A scroll that could not be applied because the chart had no width yet. */
  const pendingScrollRef = useRef(false);
  const seriesKeyRef = useRef<string | undefined>(undefined);
  const lastTimeRef = useRef<number>(0);
  // A timeframe switch rewrites every bar, not just the newest one, so it must force a reseed.
  const bucketRef = useRef<number>(bucketSeconds);

  const buckets = useMemo(
    () => bucketize(normalize(trades), bucketSeconds, MAX_BARS),
    [trades, bucketSeconds]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { color: "transparent" },
        textColor: "#9aa5bd",
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.05)" },
        horzLines: { color: "rgba(255,255,255,0.05)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.09)", scaleMargins: { top: 0.1, bottom: 0.26 } },
      timeScale: {
        borderColor: "rgba(255,255,255,0.09)",
        timeVisible: true,
        secondsVisible: false,
        /*
         * A candle is a fixed unit of TIME, so it must also be a fixed unit of WIDTH. Letting
         * the series stretch to fill the panel makes two candles look like a mountain range and
         * two hundred look like noise, and it silently rescales the moment a trade lands. The
         * bar spacing is pinned here and never recomputed from the container width; new candles
         * arrive at the right edge and the series scrolls, which is what makes a quiet market
         * read as quiet.
         */
        barSpacing: BAR_SPACING,
        minBarSpacing: BAR_SPACING,
        rightOffset: RIGHT_OFFSET,
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: true,
        shiftVisibleRangeOnNewBar: true,
      },
      crosshair: { mode: 1 },
      localization: { priceFormatter: tinyPrice },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#4ade80",
      downColor: "#ff6b6b",
      borderUpColor: "#4ade80",
      borderDownColor: "#ff6b6b",
      wickUpColor: "rgba(74,222,128,0.6)",
      wickDownColor: "rgba(255,107,107,0.6)",
      priceFormat: { type: "custom", formatter: tinyPrice, minMove: 1e-12 },
      /*
       * A market with no trades in the visible window is a flat series, and autoscaling a flat
       * series collapses the price axis to a single repeated label. Padding the range keeps the
       * axis readable and, more importantly, keeps a quiet market LOOKING quiet instead of
       * looking broken.
       */
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const info = original();
        if (!info) return info;
        const { minValue, maxValue } = info.priceRange;
        if (maxValue > minValue) return info;
        const pad = Math.abs(maxValue) * 0.05 || 1e-12;
        return { ...info, priceRange: { minValue: minValue - pad, maxValue: maxValue + pad } };
      },
    });

    /*
     * Volume in its own pane when the library offers panes, overlaid when it does not.
     *
     * Overlaying it on the price scale means the bars and the candles share one vertical range, so
     * a single large trade squashes the price action into the top fifth of the panel — the volume
     * is legible and the thing the reader came for is not. A separate pane gives each its own
     * scale.
     *
     * The fallback is kept because `panes()` is not present in every build of the library, and a
     * chart that throws on creation shows nothing at all. An overlaid volume is worse than a
     * paned one and far better than an empty box.
     */
    const volume = (() => {
      try {
        if (typeof (chart as { panes?: () => unknown[] }).panes === "function") {
          const paned = chart.addSeries(
            HistogramSeries,
            { priceFormat: { type: "volume" }, priceScaleId: "" },
            1
          );
          chart.panes()[1]?.setHeight(90);
          return paned;
        }
      } catch {
        /* fall through to the overlay */
      }

      const overlaid = chart.addSeries(HistogramSeries, {
        priceScaleId: "left",
        priceFormat: { type: "volume" },
      });
      chart.priceScale("left").applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
        borderVisible: false,
        visible: false,
      });
      return overlaid;
    })();

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    seededRef.current = false;
    lastTimeRef.current = 0;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;

      /*
       * Apply a scroll that was deferred while the container had no width.
       *
       * Done here rather than on the next data tick because a chart revealed and then left alone
       * would otherwise sit wrongly scrolled until something happened to trade.
       */
      if (width > 0 && pendingScrollRef.current) {
        pendingScrollRef.current = false;
        requestAnimationFrame(() => {
          try {
            chartRef.current?.timeScale().scrollToRealTime();
          } catch {
            /* the chart may have been disposed between frames */
          }
        });
      }
      chart.applyOptions({ width });
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    const chart = chartRef.current;
    if (!candles || !volume || !chart) return;

    if (buckets.length === 0) {
      candles.setData([]);
      volume.setData([]);
      seededRef.current = false;
      // Remember which token produced the empty chart, so returning to a token with trades reseeds.
      seriesKeyRef.current = seriesKey;
      return;
    }

    const candleData: CandlestickData<Time>[] = buckets.map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    const volumeData: HistogramData<Time>[] = buckets.map((b) => ({
      time: b.time,
      value: b.volume,
      color: b.close >= b.open ? "rgba(74,222,128,0.35)" : "rgba(255,107,107,0.35)",
    }));

    const last = buckets[buckets.length - 1]!;
    const timeframeChanged = bucketRef.current !== bucketSeconds;
    bucketRef.current = bucketSeconds;

    /*
     * A different token is a different series, not an update to this one.
     *
     * Without this the newest bar of the new token was appended to the old token's chart, which
     * renders as "the graph did not change" — and worse, as a graph that is quietly wrong rather
     * than obviously stale.
     */
    const tokenChanged = seriesKeyRef.current !== seriesKey;
    seriesKeyRef.current = seriesKey;

    // Seed once, then update only the live candle, so zoom and scroll position survive polling.
    // Rebucketing is the exception: every bar is different, and updating only the last one left
    // the previous timeframe on screen.
    if (
      !seededRef.current ||
      timeframeChanged ||
      tokenChanged ||
      last.time < lastTimeRef.current ||
      buckets.length < 2
    ) {
      candles.setData(candleData);
      volume.setData(volumeData);
      /*
       * Deliberately NOT fitContent(): that stretches the candles to fill the panel. Scroll to the
       * newest bar instead and leave the fixed bar width alone.
       *
       * Guarded on width, because a range set on a zero-width time scale does not fail — it
       * succeeds against a scale that is 0px across and comes back with the bar spacing clamped
       * to its minimum and the logical range starting thousands of bars off-screen. That happens
       * whenever the chart is seeded while its container is hidden or has not been laid out yet,
       * and it renders as the whole history squeezed into a few pixels on the right. The
       * ResizeObserver below repeats this once the width is real.
       */
      if (chart.timeScale().width() > 0) chart.timeScale().scrollToRealTime();
      else pendingScrollRef.current = true;
      seededRef.current = true;
    } else {
      candles.update(candleData[candleData.length - 1]!);
      volume.update(volumeData[volumeData.length - 1]!);
    }
    lastTimeRef.current = last.time;
  }, [buckets, bucketSeconds, seriesKey]);

  return (
    <div className="chart-host">
      <div ref={containerRef} className="chart-canvas" style={{ height }} />
      {buckets.length === 0 ? (
        <div className="chart-empty tiny">
          No trades indexed for this token yet. The curve is live, but nobody has bought or sold.
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ statistics */

/** Last trade at or before `cutoff`, via binary search on the ascending row list. */
function priceAtOrBefore(rows: Row[], cutoff: number): bigint | null {
  let lo = 0;
  let hi = rows.length - 1;
  let found: bigint | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid]!;
    if (row.time <= cutoff) {
      found = row.price1e18;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export interface PriceChange {
  /** Signed percentage, or null when there is genuinely nothing to compare. */
  percent: number | null;
  /**
   * True when the window is longer than the traded history, so the figure covers the whole
   * history instead of the labelled period. Shown as `since first trade` rather than hidden:
   * a young market that doubled in ten minutes has a real 24h change, it just has not existed
   * for 24 hours.
   */
  partial: boolean;
}

/**
 * Change over a window, measured on the SAME series the candles are drawn from.
 *
 * Two things here were wrong before and both produced a visibly false arrow:
 *
 *  1. the baseline was a trade price but the comparison point was the reserve SPOT price. On a
 *     bonding curve a buy executes at the AVERAGE price across the move while the spot ends
 *     above it, so the two are different quantities and their difference is not a price change.
 *     Both ends now come from the trade series.
 *  2. the cutoff was computed from `Date.now()` while every row carries a CHAIN timestamp. When
 *     the two clocks disagree — a time-warped test chain, a drifting sequencer — every window
 *     either collapsed to nothing or swept past the whole history.
 */
function changeOver(rows: Row[], now: number, seconds: number): PriceChange {
  if (rows.length < 2) return { percent: null, partial: false };
  const latest = rows[rows.length - 1]!.price1e18;

  const atCutoff = priceAtOrBefore(rows, now - seconds);
  if (atCutoff !== null) {
    // Guard against the cutoff landing on the newest row, which would report a flat 0%.
    if (atCutoff !== latest || rows[0]!.time <= now - seconds) {
      return { percent: pctChange(atCutoff, latest), partial: false };
    }
  }

  // Shorter history than the window: measure the whole history and say so.
  const earliest = rows[0]!.price1e18;
  return { percent: pctChange(earliest, latest), partial: true };
}

export interface MarketStats {
  currentPrice1e18: string;
  /** Actual USDC held by the curve. The only figure here that is money. */
  realUSDCReserve: string;
  /** The CONSTANT virtual USDC curve seed (set per network). It never moves. */
  virtualSeedUSDC: string;
  /** Seed + real. What the constant-product formula prices against; moves on every trade. */
  curvePricingReserveUSDC: string;
  currentSupply: string;
  /** Current supply minus the curve's inventory (burned tokens already excluded). */
  circulatingSupply?: string;
  symbol: string;
}

export function TokenChartPanel({
  trades,
  stats,
  bucketSeconds,
  onBucketChange,
  seriesKey,
}: {
  trades: Trade[];
  stats: MarketStats;
  bucketSeconds: number;
  onBucketChange: (seconds: number) => void;
  /** The token being charted. Changing it replaces every bar — see TokenChart. */
  seriesKey?: string;
}) {
  const rows = useMemo(() => normalize(trades), [trades]);

  /*
   * "Now" on the CHAIN clock. Rows carry `block.timestamp`, which on a test chain or a chain
   * with a drifting sequencer is not this browser clock. Taking the later of the two keeps a
   * quiet real market anchored to the wall clock while a time-warped chain still resolves its
   * own windows.
   */
  const now = useMemo(() => {
    const wall = Math.floor(Date.now() / 1000);
    const newest = rows.length > 0 ? rows[rows.length - 1]!.time : 0;
    return Math.max(wall, newest);
  }, [rows]);

  const current = BigInt(stats.currentPrice1e18 || "0");
  const change = (seconds: number): PriceChange => changeOver(rows, now, seconds);

  const volume24h = useMemo(() => {
    let total = 0n;
    for (const r of rows) if (r.time >= now - 86400) total += r.volume;
    return total;
  }, [rows, now]);

  // Market cap = current price x circulating supply, both exact until the final render.
  const marketCap = useMemo(() => {
    const supply = BigInt(stats.circulatingSupply || stats.currentSupply || "0");
    return (current * supply) / 10n ** 18n / 10n ** 18n;
  }, [current, stats.circulatingSupply, stats.currentSupply]);

  return (
    <section className="panel chart-panel">
      <header className="chart-toolbar">
        <div>
          <h3>Price</h3>
          <div className="tiny dim">
            Built from indexed on-chain swaps. Not an order book — the store contract is the
            counterparty on every trade.
          </div>
        </div>
        <div className="timeframes" role="group" aria-label="Chart timeframe">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.label}
              type="button"
              className={`tf${tf.seconds === bucketSeconds ? " active" : ""}`}
              aria-pressed={tf.seconds === bucketSeconds}
              onClick={() => onBucketChange(tf.seconds)}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </header>

      <TokenChart trades={trades} bucketSeconds={bucketSeconds} seriesKey={seriesKey} />

      <div className="stat-grid">
        <ChangeStat label="Market cap" raw={`${compact(marketCap)} USDC`} />
        <ChangeStat label="Δ 1h" change={change(3600)} />
        <ChangeStat label="Δ 6h" change={change(6 * 3600)} />
        <ChangeStat label="Δ 24h" change={change(86400)} />
      </div>

      <div className="stat-grid">
        <ChangeStat label="Δ 5m" change={change(300)} />
        <ChangeStat
          label="Real liquidity"
          raw={`${compact(BigInt(stats.realUSDCReserve || "0") / 10n ** 6n)} USDC`}
          tone="accent"
          hint="the only figure here that is money"
        />
        <ChangeStat
          label="Virtual seed"
          raw={`${compact(BigInt(stats.virtualSeedUSDC || "0") / 10n ** 6n)} USDC`}
          tone="violet"
          hint="constant — never moves, never withdrawable"
        />
        <ChangeStat label="Volume 24h" raw={`${compact(volume24h / 10n ** 6n)} USDC`} />
      </div>

      <div className="tiny dim">
        Last indexed price {priceUSDC(stats.currentPrice1e18)} USDC per {stats.symbol || "token"}.
        The curve prices against{" "}
        {compact(BigInt(stats.curvePricingReserveUSDC || "0") / 10n ** 6n)} USDC, which is the
        constant seed plus the real USDC that has entered — only the real part could ever be paid
        out.
      </div>
    </section>
  );
}

function ChangeStat({
  label,
  change,
  raw,
  tone,
  hint,
}: {
  label: string;
  change?: PriceChange;
  raw?: string;
  tone?: "accent" | "violet";
  hint?: string;
}) {
  if (raw !== undefined) {
    return (
      <div className="stat">
        <div className="label">{label}</div>
        <div className={`value${tone ? ` ${tone}` : ""}`}>{raw}</div>
        {hint ? <div className="hint">{hint}</div> : null}
      </div>
    );
  }
  const { text, direction } = signedPercent(change?.percent ?? null);
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value ${direction}`}>{text}</div>
      {change?.partial ? <div className="hint">since first trade</div> : null}
    </div>
  );
}
