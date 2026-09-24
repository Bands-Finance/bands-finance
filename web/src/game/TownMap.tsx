/**
 * THE MAP (bands.finance Play, 24 Sep, the town): an engraved plan of the town drawn to a canvas from the same
 * geometry the world walks (town.ts: the plaza, the boulevard ring, the four streets, the ring road and the quarters,
 * and PLACES), so the plan and the ground never disagree. No image is loaded: ink lines on paper, the way the plaza's
 * signs are drawn. Found places are named, unfound ones are blank blocks, you are a dot with your heading, and the
 * street the Mint spilled on is ringed while its coins lie there. North (the Exchange's side, -z) is up. The panel
 * redraws a few times a second while open, to follow the dot.
 *
 * THE MINI-MAP (the town alive): the same plan, drawn once to an offscreen canvas at the mini-map's scale and blitted
 * into a 150 px round window in the HUD's corner, centred on you and turned so the way you face is up. Coins within
 * MINI_REACH_M are dots on it (they are cheap to draw and the room says where they are), the Mint's spill is its rung
 * from the plan, and a tap opens the full map. It draws at a few frames a second from the same pose ref the full map
 * reads: no render of the page follows a step.
 */
import { useEffect, useRef } from "react";
import { CAPS, INK, PAPER } from "./engraved";
import { DESK_SPOT, GUARD_SPOT, PLACE_IDS, WORLD_RADIUS } from "./protocol";
import {
  FRONT,
  KERB_IN,
  KERB_OUT,
  LANE_T,
  PLACES,
  QUARTER_CORNER_R,
  QUARTER_EDGE_M,
  QUARTER_OPEN,
  QUARTERS,
  RING_ROAD_BLOCK_D,
  RING_ROAD_FRONT_IN,
  RING_ROAD_FRONT_OUT,
  RING_ROAD_IN,
  RING_ROAD_OUT,
  STREET_ANGLES,
  STREET_BLOCK_T,
  STREET_GAP,
  STREET_HALF_WIDTH_M,
  TOWN_RADIUS,
  toWorld,
  type Quarter,
} from "./town";

export interface MapPose {
  x: number;
  z: number;
  /** heading, radians (the figure faces +z turned by this, as the world does)  */
  ry: number;
}

/** a coin on the ground, as the room lists it */
export interface MapCoin {
  x: number;
  z: number;
}

export interface TownMapProps {
  /** where the walker is, read each frame (the world writes it, the page keeps the ref) */
  pose: { readonly current: MapPose };
  /** the place ids reached so far */
  found: readonly string[];
  /** the street the Mint spilled on (an index into STREET_ANGLES), or null when none is spilled */
  spill: number | null;
}

export interface MiniMapProps extends TownMapProps {
  /** the coins on the ground, by the wire's id (the page keeps the map up from the room's word) */
  coins: { readonly current: ReadonlyMap<string, MapCoin> };
  /** a tap: the full map */
  onOpen(): void;
}

/** the canvas's side in pixels; it is scaled to the panel by CSS */
const SIDE = 960;
/** the mini-map's side in CSS pixels, and how far it sees: coins this far off are on it */
export const MINI_SIDE_PX = 150;
export const MINI_REACH_M = 60;
/** the town's blocks are this deep behind their fronts, on the plan (city.ts's lots; town.ts keeps a quarter this far off them) */
const BLOCK_DEPTH = 14;
/** a street's blocks stand this far off its centre line (town.ts: "their fronts at ~9.5") and run STREET_BLOCK_T along it */
const STREET_BLOCK_OFF = 9.5;
/** a quarter's edge line |q| = p - EDGE_K keeps it QUARTER_EDGE_M off both its streets (town.ts's own rule) */
const EDGE_K = QUARTER_EDGE_M * Math.SQRT2;
/** the plan reaches this far past the town's edge: the ends' domes and their names */
const PLAN_MARGIN_M = 14;
const TAU = Math.PI * 2;

