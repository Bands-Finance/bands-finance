/**
 * The read-only look at his ClawPump account (docs/launch.md, "Before you arm anything"): what the platform holds
 * for his agent, and whether anything on ClawPump's side could launch his token without him.
 *
 * It calls ONLY the six tools in READONLY_UPSTREAM_TOOLS (src/launch/spec.ts), each checked against the server's own
 * readOnlyHint before it is called (src/launch/upstream.ts toolProblems), against the pinned install of
 * @clawpump/agents 0.1.27. No write tool of ClawPump's other 126 is reachable from here: a name off the allowlist
 * throws before the child hears of it. Output goes through redactDeep: no key, no bearer, no signed-URL query.
 *
 *   npm run launch:check                       the secrets file (~/.mrbands/clawpump.env), the pinned install
 *   npm run launch:check -- --repo-env         the key from the repo's .env, for before it is rotated into ~/.mrbands
 *   flags: --secrets-file <f> --install-dir <d> --entry <f> (an entry that must still hash to the pin) --json
 *          --repo-root <d> (which checkout's .env --repo-env reads; the default is this one, and a worktree has none)
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_INSTALL_DIR, DEFAULT_SECRETS_FILE, parseEnvFile, readSecrets } from "./files";
import { CLAWPUMP_AGENT_ID, CLAWPUMP_INDEX_SHA256, mintOf, READONLY_UPSTREAM_TOOLS, redactDeep, specProblems } from "./spec";
import { pinnedEntry, Upstream } from "./upstream";

/** Each allowlisted tool and the arguments it is called with. Nothing here takes a value from the command line. */
export const CHECK_CALLS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["get_launch_status", { agent_id: CLAWPUMP_AGENT_ID }],
  ["get_agent", { agent_id: CLAWPUMP_AGENT_ID }],
  ["list_automations", { agent_id: CLAWPUMP_AGENT_ID }],
  ["list_agent_runs", { agent_id: CLAWPUMP_AGENT_ID, limit: 20 }],
  ["get_wallet_summaries", {}],
  ["get_whitelist", { agent_id: CLAWPUMP_AGENT_ID }],
];

export interface CheckArgs {
  secretsFile: string;
  installDir: string;
  entry: string | null;
  repoEnv: boolean;
  json: boolean;
  /** with --repo-env, the checkout whose .env holds the key; null = this one */
  repoRoot: string | null;
}

export function parseCheckArgs(argv: string[]): CheckArgs {
  const o: CheckArgs = { secretsFile: DEFAULT_SECRETS_FILE, installDir: DEFAULT_INSTALL_DIR, entry: null, repoEnv: false, json: false, repoRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--repo-env") o.repoEnv = true;
    else if (a === "--json") o.json = true;
    else if (a === "--secrets-file") o.secretsFile = val();
    else if (a === "--install-dir") o.installDir = val();
    else if (a === "--entry") o.entry = val();
    else if (a === "--repo-root") o.repoRoot = val();
    else throw new Error(`unknown flag ${a}: --repo-env, --json, --secrets-file <f>, --install-dir <d>, --entry <f>, --repo-root <d>`);
  }
  return o;
}

/** The cpk_ key, from the secrets file or (--repo-env) from the repo's .env, read here and passed nowhere but the child's env. */
export function apiKeyFor(args: CheckArgs, repoRoot = path.join(__dirname, "..", "..")): string {
  if (!args.repoEnv) return readSecrets(args.secretsFile, false).apiKey;
  const file = path.join(args.repoRoot ?? repoRoot, ".env");
  const key = parseEnvFile(fs.readFileSync(file, "utf8")).CLAWPUMP_API_KEY ?? "";
  if (!key) throw new Error(`${file} has no CLAWPUMP_API_KEY`);
  return key;
}

/** What the answers say about launching without him. PURE. */
export function readiness(results: Record<string, unknown>): string[] {
  const out: string[] = [];
  const status = results.get_launch_status;
  const mint = mintOf(status);
  out.push(mint ? `A TOKEN ALREADY EXISTS for this agent: mint ${mint}. The bridge refuses to launch.` : "no token_mint yet: nothing is launched");
  const problems = specProblems(status);
  out.push(problems.length ? `the stored state does NOT match the pinned spec yet:\n    - ${problems.join("\n    - ")}` : "the stored state matches the pinned spec: a launch would send it");
  const autos = results.list_automations;
  const n = Array.isArray(autos) ? autos.length : Array.isArray((autos as { automations?: unknown[] })?.automations) ? (autos as { automations: unknown[] }).automations.length : null;
  out.push(n === null ? "list_automations did not return a list: read it above" : n === 0 ? "no automations on his ClawPump agent: nothing over there runs on its own" : `${n} AUTOMATION(S) on his ClawPump agent: read them above, and delete any that could launch`);
  const agent = (results.get_agent ?? {}) as Record<string, unknown>;
  const a = (agent.agent ?? agent) as Record<string, unknown>;
  if (a.status !== undefined) out.push(`ClawPump agent status ${JSON.stringify(a.status)} (it should be stopped until after the launch)`);
  if (a.is_public === true || a.accepting_bids === true) out.push(`the ClawPump agent is is_public ${a.is_public} / accepting_bids ${a.accepting_bids}: turn both off before it carries his token`);
  return out;
}

async function main(): Promise<void> {
  const args = parseCheckArgs(process.argv.slice(2));
  const entry = args.entry ?? pinnedEntry(args.installDir);
  const upstream = new Upstream({ entry, apiKey: apiKeyFor(args), allowed: READONLY_UPSTREAM_TOOLS, pinnedSha256: CLAWPUMP_INDEX_SHA256 });
  const results: Record<string, unknown> = {};
  try {
    await upstream.connect();
    console.log(`@clawpump/agents 0.1.27 (sha256 ${CLAWPUMP_INDEX_SHA256.slice(0, 12)}...), read-only tools only: ${[...READONLY_UPSTREAM_TOOLS].join(", ")}`);
    for (const [name, callArgs] of CHECK_CALLS) {
      const r = await upstream.call(name, callArgs, 60_000);
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.text);
      } catch {
        parsed = r.text;
      }
      results[name] = redactDeep(parsed);
      if (!args.json) console.log(`\n=== ${name} (isError=${r.isError})\n${JSON.stringify(results[name], null, 2).slice(0, 8000)}`);
    }
  } finally {
    await upstream.close();
  }
  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log("\n=== readiness");
  for (const line of readiness(results)) console.log(`  - ${line}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`launch:check: ${(err as Error).message}`);
    process.exit(1);
  });
}
