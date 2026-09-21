/**
 * A hard deadline on the desk's RPC. @solana/web3.js sends every JSON-RPC call through a plain fetch
 * with no signal, so a node that accepts the socket and then never answers holds the cycle forever:
 * nothing times it out, and the watchdog is left to judge a loop that is only waiting. Every other
 * network read on the cycle path (DexScreener, GeckoTerminal, Raydium, Orca, Meteora, Backpack,
 * Jupiter, LP Agent, OpenHermit) already carries its own deadline; this gives the RPC one.
 *
 *   rpcConnection(url)   a Connection whose every request aborts after RPC_TIMEOUT_MS (default 90 s)
 *   timedFetch(ms)       the fetch it uses, for tests and any other client that takes a fetch
 *
 * 90 s because the heaviest call the desk makes is the screener's getLbPairs (every DLMM pool on
 * chain, one reply of tens of megabytes): 16 s typical, 35 s at the 99th percentile in the logs.
 */
import { Connection, type ConnectionConfig } from "@solana/web3.js";

export const RPC_TIMEOUT_MS_DEFAULT = 90_000;

export function rpcTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.RPC_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : RPC_TIMEOUT_MS_DEFAULT;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A fetch that gives up after `ms`. A caller's own signal still works: whichever fires first aborts.
 * The rejection is always a plain Error that names the deadline, because web3.js only passes on
 * rejections that are `instanceof Error` and would otherwise leave the call pending for good.
 */
export function timedFetch(ms: number, base: FetchLike = (input, init) => fetch(input, init)): FetchLike {
  return async (input, init = {}) => {
    const deadline = AbortSignal.timeout(ms);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    try {
      return await base(input, { ...init, signal });
    } catch (err) {
      if (deadline.aborted) throw new Error(`request timed out after ${Math.round(ms / 1000)}s`);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };
}

/** The desk's Connection: "confirmed", with the deadline on every request. */
export function rpcConnection(url: string, env: NodeJS.ProcessEnv = process.env): Connection {
  return new Connection(url, { commitment: "confirmed", fetch: timedFetch(rpcTimeoutMs(env)) as unknown as ConnectionConfig["fetch"] });
}
