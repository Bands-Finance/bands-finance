/**
 * THE TOWN'S SHAPE (bands.finance Play, 24 Sep): where you can walk and where the doors are, in one pure module that
 * the browser (World.ts, city.ts, the map) and the room server share, so both sides agree on every position rule.
 * No three.js, no DOM.
 *
 * Coordinates are the plaza's: metres, the fountain at the origin, an angle is atan2(x, z) (0 is +z, the spawn's
 * side; +x is east, -z is north). The plaza is a disc of WORLD_RADIUS round the fountain; the boulevard ring runs
 * on to KERB_OUT; the four streets on the diagonals leave the ring through the rope's four mouths and run out to
 * TOWN_RADIUS as a corridor STREET_HALF_WIDTH_M either side of the centre line (STREET_MOUTH_HALF_M between the
 * corner façades); the façades stand at FRONT and beyond. Nothing else is walkable: not the fountain, not a building.
 *
 * The rope round the plaza is a line, not scenery: ROPE_POSTS posts at WORLD_RADIUS, the span at each street cut
 * (ropeCut) for the mouth, and a band ROPE_BAND_M either side of the rope off the ground everywhere else, so a walker
 * is held on the side they came from. A move can be longer than the band (the server's budget allows several metres
 * after an idle spell), so the server also refuses a step whose ends straddle the rope off a mouth (crossesRope).
 *
 * PLACES is the one table of doors. The world stands a keeper and a Spot at each, the server checks you are within
 * DOOR_REACH_M of one when you enter, buy or climb, and the map draws them. A door is the middle of its sign's bay at
 * the front, stepped 1.5 m toward the plaza (a bank with steps: their foot), so it lies on the pavement just off the
 * ring; you reach it from the kerb. The numbers were computed from city.ts's own lot frames (City.doors, read by a
 * dev script that builds the city under a stub canvas) and written in below; move a lot in city.ts and rerun it.
 */
import { DOOR_REACH_M, WORLD_RADIUS } from "./protocol";

export { DOOR_REACH_M };

/** the streets end here: the domed fronts stand a little beyond, in the fog */
export const TOWN_RADIUS = 112;
/** the four streets, on the diagonals, as atan2(x, z) angles, in the order of STREET_NAMES */
export const STREET_ANGLES = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4] as const;
/** what the town calls them (the East street leaves the ring at the Hatter's corner) */
export const STREET_NAMES = ["east", "north", "west", "south"] as const;
export type StreetName = (typeof STREET_NAMES)[number];
/** half the angle a street opens in the ring of façades (and in the rope) */
export const STREET_GAP = 0.125;
/** a street is walkable this far either side of its centre line: the carriageway and both pavements */
export const STREET_HALF_WIDTH_M = 7;
/** the boulevard's kerbs: the carriageway runs between them, the pavement before the fronts beyond the outer one */
export const KERB_IN = 45.6;
export const KERB_OUT = 49.25;
/** the ring's façades stand here (the Exchange set back at 55) */
export const FRONT = 51;
/**
 * a street's corridor short of MOUTH_END is this wide either side: the corner façades meet the street at FRONT,
 * STREET_GAP off its centre line (51 x sin 0.125 = 6.36 m), so STREET_HALF_WIDTH_M there would admit 0.64 m of façade.
 * Their flanks draw back from the street as they go, and are past 7 m off it by FRONT + 2
 */
export const STREET_MOUTH_HALF_M = 6.3;
export const MOUTH_END = FRONT + 2;
/** the fountain's basin and a step round it */
export const FOUNTAIN_R = 4.5;
/**
 * the rope round the plaza: this many posts at WORLD_RADIUS, the span whose middle falls within STREET_GAP of a
 * street cut (ropeCut): that span is the street's mouth, the two posts flanking it its gateposts. World.ts strings
 * the rope from the same count, so the line it fences and the line the server refuses are one line
 */
export const ROPE_POSTS = 44;
/**
 * the rope's band: this far either side of its line is off the ground but at a mouth, so a step onto it is pulled
 * back to the nearer side (on the client the rope's own fence has already pushed it to the side it came from)
 */
