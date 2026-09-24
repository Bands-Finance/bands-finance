/**
 * THE TOWN'S SHAPE (bands.finance Play, 24 Sep): where you can walk and where the doors are, in one pure module that
 * the browser (World.ts, city.ts, the map) and the room server share, so both sides agree on every position rule.
 * No three.js, no DOM.
 *
 * Coordinates are the plaza's: metres, the fountain at the origin, an angle is atan2(x, z) (0 is +z, the spawn's
 * side; +x is east, -z is north). The plaza is a disc of WORLD_RADIUS round the fountain; the boulevard ring runs
 * on to KERB_OUT; the four streets on the diagonals leave the ring through the rope's four mouths and run out to
 * TOWN_RADIUS as a corridor STREET_HALF_WIDTH_M either side of the centre line (STREET_MOUTH_HALF_M between the
 * corner façades); the façades stand at FRONT and beyond.
 *
 * THE LARGER TOWN (24 Sep, "make the town larger"): a RING ROAD at RING_ROAD_R joins the four streets, walkable as an
 * annulus RING_ROAD_HALF_M either side, lined with blocks on both sides. Between the streets, behind the ring's lots,
 * lie four QUARTERS (the Park, the Canal, the Market Square, the Station), each a fan of ground from its rIn out to
 * the ring road (open onto it within QUARTER_OPEN of its centre; the road's inner blocks close it beyond, at
 * QUARTER_CORNER_R) and QUARTER_EDGE_M clear of the two streets' blocks. A quarter is entered from the ring road at its
 * gate, or by a LANE off each of its streets (LANE_T along the street, the width of the blocks). A quarter's water and
 * buildings are its obstacles: neither a walker nor a coin is ever in them; the canal's bridge is a deck, walkable
 * over the water. Every quarter is described in its own frame (p out along its centre line from the plaza, q across
 * it), the same table city.ts draws from, so what is drawn and what is walkable are one thing.
 *
 * The rope round the plaza is a line, not scenery: ROPE_POSTS posts at WORLD_RADIUS, the span at each street cut
 * (ropeCut) for the mouth, and a band ROPE_BAND_M either side of the rope off the ground everywhere else, so a walker
 * is held on the side they came from. A move can be longer than the band (the server's budget allows several metres
 * after an idle spell), so the server also refuses a step whose ends straddle the rope off a mouth (crossesRope).
 *
 * PLACES is the one table of doors. The world stands a keeper and a Spot at each, the server checks you are within
 * DOOR_REACH_M of one when you enter, buy or climb, and the map draws them. A door is the middle of its sign's bay at
 * the front, stepped 1.5 m toward the road (a bank with steps: their foot), so it lies on the pavement just off the
 * walkable edge; you reach it from the kerb. The numbers were computed from city.ts's own lot frames (City.doors,
 * read by a dev script that builds the city under a stub canvas) and written in below; move a lot in city.ts and
 * rerun it. A quarter's door is its gate on the ring road: a discovery, nothing to enter, no keeper.
 *
 * COIN_ZONES says where the coins lie (how many at once on the plaza, the ring, each street, the ring road and each
 * quarter, a mint mark at each street's end and at each quarter's landmark) and what each is worth; coinSpot draws a
 * spot for one on walkable ground, clear of the doors and the furniture. The room drops and values them; the browser
 * only draws what it is told.
 *
 * routeTo is a graph: the mouths, arcs of the boulevard's middle, points along each street, the lane ends, arcs of the
 * ring road, and each quarter's gates and waypoints (linked where a straight walk between them is clear), searched
 * for the shortest way; the plaza and a straight clear walk are special-cased so a short hop stays a short hop.
 */
import { DESK_SPOT, DOOR_REACH_M, WORLD_RADIUS } from "./protocol";

export { DOOR_REACH_M };

/** the streets end here: the domed fronts stand a little beyond, in the fog */
export const TOWN_RADIUS = 200;
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

// ---------------------------------------------------------------- the ring road, the lanes and the quarters

/** the ring road's middle, and how far either side of it is walkable (the carriageway and both pavements) */
export const RING_ROAD_R = 130;
export const RING_ROAD_HALF_M = 4;
export const RING_ROAD_IN = RING_ROAD_R - RING_ROAD_HALF_M;
export const RING_ROAD_OUT = RING_ROAD_R + RING_ROAD_HALF_M;
/** its blocks' fronts stand 1.5 m off the walkable edges, their doors on that strip (as the boulevard's are off KERB_OUT) */
export const RING_ROAD_FRONT_IN = RING_ROAD_IN - 1.5;
export const RING_ROAD_FRONT_OUT = RING_ROAD_OUT + 1.5;
/** the inner blocks are this deep; behind their backs a quarter's ground ends */
export const RING_ROAD_BLOCK_D = 12;
export const QUARTER_CORNER_R = RING_ROAD_FRONT_IN - RING_ROAD_BLOCK_D;
/** a quarter opens onto the ring road within this angle of its centre line; the road's inner blocks line it beyond */
export const QUARTER_OPEN = 0.2;
/** a street's blocks reach this far off its centre line (their fronts at ~9.5, 14 deep); a quarter's ground begins beyond */
export const QUARTER_EDGE_M = 25;
/** the lane into a quarter leaves its street between these distances along it, the width of a block's gap */
export const LANE_T = [88, 96] as const;
export const LANE_MID_T = 92;
/** the stretches along a street its blocks fill: round the lane, then up to the ring road, then beyond it to the end */
export const STREET_BLOCK_T: readonly [number, number][] = [
  [66, 88],
  [96, 124],
  [136, 158],
  [158, 180],
  [180, 202],
];

export const QUARTER_IDS = ["park", "canal", "market", "station"] as const;
export type QuarterId = (typeof QUARTER_IDS)[number];

/** a disc in a quarter's frame: p out along its centre line, q across it (to its right seen from the plaza) */
export interface QDisc {
  p: number;
  q: number;
  r: number;
}
/** a box in a quarter's frame */
export interface QBox {
  p0: number;
  p1: number;
  q0: number;
  q1: number;
}
export type Obstacle = ({ kind: "disc" } & QDisc) | ({ kind: "box" } & QBox);

export interface Quarter {
  id: QuarterId;
  /** as the discovery names it */
  name: string;
  sign: string;
  /** its centre line's angle (atan2(x, z)): halfway between its two streets */
  a: number;
  /** its ground begins this far out (behind the backs of the ring's lots) */
  rIn: number;
  /** water and buildings: never walked, never a coin's spot */
  obstacles: readonly Obstacle[];
  /** ground inside an obstacle that is walked after all: the bridge's deck over the canal */
  decks: readonly QBox[];
  /** small things a coin keeps clear of and a walker steps round (trees, benches, stalls, posts): city.ts's colliders */
  fixtures: readonly QDisc[];
  /** the thing to find: its mint mark lies between r0 and r1 of it */
  landmark: { p: number; q: number; r0: number; r1: number };
  /** where its ground meets the ring road: a route's way in from the road's arc */
  gates: readonly [number, number][];
  /** a route's waypoints through it, clear of the water, the buildings and the fixtures */
  nodes: readonly [number, number][];
}

