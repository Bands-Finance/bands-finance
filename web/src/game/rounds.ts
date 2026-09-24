/**
 * Where a stall round's hours come from. The panel (LpRound.tsx) draws whatever frames arrive and knows nothing else.
 * Both deal a random 48-hour stretch of the pool's real hourly history where it has one (a Market), and a simulated
 * path where it doesn't; which stretch is told only with the score.
 *   offline: the round runs here, on a local seed and history read from here, revealed one hour per ROUND_TICK_MS;
 *            the score is local, and every round is practice.
 *   online:  the room server deals the seed, keeps the path to itself and streams each hour as its clock reaches it.
 *            A staked round is committed at the lay (width, centre, stake, hold) and settles at its hold whatever
 *            happens; a close only skips to the end. A practice round settles at a close, at the last hour sent.
 *            Nobody sees the future, and knowing it changes nothing a stake pays.
 * A round rides on the server whether or not its panel is open: stop() (the panel closed) only stops listening, and
 * resume() (the panel opened again) listens on. The page keeps the riding round (LiveRound) meanwhile.
 */
import { candlesOf, historyUrls, MARKET_HOURS, marketWindow, seriesOf, simulate, TICKS, type History, type Market, type PoolParams } from "./lpGame";
import { MAX_STAKE, MIN_STAKE, RAKE_PCT, ROUND_TICK_MS, ROUNDS_PER_DAY } from "./protocol";
import { usd } from "./money";
import type { ExchangeNet } from "./net";

export interface Laid {
  roundId: string;
  lower: number;
  upper: number;
  tickMs: number;
  /** the hours are a real stretch of the pool's history (undefined: a room server too old to say) */
  real?: boolean;
  /** the dollars staked (0: practice) and the stall's cut, taken with the stake at the lay */
  stake: number;
  rake: number;
  /** the hour the round settles at: one of HOLDS for a staked round, TICKS for practice (which may close sooner) */
  hold: number;
}

/** one hour of a round, as it happens */
export interface Frame {
  i: number;
  p: number;
  feesPct: number;
  valuePct: number;
  holdPct: number;
  inRange: boolean;
}

export interface Score {
  pct: number;
  rank: number | null;
  /** the hour the round settled at (undefined: a room server too old to say) */
  at?: number;
  /** a real round: when its stretch of history began (unix seconds) */
  from?: number;
  /** a staked round: the dollars staked, and what came back to the stack */
  stake?: number;
  back?: number;
}

/** the round riding on the room server, as the page keeps it whether or not a stall panel is open */
export interface LiveRound {
  roundId: string;
  /** the pool it was laid on */
  label: string;
  address: string;
  laid: Laid;
  /** the hours so far */
  frames: Frame[];
}

export interface RoundSource {
  /**
   * lay a band, staking dollars from the stack (0: practice; offline rounds are always practice) to ride `hold` hours;
   * frames and the score arrive through the callbacks
   */
  start(pool: PoolParams, widthBins: number, offsetBins: number, stake: number, hold: number, onFrame: (f: Frame) => void, onScore: (s: Score) => void): Promise<Laid>;
  /** a practice round: settle now; a staked round: skip to the end */
  close(roundId: string): void;
  /** listen on to a round already riding (the panel was closed and opened again) */
  resume(roundId: string, onFrame: (f: Frame) => void, onScore: (s: Score) => void): void;
  /** stop listening (the panel closed); a round on the server rides on */
  stop(): void;
}

/** the room's worst case for a lay: a cold board read (8 s) and a cold history read (6 s), and a little over */
const LAY_WAIT_MS = 16_000;

/** pools' hourly histories read from here, kept 20 minutes (a failed read, 2), so a replay doesn't read them again */
const histories = new Map<string, { at: number; history: History | null }>();

async function historyOf(pool: PoolParams): Promise<History | null> {
  const urls = historyUrls(pool);
  if (!urls) return null;
  const h = histories.get(pool.address);
  if (h && Date.now() - h.at < (h.history ? 20 : 2) * 60_000) return h.history;
  const read = async (url: string) => {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
    return res.ok ? candlesOf(await res.json()) : null;
  };
  let history: History | null = null;
  try {
    const [price, volume] = await Promise.all([read(urls.price), read(urls.volume)]);
    if (price && volume) history = { price, volume };
  } catch {
    history = null;
  }
  histories.set(pool.address, { at: Date.now(), history });
  return history;
}

/** a random stretch of the pool's history long enough for a round, or null */
async function marketOf(pool: PoolParams): Promise<Market | null> {
  const series = seriesOf(await historyOf(pool));
  if (series.length < MARKET_HOURS) return null;
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return marketWindow(series, a[0] % (series.length - MARKET_HOURS + 1), pool);
}

