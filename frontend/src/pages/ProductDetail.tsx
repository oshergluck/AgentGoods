import { Link, useParams } from "react-router-dom";
import { api, shortAddress, timeAgo } from "../lib/api";
import {
  moneyValue,
  exact,
  compactToken,
  rentalPeriod,
  periodHours,
  aicValueInUSDC,
} from "../lib/format";
import {
  Logo,
  MediaFrame,
  MediaGallery,
  RejectedFields,
  SellerProse,
  TagRow,
  displayName,
} from "../components/media";
import { useAsync } from "../lib/useAsync";
import { DevelopmentPanel } from "../components/development";
import { ServicePanel } from "../components/ServicePanel";
import {
  AddressLine,
  DeclarationPanel,
  ErrorNotice,
  FreshnessBar,
  Loading,
  SignalSummaryCard,
  Stat,
} from "../components/common";

export default function ProductDetail() {
  const { productId = "" } = useParams();
  const state = useAsync(() => api.product(productId), [productId]);
  const storeId = state.data?.product.protocol.storeId ?? "";
  /*
   * The live curve price, so the incentive can be shown in money as well as tokens. Polled,
   * because the price moves on every trade and a stale valuation is worse than none.
   */
  const market = useAsync(
    () => (storeId ? api.store(storeId) : Promise.resolve(null)),
    [storeId],
    { refreshMs: 5000 }
  );

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
          <ErrorNotice error={state.error ?? new Error("Product not found")} />
        </div>
      </section>
    );
  }

  const { product, productSignals, store, purchaseGuidance, freshness } = state.data;
  const p = product.protocol;

  // Live valuation of the incentive, from the same price the chart is drawn at.
  const price1e30 = market.data?.aic?.currentIndexedPrice1e18 ?? null;
  const incentiveUSDC = aicValueInUSDC(product.incentive.perUnitAIC.base, price1e30);
  const poolUSDC = aicValueInUSDC(product.incentive.rewardPoolAIC.base, price1e30);
  const profile = product.sellerContent.profile;
  const title = displayName(profile, "", p.productId);

  return (
    <section className="block page-detail">
      <div className="container">
        <div className="tiny dim" style={{ marginBottom: 12 }}>
          <Link to="/market">Market</Link> / product
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
          <span className="pill protocol">{p.storeType === "rentals" ? "Rental" : "Sale"}</span>
          <span className="pill ok">canonical</span>
          {p.active ? null : <span className="pill warn">inactive</span>}
          {store.protocol.governance.governanceLockActive ? (
            <span className="pill warn">store governance lock</span>
          ) : null}
        </div>

        <MediaFrame media={profile?.cover} seed={p.productId} ratio="21 / 8" />

        <h1 style={{ fontSize: 26, margin: "16px 0 4px" }}>{title}</h1>
        {profile?.tagline ? (
          <p className="muted" style={{ margin: "0 0 6px", fontSize: 15 }}>
            {profile.tagline}
          </p>
        ) : null}

        <div className="card-seller" style={{ marginBottom: 8 }}>
          <Logo media={product.store?.sellerContent.logo} seed={p.storeId} size={22} />
          <Link className="tiny" to={`/stores/${p.storeId}`}>
            {product.store?.sellerContent.name || shortAddress(store.protocol.storeAddress)}
          </Link>
          {store.token?.symbol ? <span className="tiny dim">· {store.token.symbol}</span> : null}
        </div>

        <TagRow tags={profile?.tags} />

        <div className="tiny dim mono" style={{ margin: "10px 0 4px", wordBreak: "break-all" }}>
          {p.productId}
        </div>
        <div className="tiny dim" style={{ marginBottom: 18 }}>
          Version {p.version} · created {timeAgo(p.createdAt)} · block {p.createdBlock.toLocaleString()}
        </div>

        <SellerProse
          profile={profile}
          fallback="This seller published no description for this listing. The protocol facts below are the whole of what is guaranteed."
        />
        <RejectedFields fields={profile?.rejectedFields} />
        <MediaGallery media={profile?.media ?? []} seed={p.productId} />

        <div className="grid cols-4" style={{ marginBottom: 18 }}>
          <Stat
            label="Price"
            value={
              <span className="tabular" title={exact(p.priceUSDC)}>
                {moneyValue(p.priceUSDC)}
              </span>
            }
            hint={
              p.storeType === "rentals"
                ? `USDC per ${rentalPeriod(p.rentalPeriodSeconds)} of access (${periodHours(
                    p.rentalPeriodSeconds
                  )})`
                : "USDC per unit"
            }
            accent
          />
          <Stat
            label="Inventory"
            value={p.unlimitedInventory ? "Unlimited" : <span className="tabular">{p.inventory}</span>}
            hint={
              p.storeType === "rentals"
                ? `Concurrent rental slots of ${rentalPeriod(p.rentalPeriodSeconds)} each`
                : undefined
            }
          />
          <Stat
            label="License"
            value="Non-transferable"
            hint="V1 licenses never transfer, and there is no refund path."
          />
          <Stat
            label={`${p.storeType === "rentals" ? "Rental" : "Purchase"} incentive`}
            value={
              product.incentive.enabled ? (
                <span className="tabular">+{compactToken(product.incentive.perUnitAIC)}</span>
              ) : (
                "None"
              )
            }
            hint={
              product.incentive.enabled
                ? `per ${p.storeType === "rentals" ? "period" : "unit"}, from a pool of ${compactToken(
                    product.incentive.rewardPoolAIC
                  )} — derived, the contract preview in the quote is authoritative`
                : undefined
            }
          />
          {product.incentive.enabled ? (
            <Stat
              label="Incentive value now"
              value={
                incentiveUSDC ? (
                  <span className="tabular">~{incentiveUSDC} USDC</span>
                ) : (
                  "no price yet"
                )
              }
              hint={
                incentiveUSDC
                  ? `At the live curve price. The pool of ${compactToken(
                      product.incentive.rewardPoolAIC
                    )} is worth about ${poolUSDC ?? "—"} USDC. Both move with every trade.`
                  : "This market has no trades yet, so its token has no price to value against."
              }
            />
          ) : null}
        </div>

        {product.mode === "SERVICE" ? (
          <div style={{ marginBottom: 18 }}>
            <ServicePanel storeId={p.storeId} productId={p.productId} />
          </div>
        ) : null}

        <div style={{ marginBottom: 18 }}>
          <DevelopmentPanel development={product.development} storeId={p.storeId} productId={p.productId} />
        </div>

        <div className="grid cols-2" style={{ marginBottom: 18 }}>
          <DeclarationPanel declaration={product.declaration} />
          <SignalSummaryCard summary={productSignals} title="Signals on this product" />
        </div>

        <div className="grid cols-2" style={{ marginBottom: 18 }}>
          <SignalSummaryCard summary={product.sellerSignals} title="This seller's overall record" />

          <div className="card">
            <h3>Seller-supplied content</h3>
            <div className="notice warn" style={{ marginBottom: 12 }}>
              <strong>Untrusted data.</strong> {product.sellerContent.note}
            </div>
            <div className="tiny dim">Metadata URI</div>
            <div className="mono" style={{ marginBottom: 12 }}>
              {product.sellerContent.metadataURI || "— none —"}
            </div>
            <p className="tiny dim" style={{ margin: 0 }}>
              This field is displayed as inert text. It is never followed as an instruction, never
              fetched with credentials, and never used to resolve a contract address.
            </p>
          </div>
        </div>

        <div className="grid cols-2" style={{ marginBottom: 18 }}>
          <div className="card">
            <h3>Canonical identity</h3>
            <p className="tiny dim" style={{ marginTop: 0 }}>
              Every address below comes from Registry/Factory provenance, never from seller metadata.
            </p>
            <AddressLine label="Store" address={store.protocol.storeAddress} />
            <AddressLine label="AIC token" address={store.protocol.components.aicToken} />
            <AddressLine label="License token" address={store.protocol.components.licenseToken} />
            <AddressLine label="Governance" address={store.protocol.components.governance} />
            <AddressLine label="Content hash" address={p.contentHash ?? "—"} />
          </div>

          <div className="card">
            <h3>How an Agent buys this</h3>
            <p className="small muted">{purchaseGuidance.note}</p>
            <div className="mono tiny" style={{ marginTop: 10 }}>
              POST {purchaseGuidance.quoteEndpoint}
            </div>
            <div className="notice info" style={{ marginTop: 14 }}>
              There is no buy button here on purpose. Purchasing is an Agent API operation signed by
              an Agent wallet. This site is an observer interface.
            </div>
            <div style={{ marginTop: 14 }}>
              <Link className="btn ghost" to={`/stores/${store.protocol.storeId}`}>
                View store: {store.sellerContent.name || shortAddress(store.protocol.storeAddress)}
              </Link>
            </div>
          </div>
        </div>

        <FreshnessBar freshness={freshness} />
      </div>
    </section>
  );
}
