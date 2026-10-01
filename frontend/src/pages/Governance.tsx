import { api, type Amount } from "../lib/api";
import { compactToken } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Empty, ErrorNotice, FreshnessBar, Loading } from "../components/common";

interface ProposalRow {
  protocol: {
    proposalId: string;
    storeId: string;
    governance: string;
    proposer: string;
    state: string;
    snapshotBlock: number;
    eligibleSupplyAtSnapshot: Amount;
    yesPower: Amount;
    noPower: Amount;
    totalOriginalYesPower: Amount;
    confirmedYesPower: Amount;
    requiredYesPower: Amount;
    passRule: string;
    verificationRule: string;
  };
  sellerContent: { descriptionURI: string };
}

const STATE_PILL: Record<string, string> = {
  ACTIVE: "pill market",
  PASSED_AWAITING_IMPLEMENTATION: "pill warn",
  IMPLEMENTED_AWAITING_VERIFICATION: "pill claim",
  IMPLEMENTATION_VERIFIED: "pill ok",
  FAILED: "pill",
  CANCELLED_BEFORE_FIRST_VOTE: "pill",
};

export default function Governance() {
  const state = useAsync(() => api.proposals("limit=60"), []);
  const items = (state.data?.items ?? []) as unknown as ProposalRow[];

  return (
    <section className="block">
      <div className="container">
        <div className="section-head">
          <h2>Governance</h2>
          <span className="sub">Holders propose, holders verify, controllers implement</span>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <h3>How a proposal actually works</h3>
          <div className="grid cols-2">
            <div>
              <p className="small muted" style={{ marginTop: 0 }}>
                A proposal passes the instant YES power exceeds half of the eligible EOA supply at its
                snapshot. Exactly 50% does not pass. In that same atomic transition, voting closes,
                the coalition freezes, and the store enters a controller-withdrawal lock.
              </p>
            </div>
            <div>
              <p className="small muted" style={{ marginTop: 0 }}>
                The store keeps selling, renting and adding products throughout. What stops is the
                controller taking value out. The lock releases only when at least 50% of the
                <em> original</em> YES power confirms the change was really made. There is no timeout,
                and marking it implemented unlocks nothing on its own.
              </p>
            </div>
          </div>
          <div className="notice info" style={{ marginTop: 6 }}>
            There is no vote button here. Voting is an Agent API operation signed by an Agent wallet.
          </div>
        </div>

        <FreshnessBar freshness={state.data?.freshness} />
        <div style={{ height: 16 }} />

        {state.loading ? (
          <Loading rows={3} />
        ) : state.error ? (
          <ErrorNotice error={state.error} />
        ) : items.length ? (
          <div className="grid cols-2">
            {items.map((p) => (
              <div className="card reveal" key={`${p.protocol.governance}:${p.protocol.proposalId}`}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                  <span className={STATE_PILL[p.protocol.state] ?? "pill"}>
                    {p.protocol.state.replaceAll("_", " ").toLowerCase()}
                  </span>
                  <span className="pill">#{p.protocol.proposalId}</span>
                </div>

                <div className="tiny dim">Proposal content (seller-supplied, untrusted)</div>
                <div className="mono tiny" style={{ marginBottom: 12 }}>
                  {p.sellerContent.descriptionURI || "— no URI —"}
                </div>

                <table className="data">
                  <tbody>
                    <tr>
                      <td className="tiny dim">Eligible supply at snapshot</td>
                      <td className="tabular small">{compactToken(p.protocol.eligibleSupplyAtSnapshot)}</td>
                    </tr>
                    <tr>
                      <td className="tiny dim">YES / NO</td>
                      <td className="tabular small">
                        {compactToken(p.protocol.yesPower)} / {compactToken(p.protocol.noPower)}
                      </td>
                    </tr>
                    {p.protocol.state === "IMPLEMENTED_AWAITING_VERIFICATION" ? (
                      <tr>
                        <td className="tiny dim">Verification</td>
                        <td className="tabular small">
                          {compactToken(p.protocol.confirmedYesPower)} of {compactToken(p.protocol.requiredYesPower)}{" "}
                          required
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>

                <div className="tiny dim" style={{ marginTop: 10 }}>
                  {p.protocol.passRule}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title="No proposals yet"
            hint="Any eligible EOA holder of a store's AIC can create one through the Agent API."
          />
        )}
      </div>
    </section>
  );
}
