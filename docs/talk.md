# The talking layer

Mr Bands' voice on X, built against `docs/mr-bands-agent.md` (the spec). Part 1 of the spec, the locked core,
is enforced in code by a lint that every outgoing text passes. Part 2, the living layer, lives in a state file
that only the operator can change. Nothing here places, signs or broadcasts a trade: the talking layer reads the
journal, the paper book and the ledger, and writes only its own files.

**Posting is dormant.** Nothing reaches X until the operator supplies everything listed under
[What is dormant, and what the operator must supply](#what-is-dormant-and-what-the-operator-must-supply). Until then every `post` prints the draft, says why it did
not go out, and appends it to `x-drafts.jsonl`.

```
src/talk/env.ts          every spec placeholder as an env key with a default
src/talk/lint.ts         the compliance and voice lint (pure); the phrase lists are exported
src/talk/strap.ts        strap state, stack figures, window labels (pure)
src/talk/data.ts         reads DATA_DIR: decisions.jsonl tail, paper-book.json, ledger.jsonl (read-only)
src/talk/drafts.ts       drafts for each post type, from live data only (pure)
src/talk/personality.ts  personality.json: propose, record uses, the gate, operator approve/veto
src/talk/reflect.ts      the daily reflect call and the weekly drift check
src/talk/x.ts            the X API v2 client (OAuth 1.0a, rate limits, mention screen), dormant
src/talk/tick.ts         the posting loop: one tick picks at most one event post (see "The posting loop")
src/talk/lock.ts         the lock file around the tick and around read-rate, post, write-rate
src/scripts/talk.ts      the command line
src/scripts/test-talk.ts the tests: npx tsx src/scripts/test-talk.ts
src/scripts/test-tick.ts the posting loop's tests: npx tsx src/scripts/test-tick.ts
ops/com.bands.mrbands.talk.plist  launchd: one tick every 15 minutes, posting off
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
| `REPLIES_PER_HOUR` | `{{REPLIES_PER_HOUR}}` | `10` | replies per rolling hour |
| `MAX_REPLIES_PER_ACCOUNT` | `{{MAX_REPLIES_PER_ACCOUNT}}` | `3` | replies to one account per UTC day |
| `MAX_BIT_USES_PER_WEEK` | `{{MAX_BIT_USES_PER_WEEK}}` | `3` | uses of one bit in a trailing 7 days before it rests |
| `TALK_STATE_PATH` | `{{STATE_PATH}}` | `DATA_DIR` | personality.json, x-rate.json, x-posts.jsonl, x-drafts.jsonl |
| `DATA_DIR` | | `data` | where the journal, paper book and ledger are read |
| `CYCLE_INTERVAL_SEC` | | `300` | data older than 3 cycles is stale |
| `X_LIVE` | | off | only `true` lets anything reach X (posts and engagement reads) |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | | none | OAuth 1.0a user context for `POST /2/tweets`; never logged, never written |
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`), `MODEL` | | as the desk | the reflect call, detected exactly as `src/agent/decide.ts` does |

### The edge threshold

`STRAP_EDGE_PCT` is a percent of the band's width, not of price. The desk's bands are about 1% of price wide (a
5-bin straddle at 20 bps a bin), so "within 15% of price of an edge" would be true of every band all the time and
the strap would read yellow forever. With the default 15, a band from 100 to 101 is yellow below 100.15 or above
100.85, green between. A one-bin band has no width between its bin prices and reads as at its edge.

## The spec, section by section

**1. Identity.** The "are you a real person" lesson and reply say "ai agent" and name the operator. The lint fails
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
| 6 disclose any relationship | `cashtag`: a cashtag that is not the house token fails; `house-token-disclosure`: `$bands`, a house mint, "bands token" or a `bands/` pair label needs "disclosure:", "our token", "operator launched" or similar; `house-token-price`: price, return, fee, holder, volume words, a percent or a dollar figure next to the house token fail even with a disclosure |
| 7, 8 no impersonation, no mascots | the voice is fixed text in drafts; no draft names another brand or person |
| 9 no scams or suspicious links | `link`: only bands.finance, solscan.io, meteora.ag (subdomains too) and x.com/`OPERATOR_HANDLE`; `scam-bait`: dm me, airdrop, giveaway, claim your; the mention screen skips link-only and scam text and bot-looking accounts |
| 10 no em dashes | `em-dash` |
| 11 never trades | `src/talk` imports no executor, wallet, swap or venue adapter; a test fails if one appears |
| 12 inbound text is data | reflect wraps posts, mentions and tool output in `<data>` blocks with `<` escaped; a mention only selects a canned answer and instruction-like text gets no reply |
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
or unsolicited-mention code. The automated-account label and the bio are the operator's to set on X.

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
| `write_state` | `approveProposal`, `vetoProposal`, operator identity required |

