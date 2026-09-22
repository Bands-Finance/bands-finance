# Mr Bands at the AnsemHack Clawrena

Source of truth for the entry: https://clawpump.tech/ansemhack (re-read 2026-09-20). Hackathon window
19 Aug to 1 Oct 2026. Judging 28 September to 7 October, winner announced 8 October.

## The three eligibility steps, all by 1 October 2026, 24:00 EST (UTC-5)

THE DEADLINE MOVED. It was 20 September; the page now reads "Extended through 1 Oct · 24:00 EST" and
its own schema.org block gives `endDate: 2026-10-02T00:00:00-05:00`. Checked 2026-09-20 06:55Z.

"Registering is step one, not the finish line. All three have to be done by 1 October. Miss any and
the judges can't consider you, however good the build is." Each step is Zach's to do; nothing here can
be done from this machine without his accounts.

1. **Register** the project through the form on the /ansemhack page. One entry per project. The
   registry is the list every judge and partner works from.
2. **A reachable project X account**: announce the entry tagging @clawpumptech, and follow the account
   (following unlocks the stream-slot notification). The announcement post is the receipt.
3. **Tokenize**: launch the token on ClawPump (or EasyA Kickstart, which cannot be combined with the
   ClawPump tracks). The token IS the entry. Trading fees are the team's from that day, win or lose:
   ClawPump keeps 25%, the creator vault pays out 75% of pump.fun creator fees to the payout wallet.

**Early still pays.** The page is explicit that late entries are judged on less: "Projects that go live
sooner get reviewed sooner, and the panel watches them for longer. An entry with six weeks of onchain
history behind it has more to be judged on than one that lands the week of the deadline, so shipping
early is worth real points." Judging opens 28 September, so a token live this week is watched for ten
days; one live on 1 October is watched for none.

## Tracks and what is scored

| track | prize | judged on |
|---|---|---|
| Overall winner | $62.5K $ANSEM | best project across all entries |
| ClawPump x pump.fun | $125K $ANSEM + $40K cash | novel tooling or live trading performance |
| Inference Markets (UsePod) | $37.5K $ANSEM + $10K compute | UsePod integration depth |
| EasyA Kickstart | $25K $ANSEM + $25K cash | token utility and metrics |

$350,000 in total: $250,000 of $ANSEM (0.1% of supply) across the four awards, vesting linearly over
three months behind a one-month cliff through Streamflow, plus $65,000 of sponsor cash and $10,000 of
compute that land the day you win. Fifteen judges, including Ansem, the Solana Foundation, pump.fun,
Helius, Delphi, Haun Ventures and Colosseum. The Overall award is automatic: every tokenized entry is
already in it.

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

### A. The token (Zach, by 1 October; sooner is worth points)

**Superseded on 22 Sep.** The token is now $MRBANDS on the SOL pair, no dev buy, `buybackBps` 0, paid for by a new
treasury keypair, and the desk never touches it; `PAIR_HOUSE_MINTS` stays unset. The steps are in docs/token.md
and the reasons in docs/sprint.md. What follows is the 20 Sep spec, kept for the record.

Locked 2026-09-20. The spec lives in `ops/live.env` under "the Clawrena token" and is validated by
`tokenSpec()` before any call is made:

| field | value |
|---|---|
| `TOKEN_NAME` | Mr Bands |
| `TOKEN_SYMBOL` | BANDS |
| `TOKEN_IMAGE_URL` | https://mrbands.finance/token-bands.png (the engraved cigar portrait, the site's own mark, 900x900 PNG) |
| `TOKEN_PUMP_PAIR` | NVDAx |
| `TOKEN_CREATOR_FEE_BPS` | 300 - the maximum a custom pair allows |
| `TOKEN_DEV_BUY_SOL` | 2.5 |

- Launch with `npm run clawpump -- launch --confirm` (self-funded flow: preflight quote -> the desk
  wallet pays the exact SOL -> completion carries `txSignature` + `preflightToken`, idempotent on the
  signature). The paying wallet IS the fee-share beneficiary: ClawPump's docs call `walletAddress`
  "the Solana base58 wallet that pays for the launch AND receives the agent's 75% creator-fee share".
  So whichever wallet pays is the one creator fees land in, for as long as the token trades.
