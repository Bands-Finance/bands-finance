import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMotion } from "../motion";
import type { DeskStage, StageData } from "./DeskStage";
import "./Journey.css";

/**
 * THE JOURNEY: the top of the page. One engraved desk stays fixed behind the document while the reader's
 * scroll walks a camera round it, from the whole desk, down the rows of bundles, to the cursor where the
 * price is, the dish the fees fall into, the plan view, the ledger. Each stop has a two-line headline (ink,
 * then orange) and a few plain sentences with his live numbers. Then the statement slides over the desk
 * like a sheet of paper and the rest of the page is an ordinary document.
 *
 * Per frame there is no React: the scroll handler turns the page's position into a station number and
 * hands it to the stage. React hears about it only when the beat in view changes.
 */

export interface Beat {
  id: string;
  /** which side the words stand on at desk width */
  side: "left" | "right";
  /** where the camera puts its subject at this stop, as a shift of the picture in window fractions (x right, y down); default: away from the words */
  frame?: { x: number; y: number };
  /** the same for a tall window (a phone), where the words are under the subject; default: a fifth of the window up */
  frameTall?: { x: number; y: number };
  eyebrow: string;
  line1: string;
  line2: string;
  body: ReactNode;
  /** one live figure with its label, set in the mono */
  figure?: { value: string; label: string } | null;
  links?: { href: string; label: string; external?: boolean }[];
}

interface JourneyProps {
  beats: Beat[];
  data: StageData;
  /** the element that slides over the desk after the last beat; the stage stops drawing once it covers the window */
  sheetRef: React.RefObject<HTMLElement | null>;
}

