/**
 * THE TOWN ALIVE (bands.finance Play, 24 Sep): everything in the town that moves of its own accord, so the streets
 * are not scenery. Zach, after the simple town: "the feel: camera, life, light; it's very plain."
 *
 * - Sixteen passers-by (./figure.ts) on loops: five across the plaza, one out and back along each street's pavement,
 *   one each way round the ring road, two through the park, one round the market, one along the canal and over its
 *   bridge, one round the boulevard (town.ts's quarters give the points; a quarter the town has not got sends its
 *   walker round the boulevard). Placed by the clock, as before, so every visitor sees them in the same places.
 * - Four hand-carts (a box on two spoked wheels, a shaft pair, two sacks) rolling at CART_MS on fixed loops: round
 *   the boulevard's carriageway, round the ring road, out and back along the East and West streets. Each has a
 *   collider the world moves with it, so a walker steps round it.
 * - Pigeons on the plaza: a dozen that walk a step, peck, and fly up and resettle when anyone comes within
 *   SCATTER_M. Gulls: ink Vs on slow ellipses, three round the clock tower and three over the station's shed.
 * - A newsboy at the Exchange's steps with a bundle under his arm and a line when you stand near; a sweeper on the
 *   boulevard's inner pavement, broom swinging; a dog that trots after the nearest walker for a while, then sits.
 * - Wind: the city's awnings and flags sway (they are instances of city.ts's strap piece: found by their shape and
 *   turned each frame about their hinge, so city.ts is not touched); smoke drifts from every chimney pot (found the
 *   same way among the drum instances) as one instanced sprite cloud, paper-toned, fading as it rises.
 * - At night (the shared night factor, when the light agent's engrave.ts has one) the lamp globes flicker faintly.
 *
 * Economy: every repeated thing is one InstancedMesh (carts 8 draws, pigeons 4, gulls 2, smoke 1); a figure drops
 * its contours past DETAIL_M and is not drawn or animated past SHOW_M (the fog's edge), the way the world's
 * keepers do. The whole of this at the plaza is about 200 draws with everyone in frame.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { engraveMaterial, shared, SPECS } from "../stage/engrave";
import { hexRgb, INK, labelSprite, mat, OUTLINE, OUTLINE_FINE, part } from "./engraved";
import { handOf, makeDog, makeFigure } from "./figure";
import { STRAPS, WORLD_RADIUS } from "./protocol";
import { nearestWalkable, PLACES, PLAZA_FIXTURES, quarterOf, RING_ROAD_R, STREET_ANGLES, toWorld, TOWN_RADIUS, type Quarter } from "./town";

/** a circle on the ground the walker is pushed out of (the world's own shape for one) */
export interface Circle {
  x: number;
  z: number;
  r: number;
}

export interface Life {
  root: THREE.Group;
  /** the carts' colliders: their x and z move every frame */
  colliders: Circle[];
  /** every frame: the clock, the camera, where you stand, and where the other visitors stand (for the birds and the dog) */
  update(dt: number, t: number, cam: THREE.Vector3, me: THREE.Vector3, others: readonly THREE.Vector3[]): void;
}

const TAU = Math.PI * 2;
/** the world's walk, m/s: a figure's animate() takes speed as a share of it */
const WALK_MS = 5.5;
/** a figure's contours are drawn only this near the camera, and the figure at all only within SHOW_M (the fog starts at 70) */
const DETAIL_M = 26;
const SHOW_M = 70;
/** the carts' speed */
const CART_MS = 2;
/** a cart's collider, and a cart's wheel */
const CART_R = 1.35;
const WHEEL_R = 0.5;
/** a pigeon flies when anyone comes this near */
const SCATTER_M = 3;
/** the newsboy speaks when you come this near, and not again for a while */
const NEWSBOY_M = 4.5;
const NEWSBOY_AGAIN_S = 25;
const NEWSBOY_LINE = "Gazette! The board's turned!";
/** the dog: how far it looks for someone, how close it keeps, how long it follows one walker, how long it sits */
const DOG_LOOK_M = 14;
const DOG_KEEP_M = 1.3;
const DOG_FOLLOW_S: [number, number] = [18, 40];
const DOG_SIT_S: [number, number] = [8, 16];
const DOG_MS = 3.2;

const polar = (a: number, r: number): [number, number] => [Math.sin(a) * r, Math.cos(a) * r];
/** a point t along street i, s to its side (a positive s is round toward the larger angle) */
const onStreet = (i: number, t: number, s: number): [number, number] => {
  const a = STREET_ANGLES[i];
  return [Math.sin(a) * t + Math.cos(a) * s, Math.cos(a) * t - Math.sin(a) * s];
};

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % TAU) - Math.PI;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/** a deterministic little generator (the figures' own), so the same seed always gives the same town */
function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- loops

/** a closed polyline and how far along it each point lies */
interface Loop {
  pts: [number, number][];
  lengths: number[];
  total: number;
}

function loopOf(pts: [number, number][]): Loop {
  const lengths: number[] = [];
  let total = 0;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % pts.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.push(l);
    total += l;
  }
  return { pts, lengths, total };
}

