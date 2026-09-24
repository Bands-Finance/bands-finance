/**
 * bands-exchange: the Worker in front of the Bands Exchange room (bands.finance Play).
 *   GET /health                      -> 200 JSON
 *   GET /ws  (Upgrade: websocket)    -> Origin checked against ALLOWED_ORIGINS (else 403), then handed to the one room
 *   anything else                    -> 404
 */
import { originAllowed } from "./core";
import type { Env } from "./room";

export { Room } from "./room";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "bands-exchange" });
    if (request.method === "GET" && url.pathname === "/ws" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (!originAllowed(request.headers.get("Origin"), env.ALLOWED_ORIGINS ?? "")) return new Response("forbidden", { status: 403 });
      return env.ROOM.get(env.ROOM.idFromName("main")).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
