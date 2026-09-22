import type { CSSProperties, ReactNode } from "react";
import { useReveal } from "../hooks/useReveal";
import type { ScreenedPool, ScreenResult, StockIssuer, Venue, VenueCount } from "../types";
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
  thin: "thin: under about $20k of liquidity",
  new: "new: under 24 hours old",
  hot: "hot: the price is moving fast, so bands get run over",
  volatile: "volatile: the price swung hard in the last day",
  "one-sided": "one-sided: almost all the liquidity on one side",
  "adaptive-fee": "adaptive fee: a variable fee on top of the base",
};

/** Fee markers on the board: where a pool's 24h fee figure came from. */
export const FEES_MARK_GLOSS = "* measured on-chain; ° the venue's figure; unmarked: volume × base fee";

export const VENUE_ORDER: Venue[] = ["meteora-dlmm", "raydium-clmm", "orca-whirlpool"];
export const VENUE_LABEL: Record<Venue, string> = { "meteora-dlmm": "Meteora", "raydium-clmm": "Raydium", "orca-whirlpool": "Orca" };
export const VENUE_GLOSS: Record<Venue, string> = {
  "meteora-dlmm": "Meteora DLMM: read from Solana. The only venue he trades.",
  "raydium-clmm": "Raydium CLMM: read from Raydium's API. Shown, not traded.",
  "orca-whirlpool": "Orca Whirlpools: read from Orca's API. Shown, not traded.",
};
export const ISSUER_LABEL: Record<StockIssuer, string> = { xstocks: "xStocks", backpack: "Backpack", ondo: "Ondo", unknown: "unverified" };
export const ISSUER_GLOSS: Record<StockIssuer, string> = {
  xstocks: "xStock by Backed, backed one-to-one by the share",
  backpack: "Backpack Securities, backed one-to-one by the share",
  ondo: "Ondo Global Markets, backed by the share",
  unknown: "no known issuer: a lookalike",
};

/** Old snapshots carry no venue: they are Meteora boards. */
export const venueOf = (p: Pick<ScreenedPool, "venue">): Venue => p.venue ?? "meteora-dlmm";
export const stepOf = (p: Pick<ScreenedPool, "stepBps" | "binStep">): number => p.stepBps ?? p.binStep;
export const stepGloss = (v: Venue) => (v === "meteora-dlmm" ? "bin step: the width of each price step" : "tick spacing: the width of each price step");
export function poolUrl(p: Pick<ScreenedPool, "address" | "venue">): string {
  switch (venueOf(p)) {
    case "raydium-clmm":
      return `https://raydium.io/clmm/create-position/?pool_id=${p.address}`;
    case "orca-whirlpool":
      return `https://www.orca.so/pools/${p.address}`;
    default:
      return `https://app.meteora.ag/dlmm/${p.address}`;
  }
}
/** Per-venue counts, synthesised for a snapshot from before venues. */
export function venuesOf(screen: ScreenResult): VenueCount[] {
  return screen.venues ?? [{ venue: "meteora-dlmm", scanned: screen.scannedPools, live: screen.livePools, ranked: screen.rankedPools }];
}
/** The stock count, counted from the rows when a snapshot predates it. */
export function stocksOf(screen: ScreenResult): number {
  return screen.stocks ?? screen.pools.filter((p) => p.stock && p.stock.issuer !== "unknown").length;
}

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
 * The screener's output at a glance: the counts as the proof, then the top of the
 * ranking as a light chip row, then what the flags mean. The full table sits right
 * below. Renders nothing until there is a scan.
 */
export function PoolsHead({ screen, maxActivePools }: PoolsHeadProps) {
  const ref = useReveal<HTMLElement>();
  if (!screen) return null;

  const top = [...screen.pools].sort((a, b) => a.rank - b.rank).slice(0, CHIPS);
  const more = screen.rankedPools - top.length;
  const venues = venuesOf(screen);
  const scanned = venues.reduce((n, v) => n + v.scanned, 0);
  const live = venues.reduce((n, v) => n + v.live, 0);
  const stocks = stocksOf(screen);
  const multi = venues.length > 1;

  return (
    <section className="census reveal" id="screener" ref={ref} aria-label="The screener">
      <div className="census__head r-item" style={ri(0)}>
        <span className="eyebrow">The screener · every half hour</span>
        <h2 className="census__title">Every pool on the chain, ranked.</h2>
        <p className="census__sub">
          Every <T t={VENUE_GLOSS["meteora-dlmm"]}>Meteora DLMM</T>,{" "}
          <T t={VENUE_GLOSS["raydium-clmm"]}>Raydium CLMM</T> and <T t={VENUE_GLOSS["orca-whirlpool"]}>Orca Whirlpool</T> pool, scored by fees per dollar of{" "}
          <T t="Liquidity is the money sitting in a pool, ready to be traded against.">liquidity</T> and marked down for thin, new, wild or one-sided. He works the top Meteora rows on paper,{" "}
          <T t="Tokenized stocks: tokens backed one-to-one by a listed share, issued by xStocks or Backpack Securities.">tokenized stocks</T> among them.
        </p>
      </div>

      <div className="census__stats r-item" style={ri(1)}>
        <div className="census__stat">
          <span className="census__stat-value">{scanned.toLocaleString()}</span>
          <span className="census__stat-label">{multi ? `pools scanned · ${venues.length} venues` : "pools scanned"}</span>
          {multi && (
            <span className="census__stat-sub">
              {VENUE_ORDER.filter((v) => venues.some((x) => x.venue === v)).map((v) => `${VENUE_LABEL[v]} ${venues.find((x) => x.venue === v)!.scanned.toLocaleString()}`).join(" · ")}
            </span>
          )}
        </div>
        <div className="census__stat">
          <span className="census__stat-value">{live.toLocaleString()}</span>
          <span className="census__stat-label">traded in the last day</span>
        </div>
        <div className="census__stat">
          <span className="census__stat-value">{screen.rankedPools.toLocaleString()}</span>
          <span className="census__stat-label">ranked</span>
          {multi && <span className="census__stat-sub">{VENUE_ORDER.filter((v) => venues.some((x) => x.venue === v)).map((v) => `${VENUE_LABEL[v]} ${venues.find((x) => x.venue === v)!.ranked}`).join(" · ")}</span>}
        </div>
        <div className="census__stat">
          <span className="census__stat-value">{stocks.toLocaleString()}</span>
          <span className="census__stat-label">tokenized stocks</span>
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
          const title = `#${p.rank} · ${VENUE_LABEL[venueOf(p)]} · score ${p.score.toFixed(0)} · daily fee yield ${p.feeToTvl24hPct === null ? "n/a" : `${p.feeToTvl24hPct.toFixed(2)}%`}${p.stock ? ` · ${p.stock.ticker} (${ISSUER_LABEL[p.stock.issuer]})` : ""}${p.flags.length ? ` · ${p.flags.filter((f) => f !== "onchain-fees").join(", ")}` : ""}`;
          return (
            <span className="census__chip" key={`${venueOf(p)}:${p.address}`} title={title}>
              <span className={`census__dot census__dot--${c}`} aria-hidden="true" />
              {p.name}
              {multi && <span className="census__chip-venue">{VENUE_LABEL[venueOf(p)]}</span>}
            </span>
          );
        })}
        {more > 0 && <span className="census__chip census__chip--more">+{more} more below</span>}
      </div>

      <p className="pools-gloss r-item" style={ri(3)}>
        Dot: green no flags, cream flagged, grey thin or new.
      </p>
    </section>
  );
}
