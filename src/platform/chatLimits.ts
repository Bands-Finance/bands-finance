/**
 * Backpressure + fairness for the advisor chat routes. Ports Meridian's agent/src/chatLimits.ts.
 * Three independent guards, applied in order to /api/my-agent/message and /stream:
 *
 *   per-wallet token bucket   one wallet cannot spam the model (5 burst, +1 every 3s)
 *   per-wallet single-flight  one in-flight turn per wallet at a time
 *   global concurrency slot   cap simultaneous model turns; overflow WAITS briefly for a slot
 *
 * All in-memory, per process, on purpose: these shape load, they do not bound spend. The thing that
 * bounds spend is spendGuards.ts, which folds the ledger. Knobs are read from platformEnv() at call
 * time (CHAT_RATE_BURST, CHAT_RATE_REFILL_MS, CHAT_CONCURRENCY, CHAT_ACQUIRE_TIMEOUT_MS).
 */
import { platformEnv } from "./config";

/** How long an SSE turn may go with NO event from the model before the route gives up on it. */
export function streamIdleTimeoutMs(): number {
  return platformEnv().streamIdleTimeoutMs;
}

// ---- per-wallet token bucket -------------------------------------------------------------------
const buckets = new Map<string, { tokens: number; last: number }>();

/** Consume one token; false = rate-limited (too many messages too fast). */
export function rateLimitOk(address: string): boolean {
  const { chatRateBurst: burst, chatRateRefillMs: refillMs } = platformEnv();
  const now = Date.now();
  const b = buckets.get(address) ?? { tokens: burst, last: now };
  const refill = Math.floor((now - b.last) / refillMs);
  if (refill > 0) {
    b.tokens = Math.min(burst, b.tokens + refill);
    b.last = now;
  }
  if (b.tokens <= 0) {
    buckets.set(address, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(address, b);
  // Opportunistic prune so the map cannot grow unbounded across many wallets.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.tokens >= burst && now - v.last > 10 * 60_000) buckets.delete(k);
  }
  return true;
}

// ---- per-wallet single-flight ------------------------------------------------------------------
const inFlight = new Set<string>();

/** Reserve this wallet's single turn slot; false = a turn is already running. */
export function tryBeginTurn(address: string): boolean {
  if (inFlight.has(address)) return false;
  inFlight.add(address);
  return true;
}
export function endTurn(address: string): void {
  inFlight.delete(address);
}

// ---- global concurrency semaphore --------------------------------------------------------------
let active = 0;
const waiters: Array<{ resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }> = [];

/**
 * Acquire a global model slot. Resolves true immediately if under the cap, else waits up to
 * `timeoutMs` for one to free (false if none does). A freed slot is handed directly to the next
 * waiter, so the cap is never exceeded.
 */
export function acquireSlot(timeoutMs = platformEnv().chatAcquireTimeoutMs): Promise<boolean> {
  if (active < platformEnv().chatConcurrency) {
    active += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const i = waiters.findIndex((w) => w.resolve === resolve);
      if (i >= 0) waiters.splice(i, 1);
      resolve(false);
    }, timeoutMs);
    waiters.push({ resolve, timer });
  });
}

/** Release a slot: hand it to the next waiter, or drop the active count. */
export function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(true);
  } else {
    active = Math.max(0, active - 1);
  }
}

/** Snapshot for observability. */
export function chatLoad(): { active: number; queued: number; max: number } {
  return { active, queued: waiters.length, max: platformEnv().chatConcurrency };
}

/** Tests only: forget every bucket and lock. */
export function resetChatLimits(): void {
  buckets.clear();
  inFlight.clear();
}
