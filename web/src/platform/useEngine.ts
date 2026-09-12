import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { API_BASE, useApiAvailable } from "./apiBase";

/**
 * The engine skill's hands in the browser. Ports Meridian's frontend/src/hooks/useEngine.ts
 * (the step-execution loop, L70-105) from wagmi sendTransaction + waitForTransactionReceipt
 * to wallet-adapter: each step is a base64 legacy Transaction the API built for THIS wallet,
 * unsigned except for the position keypair's partial signature; the wallet signs it,
 * sendRawTransaction broadcasts it, confirmTransaction waits on the blockhash the step
 * carries. Nothing here ever holds a key.
 *
 * `token` is the wallet session bearer (useAccount().token from AccountProvider); with none,
 * every authed call is skipped and the hook reports why through `access`/`apiAvailable`.
 * Must render inside WalletProviders (useConnection/useWallet) and after the API probe
 * (apiBase.useApiAvailable) has answered.
 */

export interface EngineAccess {
  hasAccess: boolean;
  via: string | null;
  paths: string[];
  detail: string;
}

export interface EngineStep {
  kind: "open-band" | "collect" | "close";
  description: string;
  /** base64 legacy Transaction */
  tx: string;
  blockhash: string;
  lastValidBlockHeight: number;
  signers: string[];
}

export interface EngineVerdict {
  allowed: boolean;
  passed: string[];
  violations: string[];
  overrides: string[];
  emergency: boolean;
}

export type EnginePlan =
  | { ok: true; chainId: string; steps: EngineStep[]; verdict: EngineVerdict; note: string }
  | { ok: false; verdict?: EngineVerdict; error?: string };

export interface EnginePosition {
  address: string;
  lowerBinId: number;
  upperBinId: number;
  lowerPrice: number;
  upperPrice: number;
  widthBins: number;
  inRange: boolean;
  binsFromRange: number;
  amountX: number;
  amountY: number;
  feeX: number;
  feeY: number;
  valueInSol: number;
  solInPosition: number;
  lastUpdatedAt: number;
  pool: { address: string; label: string; activeBinId: number; activePrice: number; priceLabel: string };
  advice: string;
}

export interface PlanRequest {
  pool: string;
  side: "SOL_ONLY" | "TOKEN_ONLY" | "BOTH";
  amountSol: number;
  amountToken: number;
  binsBelowActive: number;
  binsAboveActive: number;
  strategy: "Spot" | "Curve" | "BidAsk";
}

