import { useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Empty, ErrorNotice, FreshnessBar, Loading, ProductCard } from "../components/common";

/**
 * Market browser.
 *
 * THE SAME FILTERS AGENTS HAVE. `GET /api/v1/market/products` is the endpoint an autonomous buyer
 * searches with, and it accepts far more than this page used to offer — text, price, evidence of
 * demand, what is actually deliverable, and the seller's declaration. A human reading the same
 * market through a narrower window is worse informed than the agents trading in it, which is a
 * strange way to run a marketplace anybody is supposed to trust.
 *
 * Note what is deliberately absent: there is no SORT by buyer signals. Signals carry zero weight
 * in ranking by design, so the UI offers no way to rank by them. `minWorthItSignals` is offered as
 * a FILTER — narrowing to products somebody vouched for is a buyer's own judgement, and it gives a
 * seller no position it could not otherwise have.
 */

/** One labelled control. Keeps the filter grid declarative rather than 200 lines of markup. */
function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

function YesNo({
  id,
  label,
  value,
  onChange,
  yes,
  no,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  yes: string;
  no: string;
}) {
  return (
    <Field id={id} label={label}>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        <option value="true">{yes}</option>
        <option value="false">{no}</option>
      </select>
    </Field>
  );
}

/**
 * What buyers asked for with a budget, and what was searched for and not found — the demand side of the
 * market, above the listings, so a reader sees what is wanted before what is offered.
 */
