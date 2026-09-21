/**
 * The halts (src/risk/state.ts killSwitchSources) and the preflight's levels (src/lib/preflightLevels.ts):
 * the root STOP halts every desk, DATA_DIR/STOP halts one, KILL_SWITCH=true halts whoever carries it, and
 * a dry-run desk is never refused a boot over what only a signature would care about. Temp directories
 * only; no RPC, no model, no gateway.
 *   npx tsx src/scripts/test-halts.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Everything that reads src/config.ts is imported after the environment is pinned.
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
process.env.DATA_DIR = "data-test-halts";
delete process.env.KILL_SWITCH;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.log(`FAIL  ${name}\n      ${(err as Error).message.split("\n").join("\n      ")}`);
  }
}

async function main(): Promise<void> {
  const { describeHalt, killSwitchActive, killSwitchSources } = await import("../risk/state.js");
  const { expectedWalletLevel, haltLevel, modelRow } = await import("../lib/preflightLevels.js");

  // a repo root with two desks in it, the way mr-bands runs data-live and data-mainnet side by side
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bands-halts-"));
  fs.mkdirSync(path.join(root, "data-live"));
  fs.mkdirSync(path.join(root, "data-mainnet"));
  const paper = { cwd: root, dataDir: "data-live", env: {} as NodeJS.ProcessEnv };
  const live = { cwd: root, dataDir: "data-mainnet", env: {} as NodeJS.ProcessEnv };
  const touch = (...p: string[]) => fs.writeFileSync(path.join(root, ...p), "");
  const clear = () => {
    for (const p of ["STOP", "data-live/STOP", "data-mainnet/STOP"]) fs.rmSync(path.join(root, p), { force: true });
  };

  await test("no halt: no file, no KILL_SWITCH; clear for both desks", () => {
    clear();
    assert.equal(killSwitchActive(paper), false);
    assert.deepEqual(killSwitchSources(live), []);
    assert.equal(describeHalt([]), "clear");
  });
  await test("the root STOP halts every desk, and says so", () => {
    clear();
    touch("STOP");
    assert.equal(killSwitchActive(paper), true);
    assert.equal(killSwitchActive(live), true);
    assert.deepEqual(killSwitchSources(paper), ["root"]);
    assert.match(describeHalt(["root"]), /repo root \(halts every desk\)/);
  });
  await test("a desk's own STOP halts that desk only: data-mainnet/STOP leaves the paper desk trading", () => {
    clear();
    touch("data-mainnet", "STOP");
    assert.equal(killSwitchActive(live), true);
    assert.deepEqual(killSwitchSources(live), ["desk"]);
    assert.equal(killSwitchActive(paper), false);
    assert.match(describeHalt(["desk"], "data-mainnet"), /data-mainnet\/STOP \(halts this desk only\)/);
  });
  await test("an absolute DATA_DIR finds its STOP as well as a relative one", () => {
    clear();
    touch("data-live", "STOP");
    assert.deepEqual(killSwitchSources({ ...paper, dataDir: path.join(root, "data-live") }), ["desk"]);
  });
  await test("KILL_SWITCH: only the literal \"true\" halts, and only whoever carries it", () => {
    clear();
    assert.deepEqual(killSwitchSources({ ...live, env: { KILL_SWITCH: "true" } }), ["env"]);
    assert.equal(killSwitchActive({ ...live, env: { KILL_SWITCH: "false" } }), false);
    assert.equal(killSwitchActive({ ...live, env: { KILL_SWITCH: "" } }), false);
    assert.equal(killSwitchActive(paper), false);
    assert.match(describeHalt(["env"]), /KILL_SWITCH=true/);
  });
  await test("every halt in force is named, in order", () => {
    clear();
    touch("STOP");
    touch("data-mainnet", "STOP");
    const s = killSwitchSources({ ...live, env: { KILL_SWITCH: "true" } });
    assert.deepEqual(s, ["root", "desk", "env"]);
    assert.equal(describeHalt(s, "data-mainnet").split(" + ").length, 3);
  });
  await test("the file's contents are never read: an expiry written in it does not lift the halt", () => {
    clear();
    fs.writeFileSync(path.join(root, "data-live", "STOP"), "until=2000-01-01T00:00:00Z\nKILL_SWITCH=false\n");
    assert.deepEqual(killSwitchSources(paper), ["desk"]);
    // a directory named STOP halts too: existing is the whole test
    clear();
    fs.mkdirSync(path.join(root, "data-live", "STOP"));
    assert.equal(killSwitchActive(paper), true);
    fs.rmdirSync(path.join(root, "data-live", "STOP"));
  });
  await test("the defaults: the working directory, the configured DATA_DIR and process.env", () => {
    clear();
    const was = process.cwd();
    process.chdir(root);
    try {
      assert.equal(killSwitchActive(), false);
      fs.mkdirSync(path.join(root, "data-test-halts"));
      touch("data-test-halts", "STOP");
      assert.deepEqual(killSwitchSources(), ["desk"]);
      fs.rmSync(path.join(root, "data-test-halts", "STOP"));
      process.env.KILL_SWITCH = "true";
      assert.deepEqual(killSwitchSources(), ["env"]);
    } finally {
      delete process.env.KILL_SWITCH;
      process.chdir(was);
    }
  });

  await test("preflight, the kill switch: PASS when clear, WARN on a dry-run desk, FAIL live", () => {
    assert.equal(haltLevel(false, true), "PASS");
    assert.equal(haltLevel(false, false), "PASS");
    assert.equal(haltLevel(true, true), "WARN");
    assert.equal(haltLevel(true, false), "FAIL");
  });
  await test("preflight, EXPECTED_WALLET: a mismatch is a WARN on paper and a FAIL live; unset warns either way", () => {
    assert.equal(expectedWalletLevel("match", true), "PASS");
    assert.equal(expectedWalletLevel("match", false), "PASS");
    assert.equal(expectedWalletLevel("mismatch", true), "WARN");
    assert.equal(expectedWalletLevel("mismatch", false), "FAIL");
    assert.equal(expectedWalletLevel("unset", true), "WARN");
    assert.equal(expectedWalletLevel("unset", false), "WARN");
  });

  const base = { agentName: "Mr Bands", model: "claude-test", policyLive: false };
  await test("preflight, Anthropic: no key warns on paper and fails live without POLICY_LIVE", () => {
    const row = (dryRun: boolean, policyLive: boolean) => modelRow({ ...base, decider: "anthropic", dryRun, policyLive, anthropic: { hasKey: false } });
    assert.equal(row(true, false).level, "WARN");
    assert.equal(row(false, true).level, "WARN");
    assert.equal(row(false, false).level, "FAIL");
    assert.match(row(false, false).detail, /ANTHROPIC_API_KEY is empty/);
  });
  await test("preflight, Anthropic: a failed ping is a WARN on paper and a FAIL live; a dry-run desk is not pinged", () => {
    const failed = { ok: false as const, error: "401 invalid x-api-key" };
    assert.equal(modelRow({ ...base, decider: "anthropic", dryRun: true, anthropic: { hasKey: true, ping: failed } }).level, "WARN");
    assert.equal(modelRow({ ...base, decider: "anthropic", dryRun: false, anthropic: { hasKey: true, ping: failed } }).level, "FAIL");
    assert.equal(modelRow({ ...base, decider: "anthropic", dryRun: false, anthropic: { hasKey: true, ping: { ok: true, text: "ready" } } }).level, "PASS");
    const unpinged = modelRow({ ...base, decider: "anthropic", dryRun: true, anthropic: { hasKey: true } });
    assert.equal(unpinged.level, "PASS");
    assert.match(unpinged.detail, /not pinged on a dry-run desk/);
  });
  await test("preflight, policy: a PASS that says no model is asked; live without POLICY_LIVE still fails (every open would hold)", () => {
    const row = (dryRun: boolean, policyLive: boolean) => modelRow({ ...base, decider: "policy", dryRun, policyLive });
    assert.equal(row(true, false).level, "PASS");
    assert.equal(row(false, true).level, "PASS");
    assert.match(row(false, true).detail, /no model is asked/);
    assert.equal(row(false, false).level, "FAIL");
  });
  await test("preflight, OpenHermit: no token warns on paper and fails live; a down gateway only warns", () => {
    const oh = (tokenPresent: boolean, healthy: boolean) => ({ tokenPresent, gatewayUrl: "http://127.0.0.1:4000", agentId: "mr-bands", healthy, healthNote: healthy ? "answered 200" : "did not answer (ECONNREFUSED)" });
    const row = (dryRun: boolean, tokenPresent: boolean, healthy: boolean) => modelRow({ ...base, decider: "openhermit", dryRun, policyLive: true, openhermit: oh(tokenPresent, healthy) });
    assert.equal(row(true, false, true).level, "WARN");
    assert.equal(row(false, false, true).level, "FAIL");
    assert.match(row(false, false, true).detail, /OPENHERMIT_TOKEN is not set/);
    assert.equal(row(true, true, true).level, "PASS");
    assert.equal(row(false, true, true).level, "PASS");
    assert.match(row(false, true, true).detail, /token set; health answered 200/);
    // a live desk with open bands must still boot while the gateway is down: the policy proposes meanwhile
    assert.equal(row(false, true, false).level, "WARN");
    assert.equal(row(true, true, false).level, "WARN");
  });

  await test("ops/live.env halts the live desk and pins the policy; the rehearsal lifts the halt and the feed, the preflight lifts nothing", () => {
    const repo = path.resolve(__dirname, "../..");
    const lines = fs.readFileSync(path.join(repo, "ops/live.env"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const values = (k: string) => lines.filter((l) => l.startsWith(`${k}=`)).map((l) => l.slice(k.length + 1));
    assert.deepEqual(values("KILL_SWITCH"), ["true"]);
    assert.deepEqual(values("DECIDER"), ["policy"], "one DECIDER line: a second would quietly win");
    assert.deepEqual(values("DRY_RUN"), [], "DRY_RUN is the service's to set, never this file's");
    const scripts = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).scripts as Record<string, string>;
    const tail = (s: string) => s.slice(s.indexOf("set +a"));
    assert.match(tail(scripts["live:rehearse"]), /DRY_RUN=true .*KILL_SWITCH=false .*LIVE_FEED=false .*tsx src\/index\.ts --once/);
    assert.doesNotMatch(scripts["live:preflight"], /KILL_SWITCH/, "the preflight must still FAIL on the halt");
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