export const ROPE_BAND_M = 0.75;

export type PlaceKind = "shop" | "bank" | "room" | "climb" | "floor" | "office" | "end";

export interface Place {
  id: string;
  /** as the keeper's name tag says it */
  name: string;
  /** as the front's sign is lettered */
  sign: string;
  kind: PlaceKind;
  /** the ring (the Crescent is on it), or the street it ends */
  where: "ring" | StreetName;
  x: number;
  z: number;
  /** the way the door faces (toward the plaza), as a heading a figure at the door would take */
  facing: number;
}

const TAU = Math.PI * 2;
/** an edge counts as in: a point nearestWalkable put on one is walkable again, whatever the last bit of a float says */
const EPS = 1e-6;

/** an angle brought into (-PI, PI] */
const wrap = (a: number): number => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

const end = (i: number, id: string, name: string): Place => {
  const a = STREET_ANGLES[i];
  const r = TOWN_RADIUS - 1.5;
  return { id, name, sign: name.toUpperCase(), kind: "end", where: STREET_NAMES[i], x: round(Math.sin(a) * r), z: round(Math.cos(a) * r), facing: wrap(a + Math.PI) };
};
const round = (v: number) => Math.round(v * 100) / 100;

/**
 * Every door in the town. Positions from city.ts's lot frames (see the header); the ids are the ones protocol.ts's
 * PLACE_IDS and shopOf() rely on: a shop's id is its shop, then "-" and where, when the town has two.
 */
export const PLACES: readonly Place[] = [
  // the ring, east: from the East street's corner round to the North street's (the Merchants' Bank's door is at the
  // foot of its portico's steps, which run out over the pavement)
  { id: "hatter", name: "The Hatter", sign: "HATTER", kind: "shop", where: "ring", x: 42.21, z: 25.91, facing: -2.156 },
  { id: "cigars", name: "Cigars", sign: "CIGARS", kind: "shop", where: "ring", x: 47.54, z: 13.85, facing: -1.882 },
  { id: "merchants-bank", name: "The Merchants' Bank", sign: "MERCHANTS' BANK", kind: "bank", where: "ring", x: 45.1, z: 0.04, facing: -1.572 },
  { id: "coffee-east", name: "The Coffee House", sign: "COFFEE HOUSE", kind: "room", where: "ring", x: 45.58, z: -19.45, facing: -1.217 },
  { id: "stationer-east", name: "The Stationer", sign: "STATIONER", kind: "shop", where: "ring", x: 47.27, z: -14.88, facing: -1.217 },
  { id: "wine-merchant", name: "The Wine Merchant", sign: "WINE MERCHANT", kind: "room", where: "ring", x: 41.13, z: -27.59, facing: -1.011 },
  // the ring, north: the tower on the corner, the Exchange (its door at the foot of its steps), the small domed bank
  { id: "clock-tower", name: "The Clock Tower", sign: "CLOCK TOWER", kind: "climb", where: "ring", x: 26.13, z: -42.04, facing: -0.556 },
  { id: "exchange", name: "The Exchange", sign: "THE EXCHANGE", kind: "floor", where: "ring", x: 0.08, z: -50.5, facing: -0.002 },
  { id: "trust-savings", name: "Trust & Savings", sign: "TRUST & SAVINGS", kind: "bank", where: "ring", x: -26.06, z: -42.09, facing: 0.554 },
  // the ring, west: behind Mr Bands' desk, his own house among them
  { id: "tailor", name: "The Tailor", sign: "TAILOR", kind: "shop", where: "ring", x: -43.31, z: -24.09, facing: 1.014 },
  { id: "bookseller-west", name: "The Bookseller", sign: "BOOKSELLER", kind: "room", where: "ring", x: -40.76, z: -28.19, facing: 1.014 },
  { id: "ledgers", name: "Ledgers", sign: "LEDGERS", kind: "room", where: "ring", x: -48.36, z: -10.68, facing: 1.323 },
  { id: "bands-co", name: "Bands & Co.", sign: "BANDS & CO.", kind: "office", where: "ring", x: -49.33, z: 4.08, facing: 1.653 },
  { id: "glover-west", name: "The Glover", sign: "GLOVER", kind: "shop", where: "ring", x: -44.55, z: 21.61, facing: 1.998 },
  { id: "tea-room", name: "The Tea Room", sign: "TEA ROOM", kind: "room", where: "ring", x: -40.67, z: 28.23, facing: 2.155 },
  // the ring, south: the Crescent's shops under its arcade (two coffee houses in a town is normal)
  { id: "printer", name: "The Printer", sign: "PRINTER", kind: "room", where: "ring", x: -23.83, z: 43.5, facing: 2.576 },
  { id: "barber", name: "The Barber", sign: "BARBER", kind: "room", where: "ring", x: -18.24, z: 46.02, facing: 2.764 },
  { id: "glover-crescent", name: "The Glover", sign: "GLOVER", kind: "shop", where: "ring", x: -12.44, z: 48.02, facing: 2.953 },
  { id: "coffee-crescent", name: "The Coffee House", sign: "COFFEE HOUSE", kind: "room", where: "ring", x: 12.44, z: 48.02, facing: -2.953 },
  { id: "bookseller-crescent", name: "The Bookseller", sign: "BOOKSELLER", kind: "room", where: "ring", x: 18.24, z: 46.02, facing: -2.764 },
  { id: "stationer-crescent", name: "The Stationer", sign: "STATIONER", kind: "shop", where: "ring", x: 23.83, z: 43.5, facing: -2.576 },
  // the four street ends: the domed fronts in the fog, a discovery each; their door is the end of the walkable street
  end(0, "east-end", "The East End"),
  end(1, "north-end", "The North End"),
  end(2, "west-end", "The West End"),
  end(3, "south-end", "The South End"),
];