/** a round played here: the whole path is computed, and revealed an hour at a time */
export function offlineSource(): RoundSource {
  let timer = 0;
  let closeFn: (() => void) | null = null;
  return {
    async start(pool, widthBins, offsetBins, _stake, _hold, onFrame, onScore) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      const seed = a[0];
      const market = await marketOf(pool);
      const sim = simulate(pool, seed, { widthBins, offsetBins }, market);
      const roundId = `local-${seed}`;
      let i = 0;
      const finish = () => {
        window.clearInterval(timer);
        closeFn = null;
        const at = Math.max(1, i);
        onScore({ pct: simulate(pool, seed, { widthBins, offsetBins, closeAt: at }, market).scorePct, rank: null, at, from: market?.from });
      };
      closeFn = finish;
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        i += 1;
        onFrame({ i, p: sim.path[i], feesPct: sim.feesPct[i], valuePct: sim.valuePct[i], holdPct: sim.holdPct[i], inRange: sim.inRange[i] });
        if (i >= TICKS) finish();
      }, ROUND_TICK_MS);
      return { roundId, lower: sim.lower, upper: sim.upper, tickMs: ROUND_TICK_MS, real: market !== null, stake: 0, rake: 0, hold: TICKS };
    },
    close() {
      closeFn?.();
    },
    resume() {
      /* nothing rides here once the panel is closed: stop() ended the round */
    },
    stop() {
      window.clearInterval(timer);
      closeFn = null;
    },
  };
}

/** a round the room server deals, streams and scores */
export function onlineSource(net: ExchangeNet, route: RoundRoutes): RoundSource {
  /** the round this panel is listening to */
  let current: string | null = null;
  /** a lay waiting on the room: cleared by the answer, the refusal, the timer, or stop() (so nothing of it outlives the panel) */
  let pending: { address: string; timer: number; refused: (why: string) => void } | null = null;
  const clearPending = () => {
    if (!pending) return;
    window.clearTimeout(pending.timer);
    route.laid.delete(pending.address);
    if (route.refused === pending.refused) route.refused = null;
    pending = null;
  };
  const listen = (roundId: string, onFrame: (f: Frame) => void, onScore: (s: Score) => void) => {
    current = roundId;
    route.frames.set(roundId, onFrame);
    route.scores.set(roundId, (s) => {
      route.frames.delete(roundId);
      route.scores.delete(roundId);
      current = null;
      onScore(s);
    });
  };
  return {
    start(pool, widthBins, offsetBins, stake, hold, onFrame, onScore) {
      return new Promise<Laid>((resolve, reject) => {
        clearPending();
        const timer = window.setTimeout(() => {
          clearPending();
          reject(new Error("The Exchange didn't answer. Try again in a moment."));
        }, LAY_WAIT_MS);
        // a refusal (a bad stake, no rounds left, an unknown pool) ends the wait at once
        const refused = (why: string) => {
          clearPending();
          reject(new Error(REFUSALS[why] ?? "The Exchange refused that band. Try again."));
        };
        pending = { address: pool.address, timer, refused };
        route.refused = refused;
        route.laid.set(pool.address, (laid) => {
          clearPending();
          listen(laid.roundId, onFrame, onScore);
          resolve(laid);
        });
        // lay by address: two board rows can share a label, and the room prefers an address match
        if (!net.lay(pool.address, widthBins, offsetBins, stake, hold)) {
          clearPending();
          reject(new Error("The Exchange is offline. Try again in a moment."));
        }
      });
    },
    close(roundId) {
      net.closeRound(roundId);
    },
    resume(roundId, onFrame, onScore) {
      listen(roundId, onFrame, onScore);
    },
    stop() {
      clearPending();
      // a round on the server rides on (a staked one settles at its hold; the page closes a practice one it walks away from)
      if (current) {
        route.frames.delete(current);
        route.scores.delete(current);
        current = null;
      }
    },
  };
}

/** the page's switchboard: the net's callbacks look up the round they belong to here */
export interface RoundRoutes {
  /** a lay waiting on the room, by the pool's address */
  laid: Map<string, (l: Laid) => void>;
  frames: Map<string, (f: Frame) => void>;
  scores: Map<string, (s: Score) => void>;
  /** a lay waiting on the room: told when the room refuses it */
  refused: ((why: string) => void) | null;
}

export const newRoutes = (): RoundRoutes => ({ laid: new Map(), frames: new Map(), scores: new Map(), refused: null });

/** the room's refusals of a lay, in words (the limits from protocol.ts, never written out) */
export const REFUSALS: Record<string, string> = {
  "bad stake": `That stake doesn't fit your stack. Stake ${usd(MIN_STAKE)} to ${usd(MAX_STAKE)}, with the stall's ${RAKE_PCT}% on top.`,
  "no rounds left": `That's all ${ROUNDS_PER_DAY} staked rounds for today. Practice rounds are still open, and the count starts again at midnight UTC.`,
  "round in play": "Your band is still riding. Lay again when it settles.",
  "unknown pool": "That pool just left the board. Pick another stall.",
  "board unavailable": "The Exchange can't read the board right now. Try again in a moment.",
  "bad choice": "That band can't be laid. Try another width, centre or hold.",
  "practice only": "This pool is too new to stake on: a staked band needs two days of its real hours. Practise here, or stake at another stall.",
};

/** errors that belong to a lay (the rest are the page's) */
export const isLayRefusal = (why: string): boolean => why in REFUSALS;
