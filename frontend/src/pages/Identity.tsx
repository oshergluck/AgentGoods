import { useCallback, useState } from "react";
import { api, connectWallet, hasWallet, signMessage, walletChainId, ApiError } from "../lib/api";

type KeyStatus = Awaited<ReturnType<typeof api.keyStatus>>;

/**
 * Wallet identity and API-key management.
 *
 * This is the most security-sensitive surface in the whole application, so it is deliberately
 * the least decorated one. MASTER_PLAN 0.26.A, 0.27.L and 0.27.M:
 *
 *  - the raw key is shown exactly once, in plain static DOM, with no animation hook;
 *  - it is held only in component state and is never written to localStorage, sessionStorage,
 *    a cookie, the URL, the document title, or any telemetry;
 *  - there is no third-party script anywhere in this app, so no analytics or session-replay
 *    tool can observe this region even in principle;
 *  - the copy button uses the clipboard API directly and reports success as text, never as a
 *    motion effect that could imply an action completed when it did not;
 *  - every security fact is stated in words, not only implied by an icon.
 */
export default function Identity() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /* Which step a key action is on, so a wait is never a mystery. */
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async (address: string) => {
    setStatus(await api.keyStatus(address));
  }, []);

  const connect = async () => {
    setError(null);
    try {
      const address = await connectWallet();
      setWallet(address);
      setChainId(await walletChainId());
      await refresh(address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async (purpose: "ISSUE_API_KEY" | "ROTATE_API_KEY" | "REVOKE_API_KEY") => {
    if (!wallet) return;
    setError(null);
    setBusy(purpose);
    setRevealed(null);
    setCopied(false);
    try {
      setStep("Requesting a challenge from the site…");
      const challenge = await api.challenge(wallet, purpose);
      setStep("Waiting for your wallet — approve the signature request in its window (it may be behind this one).");
      const signature = await signMessage(wallet, challenge.message);
      setStep("Signature received — issuing…");

      if (purpose === "ISSUE_API_KEY") {
        const issued = await api.issueKey(challenge.nonce, signature);
        setRevealed(issued.apiKey);
      } else if (purpose === "ROTATE_API_KEY") {
        const issued = await api.rotateKey(challenge.nonce, signature);
        setRevealed(issued.apiKey);
      } else {
        await api.revokeKey(challenge.nonce, signature);
      }
      await refresh(wallet);
    } catch (e) {
      if (e instanceof ApiError && e.code === "ACTIVE_KEY_EXISTS") {
        setError(
          "This wallet already has an active key. Issuing never silently replaces one — use Rotate, " +
            "which requires its own separate signature."
        );
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(null);
      setStep(null);
    }
  };

  /*
   * Copy with a fallback. navigator.clipboard is refused on some pages and browsers (no focus, no
   * permission, an extension in the way); the old execCommand path still works there, and if both
   * fail the key is left selected so Ctrl+C copies it.
   */
  const copyKey = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      return;
    } catch {
      /* fall through */
    }
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(area);
    if (ok) {
      setCopied(true);
    } else {
      setCopied(false);
      const box = document.getElementById("api-key-value") as HTMLInputElement | null;
      box?.focus();
      box?.select();
      setError("Your browser blocked the clipboard. The key is selected above — press Ctrl+C (Cmd+C) to copy it.");
    }
  };

  return (
    <section className="block">
      <div className="container" style={{ maxWidth: 840 }}>
        <div className="section-head">
          <h2>Wallet &amp; API key</h2>
          <span className="sub">One active key per wallet</span>
        </div>

        <div className="notice info" style={{ marginBottom: 18 }}>
          <strong>An API key is not your wallet.</strong> It authenticates API access only. It cannot
          sign a blockchain transaction, cannot move USDC or AIC, and cannot act for any wallet but
          yours. Never paste a private key or seed phrase into this site or any other.
        </div>

        {!hasWallet() ? (
          <div className="card" style={{ marginBottom: 18 }}>
            <h3>No browser wallet detected</h3>
            <p className="small muted">
              You need an EIP-1193 wallet extension to prove wallet ownership. If you are an Agent,
              you do not need this page at all: sign the challenge over plain HTTP instead.
            </p>
            <div className="mono tiny" style={{ marginTop: 10 }}>
              POST /api/v1/auth/challenge → sign → POST /api/v1/auth/api-key/issue
            </div>
          </div>
        ) : null}

        {wallet === null ? (
          <div className="card">
            <h3>Step 1 — Connect your wallet</h3>
            <p className="small muted">
              Connecting reads your address. Nothing is signed and nothing is authorised at this step.
            </p>
            <button className="btn primary" type="button" onClick={connect} disabled={!hasWallet()}>
              Connect wallet
            </button>
          </div>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <span className="pill ok">connected</span>
                <span className="mono">{wallet}</span>
                {chainId !== null ? <span className="pill">chain {chainId}</span> : null}
              </div>
            </div>

            <div className="card" style={{ marginBottom: 18 }}>
              <h3>Key status</h3>
              {status === null ? (
                <div className="skeleton" style={{ width: "40%" }} />
              ) : status.status === "ACTIVE" ? (
                <>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                    <span className="pill ok">active</span>
                    <span className="mono">{status.apiKeyPrefix}••••••••••••••••</span>
                  </div>
                  <div className="grid cols-3" style={{ marginBottom: 14 }}>
                    <div>
                      <div className="tiny dim">Issued</div>
                      <div className="small">
                        {status.issuedAt ? new Date(status.issuedAt).toLocaleString() : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="tiny dim">Last used</div>
                      <div className="small">
                        {status.lastUsedAt ? new Date(status.lastUsedAt).toLocaleString() : "never"}
                      </div>
                    </div>
                    <div>
                      <div className="tiny dim">Rotations</div>
                      <div className="small tabular">{status.rotationCount}</div>
                    </div>
                  </div>
                  <p className="tiny dim">
                    Only the prefix is ever shown again. The secret is stored as a hash and cannot be
                    recovered by anyone, including us.
                  </p>
                </>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  {status.status === "REVOKED"
                    ? "This wallet had a key and revoked it. Issue a new one below."
                    : "This wallet has no API key yet."}
                </p>
              )}
            </div>

            {revealed ? (
              /* Static, unanimated, untracked region. Shown exactly once. */
              <div className="key-reveal" style={{ marginBottom: 18 }}>
                <h3 style={{ marginTop: 0 }}>Your API key — shown once</h3>
                <p className="small" style={{ marginTop: 0 }}>
                  Copy it now and store it somewhere safe. It cannot be recovered. If you lose it,
                  sign a rotation challenge to get a new one.
                </p>
                <input
                  id="api-key-value"
                  className="key-value"
                  readOnly
                  value={revealed}
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.currentTarget.select()}
                  spellCheck={false}
                  style={{ width: "100%", boxSizing: "border-box", color: "inherit" }}
                />
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void copyKey(revealed)}
                  >
                    Copy key
                  </button>
                  <button className="btn ghost" type="button" onClick={() => setRevealed(null)}>
                    I have stored it — hide
                  </button>
                  {copied ? <span className="pill ok">Copied to clipboard</span> : null}
                </div>
                <p className="tiny dim" style={{ marginBottom: 0, marginTop: 14 }}>
                  This value has not been written to browser storage, a cookie, the URL or any
                  analytics tool. It exists only in this page until you leave or hide it.
                </p>
              </div>
            ) : null}

            <div className="card">
              <h3>Actions</h3>
              <p className="small muted" style={{ marginTop: 0 }}>
                Each action requires its own signature with its own purpose. A signature made for one
                purpose can never be replayed for another.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy !== null || status?.status === "ACTIVE"}
                  onClick={() => run("ISSUE_API_KEY")}
                >
                  {busy === "ISSUE_API_KEY" ? "Waiting for signature…" : "Issue key"}
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy !== null || status?.status !== "ACTIVE"}
                  onClick={() => run("ROTATE_API_KEY")}
                >
                  {busy === "ROTATE_API_KEY" ? "Waiting for signature…" : "Rotate key"}
                </button>
                <button
                  className="btn danger"
                  type="button"
                  disabled={busy !== null || status?.status !== "ACTIVE"}
                  onClick={() => run("REVOKE_API_KEY")}
                >
                  {busy === "REVOKE_API_KEY" ? "Waiting for signature…" : "Revoke key"}
                </button>
              </div>

              <div className="notice info" style={{ marginTop: 16 }}>
                <strong>Rotation is immediate.</strong> The moment a new key exists, the previous one
                stops working. Update your Agent before rotating.
              </div>
            </div>
          </>
        )}

        {step ? (
          <div className="notice" style={{ marginTop: 18 }} role="status">
            {step}
          </div>
        ) : null}
        {error ? (
          <div className="notice warn" style={{ marginTop: 18 }} role="alert">
            <strong>Something went wrong.</strong> {error}
          </div>
        ) : null}

        <div className="card" style={{ marginTop: 18 }}>
          <h3>What your key can and cannot do</h3>
          <div className="grid cols-2">
            <div>
              <div className="pill ok" style={{ marginBottom: 8 }}>
                Can
              </div>
              <ul className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
                <li>Read data scoped to your own wallet</li>
                <li>Request deterministic transaction intents</li>
                <li>Configure webhooks and off-chain preferences</li>
              </ul>
            </div>
            <div>
              <div className="pill warn" style={{ marginBottom: 8 }}>
                Cannot
              </div>
              <ul className="small muted" style={{ paddingLeft: 18, margin: 0 }}>
                <li>Sign an EVM transaction</li>
                <li>Move USDC or AIC</li>
                <li>Change a store controller or finalize a takeover</li>
                <li>Cast an on-chain vote or claim funds</li>
                <li>Read another wallet&rsquo;s private data</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
