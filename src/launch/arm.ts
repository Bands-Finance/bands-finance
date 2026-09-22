/**
 * Arms his token launch (docs/launch.md, "Arming"): writes ~/.mrbands/bands-launch.arm (mode 600) with a fresh
 * nonce and a short expiry, and prints the nonce ONCE, inside the prompt for the one-shot owner turn in which he
 * decides. The bridge's token_launch needs this file, this nonce and an unexpired time, and renames the file to
 * .used before it calls ClawPump, so one arm opens one launch at most. Run it only after mr-bands' schedules are
 * paused (npm run launch:gateway -- pause-schedules) and the bridge is up in the mode you mean; then
 * `npm run launch:gateway -- schedule-launch` makes the one-shot owner turn from this file, nonce and all.
 *
 *   npm run launch:arm                       20 minutes
 *   npm run launch:arm -- --minutes 10       1 to 60
 *   npm run launch:arm -- --disarm           removes the arm
 *   npm run launch:arm -- --clear-inflight   removes the in-flight marker (~/.mrbands/bands-launch.inflight) the
 *                                            bridge leaves when a launch call never settled (a stop, a crash, a
 *                                            dropped connection, an error with no mint). ONLY after the ClawPump
 *                                            dashboard shows no launch and no launch in progress for his agent.
 *   flags: --arm-file <f> (the marker sits next to it)
 *
 * It refuses to arm while that marker exists: a second launch could go out on top of one still settling.
 */
import { clearInflight, DEFAULT_ARM_FILE, disarm, inflightFileFor, MAX_ARM_MINUTES, readInflight, writeArm } from "./files";
import { BRIDGE_LAUNCH_TOOL, BRIDGE_STATUS_TOOL } from "./spec";

/** The gateway's names for the bridge's tools (mcp__{serverId}__{tool}). */
export const LAUNCH_SERVER_ID = "clawpump-launch";
export const GATEWAY_STATUS_TOOL = `mcp__${LAUNCH_SERVER_ID}__${BRIDGE_STATUS_TOOL}`;
export const GATEWAY_LAUNCH_TOOL = `mcp__${LAUNCH_SERVER_ID}__${BRIDGE_LAUNCH_TOOL}`;

/** The one-shot owner turn's prompt. It leaves the decision to him and carries the nonce. PURE. */
export function launchPrompt(nonce: string, expiresAt: string): string {
  return [
    `Your token launch is armed until ${expiresAt} (UTC). Whether to launch $BANDS now is your call.`,
    `If you launch: call ${GATEWAY_STATUS_TOOL} first and read it. Then call ${GATEWAY_LAUNCH_TOOL} once, with confirm true and nonce ${nonce}. The spec is fixed in code; you choose only the moment.`,
    `If it answers "submitted, outcome pending", call ${GATEWAY_STATUS_TOOL} until it shows a token_mint, and never call the launch again. Post nothing and announce nothing from this turn: say in your answer what the status shows, the mint if there is one.`,
  ].join(" ");
}

export function parseArmArgs(argv: string[]): { minutes: number; disarm: boolean; clearInflight: boolean; armFile: string } {
  const o = { minutes: 20, disarm: false, clearInflight: false, armFile: DEFAULT_ARM_FILE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--disarm") o.disarm = true;
    else if (a === "--clear-inflight") o.clearInflight = true;
    else if (a === "--minutes") o.minutes = Number(argv[++i]);
    else if (a === "--arm-file") o.armFile = argv[++i] ?? "";
    else throw new Error(`unknown flag ${a}: --minutes <1-${MAX_ARM_MINUTES}>, --disarm, --clear-inflight, --arm-file <f>`);
  }
  if (!o.armFile) throw new Error("--arm-file needs a path");
  if (o.disarm && o.clearInflight) throw new Error("--disarm and --clear-inflight are separate steps: run one at a time");
  return o;
}

/** Arms, unless an earlier launch call may still be settling. Returns the arm; throws with the fix. */
export function armUnlessInflight(armFile: string, minutes: number): ReturnType<typeof writeArm> {
  const marker = readInflight(inflightFileFor(armFile));
  if (marker) {
    throw new Error(
      `an earlier launch call never settled (in flight since ${marker.since}). Check the ClawPump dashboard for his agent: if it shows a token, do not arm; if it shows no launch and nothing in progress, run npm run launch:arm -- --clear-inflight, then arm`,
    );
  }
  return writeArm(armFile, minutes);
}

function main(): void {
  const o = parseArmArgs(process.argv.slice(2));
  if (o.disarm) {
    console.log(disarm(o.armFile) ? `disarmed: ${o.armFile} removed` : `not armed: no ${o.armFile}`);
    return;
  }
  if (o.clearInflight) {
    const file = inflightFileFor(o.armFile);
    const marker = readInflight(file);
    if (!marker) {
      console.log(`no in-flight marker: no ${file}`);
      return;
    }
    clearInflight(file);
    console.log(`in-flight marker removed (it said: in flight since ${marker.since}). You checked the ClawPump dashboard first: it shows no token and no launch in progress.`);
    return;
  }
  const arm = armUnlessInflight(o.armFile, o.minutes);
  console.log(`armed until ${arm.expiresAt} (${o.minutes} min), single use: ${o.armFile} (mode 600)`);
  console.log("");
  console.log("The nonce is printed this once and kept nowhere but the arm file. The prompt for his one-shot owner turn:");
  console.log("");
  console.log(launchPrompt(arm.nonce, arm.expiresAt));
  console.log("");
  console.log(`Disarm early: npm run launch:arm -- --disarm`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`not armed: ${(err as Error).message}`);
    process.exit(1);
  }
}