// ---------------------------------------------------------------- the rope

const ROPE_SPAN = TAU / ROPE_POSTS;
const ROPE_IN = WORLD_RADIUS - ROPE_BAND_M;
const ROPE_OUT = WORLD_RADIUS + ROPE_BAND_M;

/** the rope's span (0..ROPE_POSTS-1) an angle falls in */
const spanOf = (a: number): number => Math.floor((((a % TAU) + TAU) % TAU) / ROPE_SPAN) % ROPE_POSTS;

/** is this span of the rope cut: a street's mouth (the span's middle within STREET_GAP of the street's angle)? */
export const ropeCut = (span: number): boolean => STREET_ANGLES.some((s) => Math.abs(wrap((span + 0.5) * ROPE_SPAN - s)) < STREET_GAP);

/** is the angle at a mouth of the rope? */
export const inMouth = (a: number): boolean => ropeCut(spanOf(a));

/** the gateposts' angles, a hair inside their mouth so a point put on one is in the mouth whatever the float says */
const MOUTH_EDGES: readonly number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < ROPE_POSTS; i++) {
    if (!ropeCut(i)) continue;
    if (!ropeCut((i + ROPE_POSTS - 1) % ROPE_POSTS)) out.push(i * ROPE_SPAN + 1e-4);
    if (!ropeCut((i + 1) % ROPE_POSTS)) out.push((i + 1) * ROPE_SPAN - 1e-4);
  }
  return out;
})();

/** on the rope's band (open: its two edges are ground) and off every mouth */
const onRope = (x: number, z: number, r: number): boolean => Math.abs(r - WORLD_RADIUS) < ROPE_BAND_M - EPS && !inMouth(Math.atan2(x, z));

/**
 * Does a step from (x0, z0) to (x1, z1) cross the rope anywhere but at a mouth? With both ends on the ground that is
 * one end on the plaza and the other on the boulevard, and the point where the step meets r WORLD_RADIUS off every
 * mouth. The band keeps a walker off the rope's line; this keeps a move longer than the band from jumping it.
 */
