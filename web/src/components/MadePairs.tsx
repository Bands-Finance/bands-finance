import { GLOSS, type MadePair, type Status } from "../model";
import { ago, short } from "../format";
import "./LivePositions.css";
import "./MadePairs.css";

/**
 * Pools he made: every pool the desk created for a token (the pair lane), as of its newest
 * journal entry. The point of the panel is the ability, shown not described: the pool, its terms,
 * what the routing model expects of it, and what the band in it is doing this minute. The model's
 * share is a model; the page says so in as many words.
 */
export interface MadePairsProps {
  pairs: MadePair[];
  status: Status;
  agentName: string;
}

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const solFmt = (n: number, d = 4) => `${n.toFixed(d)} SOL`;
const venueWord = (v: string | null) => (v === "pumpswap" ? "PumpSwap" : v === "raydium-clmm" ? "Raydium" : v === "orca-whirlpool" ? "Orca" : v === "meteora-dlmm" ? "Meteora" : v ?? "its reference");

export function MadePairs({ pairs, status, agentName }: MadePairsProps) {
  const now = Date.now();
  const paper = status.mode === "paper";
  return (
    <section className="livepos madepairs" aria-label={`Pools ${agentName} made`}>
      <div className="livepos__head">
        <h2 className="livepos__title">Pools he made</h2>
        <span className="livepos__pulse livepos__pulse--rehearsal" title={paper ? GLOSS.paper : undefined}>
          {pairs.length} pool{pairs.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="livepos__gloss">
        // pools {agentName} created himself on Meteora DLMM for a token he judged worth one, and seated his own liquidity in · the
        ‘share’ is a routing model: the slice of the token's existing flow for which his pool is the cheaper route, by trade size
        {paper ? " · on paper the pool is virtual and its fees are the model's figure, not fills" : ""}
      </p>
      <div className="livepos__grid">
        {pairs.map((p) => (
          <article key={p.poolAddress} className="livepos__card madepairs__card">
            <div className="madepairs__row">
              <span className="madepairs__label">{p.poolLabel}</span>
              <span className={`livepos__badge ${p.bands > 0 ? (p.inRange ? "livepos__badge--up" : "livepos__badge--dim") : "livepos__badge--dim"}`}>
                {p.bands > 0 ? (p.inRange ? "earning now" : "band waiting") : p.closes > 0 ? "band closed, pool stays" : "pool open, no band"}
              </span>
            </div>
            <dl className="madepairs__terms">
              <div><dt>fee</dt><dd>{(p.feeBps / 100).toFixed(2)}%</dd></div>
              <div><dt>bins</dt><dd>{(p.binStep / 100).toFixed(2)}% each</dd></div>
              <div><dt>seat</dt><dd>up to {solFmt(p.seatCapSol, 1)}</dd></div>
              <div><dt>rent</dt><dd>{p.rentSol > 0 ? `${solFmt(p.rentSol)} to make it` : "paid"}</dd></div>
              <div><dt>share</dt><dd title="the routing model's share of the reference pool's flow, after the split with any competing concentrated pool">{pct(p.routedShare)}{p.competingDepthUsd > 0 ? ` (${pct(p.routedShareGross)} alone)` : ""}</dd></div>
              <div><dt>vs</dt><dd>{venueWord(p.refVenue)}{p.refLiquidityUsd !== null ? `, ${usd(p.refLiquidityUsd)} deep` : ""}</dd></div>
            </dl>
            <p className="madepairs__now">
              {p.activePrice > 0 ? <>price {p.priceLabel} · </> : null}
              {p.opens > 0 ? <>{p.opens} band{p.opens === 1 ? "" : "s"} opened{p.closes > 0 ? `, ${p.closes} closed` : ""} · </> : null}
              {p.claims > 0 ? <>{p.claims} fee claim{p.claims === 1 ? "" : "s"} · </> : null}
              {p.feesWaitingSol > 0 ? <>{solFmt(p.feesWaitingSol)} waiting in the band · </> : null}
              since {ago(p.since, now)}
            </p>
            <p className="madepairs__headline">“{p.headline}” <span className="madepairs__ago">{ago(p.ts, now)}</span></p>
            {p.lbPair && (
              <p className="madepairs__addr" title={p.lbPair}>
                pool {short(p.lbPair)}{p.exists ? "" : " (address derived; the pool is created on the first open)"}
              </p>
            )}
          </article>
        ))}
      </div>
      <p className="livepos__foot">
        A pool of his own pays him every fee it earns while nobody else is in it. A constant-product pool spreads its depth over every
        price; a few bins at the current price are deeper in range, so routers send trades his way even at a higher fee. The catch is
        the mirror image: when the token falls, his liquidity is the first thing the sells hit, which is why a made pool carries a
        tighter stop and, for a launch, a maximum hold.
      </p>
    </section>
  );
}
