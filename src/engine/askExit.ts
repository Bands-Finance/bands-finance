/**
 * THE ASK EXIT (EXIT_ASK). A SOL-only bid band the price falls through hands back token. Selling that
 * token through the pool pays the pool's swap fee (2-3% on a memecoin pool, the same fee the band earns
 * on the way in) plus the impact of a sale into a book we just pulled our own bids from: on 2026-09-18
 * the desk sold 38.5 SOL of token at the mark and received 37.1, about 1.04 SOL of it the pools' fee.
 *
 * With EXIT_ASK=true the close is not a sale. The token is laid straight back as a one-sided TOKEN band
 * from the active bin EXIT_ASK_COVER_PCT up (the mirror of the bid band: a ladder of asks), so traders
 * buy it from us and WE earn the fee. The REBALANCE that does it (close, then a TOKEN_ONLY open in one
 * execution) is marked `exitAsk`, and the guards treat it as the exit it is: never held by the
 * cooldown, the daily cap or the open gates, and a band at its stop may leave this way.
 *
 * What the ask band does afterwards is the policy's (src/agent/policy.ts askBandDecide):
 *   - price runs up through it: the token is sold, the band holds SOL: CLOSE at once (a sold-out ask
 *     left alone is a bid band laid where we just sold; not a seat anyone chose)
 *   - price sits inside it: HOLD, it is selling bin by bin and earning the fee both ways
 *   - price falls under it: after EXIT_ASK_RELAY_SEC the ask follows the price down (another exitAsk
 *     REBALANCE), the way an idle bid band follows the price up
 * Two backstops end the chain with the old swap: EXIT_ASK_STOP_PCT under the mark the FIRST ask in the
 * chain was laid at (its own stop, rolled like any other, measured against that basis by the STOP
 * directive and the guards), and EXIT_ASK_MAX_MIN on the book since that first ask (an EXPIRE
 * directive). Both close with liquidate, through the capped sells and the residue ladder as before.
 *
 * An ask band is inventory being worked off, not a seat: it does not count toward MAX_ACTIVE_POOLS
 * (the picker may seat another pool beside it) but its value counts as exposure. Its P&L is its own
 * (state.entryValueSol[ask] is the mark it was laid at, so the ledger realizes the bid band's loss once,
 * at the bid band's close, and the ask's result on its own close); only the stop reads the chain's basis.
 * Pure: no disk, no network.
 */
import type { Decision } from "../agent/schema";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import { quoteOf } from "../tools/dlmm";

