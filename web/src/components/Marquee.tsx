import { useEffect, useRef, type ReactNode } from "react";
import { useMotion } from "../motion";
import "./Marquee.css";

/**
 * An infinite marquee whose pace the reader's scroll pushes around. It drifts left at `speed` px a second
 * on its own; scrolling the page adds to that in the scroll's own direction (down hurries it, up runs it
 * backwards) and the push dies away in under a second. It stops under the pointer and off screen, and
 * with reduced motion it is a plain strip to swipe. The content is rendered twice so the loop has no seam.
 */
export function Marquee({ children, speed = 26, scrollBoost = 5, label, className }: { children: ReactNode; speed?: number; scrollBoost?: number; label?: string; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const motion = useMotion();
  useEffect(() => {
    const root = rootRef.current;
    const track = trackRef.current;
    if (!root || !track) return;
    if (!motion) {
      root.classList.add("marquee--still");
      track.style.transform = "";
      return () => root.classList.remove("marquee--still");
    }
    root.classList.remove("marquee--still");
    let raf = 0;
    let last = performance.now();
    let offset = 0;
    let push = 0;
    let paused = false;
    let visible = true;
    let lastY = window.scrollY;
    // the loop length, measured when the track changes size (images arriving, a new feed), not every frame
    let half = track.scrollWidth / 2;
    const ro = new ResizeObserver(() => (half = track.scrollWidth / 2));
    ro.observe(track);
    const onScroll = () => {
      const y = window.scrollY;
      push = Math.max(-1800, Math.min(1800, push + (y - lastY) * scrollBoost));
      lastY = y;
    };
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      if (visible && !paused) {
        if (half > 0) {
          offset = (((offset + (speed + push) * dt) % half) + half) % half;
          track.style.transform = `translate3d(${-offset}px, 0, 0)`;
        }
      }
      push *= Math.pow(0.03, dt);
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((es) => (visible = es.some((e) => e.isIntersecting)), { rootMargin: "120px" });
    io.observe(root);
    const enter = () => (paused = true);
    const leave = () => (paused = false);
    root.addEventListener("pointerenter", enter);
    root.addEventListener("pointerleave", leave);
    root.addEventListener("focusin", enter);
    root.addEventListener("focusout", leave);
    window.addEventListener("scroll", onScroll, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointerleave", leave);
      root.removeEventListener("focusin", enter);
      root.removeEventListener("focusout", leave);
      window.removeEventListener("scroll", onScroll);
    };
  }, [speed, scrollBoost, motion]);
  return (
    <div className={`marquee${className ? ` ${className}` : ""}`} ref={rootRef} role="group" aria-label={label}>
      <div className="marquee__track" ref={trackRef}>
        <div className="marquee__set">{children}</div>
        <div className="marquee__set" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
}
