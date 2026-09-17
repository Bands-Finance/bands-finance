import { useEffect, useRef, useState } from "react";
import "./Panorama.css";

/**
 * THE PANORAMA: twelve engraved panels that read as one journey, from the capital on the desk to the
 * figure on the cliff. On a wide screen the section PINS: it holds the viewport while the reader's
 * vertical scroll walks the panels past, and lets go after the last one. Each panel stands beside a wall
 * label that carries one live figure from the desk, so the art is the dashboard, not a gallery next to it.
 * On a narrow screen, or with reduced motion, it is a strip to swipe, one panel a snap.
 */
export interface PanoramaStop {
  file: string;
  title: string;
  motto: string;
  figure: string;
  label: string;
}

export function Panorama({ stops, eyebrow, title }: { stops: PanoramaStop[]; eyebrow: string; title: string }) {
  const sectionRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const [travel, setTravel] = useState(0);
  const [at, setAt] = useState(1);

  useEffect(() => {
    const section = sectionRef.current;
    const track = trackRef.current;
    if (!section || !track) return;
    const wide = window.matchMedia("(min-width: 900px) and (min-height: 560px)");
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let dist = 0;
    const measure = () => {
      const pin = wide.matches && !calm.matches;
      setPinned(pin);
      dist = pin ? Math.max(0, track.scrollWidth - window.innerWidth) : 0;
      setTravel(dist);
      if (!pin) track.style.transform = "";
      place();
    };
    const place = () => {
      if (!dist) return;
      const top = section.getBoundingClientRect().top;
      const p = Math.min(1, Math.max(0, -top / dist));
      track.style.transform = `translate3d(${-p * dist}px, 0, 0)`;
      setAt(Math.min(stops.length, Math.max(1, Math.round(p * (stops.length - 1)) + 1)));
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, { passive: true });
    wide.addEventListener("change", measure);
    calm.addEventListener("change", measure);
    measure();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll);
      wide.removeEventListener("change", measure);
      calm.removeEventListener("change", measure);
    };
  }, [stops.length]);

  return (
    <section className={`pano${pinned ? " pano--pinned" : " pano--strip"}`} ref={sectionRef} style={pinned ? { height: `calc(100vh + ${travel}px)` } : undefined} aria-label={title}>
      <div className="pano__stage">
        <header className="pano__head">
          <p className="pano__eyebrow engrave">{eyebrow}</p>
          <h2 className="pano__title">{title}</h2>
          {pinned && (
            <p className="pano__count engrave" aria-hidden="true">
              {String(at).padStart(2, "0")} <span>/ {String(stops.length).padStart(2, "0")}</span>
            </p>
          )}
        </header>
        <div className="pano__viewport">
          <div className="pano__track" ref={trackRef}>
            {stops.map((s, i) => (
              <figure className="pano__stop" key={s.file}>
                <img className="pano__panel" src={`/art/panorama/${s.file}.webp`} alt={`${s.title}: an engraved panel`} loading={i < 4 ? "eager" : "lazy"} width="152" height="791" />
                <figcaption className="pano__label">
                  <span className="pano__no engrave">No. {String(i + 1).padStart(2, "0")}</span>
                  <span className="pano__name engrave">{s.title}</span>
                  <span className="pano__rule" aria-hidden="true" />
                  <span className="pano__figure">{s.figure}</span>
                  <span className="pano__what engrave">{s.label}</span>
                  <span className="pano__motto">{s.motto}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
