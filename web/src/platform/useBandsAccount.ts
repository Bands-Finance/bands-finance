/**
 * Wallet-as-account for bands.finance. Ports Meridian's frontend/src/hooks/useMeridianAccount.ts from
 * wagmi/SIWE to the Solana wallet adapter: connect a wallet, sign a one-time challenge to prove
 * ownership, and the verified address becomes a session-persisted account. The wallet is the identity;
 * the signature proves control only and never authorizes a transaction.
 *
 * The ONE sign-in action: signIn() connects if needed (opening the wallet picker when no wallet is
 * selected) and signs as soon as the wallet is there. The signature prompt is guarded on an intent
 * flag, so merely connecting a wallet never triggers an unrequested signature: a signature request
 * nobody asked for is the single most alarming thing a site can do to someone holding funds.
 *
 * Session: localStorage "bands.session" = {token, address, expiresAt}; addresses compare case-sensitively.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { AccountData, WalletSession } from "../types";
import { apiJson } from "./apiBase";

export type AccountStatus = "guest" | "connected" | "signing" | "signed-in";

export const SESSION_KEY = "bands.session";

export function readSession(address: string | null): WalletSession | null {
  if (!address) return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as WalletSession;
    if (s.address !== address || !s.token || Date.now() > s.expiresAt) return null;
    return s;
  } catch {
    return null;
  }
}

function writeSession(s: WalletSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode; the session lives for this page only */
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export const shortAddress = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

export function useBandsAccount(apiAvailable: boolean) {
  const wallet = useWallet();
  const modal = useWalletModal();
  const address = wallet.publicKey?.toBase58() ?? null;
  const [status, setStatus] = useState<AccountStatus>("guest");
  const [token, setToken] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wantsSignIn = useRef(false);

  // Reconcile the session with the connected wallet. A stored sign-in only counts if the wallet is
  // connected to that same address AND we still hold an unexpired bearer for it.
  useEffect(() => {
    if (!address) {
      setStatus("guest");
      setToken(null);
      setAccount(null);
      return;
    }
    const stored = readSession(address);
    setToken(stored?.token ?? null);
    if (stored && apiAvailable) {
      let cancelled = false;
      apiJson<AccountData>(`/api/account/${address}`)
        .then((r) => {
          if (cancelled) return;
          if (r.ok && r.json?.address === address) {
            setAccount(r.json);
            setStatus("signed-in");
          } else setStatus("connected");
        })
        .catch(() => !cancelled && setStatus("connected"));
      return () => {
        cancelled = true;
      };
    }
    setStatus((s) => (s === "signing" ? s : "connected"));
  }, [address, apiAvailable]);

  const doSignIn = useCallback(async () => {
    if (!address) return;
    if (!wallet.signMessage) {
      setError("this wallet cannot sign messages; try Phantom, Solflare or Backpack");
      setStatus("connected");
      wantsSignIn.current = false;
      return;
    }
    setStatus("signing");
    setError(null);
    try {
      const ch = await apiJson<{ message?: string; nonce?: string; error?: string }>("/api/account/challenge", { body: { address } });
      if (!ch.json?.message || !ch.json?.nonce) throw new Error(ch.json?.error ?? "could not start sign-in");
      const signature = toBase64(await wallet.signMessage(new TextEncoder().encode(ch.json.message)));
      const res = await apiJson<{ ok?: boolean; error?: string; account?: AccountData; session?: WalletSession }>("/api/account/link", { body: { address, nonce: ch.json.nonce, signature } });
      if (!res.json?.ok || !res.json.session || !res.json.account) throw new Error(res.json?.error ?? "sign-in failed");
      writeSession(res.json.session);
      setToken(res.json.session.token);
      setAccount(res.json.account);
      setStatus("signed-in");
    } catch (e) {
      setError(e instanceof Error ? e.message : "sign-in failed");
      setStatus("connected");
    } finally {
      wantsSignIn.current = false;
    }
  }, [address, wallet]);

  /** The one sign-in action: connect if needed, then sign. */
  const signIn = useCallback(() => {
    setError(null);
    if (!apiAvailable) {
      setError("the platform API is not hosted yet");
      return;
    }
    if (wallet.connected && address) {
      void doSignIn();
      return;
    }
    wantsSignIn.current = true;
    if (wallet.wallet) {
      wallet.connect().catch((e: unknown) => {
        wantsSignIn.current = false;
        setError(e instanceof Error && e.message ? e.message : "could not connect that wallet");
      });
    } else modal.setVisible(true);
  }, [apiAvailable, wallet, address, doSignIn, modal]);

  // The picker closed without a choice: the intent is cancelled, not deferred.
  useEffect(() => {
    if (!modal.visible && !wallet.wallet) wantsSignIn.current = false;
  }, [modal.visible, wallet.wallet]);

  // A wallet was picked while a sign-in was wanted: connect it (the adapter never auto-connects here).
  useEffect(() => {
    if (!wantsSignIn.current || !wallet.wallet || wallet.connected || wallet.connecting) return;
    wallet.connect().catch((e: unknown) => {
      wantsSignIn.current = false;
      setError(e instanceof Error && e.message ? e.message : "could not connect that wallet");
    });
  }, [wallet]);

  // Finish a sign-in the user already asked for, the moment a wallet arrives. A stored session for
  // this address means the reconcile above finishes it without a second signature.
  useEffect(() => {
    if (!wantsSignIn.current || !wallet.connected || !address) return;
    if (status === "signing" || status === "signed-in") return;
    if (readSession(address)) {
      wantsSignIn.current = false;
      return;
    }
    void doSignIn();
  }, [wallet.connected, address, status, doSignIn]);

  const signOut = useCallback(() => {
    writeSession(null);
    setAccount(null);
    setToken(null);
    setStatus("guest");
    setError(null);
    wantsSignIn.current = false;
    void wallet.disconnect().catch(() => undefined);
  }, [wallet]);

  return { address, status, token, account, error, signIn, signOut, connecting: wallet.connecting };
}

export type BandsAccount = ReturnType<typeof useBandsAccount>;
