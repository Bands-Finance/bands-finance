/**
 * THE MAP (bands.finance Play, 24 Sep, the town): an engraved plan of the town drawn to a canvas from the same
 * geometry the world walks (town.ts: the plaza, the boulevard ring, the four streets and PLACES), so the plan and the
 * ground never disagree. No image is loaded: ink lines on paper, the way the plaza's signs are drawn. Found places
 * are named, unfound ones are blank blocks, you are a dot with your heading, and the street the Mint spilled on is
 * ringed while its coins lie there. North (the Exchange's side, -z) is up. The panel redraws a few times a second
 * while open, to follow the dot.
 */
import { useEffect, useRef } from "react";
import { CAPS, INK, PAPER } from "./engraved";
import { DESK_SPOT, GUARD_SPOT, PLACE_IDS, WORLD_RADIUS } from "./protocol";
import { FRONT, KERB_IN, KERB_OUT, PLACES, STREET_ANGLES, STREET_GAP, STREET_HALF_WIDTH_M, TOWN_RADIUS } from "./town";

export interface MapPose {
  x: number;
  z: number;
  /** heading, radians (the figure faces +z turned by this, as the world does)  */
  ry: number;
}

export interface TownMapProps {
  /** where the walker is, read each frame (the world writes it, the page keeps the ref) */
  pose: { readonly current: MapPose };
  /** the place ids reached so far */
  found: readonly string[];
  /** the street the Mint spilled on (an index into STREET_ANGLES), or null when none is spilled */
  spill: number | null;
}

/** the canvas's side in pixels; it is scaled to the panel by CSS */
const SIDE = 720;
/** the town's blocks are this deep behind their fronts, on the plan */
const BLOCK_DEPTH = 14;
/** a street's blocks begin this far out along the street and stand this far off its centre line */
const STREET_BLOCK_FROM = 62;
const STREET_BLOCK_OFF = 9.5;
const TAU = Math.PI * 2;

/** the plaza's own landmarks the eye looks for */
const PLAZA_MARKS: { id: string; name: string; x: number; z: number }[] = [
  { id: PLACE_IDS.desk, name: "The desk", x: DESK_SPOT.x, z: DESK_SPOT.z },
  { id: PLACE_IDS.guardHouse, name: "Guard House", x: GUARD_SPOT.x, z: GUARD_SPOT.z },
  { id: "board", name: "The board", x: 0, z: -20 },
  { id: "notes", name: "Notices", x: -18, z: 20 },
];