export type EnginePhase = "idle" | "preparing" | "signing" | "confirming" | "done" | "error";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function useEngine(token: string | null) {
  const { connection } = useConnection();
  const wallet = useWallet();
  // Is there an API behind this page at all? A static copy of the site has none, and the
  // panel must say so rather than pretend. One probe, shared with the account layer.
  const apiAvailable = useApiAvailable();
  const [access, setAccess] = useState<EngineAccess | null>(null);
  const [plan, setPlan] = useState<EnginePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [positions, setPositions] = useState<EnginePosition[] | null>(null);
  const [loadingPositions, setLoadingPositions] = useState(false);
  const [phase, setPhase] = useState<EnginePhase>("idle");
  const [phaseDetail, setPhaseDetail] = useState("");
  const [signatures, setSignatures] = useState<string[]>([]);

  const authed = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(30000),
      }),
    [token],
  );

  const refreshAccess = useCallback(async () => {
    if (!token) {
      setAccess(null);
      return;
    }
    try {
      const j = await authed("/api/engine/access").then((r) => r.json());
      setAccess(j?.ok ? { hasAccess: Boolean(j.hasAccess), via: j.via ?? null, paths: Array.isArray(j.paths) ? j.paths : [], detail: String(j.detail ?? "") } : null);
    } catch {
      setAccess(null);
    }
  }, [authed, token]);

  const refreshPositions = useCallback(async () => {
    if (!token) return;
    setLoadingPositions(true);
    try {
      const j = await authed("/api/engine/positions").then((r) => r.json());
      setPositions(Array.isArray(j?.positions) ? j.positions : null);
    } catch {
      setPositions(null);
    } finally {
      setLoadingPositions(false);
    }
  }, [authed, token]);

  useEffect(() => {
    if (apiAvailable) void refreshAccess();
  }, [apiAvailable, refreshAccess]);

  useEffect(() => {
    if (access?.hasAccess) void refreshPositions();
  }, [access?.hasAccess, refreshPositions]);

  /** Ask the guards. The answer is a verdict either way; a refusal is not an error. */
  const askGuards = useCallback(
    async (req: PlanRequest): Promise<EnginePlan> => {
      setPlanning(true);
      setPlan(null);
      setPhase("idle");
      setPhaseDetail("");
      setSignatures([]);
      try {
        const j = await authed("/api/engine/plan", { method: "POST", body: JSON.stringify(req) }).then((r) => r.json());
        const next: EnginePlan = j?.ok ? j : { ok: false, verdict: j?.verdict, error: typeof j?.error === "string" ? j.error : undefined };
        setPlan(next);
        return next;
      } catch (e) {
        const next: EnginePlan = { ok: false, error: errorText(e, "could not reach the engine") };
        setPlan(next);
        return next;
      } finally {
        setPlanning(false);
      }
    },
    [authed],
  );

  // The step loop: sign each step in the wallet, broadcast, confirm against the blockhash
  // it was built with. Keeps the phase honest and translates wallet rejections into words.
  const runSteps = useCallback(
    async (steps: EngineStep[], doneMsg: string) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setPhase("error");
        setPhaseDetail("connect a wallet that can sign transactions");
        return;
      }
      try {
        const sigs: string[] = [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          setPhase("signing");
          setPhaseDetail(`${i + 1}/${steps.length}: ${step.description}`);
          const signed = await wallet.signTransaction(Transaction.from(b64ToBytes(step.tx)));
          setPhase("confirming");
          setPhaseDetail(`${i + 1}/${steps.length}: sending…`);
          const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
          setPhaseDetail(`${i + 1}/${steps.length}: confirming ${signature.slice(0, 8)}…`);
          const conf = await connection.confirmTransaction({ signature, blockhash: step.blockhash, lastValidBlockHeight: step.lastValidBlockHeight }, "confirmed");
          if (conf.value.err) throw new Error(`transaction ${signature.slice(0, 8)}… failed on chain`);
          sigs.push(signature);
        }
        setSignatures(sigs);
        setPhase("done");
        setPhaseDetail(doneMsg);
        setPlan(null);
        void refreshPositions();
      } catch (e) {
        setPhase("error");
        const msg = errorText(e, "transaction failed");
        setPhaseDetail(/reject|denied|cancel/i.test(msg) ? "signature declined in your wallet · nothing moved" : msg);
      }
    },
    [connection, refreshPositions, wallet],
  );

  const signAndOpen = useCallback(async () => {
    if (!plan?.ok) return;
    setPhase("preparing");
    setPhaseDetail("handing the transaction to your wallet…");
    await runSteps(plan.steps, "band open · Mr Bands' math is working for you");
  }, [plan, runSteps]);

  const prepareAndRun = useCallback(
    async (path: string, body: object, doneMsg: string) => {
      setPhase("preparing");
      setPhaseDetail("building the transaction…");
      setSignatures([]);
      try {
        const j = await authed(path, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
        if (!j?.ok) throw new Error(typeof j?.error === "string" ? j.error : "could not build the transaction");
        await runSteps(j.steps as EngineStep[], doneMsg);
      } catch (e) {
        setPhase("error");
        setPhaseDetail(errorText(e, "could not build the transaction"));
      }
    },
    [authed, runSteps],
  );

  const collect = useCallback((pool: string, position: string) => prepareAndRun("/api/engine/collect", { pool, position }, "fees swept to your wallet"), [prepareAndRun]);
  const close = useCallback((pool: string, position: string) => prepareAndRun("/api/engine/close", { pool, position }, "band closed back to your wallet"), [prepareAndRun]);

  return {
    apiAvailable,
    access,
    refreshAccess,
    plan,
    planning,
    askGuards,
    signAndOpen,
    positions,
    loadingPositions,
    refreshPositions,
    collect,
    close,
    phase,
    phaseDetail,
    signatures,
    walletAddress: wallet.publicKey?.toBase58() ?? null,
    canSign: Boolean(wallet.signTransaction),
  };
}