/** the quarter between two streets lies at their mean angle; its two streets are a quarter turn either side */
const QUARTER_HALF = Math.PI / 4;
/** |q| <= p - EDGE_K keeps a point QUARTER_EDGE_M off both of its streets' centre lines */
const EDGE_K = QUARTER_EDGE_M * Math.SQRT2;

/** a row of market stalls: six along p, on both sides of the square's aisle */
const STALLS: QDisc[] = [84, 90, 96, 102, 108, 114].flatMap((p) => [
  { p, q: -14, r: 1.9 },
  { p, q: 14, r: 1.9 },
]);

/**
 * The four quarters. The Park (east of the plaza, between the East and North streets): lawns, a pond, a bandstand
 * with the mark. The Canal (north, behind the Exchange): a channel across the quarter with a bridge on its centre
 * line, the towpath on the near bank, the wharf on the far one. The Market Square (south, behind the Crescent): a
 * dozen stalls round a well. The Station (west, behind Bands & Co.): a train shed against the ring road, two
 * platforms and a train standing at them; its gates are either side of the shed.
 */
export const QUARTERS: readonly Quarter[] = [
  {
    id: "park",
    name: "The Park",
    sign: "THE PARK",
    a: Math.PI / 2,
    rIn: 78,
    obstacles: [
      { kind: "disc", p: 100, q: 12, r: 9 },
      { kind: "disc", p: 98, q: -16, r: 5 },
    ],
    decks: [],
    fixtures: [
      // trees
      { p: 86, q: 4, r: 0.55 }, { p: 88, q: 28, r: 0.55 }, { p: 92, q: -34, r: 0.55 }, { p: 110, q: 30, r: 0.55 },
      { p: 116, q: 20, r: 0.55 }, { p: 118, q: -12, r: 0.55 }, { p: 112, q: -26, r: 0.55 }, { p: 104, q: -32, r: 0.55 },
      { p: 86, q: -8, r: 0.55 }, { p: 108, q: -2, r: 0.55 }, { p: 120, q: 8, r: 0.55 }, { p: 94, q: 40, r: 0.55 },
      { p: 84, q: -28, r: 0.55 }, { p: 100, q: 32, r: 0.55 },
      // benches
      { p: 96, q: 2, r: 1 }, { p: 104, q: 24, r: 1 }, { p: 90, q: -24, r: 1 }, { p: 112, q: -10, r: 1 }, { p: 120, q: -2, r: 1 }, { p: 88, q: 14, r: 1 },
      // the gate's piers
      { p: 125, q: 6, r: 0.5 }, { p: 125, q: -6, r: 0.5 },
    ],
    landmark: { p: 98, q: -16, r0: 5.6, r1: 9 },
    gates: [[125, 0]],
    nodes: [[118, 0], [108, -6], [100, -4], [90, 0], [100, 26], [112, 18], [88, 18], [92, -26], [104, -30], [86, -34], [116, -18], [88, 40], [88, -40]],
  },
  {
    id: "canal",
    name: "The Canal",
    sign: "THE CANAL",
    a: Math.PI,
    rIn: 93,
    obstacles: [
      // the channel, and the tunnel portals it runs into under the ring road's blocks
      { kind: "box", p0: 100, p1: 108, q0: -42, q1: 42 },
      { kind: "box", p0: 98, p1: 110, q0: 42, q1: 45 },
      { kind: "box", p0: 98, p1: 110, q0: -45, q1: -42 },
    ],
    decks: [{ p0: 98.5, p1: 109.5, q0: -3, q1: 3 }],
    fixtures: [
      // bollards on the wharf's edge and the towpath's
      { p: 109.5, q: 8, r: 0.3 }, { p: 109.5, q: 16, r: 0.3 }, { p: 109.5, q: 24, r: 0.3 }, { p: 109.5, q: 32, r: 0.3 },
      { p: 98.5, q: -10, r: 0.3 }, { p: 98.5, q: -20, r: 0.3 }, { p: 98.5, q: 12, r: 0.3 }, { p: 98.5, q: 22, r: 0.3 },
      // the crane on the wharf and the crates by it
      { p: 114, q: 12, r: 1.2 }, { p: 116, q: 20, r: 0.6 }, { p: 117.5, q: 23, r: 0.6 },
      // the lock's winding gear on the towpath
      { p: 98.5, q: -30, r: 0.5 },
      { p: 125, q: 6, r: 0.5 }, { p: 125, q: -6, r: 0.5 },
    ],
    landmark: { p: 104, q: 0, r0: 3.5, r1: 7 },
    gates: [[125, 0]],
    nodes: [[120, 0], [112, 0], [112, 14], [112, -14], [110, 20], [110, -20], [96, 0], [96, 12], [96, -12], [95, 28], [95, -28], [92, 38], [92, -38]],
  },
  {
    id: "market",
    name: "The Market Square",
    sign: "MARKET SQUARE",
    a: 0,
    rIn: 76,
    obstacles: [],
    decks: [],
    fixtures: [
      { p: 100, q: 0, r: 1.8 },
      ...STALLS,
      // crates and barrels behind the stalls
      { p: 87, q: -19.5, r: 0.55 }, { p: 93, q: 19.5, r: 0.55 }, { p: 99, q: -19.5, r: 0.55 }, { p: 105, q: 19.5, r: 0.55 }, { p: 111, q: -19.5, r: 0.55 }, { p: 117, q: 19.5, r: 0.55 },
      // the bunting's poles at the square's corners
      { p: 82, q: 22, r: 0.3 }, { p: 82, q: -22, r: 0.3 }, { p: 116, q: 22, r: 0.3 }, { p: 116, q: -22, r: 0.3 },
      { p: 125, q: 6, r: 0.5 }, { p: 125, q: -6, r: 0.5 },
    ],
    landmark: { p: 100, q: 0, r0: 2.6, r1: 6 },
    gates: [[125, 0]],
    nodes: [[118, 0], [108, 6], [100, 7], [92, 6], [84, 0], [100, -7], [108, -6], [92, -6], [100, 24], [100, -24], [86, 26], [86, -26], [112, 22], [112, -22]],
  },
  {
    id: "station",
    name: "The Station",
    sign: "STATION",
    a: (3 * Math.PI) / 2,
    rIn: 78,
    obstacles: [
      // the train shed against the ring road, and the train standing at the platform
      { kind: "box", p0: 98, p1: 124.5, q0: -13, q1: 13 },
      { kind: "box", p0: 82, p1: 99, q0: -5, q1: -1 },
    ],
    decks: [],
    fixtures: [
      // the buffer stops, the canopies' posts, the forecourt's lamps
      { p: 81, q: -3, r: 0.8 }, { p: 81, q: 3, r: 0.8 },
      { p: 86, q: -7, r: 0.3 }, { p: 92, q: -7, r: 0.3 }, { p: 86, q: 7, r: 0.3 }, { p: 92, q: 7, r: 0.3 },
      { p: 80, q: 14, r: 0.3 }, { p: 80, q: -14, r: 0.3 },
    ],
    landmark: { p: 82, q: -3, r0: 2.5, r1: 7 },
    gates: [[125, 19], [125, -19]],
    nodes: [[118, 19], [118, -19], [104, 19], [104, -19], [94, 12], [94, -12], [90, 9.5], [90, -9.5], [84, 9.5], [84, -9.5], [88, 3], [80, 0], [80, 20], [80, -20], [84, 32], [84, -32]],
  },
];

