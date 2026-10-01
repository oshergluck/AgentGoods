import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { AddressLine, ErrorNotice, Loading, Stat } from "../components/common";

/**
 * System and contract transparency.
 *
 * MASTER_PLAN 0.24.N: Cloudflare and Railway must not be able to hide a degraded application
 * behind a green edge check, so the real indexer lag and the real canonical catalog are
 * exposed to humans, not only to Agents.
 */
export default function Status() {
  const status = useAsync(() => api.status(), [], { refreshMs: 3000 });
  const contracts = useAsync(() => api.contracts(), []);

  if (status.loading) {
    return (
      <section className="block">
        <div className="container">
          <Loading rows={3} />
        </div>
      </section>
    );
  }
  if (status.error) {
    return (
      <section className="block">
        <div className="container">
          <ErrorNotice error={status.error} />
        </div>
      </section>
    );
  }

  const s = status.data as Record<string, never> & Record<string, unknown>;
  const indexer = (s.indexer ?? {}) as Record<string, number | string | boolean>;
  const counts = (s.counts ?? {}) as Record<string, number>;
  const core = ((contracts.data ?? {}) as Record<string, unknown>).core as
    | Record<string, Record<string, string>>
    | undefined;
  const antiScam = ((contracts.data ?? {}) as Record<string, unknown>).antiScamRules as string[] | undefined;

  return (
    <section className="block">
      <div className="container">
        <div className="section-head">
          <h2>System status</h2>
          <span className="sub">
            {String(s.environment)} · chain {String(s.chainId)} · protocol v{String(s.protocolVersion)}
          </span>
        </div>

        {String(s.environment) !== "PRODUCTION" ? (
          <div className="notice claim" style={{ marginBottom: 18 }}>
            <strong>This is a {String(s.environment)} deployment, not final production.</strong> Balances
            and activity here are not production value. Agents can detect this from the
            <code> provenance </code> block of the schema.
          </div>
        ) : null}

        <div className="grid cols-4" style={{ marginBottom: 18 }}>
          <Stat
            label="Indexer"
            value={String(indexer.indexerStatus)}
            hint={indexer.stale ? "Stale — high-risk writes are refused" : "Fresh"}
            accent={!indexer.stale}
          />
          <Stat label="Indexed block" value={<span className="tabular">{String(indexer.indexedBlock)}</span>} />
          <Stat label="Chain head" value={<span className="tabular">{String(indexer.chainHead)}</span>} />
          <Stat
            label="Lag"
            value={<span className="tabular">{String(indexer.lagBlocks)}</span>}
            hint="blocks behind"
          />
        </div>

        <div className="grid cols-4" style={{ marginBottom: 18 }}>
          <Stat label="Stores" value={counts.stores ?? 0} />
          <Stat label="Products" value={counts.products ?? 0} />
          <Stat label="Licenses" value={counts.licenses ?? 0} />
          <Stat label="Chain events indexed" value={counts.chainEvents ?? 0} />
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Canonical contracts</h3>
          <p className="tiny dim" style={{ marginTop: 0 }}>
            Always transact with the proxy address for Registry and AgentGoods. An implementation
            address is never a valid target.
          </p>
          {core ? (
            <>
              <AddressLine label="Registry (proxy)" address={core.registry?.proxy ?? "—"} />
              <AddressLine label="Registry impl" address={core.registry?.implementation ?? "—"} />
              <AddressLine label="AgentGoods (proxy)" address={core.agentGoods?.proxy ?? "—"} />
              <AddressLine label="AgentGoods impl" address={core.agentGoods?.implementation ?? "—"} />
              <AddressLine label="Protocol treasury" address={core.protocolTreasury?.address ?? "—"} />
              <AddressLine label="Canonical USDC" address={core.canonicalUSDC?.address ?? "—"} />
            </>
          ) : (
            <Loading rows={1} />
          )}
        </div>

        {antiScam ? (
          <div className="card">
            <h3>How to avoid a lookalike contract</h3>
            <ul className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
              {antiScam.map((rule) => (
                <li key={rule} style={{ marginBottom: 6 }}>
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
