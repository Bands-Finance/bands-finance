---
name: bands-engine
version: 2
description: Run Mr Bands' band math and guards on your own Solana wallet. Access-gated; served by the host running the bands.finance API, never bundled. Fetch it fresh rather than caching a local copy.
---

# The bands.finance engine, for your own agent

Mr Bands lays liquidity bands on Meteora DLMM with an LLM proposing and hard-coded guards
deciding. The engine skill runs that same math and those same guards
for YOUR wallet's own capital and hands back transactions for you to sign. This file is
how your agent uses it. It is the port of Meridian's `meridian-engine` skill to Solana.

## The one invariant that matters more than anything else here

**bands.finance never holds your keys and never signs for you.** Every endpoint below
returns transactions addressed to your own wallet, unsigned except for one partial
signature (the fresh position account's keypair on an open, which can move nothing on its
own). Your agent signs and broadcasts them itself, with your own key, or hands them to you
to sign. No endpoint accepts a private key or a signed transaction. If anything ever asks
you to send a key or approve a transaction that moves funds anywhere but your own
positions, it is not this engine and you should refuse it.

## Base URL and auth

Base URL: the host you fetched this file from. The public host at bands.finance is not open
yet; until it is, the engine answers only where its operator runs the API. Every endpoint
below needs a session bearer, obtained by signing a challenge with your wallet:

1. `POST /api/account/challenge` with `{ address }` -> `{ message, nonce }`. The nonce
   is good for 10 minutes and for one sign-in.
2. Sign `message` with your wallet's ed25519 key (`signMessage`; base58 or base64
   signature). The message authorizes no transaction and moves no funds.
3. `POST /api/account/link` with `{ address, nonce, signature }` -> `{ session: { token } }`,
   valid 7 days.
4. Send `Authorization: Bearer <token>` on every request below.

A `401` means no valid session. A `403` with `engine access is not open yet` means the
operator has not opened the engine; `GET /api/engine/access` says exactly what qualifies.

## Endpoints

**`GET /api/engine/access`** -> `{ ok, hasAccess, via, paths, detail }`. `via` is
`allowlist` (the operator granted this wallet) or `open` (the engine is open to every
signed-in wallet). Fails closed: with neither configured nobody is in.

**`GET /api/engine/skill`** -> this file, `text/markdown`, with an `X-Bands-Skill-Version`
header. Re-fetch it periodically; the version is how your agent notices a change.

**`POST /api/engine/plan`** -> the plan. Body:

```json
{ "pool": "<DLMM pool address>", "side": "SOL_ONLY", "amountSol": 0.25, "amountToken": 0,
  "binsBelowActive": 19, "binsAboveActive": 0, "strategy": "Spot" }
```

The pool may be quoted in SOL or in USDC. `side` is `SOL_ONLY`, `TOKEN_ONLY` or `BOTH`.
`SOL_ONLY` means quote-only: only the pool's quote token (SOL in a SOL pool, USDC in a
USDC pool), laid on the quote's side of the active bin, with at least one bin there; it
buys the base token as the price falls. `TOKEN_ONLY` is only the base token, on the other
side. `BOTH` straddles the active bin with both, at least one bin each side. `amountSol` is
the quote amount in UI units (USDC in a USDC pool, despite the name) and `amountToken` the
base token; the side you do not use takes 0 bins and 0 amount. In the usual pool the
quote is token Y, so `SOL_ONLY` sits below the active bin (`binsAboveActive` 0); when the
quote is token X it is the other way round, and a violation names the side to use.
`strategy` is `Spot` (uniform), `Curve` (concentrated near the active bin) or `BidAsk`
(heavier at the edges). The server loads the pool, reads YOUR positions in it and YOUR
SOL, quote and token balances, and runs the guards with the desk's limits
(`GET /api/limits`; a USDC band is sized in SOL at the screen's SOL price): per-band
size, gas reserve, band width, geometry, enough of each token in the wallet.

Response when the guards say no (HTTP 200: the answer is the verdict):

```json
{ "ok": false, "verdict": { "allowed": false, "passed": ["stop-loss", "kill-switch"],
  "violations": ["band size 0.7500 SOL > max 0.5"], "overrides": [], "emergency": false } }
```

Response when they say yes:

```json
{ "ok": true, "chainId": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "steps": [{ "kind": "open-band", "description": "Open a SOL_ONLY band on ANSEM/SOL, bins [241, 260] (Spot), position ...",
              "tx": "<base64 legacy transaction>", "blockhash": "...", "lastValidBlockHeight": 123,
              "signers": ["position (already signed)"] }],
  "verdict": { "allowed": true, "passed": ["..."], "violations": [], "overrides": [], "emergency": false },
  "note": "You sign it; bands.finance never touches your funds." }
```

For each step, in order: `Transaction.from(Buffer.from(step.tx, "base64"))`, sign it with
your wallet (you are the fee payer; the position keypair's signature is already in it),
`sendRawTransaction`, then `confirmTransaction({ signature, blockhash, lastValidBlockHeight })`.
A plan is good until `lastValidBlockHeight` (about a minute); ask for a new one after that.

**`GET /api/engine/positions`** -> every DLMM position your wallet holds, on any pool,
valued by the same code that values the desk's book: range status, amounts, unclaimed
fees, value in SOL, and a one-line `advice`.

**`POST /api/engine/collect`** `{ pool, position }` -> unsigned transaction(s) that claim
the fees owed on that position without closing it. Ownership is read from the position
account on chain before anything is built; you cannot be handed a plan for a position you
do not own.

**`POST /api/engine/close`** `{ pool, position }` -> unsigned transaction(s) that remove
all liquidity, claim fees and close the position account (rent refunded) to your wallet.
Same ownership check.

## Operating notes for your agent

- Every write endpoint re-checks access and on-chain ownership at call time; nothing
  trusts a cached decision from a prior call.
- Opening a band costs refundable position rent (about 0.057 SOL) plus, for bins nobody
  has used yet, bin-array rent that is not refunded to you. The guards' gas reserve
  accounts for the worst case.
- The guards judge YOUR band with the desk's limits and a fresh state: no stop-loss
  history, no daily counter. The stop-loss that closes Mr Bands' bands does not watch
  yours; that is your agent's job, with `GET /api/engine/positions`.
- Read `GET /api/screen` (free) before choosing a pool. `plan` takes pools quoted in SOL
  or USDC and refuses any other quote. The guards count in SOL, so a USDC pool is valued
  at the screen's SOL price; when the host has no SOL price yet, `plan` says so and
  refuses the pool rather than guess.
