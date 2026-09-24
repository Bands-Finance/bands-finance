// the Exchange with the city round it, for looking at the scene (play-dev-city.html). Place the view from the URL:
// ?x=&z= (where you stand), &yaw= (the camera's heading round you), &dist= (4.5..18), &pitch= (0.08..1.1).
// It measures what the city costs (draw calls and triangles, with and without it) and prints it in the title and the console.
import type * as THREE from "three";
import { buildCity } from "./city";
import { ExchangeWorld } from "./World";

interface Peek {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  me: { root: THREE.Object3D };
  yaw: number;
  dist: number;
  pitch: number;
}

const canvas = document.getElementById("c") as HTMLCanvasElement;
const world = new ExchangeWorld(canvas, { onNear() {}, onMove() {}, onInteract() {} });
const peek = world as unknown as Peek;
world.setMe("You", 0);
world.setBoard([
  { label: "CARDS / USDC", feePct: 0.696, venue: "meteora" },
  { label: "ALLINU / SOL", feePct: 0.392, venue: "meteora" },
  { label: "GP / SOL", feePct: 0.195, venue: "raydium" },
  { label: "EMBER / SOL", feePct: 0.104, venue: "orca" },
  { label: "SILV / USDC", feePct: 0.095, venue: "orca" },
  { label: "HIMS / SOL", feePct: 0.131, venue: "raydium" },
  { label: "baton / SOL", feePct: 0.097, venue: "meteora" },
  { label: "DJT / USDC", feePct: 0.07, venue: "orca" },
]);
world.setNotes(["A post of the same shape as my last one is no longer held back once 3 hours have passed."]);

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
peek.me.root.position.set(num("x", 0), 0, num("z", 20));
peek.yaw = num("yaw", 0);
peek.dist = num("dist", 9.5);
peek.pitch = num("pitch", 0.26);

const frames = (n: number) =>
  new Promise<void>((done) => {
    const f = () => (--n <= 0 ? done() : requestAnimationFrame(f));
    requestAnimationFrame(f);
  });

(async () => {
  // the world builds its city now: find it, and time a second build on its own
  const t0 = performance.now();
  buildCity();
  const buildMs = Math.round(performance.now() - t0);
  const city = { root: peek.scene.getObjectByName("city") as THREE.Object3D };
  // let the camera ease into place, then render the same frame with and without the city
  await frames(90);
  const w = world as unknown as { paused: boolean; camera: THREE.Camera };
  w.paused = true;
  const info = peek.renderer.info.render;
  peek.renderer.render(peek.scene, w.camera);
  const all = { calls: info.calls, triangles: info.triangles };
  city.root.visible = false;
  peek.renderer.render(peek.scene, w.camera);
  const base = { calls: info.calls, triangles: info.triangles };
  city.root.visible = true;
  w.paused = false;
  const report = {
    buildMs,
    baseCalls: base.calls,
    cityCalls: all.calls - base.calls,
    baseTris: base.triangles,
    cityTris: all.triangles - base.triangles,
    ...(city.root.userData.stats as object),
  };
  console.log("city", JSON.stringify(report));
  document.title = `city ${JSON.stringify(report)}`;
  (window as unknown as { city: unknown }).city = { city, report, world };
  document.body.classList.add("journey--ready");
})();
