# bands-exchange

The room server for bands.finance **Play**, the Bands Exchange plaza. Visitors walk around and see each other. They can wave, send preset phrases and play the LP mini-game for a shared leaderboard.

It is one Cloudflare Worker in front of one Durable Object room (`idFromName("main")`, up to 60 visitors). The wire format is `web/src/game/protocol.ts` and the browser client is `web/src/game/net.ts`.

## What the server enforces

- **No free text.** The server makes each name from curated word lists ("Brass Heron 42"). Emotes and phrases come from fixed lists, and error replies are fixed strings. Nothing a visitor types reaches another visitor.
- **Movement.** Moves are capped at 12 a second, clamped to the plaza disc and checked against top speed. A refused move sends the walker back to its last good spot. Positions go out in batches 10 times a second.
- **Scores.** An online round is played on the server. The player lays a band on one of the top 12 pools from the server's own copy of `BOARD_URL` (cached for 2 minutes). The server deals a seed it never sends, runs `simulate()` (`web/src/game/lpGame.ts`) and streams the round one tick every 420 ms as its clock reaches each tick. A close settles the round at the last tick already sent, and the round settles by itself at the last tick. The score is `simulate()` re-run with that close, so the browser never holds the seed or a future tick and never sends a score. The leaderboard keeps each name's best score, top 20, in Durable Object storage.

All game logic is in `src/core.ts` (`RoomCore`), which has no Cloudflare code. `src/room.ts` connects WebSockets to it using the hibernation API. `src/index.ts` checks the Origin and routes requests. The tests are in the repo root: `npm run test:game-room`.

## Run locally

```sh
cd game-server
npm install
npx wrangler dev            # http://localhost:8787/health, ws://localhost:8787/ws
```

Then start the site against it:

```sh
cd web
VITE_GAME_WS_URL=ws://localhost:8787/ws npm run dev
```

`ALLOWED_ORIGINS` in `wrangler.toml` already includes `http://localhost:5173` and `http://localhost:4312`.

## Deploy (owner)

The Worker imports `../web/src/game/{protocol,lpGame}.ts`, so deploy from a full checkout of the repo.

1. Authenticate in one of two ways:
   - `npx wrangler login` (opens a browser), or
   - set `CLOUDFLARE_API_TOKEN` (a token made from the "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID` in the environment.
2. `cd game-server && npm install && npx wrangler deploy`
3. Wrangler prints the URL, `https://bands-exchange.<subdomain>.workers.dev`. Check `https://bands-exchange.<subdomain>.workers.dev/health`.
4. Build the site with the room's address. Leaving it unset keeps Play single-player:
   `VITE_GAME_WS_URL=wss://bands-exchange.<subdomain>.workers.dev/ws`
   (for Vercel: `--build-env VITE_GAME_WS_URL=...`, or set it in the project's environment variables).

If the site is also served from another origin, such as `https://www.bands.finance` or a preview domain, add it to `ALLOWED_ORIGINS` in `wrangler.toml` and redeploy. Any other origin gets a 403.

The Durable Object uses a SQLite-backed class (`new_sqlite_classes`), which the Workers free plan supports. Incoming WebSocket messages count toward the Durable Objects request allowance, at a reduced rate per message. A walking visitor sends up to 12 a second. An empty room stops its tick timer and can hibernate. Check Cloudflare's current free-plan limits against expected traffic.

## Round rules

- One open round per player, and one lay a second.
- A player who leaves forfeits the round.
- A round still open 30 seconds past its last tick is dropped with `{ t: "error", why: "round expired" }`.
- Rounds live in memory. If the object restarts, open rounds are lost, and the page should give up on a round that goes quiet.
