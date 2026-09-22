/**
 * THE FREEZE SWITCH. Everything he learns can be stopped by one env var, and the switch is deliberately
 * blunt: only the literal "true" freezes. A guard that turns itself on by accident is as bad as one that
 * turns itself off by accident, so "1", "yes", "on", a typo and an empty string all leave learning
 * RUNNING, and the operator who means to freeze writes the word.
 *
 * A freeze costs no evidence. While frozen the desk still closes seats, still writes lessons, still
 * computes what it would have changed and still logs it: it only refuses to write the state and to put
 * the new factor on the policy env. Unfreeze and the corpus is whole.
 *
 * Nothing here can loosen a guard: the frozen state is the SHIPPED default, which is the loosest any
 * learner may ever be (the calibration is clamped at or under the 0.5 in src/agent/policy.ts, the pool
 * penalty at or under 1.0). Freezing is always the conservative direction for the book and never for
 * the risk limits, which no learner touches at all.
 */

/** PURE. Frozen only on the literal "true", trimmed and lower-cased. */
export const isFrozenValue = (v: string | undefined | null): boolean => (v ?? "").trim().toLowerCase() === "true";

/** PURE. All learning off. */
export const learningFrozen = (env: NodeJS.ProcessEnv = process.env): boolean => isFrozenValue(env.LEARN_FROZEN);

/** PURE. The forecast calibration off (LEARN_FROZEN_CALIBRATION), or everything off. */
export const calibrationFrozen = (env: NodeJS.ProcessEnv = process.env): boolean => learningFrozen(env) || isFrozenValue(env.LEARN_FROZEN_CALIBRATION);

/** PURE. The pool memory off (LEARN_FROZEN_POOLS), or everything off. */
export const poolsFrozen = (env: NodeJS.ProcessEnv = process.env): boolean => learningFrozen(env) || isFrozenValue(env.LEARN_FROZEN_POOLS);

export interface FreezeState {
  all: boolean;
  calibration: boolean;
  pools: boolean;
}

/** PURE. The three switches at once, for the public surface and the log line at boot. */
export const freezeState = (env: NodeJS.ProcessEnv = process.env): FreezeState => ({ all: learningFrozen(env), calibration: calibrationFrozen(env), pools: poolsFrozen(env) });

/** One line for the boot log and the page. */
export const freezeLine = (f: FreezeState): string =>
  f.all ? "learning frozen (LEARN_FROZEN=true): lessons still written, nothing changes" : f.calibration && f.pools ? "learning frozen knob by knob: the calibration and the pool memory are both held" : f.calibration ? "the forecast calibration is frozen; the pool memory is learning" : f.pools ? "the pool memory is frozen; the forecast calibration is learning" : "learning on";
