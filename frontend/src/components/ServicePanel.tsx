import { useState } from "react";
import { api, type ServiceDescriptor } from "../lib/api";
import { useAsync } from "../lib/useAsync";

/**
 * A callable service, for humans to read: what it takes, what it returns, what a call costs, and how it
 * is used — facts from the gateway's call records and the chain's settled commerce, never a rating.
 * Calling it is an agent operation (API key + USDC); this panel only shows how.
 */
export function ServicePanel({ storeId, productId }: { storeId: string; productId: string }) {
  const state = useAsync(() => api.service(storeId, productId), [storeId, productId], { refreshMs: 15000 });
  const [showSchemas, setShowSchemas] = useState(false);
  const s = state.data as ServiceDescriptor | undefined;
  if (state.loading && !s) return <div className="card"><p className="dim">Loading the service…</p></div>;
  if (!s) return null;
  const m = typeof s.metrics === "object" ? s.metrics : null;
  const facts: [string, string][] = m
    ? [
        ["Calls (30d)", String(m.calls30d)],
        ["Successful calls", String(m.successfulCalls)],
        ["Success rate", m.successRate === null ? "—" : `${Math.round(m.successRate * 100)}%`],
        ["Customers", String(m.uniqueCustomers)],
        ["Repeat customers", String(m.repeatCustomers)],
        ["Commerce", `${m.grossCommerceUSDC.display} USDC`],
        ["Median latency", m.medianLatencyMs === null ? "—" : `${m.medianLatencyMs} ms`],
        ["AIC burned", m.burnedAIC.display],
      ]
    : [];
  return (
    <div className="card service-panel">
      <div className="service-head">
        <span className="pill service">SERVICE</span>
        <h3 style={{ margin: 0 }}>Called per use</h3>
        <span className="service-price tabular">
          {s.pricePerCallUSDC.display} <span className="dim small">USDC / call</span>
        </span>
        {!s.active ? <span className="pill">inactive</span> : null}
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        Buyers send input and get a result; the code runs on AgentGoods&rsquo; isolated runner and is never
        delivered. Calls are prepaid on chain and a call is charged only when it succeeds.
      </p>

      {facts.length ? (
        <div className="service-facts">
          {facts.map(([k, v]) => (
            <div key={k} className="service-fact">
              <span className="tiny dim">{k}</span>
              <strong className="tabular">{v}</strong>
            </div>
          ))}
        </div>
      ) : null}
      {m && m.selfCalls > 0 ? (
        <p className="tiny dim">
          {m.selfCalls} call{m.selfCalls === 1 ? "" : "s"} by the store&rsquo;s own controller, not counted as customers.
        </p>
      ) : null}

      <button type="button" className="read-all" onClick={() => setShowSchemas((v) => !v)} aria-expanded={showSchemas}>
        {showSchemas ? "Hide input and output schemas" : "Show input and output schemas"}
      </button>
      {showSchemas ? (
        <div className="service-schemas">
          <div>
            <div className="tiny dim">Input</div>
            <pre className="mono small">{JSON.stringify(s.inputSchema, null, 2)}</pre>
          </div>
          <div>
            <div className="tiny dim">Output</div>
            <pre className="mono small">{JSON.stringify(s.outputSchema, null, 2)}</pre>
          </div>
        </div>
      ) : null}

      <div className="service-howto tiny">
        <div className="dim">How an agent calls it</div>
        <code className="mono">
          POST {s.invoke.url.replace(/^https?:\/\/[^/]+/, "")} {"{input}"} · API key + Idempotency-Key
        </code>
        <div className="dim">MCP tool: <code className="mono">{s.mcp.tool}</code> at /mcp</div>
      </div>
    </div>
  );
}
