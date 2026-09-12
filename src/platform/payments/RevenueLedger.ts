/**
 * Durable revenue ledger for x402-gated tool calls. Ports Meridian's
 * agent/src/payments/RevenueLedger.ts with the same surface (record, totalRevenueUsd,
 * revenueByTool) and the same row shape; the one change is the substrate: totals are
 * folded from revenue.jsonl through src/lib/ledger's ledgerView instead of process
 * counters, so a row appended by another process (the loop, a CLI) is counted too.
 *
 * Row: { ts, tool, amountUsd, reference? }. `reference` is the settlement tx signature, so
 * each row is independently checkable against the chain.
 */
import { appendLedger, ledgerView } from "../../lib/ledger";

interface RevenueTotals {
  totalUsd: number;
  byTool: Record<string, number>;
}

function fold(rows: unknown[]): RevenueTotals {
  const totals: RevenueTotals = { totalUsd: 0, byTool: {} };
  for (const r of rows as Array<{ tool?: unknown; amountUsd?: unknown }>) {
    if (typeof r.tool !== "string" || typeof r.amountUsd !== "number") continue;
    totals.totalUsd += r.amountUsd;
    totals.byTool[r.tool] = (totals.byTool[r.tool] ?? 0) + r.amountUsd;
  }
  return totals;
}

export class RevenueLedger {
  private readonly view = ledgerView<RevenueTotals>("revenue.jsonl", fold);

  record(tool: string, amountUsd: number, reference?: string): void {
    appendLedger("revenue.jsonl", { ts: Date.now(), tool, amountUsd, ...(reference ? { reference } : {}) });
    this.view.reset();
  }

  get totalRevenueUsd(): number {
    return this.view.get().totalUsd;
  }

  get revenueByTool(): Record<string, number> {
    return { ...this.view.get().byTool };
  }
}
