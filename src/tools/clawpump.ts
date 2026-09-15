/**
 * ClawPump: the launchpad the AnsemHack Clawrena entry runs through (docs/clawrena.md). The token IS
 * the entry, so the desk can launch its own token here and read what it earns.
 *
 * Endpoints (https://clawpump.tech/developers, read 2026-09-15):
 *   GET  /api/agents/{agentId}/earnings              public: totalEarned, totalSent, totalPending, totalHeld, recentDistributions
 *   GET  /api/v1/agents/{agentId}                    key: the agent record; `tokenAddress` is the linked mint (or null)
 *   GET  /api/v1/pump-pairs                          key: pump.fun creation pairs and the creator-fee range
 *   GET  /api/v1/launch/self-funded                  key: cost discovery (creationFeeSol, payTo, quoteValidForSeconds)
 *   POST /api/v1/launch/self-funded {preflight:true} key: a payment quote {payment: {amountLamports, payTo, validForSeconds}, retryWith: {preflightToken}}
 *   POST /api/v1/launch/self-funded {txSignature, preflightToken} key: completes the launch -> {status, mintAddress, txHash, pumpUrl}
 * Auth: `Authorization: Bearer cpk_...` from https://clawpump.tech/dashboard/api. Server-side only.
 * Timeouts: the docs ask for >= 120 s on /launch. Writes are never retried blind; the self-funded
 * completion is idempotent on txSignature, so a repeat with the same signature is safe.
 *
 * Env: CLAWPUMP_AGENT_ID (the Mr Bands agent on ClawPump), CLAWPUMP_API_KEY (never in git or chat),
 * CLAWPUMP_API_URL (default https://clawpump.tech). The token's own fields: TOKEN_NAME, TOKEN_SYMBOL,
 * TOKEN_DESCRIPTION (20+ characters), TOKEN_IMAGE_URL (https), TOKEN_DEV_BUY_SOL (default 0),
 * TOKEN_PUMP_PAIR (the pump.fun creation pair: SOL by default; the Clawrena entry is paired with NVDA,
 * so "NVDAx", "NVDA" or the mint, resolved against ClawPump's live catalogue) and TOKEN_CREATOR_FEE_BPS
 * (100-300, custom pairs only; pump.fun does not allow it on the SOL pair).
 */

export const CLAWPUMP_URL_DEFAULT = "https://clawpump.tech";
/** the docs' minimum client timeout for /launch and /chat */
export const LAUNCH_TIMEOUT_MS = 120_000;
export const READ_TIMEOUT_MS = 30_000;
export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface ClawPumpEnv {
  baseUrl: string;
  agentId: string | null;
  apiKey: string | null;
}

export function clawpumpEnv(env: NodeJS.ProcessEnv = process.env): ClawPumpEnv {
  const url = (env.CLAWPUMP_API_URL ?? "").trim().replace(/\/+$/, "");
  const agentId = (env.CLAWPUMP_AGENT_ID ?? "").trim();
  const apiKey = (env.CLAWPUMP_API_KEY ?? "").trim();
  return { baseUrl: url || CLAWPUMP_URL_DEFAULT, agentId: agentId || null, apiKey: apiKey || null };
}

/** The token as the launch call wants it. Throws on anything ClawPump would refuse, before any call. */
export interface TokenSpec {
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  devBuySol: number;
  /** the pump.fun creation pair as asked for: "SOL" (default), a symbol ("NVDAx", "NVDA") or a mint */
  pumpPair: string;
  /** creator fee on a custom pair, bps (100-300); null = the catalogue's default */
  creatorFeeBps: number | null;
}

