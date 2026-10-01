/*
 * The development behind a product: how many build-test-fix iterations its seller declared, and one
 * explanation per iteration. A buyer cannot run a product before paying; this is the work it can see.
 * Seller-written and unverified, like every seller claim — but each log is checked against the hash
 * committed on chain in that version's listing, and the page says whether it matches.
 */
import { useState } from "react";
import { api, type Development, type IterationUpload } from "../lib/api";
import { useAsync } from "../lib/useAsync";

/** How much work a count reads as, for the meter and its label. Presentation only, not a rating. */
function depth(total: number): { label: string; fill: number } {
  if (total <= 1) return { label: "first draft", fill: 0.08 };
  if (total < 5) return { label: "early", fill: 0.25 };
  if (total < 12) return { label: "worked on", fill: 0.5 };
  if (total < 30) return { label: "iterated", fill: 0.75 };
  return { label: "deeply iterated", fill: 1 };
}

export function IterationsPill({ development }: { development?: Development }) {
  const total = development?.iterationsTotal ?? null;
  if (!total) {
    return (
      <span className="pill" title="Listed before iterations were required: no development record.">
        no iteration record
      </span>
    );
  }
  return (
    <span
      className="pill iter"
      title={`${total} build-test-fix iteration(s) declared by the seller across ${development?.version ?? 1} version(s), each explained. Unverified seller claim.`}
    >
      <span className="glyph" aria-hidden>
        ⟳
      </span>
      {total} iteration{total === 1 ? "" : "s"}
    </span>
  );
}

/** The card-sized version: the count, a meter of the work, and the version it reached. */
export function IterationsBlock({ development }: { development?: Development }) {
  const total = development?.iterationsTotal ?? null;
  if (!total) {
    return (
      <div className="iter-block empty" title="Listed before iterations were required.">
        <span className="tiny dim">No development record</span>
      </div>
    );
  }
  const d = depth(total);
  return (
    <div
      className="iter-block"
      title={`${total} build-test-fix iteration(s) declared by the seller, each explained. Open the product to read them.`}
    >
      <div className="iter-block-row">
        <span className="iter-block-num tabular">
          <span aria-hidden>⟳</span> {total}
        </span>
        <span className="iter-block-label">
          iteration{total === 1 ? "" : "s"} · {d.label}
        </span>
      </div>
      <div className="iter-meter small" aria-hidden>
        <span style={{ width: `${Math.round(d.fill * 100)}%` }} />
      </div>
    </div>
  );
}

const VISIBLE = 6;

function UploadLog({ upload, open }: { upload: IterationUpload; open: boolean }) {
  const [all, setAll] = useState(false);
  const entries = all ? upload.entries : upload.entries.slice(0, VISIBLE);
  const hidden = upload.entries.length - entries.length;
  return (
    <details className="iter-upload" open={open}>
      <summary>
        <span className="iter-version">v{upload.version}</span>
        <span className="iter-count">
          {upload.iterations ?? upload.entries.length} iteration{(upload.iterations ?? 0) === 1 ? "" : "s"}
        </span>
        {upload.iterationsTotalAfter ? <span className="tiny dim">· {upload.iterationsTotalAfter} in total after this upload</span> : null}
        <span className={`pill ${upload.matchesOnChainHash ? "ok" : "warn"} iter-hash`} title={upload.iterationLogHash}>
          {upload.matchesOnChainHash ? "✓ matches on-chain hash" : "log does not match its hash"}
        </span>
      </summary>
      {upload.entries.length ? (
        <ol className="iter-timeline">
          {entries.map((e) => (
            <li key={e.iteration}>
              <span className="iter-dot" aria-hidden>
                {e.iteration}
              </span>
              <p>{e.explanation}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="tiny dim">The explanations for this upload are not available.</p>
      )}
      {hidden > 0 ? (
        <button type="button" className="btn ghost iter-more" onClick={() => setAll(true)}>
          Show all {upload.entries.length} explanations
        </button>
      ) : null}
    </details>
  );
}

export function DevelopmentPanel({
  development,
  storeId,
  productId,
}: {
  development?: Development;
  storeId: string;
  productId: string;
}) {
  const log = useAsync(() => api.productIterations(storeId, productId), [storeId, productId]);
  const total = development?.iterationsTotal ?? log.data?.iterationsTotal ?? null;
  const d = depth(total ?? 0);
  const uploads = [...(log.data?.uploads ?? [])].reverse(); // newest upload first

  return (
    <div className="card iter-panel">
      <div className="iter-head">
        <div>
          <h3 style={{ marginBottom: 4 }}>Development behind this product</h3>
          <p className="tiny dim" style={{ margin: 0 }}>
            Build-test-fix iterations declared at every upload, each with the seller&rsquo;s explanation — the work,
            not the code.
          </p>
        </div>
        {total ? (
          <div className="iter-figure">
            <span className="iter-number tabular">{total}</span>
            <span className="tiny dim">iterations · {d.label}</span>
          </div>
        ) : null}
      </div>

      {total ? (
        <>
          <div className="iter-meter" aria-hidden>
            <span style={{ width: `${Math.round(d.fill * 100)}%` }} />
          </div>
          <div className="iter-facts tiny dim">
            <span>
              Behind the current version: <strong>{development?.iterations ?? "—"}</strong>
            </span>
            <span>
              Versions published: <strong>{development?.version ?? "—"}</strong>
            </span>
            <span>
              Uploads with a log: <strong>{log.data ? log.data.uploads.length : "…"}</strong>
            </span>
          </div>

          {log.loading ? <p className="tiny dim">Loading the iteration log…</p> : null}
          {log.error ? <p className="tiny dim">The iteration log could not be loaded.</p> : null}
          {uploads.map((u, i) => (
            <UploadLog key={u.iterationLogHash} upload={u} open={i === 0} />
          ))}

          <div className="notice claim" style={{ marginTop: 14 }}>
            <strong>Seller-written, not verified.</strong> The protocol checks that each log is the one committed on
            chain, not that the work happened. Specific, distinct steps read as real work; weigh them against the
            demonstrations and buyers&rsquo; signals.
          </div>
        </>
      ) : (
        <p className="muted small" style={{ margin: "10px 0 0" }}>
          This product was listed before iterations were required, so it carries no development record.
        </p>
      )}
    </div>
  );
}
