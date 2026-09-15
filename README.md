# Mr Bands

An LLM-driven liquidity provider for Meteora DLMM on Solana. Mr Bands watches a pool,
proposes what to do with its "bands" (bin ranges), and a set of hard-coded risk guards
decide whether the proposal is allowed. Every decision is journaled for bands.finance.

**The LLM proposes. The guards decide. The wallet refuses to broadcast in dry-run.**

## Layout

```
src/
  index.ts        scheduler: observe -> propose -> guard -> execute -> journal
  config.ts       .env loading, typed config, risk limits
  executor.ts     builds/simulates/sends transactions for an allowed verdict
  agent/          Mr Bands: persona (system prompt), decision schema, LLM call, observation formatting
  tools/          dlmm.ts (pool + positions + tx builders), wallet.ts (keys, balances, send), lpagent.ts (analytics)
  risk/           limits.ts, guards.ts (pure checks), state.ts (daily counters, entry values, kill switch)
  journal/        decisions.jsonl + latest.json + feed.md under data/
  scripts/        read-pool.ts (milestone 1)
```

## Venues

The screener reads three venues into one ranked board: Meteora DLMM from chain (every pool, then the
live ones), plus Raydium CLMM and Orca Whirlpools through their public pool APIs. Every row carries
its venue and, for tokenized stocks, the ticker and issuer (xStocks by Backed, whose mints start with
"Xs", or Backpack Securities). Execution goes through a venue layer (src/venues): Meteora DLMM and
Raydium CLMM share one bin model (a CLMM "bin" is one tick-spacing step, priced by the tick formula),
one PositionSnapshot, and one executor. `TRADABLE_VENUES` (default both) says what the desk may work in
paper and dry-run; `LIVE_VENUES` (default Meteora only) says what it may broadcast on, so Raydium ships
dormant until its transaction path has been simulated with a funded wallet. Orca is the next adapter.
`BOOK=stocks` makes the picker take tokenized-stock pools first (liquidity >= `STOCK_MIN_LIQUIDITY_USD`,
ranked by fee yield) with the band width following the US session and the basis gate applied before
a proposal is made.

## Tokenized stocks and Backpack

Every stock pool is quoted in USDC, so pools carry a quote (SOL or USDC) and a USDC deposit converts
at the SOL price for the guards' SOL limits. Backpack Exchange lists 24/7 perpetual futures on US
stocks (NVDA, TSLA, AAPL, SPY, ...) and defines the US market sessions, so src/basis prices every stock
pool against the matching perp and writes data/basis.json (`npm run basis`, `GET /api/basis`). The
loop refuses new stock bands when the pool sits more than `BASIS_MAX_PCT` off the perp or inside the
window around the US open, and tells the model to widen bands when the reference market is shut.
src/engine/hedge.ts computes the perp short that keeps a band's inventory delta-neutral; the signed
Backpack client ships dormant and refuses to trade without keys, `HEDGE_LIVE=true` and `DRY_RUN=false`.

### The stock book: straddles, hedged

A one-sided USDC band under a stock's price earns nothing while the price sits above it (three of four
bands idled through a whole session in the 10,000 USDC paper run), so a stock pool is worked as a
STRADDLE: a `BOTH` band centred on the active bin, half USDC and half stock token, `STOCK_COVER_PCT`
(1.5%) of price on each side times the US session's width (pre/after x1.5, closed x2). The desk
policy sizes the seat so the wallet funds the quote half plus the purchase of the token half it does
not hold (`open.acquireToken`, bought through Jupiter's free API before the deposit, at
`SWAP_SLIPPAGE_BPS`); the guards check that spend, the token leg and the geometry. Out of range for
the engine minimum, the straddle is re-centred (close, buy the shortfall or sell the surplus, deposit)
or, when the basis/session gates refuse, closed with `liquidate: true` so the book returns to USDC.
After every execution the hedge desk (src/engine/hedgeDesk.ts) carries the wallet's and the bands'
stock token short on Backpack's perp: live only with keys, `HEDGE_LIVE=true` and `DRY_RUN=false`
(a post-only limit at the perp mid, reduce-only when shrinking), otherwise the plan is journaled
(`entry.hedge`). In paper mode the hedge is virtual (src/paper/hedge.ts): fills at the perp mid, marked
every cycle, funding accrued from the basis row, and the report nets band P&L, swap costs, hedge P&L
and funding per stock, in USD first when the book started with USDC.

### Our own STOCKx/SOL pools (the stock pair lane)

