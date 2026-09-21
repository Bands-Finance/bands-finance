/**
 * THE SNAPSHOT DEPLOY (AUTO_DEPLOY=true): after a cycle, push the site to Vercel, at most every
 * AUTO_DEPLOY_MIN_MINUTES. It is fired and forgotten, never awaited, so it cannot hold the cycle; what
 * it could do was pile up. It used to run with no timeout and stamp its clock before starting, so a
 * vercel that hung got a second one spawned beside it half an hour later, and a third after that.
 *
 *   one push at a time: while one is running the next is skipped with a log line
 *   each step has a hard timeout (DEPLOY_TIMEOUT_MS, ten minutes) and is killed past it
 *   web:deploy and dash:deploy are separate steps: the dashboard ships even when the platform fails
 */
export const DEPLOY_TIMEOUT_MS = 600_000;

export type ExecLike = (
  command: string,
  options: { cwd: string; timeout: number },
  callback: (err: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export interface DeployerOptions {
  exec: ExecLike;
  cwd: string;
  /** the throttle between pushes, minutes */
  minMinutes: number;
  now?: () => number;
  log?: (s: string) => void;
  error?: (s: string) => void;
  /** told once per push, when every step has finished: ok only if all of them did */
  onDone?: (ok: boolean, at: number) => void;
}

export type DeployOutcome = "started" | "busy" | "throttled";

export interface Deployer {
  /** push the platform, and the dashboard when `dash` (its Vercel link exists) */
  deploy(dash: boolean): DeployOutcome;
  running(): boolean;
}

export function createDeployer(o: DeployerOptions): Deployer {
  const now = o.now ?? Date.now;
  const log = o.log ?? console.log;
  const error = o.error ?? console.error;
  let lastAt = 0;
  let runningSince: number | null = null;

  const step = (script: string): Promise<boolean> =>
    new Promise((resolve) => {
      o.exec(`npm run ${script}`, { cwd: o.cwd, timeout: DEPLOY_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) error(`[deploy] ${script} failed: ${err.message.slice(0, 200)}\n${String(stderr ?? "").slice(-400)}`);
        else log(`[deploy] ${script}: ${String(stdout ?? "").trim().split("\n").slice(-2).join(" | ")}`);
        resolve(!err);
      });
    });

  return {
    running: () => runningSince !== null,
    deploy(dash) {
      const t = now();
      if (runningSince !== null) {
        log(`[deploy] skipped: the last push is still running (${((t - runningSince) / 60000).toFixed(0)} min)`);
        return "busy";
      }
      const sinceMin = (t - lastAt) / 60000;
      if (lastAt > 0 && sinceMin < o.minMinutes) {
        log(`[deploy] skipped: ${sinceMin.toFixed(0)} min since the last push, minimum ${o.minMinutes}`);
        return "throttled";
      }
      lastAt = t;
      runningSince = t;
      log(`[deploy] pushing snapshot to Vercel${dash ? " (platform + dashboard)" : ""}`);
      void (async () => {
        let ok = await step("web:deploy");
        // the dashboard is its own step: a failed platform push does not keep it from shipping
        if (dash) ok = (await step("dash:deploy")) && ok;
        runningSince = null;
        o.onDone?.(ok, now());
      })();
      return "started";
    },
  };
}
