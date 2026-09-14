/**
 * Paper-mode knobs, read straight from the environment (src/config.ts is not edited):
 *   PAPER_SOL           virtual SOL to start the book with; 0 (default) keeps paper mode off
 *   PAPER_USDC          virtual USDC beside it (default 0: no USDC bands until it is funded)
 *   PAPER_SLIPPAGE_PCT  cost charged on every open (the deposit) and close (the token leg), default 0.3
 * Paper mode only runs under DRY_RUN: assertPaperEnv() refuses PAPER_SOL > 0 with DRY_RUN=false.
 */
export interface PaperEnv {
  sol: number;
  usdc: number;
  slippagePct: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function paperEnv(env: NodeJS.ProcessEnv = process.env): PaperEnv {
  return {
    sol: Math.max(0, num(env.PAPER_SOL, 0)),
    usdc: Math.max(0, num(env.PAPER_USDC, 0)),
    slippagePct: Math.max(0, num(env.PAPER_SLIPPAGE_PCT, 0.3)),
  };
}

/** Paper mode is on when PAPER_SOL > 0 and the loop is in dry-run. */
export function paperEnabled(env: NodeJS.ProcessEnv = process.env, dryRun = true): boolean {
  return dryRun && paperEnv(env).sol > 0;
}

/** Throws when PAPER_SOL is set beside DRY_RUN=false: a paper book and a live key never share a process. */
export function assertPaperEnv(dryRun: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const p = paperEnv(env);
  if (p.sol > 0 && !dryRun) {
    throw new Error(`PAPER_SOL=${p.sol} with DRY_RUN=false: paper mode runs only under DRY_RUN. Unset PAPER_SOL to go live, or set DRY_RUN=true to paper trade. Refusing to start.`);
  }
}
