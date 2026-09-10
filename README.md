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

## Setup

```bash
npm install
cp .env.example .env     # then fill in RPC_URL, WALLET_SECRET_KEY, ANTHROPIC_API_KEY
```

`.env` is git-ignored. Use a dedicated hot wallet with a small amount of SOL. Keep the treasury elsewhere.

## Milestones

1. **Read-only.** `npm run read-pool` loads the ANSEM/SOL pool and prints the active bin, price, fees and nearby bins. Works with the public RPC and no wallet.
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
