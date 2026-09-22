# Mr Bands on OpenHermit

Mr Bands the AGENT lives on OpenHermit. The desk stays the desk.

Where it stands today: his proposals on the paper desk still come from his own rulebook (the desk
policy; the paper desk's model share is 0%), and his model on the gateway takes over the proposing as
it is switched on (`DECIDER=openhermit` with `OPENHERMIT_TOKEN` in `.env`). Either way he proposes and
the guards decide. The live desk is halted and pins `DECIDER=policy`.

OpenHermit (`/Users/zach/OpenHermit`) is a gateway that hosts agents: an agent is a model loop with
instruction rows (`identity`, `soul`, `rules`), a model, secrets, MCP servers, skills, schedules and
channels, all kept in Postgres and run by one gateway process. The Meridian fleet agents
(`mrdn-fleet-*`) already live there with the Meridian MCP server registered by URL; their engine stayed
its own process. Mr Bands follows the same split.

## Which gateway

The gateway is canonical OpenHermit (HCF-STUDIOS/openhermit), not the old fork. Cut over 2026-09-21:
`com.openhermit.gateway` now runs from `/Users/zach/OpenHermit-next`, branch `ops/canonical-live`
(canonical `9b71c02` plus the one fork behaviour worth keeping, the UTC datetime line in the system
prompt). CLI 0.11.0, up from 0.5.2. The 13 forward migrations were rehearsed on a full copy first and
applied to the live database with no row lost: 48 agents, 11 schedules, 173 instruction rows, 26
agent_skills all intact, 23 migrations -> 36.

Two things to know before touching it:

- `/Users/zach/OpenHermit` (the fork) must stay on disk. It is the git object store the canonical
  worktree hangs off, and the home of 11 vendored skill directories.
- Canonical's first boot rewrote every `skills.path` into a `blob:` pointer (tarballs under
  `~/.openhermit/attachments/skills/*`), which is one way. Going BACK to the fork therefore needs the
  two Meridian skills' paths restored by hand, or 24 of the 26 `agent_skills` rows stop resolving:
  `~/OpenHermit-backups/oh-skill-paths-2026-09-21.csv` holds the originals. Backups from the cutover:
  `openhermit-precutover-20260921-0936.dump` and `com.openhermit.gateway.plist.fork-2026-09-21`.
- Health is `GET /health`, and the fleet is `GET /api/admin/agents/fleet`. `/api/health` and
  `/api/admin/agents` do NOT exist on canonical.

## What runs where

```
 desk process (launchd: paper on 3100, live on 3101)          OpenHermit gateway (127.0.0.1:4000)
 ┌──────────────────────────────────────────────┐             ┌──────────────────────────────────┐
 │ screener -> observation                      │  observation│ agent "mr-bands"                 │
 │ decide()  DECIDER=openhermit ────────────────┼────────────>│  instructions: identity/soul/rules│
 │           (src/agent/openhermit.ts)          │<────────────┼  model: openrouter/anthropic/...  │
 │ guards (src/risk) -> executor -> wallet      │ Decision    │  session desk:<mode>:<pool>       │
 │ journal, sites, MCP server at POST /mcp <────┼─────────────┼─ MCP client (bands-paper|bands-live)
 └──────────────────────────────────────────────┘ bearer:     └──────────────────────────────────┘
                                                  PLATFORM_HOUSE_TOKEN
```

- The desk builds the observation, asks, runs the answer through its guards, signs, journals. Nothing
  about that moved. "He proposes, the guards decide": the limits live in `src/risk`, never in a
  prompt, and `DRY_RUN` still defaults on.
