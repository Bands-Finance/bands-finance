/**
 * Where a stall round's hours come from. The panel (LpRound.tsx) draws whatever frames arrive and knows nothing else.
 * Both deal a random 48-hour stretch of the pool's real hourly history where it has one (a Market), and a simulated
 * path where it doesn't; which stretch is told only with the score.
 *   offline: the round runs here, on a local seed and history read from here, revealed one hour per ROUND_TICK_MS;
 *            the score is local.
 *   online:  the room server deals the seed, keeps the path to itself and streams each hour as its clock reaches it;
 *            a close is a message, scored by the server at the last hour it sent. Nobody sees the future, so the
 *            leaderboard cannot be gamed by replaying seeds.
 */
import { candlesOf, historyUrls, MARKET_HOURS, marketWindow, seriesOf, simulate, TICKS, type History, type Market, type PoolParams } from "./lpGame";
import { ROUND_TICK_MS } from "./protocol";
import type { ExchangeNet } from "./net";

export interface Laid {
  roundId: string;
  lower: number;
  upper: number;
  tickMs: number;
  /** the hours are a real stretch of the pool's history (undefined: a room server too old to say) */
  real?: boolean;
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
  /** a real round: when its stretch of history began (unix seconds) */
  from?: number;
  /** a staked round: the dollars staked, and what came back to the stack */
  stake?: number;
  back?: number;
}

export interface RoundSource {
  /** lay a band, staking dollars from the stack (0: practice; offline rounds are always practice); frames and the score arrive through the callbacks */
  start(pool: PoolParams, widthBins: number, offsetBins: number, stake: number, onFrame: (f: Frame) => void, onScore: (s: Score) => void): Promise<Laid>;
  close(roundId: string): void;
  /** stop listening (the panel closed) */
  stop(): void;
}

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
    async start(pool, widthBins, offsetBins, _stake, onFrame, onScore) {
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
        onScore({ pct: simulate(pool, seed, { widthBins, offsetBins, closeAt: at }, market).scorePct, rank: null, from: market?.from });
      };
      closeFn = finish;
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        i += 1;
        onFrame({ i, p: sim.path[i], feesPct: sim.feesPct[i], valuePct: sim.valuePct[i], holdPct: sim.holdPct[i], inRange: sim.inRange[i] });
        if (i >= TICKS) finish();
      }, ROUND_TICK_MS);
      return { roundId, lower: sim.lower, upper: sim.upper, tickMs: ROUND_TICK_MS, real: market !== null };
    },
    close() {
      closeFn?.();
    },
    stop() {
      window.clearInterval(timer);
      closeFn = null;
    },
  };
}

/** a round the room server deals, streams and scores */
export function onlineSource(net: ExchangeNet, route: RoundRoutes): RoundSource {
  let current: string | null = null;
  return {
    start(pool, widthBins, offsetBins, stake, onFrame, onScore) {
      return new Promise<Laid>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          route.laid.delete(pool.label);
          route.refused = null;
          reject(new Error("The Exchange didn't answer. Try again in a moment."));
        }, 10_000);
        // a refusal (a bad stake, no rounds left, an unknown pool) ends the wait at once
        route.refused = (why) => {
          window.clearTimeout(timer);
          route.laid.delete(pool.label);
          route.refused = null;
          reject(new Error(REFUSALS[why] ?? "The Exchange refused that band. Try again."));
        };
        route.laid.set(pool.label, (laid) => {
          window.clearTimeout(timer);
          route.refused = null;
          current = laid.roundId;
          route.frames.set(laid.roundId, onFrame);
          route.scores.set(laid.roundId, (s) => {
            route.frames.delete(laid.roundId);
            route.scores.delete(laid.roundId);
            current = null;
            onScore(s);
          });
          resolve(laid);
        });
        net.lay(pool.label, widthBins, offsetBins, stake);
      });
    },
    close(roundId) {
      net.closeRound(roundId);
    },
    stop() {
      if (current) {
        route.frames.delete(current);
        route.scores.delete(current);
      }
    },
  };
}

/** the page's switchboard: the net's callbacks look up the round they belong to here */
export interface RoundRoutes {
  laid: Map<string, (l: Laid) => void>;
  frames: Map<string, (f: Frame) => void>;
  scores: Map<string, (s: Score) => void>;
  /** a lay waiting on the room: told when the room refuses it */
  refused: ((why: string) => void) | null;
}

export const newRoutes = (): RoundRoutes => ({ laid: new Map(), frames: new Map(), scores: new Map(), refused: null });

/** the room's refusals of a lay, in words */
export const REFUSALS: Record<string, string> = {
  "bad stake": "That stake doesn't fit your stack. Stake at least $100 and no more than you hold.",
  "no rounds left": "That's all 24 staked rounds for today. Practice rounds are still open, and the count starts again at midnight UTC.",
  "round in play": "You already have a band down. Close it first.",
  "unknown pool": "That pool just left the board. Pick another stall.",
  "board unavailable": "The Exchange can't read the board right now. Try again in a moment.",
  "bad choice": "That band can't be laid. Try another width or centre.",
};

/** errors that belong to a lay (the rest are the page's) */
export const isLayRefusal = (why: string): boolean => why in REFUSALS;