/** the plaza's own landmarks the eye looks for */
const PLAZA_MARKS: { id: string; name: string; x: number; z: number }[] = [
  { id: PLACE_IDS.desk, name: "The desk", x: DESK_SPOT.x, z: DESK_SPOT.z },
  { id: PLACE_IDS.guardHouse, name: "Guard House", x: GUARD_SPOT.x, z: GUARD_SPOT.z },
  { id: "board", name: "The board", x: 0, z: -20 },
  { id: "notes", name: "Notices", x: -18, z: 20 },
];

/** how the plan is drawn: the full map names what you have found; the mini-map is too small for words */
interface PlanStyle {
  labels: boolean;
}

/**
 * The plan itself, the fountain at (cx, cy) on the canvas, k pixels to the metre: everything but you and the north
 * mark. Line widths are in pixels, so both maps draw it at about the same k.
 */
function drawPlan(g: CanvasRenderingContext2D, cx: number, cy: number, k: number, found: readonly string[], spill: number | null, style: PlanStyle): void {
  const X = (x: number) => cx + x * k;
  const Y = (z: number) => cy + z * k;
  const ring = (r: number, a0 = 0, a1 = TAU) => {
    // world angles are atan2(x, z): on the plan (x right, z down) that is measured from straight down, clockwise
    g.beginPath();
    g.arc(cx, cy, r * k, Math.PI / 2 - a0, Math.PI / 2 - a1, true);
  };

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
  g.arc(cx, cy, 1.2 * k, 0, TAU);
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
    // the kerb lines, broken where the ring road crosses (its annulus is walkable through the crossing)
    g.lineWidth = 1.2;
    const crossing = (r: number) => Math.sqrt(r * r - STREET_HALF_WIDTH_M * STREET_HALF_WIDTH_M);
    for (const s of [-1, 1]) {
      for (const [t0, t1] of [
        [KERB_OUT, crossing(RING_ROAD_IN)],
        [crossing(RING_ROAD_OUT), TOWN_RADIUS],
      ]) {
        g.beginPath();
        g.moveTo(X(ux * t0 + s * vx * STREET_HALF_WIDTH_M), Y(uz * t0 + s * vz * STREET_HALF_WIDTH_M));
        g.lineTo(X(ux * t1 + s * vx * STREET_HALF_WIDTH_M), Y(uz * t1 + s * vz * STREET_HALF_WIDTH_M));
        g.stroke();
      }
    }
    // the blocks either side, hatched, a stretch at a time (the lanes and the ring road break them)
    for (const s of [-1, 1]) {
      for (const [t0, t1raw] of STREET_BLOCK_T) {
        const t1 = Math.min(t1raw, TOWN_RADIUS - 4);
        if (t1 <= t0) continue;
        const x0 = ux * t0 + s * vx * STREET_BLOCK_OFF;
        const z0 = uz * t0 + s * vz * STREET_BLOCK_OFF;
        g.save();
        g.translate(X(x0), Y(z0));
        g.rotate(Math.atan2(uz, ux));
        block(g, 0, s > 0 ? 0 : -BLOCK_DEPTH * k, (t1 - t0) * k, BLOCK_DEPTH * k);
        g.restore();
      }
    }
    // the lanes into the quarters: a short way off each side of the street, between the blocks
    g.lineWidth = 0.9;
    for (const s of [-1, 1]) {
      for (const t of LANE_T) {
        g.beginPath();
        g.moveTo(X(ux * t + s * vx * STREET_HALF_WIDTH_M), Y(uz * t + s * vz * STREET_HALF_WIDTH_M));
        g.lineTo(X(ux * t + s * vx * QUARTER_EDGE_M), Y(uz * t + s * vz * QUARTER_EDGE_M));
        g.stroke();
      }
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
    band(g, cx, cy, k, FRONT, FRONT + BLOCK_DEPTH, a0, a1);
  }

  // the ring road: its two edges between the streets, the inner one open where a quarter meets it; blocks both
  // sides, the inner ones stopping at each quarter's opening, all of them clear of the streets' own blocks
  const clearAt = (r: number) => Math.asin((STREET_BLOCK_OFF + BLOCK_DEPTH) / r);
  const roadAt = (r: number) => Math.asin(STREET_HALF_WIDTH_M / r);
  for (let i = 0; i < STREET_ANGLES.length; i++) {
    const sa = STREET_ANGLES[i];
    const sb = STREET_ANGLES[(i + 1) % STREET_ANGLES.length] + (i === STREET_ANGLES.length - 1 ? TAU : 0);
    const qr = QUARTERS.find((q) => Math.abs(wrapAngle(q.a - (sa + sb) / 2)) < 1e-6);
    // the outer edge and its blocks
    g.lineWidth = 1.2;
    ring(RING_ROAD_OUT, sa + roadAt(RING_ROAD_OUT), sb - roadAt(RING_ROAD_OUT));
    g.stroke();
    band(g, cx, cy, k, RING_ROAD_FRONT_OUT, RING_ROAD_FRONT_OUT + RING_ROAD_BLOCK_D, sa + clearAt(RING_ROAD_FRONT_OUT), sb - clearAt(RING_ROAD_FRONT_OUT));
    // the inner edge and its blocks, parted at the quarter's opening
    const parts: [number, number][] = qr ? [[sa, qr.a - QUARTER_OPEN], [qr.a + QUARTER_OPEN, sb]] : [[sa, sb]];
    for (const [p0, p1] of parts) {
      const e0 = p0 === sa ? p0 + roadAt(RING_ROAD_IN) : p0;
      const e1 = p1 === sb ? p1 - roadAt(RING_ROAD_IN) : p1;
      g.lineWidth = 1.2;
      ring(RING_ROAD_IN, e0, e1);
      g.stroke();
      const b0 = p0 === sa ? p0 + clearAt(RING_ROAD_FRONT_IN) : p0;
      const b1 = p1 === sb ? p1 - clearAt(RING_ROAD_FRONT_IN) : p1;
      if (b1 > b0) band(g, cx, cy, k, QUARTER_CORNER_R, RING_ROAD_FRONT_IN, b0, b1);
    }
  }

  // the quarters: each its fan of ground, its water and buildings, its small things, and the thing to find
  for (const qr of QUARTERS) quarter(g, cx, cy, k, qr);

  // the places: a door mark on the front; found ones named along the radius, unfound ones left blank
  const nameFont = `600 ${Math.round(Math.max(k * 4.2, cx / 30))}px ${CAPS}`;
  g.font = nameFont;
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
    if (!seen || !style.labels) continue;
    g.fillStyle = INK;
    if (isEnd) {
      g.textAlign = "center";
      g.fillText(p.name, X(ax * (TOWN_RADIUS + 12)), Y(az * (TOWN_RADIUS + 12)));
      continue;
    }
    if (p.kind === "quarter") {
      // a quarter's name sits in the middle of its ground
      const qr = QUARTERS.find((q) => q.id === p.id);
      const rm = qr ? (qr.rIn + QUARTER_CORNER_R) / 2 : r;
      g.textAlign = "center";
      g.fillText(p.name, X(ax * rm), Y(az * rm));
      continue;
    }
    // the name reads outward along the radius, past the block, turned to stay upright on the west side
    const angle = Math.atan2(az, ax);
    const flip = ax < 0;
    const past = p.where === "ring-road" ? RING_ROAD_FRONT_OUT + RING_ROAD_BLOCK_D : FRONT + BLOCK_DEPTH;
    g.save();
    g.translate(X(ax * (past + 1.5)), Y(az * (past + 1.5)));
    g.rotate(flip ? angle + Math.PI : angle);
    g.textAlign = flip ? "right" : "left";
    g.fillText(p.name, 0, 0);
    g.restore();
  }

  // the plaza's own: the desk, the Guard House, the boards
  g.font = `600 ${Math.round(Math.max(k * 3.6, cx / 36))}px ${CAPS}`;
  g.textAlign = "center";
  for (const m of PLAZA_MARKS) {
    g.fillStyle = INK;
    g.fillRect(X(m.x) - 1.4 * k, Y(m.z) - 1.4 * k, 2.8 * k, 2.8 * k);
    if (style.labels) g.fillText(m.name, X(m.x), Y(m.z) + 4 * k);
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
}

