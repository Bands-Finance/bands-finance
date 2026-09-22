/**
 * Snapshot the book, the limits, what he learned and the market data into web/public so a static host
 * (Vercel) can serve them. Which book, if any, is SNAPSHOT_BOOK (src/publish/snapshot.ts): a paper desk
 * ships none, so the sites carry only the real-money record.
 *   npm run web:snapshot
 *   SNAPSHOT_BOOK=none|real|paper  REAL_DATA_DIR=data-mainnet  LEARNED_DATA_DIR=data-mainnet  SNAPSHOT_OUT=web/public
 */
import path from "node:path";
import { config } from "../config";
import { loadHot } from "../hot";
import { loadScreen } from "../screener";
import { snapshotBook, writeSnapshot } from "../publish/snapshot";

const cwd = process.cwd();
const at = (v: string | undefined, fallback: string): string => path.resolve(cwd, (v ?? "").trim() || fallback);
const shown = (p: string): string => (path.relative(cwd, p).startsWith("..") ? p : path.relative(cwd, p) || ".");
const book = snapshotBook(process.env, config.dryRun);
const out = at(process.env.SNAPSHOT_OUT, "web/public");
const realDir = at(process.env.REAL_DATA_DIR, "data-mainnet");
const learnedDir = at(process.env.LEARNED_DATA_DIR, "data-mainnet");
const screen = loadScreen();
const hot = loadHot();
const r = writeSnapshot({ out, book, realDir, learnedDir, liveEnvFile: path.resolve(cwd, "ops/live.env"), screen, hot });

const from = book === "none" ? "no book" : book === "real" ? `REAL_DATA_DIR=${shown(realDir)}` : `DATA_DIR=${config.dataDir}`;
console.log(`snapshot: SNAPSHOT_BOOK=${book}: ${r.entries} entries from ${from} (newest ${r.newest ?? "none"}), equity ${r.points} points, limits max position ${r.limits.maxPositionSol} SOL -> ${shown(out)}`);
console.log(`snapshot: learned from ${shown(learnedDir)} (${r.learned.mode}): ${r.learned.factors.length} knobs, ${r.learned.changes.length} changes, ${r.learned.lessons.total} lessons${r.learned.frozen.all ? ", frozen" : ""}; screen -> ${screen ? `${screen.rankedPools} pools` : "none"}, hot -> ${hot ? `${hot.rows.length} rows` : "none"}`);