export interface AskExitEnv {
  /** EXIT_ASK=true: a close that would sell token lays it as an ask band instead */
  on: boolean;
  /** EXIT_ASK_COVER_PCT: how far above the active bin the ask ladder reaches, percent of price */
  coverPct: number;
  /** EXIT_ASK_MIN_SOL: token worth less than this at the mark is sold as before (not worth a position) */
  minSol: number;
  /** EXIT_ASK_STOP_PCT: the chain's stop, percent under the mark the first ask was laid at (rolled like any stop; capped by STOP_LOSS_PCT) */
  stopPct: number;
  /** EXIT_ASK_MAX_MIN: minutes an ask chain may stay on the book before the swap takes over (0 = no limit) */
  maxHoldMin: number;
  /** EXIT_ASK_RELAY_SEC: how long an ask sits under the price before it follows it down */
  relaySec: number;
  /**
   * EXIT_ASK_ON_STOP=true: a STOP directive's close, or a close inside a knife (ENGINE_KNIFE_PCT in 30 min), is laid as
   * an ask too. Off by default: a band at its stop or in a knife is a confirmed fall, where the chain's own stop plus
   * the sale it ends in cost more than the sale it would have replaced unless the bounce comes first.
   */
  onStop: boolean;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** PURE. The ask exit's settings from the env. Off unless EXIT_ASK is the literal "true". */
export function askExitEnv(env: NodeJS.ProcessEnv = process.env): AskExitEnv {
  return {
    on: (env.EXIT_ASK ?? "").trim().toLowerCase() === "true",
    coverPct: Math.max(0.1, num(env.EXIT_ASK_COVER_PCT, 3)),
    minSol: Math.max(0, num(env.EXIT_ASK_MIN_SOL, 0.2)),
    stopPct: Math.max(1, num(env.EXIT_ASK_STOP_PCT, 10)),
    maxHoldMin: Math.max(0, num(env.EXIT_ASK_MAX_MIN, 240)),
    relaySec: Math.max(0, num(env.EXIT_ASK_RELAY_SEC, 180)),
    onStop: (env.EXIT_ASK_ON_STOP ?? "").trim().toLowerCase() === "true",
  };
}

/**
 * An ask band on the book (state.askBands, keyed by position). Its PRESENCE is what makes a band an ask
 * band. A re-lay (the ask following the price down) carries `since`, `basisSol` and `from` forward, so
 * the stop and the maximum hold bound the whole chain, not each link.
 */
export interface AskBand {
  pool: string;
  /** epoch ms the first ask of the chain was laid */
  since: number;
  /** what the token was worth at the mark when the first ask was laid, SOL: what the chain's stop is measured against */
  basisSol: number;
  /** the bid band the chain came from */
  from: string;
  /** base token laid in this link */
  tokens: number;
  /** re-lays so far in the chain (0 on the first ask) */
  relays: number;
  /**
   * quote the chain has already banked, SOL: what the closing links handed back (their quote fees, and whatever the asks
   * had sold and not bought back). The chain's stop measures the band that is left against the basis LESS this, so fees
   * the chain earned and sales it banked do not read as drawdown (stopEntryOf).
   */
  bankedSol: number;
}

/** PURE. Bins that reach coverPct of price above (or below) the active bin at this bin step, at least one, inside the width limit. */
export function askBinsFor(binStep: number, coverPct: number, maxBinWidth: number): number {
  const per = Math.log(1 + binStep / 10_000);
  const bins = per > 0 ? Math.round(Math.log(1 + coverPct / 100) / per) : 1;
  return Math.max(1, Math.min(Math.max(1, maxBinWidth - 1), bins));
}

/** Base token units in a position incl. its unclaimed base fees. */
export function baseTokenOf(p: Pick<PositionSnapshot, "amountX" | "amountY" | "feeX" | "feeY">, s: PoolSnapshot): number {
  return quoteOf(s).side === "X" ? p.amountY + p.feeY : p.amountX + p.feeX;
}

const clip = (t: string, n = 90) => (t.length <= n ? t : t.slice(0, n - 1).trimEnd() + ".");
const floorTo = (n: number, d: number) => Math.floor(n * 10 ** d) / 10 ** d;

export interface AskExitInput {
  snapshot: PoolSnapshot;
  positions: readonly PositionSnapshot[];
  /** the wallet's base token, UI units: on a quote-only book they are fee claims, and they go into the ask with the band's */
  walletToken: number;
  askBands: Record<string, AskBand> | undefined;
  env: AskExitEnv;
  maxBinWidth: number;
}

/** PURE. The ask-band parameters for `tokens` of the base at this snapshot: TOKEN_ONLY from the active bin coverPct on the token side. */
export function askOpenParams(tokens: number, s: PoolSnapshot, env: Pick<AskExitEnv, "coverPct">, maxBinWidth: number): NonNullable<Decision["open"]> {
  const quoteBelow = quoteOf(s).side === "Y";
  const bins = askBinsFor(s.binStep, env.coverPct, maxBinWidth);
  return {
    side: "TOKEN_ONLY",
    amountSol: 0,
    // floored to the token's decimals (six at most), and never over what is held: the guards compare it to the same sum
    amountToken: Math.min(tokens, floorTo(tokens, Math.min(s.baseToken.decimals, 6))),
    binsBelowActive: quoteBelow ? 0 : bins,
    binsAboveActive: quoteBelow ? bins : 0,
    strategy: "Spot",
  };
}

/**
 * PURE. A CLOSE that would sell the token a band hands back, turned into the ask exit: a REBALANCE that
 * closes the same band and lays its token (and the wallet's) as an ask band, marked exitAsk. Null when
 * the close should stay a sale: the ask exit is off, the band is itself an ask band (its close is the
 * chain's end), the token is worth less than the minimum, or the position is not on the book.
 */
export function askExitOf(decision: Decision, i: AskExitInput): Decision | null {
  if (!i.env.on || decision.action !== "CLOSE_POSITION" || !decision.positionAddress) return null;
  const p = i.positions.find((x) => x.address === decision.positionAddress);
  if (!p) return null;
  if (i.askBands?.[p.address]) return null;
  const s = i.snapshot;
  const tokens = baseTokenOf(p, s) + Math.max(0, i.walletToken);
  const worthSol = tokens * s.tokenPriceInSol;
  if (!(worthSol >= i.env.minSol) || !(worthSol > 0)) return null;
  const open = askOpenParams(tokens, s, i.env, i.maxBinWidth);
  if (!(open.amountToken > 0)) return null;
  const q = quoteOf(s);
  const bins = Math.max(open.binsAboveActive, open.binsBelowActive);
  const { liquidate: _liquidate, ...rest } = decision;
  void _liquidate;
  return {
    ...rest,
    action: "REBALANCE",
    open,
    exitAsk: true,
    reasoning: `${decision.reasoning} The ${s.baseToken.symbol} it holds (${open.amountToken} incl. the wallet's, about ${worthSol.toFixed(4)} SOL at the mark) is not sold into the pool, which would pay its ${s.baseFeePct}% fee and the impact of a sale into a book we just left; it is laid as an ask band from bin ${s.activeBinId} ${bins} bins ${q.side === "Y" ? "up" : "down"} (${i.env.coverPct}% of price), so traders buy it from us and the fee is ours. The chain's stop is ${i.env.stopPct}% under this mark${i.env.maxHoldMin > 0 ? ` and it has ${i.env.maxHoldMin} min on the book` : ""}; either falls back to the sale.`,
    headline: clip(`${decision.headline.replace(/\s*$/, "")} Laid as an ask.`),
  };
}

/** PURE. The ask chain past its maximum hold in this pool, if any: the swap takes over. */
export function askExpiry(positions: readonly Pick<PositionSnapshot, "address">[], askBands: Record<string, AskBand> | undefined, pool: string, now: number, maxHoldMin: number): { position: string; reason: string } | null {
  if (!askBands || !(maxHoldMin > 0)) return null;
  for (const p of positions) {
    const a = askBands[p.address];
    if (!a || a.pool !== pool) continue;
    const ageMin = (now - a.since) / 60_000;
    if (ageMin >= maxHoldMin) return { position: p.address, reason: `ask band ${p.address.slice(0, 6)} has worked the token off for ${Math.round(ageMin)} min (limit ${maxHoldMin}${a.relays > 0 ? `, ${a.relays} re-lay${a.relays === 1 ? "" : "s"}` : ""}): what is left is sold` };
  }
  return null;
}

/**
 * PURE. The ask-band record for a link just laid: the first of a chain, or a re-lay carrying the chain's basis, clock and
 * banked quote forward. `bankedSol` is what the link being replaced handed back in quote (its quote fees, and anything it
 * had sold): the chain's stop measures what is still on the book against the basis less that.
 */
export function askBandRecord(prev: AskBand | undefined, i: { pool: string; from: string; tokens: number; markSol: number; now: number; bankedSol?: number }): AskBand {
  const banked = Math.max(0, i.bankedSol ?? 0);
  return prev
    ? { ...prev, tokens: i.tokens, relays: prev.relays + 1, bankedSol: prev.bankedSol + banked }
    : { pool: i.pool, since: i.now, basisSol: i.markSol, from: i.from, tokens: i.tokens, relays: 0, bankedSol: 0 };
}

/**
 * PURE. What an ask band's stop is measured against: the chain's basis less what it has already banked in quote. Undefined
 * once the chain has taken its whole basis back in SOL: there is nothing left for a stop to protect.
 */
export function askStopBasis(a: AskBand): number | undefined {
  const left = a.basisSol - Math.max(0, a.bankedSol ?? 0);
  return left > 0 ? left : undefined;
}

/** PURE. Whether a decision is the ask exit (a REBALANCE that closes a band into an ask), which the guards treat as an exit. */
export const isAskExit = (d: Pick<Decision, "action" | "exitAsk" | "open">): boolean => d.action === "REBALANCE" && d.exitAsk === true && d.open?.side === "TOKEN_ONLY";

/** Pools with an ask band on record (the picker reads this before it has observed any position). */
export const askPoolsOf = (askBands: Record<string, AskBand> | undefined): Set<string> => new Set(Object.values(askBands ?? {}).map((a) => a.pool));

/** Pools whose bands are ask bands only: inventory being worked off, not seats. */
export function askOnlyPools(askBands: Record<string, AskBand> | undefined, positionsByPool: ReadonlyMap<string, readonly Pick<PositionSnapshot, "address">[]>): Set<string> {
  const out = new Set<string>();
  if (!askBands) return out;
  for (const [pool, positions] of positionsByPool) {
    if (positions.length > 0 && positions.every((p) => !!askBands[p.address])) out.add(pool);
  }
  return out;
}