/** where a distance d along the loop falls: the point and the heading there */
function alongLoop(l: Loop, d: number, out: { x: number; z: number; ry: number }) {
  d = ((d % l.total) + l.total) % l.total;
  let k = 0;
  while (d > l.lengths[k]) {
    d -= l.lengths[k];
    k = (k + 1) % l.pts.length;
  }
  const a = l.pts[k];
  const b = l.pts[(k + 1) % l.pts.length];
  const f = l.lengths[k] > 1e-6 ? d / l.lengths[k] : 0;
  out.x = a[0] + (b[0] - a[0]) * f;
  out.z = a[1] + (b[1] - a[1]) * f;
  out.ry = Math.atan2(b[0] - a[0], b[1] - a[1]);
}

/** a full circle at r, n points, the other way round when dir is -1 */
function ring(r: number, n: number, dir: 1 | -1 = 1): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) out.push(polar((dir * i * TAU) / n, r));
  return out;
}

/**
 * out along street i on one side and back on the other, between tFrom and tTo, turning at each end: the pavements
 * beyond the tree line (the trees and lamps stand 5.6 m off the centre line) and inside the walls at 7
 */
function streetLoop(i: number, side: number, tFrom: number, tTo: number): [number, number][] {
  return [onStreet(i, tFrom, side), onStreet(i, tTo, side), onStreet(i, tTo + 2.5, 0), onStreet(i, tTo, -side), onStreet(i, tFrom, -side), onStreet(i, tFrom - 2.5, 0)];
}

/** along an arc of the ring at r from a0 to a1 and back again (a sweeper's beat) */
function arcBeat(r: number, a0: number, a1: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) out.push(polar(a0 + ((a1 - a0) * i) / n, r));
  for (let i = n - 1; i > 0; i--) out.push(polar(a0 + ((a1 - a0) * i) / n, r));
  return out;
}

/** a walk out along the points and back the same way, as one loop */
function outAndBack(pts: [number, number][]): [number, number][] {
  return [...pts, ...pts.slice(1, -1).reverse()];
}

/** points in a quarter's own frame (town.ts's p out, q across) put into the world; nothing if the quarter is not in the town */
function inQuarter(id: string, pts: [number, number][]): [number, number][] {
  const qr: Quarter | null = quarterOf(id);
  return qr ? pts.map(([p, q]) => toWorld(qr, p, q)) : [];
}

// ---------------------------------------------------------------- the passers-by

interface Route {
  pts: [number, number][];
  /** m/s */
  speed: number;
  strap: number;
  seed: number;
}

/**
 * the sixteen: the five plaza loops (checked against the map: clear of the fountain, the board, the stalls, the
 * landmarks, the benches and the lamps), one out and back along each street's pavement (two as far as the town goes,
 * two to the ring road), one each way round the ring road, two through the park's paths (either side of the pond,
 * round the bandstand), one round the market's stalls, one along the canal's towpath and over the bridge to the
 * wharf, and one round the boulevard. A quarter's points are town.ts's own frame (p out, q across), kept clear of
 * its water, its buildings and its benches
 */
function routes(): Route[] {
  // (the leg across the front of the fountain stays 2 m clear of its basin, r 4.5)
  const plazaA: [number, number][] = [[0, 28], [-10, 26], [-16, 14], [-17, 4], [-8, -6.5], [8, -6.5], [18, 6], [16, 18], [6, 27]];
  const inner = WORLD_RADIUS + 1.3;
  const far = TOWN_RADIUS - 8;
  const toRoad = RING_ROAD_R + 14;
  const list: Route[] = [
    { pts: plazaA, speed: 1.6, strap: 1, seed: 11 },
    { pts: [[-6, -24], [-12, -16], [-20, -8], [-30, -5], [-28, 10], [-20, -2]], speed: 1.45, strap: 2, seed: 18 },
    { pts: [[11, -26], [20, -18], [30, -8], [32, 8], [20, 22], [6, -4]], speed: 1.7, strap: 3, seed: 25 },
    { pts: [[-5, 14], [0, 19], [5, 14], [0, 12.5]], speed: 1.1, strap: 4, seed: 32 },
    { pts: plazaA, speed: 1.35, strap: 5, seed: 39 },
    // the streets: out on the left pavement and back on the right
    { pts: streetLoop(0, 6.3, 54, far), speed: 1.5, strap: 2, seed: 46 },
    { pts: streetLoop(1, 6.3, 54, toRoad), speed: 1.4, strap: 4, seed: 53 },
    { pts: streetLoop(2, 6.3, 54, far), speed: 1.55, strap: 0, seed: 60 },
    { pts: streetLoop(3, 6.3, 54, toRoad), speed: 1.45, strap: 3, seed: 67 },
    // the ring road, each way, on its two pavements
    { pts: ring(RING_ROAD_R - 2.8, 96, 1), speed: 1.5, strap: 5, seed: 74 },
    { pts: ring(RING_ROAD_R + 2.8, 96, -1), speed: 1.4, strap: 1, seed: 81 },
    // the park: west and north of the pond; south, round the bandstand
    { pts: inQuarter("park", [[118, 0], [108, -6], [100, -4], [90, 0], [84, 10], [88, 18], [100, 28], [112, 18]]), speed: 1.3, strap: 4, seed: 88 },
    { pts: inQuarter("park", [[118, 0], [116, -18], [104, -30], [92, -26], [88, -8], [100, -4], [108, -6]]), speed: 1.45, strap: 2, seed: 95 },
    // the market: the aisle round the well, inside the stall rows
    { pts: inQuarter("market", [[118, 0], [108, 6], [100, 7], [92, 6], [84, 0], [92, -6], [100, -7], [108, -6]]), speed: 1.2, strap: 0, seed: 102 },
    // the canal: along the towpath, over the bridge, along the wharf, and back
    { pts: inQuarter("canal", outAndBack([[95, -38], [96, -28], [96, -12], [96, 0], [112, 0], [112, 14], [110, 20]])), speed: 1.35, strap: 3, seed: 109 },
    // the boulevard: the inner pavement between the rope and the trees
    { pts: ring(inner, 48, -1), speed: 1.5, strap: 5, seed: 116 },
  ];
  // (a quarter the town has not got yet gives no points: that walker takes the boulevard instead)
  return list.map((r) => (r.pts.length >= 2 ? r : { ...r, pts: ring(inner, 48, 1) }));
}

