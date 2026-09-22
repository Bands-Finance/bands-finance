/**
 * $BANDS as it launches through ClawPump's MCP server (docs/launch.md). Decided 22 Sep: the launch goes through
 * @clawpump/agents 0.1.27's launch_metaplex_genesis_token (a Metaplex Genesis launch; its gasless tool refuses while
 * the platform reports gasless_available false), for the ClawPump platform agent below, knowingly accepting that
 * ClawPump keeps the creator wallet (75% of the creator fees accrue to that agent in ClawPump's custody) and that
 * the pair and any buyback are ClawPump's defaults: no MCP tool can set them.
 *
 * Everything that reaches ClawPump is fixed HERE, in code, not read at call time: the agent, the symbol, the
 * description, the first buy. The name, website and telegram cannot be sent at all (the platform takes them from
 * the launch metadata stored on its dashboard), so the bridge reads that stored metadata right before the call and
 * refuses unless it matches this spec exactly (specProblems). A launch happens once per agent and is irreversible.
 *
 * PURE: no I/O. src/launch/bridge.ts is the only caller that launches.
 */

/** The ClawPump platform agent the launch is for: the only agent on his key (created 22 Sep), CLAWPUMP_AGENT_ID in .env. */
export const CLAWPUMP_AGENT_ID = "64fd21e8-1d52-4a95-9c19-4db0069cbb4b";
/** That agent's custodial wallet on ClawPump: it pays for the launch, and ClawPump keeps its keys. */
export const CLAWPUMP_AGENT_WALLET = "4HQdS1HqnumqLqJT81tdUtf969Xa6cTo9jc1mEadxYyE";

export const TOKEN_NAME = "Mr Bands";
export const TOKEN_SYMBOL = "BANDS";
/** TOKEN_DESCRIPTION in ops/live.env, byte for byte (src/scripts/test-token-bridge.ts holds the two together). It names no site. */
export const TOKEN_DESCRIPTION =
  "Mr Bands is an autonomous AI market maker on Solana. He provides liquidity on Meteora and learns from every trade. His own token, not a share: it pays holders nothing.";
/** No first buy: nobody, him included, starts with a bag. Sent as 0 in so many words. */
export const FIRST_BUY_SOL = 0;
/** His X account. The launch sends it only when the bridge's config asks (LAUNCH_TWITTER); the stored metadata may carry it. */
export const TWITTER_HANDLE = "MrBandsSol";

/** The site's domains, which nothing in the token may carry yet (Zach, 22 Sep). "bands.finance" also covers mrbands.finance. */
export const SITE_DOMAINS: readonly string[] = ["bands.finance", "mrbands.finance"];

/** The ClawPump package the bridge spawns, pinned: version and the sha256 of dist/index.js as read before use. */
export const CLAWPUMP_PACKAGE = "@clawpump/agents";
export const CLAWPUMP_VERSION = "0.1.27";
export const CLAWPUMP_SERVER_NAME = "clawpump-agents";
export const CLAWPUMP_INDEX_SHA256 = "375e2ba4bfe9c1c8a7e2b329277a571d210af650fa97ae5e9585aa9708e56fc4";

/** The two upstream tools the bridge may call. Nothing else of ClawPump's 132 is reachable through it. */
export const UPSTREAM_STATUS_TOOL = "get_launch_status";
export const UPSTREAM_LAUNCH_TOOL = "launch_metaplex_genesis_token";
export const BRIDGE_UPSTREAM_TOOLS: ReadonlySet<string> = new Set([UPSTREAM_STATUS_TOOL, UPSTREAM_LAUNCH_TOOL]);
/** The read-only tools the check script may call (each is also checked for readOnlyHint before the call). */
export const READONLY_UPSTREAM_TOOLS: ReadonlySet<string> = new Set([
  "get_launch_status",
  "get_agent",
  "list_automations",
  "list_agent_runs",
  "get_wallet_summaries",
  "get_whitelist",
]);
/** launch_metaplex_genesis_token's input properties in 0.1.27. A different set means the package changed: refuse. */
export const LAUNCH_TOOL_PROPERTIES: readonly string[] = ["agent_id", "confirm_launch", "symbol", "description", "image_url", "twitter", "first_buy_amount_sol"];

/** The bridge's two tools, named outside bands_* so the talk loop's tripwire voids any X-mention turn that calls one. */
export const BRIDGE_STATUS_TOOL = "token_launch_status";
export const BRIDGE_LAUNCH_TOOL = "token_launch";

