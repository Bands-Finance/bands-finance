# Mr Bands at the AnsemHack Clawrena

Source of truth for the entry: https://clawpump.tech/ansemhack (re-read 2026-09-22). Hackathon window
19 Aug to 1 Oct 2026. Judging 28 September to 7 October, winners announced 8 October. The plan and the
decisions that bind it are in docs/sprint.md; where the two disagree, docs/sprint.md is newer.

## The three entry steps, all by Thu 1 October 2026, 24:00 EST (Fri 2 October, 05:00 UTC)

The deadline moved once already: it was 20 September, and the page now reads "1 Oct 24:00 EST (UTC-5)",
its schema.org block giving `endDate: 2026-10-02T00:00:00-05:00`. Rechecked 2026-09-22. We plan to have all
three done by Fri 25 September and recheck them on the entry page by noon ET on Thu 1 October.

"Registering is step one, not the finish line. All three have to be done by 1 October. Miss any and
the judges can't consider you, however good the build is." The page puts it shorter: no token, no award.
Each step is Zach's to do; nothing here can be done from this machine without his accounts.

1. **Register** the team through the form on the /ansemhack page, with the ClawPump x pump.fun track
   ticked. One entry per project. Free, and the token link is optional, so it goes first. The registry is
   the list every judge and partner works from, and the token later attaches to the entry by X handle.
2. **Post the entry on X and follow @clawpumptech**, from the project account. The post is the receipt,
   and following unlocks the stream-slot notification. Slots are booked by DM and go weekly.
3. **Tokenize by 1 October** on ClawPump (or EasyA Kickstart, which cannot be combined with the ClawPump
   tracks). Our token is $MRBANDS on ClawPump; its spec is in "A. The token" below.

A copycat already uses the name: a "Mr Bands" $BANDS launched on pump.fun through ClawPump on 21 September
(mint `JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m`, X `@MrBandsSol`), with our portrait and a link to
mrbands.finance. **It is not ours.** Zach reports it to dev@clawpump.tech and pump.fun, and we register
first.

**Early still pays.** "Deploy early" is scored, and the page is explicit that late entries are judged on
less: "Projects that go live sooner get reviewed sooner, and the panel watches them for longer. An entry
with six weeks of onchain history behind it has more to be judged on than one that lands the week of the
deadline, so shipping early is worth real points." Judging opens 28 September, so a token live on
25 September is watched for all ten days; one live on 1 October is watched for none.

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

What is scored (no weights are published):

- **Builders**: builders onboarded, on-chain volume during the run, attention (streams, clips), deploying
  early, and a bonus for a net-new $ANSEM use case shown live on stream.
- **Traders**: realised performance, risk control, and on-chain volume during the run.
- **Overall**: product, traction, token design, and how big it could get. Every ClawPump entry is in it.

The ClawPump x pump.fun track names market making outright and scores "what you added, not what you
wrapped". Demo format: 15-minute streamed segments, four an hour, on four set questions: team; product and
demo; market, GTM and traction; token utility and vision. "Pitch, demo, get clipped." Sponsors: Helius
free RPC credits, Alchemy credits, Colosseum founder support.

