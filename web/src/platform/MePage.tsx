/**
 * The #/me route: "Your Mr Bands" (advisor terminal) followed by the engine skill panel, which
 * lets a signed-in wallet run Mr Bands' band math and guards on its own capital. The engine
 * panel is a lazy chunk and only mounts once the platform API has answered, so the static
 * snapshot never downloads wallet-adapter for it.
 */
import { lazy, Suspense } from "react";
import type { RiskLimits, ScreenResult } from "../types";
import { useAccount } from "./AccountProvider";
import { MyAgent } from "./MyAgent";

const Engine = lazy(() => import("./Engine"));

export function MePage({ screen, limits }: { screen: ScreenResult | null; limits: RiskLimits | null }) {
  const { api, token } = useAccount();
  return (
    <>
      <MyAgent />
      {api === true && (
        <Suspense fallback={null}>
          <Engine screen={screen} limits={limits} token={token} />
        </Suspense>
      )}
    </>
  );
}