/** a figure (or the dog) of the town's own, with its contours listed so they can be dropped at a distance */
interface Extra {
  root: THREE.Group;
  lines: THREE.Object3D[];
  near: boolean;
}

function extraOf(root: THREE.Group): Extra {
  const lines: THREE.Object3D[] = [];
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m === OUTLINE || m === OUTLINE_FINE) lines.push(o);
  });
  return { root, lines, near: true };
}

/** shown within SHOW_M of the camera, contours within DETAIL_M (with a metre of slack either way); says whether to animate */
function detail(e: Extra, cam: THREE.Vector3): boolean {
  const d = cam.distanceTo(e.root.position);
  const show = d < SHOW_M;
  e.root.visible = show;
  if (!show) return false;
  const near = e.near ? d < DETAIL_M + 1 : d < DETAIL_M - 1;
  if (near !== e.near) {
    e.near = near;
    for (const l of e.lines) l.visible = near;
  }
  return true;
}

// ---------------------------------------------------------------- small shapes (the figure kit's helpers, for the birds and the carts)

function ellip(rx: number, ry: number, rz: number, x: number, y: number, z: number, seg = 10): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg - 2));
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** one geometry from several (one draw): non-indexed, position, normal and uv only */
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") n.deleteAttribute(k);
    return n;
  });
  const m = mergeGeometries(clean, false);
  if (!m) throw new Error("life: merge failed");
  return m;
}

/** an instanced piece with its contour sharing the instance matrices: two draws however many there are */
function instanced(geo: THREE.BufferGeometry, material: THREE.Material, n: number, line: THREE.Material | null, shadow: boolean): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, material, n);
  im.castShadow = shadow;
  im.receiveShadow = true;
  // (they move: no bounding sphere would hold them, and they are few)
  im.frustumCulled = false;
  if (line) {
    const ol = new THREE.InstancedMesh(geo, line, n);
    ol.instanceMatrix = im.instanceMatrix;
    ol.frustumCulled = false;
    im.add(ol);
  }
  return im;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _at = { x: 0, z: 0, ry: 0 };

// ---------------------------------------------------------------- the carts

interface Cart {
  loop: Loop;
  offset: number;
  ry: number;
  hit: Circle;
}

/** a wheel: an iron rim, eight spokes and a hub, its axle along x */
function wheelGeo(): THREE.BufferGeometry {
  const rim = new THREE.TorusGeometry(WHEEL_R, 0.04, 6, 22);
  rim.rotateY(Math.PI / 2);
  const parts: THREE.BufferGeometry[] = [rim];
  for (let k = 0; k < 4; k++) {
    const s = new THREE.BoxGeometry(0.035, WHEEL_R * 2 - 0.04, 0.035);
    s.rotateX((k * Math.PI) / 4);
    parts.push(s);
  }
  const hub = new THREE.CylinderGeometry(0.075, 0.075, 0.12, 10);
  hub.rotateZ(Math.PI / 2);
  parts.push(hub);
  return merge(parts);
}

/** the carts' loops: round the boulevard's carriageway, round the ring road, and out and back along the East and West streets to short of the ring road */
function cartLoops(): [number, number][][] {
  const far = RING_ROAD_R - 10;
  const drive = 1.9;
  const cartR = 47.4;
  // out and back along a street, a turn in the mouth on the boulevard's carriageway and one at the far end
  const street = (i: number): [number, number][] => {
    const a = STREET_ANGLES[i];
    return [polar(a - 0.06, cartR), polar(a, cartR - 0.8), polar(a + 0.06, cartR), onStreet(i, 53, drive), onStreet(i, far, drive), onStreet(i, far + 2.6, 0), onStreet(i, far, -drive), onStreet(i, 53, -drive)];
  };
  return [ring(cartR, 56, 1), ring(RING_ROAD_R, 96, -1), street(0), street(2)];
}

