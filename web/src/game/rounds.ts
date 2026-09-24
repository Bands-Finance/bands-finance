/**
 * Where a stall round's hours come from. The panel (LpRound.tsx) draws whatever frames arrive and knows nothing else.
 *   offline: the simulation runs here, on a local seed, revealed one hour per ROUND_TICK_MS; the score is local.
 *   online:  the room server deals the seed, keeps the path to itself and streams each hour as its clock reaches it;
 *            a close is a message, scored by the server at the last hour it sent. Nobody sees the future, so the
 *            leaderboard cannot be gamed by replaying seeds.
 */
import { simulate, TICKS, type PoolParams } from "./lpGame";
import { ROUND_TICK_MS } from "./protocol";
import type { ExchangeNet } from "./net";

export interface Laid {
  roundId: string;
  lower: number;
  upper: number;
  tickMs: number;
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
}

export interface RoundSource {
  /** lay a band; frames and the score arrive through the callbacks */
  start(pool: PoolParams, widthBins: number, offsetBins: number, onFrame: (f: Frame) => void, onScore: (s: Score) => void): Promise<Laid>;
  close(roundId: string): void;
  /** stop listening (the panel closed) */
  stop(): void;
}

/** a round played here: the whole path is computed, and revealed an hour at a time */
export function offlineSource(): RoundSource {
  let timer = 0;
  let closeFn: (() => void) | null = null;
  return {
    async start(pool, widthBins, offsetBins, onFrame, onScore) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      const seed = a[0];
      const sim = simulate(pool, seed, { widthBins, offsetBins });
      const roundId = `local-${seed}`;
      let i = 0;
      const finish = () => {
        window.clearInterval(timer);
        closeFn = null;
        const at = Math.max(1, i);
        onScore({ pct: simulate(pool, seed, { widthBins, offsetBins, closeAt: at }).scorePct, rank: null });
      };
      closeFn = finish;
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        i += 1;
        onFrame({ i, p: sim.path[i], feesPct: sim.feesPct[i], valuePct: sim.valuePct[i], holdPct: sim.holdPct[i], inRange: sim.inRange[i] });
        if (i >= TICKS) finish();
      }, ROUND_TICK_MS);
      return { roundId, lower: sim.lower, upper: sim.upper, tickMs: ROUND_TICK_MS };
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
    start(pool, widthBins, offsetBins, onFrame, onScore) {
      return new Promise<Laid>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          route.laid.delete(pool.label);
          reject(new Error("The Exchange didn't answer. Try again in a moment."));
        }, 6000);
        route.laid.set(pool.label, (laid) => {
          window.clearTimeout(timer);
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
        net.lay(pool.label, widthBins, offsetBins);
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
}

export const newRoutes = (): RoundRoutes => ({ laid: new Map(), frames: new Map(), scores: new Map() });
