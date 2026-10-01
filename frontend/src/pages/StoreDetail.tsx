import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, shortAddress } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import {
  circulatingSupply,
  compactToken,
  exact,
  money,
  moneyValue,
  priceUSDC,
  transitionThresholdBps,
} from "../lib/format";
import { TokenChartPanel, suggestBucketSeconds } from "../components/TokenChart";
import { RecentTrades } from "../components/RecentTrades";
import {
  Logo,
  MediaFrame,
  MediaGallery,
  RejectedFields,
  SellerProse,
  TagRow,
  displayName,
} from "../components/media";
import {
  AddressLine,
  Empty,
  ErrorNotice,
  FreshnessBar,
  Loading,
  ProductCard,
  SignalSummaryCard,
  Stat,
} from "../components/common";
import ControllerGovernancePanel from "../components/ControllerGovernancePanel";

export default function StoreDetail() {
  const { storeId = "" } = useParams();
  const state = useAsync(() => api.store(storeId), [storeId], { refreshMs: 5000 });
  const products = useAsync(() => api.storeProducts(storeId), [storeId]);
  const aicToken = state.data?.store.protocol.components.aicToken ?? "";
  const trades = useAsync(
    // Tagged with its token for the same reason as the Tokens page: stale data from a previous
    // store must never be drawn as if it belonged to this one.
    () =>
      aicToken
        ? api.tokenTrades(aicToken).then((d) => ({ ...d, forToken: aicToken }))
        : Promise.resolve(null),
    [aicToken],
    { refreshMs: 1500 }
  );
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

  /*
   * Apply the data-derived timeframe once, and only while the reader has not chosen one. Running
   * on every poll would yank the chart out from under someone who had deliberately zoomed out.
   */
  useEffect(() => {
    const items = trades.data?.items;
    if (!items || bucketChosenByUser.current) return;
    const suggested = suggestBucketSeconds(items);
    setBucket((current) => (current === suggested ? current : suggested));
  }, [trades.data]);


  if (state.loading) {
    return (
      <section className="block">
        <div className="container">
          <Loading rows={4} />
        </div>
      </section>
    );
  }
  if (state.error || !state.data) {
    return (
      <section className="block">
        <div className="container">
          <ErrorNotice error={state.error ?? new Error("Store not found")} />
        </div>
      </section>
    );
  }

  const { store, aic, freshness } = state.data;
  const s = store.protocol;
  const profile = store.sellerContent.profile;
  const name = displayName(profile, store.sellerContent.name, s.storeId);
  const symbol = store.token?.symbol || aic?.token.symbol || "";
  const lifetimeBuyback = s.accounting.lifetimeBuybackUSDC ?? aic?.lifetimeBuybackUSDC ?? null;
  // Set per network, so read from the market rather than written here.
  const thresholdBps = aic ? transitionThresholdBps(aic) : null;
  const thresholdPct = thresholdBps === null ? "—" : (thresholdBps / 100).toFixed(thresholdBps % 100 ? 2 : 0);

  return (
    <section className="block page-detail">
      <div className="container">
        <div className="tiny dim" style={{ marginBottom: 12 }}>
          <Link to="/stores">Stores</Link> / store
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
          <span className="pill protocol">{s.storeType === "rentals" ? "Rentals" : "Sales"}</span>
          <span className="pill ok">canonical · factory v{s.factoryVersion}</span>
          <span className="pill">ownership epoch {s.ownershipEpoch}</span>
          {s.governance.governanceLockActive ? (
            <span className="pill warn">
              governance lock · {s.governance.unresolvedPassedProposalCount} unresolved
            </span>
          ) : null}
        </div>

        <MediaFrame media={profile?.cover} seed={s.storeId} ratio="24 / 7" />

        <div className="store-head" style={{ margin: "16px 0 6px" }}>
          <Logo media={profile?.logo} seed={s.storeId} size={56} label={`${name} logo`} />
          <div>
            <h1 style={{ fontSize: 28, margin: 0, letterSpacing: "-0.03em" }}>{name}</h1>
            {profile?.tagline ? (
              <p className="muted" style={{ margin: "2px 0 0", fontSize: 15 }}>
                {profile.tagline}
              </p>
            ) : null}
          </div>
        </div>

        <TagRow tags={profile?.tags} />

        <div className="tiny dim mono" style={{ margin: "10px 0 18px" }}>
          {symbol ? `${symbol} · ` : ""}
          {s.storeAddress}
        </div>

        <SellerProse
          profile={profile}
          fallback="This store published no description. Everything below is protocol state, which is true regardless."
        />
        <RejectedFields fields={profile?.rejectedFields} />
        <MediaGallery media={profile?.media ?? []} seed={s.storeId} />

        {s.governance.governanceLockActive ? (
          <div className="notice warn" style={{ marginBottom: 18 }}>
            <strong>This store is under a governance lock.</strong> Sales, rentals and product work
            continue normally. What is blocked is controller value extraction: no withdrawal of owner
            proceeds, no reward-pool withdrawal, no voluntary controller transfer and no token
            rescue, until at least 50% of the original YES voting power confirms the implementation.
          </div>
        ) : null}

        <div className="grid cols-4" style={{ marginBottom: 18 }}>
          <Stat
            label="Lifetime gross commerce"
            value={
              <span className="tabular" title={exact(s.accounting.lifetimeGrossCommerceUSDC)}>
                {moneyValue(s.accounting.lifetimeGrossCommerceUSDC)}
              </span>
            }
            hint="USDC"
            accent
          />
          <Stat
            label="Lifetime buyback (USDC)"
            value={
              <span className="tabular" title={exact(lifetimeBuyback)}>
                {moneyValue(lifetimeBuyback, 4)}
              </span>
            }
            hint="Store commerce spent buying this store's AIC back and burning it"
          />
          <Stat
            label={`Burned by buyback (${symbol || "AIC"})`}
            value={
              <span className="tabular" title={exact(aic?.buybackBurnedAIC)}>
                {compactToken(aic?.buybackBurnedAIC)}
              </span>
            }
            hint="Removed from supply for good. Nobody can withdraw or re-mint it."
          />
          <Stat
            label={`${symbol || "AIC"} reward pool`}
            value={<span className="tabular">{compactToken(s.accounting.rewardPoolAIC)}</span>}
            hint="Customer incentive, bought on the market by the controller"
          />
        </div>

        {aic ? (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="section-head" style={{ marginBottom: 14 }}>
              <h2 style={{ fontSize: 20 }}>
                {symbol ? `${symbol} market` : "Store token market"}
              </h2>
              <span className="sub">
                {aic.phase === "external_dex" ? "Transitioned to the external DEX" : "Bonding curve"}
              </span>
            </div>

            <div className="grid cols-4" style={{ marginBottom: 14 }}>
              <Stat
                label="Net sold from curve"
                value={`${(aic.netSoldPercentageBps / 100).toFixed(2)}%`}
                hint={`Transition at ${thresholdPct}% · ${compactToken(aic.netSoldFromCurveAIC)}`}
                accent
              />
              <Stat
                label="Real USDC reserve"
                value={<span className="tabular">{money(aic.realUSDCReserve)}</span>}
                hint="Actual money. This is what can pay a redemption."
              />
              <Stat
                label="Virtual seed (constant)"
                value={<span className="tabular">{money(aic.virtualSeedUSDC)}</span>}
                hint="Fixed at creation. It shapes the price and is never real money."
              />
              <Stat label="Holders" value={<span className="tabular">{aic.holderCount}</span>} />
            </div>

            <div
              style={{
                height: 8,
                borderRadius: 999,
                background: "rgba(255,255,255,0.07)",
                overflow: "hidden",
                marginBottom: 8,
              }}
              role="img"
              aria-label={`${(aic.netSoldPercentageBps / 100).toFixed(2)} percent of supply net sold from the curve, transition at ${thresholdPct} percent`}
            >
              <div
                style={{
                  width: `${Math.min(100, (aic.netSoldPercentageBps / (thresholdBps || 10000)) * 100)}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, var(--accent), var(--violet))",
                  transition: "width 0.5s cubic-bezier(0.22,1,0.36,1)",
                }}
              />
            </div>
            <div className="tiny dim" style={{ marginBottom: 14 }}>
              {aic.graduationBlocked
                ? "This token will not list. It trades on its bonding curve permanently."
                : `Progress toward the one-way ${thresholdPct}% DEX transition`}
            </div>

            {aic.takeoverCandidate ? (
              <div className="notice warn" style={{ marginBottom: 14 }}>
                <strong>A holder takeover has been opened against this store.</strong> The largest
                eligible holder has started the one-hour observation period. Control changes only if
                they hold the lead continuously for the whole period — if anyone overtakes them, the
                candidacy is permanently void.
                <br />
                <br />
                <strong>If you are the controller, the reward pool is at risk.</strong> It belongs
                to the store, not to you, and it transfers with control even though you bought that
                AIC yourself. Withdrawing it before the period ends both recovers it and moves it
                into your own eligible balance — which may be enough to retake the lead and end the
                takeover outright.
              </div>
            ) : null}

            {aic.graduationBlocked && (
              <div className="notice claim" style={{ marginBottom: 14 }}>
                <strong>This token will never graduate to a DEX.</strong> Someone opened and funded
                an external liquidity pool for it before it reached its graduation threshold. Listing into
                a pool that already exists would mean depositing this curve&apos;s USDC at whatever
                price that pool&apos;s creator chose, so the market declined to list at all.
                <br />
                <br />
                <strong>Nothing was lost and nothing changes for you.</strong> The curve keeps
                working in both directions — you can buy and sell exactly as before, indefinitely.
                Commerce, the buyback and burn, and governance are all unaffected. The
                only difference is that this token stays here rather than moving to Uniswap. This
                decision is permanent, including if that pool is later emptied.
                <br />
                <br />
                <strong>It still got graduation&apos;s economics.</strong> Rather than leave this
                token with its full original supply, the curve burned unsold inventory so the supply
                and the price landed where a real listing would have put them — the same 35% step.
                The curve seed was reduced alongside it, which is what keeps selling everything back
                exactly as payable as it was before. Nobody can be left unable to exit.
              </div>
            )}

            <div className="notice claim">
              <strong>The {money(aic.virtualSeedUSDC)} seed is not cash.</strong>{" "}
              {aic.virtualSeedUSDC.note} The curve prices against{" "}
              {money(aic.curvePricingReserveUSDC)}, which is that seed plus the{" "}
              {money(aic.realUSDCReserve)} of real USDC that has actually entered — so the pricing
              reserve moves on every trade
              {aic.virtualSeedUSDC.constant ? " while the seed never does." : "."}
            </div>

            {aic.token.description ? (
              <div className="seller-prose">
                <p>{aic.token.description}</p>
                <div className="tiny dim">
                  Written by the store controller, verified by nobody.
                </div>
              </div>
            ) : null}

            {trades.data && trades.data.forToken === aicToken ? (
              <TokenChartPanel
                seriesKey={aicToken || storeId}
                trades={trades.data.items}
                bucketSeconds={bucket}
                onBucketChange={chooseBucket}
                stats={{
                  currentPrice1e18: aic.currentIndexedPrice1e18,
                  realUSDCReserve: aic.realUSDCReserve.base,
                  virtualSeedUSDC: aic.virtualSeedUSDC.base,
                  curvePricingReserveUSDC: aic.curvePricingReserveUSDC.base,
                  currentSupply: aic.currentSupplyAIC.base,
                  circulatingSupply: circulatingSupply(aic).base,
                  symbol,
                }}
              />
            ) : null}

            {aicToken ? <RecentTrades aicToken={aicToken} /> : null}

            <div className="tiny dim" style={{ marginTop: 10 }}>
              Last indexed price {priceUSDC(aic.currentIndexedPrice1e18)} USDC per{" "}
              {symbol || "token"} · <Link to="/tokens">compare every store token</Link>
            </div>

            <div className="grid cols-4" style={{ marginTop: 14 }}>
              <Stat label="Genesis supply" value={compactToken(aic.genesisSupplyAIC)} />
              <Stat
                label="Current supply"
                value={compactToken(aic.currentSupplyAIC)}
                hint="Genesis minus every burn"
              />
              <Stat
                label="Circulating"
                value={compactToken(circulatingSupply(aic))}
                hint="Current supply minus the curve's inventory"
              />
              <Stat
                label="Burned"
                value={compactToken(aic.burnedAIC)}
                hint={
                  aic.buybackBurnedAIC
                    ? `${compactToken(aic.buybackBurnedAIC)} of it by buyback`
                    : undefined
                }
              />
            </div>
          </div>
        ) : null}

        <div className="grid cols-2" style={{ marginBottom: 18 }}>
          <SignalSummaryCard summary={store.signals} title="Buyer signals for this store" />

          <div className="card">
            <h3>Buyback and burn</h3>
            <p className="small muted" style={{ marginTop: 0 }}>
              A share of every sale&rsquo;s net commerce buys this store&rsquo;s own AIC on its
              market — the bonding curve, or the Uniswap pool after graduation — and burns it in the
              same purchase transaction. There is no reserve, no epoch and nothing to claim: holders
              gain through a smaller supply and a higher price.
            </p>
            <div className="grid cols-2">
              <Stat
                label="Lifetime buyback"
                value={
                  <span className="tabular" title={exact(lifetimeBuyback)}>
                    {money(lifetimeBuyback, 4)}
                  </span>
                }
              />
              <Stat
                label="Burned by buyback"
                value={
                  <span className="tabular" title={exact(aic?.buybackBurnedAIC)}>
                    {compactToken(aic?.buybackBurnedAIC)}
                  </span>
                }
              />
            </div>
            {aic?.pendingBuybackUSDC && BigInt(aic.pendingBuybackUSDC.base || "0") > 0n ? (
              <div className="notice warn" style={{ marginTop: 12 }}>
                <strong>{money(aic.pendingBuybackUSDC, 4)} of buyback is deferred.</strong> The
                pool swap did not go through in the purchase transaction, so the USDC is held for
                the next buyback. Anyone can flush it.
              </div>
            ) : null}
          </div>
        </div>

        <ControllerGovernancePanel storeId={s.storeId} controller={s.storeController} />

        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Canonical component set</h3>
          <p className="tiny dim" style={{ marginTop: 0 }}>
            Recorded append-only by the Registry at creation. These are the only addresses an Agent
            should treat as this store.
          </p>
          <AddressLine label="Store" address={s.storeAddress} />
          <AddressLine label="AIC token" address={s.components.aicToken} />
          <AddressLine label="License token" address={s.components.licenseToken} />
          <AddressLine label="Governance" address={s.components.governance} />
          <AddressLine label="Factory" address={s.factory} />
          <AddressLine label="Creator (historical)" address={s.storeCreator} />
          <AddressLine label="Controller (current)" address={s.storeController} />
        </div>

        <div className="section-head">
          <h2 style={{ fontSize: 20 }}>Products</h2>
          <span className="sub">{products.data?.items.length ?? 0} listed</span>
        </div>
        {products.loading ? (
          <Loading rows={3} />
        ) : products.data?.items.length ? (
          <div className="grid cols-3" style={{ marginBottom: 18 }}>
            {products.data.items.map((p) => (
              <ProductCard key={p.protocol.productId} product={p} />
            ))}
          </div>
        ) : (
          <Empty title="This store has no products yet" />
        )}

        <FreshnessBar freshness={freshness} />
        <div className="tiny dim" style={{ marginTop: 10 }}>
          Controller {shortAddress(s.storeController)} · {money(s.accounting.lifetimeNetCommerceUSDC)}{" "}
          net lifetime commerce
        </div>
      </div>
    </section>
  );
}
