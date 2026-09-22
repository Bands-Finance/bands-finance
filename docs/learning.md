# What Mr Bands learns, and what he may never learn

Written 2026-09-22. Everything here is checked by `src/scripts/test-learn.ts` and printed by
`npm run learning`. Where this file and the code disagree, the code is right and this file is a bug.

## The doctrine

**The LLM proposes, the guards decide.** Learning may tune HOW he trades inside ranges fixed in code. It
may never raise or loosen a risk limit.

Every learner in `src/learn/` obeys all seven of these, and each one is a test:

| | The rule | Where |
|---|---|---|
| 1 | A minimum sample before anything moves | `LEARN_CAL_MIN_SAMPLE`, `LEARN_POOL_MIN_SEATS` |
| 2 | Bounded steps: one step per knob per cycle | `LEARN_CAL_STEP`, one rung on the pool penalty |
| 3 | Old evidence decays on its own | EWMA half-life, and the 48h pool window |
| 4 | Every change journals its evidence | `DATA_DIR/learning.jsonl`, one row per change |
| 5 | Public: what he learned is readable by anyone | `/api/status`, the site panel, `bands_lessons`, `npm run learning` |
| 6 | Switchable off | `LEARN_FROZEN`, and per knob |
| 7 | Tested | `npm run test:learn`, 20 blocks, 200 random books in the property test |

## What no learner may ever touch

`MAX_POSITION_SOL`, `MAX_TOTAL_EXPOSURE_SOL`, the stop-loss, the daily caps, the kill switch, the circuit
and portfolio breakers, and H1 (the desk never swaps or seats the house mint). These are human-set and
stay that way. Structurally, not by convention:

- Every learner is a **multiple of at most 1.0** applied through a path that already exists and already
  only tightens. It can make a seat smaller, never larger; refuse a seat, never take one the shipped code
  would refuse.
- No file under `src/learn/` imports `src/engine/breakers.ts` or writes `EngineState`.
- The calibration's product is hard-clamped to `[0.1, 0.5]`. 0.5 is the literal the shipped code uses
  (`src/agent/policy.ts`, `seatEarnings`), so a calibrated desk prices every seat at or below what
  today's desk prices it at. `test-learn.ts` proves this over 200 random books: a calibrated factor never
  takes a seat the shipped factor refused.
- The pool penalty is clamped to `[0.25, 1.0]` and its sit-out to `LEARN_POOL_SITOUT_MAX_MIN`. It cannot
  enlarge a seat and it cannot bench a pool.
- Freezing is always the conservative direction: the frozen state is the shipped default, which is the
  loosest any learner may ever be.

## The knobs

### 1. The forecast calibration (`src/learn/calibration.ts`)

**What it moves.** The in-range haircut in `seatEarnings`: the 0.5 in "halved because a band earns only
while price is inside it". Ships as `yieldFactor` on the policy env.

**Why this knob and not band width.** Over the 17-19 Sep real-money run the forecast came in at a median
**0.39** of what the seats realised, too high on **48 of 52** priced seats. Band width separates nothing
in either book: replaying the shipped width tuner over all 59 live and all 21 paper lessons produces zero
changes, and it could not fire on the paper book even if switched on. The level is what is wrong.

**How it is read.** Two halves, each of which means something on its own:

- `inRangeFactor` - of a seat's life, the share the price spent inside the band. EWMA, half-life
  `LEARN_CAL_HALFLIFE_H` (168h). Clamped `[0.25, 1.0]`.
- `paceFactor` - of the fees the screen says the pool pays, the share a seat captured while it was in
  range. Clamped `[0.2, 1.0]`.
- `combined = clamp(inRangeFactor x paceFactor, 0.1, 0.5)`.

| Guard | Value | Env |
|---|---|---|
| Minimum sample | 20 closed seats in the lane and mode | `LEARN_CAL_MIN_SAMPLE` |
| Step | 0.05 | `LEARN_CAL_STEP` |
| Gap between steps | 360 min | `LEARN_MIN_GAP_MIN` |
| Decay | 168h half-life | `LEARN_CAL_HALFLIFE_H` |
| Bounds | `[0.1, 0.5]` | `LEARN_CAL_MIN`, `LEARN_CAL_MAX` |
| Freeze | `LEARN_FROZEN_CALIBRATION=true` | or `LEARN_FROZEN=true` |
| Never touches | any limit, stop, cap, breaker or the kill switch | |

**Lanes.** `memecoin` and `stock` learn separately, and a lesson from one never votes in the other.

**Modes.** A lesson only teaches a desk in its own mode. A paper-learned factor cannot ride into the live
desk: `readLearning` refuses a file whose `mode` is not the reader's, and so does `applyTuning`.

### 2. The pool memory (`src/learn/poolMemory.ts`)

**What it moves.** A multiple on the seat the sizing rule would already have given (never above 1.0), and
extra minutes on the sit-out the seat ranking already keeps (`sittingOut`, `METEORA_STOCK_REENTRY_MIN`).

**The evidence.** On the real-money run, seats that ended ABOVE the band made +4.311 SOL over 38 closes
with 29 winners. Seats that went DOWN through the band or hit the stop lost 2.401 SOL over 7 closes with
**no winners at all**. The end side separates the book.

