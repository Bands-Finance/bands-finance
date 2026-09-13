/**
 * Price every stock pool in data/screen.json against its Backpack perp and write data/basis.json.
 *   npx tsx src/scripts/basis.ts
 */
import { refreshBasis, sessionWidthMultiplier, basisVerdict, basisFile } from "../basis";

function fmt(v: number | null, digits = 2, suffix = ""): string {
  return v === null || !Number.isFinite(v) ? "-" : `${v.toFixed(digits)}${suffix}`;
}

function pad(s: string, w: number, right = false): string {
  return right ? s.padStart(w) : s.padEnd(w);
}

async function main(): Promise<void> {
  const basis = await refreshBasis();
  const c = basis.clock;
  console.log(
    `session ${basis.session} (${c.weekday} ${c.etDate} ${c.etTime} ET${c.holiday ? `, ${c.holiday}` : ""}${c.earlyClose ? `, early close` : ""})` +
      `  next open ${c.nextOpenAt} (${basis.minutesToOpen} min)  width x${sessionWidthMultiplier(basis.session)}` +
      `  thresholds |basis| <= ${basis.thresholds.maxPct}%, pre-open ${basis.thresholds.preOpenMin} min, post-open ${basis.thresholds.postOpenMin} min`,
  );
  const cols: [string, number, boolean][] = [
    ["pool", 10, false],
    ["symbol", 7, false],
    ["poolPx", 9, true],
    ["perp", 19, false],
    ["perpMid", 9, true],
    ["basis%", 8, true],
    ["spread%", 8, true],
    ["fund%/h", 10, true],
    ["fundAPR%", 9, true],
    ["vol24h$", 11, true],
    ["verdict", 6, false],
    ["note", 0, false],
  ];
  console.log(cols.map(([h, w, r]) => pad(h, w, r)).join("  "));
  for (const r of basis.rows) {
    const v = basisVerdict(r.basisPct, c);
    const cells = [
      r.pool.slice(0, 10),
      r.symbol,
      fmt(r.poolPrice),
      r.perpSymbol ?? "-",
      fmt(r.perpMid),
      fmt(r.basisPct, 3),
      fmt(r.spreadPct, 3),
      fmt(r.fundingRatePerHour === null ? null : r.fundingRatePerHour * 100, 6),
      fmt(r.fundingAprPct, 2),
      fmt(r.perpVolume24hUsd, 0),
      v.ok ? "open" : "REFUSE",
      r.note ?? (v.ok ? "" : v.reason),
    ];
    console.log(cells.map((s, i) => pad(s, cols[i][1], cols[i][2])).join("  "));
  }
  if (!basis.rows.length) console.log("(no stock pools in the screen)");
  console.log(`wrote ${basisFile()} (${basis.rows.length} rows)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
