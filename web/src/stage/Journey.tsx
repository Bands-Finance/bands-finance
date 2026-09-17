import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMotion } from "../motion";
import type { DeskStage, StageData } from "./DeskStage";
// the model is a hashed asset like the scripts, so it can be cached for good and still change with every export
import deskUrl from "../../3d/desk.glb?url";
import "./Journey.css";

/**
 * THE JOURNEY: the whole page. One engraved desk stays fixed behind the document while the reader's scroll
 * walks a camera round it. Every chapter is a beat: a block of words on the paper side of the window (a
 * two-line headline, ink then orange, a few plain sentences, then whatever the chapter proves itself with:
 * his open bands, the fees table, the ledger of moves) and a station on the desk the camera stands at while
 * those words are read. Between blocks the camera travels; while a long block scrolls past, it drifts.
 *
 * Per frame there is no React: the scroll handler turns the page's position into a station number and hands
 * it to the stage. React hears about it only when a new beat comes into view.
 */

export interface Beat {
  id: string;
  /** the camera station on the desk (web/3d/build_desk.py names them) */
  station: string;
  /** which side the words stand on in a wide window */
  side: "left" | "right";
  /** a wider column, for a chapter that carries a table or a list */
  wide?: boolean;
  /** where the camera puts its subject, as a shift of the picture in window fractions (x right, y down); default: away from the words */
  frame?: { x: number; y: number };
  /** the same for a tall window (a phone), where the words pass over the subject; default: a fifth of the window up */
  frameTall?: { x: number; y: number };
  eyebrow: string;
  line1: string;
  line2: string;
  /** the second line in ink-green or ink-red instead of orange: a band that is earning, a band that is out */
  tone?: "good" | "bad";
  body?: ReactNode;
  /** one live figure with its label, set in the mono */
  figure?: { value: string; label: string } | null;
  links?: { href: string; label: string; external?: boolean }[];
  /** what the chapter proves itself with: figures, a table, the ledger */
  content?: ReactNode;
  /** small tags pinned to things on the desk while this beat is in view: "row0.cursor", "row0.low", "row0.high" */
  labels?: { anchor: string; text: string; strong?: boolean }[];
}

