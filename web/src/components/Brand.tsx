import { Marquee } from "./Marquee";
import "./Brand.css";

/**
 * The house imagery: Zach's engraved plates on paper with one orange accent (2026-09-17). The ten plates
 * run as an infinite marquee the reader's scroll pushes around; the full figure stands at the foot.
 * Decoration only: every plate's words are in its alt text, nothing on the page depends on them.
 */

export const PLATES: { file: string; title: string; line: string; w: number; h: number }[] = [
  { file: "mr-bands", title: "Mr Bands", line: "Liquidity in between. Discipline today compounds tomorrow.", w: 307, h: 498 },
  { file: "capital", title: "Capital", line: "Builds opportunity.", w: 277, h: 498 },
  { file: "partnership", title: "Partnership", line: "Go further together. Better markets, stronger people.", w: 292, h: 498 },
  { file: "global-reach", title: "Global reach", line: "Local opportunity. Same principles, a wider world.", w: 296, h: 498 },
  { file: "tradition", title: "Tradition", line: "Meets progress. A brighter tomorrow.", w: 284, h: 498 },
  { file: "discipline", title: "Discipline", line: "Creates freedom. A calm mind compounds everything.", w: 307, h: 471 },
  { file: "markets", title: "Markets", line: "Never sleep. Time creates opportunity.", w: 277, h: 471 },
  { file: "liquidity", title: "Liquidity in between", line: "Higher potential, in between, stronger foundations.", w: 292, h: 471 },
  { file: "brighter-tomorrow", title: "A brighter tomorrow", line: "Same principles.", w: 296, h: 471 },
  { file: "build", title: "Build", line: "For what's next. Built on principles.", w: 284, h: 471 },
];

/** The ten plates, always drifting; the reader's scroll hurries or reverses them. */
export function BrandPlates() {
  return (
    <Marquee className="plates" speed={24} scrollBoost={5} label="The house plates">
      {PLATES.map((p) => (
        <figure className="plate" key={p.file}>
          <img src={`/art/plates/${p.file}.webp`} alt={`${p.title}. ${p.line}`} loading="lazy" width={p.w} height={p.h} draggable={false} />
        </figure>
      ))}
    </Marquee>
  );
}

/** The full figure at the foot of the page. */
export function BrandFigure({ agentName }: { agentName: string }) {
  return <img className="brand-figure" src="/art/brand/figure.webp" alt={`${agentName} at full length, cane in hand. Liquidity in between.`} width="800" height="1200" loading="lazy" />;
}
