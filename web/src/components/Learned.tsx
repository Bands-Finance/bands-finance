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
  lane: string;
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
  refused?: { lessons: Record<string, number>; changes: number };
  neverTouched: string[];
}

const env = import.meta.env as Record<string, string | undefined>;

/** Where the panel looks, in order: an override, the desk's API, the static snapshot beside the page. */
export async function loadLearned(): Promise<LearnedFile | null> {
  const urls = [env.VITE_LEARNED_URL, `${API_BASE}/api/learning`, `${API_BASE}/learned.json`].filter((u): u is string => Boolean(u));
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!res.ok) continue;
      const json = (await res.json()) as LearnedFile;
      if (json && Array.isArray(json.factors) && Array.isArray(json.changes) && json.lessons) return json;
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

  const v = view ?? loaded;
  if (!v) return null;
  const ratio = v.lessons.ratio;
  const ends = Object.entries(v.lessons.byEndReason).sort((a, b) => b[1] - a[1]);
  const refused = Object.entries(v.refused?.lessons ?? {}).filter(([, n]) => n > 0);

  return (
    <section className="learned reveal" ref={ref} aria-label="What he learned">
      <div className="learned__head r-item">
        <span className="eyebrow learned__eyebrow">What he learned</span>
        <div className="learned__badges">
          <span className="learned__badge learned__badge--book">{v.mode}</span>
          {v.frozen.all && <span className="learned__badge learned__badge--frozen">learning frozen</span>}
          {!v.modelOn && <span className="learned__badge">model off</span>}
        </div>
        <h2 className="learned__title">He keeps the receipts, then moves one knob.</h2>
        <p className="learned__sub">
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
              what his entry forecast has come in at, against what the seats realised, over <strong>{ratio.n}</strong> closed seats. It was too high on <strong>{ratio.tooHigh}</strong>{" "}
              of them. He recomputes this number from the casebook; nobody types it in.
            </>
          ) : (
            <>no closed seat has scored an entry forecast yet, so there is nothing to calibrate against. {v.lessons.total} seats on the book.</>
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
            <div className={`learned__factor${f.underSample || f.lastMovedAt === null ? " learned__factor--default" : ""}`}>{x(f.underSample ? f.defaultFactor : f.factor)}</div>
            <p className="learned__knob-why">
              {f.underSample ? (
                <>
                  Not enough seats yet: <strong>{f.n}</strong> of the <strong>{f.minSample}</strong> it needs, so the shipped {x(f.defaultFactor)} stands.
                </>
              ) : f.lastMovedAt === null ? (
                <>
                  <strong>{f.n}</strong> seats say it may move, and it has not moved yet: the shipped {x(f.defaultFactor)} stands.
                </>
              ) : (
                <>
                  On <strong>{f.n}</strong> seats, last moved {day(f.lastMovedAt)}. {f.why}
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
              <li className="learned__row" key={`${c.at}:${c.knob}:${c.lane}`}>
                <span className="learned__when">{day(c.at)}</span>
                <span className="learned__what">
                  {KNOB_WORDS[c.knob] ?? c.knob} <span className="learned__lane">{c.label ?? c.lane}</span> {x(c.from)} → {x(c.to)}
                </span>
                <span className="learned__why">{c.why}</span>
                <span className="learned__n">
                  {c.n} seats · {c.windowH}h · {c.mode}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {refused.length > 0 && (
        <p className="learned__never r-item">
          Not counted above: {refused.map(([m, n]) => `${n} seat${n === 1 ? "" : "s"} from the ${m} book`).join(", ")}. A number learned on one book does not carry to another, so those rows are
          shown as refused rather than folded in.
        </p>
      )}

      {ends.length > 0 && (
        <div className="learned__ends r-item">
          <h3 className="learned__h3">How his {v.lessons.total} seats ended</h3>
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
