/**
 * "What he learned": the only place on the site where one of his own numbers has moved because of
 * something that happened to him. It reads web/public/learned.json, written by src/scripts/snapshot.ts
 * from the same view /api/status serves (src/status.ts readLearnedView), so the page and the API
 * cannot disagree.
 *
 * What it will not do:
 *   - print a factor without the sample behind it; under the minimum it says the shipped default
 *     stands, and how many seats are still missing
 *   - shrink a loss. Wins and losses are the same size, the same weight and the same colour rules
 *   - outrun the code. While his model is off the panel says so, and says these knobs are his
 *     rulebook's; while learning is frozen it says frozen; the book's label rides on the header
 *   - leave out what learning may never touch: the last line names the limits a human sets
 *   - show a practice book. The site shows only his real-money record (Zach, 22 Sep): a view learned on
 *     any book but the live one is refused by loadLearned, and the panel says its seats are real money
 * Mounted by Learn.tsx.
 */
import { useEffect, useState } from "react";
import { API_BASE } from "../api";
import { useReveal } from "../hooks/useReveal";
import "./Learned.css";

/** Mirrors src/learn/surface.ts. The site is built on its own; the shape is asserted in test-learn-surface.ts. */
export interface LearnedRatio {
  median: number;
  n: number;
  tooHigh: number;
}
export interface LearnedFactor {
  knob: "calibration" | "pool-penalty";
  lane: string;
  label: string;
  factor: number;
  defaultFactor: number;
  n: number;
  minSample: number;
  underSample: boolean;
  asOf: number | null;
  lastMovedAt: number | null;
  why: string | null;
  frozen: boolean;
  ratio: LearnedRatio | null;
}
export interface LearnedChange {
  at: number;
  mode: string;
  knob: "calibration" | "pool-penalty";
  /** the lane, on a calibration row */
  lane?: string;
  /** the pool, on a pool-penalty row */
  pool?: string;
  label?: string;
  from: number;
  to: number;
  why: string;
  n: number;
  windowH: number;
}
export interface LearnedFile {
  mode: string;
  generatedAt: number;
  frozen: { all: boolean; calibration: boolean; pools: boolean };
  modelOn: boolean;
  factors: LearnedFactor[];
  changes: LearnedChange[];
  lessons: { total: number; byEndReason: Record<string, number>; ratio: LearnedRatio | null };
  /** when the first seat in this casebook was opened, ms; null with no seat; absent on a file from before the field */
  since?: number | null;
  refused?: { lessons: Record<string, number>; changes: number };
  neverTouched: string[];
}

const env = import.meta.env as Record<string, string | undefined>;

/** The book the site shows: his real-money seats (the snapshot builds learned.json from data-mainnet). */
const REAL_BOOK = "live";

/** Where the panel looks, in order: an override, the desk's API, the static snapshot beside the page. A view learned on any other book is skipped. */
export async function loadLearned(): Promise<LearnedFile | null> {
  const urls = [env.VITE_LEARNED_URL, `${API_BASE}/api/learning`, `${API_BASE}/learned.json`].filter((u): u is string => Boolean(u));
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!res.ok) continue;
      const json = (await res.json()) as LearnedFile;
      if (json && json.mode === REAL_BOOK && Array.isArray(json.factors) && Array.isArray(json.changes) && json.lessons) return json;
    } catch {
      /* next */
    }
  }
  return null;
}

const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const x = (n: number) => `×${n.toFixed(2)}`;

/** How a seat ended, in plain words, for the tally. */
const END_WORDS: Record<string, string> = {
  idle: "went quiet and he pulled it",
  "through-band": "the price went through the bottom",
  rotated: "he moved it somewhere better",
  stop: "the stop-loss closed it",
  close: "he closed it himself",
};

const KNOB_WORDS: Record<string, string> = {
  calibration: "forecast haircut",
  "pool-penalty": "pool size penalty",
};

export interface LearnedProps {
  /** a loaded view; when absent the panel loads it itself */
  view?: LearnedFile | null;
}

