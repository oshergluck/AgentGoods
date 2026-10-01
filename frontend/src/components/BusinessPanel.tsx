import { api, type Amount } from "../lib/api";
import { useAsync } from "../lib/useAsync";

/**
 * The business behind a token: what it sells and how its services are used.
 *
 * Read from GET /api/v1/stocks/{aicToken}/fundamentals (businessModel) — call records and settled
 * commerce, never a rating. Calls and purchases by whoever controlled the store at the time are
 * excluded from customers and shown apart.
 */
export function BusinessPanel({ aicToken }: { aicToken: string }) {
  const state = useAsync(() => api.stockFundamentals(aicToken).then((d) => ({ ...d, forToken: aicToken })), [aicToken], {
    refreshMs: 15000,
  });
  const data = state.data?.forToken === aicToken ? state.data : undefined;
  const b = data?.businessModel;
  if (!b) return null;
  const s = b.services;
  const count = (n: number | undefined) => (typeof n === "number" ? n.toLocaleString("en-US") : "0");
  const facts: [string, string, string?][] = [
    ["Sales listings", count(b.sales)],
    ["Rental listings", count(b.rentals)],
    ["Services", count(b.servicesListed), `${count(b.activeServices)} active`],
  ];
  const serviceFacts: [string, string, string?][] = s
    ? [
        ["Service calls", count(s.callsTotal), `${count(s.calls24h)} in 24h`],
        ["Successful calls", count(s.successfulCalls), s.successRate === null ? undefined : `${Math.round(s.successRate * 100)}% success`],
        ["Customers", count(s.uniqueCustomers), `${count(s.uniqueCustomers30d)} in 30d`],
        ["Repeat customers", count(s.repeatCustomers), s.repeatCustomerRate === null ? undefined : `${Math.round(s.repeatCustomerRate * 100)}% of customers`],
        ["Service commerce", `${s.grossCommerceUSDC.display} USDC`, `${s.commerce24h.display} in 24h`],
        ["Median latency", s.medianLatencyMs === null ? "—" : `${s.medianLatencyMs} ms`, s.p95LatencyMs === null ? undefined : `p95 ${s.p95LatencyMs} ms`],
        ["Buyback from services", `${s.buybackUSDC.display} USDC`, `${s.burnedAIC.display} AIC burned`],
      ]
    : [];
  return (
    <div className="card business-panel">
      <div className="business-head">
        <h3 style={{ margin: 0 }}>The business</h3>
        <span className="tiny dim">what it sells and how it is used · facts, not a rating</span>
      </div>
      <div className="service-facts">
        {[...facts, ...serviceFacts].map(([k, v, hint]) => (
          <div key={k} className="service-fact">
            <span className="tiny dim">{k}</span>
            <strong className="tabular">{v}</strong>
            {hint ? <span className="tiny dim">{hint}</span> : null}
          </div>
        ))}
      </div>
      {s && s.selfCalls > 0 ? (
        <p className="tiny dim" style={{ margin: 0 }}>
          {s.selfCalls} call{s.selfCalls === 1 ? "" : "s"} and {s.selfCommerceUSDC.display} USDC of purchases by the store&rsquo;s own
          controller are excluded from customers and commerce above.
        </p>
      ) : null}
      {!s ? <p className="tiny dim" style={{ margin: 0 }}>This business sells no callable service.</p> : null}
    </div>
  );
}

export interface BusinessModelView {
  sales?: number;
  rentals?: number;
  servicesListed?: number;
  activeServices?: number;
  lifetimeBuybackBurnedAIC?: string;
  services: null | {
    callsTotal: number;
    calls24h: number;
    successfulCalls: number;
    successRate: number | null;
    uniqueCustomers: number;
    uniqueCustomers30d: number;
    repeatCustomers: number;
    repeatCustomerRate: number | null;
    grossCommerceUSDC: Amount;
    commerce24h: Amount;
    medianLatencyMs: number | null;
    p95LatencyMs: number | null;
    buybackUSDC: Amount;
    burnedAIC: Amount;
    selfCalls: number;
    selfCommerceUSDC: Amount;
  };
}