export function tokenSpec(env: NodeJS.ProcessEnv = process.env): TokenSpec {
  const name = (env.TOKEN_NAME ?? "").trim();
  const symbol = (env.TOKEN_SYMBOL ?? "").trim().toUpperCase();
  const description = (env.TOKEN_DESCRIPTION ?? "").trim();
  const imageUrl = (env.TOKEN_IMAGE_URL ?? "").trim();
  const devBuySol = Number((env.TOKEN_DEV_BUY_SOL ?? "0").trim() || "0");
  const pumpPair = (env.TOKEN_PUMP_PAIR ?? "").trim() || "SOL";
  const feeRaw = (env.TOKEN_CREATOR_FEE_BPS ?? "").trim();
  const creatorFeeBps = feeRaw === "" ? null : Number(feeRaw);
  const faults: string[] = [];
  if (creatorFeeBps !== null && !(Number.isInteger(creatorFeeBps) && creatorFeeBps >= 100 && creatorFeeBps <= 300)) faults.push(`TOKEN_CREATOR_FEE_BPS "${feeRaw}" must be a whole number from 100 to 300`);
  if (creatorFeeBps !== null && isSolPair(pumpPair)) faults.push("TOKEN_CREATOR_FEE_BPS cannot be set on the SOL pair (pump.fun does not allow it)");
  if (!name) faults.push("TOKEN_NAME is empty");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) faults.push(`TOKEN_SYMBOL "${symbol}" must be 1-10 letters or digits`);
  if (description.length < 20) faults.push(`TOKEN_DESCRIPTION must be at least 20 characters (${description.length})`);
  if (!/^https:\/\/\S+$/.test(imageUrl)) faults.push("TOKEN_IMAGE_URL must be an https URL");
  if (!Number.isFinite(devBuySol) || devBuySol < 0) faults.push(`TOKEN_DEV_BUY_SOL "${env.TOKEN_DEV_BUY_SOL}" must be a non-negative number`);
  if (faults.length) throw new Error(`token spec: ${faults.join("; ")}`);
  return { name, symbol, description, imageUrl, devBuySol, pumpPair, creatorFeeBps };
}

/** "SOL", "wSOL" or the wrapped SOL mint: the standard pump.fun pair. */
export const isSolPair = (want: string): boolean => {
  const w = want.trim();
  return w === SOL_MINT || ["SOL", "WSOL"].includes(w.toUpperCase());
};

/**
 * PURE. The catalogue entry the token will be paired with, or a refusal that lists what IS offered.
 * Matches the mint exactly, else the symbol case-insensitively, else an xStock's ticker ("NVDA" finds
 * "NVDAx"). The SOL pair needs no entry.
 */
export function resolvePumpPair(assets: readonly PumpPair[], want: string): { ok: true; asset: PumpPair | null } | { ok: false; reason: string } {
  if (isSolPair(want)) return { ok: true, asset: null };
  const w = want.trim();
  const byMint = assets.find((a) => a.mint === w);
  if (byMint) return { ok: true, asset: byMint };
  const up = w.toUpperCase();
  const bySymbol = assets.find((a) => a.symbol.toUpperCase() === up) ?? assets.find((a) => /^[A-Za-z.]{1,6}x$/.test(a.symbol) && a.symbol.slice(0, -1).toUpperCase() === up.replace(/X$/, ""));
  if (bySymbol) return { ok: true, asset: bySymbol };
  const offered = assets.map((a) => a.symbol).filter(Boolean).join(", ") || "none";
  return { ok: false, reason: `"${w}" is not a pump.fun creation pair on ClawPump today (offered: ${offered})` };
}

export interface Earnings {
  totalEarned: number;
  totalSent: number;
  totalPending: number;
  totalHeld: number;
  recentDistributions: unknown[];
}

export interface AgentRecord {
  id: string;
  name: string;
  status: string | null;
  walletAddress: string | null;
  /** the linked token's mint (Solana) or contract, null when no token is linked */
  tokenAddress: string | null;
  isPublic: boolean | null;
  createdAt: string | null;
}

