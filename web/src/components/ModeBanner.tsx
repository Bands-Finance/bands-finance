import type { ReactNode } from "react";
import { GLOSS, type Status } from "../model";
import "./ModeBanner.css";

export interface ModeBannerProps {
  status: Status;
}

/**
 * One plain sentence about what the numbers on this page are: a live wallet,
 * a rehearsal that broadcasts nothing, or a scripted demo. Replaces the old
 * "demo data" / "dry run" pills. The sentence itself comes from statusOf so
 * it can never disagree with the rest of the page.
 */
export function ModeBanner({ status }: ModeBannerProps) {
  const gloss = status.mode === "dry-run" ? GLOSS.dryRun : status.mode === "paper" ? GLOSS.paper : status.mode === "demo" ? GLOSS.demo : null;
  // The words the gloss hangs on, in the order we look for them. The dry-run
  // sentence says "Rehearsal mode", not "dry run", so both spellings count.
  const words = status.mode === "dry-run" ? ["dry run", "rehearsal"] : status.mode === "paper" ? ["Paper trading", "paper"] : status.mode === "demo" ? ["demo"] : [];

  return (
    <aside className="modebanner" aria-label="Status">
      <div className="modebanner__inner">
        <span className="eyebrow modebanner__eyebrow">
          status
          <span className="modebanner__sep" aria-hidden="true">·</span>
          {gloss ? (
            <span className="term modebanner__mode" title={gloss}>{status.short}</span>
          ) : (
            <span className="modebanner__mode modebanner__mode--live">{status.short}</span>
          )}
        </span>
        <p className="modebanner__sentence">{gloss ? glossFirst(status.sentence, words, gloss) : status.sentence}</p>
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
