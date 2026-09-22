import type { ReactNode } from "react";
import { GLOSS, type Status } from "../model";
import { runDays, type LiveRun } from "../liveRun";
import "./ModeBanner.css";

export interface ModeBannerProps {
  status: Status;
  /** his real-money run: with no book open the banner names it as his record */
  run?: LiveRun | null;
}

/**
 * One plain sentence about what the numbers on this page are: a live wallet,
 * a rehearsal that broadcasts nothing, a scripted demo, or no book open at all
 * (then a second sentence names his real-money run as the record). Replaces the old
 * "demo data" / "dry run" pills. The sentence itself comes from statusOf so
 * it can never disagree with the rest of the page.
 */
export function ModeBanner({ status, run = null }: ModeBannerProps) {
  const idle = status.mode === "none";
  const gloss = status.mode === "dry-run" ? GLOSS.dryRun : status.mode === "demo" ? GLOSS.demo : null;
  // The words the gloss hangs on, in the order we look for them. The dry-run
  // sentence says "Rehearsal mode", not "dry run", so both spellings count.
  const words = status.mode === "dry-run" ? ["dry run", "rehearsal"] : status.mode === "demo" ? ["demo"] : [];
  const sentence = idle && run ? `${status.sentence} His record is his real-money run, ${runDays(run.firstTs, run.lastTs)}.` : status.sentence;

  return (
    <aside className="modebanner" aria-label="Status">
      <div className="modebanner__inner">
        <span className="eyebrow modebanner__eyebrow">
          status
          <span className="modebanner__sep" aria-hidden="true">·</span>
          {gloss ? (
            <span className="term modebanner__mode" title={gloss}>{status.short}</span>
          ) : (
            <span className={`modebanner__mode${idle ? "" : " modebanner__mode--live"}`}>{status.short}</span>
          )}
        </span>
        <p className="modebanner__sentence">{gloss ? glossFirst(sentence, words, gloss) : sentence}</p>
      </div>
    </aside>
  );
}

/** Wraps the first of `words` found in `text` (case-insensitive) in a .term span. */
function glossFirst(text: string, words: string[], title: string): ReactNode {
  const lower = text.toLowerCase();
  for (const w of words) {
    const at = lower.indexOf(w.toLowerCase());
    if (at === -1) continue;
    const hit = text.slice(at, at + w.length);
    return (
      <>
        {text.slice(0, at)}
        <span className="term" title={title}>{hit}</span>
        {text.slice(at + w.length)}
      </>
    );
  }
  return text;
}
