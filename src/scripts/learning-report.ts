/**
 * WHAT HE LEARNED, from the files alone.
 *   npm run learning                          both books: data-live (paper) and data-mainnet (the real-money run)
 *   npm run learning -- data-live             one book
 *   npm run learning -- --pool <address>      that pool's memory and its last five closes too
 *   npm run learning -- --at 2026-09-15T18:00Z   read the books as of that moment, not now: the decay
 *                                                and the 48h pool window are both clocks, and this is
 *                                                how you check what he would have known at the time
 *
 * It reads and prints. It never writes a file, never changes a knob and never touches the desk, so it is
 * safe to run against a live data dir while the desk is trading. Everything it prints comes out of
 * src/learn/view.ts, which is the same view /api/status, the site panel and bands_lessons read: if the
 * page and this disagree, one of them has a bug and the files are the referee.
 *
 * This is where the ratio lives. "A median 0.40 of forecast" was a sentence in docs/sprint.md that no
 * code recomputed; now it is a number with an n beside it that moves when the book moves.
 */
import path from "node:path";
import { FEE_SHARE_DEFAULT, PENALTY_RUNGS, learnEnv } from "../desk/learning";
import { LESSONS_FILE, readLessons, type Lesson } from "../learn/lessons";
import { clearLearnedCache, learnedLines, learnedView } from "../learn/view";

const args = process.argv.slice(2);
const poolArg = (() => {
  const i = args.indexOf("--pool");
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
})();
const atArg = (() => {
  const i = args.indexOf("--at");
  if (i < 0 || !args[i + 1]) return undefined;
  const t = Date.parse(args[i + 1]);
  if (!Number.isFinite(t)) {
    console.error(`--at ${args[i + 1]}: not a date`);
    process.exit(1);
  }
  return { raw: args[i + 1], t };
})();
const now = atArg ? atArg.t : Date.now();
const dirs = args.filter((a) => !a.startsWith("--") && a !== poolArg && a !== atArg?.raw);
const books = dirs.length ? dirs : [process.env.DATA_DIR ?? "data-live", "data-mainnet"];

const modesIn = (lessons: readonly Lesson[]): string[] => {
  const seen = new Map<string, number>();
  for (const l of lessons) seen.set(l.mode ?? "live", (seen.get(l.mode ?? "live") ?? 0) + 1);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
};

let printed = 0;
if (atArg) console.log(`reading both books as of ${new Date(now).toISOString()}`);
for (const dir of books) {
  const resolved = path.resolve(process.cwd(), dir);
  const lessons = readLessons(path.join(resolved, LESSONS_FILE));
  if (lessons.length === 0) {
    console.log(`\n${dir}: no lessons on record (${path.join(dir, LESSONS_FILE)})`);
    continue;
  }
  for (const mode of modesIn(lessons)) {
    clearLearnedCache();
    const v = learnedView(resolved, mode, poolArg, process.env, now, 0);
    if (v.lessonsTotal === 0) continue;
    printed++;
    console.log(`\n=== ${dir} (${mode})`);
    for (const line of learnedLines(v)) console.log(line);
  }
}

// the bounds printed here are the DESK's own (src/desk/learning.ts), because those are the ones that
// bind: a report that quoted a second set of numbers would be quoting a learner nothing runs
const le = learnEnv(process.env);
console.log(`\nA change needs ${le.calMinN} closed seats in the lane, moves at most ${le.calStep} and waits ${Math.round(le.minGapMs / 60_000)} min between steps.`);
console.log(`The factor is clamped to [${le.calMin}, ${le.calMax}]: the shipped ${FEE_SHARE_DEFAULT} is the ceiling, so calibration only ever refuses more seats.`);
console.log(`A pool's seat multiple steps one rung at a time down to ${PENALTY_RUNGS[PENALTY_RUNGS.length - 1]} and never above 1, and no learner may touch a risk limit.`);
if (printed === 0) console.log("Nothing to report: no book on this machine has a closed seat yet.");