export const quarterOf = (id: string): Quarter | null => QUARTERS.find((q) => q.id === id) ?? null;

/** a quarter's frame: (x, z) as (p, q), p out along its centre line, q across it */
export function toLocal(qr: Quarter, x: number, z: number): [number, number] {
  const s = Math.sin(qr.a);
  const c = Math.cos(qr.a);
  return [x * s + z * c, x * c - z * s];
}
/** and back: (p, q) of the quarter's frame as (x, z) */
export function toWorld(qr: Quarter, p: number, q: number): [number, number] {
  const s = Math.sin(qr.a);
  const c = Math.cos(qr.a);
  return [p * s + q * c, p * c - q * s];
}

export type PlaceKind = "shop" | "bank" | "room" | "climb" | "floor" | "office" | "end" | "quarter";

export interface Place {
  id: string;
  /** as the keeper's name tag says it */
  name: string;
  /** as the front's sign is lettered */
  sign: string;
  kind: PlaceKind;
  /** the ring (the Crescent is on it), the street it ends, the ring road, or the quarter it is the gate of */
  where: "ring" | StreetName | "ring-road" | QuarterId;
  x: number;
  z: number;
  /** the way the door faces (toward the road before it), as a heading a figure at the door would take */
  facing: number;
  /** a shop's colour (an index into protocol.ts's STRAPS): its awning and door, and its keeper's strap and bow tie */
  strap?: number;
}

const TAU = Math.PI * 2;
/** an edge counts as in: a point nearestWalkable put on one is walkable again, whatever the last bit of a float says */
const EPS = 1e-6;

/** an angle brought into (-PI, PI] */
const wrap = (a: number): number => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const round = (v: number) => Math.round(v * 100) / 100;
const polar = (a: number, r: number): [number, number] => [Math.sin(a) * r, Math.cos(a) * r];
/** a point of a street's frame: t along its centre line, s across it (+s is a quarter turn on from the street) */
const streetPoint = (i: number, t: number, s: number): [number, number] => {
  const a = STREET_ANGLES[i];
  return [t * Math.sin(a) + s * Math.cos(a), t * Math.cos(a) - s * Math.sin(a)];
};

const end = (i: number, id: string, name: string): Place => {
  const a = STREET_ANGLES[i];
  const r = TOWN_RADIUS - 1.5;
  return { id, name, sign: name.toUpperCase(), kind: "end", where: STREET_NAMES[i], x: round(Math.sin(a) * r), z: round(Math.cos(a) * r), facing: wrap(a + Math.PI) };
};
/** a quarter's door: its gate on the ring road's inner edge, facing the road */
const gate = (qr: Quarter): Place => {
  const [x, z] = polar(qr.a, RING_ROAD_IN);
  return { id: qr.id, name: qr.name, sign: qr.sign, kind: "quarter", where: qr.id, x: round(x), z: round(z), facing: wrap(qr.a) };
};

/**
 * Every door in the town. Positions from city.ts's lot frames (see the header); the ids are the ones protocol.ts's
 * PLACE_IDS and shopOf() rely on: a shop's id is its shop, then "-" and where, when the town has two.
 */
