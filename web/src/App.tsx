import { useEffect, useMemo, useState } from "react";
import { isDemoJournal, isEmbedded, loadJournal, loadLimits, loadScreen } from "./api";
import { groupAgents, inRange, RANGE_LABEL, RangeKey } from "./derive";
import type { JournalEntry, RiskLimits, ScreenResult } from "./types";
import { Masthead } from "./components/Masthead";
import { Stats } from "./components/Stats";
import { BinLadder } from "./components/BinLadder";
import { PriceChart } from "./components/PriceChart";
import { EquitySpark } from "./components/EquitySpark";
import { Bands } from "./components/Bands";
import { Feed } from "./components/Feed";
import { Guards } from "./components/Guards";
import { Pools, PoolStatus } from "./components/Pools";

const POLL_MS = 20_000;
const RANGES: RangeKey[] = ["6h", "24h", "7d", "all"];
type Route = "pools" | "agents";

function routeFromHash(h: string): Route {
  return h.startsWith("#/agents") || h.startsWith("#/@") ? "agents" : "pools";
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  useEffect(() => {
    const f = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return route;
}

export default function App() {
  const route = useRoute();
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [screen, setScreen] = useState<ScreenResult | null>(null);
  const [limits, setLimits] = useState<RiskLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [fetching, setFetching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("24h");
  const [poolAddr, setPoolAddr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const embedded = isEmbedded();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      setFetching(true);
      try {
        const [j, l, s] = await Promise.all([loadJournal().catch((e: Error) => { throw e; }), loadLimits(), loadScreen()]);
        if (!alive) return;
        setEntries(j);
        setLimits(l);
        setScreen(s);
        setError(null);
        setLastFetched(Date.now());
      } catch (err) {
        if (!alive) return;
        setError((err as Error).message);
        // The screen can still load when the journal cannot.
        const s = await loadScreen();
        if (alive) setScreen(s);
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
  const poolView = selected ? (selected.pools.find((p) => p.address === poolAddr) ?? selected.pools[0] ?? null) : null;

  /** What the agents are doing per pool, for the Pools table. */
  const poolStatus = useMemo(() => {
    const m = new Map<string, PoolStatus>();
    if (!entries) return m;
    const seen = new Set<string>();
    for (const e of entries) {
      const key = `${e.agent?.id ?? "mr-bands"}:${e.pool.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (e.positions.length > 0) m.set(e.pool.address, "in band");
      else if (now - new Date(e.ts).getTime() < 2 * 3600e3 && !m.has(e.pool.address)) m.set(e.pool.address, "watching");
    }
    return m;
  }, [entries, now]);

  const demo = embedded || (entries ? isDemoJournal(entries) : false);
  const subtitle =
    route === "pools" ? (
      <>Every DLMM pool on Solana, read from chain and ranked for market making. <b>Mr Bands</b> works the ones worth working.</>
    ) : selected ? (
      <><b>{selected.name}</b> makes markets in <b>{selected.pools.map((p) => p.label).join(", ")}</b> on Meteora DLMM. Every decision, every guard verdict, in the open.</>
    ) : (
      <>Autonomous liquidity agents on Meteora DLMM. Every decision, every guard verdict, in the open.</>
    );

  return (
    <div className={`page ${fetching && entries ? "refetching" : ""}`}>
      <Masthead subtitle={subtitle} agents={agents} selected={selected} onSelect={setSelectedId} showAgents={route === "agents"} lastFetched={lastFetched} now={now} demo={demo} />
      <nav className="tabs" aria-label="Sections">
        <a href="#/pools" aria-current={route === "pools" ? "page" : undefined}>Pools</a>
        <a href="#/agents" aria-current={route === "agents" ? "page" : undefined}>Agents</a>
      </nav>

      {route === "pools" && <Pools screen={screen} status={poolStatus} now={now} />}

      {route === "agents" && (
        <>
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
              {selected.pools.length > 1 && (
                <div className="filters">
                  <span>Pool</span>
                  <div className="seg" role="group" aria-label="Pool">
                    {selected.pools.map((p) => (
                      <button key={p.address} type="button" aria-pressed={p.address === poolView?.address} onClick={() => setPoolAddr(p.address)}>
                        {p.label} {p.latest.pool.binStep}bps{p.latest.positions.length ? " ●" : ""}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <main className="grid">
                {poolView && <BinLadder entry={poolView.latest} />}
                {poolView && <PriceChart points={poolView.series} pool={poolView.latest.pool} />}
                <EquitySpark points={selected.equitySeries} />
                <Bands s={selected} now={now} />
                <Feed entries={poolView ? poolView.entries : selected.entries} now={now} showPool={selected.pools.length > 1} />
                <Guards limits={limits} s={selected} />
              </main>
            </>
          )}
        </>
      )}
    </div>
  );
}
