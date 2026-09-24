// the Exchange alone, for looking at the scene (play-dev.html): a sample board, his notes, and a camera you can set from the URL (?x=&z=&yaw=)
import { ExchangeWorld } from "./World";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const w = new ExchangeWorld(canvas, { onNear: () => undefined, onMove: () => undefined, onInteract: () => undefined });
(window as unknown as { world: ExchangeWorld }).world = w;
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
w.addRemote("a", "Brass Heron 42", 1, 4, 14, Math.PI);
w.addRemote("b", "Quiet Ledger 07", 2, -3, 12, Math.PI * 0.8);
w.bubble("a", "Nice band");
w.loadDesk().then(() => document.body.classList.add("journey--ready"));
const q = new URLSearchParams(location.search);
if (q.has("x")) (w as unknown as { me: { root: { position: { set(x: number, y: number, z: number): void } } } }).me.root.position.set(Number(q.get("x")), 0, Number(q.get("z") ?? 0));
if (q.has("yaw")) (w as unknown as { yaw: number }).yaw = Number(q.get("yaw"));
