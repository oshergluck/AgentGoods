/**
 * Shared presentational components.
 *
 * The two most important ones here are `DeclarationBadge` and `SignalSummaryCard`, because
 * they carry MASTER_PLAN 14A.1 and 14A.3 obligations into the pixels: a declaration must be
 * visibly labelled as an unverified seller claim everywhere it appears, including in compact
 * list rows, and a positive rate must never be rendered below MIN_SIGNALS.
 */

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Logo, MediaFrame, TagRow, displayName } from "./media";
import { IterationsBlock } from "./development";
import { money, moneyValue, exact, compactToken, rentalPeriod, priceUSDC, createdDateTime } from "../lib/format";
import {
  formatRate,
  shortAddress,
  timeAgo,
  type Declaration,
  type Freshness,
  type ProductView,
  type SignalSummary,
  type StoreView,
} from "../lib/api";

export function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={accent ? "value accent" : "value"}>{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card">
          <div className="skeleton" style={{ width: "42%", marginBottom: 10 }} />
          <div className="skeleton" style={{ width: "78%", marginBottom: 8 }} />
          <div className="skeleton" style={{ width: "58%" }} />
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div style={{ fontSize: 15, color: "var(--text-muted)", marginBottom: 6 }}>{title}</div>
      {hint ? <div className="tiny">{hint}</div> : null}
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="notice warn" role="alert">
      <strong>Could not load this view.</strong> {message}
    </div>
  );
}

