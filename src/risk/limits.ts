/**
 * Hard limits. These live in code and are enforced by src/risk/guards.ts before any
 * transaction is built or sent. The LLM sees them in its prompt so it can propose
 * within them, but it cannot change them.
 */
export interface RiskLimits {
  /** max SOL-equivalent deposited into a single new band (a USDC deposit converts at the SOL price) */
  maxPositionSol: number;
  /** max SOL-equivalent across all open bands after the proposed action, SOL- and USDC-quoted pools together */
  maxTotalExposureSol: number;
  /** wallet SOL that must remain untouched for fees and rent (paid in SOL whatever the quote) */
  gasReserveSol: number;
  /** force-close a band once its value drops this % below entry */
  stopLossPct: number;
  /** max bins in a band (position accounts cap at 69 bins without extension) */
  maxBinWidth: number;
  /** max executed actions per UTC day */
  maxTxPerDay: number;
  /** cooldown between non-emergency actions */
  minSecondsBetweenActions: number;
  /** slippage passed to the DLMM SDK for deposits */
  maxSlippagePct: number;
  /** if price moved more than this since the last cycle, refuse to open (bad data or crash) */
  maxPriceMovePctPerCycle: number;
}

export function describeLimits(l: RiskLimits): string {
  return [
    `- Max per band: ${l.maxPositionSol} SOL-equivalent (a USDC deposit counts at the SOL price shown in the observation)`,
    `- Max total exposure across bands: ${l.maxTotalExposureSol} SOL-equivalent, across SOL- and USDC-quoted pools alike`,
    `- Gas reserve that must stay in the wallet: ${l.gasReserveSol} SOL (rent and fees are paid in SOL even when the deposit is USDC)`,
    `- Stop-loss: a band is force-closed at -${l.stopLossPct}% from entry (guards do this, not you)`,
    `- Max band width: ${l.maxBinWidth} bins`,
    `- Max ${l.maxTxPerDay} executed actions per day, at least ${l.minSecondsBetweenActions}s apart`,
    `- Deposit slippage: ${l.maxSlippagePct}%`,
    `- Opening is refused if price moved more than ${l.maxPriceMovePctPerCycle}% since the last cycle`,
  ].join("\n");
}
