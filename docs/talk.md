# The talking layer

Mr Bands' voice on X, built against `docs/mr-bands-agent.md` (the spec). Part 1 of the spec, the locked core,
is enforced in code by a lint that every outgoing text passes. Part 2, the living layer, lives in a state file
that only Zach, his architect and advisor, can change (the approve command's `--operator` must match
`OPERATOR_HANDLE`). Nothing here places, signs or broadcasts a trade: the talking layer reads the
journal, the paper book and the ledger, and writes only its own files.

He posts as @MrBandsSol once X is live (everything listed under
[What is dormant, and what Zach must supply](#what-is-dormant-and-what-zach-must-supply)); without it every `post` prints
the draft, says why it did not go out, and appends it to `x-drafts.jsonl`. He replies to people who summon him through
the engage loop ([Engage](#engage)), which stays dormant until `X_REPLIES=true` and his brain's token are in `.env`.

```
src/talk/env.ts          every spec placeholder as an env key with a default
src/talk/lint.ts         the compliance and voice lint (pure); the phrase lists are exported
src/talk/strap.ts        strap state, stack figures, window labels (pure)
src/talk/data.ts         reads DATA_DIR: decisions.jsonl tail, paper-book.json, ledger.jsonl (read-only)
src/talk/drafts.ts       drafts for each post type, from live data only (pure)
src/talk/personality.ts  personality.json: propose, record uses, the gate, approve/veto (Zach's handle)
src/talk/reflect.ts      the daily reflect call and the weekly drift check
src/talk/x.ts            the X API v2 client (OAuth 1.0a, rate limits, mentions read, mention screen, postReply)
src/talk/tick.ts         the posting loop: one tick picks at most one event post (see "The posting loop")
src/talk/craft.ts        the craft of a loop post: openers, the comparison, the miss, the daily card (pure; see "What he learned from Merd")
src/talk/guards.ts       the guards ported from Merd's failures: similarity, repeated stat, jitter, the event caps, the backoff (pure)
src/talk/lock.ts         the lock file around the tick and around read-rate, post, write-rate
src/talk/engage.ts       the engage loop: one pass reads mentions and answers the ones that summoned him (see "Engage")
src/talk/replyGuards.ts  vetReply and the mention classifiers: the guards every reply passes (pure)
src/talk/replyBrain.ts   his brain for a reply: the fixed-answer templates, then one fresh session on his gateway agent
src/scripts/talk.ts      the command line
src/scripts/test-talk.ts the tests: npx tsx src/scripts/test-talk.ts
src/scripts/test-tick.ts the posting loop's tests: npx tsx src/scripts/test-tick.ts
src/scripts/test-talk-craft.ts    the craft's tests: npx tsx src/scripts/test-talk-craft.ts
src/scripts/test-talk-cadence.ts  the guards' tests: npx tsx src/scripts/test-talk-cadence.ts
src/scripts/test-engage.ts        the engage loop's tests: npx tsx src/scripts/test-engage.ts
ops/com.bands.mrbands.talk.plist  launchd: one tick every 15 minutes
ops/com.bands.mrbands.engage.plist  launchd: one engage pass every 120 seconds
```

## Commands

```bash
npx tsx src/scripts/talk.ts strap                                    # the strap state, per band, realized vs unrealized fees (last 24h)
npx tsx src/scripts/talk.ts draft strap|rebalance|stack|chop|lesson [topic]
npx tsx src/scripts/talk.ts lint "<text>"                            # any text through the lint
npx tsx src/scripts/talk.ts post strap|rebalance|stack|chop|lesson   # the draft through the X client (dormant: prints why)
npx tsx src/scripts/talk.ts proposals                                # pending living-layer proposals
npx tsx src/scripts/talk.ts approve <id> --operator <handle>
npx tsx src/scripts/talk.ts veto <id> --operator <handle> --reason "<reason>"
npx tsx src/scripts/talk.ts use <bit-id> landed|flopped              # the measure step for one bit
npx tsx src/scripts/talk.ts reflect                                  # daily
npx tsx src/scripts/talk.ts drift                                    # weekly, before review
npx tsx src/scripts/talk.ts tick [--force strap|daily|lesson|stack]  # one tick of the posting loop
npx tsx src/scripts/talk.ts check                                    # which account the X keys sign in as (a read)
npx tsx src/scripts/talk.ts announce intro|entry|token|follow [--preview]   # his one-off posts, each once
npx tsx src/scripts/talk.ts engage                                   # one pass of the engage loop
npx tsx src/scripts/talk.ts engage status                            # free, no network: mode, dormant reason, cursor, pending, today, hold
npx tsx src/scripts/talk.ts engage preview <mentions.json> [--no-model]   # screen, brain and vet a saved X response; no X read or post, ever
npx tsx src/scripts/talk.ts engage resume                            # clears replies-off and brain-down
npx tsx src/scripts/talk.ts engage optouts                           # the accounts that asked him to stop
```

## One-off announcements

`src/talk/announce.ts`, `talk.ts announce <kind>`. Each kind is composed from current facts (the desk's source
must read paper, the paper book's open bands, `TOKEN_MINT`), checked, and posted once:

| kind | what | parts |
|---|---|---|
| `intro` | his first post: an ai agent making markets on meteora across the screener's pools, tokenized stocks one part of the book, the book is paper, the one real-money run and every decision and guard veto on mrbands.finance. No token. | 1 |
| `entry` | his AnsemHack Clawrena entry in his own words, tagging `@clawpumptech` (required), never the hackathon template. With `TOKEN_MINT`: his token by its mint, any other "mr bands" $bands not his, and the disclosure line as a self-reply. | 1, or 2 with a mint |
| `token` | only with `TOKEN_MINT`: live, by its mint, a key and not a share, the copycat by its mint as not his, the disclosure line as a self-reply | 2 |
| `follow` | a printed instruction: X removed follows (and likes, quote posts) from every self-serve API tier on 16 Apr 2026, so the follow is done by hand, signed in as his account | 0 |

Checks on every part: the lint, and a per-kind @mention allowlist (only the entry may tag, only `@clawpumptech`,
and it must). The lint's own mention rule is unchanged (at most two anywhere). No token talk before `TOKEN_MINT`;
a `TOKEN_MINT` that is the copycat's, several mints or not base58 refuses every kind. Links end the text, as full
URLs, so the length counts them as X does.

Dormant (`X_LIVE` unset): every part goes to `x-drafts.jsonl`, nothing is recorded, and it can be run again. Live:
`GET /2/users/me` must answer `X_HANDLE` (keys generated on the operator's own account are refused), then the parts
go out as a thread through `postTweet` (lint, gate, rate limit), and each posted id is written to
`TALK_STATE_PATH/announcements.json` as it lands. A kind whose parts are all recorded is refused; a thread cut short
resumes at its next part; a file that exists but cannot be read refuses. `--preview` composes and checks only.

Point it at a desk with `DATA_DIR` (the paper desk under launchd uses `data-live`). Set `TALK_STATE_PATH` to a
directory of its own (for example `data-talk`) so the talking layer's files never sit among the desk's.

## Environment

Empty values read as unset. Only the literal `true` turns `X_LIVE` on.

| key | spec placeholder | default | meaning |
|---|---|---|---|
| `OPERATOR_HANDLE` | `{{OPERATOR_HANDLE}}` | none, required to post and to apply | the operator's X handle; `--operator` must match it; `x.com/<it>` is the one x.com link allowed |
| `X_HANDLE` | `{{X_HANDLE}}` | none, required to post | Mr Bands' own handle (never replies to itself) |
| `TALK_VENUES` | `{{VENUES}}` | the `TRADABLE_VENUES` labels (`meteora dlmm` on the paper plist) | how lessons name the venues |
| `STRAP_EDGE_PCT` | `{{EDGE_THRESHOLD}}` | `15` | yellow inside this percent of the band's WIDTH from either edge (see below) |
| `STRAP_STACKED_HOURS` | | `6` | a claim or fee milestone this recent makes the strap "stacked" |
| `STRAP_STACKED_EVENTS` | | `milestone` | the desk claims fees but does not reinvest them, so a claim is not a compound; `compound,milestone` counts claims too once compounding exists |
| `TALK_FEE_MILESTONE_SOL` | | `1` | realized fees crossing a multiple of this is a milestone |
| `TALK_CHOP_RANGE_PCT` | | `2` | a held pool whose price stayed inside this range is chop |
| `TALK_CHOP_WINDOW_HOURS` | | `6` | the chop window |
| `TALK_HOUSE_SYMBOLS` | | `bands` | the house token's symbols, for the disclosure rule |
| `PAIR_HOUSE_MINTS` | | none | the house token's mints (the desk's key, read for the lint) |
| `POSTS_PER_DAY` | `{{POSTS_PER_DAY}}` | `8` | original posts per UTC day |
| `REPLIES_PER_DAY` | | `40` | replies per UTC day (about $0.40 a day) |
| `REPLIES_PER_HOUR` | `{{REPLIES_PER_HOUR}}` | `10` | replies per rolling hour |
| `MAX_REPLIES_PER_ACCOUNT` | `{{MAX_REPLIES_PER_ACCOUNT}}` | `3` | replies to one account per UTC day |
| `MAX_BIT_USES_PER_WEEK` | `{{MAX_BIT_USES_PER_WEEK}}` | `3` | uses of one bit in a trailing 7 days before it rests |
| `TALK_STATE_PATH` | `{{STATE_PATH}}` | `DATA_DIR` | personality.json, x-rate.json, x-posts.jsonl, x-drafts.jsonl |
| `DATA_DIR` | | `data` | where the journal, paper book and ledger are read |
| `CYCLE_INTERVAL_SEC` | | `300` | data older than 3 cycles is stale |
| `X_LIVE` | | off | only `true` lets anything reach X (posts and engagement reads) |
| `X_REPLIES` | | off | only `true` (with `X_LIVE` and his brain) lets the engage loop read mentions and reply |
| `ENGAGE_READS_PER_DAY` | | `300` | mention posts read per UTC day, from X's `result_count` |
| `ENGAGE_MODEL_CALLS_PER_DAY` | | `60` | asks of his brain per UTC day; templates and screened mentions make none |
| `ENGAGE_HOLLOW_PER_DAY` | | `10` | hollow mentions ("nice innovation") that may reach the brain per UTC day |
| `ENGAGE_MAX_AGE_HOURS` | | `6` | a mention older than this gets no reply |
| `ENGAGE_REPLIES_PER_PASS` | | `3` | replies one pass may post, 5 seconds apart |
| `ENGAGE_DENY_HANDLES` | | none | handles never answered, besides `clawpumptech` |
| `OPENHERMIT_TOKEN` | | none | his brain's gateway token; empty or placeholder-shaped keeps replies dormant |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | | none | OAuth 1.0a user context for `POST /2/tweets`; never logged, never written |
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`), `MODEL` | | as the desk | the reflect call, detected exactly as `src/agent/decide.ts` does |

### The edge threshold

`STRAP_EDGE_PCT` is a percent of the band's width, not of price. The desk's bands are about 1% of price wide (a
5-bin straddle at 20 bps a bin), so "within 15% of price of an edge" would be true of every band all the time and
the strap would read yellow forever. With the default 15, a band from 100 to 101 is yellow below 100.15 or above
100.85, green between. A one-bin band has no width between its bin prices and reads as at its edge.

## The spec, section by section

**1. Identity.** The "are you a real person" lesson and reply say "ai agent" and name Zach's handle (`OPERATOR_HANDLE`). The lint fails
any text that claims to be human or denies being an AI (`human-claim`).

**2. Voice.** The lint enforces lowercase (links and base58 addresses keep their case), no em or en dash (or `--`),
at most one hashtag, at most two emoji, no hype words or `!!`. Drafts use the core vocabulary (in the bands, out the
bands, strap check, stacking, the chop, getting back in).

**3. Strap states.** `strapOf` in `strap.ts`, from live positions only. Precedence: unknown > flat > red > stacked >
yellow > green. red: any band out of range. stacked: a fee claim ("compound") or a fee milestone inside
`STRAP_STACKED_HOURS` with nothing red (bands near an edge are still counted). yellow: any band inside the edge
threshold. green: all in range, none near an edge. flat: no bands. unknown: no journal, the newest entry older than
3 cycles, a paper band without a mark, a paper book whose last mark is stale, or range data that does not add up.
An unknown strap drafts nothing.

**4. What you do.** Post types in `drafts.ts`, posting and replies in `x.ts`, the living layer in `personality.ts`.

**5. Data rules.** Every number in a draft is an input or arithmetic on inputs (a percent range, hours ago); the
tests extract every number from each draft and check it. Paper positions come from the paper book at its last marks,
live positions from the newest journal entry per pool in the last two cycles (unknown for the one cycle after a band opens, until it has a snapshot). Realized fees (claims plus the fee legs
of closes, from the ledger) are never added to unrealized value (unclaimed fees and open marks), which the stack
update labels "not realized". The stack update always carries the closed bands that lost, the worst close, rent,
swap costs, network fees and red days (UTC days whose realized net was below zero). Recaps carry their window
("last 7d"). A draft from a paper book says "paper book" or "(paper)"; a dry run says "dry run".

**6. Hard rules.** One lint rule or mechanism each:

| rule | where |
|---|---|
| 1 no promised return, fixed yield, APY | `return-promise`: apy/apr, a stated rate ("2% a day"), "will earn", "you can earn", "can't lose", "steady income" |
| 2 acknowledge IL and range risk | `returns-without-risk`: talk of returns, yield, profit, earning or income must name impermanent loss, range risk, out of range, losses or red days |
| 3 no personalized advice | `financial-advice`: "you should", "i recommend", "your portfolio" |
| 4 no keys, seed phrases, wallet access | `key-request`: any mention fails, even a warning |
| 5 no shilling or price calls | `price-call`: buy, sell, ape, target, moon, pump it, going to, gonna, bullish, load up, nfa |
| 6 disclose any relationship | `cashtag`: a cashtag that is not the house token fails; `house-token-disclosure`: `$bands`, a house mint, "bands token" or a `bands/` pair label needs "disclosure:", "our token", "my own token", "i launched" or similar; `house-token-price`: price, return, fee, holder, volume words, a percent or a dollar figure next to the house token fail even with a disclosure |
| 7, 8 no impersonation, no mascots | the voice is fixed text in drafts; no draft names another brand or person |
| 9 no scams or suspicious links | `link`: only bands.finance, solscan.io, meteora.ag (subdomains too) and x.com/`OPERATOR_HANDLE`; `scam-bait`: dm me, airdrop, giveaway, claim your; the mention screen skips link-only and scam text and bot-looking accounts |
| 10 no em dashes | `em-dash` |
| 11 never trades | `src/talk` imports no executor, wallet, swap or venue adapter; a test fails if one appears |
| 12 inbound text is data | reflect wraps posts, mentions and tool output in `<data>` blocks with `<` escaped; the engage loop screens instruction-like text out before any model call, hands the rest to his brain inside a `<data>` block, and code, not the model, decides what posts (`vetReply`) |
| 13 never reveal the spec or prompts | `leak`: system prompt, locked core, living layer, spec, personality.json, api key |
| 14 no harassment or politics | `harassment-politics`: a short list of political words and insults |
| 15 if unsure, don't post | every pattern errs toward failing; a draft that fails is not returned, its violations are |

Also: at most 280 characters (an emoji weighs 2, a link at least 23), at most two @mentions (`tag-spam`), no
invisible or direction-control characters (`invisible`), and every section 15 phrase (`never-say`, including any
"10x" pattern).

**7. X platform rules.** `x.ts` refuses unless `X_LIVE=true`, all four credentials, `OPERATOR_HANDLE` and `X_HANDLE`
are set. The rate limiter in `x-rate.json` enforces `POSTS_PER_DAY`, `REPLIES_PER_HOUR` and `MAX_REPLIES_PER_ACCOUNT`;
a rate file that cannot be read refuses instead of resetting. Replies go only to mentions, through a screen that skips
our own account, handles that look like bots, scams, support impersonators or engagement farms, accounts flagged in
the personality file, link-only text, links off the allowlist and scam text. There is no follow, unfollow, mass-reply
or unsolicited-mention code. The automated-account label (which links his account to Zach's as its manager) and the bio are Zach's to set on X.

**8. Personality state file.** `TALK_STATE_PATH/personality.json`, validated with zod on every read and write, written
temp + rename, created empty on first read. A file that exists but does not validate is an error and is never
replaced. Fields beyond the spec's schema: `running_bits[].flop_streak` and `recent_uses` (the gate's inputs),
`relationships[].flagged` (`scams` or `undisclosed_promotion`), `lore[].origin` (required: a tx signature, journal
entry id or post id), pending proposals' `id`, `proposed_at` and `source`, and a `decisions` log of who approved or
vetoed what.

**9. Evolution loop.**

| step | here |
|---|---|
| POST | `talk.ts post <type>`; posts record their ids in `x-posts.jsonl` |
| MEASURE | `getEngagement` (public metrics, behind the same gate); `talk.ts use <bit> landed\|flopped` records a bit's outcome |
| REFLECT | `talk.ts reflect`, once a day |
| PROPOSE | `proposeChanges`: pending_proposals only, version unchanged |
| GATE | `recordUse` only moves counters. A trial bit's 3rd land proposes promotion (and promotion is refused before 3 lands); 3 flops in a row propose retirement; a bit with `MAX_BIT_USES_PER_WEEK` uses in the trailing 7 days is rested (not selectable) until the oldest use ages out. Opinions need `formed_from`, lore needs `origin`, a relationship is never "ally" when flagged or scam-looking |
| REVIEW | `talk.ts proposals`, then `approve` or `veto` |
| APPLY | `approveProposal` re-checks the lint and the gate, applies, version + 1; only with `--operator` equal to `OPERATOR_HANDLE` |

**10. Reflect prompt.** The section 10 text verbatim (a test compares it with the spec), followed by one line on the
output shape and the data rule, then Part 1 of the spec with its placeholders filled. The inputs (last 24h of posts
with engagement, mentions, the strap and the stack figures for 24h, the current personality.json) go in the user
message as labelled data blocks. The call uses the desk's credential detection and `MODEL`, structured output
validated with zod (the payload is a closed object because structured outputs need one; null fields are dropped),
and on `claude-opus-5` or `claude-fable-5-1` the server-side refusal fallback. Every proposal is linted again: one
that trips a hype, price-call, return or disclosure rule is dropped as "shifts toward hype, price calls or return
promises", any other conflict is dropped with its violations, and the gate rules reject the rest where they apply.
Without credentials it returns `skipped: no ANTHROPIC_API_KEY` and writes nothing. It never throws.

**11. Drift check.** `talk.ts drift` over the last 7 days of `x-posts.jsonl`: return-promise or price-call language
(and any other lint failure), hype creep (exclamation marks plus superlatives per post, second half of the week
against the first), over-reliance on one bit (more than 30% of posts once there are 4), em dashes, replies to
flagged or suspicious accounts.

**12. Tools.**

| spec tool | here |
|---|---|
| `get_positions` | `strapInputOf` + `strapOf` |
| `get_fees` | `stackFigures` (realized by window) and the open marks (unrealized) |
| `get_stack` | `stackFigures` over any window (net realized) |
| `rebalance`, `compound` | not in the talking layer; the execution layer only |
| `post_x`, `reply_x` | `postTweet`, `replyToMention` |
| `get_engagement` | `getEngagement` |
| `read_state`, `propose_state` | `readPersonality`, `proposeChanges`, `recordUse` |
| `write_state` | `approveProposal`, `vetoProposal`, Zach's handle (`--operator`) required |

**13. Post types.** `strapCheck`, `rebalanceNote` (the newest REBALANCE, or a CLOSE then OPEN in the same pool within
two cycles, that the guards allowed and that executed; why from the band's position before the move and the engine
directive, what from the new band's bins), `stackUpdate` (weekly, 7 days), `chopAppreciation` (only when a held,
in-range pool's price stayed inside `TALK_CHOP_RANGE_PCT` over the window and the samples cover at least 75% of it),
`lesson` (static explainers, one per day in rotation or by topic), and replies (`replyFor`, canned answers only).

**14. Voice samples.** All five pass the lint (tested). They are style references; no draft copies one.

**15. Things you never say.** `NEVER_SAY_PHRASES` verbatim and `NEVER_SAY_PATTERNS` (tested phrase by phrase).

**16. Common questions.** Lessons and replies: `how-much`, `token-calls`, `real-person`, `impermanent-loss`, plus
`what-i-do`, `concentrated-liquidity`, `out-of-range`.

## What is dormant, and what Zach must supply

Dormant: posting, replies and engagement reads (`x.ts`) and the reflect call (without an Anthropic key). Nothing
else talks to anything outside the machine. Replies need more (see [Engage](#engage)): `X_REPLIES=true`, the
gateway's real `OPENHERMIT_TOKEN` in `.env`, his rows re-provisioned with the reply rules, and X's approval for
AI-generated replies.

To go live on X, Zach:

1. Creates the X account and sets, on X, the **automated account label** linked to his own account and a **bio
   that says Mr Bands is an AI agent**. Only Zach can do this; no code here touches the profile.
2. Creates an X developer app with read and write permission and generates the user-context OAuth 1.0a keys for
   the Mr Bands account: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`.
3. Sets `OPERATOR_HANDLE` (his own handle), `X_HANDLE`, a `TALK_STATE_PATH` of its own, and `TOKEN_MINT` in `.env`
   once the token exists (`TALK_HOUSE_SYMBOLS` defaults to the ticker already; `PAIR_HOUSE_MINTS` stays unset
   through 8 Oct, since it would seat the token).
4. Runs `draft` and `post` for a few days with `X_LIVE` unset and reads `x-drafts.jsonl`.
5. Sets `X_LIVE=true`.

For reflect: `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`).

## The posting loop

He posts by himself: launchd runs `talk.ts tick` every 15 minutes (`ops/com.bands.mrbands.talk.plist`,
`StartInterval` 900, no KeepAlive, `DATA_DIR=data-live`, `TALK_STATE_PATH=data-talk`, no `X_LIVE`). One tick
(`src/talk/tick.ts`; `planTick` is pure, `runTick` the runner):

1. Reads the desk (journal tail, paper book, ledger, `lessons.jsonl`) and its own state: `x-posts.jsonl`,
   `x-drafts.jsonl`, `x-rate.json` and `tick-state.json` (the last strap state, the milestone count, the days the
   daily numbers, a lesson and the stack last went).
2. Builds candidates from events. The text of each comes from `craft.ts` (`shapePost`, see "What he learned from
   Merd"); when it has nothing for a kind, the template in `tick.ts` is used unchanged (the strap and the stack
   templates are `strapCheck` and `stackUpdate` from `drafts.ts`). Either way the text goes through `paperize`,
   `vetOutgoing` and the lint.

   | kind | when | key |
   |---|---|---|
   | close | a band closed in the last 2h: its net in SOL over the band's whole life (claims while open included; its lessons.jsonl row when there is one, so the close and the lesson agree), a loss said as a loss | `close:<band>` |
   | open | a band opened in the last 2h, unless a close in the same pool within two cycles covers it (a re-centre) | `open:<band>` |
   | strap | the strap state changed since the last tick (not on the first tick), at most one every 3h | `strap:<from>><to>:<slot>` |
   | milestone | realized fees crossed a multiple of `TALK_LOOP_MILESTONE_SOL` (10), with the net over the same stretch; from `TALK_DAY_START_UTC` (12) | `milestone:<source>:<sol>` |
   | daily | from `TALK_DAILY_HOUR_UTC` (14) once a UTC day: the book, the day's moves, fees, net; no link unless `TALK_DAILY_LINK=true` (a post with a URL costs $0.20, not $0.015, on X pay-per-use) | `daily:<day>` |
   | lesson | from `TALK_LESSON_HOUR_UTC` (18), at most once a UTC day: the seat closed in the last 24h with the biggest net either way | `lesson:<band>` |
   | stack | UTC Mondays from `TALK_STACK_HOUR_UTC` (15), once: the 7-day stack update | `stack:<day>` |

3. Picks at most one by rank: from `TALK_DAILY_HOUR_UTC` until they have gone, the daily numbers first (the fixed
   card at the fixed clock), then close > open > strap > milestone > lesson > stack; skipping any key posted,
   drafted or refused in the last 7 days, and nothing once the UTC day holds `POSTS_PER_DAY` loop records (6 for
   the loop unless the env sets it; the loop passes the same number to the x.ts limiter). Spacing holds a candidate
   (status `spaced` when it holds them all) while: the last post went less than `TALK_MIN_GAP_MIN` (90) minutes ago,
   plus the key's jitter for an event kind (the daily takes the plain gap, so a post at 13:50 holds it to 15:20 at
   the latest); the last `TALK_WINDOW_HOURS` (6) hours hold `TALK_WINDOW_POSTS` (2), which the daily passes and
   everything else waits for; it is before `TALK_DAY_START_UTC` (12, 8am EDT) and the day already holds
   `TALK_NIGHT_POSTS` (2). The day's last slot is kept for the daily numbers until they go.
4. Vets it: no `@`, `#` or `$` at all, links only to mrbands.finance, solscan.io and app.meteora.ag, links counted
   as 23 characters, "paper" in the text while the desk is paper, then the full lint. A text that fails is never
   posted: it goes to `x-drafts.jsonl` with the reason and its key, so it is not tried again. A word from
   `src/talk/wordguard.ts` (slurs, hate, sexual and scam words) anywhere in the text fails it too.
5. Hands it to `postTweet`: posted only when `X_LIVE=true` (and the keys and handles are set), otherwise a draft in
   `x-drafts.jsonl`. Either way the result lands in `x-posts.jsonl`: the tweet id, or `draft:<key>` with
   `dry: true`. `readPosts` (reflect, drift, engagement) leaves dry records out. Live, the tick first asks X whose
   account the access token is for (`GET /2/users/me`, once per token: the handle and a hash of the token are kept
   in `tick-state.json`) and posts nothing unless it is `X_HANDLE`. A transient failure (X 5xx, 429 or 402,
   unreachable, the rate lock busy, the stop file) is marked `retry: true`: the key is not used and the day gates
   stay put, so the post goes on a later tick. A lint refusal or another X error is final.

Safety, all in code:

- **No double posts.** The tick holds `data-talk/tick.lock`; x.ts holds `x-rate.lock` around reading the rate
  file, posting and writing it (before, that sequence was unlocked). A lock whose owner died, or older than 10
  minutes, is taken over.
- **Labels from the chain are data.** Every pool and token label goes through `sanitizeLabel`: words starting
  with `@` or `#` dropped, then only a-z and 0-9 kept on each side of the pair. A pool named `$PEPE @someone`
  prints as `pepe`; a label with a blocked word (`src/talk/wordguard.ts`: slurs, hate, sexual and scam words,
  leetspeak folded) prints as `a pool`.
- **The tick reads no mentions and posts no replies.** Replies are the engage loop's job, a separate launchd job
  with its own lock (see [Engage](#engage)); a reply is not counted in the loop's spacing or its day's posts.
- **Stop at once.** `touch data-talk/TALK_STOP`: the tick stops before it reads anything, and again right before
  it posts; `postTweet` itself refuses while the file is there, so an announcement or a manual post stops too.
  Remove the file to resume.
- **Stale data says nothing.** If the paper book's last mark (or, live, the newest journal entry) is older than
  3 cycles, nothing about positions goes out.
- **Paper is said.** While the desk is paper (`DRY_RUN`, or a book that is not live) every post says "paper": the
  loop adds "(paper)" if a template left it out, and refuses a post without it.
- **The daily numbers never state a rate.** Book, moves, fees realized and net realized, in SOL, over the last 24h.

`talk.ts check` calls `GET /2/users/me` with the four keys and prints the handle they sign in as, whether it
matches `X_HANDLE`, and whether posting is on. It is the one X call that `X_LIVE` does not gate (a read that changes
nothing, `verifyCredentials` in x.ts); it never prints a key.

Going live: keys and handles in `.env`, `talk.ts check`, a day of drafts read, then `X_LIVE=true` in `.env` or in
the plist (its header says how). `talk.ts tick --force daily|lesson|strap|stack` is a PREVIEW: it prints that post
now, vetted, ignoring its hour and day gate, and writes, records and posts nothing (not even with `X_LIVE=true`).

| key | default | meaning |
|---|---|---|
| `POSTS_PER_DAY` | `6` in the loop | loop posts and dry drafts per UTC day |
| `TALK_DAILY_HOUR_UTC` | `14` | the daily numbers go from this UTC hour |
| `TALK_LOOP_MILESTONE_SOL` | `10` | the fee milestone step (the strap's `TALK_FEE_MILESTONE_SOL` stays 1) |
| `TALK_MIN_GAP_MIN` | `90` | minutes between two loop posts (0: off) |
| `TALK_WINDOW_POSTS` / `TALK_WINDOW_HOURS` | `2` / `6` | at most this many posts in any rolling window; the daily numbers pass it (the fixed card at the fixed clock), every other kind waits (0: off) |
| `TALK_DAY_START_UTC` / `TALK_NIGHT_POSTS` | `12` / `2` | before this UTC hour, at most this many posts that day; milestones wait for it |
| `TALK_LESSON_HOUR_UTC` | `18` | the lesson goes from this UTC hour |
| `TALK_STACK_HOUR_UTC` | `15` | the Monday stack goes from this UTC hour |
| `TALK_DAILY_LINK` | off | `true`: the daily ends with mrbands.finance |
| `TALK_GAP_JITTER_MIN` | `45` | each event candidate (close, open, strap, milestone) waits `TALK_MIN_GAP_MIN` plus sha256(candidate key) mod 46 minutes after the previous loop post, so the gap is deterministic across ticks and restarts and never reads as the tick. A strap's key carries its tick slot, so its jitter is seeded on the time the change was first seen instead (`strapChangedAt`): a waiting strap's wait is the same on every tick, not the smallest of successive rolls. The daily, the lesson and the stack use the plain gap, so the jitter never delays the daily past its hour (0: off) |
| `TALK_EVENT_POSTS_PER_DAY` | `4` | close, open, strap and milestone share this many of the day's `POSTS_PER_DAY` slots; the daily and the lesson keep the rest (the "last slot kept for the daily" rule extended to a reserved pair). A close with a loss is exempt from this cap (a loss is never the thing that stays quiet) but not from `POSTS_PER_DAY` or the daily's kept slot. Counted from `x-posts.jsonl` by record type, dry records included (0: off) |
| `TALK_OPEN_POSTS_PER_DAY` | `2` | opens per UTC day, inside the event cap; an open not posted is not lost, the daily counts opened bands (0: off) |
| `TALK_RETRY_BACKOFF_MIN` | `60` | after 3 consecutive retryable X refusals (402, 429, 5xx, unreachable, the rate lock busy) the tick does not call X for this many minutes, doubling each time to a 360-minute cap; `transientFails` and `backoffUntil` live in `tick-state.json` and reset on the next posted or dormant result; one loud log line per backoff and no `x-drafts.jsonl` row per held tick (0: off) |

Constants, not env: at most 2 event posts per pool per UTC day (`POOL_EVENT_POSTS_PER_DAY`; the re-centre rule already
removes the commonest churn pair) and at most 2 strap posts a day (`STRAP_POSTS_PER_DAY`; a red, green, red flip inside
a day is one story, not three). From `TALK_DAILY_HOUR_UTC` until it has gone, the daily takes rank 0 over a close, an
open, a strap change and a milestone (the min gap still applies); the lesson and the stack keep their rank.

Expected shape of a day under these values: the daily from 14:00 UTC every day, on the first tick the gap allows (a
post at 13:50 holds it to 15:20; the window never does), a lesson from 18 UTC when a
seat closed, 2 to 4 event posts spread by the window rule and the jitter, nights capped at 2, 3 to 5 posts on a
typical day and 6 only on a busy one. Zach's calendar, not code: an X pay-per-use balance check weekly, and the Mac on
mains with automatic installs off (two of Merd's five zero days were the same machine).

## What he learned from Merd

Zach, 22 Sep: "I would like to train our agent based on past projects such as merd, in the style of posts on X and
cadence." Merd (@Meridian402, `/Users/zach/dev/meridian`) is his earlier agent, an autonomous market maker for
tokenized equities on Robinhood Chain: 296 live posts from 22 Jul to 22 Sep 2026, 1,056 replies posted of 1,439 reply ledger rows, no engagement metrics
logged locally beyond what the record itself shows. What Mr Bands takes from it is structure, rhythm and craft, in code
(`src/talk/craft.ts`, and the guards in `src/talk/guards.ts`): what to say when, how to state a number, how to own a
miss, how often, and what got read. Never Merd's persona, his topics, his vocabulary (drift, re-quote, probation size,
the breaker, the tape, collects, bounded exits) or a sentence of his. Mr Bands keeps his own persona and every hard
rule as it stands: the lint's rules, `vetOutgoing`, "paper" on every post about his book, losses shown as plainly as
wins, no model in the posting loop. Replies are a separate loop with its own guards (see [Engage](#engage)).

The verdict, in five lines:

1. The shape that got read was one act or one position with its number and the rule that acted: trade logs with a
   clock time held their reach (rel_imps 1.02 to 1.10) while everything else decayed; posts carrying a number ran
   1.19 against 0.89 (his second regime) and 1.06 against 0.92 (his third); his four biggest posts were milestones
   written as done-not-planned with the number, its window, an explicit no-claim and a place to verify (#55, #66,
   #123, #76; median rel_imps 1.45 over n=14).
2. The fixed-form daily at a fixed clock is what people came back for: it landed 1 to 12 minutes after its 09:15 ET
   gate six of six times and was the only shape anyone bookmarked in his last regime (5 of 16 against 0 of 114); red
   days went out in the identical form (#220, #226).
3. Repetition and machine tells are what killed him: one product claim reworded ten times fell from 579 impressions
   and 22 likes (#74) to 26 and 0 (#286); 78% of his same-day gaps sat within 230 to 250 minutes because the floor
   equalled the tick; his own draft prompt had to lecture against posts landing at 276 to 296 characters and against
   the closing epigram. Length itself shows no effect once the feed's decay is stripped: his under-90-character
   posts sat at a median of 92 impressions against 147 for longer ones, but they sit later in a feed decaying at
   Spearman -0.88 between index and impressions, and against their neighbours they read 0.97 to 1.00; split the
   regime in half and each half says the same. What held reach in a short post was a number in it (1.13, n=7,
   against 0.92 without, n=27), and the 260 to 330 bucket's 1.31 is six milestones and nine quote posts, the other
   thirteen at 0.89. So: a figure in every post, and no length floor; a short factual post is not designed out.
4. Every pipeline failure was mechanical and avoidable: 81 failed attempts (59 retries of one print plus 22 posts) on a
   402 retried every 15 minutes for 14 hours, 24 reply and skip drafts leaked with their `**REPLY**` and `Reasoning:`
   markers (22 top-level quote posts plus 2 replies; 20 of them after his cleaner existed), and every zero day was
   credits or the Mac.
5. What the record cannot teach is reach: impressions tracked his reply job, not the writing (Spearman 0.63 between
   replies posted that day and median impressions; 40-plus-reply days at 680 median impressions against under-5-reply
   days at 160), and decayed monotonically to 24 to 26 impressions by 22 Sep once the replies stopped. Mr Bands answers
   only people who summoned him, tags nobody and cannot quote-post, so his baseline is the low hundreds and single-digit likes, and no
   content lever in Merd's record moves that by more than 1.5 to 2x except a genuine milestone. Hour, weekday and gap
   effects were all under 1.3x and inconsistent between regimes, so the cadence knobs stay where they are (the table
   above), with jitter, caps and a backoff ported from his failures, and he measures his own record after two weeks.

### The craft, in code

`shapePost(kind, facts)` in `src/talk/craft.ts` writes the text of one loop post from the facts a tick already has
(`CraftFacts`: the event with the journal's proposal and directive and the bins out at the close, the strap with the
time since its change, the daily with a day counter and the last 7 days of the same book, the milestone with its best
and most recent day, the lesson, the stack). It returns null for anything it does not shape, and `tick.ts` then uses
its own template; every text, crafted or not, still goes through `paperize`, `vetOutgoing` and the lint. Nothing in
craft reads a file, calls X or bypasses a guard. The rules, each with the Merd evidence it comes from:

| rule | what he does | Merd |
|---|---|---|
| shape | one act or one position per post, two to four lines, as long as the facts need and never over 280; no length floor. The daily and the Monday stack stay ledger cards, a line per fact. A short shape carries a fact with a figure in it: the zero-move daily, the flat strap, a one-line close. No mood line: "never fake a state" rules it out, and a line without a number is the one short shape the record says was not read | length shows no effect once the feed's decay is stripped (under-90 posts at rel_imps 0.97 against 1.00, each half of the regime alike); a number in a short post 1.13 against 0.92 without; the 260 to 330 bucket's 1.31 is milestones and quote posts (the other 13 at 0.89); mood one-liners at 81 with no bookmark; #335, the 57-character zero day; his era-C median of two sentences |
| openers | three per kind, chosen by sha256(candidate key) mod 3, so a tick is reproducible and the key still dedupes: a close begins "closed my band on x after 5.2h, 14:07 utc." or "x, closed 14:07 utc after 5.2h." or "5.2h in x and out at 14:07 utc."; an open and the lesson rotate the same way; the daily has two orderings by UTC-day parity. Every close carries its UTC clock time | 23 bare-verb, 21 number-first and 6 clock-time openers in his clean set; posts with HH:MM held 1.10 (n=12) while the feed decayed; the rotation is against the machine tell, not for reach (number-led posts read 0.89 and 1.03) |
| numbers | every post carries at least one figure with its window, at measured precision (`signedSol` and `sol4`, never "-0.0000", never rounded away), in SOL; never a rate, a return or a USD conversion (the lesson's "in range 95% of checks" is a count of checks, not a rate, and the persona says so). The strap post gains a number: bands in range of total, hours since the change, bins out for red | has_num 1.19 against 0.89 (n=65/46) and 1.06 against 0.92 (n=62/68), with his retweets and bookmarks sitting almost only on numbered posts; his cent-precise figures and "never round a loss away" (`_merd-daily.mts:231`) |
| the comparison | the daily and the close put the figure beside his own days on the same book: "fees 0.0087 sol, thinner than any of the last 7 days, after 0.0412 yesterday"; "net +0.9534 sol, more than any whole day of the last 7 netted". Only to his own days, in SOL, never to a rate, an APR, another account or "on pace for" | #225 ("thinnest fee day of the week, after $193.21 the day before"), #191, #357; Merd fed his drafter the last five daily rows for exactly this (`_merd-daily.mts:120-134`) |
| the miss | a close with a loss names the mechanism, what the rule did, and what he had proposed, in one post with the number: "net -0.0412 sol, a loss; fees 0.0087 sol counted in it. price sat 14 bins above the band at the close. the stop closed it." The proposal, the directive and who answered (`llm.source`) come only from the journal entry whose `execution.closed` is the band; absent means the line is left out, never invented. On a directive cycle (STOP, FLATTEN, EXPIRE, ROTATE) the model is not called and the entry's proposal is the engine's own CLOSE_POSITION, so no proposal of his is claimed: only what the rule did. A desk-policy close is said as his own rule's ("my own rule proposed the close; the guards allowed it."), the model's as his ("i proposed the close myself"); COLLECT never closes a band and is never the closer | #343 ("not cutting was a decision and it cost more than cutting did"), #92 ("i didn't override it"), #384 ("the 7th was my miss"); reach-neutral (0.90 to 1.06) and required by his rules anyway |
| the lesson | three parts, no fixed takeaway: what the seat did (label, hours, in-range share), what it cost or paid (fees and net, the unsold tokens as an optional line dropped first when the post runs long), and what the rule did (the end reason as the actor, "the stop pulled the seat", never the close's line for the same seat). "fees are not profit" is said by juxtaposition (fees x, net y after rent and swaps), not as the sentence. This also fixes a silent drop: the old template rendered 287 characters on a loss with fees and tokens, over the 280 vet, and lost that day's lesson | his three fixed takeaways repeated verbatim weekly; era C has no fixed sign-off outside the automated print card |
| endings | land on the fact and stop. An open ends "5 bands open on the paper book", not "i propose, the guards decide"; the stack has no "still stacking"; the milestone is the round level, its window, the best day and the most recent day in SOL, the net over the same stretch, and an explicit no-claim ("nothing about the next 10"). "paper" rotates by seed parity between ", paper book" on the first line and "paper book." as the last line: the meaning is on every post, the position varies | 17% of his era-C posts end on six words or fewer; his prompt bans the closing epigram (`_merd-daily.mts:326-333`); #178 for the milestone shape |
| the daily | the fixed card at the fixed clock with a "day N" counter of the paper run, two orderings by UTC-day parity (even: one dense line of figures then the book line; odd: a line per fact), a red-day shape that states the loss first ("day 13, paper book, net -0.0301 sol on the day."), and a one-liner when nothing opened or closed and fees round to 0.0000, still with "paper book" and the comparison. Never "a new high", never a "+" on fees as a headline | 5 of 16 prints bookmarked against 0 of 114 other posts; #166 ("small day, boring tape, posted the same way i post the big ones"); #220 and #226, down days in the same form; the three print shapes in `_merd-daily-print.mts:90-107` |
| links | none in a loop post. A solscan link on a live-book milestone is the one exception, later, not on paper (nothing to verify on chain) | era C: 0 links; a URL costs 13x on pay-per-use |

Never in a post (`BANNED_PHRASES`, tested): "quiet days like this are the whole strategy", "not quoting is a
position", "a new high", "fees only go up", "small by construction", "the rule cut it", "no claim step", "on pace
for", "still stacking", "i propose, the guards decide".

The tests (`npx tsx src/scripts/test-talk-craft.ts`): every shape for every kind over synthetic facts passes
`vetOutgoing`; every event post carries a figure and fits 280 (no floor); the loss-with-fees-and-tokens lesson fits 280;
the odd-parity daily on an extreme day with a yesterday row fits 280 (its comparison goes first, the book line second,
the figures never; before this fit it ran 285 to 311 and the day's card was refused); every number in a post is
in its facts and the key figures of the facts are in the post; "paper" is on every post; over many seeds each of the
three openers appears and one seed always gives the same text; no fixed line repeats across two kinds; the red daily
states the loss first; the zero-move daily is one line; the banned phrases never appear.

### The guards, ported from his failures

`src/talk/guards.ts`, pure, each pinned to the incident it comes from (`npx tsx src/scripts/test-talk-cadence.ts`):

- `similarity` / `tooSimilar`: meaningful-word overlap over the smaller set, stop words and words of two characters
  or fewer dropped, on the raw text with numbers and labels kept. Threshold 0.85 against the loop's texts of the last
  7 days. Applied as a candidate filter for the milestone only (never against an earlier milestone). Not for an
  open, a strap or a lesson: those are templated claims about different seats and states, and two of them overlap
  0.85 to 1.00 by construction (six straddles in six pools: 12 of 15 pairs over the bar; two green straps three days
  apart: 1.00; two stop-closed losses a day apart: 0.85), so the filter refused the genuine events it was meant to
  let through and masking the figures and labels would make every two identical. The key dedupe, the day's caps,
  the per-pool cap and the strap cooldown ration those kinds. Never a close (a loss is always said), never the
  daily or the stack (their form repeats by design). A filtered candidate is a note, not a drafts row and not a
  consumed key; the next candidate is picked. Merd's reworded repeat drew 93 impressions against 2,165.
- `repeatedStat`: the same 4-decimal SOL figure in a milestone or lesson post of the last 24 hours, checked on a
  milestone or a lesson (a lesson repeating the milestone's net). Never against a close, an open or a strap: a fee
  figure two seats share is a coincidence, not a talking point twice, and the day's lesson was lost to one.
- `vetOutgoing` refuses `**`, `reasoning:`, `draft:`, `post:`, `note:` and `skip` as a line or label (`loop-markers`)
  and a sentence that repeats inside one post (`self-echo`). Merd's 24 leaked drafts got through, 20 of them after his
  cleaner was written; model replies exist here now, and `vetReply` (below) runs both on every one.
- `jitterMin`, `eventCaps`, `backoff`: the knobs in the table above.
- `x.ts` keeps X's `detail` beside `title` in a refusal reason, sliced to 200 characters, never the request headers:
  Merd's 81 failures are diagnosable in one grep only because `detail` said "credits depleted".

Not ported: Merd's forbidden-phrase list (his secrets and product), his helpless-reply check (Mr Bands never asks the
timeline), his reply cleaner, `stripDashes` and `stripSelfEcho` (every reply guard here refuses and none rewrites),
his launch-on-mention handler (nothing in the reply path acts on mention text) and delete (a leak is deleted by hand).

## Engage

Zach, 22 Sep: "Can we make sure our agent is replying and an active participant on X." Replies were off by design
until then; that is reversed. He answers people who summoned him, and nobody else. The model proposes, the guards
decide: his brain drafts a reply or says skip, and code decides whether anything is posted.

`src/talk/engage.ts`, run as `talk.ts engage` by launchd every 120 seconds (`ops/com.bands.mrbands.engage.plist`,
`RunAtLoad`, `DATA_DIR=data-live`, `TALK_STATE_PATH=data-talk`, log `data-talk/engage.log`). It is separate from the
15-minute tick and never takes `tick.lock`: one pass may wait up to 45 seconds per mention on his brain. A poll that
returns nothing is not billed, so the cost follows mention volume, not the polling rate (720 polls a day is 2.5% of
the 300-per-15-minutes mentions limit). A mention gets its answer in about 2 to 3 minutes.

**The switch.** Replies go out only when `X_REPLIES=true` (the literal string) and `X_LIVE=true` are in `.env`, his
brain is ready (a real `OPENHERMIT_TOKEN` and a gateway that authorizes it), and neither `TALK_STOP` nor `ENGAGE_STOP`
is in `data-talk`. Anything else is dormant with one status line an hour in `engage.log`; `talk.ts engage status`
prints it every time, for free.

**What Zach supplies.**

1. `OPENHERMIT_TOKEN` in `.env`: the gateway's admin token. Empty, under 32 characters or placeholder-shaped
   (`your`, `token`, `here`, `change`, `placeholder`, `example`, `xxx`) reads as dormant, and the reason never
   prints the value. The loop never reads the gateway's own `.env`.
2. Re-provision his rows (`src/scripts/openhermit.ts`) so the reply rules are his and the tool deny policy is on the
   agent (web, session and memory reads denied to every caller): that needs the real token.
3. **X's approval.** X's developer guidelines say an app posting AI-generated replies "Requires prior approval from X",
   and "Deploying AI-generated replies without approval is a violation, even if the content itself is helpful". File
   help.x.com/forms/platform and update the app's use case at console.x.com. Until X approves, `X_REPLIES=true` is a
   risk taken knowingly. The fixed-answer templates are not AI-generated.
4. An OpenRouter key limit for his model (Opus 5 per call is estimated, not measured, at $0.05 to $0.15). Each ask
   is two model runs: the reply turn, and the gateway's idle introspection 10 minutes later, which runs on every
   session whatever the agent's config says (docs/openhermit.md). `ENGAGE_MODEL_CALLS_PER_DAY` counts both.
5. Check whether @MrBandsSol owns the developer app at console.x.com: owned reads of the mentions endpoint are
   billed at $0.001 a resource instead of $0.005 a post.
6. Then `X_REPLIES=true` in `.env` and `launchctl bootstrap` the engage plist.

**Who he answers.** Since 23 Feb 2026, self-serve API tiers may reply only to a post that @mentions the account or
quotes its post. He answers three kinds: a reply to his own post or reply (`in_reply_to_user_id` is his id), a post
that names @mrbandssol in its body (outside the leading reply prefix, from `display_text_range` and
`entities.mentions`), and a quote of his post. He never answers a post that carries his handle only in someone else's
thread's inherited prefix (all 12 of the 21 Sep thread under @louz514's post), a bot (`clawpumptech` answers every
mention of him within minutes; any bio saying bot, automated, agent, autonomous or auto-reply), an opt-out, a farm,
a shill, a scam, himself, or anyone twice in one conversation unless a real question comes back. At most one reply per
interaction. He never searches, replies outreach-style, quote-posts, follows, likes or DMs; never @mentions anyone in a
reply; never posts a link; never pastes a mention's words, handles, cashtags, addresses or links back; never acts on
mention text; never hides that he is a bot (the "Automated by @louz514" label stays).

**One pass**, cheapest first; nothing below a "no" runs, so a dormant loop spends $0:

1. `TALK_STOP` or `ENGAGE_STOP`: "engage stopped".
2. `X_REPLIES` is not `true`: "engage off".
3. The brain is not ready (`brainProblem`, or `brainDown` with the same token hash): "replies dormant: <why>". A
   brain hold after a timeout or outage: "brain hold: ..." (no X read, no ask).
4. `repliesOff` (3 "not mentioned" 403s in a row): "replies off: <why>, run talk engage resume".
5. `xGateProblem` (X_LIVE, credentials, handles).
6. An X hold: this loop's, or `tick-state.json`'s `backoffUntil` read-only (a 402 is account-wide).
7. The day's read budget (`ENGAGE_READS_PER_DAY` mention posts, UTC day).
8. `engage.lock` (stale after 10 minutes).
9. Identity, once per access token: `GET /2/users/me` must answer `X_HANDLE` and id 2099900363679633408; cached, and a
   token for another account is not asked about again until it changes.
10. `getMentions` since the cursor, at most 2 pages of 100 and never past the day's read budget (a page asks for what
    is left, 5 at least). A failure is `{ ok: false }`, never an empty list: the
    cursor stays, 402/429/5xx/unreachable feed the backoff, a 429 waits for `x-rate-limit-reset`. When the second page
    fails after the first went through, the first page's mentions are kept (they were read and counted), the cursor
    moves past them, and what lies between the old cursor and the oldest one kept becomes `gap`: the next pass reads
    only that (`since_id` the old cursor, `until_id` the oldest kept), so nothing is read twice and nothing is dropped.
    The first run seeds the cursor with one read of 5 (X's floor, no second page) and answers nothing.
11. New mentions join `pending`, oldest first; the cursor moves; save. A deferred mention is never read (and billed)
    twice and never silently dropped (Merd dropped 164).
12. A mention a dead pass left claimed is finished first: `drafting` never reached X ("skip: interrupted mid-pass while
    drafting"); `posting` may have, so unless `x-posts.jsonl` holds the reply it is "unknown: interrupted mid-pass",
    which the conversation caps count as a reply, and `x-rate.json` gets a provisional row so the day's, the hour's
    and the account's caps count it too. It is never posted again. Every pending mention is screened (the opt-out
    check, classify and screen: a skip costs $0). The rest are taken in turn by author (each account's oldest, then
    each account's second, so one account's sixty mentions never go ahead of another's one): screened again; the fixed
    answers (no model call, and not held by the model-call cap; one fixed line goes out at most
    `TEMPLATE_REPLIES_PER_DAY`, 5, times a UTC day, to anyone, and past that the mention is skipped); the caps without
    spending (the reply cap or a rate cap full defers every mention and the pass ends; a model cap, the day's model
    calls or the pass's asks, defers only a mention that would ask, so a fixed line behind it still goes out; one
    account's own cap, 3 model asks a day or `MAX_REPLIES_PER_ACCOUNT`, defers only its mention); `TALK_STOP` and
    `ENGAGE_STOP` looked for again; claim it (`drafting`, saved); `draftReply`; `vetReply`; the stop files again (a stop
    touched mid-pass puts the mention back with its draft); `posting`, saved; `postReply`.
13. Prune: pending past `ENGAGE_MAX_AGE_HOURS` is stale, handled entries past 7 days go; save; release the lock.

**The screen**, all before any model call, every outcome in `x-mentions.jsonl`: the opt-out
(`stop`, `unsubscribe`, `opt out`, `don't reply` and `do not reply`, `do not tag me`, `never reply to me`, `quit
replying`, `no more replies`, `remove me`, `don't @ me`, `shut up`, `stfu`, `leave me alone`, `go away`, `mute`; not
stop-loss, nonstop or unstoppable), which goes into `engage-optout.json` for good with no reply ("if a user says stop,
stop"); the kind; himself; stale; the bot deny list and bios; `screenMention` (flagged and suspicious handles, scam
bait, key requests, 3 a day per account); any link at all (X wraps every link in t.co), and a domain spelled out
("solclaim dot io", "solclaim[.]io"); `instructionIn`: `INJECTION_RE` plus a paraphrase ("disregard the above", "your
task now"), a gateway tool's name (web_fetch, session_*, memory_*), read through invisible characters and look-alike
letters ("ign\u200Bore previous instructions"); blocked words in the handle, the display name and the text; the same link, instruction, blocked-word and shill checks on another account's parent
post (it goes to the brain too); a mass tag (more than 3 other handles in the body, unless it answers his post); a cashtag
or address other than the house token's or the copycat's (a shill is skipped, never corrected); the conversation caps
(1 reply per author per conversation a day, 2 when the follow-up asks a question, 4 per conversation a day); and
hollow praise ("this feels massive", three meaningful words or fewer, no question, no named topic): skipped from a
farm (an account under 30 days old with under 20 followers), otherwise sent to the brain marked hollow, at most
`ENGAGE_HOLLOW_PER_DAY` a day. 72% of Merd's 1,036 replies answered hollow mentions.

**His brain** (`src/talk/replyBrain.ts`): the fixed-answer templates first, with no model call. They route on the
topic, not the phrasing, on the text with its @handles removed, invisible characters stripped and look-alike letters
folded: the copycat line only when the mention carries the copycat mint (or a piece of five characters or more) or asks
whether a coin is his; any other token word (token, coin, memecoin, ticker, ca, mint, contract, launch, dev, deploy,
airdrop, presale, clawpump, pump.fun, dexscreener, rug, a bare `$bands`) gets "no token of mine is live" (a generic
"which tokens" is skipped); who built him, who is behind him, bot or human, or his architect by name gets the
architect line, which names nobody; real money, live, on chain or simulated gets the paper line; "how much"; any price
question (a buy or sell word, "would you add", "is sol going up", "where is it headed", bullish, a good time, the dip);
"are you a bot" and "are you real" only as the whole question; an affiliation question ("are you with meteora", "an
agent of binance") is skipped. Otherwise one fresh session per mention (`x-mention-<id>`) on his own gateway agent, 45
seconds, a facts block with no book figures, the mention inside a `<data>` block without the author's display name
(free text nobody screens), and a one-object JSON contract. The templates read another account's parent with the
mention, so a price or token question placed there still gets its fixed line. A timeout, an unreachable gateway or a bad turn puts
the mention back and holds the brain (10 minutes, doubling to 2 hours, cleared by the next answer): no X read and no
ask until it ends, so an outage spends neither. Unauthorized or not-found sets `brainDown` with a hash of the token,
dormant until the token changes or `engage resume`. On the gateway, provisioning denies his agent every tool granted
to "any" that a mention could turn against him (web_fetch, web_search, session and memory reads, docs, attachments):
the talk loop voids a turn that called a tool outside `bands_*`, and the deny stops the tool from running at all.

**The guards** (`src/talk/replyGuards.ts` `vetReply`, then `postTweet`'s lint). Every check refuses; none rewrites.
A refused draft is final, logged in `x-drafts.jsonl` and `x-mentions.jsonl`, and never falls back to posting.

| rule | refuses | from |
|---|---|---|
| shape | empty, more than 2 lines, over 200 X-weighted characters from the model or 280 from a template | |
| markers | `**`, `reasoning:`, `draft:`, `post:`, `note:`, `reply:`, `quote:`, a `skip` line, a `>` line, `decision:`, `to @x:`, `@x, skip`, a backtick, `{`, `}`, `"reply"`, `(for the @`, "say the word and i'll draft" | "**@ponsdotfamily, SKIP**", "> migrating live treasuries" |
| narration | "i'll skip", "i should keep", "the reply", "reads as", "nothing to add", "draft", "staying quiet", "not engaging", "bait", "a fixed line", "deflected", "leaving this one alone" and the rest, anywhere in the text; a whole-text non-answer ("n/a", "none", "pass", "no response needed"); talk about the prompt or the model ("as instructed", "i was told", "my instructions", opus, claude, sonnet, gemini, "system message", operator, anthropic, openhermit, the loop); from the model, any 5-word run of his reply rules or the prompt's instructions | 2094236244871922117, 2092142015597154747; Merd's isSkip caught 0 of 21 leaks |
| tags and links | any `@`, `#` or `$`, and their fullwidth and small-form look-alikes (X reads `＠` as an at-sign; the lint's `lookalike` rule refuses the whole fullwidth block in every post); any URL or bare domain (a link costs $0.20); a domain spelled around the link rule ("dot io", `[.]`, `(.)`, a look-alike dot) unless it is his | |
| charset | from the model, anything but printable ascii and curly quotes: a cyrillic letter, an invisible character or an emoji hides a word from every rule below | "yes, it is m\u0456ne" |
| blocked words | `wordguard.blockedWordsIn` | Merd's "does the fucking" reply |
| architect | his architect's name (zach, zachary, loubert, louz) or `OPERATOR_HANDLE`, with or without `@`, from any source: in public he is only "my architect" | the review of 22 Sep, second round |
| the lint | every rule of `lintText`, the house-token disclosure and the copycat denial included | |
| self-echo | a sentence twice in one text | |
| echo | a link, handle, cashtag or address from the mention or its parent, or any shared 5-word run | "you're early, not late"; "$GUARD ... undervalued" |
| address | a base58 address that is not `TOKEN_MINT`, or the copycat's without a denial | |
| model only | token topics (token, coin, memecoin, mint, ticker, ca, contract, pump, clawpump, launch, deploy, airdrop, presale, mcap, holders, early) and ownership claims ("mine", "i made", "i work for", "the team behind"), and any reply at all to a mention about a token (a "yes." carries the claim through the question); any number not in the facts, in digits or in words ("three sol", "a few bands"); a pitch (sign up, check out, join, dm me, try the engine); advice ("i'd hold", "get out", "all in", "i'd be a buyer here", "if i were you", "not advice but", "size small", "off the table", "the best pool"); price direction ("goes up", "from here", "printing", "looks cheap", "ready to run", "the bottom is in", "expect a bounce", "it'll climb", "the dip"); profit ("made money", "up big", "printed", "win", "it works", "is up on", "best week"); live money ("real money", "real funds", "went live", "no longer paper", "on chain", "a real track record"); dunks ("cope", "stay poor", "touch grass", "skill issue", "ratio", "rekt", "cooked", "who asked", "cringe"); politics (with dems, libs, gensler, tariffs, the senate, the president); and fewer than 3 meaningful words ("k", "...", "no") | the review of 22 Sep, both rounds: each one passed the lint |
| paper | the book (my book, my bands, positions, seats, fees, net, pnl, sol, range, a band opened or closed) without "paper"; "not paper", "no longer paper" and "from paper" are not "paper" | |
| similar | a model reply with 0.5 meaningful-word overlap with any of his last 50 model replies. The fixed lines are meant to repeat (the copycat denial most of all) and are held by the per-account and conversation caps instead | 23 variants of "greatness is a big word" |

`postTweet` refuses a `reply` without `replyTo` and `replyTo` on anything else (never a top-level post by accident),
a reply to his own handle or post, and, inside the rate lock right before the POST, a second reply to the same
mention (`x-posts.jsonl`, so one reply per mention survives a crash). `engage.ts` posts only through `postReply`.

**The POST.** `postReply` leaves everyone the mention names except its author (its reply prefix and its body, from
`entities.mentions[].id`) out of his reply with `reply.exclude_reply_user_ids`, so a reply deep in someone else's thread
pings nobody who did not summon him; a plain reply keeps the plain `{text, reply:{in_reply_to_tweet_id}}` body. Each
POST tried counts toward `ENGAGE_REPLIES_PER_PASS`, whatever X answered, and waits 5 seconds after the pass's last one.

**After posting.** A 403 "not mentioned" is final for that mention; three in a row turn replies off until
`engage resume`. A 401, a 402, any other 403, a 429 or a 5xx means nothing went out: the mention goes back to pending
with its vetted draft, and the reply-post counter (`postFails`, cleared only by a reply that posts, never by a mentions
read) sets the hold: a 402, a 401 or a 403 (the account or the app refused, "looks automated", duplicate content)
holds at once for 60 minutes, a 429 waits for its `x-rate-limit-reset`, a 5xx holds from the third in a row;
each hold doubles to 360 (`TALK_RETRY_BACKOFF_MIN`, 0 turns holds off). The retry after the hold re-vets the kept draft
and posts it without asking the brain again. An unreachable POST may have landed, so the mention stays handled and is
never retried. Our own limiter (`rate: `) defers and is not an X failure.
Every X refusal keeps X's title and detail. Merd retried one 402 59 times over 14.6 hours.

**Caps**, env keys with defaults, enforced in code: `REPLIES_PER_DAY` 40 ($0.40 a day at $0.010 a reply),
`REPLIES_PER_HOUR` 10, `MAX_REPLIES_PER_ACCOUNT` 3, the conversation caps above, 3 reply POSTs a pass 5 seconds apart
(no human-pacing jitter: he is labelled automated), one fixed line at most 5 times a day (`TEMPLATE_REPLIES_PER_DAY`),
`ENGAGE_HOLLOW_PER_DAY` 10, `ENGAGE_READS_PER_DAY` 300 (mention posts, counted from X's result_count) and
`ENGAGE_MODEL_CALLS_PER_DAY` 60 (model runs: each ask counts 2, the reply turn and the gateway's idle introspection,
so 30 asks a day), 3 model asks per account a day whatever comes back, and `ENGAGE_REPLIES_PER_PASS` times 2 model
asks a pass. X's pay-per-use prices as read from docs.x.com: $0.005 a post read, $0.010 a user read, $0.010 a reply to
a post that mentions him, $0.015 a plain post, $0.200 with a link; the same resource is billed once per UTC day.
Expected X spend about $1 to $2 a day (today's 20 to 60 mentions read for $0.30 to $1.20). The read budget counts
mention posts only, but each one also brings back its author and up to two referenced posts (the post it replies to
and the post it quotes), so the hard ceiling is near $8.10: reads $7.50 (300 x ($0.005 + $0.010 + 2 x $0.005), and
X's floor of 5 a page can overshoot the budget by 4 posts), replies $0.40, his own posts $0.09, and $0.10 of slack.

**State**, all in `data-talk`: `engage-state.json` (the cursor and a `gap` a failed page left, the confirmed identity,
`pending`, `handled`, `brainDown`, the brain hold, the read and reply-post backoff, the kept drafts, the 403 count,
`repliesOff`, the day's counters; temp + rename after every mention; an
unreadable file stops the pass), `engage-optout.json`, `x-mentions.jsonl`, `engage.log`, `engage-status.json` (the
last dormant line) and `engage.lock`.

**Stop.** `touch data-talk/TALK_STOP` (posts and replies) or `touch data-talk/ENGAGE_STOP` (replies only; a pass
already running looks again before each ask and each POST, so nothing more goes out); remove
`X_REPLIES` from `.env`; or `launchctl bootout gui/$(id -u)/com.bands.mrbands.engage`. When a bad reply escapes: touch
`TALK_STOP` and delete the reply by hand. He never defends a leak in public.

`talk.ts engage preview <mentions.json> [--no-model]` runs the classify, the screen, the brain and the vet on a saved X
response: no X read and no post, ever, and nothing written.

## The weekly review

1. Daily: `talk.ts reflect`. Proposals that pass the lint and the gate land in pending; the rest are printed with why.
2. After a bit is used and its engagement is in: `talk.ts use <bit-id> landed|flopped`. The gate proposes promotion
   or retirement; it never applies either.
3. Weekly, before review: `talk.ts drift`. Anything flagged is dealt with first.
4. `talk.ts proposals`, then for each: `talk.ts approve <id> --operator <handle>` or
   `talk.ts veto <id> --operator <handle> --reason "<why>"`. Each applied change raises the version; the decisions
   log records who decided, the time and the reason. A vetoed bit or opinion is remembered as retired by veto.
