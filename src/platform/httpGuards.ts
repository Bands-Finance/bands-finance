/**
 * HTTP guards as Hono middleware. Ports Meridian's agent/src/httpGuards.ts (Express) to Hono.
 *
 *   securityHeaders   nosniff / DENY / no-referrer / HSTS on every response it wraps
 *   globalRateLimit   per-IP token bucket, one bucket per (route key, IP); skips /api/health
 *   authRateLimit     strict per-IP bucket for the unauthenticated, CPU-heavy sign-in routes
 *   routeKey          the accounting key for a path: a known prefix or "other", bounded by construction
 *
 * Bucket keys come from routeKey(path), never from the raw path, so the map cannot be grown without
 * limit by asking for random URLs. Client IP is the first X-Forwarded-For hop when a proxy set one,
 * else the socket address; a request with neither (tests via app.request) counts as one client.
 * CORS is the integrator's (src/server.ts); nothing here touches it.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { platformEnv } from "./config";

/** Security headers, set by hand rather than pulling in helmet: this is a JSON API (no HTML), so
 *  CSP is moot, and these are the headers that actually matter for an API surface. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
};

export function clientIp(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

type Bucket = { tokens: number; last: number };

/**
 * Per-IP token bucket keyed by routeKey. The global limiter is generous on purpose (it must never
 * throttle the desk's own polling, only stop a flood); the auth limiter is strict because sign-in
 * and signature verification are expensive and never happen dozens of times a minute for a real user.
 */
export function makeLimiter(maxPerMin: number, keyOf: (c: Context) => string = (c) => `${routeKey(c.req.path)}|${clientIp(c)}`): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const refillPerMs = maxPerMin / 60_000;
  let lastSweep = Date.now();
  return async (c, next) => {
    const now = Date.now();
    const key = keyOf(c);
    const b = buckets.get(key) ?? { tokens: maxPerMin, last: now };
    b.tokens = Math.min(maxPerMin, b.tokens + (now - b.last) * refillPerMs);
    b.last = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      c.header("Retry-After", "5");
      return c.json({ ok: false, error: "rate limit exceeded, slow down" }, 429);
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (now - lastSweep > 5 * 60_000) {
      lastSweep = now;
      for (const [k, v] of buckets) if (now - v.last > 10 * 60_000) buckets.delete(k);
    }
    await next();
  };
}

const globalLimiter = makeLimiter(platformEnv().globalRatePerMin);

/** Global flood guard (skips /api/health so an uptime probe is never throttled). */
export const globalRateLimit: MiddlewareHandler = async (c, next) => {
  if (c.req.path === "/api/health") return next();
  return globalLimiter(c, next);
};

/** Strict guard for the unauthenticated, CPU-heavy auth routes. */
export const authRateLimit: MiddlewareHandler = makeLimiter(platformEnv().authRatePerMin, (c) => `auth|${clientIp(c)}`);

/** The route prefixes this server serves, as the first one or two path segments. */
const KNOWN_ROUTES = new Set([
  "/mcp",
  "/api/health",
  "/api/journal",
  "/api/limits",
  "/api/screen",
  "/api/feed.md",
  "/api/account",
  "/api/my-agent",
  "/api/cli",
  "/api/platform",
  "/api/rails",
  "/api/credits",
]);

export const OTHER_ROUTE_KEY = "other";

/** The accounting key for a request path: a known prefix, or "other". Bounded by construction. */
export function routeKey(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) return OTHER_ROUTE_KEY;
  const two = "/" + segments.slice(0, 2).join("/");
  if (KNOWN_ROUTES.has(two)) return two;
  const one = "/" + segments[0];
  return KNOWN_ROUTES.has(one) ? one : OTHER_ROUTE_KEY;
}

/** How many distinct keys routeKey can ever produce. */
export const ROUTE_KEY_LIMIT = KNOWN_ROUTES.size + 1;
