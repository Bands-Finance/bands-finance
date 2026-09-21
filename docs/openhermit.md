# Mr Bands on OpenHermit

Mr Bands the AGENT lives on OpenHermit. The desk stays the desk.

OpenHermit (`/Users/zach/OpenHermit`) is a gateway that hosts agents: an agent is a model loop with
instruction rows (`identity`, `soul`, `rules`), a model, secrets, MCP servers, skills, schedules and
channels, all kept in Postgres and run by one gateway process. The Meridian fleet agents
(`mrdn-fleet-*`) already live there with the Meridian MCP server registered by URL; their engine stayed
its own process. Mr Bands follows the same split.

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
                                                  PLATFORM_OPERATOR_TOKEN
```

- The desk builds the observation, asks, runs the answer through its guards, signs, journals. Nothing
  about that moved. "The LLM proposes, the guards decide": the limits live in `src/risk`, never in a
  prompt, and `DRY_RUN` still defaults on.
- The agent holds the persona (the same text `buildSystemPrompt` in `src/agent/persona.ts` gives the
  Anthropic call today, split into the gateway's three rows) and the model. It answers each observation
  with one Decision JSON.
- The agent's hands are the desk's own MCP server (`bands_list_pools`, `bands_limits`,
  `bands_agent_thoughts`, `bands_pool_snapshot`, `bands_screen`, `bands_pool_score`). They read the
  book and the screen. Nothing on the gateway can move money.
- The gateway calls the desk's MCP server with the operator bearer, so the operator's own agent is not
  charged at his own paywall and is served the operator tool list.

## Environment

All of these are read by the desk process (`decide()`) and by `npm run openhermit`. None is committed:
the tokens go in `.env` (git-ignored); the rest may sit in `ops/live.env` or a plist.

| Variable | Default | Meaning |
|---|---|---|
| `DECIDER` | unset | Who proposes. Unset (or an unknown word): today's behaviour (Anthropic when a key exists, else the desk policy). `anthropic`: Claude directly, as today. `openhermit`: `decide()` posts the observation to the agent on the gateway and parses the Decision out of the reply. `policy`: the desk policy proposes, no model is asked. Anything unusable from the agent (a timeout, a 5xx, prose, JSON that is not a Decision) falls back to the desk policy exactly as a bad Anthropic reply does today (`policyAfterModel`), with a note that says why. |
| `OPENHERMIT_GATEWAY_URL` | `http://127.0.0.1:4000` | The gateway. |
| `OPENHERMIT_AGENT_ID` | `mr-bands` | The agent's id on the gateway. |
| `OPENHERMIT_TOKEN` | (none, required) | The gateway's admin bearer: `GATEWAY_ADMIN_TOKEN` from `~/.openhermit/gateway/.env`. The operator copies it into `.env`; no code here reads the gateway's file. |
| `OPENHERMIT_TIMEOUT_MS` | `120000` | One deadline for the whole ask: opening the session and waiting for the answer (`?wait=true&timeout=`). Past it the desk policy proposes. |
| `OPENHERMIT_MODEL` | (none) | An OpenRouter model id to pin, e.g. `anthropic/claude-opus-5`. Unset: `provision` picks the newest Anthropic Claude of the desk's `MODEL` family that OpenRouter offers. |
| `PLATFORM_OPERATOR_TOKEN` | (none, required by `provision`) | The desk's operator bearer (`src/platform`). `provision` writes it into the gateway's MCP server rows as the `Authorization` header. |
| `DATA_DIR` | `data-live` (for `ask`) | Where `ask` reads the newest journal entry from. |

The model key: the agent runtime resolves `OPENROUTER_API_KEY` from the agent's own secrets first and
from the gateway's environment second (`apps/agent/src/agent-runner.ts`, `resolveApiKey`). The gateway's
`.env` already holds one, so the agent needs no secret of its own. To give him one:
`hermit config secrets set OPENROUTER_API_KEY sk-or-... --agent mr-bands`.

## Provisioning

```bash
# once, in .env (never committed):
#   OPENHERMIT_TOKEN=<GATEWAY_ADMIN_TOKEN from ~/.openhermit/gateway/.env>
#   PLATFORM_OPERATOR_TOKEN=<a long random string; the same one the desk runs with>

npm run openhermit -- provision                       # the paper desk's MCP server enabled
npm run openhermit -- provision --mcp live            # the live desk's
npm run openhermit -- provision --model anthropic/claude-sonnet-5
npm run openhermit -- status
npm run openhermit -- ask                             # one observation from DATA_DIR's newest journal entry
```

