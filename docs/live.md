# Going live: the first 20 SOL

Mr Bands' live desk trades real money from the hot wallet in `.env` (`9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW`,
pinned by `EXPECTED_WALLET`) when it runs. It is halted through 8 Oct 2026 by decision (docs/sprint.md): his book
is paper until then, and his one real-money run is 17-19 Sep. The live configuration is `ops/live.env` (non-secret, committed) and the
service is `ops/com.bands.mrbands.live.plist`, the only place `DRY_RUN=false` is written. Installing that
service is the act of going live. It is done on Zach's word, in words, and never with the paper desk running.

## What the first run is

- **Money:** 20 SOL in the wallet. 15 at work across 3 bands of at most 5 SOL each; 1.5 SOL kept for gas and rent.
  No USDC, so only SOL-quoted pools can be seated (MRVL/SOL, NVDAx/SOL, MCDx/SOL, BROS/SOL and the like);
  the USDC-quoted stock pools (AMD, SKHY, MU) need USDC in the wallet first.
- **Pools:** Meteora DLMM stock pools that already trade, ranked by fee on depth, at most 3, plus the NVDA
  pairing (`PAIR_STOCK_PINNED_TICKERS=NVDA`). No pools of our own (`PAIR_STOCK_LANE=false`, `PAIR_LANE=false`),
  no launches, no memecoins under the 30-day rule.
- **Who proposes:** his rulebook, the desk policy (`POLICY_LIVE=true`, and `DECIDER=policy` pinned in `ops/live.env`, since
  `.env` names OpenHermit for the paper desk); there is no Anthropic key. The guards decide, as always.
- **Halted until the go:** `KILL_SWITCH=true` in `ops/live.env`. While the line is there the live service does not start at all:
  `npm run live` runs the preflight first, and a live preflight FAILs on the kill switch. It is cleared at step 4 and nowhere else.
- **Hedging:** off. The stock halves of the straddles run unhedged until Backpack keys exist.
- **Stops:** 15% per band, the circuit and portfolio breakers as in paper, 120 actions a day at most.
- **RPC:** `.env`'s `RPC_URL`. The public endpoint rate-limits; a Helius URL is strongly preferred for real money.

## The order of operations (the second run, 21 September 2026 and after)

The first run (17-19 September: 7.91 SOL of fees claimed, 3.27 of it paid in tokens; the book 19.79 -> 19.71 SOL
all cash, -0.08; 111 claims, 205 moves, 293 transactions; docs/sprint.md "One headline number") is frozen as `web/public/live-run.json` and printed as
the "On Solana" chapter of mrbands.finance. Its data directory must NOT be reused: the page reads the desk's feed as a
window over `DATA_DIR`, and a restart on `data-mainnet` would print that run a second time under the new one. So:

0. Archive the first run and start clean: `mv data-mainnet data-mainnet-2026-09-17 && mkdir data-mainnet`
   (the engine state it held - stops, seats, cooldowns - belongs to positions that are closed; the wallet was emptied).
   If the token launched first, put its mint in `ops/live.env` as `PAIR_HOUSE_MINTS=<mint>` before starting, so the
   desk makes and works BANDS/SOL on Meteora from its first cycle; and fill `TOKEN_URL=` / `X_URL=` there once the
   token page and the announcement exist, then deploy the dashboard so the "For other agents" chapter links them.


1. The wallet is funded: 20 SOL sent by Zach, or (25 Sep) 5 SOL of the token's fee share moved from the treasury
   agent with Zach's approval of each transfer; `ops/live.env` is sized to the book (5 SOL: 3.5 exposure, 0.8 gas).
   Every transfer into or out of the wallet that is not the desk's own transaction gets one line in
   `data-mainnet/flows.jsonl` (`{"ts":<ms>,"sig":"<tx>","sol":3.703,"note":"..."}`, signed, into the wallet positive):
   `ops/treasury-sweep.mjs` writes it on a landed sweep, a hand transfer gets it by hand. The desk stamps the running
   total on every equity point (`flowSol`, `flowUsdc`) and the sites take it out of "net", "started with" and the day
   rows: on 25 Sep a 3.703 SOL sweep read as "Mr Bands is up 3.7 SOL today" until it was noted. A swap inside the
   wallet (SOL to USDC for a USDC-quoted seat) is not a flow. Known gap: the drawdown guard's day high still reads a
   sweep as equity, so a withdrawal would read as a loss to it; halt around one.
   With one seat and both quotes in the wallet, the desk seats new bands in the quote that holds the book: a quote whose
   seat is under half the other's AND under 0.5 SOL is skipped for new seats (src/desk/funds.ts;
   `POLICY_QUOTE_MIN_SHARE_PCT=50`, `POLICY_QUOTE_DROP_UNDER_SOL=0.5`, a blank line keeps the default, 0 turns the share
   test off). On 25 Sep, 1.04 SOL beside 497 USDC laid a 0.19 SOL BP/SOL band that lost its rent while the USDC sat idle.
2. `npm run live:preflight`: every FAIL except the kill switch must be clear before the rehearsal (the SOL balance
   line turns PASS once funded). The kill switch row FAILs by design: it names `KILL_SWITCH=true` until step 4.
3. `npm run live:rehearse`: ONE cycle with the real wallet and `DRY_RUN=true`. It screens, picks, builds
   the real transactions and simulates them against the chain, and sends nothing. Read `data-mainnet/mrbands.log`.
   It runs with `KILL_SWITCH=false` so the open path is exercised, and `LIVE_FEED=false` so a dry-run cycle is not
   published to the public live feed the sites read.
   Pause the paper desk for it (`launchctl bootout gui/$(id -u)/com.bands.mrbands.paper`) so the two do not
   share rate limits; start it again after if the go is not given.
4. Zach says go, in words. Then, and only then, delete the `KILL_SWITCH=true` line from `ops/live.env` and run
   `npm run live:preflight` once more: the kill switch row now reads clear.
5. Stop the paper desk, install the live service:
   ```
   launchctl bootout gui/$(id -u)/com.bands.mrbands.paper
   cp ops/com.bands.mrbands.live.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bands.mrbands.live.plist
   tail -f data-mainnet/mrbands.log
   ```
6. The desk publishes its own journal to both sites after each screen (mode `live`; the sites switch to it
   and the paper history stays in `data-live`).

## Stopping

- `touch data-mainnet/STOP` halts the live desk alone; `touch data-live/STOP` halts the paper desk alone. Every new
  band is blocked at once; exits and claims still run. `rm` the file to lift it. Only the file's existence counts:
  nothing written in it is read, so it holds until someone removes it.
- `touch STOP` in the repo root halts every desk run from it, paper and live alike. Both desks run from the repo root,
  so this is the big red button, not the way to stop one of them.
- `KILL_SWITCH=true` back in `ops/live.env` halts the live desk from its next start (bootout and bootstrap to apply it now).
- `launchctl bootout gui/$(id -u)/com.bands.mrbands.live` stops the loop; open bands stay open on chain
  until the desk runs again or they are closed by hand on Meteora.

## Changing the size later

Edit `ops/live.env` (`MAX_TOTAL_EXPOSURE_SOL`, `MAX_POSITION_SOL`, `MAX_ACTIVE_POOLS`, `GAS_RESERVE_SOL`),
then `launchctl kickstart -k` does NOT reload it: bootout and bootstrap the service again.
