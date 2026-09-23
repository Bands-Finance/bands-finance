/**
 * PACING A DAILY MODEL CAP (Zach, 23 Sep: "the account must keep posting"). On 23 Sep his 16 post calls were gone by
 * 18:47 UTC and his 60 reply calls by 15:48, and he went quiet for the evening. A cap is now spent across the UTC
 * day: by any hour, at most that hour's even share of the cap plus a small burst. A busy morning waits for the next
 * hour's share; it never takes the evening's. PURE.
 */

/** The burst above the even share: an eighth of the cap, at least 2. */
export const paceBurst = (cap: number): number => Math.max(2, Math.ceil(cap / 8));

/**
 * How much of `cap` may be spent by `now`: the even share of the hours begun so far (the current hour counts as
 * begun) plus the burst, never above the cap. With 48: 8 in the first hour, 32 from noon, all 48 from 20:00 UTC.
 */
export function pacedAllowance(cap: number, now: number): number {
  if (!(cap > 0)) return 0;
  const d = new Date(now);
  const hoursBegun = d.getUTCHours() + 1;
  return Math.min(cap, Math.ceil((cap * hoursBegun) / 24) + paceBurst(cap));
}
