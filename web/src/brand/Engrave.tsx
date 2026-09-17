import { useId, useMemo } from "react";

/**
 * ENGRAVING, generated. The ornaments a banknote is made of, drawn from their mathematics rather than
 * pasted in as pictures: the guilloche (phase-shifted sine waves braided into a band), the rosette (a
 * radius that breathes with the angle, many times over), and the hatch an engraver fills a tone with.
 * All of it is line work in currentColor, so the page's ink and its one orange do the colouring.
 */

/** A braided rule, as wide as its container. Three waves a third of a turn apart, and a finer pair inside them. */
export function GuillocheRule({ height = 14, className }: { height?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const W = 44;
  const mid = height / 2;
  const paths = useMemo(() => {
    const wave = (amp: number, cycles: number, phase: number) => {
      const pts: string[] = [];
      const N = 44;
      for (let i = 0; i <= N; i++) {
        const x = (i / N) * W;
        const y = mid + amp * Math.sin((2 * Math.PI * cycles * x) / W + phase);
        pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
      }
      return pts.join(" ");
    };
    const a = mid - 1.4;
    return [
      ...[0, 1, 2].map((k) => ({ d: wave(a, 1, (k * 2 * Math.PI) / 3), w: 0.7 })),
      ...[0, 1].map((k) => ({ d: wave(a * 0.45, 2, k * Math.PI), w: 0.5 })),
    ];
  }, [mid]);
  return (
    <svg className={`guilloche${className ? ` ${className}` : ""}`} width="100%" height={height} aria-hidden="true" focusable="false">
      <defs>
        <pattern id={`g${id}`} width={W} height={height} patternUnits="userSpaceOnUse">
          {paths.map((p, i) => (
            <path key={i} d={p.d} fill="none" stroke="currentColor" strokeWidth={p.w} />
          ))}
        </pattern>
      </defs>
      <line x1="0" x2="100%" y1="0.5" y2="0.5" stroke="currentColor" strokeWidth="1" />
      <rect x="0" y="0" width="100%" height={height} fill={`url(#g${id})`} />
      <line x1="0" x2="100%" y1={height - 0.5} y2={height - 0.5} stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** A rosette: rings whose radius rises and falls `lobes` times a turn, each ring a little out of step with the last. */
export function Rosette({ size = 180, lobes = 14, rings = 7, className }: { size?: number; lobes?: number; rings?: number; className?: string }) {
  const paths = useMemo(() => {
    const out: string[] = [];
    const R = 46;
    for (let j = 0; j < rings; j++) {
      const base = R * (0.42 + (0.5 * j) / Math.max(1, rings - 1));
      const amp = R * 0.085 * (1 + j / rings);
      for (const fam of [0, 1]) {
        const pts: string[] = [];
        const N = 360;
        for (let i = 0; i <= N; i++) {
          const th = (i / N) * 2 * Math.PI;
          const r = base + amp * Math.cos(lobes * th + (fam ? Math.PI : 0) + (j * Math.PI) / rings);
          pts.push(`${i === 0 ? "M" : "L"}${(50 + r * Math.cos(th)).toFixed(2)} ${(50 + r * Math.sin(th)).toFixed(2)}`);
        }
        out.push(`${pts.join(" ")} Z`);
      }
    }
    return out;
  }, [lobes, rings]);
  return (
    <svg className={`rosette${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="0.32" />
      ))}
      <circle cx="50" cy="50" r="49" fill="none" stroke="currentColor" strokeWidth="0.5" />
      <circle cx="50" cy="50" r="17" fill="none" stroke="currentColor" strokeWidth="0.4" />
    </svg>
  );
}

/** The paint servers the page's charts and straps fill with: a hatch and a cross-hatch, in the page's ink. */
export function EngraveDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <pattern id="dash-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#16120f" strokeWidth="0.9" strokeOpacity="0.55" />
        </pattern>
        <pattern id="dash-crosshatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#16120f" strokeWidth="0.8" strokeOpacity="0.5" />
          <line x1="0" y1="0" x2="5" y2="0" stroke="#16120f" strokeWidth="0.8" strokeOpacity="0.5" />
        </pattern>
      </defs>
    </svg>
  );
}

/** The oval a banknote sets its portrait in: a beaded ring between two rules. The image goes underneath. */
export function VignetteRing() {
  return (
    <svg className="vignette__ring" viewBox="0 0 200 240" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <ellipse cx="100" cy="120" rx="97" ry="117" fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <ellipse cx="100" cy="120" rx="92.5" ry="112.5" fill="none" stroke="currentColor" strokeWidth="5" strokeDasharray="1.2 2.6" vectorEffect="non-scaling-stroke" />
      <ellipse cx="100" cy="120" rx="88" ry="108" fill="none" stroke="currentColor" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
