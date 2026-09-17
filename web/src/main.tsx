import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import DashboardApp from "./DashboardApp";
import { SITE } from "./site";
import "./styles/global.css";
import "./styles.css";

// Stale-chunk guard: after a deploy an old tab may hold references to hashed files that no longer exist.
window.addEventListener("unhandledrejection", (ev) => {
  const msg = String((ev.reason as Error | undefined)?.message ?? ev.reason ?? "");
  if (/Failed to fetch dynamically imported module|Importing a module script failed/.test(msg)) {
    try {
      if (!sessionStorage.getItem("bands:reloaded")) {
        sessionStorage.setItem("bands:reloaded", "1");
        location.reload();
      }
    } catch {
      /* ignore */
    }
  }
});

// One codebase, two sites (src/site.ts): the platform, or just Mr Bands at work.
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {SITE === "dashboard" ? <DashboardApp /> : <App />}
  </React.StrictMode>,
);
