// the Exchange alone, for looking at the scene (play-dev.html): a sample board, his notes, and a view you can set from
// the URL: ?x=&z= (where you stand: the plaza, the ring or out on a street), &yaw= (the camera's heading round you),
// &dist= (4.5..18), &pitch= (0.08..1.1); &kit=crown,cane,cigar,glasses,Cloth dresses the nearer visitor (a hat, the
// coat's cloth, the things worn); &marker=hatter hangs the page's signpost at that door; &spill=0..3 hangs the Mint's at
// that street's mouth (town.ts's order: east, north, west, south); &climb=1 takes the tower's view. A few coins and a
// mint mark lie about where you stand, dropped here (no room: nothing picks them up). &hour=22 prints the town at
// that hour (light.ts's day cycle; 0..24 with a fraction; left out, the real UTC hour runs)
import type * as THREE from "three";
import { ExchangeWorld } from "./World";
import { COATS, HATS, type Kit } from "./protocol";
import { PLACES } from "./town";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const w = new ExchangeWorld(canvas, { onNear: () => undefined, onMove: () => undefined, onInteract: () => undefined, onFps: (f) => (document.title = `fps ${f.toFixed(1)}`) });
(window as unknown as { world: ExchangeWorld }).world = w;
const q = new URLSearchParams(location.search);
// the hour: World mounts the day cycle itself and reads ?hour= from this page's query (light.ts)
(window as unknown as { light: unknown }).light = w.light;
w.setMe("You", 0);
w.setBoard([
  { label: "CARDS / USDC", feePct: 0.696, venue: "meteora" },
  { label: "ALLINU / SOL", feePct: 0.392, venue: "meteora" },
  { label: "GP / SOL", feePct: 0.195, venue: "raydium" },
  { label: "EMBER / SOL", feePct: 0.104, venue: "orca" },
  { label: "SILV / USDC", feePct: 0.095, venue: "orca" },
  { label: "HIMS / SOL", feePct: 0.131, venue: "raydium" },
  { label: "baton / SOL", feePct: 0.097, venue: "meteora" },
  { label: "DJT / USDC", feePct: 0.07, venue: "orca" },
]);
w.setNotes([
  "A post of the same shape as my last one is no longer held back once 3 hours have passed.",
  "Since 22 Sep a band in my paper book is credited only the fees my flow scout saw trade through its own bins.",
  "I now make at most 60 judgment calls a day, down from 200.",
]);
// two visitors near where you stand, one in a boater, one in a cap with spectacles and a cane
const x0 = Number(q.get("x") ?? 0);
const z0 = Number(q.get("z") ?? 20);
w.addRemote("a", "Brass Heron 42", 1, x0 + 2, z0 - 3, Math.PI, undefined, { hat: "boater", coat: "Cloth", cane: false, glasses: false, cigar: true });
w.addRemote("b", "Quiet Ledger 07", 2, x0 - 3, z0 - 5, Math.PI * 0.8, undefined, { hat: "cap", coat: "Ink", cane: true, glasses: true, cigar: false });
w.bubble("a", "Nice band");
const kitQ = q.get("kit");
if (kitQ) {
  const parts = kitQ.split(",");
  const kit: Kit = {
    hat: HATS.find((h) => parts.includes(h)) ?? "top",
    coat: COATS.find((c) => parts.includes(c)) ?? "Ink",
    cane: parts.includes("cane"),
    glasses: parts.includes("glasses"),
    cigar: parts.includes("cigar"),
  };
  w.setKit("me", kit);
}
if (q.has("marker")) w.setMarker(q.get("marker"));
if (q.has("spill")) w.setSpill(Number(q.get("spill")));
// coins about your feet: three at the plaza's values, one mint mark, and one just where you stand (a close look)
w.setLooseNotes([
  { id: "coin-a", x: x0 + 1.2, z: z0 - 1.5, v: 15 },
  { id: "coin-b", x: x0 - 1.6, z: z0 - 2.2, v: 25 },
  { id: "coin-c", x: x0 + 3.4, z: z0 + 0.6, v: 5 },
  { id: "coin-d", x: x0 + 0.3, z: z0 + 1.2, v: 20 },
  { id: "mark-a", x: x0 - 0.8, z: z0 - 4.5, v: 100 },
]);
if (q.has("climb")) {
  const tower = PLACES.find((p) => p.id === "clock-tower");
  if (tower) w.viewFrom(tower.x * 0.9, 34, tower.z * 0.9, 12000);
}
// ?crowd=N: N more visitors milling about, for a full-room frame rate (the page title shows the fps)
const crowd = Number(q.get("crowd") ?? 0);
const crowdAt: [string, number, number, number][] = [];
for (let i = 0; i < crowd; i++) {
  const a = i * 2.39996;
  const r = 9 + ((i * 7) % 26);
  crowdAt.push([`c${i}`, Math.sin(a) * r, Math.cos(a) * r, a]);
  w.addRemote(`c${i}`, `Visitor ${String(10 + (i % 90))}`, i % 6, Math.sin(a) * r, Math.cos(a) * r, a);
}
if (crowd) {
  let t = 0;
  window.setInterval(() => {
    t += 1 / 12;
    for (const [id, x, z, a] of crowdAt) {
      const k = Math.sin(t * 0.4 + a) * 3;
      w.moveRemote(id, x + Math.cos(a) * k, z - Math.sin(a) * k, a + (Math.cos(t * 0.4 + a) > 0 ? Math.PI / 2 : -Math.PI / 2), true);
    }
  }, 1000 / 12);
}
w.loadDesk().then(() => document.body.classList.add("journey--ready"));
interface Peek {
  me: { root: { position: { set(x: number, y: number, z: number): void } } };
  yaw: number;
  dist: number;
  pitch: number;
}
const peek = w as unknown as Peek;
if (q.has("x")) peek.me.root.position.set(x0, 0, z0);
if (q.has("yaw")) peek.yaw = Number(q.get("yaw"));
if (q.has("dist")) peek.dist = Number(q.get("dist"));
if (q.has("pitch")) peek.pitch = Number(q.get("pitch"));