export const PLACES: readonly Place[] = [
  // the ring, east: from the East street's corner round to the North street's (the Merchants' Bank's door is at the
  // foot of its portico's steps, which run out over the pavement)
  { id: "hatter", name: "The Hatter", sign: "HATTER", kind: "shop", where: "ring", x: 42.21, z: 25.91, facing: -2.156, strap: 0 },
  { id: "cigars", name: "Cigars", sign: "CIGARS", kind: "shop", where: "ring", x: 47.54, z: 13.85, facing: -1.882, strap: 0 },
  { id: "merchants-bank", name: "The Merchants' Bank", sign: "MERCHANTS' BANK", kind: "bank", where: "ring", x: 45.1, z: 0.04, facing: -1.572 },
  { id: "coffee-east", name: "The Coffee House", sign: "COFFEE HOUSE", kind: "room", where: "ring", x: 45.58, z: -19.45, facing: -1.217, strap: 0 },
  { id: "stationer-east", name: "The Stationer", sign: "STATIONER", kind: "shop", where: "ring", x: 47.27, z: -14.88, facing: -1.217, strap: 0 },
  { id: "wine-merchant", name: "The Wine Merchant", sign: "WINE MERCHANT", kind: "room", where: "ring", x: 41.13, z: -27.59, facing: -1.011, strap: 0 },
  // the ring, north: the tower on the corner, the Exchange (its door at the foot of its steps), the small domed bank
  { id: "clock-tower", name: "The Clock Tower", sign: "CLOCK TOWER", kind: "climb", where: "ring", x: 26.13, z: -42.04, facing: -0.556 },
  { id: "exchange", name: "The Exchange", sign: "THE EXCHANGE", kind: "floor", where: "ring", x: 0.08, z: -50.5, facing: -0.002 },
  { id: "trust-savings", name: "Trust & Savings", sign: "TRUST & SAVINGS", kind: "bank", where: "ring", x: -26.06, z: -42.09, facing: 0.554 },
  // the ring, west: behind Mr Bands' desk, his own house among them
  { id: "tailor", name: "The Tailor", sign: "TAILOR", kind: "shop", where: "ring", x: -43.31, z: -24.09, facing: 1.014, strap: 0 },
  { id: "bookseller-west", name: "The Bookseller", sign: "BOOKSELLER", kind: "room", where: "ring", x: -40.76, z: -28.19, facing: 1.014, strap: 0 },
  { id: "ledgers", name: "Ledgers", sign: "LEDGERS", kind: "room", where: "ring", x: -48.36, z: -10.68, facing: 1.323, strap: 0 },
  { id: "bands-co", name: "Bands & Co.", sign: "BANDS & CO.", kind: "office", where: "ring", x: -49.33, z: 4.08, facing: 1.653 },
  { id: "glover-west", name: "The Glover", sign: "GLOVER", kind: "shop", where: "ring", x: -44.55, z: 21.61, facing: 1.998, strap: 0 },
  { id: "tea-room", name: "The Tea Room", sign: "TEA ROOM", kind: "room", where: "ring", x: -40.67, z: 28.23, facing: 2.155, strap: 0 },
  // the ring, south: the Crescent's shops under its arcade (two coffee houses in a town is normal)
  { id: "printer", name: "The Printer", sign: "PRINTER", kind: "room", where: "ring", x: -23.83, z: 43.5, facing: 2.576, strap: 0 },
  { id: "barber", name: "The Barber", sign: "BARBER", kind: "room", where: "ring", x: -18.24, z: 46.02, facing: 2.764, strap: 0 },
  { id: "glover-crescent", name: "The Glover", sign: "GLOVER", kind: "shop", where: "ring", x: -12.44, z: 48.02, facing: 2.953, strap: 0 },
  { id: "coffee-crescent", name: "The Coffee House", sign: "COFFEE HOUSE", kind: "room", where: "ring", x: 12.44, z: 48.02, facing: -2.953, strap: 0 },
  { id: "bookseller-crescent", name: "The Bookseller", sign: "BOOKSELLER", kind: "room", where: "ring", x: 18.24, z: 46.02, facing: -2.764, strap: 0 },
  { id: "stationer-crescent", name: "The Stationer", sign: "STATIONER", kind: "shop", where: "ring", x: 23.83, z: 43.5, facing: -2.576, strap: 0 },
  // the ring road's new fronts, on its outer side (the Grand Hotel by the East street, its door at the foot of its
  // steps); one near a street wears the street's colour, the rest the ring road's own (STRAPS' last)
  { id: "grand-hotel", name: "The Grand Hotel", sign: "GRAND HOTEL", kind: "room", where: "ring-road", x: 107.06, z: 80.58, facing: -2.216, strap: 1 },
  { id: "ironmonger", name: "The Ironmonger", sign: "IRONMONGER", kind: "room", where: "ring-road", x: 133.75, z: -9.19, facing: -1.534, strap: 5 },
  { id: "chandler", name: "The Chandler", sign: "CHANDLER", kind: "room", where: "ring-road", x: 62.87, z: -118.39, facing: -0.516, strap: 2 },
  { id: "baker", name: "The Baker", sign: "BAKER", kind: "room", where: "ring-road", x: -44.63, z: -126.36, facing: 0.328, strap: 5 },
  { id: "apothecary", name: "The Apothecary", sign: "APOTHECARY", kind: "room", where: "ring-road", x: -133.44, z: -12.32, facing: 1.468, strap: 5 },
  { id: "gazette", name: "The Gazette", sign: "GAZETTE", kind: "room", where: "ring-road", x: -9.08, z: 133.78, facing: 3.038, strap: 5 },
  // the four quarters: their gates on the ring road, a discovery each
  ...QUARTERS.map(gate),
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

/** a lane's ground runs from the street's corridor out to the quarter, a little over the blocks' back line */
const LANE_S_OUT = QUARTER_EDGE_M + 0.5;

/** the lane the point is in: its street, and how far along and across the street it is */
function laneAt(x: number, z: number): { i: number; t: number; s: number } | null {
  for (let i = 0; i < STREET_ANGLES.length; i++) {
    const a = STREET_ANGLES[i];
    const t = x * Math.sin(a) + z * Math.cos(a);
    const s = x * Math.cos(a) - z * Math.sin(a);
    if (t < LANE_T[0] - EPS || t > LANE_T[1] + EPS) continue;
    if (Math.abs(s) < STREET_HALF_WIDTH_M - EPS || Math.abs(s) > LANE_S_OUT + EPS) continue;
    return { i, t, s };
  }
  return null;
}

/** is the point of a quarter's frame on its ground, before its obstacles are asked: its fan, out to the road or the blocks */
function onQuarterFan(qr: Quarter, p: number, q: number): boolean {
  if (p <= 0) return false;
  const r = Math.hypot(p, q);
  if (r < qr.rIn - EPS) return false;
  if (Math.abs(q) > p - EDGE_K + EPS) return false;
  const open = Math.abs(Math.atan2(q, p)) <= QUARTER_OPEN + EPS;
  return r <= (open ? RING_ROAD_IN : QUARTER_CORNER_R) + EPS;
}

const inBox = (b: QBox, p: number, q: number, pad = 0): boolean => p >= b.p0 - pad && p <= b.p1 + pad && q >= b.q0 - pad && q <= b.q1 + pad;
const inObstacle = (o: Obstacle, p: number, q: number): boolean => (o.kind === "disc" ? Math.hypot(p - o.p, q - o.q) < o.r - EPS : inBox(o, p, q, -EPS));

/** the quarter whose ground holds the point (a deck counts, an obstacle does not), with the point in its frame */
export function quarterAt(x: number, z: number): { qr: Quarter; p: number; q: number } | null {
  for (const qr of QUARTERS) {
    const [p, q] = toLocal(qr, x, z);
    if (!onQuarterFan(qr, p, q)) continue;
    if (qr.decks.some((d) => inBox(d, p, q, EPS))) return { qr, p, q };
    if (qr.obstacles.some((o) => inObstacle(o, p, q))) return null;
    return { qr, p, q };
  }
  return null;
}

/**
 * the plaza less the fountain, the whole ring less the rope's band, the four streets out to the town's edge, the ring
 * road, the lanes and the quarters' ground
 */
export function walkable(x: number, z: number): boolean {
  const r = Math.hypot(x, z);
  if (r < FOUNTAIN_R - EPS) return false;
  if (onRope(x, z, r)) return false;
  if (r <= KERB_OUT + EPS) return true;
  if (r > TOWN_RADIUS + EPS) return false;
  if (streetAt(x, z) !== null) return true;
  if (r >= RING_ROAD_IN - EPS && r <= RING_ROAD_OUT + EPS) return true;
  if (laneAt(x, z) !== null) return true;
  return quarterAt(x, z) !== null;
}

/** a street's corridor as two strips along its centre line (t from, t to, half a width): the mouth's, and the open street's */
const STRIPS: readonly { t0: number; t1: number; half: number }[] = [
  { t0: KERB_OUT, t1: MOUTH_END, half: STREET_MOUTH_HALF_M },
  { t0: MOUTH_END, t1: TOWN_RADIUS, half: STREET_HALF_WIDTH_M },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * a point of a quarter's frame pulled onto its fan by projection, each rule in turn a few times over (the fan is all
 * but convex, so this lands on it, at or very near the closest spot), then out of any obstacle it landed in
 */
function ontoFan(qr: Quarter, p0: number, q0: number, open: boolean): [number, number] {
  let p = p0;
  let q = q0;
  const rOut = open ? RING_ROAD_IN : QUARTER_CORNER_R;
  const settle = () => {
    for (let k = 0; k < 8; k++) {
      let r = Math.hypot(p, q);
      let a = Math.atan2(q, p);
      if (open && Math.abs(a) > QUARTER_OPEN) a = Math.sign(a) * QUARTER_OPEN;
      r = clamp(r, qr.rIn, rOut);
      p = Math.cos(a) * r;
      q = Math.sin(a) * r;
      // QUARTER_EDGE_M off each street: the half-planes |q| <= p - EDGE_K, entered along their normals
      const d1 = (q - p + EDGE_K) / Math.SQRT2;
      if (d1 > 0) {
        p += d1 / Math.SQRT2;
        q -= d1 / Math.SQRT2;
      }
      const d2 = (-q - p + EDGE_K) / Math.SQRT2;
      if (d2 > 0) {
        p += d2 / Math.SQRT2;
        q += d2 / Math.SQRT2;
      }
    }
  };
  settle();
  // out of any obstacle it landed in (and out of the next one that push landed it in: the canal's portals meet its channel)
  for (let pass = 0; pass < 4; pass++) {
    if (qr.decks.some((d) => inBox(d, p, q, EPS))) break;
    const o = qr.obstacles.find((ob) => inObstacle(ob, p, q));
    if (!o) break;
    {
      if (o.kind === "disc") {
        const d = Math.hypot(p - o.p, q - o.q);
        const ux = d > 1e-6 ? (p - o.p) / d : 1;
        const uq = d > 1e-6 ? (q - o.q) / d : 0;
        p = o.p + ux * (o.r + 0.05);
        q = o.q + uq * (o.r + 0.05);
      } else {
        // out through the nearest side that is not another obstacle's inside (the portals' sides on the channel)
        const sides = [
          [p - o.p0, -1, 0],
          [o.p1 - p, 1, 0],
          [q - o.q0, 0, -1],
          [o.q1 - q, 0, 1],
        ].sort((u, v) => u[0] - v[0]);
        const clear = sides.find(([d, dp, dq]) => !qr.obstacles.some((ob) => inObstacle(ob, p + dp * (d + 0.05), q + dq * (d + 0.05)))) ?? sides[0];
        p += clear[1] * (clear[0] + 0.05);
        q += clear[2] * (clear[0] + 0.05);
      }
    }
    settle();
  }
  return [p, q];
}

/**
 * The point pulled back to the nearest walkable spot: itself when it is one, else the closest of the fountain's edge,
 * the ring's outer kerb, the rope's band's nearer edge (or the nearest gatepost's line, from the band), the nearest
 * point of each street's two strips, of the ring road, of each lane, and of each quarter's ground (out of its water
 * and its buildings). The server corrects a refused step with this.
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
  for (let i = 0; i < STREET_ANGLES.length; i++) {
    const sa = STREET_ANGLES[i];
    const ux = Math.sin(sa);
    const uz = Math.cos(sa);
    const t = x * ux + z * uz;
    const s = x * Math.cos(sa) - z * Math.sin(sa);
    for (const strip of STRIPS) {
      let ct = clamp(t, strip.t0, strip.t1);
      const cs = clamp(s, -strip.half, strip.half);
      if (Math.hypot(ct, cs) > TOWN_RADIUS) ct = Math.sqrt(TOWN_RADIUS * TOWN_RADIUS - cs * cs);
      offer(ct * ux + cs * Math.cos(sa), ct * uz - cs * Math.sin(sa));
    }
    // the lane, on the side the point is
    const lt = clamp(t, LANE_T[0], LANE_T[1]);
    const ls = Math.sign(s || 1) * clamp(Math.abs(s), STREET_HALF_WIDTH_M, LANE_S_OUT);
    offer(...streetPoint(i, lt, ls));
  }
  // the ring road
  radial(clamp(r, RING_ROAD_IN, RING_ROAD_OUT));
  // the quarters: onto the fan through its opening, and onto the fan short of the road's blocks; a deck's nearest point
  for (const qr of QUARTERS) {
    const [p, q] = toLocal(qr, x, z);
    for (const open of [true, false]) {
      const [cp, cq] = ontoFan(qr, p, q, open);
      const [wx, wz] = toWorld(qr, cp, cq);
      if (walkable(wx, wz)) offer(wx, wz);
    }
    for (const d of qr.decks) {
      const [wx, wz] = toWorld(qr, clamp(p, d.p0, d.p1), clamp(q, d.q0, d.q1));
      if (walkable(wx, wz)) offer(wx, wz);
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

// ---------------------------------------------------------------- the coins

/** a coin, or a mint mark (worth more, drawn larger, one at each street's end and at each quarter's landmark) */
export type CoinKind = "coin" | "mark";
/** the ground a zone covers */
export type CoinGround = "plaza" | "ring" | "ring-road" | StreetName | QuarterId;

export interface CoinZone {
  id: string;
  ground: CoinGround;
  kind: CoinKind;
  /** coins of this zone on the ground at once */
  count: number;
  /** what one is worth, dollars of play money, min..max whole */
  min: number;
  max: number;
}

/**
 * Where the coins lie and what they are worth: cheap about the plaza, better on the ring, best out along the streets
 * and in the quarters, the ring road between; a mint mark at each street's end and at each quarter's landmark. The
 * room refills each zone on its own; the values are the room's alone.
 */
export const COIN_ZONES: readonly CoinZone[] = [
  { id: "plaza", ground: "plaza", kind: "coin", count: 6, min: 5, max: 25 },
  { id: "ring", ground: "ring", kind: "coin", count: 10, min: 10, max: 40 },
  ...STREET_NAMES.flatMap((s): CoinZone[] => [
    { id: s, ground: s, kind: "coin", count: 8, min: 20, max: 80 },
    { id: `${s}-mark`, ground: s, kind: "mark", count: 1, min: 100, max: 100 },
  ]),
  { id: "ring-road", ground: "ring-road", kind: "coin", count: 12, min: 30, max: 60 },
  ...QUARTERS.flatMap((q): CoinZone[] => [
    { id: q.id, ground: q.id, kind: "coin", count: 6, min: 40, max: 90 },
    { id: `${q.id}-mark`, ground: q.id, kind: "mark", count: 1, min: 100, max: 100 },
  ]),
];

/** a coin lands this far from any door (its keeper stands 1.6 m from it), and this far from every other coin */
export const COIN_DOOR_M = 3.5;
export const COIN_GAP_M = 4;
/** the plaza's coins lie between these radii: clear of the fountain's step, and inside the lamps (r 31) and the trees */
export const PLAZA_COIN_R = [FOUNTAIN_R + 2.5, 30] as const;
/** the ring's: off the rope's band and its gateposts, and short of the outer kerb where the doors are */
export const RING_COIN_R = [WORLD_RADIUS + ROPE_BAND_M + 1, KERB_OUT - 0.75] as const;
/** a street's coins run from past the mouth to short of the end, on the carriageway and the pavements */
export const STREET_COIN_T = [MOUTH_END + 2, TOWN_RADIUS - 14] as const;
/** its mark lies near the end, short of the domed front's door and keeper */
export const MARK_COIN_T = [TOWN_RADIUS - 10, TOWN_RADIUS - 4] as const;
/** the ring road's coins keep off its edges, where the doors are */
export const RING_ROAD_COIN_R = [RING_ROAD_IN + 0.75, RING_ROAD_OUT - 0.75] as const;
/** a coin keeps this much clear of a quarter's fixtures beyond their own radius */
export const COIN_FIXTURE_M = 0.6;
/** the plaza's furniture a coin keeps clear of: (x, z, radius) of the fountain, stalls, boards, Guard House, desk, benches, stacks */
export const PLAZA_FIXTURES: readonly [number, number, number][] = [
  [0, 0, 6],
  [-10.5, -9, 3.5], [-3.6, -11, 3.5], [3.6, -11, 3.5], [10.5, -9, 3.5],
  [0, -20, 9],
  [24, 2, 6],
  [-24, 2, 4.5], [DESK_SPOT.x, DESK_SPOT.z, DESK_SPOT.r],
  [-18, 20, 4],
  [-11, 12, 2.2], [11, 13, 2.2], [28, 18, 2.2],
  [-13.5, 4.5, 2], [-12.8, 5.8, 2], [13.5, 6.5, 2], [16, -16, 2], [-15, -15, 2],
];
/** tries before coinSpot gives up (a zone crowded by the coins already down) */
const COIN_TRIES = 40;

/** a point drawn uniformly over the zone's ground (not yet checked against anything) */
function coinDraw(zone: CoinZone, rng: () => number): [number, number] {
  if (zone.ground === "plaza" || zone.ground === "ring" || zone.ground === "ring-road") {
    const [r0, r1] = zone.ground === "plaza" ? PLAZA_COIN_R : zone.ground === "ring" ? RING_COIN_R : RING_ROAD_COIN_R;
    // uniform over the area, not the radius: r from the square root
    const r = Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * rng());
    const a = rng() * TAU;
    return [Math.sin(a) * r, Math.cos(a) * r];
  }
  const qr = quarterOf(zone.ground);
  if (qr) {
    if (zone.kind === "mark") {
      // about the landmark
      const lm = qr.landmark;
      const r = lm.r0 + (lm.r1 - lm.r0) * rng();
      const a = rng() * TAU;
      return toWorld(qr, lm.p + Math.cos(a) * r, lm.q + Math.sin(a) * r);
    }
    // over the fan's bounding sector; the fan's own edges and its obstacles are left to the checks
    const r = Math.sqrt(qr.rIn * qr.rIn + (RING_ROAD_IN * RING_ROAD_IN - qr.rIn * qr.rIn) * rng());
    const a = (rng() * 2 - 1) * 0.6;
    return toWorld(qr, Math.cos(a) * r, Math.sin(a) * r);
  }
  const sa = STREET_ANGLES[STREET_NAMES.indexOf(zone.ground as StreetName)];
  const [t0, t1] = zone.kind === "mark" ? MARK_COIN_T : STREET_COIN_T;
  const half = zone.kind === "mark" ? STREET_HALF_WIDTH_M - 2 : STREET_HALF_WIDTH_M - 1;
  const t = t0 + (t1 - t0) * rng();
  const s = (rng() * 2 - 1) * half;
  return [t * Math.sin(sa) + s * Math.cos(sa), t * Math.cos(sa) - s * Math.sin(sa)];
}

