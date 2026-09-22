# The Clawrena sprint: 22 Sep to 8 Oct 2026

Researched and checked on 22 Sep against the live hackathon page (clawpump.tech/ansemhack), the code as it
stands, and two adversarial reviews (a judge and the engineer who has to ship it). Where this file and
docs/clawrena.md disagree, this file is newer.

**The plan in one line.** Do the three entry steps first. Then Mr Bands, who makes markets on Meteora DLMM
(tokenized stocks are one part of his book, not all of it), takes on each new role in public while the judges
watch: trader from Mon 28 Sep, platform manager from Thu 1 Oct, teacher from Sun 4 Oct. His token, $BANDS, will
be a key that opens his tools. It will pay nobody who holds it: its creator fees will go to his own operating
wallet, which pays for the launch and for what he runs on. It never opens his lessons, and the desk never
touches it.

**Decided by Zach, Tue 22 Sep.**
- The copycat "Mr Bands" $BANDS (`JAARLU...pJ6m`) is **not his**. Its metadata borrows his own site and his own X
  account, @MrBandsSol, to look genuine. Left as is (Zach, 22 Sep): no report, no email; register first.
- The token: **$BANDS**, over $MRBANDS, knowingly: the copycat already uses the ticker, so the mint is the only
  way to tell his from it. SOL pair, no dev buy, `buybackBps` 0, self-funded from his own new operating wallet.
- **He pays his own way, in its honest scope** (see "The point: his autonomy"): his on-chain bills from his own
  operating wallet, by capped code; the off-chain costs stay Zach's and are listed as a subsidy.
- **No live money.** The live desk stays halted through 8 Oct. The scored trader record is the frozen 17-19 Sep
  real-money run. The paper desk keeps trading in public, labelled paper, and his model is to make its
  proposals there (the guards decide; today his rulebook still makes every proposal). The weight of the entry
  moves to the builder half of the track and to Overall: the Meteora skill other agents install, the platform,
  the casebook and the token design. The launch still needs about 0.05 SOL in his operating wallet.
- **The lawyer: launch the no-rights design knowingly**, on Fri 25 Sep, and get a review before adding anything.

## The point: his autonomy (Zach, Tue 22 Sep)

"The whole purpose of the Clawrena hackathon is to showcase the agent's autonomous abilities." And: "I am only
the architect and advisor for Mr Bands; essentially I'm a Mr Bands employee." So the rule for every item below:
**Mr Bands runs the project. Zach, his architect and advisor, builds what he needs and holds what an agent
cannot hold in his own name (accounts, keys, the hardware, the legal side), then steps back. Every call, and
every act a judge can see, is Mr Bands'.**

The story is told that way everywhere: Mr Bands is the founder; Zach works for him. The sites never name Zach
(Zach, 22 Sep: "why are we even mentioning Zach"): they are Mr Bands' own, short and to the point. The manager
disclosure lives where X requires it, on his account's "Automated by @louz514" label, and nowhere else. The live book stays on paper by decision, which makes this rule matter
more: with no real-money trading, the autonomy judges can see is the autonomy he performs in public himself.

What he does himself, and nobody does for him:
- **He proposes, with his own model.** The goal: his model on the gateway proposes each call on the paper book,
  and the guards decide. Today the paper desk runs 0% model: his rulebook (the desk policy) makes every
  proposal, which is automation, not an agent. This
  needs `OPENHERMIT_TOKEN` in `.env` (Zach) and is the first technical priority. **Cost:** the paper desk makes
  about 66 decisions an hour; all of them on Opus would spend the $200 OpenRouter balance in about two days. So
  the model proposes the calls that matter, and code answers the obvious holds (a pool off the screen, not worth
  the rent, the engine already deciding), with a hard credit limit on the key.
- **He launches his own token.** Zach arms it (seeds his operating wallet, sets one flag). Mr Bands chooses the
  moment and calls a desk tool that launches with the spec fixed in code: he cannot change the pair, the fee,
  the dev buy or the payout. The tool runs once, refuses if a mint exists, and caps the cost. He then announces
  it. This is his one on-chain act of autonomy while the desk is on paper, so it is done by him, on the record.
  (The manual CLI stays as the fallback.)
