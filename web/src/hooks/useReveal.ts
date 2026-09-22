import { useCallback, useRef } from "react";

/**
 * Marks a section revealed once it scrolls into view: adds `is-visible` to the
 * element, and CSS (styles/motion.css) staggers the children in. Reveals once
 * and disconnects: content never re-hides on scroll-up. Without
 * IntersectionObserver support everything is visible immediately.
 *
 * Returns a CALLBACK ref (not a RefObject) on purpose: the observer attaches
 * the moment the node mounts, whichever render that happens on. A plain
 * useEffect + RefObject wired the observer on the parent's first mount, so a
 * section that renders LATER (e.g. a data-gated section that returns null until
 * its fetch resolves) never got observed and stayed stuck at opacity:0, an
 * invisible block of reserved space. The callback ref fixes that class of bug.
 */
export function useReveal<T extends HTMLElement>(threshold = 0.12) {
  const ioRef = useRef<IntersectionObserver | null>(null);

  return useCallback(
    (el: T | null) => {
      // Detaching (unmount) or re-attaching: tear down any prior observer.
      if (ioRef.current) {
        ioRef.current.disconnect();
        ioRef.current = null;
      }
      if (!el) return;
      if (!("IntersectionObserver" in window)) {
        el.classList.add("is-visible");
        return;
      }
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              el.classList.add("is-visible");
              io.disconnect();
              ioRef.current = null;
            }
          }
        },
        { threshold, rootMargin: "0px 0px -8% 0px" },
      );
      io.observe(el);
      ioRef.current = io;
    },
    [threshold],
  );
}