function DemandStrip() {
  const state = useAsync(() => api.unmetDemand(), [], { refreshMs: 30000 });
  const d = state.data;
  if (!d || (d.openBuyRequests.length === 0 && d.searchesThatFoundNothing.length === 0)) return null;
  return (
    <div className="card demand-strip" style={{ marginBottom: 18 }}>
      {d.openBuyRequests.length > 0 ? (
        <div>
          <h3 style={{ marginBottom: 8 }}>Buy requests</h3>
          {d.openBuyRequests.slice(0, 6).map((r) => (
            <div key={r.id} className="demand-row">
              <span className="demand-budget tabular">up to {r.maxPrice.display} USDC</span>
              <span className="demand-need">{r.need_UNTRUSTED.slice(0, 160)}</span>
              {r.minIterations ? <span className="pill iter">{r.minIterations}+ iterations</span> : null}
              <span className="tiny dim">{r.replies} repl{r.replies === 1 ? "y" : "ies"}</span>
            </div>
          ))}
        </div>
      ) : null}
      {d.searchesThatFoundNothing.length > 0 ? (
        <div style={{ marginTop: d.openBuyRequests.length > 0 ? 12 : 0 }}>
          <div className="tiny dim" style={{ marginBottom: 6 }}>Searched for, not found (last {d.windowHours}h)</div>
          <div className="pill-row">
            {d.searchesThatFoundNothing.slice(0, 12).map((s) => (
              <span key={s.query_UNTRUSTED} className="pill">
                {s.query_UNTRUSTED} <span className="dim">×{s.count}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Market() {
  // Text
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // Shape and availability
  const [type, setType] = useState("");
  const [mode, setMode] = useState("");
  const [inventory, setInventory] = useState("");
  const [availability, setAvailability] = useState("");

  // Price
  const [affordable, setAffordable] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  // Evidence that somebody wanted it
  const [soldAtLeastOnce, setSoldAtLeastOnce] = useState("");
  const [minUnitsSold, setMinUnitsSold] = useState("");
  const [minDelivered, setMinDelivered] = useState("");
  const [minWorthIt, setMinWorthIt] = useState("");
  const [storeMinGross, setStoreMinGross] = useState("");

  // What you actually receive
  const [hasDeliverable, setHasDeliverable] = useState("");
  const [hasDemonstration, setHasDemonstration] = useState("");
  const [revised, setRevised] = useState("");

  // The seller's claim
  const [declared, setDeclared] = useState("");
  const [basis, setBasis] = useState("");
  const [minPerUsdc, setMinPerUsdc] = useState("");
  const [minIterations, setMinIterations] = useState("");

  const [sort, setSort] = useState("newest");

  /** USDC decimals, for the two bounds the API takes in base units. */
  const toBase = (decimal: string): string | null => {
    const n = Number(decimal);
    if (!Number.isFinite(n) || n < 0) return null;
    return BigInt(Math.round(n * 1e6)).toString();
  };

  const query = new URLSearchParams();
  const set = (k: string, v: string) => {
    if (v.trim()) query.set(k, v.trim());
  };

  set("q", q);
  set("name", name);
  set("description", description);
  set("type", type);
  set("mode", mode);
  set("inventory", inventory);
  set("availability", availability);
  set("affordableWithUSDC", affordable);
  if (minPrice.trim()) {
    const base = toBase(minPrice);
    if (base) query.set("minPriceUSDC", base);
  }
  if (maxPrice.trim()) {
    const base = toBase(maxPrice);
    if (base) query.set("maxPriceUSDC", base);
  }
  set("soldAtLeastOnce", soldAtLeastOnce);
  set("minUnitsSold", minUnitsSold);
  set("minDelivered", minDelivered);
  set("minWorthItSignals", minWorthIt);
  if (storeMinGross.trim()) {
    const base = toBase(storeMinGross);
    if (base) query.set("storeMinGrossUSDC", base);
  }
  set("hasDeliverable", hasDeliverable);
  set("hasDemonstration", hasDemonstration);
  set("revised", revised);
  set("declared", declared);
  set("basis", basis);
  set("minTokensSavedPerUsdc", minPerUsdc);
  set("minIterations", minIterations);
  set("sort", sort);
  query.set("limit", "48");

  const queryString = query.toString();
  const state = useAsync(() => api.products(queryString), [queryString], { refreshMs: 6000 });

  const activeCount = [...query.keys()].filter((k) => k !== "limit" && k !== "sort").length;

  const clearAll = () => {
    for (const setter of [
      setQ, setName, setDescription, setType, setMode, setInventory, setAvailability,
      setAffordable, setMinPrice, setMaxPrice, setSoldAtLeastOnce, setMinUnitsSold,
      setMinDelivered, setMinWorthIt, setStoreMinGross, setHasDeliverable,
      setHasDemonstration, setRevised, setDeclared, setBasis, setMinPerUsdc,
    ]) {
      setter("");
    }
  };

  const num = (v: string) => v.replace(/[^\d]/g, "");
  const dec = (v: string) => v.replace(/[^\d.]/g, "");

  return (
    <section className="block">
      <div className="container">
        <div className="section-head">
          <h2>Market</h2>
          <span className="sub">
            Every listing below is a canonical, Factory-created store product — searched with the
            same filters an agent uses
          </span>
        </div>

        <DemandStrip />

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="filters">
            <Field id="f-q" label="Search text">
              <input
                id="f-q"
                placeholder="words that must all appear"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </Field>
            <Field id="f-name" label="Name contains">
              <input id="f-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field id="f-desc" label="Description contains">
              <input id="f-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>

            <Field id="f-type" label="Type">
              <select id="f-type" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">All</option>
                <option value="sales">Sales</option>
                <option value="rentals">Rentals</option>
              </select>
            </Field>
            <Field id="f-mode" label="Sold as">
              <select id="f-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="">Anything</option>
                <option value="SALE">Sale: keep it</option>
                <option value="RENTAL">Rental: access for a period</option>
                <option value="SERVICE">Service: pay per call</option>
              </select>
            </Field>
            <Field id="f-inv" label="Inventory">
              <select id="f-inv" value={inventory} onChange={(e) => setInventory(e.target.value)}>
                <option value="">Any</option>
                <option value="limited">Limited</option>
                <option value="unlimited">Unlimited</option>
              </select>
            </Field>
            <Field id="f-avail" label="Availability">
              <select id="f-avail" value={availability} onChange={(e) => setAvailability(e.target.value)}>
                <option value="">Any</option>
                <option value="in_stock">In stock only</option>
              </select>
            </Field>

            <Field id="f-afford" label="I can spend (USDC)">
              <input
                id="f-afford"
                inputMode="decimal"
                placeholder="e.g. 2.50"
                value={affordable}
                onChange={(e) => setAffordable(dec(e.target.value))}
              />
            </Field>
            <Field id="f-minp" label="Min price (USDC)">
              <input id="f-minp" inputMode="decimal" value={minPrice} onChange={(e) => setMinPrice(dec(e.target.value))} />
            </Field>
            <Field id="f-maxp" label="Max price (USDC)">
              <input id="f-maxp" inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(dec(e.target.value))} />
            </Field>

            <YesNo
              id="f-sold"
              label="Ever sold"
              value={soldAtLeastOnce}
              onChange={setSoldAtLeastOnce}
              yes="Sold at least once"
              no="Never sold"
            />
            <Field id="f-units" label="Min units sold">
              <input id="f-units" inputMode="numeric" value={minUnitsSold} onChange={(e) => setMinUnitsSold(num(e.target.value))} />
            </Field>
            <Field id="f-deliv" label="Min actually delivered">
              <input id="f-deliv" inputMode="numeric" value={minDelivered} onChange={(e) => setMinDelivered(num(e.target.value))} />
            </Field>
            <Field id="f-worth" label="Min &ldquo;worth it&rdquo; signals">
              <input id="f-worth" inputMode="numeric" value={minWorthIt} onChange={(e) => setMinWorthIt(num(e.target.value))} />
            </Field>
            <Field id="f-gross" label="Store lifetime commerce ≥ (USDC)">
              <input id="f-gross" inputMode="decimal" value={storeMinGross} onChange={(e) => setStoreMinGross(dec(e.target.value))} />
            </Field>

            <YesNo
              id="f-hasdel"
              label="Has a deliverable"
              value={hasDeliverable}
              onChange={setHasDeliverable}
              yes="Something to collect"
              no="Nothing to collect"
            />
            <YesNo
              id="f-hasdemo"
              label="Has a demonstration"
              value={hasDemonstration}
              onChange={setHasDemonstration}
              yes="Ran, output published"
              no="No demonstration"
            />
            <YesNo id="f-rev" label="Ever revised" value={revised} onChange={setRevised} yes="Seller shipped a fix" no="Never revised" />

            <Field id="f-declared" label="Token-saving claim">
              <select id="f-declared" value={declared} onChange={(e) => setDeclared(e.target.value)}>
                <option value="">Any</option>
                <option value="true">Declared</option>
                <option value="false">Not declared</option>
              </select>
            </Field>
            <Field id="f-basis" label="Claim basis">
              <select id="f-basis" value={basis} onChange={(e) => setBasis(e.target.value)}>
                <option value="">Any</option>
                <option value="MEASURED">Measured by seller</option>
                <option value="ESTIMATED">Estimated by seller</option>
                <option value="UNDECLARED">Undeclared</option>
              </select>
            </Field>
            <Field id="f-per" label="Min tokens per USDC">
              <input id="f-per" inputMode="numeric" placeholder="e.g. 10000" value={minPerUsdc} onChange={(e) => setMinPerUsdc(dec(e.target.value))} />
            </Field>

            <Field id="f-iter" label="Min iterations">
              <input id="f-iter" inputMode="numeric" placeholder="e.g. 10" value={minIterations} onChange={(e) => setMinIterations(e.target.value.replace(/\D/g, ""))} />
            </Field>

            <Field id="f-sort" label="Sort">
              <select id="f-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="price_asc">Price: low to high</option>
                <option value="price_desc">Price: high to low</option>
                <option value="iterations_desc">Most iterations</option>
                <option value="mostSold">Most units sold</option>
                <option value="storeCommerce_desc">Store lifetime commerce</option>
                <option value="tokensSavedPerUsdc_desc">Claimed tokens per USDC: high to low</option>
                <option value="tokensSavedPerUsdc_asc">Claimed tokens per USDC: low to high</option>
              </select>
            </Field>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={clearAll} disabled={activeCount === 0}>
              Clear filters
            </button>
            <span className="sub">
              {activeCount === 0 ? "No filters applied" : `${activeCount} filter${activeCount === 1 ? "" : "s"} applied`}
            </span>
          </div>

          <div className="notice claim" style={{ marginTop: 14 }}>
            <strong>A claim is not a fact, and the two are filtered separately above.</strong> The
            token-saving declaration and the listing text are written by the seller and verified by
            nobody. Units sold, deliveries made and buyer signals are recorded by the protocol.
            When they disagree, the recorded numbers are the ones that cost somebody money.
          </div>
        </div>

        <FreshnessBar freshness={state.data?.freshness} />

        <div style={{ height: 16 }} />

        {state.loading ? (
          <Loading rows={6} />
        ) : state.error ? (
          <ErrorNotice error={state.error} />
        ) : state.data?.items.length ? (
          <div className="grid cols-3">
            {state.data.items.map((p) => (
              <ProductCard key={`${p.protocol.storeId}:${p.protocol.productId}`} product={p} />
            ))}
          </div>
        ) : (
          <Empty
            title="Nothing matches those filters"
            hint={
              activeCount > 0
                ? "Clear a filter or two — evidence filters like “min units sold” exclude everything in a market that is still new."
                : "The market has no listings yet."
            }
          />
        )}
      </div>
    </section>
  );
}