/** What the bridge's config may add to the call. Both are omitted unless set (the default). */
export interface LaunchConfig {
  /** an https image not on the site's domain; omitted = ClawPump uses the stored launch image or the avatar */
  imageUrl?: string;
  /** his X handle, exactly TWITTER_HANDLE; omitted = the stored metadata stands */
  twitter?: string;
}

/** True when a string names the site's domains anywhere (any case). */
export function namesSite(text: string): boolean {
  const t = text.toLowerCase();
  return SITE_DOMAINS.some((d) => t.includes(d));
}

/** The config, checked. Throws on a value the launch must never carry. */
export function checkLaunchConfig(cfg: LaunchConfig): LaunchConfig {
  const out: LaunchConfig = {};
  if (cfg.imageUrl !== undefined && cfg.imageUrl !== "") {
    let u: URL;
    try {
      u = new URL(cfg.imageUrl);
    } catch {
      throw new Error("LAUNCH_IMAGE_URL is not a URL");
    }
    if (u.protocol !== "https:") throw new Error("LAUNCH_IMAGE_URL must be https");
    if (namesSite(cfg.imageUrl)) throw new Error("LAUNCH_IMAGE_URL is on the site's domain: the token is not linked to the site yet (Zach, 22 Sep)");
    if (u.search || u.hash) throw new Error("LAUNCH_IMAGE_URL carries a query or fragment: use a plain, permanent URL");
    out.imageUrl = cfg.imageUrl;
  }
  if (cfg.twitter !== undefined && cfg.twitter !== "") {
    if (cfg.twitter !== TWITTER_HANDLE) throw new Error(`LAUNCH_TWITTER must be exactly ${TWITTER_HANDLE} (a handle, as the tool asks), or unset`);
    out.twitter = cfg.twitter;
  }
  return out;
}

/**
 * The upstream call's arguments, exactly. Key order is fixed so the audit shows the same bytes every time.
 * confirm_launch is the upstream schema's own literal; the spec never comes from the model.
 */
