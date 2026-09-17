import { useState } from "react";
import { ACTION_PAST, type ActionRow, type Status } from "../model";
import { ago, dayClock } from "../format";
import "./Actions.css";

/**
 * What he did: every executed move, newest first, one line each. The time, the move, the pool, the
 * numbers, his own words, and the transaction when there is one. Nothing explanatory: the page's
 * first screen already said what mode this is.
 */
export interface ActionsProps {
  actions: ActionRow[];
  status: Status;
  now: number;
  agentName: string;
}

const FIRST = 40;
const STEP = 60;

const VERB: Record<ActionRow["action"], string> = {
  HOLD: "held",
  OPEN_POSITION: "opened",
  CLOSE_POSITION: "closed",
  CLAIM_FEES: "claimed",
  REBALANCE: "moved",
};

export function Actions({ actions, status, now, agentName }: ActionsProps) {
  const [shown, setShown] = useState(FIRST);
  const rows = actions.slice(0, shown);
  const live = status.mode === "live";
  if (actions.length === 0) {
    return <p className="acts__empty">No move yet. {agentName} only acts when a pool is worth it; the holds are in his journal.</p>;
  }
  return (
    <div className="acts">
      <ol className="acts__list" aria-label={`Moves ${agentName} made`}>
        {rows.map((a) => (
          <li className={`acts__row acts__row--${a.action.toLowerCase()}${a.forced ? " acts__row--forced" : ""}`} key={a.id}>
            <span className="acts__when" title={new Date(a.ts).toLocaleString()}>
              <span className="acts__clock">{dayClock(a.ts)}</span>
              <span className="acts__ago">{ago(a.ts, now)}</span>
            </span>
            <span className="acts__verb">{VERB[a.action]}</span>
            <span className="acts__pool">{a.poolLabel}</span>
            <span className="acts__what">
              {a.what || ACTION_PAST[a.action]}
              {a.forced && <span className="acts__forced" title="A guard rule closed it: a stop or a breaker, not his choice">forced by the guards</span>}
            </span>
            <span className={`acts__result${a.resultSol === null ? "" : a.resultSol >= 0 ? " acts__result--up" : " acts__result--down"}`}>
              {a.resultSol === null ? "" : `${a.resultSol >= 0 ? "+" : "−"}${Math.abs(a.resultSol).toFixed(4)} SOL`}
            </span>
            <span className="acts__voice">“{a.headline}”</span>
            <span className="acts__tx">
              {a.href ? (
                <a href={a.href} target="_blank" rel="noreferrer">
                  tx ↗
                </a>
              ) : (
                <span title={live ? "no signature recorded" : status.sentence}>{live ? "·" : "simulated"}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {actions.length > shown && (
        <button type="button" className="acts__more" onClick={() => setShown((n) => n + STEP)}>
          {actions.length - shown} earlier moves ↓
        </button>
      )}
    </div>
  );
}
