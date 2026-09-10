import { useMemo, useState } from "react";
import type { ScreenedPool, ScreenResult } from "../types";
import { ago, fmtPct, fmtUsd, short } from "../format";

export type PoolStatus = "in band" | "watching";

type SortKey = "score" | "feeToTvl24hPct" | "tvlUsd" | "volume24hUsd" | "fees24hUsd" | "turnover24h" | "priceChange24hPct" | "binRangePct" | "mcapUsd" | "ageHours" | "binStep";
const PAGE = 25;

function ageLabel(h: number | null): string {
  if (h === null) return "n/a";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${Math.round(h)} h`;
  if (h < 24 * 60) return `${Math.round(h / 24)} d`;
  return `${Math.round(h / (24 * 30))} mo`;
}
const mult = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(2)}×`);

interface Col {
  key: SortKey;
  label: string;
  title: string;
  render: (p: ScreenedPool) => React.ReactNode;
}

const COLS: Col[] = [
  { key: "feeToTvl24hPct", label: "Fee / TVL 24h", title: "Fees earned in 24h as a share of liquidity. The LP number.", render: (p) => <b>{p.feeToTvl24hPct === null ? "n/a" : `${p.feeToTvl24hPct.toFixed(2)}%`}</b> },
  { key: "tvlUsd", label: "Liquidity", title: "Pool reserves valued from chain", render: (p) => fmtUsd(p.tvlUsd) },
  { key: "volume24hUsd", label: "Volume 24h", title: "24h swap volume", render: (p) => fmtUsd(p.volume24hUsd) },
  { key: "fees24hUsd", label: "Fees 24h", title: "* measured from on-chain protocol fee counters; otherwise volume × base fee", render: (p) => <>{fmtUsd(p.fees24hUsd)}{p.feesSource === "onchain" ? <span className="onchain" title={`on-chain, ${p.feesWindowHours}h window`}>*</span> : null}</> },
  { key: "turnover24h", label: "Turnover", title: "Volume / liquidity", render: (p) => mult(p.turnover24h) },
  { key: "priceChange24hPct", label: "24h", title: "Price change over 24h", render: (p) => <span className={p.priceChange24hPct === null ? "" : p.priceChange24hPct >= 0 ? "pos" : "neg"}>{p.priceChange24hPct === null ? "n/a" : fmtPct(p.priceChange24hPct, 1)}</span> },
  { key: "binRangePct", label: "Range", title: "Active-bin travel over the sample window, in percent", render: (p) => (p.binRangePct === null ? "n/a" : `${p.binRangePct.toFixed(1)}%`) },
  { key: "mcapUsd", label: "Mcap", title: "Market cap or FDV", render: (p) => fmtUsd(p.mcapUsd) },
  { key: "ageHours", label: "Age", title: "Pool age", render: (p) => ageLabel(p.ageHours) },
];

export function Pools({ screen, status, now }: { screen: ScreenResult | null; status: Map<string, PoolStatus>; now: number }) {
  const [quote, setQuote] = useState<"all" | "SOL" | "USDC">("all");
  const [q, setQ] = useState("");
  const [minLiq, setMinLiq] = useState(20_000);
  const [hideNew, setHideNew] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    if (!screen) return [];
    const needle = q.trim().toLowerCase();
    const f = screen.pools.filter(
      (p) =>
        (quote === "all" || p.quoteSymbol === quote) &&
        (p.tvlUsd ?? 0) >= minLiq &&
        (!hideNew || p.ageHours === null || p.ageHours >= 24) &&
        (!needle || p.name.toLowerCase().includes(needle) || p.address.toLowerCase().includes(needle) || p.baseMint.toLowerCase().includes(needle)),
    );
    const sign = dir === "desc" ? -1 : 1;
    return f.sort((a, b) => {
      const av = a[sortKey] as number | null;
      const bv = b[sortKey] as number | null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sign * (av - bv) || a.rank - b.rank;
    });
  }, [screen, quote, q, minLiq, hideNew, sortKey, dir]);

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

  if (!screen) {
    return <div className="loading">No screen yet. Run <code>npm run screen</code> to scan every DLMM pool on chain.</div>;
  }

  return (
    <section className="pools" aria-label="Pools">
      <div className="pools-filters">
        <label className="fld">
          <span>Quote</span>
          <select id="quote" value={quote} onChange={(e) => { setQuote(e.target.value as typeof quote); setPage(1); }}>
            <option value="all">SOL &amp; USDC</option>
            <option value="SOL">SOL</option>
            <option value="USDC">USDC</option>
          </select>
        </label>
        <label className="fld">
          <span>Min liquidity</span>
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
          <input id="poolq" type="search" placeholder="token, pool or mint address" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </label>
      </div>

      <div className="pools-head">
        <span>
          <b>{rows.length}</b> pools · scanned <b>{screen.scannedPools.toLocaleString()}</b> DLMM pools on-chain, <b>{screen.livePools.toLocaleString()}</b> traded in the last day
        </span>
        <span className="panel-meta">SOL ${screen.solPriceUsd?.toFixed(2) ?? "n/a"} · scan {(screen.scanMs / 1000).toFixed(0)}s · updated {ago(screen.generatedAt, now)}</span>
      </div>

      <div className="table-wrap">
        <table className="pools-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Pool</th>
              <th className="num sortable" onClick={() => sortBy("score")} title="Mr Bands' score: fee yield, braked by liquidity, age and volatility">Score{arrow("score")}</th>
              {COLS.map((c) => (
                <th key={c.key} className="num sortable" onClick={() => sortBy(c.key)} title={c.title}>{c.label}{arrow(c.key)}</th>
              ))}
              <th>Mr Bands</th>
            </tr>
          </thead>
          <tbody>
            {view.map((p) => {
              const st = status.get(p.address);
              return (
                <tr key={p.address}>
                  <td className="num muted">{p.rank}</td>
                  <td>
                    <div className="pool-name">
                      <a href={`https://app.meteora.ag/dlmm/${p.address}`} target="_blank" rel="noreferrer">{p.name}</a>
                      <span className="chip tiny">DLMM</span>
                      <span className="chip tiny">{p.binStep} bps</span>
                      <span className="chip tiny">{p.baseFeePct.toFixed(2)}% fee</span>
                    </div>
                    <div className="pool-sub">
                      <span title={p.address}>{short(p.address)}</span>
                      {p.flags.filter((f) => f !== "onchain-fees").map((f) => (
                        <span key={f} className={`flag ${f}`}>{f}</span>
                      ))}
                    </div>
                  </td>
                  <td className="num">
                    <span className="score">
                      <span className="score-bar"><span style={{ width: `${Math.min(100, p.score)}%` }} /></span>
                      {p.score.toFixed(0)}
                    </span>
                  </td>
                  {COLS.map((c) => (
                    <td key={c.key} className="num">{c.render(p)}</td>
                  ))}
                  <td>{st ? <span className={`chip ${st === "in band" ? "inrange" : ""}`}>{st}</span> : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
            {view.length === 0 && (
              <tr><td colSpan={COLS.length + 4} className="empty">Nothing matches these filters.</td></tr>
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
      <p className="fine">Liquidity, fees, bin step and fee tiers come from the DLMM program accounts on Solana. Volume, prices, market cap and pool age come from GeckoTerminal. Fees marked * are measured from on-chain protocol-fee counters over the sample window and extrapolated to 24h; others are volume × base fee.</p>
    </section>
  );
}
