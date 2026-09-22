import type { AgentRecord, DayRow, FlowTotals, Status } from "./model";

/**
 * The note at the top of the page, written from the numbers: what a person at the desk would say
 * if you asked how it's going. Plain sentences, rounded the way people round, days named the way
 * people name them. Every figure is the record's; nothing is invented, and a quiet day says so.
 * Pure.
 */
export interface Narrative {
  /** one sentence: up, down or flat, and since when */
  headline: string;
  /** two to four sentences: fees, the day that mattered, today, and what kind of run this is */
  story: string[];
}

/** 35.01 -> "35", 6.42 -> "6.4", 0.4321 -> "0.43": the precision a person uses out loud. */
export function num(x: number): string {
  const a = Math.abs(x);
  if (a >= 100) return Math.round(a).toString();
  if (a >= 10) return a.toFixed(1).replace(/\.0$/, "");
  if (a >= 1) return a.toFixed(1);
  if (a >= 0.01) return a.toFixed(2);
  return a.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);
const daysBetween = (date: string, now: number) => Math.round((Date.parse(`${utcDate(now)}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400e3);

/** "today", "yesterday", "Monday" inside the week, else "Sep 15". The journal's days are UTC days. */
export function dayWord(date: string, now: number): string {
  const d = daysBetween(date, now);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  const dt = new Date(`${date}T00:00:00Z`);
  if (d <= 6) return WEEKDAY[dt.getUTCDay()];
  return `${MONTH[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

/** "since Sunday", "since yesterday", "since Sep 14", "today" */
export function sinceWord(t: number, now: number): string {
  const w = dayWord(utcDate(t), now);
  return w === "today" ? "today" : `since ${w}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const upDown = (x: number, flatBelow = 0.05) => (x >= flatBelow ? "up" : x <= -flatBelow ? "down" : "flat");

const MODE_SENTENCE: Record<Status["mode"], string> = {
  paper: "This is paper: real pools, a pretend wallet.",
  "dry-run": "This is a rehearsal: real pools, a wallet that sends nothing.",
  live: "This is his own wallet on Solana.",
  demo: "This is a scripted demo: no wallet, no money.",
};

export function narrativeOf(o: { record: AgentRecord | null; status: Status; agentName: string; now: number; flow?: FlowTotals | null; bandsOpen?: number; atWorkSol?: number }): Narrative {
  const { record, status, agentName, now } = o;
  if (!record) return { headline: "Reading the journal.", story: [MODE_SENTENCE[status.mode]] };
  const dir = upDown(record.net);
  const headline = dir === "flat" ? `${agentName} is about flat ${sinceWord(record.startTs, now)}.` : `${agentName} is ${dir} ${num(record.net)} SOL ${sinceWord(record.startTs, now)}.`;

  const story: string[] = [];
  const fees = record.feesRealized + record.feesUnclaimed;
  const elapsedDays = (now - record.startTs) / 86400e3;
  const bands = o.bandsOpen ?? 0;
  const atWork = o.atWorkSol ?? record.atWork;
  if (bands > 0 && atWork > 0) story.push(`He has ${num(atWork)} SOL at work in ${bands} band${bands === 1 ? "" : "s"}.`);
  if (fees >= 0.0005) {
    const span = elapsedDays < 1.5 ? "since he started" : `over ${Math.round(elapsedDays)} days`;
    const where = record.feesRealized < 0.0005 && record.feesUnclaimed >= 0.0005 ? ", still in the bands" : "";
    story.push(`He has earned ${num(fees)} SOL in fees ${span}${where}.`);
  } else {
    story.push("He has not earned a fee yet.");
  }
  // The scout reads each pool's own account now: its fee counters are exact, its "swaps" are polls in which they
  // moved and its volume is an estimate, so the story quotes the fees and nothing else. The bins-he-covers figure
  // is left out: the scout applies today's band to the whole hour, which overstates it after a re-lay.
  if (o.flow && o.flow.fees60mSol > 0) {
    const f = o.flow;
    story.push(`In the last hour his ${f.pools === 1 ? "pool" : `${f.pools} pools`} paid ${num(f.fees60mSol)} SOL in fees to their market makers.`);
  }


  const days: DayRow[] = record.days.filter((d) => Number.isFinite(d.open) && Number.isFinite(d.close));
  const change = (d: DayRow) => d.close - d.open;
  const worst = days.length ? days.reduce((w, d) => (change(d) < change(w) ? d : w)) : null;
  const today = days.find((d) => daysBetween(d.date, now) <= 0) ?? null;
  if (worst && change(worst) <= -1) {
    const lost = -(change(worst) - worst.fees);
    const when = cap(dayWord(worst.date, now));
    story.push(
      lost > 0.5
        ? `${when} cost ${num(-change(worst))} SOL: ${num(worst.fees)} earned in fees, ${num(lost)} lost to the price.`
        : `${when} cost ${num(-change(worst))} SOL.`,
    );
  }
  if (today && today !== worst) {
    const c = change(today);
    const d = upDown(c);
    if (today.fees >= 0.005 || d !== "flat") {
      story.push(`Today he banked ${num(today.fees)} SOL of fees and the book is ${d === "flat" ? "about where it opened" : `${d} ${num(c)}`}.`);
    } else {
      story.push("Today is quiet: nothing claimed, the book about where it opened.");
    }
  }
  story.push(MODE_SENTENCE[status.mode]);
  return { headline, story };
}
