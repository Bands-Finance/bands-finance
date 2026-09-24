/**
 * THE MEMECOIN FLOOR: which non-stock tokens the desk may pick. Zach (2026-09-15): "when selecting
 * memecoins we should be selecting tokens in a higher range not on launch maybe about 1million
 * market cap".
 *
 * Replayed on the paper book's first day (2026-09-15) the two halves did different work:
 *   - the AGE floor (not on launch, 24h) would have kept the desk out of GOOGL, HUHCAT, CAT, NIKE and
 *     OpenAI, whose closed bands lost 12.7 SOL between them (GOOGL fell 86% in five minutes at 8.6h old);
 *   - the MARKET CAP floor ($1M) changes little on that day: every memecoin the desk entered was already
 *     above it except DJT, INDEX and CAT, which made a small profit;
 *   - tokens that clear both (baton, ALLINU, EMBER, ZCAT, STONK, LOOM) still lost 20 SOL, falling
 *     through their bands. The floor is a guardrail, not the answer to trend losses.
 *
 * Applied by the picker (src/index.ts pickPools) to every lane that can seat a memecoin: the hot list,
 * the screener board, the launch lane and the pump.fun pair lane. Tokenized stocks and the house token
 * are never judged by it. A token whose market cap or age nobody reported is refused while the
 * corresponding floor is on: the floor exists to keep out what cannot be checked.
 *
 * SUSTAINED HEAT, the one exemption (src/hot/sustained.ts). xHYPE/USDC, seated on 23 Sep only because its
 * cap was unreadable and a day of volume stood in, made most of the book's profit since, while CRACKER/SOL
 * paid over 0.3%/h on $117k for 25 of 48 hours and was refused every cycle at 98h old. A pool the desk's own
 * tape has watched pay for HOT_SUSTAINED_HOURS of the last HOT_SUSTAINED_WINDOW_HOURS is admitted past the
 * AGE line and the MARKET CAP line, an unknown cap included: twelve hours of fees on six figures of
 * liquidity are more evidence than a supply figure. It never stands in for a ceiling (too big is a
 * different question), never for STOCKS_ONLY, and never for a token in collapse (down 50% or more on the
 * day: a collapse day is a high-fee day, which is exactly the trap). The seat is smaller (HOT_SUSTAINED_SEAT,
 * applied in src/index.ts) and the stops are the desk's usual ones.
 *
 * The exemption has a hard age floor of its own, MEME_SUSTAINED_MIN_AGE_HOURS (24), and the age must be
 * KNOWN: a pool the desk cannot date is never seated on its tape. The day-one memecoins that lost 38.9 SOL
 * on 15 Sep were hours old. Twelve hot hours on the tape are evidence, but the tape starts when the watch
 * first sees a pool, which today is as young as 6h (HOT_MIN_AGE_HOURS keeps a young pool off the tradable
 * list, not off the tape), so twelve hot hours alone could seat an 18-hour-old coin at the top of its launch
 * curve. At the defaults (both 24h) the age line is never set aside and the exemption works on the cap line
 * alone; it sets the age line aside only where MEME_MIN_AGE_HOURS is raised above it (the 720h book that
 * refused CRACKER), and never below MEME_SUSTAINED_MIN_AGE_HOURS, so raising HOT_SUSTAINED_HOURS or lowering
 * MEME_MIN_AGE_HOURS can never put the desk back into launch-day coins by accident.
 *
 * Env: MEME_MIN_MARKET_CAP_USD (1000000; 0 = off), MEME_MAX_MARKET_CAP_USD (unset = no ceiling),
 * MEME_MIN_AGE_HOURS (24; 0 = off), MEME_SUSTAINED_MIN_AGE_HOURS (24; 0 = any known age), and through the
 * hot env HOT_SUSTAINED_HOURS (12; 0 = off) and HOT_SUSTAINED_MODE (on; shadow = the floor admits nothing
 * and the hot watch only logs). Pure.
 */
import { hotEnv } from "../hot/env";