export function FreshnessBar({ freshness }: { freshness?: Freshness }) {
  if (!freshness) return null;
  const state = freshness.stale ? "warn" : freshness.indexerStatus === "live" ? "live" : "warn";
  return (
    <div className="status-bar" role="status">
      <span>
        <span className={`dot ${state}`} aria-hidden="true" />
        Indexer {freshness.indexerStatus}
        {freshness.stale ? " (stale)" : ""}
      </span>
      <span className="tabular">block {freshness.indexedBlock.toLocaleString()}</span>
      <span className="tabular">lag {freshness.lagBlocks}</span>
      <span>
        {freshness.stale
          ? "Data below may be behind the chain. High-risk Agent writes are refused while stale."
          : "Reads are served from the indexed projection, never a live chain call."}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ Phase 10.1 */

/**
 * The declared token saving, always labelled as an unverified seller claim.
 * `compact` is used in list rows, where the label must still be present. [14A.1, 14A.5]
 */
export function DeclarationBadge({ declaration, compact }: { declaration: Declaration; compact?: boolean }) {
  if (!declaration.declared) {
    return (
      <span className="pill" title="This seller made no token-saving claim. That is valid.">
        No saving declared
      </span>
    );
  }

  const perUsdc = declaration.tokensSavedPerUsdc;
  return (
    <span
      className="pill claim"
      title={declaration.disclaimer}
      aria-label={`Unverified seller claim: saves ${declaration.tokensSaved} ${declaration.modelTier} tokens`}
    >
      <span className="glyph" aria-hidden="true">
        ◈
      </span>
      {compact ? null : <span>Seller claim (unverified):</span>}
      <strong className="tabular">{Number(declaration.tokensSaved).toLocaleString()}</strong>
      <span>tok</span>
      {perUsdc ? <span className="dim">· {Number(perUsdc).toLocaleString()}/USDC</span> : null}
      <span className="dim">· {declaration.basis.toLowerCase()}</span>
    </span>
  );
}

export function DeclarationPanel({ declaration }: { declaration: Declaration }) {
  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Declared token saving</h3>
        <span className="pill claim">Unverified seller claim</span>
      </div>

      {declaration.declared ? (
        <>
          <div className="grid cols-3" style={{ marginBottom: 12 }}>
            <Stat
              label="Tokens the seller says you avoid"
              value={<span className="tabular">{Number(declaration.tokensSaved).toLocaleString()}</span>}
            />
            <Stat label="Assumed model tier" value={declaration.modelTier ?? "—"} />
            <Stat
              label="Basis"
              value={declaration.basis === "MEASURED" ? "Measured by seller" : "Estimated by seller"}
              hint={declaration.basis === "MEASURED" ? "The seller says it ran the workload." : undefined}
            />
          </div>
          {declaration.buildCostUSDC ? (
            <div className="build-cost" title={declaration.buildCostUSDC.howItIsComputed}>
              <div className="tiny dim" style={{ marginBottom: 4 }}>Building it yourself would cost about</div>
              <div className="build-cost-row">
                {declaration.buildCostUSDC.atDeclaredModel ? (
                  <span className="build-cost-main tabular">
                    ${declaration.buildCostUSDC.atDeclaredModel.usdc}
                    <span className="tiny dim"> on {declaration.buildCostUSDC.atDeclaredModel.model}</span>
                  </span>
                ) : null}
                {declaration.buildCostUSDC.atReferenceModels.map((r) => (
                  <span key={r.model} className="build-cost-ref tabular">
                    ${r.usdc} <span className="tiny dim">{r.model}</span>
                  </span>
                ))}
              </div>
              {declaration.buildCostUSDC.breakdown ? (
                <div className="tiny" style={{ marginBottom: 2 }}>
                  input {declaration.buildCostUSDC.breakdown.input.toLocaleString("en-US")} · reasoning{" "}
                  {declaration.buildCostUSDC.breakdown.reasoning.toLocaleString("en-US")} · output{" "}
                  {declaration.buildCostUSDC.breakdown.output.toLocaleString("en-US")} tokens
                </div>
              ) : null}
              <div className="tiny dim">Declared tokens at published list prices (reasoning billed as output). A reference for buy-versus-build, not a price.</div>
            </div>
          ) : null}
          {declaration.tokensSavedPerUsdc ? (
            <div className="grid" style={{ marginBottom: 12 }}>
              <Stat
                label="Derived: tokens per USDC"
                value={<span className="tabular">{Number(declaration.tokensSavedPerUsdc).toLocaleString()}</span>}
                hint="Computed by the indexer from the on-chain claim and price. Not stored as truth."
              />
            </div>
          ) : null}
          <div className="notice claim">
            <strong>The protocol verifies none of this.</strong> {declaration.disclaimer} Weigh it against
            this seller&rsquo;s delivered record below.
          </div>
        </>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          No tokens declared. This product was listed before every listing had to declare the tokens
          building it took; it gains a declaration with its next update.
        </p>
      )}
    </div>
  );
}

/**
 * Buyer signal summary.
 *
 * Below MIN_SIGNALS this renders counts and an explicit "not enough signals" state and NEVER
 * a percentage, because a rate from three data points is noise presented as a measurement.
 * Coverage is always shown, including when it is bad: absence of signals is information.
 * [14A.3, 14A.5]
 */
export function SignalSummaryCard({ summary, title }: { summary?: SignalSummary; title?: string }) {
  if (!summary) return null;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>{title ?? "Buyer signals"}</h3>
        <span className="pill">No economic weight</span>
      </div>
      <p className="tiny dim" style={{ marginTop: 0, marginBottom: 14 }}>
        A binary verdict from buyers after delivery. It pays nothing and ranks nothing.
      </p>

      {summary.insufficientSignals ? (
        <>
          <div className="grid cols-4" style={{ marginBottom: 12 }}>
            <Stat label="Delivered" value={<span className="tabular">{summary.delivered}</span>} />
            <Stat label="Signalled" value={<span className="tabular">{summary.signalled}</span>} />
            <Stat label="Worth it" value={<span className="tabular">{summary.positive}</span>} />
            <Stat label="Not worth it" value={<span className="tabular">{summary.negative}</span>} />
          </div>
          <div className="notice info">
            <strong>Not enough signals for a rate.</strong> Fewer than {summary.minSignals} counted signals,
            so no percentage is shown. Raw counts are above.
          </div>
        </>
      ) : (
        <div className="grid cols-4" style={{ marginBottom: 12 }}>
          <Stat
            label="Worth it"
            value={formatRate(summary.positiveRate)}
            hint={`${summary.positive} of ${summary.signalled}`}
            accent
          />
          <Stat
            label="Coverage"
            value={formatRate(summary.coverage)}
            hint={`${summary.signalled} of ${summary.delivered} delivered`}
          />
          <Stat label="Delivered" value={<span className="tabular">{summary.delivered}</span>} />
          <Stat
            label="Last 30 days"
            value={formatRate(summary.rolling30d.positiveRate)}
            hint={`${summary.rolling30d.signalled} signals`}
          />
        </div>
      )}

      {summary.raw.selfSignalCount > 0 ? (
        <div className="notice claim">
          <strong>{summary.raw.selfSignalCount} self-signal(s) excluded.</strong> The seller bought from
          its own store and signalled. Those are visible in the raw counts ({summary.raw.signalled} total,{" "}
          {summary.raw.positive} positive) but are excluded from every rate above.
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- cards */

export function ProductCard({ product }: { product: ProductView }) {
  const p = product.protocol;
  const profile = product.sellerContent.profile;
  const title = displayName(profile, "", p.productId);
  const storeName =
    product.store?.sellerContent.name || product.store?.protocol.tokenSymbol || "";

  return (
    <Link className="card interactive reveal product-card" to={`/products/${p.productId}`}>
      <MediaFrame media={profile?.cover} seed={p.productId} ratio="16 / 7" />

      <div className="card-body">
        <div className="card-top">
          {product.mode === "SERVICE" ? (
            <span className="pill service" title="Called per use: input in, result out, paid per call">Service</span>
          ) : (
            <span className="pill protocol">{p.storeType === "rentals" ? "Rental" : "Sale"}</span>
          )}
          <span className="tiny dim nowrap">{timeAgo(p.createdAt)}</span>
        </div>

        <h3 className="card-title">{title}</h3>
        {profile?.tagline ? <p className="card-tagline">{profile.tagline}</p> : null}

        {storeName ? (
          <div className="card-seller">
            <Logo
              media={product.store?.sellerContent.logo}
              seed={product.store?.protocol.storeId ?? p.storeId}
              size={20}
            />
            <span className="tiny dim">{storeName}</span>
          </div>
        ) : null}

        <div className="card-price">
          <span className="tabular" title={exact(p.priceUSDC)}>
            {moneyValue(p.priceUSDC)}
          </span>
          <span className="dim small">
            USDC
            {product.mode === "SERVICE" ? " / call" : p.storeType === "rentals" ? ` / ${rentalPeriod(p.rentalPeriodSeconds)}` : ""}
          </span>
        </div>

        <IterationsBlock development={product.development} />
        <CreatedStamp at={p.createdAt} what="Listed" />

        <div className="pill-row">
          <DeclarationBadge declaration={product.declaration} compact />
          {product.incentive.enabled ? (
            <span
              className="pill market"
              title={`Derived from the currently indexed pool of ${compactToken(
                product.incentive.rewardPoolAIC
              )}. The pool decays with every unit, so take the contract preview in the quote.`}
            >
              +{compactToken(product.incentive.perUnitAIC)} per {p.storeType === "rentals" ? "period" : "unit"}
            </span>
          ) : null}
          {p.unlimitedInventory ? (
            <span className="pill">unlimited</span>
          ) : (
            <span className="pill">{p.inventory} left</span>
          )}
        </div>

        <TagRow tags={profile?.tags} />

        {product.sellerSignals ? (
          <div className="tiny dim">
            Seller record:{" "}
            {product.sellerSignals.insufficientSignals ? (
              <>
                {product.sellerSignals.signalled} signal(s), {product.sellerSignals.delivered} delivered — too
                few for a rate
                {product.sellerSignals.coverage ? (
                  <> · {formatRate(product.sellerSignals.coverage)} coverage</>
                ) : null}
              </>
            ) : (
              <>
                {formatRate(product.sellerSignals.positiveRate)} worth it ·{" "}
                {formatRate(product.sellerSignals.coverage)} coverage
              </>
            )}
          </div>
        ) : null}
      </div>
    </Link>
  );
}

export function StoreCard({ store }: { store: StoreView }) {
  const s = store.protocol;
  const profile = store.sellerContent.profile;
  const name = displayName(profile, store.sellerContent.name, s.storeId);

  return (
    <Link className="card interactive reveal store-card" to={`/stores/${s.storeId}`}>
      <MediaFrame media={profile?.cover} seed={s.storeId} ratio="16 / 6" />

      <div className="card-body">
        <div className="card-top">
          <span className="pill protocol">{s.storeType === "rentals" ? "Rentals" : "Sales"}</span>
          {s.governance.governanceLockActive ? <span className="pill warn">Governance lock</span> : null}
        </div>

        <div className="store-head">
          <Logo media={profile?.logo} seed={s.storeId} size={42} label={`${name} logo`} />
          <div>
            <h3 className="card-title">{name}</h3>
            <div className="tiny dim mono">
              {store.token?.symbol ? `${store.token.symbol} · ` : ""}
              {shortAddress(s.storeAddress)}
            </div>
          </div>
        </div>

        {profile?.tagline ? <p className="card-tagline">{profile.tagline}</p> : null}

        {store.overview ? <StoreFacts store={store} /> : null}
        {store.overview?.graduation ? <GraduationBar g={store.overview.graduation} /> : null}
        <CreatedStamp at={s.createdAt} what="Opened" />

        <div className="grid cols-2" style={{ gap: 8 }}>
          <div>
            <div className="tiny dim">Lifetime commerce</div>
            <div className="tabular small" title={exact(s.accounting.lifetimeGrossCommerceUSDC)}>
              {money(s.accounting.lifetimeGrossCommerceUSDC)}
            </div>
          </div>
          <div>
            <div className="tiny dim">Lifetime buyback</div>
            <div
              className="tabular small"
              title={exact(s.accounting.lifetimeBuybackUSDC ?? store.aic?.lifetimeBuybackUSDC)}
            >
              {money(s.accounting.lifetimeBuybackUSDC ?? store.aic?.lifetimeBuybackUSDC, 4)}
            </div>
          </div>
        </div>

        <TagRow tags={profile?.tags} />

        {store.aic ? (
          <div className="tiny dim">
            {store.aic.token.symbol || "Token"} {(store.aic.netSoldPercentageBps / 100).toFixed(2)}% sold ·{" "}
            {store.aic.phase === "external_dex" ? "on external DEX" : "bonding curve"}
          </div>
        ) : null}
      </div>
    </Link>
  );
}

/**
 * How close the store's AIC market is to graduating to its DEX pool, against this network's
 * threshold — so a page of stores shows at a glance which are close and which have graduated.
 */
function GraduationBar({ g }: { g: { graduated: boolean; netSoldBps: number; thresholdBps: number } }) {
  const pctOfThreshold = g.graduated ? 100 : g.thresholdBps > 0 ? Math.min(100, (g.netSoldBps / g.thresholdBps) * 100) : 0;
  const state = g.graduated ? "done" : pctOfThreshold >= 80 ? "close" : "";
  const fmt = (bps: number) => (bps / 100).toFixed(bps % 100 ? 1 : 0);
  return (
    <div className={`grad ${state}`} title={g.graduated ? "Graduated: trades on its DEX pool" : `${fmt(g.netSoldBps)}% of supply sold from the curve; graduation at ${fmt(g.thresholdBps)}%`}>
      <div className="grad-row">
        <span className="grad-label">{g.graduated ? "Graduated" : "Graduation"}</span>
        <span className="grad-value tabular">
          {g.graduated ? "on DEX pool" : `${fmt(g.netSoldBps)}% / ${fmt(g.thresholdBps)}%`}
        </span>
      </div>
      <div className="grad-bar" aria-hidden>
        <span style={{ width: `${pctOfThreshold.toFixed(1)}%` }} />
      </div>
    </div>
  );
}

/** A small box with the date and time something was created on chain. */
function CreatedStamp({ at, what }: { at: number; what: string }) {
  const c = createdDateTime(at);
  if (!c) return null;
  return (
    <div className="created-stamp" title={new Date(at * 1000).toString()}>
      <span className="created-label">{what}</span>
      <span className="created-date">{c.date}</span>
      <span className="created-time tabular">{c.time}</span>
    </div>
  );
}

/** The business at a glance: what it sells, the work behind it, who buys, who holds, what a buyer earns. */
function StoreFacts({ store }: { store: StoreView }) {
  const o = store.overview!;
  const inc = store.customerIncentive;
  const incentiveOn = inc ? BigInt(inc.nextUnitRewardAIC.base || "0") > 0n : false;
  const tiles: { label: string; value: ReactNode; hint?: string; tone?: string }[] = [
    {
      label: "Products",
      value: (
        <>
          {o.productsActive}
          {o.productsTotal > o.productsActive ? <span className="dim"> / {o.productsTotal}</span> : null}
        </>
      ),
      hint: o.cheapestProductUSDC ? `from ${moneyValue(o.cheapestProductUSDC)} USDC` : "nothing on sale",
    },
    {
      label: "Iterations",
      value: <>⟳ {o.iterationsTotal}</>,
      hint: o.mostIteratedProduct ? `top product ${o.mostIteratedProduct}` : "no record yet",
      tone: o.iterationsTotal >= 12 ? "iter" : undefined,
    },
    {
      label: "Customers",
      value: o.customers,
      hint: o.sales ? `${o.sales} sale${o.sales === 1 ? "" : "s"}${o.lastSaleAt ? ` · last ${timeAgo(o.lastSaleAt)}` : ""}` : "no sales yet",
      tone: o.sales ? "ok" : undefined,
    },
    {
      label: "Buyer incentive",
      value: incentiveOn ? `+${compactToken(inc!.nextUnitRewardAIC)}` : "None",
      hint: incentiveOn ? `per ${store.protocol.storeType === "rentals" ? "period" : "item"}` : "pool unfunded",
      tone: incentiveOn ? "market" : undefined,
    },
    {
      label: "Holders",
      value: o.holders,
      hint: o.aicPrice1e18 ? `${store.token?.symbol || "AIC"} ${priceUSDC(o.aicPrice1e18)} USDC` : undefined,
    },
  ];
  return (
    <div className="store-facts">
      {tiles.map((t) => (
        <div key={t.label} className={`store-fact${t.tone ? ` ${t.tone}` : ""}`}>
          <div className="store-fact-label">{t.label}</div>
          <div className="store-fact-value tabular">{t.value}</div>
          {t.hint ? <div className="store-fact-hint">{t.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function AddressLine({ label, address }: { label: string; address: string }) {
  return (
    <div style={{ display: "flex", gap: 10, justifyContent: "space-between", padding: "7px 0" }}>
      <span className="tiny dim nowrap">{label}</span>
      <span className="mono tiny" style={{ textAlign: "right" }}>
        {address}
      </span>
    </div>
  );
}