export interface PumpPair {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface LaunchQuote {
  amountLamports: number;
  amountSol: number;
  payTo: string;
  payFrom: string | null;
  validForSeconds: number;
  creationFeeSol: number | null;
  devBuySol: number | null;
  preflightToken: string;
  requestId: string | null;
}

export interface LaunchResult {
  status: string;
  mintAddress: string;
  txHash: string | null;
  pumpUrl: string | null;
  explorerUrl: string | null;
  idempotent: boolean;
  requestId: string | null;
}

export interface LaunchRequest {
  agentId: string;
  agentName: string;
  walletAddress: string;
  token: TokenSpec;
  /** the pump.fun creation pair; omitted = the standard SOL pair */
  pumpQuoteMint?: string;
  /** 100-300, custom pairs only (pump.fun does not allow it on the SOL pair) */
  pumpCreatorFeeBps?: number;
}

export class ClawPumpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId: string | null,
    readonly body: string,
  ) {
    super(message);
    this.name = "ClawPumpError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x : null);
const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The launch body as the partner API wants it (the same fields on preflight and completion). */
export function launchBody(r: LaunchRequest, extra: { preflight?: true; txSignature?: string; preflightToken?: string } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: r.token.name,
    symbol: r.token.symbol,
    description: r.token.description,
    imageUrl: r.token.imageUrl,
    agentId: r.agentId,
    agentName: r.agentName,
    walletAddress: r.walletAddress,
    devBuySol: r.token.devBuySol,
  };
  if (r.pumpQuoteMint && r.pumpQuoteMint !== SOL_MINT) {
    body.pumpQuoteMint = r.pumpQuoteMint;
    if (r.pumpCreatorFeeBps !== undefined) body.pumpCreatorFeeBps = r.pumpCreatorFeeBps;
  }
  if (extra.preflight) body.preflight = true;
  if (extra.txSignature) body.txSignature = extra.txSignature;
  if (extra.preflightToken) body.preflightToken = extra.preflightToken;
  return body;
}

export class ClawPumpClient {
  private readonly fetchImpl: FetchLike;
  readonly baseUrl: string;
  readonly apiKey: string | null;

