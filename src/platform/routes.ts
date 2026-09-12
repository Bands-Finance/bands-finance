/**
 * The identity + personal-agent + credits routes, mounted by the integrator with
 * `platformRoutes(app)` in src/server.ts. Ports the corresponding Express routes of Meridian's
 * agent/src/index.ts (/api/account/*, /api/my-agent/*, /api/cli) to Hono.
 *
 *   POST /api/account/challenge   {address}                    -> {message, nonce}            400
 *   POST /api/account/link        {address, nonce, signature}  -> {ok, account, session}      401
 *   GET  /api/account/:address                                 -> {address, linkedAt}         400
 *   POST /api/my-agent/ensure     (bearer)                     -> {ok, agentId, name, settings, credits, created}
 *   GET  /api/my-agent/settings   (bearer)                     -> {ok, settings}
 *   POST /api/my-agent/settings   (bearer) patch               -> {ok, settings}              400
 *   POST /api/my-agent/message    (bearer) {text}              -> {ok, text, credits}         400 401 402 409 429 502 503
 *   POST /api/my-agent/stream     (bearer) {text}              -> SSE: token {text} / done {credits} / error {error}
 *   GET  /api/my-agent/credits    (bearer)                     -> {ok, balance, freeMessages, packs, enforced}
 *   GET  /api/my-agent/history    (bearer)                     -> {ok, turns}
 *   POST /api/cli                 (bearer) {line}              -> {ok, lines, effect, suggest?, text?, settings?}
 *   GET  /api/platform/ops        (operator bearer)            -> load, spend ceilings, credits switch, model
 *   POST /api/platform/credits/grant (operator bearer) {address, credits, reason} -> {ok, balance}
 *
 * Session routes take `Authorization: Bearer <session>` from /api/account/link (accounts.ts). The
 * wallet IS the account: the bearer proves control, and every route acts only on that wallet's own
 * agent. No funds move here; this is conversation. Operator routes fail closed when
 * PLATFORM_OPERATOR_TOKEN is unset. CORS belongs to the integrator; the http guards (security
 * headers, per-IP buckets) are mounted here on /api/*.
 */
import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { accountData, issueChallenge, linkAccount, requireWallet } from "./accounts";
import { chatLoad } from "./chatLimits";
import { describeSettings, routeCli } from "./cli";
import { platformEnv } from "./config";
import { balanceOf, creditsEnforced, freeCredits, grantCredits, packs } from "./credits";
import { authRateLimit, globalRateLimit, securityHeaders } from "./httpGuards";
import { advisorConfigured, agentDisplayName, deskLines, ensureUserAgent, openTurn, runUserTurn, userAgentHistory } from "./myAgent";
import { getAgentSettings, setAgentSettings } from "./settings";
import { chatSpendStatus } from "./spendGuards";
import { isAddress } from "./accounts";

const MAX_TEXT = 2000;

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const j = await c.req.json();
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The wallet a request proves, or null (the caller writes the 401). */
function walletOf(c: Context): string | null {
  return requireWallet(c.req.header("authorization"));
}

const unauthorized = (c: Context) => c.json({ ok: false, error: "sign in with your wallet to reach your advisor" }, 401);

/** Operator bearer, compared in constant time. Unset token = every operator route refuses. */
function operatorOk(c: Context): "ok" | "unset" | "bad" {
  const expected = platformEnv().operatorToken;
  if (!expected) return "unset";
  const m = /^Bearer\s+(.+)$/i.exec((c.req.header("authorization") ?? "").trim());
  if (!m) return "bad";
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "bad";
}

function messageText(raw: Record<string, unknown>): { text: string } | { error: string } {
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) return { error: "empty message" };
  if (text.length > MAX_TEXT) return { error: `message too long (${MAX_TEXT} char max)` };
  return { text };
}