/** is the point clear of the quarter's fixtures (its trees, benches, stalls and posts), by COIN_FIXTURE_M beyond each */
function clearOfFixtures(qr: Quarter, x: number, z: number): boolean {
  const [p, q] = toLocal(qr, x, z);
  return !qr.fixtures.some((f) => Math.hypot(p - f.p, q - f.q) < f.r + COIN_FIXTURE_M);
}

/**
 * A spot for a new coin of the zone: a random point on its ground that is walkable, clear of the plaza's furniture
 * and a quarter's fixtures, COIN_DOOR_M from every door (and so its keeper) and `gap` (COIN_GAP_M unless the caller
 * packs them closer, as a spill does) from every point in `avoid` (the coins down already). Rejection sampling from
 * `rng` (uniform [0, 1)); null when COIN_TRIES draws found none. Pure: the room calls it with its own random, the
 * tests with a seeded one.
 */
export function coinSpot(zone: CoinZone, rng: () => number, avoid: readonly { x: number; z: number }[], gap = COIN_GAP_M): [number, number] | null {
  const qr = quarterOf(zone.ground);
  for (let i = 0; i < COIN_TRIES; i++) {
    const [dx, dz] = coinDraw(zone, rng);
    // rounded first, so the checks judge the point that goes on the wire
    const x = round(dx);
    const z = round(dz);
    if (!walkable(x, z)) continue;
    if (zone.ground === "plaza" && PLAZA_FIXTURES.some(([fx, fz, fr]) => Math.hypot(x - fx, z - fz) < fr)) continue;
    if (qr && (quarterAt(x, z)?.qr !== qr || !clearOfFixtures(qr, x, z))) continue;
    if (zone.ground === "ring-road" && Math.abs(Math.hypot(x, z) - RING_ROAD_R) > RING_ROAD_HALF_M - 0.75) continue;
    if (PLACES.some((p) => Math.hypot(x - p.x, z - p.z) < COIN_DOOR_M)) continue;
    if (avoid.some((c) => Math.hypot(x - c.x, z - c.z) < gap)) continue;
    return [x, z];
  }
  return null;
}