  constructor(opts: { baseUrl?: string; apiKey?: string | null; fetch?: FetchLike } = {}) {
    this.baseUrl = (opts.baseUrl ?? CLAWPUMP_URL_DEFAULT).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? null;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(method: "GET" | "POST", path: string, o: { body?: unknown; auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
    if (o.auth && !this.apiKey) throw new Error(`${method} ${path} needs CLAWPUMP_API_KEY (a cpk_ key from https://clawpump.tech/dashboard/api)`);
    const headers: Record<string, string> = { accept: "application/json" };
    if (o.auth) headers.authorization = `Bearer ${this.apiKey}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: AbortSignal.timeout(o.timeoutMs ?? READ_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const requestId = str(obj(obj(parsed).meta).requestId);
    if (!res.ok) {
      const detail = str(obj(parsed).error) ?? str(obj(parsed).message) ?? text.slice(0, 200);
      throw new ClawPumpError(`ClawPump ${method} ${path} -> HTTP ${res.status}${detail ? `: ${detail}` : ""}${requestId ? ` (request ${requestId})` : ""}`, res.status, requestId, text);
    }
    return parsed as T;
  }

  /** Public: what the agent's token has earned it so far. */
  async earnings(agentId: string): Promise<Earnings> {
    const r = obj(await this.request<unknown>("GET", `/api/agents/${encodeURIComponent(agentId)}/earnings`));
    return {
      totalEarned: num(r.totalEarned) ?? 0,
      totalSent: num(r.totalSent) ?? 0,
      totalPending: num(r.totalPending) ?? 0,
      totalHeld: num(r.totalHeld) ?? 0,
      recentDistributions: Array.isArray(r.recentDistributions) ? r.recentDistributions : [],
    };
  }

  /** The agent record; `tokenAddress` is the mint once a token is linked. */
  async agent(agentId: string): Promise<AgentRecord> {
    const r = obj(await this.request<unknown>("GET", `/api/v1/agents/${encodeURIComponent(agentId)}`, { auth: true }));
    return {
      id: str(r.id) ?? agentId,
      name: str(r.name) ?? "",
      status: str(r.status),
      walletAddress: str(r.walletAddress),
      tokenAddress: str(r.tokenAddress),
      isPublic: typeof r.isPublic === "boolean" ? r.isPublic : null,
      createdAt: str(r.createdAt),
    };
  }

  async pumpPairs(): Promise<{ assets: PumpPair[]; creatorFeeBps: { min: number; max: number; default: number } }> {
    const r = obj(await this.request<unknown>("GET", "/api/v1/pump-pairs", { auth: true }));
    const fee = obj(r.creatorFeeBps);
    return {
      assets: (Array.isArray(r.assets) ? r.assets : []).map((a) => {
        const x = obj(a);
        return { mint: str(x.mint) ?? "", symbol: str(x.symbol) ?? "", name: str(x.name) ?? "", decimals: num(x.decimals) ?? 6 };
      }),
      creatorFeeBps: { min: num(fee.min) ?? 100, max: num(fee.max) ?? 300, default: num(fee.default) ?? 100 },
    };
  }

  /** Cost discovery for a self-funded launch: what a launch costs today and who is paid. */
  async selfFundedCost(): Promise<{ creationFeeSol: number | null; payTo: string | null; quoteValidForSeconds: number | null; standardCostSol: number | null }> {
    const r = obj(await this.request<unknown>("GET", "/api/v1/launch/self-funded", { auth: true }));
    return { creationFeeSol: num(r.creationFeeSol), payTo: str(r.payTo), quoteValidForSeconds: num(r.quoteValidForSeconds), standardCostSol: num(r.standardCostSol) };
  }

  /** Step 1 of a self-funded launch: the payment quote. Nothing is minted; nothing is paid. */
  async launchPreflight(r: LaunchRequest): Promise<LaunchQuote> {
    const res = obj(await this.request<unknown>("POST", "/api/v1/launch/self-funded", { auth: true, body: launchBody(r, { preflight: true }), timeoutMs: LAUNCH_TIMEOUT_MS }));
    const p = obj(res.payment);
    const retry = obj(res.retryWith);
    const breakdown = obj(p.breakdown);
    const token = str(retry.preflightToken);
    const payTo = str(p.payTo);
    const lamports = num(p.amountLamports);
    if (!token || !payTo || lamports === null) throw new Error(`ClawPump preflight answered without a payment quote: ${JSON.stringify(res).slice(0, 300)}`);
    return {
      amountLamports: lamports,
      amountSol: num(p.amountSol) ?? lamports / 1e9,
      payTo,
      payFrom: str(p.payFrom),
      validForSeconds: num(p.validForSeconds) ?? 900,
      creationFeeSol: num(breakdown.creationFeeSol),
      devBuySol: num(breakdown.devBuySol),
      preflightToken: token,
      requestId: str(obj(res.meta).requestId),
    };
  }

  /** Step 3: the same request with the proof of payment. Idempotent on txSignature. */
  async launchComplete(r: LaunchRequest, txSignature: string, preflightToken: string): Promise<LaunchResult> {
    const res = obj(await this.request<unknown>("POST", "/api/v1/launch/self-funded", { auth: true, body: launchBody(r, { txSignature, preflightToken }), timeoutMs: LAUNCH_TIMEOUT_MS }));
    const mint = str(res.mintAddress);
    if (!mint) throw new Error(`ClawPump launch answered without a mint: ${JSON.stringify(res).slice(0, 300)}`);
    return {
      status: str(res.status) ?? "launched",
      mintAddress: mint,
      txHash: str(res.txHash),
      pumpUrl: str(res.pumpUrl),
      explorerUrl: str(res.explorerUrl),
      idempotent: res.idempotent === true,
      requestId: str(obj(res.meta).requestId),
    };
  }
}

/**
 * The gate on actually launching: the desk's own SOL leaves the wallet, and a token appears with
 * Mr Bands' name on it. All three must hold, and Zach says go in words first (docs/clawrena.md).
 */
export function launchRefusal(o: { dryRun: boolean; confirm: boolean; apiKey: string | null; agentId: string | null; ephemeralWallet: boolean }): string | null {
  if (!o.agentId) return "CLAWPUMP_AGENT_ID is not set";
  if (!o.apiKey) return "CLAWPUMP_API_KEY is not set (a cpk_ key from https://clawpump.tech/dashboard/api)";
  if (o.ephemeralWallet) return "no WALLET_SECRET_KEY: the launch fee must come from the desk's own wallet";
  if (o.dryRun) return "DRY_RUN is on: the wallet will not send the launch fee (set DRY_RUN=false for this command only, with Zach's go)";
  if (!o.confirm) return "pass --confirm to send the launch fee and mint the token";
  return null;
}
