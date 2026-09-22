# Porting Meridian's money engine to Mr Bands (Solana / Meteora DLMM)

Source of truth for this plan: a file-level read of `/Users/zach/dev/meridian/agent/src` on 2026-09-12.
Meridian ("Merd") ran 33 days live on Robinhood Chain: $997 in, $3,002 profit, $3,259 lifetime fees, closed 2026-09-07.

## The load-bearing finding

Nothing in Meridian's house money path is an LLM decision. Every mint, re-center, collect, exit, sizing and
venue choice is deterministic code (`lpGuard.ts`, `pilotGuard.ts`, `memeGuard.ts`, `dumpWatch.ts`,
`lpAllocator.ts`). The LLM narrates the desk, advises users, and writes posts. Outside agents may only
propose; the holder of the approval key decides; the desk executes through its own guards.

Mr Bands keeps "he proposes, the guards decide" for entries, and adopts Meridian's rule for everything
that protects money: exits, collects, breakers and sizing multipliers are code, and they run before he
is asked (engine directives). His proposal, from his rulebook or his model, chooses only among what the
verdicts allow.

## Phase 1 (in progress, `src/engine/`)

Attribution ledger (`data/ledger.jsonl`, cash-boundary rows, exact vs marked never summed), jittered per-band
stops (0.8-1.0 x STOP_LOSS_PCT, persisted at open), anti-churn on out-of-range bands, knife (30-min drop),
bench ladder per pool (stops in 6h: x1, x0.5, x0.25, benched at 3), board regime multiplier (median 24h
move), circuit breaker (daily loss >= max(0.05 SOL, 15% working): 4h halt, then 6h), portfolio breaker
(3 confirming marks of >= max(0.15 SOL, 15%) drawdown: flatten + 12h stand-down, cleared by hand),
collect policy (>= 0.005 SOL or 2h pending above 0.001, 30/day), treasury skim (dormant; 75% of fee gain
above a float target), liveness watchdog + `engine.lock` (one process holds the key), EXPECTED_WALLET.

## Phase 2 (next), in Meridian's recommended order

1. **The tape.** `src/tape/swaps.ts`: per-pool swap ingestion for DLMM (Helius enhanced transactions or
   `getSignaturesForAddress` on the LbPair + parsed inner instructions) -> rows `{t, px, sol, side}` in
   `data/pool-flow.jsonl`; `src/tape/stats.ts` ports `flowUsdPerHour`, `moveStats`, `hourlyWindowUsd`,
   `tickDriftPctPerHour` (bins: pct = dBins x binStep / 100), pulse (swaps/h).
2. **Score net of toxicity and size.** `src/screener/score.ts`: add 30-min markout (`lpScore.ts` L161-193),
   `lpNetPerDay`, `vetRow` (fee tier bounds, swaps >= N, volume/fees floors, arrival move in [-5%, +15%]),
   `expectedFeePerHourForSeat(seatSol)` = flow x fee x share, share from our liquidity in the covered bins
   vs the pool's liquidity in those bins; `LP_MAX_SHARE_PCT` 50 -> not viable ("we would BE the pool").
3. **Qualification.** `src/screener/qualify.ts`: depth gate (quote needed to walk price 2% through the
   bins), score gate (lpNet > 0; "silence is not a passing grade"), holdability (simulate a small
   round-trip swap; catch freeze/transfer-hook mints), quarantine list, TTL 30 min. `pickPools` consumes it.
4. **Deterministic seat manager.** `src/engine/pilot.ts`, verbatim pure ports of `recenterVerdict`
   (below: 30 min out + 30-min stability window; above: 12 + 12; refuse while still moving away > 1%),
   `spikeVerdict` (up > 10% in 60 min refuses re-arms above), `collectDue`, `effectiveFloorUsd` /
   `floorBreached` / `inferredDepositUsd` with lineage carried across re-centers (`data/lineage.json`),
   `idleBidVerdict` (unfilled bid 120 min -> cash), `recenterPaysBack` (cost = budget x fee x 1.2 + rent
   and tx fees; fee/h x 12h must cover it), `sleeveBoardRed`, `autoEntryVerdict` (seats, reserve,
   cooldown, entries/day, flow floor, $/h floor, yield-to-move >= 0.25, spike). Re-centers above re-arm
   as an all-SOL bid with its top at spot ("never re-buy the top"); below re-centers balanced.
