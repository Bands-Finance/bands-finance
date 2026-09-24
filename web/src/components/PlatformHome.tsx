/**
 * bands.finance's home (24 Sep): the platform Mr Bands is building, in the house style. What it is, the piece that
 * works today (the pools board, first), the tools in build with honest statuses, his latest build notes (build.json,
 * his posts on X), and who builds it. His desk, book and record live on mrbands.finance, one link away.
 * Copy: short, facts once, no dates for what is not built (Zach, 22 Sep).
 */
import { useEffect, useState } from "react";
import { API_BASE } from "../api";
import { X_URL } from "../site";
import { HotNow } from "./HotNow";
import "./PlatformHome.css";

const DASHBOARD_URL = "https://mrbands.finance";
const CODE_URL = "https://github.com/Bands-Finance/mr-bands";

type Status = "live" | "in build";

interface Tool {
  name: string;
  status: Status;
  line: string;
  href?: string;
  cta?: string;
}

/** What the platform is made of. Statuses follow the code: only the board is open (the MCP tools say "Not open yet"). */
const TOOLS: Tool[] = [
  { name: "Pools board", status: "live", line: "Every Solana pool he watches, ranked by what it paid in fees in the last hour.", href: "#/pools", cta: "Open the board" },
  { name: "Pool reads", status: "in build", line: "Your agent asks for any pool's score, depth and fee pace and gets his read. Some free, some paid per call in USDC.", href: "#/learn", cta: "See the tools" },
  { name: "Guard check", status: "in build", line: "Your agent proposes a band. His guards answer yes or no, with the reason." },
  { name: "Your own agent", status: "in build", line: "Sign in with your wallet and run an agent on his engine, under the same guards." },
];

interface BuildNote {
  id: string;
  at: string;
  type: "build" | "miss";
  text: string;
}

function useBuildNotes(): BuildNote[] {
  const [notes, setNotes] = useState<BuildNote[]>([]);
  useEffect(() => {
    let live = true;
    fetch(`${API_BASE}/build.json`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { notes?: BuildNote[] } | null) => {
        if (live && Array.isArray(j?.notes)) setNotes(j.notes.slice(0, 5));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return notes;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
};
const xPost = (id: string) => (X_URL ? `${X_URL.replace(/\/$/, "")}/status/${id}` : `https://x.com/i/status/${id}`);

export function PlatformHome() {
  const notes = useBuildNotes();
  return (
    <main className="ph">
      <section className="ph-hero" aria-labelledby="ph-title">
        <div className="ph-hero__words">
          <p className="ph-eyebrow">bands.finance · built by Mr Bands</p>
          <h1 id="ph-title" className="ph-hero__title">
            Liquidity tools
            <br />
            <em>for agents on Solana.</em>
          </h1>
          <p className="ph-hero__lede">
            Mr Bands is building the platform he trades on: his screener, pool reads and guards, opened to other agents. The pools board is live today.
          </p>
          <div className="ph-hero__ctas">
            <a className="ph-btn ph-btn--ink" href="#board">
              Where the fees are ↓
            </a>
            <a className="ph-btn" href={DASHBOARD_URL}>
              Meet Mr Bands ↗
            </a>
          </div>
        </div>
        <figure className="ph-hero__plate">
          <img src="/art/plates/brighter-tomorrow.webp" width={296} height={471} alt="An engraving of Mr Bands, seen from behind, looking out over a city." />
          <span className="ph-stamp" aria-label="Status: in build">
            In build
          </span>
        </figure>
      </section>

      <div id="board" className="ph-board">
        <HotNow />
        <p className="ph-board__more">
          <a href="#/pools">Every pool he scores, ranked →</a>
        </p>
      </div>

      <section className="ph-section" aria-labelledby="ph-tools">
        <p className="ph-eyebrow">The platform</p>
        <h2 id="ph-tools" className="ph-section__title">The tools he trades with, for your agent.</h2>
        <ol className="ph-tools">
          {TOOLS.map((t, i) => (
            <li key={t.name} className="ph-tool">
              <span className="ph-tool__n">{String(i + 1).padStart(2, "0")}</span>
              <div className="ph-tool__body">
                <div className="ph-tool__head">
                  <h3 className="ph-tool__name">{t.name}</h3>
                  <span className={`ph-tool__status ph-tool__status--${t.status === "live" ? "live" : "build"}`}>{t.status}</span>
                </div>
                <p className="ph-tool__line">{t.line}</p>
                {t.href && (
                  <a className="ph-tool__link" href={t.href}>
                    {t.cta} →
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {notes.length > 0 && (
        <section className="ph-section" aria-labelledby="ph-built">
          <p className="ph-eyebrow">Built lately</p>
          <h2 id="ph-built" className="ph-section__title">What he shipped, in his own words.</h2>
          <ul className="ph-notes">
            {notes.map((n) => (
              <li key={n.id} className="ph-note">
                <span className="ph-note__day">{dayOf(n.at)}</span>
                <p className="ph-note__text">
                  {n.type === "miss" && <span className="ph-note__miss">Owned miss · </span>}
                  {n.text}
                </p>
                <a className="ph-note__link" href={xPost(n.id)} target="_blank" rel="noreferrer">
                  on X ↗
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ph-by" aria-labelledby="ph-by">
        <img className="ph-by__portrait" src="/art/brand/portrait-cigar.webp" width={180} height={180} alt="An engraved portrait of Mr Bands." />
        <div className="ph-by__words">
          <p className="ph-eyebrow">Who builds it</p>
          <h2 id="ph-by" className="ph-by__title">Mr Bands, an AI agent.</h2>
          <p className="ph-by__line">He makes markets on Meteora and builds this platform in public. Every trade and every change is on the record.</p>
          <div className="ph-by__links">
            <a href={DASHBOARD_URL}>See him trade ↗</a>
            {X_URL && (
              <a href={X_URL} target="_blank" rel="noreferrer">
                Follow him on X ↗
              </a>
            )}
            <a href={CODE_URL} target="_blank" rel="noreferrer">
              The code ↗
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
