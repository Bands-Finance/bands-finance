# Mr Bands at the AnsemHack Clawrena

Source of truth for the entry: https://clawpump.tech/ansemhack (read 2026-09-15). Hackathon window
19 Aug to 1 Oct 2026. Judging 21 to 30 September, winners 1 October.

## The three eligibility steps, all by 20 September 23:59 UTC

"No token, no award, however good the build is." Each step is Zach's to do; nothing here can be done
from this machine without his accounts.

1. **Register** the project through the form on the /ansemhack page. One entry per project. The
   registry is the list every judge and partner works from.
2. **Post on X and follow**: announce the entry tagging @clawpumptech, and follow the account
   (following unlocks the stream-slot notification).
3. **Tokenize**: launch the token on ClawPump (or EasyA Kickstart, which cannot be combined with the
   ClawPump tracks). The token IS the entry. Trading fees are the team's from that day, win or lose:
   ClawPump keeps 25%, the creator vault pays out 75% of pump.fun creator fees to the payout wallet.

## Tracks and what is scored

| track | prize | judged on |
|---|---|---|
| Overall winner | $62.5K $ANSEM | best project across all entries |
| ClawPump x pump.fun | $125K $ANSEM + $40K cash | novel tooling or live trading performance |
| Inference Markets (UsePod) | $37.5K $ANSEM + $10K compute | UsePod integration depth |
| EasyA Kickstart | $25K $ANSEM + $25K cash | token utility and metrics |

Scoring criteria across tracks: onchain volume, builder onboarding, attention and streaming presence,
early deployment, token innovation. Demo format: 15-minute streamed segments, four an hour. "Pitch,
demo, get clipped." Sponsors: Helius free RPC credits, Alchemy credits, Colosseum founder support.

Our lane is the ClawPump x pump.fun track on "novel tooling" (an autonomous Meteora market maker that
publishes every decision, makes its own pools, and can be rented by other agents over MCP and x402) and
"live trading performance" (the desk live on Meteora, with the token's own pool in its book).

## Paired with NVDA, Meteora only (Zach, 2026-09-15)

Zach: "our agent will be paired with nvda" and "we dont want to use any other pools except meteora pools
for this". What that means on chain, checked 2026-09-15:

- **The token's pump.fun pair can be NVDAx.** pump.fun already lists tokens launched against NVDAx
  (Jackcat/NVDAx, PEPE/NVDAx, Ainu/NVDAx). ClawPump's partner API takes a custom creation pair
  (`pumpQuoteMint`) and a creator fee of 100-300 bps on it; creator fees then accrue in NVDAx.
  `TOKEN_PUMP_PAIR=NVDAx` makes `npm run clawpump -- quote` resolve it against ClawPump's live catalogue
  and refuse, listing what is offered, if it is not there.
- **Meteora has NVDA pools, thin but busy.** NVDAx/SOL (FCn5zw4g, 0.2% bins, 0.2% fee, $4.1k deep,
  $26.7k traded in a day: ~1.3% of its depth in fees daily) and NVDAx/USDC (F4inHs4R, 0.25%, $20.7k deep,
  $12.5k a day). Raydium's NVDAx/USDC holds $2.1M; under the rule it is not used.
- **The desk supplements them.** `PAIR_STOCK_PINNED_TICKERS=NVDA` pins the best Meteora NVDA pool the
  wallet can fund into the book as a straddle hedged on Backpack's NVDA perp, floors waived (the guards,
  the stop, the basis check stay). The seat is capped at half the band's depth, so in a $4k pool it stays
  a supplement, not a takeover. If Meteora had no NVDA pool, the stock pair lane would make our own.
- **Swaps stay on Meteora.** `SWAP_DEXES=Meteora DLMM` restricts Jupiter to Meteora DLMM routes. A 1 SOL
  NVDAx buy costs 0.14% impact that way against 0.05% on the best route anywhere. Every xStock the desk
  trades has a Meteora-only route (COIN is the expensive one at 2.5% per SOL).
- **The house pool can be quoted in NVDAx on Meteora.** The program accepts it on the customizable
  permissionless path: NEVIDIA/NVDAx was created that way (bin step 400, 0.5%). Our book's quote
  accounting is SOL or USDC today, so a BANDS/NVDAx house pool is the next build; until then the house
  pool is BANDS/SOL, and SOL holders reach BANDS through the NVDAx/SOL pool the desk supplements.

## What ships, in order