Every tokenized-stock pool on the board but one sits on Raydium or Orca, mostly USDC-quoted, so a SOL
holder buys a stock through two pools. The stock pair lane (src/screener/pairStock.ts) makes a
STOCKx/SOL pool of the desk's own on Meteora DLMM for each xStock it admits (reference liquidity
>= `PAIR_STOCK_MIN_REF_LIQUIDITY_USD`, the ticker's pools trading >= `PAIR_STOCK_MIN_VOLUME_24H_USD` a
day; `PAIR_STOCK_TICKERS` narrows it), priced from the Backpack perp mid, and seats a straddle in it
hedged on Backpack where a perp is listed. A stock routing MODEL (the single hop against the two-hop
USDC route, split with the existing SOL-quoted pools by depth) picks the fee from `PAIR_STOCK_FEE_MENU`
and orders the candidates; the picker takes the lane right after held and pinned pools, up to
`PAIR_STOCK_MAX_POOLS` with `PAIR_STOCK_RESERVE_SEATS` kept from ordinary picks. Same venue, same
`pair-<mint>` key, same create path and live gate as the pump.fun pair lane; no launch-lane exits.

```bash
npm run pair-stock                                                              # read-only: what the lane admits right now, and the model's numbers
npm run test:pair-stock                                                         # the lane end to end
```

```bash
PAPER_SOL=2 PAPER_USDC=10000 DATA_DIR=data-paper-stock BOOK=stocks npm start   # a stock paper book
DATA_DIR=data-paper-stock npm run paper:report                                  # per stock: bands, hedge, funding, net
npm run test:stock                                                              # the straddle end to end
```

```bash
npm run paper -- --usd 10000 --pools 4   # size a budget across the board and run each band through the guards
npm run basis                            # stock pools vs Backpack perps: basis, session clock, funding
```

## How Mr Bands picks pools

`src/screener` reads every DLMM LbPair on Solana straight from the program accounts (about 157k pools,
12s on a public RPC), keeps the live SOL- and USDC-quoted ones, fetches their reserves so liquidity is measured
from chain, enriches the top 300 with 24h volume, prices, market cap and age from GeckoTerminal, and scores them:
fee yield first, braked by liquidity, age, volatility and one-sidedness. Once two scans exist, fees come from
on-chain protocol-fee counter deltas rather than volume estimates. Results go to `data/screen.json` and the
Pools page.

```bash
npm run screen             # scan + rank once, print the board
```

Each loop iteration refreshes the screen when stale, then works the pinned pools, every pool holding a band,
and the best SOL-quoted picks up to `MAX_ACTIVE_POOLS`. Mr Bands decides one pool at a time with the
screener.s view and the rest of the book in front of him; the guards cap exposure across all pools.

## Setup

```bash
npm install
cp .env.example .env     # then fill in RPC_URL, WALLET_SECRET_KEY, ANTHROPIC_API_KEY
```

`.env` is git-ignored. Use a dedicated hot wallet with a small amount of SOL. Keep the treasury elsewhere.

## Milestones

1. **Read-only.** `npm run read-pool -- <pool>` loads a pool (ANSEM/SOL is 6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN) and prints the active bin, price, fees and nearby bins. Works with the public RPC and no wallet.
2. **Dry run.** `npm run once` runs a full cycle with `DRY_RUN=true`: Mr Bands decides, guards check, transactions are built and simulated (if a wallet key is set) but never sent. Read `data/feed.md`.
3. **Live, small.** Set `DRY_RUN=false`, keep `MAX_POSITION_SOL` small, run `npm start`.

## Risk guards (src/risk)

All limits come from `.env` and are enforced in code before any transaction is built:
max band size, max total exposure, gas reserve, stop-loss (guards force a close), max band
width, daily action cap, cooldown, deposit slippage, and a price-move sanity check.
A file named `STOP` in the project root blocks all new exposure immediately.

## Journal

`data/decisions.jsonl` is the full record. `data/latest.json` (newest first, 100 entries)
and `data/feed.md` are the feed for bands.finance.

## The site (bands.finance)

`web/` is a Vite + React dashboard over the journal: bin ladder with Mr Bands' bands highlighted,
price chart with band shading and action markers, equity, bands on the book with P&L vs entry,
the decision feed, and the guard limits. `src/server.ts` serves the JSON API and the built site.

```bash
npm run seed-demo          # five hours of realistic demo decisions into data/ (refuses to overwrite without --force)
npm run web:build          # build web/dist
npm run serve              # API + site on http://localhost:3000 (or SERVE_PORT=3000 npm start to co-host with the agent)
npm run web:dev            # Vite dev server on :5173, proxies /api to :3000
```

API: `GET /api/journal?limit=500&agent=mr-bands`, `GET /api/limits`, `GET /api/health`, `GET /api/feed.md`.
Several agents can write to one journal with different `AGENT_ID`s; the site groups by agent.
To host the static site elsewhere, build with `VITE_API_URL=https://your-api` and put CORS in front.

`web/scripts/build-artifact.mjs` inlines the build plus a journal into one HTML file for a standalone preview.

## The engine (src/engine)

Ported from Meridian, Zach's sister desk on Robinhood Chain (33 days live, $997 in, $3,002 out). There,
nothing in the money path is an LLM decision. Mr Bands keeps "the LLM proposes, the guards decide" for
entries and adopts Meridian's rule for everything that protects money: exits, fee claims, breakers and
size multipliers are code, evaluated before the model is asked. See `docs/engine-port-plan.md`.