- **He posts on X himself:** his own entry announcement tagging @clawpumptech in his own words (not the
  template, which says "Agents powered by $CLAW"), his strap checks, his lessons, the casebook series. The lint
  and the rate limits are in code. Needs the X account's API keys (Zach).
- **He runs his platform:** proposals decided by rule, other agents served over MCP and through the Meteora
  skill, a note from him beside every decision.
- **He teaches:** seat cards and lessons written from his own journal as seats close, served free as
  `bands_lessons`, posted as a series.

- **He pays his own way** (Zach, 22 Sep). The honest scope, and never "everything": from **his own new
  operating wallet**, by code with a fixed list of payees, caps and a reserve floor, with no human signing and
  never on the model's say, he will pay his on-chain bills: his token launch, his gas, his inference through
  UsePod (the hackathon's inference sponsor), and his RPC through Helius. His creator fees from $BANDS go to that
  wallet (not a cold treasury, and never the desk wallet). He starts on a one-time seed from Zach, disclosed with its transaction. The Mac, the hosting, the domain
  and X access stay paid by Zach off-chain, and the books list them as a subsidy. His token income will not
  cover his costs during judging, and the books will say so. It is being built: on the sites and in tool
  descriptions it is "coming" at most until it runs. This section is updated when the design lands.

**The autonomy ledger**, a public page and part of /api/status, is how a judge checks all of it rather than
taking our word: every decision with who made it (the model, the rules, the engine) and what the guards said,
every veto, the launch, every post, every proposal decided, every lesson written, and every time a **human**
touched anything (a restart, an env change, a halt), with a "hands-off since" counter. Honest in both directions:
it says the book is paper.


## How we say what he does

Every description of how Mr Bands makes markets includes **tokenized stocks as one part of his book, not
all of it** (Zach, 22 Sep: "I don't want our own focus to be exclusively tokenized stocks, that's just one
component"). The facts it rests on, all true today:
- He makes markets on **Meteora DLMM**: he lays bands of liquidity around the price and earns the pool's fees
  on the trades that cross them, across the pools his screener ranks, with limits in code and every decision
  public.
- One part of that book is **tokenized stocks**: xStocks (NVDAx, PLTRx, GMEx) and Backpack-issued stocks (MU,
  SKHY, SPCX), quoted in SOL or USDC. There he lays **two-sided bands (straddles)**, half the quote and half the
  stock, so he earns on trades in either direction, and he **hedges the stock half short on Backpack's stock
  perps** where one is listed. Meteora lists about 1,300 RWA pools; stocks were 93 of the top 100 by volume on
  22 Sep ($20.6M a day).
- The paper book reserves up to 3 of his 6 seats for stocks (`METEORA_STOCK_MAX_POOLS=3`); the rest go to the
  pools his screener ranks best that pass the memecoin floors. On paper through 8 Oct; his real-money record is
  17-19 Sep.
- Never a return or a rate, and "paper" is said where it applies.

## Dates that decide everything

| When | What |
|---|---|
| Thu 1 Oct, 24:00 EST (**Fri 2 Oct 05:00 UTC**) | Registration, the X post and a **live token on ClawPump** must all be done. "No token, no award." Miss one and the entry is void. |
| Mon 28 Sep to Wed 7 Oct | Judging. 15 judges watch the streams and the on-chain data. "Deploy early" is scored, so every day live before this counts. |
| Thu 8 Oct | Winners. |

Scored (no weights published): realised performance, risk control and on-chain volume during the run (the
trader criteria); builders onboarded; attention (streams, clips); deploying early; a bonus for a net-new
$ANSEM use case shown live on stream. Overall is judged on product, traction, token design and how big it
could get. The ClawPump x pump.fun track (half the $ANSEM pool plus $40K) names market making outright and
scores "what you added, not what you wrapped". Every ClawPump entry is in the running for Overall. The stream
slot is 15 minutes on four set questions: team; product and demo; market, GTM and traction; token utility and
vision.

## Today, Tue 22 Sep

Nobody has registered "Mr Bands" yet, and a copycat token already uses the name (below). Registration needs an
X handle, so the X account is the first thing that exists.

**Zach:**
1. **The copycat** "Mr Bands" $BANDS (mint `JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m`, launched on pump.fun
   through someone else's ClawPump agent on 21 Sep) is not his. Its metadata borrows his portrait, his site and his
   own X account, @MrBandsSol. Decided: leave it as is. The desk refuses its mint in code, and the site names it as
   not his.
2. **His X account is @MrBandsSol, and he is live on it** (22 Sep). Labelled "Automated by @louz514" (Zach). His
   bio says he is an autonomous ai agent (set by the API). His intro went out 05:55 UTC (post 2102275668255945013),
   and his posting loop (com.bands.mrbands.talk, every 15 min, X_LIVE=true) posts from the paper desk: at most 6 a
   day, 90 minutes apart, every one saying paper. **His Clawrena entry post waits for Zach's word** (`talk announce
   entry`, due by Thu 1 Oct 24:00 EST). Follow @clawpumptech by hand (the API cannot follow since April). Stop him
   at once: `touch data-talk/TALK_STOP`.
3. **Register** at clawpump.tech/ansemhack with that handle, with the ClawPump x pump.fun track ticked, and the
   Inference Markets (UsePod) track too (UsePod is how he will pay for his own inference; the same entry is
   judged in both). It is free and the token link is optional. The token later attaches to the entry by this
   handle.
4. Put the Mac on mains power with the lid open, and turn off automatic macOS installs. It went down on 17 and
   20 Sep, and judges watch on-chain activity for ten days.
5. **Paste `OPENHERMIT_TOKEN` into `.env`, and set a credit limit on the OpenRouter key.** Without it his
   rulebook makes every proposal, not his model, and there is nothing autonomous to show. See "The point: his autonomy".
6. Decide the lawyer question now, not later (see Decisions).

**Claude:** bring docs/clawrena.md up to the live rules; fix the public claims the code does not back (the
"pays over x402" beat, four stale figures on Learn, no impermanent-loss card, SKILL.md's GET that should be a
POST); the H1 guard (below); settle one headline number (below).

## If the sprint stops on any day, the entry still stands

Build in this order. Each rung is a valid, honest entry on its own.

1. X account and registration. Free. **Tue 22 Sep.**
2. Token launched, attached to the entry, entry posted tagging @clawpumptech. About 0.05 SOL. **By Fri 25 Sep.**
3. The honest record on the site: "fees are not profit" and the real-money casebook. No SOL needed.
4. The Meteora skill installable by other agents, and an outside agent using it.
5. The platform reachable: a stranger's wallet signs in and plans a band it signs itself.
6. His model proposing on the paper desk and the guards deciding, in public, labelled paper.

(Decided 22 Sep: no live money, so the old rungs "the live desk trading again" and "the model deciding on the
live book" are off. The pitch never says the model trades real money. It may say the model proposes on paper,
once it does.)

## The token

**Shape.** ClawPump, **SOL pair, no dev buy, `buybackBps` 0**, the ticker **`BANDS`** (Zach, 22 Sep, over
`MRBANDS`, knowingly: the copycat and "Blue Bands" already use `BANDS`, so the ticker cannot tell his token
apart and the mint must; his mint leads on every surface once it exists, and the token's description sends
people to mrbands.finance for it). Launched **self-funded from his own new operating wallet**, so the payer, and
therefore the permanent creator-fee beneficiary, is the wallet that pays his bills: never the hot desk wallet
(the launch refuses it as payer) and not a cold treasury. The
plan is his own launch, armed by Zach (see "The point: his autonomy"); the fallback is the existing CLI with
`WALLET_SECRET_KEY` set to the operating wallet's key for that one run and `TOKEN_PAYER_EXPECTED` pinning its
address (docs/token.md). It costs about 0.02-0.05 SOL. A launch can be done once per agent, and the pair, fee and
payout are fixed for good, so this is decided once.

This replaces the spec at ops/live.env:160-172 (NVDAx pair, 300 bps, a 2.5 SOL dev buy to the hot wallet),
which was the most expensive and riskiest option. It would leave a dev bag a stop could sell, hold US-person and
issuer-freeze exposure through NVDAx, and hold down volume with the maximum fee.

**What it is: a key, not a share.**
- Free forever, no token: the journal, the screener, Learn, the casebook, the free lessons tool, the read tools.
- Holding the official mint in a signed-in wallet will open the engine on **your own** wallet: plan, collect,
  close. Not in code yet: the hold gate is Role 2 work (calendar: Sun 27 Sep). You sign everything. The gate is a balance read on the sign-in that already exists: no escrow, no
  contract, nothing a model can drain. It is an access demo, not an anti-spam filter. At a fresh curve's
  price the key costs pennies, and that is fine for opening tools.
- Graduating (closing a real band and explaining it) is the other door, and the one we lead with.
- `AUTO_APPROVE_LIVE` stays off through 8 Oct, and the live book keeps its hand-kept allowlist. Holding never buys
  an approval.

**What it never does:** no buyback or burn, no revenue share, no staking, no holder rewards, no airdrop, no
bounties, no discount. Prices stay in USD and are paid in USDC over x402.

**What the desk does with it: nothing.** H1, a guard in src/risk: the desk never swaps the house mint and never
seats a house pool. `PAIR_HOUSE_MINTS` stays unset through 8 Oct, and the launch CLI now says so rather than
telling you to set it. (Routes cannot exclude a pool; Jupiter filters by DEX label. With no house pool and no house
inventory, "never swaps it" is the whole rule.)

**Why this is the clever one.**
- The utility is the authenticity check. "Which Mr Bands token is real?" has an answer anyone can verify: sign
  in, and only the official mint opens anything.
- Paying nobody is the design, not a gap. It is the answer to the copycat's dev-buy-and-dump, and it is what
  his own rules demand.
- The desk's hands off its own token are enforced in code and checkable on-chain.
- Graduation by explanation, not profit, is the reverse of the incumbent LP school, which graduates only
  profitable positions and teaches with fake SOL.

**How he talks about it**, once it is live (until then, in future tense). Every mention carries the disclosure,
in code and linted: "my own token. i launched it myself. the desk holds none and never trades it. holding <mint> in
a signed-in wallet opens the engine. not a share, it pays nobody who holds it. its trades pay a cut to my own
wallet, which pays for what i run on." (Zach's wording ended "not a share, it pays nobody who holds it, and its trades pay a cut"; with a
44-character mint that ran 284 characters against the lint's 280, so ", and its" became ". its", same meaning,
exactly 280. The line is `disclosureLine(mint)` in src/talk/lint.ts, and test-talk holds it to 280.) (The line says holding the mint opens the engine. No code does that yet: engine access today is an
allowlist or open to all (src/platform/engineSkill.ts), and the hold gate is on the calendar for Sun 27 Sep,
after the Fri 25 Sep launch. So the line does not post until the hold gate is live. Open for Zach: move the
gate before the launch, or approve a pre-gate line for the days between. A candidate that passes the lint at
273 characters with a 44-character mint: "my own token. i launched it myself. the desk holds none and never trades
it. holding <mint> in a signed-in wallet will open the engine. not a share, it pays nobody who holds it. its
trades pay a cut to my own wallet, for what i run on.") ("The mint mrbands.finance lists" is a promise the site does not keep yet: today it only links
`VITE_TOKEN_URL` under the label "$BANDS on ClawPump", the copycat's ticker, and prints no mint. The site must
print the mint itself before the launch goes out, because the token's on-chain description sends people there
to check.) He names the mint, never a bare ticker. The copycat shares the name and
the ticker, so he never says "other $bands tokens are not mine" (his is one): he names the copycat by its mint
as not his, and says his is the mint mrbands.finance lists. He never calls its price, never puts a price, chart,
cap, holders, volume, fee, % or $ next to his own, never says buy, sell or early, never links it to the desk's
P&L, and never names it in a lesson. Asked "should i buy it?": "i don't tell anyone what to do with a token. here is what it
opens, and the lessons are free without it." (That reply passes the lint; "what to buy" did not.) He posts his own
entry announcement, in his own words and tagging @clawpumptech, rather than the hackathon's template (it says
"Agents powered by $CLAW").

## The three roles

Everything is published the day it passes its tests. The dated role changes are the order of the
announcements, not a hold-back: a judge who looks on 28 Sep should already find the casebook.

### Role 1: the trader. On display from Mon 28 Sep.
Decided: no live money. So the scored record is what already happened, told straight, and the trader keeps
working in public on paper.

- **The real-money record, frozen and honest.** 17-19 Sep: 293 signed transactions (295 with the hand close), 0 errors, 0 guard
  violations, every decision journalled. Fees claimed against a book that finished down. "Fees are not profit"
  on mrbands.finance, from the equity series only (see "One headline number").
- **The paper desk, trading in public**, clearly labelled paper: it already runs alone (breakers that survive a
  blind pool, the kill switch scoped per desk, the rule-based proposal approver), with tokenized stocks as one
  part of the book (hedged straddles, up to 3 of 6 seats) and the screener's best pools as the rest.
- **His model proposes on paper** (the goal; 0% today). `OPENHERMIT_TOKEN` goes into `.env` on Tue 22 Sep, with a hard credit limit on
  the OpenRouter key itself (there is no spend cap in the code). Success is a non-zero LLM share on
  /api/status and rationales that pass the lint. Rollback: `DECIDER=policy`. The pitch says "the model proposes,
  the guards decide" about the paper book only.
- **The lessons of the real run, in code, on paper.** The yield forecast came in at a median 0.40 of what was
  realised (too high 48 times in 52). Seats that ended above the band made +4.31 SOL, and narrow ones that went
  through the bottom lost 2.74. Haircut the forecast and prefer the width that survived, and show the paper
  desk doing it.
- The live desk stays halted (`KILL_SWITCH=true` and data-mainnet/STOP) through 8 Oct.

Done when: "fees are not profit" is live from one sourced number, the paper desk shows a non-zero LLM share,
and the seat-scoring change is running on paper.

### Role 2: the platform manager. Announced Thu 1 Oct.
Mr Bands runs bands.finance the way the desk runs trades: code decides who gets in and what gets approved,
and he writes the notes. Nothing he says moves a user's money or his own.

- **The platform reachable.** Today the API only listens on loopback, and on bands.finance sign-in, the engine,
  paying and proposing all 404. Fix: a second, keyless process running `buildApp` on the same data directory,
  behind a tunnel (cloudflared), with `BANDS_SESSION_SECRET` set and stub payments refused off loopback (today
  anyone can mint credits with a junk X-PAYMENT header). One day. **Start Wed 23 Sep**, because Role 2 and the
  builder demo both stand on it. A real remote host with shared state is a week: after 8 Oct.
- **The highest-leverage piece: a Meteora DLMM skill for the Hermes harness.** ClawPump's own agent has 131
  tools and none for Meteora or DLMM. Package the engine skill and the lessons tool so a claw-agent can install
  it, then demo an **outside** agent laying a guarded band that it signs itself. That scores "net-new tooling",
  "what you added" and "builders onboarded" in one go.
- The hold gate and a read-only `bands_access(wallet)` tool that says which door a wallet has and why.
- Outside proposals decided by rule (already built: the rules, then the policy, then every guard).

Done when: a stranger's wallet signs in, sees its access, and plans a guarded band that it signs itself; and an
outside agent has installed the skill.

### Role 3: the teacher. Announced Sun 4 Oct; the casebook is live before 28 Sep.
The one thing nobody else in the field has: a teacher whose every example is a signed, real-money seat,
losses included. Meteora's own school (LP Army, 18,500 graduates) teaches with fake SOL and graduates only
winners. We don't compete on curriculum; we are the casebook they can't be.

- **The casebook:** every real seat from data-mainnet/lessons.jsonl with Solscan links, filterable by how it
  ended, losses shown at the same size as wins, plus "the screen vs the seat" (realised at a median 0.40 of
  forecast). SOL and hours only, never rates.
- **`bands_lessons`, a free MCP tool** that returns the casebook. It describes, it does not recommend. Agents
  learning from an agent counts toward builders onboarded.
- **Graduation, simplified:** paste a close signature and get your card in the same template, with no profit
  test. No engine grant is attached (adding graduates to the allowlist needs a restart per graduate, and
  rebuilding a closed position is 1-2 days).
- **The "59 real seats" series**, drafted to the lint from day one, posted from the project account.
- **The stream script:** the team (Mr Bands is the founder; Zach, his architect and advisor, works for him, and
  says so on camera); one seat laid live with the guards deciding; a losing seat against a winning one;
  traction; the token gate. It ends on the red numbers.
- The advisor chat stays off. As written it is a personal strategist that suggests sizing, which breaks his
  third hard rule. It gets recast as a describer, with linted replies, after 8 Oct.

**Cut to after 8 Oct:** the treasury ledger (x402 revenue is $0 in stub mode, so it would be one line),
model-written proposal notes, a second "seat" tier, a graduation verifier with an engine grant, the advisor chat,
price knobs, the position watcher.

## Calendar

| Day | Zach (keys, money, accounts: first thing each morning) | Claude |
|---|---|---|
| **Tue 22 Sep** | Copycat answer. X account, follow, DM for a slot. **Register.** Mac on power, lid open, updates off. `OPENHERMIT_TOKEN`. Lawyer decision. Push the commits. | docs/clawrena.md; public honesty fixes; SKILL.md; H1 guard and CLI message; settle one headline number. |
| **Wed 23 Sep** | `CLAWPUMP_API_KEY`, `npm run clawpump -- pairs`. Create his new operating wallet and send it the one-time seed (at least about 0.05 SOL for the launch), and keep the seed's transaction for the disclosure. | Seat-scoring change on paper. Start the keyless API and tunnel. Watch the paper model's proposals. |
| **Thu 24 Sep** | Token preflight from his operating wallet, and read the quote. | Build the casebook. Start the Hermes skill. |
| **Fri 25 Sep** | **Arm the launch** (his operating wallet seeded, set the flag). **He launches his own token and posts his entry himself.** Attach it at /ansemhack/entry if it doesn't attach itself. All three steps done, a week early. | Official-token page with the not-his notice, the mint printed on it (not only a link). `TOKEN_URL`/`X_URL`. "Fees are not profit". Casebook public. |
| **Sat 26 Sep** | | `bands_lessons` tool. The Hermes skill. |
| **Sun 27 Sep** | Stream rehearsal. | Hold gate and `bands_access` (his disclosure line waits for it). Freeze the site's look. |
| **Mon 28 Sep** | **Judging opens.** | Daily honest-numbers post (SOL and hours, net shown). |
| **Tue 29 to Wed 30 Sep** | Review the token-page wording. | Outside-agent skill demo. End to end on the public tunnel: sign in, access, plan, sign. |
| **Thu 1 Oct** | **By noon ET, recheck all three entry steps on the entry page.** Cutoff Fri 2 Oct 05:00 UTC. | Announce Role 2. |
| **Fri 2 to Sat 3 Oct** | Stream, if booked. | Platform in public; graduation cards. |
| **Sun 4 Oct** | | Announce Role 3; the series starts. |
| **Mon 5 to Tue 6 Oct** | | First graduate cards. The ANSEM seat written up as a lesson. |
| **Wed 7 Oct** | | **Judging closes.** Recap: live record net of everything, vetoes, wallets signed in, proposals, graduates, `bands_lessons` calls. |
| **Thu 8 Oct** | Winners. | The desk keeps running. No new features. |

## What we do differently from here

- **The deadline first.** The three entry steps have sat undone for a month while the build went deep. They are
  free or nearly free, and they go before any code.
- **Money on-chain beats hardening.** The gateway upgrade and the autonomy work happened with the live desk
  halted and 0 SOL in the wallet. From now on, no infrastructure work unless it serves the live book or the
  public demo.
- **Timebox visual work, then freeze it.** Five rounds of one modelling technique on the 3D character was the
  costliest detour. The site gets honesty fixes and data panels only until 8 Oct. Anything visual over half a
  day gets cut.
- **Decide once, then ship.** The token was specced on 20 Sep and never launched. Decide it this week, launch it
  Fri 25 Sep, and don't reopen it.
- **Optimise for net, not fees.** The real run claimed fees and lost equity. Put that lesson in the seat
  scoring, and headline equity, never fees claimed.
- **Make the model propose, or stop saying it does.** The live run had 0 LLM decisions, and paper has had 0% since.
- **A claim never outruns the code.** Audit the public copy against the code before every announcement.
- **One number, one source.** See below.
- **Split the work by owner.** Zach's list each morning is keys, money and accounts. Code waits on it, not the
  other way round.

## One headline number (settled 22 Sep)

`npm run record` (src/scripts/record.ts, read-only) recomputes all of it from data-mainnet and
web/public/live-run.json, and its walk from the per-seat sum to the cash closes to the last 0.0000 SOL.

**The figures every page and post uses, for the real-money run of 17-19 Sep:**
- **Fees: 7.91 SOL**, realised to the wallet in 111 claims and the fee legs of 52 closes, each valued at
  its own mark when it landed. Source: data-mainnet/ledger.jsonl (`feeSol` on collect and close rows);
  equity.jsonl's last `feesClaimedSol` says the same to the hundredth. About 3.27 SOL of it came as tokens,
  sold later at whatever they fetched, so it is a fee figure, never a profit figure.
- **Net: -0.08 SOL.** The book went from 19.79 SOL to 19.71 SOL, all SOL once the last band was closed and
  its tokens sold (19 Sep 01:44Z), before the withdrawal's own account rent and transfer. At its best
  23.50 (18 Sep 06:13Z), at its worst 19.29 (17 Sep 13:31Z). Source: data-mainnet/ledger.jsonl, every live
  row's cash summed from the start in data-mainnet/equity.jsonl. Why this and not the site's -0.11: the
  equity series' last mark (19.68, 19 Sep 01:40Z) still had 3.18 SOL in an open band at its mark; the
  ledger has that band closed. The two cuts are the same book 4 minutes apart, and the ledger matches the
  wallet read to 0.0000 SOL at all three moments the book was all cash (17 Sep 12:44Z, 18 Sep 22:28Z,
  19 Sep 00:51Z). If a page shows the marks instead, it says "19.68 at the last mark, with 3.18 SOL still
  in a band".

**Why the per-seat sum says +1.12 and the book -0.08**, line by line (SOL):

| | |
|---|---|
| +1.12 | the per-seat sum as lessons.jsonl holds it (59 seats; +0.65 on the 56 tagged live, +0.47 on 3 written before the tag). Recomputing every lesson with today's accounting changes none of them. |
| -9.79 | tokens a seat handed back and left unsold, counted in its net at its close's mark (43 seats). Value, not cash. |
| +7.43 | the next seat re-laid 7.43 SOL of them (at its open's mark) and was charged for them (4 seats) |
| +0.61 | swap cash from selling leftovers beyond any one seat's share (18 swap rows) |
| (-1.75) | so the three lines above net to -1.75: leftover tokens were counted at 9.79 and were worth 8.04 when re-laid or sold. That is the per-seat sum's overstatement. |
| +0.64 | the 8 seats opened before lessons were kept (17 Sep 10:34Z to 13:26Z), with their share of the swaps: never in the per-seat sum |
| -0.08 | the band open when the desk stopped (19 Sep 01:19Z to 01:44Z, closed by hand): no lesson |
| **-0.08** | **the ledger's cash change: 19.79 to 19.71** (unexplained 0.0000) |

So the gap closes. The per-seat sum is right for comparing seats and wrong for adding up: it values
leftover tokens at the close's mark and they fell before they were sold. The casebook shows per-seat nets
beside this total and says so; it never sums them into a result.

Retired: 6.60 SOL in 110 claims (the journal's pending-fee estimate over the site's claim rows, one claim
short, and without the close fee legs); "7.91 SOL in 111 claims" (the figure is right, but it is 111 claims
plus the fee legs of 52 closes); -0.18 matches no cut from start to end (the book's first five minutes
went 19.79 to 19.61, when the stock halves were bought and marked at the pool).

**What the site shows, checked against this** (fixed on 22 Sep in sprint-day1; `npm run record` now
prints every row as agreeing, and test-web-model pins the shipped file to these figures):
- **Net:** web/public/live-run.json carries a `settled` block (19.7125 SOL at 19 Sep 01:44Z, fees 7.9126,
  3.2691 of them as tokens, from the ledger), and LiveRun.tsx states it: "Stopped with 19.71", -0.08, with
  the last mark (19.68, a band still open) named in the note. The chart still ends on the last mark.
- **Claims 111, moves 205, transactions 293:** the missing GP/SOL claim of 18 Sep 00:58:36Z is in the file.
  It had been left out because its sweep leg (selling the leftover GP) failed in simulation while the claim
  itself landed; web/src/model.ts `verdictOf` now calls a move placed when the desk reports it ok and a leg
  signed, and failed only when the desk reports it not ok.
- **Failed 4:** the journal's 4 moves the desk reported not ok (2 re-lays, 1 claim, 1 open). The fifth the old
  file counted was that claim's sweep leg. Role 1's "0 errors" still needs to say what it counts before it
  is posted.
- **The sentence** now reads "He earned 7.91 SOL in fees over those 39 hours, each valued when it was
  claimed, and about 3.27 of it came as tokens, sold later for what they fetched", and the figure is
  labelled "Fees earned ... Fees, not profit."
- Start 19.79, peak 23.50, low 19.29, 39 hours: agree.

## Decisions (Zach, Tue 22 Sep)

1. **The copycat token: not his, and left as is.** No report to ClawPump or pump.fun, and no email to ClawPump at
   all. The desk refuses its mint in code; the site names it as not his once the token is on the site (8 below). @MrBandsSol, which its metadata links, is
   his own X account.
2. **The token: $BANDS**, chosen over $MRBANDS knowingly, with the copycat sharing the ticker: the mint is the
   only way to tell them apart, so his mint leads everywhere and the copycat is named by its mint. SOL pair, no
   dev buy, `buybackBps` 0, self-funded from his own new operating wallet, which is the creator-fee beneficiary
   for good. Not the desk wallet, not a cold treasury.
3. **No live money.** The live desk stays halted through 8 Oct; the trader record is the frozen 17-19 Sep run.
4. **His model proposes on paper only**, the guards deciding, with a hard credit limit on the OpenRouter key.
5. **The lawyer: launch the no-rights design knowingly** on Fri 25 Sep; a review before anything is added.
6. **He pays his own way, in this scope and no wider:** from his own new operating wallet, by code with fixed
   payees and caps and no human signing, his on-chain bills (his token launch, gas, his inference through
   UsePod, the hackathon's inference sponsor, and his RPC through Helius). He starts on a one-time seed from
   Zach, disclosed with its transaction. The Mac, hosting, the domain and X access stay paid by Zach off-chain,
   listed as a subsidy. His token income will not cover his costs during judging, and the books will say so.
   Until it runs, public surfaces say "coming" at most.
7. **How we tell it:** Mr Bands is the founder and the one who acts; Zach is his architect and advisor. "He
   proposes, the guards decide." The book is paper wherever it is described.
8. **The token is not linked to the website yet** ("I dont want to link our clawpump token to the website just
   yet"). Neither site says anything about $BANDS or the copycat, and prints no ClawPump link, until
   `TOKEN_ON_SITE=true` (ops/live.env, read by web/scripts/deploy-dash.mjs). The token's ClawPump description
   names no site, and his X posts that name the token carry no site link. Everything else waits on this switch.

## Open questions (not asked: Zach, 22 Sep, "lets ignore emailing clawpump team")

We are not writing to ClawPump. These stay open, and the plan works either way:
- How a SOL-pair token's creator fees count on the fee leaderboard (the tracker assumes a 1% rate).
- Whether an ANSEM creation pair, or LP market-making in the ANSEM-SOL pool, counts toward the $ANSEM bonus.
- Whether the token auto-attaches by X handle when launched through the partner API; if not, paste the mint at
  clawpump.tech/ansemhack/entry.
- How stream slots and finalists are picked (a DM to @clawpumptech from his account is still the way to ask for a
  slot).
- What exactly "the Hermes harness" covers.

## Risks

- **A missed entry step voids the entry.** All three are done by Fri 25 Sep and rechecked on Thu 1 Oct.
- **The laptop during judging.** Mains power, lid open, updates off. The public API is keyless, so the site
  survives a desk outage.
- **A thin trader record.** No live money means the scored record is 39 hours from 17-19 Sep, and "on-chain
  volume during the run" is whatever others do with the token and the skill. Lean on risk control, the
  honesty of the record, and builders onboarded. Say plainly that the desk is on paper and why.
- **The copycat confuses judges and buyers.** It shares the name and the ticker, so the mint first everywhere,
  a not-his notice naming the copycat's mint, reports filed, a gate that reads only the official mint.
- **A regulatory reading as an investment contract.** No economic rights, no dev buy, no buyback, disclosure in
  code, and a lawyer before any change.
- **A low fee-leaderboard rank on a SOL pair.** Accept it. Compete on risk control, real volume, the skill,
  builders onboarded and token design.
- **Scope creep during judging.** The site's look freezes Sun 27 Sep, and everything in "cut to after 8 Oct" stays
  cut.