function buildCarts(root: THREE.Group): { carts: Cart[]; place(t: number, dt: number): void } {
  const loops = cartLoops();
  const n = loops.length;
  const wood = mat("Wood");
  const body = instanced(new THREE.BoxGeometry(1.0, 0.5, 1.7), wood, n, OUTLINE, true);
  const wheel = instanced(wheelGeo(), wood, n * 2, OUTLINE_FINE, true);
  const shaft = instanced(new THREE.BoxGeometry(0.06, 0.06, 1.5), wood, n * 2, OUTLINE_FINE, false);
  const sack = instanced(merge([ellip(0.3, 0.24, 0.28, 0, 0, 0)]), mat("Cloth"), n * 2, OUTLINE_FINE, true);
  root.add(body, wheel, shaft, sack);
  const carts: Cart[] = loops.map((pts, i) => ({ loop: loopOf(pts), offset: i * 61.7 + 20, ry: 0, hit: { x: 0, z: 0, r: CART_R } }));
  return {
    carts,
    place(t, dt) {
      carts.forEach((c, i) => {
        const d = t * CART_MS + c.offset;
        alongLoop(c.loop, d, _at);
        c.ry = dt > 0 ? lerpAngle(c.ry, _at.ry, Math.min(1, dt * 4)) : _at.ry;
        c.hit.x = _at.x;
        c.hit.z = _at.z;
        _m.makeRotationY(c.ry).setPosition(_at.x, 0, _at.z);
        body.setMatrixAt(i, _m2.copy(_m).multiply(_m3.makeTranslation(0, 0.8, 0)));
        const spin = d / WHEEL_R;
        for (const s of [-1, 1]) {
          const k = i * 2 + (s + 1) / 2;
          wheel.setMatrixAt(k, _m2.copy(_m).multiply(_m3.makeTranslation(s * 0.63, WHEEL_R, 0)).multiply(_m3.makeRotationX(spin)));
          shaft.setMatrixAt(k, _m2.copy(_m).multiply(_m3.makeTranslation(s * 0.36, 0.7, 1.45)).multiply(_m3.makeRotationX(0.12)));
          sack.setMatrixAt(k, _m2.copy(_m).multiply(_m3.makeTranslation(s * 0.08, 1.2, s * 0.42)).multiply(_m3.makeRotationY(s * 0.4)));
        }
      });
      body.instanceMatrix.needsUpdate = true;
      wheel.instanceMatrix.needsUpdate = true;
      shaft.instanceMatrix.needsUpdate = true;
      sack.instanceMatrix.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------- the birds

interface Pigeon {
  x: number;
  z: number;
  ry: number;
  /** the ground it keeps to: a home it walks about, chosen afresh after a flight */
  hx: number;
  hz: number;
  /** a flight: from, to, how far along (0..1) or -1 on the ground */
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  f: number;
  /** the next step, and a peck's phase */
  nextAt: number;
  peck: number;
  seed: number;
}

const PIGEONS = 12;
const PIGEON_SCALE = 1.3;
/** where the pigeons settle: the open plaza between the fountain's step and the lamps, off the fixtures */
function pigeonSpot(rand: () => number, awayX: number, awayZ: number): [number, number] {
  for (let i = 0; i < 20; i++) {
    const a = rand() * TAU;
    const r = 8 + rand() * 20;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    if (PLAZA_FIXTURES.some(([fx, fz, fr]) => Math.hypot(x - fx, z - fz) < fr + 1)) continue;
    if (Math.hypot(x - awayX, z - awayZ) < SCATTER_M * 2.5) continue;
    return [x, z];
  }
  return [0, 14];
}

function buildPigeons(root: THREE.Group, rand: () => number) {
  const grey = mat("Cloth");
  // (drawn a size up, as an engraver draws a bird that has to read at ten paces)
  const bodyGeo = merge([ellip(0.06, 0.055, 0.1, 0, 0.075, 0), ellip(0.034, 0.032, 0.036, 0, 0.13, 0.085), box(0.06, 0.012, 0.09, 0, 0.075, -0.12, -0.12)]).scale(PIGEON_SCALE, PIGEON_SCALE, PIGEON_SCALE);
  const body = instanced(bodyGeo, grey, PIGEONS, OUTLINE_FINE, false);
  const wingGeo = new THREE.PlaneGeometry(0.16, 0.09).rotateX(-Math.PI / 2).translate(0.08, 0, 0).scale(PIGEON_SCALE, PIGEON_SCALE, PIGEON_SCALE);
  const wings = instanced(wingGeo, engraveMaterial({ ...SPECS.Cloth, doubleSide: true }), PIGEONS * 2, null, false);
  root.add(body, wings);
  const birds: Pigeon[] = [];
  for (let i = 0; i < PIGEONS; i++) {
    const [x, z] = pigeonSpot(rand, 0, 20);
    birds.push({ x, z, ry: rand() * TAU, hx: x, hz: z, fx: x, fz: z, tx: x, tz: z, f: -1, nextAt: rand() * 3, peck: rand() * 10, seed: rand() * 100 });
  }
  return {
    place(dt: number, t: number, walkers: readonly THREE.Vector3[], me: THREE.Vector3) {
      birds.forEach((b, i) => {
        let y = 0;
        let pitch = 0;
        let flap = 0;
        if (b.f < 0) {
          // on the ground: a step now and then about its home, and a peck between steps
          let near = Math.hypot(me.x - b.x, me.z - b.z) < SCATTER_M ? me : null;
          if (!near) for (const w of walkers) if (Math.hypot(w.x - b.x, w.z - b.z) < SCATTER_M) { near = w; break; }
          if (near) {
            // up and away from whoever came: a new home on the far side of the plaza from them
            const [tx, tz] = pigeonSpot(rand, near.x, near.z);
            b.fx = b.x; b.fz = b.z; b.tx = tx; b.tz = tz; b.f = 0;
            b.hx = tx; b.hz = tz;
            b.ry = Math.atan2(tx - b.x, tz - b.z);
          } else {
            b.nextAt -= dt;
            if (b.nextAt <= 0) {
              b.nextAt = 1.5 + rand() * 3;
              const a = rand() * TAU;
              const step = 0.4 + rand() * 0.9;
              const nx = b.hx + Math.sin(a) * step * 2;
              const nz = b.hz + Math.cos(a) * step * 2;
              b.ry = Math.atan2(nx - b.x, nz - b.z);
              b.x += Math.sin(b.ry) * step;
              b.z += Math.cos(b.ry) * step;
              b.peck = t;
            }
            // a peck: three quick nods after each step
            const since = t - b.peck;
            if (since < 1.2) pitch = Math.max(0, Math.sin(since * TAU * 2.5)) * 0.5;
          }
        } else {
          // a flight: an arc up and over to the new spot, wings beating, then a glide down
          b.f = Math.min(1, b.f + dt / 2.2);
          const f = b.f;
          b.x = b.fx + (b.tx - b.fx) * f;
          b.z = b.fz + (b.tz - b.fz) * f;
          y = Math.sin(f * Math.PI) * 3.2;
          flap = f < 0.75 ? Math.sin(t * TAU * 7 + b.seed) * 0.9 : 0.35;
          pitch = -0.25 + 0.5 * f;
          if (f >= 1) {
            b.f = -1;
            b.nextAt = 1 + rand() * 2;
          }
        }
        _e.set(pitch, b.ry, 0, "YXZ");
        _m.makeRotationFromEuler(_e).setPosition(b.x, y, b.z);
        body.setMatrixAt(i, _m);
        for (const s of [-1, 1]) {
          const k = i * 2 + (s + 1) / 2;
          // folded along the body on the ground, beating in the air; the left wing is the right one mirrored
          _m2.copy(_m).multiply(_m3.makeTranslation(s * 0.04 * PIGEON_SCALE, 0.1 * PIGEON_SCALE, 0.0)).multiply(_m3.makeRotationZ(-s * (flap + 0.1))).multiply(_m3.makeScale(s, 1, 1));
          wings.setMatrixAt(k, _m2);
        }
      });
      body.instanceMatrix.needsUpdate = true;
      wings.instanceMatrix.needsUpdate = true;
    },
  };
}

/** a flock's slow ellipse: its centre in the air and its half-axes */
interface Flock {
  centre: THREE.Vector3;
  axes: [number, number];
}
const GULLS_PER_FLOCK = 3;

/** the flocks: round the clock tower, above its spire, and over the station's train shed (when the town has one) */
function flocks(): Flock[] {
  const out: Flock[] = [{ centre: new THREE.Vector3(22, 31, -40), axes: [17, 12] }];
  const station = quarterOf("station");
  if (station) {
    const [x, z] = toWorld(station, 111, 0);
    out.push({ centre: new THREE.Vector3(x, 22, z), axes: [16, 12] });
  }
  return out;
}

function buildGulls(root: THREE.Group) {
  const fl = flocks();
  const n = fl.length * GULLS_PER_FLOCK;
  const ink = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...hexRgb(INK), THREE.LinearSRGBColorSpace), side: THREE.DoubleSide });
  const body = instanced(ellip(0.05, 0.04, 0.2, 0, 0, 0, 8), ink, n, null, false);
  const wingGeo = new THREE.PlaneGeometry(0.85, 0.2).rotateX(-Math.PI / 2).translate(0.43, 0, 0);
  const wings = instanced(wingGeo, ink, n * 2, null, false);
  root.add(body, wings);
  return {
    place(t: number) {
      for (let i = 0; i < n; i++) {
        const f = fl[Math.floor(i / GULLS_PER_FLOCK)];
        const ph = (t / (26 + i * 1.7)) * TAU + (i * TAU) / GULLS_PER_FLOCK;
        const x = f.centre.x + Math.sin(ph) * f.axes[0];
        const z = f.centre.z + Math.cos(ph) * f.axes[1];
        const y = f.centre.y + Math.sin(t * 0.37 + i) * 2.5 + (i % GULLS_PER_FLOCK) * 0.8;
        // heading along the ellipse, banked toward its middle
        const ry = Math.atan2(Math.cos(ph) * f.axes[0], -Math.sin(ph) * f.axes[1]);
        _e.set(0, ry, 0.3, "YXZ");
        _m.makeRotationFromEuler(_e).setPosition(x, y, z);
        body.setMatrixAt(i, _m);
        // a slow glide with a few beats now and then
        const beat = Math.max(0, Math.sin(t * 0.5 + i * 2.1)) ** 3;
        const flap = 0.28 + Math.sin(t * TAU * 1.6 + i) * 0.5 * beat;
        for (const s of [-1, 1]) {
          const k = i * 2 + (s + 1) / 2;
          _m2.copy(_m).multiply(_m3.makeRotationZ(-s * flap)).multiply(_m3.makeScale(s, 1, 1));
          wings.setMatrixAt(k, _m2);
        }
      }
      body.instanceMatrix.needsUpdate = true;
      wings.instanceMatrix.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------- wind and smoke, from the city's own instances

/** one of the city's strap instances that the wind moves: its place and turn (without the scale), its scale, and the hinge it swings on */
interface Swayed {
  i: number;
  tr: THREE.Matrix4;
  s: THREE.Vector3;
  hinge: THREE.Vector3;
  kind: "awning" | "flag";
  phase: number;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

/**
 * the awnings and flags among city.ts's strap instances, known by their shape (an awning is a slab 0.08 thick and
 * 1.8 deep hung at a tilt; a flag 2.5 by 1.5 by 0.05 beside its pole). A wind on them needs no change to city.ts
 */
function findSwayed(city: THREE.Group): { im: THREE.InstancedMesh; list: Swayed[] } | null {
  const im = city.getObjectByName("city:strap") as THREE.InstancedMesh | undefined;
  if (!im?.isInstancedMesh) return null;
  const list: Swayed[] = [];
  for (let i = 0; i < im.count; i++) {
    im.getMatrixAt(i, _m);
    _m.decompose(_p, _q, _s);
    let kind: Swayed["kind"] | null = null;
    let hinge: THREE.Vector3 | null = null;
    if (near(_s.y, 0.08) && near(_s.z, 1.8)) {
      kind = "awning";
      hinge = new THREE.Vector3(0, 0, -0.9);
    } else if (near(_s.x, 2.5) && near(_s.y, 1.5) && near(_s.z, 0.05)) {
      kind = "flag";
      hinge = new THREE.Vector3(-1.25, 0, 0);
    }
    if (!kind || !hinge) continue;
    list.push({ i, tr: new THREE.Matrix4().compose(_p, _q, new THREE.Vector3(1, 1, 1)), s: _s.clone(), hinge, kind, phase: (_p.x * 0.37 + _p.z * 0.53) % TAU });
  }
  return list.length ? { im, list } : null;
}

function sway(w: { im: THREE.InstancedMesh; list: Swayed[] }, t: number) {
  for (const s of w.list) {
    if (s.kind === "awning") _e.set(0.03 * Math.sin(t * 1.6 + s.phase) + 0.012 * Math.sin(t * 4.1 + s.phase * 2), 0, 0);
    else _e.set(0, 0.12 * Math.sin(t * 1.3 + s.phase) + 0.05 * Math.sin(t * 3.1 + s.phase), 0.05 * Math.sin(t * 2.7 + s.phase));
    // turned about its hinge: place and turn, then out to the hinge, the swing, back, and the scale
    _m.copy(s.tr)
      .multiply(_m2.makeTranslation(s.hinge.x, s.hinge.y, s.hinge.z))
      .multiply(_m2.makeRotationFromEuler(_e))
      .multiply(_m2.makeTranslation(-s.hinge.x, -s.hinge.y, -s.hinge.z))
      .multiply(_m2.makeScale(s.s.x, s.s.y, s.s.z));
    w.im.setMatrixAt(s.i, _m);
  }
  w.im.instanceMatrix.needsUpdate = true;
}

/** how many puffs rise from each chimney pot at once */
const PUFFS = 5;

/**
 * the chimney pots among city.ts's drum instances (a pot is the drum at 0.34 by 0.65 by 0.34), each with a few puffs
 * of smoke in one instanced billboard cloud: a puff rises and drifts with the wind, grows and fades over its life,
 * paper-toned with a little ink so it reads as smoke on the paper and darkens with it at night
 */
function buildSmoke(city: THREE.Group): THREE.Mesh | null {
  const drums = city.getObjectByName("city:drum") as THREE.InstancedMesh | undefined;
  if (!drums?.isInstancedMesh) return null;
  const origins: number[] = [];
  const seeds: number[] = [];
  for (let i = 0; i < drums.count; i++) {
    drums.getMatrixAt(i, _m);
    _m.decompose(_p, _q, _s);
    if (!(near(_s.x, 0.34) && near(_s.y, 0.65))) continue;
    for (let k = 0; k < PUFFS; k++) {
      origins.push(_p.x, _p.y + 0.33, _p.z);
      seeds.push(((i * 7 + k * 13) % 97) / 97 + k / PUFFS);
    }
  }
  if (!origins.length) return null;
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.setAttribute("position", quad.getAttribute("position"));
  geo.setAttribute("uv", quad.getAttribute("uv"));
  geo.setIndex(quad.getIndex());
  geo.setAttribute("aOrigin", new THREE.InstancedBufferAttribute(new Float32Array(origins), 3));
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(new Float32Array(seeds), 1));
  geo.instanceCount = seeds.length;
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(0.7, 0, 0.4) }, uPaper: shared.uPaper, uInk: shared.uInk, uFade: shared.uFade },
    vertexShader: /* glsl */ `
      attribute vec3 aOrigin; attribute float aSeed;
      uniform float uTime; uniform vec3 uWind;
      varying vec2 vUv; varying float vAge; varying float vDist;
      void main() {
        float life = 5.0 + 2.5 * fract(aSeed * 7.31);
        float age = fract(uTime / life + aSeed);
        vec3 c = aOrigin + vec3(0.0, 5.5 * age, 0.0) + uWind * age * age * 4.5
          + vec3(sin(uTime * 0.9 + aSeed * 20.0), 0.0, cos(uTime * 0.7 + aSeed * 13.0)) * 0.3 * age;
        float size = 0.5 + 1.9 * age;
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 wp = c + (right * position.x + up * position.y) * size;
        vUv = uv; vAge = age; vDist = distance(wp, cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uPaper; uniform vec3 uInk; uniform float uFade;
      varying vec2 vUv; varying float vAge; varying float vDist;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float soft = 1.0 - smoothstep(0.3, 1.0, d);
        float a = soft * (1.0 - vAge) * smoothstep(0.0, 0.12, vAge) * 0.6;
        a *= 1.0 - smoothstep(70.0, 150.0, vDist);
        // a shade of ink on the paper by day; on a dark paper (the night) a pale smoke, lit from the town below
        float bright = dot(uPaper, vec3(0.3333));
        vec3 col = bright > 0.5 ? mix(uPaper, uInk, 0.5) : mix(uPaper, vec3(1.0), 0.4);
        gl_FragColor = vec4(col, a * (1.0 - uFade));
      }`,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

/** the lamp globes among the city's instances, kept with their base matrices for the night's flicker */
function findGlobes(city: THREE.Group): { im: THREE.InstancedMesh; base: THREE.Matrix4[] } | null {
  const im = city.getObjectByName("city:globe") as THREE.InstancedMesh | undefined;
  if (!im?.isInstancedMesh) return null;
  const base: THREE.Matrix4[] = [];
  for (let i = 0; i < im.count; i++) {
    const m = new THREE.Matrix4();
    im.getMatrixAt(i, m);
    base.push(m);
  }
  return { im, base };
}

/** the shared night factor, when the light agent's engrave.ts carries one (0 by day); nothing flickers without it */
function nightFactor(): number {
  const u = (shared as unknown as Record<string, { value: unknown } | undefined>).uNight;
  return typeof u?.value === "number" ? u.value : 0;
}

// ---------------------------------------------------------------- the town

export function buildLife(city: THREE.Group): Life {
  const root = new THREE.Group();
  root.name = "life";
  const rand = rng(23);

  // the passers-by
  const strollers = routes().map((r, i) => {
    const fig = makeFigure({ strap: STRAPS[r.strap % STRAPS.length], seed: r.seed });
    root.add(fig.root);
    return { fig, e: extraOf(fig.root), loop: loopOf(r.pts), speed: r.speed, offset: i * 37.3 };
  });

  const cartKit = buildCarts(root);
  const pigeons = buildPigeons(root, rand);
  const gulls = buildGulls(root);
  const swayed = findSwayed(city);
  const smoke = buildSmoke(city);
  if (smoke) root.add(smoke);
  const globes = findGlobes(city);
  root.userData.stats = { strollers: strollers.length, carts: cartKit.carts.length, swayed: swayed?.list.length ?? 0, puffs: smoke ? (smoke.geometry as THREE.InstancedBufferGeometry).instanceCount : 0, globes: globes?.base.length ?? 0 };

  // the newsboy at the Exchange's steps (the keeper stands to the door's right; he takes the left, clear of a signpost there)
  const exchange = PLACES.find((p) => p.id === "exchange");
  const newsboy = makeFigure({ strap: STRAPS[0], seed: 77, kit: { hat: "cap", coat: "Cloth" } });
  const newsboyE = extraOf(newsboy.root);
  newsboy.root.scale.setScalar(0.72);
  newsboy.root.position.set((exchange?.x ?? 0) - 4.6, 0, (exchange?.z ?? -50.5) + 2.1);
  newsboy.root.rotation.y = 0.15;
  {
    // the bundle under his left arm: a stack of papers, a strap round it
    const papers = part(new THREE.BoxGeometry(0.2, 0.16, 0.3), mat("Paper"), true);
    papers.position.set(0.07, -0.16, 0.06);
    papers.rotation.z = 0.2;
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.17, 0.05), mat("Ink"));
    strap.position.copy(papers.position);
    strap.rotation.copy(papers.rotation);
    handOf(newsboy, "L", "elbow").add(papers, strap);
  }
  root.add(newsboy.root);
  let newsboyBubble: THREE.Sprite | null = null;
  let newsboyUntil = 0;
  let newsboyAgainAt = 0;

  // the sweeper on the inner pavement, just right of the spawn's line, with a broom in the right hand
  const sweeper = makeFigure({ strap: STRAPS[4], seed: 91, kit: { hat: "cap", coat: "Cloth" } });
  const sweeperE = extraOf(sweeper.root);
  const broom = new THREE.Group();
  {
    // from the hand down and forward to the ground: the shaft's line runs (0, -0.83, 0.55) from the wrist
    const shaft = part(new THREE.CylinderGeometry(0.014, 0.016, 1.4, 6), mat("Wood"), true);
    shaft.position.set(0, -0.45, 0.3);
    shaft.rotation.x = -0.585;
    const head = part(new THREE.BoxGeometry(0.34, 0.07, 0.1), mat("Ink"), true);
    head.position.set(0, -1.02, 0.68);
    broom.add(shaft, head);
    handOf(sweeper, "R").add(broom);
  }
  const sweepLoop = loopOf(arcBeat(WORLD_RADIUS + 1.4, 0.2, 0.6, 6));
  root.add(sweeper.root);

  // the dog, starting by the fountain
  const dog = makeDog({ strap: STRAPS[0], seed: 8 });
  const dogE = extraOf(dog.root);
  dog.root.position.set(3, 0, 12);
  root.add(dog.root);
  const dogState = { target: null as THREE.Vector3 | null, until: 0, sitting: true, speed: 0, ry: 0 };
  let dogSpeed = 0;

  const colliders = cartKit.carts.map((c) => c.hit);
  // the newsboy stands on the pavement: a walker steps round him as round a keeper
  colliders.push({ x: newsboy.root.position.x, z: newsboy.root.position.z, r: 0.45 });
  const walkerAt: THREE.Vector3[] = [];

  return {
    root,
    colliders,
    update(dt, t, cam, me, others) {
      const clock = Date.now() / 1000;
      // the passers-by, along their loops by the clock
      walkerAt.length = 0;
      for (const s of strollers) {
        alongLoop(s.loop, clock * s.speed + s.offset, _at);
        const r = s.fig.root;
        r.position.set(_at.x, 0, _at.z);
        walkerAt.push(r.position);
        if (!detail(s.e, cam)) continue;
        r.rotation.y = lerpAngle(r.rotation.y, _at.ry, Math.min(1, dt * 5));
        s.fig.animate(dt, s.speed / WALK_MS, t);
      }
      cartKit.place(clock, dt);
      gulls.place(t);
      if (swayed) sway(swayed, t);
      if (smoke) (smoke.material as THREE.ShaderMaterial).uniforms.uTime.value = t;

      // the birds scatter from you, the other visitors and the passers-by
      for (const o of others) walkerAt.push(o);
      pigeons.place(dt, t, walkerAt, me);

      // the newsboy: idle at his post, a line and a wave when you come near
      if (detail(newsboyE, cam)) {
        newsboy.animate(dt, 0, t);
        const d = Math.hypot(me.x - newsboy.root.position.x, me.z - newsboy.root.position.z);
        if (d < NEWSBOY_M && t > newsboyAgainAt) {
          newsboyAgainAt = t + NEWSBOY_AGAIN_S;
          newsboyUntil = t + 4.2;
          if (newsboyBubble) dropSprite(newsboyBubble);
          newsboyBubble = labelSprite(NEWSBOY_LINE, { bubble: true });
          newsboyBubble.position.y = newsboy.height + 1.1;
          newsboy.root.add(newsboyBubble);
          newsboy.gesture("wave");
        }
      }
      if (newsboyBubble && t > newsboyUntil) {
        dropSprite(newsboyBubble);
        newsboyBubble = null;
      }

      // the sweeper: a slow beat along the pavement, the broom swinging across the ground
      alongLoop(sweepLoop, clock * 0.45, _at);
      sweeper.root.position.set(_at.x, 0, _at.z);
      if (detail(sweeperE, cam)) {
        sweeper.root.rotation.y = lerpAngle(sweeper.root.rotation.y, _at.ry, Math.min(1, dt * 3));
        sweeper.animate(dt, 0.45 / WALK_MS, t);
        broom.rotation.y = Math.sin(t * 4.2) * 0.4;
        broom.rotation.x = 0.1 + Math.sin(t * 8.4) * 0.05;
      }

      // the dog: after the nearest walker for a while, then a sit; then someone else
      {
        const p = dog.root.position;
        const st = dogState;
        if (t > st.until) {
          if (st.sitting) {
            // done sitting: the nearest walker within DOG_LOOK_M, you first
            let best: THREE.Vector3 | null = Math.hypot(me.x - p.x, me.z - p.z) < DOG_LOOK_M ? me : null;
            let bestD = best ? Math.hypot(me.x - p.x, me.z - p.z) : DOG_LOOK_M;
            for (const w of walkerAt) {
              const d = Math.hypot(w.x - p.x, w.z - p.z);
              if (d < bestD) {
                best = w;
                bestD = d;
              }
            }
            if (best) {
              st.target = best;
              st.sitting = false;
              st.until = t + DOG_FOLLOW_S[0] + rand() * (DOG_FOLLOW_S[1] - DOG_FOLLOW_S[0]);
            } else st.until = t + 2;
          } else {
            st.target = null;
            st.sitting = true;
            st.until = t + DOG_SIT_S[0] + rand() * (DOG_SIT_S[1] - DOG_SIT_S[0]);
          }
        }
        let want = 0;
        if (st.target) {
          const dx = st.target.x - p.x;
          const dz = st.target.z - p.z;
          const d = Math.hypot(dx, dz);
          if (d > DOG_KEEP_M + 0.2) {
            want = Math.min(1, (d - DOG_KEEP_M) / 3);
            st.ry = lerpAngle(st.ry, Math.atan2(dx, dz), Math.min(1, dt * 6));
          }
        }
        dogSpeed += (want - dogSpeed) * Math.min(1, dt * 5);
        if (dogSpeed > 0.02) {
          const step = dogSpeed * DOG_MS * dt;
          const [nx, nz] = nearestWalkable(p.x + Math.sin(st.ry) * step, p.z + Math.cos(st.ry) * step);
          p.set(nx, 0, nz);
        }
        dog.root.rotation.y = st.ry;
        if (detail(dogE, cam)) dog.animate(dt, dogSpeed, t, st.sitting);
      }

      // the lamps at night: a faint flicker on the globes (nothing by day)
      if (globes) {
        const night = nightFactor();
        if (night > 0.01) {
          for (let i = 0; i < globes.base.length; i++) {
            const f = 1 + 0.035 * night * (Math.sin(t * 9.1 + i * 1.7) * Math.sin(t * 3.7 + i * 0.9));
            globes.im.setMatrixAt(i, _m.copy(globes.base[i]).multiply(_m2.makeScale(f, f, f)));
          }
          globes.im.instanceMatrix.needsUpdate = true;
        }
      }
    },
  };
}

/** a label sprite taken down and its texture and material freed */
function dropSprite(s: THREE.Sprite) {
  s.parent?.remove(s);
  (s.material as THREE.SpriteMaterial).map?.dispose();
  s.material.dispose();
}

