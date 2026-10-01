/**
 * Store token market.
 *
 * Every store mints its OWN ERC20 on its OWN bonding curve. This page exists to make that
 * concrete: the rows are separate assets that merely share a mechanism, so each one is shown
 * with its own symbol, its own description and its own curve state, and nothing here aggregates
 * them into a single "AIC price".
 *
 * Reads come from the indexed projection (`/api/v1/market/tokens`), never a live chain call.
 * Nothing on this page can trade: the browser never signs an economic transaction, and buying or
 * selling is an Agent action through the TransactionIntent path. [MASTER_PLAN 0.29.P]
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, shortAddress, type TokenListing, type TokenSort } from "../lib/api";
import { circulatingSupply, compactToken, compact, exact, moneyValue, priceUSDC, transitionThresholdBps } from "../lib/format";
import {
  Empty,
  ErrorNotice,
  FreshnessBar,
  Loading,
} from "../components/common";
import { Logo, GeneratedPattern } from "../components/media";
import { useAsync } from "../lib/useAsync";
import { TokenChartPanel, suggestBucketSeconds } from "../components/TokenChart";
import { RecentTrades } from "../components/RecentTrades";
import { Leaderboard } from "../components/Leaderboard";
import { BusinessPanel } from "../components/BusinessPanel";

export default function Tokens() {
  const [sort, setSort] = useState<TokenSort>("volume_desc");
  const [selected, setSelected] = useState<string | null>(null);
  // The token market is live state, so it refreshes itself. [MASTER_PLAN 0.26.A]
  /*
   * An explicit page size, not the endpoint's default.
   *
   * The ordering is applied across the whole market, so the page size decides how much of that
   * ordering is visible. Relying on a server default means the page silently shows a different
   * slice if that default ever changes.
   */
  const state = useAsync(() => api.tokens(sort, 100), [sort], { refreshMs: 2500 });

  /*
   * Changing the ordering clears the selection, so the detail panel follows the list.
   *
   * The panel shows `selected`, falling back to the first row. `selected` used to survive a sort
   * change, so asking for "most liquidity" re-ordered the list correctly and left the chart on
   * whatever token had been picked under the previous ordering — the page then showed the highest
   * value at the top of the table and a different, lower-ranked token beside it, which reads as
   * the sort being broken. The list was right; the panel was stale.
   *
   * Clearing on a sort change makes the panel mean "the top of what you just asked for", and a
   * click still pins whichever token the viewer chooses afterwards.
   */
  useEffect(() => {
    setSelected(null);
  }, [sort]);

  const items = state.data?.items ?? [];
  const active = useMemo(() => {
    if (items.length === 0) return null;
    return items.find((t) => t.aicToken === selected) ?? items[0] ?? null;
  }, [items, selected]);

  return (
    <section className="block">
      <div className="container">
        <div className="card" style={{ marginBottom: 20 }}>
          <h3>Largest holders</h3>
          <p className="tiny dim" style={{ marginTop: -4, marginBottom: 12 }}>
            Equity valued at what the curve would actually pay to unwind the whole position.
          </p>
          <Leaderboard limit={10} />
        </div>

        <header className="page-head">
          <div>
            <h2>Token market</h2>
            <p className="muted">
              One token per store, each on its own bonding curve. These are not
              shares of AgentGoods — they are separate AIC tokens (ERC20s) whose
              only common feature is the mechanism.
            </p>
          </div>
          <div className="field" style={{ minWidth: 260 }}>
            <label htmlFor="t-sort">Sort</label>
            <select id="t-sort" value={sort} onChange={(e) => setSort(e.target.value as TokenSort)}>
              <option value="volume_desc">Most traded (lifetime volume)</option>
              <option value="buyback_desc">Lifetime buyback: high to low</option>
              <option value="storeCommerce_desc">Store lifetime commerce: high to low</option>
              <option value="reserve_desc">Curve liquidity (real USDC): high to low</option>
              <option value="price_desc">Price: high to low</option>
              <option value="price_asc">Price: low to high</option>
              <option value="progress_desc">Closest to graduation</option>
              <option value="progress_asc">Least sold from the curve</option>
              <option value="active">Most recent trade</option>
              <option value="newest">Newest market</option>
              <option value="oldest">Oldest market</option>
            </select>
          </div>
        </header>

        <section className="notice info">
          <strong>How the price is set.</strong> There is no order book and no
          counterparty. Price is a constant-product function of the curve state,
          so a buy moves it up and a sell moves it down deterministically. Once
          the network&rsquo;s graduation share of genesis supply has been net sold from the curve, the store
          performs a one-way transition to an external DEX pool and the curve
          stops quoting. A fixed share of every sale&rsquo;s net commerce buys the
          store&rsquo;s own token back on its market and burns it in the same
          transaction, so supply shrinks as the store trades. Holding a store
          token carries its governance vote; it is never a claim on another
          store.
        </section>

        <FreshnessBar freshness={state.data?.freshness} />

        {state.loading ? <Loading rows={3} /> : null}
        {state.error ? <ErrorNotice error={state.error} /> : null}
        {!state.loading && items.length === 0 ? (
          <Empty
            title="No store tokens indexed yet"
            hint="A token appears the moment a store is created."
          />
        ) : null}

        {active ? <TokenSpotlight token={active} /> : null}

        <div className="token-table" role="table" aria-label="Store tokens">
          <div className="token-row head" role="row">
            <span role="columnheader">Token</span>
            <span role="columnheader">Price</span>
            <span role="columnheader">Curve sold</span>
            <span
              role="columnheader"
              title="USDC of store commerce that has bought this token back and burned it, lifetime"
            >
              Lifetime buyback
            </span>
            <span role="columnheader" title="Real USDC the curve can pay when you sell">
              Curve liquidity
            </span>
            <span role="columnheader">Lifetime volume</span>
            <span role="columnheader">Holders</span>
          </div>
          {items.map((t) => (
            <button
              key={t.aicToken}
              type="button"
              role="row"
              className={`token-row${active?.aicToken === t.aicToken ? " selected" : ""}`}
              onClick={() => setSelected(t.aicToken)}
              aria-pressed={active?.aicToken === t.aicToken}
            >
              <span className="token-id" role="cell">
                <Logo media={t.token.logo} seed={t.aicToken} size={32} />
                <span>
                  <strong>{t.token.symbol || "—"}</strong>
                  <span className="tiny dim block">
                    {t.token.storeName || t.token.name}
                  </span>
                </span>
              </span>
              <span className="tabular" role="cell">
                {priceUSDC(t.currentIndexedPrice1e18)}
              </span>
              <span className="tabular" role="cell">
                {(t.netSoldPercentageBps / 100).toFixed(2)}%
              </span>
              <span className="tabular" role="cell">
                <span title={exact(t.lifetimeBuybackUSDC)}>
                  {t.lifetimeBuybackUSDC ? moneyValue(t.lifetimeBuybackUSDC, 4) : "—"}
                </span>
              </span>
              <span className="tabular" role="cell">
                {moneyValue(t.realUSDCReserve)}
              </span>
              <span className="tabular" role="cell">
                {compact(BigInt(t.lifetimeGrossVolumeUSDC || "0") / 10n ** 6n)}
              </span>
              <span className="tabular" role="cell">
                {t.holderCount}
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The selected token: identity, seller description, curve state and its candlestick chart. */
function TokenSpotlight({ token }: { token: TokenListing }) {
  const [bucket, setBucket] = useState(900);
  /*
   * The default timeframe follows the data until a human overrides it. A brand-new market whose
   * whole history is a few minutes long would otherwise render as a single candle on a 15-minute
   * default, which tells the reader nothing.
   */
  const bucketChosenByUser = useRef(false);
  const chooseBucket = (seconds: number) => {
    bucketChosenByUser.current = true;
    setBucket(seconds);
  };

  // The chart is the most live thing on the site: poll it fastest. The chart component seeds
  // once and then updates only the live candle, so this never resets zoom or scroll position.
  /*
   * The response is tagged with the token it belongs to, and the chart is not rendered until the
   * tag matches the selection.
   *
   * `useAsync` keeps the PREVIOUS data while a new request is in flight, which is right for a
   * poll and wrong for a switch: selecting another token left the old token's trades in
   * `trades.data` for a moment. The chart reseeded from those stale trades, recorded that it had
   * drawn the new token, and then treated the real data as a routine poll — so it grafted one bar
   * onto the previous token's candles and the graph appeared not to change at all, while the
   * price beside it updated correctly.
   *
   * Tagging makes the mismatch impossible to render rather than merely unlikely.
   */
  const trades = useAsync(
    () => api.tokenTrades(token.aicToken).then((d) => ({ ...d, forToken: token.aicToken })),
    [token.aicToken],
    { refreshMs: 1500 }
  );
  const tradesAreForThisToken = trades.data?.forToken === token.aicToken;

  /*
   * Apply the data-derived timeframe once, and only while the reader has not chosen one. Running
   * on every poll would yank the chart out from under someone who had deliberately zoomed out.
   */
  useEffect(() => {
    // Ignore a payload belonging to the token we just navigated away from.
    const items = tradesAreForThisToken ? trades.data?.items : undefined;
    if (!items || bucketChosenByUser.current) return;
    const suggested = suggestBucketSeconds(items);
    setBucket((current) => (current === suggested ? current : suggested));
  }, [trades.data]);


  const transitionPct = (token.netSoldPercentageBps / 100).toFixed(2);
  const thresholdBps = transitionThresholdBps(token);
  const thresholdPct = thresholdBps === null ? "—" : (thresholdBps / 100).toFixed(thresholdBps % 100 ? 2 : 0);

  return (
    <section className="spotlight">
      <div className="spotlight-head">
        <Logo
          media={token.token.logo}
          seed={token.aicToken}
          size={64}
          label={`${token.token.symbol} logo`}
        />
        <div className="spotlight-id">
          <h2>
            {token.token.symbol || "—"}
            <span className="dim"> · {token.token.name}</span>
          </h2>
          <div className="tiny dim mono">{token.aicToken}</div>
          <div className="tiny">
            Issued by{" "}
            <Link to={`/stores/${token.storeId}`}>
              {token.token.storeName || shortAddress(token.storeId)}
            </Link>
          </div>
        </div>
        <div className="spotlight-price">
          <div className="tiny dim">Last indexed price</div>
          <div className="big tabular">
            {priceUSDC(token.currentIndexedPrice1e18)}
          </div>
          <div className="tiny dim">
            USDC per {token.token.symbol || "token"}
          </div>
        </div>
      </div>

      {token.token.description ? (
        <div className="seller-prose">
          <p>{token.token.description}</p>
          <div className="tiny dim">
            Written by the store controller. The protocol neither verifies nor
            endorses it, and nothing in it changes what the token does.
          </div>
        </div>
      ) : (
        <p className="muted small">
          This store published no description for its token. The mechanics below
          are protocol facts and apply either way.
        </p>
      )}

      <div className="grid cols-4">
        <Mini
          label="Phase"
          value={
            token.phase === "external_dex" ? "External DEX" : "Bonding curve"
          }
        />
        <Mini
          label="Sold from curve"
          value={`${transitionPct}%`}
          hint={`transition at ${thresholdPct}%`}
        />
        <Mini
          label="Circulating"
          value={compactToken(circulatingSupply(token))}
          hint="supply minus the curve's inventory"
        />
        <Mini
          label="Burned"
          value={compactToken(token.burnedAIC)}
          hint={
            token.buybackBurnedAIC
              ? `${compactToken(token.buybackBurnedAIC)} by buyback`
              : undefined
          }
        />
      </div>

      <div className="transition-bar" aria-hidden="true">
        <div
          className="fill"
          style={{
            width: `${Math.min(100, (token.netSoldPercentageBps / (thresholdBps || 10000)) * 100).toFixed(2)}%`,
          }}
        />
      </div>
      <div className="tiny dim">
        {transitionPct}% of genesis supply net sold. At {thresholdPct}% the store performs
        the one-way DEX transition, adds liquidity at a 35% premium and burns
        the LP tokens.
      </div>

      {trades.loading || !tradesAreForThisToken ? (
        <div className="chart-skeleton">
          <GeneratedPattern seed={token.aicToken} />
        </div>
      ) : null}
      {trades.error ? <ErrorNotice error={trades.error} /> : null}
      {trades.data && tradesAreForThisToken ? (
        <TokenChartPanel
          seriesKey={token.aicToken}
          trades={trades.data.items}
          bucketSeconds={bucket}
          onBucketChange={chooseBucket}
          stats={{
            currentPrice1e18: token.currentIndexedPrice1e18,
            realUSDCReserve: token.realUSDCReserve.base,
            virtualSeedUSDC: token.virtualSeedUSDC.base,
            curvePricingReserveUSDC: token.curvePricingReserveUSDC.base,
            currentSupply: token.currentSupplyAIC.base,
            circulatingSupply: circulatingSupply(token).base,
            symbol: token.token.symbol,
          }}
        />
      ) : null}

      <BusinessPanel aicToken={token.aicToken} />

      <RecentTrades aicToken={token.aicToken} />

      <div className="notice claim">
        <strong>The virtual seed is not money, and it never moves.</strong>{" "}
        {token.virtualSeedUSDC.note} What moves is the pricing reserve,{" "}
        {moneyValue(token.curvePricingReserveUSDC)} USDC, which is that constant seed plus the{" "}
        {moneyValue(token.realUSDCReserve)} USDC that has genuinely entered the curve. Only the
        real part could ever be paid back out.
      </div>

      {token.store ? (
        <div className="tiny dim">
          Controller {shortAddress(token.store.protocol.storeController)} ·{" "}
          <Link to={`/stores/${token.storeId}`}>open the store</Link>
        </div>
      ) : null}
    </section>
  );
}

function Mini({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value tabular">{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
