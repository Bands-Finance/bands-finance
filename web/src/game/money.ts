/** the stack in words: dollars, and bands (a band is $1,000) */
import { BAND } from "./protocol";

/** "$1,250" */
export const usd = (n: number): string => `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

/** "$840" under a band; "1 band", "3.4 bands", "212 bands" over it */
export function bands(n: number): string {
  if (!(n >= BAND)) return usd(n);
  const b = n / BAND;
  const t = b >= 100 ? Math.floor(b).toLocaleString("en-US") : (Math.floor(b * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return `${t} band${t === "1" ? "" : "s"}`;
}

/** the bands word beside a dollar figure: null under a band, where it would only repeat the figure */
export const bandsWord = (n: number): string | null => (n >= BAND ? bands(n) : null);

/** the stack as it is strapped: "$640" under a band, "1 band + $250", "12 bands" when nothing is loose */
export function bandsAndCash(n: number): string {
  const whole = Math.floor(Math.max(0, Math.round(n)) / BAND);
  const loose = Math.max(0, Math.round(n)) - whole * BAND;
  if (whole < 1) return usd(n);
  const b = `${whole.toLocaleString("en-US")} band${whole === 1 ? "" : "s"}`;
  return loose ? `${b} + ${usd(loose)}` : b;
}
