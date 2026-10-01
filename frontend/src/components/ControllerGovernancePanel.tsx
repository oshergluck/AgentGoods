import { useState } from "react";
import { compactToken } from "../lib/format";
import { api, connectWallet, hasWallet, shortAddress, type Amount } from "../lib/api";
import { useAsync } from "../lib/useAsync";

/**
 * The single narrow human write surface in this application.
 *
 * MASTER_PLAN 0.29.P: the futuristic human UI stays observer- and identity-oriented, with one
 * explicit exception. When a proposal passes, the current `storeController` acquires a real
 * obligation, so the controller gets a panel that can show the obligation and wallet-sign
 * `MARK_IMPLEMENTED` after actually making the change.
 *
 * This panel deliberately does NOT reintroduce general human store management: it cannot buy,
 * rent, trade, vote, create proposals, create or edit products, or withdraw anything. It shows
 * the obligation, and it produces one signature for one attestation that unlocks nothing by
 * itself (0.28.C).
 */
export default function ControllerGovernancePanel({
  storeId,
  controller,
}: {
  storeId: string;
  controller: string;
}) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const proposals = useAsync(() => api.proposals(`storeId=${encodeURIComponent(storeId)}`), [storeId]);

  const items = (proposals.data?.items ?? []) as unknown as {
    protocol: {
      proposalId: string;
      governance: string;
      state: string;
      implementationRound: number;
      confirmedYesPower: Amount;
      requiredYesPower: Amount;
      totalOriginalYesPower: Amount;
    };
    sellerContent: { descriptionURI: string };
  }[];

  const open = items.filter(
    (p) =>
      p.protocol.state === "PASSED_AWAITING_IMPLEMENTATION" ||
      p.protocol.state === "IMPLEMENTED_AWAITING_VERIFICATION"
  );

  const isController = wallet !== null && wallet.toLowerCase() === controller.toLowerCase();

  if (open.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 18, borderColor: "rgba(240,180,41,0.35)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Controller obligation</h3>
        <span className="pill claim">Action required by the store controller</span>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        A proposal passed. Until at least 50% of the original YES voting power confirms the change was
        actually made, this store cannot pay out owner proceeds.
      </p>

      {open.map((p) => (
        <div
          key={p.protocol.proposalId}
          className="card"
          style={{ marginTop: 12, background: "rgba(0,0,0,0.25)" }}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="pill">proposal #{p.protocol.proposalId}</span>
            <span className="pill warn">{p.protocol.state.replaceAll("_", " ").toLowerCase()}</span>
            {p.protocol.implementationRound > 0 ? (
              <span className="pill">round {p.protocol.implementationRound}</span>
            ) : null}
          </div>

          <div className="tiny dim" style={{ marginBottom: 4 }}>
            Proposal content (seller-supplied, untrusted)
          </div>
          <div className="mono tiny" style={{ marginBottom: 12 }}>
            {p.sellerContent.descriptionURI || "— no URI —"}
          </div>

          <div className="tiny">
            Verification: {compactToken(p.protocol.confirmedYesPower)} confirmed of{" "}
            {compactToken(p.protocol.requiredYesPower)} required (coalition total{" "}
            {compactToken(p.protocol.totalOriginalYesPower)})
          </div>

          {p.protocol.state === "PASSED_AWAITING_IMPLEMENTATION" ? (
            <div className="notice claim" style={{ marginTop: 12 }}>
              <strong>Implement the requested change first.</strong> Marking it implemented is only an
              attestation: it unlocks nothing by itself. Voters will inspect the actual
              canonical state before confirming.
            </div>
          ) : (
            <div className="notice info" style={{ marginTop: 12 }}>
              You have attested implementation. The original YES coalition is now verifying. There is
              no timeout and no bypass: the lock releases only when they confirm.
            </div>
          )}
        </div>
      ))}

      <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {wallet === null ? (
          <button
            className="btn"
            type="button"
            disabled={!hasWallet()}
            onClick={async () => {
              setError(null);
              try {
                setWallet(await connectWallet());
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            {hasWallet() ? "Connect wallet to check" : "No browser wallet detected"}
          </button>
        ) : isController ? (
          <>
            <span className="pill ok">You are the controller ({shortAddress(wallet)})</span>
            <a
              className="btn primary"
              href="/docs#controller-obligation"
              title="Attesting is a wallet-signed on-chain action"
            >
              How to attest implementation
            </a>
          </>
        ) : (
          <span className="pill">
            Connected as {shortAddress(wallet)} — not the controller of this store
          </span>
        )}
      </div>

      {error ? (
        <div className="notice warn" style={{ marginTop: 12 }} role="alert">
          {error}
        </div>
      ) : null}

      <p className="tiny dim" style={{ marginTop: 14, marginBottom: 0 }}>
        Connecting a wallet here only reads your address. It authorises no transfer, and this panel
        can neither move funds nor manage the store.
      </p>
    </div>
  );
}