Our lane is the ClawPump x pump.fun track, builder half first: a Meteora DLMM skill other agents install
(ClawPump's own agent has 131 tools and none for Meteora), the platform a stranger's wallet can use, the
real-money casebook, and the token design. The trader half is the frozen real-money run of 17-19 September
told straight, and the paper desk trading in public, labelled paper. No live money through 8 October
(decided 22 September): the live desk stays halted.

## Meteora only; the NVDA pairing is off (Zach, 2026-09-15, revised 2026-09-22)

Zach, 15 September: "we dont want to use any other pools except meteora pools for this". That still
holds: the desk works Meteora DLMM pools only, and `SWAP_DEXES=Meteora DLMM` keeps Jupiter on Meteora
routes (a 1 SOL NVDAx buy costs 0.14% impact that way against 0.05% on the best route anywhere).

The other half of that day, "our agent will be paired with nvda", no longer applies to the token. The
20 September spec paired the token with NVDAx at a 300 bps creator fee and a 2.5 SOL dev buy; on
22 September it was replaced by $MRBANDS on the SOL pair (below). The NVDAx pair would have left a dev bag
a stop could sell, carried US-person and issuer-freeze exposure, and held volume down with the maximum
fee. The stock lane itself (NVDAx/SOL on Meteora, hedged on Backpack's perp) is still in the code; it is
not the token's pair, and like every lane it trades no real money before 8 October.

## What ships, in order

### A. The token (Zach launches it Fri 25 September)

Decided 2026-09-22 (docs/sprint.md, "The token"). A launch can be done once per agent and the pair, fee
and payout are fixed for good, so this is decided once and not reopened. The launch steps are in
docs/token.md. The 20 September spec (NVDAx pair, 300 bps, 2.5 SOL dev buy) is superseded.

| field | value |
|---|---|
| name | Mr Bands |
| ticker | MRBANDS (`BANDS` is taken by the copycat and by "Blue Bands") |
| image | https://mrbands.finance/token-bands.png (the engraved cigar portrait, the site's own mark, 900x900 PNG) |
| venue | ClawPump |
| pump.fun pair | SOL |
| dev buy | none |
| `buybackBps` | 0 |
| paid by | a new cold treasury keypair, created offline, holding about 0.05 SOL; never the desk wallet |

- **Who pays is who gets the creator fees.** ClawPump's docs call `walletAddress` "the Solana base58
  wallet that pays for the launch AND receives the agent's 75% creator-fee share". So the launch is
  self-funded from the treasury: the existing `npm run clawpump -- launch --confirm` with
  `WALLET_SECRET_KEY` set to the treasury key for that one run. No new code, no second launch flow. It
  costs about 0.02-0.05 SOL. The spec in `ops/live.env` under "the Clawrena token" matches this table,
  and test-clawpump fails if it drifts.
- **What it is: a key, not a share.** Holding the official mint in a signed-in wallet opens the engine on
  your own wallet (plan, collect, close; you sign everything). The gate is a balance read on the sign-in
  that already exists: no escrow, no contract, nothing a model can drain. Graduating, closing a real band
  and explaining it, is the other door, and the one we lead with. Free forever without it: the journal,
  the screener, Learn, the casebook, the free lessons tool, the read tools.
- **What it never does:** no buyback or burn, no revenue share, no staking, no holder rewards, no
  airdrop, no bounties, no discount. Prices stay in USD and are paid in USDC over x402. Holding never buys
  a live approval: `AUTO_APPROVE_LIVE` stays off through 8 October.
- **What the desk does with it: nothing.** The desk never holds, swaps or market-makes the token and never
  seats a pool of it. A guard in src/risk enforces it, and `PAIR_HOUSE_MINTS` stays unset through
  8 October. There is no house pool and no house inventory. No model path reaches the launch, the treasury
  or the token: the LLM proposes, the guards decide.
- **How he talks about it.** Every mention carries the disclosure: "our own token, launched by my
  operator. the desk holds none and never trades it. holding <mint> in a signed-in wallet opens the
  engine. it is not a share of anything and pays nobody." He names the mint, never a bare ticker, and
  says other $BANDS tokens are not his. Never a price, chart, cap, holders, volume, fee, % or $ next to it,
  never buy, sell or early, never linked to the desk's P&L, never named in a lesson.
- **Legal.** Zach's call on 22 September: launch the no-rights design knowingly, and get a lawyer's review
  before anything is added to it.

### B. The desk: halted live, trading in public on paper

Decided 2026-09-22: **no live money through 8 October.** The live desk stays halted (`KILL_SWITCH=true`
and data-mainnet/STOP). The scored trader record is the real-money run of 17-19 September: 39 hours on
Meteora from the hot wallet 9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW, every decision journalled, 0
guard violations. It claimed 7.91 SOL of fees against a book that went from 19.79 to 19.71 SOL, down
0.08 (docs/sprint.md, "One headline number"; `npm run record` recomputes it).

The paper desk keeps running on its own DATA_DIR and port, labelled paper everywhere. The model decides
there once `OPENHERMIT_TOKEN` is in `.env`, with a hard credit limit on the key; `DECIDER=policy` rolls it
back. The pitch may say the model proposes on paper; it never says the model trades real money.

### C. The site (honesty fixes and data panels only until 8 October; the look freezes Sun 27 September)

- "Fees are not profit": the real-money record from one sourced number (docs/sprint.md), with the
  casebook of every real seat, losses at the same size as wins.
- The entry itself: a line on the home page naming the Clawrena entry and the official mint, linking the
  ClawPump token page and the X post once they exist, and a not-ours notice for the copycat.
- Nothing on the page may disagree with the journal or the ledger.

### D. The stream segment (15 minutes, the four set questions)

1. Team: who built it, and what Mr Bands is: a Meteora DLMM market maker that publishes every decision
   and every guard veto.
2. Product and demo: one seat laid live on paper with the guards deciding; a losing real-money seat
   against a winning one from the casebook.
3. Market, GTM and traction: the skill other agents install, wallets signed in, proposals decided.
4. Token utility and vision: the key that opens the engine on your own wallet, and why it pays nobody.
   It ends on the red numbers: fees claimed, and the book down all the same.

### E. The X posts

Two voices. The project account announces the entry. Mr Bands' own posts follow the locked core in
docs/mr-bands-agent.md: lowercase, no em dashes, no hype, no price calls, only live numbers, and the
disclosure whenever the token is named (hard rule 6). He does not post the hackathon's template
announcement (it says "Agents powered by $CLAW"); the project account posts it, edited.

The project account (the entry step: tag @clawpumptech):

> Mr Bands is entering the @clawpumptech AnsemHack Clawrena. He's an autonomous LP market maker on
> Meteora: he picks the pools worth a band, lays it, re-centres it, and publishes every decision and
> every guard veto at mrbands.finance. His token is <mint> on ClawPump: a key that opens his engine on
> your own wallet. It pays nobody, and the desk never trades it.

Mr Bands, from his own account (drafts; `npm run talk -- draft` builds them from live data and lints
them against the locked core before anything can post):

> entered the clawrena. i sit between the bands on meteora and collect. every call i make is public at
> mrbands.finance, the red ones too

> our own token, launched by my operator: <mint>. the desk holds none and never trades it. holding it
> in a signed-in wallet opens the engine. it is not a share of anything and pays nobody. other $bands
> tokens are not mine

### The registration form

What the form asks for (read 2026-09-20), and what to put:

| field | answer |
|---|---|
| Project name | Mr Bands |
| X handle | the project account (see below) |
| One-line description | An autonomous LP market maker on Meteora that publishes every decision and every guard veto. |
| Ticker (optional) | MRBANDS |
| Website (optional) | https://mrbands.finance |
| Token link (optional) | the ClawPump/pump.fun page, once the mint exists |
| Tracks | ClawPump Builder/Trader (not EasyA Kickstart - they are mutually exclusive) |
| Primary contact | Zach |

The form can be filled before the token exists: registration and tokenization are separate steps with
the same deadline, and the token link is optional. Registering first is free, and with a copycat already
using the name it is urgent. The X handle is the project account, so that account is the first thing that
exists.

## What the launch needs from Zach (2026-09-22)

1. **The project X account**, following @clawpumptech, and the registration (Tue 22 September).
2. **`CLAWPUMP_API_KEY`**: a `cpk_` key from https://clawpump.tech/dashboard/api, into `.env` (never
   `ops/live.env`, which is committed). Then `npm run clawpump -- pairs` and `cost` (Wed 23 September).
3. **The treasury keypair**, created offline, holding about 0.05 SOL (Wed 23 September). The desk wallet
   stays empty: it was swept on 18 September by `src/scripts/withdraw.ts`, and it must not be the payer,
   because the payer is the creator-fee beneficiary for good. ClawPump has a `PUT /api/fees/wallet` to
   repoint payouts, but the Ed25519 payload it wants is on neither docs page, so we do not rely on it.
4. **The launch** from the treasury on Fri 25 September, attached at /ansemhack/entry if it does not
   attach itself, and the entry posted from the project account.

## Questions for ClawPump (dev@clawpump.tech, @clawpumptech)

- The copycat: can they block or delist it, and is "Mr Bands" protected on the entry list?
- How a SOL-pair token's creator fees count on the fee leaderboard.
- Would an ANSEM creation pair, or market making in the ANSEM-SOL pool, count toward the $ANSEM bonus?
- Does the token auto-attach by X handle when it is launched through the partner API?
- Stream slots: how finalists are picked, and when.