// ---------------------------------------------------------------- the way there

/**
 * A click-walk's route runs the boulevard's arcs at this radius: the carriageway's middle, clear of the kerbs'
 * furniture and 3 m inside the ring's inner edge (an arc's chords stay 0.7 m clear of it)
 */
export const ROUTE_RING_R = 46;
/** and passes a mouth between this far inside (on the plaza, clear of the rope's band and the gateposts) and ROUTE_RING_R */
export const ROUTE_MOUTH_IN_R = 40.5;
/** the boulevard's arc between two mouths is walked in this many chords (0.31 rad each: a chord at r 46 dips to r 45.4) */
const RING_ARC_N = 5;
/** the ring road's arc is walked in this many chords (0.2 rad each: a chord at r 130 dips to r 129.4, inside its 126..134) */
const RING_ROAD_ARC_N = 32;
/** a street's waypoints: every 20 m out from the boulevard, the lane's crossing and the ring road's among them */
const STREET_NODE_T: readonly number[] = [66, 86, LANE_MID_T, 106, RING_ROAD_R, 150, 170, 190];
/** a lane's far end: on the quarter's ground, a few metres past the blocks' back line */
const LANE_END_S = QUARTER_EDGE_M + 4;
/** a plaza leg that would cross the fountain is bent round it at this radius */
const FOUNTAIN_ROUND_R = FOUNTAIN_R + 2;
/** a straight walk is checked this often along it */
const LEG_STEP_M = 0.25;

/** the ground a point stands on */
type Zone =
  | { kind: "plaza" }
  | { kind: "ring"; a: number }
  | { kind: "street"; i: number; t: number }
  | { kind: "ringroad"; a: number }
  | { kind: "lane"; i: number; side: 0 | 1 }
  | { kind: "quarter"; qr: Quarter };