export function crossesRope(x0: number, z0: number, x1: number, z1: number): boolean {
  const from = Math.hypot(x0, z0) < WORLD_RADIUS;
  const to = Math.hypot(x1, z1) < WORLD_RADIUS;
  if (from === to) return false;
  // |P0 + t (P1 - P0)| = WORLD_RADIUS: the step leaves the plaza through the larger root, comes in through the smaller
  const dx = x1 - x0;
  const dz = z1 - z0;
  const qa = dx * dx + dz * dz;
  const qb = 2 * (x0 * dx + z0 * dz);
  const qc = x0 * x0 + z0 * z0 - WORLD_RADIUS * WORLD_RADIUS;
  const sq = Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc));
  const t = (from ? -qb + sq : -qb - sq) / (2 * qa);
  return !inMouth(Math.atan2(x0 + dx * t, z0 + dz * t));
}

// ---------------------------------------------------------------- where you can walk

/**
 * the street whose corridor holds the point, with how far along its centre line (t) and across it (s) the point is;
 * the corridor is STREET_MOUTH_HALF_M wide short of MOUTH_END and STREET_HALF_WIDTH_M beyond
 */
function streetAt(x: number, z: number): { i: number; t: number; s: number } | null {
  for (let i = 0; i < STREET_ANGLES.length; i++) {
    const a = STREET_ANGLES[i];
    const t = x * Math.sin(a) + z * Math.cos(a);
    const s = x * Math.cos(a) - z * Math.sin(a);
    if (t <= 0) continue;
    const half = t < MOUTH_END - EPS ? STREET_MOUTH_HALF_M : STREET_HALF_WIDTH_M;
    if (Math.abs(s) <= half + EPS) return { i, t, s };
  }
  return null;
}

/** the plaza less the fountain, the whole ring less the rope's band, and the four streets out to the town's edge */
export function walkable(x: number, z: number): boolean {
  const r = Math.hypot(x, z);
  if (r < FOUNTAIN_R - EPS) return false;
  if (onRope(x, z, r)) return false;
  if (r <= KERB_OUT + EPS) return true;
  if (r > TOWN_RADIUS + EPS) return false;
  return streetAt(x, z) !== null;
}

/** a street's corridor as two strips along its centre line (t from, t to, half a width): the mouth's, and the open street's */
const STRIPS: readonly { t0: number; t1: number; half: number }[] = [
  { t0: KERB_OUT, t1: MOUTH_END, half: STREET_MOUTH_HALF_M },
  { t0: MOUTH_END, t1: TOWN_RADIUS, half: STREET_HALF_WIDTH_M },
];

/**
 * The point pulled back to the nearest walkable spot: itself when it is one, else the closest of the fountain's edge,
 * the ring's outer kerb, the rope's band's nearer edge (or the nearest gatepost's line, from the band), and the
 * nearest point of each street's two strips. The server corrects a refused step with this.
 */
export function nearestWalkable(x: number, z: number): [number, number] {
  if (walkable(x, z)) return [x, z];
  const r = Math.hypot(x, z);
  const a = Math.atan2(x, z);
  let best: [number, number] = [0, FOUNTAIN_R];
  let bestD = Infinity;
  const offer = (cx: number, cz: number) => {
    const d = Math.hypot(cx - x, cz - z);
    if (d < bestD) {
      bestD = d;
      best = [cx, cz];
    }
  };
  const radial = (rr: number) => offer(Math.sin(a) * rr, Math.cos(a) * rr);
  if (r < FOUNTAIN_R) radial(FOUNTAIN_R);
  else if (r > KERB_OUT) radial(KERB_OUT);
  else {
    // on the rope's band, off a mouth
    radial(ROPE_IN);
    radial(ROPE_OUT);
    for (const e of MOUTH_EDGES) {
      const da = wrap(a - e);
      if (Math.abs(da) >= Math.PI / 2) continue;
      const rr = Math.min(ROPE_OUT, Math.max(ROPE_IN, r * Math.cos(da)));
      offer(Math.sin(e) * rr, Math.cos(e) * rr);
    }
  }
  for (const sa of STREET_ANGLES) {
    const ux = Math.sin(sa);
    const uz = Math.cos(sa);
    const t = x * ux + z * uz;
    const s = x * Math.cos(sa) - z * Math.sin(sa);
    for (const strip of STRIPS) {
      let ct = Math.min(strip.t1, Math.max(strip.t0, t));
      const cs = Math.min(strip.half, Math.max(-strip.half, s));
      if (Math.hypot(ct, cs) > TOWN_RADIUS) ct = Math.sqrt(TOWN_RADIUS * TOWN_RADIUS - cs * cs);
      offer(ct * ux + cs * Math.cos(sa), ct * uz - cs * Math.sin(sa));
    }
  }
  return best;
}