export interface MemeFloorEnv {
  minMarketCapUsd: number;
  maxMarketCapUsd: number | null;
  minAgeHours: number;
  /** STOCKS_ONLY=true: the book is tokenized stocks and nothing else; every token that is not one is refused */
  stocksOnly?: boolean;
  /** HOT_SUSTAINED_HOURS: hot hours on the tape that stand in for the age and cap lines; 0 or absent = no exemption (0 in shadow mode) */
  sustainedMinHours?: number;
  /** MEME_SUSTAINED_MIN_AGE_HOURS: the youngest a pool may be and still be seated on its tape; absent = 0, and the age must be known either way */
  sustainedMinAgeHours?: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function memeFloorEnv(env: NodeJS.ProcessEnv = process.env): MemeFloorEnv {
  const max = (env.MEME_MAX_MARKET_CAP_USD ?? "").trim();
  const maxN = max === "" ? null : Number(max);
  const hot = hotEnv(env);
  return {
    minMarketCapUsd: Math.max(0, num(env.MEME_MIN_MARKET_CAP_USD, 1_000_000)),
    maxMarketCapUsd: maxN !== null && Number.isFinite(maxN) && maxN > 0 ? maxN : null,
    minAgeHours: Math.max(0, num(env.MEME_MIN_AGE_HOURS, 24)),
    // only the literal "true", like every switch that narrows what the desk may do
    stocksOnly: (env.STOCKS_ONLY ?? "").trim().toLowerCase() === "true",
    // the floor's copy of the exemption's threshold is 0 in shadow mode: the hot watch keeps counting and logging, the floor admits nothing
    sustainedMinHours: hot.sustainedMode === "on" ? hot.sustainedHours : 0,
    sustainedMinAgeHours: Math.max(0, num(env.MEME_SUSTAINED_MIN_AGE_HOURS, 24)),
  };
}

export interface MemeCandidate {
  symbol: string;
  marketCapUsd: number | null;
  /** hours since the pool (or the token's first pool) was created */
  ageHours: number | null;
  /** a tokenized stock: never judged by the memecoin floor */
  stock?: unknown;
  /** the house token (PAIR_HOUSE_MINTS): always seated, never judged */
  house?: boolean;
  /** the value of the pool's holdings of the token itself, USD (the quote side excluded): a cap far under it is not a reading */
  tokenSideUsd?: number | null;
  /** the pool's day of volume, USD: stands in for an unreadable market cap when it is at least the floor */
  volume24hUsd?: number | null;
  /** the token's day, percent: an unreadable cap never stands in for a token in collapse */
  priceChange24hPct?: number | null;
  /** hot hours on the fast watch's tape (src/hot/sustained.ts), from a row that QUALIFIES; null or absent when it does not */
  sustainedHours?: number | null;
}

const usd = (n: number): string => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `$${Math.round(n).toLocaleString("en-US")}`);

/** Which line refused the token: sustained heat stands in for "age" and "cap" and for nothing else. */
interface FloorRefusal {
  why: string;
  on: "stocks" | "age" | "cap" | "ceiling";
  /** the same reason without the symbol, for the admission note */
  short: string;
}

const collapsing = (c: MemeCandidate): boolean => typeof c.priceChange24hPct === "number" && c.priceChange24hPct <= -50;

