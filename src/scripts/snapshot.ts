/**
 * Snapshot the journal, the limits and what he learned into web/public so a static host (Vercel)
 * can serve them.
 *   npm run web:snapshot
 */
import fs from "node:fs";
import path from "node:path";
import { config, riskLimits } from "../config";
import { readEquity, readRecent } from "../journal";
import { loadHot } from "../hot";
import { loadScreen } from "../screener";
import { learningReport } from "../server";

const out = path.resolve(process.cwd(), "web/public");
fs.mkdirSync(out, { recursive: true });
const entries = readRecent(600);
fs.writeFileSync(path.join(out, "journal.json"), JSON.stringify({ entries, generatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(out, "limits.json"), JSON.stringify(riskLimits, null, 2));
// the equity history: one small point a cycle, the whole run (src/journal EquityPoint)
const equity = readEquity(20_000);
fs.writeFileSync(path.join(out, "equity.json"), JSON.stringify({ points: equity, generatedAt: new Date().toISOString() }));
const screen = loadScreen();
if (screen) fs.writeFileSync(path.join(out, "screen.json"), JSON.stringify(screen));
const hot = loadHot();
if (hot) fs.writeFileSync(path.join(out, "hot.json"), JSON.stringify(hot));
// What he learned: the SAME view /api/status serves (src/server.ts learningReport), written as a
// static file because the site reads snapshots, not the API. The panel and the API cannot disagree.
const learned = learningReport();
fs.writeFileSync(path.join(out, "learned.json"), JSON.stringify(learned));
// Say where the journal came from: a shell with DATA_DIR=data snapshots the demo journal over the desk's (2026-09-16).
const newest = entries[0];
console.log(`snapshot: ${learned.factors.length} knobs, ${learned.changes.length} changes and ${learned.lessons.total} lessons -> web/public/learned.json (${learned.mode}${learned.frozen.all ? ", frozen" : ""})`);
console.log(`snapshot: ${entries.length} entries from DATA_DIR=${config.dataDir} (newest ${newest ? `${newest.mode} ${newest.ts}` : "none"}) -> web/public/journal.json, equity -> ${equity.length} points, limits -> web/public/limits.json, screen -> ${screen ? `${screen.rankedPools} pools` : "none"}, hot -> ${hot ? `${hot.rows.length} rows` : "none"}`);