5. **Dump / bleed / fade watch.** `src/engine/dump.ts`: `dumpVerdict` (sell share >= 0.66, acceleration
   >= 1.6, velocity <= -3%, >= 8 swaps), `bleedVerdict` (6% off the 8h peak, 55% negative steps, 50% avg
   sell share, >= 3h, >= 20 samples), `volumeFadeVerdict` (two hours each -30% from a >= floor base);
   lockouts persisted, checked on the open path.
6. **Sell queue + wallet-op budget.** `src/engine/pendingSells.ts` (retry `min(1h, 3min x 2^attempts)`,
   dedupe by mint, retried at the top of every cycle) and rolling-24h ops/notional ledger with
   `walletOpsAvailable(n)` ("never start what you cannot finish": open 3 ops, re-center 4).
7. **Executor hardening.** Confirm and inspect `getTransaction` meta.err and throw on failure; measure
   outputs as balance deltas; retry opens with fresh snapshots (3x); undersized-open abort (< 55% of
   budget); chunked exits via Jupiter (0.2 SOL-ish chunks, 3 per pass, halve on failure); priority-fee
   policy; `data/executions.jsonl`.
8. **Book.** `computeBookNow` (banked / working / accruing / fees monotonic) every 2 min, equity every
   30 min, per-day consistency board with the crater filter; routes `/api/book-history`,
   `/api/consistency`, `/api/attribution`.

## DLMM translation notes

- price(bin) = (1 + binStep/1e4)^binId x 10^(xDec - yDec) (`binPriceUi`).
- Meridian "width 50" (-20% / +25%) = ln(1.25)/ln(1+binStep/1e4) bins above and ln(1/0.8)/... below;
  at 20 bps that is ~112 bins, above the 69-bin single-position cap: a seat becomes two positions or a
  narrower band.
- Meridian's bid-only seat = a SOL_ONLY band with the active bin as its top (already the persona default).
- Meridian's gas is negligible; DLMM rent is not: 0.0574 SOL refundable per position, 0.0715 SOL per fresh
  bin array (not refundable), plus tx fees. Fold these into the payback gate and the collect guard
  (`OPEN_COST_ESTIMATE_SOL`).
- Meridian's 24h wallet-op cap was 150 (100 in production), notional $25k/24h; portfolio breaker
  max($200, 15%); meme daily loss max($75, 15%). SOL equivalents live in `config.engine`.

## Reusable verbatim (pure TS in Meridian; no chain access)

`pilotGuard.ts`: recenterVerdict, outOfRangeManaged, collectDue, inferredDepositUsd, floorBreached,
effectiveFloorUsd, spikeVerdict, bidShareOfPool, autoEntryVerdict, idleBidVerdict, gasRefillVerdict,
sleeveBoardRed, paybackFeePerHour, recenterPaysBack, dumpBidDecision.
`dumpWatch.ts`: dumpExitVerdict, hourlyWindowUsd, volumeFadeVerdict, flowUsdPerHour, moveStats,
bleedVerdict, crowdingSharePct, dumpVerdict.
`memeGuard.ts`: moveCooldownMs, tickDriftPctPerHour, targetRange, volumeMode, worthRequoting,
boardRegimeMultiplier, makerExitPatienceMs, hourlyVolPct, effectiveStopPct, stopLinePct, stopsInWindow,
entrySizeMultiplier, pulseSizeMultiplier, staleBandAction, scaledDailyLimit, venueAdmits, breakerStage,
shouldCollect.
`risk.ts`: RiskLimiter, guardWalletOp, walletOpsAvailable. `portfolioBreaker.ts`: portfolioLimitUsd,
portfolioVerdict. `pendingSells.ts`: nextRetryDelayMs. `houseWallet.ts`: withHouseWalletLock.
`liveness.ts`: staleAfterMs (beat on completion, never on start). `attribution.ts`: AttributionRow,
aggregateAttribution, isExactRow, venueRealizedAdmits, churnCycleAdmits. `dailyReconcile.ts`:
cashCollectedSince, reconcileSplit. `consistency.ts`: crater filter (CRATER_USD 120, CRATER_RUN 3).
