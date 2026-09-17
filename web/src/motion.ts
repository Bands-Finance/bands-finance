import { useSyncExternalStore } from "react";

/**
 * MOTION, one switch for the whole page. Off when the reader's system asks for reduced motion, or when
 * they press "Pause motion" in the footer (remembered). Off means: native scrolling, the desk's camera
 * cuts from station to station and does not glide, the marquees are strips to swipe.
 */
const KEY = "bands.motion";
const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
let paused = false;
try {
  paused = typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "off";
} catch {
  /* private mode: the toggle still works for this visit */
}
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
mq?.addEventListener?.("change", emit);

export const motionSystemReduced = () => !!mq?.matches;
export const motionOn = () => !paused && !mq?.matches;
export function setMotionPaused(p: boolean) {
  paused = p;
  try {
    localStorage.setItem(KEY, p ? "off" : "on");
  } catch {
    /* ignore */
  }
  emit();
}
export function subscribeMotion(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, motionOn, () => true);
}
