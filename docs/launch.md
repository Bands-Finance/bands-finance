# Launching $BANDS: the runbook

Zach's decision of 22 Sep: Mr Bands launches his own token through ClawPump's MCP, himself, once Zach has armed
it. What the token is and what may never be done with it: docs/token.md. This file is the how, in order.

Run everything from `/Users/zach/Bands.Finance/mr-bands` once the `mcp-launch` branch is merged. Nothing here
touches the desk wallet.

## How it fits together

```
his gateway agent (mr-bands, an owner turn only)
  -> mcp__clawpump-launch__token_launch / token_launch_status
  -> the launch bridge, 127.0.0.1:3140 (src/launch/bridge.ts; bearer CLAWPUMP_BRIDGE_TOKEN)
  -> ClawPump's own stdio server, @clawpump/agents 0.1.27, spawned by the bridge
  -> get_launch_status, launch_metaplex_genesis_token (and nothing else of its 132 tools)
```

- **The bridge** serves two tools. `token_launch_status` is read-only. `token_launch` takes
  `{confirm: true, nonce}` and, in order: checks the arm file and its nonce; re-reads the launch status and
  refuses on a mint or on stored metadata that is off spec; renames the arm to `.used`; sends the one launch
  call with the spec fixed in code; answers within 45 s ("submitted, outcome pending" if ClawPump is still
  working, never "failed"); re-reads the status after any error, because the Genesis tool can report an error
  after the token launched; and writes one line per call to `~/.mrbands/launch-audit.jsonl`.
- **Its secrets** live in `~/.mrbands/clawpump.env` (mode 600): the ClawPump key and the bridge's bearer. The
  bridge refuses to start if the file is looser. The repo's `.env` is not used: every desk process and the
  platform server load that one.
- **The gateway** gets a server row whose header is the placeholder `Bearer ${{CLAWPUMP_BRIDGE_TOKEN}}`, filled
  from mr-bands' own encrypted secret. It is enabled for mr-bands only, and it is visible to owner turns only.
  Desk cycles and X mentions run with no role, so they never see it. The names sit outside `bands_*`, so the talk
  loop voids any mention turn that touches them anyway.
- **The arm** (`~/.mrbands/bands-launch.arm`) is the last gate. Anything holding the gateway's admin token can
  make an owner turn, but not the nonce.

## 1. Prerequisites (Zach, Wed 23 to Thu 24 Sep)