export function launchArguments(cfg: LaunchConfig): Record<string, unknown> {
  const c = checkLaunchConfig(cfg);
  return {
    agent_id: CLAWPUMP_AGENT_ID,
    confirm_launch: true,
    symbol: TOKEN_SYMBOL,
    description: TOKEN_DESCRIPTION,
    ...(c.imageUrl ? { image_url: c.imageUrl } : {}),
    ...(c.twitter ? { twitter: c.twitter } : {}),
    first_buy_amount_sol: FIRST_BUY_SOL,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(stripUrlQueries(v).slice(0, 80)) : JSON.stringify(v));

/** The stored twitter values that are his: empty, the handle, @handle, or his x.com / twitter.com profile URL. */
export function isHisTwitter(v: unknown): boolean {
  if (empty(v)) return true;
  if (typeof v !== "string") return false;
  return new RegExp(`^(?:https?://(?:www\\.)?(?:x|twitter)\\.com/|@)?${TWITTER_HANDLE}/?$`, "i").test(v.trim());
}

/** The mint get_launch_status reports, or null. */
export function mintOf(status: unknown): string | null {
  if (!isObj(status)) return null;
  const m = status.token_mint ?? (isObj(status.agent) ? status.agent.token_mint : undefined);
  return typeof m === "string" && m.trim() ? m.trim() : null;
}

/**
 * Why the stored state is not the one to launch from; empty when everything matches. Reads what get_launch_status
 * returns ({agent, metadata, funding, already_launched, token_mint}). Refuses on: a mint (one token per agent); the
 * wrong agent wallet; a stored name, symbol or description that is not the spec; a website, telegram or any other
 * link field that is filled in; a stored twitter that is not his; the site's domain anywhere in the metadata or the
 * image the launch would fall back to; no image at all; and a custodial wallet that cannot pay.
 */
export function specProblems(status: unknown, cfg: LaunchConfig = {}): string[] {
  const p: string[] = [];
  if (!isObj(status)) return ["the launch status is not an object"];
  const mint = mintOf(status);
  if (mint) p.push(`a token is already launched for this agent (mint ${mint}): one token per agent`);
  if (status.already_launched === true && !mint) p.push("the status says already_launched");
  const agent = isObj(status.agent) ? status.agent : null;
  if (!agent) p.push("the status carries no agent");
  else if (agent.wallet_address !== CLAWPUMP_AGENT_WALLET) p.push(`the agent wallet is ${show(agent.wallet_address)}, not ${CLAWPUMP_AGENT_WALLET}: the wrong ClawPump agent`);

  const md = isObj(status.metadata) ? status.metadata : null;
  if (!md) {
    p.push("the status carries no launch metadata");
  } else {
    if (md.name !== TOKEN_NAME) p.push(`stored name is ${show(md.name)}, not ${JSON.stringify(TOKEN_NAME)} (fix it on the ClawPump dashboard)`);
    if (md.symbol !== TOKEN_SYMBOL) p.push(`stored symbol is ${show(md.symbol)}, not ${JSON.stringify(TOKEN_SYMBOL)} (fix it on the ClawPump dashboard)`);
    if (md.description !== TOKEN_DESCRIPTION) p.push("stored description is not TOKEN_DESCRIPTION exactly (fix it on the ClawPump dashboard)");
    for (const [k, v] of Object.entries(md)) {
      if (/web|site|telegram|discord|link/i.test(k) && !empty(v)) p.push(`stored ${k} is filled in (${show(v)}): it must be empty`);
    }
    if (!isHisTwitter(md.twitter)) p.push(`stored twitter is ${show(md.twitter)}, not his (@${TWITTER_HANDLE}) or empty`);
    if (namesSite(JSON.stringify(md))) p.push("the stored metadata names the site's domain (bands.finance / mrbands.finance): the token is not linked to the site yet");
  }
  const fallbackImage = cfg.imageUrl || (md && typeof md.imageUrl === "string" && md.imageUrl) || (agent && typeof agent.avatar_url === "string" && agent.avatar_url) || "";
  if (!fallbackImage) p.push("no image: none configured, none stored, no avatar");
  else if (namesSite(fallbackImage)) p.push("the image the launch would use is on the site's domain");
  if (cfg.twitter !== undefined && cfg.twitter !== TWITTER_HANDLE) p.push("the configured twitter is not his handle");

  const f = isObj(status.funding) ? status.funding : null;
  if (!f) p.push("the status carries no funding block");
  else {
    const bal = Number(f.agent_wallet_balance_sol);
    const cost = Number(f.self_funded_cost_sol);
    if (f.can_self_fund !== true) p.push(`the custodial wallet cannot pay (can_self_fund ${show(f.can_self_fund)}, balance ${show(f.agent_wallet_balance_sol)} SOL): fund ${CLAWPUMP_AGENT_WALLET}`);
    else if (!Number.isFinite(bal) || !Number.isFinite(cost) || bal < cost) p.push(`the custodial wallet holds ${show(f.agent_wallet_balance_sol)} SOL against a cost of ${show(f.self_funded_cost_sol)} SOL`);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// redaction: what leaves the bridge (to the gateway, the audit, the log) never carries a key or a signed URL
// ---------------------------------------------------------------------------------------------

/** Every URL's query string and fragment removed: signed image URLs carry download tokens there. */
export function stripUrlQueries(s: string): string {
  return s.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1");
}

const SENSITIVE_KEY = /(secret|private|priv_?key|api_?key|apikey|(?<!launch_)token(?!_mint|_launch|_address|Address|Mint|_symbol|_name)|password|passwd|seed|mnemonic|credential|bearer|authorization|cookie|session|encrypted|cipher|jwt|refresh|access_?key|signing)/i;
const EMAIL = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** One string, redacted: a cpk_ key, a JWT, a secret-key-shaped base58 or byte array, the given secrets, URL queries, email local parts. */
export function redactString(s: string, secrets: readonly string[] = []): string {
  let out = stripUrlQueries(s);
  for (const sec of secrets) if (sec && sec.length >= 8) out = out.split(sec).join(`<redacted len=${sec.length}>`);
  out = out.replace(/cpk_[A-Za-z0-9_-]{8,}/g, (m) => `<redacted cpk len=${m.length}>`);
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, (m) => `<redacted jwt len=${m.length}>`);
  out = out.replace(/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, (m) => `<redacted base58-secret-like len=${m.length}>`);
  out = out.replace(/\[\s*\d+(\s*,\s*\d+){31,}\s*\]/g, (m) => `<redacted byte-array len=${m.length}>`);
  return out.replace(EMAIL, (_m, _u, d) => `<email @${d}>`);
}

/** A parsed value, redacted deep: sensitive-looking keys become their length, strings go through redactString. */
export function redactDeep(v: unknown, secrets: readonly string[] = [], key = ""): unknown {
  if (key && SENSITIVE_KEY.test(key) && v !== null && v !== undefined && typeof v !== "boolean") {
    if (typeof v === "string") return `<redacted ${key} len=${v.length}>`;
    if (typeof v === "number") return `<redacted ${key} number>`;
    return `<redacted ${key} ${Array.isArray(v) ? "array" : "object"}>`;
  }
  if (typeof v === "string") return redactString(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, secrets));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, secrets, k)]));
  return v;
}