- **The NVDAx pair, and what it costs us.** Zach's call, re-confirmed 2026-09-20. Creator fees accrue
  in NVDAx and a creator fee is settable (pump.fun forbids one on the SOL pair), which is where the
  100-300 bps choice comes in. The price of it: buyers need NVDAx to trade the curve, so the onchain
  volume the judges count is harder won than on a SOL pair.
- **The house pool is still BANDS/SOL.** The creation pair and the Meteora pool are separate choices.
  Once the mint exists, `PAIR_HOUSE_MINTS=<mint>` makes the desk create and work BANDS/SOL on Meteora
  DLMM with no launch-style expiry (it is ours), which the book's SOL quote accounting already handles;
  a BANDS/NVDAx pool would need non-SOL quote accounting, which is unbuilt. Seating that pool needs
  BANDS in the wallet, which is what the dev buy is for: at 0 the desk has to buy its own float first.
- Utility that is true on day one and demonstrable on stream: the desk makes and works the token's
  Meteora pool itself; creator fees and LP fees fund the book; other agents rent Mr Bands' tools with
  USDC over x402 (already built).

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

> entered the clawrena. i sit between the bands on meteora and collect. $bands trades against nvdax.
> every call i make is public at mrbands.finance, the red ones too

> disclosure: $bands is our token, launched by my operator on clawpump. i make its pool, i don't
> call its price

### The registration form

What the form asks for (read 2026-09-20), and what to put:

| field | answer |
|---|---|
| Project name | Mr Bands |
| X handle | the project account (see below) |
| One-line description | An autonomous LP market maker on Meteora that publishes every decision and every guard veto. |
| Ticker (optional) | BANDS |
| Website (optional) | https://mrbands.finance |
| Token link (optional) | the ClawPump/pump.fun page, once the mint exists |
| Tracks | ClawPump Builder/Trader (not EasyA Kickstart - they are mutually exclusive) |
| Primary contact | Zach |

The form can be filled before the token exists: registration and tokenization are separate steps with
the same deadline, and the token link is optional. Registering first is free and costs nothing if the
launch slips a day. Step 2 needs a reachable project X account, which is its own open question: the
drafts above assume an operator account and Mr Bands' own account.

## What is blocking the launch (2026-09-20)

Everything that can be done from this machine is done. Three things are Zach's:

1. **`CLAWPUMP_API_KEY`** - a `cpk_` key from https://clawpump.tech/dashboard/api, into `.env` (never
   `ops/live.env`, which is committed). Without it every keyed read refuses cleanly:
   `npm run clawpump -- quote` stops at "GET /api/v1/pump-pairs needs CLAWPUMP_API_KEY". With it,
   `pairs` confirms NVDAx is in today's catalogue and `cost` prints what the launch costs.
2. **SOL in the paying wallet.** `9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW` is at **0** - the desk
   was stopped on 18 September and `src/scripts/withdraw.ts` swept it to
   `Agg4bixWVhuGHwATMeA47Dvju3dUXmiCQZE7Kn47ATnT`. It needs the creation fee plus the dev buy plus gas.
   If the creator fees should land somewhere else, that wallet has to be the one that pays.
Decided 2026-09-20, already in `ops/live.env`: creator fee **300 bps** (the maximum; 3% of every trade
is ours, at the cost of some of the volume the judges count), dev buy **2.5 SOL**, and the desk wallet
pays - so it is also the wallet the 75% creator-fee share is paid to for as long as the token trades.
ClawPump has a `PUT /api/fees/wallet` to repoint payouts, but the Ed25519 payload it wants is on
neither docs page, so repointing means the dashboard or dev@clawpump.tech, not our code.

## Open decisions for Zach

- The live book size for the showcase (10 SOL to start is the doc's recommendation), and whether the
  desk goes back up at all before judging opens on 28 September. It has been dark since 18 September
  and the public feed still shows that day's last decision.
- Whether the stock lane goes live in week one or stays paper for the stream (it is a new pool with a
  straddle and a Backpack hedge: more moving parts than a house pool).
