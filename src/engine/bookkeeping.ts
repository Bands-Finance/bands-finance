/**
 * An execution's bookkeeping on the risk state: the entries, stops, seats, cooldowns and records a band carries
 * while it is on the book. Pure apart from the state it is handed (the loop saves it, src/index.ts updateState).
 *
 * `launch` marks a band opened through the launch lane: its stop is rolled tighter (LAUNCH_STOP_PCT
 * in place of STOP_LOSS_PCT, same jitter, same place on disk) and its opening mark is recorded in
 * state.launchBands, which is what the EXPIRE directive reads for the maximum hold and the
 * volume-fade exit, and what the picker counts against LAUNCH_MAX_SEATS.
 *
 * A dry-run execution (the rehearsal) changes nothing but the price and the entries of bands the chain shows.
 */
import { riskLimits } from "../config";
import type { ExecutionResult } from "../executor";
import type { RiskState } from "../risk/state";
import type { LaunchEnv } from "../screener/launch";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import type { AskBand } from "./askExit";
import { clearFeesPending } from "./collect";
import { forgetBand, rollStop } from "./exit";

export function bookExecution(
  state: RiskState,
  exec: ExecutionResult,
  positions: PositionSnapshot[],
  snapshot: PoolSnapshot,
  launch?: { env: LaunchEnv; vol1hUsd: number | null } | null,
  ask?: { band: AskBand; stopPct: number } | null,
  now: number = Date.now(),
  rng: () => number = Math.random,
): void {
  state.lastPrice = snapshot.activePrice;
  for (const p of positions) {
    if (!(p.address in state.entryValueSol)) state.entryValueSol[p.address] = p.entryValueSol ?? p.valueInSol;
  }
  // A REHEARSAL (dry-run: live:rehearse runs on the live DATA_DIR) sends nothing, so it books nothing: its "opened" band is not
  // on the chain and its "closed" band still is. Writing them here gave the live bands phantom entries and stops (a phantom
  // 10 SOL entry doubled the breaker's working capital) and dropped a real band's entry and stop, which then re-based at
  // the current value and would have stopped 26% under its real entry instead of 12%. What the chain shows is kept above.
  if (exec.mode === "dry-run") return;
  if (exec.txs.length > 0) {
    state.actionsToday += 1;
    state.lastActionAt = now;
    // Band moves start this pool's cooldown; a fee claim does not.
    // a move that landed, and a move that was SENT and failed: both start the per-pool cooldown, so a
    // failing open is not re-sent every cycle until the daily cap (fees are paid either way)
    if (exec.opened || exec.closed || exec.txs.some((t) => !t.ok)) (state.lastMoveByPool ??= {})[snapshot.address] = now;
  }
  // the band closed was an ask band (read before forgetBand drops it): its final close puts the pool on the bench for a while,
  // and a re-lay keeps the chain's rolled stop rather than rolling a new one (a fresh roll could land under the chain's drawdown)
  const closedAsk = exec.closed ? state.askBands?.[exec.closed] : undefined;
  const carriedStop = exec.closed && closedAsk ? state.stops?.[exec.closed] : undefined;
  // a proposal band re-laid stays a proposal band: the auto-approval budget follows the capital, not the address
  const carriedProposal = exec.closed ? state.proposalBands?.[exec.closed] : undefined;
  if (exec.ok && exec.opened) {
    state.entryValueSol[exec.opened.address] = exec.opened.entryValueSol;
    // an ask band's stop is the chain's (EXIT_ASK_STOP_PCT, measured against the chain's basis by stopEntryOf), a launch band's the lane's
    (state.stops ??= {})[exec.opened.address] = ask && carriedStop ? carriedStop : rollStop(riskLimits, rng, ask ? ask.stopPct : launch ? launch.env.stopPct : null);
    if (launch && !ask) (state.launchBands ??= {})[exec.opened.address] = { pool: snapshot.address, openedAt: now, vol1hUsd: launch.vol1hUsd };
    if (ask) (state.askBands ??= {})[exec.opened.address] = ask.band;
    if (carriedProposal && exec.closed !== exec.opened.address) (state.proposalBands ??= {})[exec.opened.address] = carriedProposal;
  }
  // the close landed whether or not the sale after it did: the band is gone, its records go with it
  if (exec.closed) forgetBand(state, exec.closed);
  // the seat's tenure in this pool: starts at the first open, survives a re-lay (a close and an open), ends at a plain close.
  // An ask band is not a seat: laying one ends the tenure, and the pool sits out a while after the chain's end (the token
  // just ran through us; the lanes may seat it again after METEORA_STOCK_REENTRY_MIN).
  if (exec.ok && exec.opened && !ask && !state.seatSince?.[snapshot.address]) (state.seatSince ??= {})[snapshot.address] = now;
  if (((exec.closed && !exec.opened) || (exec.ok && exec.opened && ask)) && state.seatSince) delete state.seatSince[snapshot.address];
  if (closedAsk && !(exec.ok && exec.opened && ask)) (state.rotatedOutAt ??= {})[snapshot.address] = now;
  // a claim restarts the "pending above the floor" clock: the next claim by that rule is two hours away, not next cycle
  if (exec.ok && exec.claimed) clearFeesPending(state, exec.claimed);
  // what an exit could not sell under the caps waits in the wallet; the residue pass comes back for it every cycle
  if (exec.residue) {
    const prev = state.residues?.[exec.residue.mint];
    // a new leftover starts the ladder over, and it already counts what an older residue left in the wallet (the
    // liquidation on a sweep book sells the wallet's whole holding): it replaces the old record, never adds to it
    if (prev) console.log(`[cycle ${exec.residue.cycle}] residue ${exec.residue.symbol}: ${prev.amountUi} on record replaced by this exit's leftover of ${exec.residue.amountUi}`);
    (state.residues ??= {})[exec.residue.mint] = exec.residue;
  }
  // a made pair's pool landed on chain: remember it is ours, and which real address the alias stands for
  if (exec.created && snapshot.pair) {
    (state.pairPools ??= {})[exec.created.pool] = {
      lbPair: exec.created.lbPair,
      mint: snapshot.pair.mint,
      symbol: snapshot.pair.symbol,
      ...(snapshot.pair.stock ? { stock: snapshot.pair.stock } : {}),
      quote: snapshot.pair.quote,
      binStep: snapshot.binStep,
      feeBps: Math.round(snapshot.baseFeePct * 100),
      createdAt: now,
      rentSol: exec.created.rentSol,
      refPool: snapshot.pair.refPool,
      refVenue: snapshot.pair.refVenue,
      sig: exec.created.sig,
    };
  }
}