// ---------------------------------------------------------------- the doors

/** the place whose door you stand within DOOR_REACH_M of (the nearest, if two are that close), or null */
export function placeAt(x: number, z: number): Place | null {
  let best: Place | null = null;
  let bestD = DOOR_REACH_M;
  for (const p of PLACES) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------- the way there

/**
 * A click-walk's route runs the boulevard's arcs at this radius: the carriageway's middle, clear of the kerbs'
 * furniture and 3 m inside the ring's inner edge (an arc's chords stay 0.7 m clear of it)
 */
export const ROUTE_RING_R = 46;
/** and passes a mouth between this far inside (on the plaza, clear of the rope's band and the gateposts) and ROUTE_RING_R */
export const ROUTE_MOUTH_IN_R = 40.5;
/** an arc's waypoints are this far apart (a chord of 0.35 rad at r 46 dips to r 45.3) */
const ARC_STEP = 0.35;
/** a street's centre-line waypoints are this far apart */
const STREET_STEP_M = 20;
/** a plaza leg that would cross the fountain is bent round it at this radius */
const FOUNTAIN_ROUND_R = FOUNTAIN_R + 2;

/** the ground a point stands on: the plaza, the ring (with its angle), or a street (with how far along it) */
type Zone = { kind: "plaza" } | { kind: "ring"; a: number } | { kind: "street"; i: number; t: number };

function zoneOf(x: number, z: number): Zone {
  const r = Math.hypot(x, z);
  if (r < WORLD_RADIUS) return { kind: "plaza" };
  if (r > KERB_OUT) {
    const s = streetAt(x, z);
    if (s) return { kind: "street", i: s.i, t: s.t };
  }
  return { kind: "ring", a: Math.atan2(x, z) };
}

const polar = (a: number, r: number): [number, number] => [Math.sin(a) * r, Math.cos(a) * r];
const mouthIn = (i: number): [number, number] => polar(STREET_ANGLES[i], ROUTE_MOUTH_IN_R);
const mouthOut = (i: number): [number, number] => polar(STREET_ANGLES[i], ROUTE_RING_R);

/** the waypoints of an arc along the ring's middle from a0 to a1 the shorter way round, every ARC_STEP: neither end */
function arc(a0: number, a1: number): [number, number][] {
  const d = wrap(a1 - a0);
  const n = Math.ceil(Math.abs(d) / ARC_STEP - EPS);
  const out: [number, number][] = [];
  for (let k = 1; k < n; k++) out.push(polar(a0 + (d * k) / n, ROUTE_RING_R));
  return out;
}

/** a street's centre-line waypoints between two distances along it (every STREET_STEP_M from ROUTE_RING_R), in walking order: neither end */
function along(i: number, tFrom: number, tTo: number): [number, number][] {
  const lo = Math.min(tFrom, tTo) + 1;
  const hi = Math.max(tFrom, tTo) - 1;
  const out: [number, number][] = [];
  for (let t = ROUTE_RING_R + STREET_STEP_M; t < hi; t += STREET_STEP_M) if (t > lo) out.push(polar(STREET_ANGLES[i], t));
  return tFrom < tTo ? out : out.reverse();
}

/** a leg across the plaza to (qx, qz): straight, or bent round the fountain when the straight line would cross it */
function plazaLeg(px: number, pz: number, qx: number, qz: number): [number, number][] {
  const dx = qx - px;
  const dz = qz - pz;
  const len2 = dx * dx + dz * dz;
  if (len2 < EPS) return [[qx, qz]];
  // the leg's nearest point to the fountain, if it is between the ends and within the basin's step
  const t = -(px * dx + pz * dz) / len2;
  if (t <= 0 || t >= 1) return [[qx, qz]];
  const cx = px + dx * t;
  const cz = pz + dz * t;
  const c = Math.hypot(cx, cz);
  if (c >= FOUNTAIN_ROUND_R - 0.5) return [[qx, qz]];
  // round it on the side the leg already leans to (straight through the middle: the left)
  const a = c > 1e-3 ? Math.atan2(cx, cz) : Math.atan2(dx, dz) + Math.PI / 2;
  return [polar(a, FOUNTAIN_ROUND_R), [qx, qz]];
}

/** where the boulevard side of a route joins the ring's middle: the angle, and the waypoints from the start to there (a street walked in) */
function outFrom(z: Zone, x: number, zz: number): { a: number; pts: [number, number][] } {
  if (z.kind === "street") return { a: STREET_ANGLES[z.i], pts: [...along(z.i, z.t, ROUTE_RING_R), mouthOut(z.i)] };
  return { a: z.kind === "ring" ? z.a : Math.atan2(x, zz), pts: [] };
}

/** where the boulevard side of a route leaves the ring's middle: the angle, and the waypoints from there to the target (a street walked out) */
function inTo(z: Zone, x: number, zz: number): { a: number; pts: [number, number][] } {
  if (z.kind === "street") return { a: STREET_ANGLES[z.i], pts: [mouthOut(z.i), ...along(z.i, ROUTE_RING_R, z.t), [x, zz]] };
  return { a: z.kind === "ring" ? z.a : Math.atan2(x, zz), pts: [[x, zz]] };
}

/** the mouth to pass between a plaza point and the ring's middle at angle a: the shortest walk to it and arc from it */
function mouthFor(px: number, pz: number, a: number): number {
  let best = 0;
  let bestCost = Infinity;
  for (let i = 0; i < STREET_ANGLES.length; i++) {
    const [mx, mz] = mouthIn(i);
    const cost = Math.hypot(mx - px, mz - pz) + ROUTE_RING_R * Math.abs(wrap(STREET_ANGLES[i] - a));
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}

/**
 * The way from (x0, z0) to (x1, z1) through the town's shape, as waypoints to walk in order, the last the target
 * itself (pulled to walkable ground). On the same ground (the plaza, the same street) it is the target alone; the
 * boulevard is walked along the ring's middle (ROUTE_RING_R) in short arcs; a street along its centre line; and
 * the rope is passed only at a mouth, in and out along the street's angle. Small things on the way (a planter, a
 * lamp, the Guard House) are left to the walker to go round; no waypoint lies in the rope's band or a façade.
 */
export function routeTo(x0: number, z0: number, x1: number, z1: number): [number, number][] {
  const [sx, sz] = nearestWalkable(x0, z0);
  const [tx, tz] = nearestWalkable(x1, z1);
  const from = zoneOf(sx, sz);
  const to = zoneOf(tx, tz);
  let path: [number, number][];
  if (from.kind === "plaza" && to.kind === "plaza") path = plazaLeg(sx, sz, tx, tz);
  else if (from.kind === "street" && to.kind === "street" && from.i === to.i) path = [[tx, tz]];
  else if (from.kind === "plaza") {
    const end = inTo(to, tx, tz);
    const m = mouthFor(sx, sz, end.a);
    path = [...plazaLeg(sx, sz, ...mouthIn(m)), mouthOut(m), ...arc(STREET_ANGLES[m], end.a), ...end.pts];
  } else if (to.kind === "plaza") {
    const start = outFrom(from, sx, sz);
    const m = mouthFor(tx, tz, start.a);
    path = [...start.pts, ...arc(start.a, STREET_ANGLES[m]), mouthOut(m), mouthIn(m), ...plazaLeg(...mouthIn(m), tx, tz)];
  } else {
    const start = outFrom(from, sx, sz);
    const end = inTo(to, tx, tz);
    path = [...start.pts, ...arc(start.a, end.a), ...end.pts];
  }
  // a waypoint on top of the one before it (the start counts) says nothing: dropped, the target always kept
  const out: [number, number][] = [];
  let [lx, lz] = [sx, sz];
  path.forEach((p, i) => {
    if (i === path.length - 1 || Math.hypot(p[0] - lx, p[1] - lz) > 0.5) {
      out.push(p);
      [lx, lz] = p;
    }
  });
  return out;
}
