import type { AgentSummary } from "../derive";
import { ago } from "../format";

interface Props {
  subtitle: React.ReactNode;
  agents: AgentSummary[];
  selected: AgentSummary | null;
  onSelect: (id: string) => void;
  showAgents: boolean;
  lastFetched: number | null;
  now: number;
  demo: boolean;
}

export function Masthead({ subtitle, agents, selected, onSelect, showAgents, lastFetched, now, demo }: Props) {
  const live = selected?.latest.mode === "live";
  return (
    <header className="mast">
      <div>
        <h1 className="wordmark">
          bands<span className="tld">.finance</span>
        </h1>
        <p className="mast-sub">{subtitle}</p>
      </div>
      <div className="mast-right">
        {showAgents && agents.length > 1 && (
          <div className="agents" role="group" aria-label="Agent">
            {agents.map((a) => (
              <button key={a.id} type="button" aria-pressed={a.id === selected?.id} onClick={() => onSelect(a.id)}>
                {a.name}
              </button>
            ))}
          </div>
        )}
        {demo && <span className="pill demo"><span className="dot" />demo data</span>}
        {showAgents && selected && (
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
