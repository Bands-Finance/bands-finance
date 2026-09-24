// the figures alone, in the plaza, for looking at them (play-dev-figure.html). A lineup of five visitors and Mr Bands
// round (0, 0, 12). From the URL:
//   speeds=1,1.6,0,0,1,0  seeds=1,2,3,4,5  gap=2  side=1 (turn them to show their profiles)  only=i (one figure, at x = 0)
//   g=wave|tip-hat|cheer|shrug (what the gesturing ones do)  mrg=… (Mr Bands' gesture)  every=2.4 (seconds between gestures)
//   freeze=T (run the clock to T seconds in 60 fps steps, then hold the pose)
//   fx=0&fz=12&dist=9.5&yaw=0&pitch=0.26 (the game's own camera)  cam=x,y,z&look=x,y,z (a free camera)
//   test=1 (a pop test and animate()'s cost, in the footer)  plot=1 (the joints and the body's height, frame by frame)
import * as THREE from "three";
import { ExchangeWorld } from "./World";
import { drawCount, makeFigure, type Figure, type Gesture } from "./figure";
import { STRAPS } from "./protocol";

interface Priv {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  me: { root: THREE.Group };
  yaw: number;
  pitch: number;
  dist: number;
  step(dt: number, now: number): void;
}

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const list = (k: string) => (q.get(k) ?? "").split(",").filter(Boolean).map(Number);
const vec = (k: string) => {
  const a = list(k);
  return a.length === 3 ? new THREE.Vector3(a[0], a[1], a[2]) : null;
};

const canvas = document.getElementById("c") as HTMLCanvasElement;
const world = new ExchangeWorld(canvas, { onNear() {}, onMove() {}, onInteract() {} });
const w = world as unknown as Priv;
w.me.root.visible = false;
// the world's own passers-by (the old walkers) would wander through the lineup
for (const s of (world as unknown as { strollers?: { w: { root: THREE.Object3D } }[] }).strollers ?? []) s.w.root.visible = false;

interface Actor {
  fig: Figure;
  speed: number;
  g: Gesture | null;
  next: number;
}
const seeds = list("seeds");
const speeds = list("speeds");
const g = (q.get("g") as Gesture | null) ?? "wave";
const mrg = q.get("mrg") as Gesture | null;
const every = num("every", 2.4);
const defaults = [1, 1.6, 0, 0, 1, 0];
let cast: Actor[] = [0, 1, 2, 3, 4].map((i) => ({
  fig: makeFigure({ strap: STRAPS[i + 1], seed: seeds[i] ?? i + 1 }),
  speed: speeds[i] ?? defaults[i],
  g: i === 3 || q.has("gall") ? g : null,
  next: 0.2,
}));
cast.push({ fig: makeFigure({ strap: STRAPS[0], kind: "mrbands" }), speed: speeds[5] ?? 0, g: mrg, next: 0.2 });
if (q.has("only")) cast = [cast[num("only", 0)]];

const gap = num("gap", 2);
const side = q.has("side");
cast.forEach((a, i) => {
  a.fig.root.position.set((i - (cast.length - 1) / 2) * gap, 0, 12);
  a.fig.root.rotation.y = side ? Math.PI / 2 : 0;
  w.scene.add(a.fig.root);
});

const fx = num("fx", 0);
const fz = num("fz", 12);
w.me.root.position.set(fx, 0, fz);
w.yaw = num("yaw", 0);
w.pitch = num("pitch", 0.26);
w.dist = num("dist", 9.5);
const cam = vec("cam");
const look = vec("look") ?? new THREE.Vector3(fx, 1.2, fz);

function tick(dt: number, t: number) {
  for (const a of cast) {
    if (a.g && t >= a.next) {
      a.fig.gesture(a.g);
      a.next += every;
    }
    a.fig.animate(dt, a.speed, t);
  }
}

const freeze = q.has("freeze") ? num("freeze", 0) : null;
let clock = 0;
if (freeze !== null) {
  const steps = Math.round(freeze * 60);
  for (let i = 0; i < steps; i++) {
    clock += 1 / 60;
    tick(1 / 60, clock);
  }
}

// the world's own step moves its camera; after it, the figures move and a free camera (if asked for) takes over
const step = w.step.bind(world);
w.step = (dt: number, now: number) => {
  step(dt, now);
  if (freeze === null) {
    clock += dt;
    tick(dt, clock);
  }
  if (cam) {
    w.camera.position.copy(cam);
    w.camera.lookAt(look);
  }
};

