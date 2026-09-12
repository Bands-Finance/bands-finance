/**
 * The heavy half of the wallet layer, loaded lazily by WalletProviders once the API has answered.
 * Replaces Meridian's frontend/src/web3/Web3Providers.tsx (wagmi) with @solana/wallet-adapter-react.
 *
 * wallets=[]: every current Solana wallet (Phantom, Solflare, Backpack, ...) registers itself through
 * the Wallet Standard and is auto-detected, so no per-wallet adapter package is bundled.
 * autoConnect=false: nothing connects until the user clicks; a signature is only ever requested
 * after they asked to sign in (useBandsAccount). The modal renders through a portal, so this can sit
 * anywhere in the tree; it wraps nothing but its own bridge.
 */
import { useEffect, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter } from "@solana/wallet-adapter-base";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./wallet.css";
import type { EngineProps } from "./AccountProvider";
import { useBandsAccount } from "./useBandsAccount";

const env = import.meta.env as Record<string, string | undefined>;
const ENDPOINT = env.VITE_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";

function Bridge({ onSnapshot, actions }: EngineProps) {
  const a = useBandsAccount(true);
  actions.current = { signIn: a.signIn, signOut: a.signOut };
  useEffect(() => {
    onSnapshot({ status: a.status, address: a.address, token: a.token, account: a.account, error: a.error, connecting: a.connecting });
  }, [onSnapshot, a.status, a.address, a.token, a.account, a.error, a.connecting]);
  return null;
}

export default function WalletEngine(props: EngineProps) {
  const wallets = useMemo<Adapter[]>(() => [], []);
  return (
    <ConnectionProvider endpoint={ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect={false} onError={(e) => console.warn("[wallet]", e.name, e.message)}>
        <WalletModalProvider>
          <Bridge {...props} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