/** The hero's headline is the page's h1; the other beats are h2. */
function Head({ i, children, ...rest }: { i: number; children: ReactNode; className: string; id: string }) {
  return i === 0 ? <h1 {...rest}>{children}</h1> : <h2 {...rest}>{children}</h2>;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function Journey({ beats, data, sheetRef }: JourneyProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<DeskStage | null>(null);
  const [state, setState] = useState<"boot" | "ready" | "flat">("boot");
  const [seen, setSeen] = useState<Set<number>>(() => new Set([0]));
  const motion = useMotion();
  const dataRef = useRef(data);
  dataRef.current = data;
  const framesRef = useRef<{ wide: { x: number; y: number }[]; tall: { x: number; y: number }[] }>({ wide: [], tall: [] });
  framesRef.current = {
    wide: beats.map((b) => b.frame ?? { x: b.side === "left" ? 0.17 : -0.17, y: 0.02 }),
    tall: beats.map((b) => b.frameTall ?? { x: 0, y: -0.2 }),
  };

  // the stage: its own chunk (three.js is most of it), started after first paint
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gone = false;
    let stage: DeskStage | null = null;
    const gl = (() => {
      try {
        const c = document.createElement("canvas");
        return !!(c.getContext("webgl2") || c.getContext("webgl"));
      } catch {
        return false;
      }
    })();
    if (!gl) {
      setState("flat");
      return;
    }
    import("./DeskStage")
      .then(async ({ DeskStage }) => {
        if (gone) return;
        stage = new DeskStage(canvas);
        stage.setData(dataRef.current);
        stage.setFrames(framesRef.current.wide, framesRef.current.tall);
        await stage.load("/3d/desk.glb");
        if (gone) return stage.dispose();
        stageRef.current = stage;
        setState("ready");
        window.dispatchEvent(new Event("scroll"));
      })
      .catch(() => !gone && setState("flat"));
    return () => {
      gone = true;
      stageRef.current = null;
      stage?.dispose();
    };
  }, []);

  useEffect(() => {
    stageRef.current?.setData(data);
  }, [data]);
  useEffect(() => {
    stageRef.current?.setMotion(motion);
  }, [motion, state]);

  // scroll -> station. Station i is where beat i's words are at the middle of the window; between two
  // beats the camera rests a moment at each end and travels in the middle.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let centres: number[] = [];
    let sheetTop = Infinity;
    const measure = () => {
      const vh = window.innerHeight;
      const els = [...root.querySelectorAll<HTMLElement>("[data-beat]")];
      centres = els.map((el, i) => {
        if (i === 0) return 0;
        const words = el.querySelector<HTMLElement>(".beat__words") ?? el;
        const r = words.getBoundingClientRect();
        return Math.max(0, r.top + window.scrollY + r.height / 2 - vh / 2);
      });
      sheetTop = sheetRef.current ? sheetRef.current.getBoundingClientRect().top + window.scrollY : Infinity;
      stageRef.current?.resize();
      onScroll();
    };
    const onScroll = () => {
      const y = window.scrollY;
      const stage = stageRef.current;
      let p = centres.length - 1;
      for (let i = 0; i < centres.length - 1; i++) {
        if (y < centres[i + 1]) {
          p = i + smooth(0.16, 0.84, (y - centres[i]) / Math.max(1, centres[i + 1] - centres[i]));
          break;
        }
      }
      // the plate fades to bare paper on the side where the words stand: weights follow the camera between beats
      const i0 = Math.min(sidesNow.current.length - 1, Math.floor(p));
      const i1 = Math.min(sidesNow.current.length - 1, i0 + 1);
      const f = p - i0;
      const left = (sidesNow.current[i0] === "left" ? 1 - f : 0) + (sidesNow.current[i1] === "left" ? f : 0);
      const hero = i0 === 0 ? 1 - f : 0;
      root.style.setProperty("--mist-l", String(Math.max(0, left - hero)));
      root.style.setProperty("--mist-r", String(1 - left));
      root.style.setProperty("--mist-t", String(hero));
      if (stage) {
        stage.setProgress(motionRef.current ? p : Math.round(p));
        stage.setVisible(y < sheetTop + 40);
      }
      const at = Math.round(p);
      setSeen((s) => (s.has(at) ? s : new Set(s).add(at)));
    };
    const onPointer = (e: PointerEvent) => {
      if (!motionRef.current || e.pointerType !== "mouse") return;
      stageRef.current?.setPointer((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointermove", onPointer, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointer);
    };
  }, [beats.length, sheetRef, state]);
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const sidesNow = useRef<string[]>([]);
  sidesNow.current = beats.map((b) => b.side);

  return (
    <div className={`journey journey--${state}`} ref={rootRef} id="top">
      <div className="stage" aria-hidden="true">
        <canvas ref={canvasRef} className="stage__canvas" />
        <div className="stage__mist stage__mist--l" />
        <div className="stage__mist stage__mist--r" />
        <div className="stage__mist stage__mist--t" />
        <div className="stage__veil" />
      </div>
      {beats.map((b, i) => (
        <section key={b.id} id={b.id} data-beat={i} className={`beat beat--${b.side}${i === 0 ? " beat--hero" : ""}${seen.has(i) ? " is-seen" : ""}`} aria-labelledby={`${b.id}-h`}>
          <div className="beat__words">
            <p className="beat__eyebrow engrave">{b.eyebrow}</p>
            <Head i={i} className="beat__head" id={`${b.id}-h`}>
              <span className="beat__line">
                <span>{b.line1}</span>
              </span>
              <span className="beat__line beat__line--accent">
                <span>{b.line2}</span>
              </span>
            </Head>
            <div className="beat__body">{b.body}</div>
            {b.figure && (
              <p className="beat__figure">
                <b>{b.figure.value}</b>
                <span>{b.figure.label}</span>
              </p>
            )}
            {b.links && b.links.length > 0 && (
              <p className="beat__links">
                {b.links.map((l) => (
                  <a key={l.href} href={l.href} {...(l.external ? { target: "_blank", rel: "noreferrer" } : {})}>
                    {l.label} <span aria-hidden="true">{l.external ? "↗" : "↓"}</span>
                  </a>
                ))}
              </p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
