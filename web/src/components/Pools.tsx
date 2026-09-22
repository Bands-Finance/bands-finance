import { useMemo, useState } from "react";
import type { ScreenedPool, ScreenResult, Venue } from "../types";
import { ago, fmtPct, fmtUsd, short } from "../format";
import { FEES_MARK_GLOSS, FLAG_GLOSS, ISSUER_GLOSS, ISSUER_LABEL, poolUrl, stepGloss, stepOf, stocksOf, VENUE_GLOSS, VENUE_LABEL, VENUE_ORDER, venueOf, venuesOf } from "./PoolsHead";

export type PoolStatus = "in band" | "watching";

export interface PoolsProps {
  screen: ScreenResult | null;
  /** what Mr Bands is doing per pool address, from the journal */
  status: Map<string, PoolStatus>;
  now: number;
}

type SortKey = "score" | "feeToTvl24hPct" | "tvlUsd" | "volume24hUsd" | "fees24hUsd" | "turnover24h" | "priceChange24hPct" | "binRangePct" | "mcapUsd" | "ageHours" | "binStep";
type VenueFilter = "all" | Venue;
const PAGE = 25;

const STATUS_WORDS: Record<PoolStatus, string> = { "in band": "Mr Bands has a band here", watching: "watching" };
const STATUS_RANK: Record<PoolStatus, number> = { "in band": 2, watching: 1 };
const VENUE_CLASS: Record<Venue, string> = { "meteora-dlmm": "meteora", "raydium-clmm": "raydium", "orca-whirlpool": "orca" };

function ageLabel(h: number | null): string {
  if (h === null) return "n/a";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${Math.round(h)} h`;
  if (h < 24 * 60) return `${Math.round(h / 24)} d`;
  return `${Math.round(h / (24 * 30))} mo`;
}
const mult = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(2)}×`);
const isStock = (p: ScreenedPool) => !!p.stock && p.stock.issuer !== "unknown";

interface Col {
  key: SortKey;
  label: string;
  title: string;
  render: (p: ScreenedPool) => React.ReactNode;
}

const COLS: Col[] = [
  { key: "feeToTvl24hPct", label: "Daily fee yield", title: "24h fees as a share of the pool's money", render: (p) => <b>{p.feeToTvl24hPct === null ? "n/a" : `${p.feeToTvl24hPct.toFixed(2)}%`}</b> },
  { key: "tvlUsd", label: "Money in pool", title: "what the pool holds", render: (p) => fmtUsd(p.tvlUsd) },
  { key: "volume24hUsd", label: "Volume 24h", title: "traded in the last day", render: (p) => fmtUsd(p.volume24hUsd) },
  {
    key: "fees24hUsd",
    label: "Fees 24h",
    title: `fees paid to the pool's liquidity in 24h. ${FEES_MARK_GLOSS}`,
    render: (p) => (
      <>
        {fmtUsd(p.fees24hUsd)}
        {p.feesSource === "onchain" ? <span className="onchain" title={`measured on-chain over ${p.feesWindowHours}h`}>*</span> : null}
        {p.feesSource === "api" ? <span className="api" title={`reported by ${VENUE_LABEL[venueOf(p)]}'s API`}>°</span> : null}
      </>
    ),
  },
  { key: "turnover24h", label: "Turnover", title: "times the pool's money changed hands in a day", render: (p) => mult(p.turnover24h) },
  { key: "priceChange24hPct", label: "24h", title: "price change over the last day", render: (p) => <span className={p.priceChange24hPct === null ? "" : p.priceChange24hPct >= 0 ? "pos" : "neg"}>{p.priceChange24hPct === null ? "n/a" : fmtPct(p.priceChange24hPct, 1)}</span> },
  { key: "binRangePct", label: "Range", title: "how far the price walked (Meteora only)", render: (p) => (p.binRangePct === null ? "n/a" : `${p.binRangePct.toFixed(1)}%`) },
  { key: "mcapUsd", label: "Mcap", title: "market cap", render: (p) => fmtUsd(p.mcapUsd) },
  { key: "ageHours", label: "Age", title: "pool age", render: (p) => ageLabel(p.ageHours) },
];

