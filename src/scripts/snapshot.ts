/**
 * Snapshot the book, the limits, what he learned and the market data into web/public so a static host
 * (Vercel) can serve them. Which book, if any, is SNAPSHOT_BOOK (src/publish/snapshot.ts): none unless set,
 * and a real book only while it is current, so the sites carry only the real-money record.
 *   npm run web:snapshot
 *   SNAPSHOT_BOOK=none|real|paper  REAL_DATA_DIR=data-mainnet  LEARNED_DATA_DIR=data-mainnet  SNAPSHOT_OUT=web/public
 *
 * A plain shell (SNAPSHOT_BOOK unset) is refused while the real book is being traded: on 25 Sep 2026 two hand-run
 * deploys from one shipped an empty book and the 14 Sep board from data/ over a live band. The board (screen.json,
 * hot.json) is the freshest copy of this shell's DATA_DIR and REAL_DATA_DIR, never an older one over a newer.
 */
import path from "node:path";
import { config } from "../config";
import { loadHot } from "../hot";
import { loadScreen } from "../screener";
import { freshest, plainShellRefusal, realBookNewestTs, snapshotBook, writeSnapshot } from "../publish/snapshot";

const cwd = process.cwd();
const at = (v: string | undefined, fallback: string): string => path.resolve(cwd, (v ?? "").trim() || fallback);
const shown = (p: string): string => (path.relative(cwd, p).startsWith("..") ? p : path.relative(cwd, p) || ".");
const book = snapshotBook(process.env);
const out = at(process.env.SNAPSHOT_OUT, "web/public");
const realDir = at(process.env.REAL_DATA_DIR, "data-mainnet");
const learnedDir = at(process.env.LEARNED_DATA_DIR, "data-mainnet");

const refusal = plainShellRefusal(process.env, realBookNewestTs(realDir), Date.now(), shown(realDir));
if (refusal) {
  console.error(refusal);
  process.exit(2);
}

// the board: this shell's DATA_DIR and the real desk's, the newer stamp wins per file
const boardDirs = [...new Set([config.dataDir, shown(realDir)])];
const screenPick = freshest(boardDirs.map((dir) => ({ dir, file: loadScreen(dir) })));
const hotPick = freshest(boardDirs.map((dir) => ({ dir, file: loadHot(dir) })));
const screen = screenPick?.file ?? null;
const hot = hotPick?.file ?? null;
const stamp = (t: number | null) => (t === null ? "no stamp" : `${new Date(t).toISOString().slice(11, 16)}Z ${new Date(t).toISOString().slice(0, 10)}`);
const talkDir = at(process.env.TALK_STATE_PATH, "data-talk");
const r = writeSnapshot({ out, book, realDir, learnedDir, liveEnvFile: path.resolve(cwd, "ops/live.env"), screen, hot, talkDir });

const from = r.staleReal ? `no book (REAL_DATA_DIR=${shown(realDir)} is not current: newest ${r.staleReal})` : r.book === "none" ? "no book" : book === "real" ? `REAL_DATA_DIR=${shown(realDir)}` : `DATA_DIR=${config.dataDir}`;
console.log(`snapshot: SNAPSHOT_BOOK=${book}${r.book !== book ? ` -> ${r.book}` : ""}: ${r.entries} entries from ${from} (newest ${r.newest ?? "none"}), equity ${r.points} points, limits max position ${r.limits.maxPositionSol} SOL -> ${shown(out)}`);
console.log(
  `snapshot: learned from ${shown(learnedDir)} (${r.learned.mode}): ${r.learned.factors.length} knobs, ${r.learned.changes.length} changes, ${r.learned.lessons.total} lessons${r.learned.frozen.all ? ", frozen" : ""}; ` +
    `screen -> ${screen && screenPick ? `${screen.rankedPools} pools (${screenPick.dir}, ${stamp(screenPick.at)})` : "none"}, hot -> ${hot && hotPick ? `${hot.rows.length} rows (${hotPick.dir}, ${stamp(hotPick.at)})` : "none"}`,
);
