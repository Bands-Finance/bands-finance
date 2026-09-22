# $BANDS: launching the token

Decided by Zach on Tue 22 Sep 2026 (docs/sprint.md, "The token"). This file is the launch runbook. Where it and
the token section of docs/clawrena.md disagree, this file is newer.

**The shape.** ClawPump, self-funded, the standard **SOL pair**, **no dev buy**, **`buybackBps` 0**, ticker
**`BANDS`** (Zach, 22 Sep, over `MRBANDS`), name "Mr Bands". Paid for by **Mr Bands' own new operating wallet**,
never the desk wallet and not a cold treasury: ClawPump's docs call the self-funded `walletAddress` "the Solana
base58 wallet that pays for the launch AND receives the agent's 75% creator-fee share", so the payer is the
creator-fee beneficiary for as long as the token trades. Zach decided on 22 Sep that Mr Bands pays his own way,
so that beneficiary is the wallet that pays his on-chain bills, by capped code; any excess is swept to a cold
wallet held for him. A launch happens once per agent, and the pair, the fee and the payout are fixed for good.

**Same ticker as the copycat.** A copycat "Mr Bands" $BANDS already trades on pump.fun with his portrait (mint
`JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m`, X `@MrBandsSol`). It is not his. Name and ticker are the same, so
the mint is the only way to tell them apart: his is the mint mrbands.finance lists once it launches, and the
token's on-chain description sends people there to check.

**What it is.** His own token: a key that opens the engine on your own wallet, not a share. It will pay nobody
who holds it: no buyback, no burn, no revenue share, no staking, no holder rewards, no airdrop. Its creator fees
will go to the wallet that paid for the launch, his own operating wallet, which pays for what he runs on, for as
long as it trades. The desk never holds, swaps or market-makes it.

**The plan, and this runbook as the fallback.** The launch is planned as his own act, armed by Zach
(docs/sprint.md, "The point: his autonomy"): Zach funds the operating wallet and sets one flag, and Mr Bands
chooses the moment and calls a desk tool that launches with this spec fixed in code, once, then announces it.
That tool is being built. The manual CLI below is the fallback, run by Zach, if it is not ready in time; the
spec, the payer check and the refusals are the same either way.

**Cost.** The sprint budgets 0.02 to 0.05 SOL; `npm run clawpump -- cost` prints today's creation fee. The
operating wallet needs about 0.05 SOL for the launch so the fee and a margin are covered (the launch refuses
unless the wallet holds the quote plus 0.005 SOL).

## What the code does for you

- `ops/live.env` holds the spec: `TOKEN_NAME="Mr Bands"`, `TOKEN_SYMBOL=BANDS`, `TOKEN_PUMP_PAIR=SOL`,
  `TOKEN_DEV_BUY_SOL=0`, no `TOKEN_CREATOR_FEE_BPS` (pump.fun sets none on the SOL pair, and `tokenSpec()`
  refuses one there). A test (`npm run test:clawpump`) reads that file and fails if any of it drifts.
- The launch body always sends `buybackBps: 0`. The developers page lists `buybackBps` on the self-funded
  endpoint with no description and no stated default, so it is set off in so many words. The page has no field
  for holder rewards or a creator-fee split, and `devBuyAmountUsd` (a post-launch buy) is never sent.
- The launch pays from `WALLET_SECRET_KEY`. For this command only, `TOKEN_PAYER_EXPECTED` replaces the desk's
  `EXPECTED_WALLET` check: the key must derive to that address, and the launch refuses outright if the payer is
  the desk wallet. The desk's own `EXPECTED_WALLET` check is untouched.
- H1 (`src/risk/house.ts`): once `TOKEN_MINT` is set, the guards refuse any band in a pool that holds it and any
  Jupiter leg with it in or out. The copycat's mint gets the same refusal.
- The talk lint treats `$bands` (the ticker, any case), `$mrbands` and `TOKEN_MINT` as the house token: the disclosure
  is required, and price, chart, cap, holders, volume, fee, value, a % or a $ may never sit next to it, nor buy,
  sell or early. The copycat's mint or `@mrbandssol` may only appear in a sentence that says it is not his.

## The steps, in order (Zach: steps 1 to 3 arm his own launch too; 4 to 6 are the manual fallback; 7 follows either launch)

Run from `/Users/zach/Bands.Finance/mr-bands`. Nothing below touches the desk wallet or the running services.

**1. Make his operating wallet (Wed 23 Sep).** A new keypair, his own, never the desk wallet. On this Mac,
outside the repo:

```sh
solana-keygen new --no-bip39-passphrase -o ~/mrbands-operating.json
chmod 600 ~/mrbands-operating.json
solana-keygen pubkey ~/mrbands-operating.json
```

The last line prints the operating wallet's address. Keep a copy of the key file offline (a USB stick, not a
cloud drive). It never goes in the repo, in chat or in a gateway agent. The creator fees arrive at the address
without the key; his payment code (being built) spends from it within its caps, and any excess is swept to a
cold wallet held for him.

**2. Seed it.** Send the one-time seed (about 0.05 SOL covers the launch) to the operating wallet's address from
your own wallet, not from the desk. Keep the seed's transaction signature: it is disclosed as his starting
money.