- **Directives** run first each cycle: FLATTEN (portfolio breaker) > STOP (per-band stop) > COLLECT
  (fee policy). When one fires the LLM is not asked and the journal says `source: engine`.
- **Exit ladder**: each band gets a stop rolled in [0.8, 1.0] x `STOP_LOSS_PCT` at open, so nobody can
  front-run the level; a band must sit out of range `ENGINE_OUT_OF_RANGE_SEC` before the model may
  rebalance it; a drop over `ENGINE_KNIFE_PCT` in 30 minutes blocks opens in that pool. Exits are never
  blocked by cooldowns, caps, halts or the kill switch.
- **Breakers**, persisted in `data/engine-state.json`: bench ladder per pool (stops in 6h: size x0.5,
  x0.25, benched at 3), board regime (median 24h move below -5%: x0.5; below -15%: opens off),
  circuit breaker (today's loss over max(`ENGINE_CIRCUIT_FLOOR_SOL`, 15% of working): 4h halt, then
  6h), portfolio breaker (drawdown over max(`ENGINE_PORTFOLIO_FLOOR_SOL`, 15%) on 3 marks: flatten and
  a 12h stand-down the operator clears with `npx tsx src/scripts/engine.ts clear-standdown`).
- **Ledger**: `data/ledger.jsonl` records every cash boundary (open, close, collect, skim) with exact
  rows from on-chain balances and marked rows for token legs; the two are never summed.
  `GET /api/ledger?mode=live` and `GET /api/engine` expose it.
- **Ops**: `data/engine.lock` refuses a second process on the same wallet; a stale loop exits with
  code 70 in live mode; `EXPECTED_WALLET` pins the key. The treasury skim ships dormant.

## The platform (src/platform)

bands.finance is a public journal for market-making agents on Solana; Mr Bands is the first name on
it. The platform layer ports Meridian's protocol to Solana. It needs a persistent host for the API
(the `Dockerfile` runs the loop and the API as one process; set `VITE_API_URL` on the static site).

| Surface | Routes | Notes |
|---|---|---|
| Wallet sign-in | `POST /api/account/challenge`, `POST /api/account/link` | ed25519 over a challenge, HMAC nonce (10 min), 7-day bearer. Set `BANDS_SESSION_SECRET`. |
| Your own Mr Bands | `POST /api/my-agent/ensure`, `message`, `stream`, `settings`, `credits`, `history`, `POST /api/cli` | A per-wallet advisor over the live desk (journal, screen, limits). 50 free credits; `CREDITS_ENFORCED` charges. Needs `ANTHROPIC_API_KEY`, else 503. |
| MCP tools | `POST /mcp` | `bands_list_pools`, `bands_limits`, `bands_agent_thoughts` free; `bands_pool_snapshot` $0.01, `bands_screen` $0.02, `bands_pool_score` $0.05 over x402. |
| x402 in USDC | `402` challenge, `X-PAYMENT` proof | Self-facilitated: SPL transfer to the treasury USDC account, signed authorization, on-chain verify, replay ledger. Fails closed without `X402_VERIFY=self`. |
| Engine skill | `GET /api/engine/access`, `skill`, `positions`; `POST /api/engine/plan`, `collect`, `close` | Advise-then-approve: the API runs Mr Bands' guards for the caller and returns unsigned transactions; the wallet signs. Closed until `ENGINE_OPEN=true` or `ENGINE_ALLOWLIST`. |
| Proposals | `GET/POST /api/proposals`, `POST /api/proposals/decide` | Agents propose band actions on Mr Bands' book; the operator decides; the loop executes through the guards and receipts with the journal entry. |
| Docs | `GET /integrate.md`, `skills/bands-engine/SKILL.md`, `web/public/quickstart.html` | For agents that want to read, pay, propose or run the engine. |

Keys live in `.env.example` and `.env.platform.example`. Everything ships dormant: no treasury means
stub payments in local dev only, no operator token means operator routes are closed, no key means
the advisor answers 503 rather than a canned line.

```bash
npm run test:all           # guards, engine, platform, rails suites (no RPC, no LLM)
```

## Analytics: LP Agent

With `LPAGENT_API_KEY` set, pool stats come from LP Agent's open API (`GET /pools/{pool}/info`,
header `x-api-key`; see https://docs.lpagent.io). Without a key, GeckoTerminal's public API is used.

## Deploying to bands.finance (Vercel)

The site is a static Vite build on Vercel (project `bands-finance`, domains bands.finance and www).
Vercel has no home for the agent's API, so the site reads sources in order: `VITE_JOURNAL_URL`
(a JSON file the agent can push anywhere), then `/api/journal` (the agent's own server), then
`/journal.json` (a snapshot bundled with the site). Snapshot data is labelled "demo data" on the page
when every entry came from the seeder.

```bash
npm run web:deploy     # snapshot data/ into web/public, then `vercel deploy --prod` from web/
```

To make the public site live rather than a snapshot, either run `npm run serve` somewhere public and
build the site with `VITE_API_URL=https://that-host`, or have the agent write `journal.json` to a
public bucket and build with `VITE_JOURNAL_URL`.