1. **Fix the stored launch metadata** on the ClawPump dashboard
   (https://agents.clawpump.tech/dashboard/launch-token). The MCP cannot send a name, a website or a telegram:
   ClawPump takes them from here, and the bridge refuses unless every field matches.
   - name `Mr Bands`
   - symbol `BANDS` (today: `MB`)
   - description exactly as in ops/live.env (today: his X bio):
     `Mr Bands is an autonomous AI market maker on Solana. He provides liquidity on Meteora and learns from every trade. His own token, not a share: it pays holders nothing.`
   - website empty, telegram empty
   - twitter: `https://x.com/MrBandsSol` (as stored) or empty
   - image: the picture you want on the token, uploaded to ClawPump, never a mrbands.finance URL. Check which
     picture the stored avatar is.
2. **Turn off the marketplace listing** on the ClawPump agent's settings: `accepting_bids` off, and `is_public`
   off. Today both are on. Leave the ClawPump agent **stopped**.
3. **Rotate the ClawPump key into its own file.** The old key was pasted into a chat. Make a new `cpk_` key on
   the dashboard, revoke the old one, then (zsh; the key is typed hidden and never lands in argv or history):

   ```sh
   ( umask 077; mkdir -p ~/.mrbands
     read -rs 'k?new cpk_ key (hidden): '; echo
     { echo "CLAWPUMP_API_KEY=$k"; echo "CLAWPUMP_BRIDGE_TOKEN=$(openssl rand -hex 32)"; } > ~/.mrbands/clawpump.env )
   chmod 700 ~/.mrbands; chmod 600 ~/.mrbands/clawpump.env
   ```

   Then delete the `CLAWPUMP_API_KEY=` line from the repo's `.env` by hand. Nothing in the launch reads it there.
   Optional lines in the same file: `LAUNCH_IMAGE_URL=` (an https image off the site's domain; the default is
   none, and ClawPump uses the stored image) and `LAUNCH_TWITTER=MrBandsSol` (the default is none, and the
   stored value stands).
4. **Install the pinned ClawPump server** from the lockfile, with no install scripts:

   ```sh
   mkdir -p ~/.mrbands/clawpump-agents
   cp ops/clawpump-agents/package.json ops/clawpump-agents/package-lock.json ~/.mrbands/clawpump-agents/
   (cd ~/.mrbands/clawpump-agents && npm ci --ignore-scripts --omit=dev)
   shasum -a 256 ~/.mrbands/clawpump-agents/node_modules/@clawpump/agents/dist/index.js
   # must print 375e2ba4bfe9c1c8a7e2b329277a571d210af650fa97ae5e9585aa9708e56fc4
   ```

   The bridge and the check refuse any other version or hash.
5. **Take the launch away from Claude Code.** The local `clawpump-agents` MCP registration gives every Claude
   Code session all 132 tools, both launch tools included. Remove it (`claude mcp remove clawpump-agents -s
   local`, from the directory where it was added), or deny at least `launch_token_gasless`,
   `launch_metaplex_genesis_token`, `chat_with_agent`, `create_agent_run`, `trigger_automation`,
   `create_automation`, `update_automation`, `update_agent`, `wallet_transfer`, `swap_execute` and
   `add_to_whitelist` in the project's permissions. "i launched it myself" has to be true.
6. **Fund the ClawPump agent's custodial wallet** `4HQdS1HqnumqLqJT81tdUtf969Xa6cTo9jc1mEadxYyE` from your own
   wallet, never the desk's. ClawPump quotes 0.00751 SOL for a self-funded launch and states no Genesis price,
   so send about 0.05 SOL. Its whitelist is empty: what is left there stays until an address is whitelisted on
   ClawPump.
7. **Check it all, read-only:**

   ```sh
   npm run launch:check
   ```

   It calls six read-only ClawPump tools, nothing else. Go on only when it says no token_mint, "the stored state
   matches the pinned spec", no automations, and the marketplace listing is off.
8. **Top up the OpenRouter credit** his model runs on (shared with the Meridian fleet), or the launch turn can
   fail for want of a model.

## 2. Provisioning the gateway (Thu 24 Sep, between desk cycles)

In one terminal, the bridge in dry-run mode (the default: it runs every check and never calls the launch):

```sh
npm run launch:bridge
```

In another:

```sh
npm run launch:gateway -- plan        # read-only: any conflicting policy row, and what provision would write
npm run launch:gateway -- provision   # needs OPENHERMIT_TOKEN in .env and the bridge up
npm run launch:gateway -- readback    # read-only, header names only
hermit mcp assignments                 # clawpump-launch for mr-bands only, never "*"
```

`provision` reads mr-bands' policies first and writes nothing if a wildcard row covers the launch tools or the
server. It then writes, all on mr-bands: the agent secret `CLAWPUMP_BRIDGE_TOKEN` (from `~/.mrbands/clawpump.env`,
never argv; passThrough off); a server-level allow for the owner on `clawpump-launch`; an exact owner allow on
each of the two tools; denies on `mcp_enable` and `mcp_disable` (his own `mcp_enable` would connect the row
without its secret); the server row at `http://127.0.0.1:3140/mcp` with the placeholder header; and the enable
with `{agentId: "mr-bands"}`. It reads everything back and fails loudly if the row reached every agent. The
enable reloads his MCP connections, bands-paper's included, which is why it goes between desk cycles.

With `--approval` it also writes a `require_approval` row for the owner on `token_launch`: then the launch waits
for you in `hermit chat` or `hermit config --agent mr-bands approvals review <id> approved --resolution once`.
Never `persistent`, and never grant it to `any`: a turn with no user skips the approval.

Never run `npm run openhermit -- status` for this: it reads the admin server rows, bearer values included.

## 3. The dry run (Thu 24 Sep)

With the bridge still in dry-run mode:

```sh
npm run launch:gateway -- schedules         # what runs on mr-bands
npm run launch:gateway -- pause-schedules   # pauses every active one; the ids go to ~/.mrbands/paused-schedules.json
npm run launch:arm                          # 20 minutes, single use; prints the nonce once, inside the prompt
npm run launch:gateway -- schedule-launch   # a one-shot owner turn a minute out, the prompt read from the arm file
```

In his turn he reads `token_launch_status` and calls `token_launch`. The dry-run answer is "would call
launch_metaplex_genesis_token" with the arguments: agent `64fd21e8-1d52-4a95-9c19-4db0069cbb4b`, symbol `BANDS`,
the description, `first_buy_amount_sol` 0, and no image or twitter unless you set them. The arm is now used.

Also check:
- `tail ~/.mrbands/launch-audit.jsonl`: tool, time, outcome, no key.
- A wrong bearer is refused:
  `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Authorization: Bearer wrong' -H 'content-type: application/json' -d '{}' http://127.0.0.1:3140/mcp`
  prints 401.
- A desk cycle and an X mention run as before, and neither shows a `clawpump-launch` tool.

Then `npm run launch:gateway -- resume-schedules`.

## 4. Arming and the launch turn (Fri 25 Sep)

1. `npm run launch:check`: no mint, the spec matches, the wallet can pay.
2. `npm run launch:gateway -- pause-schedules`.
3. Stop the dry-run bridge (Ctrl-C) and start it live: `npm run launch:bridge -- --live`. The gateway's client
   is stateless against it, so no reload is needed; `npm run launch:gateway -- provision` again is harmless if
   his tools are missing.
4. `npm run launch:arm -- --minutes 20`.
5. `npm run launch:gateway -- schedule-launch`. The launch is now his call. The prompt tells him to read the
   status, call the launch once with the nonce, and post nothing from that turn.

The answers he can get:
- **launched, mint `<mint>`**: done.
- **submitted, outcome pending**: ClawPump is still working. He calls `token_launch_status` until it shows the
  mint. Do not re-arm.
- **error-no-mint**: the call failed and the status shows no mint. Look at the ClawPump dashboard before
  anything else. Re-arm only when both say nothing launched.
- **unknown**: the status could not be read. Treat it as pending.
- **refused**: nothing was sent. The message says why.

`hermit schedules runs <id> --agent mr-bands` shows the turn; the bridge's terminal and the audit show the call.

## 5. Verification

- `npm run launch:check` (or his `token_launch_status`) shows `token_mint`.
- On-chain and on the ClawPump token page: name Mr Bands, symbol BANDS, the description, no website, no site
  domain anywhere, the image you chose.
- Put `TOKEN_MINT=<mint>` in the repo's `.env` (not ops/live.env). Restart the desks and the talk layer the same
  day, so H1 refuses the mint and the lint treats it as the house token (docs/token.md).
- Attach the mint at clawpump.tech/ansemhack/entry if it did not attach itself, then post the entry.
- His announcement carries the disclosure (`disclosureLine`), which now says the cut goes to his agent on
  ClawPump, not to his own wallet.

## 6. Teardown (the same day)

```sh
# Ctrl-C the bridge
npm run launch:gateway -- teardown          # disable for mr-bands, delete the row, the secret, the launch rows
npm run launch:gateway -- resume-schedules
npm run launch:arm -- --disarm              # if an arm is still there
hermit mcp assignments                       # no clawpump-launch anywhere
```

The `mcp_enable` and `mcp_disable` denies stay. Revoke the `cpk_` key on the dashboard, or keep it only in
`~/.mrbands/clawpump.env` if the check will be used again. Keep `~/.mrbands/launch-audit.jsonl`.