**3. `.env`.** Add two lines (the API key is the secret; the address is public):

```sh
CLAWPUMP_API_KEY=cpk_...            # from https://clawpump.tech/dashboard/api
TOKEN_PAYER_EXPECTED=<operating wallet address from step 1>
```

`CLAWPUMP_AGENT_ID` is already there. Leave `EXPECTED_WALLET` as it is: it pins the desk, and the launch does not
read it except to refuse the desk as payer.

**4. The pairs.**

```sh
npm run clawpump -- pairs
```

Prints the creator-fee range and the custom pairs on offer. Nothing to choose: we launch on SOL. It is a check
that the key works.

**5. The quote (Thu 24 Sep).** With the operating wallet's key loaded for this one command, still in dry run:

```sh
set -a; . ./ops/live.env; set +a
WALLET_SECRET_KEY="$(cat ~/mrbands-operating.json)" npm run clawpump -- quote
```

It prints:

```
Mr Bands (BANDS) by <agent name>, agent <agent id>, pair SOL, dev buy 0 SOL, buybackBps 0
  payer <operating wallet address>
  creator fees go to <operating wallet address> for good
  quote: <amount> SOL (<lamports> lamports) to <ClawPump's address>, valid 900 s; creation fee <fee> SOL
  nothing paid, nothing minted: `npm run clawpump -- launch --confirm` with DRY_RUN=false does it
```

Read it before going on. The payer must be the operating wallet's address from step 1. Any line starting with WARNING
(the desk wallet as payer, `TOKEN_PAYER_EXPECTED` unset or not matching, a dev buy above 0, a pair other than
SOL) means stop. The launch refuses every one of them in code as well, but fix the setting rather than lean on it.

**6. The launch (Fri 25 Sep), if he has not launched it himself.** The same, with `DRY_RUN=false` for this
command only and `--confirm`:

```sh
set -a; . ./ops/live.env; set +a
WALLET_SECRET_KEY="$(cat ~/mrbands-operating.json)" DRY_RUN=false npm run clawpump -- launch --confirm
```

It prints the quote block again, then:

```
  paid: <payment signature>
  launched: mint <mint> (launch tx <tx>)
  pump.fun: https://pump.fun/coin/<mint>
  creator fees go to <operating wallet address> for good

  record the mint in .env (the desk's H1 guard and the talk lint read it; the desk never trades it):
  TOKEN_MINT=<mint>
  PAIR_HOUSE_MINTS stays unset through 8 Oct by decision (docs/sprint.md): it would seat and market-make the token.
```

A refusal prints `launch refused: <why>` and pays nothing. If the payment went out but completion failed, run the
same command again: completion is idempotent on the payment signature.

**7. After.** Put `TOKEN_MINT=<mint>` in `.env` (not `ops/live.env`: that file is sourced first and dotenv never
overrides, so an empty line there would hide it). The desks and the talk layer read it at start, so until they
restart H1 does not know the mint: restart them the same day (the live desk stays halted either way). Set
`TOKEN_URL` in `ops/live.env` to the ClawPump token page, attach the token at clawpump.tech/ansemhack/entry if it did not attach itself by the X handle, and
post the entry from the project account. `npm run clawpump -- status` then shows the linked mint as `TOKEN_MINT`.

## What must NOT be done

- **No dev buy.** `TOKEN_DEV_BUY_SOL` stays 0, and nobody sends `devBuyAmountUsd`. Nobody, us included, starts
  with a bag. The launch refuses a dev buy above 0 and any pair but SOL (`launchRefusal`).
- **No launch from the desk wallet, and none from a cold treasury.** The payer keeps the creator fees for good,
  and they belong in his operating wallet. The launch refuses the desk address, but do not work around it.
- **No `PAIR_HOUSE_MINTS`.** It stays unset through 8 Oct. Set, it seats and market-makes the house token even
  with the pair lane off (src/index.ts). H1 would refuse the band, but the setting is the wrong intent.
- **No ClawPump MCP (or any ClawPump key) attached to the gateway agent.** The fallback is a human command with
  `--confirm` and `DRY_RUN=false`. His own launch, once built, is one desk tool with the spec fixed in code that
  runs once, only when Zach has armed it: no model path may reach ClawPump, the wallet's key or the spec.
- **No buying, selling or pooling the token from the desk** by hand either: that is what H1 enforces in code.
- **Not the copycat.** "Mr Bands" $BANDS at `JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m` (X `@MrBandsSol`) is
  not his. It shares the ticker, so never write that "any $BANDS on pump.fun" is not his (his will be one):
  name the copycat by its mint. His mint is the only one the site, the gate and Mr Bands name.

## How he talks about it

Every mention carries the disclosure (the lint enforces it; docs/sprint.md holds the current wording). Until it
launches, everything about it is in future tense. Once he has launched it, the line is: "my own token. i launched
it myself. the desk never holds or trades it. holding <mint> in a signed-in wallet opens the engine. not a share,
it pays nobody who holds it, and its trades pay a cut to my own wallet, which pays for what i run on." (If Zach
launches it by the fallback, "i launched it myself" is not true: that clause is replaced with one that is, and
the line passes the lint, at most 280 characters with the mint, before anything posts.) He names the mint, never a bare ticker, names
the copycat by its mint as not his, and never calls a price.