function zoneOf(x: number, z: number): Zone {
  const r = Math.hypot(x, z);
  if (r < WORLD_RADIUS) return { kind: "plaza" };
  if (r <= KERB_OUT) return { kind: "ring", a: Math.atan2(x, z) };
  const s = streetAt(x, z);
  if (s) return { kind: "street", i: s.i, t: s.t };
  if (r >= RING_ROAD_IN - EPS && r <= RING_ROAD_OUT + EPS) return { kind: "ringroad", a: Math.atan2(x, z) };
  const l = laneAt(x, z);
  if (l) return { kind: "lane", i: l.i, side: l.s > 0 ? 1 : 0 };
  const q = quarterAt(x, z);
  if (q) return { kind: "quarter", qr: q.qr };
  return { kind: "ring", a: Math.atan2(x, z) };
}

const mouthIn = (i: number): [number, number] => polar(STREET_ANGLES[i], ROUTE_MOUTH_IN_R);

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

/** is a straight walk from one point to the other on the ground the whole way, and never over the rope? */
function legWalkable(x0: number, z0: number, x1: number, z1: number): boolean {
  if (crossesRope(x0, z0, x1, z1)) return false;
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / LEG_STEP_M));
  for (let k = 0; k <= n; k++) {
    if (!walkable(x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n)) return false;
  }
  return true;
}

/** and, within a quarter, clear of its fixtures too (a route goes round the well, not through it) */
function legClear(qr: Quarter, x0: number, z0: number, x1: number, z1: number): boolean {
  if (!legWalkable(x0, z0, x1, z1)) return false;
  const [p0, q0] = toLocal(qr, x0, z0);
  const [p1, q1] = toLocal(qr, x1, z1);
  const dp = p1 - p0;
  const dq = q1 - q0;
  const len2 = dp * dp + dq * dq;
  for (const f of qr.fixtures) {
    const t = len2 < EPS ? 0 : clamp(((f.p - p0) * dp + (f.q - q0) * dq) / len2, 0, 1);
    if (Math.hypot(p0 + dp * t - f.p, q0 + dq * t - f.q) < f.r + COIN_FIXTURE_M) return false;
  }
  return true;
}

/** the route graph: nodes and their links, built once */
interface Graph {
  pts: [number, number][];
  links: number[][];
  /** the mouths' inner points, by street */
  mouthIn: number[];
  /** the boulevard's nodes with their angles, the mouths' outer points among them */
  ring: { a: number; id: number }[];
  /** each street's nodes in order out from the boulevard (the mouth's outer point first), with their t */
  street: { t: number; id: number }[][];
  /** each street's lane ends: [the -s side, the +s side] */
  laneEnd: [number, number][];
  /** the ring road's nodes with their angles */
  ringRoad: { a: number; id: number }[];
  /** each quarter's nodes (its gates, waypoints and lane ends), by id */
  quarter: Map<string, number[]>;
}

const GRAPH: Graph = (() => {
  const pts: [number, number][] = [];
  const links: number[][] = [];
  const node = (x: number, z: number): number => {
    pts.push([x, z]);
    links.push([]);
    return pts.length - 1;
  };
  const link = (a: number, b: number) => {
    if (!links[a].includes(b)) links[a].push(b);
    if (!links[b].includes(a)) links[b].push(a);
  };
  const S = STREET_ANGLES;
  // the mouths and the boulevard's arcs between them
  const mouthInIds = S.map((a) => node(...polar(a, ROUTE_MOUTH_IN_R)));
  const mouthOutIds = S.map((a) => node(...polar(a, ROUTE_RING_R)));
  const ring: { a: number; id: number }[] = [];
  for (let i = 0; i < S.length; i++) {
    link(mouthInIds[i], mouthOutIds[i]);
    ring.push({ a: S[i], id: mouthOutIds[i] });
    let prev = mouthOutIds[i];
    for (let k = 1; k < RING_ARC_N; k++) {
      const a = S[i] + ((TAU / 4) * k) / RING_ARC_N;
      const id = node(...polar(a, ROUTE_RING_R));
      ring.push({ a: wrap(a), id });
      link(prev, id);
      prev = id;
    }
    link(prev, mouthOutIds[(i + 1) % S.length]);
  }
  // the streets, out from the boulevard; the ring road's crossing is one of their nodes
  const street: { t: number; id: number }[][] = [];
  const crossing: number[] = [];
  const laneEnd: [number, number][] = [];
  for (let i = 0; i < S.length; i++) {
    const row = [{ t: ROUTE_RING_R, id: mouthOutIds[i] }];
    for (const t of STREET_NODE_T) {
      const id = node(...polar(S[i], t));
      link(row[row.length - 1].id, id);
      row.push({ t, id });
      if (t === RING_ROAD_R) crossing[i] = id;
    }
    street.push(row);
    const laneNode = row.find((n) => n.t === LANE_MID_T)!.id;
    const ends: [number, number] = [node(...streetPoint(i, LANE_MID_T, -LANE_END_S)), node(...streetPoint(i, LANE_MID_T, LANE_END_S))];
    link(laneNode, ends[0]);
    link(laneNode, ends[1]);
    laneEnd.push(ends);
  }
  // the ring road round, through the crossings
  const ringRoad: { a: number; id: number }[] = [];
  for (let k = 0; k < RING_ROAD_ARC_N; k++) {
    const a = (TAU * k) / RING_ROAD_ARC_N;
    const si = S.findIndex((s) => Math.abs(wrap(a - s)) < 1e-9);
    const id = si >= 0 ? crossing[si] : node(...polar(a, RING_ROAD_R));
    ringRoad.push({ a: wrap(a), id });
  }
  for (let k = 0; k < RING_ROAD_ARC_N; k++) link(ringRoad[k].id, ringRoad[(k + 1) % RING_ROAD_ARC_N].id);
  // the quarters: gates off the ring road's node at their angle, waypoints, and the lane ends of their two streets;
  // linked wherever a straight walk between two of them is clear
  const quarter = new Map<string, number[]>();
  for (const qr of QUARTERS) {
    const own: number[] = [];
    const road = ringRoad.find((n) => Math.abs(wrap(n.a - qr.a)) < 1e-9)!.id;
    for (const [p, q] of qr.gates) {
      const id = node(...toWorld(qr, p, q));
      link(road, id);
      own.push(id);
    }
    for (const [p, q] of qr.nodes) own.push(node(...toWorld(qr, p, q)));
    // the street a quarter turn before it has the quarter on its +s side; the one after, on its -s side
    const before = S.findIndex((s) => Math.abs(wrap(qr.a - QUARTER_HALF - s)) < 1e-9);
    const after = S.findIndex((s) => Math.abs(wrap(qr.a + QUARTER_HALF - s)) < 1e-9);
    own.push(laneEnd[before][1], laneEnd[after][0]);
    for (let i = 0; i < own.length; i++) {
      for (let j = i + 1; j < own.length; j++) {
        const [ax, az] = pts[own[i]];
        const [bx, bz] = pts[own[j]];
        if (legClear(qr, ax, az, bx, bz)) link(own[i], own[j]);
      }
    }
    quarter.set(qr.id, own);
  }
  return { pts, links, mouthIn: mouthInIds, ring, street, laneEnd, ringRoad, quarter };
})();