### A. The token (Zach, by 20 September)

- Launch through ClawPump's partner API or dashboard: `POST https://clawpump.tech/api/v1/launch`
  (or the self-funded flow) with an agent created first (`create_agent` / `POST /agents`). Standard
  SOL pair; `pumpCreatorFeeBps` cannot be set on SOL pairs. Register the payout wallet
  (`PUT /api/fees/wallet`, Ed25519-signed) so the 75% creator share lands in the desk's wallet.
- Name and ticker are Zach's call. Working proposal: **BANDS**. Utility that is true on day one and
  demonstrable on stream: the desk makes and works the token's Meteora pool itself; creator fees and
  LP fees fund the book; other agents rent Mr Bands' tools with USDC over x402 (already built).
- Once the mint exists: set `PAIR_HOUSE_MINTS=<mint>` on the desk. The pump.fun pair lane then makes
  BANDS/SOL on Meteora DLMM and seats the house band, with no launch-style expiry (it is ours).

### B. The desk live on Meteora (this week, staged; Zach flips DRY_RUN)

Per docs/go-live.md, compressed to the timeline:

1. Credentials from Zach: ANTHROPIC_API_KEY (the model's own reasoning on the journal is the showcase;
   without it the desk policy decides and the live gate POLICY_LIVE must be set on purpose),
   RPC_URL from Helius (free credits through the hackathon), the funded hot wallet
   9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW.
2. Stage 0: DRY_RUN=true with real balances and the real model for one day. `npm run preflight` READY.
3. Stage 1: DRY_RUN=false, LIVE_VENUES=meteora-dlmm (the default), TRADABLE_VENUES=meteora-dlmm,
   MAX_TOTAL_EXPOSURE_SOL small (10 SOL) for two days. Raydium stays dormant. PAIR_LIVE stays false
   until one made pool has been simulated against the funded wallet.
4. Stage 2: the book Zach wants for the showcase, plus PAIR_LIVE=true for the house token.

The paper desk keeps running beside it on its own DATA_DIR and port until the live desk replaces it.

### C. The site (this week)

- "Pools he made": a panel listing every pool the desk created, with its fee, bin step, the routing
  model's share and what it has earned. Judges can see the ability, not read about it.
- The entry itself: a line on the home page naming the Clawrena entry and the token, linking the
  ClawPump token page and the X post, once they exist.
- The record: fees, volume through our pools, and the journal stay the centrepiece. Nothing on the
  page may disagree with the journal.

### D. The stream segment (15 minutes)

1. One line: an autonomous market maker for Meteora that publishes every decision and makes its own
   pools. Show bands.finance live.
2. The journal: a real decision from today, the reasoning, the guards' verdict, the transaction.
3. A pool he made: BANDS/SOL, the model's share, the fees so far, the re-centre when price moved.
4. The stock lane: NVDAx/SOL on Meteora, hedged on Backpack; why one hop beats two.
5. Other agents: `npx` the MCP server, rent a tool over x402, get your own Mr Bands.
6. What is real and what is paper: say it plainly. The judges reward honesty on stream more than a
   number nobody can check.

### E. The X posts

Two accounts, two voices. Zach's post announces the entry. Mr Bands' own posts follow the locked
core in docs/mr-bands-agent.md: lowercase, no em dashes, no hype, no price calls, only live numbers,
and a clear disclosure whenever the token is named (hard rule 6).

Zach, from the operator account (the eligibility step: tag @clawpumptech):

> Mr Bands is entering the @clawpumptech AnsemHack Clawrena. He's an autonomous LP market maker on
> Meteora: he picks the pools worth a band, lays it, re-centres it, and publishes every decision and
> every guard veto at bands.finance. Paired with NVDA. Token launched on ClawPump.

Mr Bands, from his own account (drafts; `npm run talk -- draft` builds them from live data and lints
them against the locked core before anything can post):

> entered the clawrena. i sit between the bands on meteora and collect. nvdax/sol is my pair.
> every call i make is public at bands.finance, the red ones too

> disclosure: $bands is our token, launched by my operator on clawpump. i make its pool, i don't
> call its price

## Open decisions for Zach

- Ticker and name; the token image; whether the dev buy is 0.
- The live book size for the showcase (10 SOL to start is the doc's recommendation).
- Whether the stock lane goes live in week one or stays paper for the stream (it is a new pool with a
  straddle and a Backpack hedge: more moving parts than a house pool).
