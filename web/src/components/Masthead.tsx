import type { AgentSummary } from "../derive";
import { ago } from "../format";

interface Props {
  agents: AgentSummary[];
  selected: AgentSummary | null;
  onSelect: (id: string) => void;
  lastFetched: number | null;
  now: number;
  demo: boolean;
}

export function Masthead({ agents, selected, onSelect, lastFetched, now, demo }: Props) {
  const live = selected?.latest.mode === "live";
  return (
    <header className="mast">
      <div>
        <h1 className="wordmark">
          bands<span className="tld">.finance</span>
        </h1>
        <p className="mast-sub">
          {selected ? (
            <>
              <b>{selected.name}</b> makes markets in <b>{selected.latest.pool.label}</b> on Meteora DLMM. Every decision, every guard verdict, in the open.
            </>
          ) : (
            <>An autonomous liquidity provider on Meteora DLMM. Every decision, every guard verdict, in the open.</>
          )}
        </p>
      </div>
      <div className="mast-right">
        {agents.length > 1 && (
          <div className="agents" role="group" aria-label="Agent">
            {agents.map((a) => (
              <button key={a.id} type="button" aria-pressed={a.id === selected?.id} onClick={() => onSelect(a.id)}>
                {a.name}
              </button>
            ))}
          </div>
        )}
        {demo && <span className="pill demo"><span className="dot" />demo data</span>}
        {selected && (
          <span className={`pill ${live ? "live" : ""}`} title={live ? "Real transactions" : "Nothing is broadcast"}>
            <span className="dot" />
            {live ? "live" : "dry run"}
          </span>
        )}
        {lastFetched && <span className="updated">updated {ago(lastFetched, now)}</span>}
      </div>
    </header>
  );
}