/** how a point off the graph joins it: a node, the walk to it, and the points passed on the way (the node not among them) */
interface Join {
  id: number;
  cost: number;
  via: [number, number][];
}

const polyLen = (from: [number, number], pts: [number, number][]): number => {
  let d = 0;
  let [lx, lz] = from;
  for (const [x, z] of pts) {
    d += Math.hypot(x - lx, z - lz);
    [lx, lz] = [x, z];
  }
  return d;
};

/** the ways a point joins the graph, by the ground it stands on */
function joins(x: number, z: number, zone: Zone): Join[] {
  const G = GRAPH;
  const straight = (id: number): Join => ({ id, cost: Math.hypot(G.pts[id][0] - x, G.pts[id][1] - z), via: [] });
  const flanking = (nodes: { a: number; id: number }[], a: number): Join[] =>
    [...nodes]
      .sort((u, v) => Math.abs(wrap(u.a - a)) - Math.abs(wrap(v.a - a)))
      .slice(0, 2)
      .map((n) => straight(n.id));
  switch (zone.kind) {
    case "plaza":
      return G.mouthIn.map((id) => {
        const leg = plazaLeg(x, z, ...G.pts[id]);
        return { id, cost: polyLen([x, z], leg), via: leg.slice(0, -1) };
      });
    case "ring":
      return flanking(G.ring, zone.a);
    case "ringroad": {
      // and a quarter's gate in plain sight, so a walk to a gate is not out to the road's middle and back
      const gates: Join[] = [];
      for (const qr of QUARTERS) for (const id of (G.quarter.get(qr.id) ?? []).slice(0, qr.gates.length)) if (legWalkable(x, z, ...G.pts[id])) gates.push(straight(id));
      return [...flanking(G.ringRoad, zone.a), ...gates];
    }
    case "street": {
      const row = G.street[zone.i];
      const below = [...row].reverse().find((n) => n.t <= zone.t) ?? row[0];
      const above = row.find((n) => n.t >= zone.t) ?? row[row.length - 1];
      return [...new Set([below.id, above.id])].map(straight);
    }
    case "lane": {
      const row = G.street[zone.i];
      return [row.find((n) => n.t === LANE_MID_T)!.id, G.laneEnd[zone.i][zone.side]].map(straight);
    }
    case "quarter": {
      const own = G.quarter.get(zone.qr.id) ?? [];
      const clear = own.filter((id) => legClear(zone.qr, x, z, ...G.pts[id])).map(straight);
      // a pocket no waypoint sees straight: the nearest one, and let the walker slide round what is in the way
      return clear.length ? clear : own.map(straight).sort((u, v) => u.cost - v.cost).slice(0, 1);
    }
  }
}

/** the shortest way through the graph from any of the start's joins to any of the end's: the nodes passed, in order */
function search(from: Join[], to: Join[]): { start: Join; end: Join; nodes: number[] } | null {
  const G = GRAPH;
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const startBy = new Map<number, Join>();
  const open = new Set<number>();
  for (const j of from) {
    if ((dist.get(j.id) ?? Infinity) > j.cost) {
      dist.set(j.id, j.cost);
      startBy.set(j.id, j);
      open.add(j.id);
    }
  }
  const done = new Set<number>();
  while (open.size) {
    let u = -1;
    let du = Infinity;
    for (const id of open) {
      const d = dist.get(id)!;
      if (d < du) {
        du = d;
        u = id;
      }
    }
    open.delete(u);
    done.add(u);
    for (const v of G.links[u]) {
      if (done.has(v)) continue;
      const d = du + Math.hypot(G.pts[v][0] - G.pts[u][0], G.pts[v][1] - G.pts[u][1]);
      if (d < (dist.get(v) ?? Infinity)) {
        dist.set(v, d);
        prev.set(v, u);
        open.add(v);
      }
    }
  }
  let best: { end: Join; total: number } | null = null;
  for (const j of to) {
    const d = dist.get(j.id);
    if (d === undefined) continue;
    if (!best || d + j.cost < best.total) best = { end: j, total: d + j.cost };
  }
  if (!best) return null;
  const nodes: number[] = [];
  for (let u: number | undefined = best.end.id; u !== undefined; u = prev.get(u)) nodes.push(u);
  nodes.reverse();
  return { start: startBy.get(nodes[0])!, end: best.end, nodes };
}

/**
 * may a route between these grounds be the straight line, if it is clear? Not from or to the plaza (the rope), and on
 * the boulevard only a short hop (a longer one is walked along the ring's middle, clear of the kerbs' furniture)
 */
function straightAway(from: Zone, to: Zone): boolean {
  if (from.kind === "plaza" || to.kind === "plaza") return false;
  if (from.kind === "ring" || to.kind === "ring") return from.kind === "ring" && to.kind === "ring" && Math.abs(wrap(from.a - to.a)) <= TAU / 4 / RING_ARC_N;
  return true;
}

/**
 * The way from (x0, z0) to (x1, z1) through the town's shape, as waypoints to walk in order, the last the target
 * itself (pulled to walkable ground). On the plaza it is the straight line, bent round the fountain; anywhere else a
 * straight walk that is on the ground the whole way (and not over the rope) is the target alone; otherwise the route
 * graph: the rope passed only at a mouth, in and out along the street's angle, the boulevard walked along the ring's
 * middle (ROUTE_RING_R) in short arcs, a street along its centre line, the ring road in its arcs, a quarter by its
 * gate or a lane and its own waypoints. Small things on the way (a planter, a lamp, the Guard House) are left to the
 * walker to go round; no waypoint lies in the rope's band, a façade or the water.
 */
export function routeTo(x0: number, z0: number, x1: number, z1: number): [number, number][] {
  const [sx, sz] = nearestWalkable(x0, z0);
  const [tx, tz] = nearestWalkable(x1, z1);
  const from = zoneOf(sx, sz);
  const to = zoneOf(tx, tz);
  let path: [number, number][];
  if (from.kind === "plaza" && to.kind === "plaza") path = plazaLeg(sx, sz, tx, tz);
  else if (straightAway(from, to) && legWalkable(sx, sz, tx, tz)) path = [[tx, tz]];
  else {
    const found = search(joins(sx, sz, from), joins(tx, tz, to));
    if (!found) path = [[tx, tz]];
    else path = [...found.start.via, ...found.nodes.map((id) => GRAPH.pts[id]), ...[...found.end.via].reverse(), [tx, tz]];
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

/** the route graph's points and links, for a dev script or a test to check every link is a clear walk */
export const ROUTE_GRAPH: { readonly pts: readonly (readonly [number, number])[]; readonly links: readonly (readonly number[])[] } = GRAPH;
