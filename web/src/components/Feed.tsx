import { useState } from "react";
import type { JournalEntry } from "../types";
import { ACTION_LABEL, ago, clock, fmtPrice, fmtSol } from "../format";

function StatusChip({ e }: { e: JournalEntry }) {
  if (e.emergency) return <span className="chip override">guard override</span>;
  if (!e.allowed) return <span className="chip blocked">blocked by guards</span>;
  if (e.execution.txs.length) return <span className="chip exec">{e.execution.mode === "live" ? "executed" : "simulated"}</span>;
  return null;
}

function Item({ e, now, showPool }: { e: JournalEntry; now: number; showPool: boolean }) {
  const proposedDiffers = e.proposal.action !== e.decision.action || e.proposal.headline !== e.decision.headline;
  return (
    <article className="feed-item">
      <div className="feed-head">
        <time dateTime={e.ts} title={new Date(e.ts).toLocaleString()}>{clock(e.ts)}</time>
        <span>{ago(e.ts, now)}</span>
        {showPool && <span className="chip">{e.pool.label}</span>}
        <span className="chip action">{ACTION_LABEL[e.decision.action]}</span>
        <StatusChip e={e} />
        {e.llm.source === "fallback" && <span className="chip">no model</span>}
      </div>
      <p className="headline">“{e.headline}”</p>
      <p className="reason">{e.decision.reasoning}</p>
      {proposedDiffers && (
        <div className={`note ${e.emergency ? "crit" : ""}`}>
          <b>Proposed {ACTION_LABEL[e.proposal.action]}.</b> {e.proposal.reasoning}
        </div>
      )}
      {e.violations.length > 0 && (
        <div className="note">
          <b>Rejected:</b> {e.violations.join("; ")}
        </div>
      )}
      {e.overrides.length > 0 && (
        <div className="note crit">
          <b>Override:</b> {e.overrides.join("; ")}
        </div>
      )}
      {e.execution.txs.length > 0 && (
        <ul className="txs">
          {e.execution.txs.map((t, i) => (
            <li key={i}>
              <span className={t.ok ? "ok" : "fail"}>{t.ok ? "✓" : "✕"}</span> {t.label} ·{" "}
              {t.signature ? (
                <a href={`https://solscan.io/tx/${t.signature}`} target="_blank" rel="noreferrer">{t.signature.slice(0, 10)}…</a>
              ) : t.skipped ? (
                t.skipped
              ) : t.ok ? (
                `simulated ok${t.unitsConsumed ? `, ${Math.round(t.unitsConsumed / 1000)}k CU` : ""}`
              ) : (
                `failed: ${t.error}`
              )}
            </li>
          ))}
        </ul>
      )}
      {e.execution.notes.some((n) => n.startsWith("build error")) && <div className="note crit">{e.execution.notes.join("; ")}</div>}
      {e.llm.source === "fallback" && e.llm.note && <div className="note quiet">{e.llm.note}</div>}
      <div className="meta">
        <span>bin {e.pool.activeBinId}</span>
        <span>{fmtPrice(e.pool.price)} {e.pool.priceLabel}</span>
        <span>fee {e.pool.dynamicFeePct.toFixed(2)}%</span>
        <span>bands {e.positions.length}</span>
        <span>wallet {fmtSol(e.wallet.sol, 3)}</span>
        <span>confidence {Math.round(e.decision.confidence * 100)}%</span>
      </div>
    </article>
  );
}

export function Feed({ entries, now, showPool = false }: { entries: JournalEntry[]; now: number; showPool?: boolean }) {
  const [shown, setShown] = useState(20);
  const visible = entries.slice(0, shown);
  return (
    <section className="area-feed" aria-label="Decision journal">
      <div className="section-head">
        <h2 className="section">Decision journal</h2>
        <span className="panel-meta">{entries.length} cycles · newest first</span>
      </div>
      {visible.map((e) => (
        <Item key={e.id} e={e} now={now} showPool={showPool} />
      ))}
      {shown < entries.length && (
        <button type="button" className="more" onClick={() => setShown((n) => n + 20)}>
          Show {Math.min(20, entries.length - shown)} more
        </button>
      )}
    </section>
  );
}
