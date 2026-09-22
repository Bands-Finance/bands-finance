import type { ReactNode } from "react";
import type { AgentRecord, BandCard, FeePoint, PoolFlow } from "../model";
import { ago, duration, fmtPrice } from "../format";
import { num } from "../narrative";
import { PLATFORM_URL } from "../site";
import { motionSystemReduced, setMotionPaused, useMotion } from "../motion";

/**
 * What the chapters of the journey prove themselves with. Every number here is the Record's, the Book's or
 * the flow scout's (src/model.ts); this file only sets them in the page's one type system: a label in
 * engraved capitals, a figure in the mono, a sentence in the serif, a hairline between.
 */

const signed = (n: number, d = 2) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(d)}`;

export function Figures({ items }: { items: { label: string; value: ReactNode; note?: ReactNode; tone?: "good" | "bad" }[] }) {
  return (
    <dl className="figs">
      {items.map((f) => (
        <div className="figs__item" key={f.label}>
          <dt className="engrave">{f.label}</dt>
          <dd className={f.tone ? `figs__v figs__v--${f.tone}` : "figs__v"}>{f.value}</dd>
          {f.note && <dd className="figs__note">{f.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** "NVDAx/SOL" -> "NVDAx / SOL"; "SOL/DJT" -> "DJT / SOL": the token first, what it is paired with second. */
export function pairWords(label: string): { base: string; quote: string } {
  const [a, b] = label.split("/");
  if (!b) return { base: label, quote: "" };
  return a === "SOL" || a === "USDC" ? { base: b, quote: a } : { base: a, quote: b };
}

export function bandStatus(b: BandCard): { word: string; tone: "good" | "bad" | undefined } {
  if (b.inRange) return { word: "Earning now.", tone: "good" };
  const n = Math.abs(b.binsFromRange);
  return { word: `Out by ${n} bin${n === 1 ? "" : "s"}.`, tone: n <= 2 ? undefined : "bad" };
}

/** A base58 Solana account, as opposed to the paper desk's "paper-<pool>-<n>" tag for a pretend position. */
const isOnchainAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

/** One open band: the four figures that matter, what the pool paid in the last hour, and the small facts. */
export function BandBlock({ band: b, flow, now }: { band: BandCard; flow?: PoolFlow; now: number }) {
  const move = b.marketMove;
  const f = flow?.flow;
  const age = f ? Math.max(0, Math.round((now - f.asOf) / 60_000)) : 0;
  return (
    <>
      <Figures
        items={[
          { label: "Fees earned", value: <>{b.fees < 0.00005 ? "0" : `+${num(b.fees)}`}<small> SOL</small></>, tone: b.fees > 0 ? "good" : undefined },
          { label: "Worth now", value: <>{num(b.worthNow)}<small> SOL</small></>, note: b.putIn !== null ? `he put in ${num(b.putIn)}` : undefined },
          ...(move !== null ? [{ label: "From the market", value: <>{signed(move)}<small> SOL</small></>, tone: (move >= 0 ? "good" : "bad") as "good" | "bad", note: "what price did to it, fees aside" }] : []),
          ...(b.pacePerDay !== null ? [{ label: "His pace", value: <>{num(b.pacePerDay)}<small> SOL a day</small></> }] : []),
        ]}
      />
      {f && (
        <p className="chap__p" title="Read from the chain by the flow scout, from the pool's own account">
          In the last hour this pool paid {num(f.fees60mQuote)} {f.quoteSymbol} in fees to everyone making a market in it
          {f.feesPerDayQuote60m !== null ? <>, a pace of {num(f.feesPerDayQuote60m)} {f.quoteSymbol} a day</> : null}
          {f.fees15mQuote > 0 ? <>. {num(f.fees15mQuote)} {f.quoteSymbol} of it came in the last fifteen minutes.</> : <>. The last fifteen minutes were quiet.</>}
          <span className="chap__age"> Read {age === 0 ? "just now" : `${age} min ago`}.</span>
        </p>
      )}
      <p className="chap__facts engrave">
        {b.openedAt !== null && <span>Open {duration(now - b.openedAt)}</span>}
        <span>{b.widthBins} bins</span>
        <span>±{(b.widthPct / 2).toFixed(1)}%</span>
        <span>{b.side}</span>
        {/* the pool is the real venue in every mode; the position itself is on Solscan only when its address is one Solana knows
            (a paper band's "address" is the desk's own tag, src/paper/book.ts, and a Solscan page for it is a dead end) */}
        <a href={`https://app.meteora.ag/dlmm/${b.poolAddress}`} target="_blank" rel="noreferrer" title="the pool on Meteora">
          The pool on Meteora ↗
        </a>
        {isOnchainAddress(b.address) && (
          <a href={`https://solscan.io/account/${b.address}`} target="_blank" rel="noreferrer" title="the position on Solscan">
            No. {b.address.slice(0, 4)}…{b.address.slice(-4)} ↗
          </a>
        )}
      </p>
    </>
  );
}

/** Tags for the desk: the price on the cursor, the band's two ends. */
export function bandLabels(row: number, b: BandCard) {
  return [
    { anchor: `row${row}.cursor`, text: `${fmtPrice(b.activePrice)} now`, strong: true },
    { anchor: `row${row}.low`, text: fmtPrice(b.lowerPrice) },
    { anchor: `row${row}.high`, text: fmtPrice(b.upperPrice) },
  ];
}

/* ---------- what he made ---------- */

export interface FeeChart {
  /** coins standing on each seat, oldest first */
  coins: number[];
  /** what one coin is worth, SOL */
  unit: number;
  bucket: "hour" | "day";
}

const UNITS = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];