export function platformRoutes(app: Hono): void {
  app.use("/api/*", securityHeaders);
  app.use("/api/*", globalRateLimit);
  app.use("/api/account/*", authRateLimit);

  // ---- wallet-as-account sign-in --------------------------------------------------------------
  app.post("/api/account/challenge", async (c) => {
    const { address } = await body(c);
    const challenge = typeof address === "string" ? issueChallenge(address) : null;
    if (!challenge) return c.json({ ok: false, error: "valid Solana address required" }, 400);
    return c.json(challenge);
  });

  app.post("/api/account/link", async (c) => {
    const { address, nonce, signature } = await body(c);
    if (typeof address !== "string" || typeof nonce !== "string" || typeof signature !== "string") return c.json({ ok: false, error: "address, nonce and signature required" }, 401);
    const result = linkAccount({ address, nonce, signature });
    if (!result.ok) return c.json({ ok: false, error: result.error }, 401);
    return c.json({ ok: true, account: result.account, session: result.session });
  });

  app.get("/api/account/:address", (c) => {
    const data = accountData(c.req.param("address"));
    if (!data) return c.json({ ok: false, error: "invalid address" }, 400);
    return c.json(data);
  });

  // ---- your own agent ---------------------------------------------------------------------------
  app.post("/api/my-agent/ensure", (c) => {
    const wallet = walletOf(c);
    if (!wallet) return unauthorized(c);
    try {
      return c.json({ ok: true, ...ensureUserAgent(wallet), configured: advisorConfigured() });
    } catch (err) {
      console.error("[my-agent] ensure failed:", err instanceof Error ? err.message : err);
      return c.json({ ok: false, error: "could not set up your advisor, try again shortly" }, 502);
    }
  });

  app.get("/api/my-agent/settings", (c) => {
    const wallet = walletOf(c);
    if (!wallet) return unauthorized(c);
    return c.json({ ok: true, settings: getAgentSettings(wallet) });
  });

  app.post("/api/my-agent/settings", async (c) => {
    const wallet = walletOf(c);
    if (!wallet) return unauthorized(c);
    const result = setAgentSettings(wallet, await body(c));
    if ("error" in result) return c.json({ ok: false, error: result.error }, 400);
    return c.json({ ok: true, settings: result.settings });
  });

  app.post("/api/my-agent/message", async (c) => {
    const wallet = walletOf(c);
    if (!wallet) return unauthorized(c);
    const parsed = messageText(await body(c));
    if ("error" in parsed) return c.json({ ok: false, error: parsed.error }, 400);
    const lease = await openTurn(wallet);
    if (!lease.ok) return c.json({ ok: false, code: lease.code, error: lease.error, ...(lease.balance !== undefined ? { balance: lease.balance } : {}) }, lease.status);
    try {
      const out = await runUserTurn(wallet, parsed.text, lease);
      if (!out.ok) return c.json({ ok: false, error: out.error, credits: out.credits }, out.status);
      return c.json({ ok: true, text: out.text, credits: out.credits });
    } finally {
      lease.close();
    }
  });

  app.post("/api/my-agent/stream", async (c) => {
    const wallet = walletOf(c);
    if (!wallet) return unauthorized(c);
    const parsed = messageText(await body(c));
    if ("error" in parsed) return c.json({ ok: false, error: parsed.error }, 400);
    // Guards BEFORE the SSE headers, so a refusal gets a clean JSON error rather than a half-open stream.
    const lease = await openTurn(wallet);
    if (!lease.ok) return c.json({ ok: false, code: lease.code, error: lease.error, ...(lease.balance !== undefined ? { balance: lease.balance } : {}) }, lease.status);
    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-cache, no-transform");
    return streamSSE(
      c,
      async (stream) => {
        const ac = new AbortController();
        stream.onAbort(() => ac.abort());
        try {
          const out = await runUserTurn(wallet, parsed.text, lease, {
            signal: ac.signal,
            onToken: (chunk) => void stream.writeSSE({ event: "token", data: JSON.stringify({ text: chunk }) }),
          });
          if (out.ok) await stream.writeSSE({ event: "done", data: JSON.stringify({ credits: out.credits }) });
          else if (!out.aborted) await stream.writeSSE({ event: "error", data: JSON.stringify({ error: out.error, credits: out.credits }) });
        } finally {
          lease.close();
        }
      },
      async (err, stream) => {
        console.error("[my-agent] stream broke:", err.message);
        lease.close();
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "your advisor could not respond just now, try again shortly." }) });
      },
    );
  });

  app.get("/api/my-agent/credits", (c) => {
    const wallet = walletOf(c);
    if (!wallet) return unauthorized(c);
    // `enforced` says whether a message is ACTUALLY being charged for, so the UI advertises the
    // rule that is running rather than the one on the price list.
    return c.json({ ok: true, balance: balanceOf(wallet), freeMessages: freeCredits(), packs: packs(), enforced: creditsEnforced() });
  });

  app.get("/api/my-agent/history", (c) => {
    const wallet = walletOf(c);
    if (!wallet) return unauthorized(c);
    return c.json({ ok: true, turns: userAgentHistory(wallet) });
  });

  // ---- the CLI ----------------------------------------------------------------------------------
  // The routing is PURE (cli.ts) and this route is the only thing that can act. Every settings
  // change goes through setAgentSettings, the same path the settings route uses. Chat is
  // deliberately NOT handled here: it returns the text and the client posts to /stream, so a
  // conversational turn keeps its streaming, its credit debit and its guards.
  app.post("/api/cli", async (c) => {
    const wallet = walletOf(c);
    if (!wallet) return unauthorized(c);
    const { line } = await body(c);
    if (typeof line !== "string") return c.json({ ok: false, lines: ["send a line."], effect: "none" }, 400);
    if (line.length > MAX_TEXT) return c.json({ ok: false, lines: ["that is too long for one line."], effect: "none" }, 400);
    const before = getAgentSettings(wallet);
    const routed = routeCli(line, before);
    switch (routed.effect.kind) {
      case "none":
      case "clear":
        return c.json({ ok: !routed.error, lines: routed.lines, effect: routed.effect.kind, ...(routed.suggest ? { suggest: routed.suggest } : {}) });
      case "chat":
        return c.json({ ok: true, lines: [], effect: "chat", text: routed.effect.text });
      case "settings": {
        const result = setAgentSettings(wallet, routed.effect.patch);
        if ("error" in result) return c.json({ ok: false, lines: [result.error], effect: "settings" });
        return c.json({ ok: true, lines: describeSettings(result.settings), effect: "settings", settings: result.settings });
      }
      case "desk":
        return c.json({ ok: true, lines: deskLines(routed.effect.command), effect: "desk" });
      case "read": {
        if (routed.effect.what === "settings") return c.json({ ok: true, lines: describeSettings(before), effect: "read" });
        const balance = balanceOf(wallet);
        const enforced = creditsEnforced();
        if (routed.effect.what === "credits") {
          return c.json({
            ok: true,
            effect: "read",
            lines: enforced
              ? [`${balance} credits`, ``, `  1 credit   one message to your advisor`, `  free       every /command, including the desk ones`, ``, balance > 0 ? `/packs shows what a top-up costs.` : `you are out. /packs shows what a top-up costs.`]
              : [`${balance} credits, but charging is OFF right now, so messages are free.`, ``, `nothing is being deducted and nothing is for sale until that changes.`, `the balance is real and will be there when it turns on.`],
          });
        }
        if (!enforced) return c.json({ ok: true, effect: "read", lines: [`nothing to buy: charging is off, so messages are free right now.`, `your ${balance} credits stay yours for when it turns on.`] });
        const rows = packs().map((p) => `  ${p.id.padEnd(9)} $${String(p.usd).padEnd(4)} ${p.credits} credits${p.bonusPct ? `  (+${p.bonusPct}%)` : ""}`);
        return c.json({ ok: true, effect: "read", lines: [`credit packs, priced in USDC:`, ``, ...rows, ``, `buying is not wired on this host yet; these are the prices it will charge.`] });
      }
    }
  });

  // ---- operator ---------------------------------------------------------------------------------
  const operator = (c: Context): Response | null => {
    const st = operatorOk(c);
    if (st === "unset") return c.json({ ok: false, error: "operator routes are not configured on this host" }, 503);
    if (st === "bad") return c.json({ ok: false, error: "operator token required" }, 401);
    return null;
  };

  app.get("/api/platform/ops", (c) => {
    const refused = operator(c);
    if (refused) return refused;
    const env = platformEnv();
    return c.json({ ok: true, configured: advisorConfigured(), model: env.userAgentModel, creditsEnforced: env.creditsEnforced, freeCredits: env.creditsFreeMessages, load: chatLoad(), spend: chatSpendStatus() });
  });

  app.post("/api/platform/credits/grant", async (c) => {
    const refused = operator(c);
    if (refused) return refused;
    const { address, credits, reason } = await body(c);
    const n = typeof credits === "number" ? Math.floor(credits) : NaN;
    if (typeof address !== "string" || !isAddress(address)) return c.json({ ok: false, error: "valid Solana address required" }, 400);
    if (!Number.isFinite(n) || n <= 0 || n > 100_000) return c.json({ ok: false, error: "credits must be a positive integer" }, 400);
    const balance = grantCredits(address, n, `operator:${typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 120) : "grant"}`);
    return c.json({ ok: true, address, name: agentDisplayName(address), balance });
  });
}
