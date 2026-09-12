import type { CSSProperties } from "react";
import "./Skeleton.css";

// A shimmer placeholder shaped roughly like the content it stands in for, so a
// first-ever load shows structure instead of a blank couple of seconds. Only
// the genuine first visit to a tab ever sees this; every revisit paints from
// the resource cache instantly. Respects prefers-reduced-motion (the CSS drops
// the shimmer to a static tint there).

export function SkeletonLine({ w = "100%", h = 14 }: { w?: string | number; h?: number }) {
  return <span className="sk sk--line" style={{ width: w, height: h } as CSSProperties} aria-hidden="true" />;
}

/** A generic card-shaped block: an eyebrow, a couple of stat rows, some lines.
 *  Sized to feel like the real cards without pretending to be them. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="sk-card" aria-hidden="true">
      <SkeletonLine w="38%" h={12} />
      <div className="sk-card__stats">
        <SkeletonLine w="22%" h={26} />
        <SkeletonLine w="22%" h={26} />
        <SkeletonLine w="22%" h={26} />
      </div>
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} w={i === lines - 1 ? "70%" : "100%"} />
      ))}
    </div>
  );
}

/** Whole-section placeholder: an eyebrow, a title, and a row of cards. Used
 *  where a tab would otherwise render nothing on its first paint. */
export function SkeletonSection({ cards = 3 }: { cards?: number }) {
  return (
    <section className="sk-section" aria-busy="true" aria-label="Loading">
      <SkeletonLine w="10rem" h={11} />
      <SkeletonLine w="min(22rem, 70%)" h={34} />
      <div className="sk-section__grid">
        {Array.from({ length: cards }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </section>
  );
}
