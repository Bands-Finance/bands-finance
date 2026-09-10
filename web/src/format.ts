import type { Action } from "./types";

export const ACTION_LABEL: Record<Action, string> = {
  HOLD: "Hold",
  OPEN_POSITION: "Open band",
  CLOSE_POSITION: "Close band",
  CLAIM_FEES: "Claim fees",
  REBALANCE: "Rebalance",
};

export const fmtSol = (n: number, digits = 4) => `${n.toFixed(digits)} SOL`;
export const fmtSigned = (n: number, digits = 4) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`;
export const fmtPct = (n: number, digits = 1) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}%`;

export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  if (n === 0) return "0";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toPrecision(5);
  return n.toPrecision(4);
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString();

export const short = (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;

export function clock(ts: string | number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function dayClock(ts: string | number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ago(ts: string | number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function duration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