`provision` is idempotent: run it again after a persona change, a limit change, a token rotation or a
model change and it writes only what differs. It does, in order:

1. **The agent.** `mr-bands` ("Mr Bands") exists, created without a sandbox (his hands are MCP; a docker
   container he never uses would only cost). The OS user running the script is made its owner through
   the gateway's `cli` identity, the way `hermit chat` claims ownership, unless someone already owns it.
2. **The model.** `config.model = { provider: "openrouter", model, max_tokens: 4096 }`. The model is
   `--model`, else `OPENHERMIT_MODEL`, else the newest `anthropic/claude-<family>*` on OpenRouter where
   the family is the desk's `MODEL` (`claude-opus-5` today, so opus); the script prints what it chose.
   Memory introspection is turned off: one decision a cycle is not a conversation, and the introspection
   would run a second model every few turns to write memories nobody reads.
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
   provision --mcp live` for the live desk. The rules also say the observation wins where it differs.
4. **The MCP servers.** `bands-paper` (`http://127.0.0.1:3100/mcp`) and `bands-live`
   (`http://127.0.0.1:3101/mcp`) are both registered (`--mcp-url` overrides the chosen one's URL), each
   with `Authorization: Bearer <PLATFORM_OPERATOR_TOKEN>`. The one matching `--mcp` (default `paper`) is
   enabled for the agent, the other disabled. The row is rewritten every run so a rotated token lands.
   The gateway keeps the header in Postgres (`mcp_servers.headers`) and shows only its key name over the
   agent API; the admin API returns it whole, as it does for the Meridian rows.
5. **The runner.** The agent is started, or restarted when its config or instructions changed so the
   new rows are read.

`status` prints the gateway health, the agent row (enabled, runner running or stopped), the model, the
first line of each instruction row, and the MCP servers enabled for him with whether an auth header is
set. The gateway does not serve MCP connection state over HTTP (it is an agent tool, `mcp_status`), so
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

1. `.env` holds `OPENHERMIT_TOKEN` and `PLATFORM_OPERATOR_TOKEN` (the desk reads `.env` itself; launchd
   does not need them).
2. `npm run openhermit -- provision --mcp paper` (or `--mcp live` from `ops/live.env`'s environment).
3. `npm run openhermit -- ask` answers with a Decision.
4. Uncomment in the plist's `EnvironmentVariables` (or in `ops/live.env` for the live desk):
   ```xml
   <key>DECIDER</key><string>openhermit</string>
   <key>OPENHERMIT_GATEWAY_URL</key><string>http://127.0.0.1:4000</string>
   <key>OPENHERMIT_AGENT_ID</key><string>mr-bands</string>
   <key>OPENHERMIT_TIMEOUT_MS</key><string>120000</string>
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

## Switching back

`DECIDER=policy` in the same place (or remove the `DECIDER` line to return to today's default), then the
same bootout and bootstrap. The agent keeps running on the gateway with nothing to answer; nothing on
the gateway needs to change. `hermit agents disable mr-bands` parks him if wanted.

## What is NOT on OpenHermit, and why

- **The signing loop.** The wallet key, the guards, the executor, the engine's exits (stops, flatten,
  expire), the fast watch, the journal and the sites are the desk process and stay there. The agent has
  no wallet and no tool that moves money: his MCP tools read. A gateway that hosts many agents, a model
  that can be talked to from a chat window, and a sandbox are not where a hot wallet belongs.
- **The doctrine.** "The LLM proposes, the guards decide." The limits are code in `src/risk`, enforced
  before any transaction is built, and no instruction row can change them. What the agent answers is a
  proposal, taken the same way an Anthropic reply is today: the entry rules (`adviseWithPolicy`) and the
  guards still have the last word, and an unusable answer means the desk policy proposes.
- **The paywall.** The desk's MCP server charges `bands_pool_snapshot`, `bands_screen` and
  `bands_pool_score` over x402. The gateway sends the operator bearer with every call; the desk's `/mcp`
  route lets the operator bearer past the paywall so the operator's agent does not pay the operator.
  Anyone else's agent on the same gateway pays as before.

## Next

- **A Telegram channel.** OpenHermit's built-in Telegram adapter is a channel row on the agent; it needs
  a bot token from the owner (`hermit` or the admin UI at `/admin/`). Then Mr Bands answers strap checks
  in a chat with the same rules.
- **The X voice as a schedule.** `src/talk` composes his posts from the journal today. A gateway
  schedule (`hermit schedules create`) can post a prompt into a session on a cron and let him write the
  line with his tools in front of him; the posting itself stays behind `src/talk`'s rate limits and the
  operator's keys.
- **The trading loop itself does not move.** See above.
