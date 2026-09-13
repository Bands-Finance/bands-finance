/**
 * The NYSE clock, computed in America/New_York (so DST is handled by the platform tz database).
 *
 *   pre      04:00-09:30 ET   Mon-Fri, not a holiday
 *   regular  09:30-16:00 ET   (09:30-13:00 on early-close days)
 *   after    16:00-20:00 ET   (13:00-17:00 on early-close days)
 *   closed   otherwise: nights, weekends, NYSE holidays
 *
 * These match Backpack's RFQ session names (US_EQUITIES_PRE_MARKET / _REGULAR / _POST_MARKET;
 * _OVERNIGHT is what we call "closed": the perps trade 24/7 but no NYSE print anchors them).
 *
 * Holidays are hard-coded per year (NYSE 2026 calendar, https://www.nyse.com/markets/hours-calendars);
 * extend the tables each December. Dates are ET calendar days.
 */

export type UsEquitySession = "closed" | "pre" | "regular" | "after";

/** Full-day NYSE closures. 2026 verified against the published calendar; 2027-01-01 added so New Year's week rolls over. */
export const NYSE_HOLIDAYS: Readonly<Record<string, string>> = {
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King Jr. Day",
  "2026-02-16": "Presidents' Day",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day (observed; July 4 is a Saturday)",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving Day",
  "2026-12-25": "Christmas Day",
  "2027-01-01": "New Year's Day",
};

/** 13:00 ET closes (after-hours then runs 13:00-17:00). */
export const NYSE_EARLY_CLOSES: Readonly<Record<string, string>> = {
  "2026-11-27": "Day after Thanksgiving",
  "2026-12-24": "Christmas Eve",
};

const PRE_OPEN_MIN = 4 * 60;
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const AFTER_END_MIN = 20 * 60;
const EARLY_CLOSE_MIN = 13 * 60;
const EARLY_AFTER_END_MIN = 17 * 60;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
  /** "YYYY-MM-DD" in ET */
  date: string;
  /** minutes since ET midnight */
  minuteOfDay: number;
  /** ET offset from UTC in minutes (-240 EDT, -300 EST) */
  offsetMin: number;
}

/** The wall clock in America/New_York for an instant. */
export function etParts(d: Date): EtParts {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) if (part.type !== "literal") p[part.type] = part.value;
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  const second = Number(p.second);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMin = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: Math.max(0, WEEKDAYS.indexOf(p.weekday)),
    date: `${p.year}-${p.month}-${p.day}`,
    minuteOfDay: hour * 60 + minute,
    offsetMin,
  };
}

function splitDate(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

/** "2026-09-13" + 1 -> "2026-09-14" (pure calendar arithmetic) */
export function addDays(date: string, days: number): string {
  const [y, m, d] = splitDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** The instant of an ET wall time (date "YYYY-MM-DD", minutes since midnight). Exact outside the 02:00 DST hour. */
export function etWallToUtc(date: string, minuteOfDay: number): Date {
  const [y, m, d] = splitDate(date);
  const guess = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  const off1 = etParts(new Date(guess)).offsetMin;
  const off2 = etParts(new Date(guess - off1 * 60_000)).offsetMin;
  return new Date(guess - off2 * 60_000);
}

export function isNyseTradingDay(date: string): boolean {
  const [y, m, d] = splitDate(date);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd !== 0 && wd !== 6 && !(date in NYSE_HOLIDAYS);
}

export interface SessionClock {
  session: UsEquitySession;
  /** ET calendar day, "YYYY-MM-DD" */
  etDate: string;
  /** "HH:MM" ET */
  etTime: string;
  weekday: string;
  tradingDay: boolean;
  holiday: string | null;
  earlyClose: string | null;
  /** minutes until the next regular-session open (09:30 ET on a trading day); 0 while the regular session is on */
  minutesToOpen: number;
  /** minutes since 09:30 ET; null outside the regular session */
  minutesSinceOpen: number | null;
  /** minutes until the regular close; null outside the regular session */
  minutesToClose: number | null;
  /** the next regular open, ISO */
  nextOpenAt: string;
}

/** The full NYSE clock for an instant. */
export function sessionClock(now: Date = new Date()): SessionClock {
  const p = etParts(now);
  const holiday = NYSE_HOLIDAYS[p.date] ?? null;
  const earlyClose = NYSE_EARLY_CLOSES[p.date] ?? null;
  const tradingDay = isNyseTradingDay(p.date);
  const closeMin = earlyClose ? EARLY_CLOSE_MIN : CLOSE_MIN;
  const afterEndMin = earlyClose ? EARLY_AFTER_END_MIN : AFTER_END_MIN;
  const m = p.minuteOfDay;

  let session: UsEquitySession = "closed";
  if (tradingDay) {
    if (m >= PRE_OPEN_MIN && m < OPEN_MIN) session = "pre";
    else if (m >= OPEN_MIN && m < closeMin) session = "regular";
    else if (m >= closeMin && m < afterEndMin) session = "after";
  }

  // next regular open: today at 09:30 if that is still ahead on a trading day, else the next trading day
  let date = tradingDay && m < OPEN_MIN ? p.date : addDays(p.date, 1);
  for (let i = 0; i < 14 && !isNyseTradingDay(date); i++) date = addDays(date, 1);
  const nextOpen = etWallToUtc(date, OPEN_MIN);
  const minutesToOpen = session === "regular" ? 0 : Math.max(0, Math.ceil((nextOpen.getTime() - now.getTime()) / 60_000));

  return {
    session,
    etDate: p.date,
    etTime: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
    weekday: WEEKDAYS[p.weekday],
    tradingDay,
    holiday,
    earlyClose,
    minutesToOpen,
    minutesSinceOpen: session === "regular" ? m - OPEN_MIN : null,
    minutesToClose: session === "regular" ? closeMin - m : null,
    nextOpenAt: nextOpen.toISOString(),
  };
}

/** "closed" | "pre" | "regular" | "after" for an instant. */
export function usEquitySession(now: Date = new Date()): UsEquitySession {
  return sessionClock(now).session;
}

/** Minutes until the next regular-session open; 0 while the regular session is on. */
export function minutesToOpen(now: Date = new Date()): number {
  return sessionClock(now).minutesToOpen;
}
