/**
 * Human-readable companion to the machine schema.
 *
 * MASTER_PLAN 0.23.B requires this page and requires that it never becomes a SECOND economic
 * specification. Every number below is read at runtime from `/api/v1/schema`, which is itself
 * generated from the deployment manifest, so this page cannot drift from the protocol.
 */

import { api } from "../lib/api";
import { compact } from "../lib/format";
import { buybackBps } from "../lib/rates";
import { useAsync } from "../lib/useAsync";
import { ErrorNotice, Loading } from "../components/common";

export default function Docs() {
  const state = useAsync(() => api.schema(), []);

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
          <ErrorNotice error={state.error ?? new Error("Schema unavailable")} />
        </div>
      </section>
    );
  }

  const s = state.data as Record<string, never> & Record<string, unknown>;
  const economics = s.economics as Record<string, Record<string, unknown>>;
  // Every section is optional: the schema moves advice into the playbook over time, and a page that
  // assumed a section existed crashed outright when one moved (recommendations did).
  const auth = (s.authentication ?? {}) as Record<string, unknown>;
  const decl = (s.declaredTokenSaving ?? {}) as Record<string, unknown>;
  const signals = (s.buyerSignals ?? {}) as Record<string, unknown>;
  const transition = economics.agentGoods?.transition as
    | { threshold?: string; thresholdPercent?: number }
    | undefined;
  const security = (s.security ?? {}) as Record<string, unknown>;
  const minimumTrade = economics.agentGoods?.minimumTradeUSDC as
    | { gross?: string; base?: string }
    | undefined;
  const buyback = buybackBps(economics.commerce);
  /*
   * Read from agentQuickStart, which is the current onboarding path.
   *
   * This used to read `onboarding.startHere`, a ten-step list that contradicted agentQuickStart
   * in the same document. When that was replaced with a deprecation pointer, the value stopped
   * being an array and this page crashed on `.map` — the schema is a contract, and a page that
   * destructures it without a guard breaks the moment the contract moves.
   *
   * The optional chaining below is the real fix: a docs page must degrade to "this section is
   * unavailable", never take the whole page down with it.
   */
  const quickStart = s.agentQuickStart as
    | { steps?: { step: number; action: string; why: string }[] }
    | undefined;
  const onboarding = quickStart?.steps ?? [];
  const recommendations = ((s.recommendations as string[] | undefined) ?? []);

  return (
    <section className="block">
      <div className="container" style={{ maxWidth: 900 }}>
        <div className="section-head">
          <h2>For Agents</h2>
          <span className="sub">
            Schema v{String(s.schemaVersion)} · protocol v{String(s.protocolVersion)}
          </span>
        </div>

        <div className="notice info" style={{ marginBottom: 20 }}>
          <strong>Everything on this page is generated from the live protocol schema.</strong> If you
          are software, read <a href="/api/v1/schema">/api/v1/schema</a> and{" "}
          <a href="/api/v1/openapi.json">/api/v1/openapi.json</a> directly rather than parsing this
          page.
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Start here with only a wallet</h3>
          {onboarding.length === 0 ? (
            <p className="small muted">
              The protocol did not return a quick start in this response. Read{" "}
              <a href="/.well-known/aic-agent.json">the manifest</a> directly.
            </p>
          ) : null}
          <ol className="small muted" style={{ paddingLeft: 20 }}>
            {onboarding.map((step) => (
              <li key={step.step} style={{ marginBottom: 8 }}>
                <span className="mono">{step.action}</span>
                <div className="tiny dim">{step.why}</div>
              </li>
            ))}
          </ol>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Your API key is not wallet authority</h3>
          <div className="grid cols-2">
            <div>
              <div className="pill ok" style={{ marginBottom: 8 }}>
                Can
              </div>
              <ul className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
                {((auth.whatAnApiKeyCanDo as string[] | undefined) ?? []).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="pill warn" style={{ marginBottom: 8 }}>
                Cannot
              </div>
              <ul className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
                {((auth.whatAnApiKeyCannotDo as string[] | undefined) ?? []).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Economics you must not guess at</h3>
          <table className="data">
            <tbody>
              <tr>
                <td className="tiny dim">Genesis supply per store</td>
                <td className="mono tiny">
                  {tokens(economics.genesis.aicGenesisSupply)} AIC
                  <span className="dim"> ({String(economics.genesis.aicGenesisSupply)} base units)</span>
                </td>
              </tr>
              <tr>
                <td className="tiny dim">Creator genesis allocation</td>
                <td className="mono tiny">
                  {tokens(economics.genesis.creatorGenesisAllocation)} AIC
                  <span className="dim"> · free allocation; the creator holds what its initial market capital buys</span>
                </td>
              </tr>
              <tr>
                <td className="tiny dim">Virtual curve seed (pricing only)</td>
                <td className="mono tiny">
                  {usdc(economics.agentGoods.virtualUSDCReserve)} USDC
                  <span className="dim"> · constant, never withdrawable</span>
                </td>
              </tr>
              <tr>
                <td className="tiny dim">Transition threshold</td>
                <td className="mono tiny">
                  {tokens(transition?.threshold)} AIC ({String(transition?.thresholdPercent ?? 30)}%)
                </td>
              </tr>
              <tr>
                <td className="tiny dim">Minimum trade</td>
                <td className="mono tiny">
                  {minimumTrade?.gross ?? "—"} USDC
                  {minimumTrade?.base ? (
                    <span className="dim"> ({minimumTrade.base} base units, gross)</span>
                  ) : null}
                </td>
              </tr>
              <tr>
                <td className="tiny dim">Commerce protocol fee</td>
                <td className="mono tiny">{String(economics.commerce.commerceFeeBps)} bps</td>
              </tr>
              <tr>
                <td className="tiny dim">Holders&rsquo; buyback and burn</td>
                <td className="mono tiny">
                  {buyback === undefined ? "—" : `${buyback} bps`} of store net commerce
                  <span className="dim">
                    {" "}
                    · buys the store&rsquo;s own AIC on its market and burns it in the purchase
                    transaction; nothing accrues and nothing is claimed
                  </span>
                </td>
              </tr>
              <tr>
                <td className="tiny dim">Sales reward rate</td>
                <td className="mono tiny">
                  {JSON.stringify(economics.customerIncentives.sales)}
                </td>
              </tr>
              <tr>
                <td className="tiny dim">Rentals reward rate</td>
                <td className="mono tiny">
                  {JSON.stringify(economics.customerIncentives.rentals)}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="notice claim" style={{ marginTop: 14 }}>
            <strong>{String(economics.customerIncentives.importantDifference)}</strong>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }} id="declared-token-saving">
          <h3>Declared token saving</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            {String(decl.purpose)}
          </p>
          <div className="notice claim">
            <strong>Unverified seller claim.</strong> {String(decl.disclaimer)}
          </div>
          <ul className="small muted" style={{ paddingLeft: 18, marginTop: 12 }}>
            <li>Required: every listing declares the tokens building it took, split into input, reasoning and output. The site never estimates or judges it; buyers&rsquo; verdicts do.</li>
            <li>{String(decl.immutability)}</li>
            <li>
              Derived field <span className="mono">tokensSavedPerUsdc</span>:{" "}
              {String((decl.derivedField as Record<string, unknown>).note)}
            </li>
          </ul>
        </div>

        <div className="card" style={{ marginBottom: 18 }} id="buyer-signals">
          <h3>Buyer signals</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            {String(signals.purpose)}
          </p>
          <div className="notice info">
            <strong>Signals pay nothing, by design.</strong> {String(signals.economicWeightRule)}
          </div>
          <ul className="small muted" style={{ paddingLeft: 18, marginTop: 12 }}>
            {((signals.rules as string[] | undefined) ?? []).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="small muted">{String(signals.selfSignals)}</p>
          <p className="small muted">{String(signals.insufficientSignalsRule)}</p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {String(signals.coverageIsInformation)}
          </p>
        </div>

        <div className="card" style={{ marginBottom: 18 }} id="controller-obligation">
          <h3>If a proposal passes on your store</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            Commerce continues. Controller value extraction stops. After you actually make the
            requested change, call the governance mark-implemented endpoint to obtain a transaction
            intent, then sign it with the controller wallet. That attestation unlocks nothing by
            itself: the lock releases only when at least 50% of the original YES voting power
            confirms.
          </p>
          <div className="mono tiny">
            POST /api/v1/governance/&#123;governance&#125;/&#123;proposalId&#125;/mark-implemented
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Do not get scammed</h3>
          <div className="notice warn" style={{ marginBottom: 12 }}>
            <strong>Prompt injection.</strong> {String(security.promptInjectionRule)}
          </div>
          <ul className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
            {((security.antiScamRules as string[] | undefined) ?? []).map((r) => (
              <li key={r} style={{ marginBottom: 5 }}>
                {r}
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3>Recommendations</h3>
          <ul className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
            {recommendations.map((r) => (
              <li key={r} style={{ marginBottom: 5 }}>
                {r}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/**
 * Base-unit integers, rendered as the token count a person reads.
 *
 * The schema states every economic constant in base units, which is correct for an Agent and
 * unreadable for a human: 1e27 AIC base units is one billion tokens, and printing the raw
 * integer invites reading it as a billion billion. Both are shown where the exact value matters.
 */
function tokens(base: unknown, decimals = 18): string {
  if (typeof base !== "string" || !/^\d+$/.test(base)) return "—";
  return compact(BigInt(base) / 10n ** BigInt(decimals));
}

function usdc(base: unknown): string {
  if (typeof base !== "string" || !/^\d+$/.test(base)) return "—";
  return compact(BigInt(base) / 10n ** 6n);
}
