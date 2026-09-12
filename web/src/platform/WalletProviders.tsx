/**
 * The wallet + account layer, mounted once at the top of the app so the header and the #/me page
 * share one wallet and one account. Light by design: the context is always there, the wallet
 * adapter (WalletEngine, a separate chunk) is fetched only once /api/health has answered. On the
 * static snapshot and in artifact mode that never happens, and nothing wallet-shaped is downloaded.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { AccountProvider } from "./AccountProvider";

const WalletEngine = lazy(() => import("./WalletEngine"));

export function WalletProviders({ children }: { children: ReactNode }) {
  return (
    <AccountProvider
      engine={(props, api) =>
        api === true ? (
          <Suspense fallback={null}>
            <WalletEngine {...props} />
          </Suspense>
        ) : null
      }
    >
      {children}
    </AccountProvider>
  );
}
