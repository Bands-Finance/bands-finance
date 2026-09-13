/**
 * Snapshot the journal and the limits into web/public so a static host (Vercel) can serve them.
 *   npm run web:snapshot
 */
import fs from "node:fs";
import path from "node:path";
import { riskLimits } from "../config";
import { readRecent } from "../journal";
import { loadHot } from "../hot";
import { loadScreen } from "../screener";

const out = path.resolve(process.cwd(), "web/public");
fs.mkdirSync(out, { recursive: true });
const entries = readRecent(600);
fs.writeFileSync(path.join(out, "journal.json"), JSON.stringify({ entries, generatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(out, "limits.json"), JSON.stringify(riskLimits, null, 2));
const screen = loadScreen();
if (screen) fs.writeFileSync(path.join(out, "screen.json"), JSON.stringify(screen));
const hot = loadHot();
if (hot) fs.writeFileSync(path.join(out, "hot.json"), JSON.stringify(hot));
console.log(`snapshot: ${entries.length} entries -> web/public/journal.json, limits -> web/public/limits.json, screen -> ${screen ? `${screen.rankedPools} pools` : "none"}, hot -> ${hot ? `${hot.rows.length} rows` : "none"}`);
