import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