export function drawTownMap(c: HTMLCanvasElement, pose: MapPose, found: readonly string[], spill: number | null): void {
  const g = c.getContext("2d");
  if (!g) return;
  const W = c.width;
  const H = c.height;
  const k = (W / 2 - 36) / (TOWN_RADIUS + 14);
  const X = (x: number) => W / 2 + x * k;
  const Y = (z: number) => H / 2 + z * k;
  const ring = (r: number, a0 = 0, a1 = TAU) => {
    // world angles are atan2(x, z): on the plan (x right, z down) that is measured from straight down, clockwise
    g.beginPath();
    g.arc(W / 2, H / 2, r * k, Math.PI / 2 - a0, Math.PI / 2 - a1, true);
  };

  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = INK;
  g.lineJoin = "round";
  g.lineCap = "round";

  // the plaza: its rim, a faint ring of paving, the fountain
  g.lineWidth = 1.6;
  ring(WORLD_RADIUS);
  g.stroke();
  g.lineWidth = 0.6;
  ring(WORLD_RADIUS * 0.55);
  g.stroke();
  g.lineWidth = 1.2;
  ring(4);
  g.stroke();
  g.beginPath();
  g.arc(W / 2, H / 2, 1.2 * k, 0, TAU);
  g.fillStyle = INK;
  g.fill();

  // the boulevard: the inner kerb whole, the outer kerb broken at the four mouths
  g.lineWidth = 0.8;
  ring(KERB_IN);
  g.stroke();
  g.lineWidth = 1.4;
  for (let i = 0; i < STREET_ANGLES.length; i++) {
    const a = STREET_ANGLES[i];
    const b = STREET_ANGLES[(i + 1) % STREET_ANGLES.length] + (i === STREET_ANGLES.length - 1 ? TAU : 0);
    ring(KERB_OUT, a + STREET_GAP, b - STREET_GAP);
    g.stroke();
  }

  // the streets: a corridor each, out to its end, and the domed front that closes it
  for (const a of STREET_ANGLES) {
    const ux = Math.sin(a);
    const uz = Math.cos(a);
    const vx = Math.cos(a);
    const vz = -Math.sin(a);
    g.lineWidth = 1.2;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(X(ux * KERB_OUT + s * vx * STREET_HALF_WIDTH_M), Y(uz * KERB_OUT + s * vz * STREET_HALF_WIDTH_M));
      g.lineTo(X(ux * TOWN_RADIUS + s * vx * STREET_HALF_WIDTH_M), Y(uz * TOWN_RADIUS + s * vz * STREET_HALF_WIDTH_M));
      g.stroke();
    }
    // the blocks either side, hatched
    for (const s of [-1, 1]) {
      const x0 = ux * STREET_BLOCK_FROM + s * vx * STREET_BLOCK_OFF;
      const z0 = uz * STREET_BLOCK_FROM + s * vz * STREET_BLOCK_OFF;
      const len = TOWN_RADIUS - 4 - STREET_BLOCK_FROM;
      g.save();
      g.translate(X(x0), Y(z0));
      g.rotate(Math.atan2(uz, ux));
      block(g, 0, s > 0 ? 0 : -BLOCK_DEPTH * k, len * k, BLOCK_DEPTH * k);
      g.restore();
    }
    // the end: a domed front across the street's head
    const ex = ux * (TOWN_RADIUS + 3);
    const ez = uz * (TOWN_RADIUS + 3);
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(X(ex - vx * 11), Y(ez - vz * 11));
    g.lineTo(X(ex + vx * 11), Y(ez + vz * 11));
    g.stroke();
    g.beginPath();
    g.arc(X(ex + ux * 3), Y(ez + uz * 3), 4 * k, 0, TAU);
    g.stroke();
  }

  // the ring of fronts: a band of blocks between the mouths, hatched like the street blocks
  for (let i = 0; i < STREET_ANGLES.length; i++) {
    const a0 = STREET_ANGLES[i] + STREET_GAP;
    const a1 = STREET_ANGLES[(i + 1) % STREET_ANGLES.length] + (i === STREET_ANGLES.length - 1 ? TAU : 0) - STREET_GAP;
    g.beginPath();
    g.arc(W / 2, H / 2, FRONT * k, Math.PI / 2 - a0, Math.PI / 2 - a1, true);
    g.arc(W / 2, H / 2, (FRONT + BLOCK_DEPTH) * k, Math.PI / 2 - a1, Math.PI / 2 - a0, false);
    g.closePath();
    g.save();
    g.clip();
    hatch(g, 0, 0, W, H);
    g.restore();
    g.lineWidth = 1.2;
    g.stroke();
  }

  // the places: a door mark on the front; found ones named along the radius, unfound ones left blank
  g.font = `600 ${Math.round(k * 4.2)}px ${CAPS}`;
  g.textBaseline = "middle";
  for (const p of PLACES) {
    const isEnd = p.kind === "end";
    const r = Math.hypot(p.x, p.z);
    const ax = p.x / r;
    const az = p.z / r;
    const seen = found.includes(p.id);
    if (!isEnd) {
      // the door: a short bar across the front, filled when found
      g.save();
      g.translate(X(p.x), Y(p.z));
      g.rotate(Math.atan2(az, ax));
      g.fillStyle = seen ? INK : PAPER;
      g.lineWidth = 1;
      g.beginPath();
      g.rect(-0.6 * k, -1.6 * k, 1.2 * k, 3.2 * k);
      g.fill();
      g.stroke();
      g.restore();
    }
    if (!seen) continue;
    g.fillStyle = INK;
    if (isEnd) {
      g.textAlign = "center";
      g.fillText(p.name, X(ax * (TOWN_RADIUS + 12)), Y(az * (TOWN_RADIUS + 12)));
      continue;
    }
    // the name reads outward along the radius, past the block, turned to stay upright on the west side
    const angle = Math.atan2(az, ax);
    const flip = ax < 0;
    g.save();
    g.translate(X(ax * (FRONT + BLOCK_DEPTH + 1.5)), Y(az * (FRONT + BLOCK_DEPTH + 1.5)));
    g.rotate(flip ? angle + Math.PI : angle);
    g.textAlign = flip ? "right" : "left";
    g.fillText(p.name, 0, 0);
    g.restore();
  }

  // the plaza's own: the desk, the Guard House, the boards
  g.font = `600 ${Math.round(k * 3.6)}px ${CAPS}`;
  g.textAlign = "center";
  for (const m of PLAZA_MARKS) {
    g.fillStyle = INK;
    g.fillRect(X(m.x) - 1.4 * k, Y(m.z) - 1.4 * k, 2.8 * k, 2.8 * k);
    g.fillText(m.name, X(m.x), Y(m.z) + 4 * k);
  }

  // the Mint's spill: the street it fell on ringed, mouth to end, a double line so it reads over the kerbs
  if (spill !== null && spill >= 0 && spill < STREET_ANGLES.length) {
    const a = STREET_ANGLES[spill];
    const mid = (KERB_OUT + TOWN_RADIUS) / 2;
    const len = TOWN_RADIUS - KERB_OUT + 8;
    const wide = STREET_HALF_WIDTH_M * 2 + 8;
    g.save();
    g.translate(X(Math.sin(a) * mid), Y(Math.cos(a) * mid));
    g.rotate(Math.atan2(Math.cos(a), Math.sin(a)));
    for (const [w, lw] of [[0, 2], [2.4, 0.8]] as const) {
      g.lineWidth = lw;
      g.beginPath();
      g.roundRect((-len / 2 - w) * k, (-wide / 2 - w) * k, (len + 2 * w) * k, (wide + 2 * w) * k, (wide / 2 + w) * k);
      g.stroke();
    }
    g.restore();
  }

  // you: a dot with its heading
  const hx = Math.sin(pose.ry);
  const hz = Math.cos(pose.ry);
  g.fillStyle = INK;
  g.beginPath();
  g.arc(X(pose.x), Y(pose.z), 2 * k, 0, TAU);
  g.fill();
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(X(pose.x), Y(pose.z));
  g.lineTo(X(pose.x + hx * 5), Y(pose.z + hz * 5));
  g.stroke();
  g.fillStyle = PAPER;
  g.beginPath();
  g.arc(X(pose.x), Y(pose.z), 0.8 * k, 0, TAU);
  g.fill();

  // north
  g.fillStyle = INK;
  g.font = `600 ${Math.round(k * 5)}px ${CAPS}`;
  g.textAlign = "center";
  g.fillText("N", W / 2, 22);
}

/** a hatched block on the plan: the engraving's shading for built ground */
function block(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  hatch(g, x, y, x + w, y + h);
  g.restore();
  g.lineWidth = 1.2;
  g.strokeRect(x, y, w, h);
}

/** fine diagonal lines over the rectangle x0,y0..x1,y1 (the caller clips to the shape it wants shaded) */
function hatch(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  const h = y1 - y0;
  g.lineWidth = 0.5;
  g.beginPath();
  for (let d = x0 - h; d < x1; d += 5) {
    g.moveTo(d, y0);
    g.lineTo(d + h, y1);
  }
  g.stroke();
}

export function TownMap({ pose, found, spill }: TownMapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => drawTownMap(c, pose.current, found, spill);
    draw();
    const timer = window.setInterval(draw, 300);
    return () => window.clearInterval(timer);
  }, [pose, found, spill]);
  return (
    <div className="play__map">
      <p className="play-eyebrow">The town</p>
      <canvas ref={ref} width={SIDE} height={SIDE} role="img" aria-label="A plan of the town: the plaza, the ring, the four streets, and the places you have found" />
      <p className="play__map-key">Named doors are the ones you have found. A ring marks the street the Mint spilled on. M closes the map.</p>
    </div>
  );
}
