# $BANDS: the token

Decided by Zach on Tue 22 Sep 2026 (docs/sprint.md, "The token"). This file says what the token is and what may
never be done with it. **The launch runbook is docs/launch.md.** Where this file and the token section of
docs/clawrena.md disagree, this file is newer.

**The shape (22 Sep, second decision of the day).** Launched through **ClawPump's MCP**, not the self-funded
partner API: `launch_metaplex_genesis_token` from `@clawpump/agents` 0.1.27, a **Metaplex Genesis** launch, for
his ClawPump agent `64fd21e8-1d52-4a95-9c19-4db0069cbb4b`. Name "Mr Bands", ticker **`BANDS`** (over `MRBANDS`),
the description `TOKEN_DESCRIPTION` in ops/live.env, **first buy 0**, no website and nothing that links the token
to mrbands.finance or bands.finance, the image URL included. A launch happens once per agent and is irreversible.

**Accepted knowingly.** The MCP cannot express three things the earlier plan pinned, and Zach took them as they
come:
- **The payer and the fees.** The launch is paid from that ClawPump agent's **custodial wallet**
  `4HQdS1HqnumqLqJT81tdUtf969Xa6cTo9jc1mEadxYyE`, whose keys ClawPump keeps. ClawPump's docs: "ClawPump
  retains creator-wallet custody" and "Your agent earns 75% of future creator fees". So **75% of the creator fees
  sit in ClawPump's custody for his ClawPump agent**. They do not reach his operating wallet on their own: that
  needs a whitelist entry and a transfer on ClawPump, which are write tools and are not built.
- **The pair and any buyback** are ClawPump's defaults. No MCP tool has a field for them.
- **Genesis, not a plain pump.fun launch.** The MCP's gasless tool refuses while the platform reports
  `gasless_available` false (it does today), so the Genesis tool is the one that launches. Whether a Genesis
  launch counts for the ClawPump x pump.fun track is an open question (docs/sprint.md).

**Same ticker as the copycat.** A copycat "Mr Bands" $BANDS already trades on pump.fun with his portrait (mint
`JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m`); its metadata even links his own X account, @MrBandsSol, and his
site. It is not his. Name and ticker are the same, so the mint is the only way to tell them apart. The token is
off the site for now (docs/sprint.md, decision 8), so his is the mint he posts from @MrBandsSol.

**What it is (the design, not yet the state).** His own token: a key that will open the engine on your own
wallet once the hold gate ships (planned Sun 27 Sep; today engine access is an allowlist or open to all), not a
share. It will pay nobody who holds it: no buyback of ours, no burn, no revenue share, no staking, no holder
rewards, no airdrop. The desk never holds, swaps or market-makes it.

**He launches it himself.** His gateway agent calls `token_launch` on a loopback bridge
(`src/launch/bridge.ts`). The bridge pins the spec in code, spawns ClawPump's server itself, and can reach two of
its 132 tools: `get_launch_status` and that one launch. Zach arms it with a single-use nonce, and the tool is
never offered to a desk cycle or an X mention. docs/launch.md has every step.

## What the code does for you

- `src/launch/spec.ts` holds the spec the bridge sends (agent id, `BANDS`, `TOKEN_DESCRIPTION` byte for byte,
  first buy 0) and refuses to launch unless ClawPump's stored launch metadata matches it exactly: name, symbol,
  description, website and telegram empty, no site domain anywhere, the image included. `npm run
  test:token-bridge` fails if the description drifts from ops/live.env.
- H1 (`src/risk/house.ts`): once `TOKEN_MINT` is set, the guards refuse any band in a pool that holds it and any
  Jupiter leg with it in or out. The copycat's mint gets the same refusal.
- The talk lint treats `$bands` (the ticker, any case), `$mrbands` and `TOKEN_MINT` as the house token: the
  disclosure is required, and price, chart, cap, holders, volume, fee, value, a % or a $ may never sit next to it,
  nor buy, sell or early. The copycat's mint may only appear in a sentence that says it is not his.
  `@mrbandssol` is his own handle and is never treated as the copycat's.
- The self-funded CLI (`npm run clawpump`, src/tools/clawpump.ts) is the superseded path. It stays in the code
  and its tests, but it is not run for this launch: one token per agent, and his is the MCP launch.

## What must NOT be done

- **No first buy.** The bridge sends `first_buy_amount_sol: 0`. Nobody, us included, starts with a bag.
- **No other ClawPump tool on the gateway.** ClawPump's stock MCP server (all 132 tools, `wallet_transfer` and
  `swap_execute` included) is never registered on the gateway, and its HTTP server is never run. The gateway gets
  the bridge only, for the launch window only, for mr-bands only, and the ClawPump key never leaves
  `~/.mrbands/clawpump.env` and the bridge's child process.
- **No launch from Claude Code.** The local `clawpump-agents` MCP registration exposes the launch tools to every
  Claude Code session; it is denied or removed (docs/launch.md, prerequisites). "i launched it myself" must be
  true.
- **No site in the token.** No website on the ClawPump dashboard, no image on mrbands.finance, no domain in the
  description. The bridge refuses any of them.
- **No `PAIR_HOUSE_MINTS`.** It stays unset through 8 Oct. Set, it seats and market-makes the house token even
  with the pair lane off (src/index.ts). H1 would refuse the band, but the setting is the wrong intent.
- **No buying, selling or pooling the token from the desk** by hand either: that is what H1 enforces in code.
- **Not the copycat.** "Mr Bands" $BANDS at `JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m` is not his, though
  its metadata borrows his own X account and site. It shares the ticker, so never write that "any $BANDS on
  pump.fun" is not his: name the copycat by its mint.

## How he talks about it

Every mention carries the disclosure (the lint enforces it). Until it launches, everything about it is in future
tense. Once he has launched it, the line is `disclosureLine(mint)` in src/talk/lint.ts: "my own token. i launched
it myself. the desk holds none and never trades it. holding <mint> in a signed-in wallet opens the engine. not a
share, it pays nobody who holds it. its trades pay a cut to my agent on clawpump, which keeps the keys." (Until 22
Sep it ended "to my own wallet, which pays for what i run on", which the MCP launch made untrue.) It does not post
until the hold gate is live, because it says holding the mint opens the engine (docs/sprint.md, "How he talks
about it"). He names the mint, never a bare ticker, names the copycat by its mint as not his, and never calls a
price.
