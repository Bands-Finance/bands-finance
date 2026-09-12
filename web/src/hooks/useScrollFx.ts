import { useEffect } from "react";

/**
 * Global scroll driver for parallax + the header progress bar. Writes two
 * custom properties on <html> once per animation frame:
 *   --scroll-y        current scrollY, unitless (CSS multiplies by px)
 *   --scroll-progress 0..1 through the whole document
 * All consumers are pure CSS (transform/opacity), so the page stays on the
 * compositor — no layout work per frame.
 */
export function useScrollFx() {
  useEffect(() => {
    const root = document.documentElement;
    let raf = 0;

    const update = () => {
      raf = 0;
      const y = window.scrollY;
      const max = root.scrollHeight - window.innerHeight;
      root.style.setProperty("--scroll-y", String(y));
      root.style.setProperty("--scroll-progress", String(max > 0 ? Math.min(y / max, 1) : 0));
      // Glass nav solidifies over the first ~80px of scroll.
      root.style.setProperty("--nav-solid", String(Math.min(y / 80, 1)));
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}
