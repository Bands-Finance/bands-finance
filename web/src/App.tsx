import { useEffect, useMemo, useState } from "react";
import { isDemoJournal } from "./api";
import { useJournalFeed } from "./hooks/useJournalFeed";
import { groupAgents } from "./derive";
import { bookOf, madePairsOf, recordOf, statusOf } from "./model";
import { useScrollFx } from "./hooks/useScrollFx";
import { Header } from "./components/Header";
import { ModeBanner } from "./components/ModeBanner";
import { Desk } from "./components/Desk";
import { Record } from "./components/Record";
import { Book } from "./components/Book";
import { MadePairs } from "./components/MadePairs";
import { Guards } from "./components/Guards";
import { Learn } from "./components/Learn";
import { TryIt } from "./components/TryIt";
import { PoolsHead } from "./components/PoolsHead";
import { Pools, PoolStatus } from "./components/Pools";
import { PublishHere } from "./components/PublishHere";
import { Footer } from "./components/Footer";
import { BinLadder } from "./components/BinLadder";
import { PriceChart } from "./components/PriceChart";
import { WalletProviders } from "./platform/WalletProviders";
import { MePage } from "./platform/MePage";
import { ToolCatalog } from "./components/ToolCatalog";
import { HotNow } from "./components/HotNow";
import { PlatformHome } from "./components/PlatformHome";
import { lazy, Suspense } from "react";

/** the Exchange (three.js, the desk model) loads only when someone opens Play */
const PlayPage = lazy(() => import("./game/PlayPage"));
import { useLiveRun } from "./hooks/useLiveRun";

export type Route = "home" | "pools" | "learn" | "agents" | "me" | "play";

function routeFromHash(h: string): Route {
  if (h.startsWith("#/pools")) return "pools";
  if (h.startsWith("#/learn")) return "learn";
  if (h.startsWith("#/agents") || h.startsWith("#/@")) return "agents";
  if (h.startsWith("#/me")) return "me";
  if (h.startsWith("#/play")) return "play";
  return "home";
}

const TITLES: Record<Route, string> = {
  home: "bands.finance · Mr Bands makes markets on Meteora",
  pools: "Every pool, ranked · bands.finance",
  learn: "How it works · bands.finance",
  agents: "Agents · bands.finance",
  me: "Your Mr Bands · bands.finance",
  play: "The Bands Exchange · bands.finance",
};

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  useEffect(() => {
    const f = () => {
      const r = routeFromHash(window.location.hash);
      setRoute(r);
      if (window.location.hash === "" || window.location.hash.startsWith("#/")) window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  useEffect(() => {
    document.title = TITLES[route];
  }, [route]);
  return route;
}

export default function App() {
  useScrollFx();
  const route = useRoute();
  const { entries, screen, limits, equity, error, now, embedded } = useJournalFeed();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [poolAddr, setPoolAddr] = useState<string | null>(null);
  // his real-money run (web/public/live-run.json): while no book is open it is the record every empty panel points at
  const liveRun = useLiveRun();

  const agents = useMemo(() => (entries ? groupAgents(entries) : []), [entries]);
  const selected = agents.find((a) => a.id === selectedId) ?? agents[0] ?? null;
  const agentEntries = selected?.entries ?? [];
  const demo = embedded || (entries ? isDemoJournal(entries) : false);
  const status = useMemo(() => statusOf(agentEntries, now, demo), [agentEntries, now, demo]);
  const record = useMemo(() => recordOf(agentEntries, equity), [agentEntries, equity]);
  const book = useMemo(() => bookOf(agentEntries), [agentEntries]);
  const madePairs = useMemo(() => madePairsOf(agentEntries), [agentEntries]);
  const agentName = selected?.name ?? "Mr Bands";
  const workingNow = useMemo(() => {
    const seen = new Map<string, boolean>();
    for (const e of agentEntries) if (!seen.has(e.pool.address)) seen.set(e.pool.address, e.positions.length > 0);
    const withBands = agentEntries.filter((e) => seen.get(e.pool.address)).map((e) => e.pool.label);
    const labels = [...new Set(withBands.length ? withBands : agentEntries.slice(0, 3).map((e) => e.pool.label))];
    return labels.slice(0, 4);
  }, [agentEntries]);
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
  const poolView = selected ? (selected.pools.find((p) => p.address === poolAddr) ?? selected.pools[0] ?? null) : null;

  const deskStack = (id: string) => (
    <>
      <Desk id={id} entries={agentEntries} status={status} limits={limits} screen={screen} agentName={agentName} />
      {(record || status.mode === "none") && <Record record={record} solPriceUsd={screen?.solPriceUsd ?? null} status={status} agentName={agentName} run={liveRun} />}
      <Book book={book} status={status} agentName={agentName} />
      {madePairs.length > 0 && <MadePairs pairs={madePairs} status={status} agentName={agentName} />}
      <Guards limits={limits} record={record} />
    </>
  );

  return (
    <WalletProviders>
    <div className="app">
      <Header route={route} />

      {/* the platform he is building (24 Sep): his desk, book and record live on mrbands.finance, and on the Agents tab */}
      {route === "home" && <PlatformHome />}

      {route === "pools" && (
        <main className="app__tabview">
          <HotNow />
          <PoolsHead screen={screen} maxActivePools={6} />
          <Pools screen={screen} status={poolStatus} now={now} />
        </main>
      )}

      {route === "learn" && (
        <main className="app__tabview">
          <Learn />
          <TryIt />
          <ToolCatalog />
          <Guards limits={limits} record={record} />
        </main>
      )}

      {route === "agents" && (
        <main className="app__tabview">
          {agents.length > 1 && (
            <div className="filters" style={{ maxWidth: 1100, margin: "0 auto 16px", paddingInline: 32 }}>
              <span>Agent</span>
              <div className="seg" role="group" aria-label="Agent">
                {agents.map((a) => (
                  <button key={a.id} type="button" aria-pressed={a.id === selected?.id} onClick={() => setSelectedId(a.id)}>{a.name}</button>
                ))}
              </div>
            </div>
          )}
          {entries && <ModeBanner status={status} run={liveRun} />}
          {entries && selected && deskStack("agent-desk")}
          {selected && poolView && (
            <section className="app__desk" aria-label="What he sees">
              <div className="app__desk-head">
                <h2 className="app__desk-title">What he sees</h2>
                <p className="app__desk-sub">The pool at his last check, with his band drawn on the price.</p>
              </div>
              {selected.pools.length > 1 && (
                <div className="filters">
                  <span>Pool</span>
                  <div className="seg" role="group" aria-label="Pool">
                    {selected.pools.map((p) => (
                      <button key={p.address} type="button" aria-pressed={p.address === poolView.address} onClick={() => setPoolAddr(p.address)}>{p.label} {p.latest.pool.binStep}bps</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid" style={{ gridTemplateAreas: '"ladder chart"', gridTemplateColumns: "400px minmax(0,1fr)" }}>
                <BinLadder entry={poolView.latest} />
                <PriceChart points={poolView.series} pool={poolView.latest.pool} />
              </div>
            </section>
          )}
          <PublishHere />
        </main>
      )}

      {route === "me" && <MePage screen={screen} limits={limits} />}

      {route === "play" && (
        <Suspense fallback={<main className="app__tabview" style={{ padding: 48, textAlign: "center" }}>Opening the Exchange…</main>}>
          <PlayPage />
        </Suspense>
      )}

      <Footer />
    </div>
    </WalletProviders>
  );
}
