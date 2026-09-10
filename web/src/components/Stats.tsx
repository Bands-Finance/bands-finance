import type { AgentSummary } from "../derive";
import { duration, fmtPct, fmtSigned } from "../format";

export function Stats({ s, rangeLabel }: { s: AgentSummary; rangeLabel: string }) {
  const dir = s.pnlSol > 0.00005 ? "up" : s.pnlSol < -0.00005 ? "down" : "";
  return (
    <section className="stats" aria-label="Summary">
      <div className="stat">
        <div className="stat-label">Equity</div>
        <div className="stat-value hero">
          {s.equitySol.toFixed(4)}<span className="unit">SOL</span>
        </div>
        <div className="stat-sub">wallet + bands + refundable rent</div>
      </div>
      <div className="stat">
        <div className="stat-label">P&amp;L, {rangeLabel}</div>
        <div className={`stat-value ${dir}`}>
          {dir === "up" ? "▲ " : dir === "down" ? "▼ " : ""}
          {fmtSigned(s.pnlSol)}<span className="unit">SOL</span>
        </div>
        <div className="stat-sub">{fmtPct(s.pnlPct, 2)} over {duration(s.spanMs)}</div>
      </div>
      <div className="stat">
        <div className="stat-label">Fees earned</div>
        <div className="stat-value">
          {(s.feesRealizedSol + s.feesUnclaimedSol).toFixed(4)}<span className="unit">SOL</span>
        </div>
        <div className="stat-sub">{s.feesRealizedSol.toFixed(4)} claimed · {s.feesUnclaimedSol.toFixed(4)} open</div>
      </div>
      <div className="stat">
        <div className="stat-label">Bands on the book</div>
        <div className="stat-value">{s.bandsOpen}</div>
        <div className="stat-sub">{s.bandsOpen === 0 ? "flat" : `${s.bandsInRange} of ${s.bandsOpen} in range`}{s.closed.length ? ` · ${s.wins}/${s.closed.length} closed won` : ""}</div>
      </div>
      <div className="stat">
        <div className="stat-label">Decisions</div>
        <div className="stat-value">{s.decisions}</div>
        <div className="stat-sub">{s.executed} executed · {s.blocked} blocked · {s.overrides} overridden</div>
      </div>
    </section>
  );
}
