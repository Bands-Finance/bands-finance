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
 *   flags: --arm-file <f>
 */
import { DEFAULT_ARM_FILE, disarm, MAX_ARM_MINUTES, writeArm } from "./files";
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

export function parseArmArgs(argv: string[]): { minutes: number; disarm: boolean; armFile: string } {
  const o = { minutes: 20, disarm: false, armFile: DEFAULT_ARM_FILE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--disarm") o.disarm = true;
    else if (a === "--minutes") o.minutes = Number(argv[++i]);
    else if (a === "--arm-file") o.armFile = argv[++i] ?? "";
    else throw new Error(`unknown flag ${a}: --minutes <1-${MAX_ARM_MINUTES}>, --disarm, --arm-file <f>`);
  }
  if (!o.armFile) throw new Error("--arm-file needs a path");
  return o;
}

function main(): void {
  const o = parseArmArgs(process.argv.slice(2));
  if (o.disarm) {
    console.log(disarm(o.armFile) ? `disarmed: ${o.armFile} removed` : `not armed: no ${o.armFile}`);
    return;
  }
  const arm = writeArm(o.armFile, o.minutes);
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
