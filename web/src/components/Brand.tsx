import "./Brand.css";

/**
 * The house imagery: engraved plates on paper with one orange accent (Zach's brand renders,
 * 2026-09-17). A portrait beside the note, the eight plates as a strip, the full figure at the foot.
 * Decoration only: every plate's words are in its alt text, nothing on the page depends on them.
 */

export const PLATES: { file: string; title: string; line: string }[] = [
  { file: "card-portrait", title: "Mr Bands", line: "Liquidity in between" },
  { file: "card-partnership", title: "Partnership", line: "Better markets together" },
  { file: "card-capital-flows", title: "Capital flows", line: "In between opportunity" },
  { file: "card-global-liquidity", title: "Global liquidity", line: "Same principles. A wider world." },
  { file: "card-higher-perspective", title: "A higher perspective", line: "Discipline creates freedom" },
  { file: "card-liquidity-in-between", title: "Liquidity in between", line: "People, markets, opportunities, a brighter tomorrow" },
  { file: "card-tradition", title: "Tradition meets progress", line: "" },
  { file: "card-built-for-next", title: "Built for what's next", line: "" },
];

/** The engraved portrait beside the note. */
export function BrandPortrait({ agentName }: { agentName: string }) {
  return <img className="brand-portrait" src="/art/brand/portrait-cigar.webp" alt={`${agentName}, engraved: top hat with an orange band, pixel shades, a cigar`} width="900" height="900" loading="eager" />;
}

/** The eight plates, a strip on wide screens and a scroll on small ones. */
export function BrandPlates() {
  return (
    <div className="brand-plates" role="list" aria-label="The house plates">
      {PLATES.map((p) => (
        <figure className="brand-plate" role="listitem" key={p.file}>
          <img src={`/art/brand/${p.file}.webp`} alt={`${p.title}${p.line ? `. ${p.line}` : ""}`} loading="lazy" width="372" height="496" />
        </figure>
      ))}
    </div>
  );
}

/** The full figure at the foot of the page. */
export function BrandFigure({ agentName }: { agentName: string }) {
  return <img className="brand-figure" src="/art/brand/figure.webp" alt={`${agentName} at full length, cane in hand. Liquidity in between.`} width="800" height="1200" loading="lazy" />;
}
