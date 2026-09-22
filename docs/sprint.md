# The Clawrena sprint: 22 Sep to 8 Oct 2026

Researched and checked on 22 Sep against the live hackathon page (clawpump.tech/ansemhack), the code as it
stands, and two adversarial reviews (a judge and the engineer who has to ship it). Where this file and
docs/clawrena.md disagree, this file is newer.

**The plan in one line.** Do the three entry steps first. Then Mr Bands takes on each new role in public
while the judges watch: trader from Mon 28 Sep, platform manager from Thu 1 Oct, teacher from Sun 4 Oct. His
token, $MRBANDS, is a key that opens his tools. It pays nobody, it never opens his lessons, and the desk
never touches it.

**Decided by Zach, Tue 22 Sep.**
- The copycat "Mr Bands" $BANDS (`JAARLU...pJ6m`, `@MrBandsSol`) is **not ours**: report it, and register first.
- The token: **$MRBANDS**, SOL pair, no dev buy, `buybackBps` 0, self-funded from a new cold treasury keypair.
- **No live money.** The live desk stays halted through 8 Oct. The scored trader record is the frozen 17-19 Sep
  real-money run. The paper desk keeps trading in public, labelled paper, and the model decides there. The
  weight of the entry moves to the builder half of the track and to Overall: the Meteora skill other agents
  install, the platform, the casebook and the token design. The token still needs about 0.05 SOL in the treasury.
- **The lawyer: launch the no-rights design knowingly**, on Fri 25 Sep, and get a review before adding anything.

## The point: his autonomy (Zach, Tue 22 Sep)

"The whole purpose of the Clawrena hackathon is to showcase the agent's autonomous abilities." And: "I am only
the architect and advisor for Mr Bands; essentially I'm a Mr Bands employee." So the rule for every item below:
**Mr Bands runs the project. Zach, his architect and advisor, builds what he needs and holds what an agent
cannot hold in his own name (accounts, keys, the hardware, the legal side), then steps back. Every call, and
every act a judge can see, is Mr Bands'.**

