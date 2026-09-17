import { Fragment, useState } from "react";
import { type ActionRow, type Status } from "../model";
import { clock } from "../format";
import { dayWord } from "../narrative";
import "./Actions.css";

/**
 * What he did: every executed move as a sentence, newest first, grouped by day like a ledger.
 * The time in the margin, the sentence, the money it realised, and the transaction when there is
 * one. His own words under the moves where they add something (opens, closes, moves), not under a
 * claim that already says what it is.
 */
export interface ActionsProps {
  actions: ActionRow[];
  status: Status;
  now: number;
  agentName: string;
}

const FIRST = 40;
const STEP = 60;

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayHeading = (date: string, now: number) => {
  const w = dayWord(date, now);
  const d = new Date(`${date}T00:00:00Z`);
  const long = `${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const cap = w.charAt(0).toUpperCase() + w.slice(1);
  return cap === long ? long : `${cap}, ${long}`;
};

export function Actions({ actions, status, now, agentName }: ActionsProps) {
  const [shown, setShown] = useState(FIRST);
  const rows = actions.slice(0, shown);
  if (actions.length === 0) {
    return <p className="acts__empty">No move yet. {agentName} only acts when a pool is worth it; the holds are in his journal.</p>;
  }
  let lastDay = "";
  return (
    <div className="acts">
      <ol className="acts__list" aria-label={`Moves ${agentName} made`}>
        {rows.map((a) => {
          const day = a.ts.slice(0, 10);
          const heading = day !== lastDay;
          lastDay = day;
          const quote = a.action !== "CLAIM_FEES" && a.headline && a.headline.trim().length > 0;
          return (
            <Fragment key={a.id}>
              {heading && (
                <li className="acts__day" aria-hidden="true">
                  {dayHeading(day, now)}
                </li>
              )}
              <li className={`acts__row${a.forced ? " acts__row--forced" : ""}`}>
                <span className="acts__when" title={new Date(a.ts).toLocaleString()}>
                  {clock(a.ts)}
                </span>
                <span className="acts__body">
                  <span className="acts__sentence">{a.sentence}</span>
                  {quote && <span className="acts__quote">“{a.headline}”</span>}
                </span>
                <span className={`acts__result${a.resultSol === null ? "" : a.resultSol >= 0 ? " acts__result--up" : " acts__result--down"}`}>
                  {a.resultSol === null ? "" : `${a.resultSol >= 0 ? "+" : "−"}${Math.abs(a.resultSol).toFixed(2)} SOL`}
                </span>
                <span className="acts__tx">
                  {a.href && (
                    <a href={a.href} target="_blank" rel="noreferrer" title="the transaction on Solscan">
                      tx ↗
                    </a>
                  )}
                </span>
              </li>
            </Fragment>
          );
        })}
      </ol>
      {actions.length > shown && (
        <button type="button" className="acts__more" onClick={() => setShown((n) => n + STEP)}>
          Show {Math.min(STEP, actions.length - shown)} earlier moves
        </button>
      )}
    </div>
  );
}