| Down exits in the last 48h | Seat | Sit-out |
|---|---|---|
| 0 | 1.0 (today's behaviour) | none |
| 1 | 0.5 | 2x the base, capped |
| 2 or more | 0.25 | 4x the base, capped at 240 min |

Minimum sample 3 closed seats in that pool and mode (`LEARN_POOL_MIN_SEATS`). The window decays: as the
48 hours empty, the multiple walks back to 1.0 and the extra sit-out to zero with no second decision.
Freeze with `LEARN_FROZEN_POOLS=true`.

### 3. The freeze switch (`src/learn/freeze.ts`)

Frozen **only** on the literal `"true"`, trimmed and lower-cased. `LEARN_FROZEN` unset, `1`, `yes`, `on`
and a typo all leave learning **running**. A switch that turns itself on by accident is as bad as one
that turns itself off by accident, so the operator who means to freeze writes the word. There is a test
of that exact table.

**A freeze costs no evidence.** While frozen the desk still closes seats, still writes lessons, still
computes what it would have changed and still logs it. It only refuses to write state and to put the new
factor on the policy env. Unfreeze and the corpus is whole.

## The journal

Nothing changes without a row in `DATA_DIR/learning.jsonl`:

```
{at, mode, knob, lane|pool, from, to, why, n, windowH}
```

`why` is the evidence sentence, with the numbers in it, and the site, the API and `npm run learning`
print it verbatim. A knob that moved without a row is a bug. `DATA_DIR/learning.json` holds what is in
force, mode-stamped, written by atomic rename.

## The casebook

`DATA_DIR/lessons.jsonl`, one row per closed seat. New on the row since this sprint:

- `entryYieldPct`, `entrySource`, `entryCoveredMin`, `entrySharePct`, `entryYieldFactor` - what he
  forecast **at the open** and what he forecast it with. `predictedYieldPct` is the LAST seat check's
  figure, rewritten every cycle, so it cannot be the training label.
- `quoteDriftSol`, `netSolExDrift` - the quote token's move against SOL, taken off the seat's own result.
- `backfilled` - reconstructed by `npm run lessons:recompute -- --backfill`, not observed at the close.

**The backfill.** The lesson writer landed on 2026-09-18, by which time the paper book had closed 88
bands and kept 21 lessons. The 67 missing ones held every seat that was priced out and every seat the
stop took. `--backfill` reconstructs them: the band from `paper-book.json`, the money from `ledger.jsonl`
through the same `seatNetSol` a live close uses, the in-range share from `decisions.jsonl` (one journal
row per pool per cycle carries that cycle's positions with `inRange` on them, which is exactly what the
desk counts), the bin step from the journal's pool block. It backs the file up, never overwrites a row
the desk wrote, and running it twice writes nothing.

## The honest caveats

These travel with the numbers on every surface (`caveatsFor` in `src/learn/view.ts`), and none of them
may be dropped or softened.

1. **His model is not switched on yet.** Until `OPENHERMIT_TOKEN` lands, 0% of his proposals come from
   the model. These knobs are his **rulebook's**, not his model's, and the page says so.
2. **Paper fees are modelled.** A paper seat's fees come out of the same formula as the forecast
   (`src/paper/mark.ts` `accrueFees`: pool pace x share x 0.5). A paper pace factor would score the
   screen against itself and read 1.0 by construction. So on a paper desk the pace half is the seed
   measured on the 17-19 Sep real-money run (`LEARN_PACE_SEED`, default 0.33) and never moves; only the
   in-range half learns, because where the price went is a fact the paper book did not invent.
3. **The pace seed is a memecoin figure.** The real-money run held no stock seat, so the stock lane
   borrows it until a live stock seat closes. It is a haircut either way: borrowing it can only refuse
   seats, never take one.
4. **The calibration fixes the level, not the ordering.** It scales every pool's forecast by the same
   number. It does not learn which pool is better than which. If the screen ranks the wrong pool first,
   a calibrated desk will still seat it, just smaller or not at all.
5. **The calibration under-corrects on purpose.** The factor in force at the open is part of the
   arithmetic (`entryYieldFactor`), which makes the loop converge instead of ringing between 0.5 and
   0.39 for ever. A lesson written before that stamp existed is read at the shipped 0.5, which is the
   conservative assumption.
6. **Band width is NOT learnable on this evidence.** The width tuner stays in the tree and stays off.
   Nothing in either book separates a good width from a bad one. If that changes, the evidence will be
   in `npm run learning` before the knob moves.
7. **No learner reads `netSol`.** -8.479 SOL of SOL/USD drift sits inside the 32 USDC-quoted paper seats.
   AMD/USDC stopped at -6.014 SOL, of which -6.346 was drift: the seat itself was **+0.332** and the
   price was 48 bins ABOVE the band when the stop fired. The learners key on the end side and on the
   yield ratio. The drift is decomposed onto the lesson and shown, never learned from.

## Checking it yourself

```
npm run learning                                   both books, every number recomputed from the files
npm run learning -- --pool <address>               that pool's memory and its last five closes
npm run learning -- --at 2026-09-15T18:00Z         as of that moment, not now
npm run test:learn                                 every decision function, plus a pass over the real books
DATA_DIR=data-live npm run lessons:recompute -- --backfill    what the backfill would write
```

If the site and `npm run learning` disagree, one of them has a bug and the files are the referee.
