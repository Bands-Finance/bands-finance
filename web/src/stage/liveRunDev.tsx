// Dev only (web/live-run-dev.html): the live-run chapter alone, inside the real Journey and its desk, for looking at
// it (and shooting it) without the rest of the page. A stub first beat stands in for the hero: the journey sets the
// first beat as the page's h1, so the chapter under test renders exactly as it does after "record" in DashboardApp.
import React from "react";
import { createRoot } from "react-dom/client";
import { EngraveDefs } from "../brand/Engrave";
import { Journey, type Beat } from "./Journey";
import { liveRunBeat, useLiveRun } from "./LiveRun";
import "../styles/global.css";
import "../styles.css";
import "../components/Dash.css";

function Dev() {
  const run = useLiveRun();
  if (!run) return <p style={{ padding: 40 }}>Reading /live-run.json…</p>;
  const now = Date.now();
  const hero: Beat = { id: "hero", station: "hero", side: "left", eyebrow: "dev", line1: "The live run,", line2: "on its own." };
  return (
    <div className="dash">
      <EngraveDefs />
      <Journey beats={[hero, liveRunBeat(run, now, "paper")]} data={{ bands: [], feesSol: 0 }} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Dev />
  </React.StrictMode>,
);