- The agent holds the persona (the same text `buildSystemPrompt` in `src/agent/persona.ts` gives the
  Anthropic call today, split into the gateway's three rows) and the model. It answers each observation
  with one Decision JSON.
- The agent's hands are the desk's own MCP server (`bands_list_pools`, `bands_limits`,
  `bands_agent_thoughts`, `bands_pool_snapshot`, `bands_screen`, `bands_pool_score`). They read the
  book and the screen. Nothing on the gateway can move money, and nothing on it can approve a proposal.
- The gateway calls the desk's MCP server with the HOUSE bearer (`PLATFORM_HOUSE_TOKEN`), so the house's
  own agent is not charged at its own paywall and is served the house tool list: those six read tools
  and nothing else, not `bands_propose_band_action` and not `bands_decide_proposal`. The operator token
  (`PLATFORM_OPERATOR_TOKEN`) never leaves `.env`. Until 2026-09-21 the rows carried the operator token,
  which meant any session on the agent was served `bands_decide_proposal` and could approve proposals;
  a model must never hold that. A proposal is approved one of two ways: Zach calls
  `POST /api/proposals/decide` (or `bands_decide_proposal`) with the operator token directly, or the
  desk's own auto-approver, deterministic code with no model in it, approves it. Either way the
  approved proposal still runs through the guards before anything executes. The rails (`POST /mcp` and the
  engine, proposals, revenue and credits routes in `src/platform/railsRoutes.ts`) are mounted by
  `src/server.ts` since 2026-09-21; a desk process started before that serves no `/mcp` at all.
  Mounting them turns on MORE than `/mcp`: the same call adds `/api/engine/*`, `/api/proposals`,
  `/api/revenue` and `/api/credits` to a desk that served none of them before. They are the platform's
  own rails and carry their own auth, the desk listens on `127.0.0.1` only, and an outside proposal
  still reaches the book only through the guards; but it is a real widening of what the process answers.
  Because of it the desk now binds `127.0.0.1` rather than every interface (`SERVE_HOST`, default
  loopback): the gateway calls it on loopback, so nothing here needs more. Set `SERVE_HOST=0.0.0.0` to
  read the dashboard from another machine, knowing the rails go with it.

## Environment

All of these are read by the desk process (`decide()`) and by `npm run openhermit`. None is committed:
the tokens go in `.env` (git-ignored); the rest may sit in `ops/live.env` or a plist.

| Variable | Default | Meaning |
|---|---|---|
| `DECIDER` | unset | Who proposes. Unset (or an unknown word): today's behaviour (Anthropic when a key exists, else the desk policy). `anthropic`: Claude directly, as today. `openhermit`: `decide()` posts the observation to the agent on the gateway and parses the Decision out of the reply. `policy`: the desk policy proposes, no model is asked. Anything unusable from the agent (a timeout, a 5xx, prose, JSON that is not a Decision) falls back to the desk policy exactly as a bad Anthropic reply does today (`policyAfterModel`), with a note that says why. |
| `OPENHERMIT_GATEWAY_URL` | `http://127.0.0.1:4000` | The gateway. |
| `OPENHERMIT_AGENT_ID` | `mr-bands` | The agent's id on the gateway. |
| `OPENHERMIT_TOKEN` | (none, required) | The gateway's admin bearer: `GATEWAY_ADMIN_TOKEN` from `~/.openhermit/gateway/.env`. Zach copies it into `.env`; no code here reads the gateway's file. |
| `OPENHERMIT_TIMEOUT_MS` | `60000` | One deadline for the whole ask: opening the session and waiting for the answer (`?wait=true&timeout=`). Past it the desk policy proposes. It is per POOL and the pools are decided one after another, so this is the slowest a pool can make a cycle; raising it raises the whole cycle. Once one pool has missed the deadline (or the gateway was unreachable), the rest of that cycle goes straight to the policy without asking again, so a dead gateway costs one wait, not six. |
| `OPENHERMIT_PROVIDER` | `openrouter` | Who serves the model (`provision` only; `--provider` overrides). `openrouter`: the gateway's shared `OPENROUTER_API_KEY`. `anthropic`: Anthropic directly on an `ANTHROPIC_API_KEY` the owner has given the agent (`hermit config secrets set ANTHROPIC_API_KEY <key> --agent mr-bands`); `provision` checks the secret is there by name and refuses otherwise. It never writes a key. |
| `OPENHERMIT_MODEL` | (none) | A model id to pin (`provision` only). Unset: on OpenRouter the newest Anthropic Claude of the desk's `MODEL` family that OpenRouter offers; at Anthropic the desk's `MODEL` itself. |
| `PLATFORM_HOUSE_TOKEN` | (none, required by `provision`) | The desk's house bearer (`src/platform/mcp/server.ts`). `provision` writes it into the gateway's MCP server rows as the `Authorization` header. The desk serves it the six read tools free of the paywall. It must differ from `PLATFORM_OPERATOR_TOKEN`: the desk does not treat an equal one as the house (it logs so once), and `provision` refuses it. Generate it with `openssl rand -hex 32`. |
| `PLATFORM_OPERATOR_TOKEN` | (none) | The approval key (the desk's operator bearer, by its env name): decides proposals, settles stranded payments. Zach's alone; it stays in `.env` and `provision` never sends it anywhere. `status` reads it only to warn when a gateway row still holds it. |
| `DATA_DIR` | `data-live` (for `ask`) | Where `ask` reads the newest journal entry from. |

The model key: the agent runtime resolves a provider's key from the agent's own secrets first and from
the gateway's environment second (`apps/agent/src/agent-runner.ts`, `resolveApiKey`). The gateway's
`.env` holds an `OPENROUTER_API_KEY` shared by every agent on it, so on OpenRouter the agent needs no
secret of his own, but that key's credit is shared too (on 2026-09-21 it was empty: OpenRouter answered
"can only afford 124 tokens", and the desk policy would have proposed every cycle). Two ways out, both
Zach's: add credit at openrouter.ai/settings/credits, or `--provider anthropic` after giving the
agent the desk's own key, the one `DECIDER=anthropic` already spends on the same decisions:
`hermit config secrets set ANTHROPIC_API_KEY sk-ant-... --agent mr-bands` (encrypted at rest by the
gateway, returned masked by its API). An agent secret of either name also wins over the shared key.

## Provisioning

```bash
# once, in .env (never committed):
#   OPENHERMIT_TOKEN=<GATEWAY_ADMIN_TOKEN from ~/.openhermit/gateway/.env>
#   PLATFORM_HOUSE_TOKEN=<openssl rand -hex 32; the same one the desk runs with, NOT the operator token>

npm run openhermit -- provision                       # the paper desk's MCP server enabled
npm run openhermit -- provision --mcp live            # the live desk's
npm run openhermit -- provision --model anthropic/claude-sonnet-5
npm run openhermit -- provision --provider anthropic    # the agent's own ANTHROPIC_API_KEY and the desk's MODEL
npm run openhermit -- status
npm run openhermit -- ask                             # one observation from DATA_DIR's newest journal entry
```

`provision` is idempotent: run it again after a persona change, a limit change, a token rotation or a
model change and it writes only what differs. It refuses to start, before it touches the gateway, when
`PLATFORM_HOUSE_TOKEN` is unset or is the operator token. It does, in order:

1. **The agent.** `mr-bands` ("Mr Bands") exists, created without a sandbox (his hands are MCP; a docker
   container he never uses would only cost). The OS user running the script is made its owner through
   the gateway's `cli` identity, the way `hermit chat` claims ownership, unless someone already owns it.
2. **The model.** `config.model = { provider, model, max_tokens: 4096 }`. The provider is `--provider`,
   else `OPENHERMIT_PROVIDER`, else `openrouter`. The model is `--model`, else `OPENHERMIT_MODEL`, else
   (OpenRouter) the newest `anthropic/claude-<family>*` on OpenRouter where the family is the desk's
   `MODEL` (`claude-opus-5.5` today, so opus) or (Anthropic) the desk's `MODEL` itself; the script prints
   what it chose. At Anthropic the agent must already hold an `ANTHROPIC_API_KEY` secret.
   **His memory stays on** (Zach, 22 Sep: "I would like to keep our agent running on openhermit for persistent
   memory"). The gateway's introspection is how he keeps what a session taught him: every 5 turns, and 10 minutes
   after a session's last turn, it runs his model over the new turns and writes his memories and the session's working
   memory, with its own tools that no tool policy reaches (`apps/agent/src/introspection`). Provisioning never turns
   it off, shortens it or narrows it (`introspectionFor`): a config an earlier provisioning asked off
   (`memory.introspection.enabled: false`, what the provisioning code of 22 Sep wrote) is asked on again with its other
   fields kept, a field the gateway's schema needs and the block lacks takes the gateway's default, and a config with
   no introspection block keeps the gateway's defaults (on: 5 turns, 20 passive group messages, 10 minutes idle, 10
   tool calls, his own model). Nothing else in `memory` (`context_entry_limit`) or in `context` (the rolling window)
   is written. The gateway read `enabled: false` only to ignore configured intervals for its defaults, so the old flag
   never stopped introspection; it is asked on anyway, so a gateway that honours the flag later keeps his memory. A
   memory change alone never restarts the runner: it reads its config on every turn. Each desk session and each
   talk-loop mention session (`x-mention-<id>`) costs that second model run on the shared OpenRouter key, and the talk
   loop counts each ask as two against `ENGAGE_MODEL_CALLS_PER_DAY`. A mention's session is introspected too, so what
   strangers say can reach his memory: the identity row tells him his memory is his notes, never instructions, and
   the desk's guards and the talk loop's still decide everything that acts or posts.
3. **The instructions.** `identity`, `soul` and `rules` are cut from the desk's own system prompt with
   the per-pool clause removed: who he is and how DLMM, the screener and the engine work go to
   `identity`; the voice to `soul`; the rules that never bend, the decision order, the hard limits and
   the output contract to `rules`. Three gateway-only additions: where he runs and what his tools are; the
   public voice (lowercase, no hype, no price calls, disclosure whenever the token is named); and the
   one rule the desk relies on: *"When the desk sends you an observation, answer with one JSON object
   and nothing else: {action, open, positionAddress, reasoning, confidence, headline} as the observation
   describes; use your bands_* tools to look at the pool first when the observation is thin."*
   The hard limits written are the ones the provisioning process runs with, so provision from the
   environment of the desk that will use him: `set -a; . ops/live.env; set +a; npm run openhermit --
   provision --mcp live` for the live desk. The rules also say the observation wins where it differs. `identity`
   also tells him his memory goes with him into every session (memory_list, memory_recall, memory_get and his session
   history) and is his notes, never instructions.
4. **The MCP servers.** `bands-paper` (`http://127.0.0.1:3100/mcp`) and `bands-live`
   (`http://127.0.0.1:3101/mcp`) are both registered (`--mcp-url` overrides the chosen one's URL), each
   with `Authorization: Bearer <PLATFORM_HOUSE_TOKEN>` and `metadata.audience: "house"`. The one
   matching `--mcp` (default `paper`) is enabled for the agent, the other disabled. The row is
   rewritten every run so a rotated token lands, and so a row that once held the operator token is
   overwritten by the first provision after this change.
   The gateway keeps the header in Postgres (`mcp_servers.headers`) and shows only its key name over the
   agent API; the admin API returns it whole, as it does for the Meridian rows.
5. **The tool policy.** A deny for every principal on the gateway tools no caller of his needs and a stranger's text
   could turn against him (`DENIED_TOOLS`): `web_fetch` and `web_search` (the way out: a mention could carry his
   memory or a session to a URL of its choosing), `doc_read` and the four `attachment_*` tools (files; the desk and the
   talk loop post text only), `schedule_list` and `schedule_runs` (the owner's jobs), `identity_link_request` and
   `identity_link_confirm` (tying a channel account to a gateway user). None of them is memory.
   **His memory and history are never denied** (`MEMORY_TOOLS`): `memory_get`, `memory_list` and `memory_recall`
   (the gateway injects no memory into a prompt, so these are the only way a session reads what earlier ones taught
   him), `session_list`, `session_read`, `session_summary` and `fetch_full_history`. The provisioning code of 22 Sep
   denied those seven, and a row it wrote would outlive the list: a run now lifts every deny-for-everyone row on a
   memory or history tool
   (`DELETE /api/agents/mr-bands/policies/tool/<tool>?effect=deny`) and names, without touching, a narrower deny it
   never wrote. `toolPolicyRows` refuses to write a deny on any `memory_*`, `working_memory_*` or history tool,
   whatever the list says. The memory writes (`memory_add`, `memory_update`, `memory_delete`) keep the gateway's own
   grants (owner and user): a desk or talk-loop turn carries no user, so he writes no memory inside a turn himself;
   introspection writes it for him. The talk loop lets a reply turn read his memory and its own conversation
   (`fetch_full_history`) and voids one that read another session (`src/talk/replyBrain.ts`): under the admin bearer a
   turn with no user is served any session on the agent, his architect's chats included.
6. **The runner.** The agent is started, or restarted when its model or instructions changed so the
   new rows are read (`runnerAction`). The tool policy and his memory alone never restart it: the runner reads its
   policy rows and its config on every turn, and a restart stops a desk turn in flight and drops its MCP connections.

`status` prints the gateway health, the agent row (enabled, runner running or stopped), the model, his memory
(introspection on, or asked off, and any deny left on a memory or history tool), the first line of each instruction
row, and the MCP servers enabled for him with whether an auth header is
set and which audience it buys at the desk: `house` when the header is this environment's
`PLATFORM_HOUSE_TOKEN`, `OPERATOR` (loudly, with "run provision again") when it is the operator token,
`public` with no header. The value is read from the admin API and compared in-process, never printed;
with neither token in the environment the row's `metadata.audience` is shown and marked unchecked. The gateway does not serve MCP connection state over HTTP (it is an agent tool, `mcp_status`), so
for that: `hermit chat --agent mr-bands` and ask him to run it.

`ask` reads the newest entry of `DATA_DIR/decisions.jsonl`, renders it as a thin observation (the pool,
the wallet, the bands, the screen, the engine directive, the last headline) plus the answer rule, posts
it through the desk's own client (`askSession` in `src/agent/openhermit.ts`: the same open, post,
deadline and parse `decide()` uses) into the session `api:mr-bands-ask`, and prints the raw reply, every
tool call he made, and whether the reply parses as a Decision. It exits 1 when it does not.

The desk itself talks to him in one session per desk mode and pool, `desk:<mode>:<pool address>`
(`dry-run` for the paper desk, `live` for the live one), so he sees what he said about a pool last cycle
and the two desks never read each other's history. Each message is `formatObservation(observation)`, the
text the Anthropic backend sees, plus two lines: answer with only one JSON object (the Decision fields
spelled out) and the pool's label. Sessions are opened once per desk process; a 404 on a post (the
gateway restarted) opens the session again and posts once more.

## Switching a desk to the agent

The paper desk (`ops/com.bands.mrbands.paper.plist`, `SERVE_PORT` 3100) and the live desk
(`ops/com.bands.mrbands.live.plist` + `ops/live.env`, 3101) each carry the lines commented out. To switch
one on:

1. `.env` holds `OPENHERMIT_TOKEN` and `PLATFORM_HOUSE_TOKEN` (the desk reads `.env` itself; launchd
   does not need them). The desk must have been restarted since the house token was added, or it
   serves the gateway's bearer as a stranger: the public list, and a 402 on every priced tool.
2. `npm run openhermit -- provision --mcp paper` (or `--mcp live` from `ops/live.env`'s environment).
3. `npm run openhermit -- ask` answers with a Decision.
4. Uncomment in the paper plist's `EnvironmentVariables`. For the live desk, change `DECIDER=policy` at the top of
   `ops/live.env` to `DECIDER=openhermit` and uncomment the other three there: the service sources that file after
   launchd sets its environment, so a `DECIDER` in the live plist would lose to it.
   ```xml
   <key>DECIDER</key><string>openhermit</string>
   <key>OPENHERMIT_GATEWAY_URL</key><string>http://127.0.0.1:4000</string>
   <key>OPENHERMIT_AGENT_ID</key><string>mr-bands</string>
   <key>OPENHERMIT_TIMEOUT_MS</key><string>60000</string>
   ```
5. Restart the service:
   ```bash
   launchctl bootout gui/$(id -u)/com.bands.mrbands.paper
   cp ops/com.bands.mrbands.paper.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bands.mrbands.paper.plist
   tail -f data-live/mrbands.log        # data-mainnet/mrbands.log for the live desk
   ```
   The journal's `llm.source` reads `llm` with model `openhermit:mr-bands` when he answered (the gateway
   names no model in its reply) and `policy` with a note naming the gateway when he did not.

The live desk keeps `POLICY_LIVE=true` in `ops/live.env`: without it a live book whose model does not
answer holds instead of trading on the policy (`policyMayTradeLive`). That rule is unchanged.

### The stamp, and why an answer can be thrown away

The gateway's wait mode subscribes to the SESSION and returns the first turn that ends in it, whoever
asked for it, while a message posted during a running turn queues behind that turn
(`apps/gateway/src/app.ts`, `apps/agent/src/agent-runner.ts`). So if the desk stops waiting at
`OPENHERMIT_TIMEOUT_MS` and the agent answers a moment later, the NEXT ask in that pool's session can be
handed the previous observation's answer: a decision priced on numbers that have moved, possibly naming
a position that has since closed.

So every prompt says which cycle it is and asks for that number back in a `cycle` field, and
`extractDecision` throws away anything else:

- a reply stamped with another cycle is a late turn. The desk takes the policy for that pool and walks
  away from the session: the next ask opens `desk:<mode>:<pool>-r1` (then `-r2`...), so it is never
  queued behind the turn that is running late. The pool's history on the gateway is the price of that.
- a reply with no stamp at all is a model that did not follow its rules. The policy proposes, with a
  note that says so. If this shows up every cycle in the journal, the model is too weak for the job
  (the `cycle` rule is in his `rules` row, written by `provision`) - pick another with
  `OPENHERMIT_MODEL` rather than turning the check off.

Both read the same way in the journal: `source: "policy"` with a note beginning `OpenHermit reply was
not a decision`.

## Switching back

`DECIDER=policy` in the same place (or remove the `DECIDER` line to return to today's default), then the
same bootout and bootstrap. The agent keeps running on the gateway with nothing to answer; nothing on
the gateway needs to change. `hermit agents disable mr-bands` parks him if wanted.

## What is NOT on OpenHermit, and why

- **The signing loop.** The wallet key, the guards, the executor, the engine's exits (stops, flatten,
  expire), the fast watch, the journal and the sites are the desk process and stay there. The agent has
  no wallet and no tool that moves money: his MCP tools read. A gateway that hosts many agents, a model
  that can be talked to from a chat window, and a sandbox are not where a hot wallet belongs.
- **The doctrine.** "He proposes, the guards decide." The limits are code in `src/risk`, enforced
  before any transaction is built, and no instruction row can change them. What the agent answers is a
  proposal, taken the same way an Anthropic reply is today: the entry rules (`adviseWithPolicy`) and the
  guards still have the last word, and an unusable answer means the desk policy proposes.
- **The paywall.** The desk's MCP server charges `bands_pool_snapshot`, `bands_screen` and
  `bands_pool_score` over x402. The gateway sends the house bearer with every call; the desk's `/mcp`
  route lets the house bearer (and the approval key) past the paywall so the house's agent does not pay
  the house. The house bearer buys nothing else: the read tools, no proposing, no deciding.
  Anyone else's agent on the same gateway pays as before - once `X402_TREASURY` (and `X402_VERIFY`) are
  set. Without them the gate is a stub that charges nobody, so on the paper desk today the bearer buys
  nothing that was not already free. It matters on the live desk, where the treasury is set.

## Next

- **A Telegram channel.** OpenHermit's built-in Telegram adapter is a channel row on the agent; it needs
  a bot token from Zach (`hermit` or the admin UI at `/admin/`). Then Mr Bands answers strap checks
  in a chat with the same rules.
- **The X voice as a schedule.** `src/talk` composes his posts from the journal today. A gateway
  schedule (`hermit schedules create`) can post a prompt into a session on a cron and let him write the
  line with his tools in front of him; the posting itself stays behind `src/talk`'s rate limits and the
  X keys Zach holds for his account.
- **The trading loop itself does not move.** See above.
