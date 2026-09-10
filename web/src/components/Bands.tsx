import type { AgentSummary } from "../derive";
import { feesInSol } from "../derive";
import { ACTION_LABEL, duration, fmtPct, fmtPrice, fmtSigned, short } from "../format";

export function Bands({ s, now }: { s: AgentSummary; now: number }) {
  const e = s.latest;
  const lastExit = s.closed[s.closed.length - 1];
  const lastExitEntry = lastExit ? s.entries.find((x) => x.ts === lastExit.ts) : undefined;
  return (
    <section className="panel area-bands" aria-label="Bands on the book">
      <div className="panel-head">
        <h2 className="panel-title">Bands on the book</h2>
        <div className="panel-meta">{e.positions.length === 0 ? "flat" : `${s.bandsInRange}/${s.bandsOpen} in range`}</div>
      </div>
      {e.positions.length === 0 ? (
        <div className="empty">
          No band on the book.
          {lastExit && lastExitEntry && (
            <>
              {" "}Last exit: {ACTION_LABEL[lastExit.action]} {duration(now - new Date(lastExit.ts).getTime())} ago, “{lastExitEntry.headline}”
            </>
          )}
        </div>
      ) : (
        e.positions.map((p) => {
          const lo = Math.min(p.lowerPrice, e.pool.price) * 0.995;
          const hi = Math.max(p.upperPrice, e.pool.price) * 1.005;
          const pct = (v: number) => `${(((v - lo) / (hi - lo)) * 100).toFixed(2)}%`;
          const age = Math.max(0, now - p.lastUpdatedAt * 1000);
          const pnl = p.entryValueSol != null && p.entryValueSol > 0 ? p.valueInSol - p.entryValueSol : null;
          const pnlPct = pnl !== null && p.entryValueSol ? (pnl / p.entryValueSol) * 100 : null;
          return (
            <div className="band" key={p.address}>
              <div className="band-head">
                <span className="addr" title={p.address}>band {short(p.address)}</span>
                <span className={`chip ${p.inRange ? "inrange" : "outrange"}`}>
                  {p.inRange ? "in range" : `out by ${Math.abs(p.binsFromRange)} bins`}
                </span>
              </div>
              <div className="range" aria-label={`Band from ${fmtPrice(p.lowerPrice)} to ${fmtPrice(p.upperPrice)}, price now ${fmtPrice(e.pool.price)}`}>
                <div className="track" />
                <div className={`fill ${p.inRange ? "" : "out"}`} style={{ left: pct(p.lowerPrice), width: `calc(${pct(p.upperPrice)} - ${pct(p.lowerPrice)})` }} />
                <div className="now" style={{ left: pct(e.pool.price) }} title={`now ${fmtPrice(e.pool.price)}`} />
                <span className="lbl" style={{ left: pct(p.lowerPrice) }}>{fmtPrice(p.lowerPrice)}</span>
                <span className="lbl" style={{ left: pct(p.upperPrice), transform: "translateX(-100%)" }}>{fmtPrice(p.upperPrice)}</span>
              </div>
              <div className="band-meta">
                <span><span className="k">value</span>{p.valueInSol.toFixed(4)} SOL</span>
                <span>
                  <span className="k">P&amp;L vs entry</span>
                  {pnl === null ? "n/a" : <span className={`band-pnl ${pnl > 0 ? "up" : pnl < 0 ? "down" : ""}`}>{fmtSigned(pnl)} SOL ({fmtPct(pnlPct ?? 0, 2)})</span>}
                </span>
                <span><span className="k">unclaimed fees</span>{feesInSol(p, e).toFixed(4)} SOL</span>
                <span><span className="k">bins</span>{p.lowerBinId}–{p.upperBinId} · {p.widthBins} wide</span>
                <span><span className="k">holds</span>{p.amountX.toLocaleString(undefined, { maximumFractionDigits: 0 })} {e.pool.tokenX.symbol} + {p.amountY.toFixed(4)} {e.pool.tokenY.symbol}</span>
                <span><span className="k">age</span>{p.lastUpdatedAt ? duration(age) : "n/a"}</span>
              </div>
            </div>
          );
        })
      )}
      {s.closed.length > 0 && (
        <div className="band-foot">
          <span><b>{s.closed.length}</b> band{s.closed.length === 1 ? "" : "s"} closed</span>
          <span><b>{s.wins}</b> won</span>
          <span>realized <b className={s.realizedPnlSol >= 0 ? "" : ""}>{fmtSigned(s.realizedPnlSol)} SOL</b> vs entry</span>
        </div>
      )}
    </section>
  );
}
