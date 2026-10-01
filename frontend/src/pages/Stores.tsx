import { useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Empty, ErrorNotice, FreshnessBar, Loading, StoreCard } from "../components/common";

/**
 * Store browser.
 *
 * Ordering matters here more than anywhere else on the site, because this is the page somebody
 * uses to decide which business to back. Creation order — the only order this page used to offer —
 * answers "what is new", which is not the question. `commerce_desc` ranks by money that actually
 * moved through the store, and that is the one figure on a store page a seller cannot write for
 * itself.
 *
 * The ordering is applied by the database across every store, not to the page after it arrives.
 */
export default function Stores() {
  const [sort, setSort] = useState("commerce_desc");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");

  const query = new URLSearchParams({ limit: "60", sort });
  if (type) query.set("type", type);
  if (status) query.set("status", status);
  const queryString = query.toString();

  const state = useAsync(() => api.stores(queryString), [queryString], { refreshMs: 6000 });

  return (
    <section className="block">
      <div className="container">
        <div className="section-head">
          <h2>Stores</h2>
          <span className="sub">
            Each store was created atomically by a canonical Factory with its own immutable
            component set
          </span>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="filters">
            <div className="field">
              <label htmlFor="s-sort">Sort</label>
              <select id="s-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="commerce_desc">Lifetime commerce: high to low</option>
                <option value="commerce_asc">Lifetime commerce: low to high</option>
                <option value="incentive_desc">Customer incentive (next unit): high to low</option>
                <option value="buyback_desc">Lifetime buyback: high to low</option>
                <option value="unclaimed_desc">Unclaimed owner balance: high to low</option>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="name_asc">Name A–Z</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="s-type">Type</label>
              <select id="s-type" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">All</option>
                <option value="sales">Sales</option>
                <option value="rentals">Rentals</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="s-status">Status</label>
              <select id="s-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Any</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </select>
            </div>
          </div>

          <div className="notice claim" style={{ marginTop: 14 }}>
            <strong>Lifetime commerce is the number a seller cannot write.</strong> A store name,
            a tagline and a description are seller-supplied text. Commerce is money the protocol
            watched move. Sorting by it ranks businesses by trade rather than by copywriting.
            <br />
            <br />
            <strong>Lifetime buyback</strong> is the other half of the same question: USDC of that
            commerce that has bought this store&rsquo;s own token on its market and burned it.
            Commerce says the business trades; buyback says how much of that trade has gone back
            to its holders as a smaller supply.
            <br />
            <br />
            <strong>Customer incentive</strong> ranks by what the <em>next</em> unit would pay a
            buyer, not by pool size — the protocol pays a fraction of the remaining pool, and the
            fraction is 100&times; smaller for rentals (0.002% per rental period) than for sales
            (0.2% per item). A large rentals pool can therefore pay less per purchase than a small
            sales one.
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
            {state.data.items.map((s) => (
              <StoreCard key={s.protocol.storeId} store={s} />
            ))}
          </div>
        ) : (
          <Empty title="No stores indexed yet" />
        )}
      </div>
    </section>
  );
}