/** The abacus on the desk: his fee claims summed by the hour (by the day once the run is older than a day and a bit), one coin a round amount. */
export function feeChartOf(points: FeePoint[], startTs: number, now: number, seats = 24): FeeChart {
  const hour = 3600e3;
  const bucketMs = now - startTs <= 30 * hour ? hour : 24 * hour;
  const end = Math.floor(now / bucketMs) + 1;
  const sums = new Array<number>(seats).fill(0);
  for (const p of points) {
    const k = seats - (end - Math.floor(p.t / bucketMs));
    if (k >= 0 && k < seats) sums[k] += p.amount;
  }
  const max = Math.max(0, ...sums);
  const unit = UNITS.find((u) => max / u <= 16) ?? UNITS[UNITS.length - 1];
  return { coins: sums.map((s) => (s > 0 ? Math.max(1, Math.round(s / unit)) : 0)), unit, bucket: bucketMs === hour ? "hour" : "day" };
}

const usd = (sol: number, px: number | null): string | null => (px !== null && Number.isFinite(px) && px > 0 ? `$${Math.round(sol * px).toLocaleString()}` : null);
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

export function MadeBlock({ record, solPriceUsd, now, chart }: { record: AgentRecord; solPriceUsd: number | null; now: number; chart: FeeChart }) {
  const last = record.feePoints[record.feePoints.length - 1] ?? null;
  const days = [...record.days].reverse().slice(0, 10);
  return (
    <>
      <Figures
        items={[
          { label: "Claimed", value: <>{`+${num(record.feesRealized)}`}<small> SOL</small></>, tone: "good", note: usd(record.feesRealized, solPriceUsd) ? `about ${usd(record.feesRealized, solPriceUsd)}` : undefined },
          { label: "Waiting in his bands", value: <>{num(record.feesUnclaimed)}<small> SOL</small></>, note: "earned, not yet claimed" },
          { label: "Claims", value: record.feePoints.length.toLocaleString(), note: last ? `the last one ${ago(last.t, now)}` : undefined },
        ]}
      />
      {/* the abacus only means something once a claim has put a coin on it; before that, say why it is bare */}
      <p className="chap__p">
        {chart.coins.some((c) => c > 0)
          ? `On the desk, each column of coins is one ${chart.bucket} of claims and each coin is ${chart.unit} SOL. The newest ${chart.bucket} stands at the right.`
          : "No claim yet, so the abacus on the desk is empty; the fees sit in his bands until he collects them."}
      </p>
      {days.length > 0 && (
        <div className="chap__scroll">
          <table className="chap__table">
            <thead>
              <tr className="engrave">
                <th>Day</th>
                <th>Fees claimed</th>
                <th>The book, open to close</th>
                <th>Moves</th>
                <th>Claims</th>
                <th>Holds</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                // num() rounds a book over 100 SOL to whole SOL, which can print "174 → 174 (−0.55)": when the two
                // round to the same figure, print them to the cent so the bracket adds up
                const same = num(d.open) === num(d.close);
                return (
                <tr key={d.date}>
                  <td>{dayLabel(d.date)}</td>
                  <td className="chap__good">+{num(d.fees)}</td>
                  <td>
                    {same ? d.open.toFixed(2) : num(d.open)} → {same ? d.close.toFixed(2) : num(d.close)} <span className={d.close - d.open >= 0 ? "chap__good" : "chap__bad"}>({signed(d.close - d.open)})</span>
                  </td>
                  <td>{d.moves}</td>
                  <td>{d.claims}</td>
                  <td>{d.holds}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ---------- the statement ---------- */

export function StatementList({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="stmt">
      {rows.map((r) => (
        <div className="stmt__row" key={r.label}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------- the close ---------- */

export function ClosingBlock({ agentName, walletAddress }: { agentName: string; walletAddress: string | null }) {
  const motion = useMotion();
  const system = motionSystemReduced();
  return (
    <>
      {/* the close stands at the man himself on the desk (station "him"), so no printed portrait beside the words */}
      <div className="close__row">
        <p className="chap__p close__legal">
          {/* walletAddress is set only while the desk is live (DashboardApp.tsx): otherwise he is on paper and says so */}
          {agentName} is experimental software.{" "}
          {walletAddress ? "He trades a wallet of his own." : "He trades on paper now; his live desk, a wallet of his own, is stopped."} Nothing here is advice, and
          nothing on this page can touch your money. Every move above is published as it happened, including the ones that lost.
        </p>
      </div>
      {/* the words pin to the window's centre while the camera walks round him, so the close stays short: the ask is the
          chapter before this one (the "hire" beat, DashboardApp.tsx) and this row only points at where to go. No "rent him" link:
          nothing is for rent until the public platform opens */}
      <nav className="close__links engrave" aria-label="Footer">
        {walletAddress && <a href={`https://solscan.io/account/${walletAddress}`} target="_blank" rel="noreferrer">His wallet</a>}
        <a href={PLATFORM_URL} target="_blank" rel="noreferrer">bands.finance</a>
        <a href={`${PLATFORM_URL}/#/learn`} target="_blank" rel="noreferrer">How it works</a>
        <a href="https://app.meteora.ag" target="_blank" rel="noreferrer">Meteora</a>
        <a href="https://github.com/louz514/bands-finance" target="_blank" rel="noreferrer">The code</a>
      </nav>
      <button type="button" className="dash-foot__motion engrave" aria-pressed={!motion} disabled={system} onClick={() => setMotionPaused(motion)}>
        {system ? "Reduced motion" : motion ? "Pause motion" : "Resume motion"} <span aria-hidden="true">{motion ? "Ⅱ" : "▷"}</span>
      </button>
    </>
  );
}