**13. Post types.** `strapCheck`, `rebalanceNote` (the newest REBALANCE, or a CLOSE then OPEN in the same pool within
two cycles, that the guards allowed and that executed; why from the band's position before the move and the engine
directive, what from the new band's bins), `stackUpdate` (weekly, 7 days), `chopAppreciation` (only when a held,
in-range pool's price stayed inside `TALK_CHOP_RANGE_PCT` over the window and the samples cover at least 75% of it),
`lesson` (static explainers, one per day in rotation or by topic), and replies (`replyFor`, canned answers only).

**14. Voice samples.** All five pass the lint (tested). They are style references; no draft copies one.

**15. Things you never say.** `NEVER_SAY_PHRASES` verbatim and `NEVER_SAY_PATTERNS` (tested phrase by phrase).

**16. Common questions.** Lessons and replies: `how-much`, `token-calls`, `real-person`, `impermanent-loss`, plus
`what-i-do`, `concentrated-liquidity`, `out-of-range`.

## What is dormant, and what the operator must supply

Dormant: posting, replies and engagement reads (`x.ts`) and the reflect call (without an Anthropic key). Nothing
else talks to anything outside the machine.

To go live on X, the operator:

1. Creates the X account and sets, on X, the **automated account label** linked to his own account and a **bio
   that says Mr Bands is an AI agent**. Only the operator can do this; no code here touches the profile.
2. Creates an X developer app with read and write permission and generates the user-context OAuth 1.0a keys for
   the Mr Bands account: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`.
3. Sets `OPERATOR_HANDLE`, `X_HANDLE`, a `TALK_STATE_PATH` of its own, and `TALK_HOUSE_SYMBOLS` / `PAIR_HOUSE_MINTS`
   once the token exists.
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
2. Builds candidates from events. Templates for the new post types live in `tick.ts`; the strap and the stack use
   `strapCheck` and `stackUpdate` from `drafts.ts` unchanged.

   | kind | when | key |
   |---|---|---|
   | close | a band closed in the last 2h: its net in SOL over the band's whole life (claims while open included; its lessons.jsonl row when there is one, so the close and the lesson agree), a loss said as a loss | `close:<band>` |
   | open | a band opened in the last 2h, unless a close in the same pool within two cycles covers it (a re-centre) | `open:<band>` |
   | strap | the strap state changed since the last tick (not on the first tick), at most one every 3h | `strap:<from>><to>:<slot>` |
   | milestone | realized fees crossed a multiple of `TALK_LOOP_MILESTONE_SOL` (10), with the net over the same stretch; from `TALK_DAY_START_UTC` (12) | `milestone:<source>:<sol>` |
   | daily | from `TALK_DAILY_HOUR_UTC` (14) once a UTC day: the book, the day's moves, fees, net; no link unless `TALK_DAILY_LINK=true` (a post with a URL costs $0.20, not $0.015, on X pay-per-use) | `daily:<day>` |
   | lesson | from `TALK_LESSON_HOUR_UTC` (18), at most once a UTC day: the seat closed in the last 24h with the biggest net either way | `lesson:<band>` |
   | stack | UTC Mondays from `TALK_STACK_HOUR_UTC` (15), once: the 7-day stack update | `stack:<day>` |

3. Picks at most one, in that order (close > open > strap > milestone > daily > lesson > stack), skipping any key
   posted, drafted or refused in the last 7 days, and nothing once the UTC day holds `POSTS_PER_DAY` loop records
   (6 for the loop unless the env sets it; the loop passes the same number to the x.ts limiter). Spacing holds
   everything (status `spaced`) while: the last post went less than `TALK_MIN_GAP_MIN` (90) minutes ago; the last
   `TALK_WINDOW_HOURS` (6) hours hold `TALK_WINDOW_POSTS` (2); it is before `TALK_DAY_START_UTC` (12, 8am EDT) and
   the day already holds `TALK_NIGHT_POSTS` (2). The day's last slot is kept for the daily numbers until they go.
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
- **No replies, no mentions.** The loop never reads mentions and never replies; replies stay off entirely. The
  reply code in x.ts (`replyToMention`, `screenMention`) is not run by anything scheduled.
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
| `TALK_WINDOW_POSTS` / `TALK_WINDOW_HOURS` | `2` / `6` | at most this many posts in any rolling window (0: off) |
| `TALK_DAY_START_UTC` / `TALK_NIGHT_POSTS` | `12` / `2` | before this UTC hour, at most this many posts that day; milestones wait for it |
| `TALK_LESSON_HOUR_UTC` | `18` | the lesson goes from this UTC hour |
| `TALK_STACK_HOUR_UTC` | `15` | the Monday stack goes from this UTC hour |
| `TALK_DAILY_LINK` | off | `true`: the daily ends with mrbands.finance |

## The weekly review

1. Daily: `talk.ts reflect`. Proposals that pass the lint and the gate land in pending; the rest are printed with why.
2. After a bit is used and its engagement is in: `talk.ts use <bit-id> landed|flopped`. The gate proposes promotion
   or retirement; it never applies either.
3. Weekly, before review: `talk.ts drift`. Anything flagged is dealt with first.
4. `talk.ts proposals`, then for each: `talk.ts approve <id> --operator <handle>` or
   `talk.ts veto <id> --operator <handle> --reason "<why>"`. Each applied change raises the version; the decisions
   log records the operator, the time and the reason. A vetoed bit or opinion is remembered as retired by veto.
