/**
 * One account, shared by the whole app. Ports Meridian's frontend/src/hooks/AccountProvider.tsx.
 *
 * The context is LIGHT and always mounted: the API probe and a snapshot of the wallet state. The
 * wallet adapter and @solana/web3.js (about 450 KB of JavaScript) live in WalletEngine, a lazy chunk
 * that is only fetched once /api/health has answered, so the public site pays nothing for a layer
 * that is dormant on the static snapshot. The engine pushes its state into this context and
 * registers the two actions; every consumer reads one answer to "am I signed in".
 */
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { AccountData } from "../types";
import { useApiAvailable } from "./apiBase";
import type { AccountStatus } from "./useBandsAccount";

export interface AccountSnapshot {
  status: AccountStatus;
  address: string | null;
  token: string | null;
  account: AccountData | null;
  error: string | null;
  connecting: boolean;
}

export const GUEST: AccountSnapshot = { status: "guest", address: null, token: null, account: null, error: null, connecting: false };

export interface AccountActions {
  signIn: () => void;
  signOut: () => void;
}

export interface AccountContext extends AccountSnapshot, AccountActions {
  /** null while probing, then whether the platform API answered */
  api: boolean | null;
}

const Ctx = createContext<AccountContext | null>(null);

/** What the lazy engine is handed so it can drive the context from inside its own providers. */
export interface EngineProps {
  onSnapshot: (s: AccountSnapshot) => void;
  actions: { current: AccountActions };
}

export function AccountProvider({ children, engine }: { children: ReactNode; engine: (props: EngineProps, api: boolean | null) => ReactNode }) {
  const api = useApiAvailable();
  const [snap, setSnap] = useState<AccountSnapshot>(GUEST);
  const actions = useRef<AccountActions>({ signIn: () => undefined, signOut: () => undefined });
  const value = useMemo<AccountContext>(
    () => ({ ...snap, api, signIn: () => actions.current.signIn(), signOut: () => actions.current.signOut() }),
    [snap, api],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {engine({ onSnapshot: setSnap, actions }, api)}
    </Ctx.Provider>
  );
}

/** The account, from anywhere in the tree. Throws rather than handing back a fake "guest". */
export function useAccount(): AccountContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAccount must be used inside <WalletProviders>");
  return ctx;
}
