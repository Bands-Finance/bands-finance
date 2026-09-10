import type { AgentSummary } from "../derive";
import type { RiskLimits } from "../types";

export function Guards({ limits, s }: { limits: RiskLimits | null; s: AgentSummary }) {
  return (
    <section className="panel area-guards" aria-label="Risk guards">
      <div className="panel-head">
        <h2 className="panel-title">The guards</h2>
        <div className="panel-meta">enforced in code, not in the prompt</div>
      </div>
      <div className="panel-body">
        {limits ? (
          <dl className="limits">
            <dt>Max per band</dt><dd>{limits.maxPositionSol} SOL</dd>
            <dt>Max total exposure</dt><dd>{limits.maxTotalExposureSol} SOL</dd>
            <dt>Gas reserve kept in wallet</dt><dd>{limits.gasReserveSol} SOL</dd>
            <dt>Stop-loss (forced close)</dt><dd>−{limits.stopLossPct}%</dd>
            <dt>Max band width</dt><dd>{limits.maxBinWidth} bins</dd>
            <dt>Max actions per day</dt><dd>{limits.maxTxPerDay}</dd>
            <dt>Cooldown between actions</dt><dd>{Math.round(limits.minSecondsBetweenActions / 60)} min</dd>
            <dt>Deposit slippage</dt><dd>{limits.maxSlippagePct}%</dd>
            <dt>Refuse to open if price moved</dt><dd>&gt; {limits.maxPriceMovePctPerCycle}% / cycle</dd>
          </dl>
        ) : (
          <p className="fine">Limits unavailable from the API.</p>
        )}
        <div className="guard-counts">
          <span><b>{s.blocked}</b> proposal{s.blocked === 1 ? "" : "s"} blocked</span>
          <span><b>{s.overrides}</b> override{s.overrides === 1 ? "" : "s"}</span>
          <span><b>{s.holds}</b> holds of {s.decisions}</span>
        </div>
        <p className="fine">Mr Bands proposes. The guards decide. A kill-switch file stops all new exposure instantly.</p>
      </div>
    </section>
  );
}