/** you: a dot with its heading, drawn at (x, y) on the canvas, k pixels to the metre, the heading as a plan angle */
function drawYou(g: CanvasRenderingContext2D, x: number, y: number, k: number, hx: number, hy: number): void {
  g.fillStyle = INK;
  g.beginPath();
  g.arc(x, y, 2 * k, 0, TAU);
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + hx * 5 * k, y + hy * 5 * k);
  g.stroke();
  g.fillStyle = PAPER;
  g.beginPath();
  g.arc(x, y, 0.8 * k, 0, TAU);
  g.fill();
}

export function drawTownMap(c: HTMLCanvasElement, pose: MapPose, found: readonly string[], spill: number | null): void {
  const g = c.getContext("2d");
  if (!g) return;
  const W = c.width;
  const H = c.height;
  const k = (W / 2 - 36) / (TOWN_RADIUS + PLAN_MARGIN_M);
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  drawPlan(g, W / 2, H / 2, k, found, spill, { labels: true });
  drawYou(g, W / 2 + pose.x * k, H / 2 + pose.z * k, k, Math.sin(pose.ry), Math.cos(pose.ry));
  // north
  g.fillStyle = INK;
  g.font = `600 ${Math.round(k * 5)}px ${CAPS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("N", W / 2, 22);
}

/** an angle brought into (-PI, PI] */
const wrapAngle = (a: number): number => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

/**
 * A quarter on the plan, from its own table: the fan of its ground (from rIn out to the corner radius, open onto
 * the ring road within QUARTER_OPEN of its centre line, the edge lines QUARTER_EDGE_M off its streets), then its
 * water (a box or a disc, ruled like the fountain's basin), its buildings (hatched), its decks (the bridge), its
 * fixtures as dots (trees, benches, stalls) and a ring for the thing to find.
 */
function quarter(g: CanvasRenderingContext2D, cx: number, cy: number, k: number, qr: Quarter) {
  const P = (p: number, q: number): [number, number] => {
    const [x, z] = toWorld(qr, p, q);
    return [cx + x * k, cy + z * k];
  };
  // where the edge line |q| = p - EDGE_K meets a circle of radius r: its angle from the centre line
  const edgeAngle = (r: number) => {
    const p = (EDGE_K + Math.sqrt(Math.max(0, 2 * r * r - EDGE_K * EDGE_K))) / 2;
    return Math.atan2(p - EDGE_K, p);
  };
  const arcTo = (r: number, from: number, to: number, steps = 12) => {
    for (let i = 0; i <= steps; i++) {
      const t = from + ((to - from) * i) / steps;
      g.lineTo(...P(Math.cos(t) * r, Math.sin(t) * r));
    }
  };
  const tIn = edgeAngle(qr.rIn);
  const tC = edgeAngle(QUARTER_CORNER_R);
  g.beginPath();
  g.moveTo(...P(Math.cos(-tIn) * qr.rIn, Math.sin(-tIn) * qr.rIn));
  arcTo(qr.rIn, -tIn, tIn);
  arcTo(QUARTER_CORNER_R, tC, QUARTER_OPEN);
  arcTo(RING_ROAD_IN, QUARTER_OPEN, -QUARTER_OPEN, 6);
  arcTo(QUARTER_CORNER_R, -QUARTER_OPEN, -tC);
  g.closePath();
  g.strokeStyle = INK;
  g.lineWidth = 0.7;
  g.stroke();
  // water and buildings: a box is a building unless it holds a deck (then it is the canal); a disc is a pond
  for (const o of qr.obstacles) {
    if (o.kind === "disc") {
      g.beginPath();
      g.moveTo(...P(o.p + o.r, o.q));
      for (let i = 1; i <= 24; i++) g.lineTo(...P(o.p + Math.cos((TAU * i) / 24) * o.r, o.q + Math.sin((TAU * i) / 24) * o.r));
      g.closePath();
      g.lineWidth = 1;
      g.stroke();
      for (let i = 1; i <= 3; i++) {
        const rr = (o.r * i) / 4;
        g.beginPath();
        g.moveTo(...P(o.p + rr, o.q));
        for (let j = 1; j <= 16; j++) g.lineTo(...P(o.p + Math.cos((TAU * j) / 16) * rr, o.q + Math.sin((TAU * j) / 16) * rr));
        g.lineWidth = 0.4;
        g.stroke();
      }
      continue;
    }
    const water = qr.decks.some((d) => d.p0 >= o.p0 - 2 && d.p1 <= o.p1 + 2);
    const corners: [number, number][] = [P(o.p0, o.q0), P(o.p1, o.q0), P(o.p1, o.q1), P(o.p0, o.q1)];
    const trace = () => {
      g.beginPath();
      g.moveTo(...corners[0]);
      for (const c of corners.slice(1)) g.lineTo(...c);
      g.closePath();
    };
    if (water) {
      // ruled along its length, like the basin
      trace();
      g.save();
      g.clip();
      g.lineWidth = 0.4;
      for (let p = o.p0 + 1.5; p < o.p1; p += 1.5) {
        g.beginPath();
        g.moveTo(...P(p, o.q0));
        g.lineTo(...P(p, o.q1));
        g.stroke();
      }
      g.restore();
    } else {
      trace();
      g.save();
      g.clip();
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      hatch(g, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
      g.restore();
    }
    trace();
    g.lineWidth = 1;
    g.stroke();
  }
  // the decks: the bridge, an open rectangle over the water
  for (const d of qr.decks) {
    g.fillStyle = PAPER;
    g.beginPath();
    g.moveTo(...P(d.p0, d.q0));
    g.lineTo(...P(d.p1, d.q0));
    g.lineTo(...P(d.p1, d.q1));
    g.lineTo(...P(d.p0, d.q1));
    g.closePath();
    g.fill();
    g.lineWidth = 1;
    g.stroke();
  }
  // the small things: a dot each, the larger ones (a stall, a bench, a crane) a little bigger
  g.fillStyle = INK;
  for (const f of qr.fixtures) {
    const [x, y] = P(f.p, f.q);
    g.beginPath();
    g.arc(x, y, Math.min(1.2, Math.max(0.5, f.r)) * k * 0.6, 0, TAU);
    g.fill();
  }
  // the thing to find: a ring where its mark lies
  const [lx, ly] = P(qr.landmark.p, qr.landmark.q);
  g.beginPath();
  g.arc(lx, ly, qr.landmark.r0 * k, 0, TAU);
  g.lineWidth = 0.8;
  g.stroke();
}

/**
 * a hatched band of blocks on the plan between two radii and two world angles (a0 to a1 the way the angles grow);
 * the path is traced twice, since a canvas path is not part of the state save() keeps and hatch() starts its own
 */
function band(g: CanvasRenderingContext2D, cx: number, cy: number, k: number, r0: number, r1: number, a0: number, a1: number) {
  const trace = () => {
    g.beginPath();
    g.arc(cx, cy, r0 * k, Math.PI / 2 - a0, Math.PI / 2 - a1, true);
    g.arc(cx, cy, r1 * k, Math.PI / 2 - a1, Math.PI / 2 - a0, false);
    g.closePath();
  };
  trace();
  g.save();
  g.clip();
  hatch(g, cx - r1 * k, cy - r1 * k, cx + r1 * k, cy + r1 * k);
  g.restore();
  trace();
  g.lineWidth = 1.2;
  g.stroke();
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
      <canvas ref={ref} width={SIDE} height={SIDE} role="img" aria-label="A plan of the town: the plaza, the ring, the four streets, the ring road, the quarters, and the places you have found" />
      <p className="play__map-key">Named doors are the ones you have found. A ring marks the street the Mint spilled on. M closes the map.</p>
    </div>
  );
}

// ---------------------------------------------------------------- the mini-map

/** the plan for the mini-map, drawn once at its scale; redrawn when a door is found or the spill moves */
function planImage(k: number, found: readonly string[], spill: number | null): HTMLCanvasElement {
  const reach = TOWN_RADIUS + PLAN_MARGIN_M;
  const side = Math.ceil(2 * reach * k);
  const c = document.createElement("canvas");
  c.width = side;
  c.height = side;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = PAPER;
    g.fillRect(0, 0, side, side);
    drawPlan(g, side / 2, side / 2, k, found, spill, { labels: false });
  }
  return c;
}

/**
 * one frame of the mini-map: the plan turned so the heading is up and slid so you are the middle, then the coins in
 * reach as dots (in the same turned frame), you, and N at the rim where north has gone
 */
export function drawMiniMap(c: HTMLCanvasElement, plan: HTMLCanvasElement, k: number, pose: MapPose, coins: ReadonlyMap<string, MapCoin>): void {
  const g = c.getContext("2d");
  if (!g) return;
  const W = c.width;
  const cx = W / 2;
  const cy = W / 2;
  // the heading on the plan (x right, z down) is (sin ry, cos ry); turn the plan so it points straight up
  const turn = -Math.PI / 2 - Math.atan2(Math.cos(pose.ry), Math.sin(pose.ry));
  g.clearRect(0, 0, W, W);
  g.save();
  g.beginPath();
  g.arc(cx, cy, cx - 1, 0, TAU);
  g.clip();
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, W);
  g.translate(cx, cy);
  g.rotate(turn);
  // the plan's own middle is the fountain: slide it by where you stand
  const half = plan.width / 2;
  g.drawImage(plan, -half - pose.x * k, -half - pose.z * k);
  // the coins in reach: a brass dot with an ink rim, in the world's frame (still turned), so they sit on their ground
  for (const coin of coins.values()) {
    const dx = coin.x - pose.x;
    const dz = coin.z - pose.z;
    if (dx * dx + dz * dz > MINI_REACH_M * MINI_REACH_M) continue;
    g.beginPath();
    g.arc(dx * k, dz * k, 1.6 * k, 0, TAU);
    g.fillStyle = "#c9932a";
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = INK;
    g.stroke();
  }
  g.restore();
  drawYou(g, cx, cy, k, 0, -1);
  // north: a small N on the rim, turned with the plan
  const nx = cx + Math.sin(turn) * (cx - 9 * (W / MINI_SIDE_PX));
  const ny = cy - Math.cos(turn) * (cy - 9 * (W / MINI_SIDE_PX));
  g.fillStyle = INK;
  g.font = `700 ${Math.round(5 * (W / MINI_SIDE_PX))}px ${CAPS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("N", nx, ny);
  // the rim
  g.strokeStyle = INK;
  g.lineWidth = 1.2 * (W / MINI_SIDE_PX);
  g.beginPath();
  g.arc(cx, cy, cx - 1, 0, TAU);
  g.stroke();
}

export function MiniMap({ pose, found, spill, coins, onOpen }: MiniMapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    // a sharp plan on a dense screen; capped, since the plan image grows with the square of it
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(MINI_SIDE_PX * dpr);
    c.width = W;
    c.height = W;
    // the window's radius shows MINI_REACH_M and a little over, so a coin at the reach lies inside the rim
    const k = (W / 2) / (MINI_REACH_M + 4);
    const plan = planImage(k, found, spill);
    const draw = () => drawMiniMap(c, plan, k, pose.current, coins.current);
    draw();
    const timer = window.setInterval(draw, 80);
    return () => window.clearInterval(timer);
  }, [pose, coins, found, spill]);
  return (
    <button type="button" className="play__minimap" onClick={onOpen} aria-label="The map. Tap for the whole town.">
      <canvas ref={ref} width={MINI_SIDE_PX} height={MINI_SIDE_PX} />
    </button>
  );
}
