import { useEffect, useState } from "react";
import { loadLiveRun, type LiveRun } from "../liveRun";

/**
 * His real-money run, frozen in /live-run.json (src/liveRun.ts): loaded once, null until it answers or
 * when the host has none. Both sites read it: the journey's chapter and, while no book is open, every
 * empty "now" surface that points at his record instead.
 */
export function useLiveRun(): LiveRun | null {
  const [run, setRun] = useState<LiveRun | null>(null);
  useEffect(() => {
    let alive = true;
    void loadLiveRun().then((r) => alive && r && setRun(r));
    return () => {
      alive = false;
    };
  }, []);
  return run;
}
