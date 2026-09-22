# Going live with Mr Bands

Written for: whoever funds the wallet and flips the switch. Nothing below is automatic; every step is
yours, in order, and each one is checked by `npm run preflight`.

## What "live" means here

One process on one machine holds one hot wallet's key and runs the loop every 5 minutes. He proposes
(from his rulebook, the desk policy, or from his model once it is switched on); the guards and the engine
decide; the wallet signs. The kill switch is a file named `STOP`
in the project root: it blocks every new band the moment it exists. The engine's own breakers halt
opens after a losing day and flatten the book after a drawdown; you clear those with
`npx tsx src/scripts/engine.ts clear-standdown`.

## Before the first SOL

1. **The wallet.** A dedicated hot wallet whose only job is this desk. Its secret lives in `.env`
   as `WALLET_SECRET_KEY` (never committed) and its address is pinned in `EXPECTED_WALLET` so a wrong
   key cannot trade. Import the same secret into Backpack or Phantom if you want to watch it.
2. **The model.** `ANTHROPIC_API_KEY` in `.env` (or his agent on the gateway, docs/openhermit.md). Without
   one the desk policy, his rulebook, makes every proposal, but on a live book only with `POLICY_LIVE=true`
   (ops/live.env sets it); without it nothing opens and only the engine's exits run. The live loop has never run with a model
   proposal yet (the 17-19 Sep run was all rulebook); the first day of one should stay in dry-run so you
   can read what it proposes before anything is signed.
3. **The RPC.** `RPC_URL` pointing at a dedicated endpoint (Helius). The public endpoint rate-limits
   the screener and the executor; a 429 in the wrong place is a missed exit.
4. **The limits.** `MAX_TOTAL_EXPOSURE_SOL` is the most the desk may have in bands; `MAX_POSITION_SOL`
   the most in one band; `GAS_RESERVE_SOL` what must stay in the wallet for rent and fees;
   `MAX_ACTIVE_POOLS` how many pools at once. For a 100 SOL book: 90 / 22.5 / 1 / 4.
5. **The machine.** The loop must run without you: the launchd job in `ops/` on the Mac, or the
   Dockerfile on Railway or Fly. Only ONE of them may hold the key; the engine lock refuses a second.

## The staged switch

- **Stage 0, dry-run with real money.** Fund the wallet, keep `DRY_RUN=true`, run
  `npm run preflight`, then `npm start`. The executor now simulates every transaction against the
  chain with your real balances and the model's real proposals. Read the journal for a day.
- **Stage 1, live small.** `DRY_RUN=false` with `MAX_TOTAL_EXPOSURE_SOL=10` and
  `MAX_POSITION_SOL=5`. Two days. Watch the ledger (`GET /api/ledger?mode=live`) and the breakers.
- **Stage 2, the book.** Raise the limits to the full size. Nothing else changes.

## Every day

`npm run preflight` prints the same checklist; `npx tsx src/scripts/engine.ts status` prints the
breakers; the site shows the journal. If anything looks wrong, create `STOP` first and read second.