/** The floor's own reading, before any exemption. */
function floorRefusal(c: MemeCandidate, env: MemeFloorEnv): FloorRefusal | null {
  if (c.stock || c.house) return null;
  // Every seat that is not a stock lane of its own comes through here (the screen, the hot watch, the seat
  // ranking), so this one line is what makes a stocks-only book stocks only.
  if (env.stocksOnly) return { why: `${c.symbol} is not a tokenized stock, and the book is stocks only (STOCKS_ONLY)`, on: "stocks", short: "not a tokenized stock" };
  if (env.minAgeHours > 0) {
    if (c.ageHours === null || !Number.isFinite(c.ageHours)) return { why: `${c.symbol}: age unknown, and the desk does not pick a memecoin it cannot date`, on: "age", short: "age unknown" };
    if (c.ageHours < env.minAgeHours) return { why: `${c.symbol} is ${c.ageHours.toFixed(1)}h old, under the ${env.minAgeHours}h memecoin floor: not on launch`, on: "age", short: `${c.ageHours.toFixed(1)}h old, under the ${env.minAgeHours}h floor` };
  }
  if (env.minMarketCapUsd > 0 || env.maxMarketCapUsd !== null) {
    if (c.marketCapUsd === null || !Number.isFinite(c.marketCapUsd) || c.marketCapUsd <= 0) return { why: `${c.symbol}: market cap unknown, and the desk does not pick a memecoin it cannot size`, on: "cap", short: "market cap unknown" };
    // A cap under what the pool itself holds of the token is not a reading: the supply cannot be smaller than one pool's
    // reserve of it (wXMR: $623 against thousands of dollars of wXMR in the pool and $1M of daily volume, a wrapped asset
    // the venue's supply figure cannot size). A day's volume of at least the floor stands in, on a token that is not
    // collapsing, and never for a ceiling, which no stand-in can judge. The pool's quote side is not counted.
    const unreadable = typeof c.tokenSideUsd === "number" && c.tokenSideUsd > 0 && c.marketCapUsd < c.tokenSideUsd;
    if (unreadable) {
      const reads = `market cap reads ${usd(c.marketCapUsd)}, under the ${usd(c.tokenSideUsd!)} of ${c.symbol} the pool holds, so it cannot be right`;
      if (env.maxMarketCapUsd !== null) return { why: `${c.symbol}: ${reads}, and a ceiling cannot be judged without it`, on: "ceiling", short: `${reads}, and a ceiling cannot be judged without it` };
      const falling = collapsing(c);
      if (typeof c.volume24hUsd === "number" && c.volume24hUsd >= env.minMarketCapUsd && !falling) return null;
      const standIn = `${falling ? `a token down ${Math.abs(c.priceChange24hPct!).toFixed(0)}% on the day` : c.volume24hUsd ? `${usd(c.volume24hUsd)} of daily volume` : "no volume figure"} ${falling ? "cannot" : "is too little to"} stand in for the ${usd(env.minMarketCapUsd)} floor`;
      return { why: `${c.symbol}: ${reads}, and ${standIn}`, on: "cap", short: `${reads}, and ${standIn}` };
    }
    if (c.marketCapUsd < env.minMarketCapUsd) return { why: `${c.symbol} is at ${usd(c.marketCapUsd)} market cap, under the ${usd(env.minMarketCapUsd)} memecoin floor`, on: "cap", short: `${usd(c.marketCapUsd)} market cap, under the ${usd(env.minMarketCapUsd)} floor` };
    if (env.maxMarketCapUsd !== null && c.marketCapUsd > env.maxMarketCapUsd) return { why: `${c.symbol} is at ${usd(c.marketCapUsd)} market cap, over the ${usd(env.maxMarketCapUsd)} memecoin ceiling`, on: "ceiling", short: `${usd(c.marketCapUsd)} market cap, over the ${usd(env.maxMarketCapUsd)} ceiling` };
  }
  return null;
}

export interface MemeVerdict {
  /** null when the token may be picked, else the reason in the desk's voice, naming the number */
  refusal: string | null;
  /** set when the token may be picked ONLY because of sustained heat: the admission, in the desk's voice, for the log and the seat */
  sustained: string | null;
}

/**
 * PURE. The floor's verdict with the exemption applied: a token the floor refused on its age or its market cap is
 * admitted when its tape shows at least sustainedMinHours hot hours (src/hot/sustained.ts), unless it is collapsing,
 * its age is unknown or under sustainedMinAgeHours, or a line the exemption does not cover (the ceiling) refuses it.
 * `sustained` names the admission so the picker can log it and size the seat down (HOT_SUSTAINED_SEAT).
 */
