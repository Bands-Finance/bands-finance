import { useContext, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ConnectionContext, ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import type { Adapter } from "@solana/wallet-adapter-base";
import { useReveal } from "../hooks/useReveal";
import { fmtPrice, short } from "../format";
import type { RiskLimits, ScreenResult } from "../types";
import { useEngine, type EnginePosition, type PlanRequest } from "./useEngine";
import "./Engine.css";

const ri = (n: number) => ({ "--ri": n }) as CSSProperties;

export interface EngineProps {
  screen: ScreenResult | null;
  limits: RiskLimits | null;
  /** the wallet session bearer from the sign-in flow; null when not signed in */
  token: string | null;
}

type Side = PlanRequest["side"];
type Strategy = PlanRequest["strategy"];

const SIDE_WORDS: Record<Side, string> = {
  SOL_ONLY: "SOL only, below the price (buys the token as it falls)",
  TOKEN_ONLY: "token only, above the price (sells as it rises)",
  BOTH: "both sides of the price",
};

const STRATEGY_WORDS: Record<Strategy, string> = {
  Spot: "spread evenly across the bins",
  Curve: "heavier near the current price",
  BidAsk: "heavier at the edges",
};

function Empty({ children }: { children: ReactNode }) {
  return <div className="engine__empty">{children}</div>;
}

const env = import.meta.env as Record<string, string | undefined>;
const RPC_ENDPOINT = env.VITE_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";

/**
 * "Run Mr Bands' bands on your own wallet": the engine skill's panel. The API runs Mr
 * Bands' guards for the connected wallet and returns an unsigned transaction; the wallet
 * signs it here. Honest about every missing precondition (no API, no wallet, no session,
 * no access) rather than showing a form that cannot work.
 *
 * Needs wallet-adapter context (useConnection/useWallet). WalletProviders mounts that
 * context around its own Bridge only, not around the page, so when this renders outside
 * it the panel brings its own ConnectionProvider + WalletProvider: the same Wallet
 * Standard auto-detection and the same `walletName` storage key, so the wallet chosen in
 * the header auto-connects here without a second prompt. Import it lazily and only once
 * useAccount().api is true, so the static site never downloads wallet-adapter for it.
 */
export function Engine(props: EngineProps) {
  const hasAdapter = Boolean(useContext(ConnectionContext).connection);
  if (hasAdapter) return <EnginePanel {...props} />;
  return <OwnProviders><EnginePanel {...props} /></OwnProviders>;
}

export default Engine;

function OwnProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo<Adapter[]>(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect onError={(err) => console.warn("[engine wallet]", err.name, err.message)}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}

/** When the panel owns its providers, the wallet the header selected may still need a connect call here. */
function ConnectHere() {
  const w = useWallet();
  if (!w.wallet || w.connected || w.connecting) return null;
  return (
    <button type="button" className="engine__btn" onClick={() => void w.connect().catch(() => undefined)}>
      connect {w.wallet.adapter.name} here
    </button>
  );
}

function EnginePanel({ screen, limits, token }: EngineProps) {
  const ref = useReveal<HTMLElement>();
  const e = useEngine(token);
  // SOL- and USDC-quoted pools alike: the guards convert a USDC deposit at the SOL price the screen carries.
  const pools = useMemo(() => (screen?.pools ?? []).filter((p) => p.quoteSymbol === "SOL" || (p.quoteSymbol === "USDC" && screen?.solPriceUsd)).slice(0, 30), [screen]);
  const [pool, setPool] = useState("");
  const [customPool, setCustomPool] = useState("");
  const [side, setSide] = useState<Side>("SOL_ONLY");
  const [amountSol, setAmountSol] = useState("0.1");
  const [amountToken, setAmountToken] = useState("0");
  const [binsBelow, setBinsBelow] = useState("19");
  const [binsAbove, setBinsAbove] = useState("0");
  const [strategy, setStrategy] = useState<Strategy>("Spot");

  const chosenPool = customPool.trim() || pool || pools[0]?.address || "";
  const chosen = pools.find((p) => p.address === chosenPool) ?? null;
  const quote = chosen?.quoteSymbol ?? "SOL";
  const request: PlanRequest = {
    pool: chosenPool,
    side,
    amountSol: side === "TOKEN_ONLY" ? 0 : Number(amountSol) || 0,
    amountToken: side === "SOL_ONLY" ? 0 : Number(amountToken) || 0,
    binsBelowActive: side === "TOKEN_ONLY" ? 0 : Math.max(0, Math.floor(Number(binsBelow) || 0)),
    binsAboveActive: side === "SOL_ONLY" ? 0 : Math.max(0, Math.floor(Number(binsAbove) || 0)),
    strategy,
  };
  const width = request.binsBelowActive + request.binsAboveActive + 1;
  const busy = e.phase === "preparing" || e.phase === "signing" || e.phase === "confirming";

  let gate: ReactNode = null;
  if (e.apiAvailable === false) {
    gate = (
      <Empty>
        No API behind this copy. Set <code>VITE_API_URL</code>.
      </Empty>
    );
  } else if (e.apiAvailable === null) {
    gate = <Empty>checking for the API…</Empty>;
  } else if (!e.walletAddress) {
    gate = (
      <Empty>
        Connect a wallet (top right). The page never sees your key. <ConnectHere />
      </Empty>
    );
  } else if (!token) {
    gate = <Empty>Sign in with that wallet. The signature moves nothing.</Empty>;
  } else if (e.access && !e.access.hasAccess) {
    gate = (
      <Empty>
        {e.access.detail}
      </Empty>
    );
  } else if (!e.access) {
    gate = <Empty>checking access…</Empty>;
  }

  return (
    <section className="engine reveal" id="engine" ref={ref}>
      <div className="engine__head r-item" style={ri(0)}>
        <span className="eyebrow">Engine skill</span>
        <h2 className="engine__title">Run Mr Bands' bands on your own wallet.</h2>
        <p className="engine__sub">
          His band math and his guards, on your capital. You sign; bands.finance never touches your funds.
        </p>
      </div>

      {gate ?? (
        <>
          <div className="engine__grid r-item" style={ri(1)}>
            <form
              className="engine__form"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (chosenPool && !e.planning && !busy) void e.askGuards(request);
              }}
            >
              <label className="engine__field">
                <span>Pool</span>
                <select value={pool || chosenPool} onChange={(ev) => setPool(ev.target.value)} disabled={pools.length === 0}>
                  {pools.length === 0 && <option value="">no screened pools yet</option>}
                  {pools.map((p) => (
                    <option key={p.address} value={p.address}>
                      #{p.rank} {p.name} · score {p.score.toFixed(0)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="engine__field">
                <span>or paste a pool address</span>
                <input value={customPool} onChange={(ev) => setCustomPool(ev.target.value)} placeholder="DLMM pool address" spellCheck={false} />
              </label>
              <label className="engine__field">
                <span>Side</span>
                <select value={side} onChange={(ev) => setSide(ev.target.value as Side)}>
                  {(Object.keys(SIDE_WORDS) as Side[]).map((s) => (
                    <option key={s} value={s}>
                      {s.replace("_", " ")}
                    </option>
                  ))}
                </select>
                <small>{quote === "SOL" ? SIDE_WORDS[side] : SIDE_WORDS[side].replace(/^SOL only/, `${quote} only`)}</small>
              </label>
              <div className="engine__row">
                <label className="engine__field">
                  <span>{quote} to deposit</span>
                  <input type="number" inputMode="decimal" min="0" step="0.01" value={amountSol} onChange={(ev) => setAmountSol(ev.target.value)} disabled={side === "TOKEN_ONLY"} />
                </label>
                <label className="engine__field">
                  <span>{chosen ? `${chosen.baseSymbol} to deposit` : "Token to deposit"}</span>
                  <input type="number" inputMode="decimal" min="0" step="any" value={amountToken} onChange={(ev) => setAmountToken(ev.target.value)} disabled={side === "SOL_ONLY"} />
                </label>
              </div>
              <div className="engine__row">
                <label className="engine__field">
                  <span>Bins below the price</span>
                  <input type="number" inputMode="numeric" min="0" step="1" value={binsBelow} onChange={(ev) => setBinsBelow(ev.target.value)} disabled={side === "TOKEN_ONLY"} />
                </label>
                <label className="engine__field">
                  <span>Bins above the price</span>
                  <input type="number" inputMode="numeric" min="0" step="1" value={binsAbove} onChange={(ev) => setBinsAbove(ev.target.value)} disabled={side === "SOL_ONLY"} />
                </label>
              </div>
              <label className="engine__field">
                <span>Shape</span>
                <select value={strategy} onChange={(ev) => setStrategy(ev.target.value as Strategy)}>
                  {(Object.keys(STRATEGY_WORDS) as Strategy[]).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <small>{STRATEGY_WORDS[strategy]}</small>
              </label>
              <p className="engine__limits">
                {limits
                  ? `Guards: at most ${limits.maxPositionSol} SOL, ${limits.maxBinWidth} bins, ${limits.gasReserveSol} SOL kept for fees. This band: ${width} bin${width === 1 ? "" : "s"}${chosen && chosen.binStep ? ` · ${((width * chosen.binStep) / 100).toFixed(2)}% of price` : ""}.`
                  : "The guards' limits load from /api/limits."}
              </p>
              <button type="submit" className="engine__btn engine__btn--primary" disabled={!chosenPool || e.planning || busy}>
                {e.planning ? "asking the guards…" : "Ask the guards"}
              </button>
            </form>

            <div className="engine__verdict">
              {!e.plan && !e.planning && <p className="engine__idle">The verdict shows here. Nothing moves until you sign.</p>}
              {e.planning && <p className="engine__idle">reading the pool and your wallet…</p>}
              {e.plan && !e.plan.ok && (
                <>
                  <p className="engine__no">Guards said no.</p>
                  {e.plan.verdict?.violations.map((v) => (
                    <p className="engine__line engine__line--bad" key={v}>
                      {v}
                    </p>
                  ))}
                  {e.plan.error && <p className="engine__line engine__line--bad">{e.plan.error}</p>}
                  {e.plan.verdict?.passed.map((p) => (
                    <p className="engine__line engine__line--ok" key={p}>
                      {p}
                    </p>
                  ))}
                </>
              )}
              {e.plan && e.plan.ok && (
                <>
                  <p className="engine__yes">Guards allow it.</p>
                  {e.plan.verdict.passed.map((p) => (
                    <p className="engine__line engine__line--ok" key={p}>
                      {p}
                    </p>
                  ))}
                  {e.plan.steps.map((s) => (
                    <p className="engine__line" key={s.tx.slice(0, 24)}>
                      {s.description}
                      {s.signers.length > 0 && <span className="engine__faint"> · signed so far: {s.signers.join(", ")}</span>}
                    </p>
                  ))}
                  <p className="engine__faint">{e.plan.note}</p>
                  <button type="button" className="engine__btn engine__btn--primary" onClick={() => void e.signAndOpen()} disabled={busy || !e.canSign}>
                    {busy ? "in your wallet…" : "Sign and open"}
                  </button>
                </>
              )}
              {e.phase !== "idle" && <p className={`engine__phase engine__phase--${e.phase}`}>{e.phaseDetail}</p>}
              {e.signatures.map((sig) => (
                <p className="engine__line" key={sig}>
                  <a href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noreferrer">
                    {sig.slice(0, 12)}… on Solscan ↗
                  </a>
                </p>
              ))}
            </div>
          </div>

          <div className="engine__positions r-item" style={ri(2)}>
            <div className="engine__positions-head">
              <h3>Your bands</h3>
              <button type="button" className="engine__btn" onClick={() => void e.refreshPositions()} disabled={e.loadingPositions || busy}>
                {e.loadingPositions ? "reading…" : "refresh"}
              </button>
            </div>
            {e.positions === null && !e.loadingPositions && <p className="engine__faint">Could not read your bands yet.</p>}
            {e.positions && e.positions.length === 0 && <p className="engine__faint">No bands on this wallet yet.</p>}
            {e.positions && e.positions.length > 0 && (
              <div className="engine__list">
                {e.positions.map((p) => (
                  <PositionRow key={p.address} p={p} busy={busy} onCollect={() => void e.collect(p.pool.address, p.address)} onClose={() => void e.close(p.pool.address, p.address)} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function PositionRow({ p, busy, onCollect, onClose }: { p: EnginePosition; busy: boolean; onCollect: () => void; onClose: () => void }) {
  const fees = p.feeX > 0 || p.feeY > 0;
  return (
    <div className="engine__pos">
      <div className="engine__pos-main">
        <span className="engine__pos-pool">{p.pool.label}</span>
        <span className={`engine__pos-tag ${p.inRange ? "is-in" : "is-out"}`}>{p.inRange ? "in range" : "out of range"}</span>
        <span className="engine__pos-range">
          {fmtPrice(p.lowerPrice)} – {fmtPrice(p.upperPrice)} {p.pool.priceLabel} · {p.widthBins} bins
        </span>
      </div>
      <div className="engine__pos-meta">
        <span>{p.valueInSol.toFixed(4)} SOL</span>
        <span className="engine__faint">{p.advice}</span>
        <span className="engine__faint" title={p.address}>
          {short(p.address)}
        </span>
      </div>
      <div className="engine__pos-actions">
        <button type="button" className="engine__btn" onClick={onCollect} disabled={busy || !fees} title={fees ? "claim the fees this band earned" : "no fees to collect yet"}>
          collect
        </button>
        <button type="button" className="engine__btn engine__btn--danger" onClick={onClose} disabled={busy}>
          close
        </button>
      </div>
    </div>
  );
}