// ?test: how far any joint moves in one 60 fps frame through speed changes (0 → 1 → 1.6 → 0) and a gesture cut short by
// another, against the walk's own largest step; and what animate() costs for 25 figures
function popTest(): string {
  const f = makeFigure({ strap: STRAPS[2], seed: 9 });
  const joints: THREE.Object3D[] = [];
  f.root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) joints.push(o);
  });
  // a pop is a break in the motion: the second difference of a joint's angle (or height x10) from one frame to the next
  const hist = joints.map(() => [new Float64Array(4), new Float64Array(4)]);
  const read = (o: THREE.Object3D, out: Float64Array) => {
    out[0] = o.rotation.x; out[1] = o.rotation.y; out[2] = o.rotation.z; out[3] = o.position.y * 10;
  };
  const dt = 1 / 60;
  let worstSteady = 0, whereSteady = "";
  let worstChange = 0, where = "";
  const cur = new Float64Array(4);
  for (let i = 0; i < 60 * 8; i++) {
    const t = i * dt;
    const sp = t < 1 ? 0 : t < 2.5 ? 1 : t < 4 ? 1.6 : t < 5.5 ? 0 : 1;
    if (Math.abs(t - 4.3) < dt / 2) f.gesture("wave");
    if (Math.abs(t - 4.9) < dt / 2) f.gesture("cheer");
    if (Math.abs(t - 6.2) < dt / 2) f.gesture("tip-hat");
    if (Math.abs(t - 6.8) < dt / 2) f.gesture("shrug");
    f.animate(dt, sp, t);
    const near = [1, 2.5, 4, 4.3, 4.9, 5.5, 6.2, 6.8].some((c) => t >= c && t < c + 0.3);
    joints.forEach((o, k) => {
      const [p1, p2] = hist[k];
      read(o, cur);
      if (i > 1) {
        let d = 0;
        for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(cur[c] - 2 * p1[c] + p2[c]));
        const label = `${t.toFixed(2)}s ${o.name || o.type}`;
        if (near && d > worstChange) { worstChange = d; where = label; }
        if (!near && d > worstSteady) { worstSteady = d; whereSteady = label; }
      }
      p2.set(p1);
      p1.set(cur);
    });
  }
  const crowd = Array.from({ length: 25 }, (_, i) => makeFigure({ strap: STRAPS[i % 6], seed: 100 + i }));
  const t0 = performance.now();
  for (let i = 0; i < 600; i++) crowd.forEach((c, k) => c.animate(dt, k % 3 === 0 ? 0 : k % 3 === 1 ? 1 : 1.6, i * dt));
  const per = (performance.now() - t0) / 600;
  return `jerk per frame: steady walk/run/idle ${worstSteady.toFixed(3)} (${whereSteady}); at speed changes and gestures ${worstChange.toFixed(3)} (${where}). animate() x25: ${per.toFixed(3)} ms`;
}
const testLine = q.has("test") ? popTest() : "";

// ?plot: the body's height (x10), the left thigh, knee and ankle, and the front skirt, frame by frame through
// idle → walk → run → idle, so a corner in any of them shows
function plot() {
  const f = makeFigure({ strap: STRAPS[2], seed: 9 });
  const find = (n: string) => f.root.getObjectByName(n)!;
  const body = find("body"), th = find("thighL"), kn = find("kneeL"), an = find("ankleL"), sh = find("shoulderR");
  const skirt = th.parent!.children.find((c) => (c as THREE.Mesh).isMesh)!;
  const series: number[][] = [[], [], [], [], [], []];
  const dt = 1 / 60;
  const N = 60 * 6;
  for (let i = 0; i < N; i++) {
    const t = i * dt;
    const sp = t < 0.5 ? 0 : t < 2.5 ? 1 : t < 4.5 ? 1.6 : 0;
    if (Math.abs(t - 3.2) < dt / 2) f.gesture("wave");
    if (Math.abs(t - 3.6) < dt / 2) f.gesture("cheer");
    f.animate(dt, sp, t);
    series[0].push(body.position.y * 10);
    series[1].push(th.rotation.x);
    series[2].push(kn.rotation.x);
    series[3].push(an.rotation.x);
    series[4].push(skirt.rotation.x);
    series[5].push(sh.rotation.z);
  }
  const c = document.createElement("canvas");
  c.width = 1280;
  c.height = 800;
  c.style.cssText = "position:fixed;inset:0;width:100%;height:100%;background:#fff;z-index:5";
  document.body.appendChild(c);
  const g = c.getContext("2d")!;
  const colors = ["#000", "#c33", "#36c", "#393", "#c80", "#909"];
  const names = ["body y x10", "thigh L", "knee L", "ankle L", "skirt (first mesh)", "shoulder R z"];
  const rows = series.length;
  const hh = 800 / rows;
  series.forEach((arr, k) => {
    const lo = Math.min(...arr), hi = Math.max(...arr);
    const y0 = k * hh;
    g.strokeStyle = "#ddd";
    g.strokeRect(0, y0, 1280, hh);
    g.fillStyle = colors[k];
    g.font = "12px sans-serif";
    g.fillText(`${names[k]}  [${lo.toFixed(2)}, ${hi.toFixed(2)}]`, 6, y0 + 14);
    g.beginPath();
    arr.forEach((v, i) => {
      const x = (i / (N - 1)) * 1280;
      const y = y0 + hh - 6 - ((v - lo) / (hi - lo || 1)) * (hh - 22);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.strokeStyle = colors[k];
    g.lineWidth = 1.5;
    g.stroke();
    for (let i = 0; i < N; i++) if (i % 60 === 0) g.fillRect((i / (N - 1)) * 1280, y0 + hh - 4, 1, 4);
  });
}
if (q.has("plot")) plot();

const info = document.getElementById("info")!;
let frames = 0;
function report() {
  const counts = cast.map((a) => drawCount(a.fig)).join(" · ");
  const heights = cast.map((a) => a.fig.height.toFixed(2)).join(" · ");
  info.textContent = `draws per figure: ${counts}   heights: ${heights}   frame calls: ${w.renderer.info.render.calls}   ${testLine}`;
  if (++frames === 3) document.body.classList.add("journey--ready");
  if (frames < 200) requestAnimationFrame(report);
}
requestAnimationFrame(report);
(window as unknown as { figs: Actor[] }).figs = cast;
