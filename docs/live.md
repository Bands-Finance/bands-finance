# Going live: the first 20 SOL

Mr Bands trades real money from the hot wallet in `.env` (`9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW`,
pinned by `EXPECTED_WALLET`). The live configuration is `ops/live.env` (non-secret, committed) and the
service is `ops/com.bands.mrbands.live.plist`, the only place `DRY_RUN=false` is written. Installing that
service is the act of going live. It is done on Zach's word, in words, and never with the paper desk running.

## What the first run is

- **Money:** 20 SOL in the wallet. 15 at work across 3 bands of at most 5 SOL each; 1.5 SOL kept for gas and rent.
  No USDC, so only SOL-quoted pools can be seated (MRVL/SOL, NVDAx/SOL, MCDx/SOL, BROS/SOL and the like);
  the USDC-quoted stock pools (AMD, SKHY, MU) need USDC in the wallet first.
- **Pools:** Meteora DLMM stock pools that already trade, ranked by fee on depth, at most 3, plus the NVDA
  pairing (`PAIR_STOCK_PINNED_TICKERS=NVDA`). No pools of our own (`PAIR_STOCK_LANE=false`, `PAIR_LANE=false`),
  no launches, no memecoins under the 30-day rule.
- **Who decides:** the desk policy (`POLICY_LIVE=true`); there is no Anthropic key. The guards decide last, as always.
- **Hedging:** off. The stock halves of the straddles run unhedged until Backpack keys exist.
- **Stops:** 15% per band, the circuit and portfolio breakers as in paper, 120 actions a day at most.
- **RPC:** `.env`'s `RPC_URL`. The public endpoint rate-limits; a Helius URL is strongly preferred for real money.

## The order of operations

1. Zach sends 20 SOL to the wallet above.
2. `npm run live:preflight` — every FAIL must be clear (the SOL balance line turns PASS once funded).
3. `npm run live:rehearse` — ONE cycle with the real wallet and `DRY_RUN=true`: it screens, picks, builds
   the real transactions and simulates them against the chain, and sends nothing. Read `data-mainnet/mrbands.log`.
   Pause the paper desk for it (`launchctl bootout gui/$(id -u)/com.bands.mrbands.paper`) so the two do not
   share rate limits; start it again after if the go is not given.
4. Zach says go, in words.
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

- `touch STOP` in the repo root blocks every new band at once; exits and claims still run.
- `launchctl bootout gui/$(id -u)/com.bands.mrbands.live` stops the loop; open bands stay open on chain
  until the desk runs again or they are closed by hand on Meteora.

## Changing the size later

Edit `ops/live.env` (`MAX_TOTAL_EXPOSURE_SOL`, `MAX_POSITION_SOL`, `MAX_ACTIVE_POOLS`, `GAS_RESERVE_SOL`),
then `launchctl kickstart -k` does NOT reload it: bootout and bootstrap the service again.