export function Learned({ view }: LearnedProps = {}) {
  const ref = useReveal<HTMLElement>();
  const [loaded, setLoaded] = useState<LearnedFile | null>(view ?? null);
  useEffect(() => {
    if (view) return;
    let live = true;
    void loadLearned().then((f) => {
      if (live) setLoaded(f);
    });
    return () => {
      live = false;
    };
  }, [view]);

  const v0 = view ?? loaded;
  if (!v0 || v0.mode !== REAL_BOOK) return null;
  // only the real-money book's own rows: a change journalled on another book is not his record
  const v = { ...v0, changes: v0.changes.filter((c) => c.mode === REAL_BOOK) };
  const ratio = v.lessons.ratio;
  const ends = Object.entries(v.lessons.byEndReason).sort((a, b) => b[1] - a[1]);
  const refused = Object.entries(v.refused?.lessons ?? {}).filter(([, n]) => n > 0);
  // The casebook is this desk's alone: a fresh DATA_DIR starts it at 0 while the record chapter on the same page
  // tells of a 55-seat run (25 Sep 2026: "How his 1 seats ended"). So every count here is dated from its first seat.
  const since = typeof v.since === "number" ? ` since ${day(v.since)}` : "";
  const seats = (n: number) => `${n} seat${n === 1 ? "" : "s"}`;

  return (
    <section className="learned reveal" ref={ref} aria-label="What he learned">
      <div className="learned__head r-item">
        <span className="eyebrow learned__eyebrow">What he learned</span>
        <div className="learned__badges">
          <span className="learned__badge learned__badge--book">real-money desk</span>
          {v.frozen.all && <span className="learned__badge learned__badge--frozen">learning frozen</span>}
          {!v.modelOn && <span className="learned__badge">model off</span>}
        </div>
        <h2 className="learned__title">He keeps the receipts, then moves one knob.</h2>
        <p className="learned__sub">
          {typeof v.since === "number" ? `These seats are from his real-money desk${since}.` : "No seat has closed on this desk yet."} His first run's seats are in the record chapter, not in this sample.{" "}
          Every seat he closes is written down: how long it sat, how wide, how it ended, what it earned against what he expected. A handful of his own settings move off that record, one
          bounded step at a time, never without a minimum sample, and every move is journalled with the evidence you can read below.{" "}
          {v.modelOn ? "His model is answering." : "His model is off today, so these knobs are his rulebook's, not his model's."}
        </p>
      </div>

      <div className="learned__stat r-item">
        <div className="learned__stat-n">{ratio ? ratio.median.toFixed(2) : "—"}</div>
        <div className="learned__stat-w">
          {ratio ? (
            <>
              what his entry forecast has come in at, against what the seats realised, over <strong>{ratio.n}</strong> closed seat{ratio.n === 1 ? "" : "s"}{since}. It was too high on <strong>{ratio.tooHigh}</strong>{" "}
              of them. He recomputes this number from the casebook; nobody types it in.
            </>
          ) : (
            <>no closed seat has scored an entry forecast yet, so there is nothing to calibrate against. {v.lessons.total > 0 ? `${seats(v.lessons.total)} on this desk${since}.` : "No seat has closed on this desk yet."}</>
          )}
        </div>
      </div>

      <div className="learned__grid">
        {v.factors.length === 0 && <p className="learned__none r-item">No knob has moved yet. Until one does, what ships in code is what runs.</p>}
        {v.factors.map((f) => (
          <article className="learned__knob r-item" key={`${f.knob}:${f.lane}`}>
            <h3 className="learned__knob-title">
              {KNOB_WORDS[f.knob] ?? f.knob} <span className="learned__lane">{f.label}</span>
            </h3>
            {/* a knob that was journalled prints the number IN FORCE, whatever its sample reads today: the
                desk is pricing at it either way, and "it has not moved" beside the row that moved it is
                the one thing the journal exists to prevent. The default shows only while nothing moved. */}
            <div className={`learned__factor${f.lastMovedAt === null ? " learned__factor--default" : ""}`}>{x(f.lastMovedAt === null ? f.defaultFactor : f.factor)}</div>
            <p className="learned__knob-why">
              {f.lastMovedAt !== null ? (
                <>
                  In force on <strong>{f.n}</strong> scored seat{f.n === 1 ? "" : "s"}, last moved {day(f.lastMovedAt)}
                  {f.underSample ? <>, which is under the {f.minSample} a fresh move needs, so it stands where it was left</> : null}. {f.why}
                </>
              ) : f.underSample ? (
                <>
                  Not enough seats yet: <strong>{f.n}</strong> of the <strong>{f.minSample}</strong> it needs, so the shipped {x(f.defaultFactor)} stands.
                </>
              ) : (
                <>
                  <strong>{f.n}</strong> seats say it may move, and it has not moved yet: the shipped {x(f.defaultFactor)} stands.
                </>
              )}
              {f.frozen && <span className="learned__frozen"> frozen</span>}
            </p>
            <p className="learned__knob-bound">It can only make a seat smaller or rarer. It can never make one bigger.</p>
          </article>
        ))}
      </div>

      <div className="learned__journal r-item">
        <h3 className="learned__h3">The change journal</h3>
        {v.changes.length === 0 ? (
          <p className="learned__none">Nothing has changed yet. When something does, the row appears here with the evidence that moved it.</p>
        ) : (
          <ol className="learned__rows">
            {v.changes.map((c) => (
              <li className="learned__row" key={`${c.at}:${c.knob}:${c.lane ?? c.pool}`}>
                <span className="learned__when">{day(c.at)}</span>
                <span className="learned__what">
                  {KNOB_WORDS[c.knob] ?? c.knob} <span className="learned__lane">{c.label ?? c.lane ?? c.pool?.slice(0, 6)}</span> {x(c.from)} → {x(c.to)}
                </span>
                <span className="learned__why">{c.why}</span>
                <span className="learned__n">
                  {c.n} seats · {c.windowH}h · real money
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {refused.length > 0 && (
        <p className="learned__never r-item">
          Not counted above: {(() => { const n = refused.reduce((t, [, k]) => t + k, 0); return `${n} seat${n === 1 ? "" : "s"} that were not real money`; })()}. A number learned on one book does not carry to another, so those rows are
          shown as refused rather than folded in.
        </p>
      )}

      {ends.length > 0 && (
        <div className="learned__ends r-item">
          <h3 className="learned__h3">How his {seats(v.lessons.total)} ended{since}</h3>
          <ul className="learned__endlist">
            {ends.map(([reason, n]) => (
              <li key={reason}>
                <span className="learned__end-n">{n}</span>
                <span className="learned__end-w">{END_WORDS[reason] ?? reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="learned__never r-item">
        What learning may never touch: {v.neverTouched.join(", ")}. Those are set by a human and stay that way. Learning tunes how he trades inside them, never the limits themselves,
        and a freeze switch stops it without costing him a single lesson.
      </p>
    </section>
  );
}