export function memeVerdict(c: MemeCandidate, env: MemeFloorEnv): MemeVerdict {
  const f = floorRefusal(c, env);
  if (!f) return { refusal: null, sustained: null };
  const min = env.sustainedMinHours ?? 0;
  const hot = min > 0 && typeof c.sustainedHours === "number" && Number.isFinite(c.sustainedHours) && c.sustainedHours >= min;
  if (!hot || (f.on !== "age" && f.on !== "cap")) return { refusal: f.why, sustained: null };
  const would = `${c.sustainedHours}h of sustained heat would stand in, but`;
  if (collapsing(c)) return { refusal: `${f.why}; ${would} a token down ${Math.abs(c.priceChange24hPct!).toFixed(0)}% on the day is in collapse`, sustained: null };
  // the exemption's own age floor: a known age of at least sustainedMinAgeHours, whichever line the floor refused on
  const minAge = env.sustainedMinAgeHours ?? 0;
  if (c.ageHours === null || !Number.isFinite(c.ageHours)) return { refusal: `${f.why}; ${would} never for a pool the desk cannot date`, sustained: null };
  if (c.ageHours < minAge) return { refusal: `${f.why}; ${would} not at ${c.ageHours.toFixed(1)}h old: a sustained-heat seat needs ${minAge}h`, sustained: null };
  // The lines the exemption does not cover are still judged: a pool refused on its age has not had its cap read yet,
  // and a ceiling is never stood in for, nor judged without a cap.
  const rest = floorRefusal(c, { ...env, minAgeHours: 0, minMarketCapUsd: 0 });
  if (rest && rest.on === "ceiling") return { refusal: `${f.why}; ${would} ${rest.short}`, sustained: null };
  if (rest && rest.on === "cap" && env.maxMarketCapUsd !== null) return { refusal: `${f.why}; ${would} a ceiling cannot be judged without a market cap`, sustained: null };
  return { refusal: null, sustained: `${c.symbol} admitted on sustained heat, ${c.sustainedHours} hot hours on the tape, though ${f.short}` };
}

/** PURE. Null when the token may be picked, else the reason in the desk's voice, naming the number. */
export const memeRefusal = (c: MemeCandidate, env: MemeFloorEnv): string | null => memeVerdict(c, env).refusal;

/**
 * PURE. The note a pool's seat is sized on when the process has no memory of admitting it (a restart): the floor's
 * verdict now, read with the seat in mind. An admission on sustained heat is its own note. A refusal on a pool that is
 * HELD means it was admitted on sustained heat and has since cooled, or, rarer, its cap fell under the floor while it
 * sat; either way the desk would not seat it today, so the seat stays the smaller one rather than growing to a full
 * seat on the next re-lay because nobody remembers why it was let in. Null when the floor admits the pool on its own,
 * and for a pool that is not held: a refusal there is the picker's business, and the seat question does not arise.
 */
export function sustainedSeatNote(v: MemeVerdict, held: boolean): string | null {
  if (v.sustained !== null) return v.sustained;
  if (held && v.refusal !== null) return `held on an admission the restart forgot; the floor refuses it today (${v.refusal})`;
  return null;
}

/**
 * The admission as memeVerdict writes it ("CRACKER admitted on sustained heat, 14 hot hours on the tape, though 98.2h
 * old, under the 720h floor"), cut to "CRACKER, 14 hot hours, though 98.2h old, under the 720h floor" for the floor
 * line, whose header already says "admitted on sustained heat (>= 12 hot hours on the tape)". Both shapes live in this
 * file; a note in another shape is left as it is.
 */
const shortAdmission = (note: string): string => note.replace(/^(\S+) admitted on sustained heat, (\d+) hot hours on the tape, though /, "$1, $2 hot hours, though ");

/**
 * A one-line summary of what the floor kept out this cycle and what it admitted on sustained heat, or null when
 * it did neither.
 */
export function memeFloorLine(refused: readonly string[], env: MemeFloorEnv, admitted: readonly string[] = []): string | null {
  if (!refused.length && !admitted.length) return null;
  const rule = [env.minAgeHours > 0 ? `>= ${env.minAgeHours}h old` : null, env.minMarketCapUsd > 0 ? `>= ${usd(env.minMarketCapUsd)} market cap` : null, env.maxMarketCapUsd !== null ? `<= ${usd(env.maxMarketCapUsd)}` : null].filter(Boolean).join(", ");
  const shown = refused.slice(0, 4).join("; ");
  const kept = refused.length ? `kept out ${refused.length}: ${shown}${refused.length > 4 ? `; and ${refused.length - 4} more` : ""}` : "kept out nothing";
  const let_in = admitted.length ? `; admitted on sustained heat (>= ${env.sustainedMinHours ?? 0} hot hours on the tape): ${admitted.map(shortAdmission).join("; ")}` : "";
  return `memecoin floor (${rule}) ${kept}${let_in}`;
}
