/**
 * Write web/public/history.json (src/publish/gameHistory.ts): the stall pools' hourly history for the Exchange's room
 * server, read from GeckoTerminal here because the Worker can't. Runs in web:deploy after the snapshot (which writes
 * the hot.json it reads). Always exits 0: a publish never fails on the game.
 *   npm run game:history        SNAPSHOT_OUT=web/public
 */
import fs from "node:fs";
import path from "node:path";
import { loadHistoryFile, refreshHistory, writeHistoryFile } from "../publish/gameHistory";

const out = path.resolve(process.cwd(), (process.env.SNAPSHOT_OUT ?? "").trim() || "web/public");
const file = path.join(out, "history.json");

(async () => {
  try {
    const hot = JSON.parse(fs.readFileSync(path.join(out, "hot.json"), "utf8"));
    const r = await refreshHistory({ hot, previous: loadHistoryFile(file), log: (l) => console.log(l) });
    writeHistoryFile(file, r.file);
  } catch (err) {
    console.log(`history: skipped (${(err as Error).message.slice(0, 120)})`);
  }
})();
