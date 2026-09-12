import type { CSSProperties, ReactNode } from "react";
import { useReveal } from "../hooks/useReveal";
import type { ScreenedPool, ScreenResult } from "../types";
import "./RwaCensus.css";

const ri = (n: number) => ({ "--ri": n }) as CSSProperties;

/** A glossed term: dotted underline, the plain-words definition on hover or focus. */
const T = ({ t, children }: { t: string; children: ReactNode }) => (
  <span className="term" title={t} tabIndex={0}>
    {children}
  </span>
);

/** What each screener flag means, in plain words. Used as chip titles here and in the table. */
export const FLAG_GLOSS: Record<string, string> = {
  thin: "thin: under about $20k of liquidity in the pool",
  new: "new: under 24 hours old",
  hot: "hot: fees look great because the price is moving fast, which is exactly when a band gets run over",
  volatile: "volatile: the price swung hard in the last day",
  "one-sided": "one-sided: almost all the liquidity sits on one side of the price",
};

const CHIPS = 12;

type Confidence = "high" | "medium" | "low";
function confidenceOf(p: ScreenedPool): Confidence {
  const flags = p.flags.filter((f) => f !== "onchain-fees");
  if (flags.length === 0) return "high";
  if (flags.includes("thin") || flags.includes("new")) return "low";
  return "medium";
}

export interface PoolsHeadProps {
  screen: ScreenResult | null;
  maxActivePools?: number;
}

/**
 * The screener's output at a glance: three counts as the proof, then the top
 * of the ranking as a light chip row, then what the flags mean. The full table
 * sits right below. Renders nothing until there is a scan.
 */
export function PoolsHead({ screen, maxActivePools }: PoolsHeadProps) {
  const ref = useReveal<HTMLElement>();
  if (!screen) return null;

  const top = [...screen.pools].sort((a, b) => a.rank - b.rank).slice(0, CHIPS);
  const more = screen.rankedPools - top.length;

  return (
    <section className="census reveal" id="screener" ref={ref} aria-label="The screener">
      <div className="census__head r-item" style={ri(0)}>
        <span className="eyebrow">The screener · every 15 minutes</span>
        <h2 className="census__title">Every pool on the chain, ranked.</h2>
        <p className="census__sub">
          Mr Bands reads every{" "}
          <T t="Meteora is an exchange on Solana. DLMM is its pool design: the money sits in small price steps called bins instead of being spread across every price.">Meteora DLMM</T>{" "}
          pool straight from Solana, keeps the ones that traded in the last day, and scores them: fees earned per dollar of{" "}
          <T t="Liquidity is the money sitting in a pool, ready to be traded against.">liquidity</T> first, marked down for being thin, new, wild, or one-sided. He works the top of this list and nothing else.
        </p>
      </div>

      <div className="census__stats r-item" style={ri(1)}>
        <div className="census__stat">
          <span className="census__stat-value">{screen.scannedPools.toLocaleString()}</span>
          <span className="census__stat-label">pools scanned on-chain</span>
        </div>
        <div className="census__stat">
          <span className="census__stat-value">{screen.livePools.toLocaleString()}</span>
          <span className="census__stat-label">traded in the last day</span>
        </div>
        <div className="census__stat">
          <span className="census__stat-value">{screen.rankedPools.toLocaleString()}</span>
          <span className="census__stat-label">ranked</span>
        </div>
        {maxActivePools !== undefined && (
          <div className="census__stat">
            <span className="census__stat-value">{maxActivePools}</span>
            <span className="census__stat-label">worked at once</span>
          </div>
        )}
      </div>

      <div className="census__chips r-item" style={ri(2)}>
        {top.map((p) => {
          const c = confidenceOf(p);
          const title = `#${p.rank} · score ${p.score.toFixed(0)} · daily fee yield ${p.feeToTvl24hPct === null ? "n/a" : `${p.feeToTvl24hPct.toFixed(2)}%`}${p.flags.length ? ` · ${p.flags.filter((f) => f !== "onchain-fees").join(", ")}` : ""}`;
          return (
            <span className="census__chip" key={p.address} title={title}>
              <span className={`census__dot census__dot--${c}`} aria-hidden="true" />
              {p.name}
            </span>
          );
        })}
        {more > 0 && <span className="census__chip census__chip--more">+{more} more below</span>}
      </div>

      <p className="pools-gloss r-item" style={ri(3)}>
        Flags: <b>thin</b> = under about $20k of liquidity · <b>new</b> = under 24 hours old · <b>hot</b> = fees look great because the price is moving fast, which is exactly when a band gets run over · <b>volatile</b> = the price swung hard in the last day · <b>one-sided</b> = almost all the liquidity sits on one side. Dot: green means no flags, cream means flagged, grey means thin or new.
      </p>
    </section>
  );
}
