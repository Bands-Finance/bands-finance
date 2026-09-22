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
   ticked, and the Inference Markets (UsePod) track as well (UsePod is how he will pay for his own
   inference from his own wallet; the same entry is judged in both). One entry per project. Free, and the token link is optional, so it goes first. The registry is
   the list every judge and partner works from, and the token later attaches to the entry by X handle.
2. **Post the entry on X and follow @clawpumptech**, from the project account. The post is the receipt,
   and following unlocks the stream-slot notification. Slots are booked by DM and go weekly.
3. **Tokenize by 1 October** on ClawPump (or EasyA Kickstart, which cannot be combined with the ClawPump
   tracks). His token will be $BANDS on ClawPump; its spec is in "A. The token" below.

A copycat already uses the name: a "Mr Bands" $BANDS launched on pump.fun through ClawPump on 21 September
(mint `JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m`), with his portrait, a link to mrbands.finance and a link
to his own X account, @MrBandsSol, all borrowed to look genuine. **It is not his.** Left as is (Zach, 22 Sep: no
report, no email); we register first. His own token will carry the same ticker, $BANDS (decided 22 September), so the mint is the only
way to tell them apart: the copycat is always named by its mint, and his is the mint he posts from
@MrBandsSol once it launches (the token is off the site for now).

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
22 September it was replaced by the SOL pair, ticker $BANDS (below). The NVDAx pair would have left a dev bag
a stop could sell, carried US-person and issuer-freeze exposure, and held volume down with the maximum
fee. The stock lane itself (NVDAx/SOL on Meteora, hedged on Backpack's perp) is still in the code; it is
not the token's pair, and like every lane it trades no real money before 8 October.

## What ships, in order

### A. The token (he launches it himself Fri 25 September, armed by Zach; not launched yet)

Decided 2026-09-22 (docs/sprint.md, "The token"). A launch can be done once per agent and is irreversible,
so this is decided once and not reopened. The runbook is docs/launch.md. The 20 September spec (NVDAx pair,
300 bps, 2.5 SOL dev buy) and the self-funded partner-API plan (docs/token.md) are superseded.

| field | value |
|---|---|
| name | Mr Bands |
| ticker | BANDS (Zach, 22 September, over MRBANDS, knowingly: the copycat and "Blue Bands" use it too, so the mint tells his apart) |
| description | `TOKEN_DESCRIPTION` in ops/live.env; it names no site |
| website | none, and nothing that links the token to the site, the image URL included |
| venue | ClawPump, through its MCP: `launch_metaplex_genesis_token`, a Metaplex Genesis launch |
| first buy | 0 |
| pair, buyback | ClawPump's defaults: no MCP tool can set them |
| ClawPump agent | `64fd21e8-1d52-4a95-9c19-4db0069cbb4b` |
| paid by | that agent's custodial wallet `4HQdS1HqnumqLqJT81tdUtf969Xa6cTo9jc1mEadxYyE`, whose keys ClawPump keeps |
| creator fees | 75% accrue to that agent in ClawPump's custody |

- **Accepted knowingly (Zach, 22 Sep).** ClawPump's MCP has no self-funded launch, no fee-recipient field, no
  pair field and no buyback field. Its gasless tool refuses while the platform reports `gasless_available`
  false, so the one tool that launches is the Genesis one. ClawPump's docs: "ClawPump retains creator-wallet
  custody" and "Your agent earns 75% of future creator fees". So the fees are held by ClawPump for his ClawPump
  agent, not paid to a wallet he holds; moving them out needs a whitelist entry and a transfer on ClawPump.
- **He launches it himself.** His gateway agent calls `token_launch` on a loopback bridge that pins the spec in
  code and calls nothing of ClawPump's but the status read and that one launch. Zach arms it with a single-use
  nonce, and it is never offered to a desk cycle or an X mention (docs/launch.md).
- **What it is: his own token, a key, not a share.** Once the hold gate ships (planned Sun 27 Sep, after the launch; not in code yet), holding the official mint in a signed-in wallet will open the engine on
  your own wallet (plan, collect, close; you sign everything). The gate is a balance read on the sign-in
  that already exists: no escrow, no contract, nothing a model can drain. Graduating, closing a real band
  and explaining it, is the other door, and the one we lead with. Free forever without it: the journal,
  the screener, Learn, the casebook, the free lessons tool, the read tools.
- **What it will never do:** no buyback or burn, no revenue share, no staking, no holder rewards, no
  airdrop, no bounties, no discount. Prices stay in USD and are paid in USDC over x402. Holding never buys
  a live approval: `AUTO_APPROVE_LIVE` stays off through 8 October.
- **What the desk does with it: nothing.** The desk never holds, swaps or market-makes the token and never
  seats a pool of it. A guard in src/risk enforces it, and `PAIR_HOUSE_MINTS` stays unset through
  8 October. There is no house pool and no house inventory. His one path to ClawPump is the launch bridge,
  in one owner turn Zach arms; it holds the spec, and the ClawPump key never reaches the gateway.
- **How he talks about it.** Future tense until it launches. Once live, every mention carries the
  disclosure: "my own token. i launched it myself. the desk holds none and never trades it. holding <mint> in
  a signed-in wallet opens the engine. not a share, it pays nobody who holds it. its trades pay a cut
  to my agent on clawpump, which keeps the keys." It posts only once the hold gate is live. He names the mint, never a bare ticker. The copycat
  shares the ticker, so he names it by its mint as not his, never "other $bands tokens". Never a price,
  chart, cap, holders, volume, fee, % or $ next to it, never buy, sell or early, never linked to the
  desk's P&L, never named in a lesson.
- **Legal.** Zach's call on 22 September: launch the no-rights design knowingly, and get a lawyer's review
  before anything is added to it.

### B. The desk: halted live, trading in public on paper

Decided 2026-09-22: **no live money through 8 October.** The live desk stays halted (`KILL_SWITCH=true`
and data-mainnet/STOP). The scored trader record is the real-money run of 17-19 September: 39 hours on
Meteora from the hot wallet 9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW, every decision journalled, 0
guard violations. It claimed 7.91 SOL of fees (3.27 of it paid in tokens, valued when claimed) in 111
claims, 205 moves and 293 transactions, against a book that went from 19.79 to 19.71 SOL, all cash, down
0.08. Fees are not profit (docs/sprint.md, "One headline number"; `npm run record` recomputes it).

The paper desk keeps running on its own DATA_DIR and port, labelled paper everywhere: real pools and live
prices, pretend money. Today his rulebook (the desk policy) makes every proposal there and the guards
decide. His model on the OpenHermit gateway takes over the proposing once `OPENHERMIT_TOKEN` is in `.env`,
with a hard credit limit on the key; `DECIDER=policy` rolls it back. The pitch may say the model proposes
on paper once it does; it never says the model trades real money.

### C. The site (honesty fixes and data panels only until 8 October; the look freezes Sun 27 September)

- "Fees are not profit": the real-money record from one sourced number (docs/sprint.md), with the
  casebook of every real seat, losses at the same size as wins.
- (Held, Zach 22 Sep: the token is not linked to the website yet; see docs/sprint.md Decisions 8.) The entry itself: a line on the home page naming the Clawrena entry and the official mint, linking the
  ClawPump token page and the X post once they exist, and a notice, naming the copycat by its mint, that it is not his.
- Nothing on the page may disagree with the journal or the ledger.

### D. The stream segment (15 minutes, the four set questions)

1. Team: Mr Bands is the founder, and Zach, his architect and advisor, works for him. What he is: a
   market maker on Meteora DLMM, tokenized stocks one part of his book, who publishes every decision and
   every guard veto.
2. Product and demo: one seat laid live on paper, him proposing and the guards deciding; a losing real-money seat
   against a winning one from the casebook.
3. Market, GTM and traction: the skill other agents install, wallets signed in, proposals decided.
4. Token utility and vision: his own token, the key that will open the engine on your own wallet, and why it pays its holders nothing (its creator-fee share is held by ClawPump for his agent there).
   It ends on the red numbers: fees claimed, and the book down all the same.

### E. The X posts

Two voices. The project account announces the entry. Mr Bands' own posts follow the locked core in
docs/mr-bands-agent.md: lowercase, no em dashes, no hype, no price calls, only live numbers, and the
disclosure whenever the token is named (hard rule 6). He does not post the hackathon's template
announcement (it says "Agents powered by $CLAW"); the project account posts it, edited.

The project account (the entry step: tag @clawpumptech):

> Mr Bands is entering the @clawpumptech AnsemHack Clawrena. He's an autonomous market maker on
> Meteora DLMM, with tokenized stocks one part of his book: he lays bands of liquidity around the price
> in the pools his screener ranks, proposes every move, lets his guards decide, and publishes every
> decision and every guard veto at mrbands.finance. His book is on paper for now. His own token is
> <mint> on ClawPump: a key that will open his engine on your own wallet. It pays holders nothing, its
> creator-fee share is held by ClawPump for his agent there, and the desk never trades it.

Mr Bands, from his own account (drafts; `npm run talk -- draft` builds them from live data and lints
them against the locked core before anything can post):

> entered the clawrena. i sit between the bands on meteora and collect. every call i make is public at
> mrbands.finance, the red ones too

> my own token. i launched it myself. the desk holds none and never trades it. holding <mint> in a
> signed-in wallet opens the engine. not a share, it pays nobody who holds it. its trades pay a cut to my agent
> on clawpump, which keeps the keys.

> the "mr bands" token at JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m is not mine. it borrows my name, my
> picture and my links. same name, same ticker, so the mint is the only way to tell. mine is the one i posted

(The second and third pass the lint as written, the second at 279 characters with a 44-character mint. The second does not post until the hold gate is
live, since it says holding the mint opens the engine; see docs/sprint.md, "How he talks about it".
The first names mrbands.finance, which the lint's link allowlist does not yet carry, so it is refused
until the allowlist or the line changes.)

### The registration form

What the form asks for (read 2026-09-20), and what to put:

| field | answer |
|---|---|
| Project name | Mr Bands |
| X handle | the project account (see below) |
| One-line description | An autonomous market maker on Meteora DLMM, tokenized stocks one part of his book, that publishes every decision and every guard veto. |
| Ticker (optional) | BANDS |
| Website (optional) | https://mrbands.finance |
| Token link (optional) | the ClawPump/pump.fun page, once the mint exists |
| Tracks | ClawPump Builder/Trader, and Inference Markets (UsePod) (not EasyA Kickstart: it cannot be combined with the ClawPump tracks) |
| Primary contact | Zach |

The form can be filled before the token exists: registration and tokenization are separate steps with
the same deadline, and the token link is optional. Registering first is free, and with a copycat already
using the name it is urgent. The X handle is the project account, so that account is the first thing that
exists.

## What the launch needs from Zach (2026-09-22)

1. **The project X account**, following @clawpumptech, and the registration (Tue 22 September).
2. **The launch prerequisites** (docs/launch.md): the stored launch metadata fixed on the ClawPump dashboard
   (symbol BANDS, the description, no website), the marketplace listing off, the rotated `cpk_` key in
   `~/.mrbands/clawpump.env` (never the repo's `.env`), the pinned ClawPump server installed, and his ClawPump
   agent's custodial wallet funded with the Genesis cost plus a margin (Wed 23 to Thu 24 September).
3. **The dry run and the gateway provisioning** (docs/launch.md), with the bridge in dry-run mode.
4. **Arming the launch** on Fri 25 September: his schedules paused, the bridge live, `npm run launch:arm`,
   then the one-shot owner turn in which he launches it himself; attached at /ansemhack/entry if it does not
   attach itself, and the entry posted.

## Open questions (not asked: Zach, 22 Sep, "lets ignore emailing clawpump team")

We are not writing to ClawPump. These stay open, and the plan works either way:
- How a Metaplex Genesis token's creator fees count on the fee leaderboard, and whether a Genesis launch
  counts for the ClawPump x pump.fun track.
- Whether an ANSEM creation pair, or LP market-making in the ANSEM-SOL pool, counts toward the $ANSEM bonus.
- Whether the token auto-attaches by X handle when launched through ClawPump's MCP; if not, paste the mint at
  clawpump.tech/ansemhack/entry.
- How stream slots and finalists are picked (a DM to @clawpumptech from his account is still the way to ask for a
  slot).
- What exactly "the Hermes harness" covers.