export function Pools({ screen, status, now }: PoolsProps) {
  const [venue, setVenue] = useState<VenueFilter>("all");
  const [stocksOnly, setStocksOnly] = useState(false);
  const [quote, setQuote] = useState<"all" | "SOL" | "USDC">("SOL");
  const [q, setQ] = useState("");
  const [minLiq, setMinLiq] = useState(20_000);
  const [hideNew, setHideNew] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);

  // The Range column only exists when the screener measured it for at least one pool.
  const cols = useMemo(() => (screen && screen.pools.every((p) => p.binRangePct === null) ? COLS.filter((c) => c.key !== "binRangePct") : COLS), [screen]);
  // Venue chips only for venues the scan actually covered; a single-venue snapshot shows no chips.
  const venuesPresent = useMemo(() => (screen ? VENUE_ORDER.filter((v) => venuesOf(screen).some((x) => x.venue === v) || screen.pools.some((p) => venueOf(p) === v)) : []), [screen]);
  const stockCount = useMemo(() => (screen ? stocksOf(screen) : 0), [screen]);

  const rows = useMemo(() => {
    if (!screen) return [];
    const needle = q.trim().toLowerCase();
    const f = screen.pools.filter((p) => {
      // A pool Mr Bands is in or watching always shows: hiding it behind a size
      // or age filter is the one thing this table must not do.
      const pinned = status.has(p.address);
      return (
        (venue === "all" || venueOf(p) === venue) &&
        (!stocksOnly || isStock(p)) &&
        (quote === "all" || p.quoteSymbol === quote) &&
        (pinned || (p.tvlUsd ?? 0) >= minLiq) &&
        (pinned || !hideNew || p.ageHours === null || p.ageHours >= 24) &&
        (!needle ||
          p.name.toLowerCase().includes(needle) ||
          p.address.toLowerCase().includes(needle) ||
          p.baseMint.toLowerCase().includes(needle) ||
          (p.stock ? p.stock.ticker.toLowerCase().includes(needle) : false))
      );
    });
    const sign = dir === "desc" ? -1 : 1;
    // In the default order the pools he is in float to the top; any explicit sort is a plain sort.
    const pinFirst = sortKey === "score" && dir === "desc";
    return f.sort((a, b) => {
      if (pinFirst) {
        const sa = status.get(a.address);
        const sb = status.get(b.address);
        const ra = sa ? STATUS_RANK[sa] : 0;
        const rb = sb ? STATUS_RANK[sb] : 0;
        if (ra !== rb) return rb - ra;
      }
      const av = a[sortKey] as number | null;
      const bv = b[sortKey] as number | null;
      if (av === null && bv === null) return a.rank - b.rank;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sign * (av - bv) || a.rank - b.rank;
    });
  }, [screen, status, venue, stocksOnly, quote, q, minLiq, hideNew, sortKey, dir]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const cur = Math.min(page, pages);
  const view = rows.slice((cur - 1) * PAGE, cur * PAGE);

  const sortBy = (k: SortKey) => {
    if (k === sortKey) setDir(dir === "desc" ? "asc" : "desc");
    else {
      setSortKey(k);
      setDir("desc");
    }
    setPage(1);
  };
  const arrow = (k: SortKey) => (k === sortKey ? (dir === "desc" ? " ↓" : " ↑") : "");
  const pickVenue = (v: VenueFilter) => {
    setVenue(v);
    setPage(1);
  };
  const toggleStocks = () => {
    const on = !stocksOnly;
    setStocksOnly(on);
    // Stock liquidity is USDC-quoted almost everywhere; a SOL-only quote filter would hide it.
    if (on && quote === "SOL") setQuote("all");
    setPage(1);
  };

  if (!screen) {
    return <div className="loading">No scan yet. The screener runs every half hour.</div>;
  }

  const venues = venuesOf(screen);
  const multi = venuesPresent.length > 1;
  const countOf = (v: Venue) => venues.find((x) => x.venue === v);

  return (
    <section className="pools" id="pools" aria-label="Every pool, ranked">
      <div className="venue-chips" role="group" aria-label="Venue">
        <span className="seg">
          <button type="button" aria-pressed={venue === "all"} onClick={() => pickVenue("all")} title="every venue">All</button>
          {venuesPresent.map((v) => (
            <button key={v} type="button" aria-pressed={venue === v} onClick={() => pickVenue(v)} title={VENUE_GLOSS[v]}>
              {VENUE_LABEL[v]}
              {countOf(v) && <span className="venue-chip-count">{countOf(v)!.ranked}</span>}
            </button>
          ))}
        </span>
        <button type="button" className="toggle-chip" aria-pressed={stocksOnly} onClick={toggleStocks} title="tokenized stocks only">
          Stocks{stockCount > 0 && <span className="venue-chip-count">{stockCount}</span>}
        </button>
        {multi && <span className="venue-note">He trades Meteora only; Raydium and Orca are shown, not traded.</span>}
      </div>

      <div className="pools-filters">
        <label className="fld">
          <span>Quote</span>
          <select id="quote" value={quote} onChange={(e) => { setQuote(e.target.value as typeof quote); setPage(1); }}>
            <option value="SOL">SOL</option>
            <option value="USDC">USDC</option>
            <option value="all">SOL &amp; USDC</option>
          </select>
        </label>
        <span className="fld-note">he trades SOL-paired pools only</span>
        <label className="fld">
          <span>Min money in pool</span>
          <select id="minliq" value={minLiq} onChange={(e) => { setMinLiq(Number(e.target.value)); setPage(1); }}>
            <option value={0}>any</option>
            <option value={5000}>$5K</option>
            <option value={20000}>$20K</option>
            <option value={100000}>$100K</option>
            <option value={1000000}>$1M</option>
          </select>
        </label>
        <label className="fld chk">
          <input id="hidenew" type="checkbox" checked={hideNew} onChange={(e) => { setHideNew(e.target.checked); setPage(1); }} />
          <span>hide pools under 24h old</span>
        </label>
        <label className="fld grow">
          <span>Search</span>
          <input id="poolq" type="search" placeholder="token, ticker, pool or mint address" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </label>
      </div>

      <div className="pools-head">
        <span>
          <b>{rows.length}</b> pools · scanned <b>{venues.reduce((n, v) => n + v.scanned, 0).toLocaleString()}</b> pools{multi ? ` across ${venues.length} venues` : " on-chain"}, <b>{venues.reduce((n, v) => n + v.live, 0).toLocaleString()}</b> traded in the last day
          {stockCount > 0 && <>, <b>{stockCount}</b> tokenized stock{stockCount === 1 ? "" : "s"}</>}
        </span>
        <span className="panel-meta">SOL ${screen.solPriceUsd?.toFixed(2) ?? "n/a"} · scan {(screen.scanMs / 1000).toFixed(0)}s · updated {ago(screen.generatedAt, now)}</span>
      </div>

      <div className="table-wrap">
        <table className="pools-table">
          <thead>
            <tr>
              <th className="num col-rank" title="rank by his score">#</th>
              <th className="col-pool">Pool</th>
              <th className="col-venue" title="venue">Venue</th>
              <th className="num sortable" onClick={() => sortBy("score")} title="0–100: fee yield, marked down for thin, new, wild or one-sided">Mr Bands' score{arrow("score")}</th>
              {cols.map((c) => (
                <th key={c.key} className="num sortable" onClick={() => sortBy(c.key)} title={c.title}>{c.label}{arrow(c.key)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((p) => {
              const st = status.get(p.address);
              const v = venueOf(p);
              return (
                <tr key={`${v}:${p.address}`} className={st ? `has-status ${st === "in band" ? "is-inband" : "is-watching"}` : undefined}>
                  <td className="num muted col-rank">{p.rank}</td>
                  <td className="col-pool">
                    <div className="pool-name">
                      <a href={poolUrl(p)} target="_blank" rel="noreferrer">{p.name}</a>
                      {p.stock && (
                        <span className={`stock-badge ${p.stock.issuer}`} title={`tokenized ${p.stock.ticker} stock: ${ISSUER_GLOSS[p.stock.issuer]}`}>
                          {p.stock.ticker}
                          <span className="issuer">{ISSUER_LABEL[p.stock.issuer]}</span>
                        </span>
                      )}
                      <span className="chip tiny" title={stepGloss(v)}>{stepOf(p)} bps</span>
                      <span className="chip tiny" title="base fee: the pool's cut of every trade">{p.baseFeePct.toFixed(2)}% fee</span>
                    </div>
                    {st && (
                      <div className="pool-status">
                        <span className={`chip ${st === "in band" ? "inrange" : "dim"}`} title={st === "in band" ? "his open band is here" : "read in the last two hours"}>{STATUS_WORDS[st]}</span>
                      </div>
                    )}
                    <div className="pool-sub">
                      <span title={p.address}>{short(p.address)}</span>
                      {p.flags.filter((f) => f !== "onchain-fees").map((f) => (
                        <span key={f} className={`flag ${f}`} title={FLAG_GLOSS[f] ?? f}>{f}</span>
                      ))}
                    </div>
                  </td>
                  <td className="col-venue">
                    <span className={`venue-tag venue-${VENUE_CLASS[v]}`} title={VENUE_GLOSS[v]}>{VENUE_LABEL[v]}</span>
                  </td>
                  <td className="num">
                    <span className="score">
                      <span className="score-bar"><span style={{ width: `${Math.min(100, p.score)}%` }} /></span>
                      {p.score.toFixed(0)}
                    </span>
                  </td>
                  {cols.map((c) => (
                    <td key={c.key} className="num">{c.render(p)}</td>
                  ))}
                </tr>
              );
            })}
            {view.length === 0 && (
              <tr><td colSpan={cols.length + 4} className="empty">Nothing matches these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <span>Showing {rows.length === 0 ? 0 : (cur - 1) * PAGE + 1} to {Math.min(cur * PAGE, rows.length)} of {rows.length} pools</span>
        <span className="seg">
          <button type="button" onClick={() => setPage(Math.max(1, cur - 1))} disabled={cur === 1}>‹</button>
          {Array.from({ length: pages }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === pages || Math.abs(n - cur) <= 1)
            .reduce<(number | "…")[]>((acc, n) => (acc.length && typeof acc[acc.length - 1] === "number" && n - (acc[acc.length - 1] as number) > 1 ? [...acc, "…", n] : [...acc, n]), [])
            .map((n, i) => (typeof n === "number" ? <button key={n} type="button" aria-pressed={n === cur} onClick={() => setPage(n)}>{n}</button> : <button key={`e${i}`} type="button" disabled>…</button>))}
          <button type="button" onClick={() => setPage(Math.min(pages, cur + 1))} disabled={cur === pages}>›</button>
        </span>
      </div>
      <p className="fine">
        Meteora rows are read from Solana, Raydium and Orca rows from the venue's API. Fees marked <b>*</b> are measured on-chain; <b>°</b> are the venue's figure; the rest are volume × base fee.
      </p>
    </section>
  );
}
