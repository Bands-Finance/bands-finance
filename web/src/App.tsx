import { useEffect, useMemo, useState } from "react";
import { isDemoJournal, isEmbedded, loadJournal, loadLimits } from "./api";
import { groupAgents, inRange, RANGE_LABEL, RangeKey } from "./derive";
import type { JournalEntry, RiskLimits } from "./types";
import { Masthead } from "./components/Masthead";
import { Stats } from "./components/Stats";
import { BinLadder } from "./components/BinLadder";
import { PriceChart } from "./components/PriceChart";
import { EquitySpark } from "./components/EquitySpark";
import { Bands } from "./components/Bands";
import { Feed } from "./components/Feed";
import { Guards } from "./components/Guards";

const POLL_MS = 20_000;
const RANGES: RangeKey[] = ["6h", "24h", "7d", "all"];

export default function App() {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [limits, setLimits] = useState<RiskLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [fetching, setFetching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("24h");
  const [now, setNow] = useState(Date.now());
  const embedded = isEmbedded();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      setFetching(true);
      try {
        const [j, l] = await Promise.all([loadJournal(), loadLimits()]);
        if (!alive) return;
        setEntries(j);
        setLimits(l);
        setError(null);
        setLastFetched(Date.now());
      } catch (err) {
        if (alive) setError((err as Error).message);
      } finally {
        if (alive) setFetching(false);
      }
    };
    void tick();
    const id = embedded ? undefined : window.setInterval(() => void tick(), POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      alive = false;
      if (id) window.clearInterval(id);
      window.clearInterval(clock);
    };
  }, [embedded]);

  const scoped = useMemo(() => (entries ? inRange(entries, range, now) : null), [entries, range, now]);
  const agents = useMemo(() => (scoped ? groupAgents(scoped) : []), [scoped]);
  const selected = agents.find((a) => a.id === selectedId) ?? agents[0] ?? null;

  return (
    <div className={`page ${fetching && entries ? "refetching" : ""}`}>
      <Masthead agents={agents} selected={selected} onSelect={setSelectedId} lastFetched={lastFetched} now={now} demo={embedded || (entries ? isDemoJournal(entries) : false)} />
      {error && !entries && (
        <div className="error">
          Could not load the journal: <code>{error}</code>. Start the API with <code>npm run serve</code> (or set <code>VITE_API_URL</code>).
        </div>
      )}
      {!entries && !error && <div className="loading">loading the ledger…</div>}
      {entries && !selected && <div className="loading">No decisions yet. Run <code>npm run once</code> or <code>npm run seed-demo</code>.</div>}
      {selected && scoped && (
        <>
          <div className="filters">
            <span>Showing</span>
            <div className="seg" role="group" aria-label="Time range">
              {RANGES.map((k) => (
                <button key={k} type="button" aria-pressed={range === k} onClick={() => setRange(k)}>
                  {k}
                </button>
              ))}
            </div>
            <span>{selected.decisions} cycles · {RANGE_LABEL[range]}</span>
          </div>
          <Stats s={selected} rangeLabel={RANGE_LABEL[range]} />
          <main className="grid">
            <BinLadder entry={selected.latest} />
            <PriceChart points={selected.series} pool={selected.latest.pool} />
            <EquitySpark points={selected.series} />
            <Bands s={selected} now={now} />
            <Feed entries={selected.entries} now={now} />
            <Guards limits={limits} s={selected} />
          </main>
        </>
      )}
    </div>
  );
}