The story is told that way everywhere: Mr Bands is the founder; Zach works for him. Two facts sit under it in
the fine print, because a claim never outruns the truth: the human who holds the keys and the legal
responsibility is Zach (the token page and the site's small print say so), and X's automated-account label links
Mr Bands' account to Zach's as its manager, as X's rules require. The live book stays on paper by decision, which makes this rule matter
more: with no real-money trading, the autonomy judges can see is the autonomy he performs in public himself.

What he does himself, and nobody does for him:
- **He decides.** The model on the gateway makes the calls on the paper book, and the guards decide. Today the
  paper desk runs 0% model: the rule-based policy makes every call, which is automation, not an agent. This
  needs `OPENHERMIT_TOKEN` in `.env` (Zach) and is the first technical priority. **Cost:** the paper desk makes
  about 66 decisions an hour; all of them on Opus would spend the $200 OpenRouter balance in about two days. So
  the model decides the calls that matter, and code answers the obvious holds (a pool off the screen, not worth
  the rent, the engine already deciding), with a hard credit limit on the key.
- **He launches his own token.** Zach arms it (funds the launch wallet, sets one flag). Mr Bands chooses the
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

**The autonomy ledger**, a public page and part of /api/status, is how a judge checks all of it rather than
taking our word: every decision with who made it (the model, the rules, the engine) and what the guards said,
every veto, the launch, every post, every proposal decided, every lesson written, and every time a **human**
touched anything (a restart, an env change, a halt), with a "hands-off since" counter. Honest in both directions:
it says the book is paper.


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
1. **Is the "Mr Bands" $BANDS token yours?** It was launched on pump.fun through ClawPump on 21 Sep 15:03 UTC:
   mint `JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m`, X handle `@MrBandsSol`, our portrait, links
   mrbands.finance, from a ClawPump agent that is not ours. Its dev buy was sold 2h05m later, and its wallet
   pattern looks like a launch farm. If it is not yours, report it to dev@clawpump.tech and to pump.fun today.
2. **Create the project X account**, follow @clawpumptech, and DM them for a stream slot the same day (slots
   are booked there and go weekly).
3. **Register** at clawpump.tech/ansemhack with that handle, with the ClawPump x pump.fun track ticked. It is free
   and the token link is optional. The token later attaches to the entry by this handle.
4. Put the Mac on mains power with the lid open, and turn off automatic macOS installs. It went down on 17 and
   20 Sep, and judges watch on-chain activity for ten days.
5. **Paste `OPENHERMIT_TOKEN` into `.env`, and set a credit limit on the OpenRouter key.** Without it the rules
   decide, not him, and there is nothing autonomous to show. See "The point: his autonomy".
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
6. The model deciding on the paper desk, in public, labelled paper.

(Decided 22 Sep: no live money, so the old rungs "the live desk trading again" and "the model deciding on the
live book" are off. The pitch never says the model trades real money. It may say the model proposes on paper.)

## The token

**Shape.** ClawPump, **SOL pair, no dev buy, `buybackBps` 0**, the ticker **`MRBANDS`** (decided;
`BANDS` is taken by the copycat and by "Blue Bands"). Launched **self-funded from a new cold treasury keypair**,
so the payer, and therefore the permanent creator-fee beneficiary, is that treasury and never the hot desk
wallet. That is the existing CLI with `WALLET_SECRET_KEY` set to the treasury key: no new code, no untested
second launch flow. It costs about 0.02-0.05 SOL. A launch can be done once per agent, and the pair, fee and
payout are fixed for good, so this is decided once.

This replaces the spec at ops/live.env:160-172 (NVDAx pair, 300 bps, a 2.5 SOL dev buy to the hot wallet),
which was the most expensive and riskiest option. It would leave a dev bag a stop could sell, hold US-person and
issuer-freeze exposure through NVDAx, and hold down volume with the maximum fee.

**What it is: a key, not a share.**
- Free forever, no token: the journal, the screener, Learn, the casebook, the free lessons tool, the read tools.
- Holding the official mint in a signed-in wallet opens the engine on **your own** wallet: plan, collect,
  close. You sign everything. The gate is a balance read on the sign-in that already exists: no escrow, no
  contract, nothing a model can drain. It is an access demo, not an anti-spam filter. At a fresh curve's
  price the key costs pennies, and that is fine for opening tools.
- Graduating (closing a real band and explaining it) is the other door, and the one we lead with.
- `AUTO_APPROVE_LIVE` stays off through 8 Oct, and the live book keeps its hand-kept allowlist. Holding never buys
  an approval.

**What it never does:** no buyback or burn, no revenue share, no staking, no holder rewards, no airdrop, no
bounties, no discount. Prices stay in USD and are paid in USDC over x402.

**What the desk does with it: nothing.** H1, a guard in src/risk: the desk never swaps the house mint and never
seats a house pool. `PAIR_HOUSE_MINTS` stays unset through 8 Oct, and the launch CLI's message telling you to set
it gets changed. (Routes cannot exclude a pool; Jupiter filters by DEX label. With no house pool and no house
inventory, "never swaps it" is the whole rule.)

**Why this is the clever one.**
- The utility is the authenticity check. "Which Mr Bands token is real?" has an answer anyone can verify: sign
  in, and only the official mint opens anything.
- Paying nobody is the design, not a gap. It is the answer to the copycat's dev-buy-and-dump, and it is what
  his own rules demand.
- The desk's hands off its own token are enforced in code and checkable on-chain.
- Graduation by explanation, not profit, is the reverse of the incumbent LP school, which graduates only
  profitable positions and teaches with fake SOL.

**How he talks about it.** Every mention carries the disclosure, in code and linted: "my own token. i launched
it myself. the desk holds none and never trades it. holding <mint> in a signed-in wallet opens the engine. it is
not a share of anything and pays nobody." He names the mint, never a bare ticker, and says other $BANDS
tokens are not his. He never puts a price, chart, cap, holders, volume, fee, % or $ next to it, never says buy,
sell or early, never links it to the desk's P&L, and never names it in a lesson. Asked "should I buy it?": "I
don't tell anyone what to buy. here is what it opens, and the lessons are free without it." He posts his own
entry announcement, in his own words and tagging @clawpumptech, rather than the hackathon's template (it says
"Agents powered by $CLAW").

## The three roles

Everything is published the day it passes its tests. The dated role changes are the order of the
announcements, not a hold-back: a judge who looks on 28 Sep should already find the casebook.

### Role 1: the trader. On display from Mon 28 Sep.
Decided: no live money. So the scored record is what already happened, told straight, and the trader keeps
working in public on paper.

- **The real-money record, frozen and honest.** 17-19 Sep: 329 signed transactions, 0 errors, 0 guard
  violations, every decision journalled. Fees claimed against a book that finished down. "Fees are not profit"
  on mrbands.finance, from the equity series only (see "One headline number").
- **The paper desk, trading in public**, clearly labelled paper: it already runs alone (straddles, breakers that
  survive a blind pool, the kill switch scoped per desk, the rule-based proposal approver).
- **The model decides on paper.** `OPENHERMIT_TOKEN` goes into `.env` on Tue 22 Sep, with a hard credit limit on
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
and he writes the notes. Nothing he says moves a user's money or the treasury's.

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
| **Wed 23 Sep** | `CLAWPUMP_API_KEY`, `npm run clawpump -- pairs`. Email ClawPump the questions below. Create the treasury keypair offline and send it about 0.05 SOL. | Seat-scoring change on paper. Start the keyless API and tunnel. Watch the paper LLM decisions. |
| **Thu 24 Sep** | Token preflight from the treasury wallet, and read the quote. | Build the casebook. Start the Hermes skill. |
| **Fri 25 Sep** | **Arm the launch** (fund the launch wallet, set the flag). **He launches his own token and posts his entry himself.** Attach it at /ansemhack/entry if it doesn't attach itself. All three steps done, a week early. | Official-token page with the not-ours notice. `TOKEN_URL`/`X_URL`. "Fees are not profit". Casebook public. |
| **Sat 26 Sep** | | `bands_lessons` tool. The Hermes skill. |
| **Sun 27 Sep** | Stream rehearsal. | Hold gate and `bands_access`. Freeze the site's look. |
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
- **Make the model decide, or stop saying it does.** The live run had 0 LLM decisions, and paper has had 0% since.
- **A claim never outruns the code.** Audit the public copy against the code before every announcement.
- **One number, one source.** See below.
- **Split the work by owner.** Zach's list each morning is keys, money and accounts. Code waits on it, not the
  other way round.

## One headline number (settle before anything posts)

The sources disagree, and a judge who adds them up will notice:
- Fees claimed on 17-19 Sep: 7.91 SOL in 111 claims (the earlier brief) against 6.60 SOL in 110 claims
  (recomputed from web/public/live-run.json at claim-time value).
- Net: the book went 19.79 to 19.68 SOL (about -0.11; -0.18 on another cut) against the per-seat lessons, which
  sum to +1.12 SOL (+0.65 on the 56 live seats). The open band at the end and the tokens left over are the
  likely gap.

Until it is reconciled, public figures come from the equity series and nothing else, and the casebook prints
the gap if it can't be closed.

## Decisions (Zach, Tue 22 Sep)

1. **The copycat token and @MrBandsSol: not ours.** Report both to ClawPump and pump.fun today, register first,
   and publish a not-ours notice once our mint exists.
2. **The token: $MRBANDS**, SOL pair, no dev buy, `buybackBps` 0, self-funded from a new treasury keypair.
3. **No live money.** The live desk stays halted through 8 Oct; the trader record is the frozen 17-19 Sep run.
4. **The model decides on paper only**, with a hard credit limit on the OpenRouter key.
5. **The lawyer: launch the no-rights design knowingly** on Fri 25 Sep; a review before anything is added.

## Ask ClawPump (Wed 23 Sep, dev@clawpump.tech and @clawpumptech)

- The copycat: can they block or delist it, and is "Mr Bands" protected on the entry list?
- How a SOL-pair token's creator fees count on the fee leaderboard (the tracker assumes a 1% rate).
- Would an ANSEM creation pair, or LP market-making in the ANSEM-SOL pool, count toward the $ANSEM bonus?
- Does the token auto-attach by X handle when it is launched through the partner API, rather than the dashboard?
- Stream slots: how finalists are picked, and when.
- What exactly "the Hermes harness" covers.

## Risks

- **A missed entry step voids the entry.** All three are done by Fri 25 Sep and rechecked on Thu 1 Oct.
- **The laptop during judging.** Mains power, lid open, updates off. The public API is keyless, so the site
  survives a desk outage.
- **A thin trader record.** No live money means the scored record is 39 hours from 17-19 Sep, and "on-chain
  volume during the run" is whatever others do with the token and the skill. Lean on risk control, the
  honesty of the record, and builders onboarded. Say plainly that the desk is on paper and why.
- **The copycat confuses judges and buyers.** A distinct ticker, the mint first everywhere, a not-ours page,
  reports filed, a gate that reads only the official mint.
- **A regulatory reading as an investment contract.** No economic rights, no dev buy, no buyback, disclosure in
  code, and a lawyer before any change.
- **A low fee-leaderboard rank on a SOL pair.** Accept it. Compete on risk control, real volume, the skill,
  builders onboarded and token design.
- **Scope creep during judging.** The site's look freezes Sun 27 Sep, and everything in "cut to after 8 Oct" stays
  cut.
