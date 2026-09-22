# $MRBANDS: launching the token

Decided by Zach on Tue 22 Sep 2026 (docs/sprint.md, "The token"). This file is the launch runbook. Where it and
the token section of docs/clawrena.md disagree, this file is newer.

**The shape.** ClawPump, self-funded, the standard **SOL pair**, **no dev buy**, **`buybackBps` 0**, ticker
**`MRBANDS`**, name "Mr Bands". Paid for by a **new cold treasury keypair**, never the desk wallet: ClawPump's
docs call the self-funded `walletAddress` "the Solana base58 wallet that pays for the launch AND receives the
agent's 75% creator-fee share", so the payer is the creator-fee beneficiary for as long as the token trades. A
launch happens once per agent, and the pair, the fee and the payout are fixed for good.

**What it is.** A key that opens the engine on your own wallet, not a share. It pays nobody who holds it: no buyback, no burn,
no revenue share, no staking, no holder rewards, no airdrop. Its creator fees go to the treasury that paid for
the launch, which is his operator's, for as long as it trades. The desk never holds, swaps or market-makes it.

**Cost.** The sprint budgets 0.02 to 0.05 SOL; `npm run clawpump -- cost` prints today's creation fee. Send the
treasury about 0.05 SOL so the fee and a margin are covered (the launch refuses unless the wallet holds the quote
plus 0.005 SOL).

## What the code does for you

- `ops/live.env` holds the spec: `TOKEN_NAME="Mr Bands"`, `TOKEN_SYMBOL=MRBANDS`, `TOKEN_PUMP_PAIR=SOL`,
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
- The talk lint treats `$mrbands`, `TOKEN_MINT` and a bare `$bands` (any case) as the house token: the disclosure
  is required, and price, chart, cap, holders, volume, fee, value, a % or a $ may never sit next to it, nor buy,
  sell or early. The copycat's mint or `@mrbandssol` may only appear in a sentence that says it is not his.

## The steps, in order (Zach)

Run from `/Users/zach/Bands.Finance/mr-bands`. Nothing below touches the desk wallet or the running services.

**1. Make the treasury keypair (Wed 23 Sep).** On this Mac, outside the repo:

```sh
solana-keygen new --no-bip39-passphrase -o ~/mrbands-treasury.json
chmod 600 ~/mrbands-treasury.json
solana-keygen pubkey ~/mrbands-treasury.json
```

The last line prints the treasury address. Keep a copy of the key file offline (a USB stick, not a cloud drive).
It never goes in `.env`, in the repo, in chat or in a gateway agent. After the launch it is only needed to move
creator fees out; the fees arrive at the address without it.

**2. Fund it.** Send about 0.05 SOL to the treasury address from your own wallet, not from the desk.

**3. `.env`.** Add two lines (the API key is the secret; the address is public):

```sh
CLAWPUMP_API_KEY=cpk_...            # from https://clawpump.tech/dashboard/api
TOKEN_PAYER_EXPECTED=<treasury address from step 1>
```

`CLAWPUMP_AGENT_ID` is already there. Leave `EXPECTED_WALLET` as it is: it pins the desk, and the launch does not
read it except to refuse the desk as payer.

**4. The pairs.**

```sh
npm run clawpump -- pairs
```

Prints the creator-fee range and the custom pairs on offer. Nothing to choose: we launch on SOL. It is a check
that the key works.

**5. The quote (Thu 24 Sep).** With the treasury key loaded for this one command, still in dry run:

```sh
set -a; . ./ops/live.env; set +a
WALLET_SECRET_KEY="$(cat ~/mrbands-treasury.json)" npm run clawpump -- quote
```

It prints:

```
Mr Bands (MRBANDS) by <agent name>, agent <agent id>, pair SOL, dev buy 0 SOL, buybackBps 0
  payer <treasury address>
  creator fees go to <treasury address> for good
  quote: <amount> SOL (<lamports> lamports) to <ClawPump's address>, valid 900 s; creation fee <fee> SOL
  nothing paid, nothing minted: `npm run clawpump -- launch --confirm` with DRY_RUN=false does it
```

Read it before going on. The payer must be the treasury address from step 1. Any line starting with WARNING
(the desk wallet as payer, `TOKEN_PAYER_EXPECTED` unset or not matching, a dev buy above 0, a pair other than
SOL) means stop. The launch refuses every one of them in code as well, but fix the setting rather than lean on it.

**6. The launch (Fri 25 Sep).** The same, with `DRY_RUN=false` for this command only and `--confirm`:

```sh
set -a; . ./ops/live.env; set +a
WALLET_SECRET_KEY="$(cat ~/mrbands-treasury.json)" DRY_RUN=false npm run clawpump -- launch --confirm
```

It prints the quote block again, then:

```
  paid: <payment signature>
  launched: mint <mint> (launch tx <tx>)
  pump.fun: https://pump.fun/coin/<mint>
  creator fees go to <treasury address> for good

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
- **No launch from the desk wallet.** The payer keeps the creator fees for good. The launch refuses the desk
  address, but do not work around it.
- **No `PAIR_HOUSE_MINTS`.** It stays unset through 8 Oct. Set, it seats and market-makes the house token even
  with the pair lane off (src/index.ts). H1 would refuse the band, but the setting is the wrong intent.
- **No ClawPump MCP (or any ClawPump key) attached to the gateway agent.** The launch is a human command with
  `--confirm` and `DRY_RUN=false`. No model path may ever reach a launch, the wallet or the token.
- **No buying, selling or pooling the token from the desk** by hand either: that is what H1 enforces in code.
- **Not the copycat.** "Mr Bands" $BANDS at `JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m` (X `@MrBandsSol`) is
  not ours. Our mint is the only one the site, the gate and Mr Bands name.

## How he talks about it

Every mention carries the disclosure (the lint enforces it; docs/sprint.md holds the current wording). Launched
with this runbook, the true one is: "our own token, launched by my operator. the desk holds none and never trades
it. holding <mint> in a signed-in wallet opens the engine. not a share, it pays nobody who holds it, and its trades pay a cut to my operator's treasury." He
names the mint, never a bare ticker, and says other $bands tokens are not his.