interface JourneyProps {
  beats: Beat[];
  data: StageData;
  /** drawn over the first window's foot: the ticker tape */
  heroFoot?: ReactNode;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The hero's headline is the page's h1; the other beats are h2. */
function Head({ i, children, ...rest }: { i: number; children: ReactNode; className: string; id: string }) {
  return i === 0 ? <h1 {...rest}>{children}</h1> : <h2 {...rest}>{children}</h2>;
}

export function Journey({ beats, data, heroFoot }: JourneyProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<DeskStage | null>(null);
  const [state, setState] = useState<"boot" | "ready" | "flat">("boot");
  const [seen, setSeen] = useState<Set<number>>(() => new Set([0]));
  const [at, setAt] = useState(0);
  const motion = useMotion();
  const dataRef = useRef(data);
  dataRef.current = data;
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const beatsRef = useRef(beats);
  beatsRef.current = beats;
  const sideRef = useRef<"left" | "right">("left");
  const routeKey = beats.map((b) => b.station).join("|");
  const frameKey = beats.map((b) => `${b.side}${b.wide ? "w" : ""}${b.frame ? `${b.frame.x},${b.frame.y}` : ""}`).join("|");

  const framing = () => ({
    wide: beatsRef.current.map((b) => b.frame ?? { x: (b.side === "left" ? 1 : -1) * (b.wide ? 0.23 : 0.17), y: 0.02 }),
    tall: beatsRef.current.map((b) => b.frameTall ?? { x: 0, y: -0.2 }),
  });

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
        stage.setRoute(beatsRef.current.map((b) => b.station));
        const f = framing();
        stage.setFrames(f.wide, f.tall);
        await stage.load(deskUrl);
        if (gone) return stage.dispose();
        stageRef.current = stage;
        (window as unknown as { __desk?: DeskStage }).__desk = stage; // for looking at the camera from the console
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
  }, [data, state]);
  useEffect(() => {
    stageRef.current?.setMotion(motion);
  }, [motion, state]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.setRoute(beatsRef.current.map((b) => b.station));
    const f = framing();
    stage.setFrames(f.wide, f.tall);
    window.dispatchEvent(new Event("scroll"));
  }, [routeKey, frameKey, state]);

  // the tags pinned to the desk follow it, frame by frame, without React
  useEffect(() => {
    const stage = stageRef.current;
    const layer = labelsRef.current;
    if (!stage || !layer) return;
    stage.onFrame = () => {
      for (const el of layer.children as unknown as HTMLElement[]) {
        const pt = stage.project(el.dataset.anchor ?? "");
        // a tag that would land under the words is not shown
        const w = window.innerWidth;
        const under = pt && (sideRef.current === "left" ? pt.x < w * 0.5 : pt.x > w * 0.5);
        if (!pt || under) {
          el.style.opacity = "0";
          continue;
        }
        el.style.opacity = "";
        el.style.transform = `translate3d(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px, 0)`;
      }
    };
    return () => {
      stage.onFrame = null;
    };
  }, [state, at]);

  // scroll -> station. A beat holds its station from the moment its words are a quarter of the way down the
  // window until their foot is three quarters down (a short block: while it is centred); between two beats
  // the camera travels. A long block reports how far through it the reader is, and the camera drifts.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let enter: number[] = [];
    let exit: number[] = [];
    const measure = () => {
      const vh = window.innerHeight;
      const els = [...root.querySelectorAll<HTMLElement>("[data-beat] .beat__words")];
      enter = [];
      exit = [];
      els.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const top = r.top + window.scrollY;
        if (r.height <= vh * 0.5) {
          const c = Math.max(0, top + r.height / 2 - vh / 2);
          enter.push(i === 0 ? 0 : c);
          exit.push(i === 0 ? Math.max(0, c) : c);
        } else {
          enter.push(i === 0 ? 0 : Math.max(0, top - vh * 0.25));
          exit.push(Math.max(0, top + r.height - vh * 0.75));
        }
      });
      stageRef.current?.resize();
      onScroll();
    };
    const onScroll = () => {
      const y = window.scrollY;
      const stage = stageRef.current;
      const n = enter.length;
      if (!n) return;
      let p = n - 1;
      let hold = 1;
      for (let i = 0; i < n; i++) {
        if (y <= exit[i]) {
          if (y >= enter[i]) {
            p = i;
            hold = exit[i] > enter[i] ? (y - enter[i]) / (exit[i] - enter[i]) : 0.5;
          } else {
            const from = i === 0 ? 0 : exit[i - 1];
            p = i === 0 ? 0 : i - 1 + smooth(0.08, 0.92, (y - from) / Math.max(1, enter[i] - from));
            hold = p < i - 0.5 ? 1 : 0;
          }
          break;
        }
      }
      // the plate fades to bare paper on the side where the words stand: weights follow the camera between beats
      const bs = beatsRef.current;
      const i0 = Math.min(bs.length - 1, Math.floor(p));
      const i1 = Math.min(bs.length - 1, i0 + 1);
      const f = p - i0;
      const left = (bs[i0]?.side === "left" ? 1 - f : 0) + (bs[i1]?.side === "left" ? f : 0);
      const wide = (bs[i0]?.wide ? 1 - f : 0) + (bs[i1]?.wide ? f : 0);
      const hero = i0 === 0 ? 1 - f : 0;
      root.style.setProperty("--mist-l", String(Math.max(0, left - hero)));
      root.style.setProperty("--mist-r", String(1 - left));
      root.style.setProperty("--mist-t", String(hero));
      root.style.setProperty("--mist-wide", wide.toFixed(3));
      if (stage) stage.setProgress(motionRef.current ? p : Math.round(p), hold);
      const now = Math.round(p);
      setAt((a) => (a === now ? a : now));
      setSeen((s) => (s.has(now) ? s : new Set(s).add(now)));
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
  }, [beats.length, state]);

  const labels = beats[at]?.labels ?? [];
  sideRef.current = beats[at]?.side ?? "left";

  return (
    <div className={`journey journey--${state}`} ref={rootRef} id="top">
      <div className="stage" aria-hidden="true">
        <canvas ref={canvasRef} className="stage__canvas" />
        <div className="stage__mist stage__mist--l" />
        <div className="stage__mist stage__mist--r" />
        <div className="stage__mist stage__mist--t" />
        <div className="stage__labels" ref={labelsRef}>
          {labels.map((l) => (
            <span key={l.anchor} data-anchor={l.anchor} className={`stage__tag${l.strong ? " stage__tag--strong" : ""}`}>
              <i />
              <b>{l.text}</b>
            </span>
          ))}
        </div>
        <div className="stage__veil" />
      </div>
      {beats.map((b, i) => (
        <section key={b.id} id={b.id} data-beat={i} className={`beat beat--${b.side}${b.wide ? " beat--wide" : ""}${i === 0 ? " beat--hero" : ""}${seen.has(i) ? " is-seen" : ""}`} aria-labelledby={`${b.id}-h`}>
          <div className="beat__words">
            <p className="beat__eyebrow engrave">{b.eyebrow}</p>
            <Head i={i} className="beat__head" id={`${b.id}-h`}>
              <span className="beat__line">
                <span>{b.line1}</span>
              </span>
              <span className={`beat__line beat__line--accent${b.tone ? ` beat__line--${b.tone}` : ""}`}>
                <span>{b.line2}</span>
              </span>
            </Head>
            {b.body && <div className="beat__body">{b.body}</div>}
            {b.figure && (
              <p className="beat__figure">
                <b>{b.figure.value}</b>
                <span>{b.figure.label}</span>
              </p>
            )}
            {b.content && <div className="beat__content">{b.content}</div>}
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
          {i === 0 && heroFoot && <div className="beat__foot">{heroFoot}</div>}
        </section>
      ))}
    </div>
  );
}
