/**
 * THE EXCHANGE'S PEOPLE: a visitor, or Mr Bands himself, drawn with the plaza's kit (./engraved.ts) so every form is
 * ink lines on paper inside one contour. A jointed figure, not a stack of cylinders: thighs, shins and shoes on knees
 * and ankles, a frock coat whose skirt is cut front and back (each half hinged at the hips and swung by the leg that
 * pushes it, so the knees never come through the cloth), sleeves on elbows, hands, a head whose nose, ears and neck
 * are one form with it (so its contour draws the profile), brows and eyes, and a hat with the strap in the visitor's
 * colour. A matching bow tie at the throat.
 *
 * Cheap enough for a crowd: every geometry is built once for all figures, a visitor is 36 or 37 draws with the
 * contours (Mr Bands 46; a visitor in every piece of kit 42), the contours go on the big forms only, and animate()
 * allocates nothing.
 *
 * KIT (24 Sep): what a visitor wears is protocol.ts's Kit, bought in the town's shops: a hat (his top hat, a bowler, a
 * boater, a flat cap or a coronet with the strap as its velvet), the coat's cloth, and a cane, spectacles and a cigar,
 * which were his alone before. FigureOpts.kit dresses a new figure; setKit(kit) swaps the pieces on a standing one
 * without rebuilding it (what comes off shares its geometry and material with every figure, so there is nothing to
 * free). Without a kit, the seed dresses the visitor as before.
 *
 * The walk is sampled from eight key poses per cycle (thigh swing, knee flexion and the foot's pitch), the run from
 * eight more, and the two are blended by speed, which eases like a critically damped spring. Standing, the body is
 * lowered until the lower sole just meets the ground; moving, that is blended with a drawn bob so there is no corner
 * where the weight changes feet. Gestures play over the top; one cut short by another fades out along its own curve.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { flat, INK, mat, part } from "./engraved";
import type { HatId, Kit } from "./protocol";

export type Gesture = "wave" | "tip-hat" | "cheer" | "shrug";
export interface FigureOpts {
  strap: string;
  kind?: "visitor" | "mrbands";
  seed?: number;
  /** what a visitor wears; what is left out, the seed chooses (the hat and the coat; Mr Bands' own kit is fixed) */
  kit?: Partial<Kit>;
}
export interface Figure {
  /** feet at y = 0, facing +z; the caller moves and turns it */
  root: THREE.Group;
  /** speed 0 = still, 1 = walk (~4.4 m/s), 1.6 = run (~7.2 m/s); t = seconds, for the idle motion */
  animate(dt: number, speed: number, t: number): void;
  /** plays once over ~1.5 s, over the walk or the idle */
  gesture(g: Gesture): void;
  /** change what is worn: only the pieces that differ are swapped */
  setKit(kit: Kit): void;
  /** the top of the hat, metres (it changes with the hat) */
  readonly height: number;
  /** what is worn now */
  readonly kit: Kit;
}

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- proportions (metres, a visitor at scale 1)

const ANKLE = 0.085; // the ankle above the sole
const HEEL = 0.08; // the heel behind the ankle
const TOE = 0.175; // the toe before it
const SHIN = 0.43;
const THIGH = 0.45;
const HIP_Y = ANKLE + SHIN + THIGH;
const HIP_X = 0.095;
const WAIST = 0.06; // the spine's root above the hip joints
const SHOULDER_Y = 0.42;
const SHOULDER_X = 0.2;
const NECK_Y = 0.5;
const HEAD_Y = 0.19; // the head's centre above the base of the neck
/** the head and face are drawn at this size about the head's centre (a touch large, as an engraver draws a character) */
const HS = 1.1;
const UPPER = 0.29;
const FORE = 0.26;
const HEAD_ABS = HIP_Y + WAIST + NECK_Y + HEAD_Y; // 1.715: the top of the head is 0.154 above
const TOP_HAT = 0.45; // the crown's top above the head's centre
const BOWLER = 0.3;
const BOATER = 0.154;
const CAP = 0.124;
const CROWN = 0.17; // the coronet's points
const HAT_TOP: Record<HatId, number> = { top: TOP_HAT, bowler: BOWLER, boater: BOATER, cap: CAP, crown: CROWN };
/** the hat sits this far above where its lathe is drawn, so the brim clears the brows */
const HAT_Y = 0.02;
const REST_REACH = THIGH + SHIN + ANKLE;

// the coat's body, bottom to top, [radius, height above the waist]; drawn wider than deep
const TORSO: [number, number][] = [
  [0.001, -0.14], [0.152, -0.13], [0.162, 0], [0.17, 0.12], [0.183, 0.24], [0.19, 0.33],
  [0.19, 0.4], [0.18, 0.44], [0.15, 0.48], [0.1, 0.51], [0.06, 0.535], [0.001, 0.545],
];
const TX = 1.22;
const TZ = 0.74;

// ---------------------------------------------------------------- the gait: eight poses per cycle, left leg, 0 = left heel strike

/** thigh swing, forward positive (rad) */
const WALK_THIGH = [0.44, 0.3, 0.06, -0.22, -0.42, -0.3, 0.1, 0.4];
/** knee flexion (rad): a little at contact, most in the swing */
const WALK_KNEE = [0.06, 0.26, 0.12, 0.06, 0.24, 0.85, 1.02, 0.42];
/** the foot's pitch in the world, toe down positive: toe up at the heel strike, heel up at the push-off */
const WALK_FOOT = [-0.28, -0.02, 0, 0.04, 0.42, 0.62, 0.3, -0.06];
// the run's stance gives most at the knee in mid-stance, so the body is lowest there and highest in the flight after
const RUN_THIGH = [0.52, 0.2, -0.14, -0.44, -0.64, -0.26, 0.36, 0.72];
const RUN_KNEE = [0.25, 0.75, 0.62, 0.2, 0.72, 1.75, 1.62, 0.78];
const RUN_FOOT = [-0.16, 0.0, 0.1, 0.5, 0.78, 0.62, 0.3, 0.0];

/** a periodic Catmull-Rom through eight keys */
function cyc(k: readonly number[], ph: number): number {
  const u = (ph / TAU) * 8;
  const i = Math.floor(u);
  const f = u - i;
  const a = k[(i + 7) & 7], b = k[i & 7], c = k[(i + 1) & 7], d = k[(i + 2) & 7];
  return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
}

/** the larger of a and b with the corner rounded over a width k, so what follows it has no kink */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/** how far below the hip the lower of the heel and the toe reaches, for a leg in this pose */
function reach(th: number, kn: number, p: number): number {
  const c = Math.cos(p), s = Math.sin(p);
  return THIGH * Math.cos(th) + SHIN * Math.cos(th - kn) + smax(ANKLE * c - HEEL * s, ANKLE * c + TOE * s, 0.02);
}

/** the larger of a and b, rounded by e everywhere (a smooth |a - b|): for what swaps between two moving things */
function soft(a: number, b: number, e: number): number {
  const d = a - b;
  return 0.5 * (a + b + Math.sqrt(d * d + e * e));
}

/** a gesture's envelope over its 1.5 s: in over a third of a second, out over the last */
const envelope = (t: number) => smooth(0, 0.32, t) * (1 - smooth(1.12, 1.5, t));
const GESTURE_S = 1.5;
/** a gesture cut short by another fades out over this long, along its own envelope */
const CUT_S = 0.35;

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 0 → 1 between a and b, 1 → 0 between c and d */
const bump = (a: number, b: number, c: number, d: number, x: number) => smooth(a, b, x) * (1 - smooth(c, d, x));

// ---------------------------------------------------------------- geometry, built once for every figure

function lathe(pts: [number, number][], seg: number, sx = 1, sz = 1, phiStart = 0, phiLength = TAU): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg, phiStart, phiLength);
  g.scale(sx, 1, sz);
  return g;
}

function ellip(rx: number, ry: number, rz: number, x: number, y: number, z: number, rotX = 0, rotZ = 0, rotY = 0, seg = 10): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg - 2));
  g.scale(rx, ry, rz);
  if (rotX) g.rotateX(rotX);
  if (rotZ) g.rotateZ(rotZ);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, rotZ = 0, rotY = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotZ) g.rotateZ(rotZ);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

/** one geometry from several (one draw): all made non-indexed, and only position, normal and uv kept */
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") n.deleteAttribute(k);
    return n;
  });
  const m = mergeGeometries(clean, false);
  if (!m) throw new Error("figure: merge failed");
  return m;
}

function torsoR(y: number): number {
  if (y <= TORSO[0][1]) return TORSO[0][0];
  for (let i = 1; i < TORSO.length; i++) {
    const [r1, y1] = TORSO[i];
    if (y <= y1) {
      const [r0, y0] = TORSO[i - 1];
      return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    }
  }
  return 0.001;
}

/** a patch laid on the coat's front: a trapezoid (a V when wBot is 0) from yTop down to yBot, lifted off the cloth */
function frontPatch(yTop: number, yBot: number, wTop: number, wBot: number, lift: number, rows = 7, cols = 4): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const v = i / rows;
    const y = mix(yTop, yBot, v);
    const hw = mix(wTop, wBot, v) / 2;
    const r = torsoR(y);
    for (let j = 0; j <= cols; j++) {
      const u = j / cols;
      const x = mix(-hw, hw, u);
      const q = x / TX;
      const z = TZ * Math.sqrt(Math.max(0, r * r - q * q)) + lift;
      pos.push(x, y, z);
      uv.push(u, 1 - v);
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const tl = i * (cols + 1) + j, tr = tl + 1, bl = tl + cols + 1, br = bl + 1;
      idx.push(tl, bl, tr, tr, bl, br);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function egg(): [number, number][] {
  const pts: [number, number][] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI * i) / n;
    const y = -Math.cos(a) * 0.14;
    // full in the cheeks, round at the chin
    const k = y < 0 ? 1 - 0.1 * (y / 0.14) ** 4 : 1 + 0.02 * (y / 0.14);
    pts.push([i === 0 || i === n ? 0.001 : Math.sin(a) * 0.1 * k, y]);
  }
  return pts;
}

function buildGeos() {
  // ---- the coat
  const torso = lathe(TORSO, 16, TX, TZ);
  const skirtPts: [number, number][] = [[0.216, -0.42], [0.208, -0.3], [0.197, -0.2], [0.184, -0.1], [0.172, 0], [0.162, 0.08], [0.152, 0.13]];
  // the front half and the back half overlap a little at the sides, so the coat is closed when he stands
  const skirtF = lathe(skirtPts, 10, 1.15, 0.8, -Math.PI / 2 - 0.12, Math.PI + 0.24);
  const skirtB = lathe(skirtPts, 10, 1.15, 0.8, Math.PI / 2 - 0.12, Math.PI + 0.24);
  // ---- the legs: trousers and shoes
  const thigh = lathe([[0.001, -0.47], [0.04, -0.465], [0.058, -0.45], [0.064, -0.4], [0.072, -0.28], [0.08, -0.14], [0.086, -0.02], [0.084, 0.04], [0.06, 0.08], [0.001, 0.095]], 12);
  const shin = lathe([[0.001, -0.442], [0.061, -0.436], [0.062, -0.41], [0.053, -0.36], [0.05, -0.25], [0.056, -0.12], [0.062, -0.03], [0.058, 0.03], [0.035, 0.06], [0.001, 0.066]], 12);
  // a shoe: the upper half of an egg, longer before the ankle than behind; its open sole draws as a black welt when it lifts
  const shoeG = new THREE.SphereGeometry(1, 12, 6, 0, TAU, 0, Math.PI / 2);
  shoeG.scale(0.056, 0.074, (HEEL + TOE) / 2);
  shoeG.translate(0, -ANKLE, (TOE - HEEL) / 2);
  const shoe = shoeG;
  // ---- the arms: sleeves, and a hand with its cuff
  const upper = lathe([[0.001, -0.305], [0.045, -0.3], [0.055, -0.28], [0.058, -0.2], [0.062, -0.1], [0.066, -0.02], [0.062, 0.02], [0.046, 0.05], [0.001, 0.062]], 12);
  const fore = lathe([[0.001, -0.27], [0.057, -0.265], [0.059, -0.245], [0.052, -0.18], [0.05, -0.08], [0.054, -0.01], [0.048, 0.035], [0.001, 0.055]], 12);
  const cuff = new THREE.CylinderGeometry(0.043, 0.041, 0.036, 10);
  cuff.translate(0, -0.004, 0);
  const hand = merge([cuff, ellip(0.026, 0.056, 0.042, 0, -0.07, 0.006), ellip(0.014, 0.03, 0.014, 0, -0.05, 0.036, -0.5)]);
  // ---- the head: one form with the nose, the ears and the neck, so its contour draws the profile (the seam at the back)
  const skull = lathe(egg(), 14, 1.04, 1.1, Math.PI);
  skull.translate(0, 0, 0.004);
  // the jaw and chin carried forward of the neck, so the profile has a chin (the lathe's own normals are kept: no seam)
  const sp = skull.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < sp.count; i++) {
    const y = sp.getY(i), z = sp.getZ(i);
    sp.setZ(i, z + 0.032 * clamp((0.02 - y) / 0.13, 0, 1) * clamp(z / 0.07, 0, 1));
  }
  // a round nose: the bridge down from the brow, and a bulb at its end
  const bridge = ellip(0.016, 0.036, 0.02, 0, 0.002, 0.113, -0.37, 0, 0, 8);
  const bulb = ellip(0.024, 0.021, 0.023, 0, -0.03, 0.127, 0, 0, 0, 10);
  const neck = new THREE.CylinderGeometry(0.045, 0.05, 0.15, 10);
  neck.translate(0, -0.13, -0.024);
  const head = merge([skull, bridge, bulb, ellip(0.016, 0.034, 0.024, 0.106, -0.006, -0.004), ellip(0.016, 0.034, 0.024, -0.106, -0.006, -0.004), neck]);
  const eyes = [ellip(0.012, 0.014, 0.008, 0.037, 0.018, 0.104), ellip(0.012, 0.014, 0.008, -0.037, 0.018, 0.104)];
  const brows = [box(0.042, 0.009, 0.012, 0.039, 0.05, 0.1, -0.14), box(0.042, 0.009, 0.012, -0.039, 0.05, 0.1, 0.14)];
  const mouth = box(0.036, 0.007, 0.01, 0, -0.07, 0.1);
  const moustache = [ellip(0.036, 0.012, 0.015, 0.03, -0.046, 0.106, 0, -0.3), ellip(0.036, 0.012, 0.015, -0.03, -0.046, 0.106, 0, 0.3)];
  const faceInk = merge([...eyes, ...brows, mouth]);
  const faceInkMo = merge([...eyes, ...brows, ...moustache]);
  const faceInkBrows = merge([...brows, box(0.04, 0.007, 0.01, 0, -0.078, 0.098)]);
  // ---- the hats: a lathe from under the brim, round its curled edge, up the crown and over the top
  const topHat = lathe([[0.112, 0.052], [0.178, 0.05], [0.196, 0.06], [0.195, 0.073], [0.175, 0.069], [0.132, 0.066], [0.12, 0.073],
    [0.116, 0.2], [0.119, 0.36], [0.125, TOP_HAT - 0.014], [0.123, TOP_HAT - 0.002], [0.001, TOP_HAT]], 20, 1, 1.08);
  const topStrap = new THREE.CylinderGeometry(0.1195, 0.1225, 0.12, 20, 1, true);
  topStrap.scale(1, 1, 1.08);
  topStrap.translate(0, 0.14, 0);
  const bowler = lathe([[0.112, 0.05], [0.166, 0.05], [0.182, 0.06], [0.18, 0.071], [0.16, 0.067], [0.126, 0.07], [0.126, 0.1],
    [0.124, 0.165], [0.113, 0.222], [0.09, 0.264], [0.05, 0.29], [0.001, BOWLER]], 20, 1, 1.08);
  const bowlerStrap = new THREE.CylinderGeometry(0.1285, 0.1295, 0.042, 20, 1, true);
  bowlerStrap.scale(1, 1, 1.08);
  bowlerStrap.translate(0, 0.093, 0);
  // a boater: a low flat crown on a wide flat brim, the band in the strap colour
  const boater = lathe([[0.112, 0.05], [0.21, 0.048], [0.216, 0.06], [0.132, 0.064], [0.128, BOATER - 0.008], [0.12, BOATER - 0.001], [0.001, BOATER]], 20, 1, 1.08);
  const boaterStrap = new THREE.CylinderGeometry(0.131, 0.133, 0.042, 20, 1, true);
  boaterStrap.scale(1, 1, 1.08);
  boaterStrap.translate(0, 0.088, 0);
  // a flat cap: a low soft crown, wider than the head and deeper than it is wide, falling to a short peak at the front;
  // the strap its band
  const capCrown = lathe([[0.118, 0.05], [0.152, 0.058], [0.162, 0.082], [0.146, 0.104], [0.1, 0.118], [0.001, CAP]], 16, 1, 1.15);
  const cap = merge([capCrown, ellip(0.105, 0.007, 0.07, 0, 0.055, 0.165, -0.16, 0, 0, 10)]);
  const capStrap = new THREE.CylinderGeometry(0.128, 0.13, 0.022, 16, 1, true);
  capStrap.scale(1, 1, 1.15);
  capStrap.translate(0, 0.061, 0);
  // a coronet: a brass circlet on a rim, eight points, and the strap's colour as the velvet within
  const circlet = new THREE.CylinderGeometry(0.12, 0.124, 0.07, 16, 1, true);
  circlet.translate(0, 0.086, 0);
  const rim = new THREE.TorusGeometry(0.123, 0.01, 6, 20);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 0.053, 0);
  const points: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const p = new THREE.ConeGeometry(0.018, 0.05, 4);
    p.translate(Math.sin(a) * 0.118, CROWN - 0.025, Math.cos(a) * 0.118);
    points.push(p);
  }
  const crown = merge([circlet, rim, ...points]);
  crown.scale(1, 1, 1.08);
  const velvet = new THREE.SphereGeometry(0.114, 16, 8, 0, TAU, 0, Math.PI / 2);
  velvet.scale(1, 0.6, 1.08);
  velvet.translate(0, 0.075, 0);
  // reading spectacles: two round rims, a bridge and the arms back to the ears; no lens, so the eyes show through
  const rimOf = (sx: number) => new THREE.TorusGeometry(0.03, 0.004, 6, 16).translate(sx * 0.04, 0.02, 0.112);
  const spectacles = merge([rimOf(1), rimOf(-1), box(0.02, 0.005, 0.005, 0, 0.026, 0.114), box(0.005, 0.005, 0.1, 0.098, 0.03, 0.06), box(0.005, 0.005, 0.1, -0.098, 0.03, 0.06)]);
  // ---- the front: collar, shirt, waistcoat, bow tie
  const collar = new THREE.CylinderGeometry(0.064, 0.074, 0.065, 14, 1, true);
  collar.scale(1, 1, 0.92);
  collar.translate(0, 0.525, 0);
  const shirtNarrow = merge([collar, frontPatch(0.51, 0.3, 0.13, 0, 0.009)]);
  const shirtWide = merge([collar, frontPatch(0.51, 0.2, 0.17, 0, 0.006)]);
  const waistcoat = frontPatch(0.5, -0.02, 0.21, 0.07, 0.004, 9, 4);
  const lobe = (sx: number) => {
    const c = new THREE.ConeGeometry(0.03, 0.056, 4);
    c.rotateY(Math.PI / 4);
    c.rotateZ((sx * Math.PI) / 2);
    c.scale(1, 1, 0.5);
    c.translate(sx * 0.03, 0, 0);
    return c;
  };
  const bow = merge([lobe(1), lobe(-1), box(0.022, 0.024, 0.02, 0, 0, 0.004)]);
  bow.translate(0, 0.505, 0.1);
  // ---- his things
  const lens = (sx: number) => box(0.072, 0.036, 0.012, sx * 0.043, 0.02, 0.112, 0, sx * 0.22);
  const glasses = merge([lens(1), lens(-1), box(0.03, 0.01, 0.01, 0, 0.03, 0.118), box(0.2, 0.012, 0.012, 0, 0.04, 0.108),
    box(0.008, 0.012, 0.11, 0.1, 0.035, 0.05), box(0.008, 0.012, 0.11, -0.1, 0.035, 0.05)]);
  const bar = (sx: number) => [ellip(0.058, 0.018, 0.021, sx * 0.05, -0.05, 0.098, 0, sx * -0.26), ellip(0.014, 0.028, 0.014, sx * 0.106, -0.036, 0.066, 0, sx * 0.5)];
  const handlebar = merge([...bar(1), ...bar(-1)]);
  const cigar = new THREE.CylinderGeometry(0.014, 0.012, 0.15, 8);
  const ember = new THREE.CylinderGeometry(0.0145, 0.0145, 0.02, 8);
  const cane = new THREE.CylinderGeometry(0.017, 0.013, 1, 8);
  const knob = new THREE.SphereGeometry(0.036, 10, 8);
  // everything drawn about the head's centre is drawn a size up
  for (const g of [head, faceInk, faceInkMo, faceInkBrows, glasses, spectacles, handlebar]) g.scale(HS, HS, HS);
  return {
    torso, skirtF, skirtB, thigh, shin, shoe, upper, fore, hand, head, faceInk, faceInkMo, faceInkBrows,
    topHat, topStrap, bowler, bowlerStrap, boater, boaterStrap, cap, capStrap, crown, velvet,
    shirtNarrow, shirtWide, waistcoat, bow, glasses, spectacles, handlebar, cigar, ember, cane, knob,
  };
}

let GEO: ReturnType<typeof buildGeos> | null = null;
const geos = () => (GEO ??= buildGeos());

const flats = new Map<string, THREE.MeshBasicMaterial>();
function flatC(hex: string): THREE.MeshBasicMaterial {
  let m = flats.get(hex);
  if (!m) flats.set(hex, (m = flat(hex)));
  return m;
}

/** a small form with no contour and no shadow of its own */
function bit(geo: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.receiveShadow = true;
  return m;
}

/** a deterministic little generator, so a seed always dresses the same visitor */
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

// scratch for the cane, shared: animate() allocates nothing
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qI = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// arm channels: shoulder pitch, twist, abduction; elbow bend, elbow sweep; hand twist
const SX = 0, SY = 1, SZ = 2, EX = 3, EZ = 4, HY = 5;

class Person implements Figure {
  root = new THREE.Group();

  private body = new THREE.Group();
  private hips = new THREE.Group();
  private spine = new THREE.Group();
  private chest = new THREE.Group();
  private skirtF: THREE.Mesh;
  private skirtB: THREE.Mesh;
  private thigh: THREE.Group[] = [];
  private knee: THREE.Group[] = [];
  private ankle: THREE.Group[] = [];
  private shoulder: THREE.Group[] = [];
  private elbow: THREE.Group[] = [];
  private wrist: THREE.Group[] = [];
  private neck = new THREE.Group();
  private head = new THREE.Group();
  private hat = new THREE.Group();
  private cane: THREE.Group | null = null;
  private ember: THREE.Mesh | null = null;
  private cigar: THREE.Mesh | null = null;
  private glasses: THREE.Mesh | null = null;
  /** the coat's pieces (the body, the skirt's halves, the sleeves): their cloth is swapped with the kit */
  private coatParts: THREE.Mesh[] = [];
  private strap: THREE.Material;
  private tall: number;
  kit!: Kit;
  height = 0;

  private mr: boolean;
  private chestSX: number;
  private chestSZ: number;
  private abduct: number;
  private hatTilt: number;
  private seedPh: number;
  private sp = 0;
  private spV = 0;
  private phase: number;
  /** the gesture playing, and the one it cut short (fading out along its own envelope) */
  private g: Gesture | null = null;
  private gt = 0;
  private pg: Gesture | null = null;
  private pgt = 0;
  private pgCut = 0;
  private first = true;
  private arm = [new Float32Array(6), new Float32Array(6)];
  /** hat lift, hat tilt, head nod, head tilt, shoulders up, hop */
  private ch = new Float32Array(6);
  private thL = new Float32Array(2);

  constructor(o: FigureOpts) {
    const G = geos();
    const mr = (this.mr = o.kind === "mrbands");
    const rand = rng(mr ? 7 : (o.seed ?? 1));
    // ---- the dressing, from the seed
    const coatName = mr ? "FigInk" : (["Ink", "Cloth", "FigInk"] as const)[Math.floor(rand() * 3)];
    const trouserName = mr ? "Cloth" : coatName === "Cloth" ? (rand() < 0.5 ? "Ink" : "FigInk") : rand() < 0.7 ? "Cloth" : "Wood";
    const bowlerHat = !mr && rand() < 0.38;
    const tall = mr ? 1.2 : 0.95 + rand() * 0.1;
    const moustache = !mr && rand() < 0.5;
    const vest = mr || rand() < 0.55;
    const vestName = coatName === "Cloth" ? "FigInk" : rand() < 0.5 ? "Wood" : "Brass";
    const girth = mr ? 1 : 0.96 + rand() * 0.08;
    this.hatTilt = mr ? -0.07 : -0.1 + rand() * 0.12;
    this.seedPh = rand() * 100;
    this.phase = rand() * TAU;
    this.chestSX = mr ? 1.1 : girth;
    this.chestSZ = mr ? 1.26 : girth;
    this.abduct = mr ? 0.2 : 0.09;

    const coat = mat(coatName);
    const trousers = mat(trouserName);
    const skin = mat("Ivory");
    const strap = flatC(o.strap);
    const ink = flatC(INK);
    this.strap = strap;
    this.tall = tall;

    this.body.name = "body";
    this.hips.name = "hips";
    this.spine.name = "spine";
    this.chest.name = "chest";
    this.neck.name = "neck";
    this.head.name = "head";
    this.hat.name = "hat";
    this.root.add(this.body);
    this.body.scale.setScalar(tall);
    this.body.add(this.hips);
    this.hips.position.y = HIP_Y;

    // the legs: 0 is the left (+x), 1 the right
    for (let s = 0; s < 2; s++) {
      const sx = s === 0 ? 1 : -1;
      const th = new THREE.Group();
      th.name = s === 0 ? "thighL" : "thighR";
      th.position.x = sx * HIP_X;
      th.rotation.order = "YXZ";
      th.add(part(G.thigh, trousers, true));
      const kn = new THREE.Group();
      kn.name = s === 0 ? "kneeL" : "kneeR";
      kn.position.y = -THIGH;
      kn.add(part(G.shin, trousers, true));
      const an = new THREE.Group();
      an.name = s === 0 ? "ankleL" : "ankleR";
      an.position.y = -SHIN;
      const shoe = part(G.shoe, mat("Shoe"), true);
      shoe.castShadow = false; // (on the ground: its shadow is under it)
      an.add(shoe);
      kn.add(an);
      th.add(kn);
      this.hips.add(th);
      this.thigh.push(th);
      this.knee.push(kn);
      this.ankle.push(an);
    }

    // the coat's skirt, hinged at the hips: the front half swings with the leading knee, the back with the trailing one
    this.skirtF = part(G.skirtF, coat, true);
    this.skirtB = part(G.skirtB, coat, true);
    this.skirtF.scale.set(this.chestSX, 1, mr ? 1.2 : girth);
    this.skirtB.scale.copy(this.skirtF.scale);
    this.hips.add(this.skirtF, this.skirtB);
    this.coatParts.push(this.skirtF, this.skirtB);

    // the upper body
    this.spine.position.y = WAIST;
    this.hips.add(this.spine);
    this.spine.add(this.chest);
    this.chest.scale.set(this.chestSX, 1, this.chestSZ);
    const torso = part(G.torso, coat, true);
    this.chest.add(torso);
    this.coatParts.push(torso);
    if (vest) this.chest.add(bit(G.waistcoat, mat(mr ? "Wood" : vestName)));
    this.chest.add(bit(vest ? G.shirtNarrow : G.shirtWide, mat("Paper")));
    this.chest.add(bit(G.bow, strap));

    for (let s = 0; s < 2; s++) {
      const sx = s === 0 ? 1 : -1;
      const sh = new THREE.Group();
      sh.name = s === 0 ? "shoulderL" : "shoulderR";
      sh.position.set(sx * SHOULDER_X * (mr ? 1.1 : girth), SHOULDER_Y, 0);
      sh.rotation.order = "XZY";
      const upperArm = part(G.upper, coat, true);
      sh.add(upperArm);
      const el = new THREE.Group();
      el.name = s === 0 ? "elbowL" : "elbowR";
      el.position.y = -UPPER;
      const foreArm = part(G.fore, coat, true);
      el.add(foreArm);
      this.coatParts.push(upperArm, foreArm);
      const wr = new THREE.Group();
      wr.name = s === 0 ? "wristL" : "wristR";
      wr.position.y = -FORE;
      wr.add(bit(G.hand, skin));
      el.add(wr);
      sh.add(el);
      this.spine.add(sh);
      this.shoulder.push(sh);
      this.elbow.push(el);
      this.wrist.push(wr);
    }

    // the head
    this.neck.position.y = NECK_Y;
    this.spine.add(this.neck);
    this.head.position.y = HEAD_Y;
    // his face is the big round one of the portrait
    if (mr) this.head.scale.set(1.26, 1.14, 1.2);
    // (his hat keeps about its own size on the bigger head)
    if (mr) this.hat.scale.set(0.87, 0.84, 0.88);
    this.neck.add(this.head);
    this.head.add(part(G.head, skin, true));
    this.head.add(bit(mr ? G.faceInkBrows : moustache ? G.faceInkMo : G.faceInk, ink));
    this.head.add(this.hat);
    this.hat.rotation.x = this.hatTilt;
    // the white moustache is his alone
    if (mr) this.head.add(part(G.handlebar, mat("Paper"), true));

    // his own kit: the top hat, dark glasses, a cigar and the cane; a visitor's is the kit given, or the seed's
    this.first = true;
    this.dress(
      mr
        ? { hat: "top", coat: "FigInk", cane: true, glasses: true, cigar: true }
        : { hat: bowlerHat ? "bowler" : "top", coat: coatName, cane: false, glasses: false, cigar: false, ...o.kit },
    );
  }

  setKit(kit: Kit) {
    if (this.mr) return;
    this.dress(kit);
  }

  /** put the kit on: only what differs from what is worn is swapped; the parts that come off are shared, nothing to free */
  private dress(kit: Kit) {
    const G = geos();
    const mr = this.mr;
    const was = this.kit as Kit | undefined;
    this.kit = kit;
    if (!was || was.hat !== kit.hat) {
      this.hat.clear();
      // the hat's form, and its band (a coronet's velvet) in the strap's colour
      const [shape, band] =
        kit.hat === "bowler" ? [G.bowler, G.bowlerStrap]
        : kit.hat === "boater" ? [G.boater, G.boaterStrap]
        : kit.hat === "cap" ? [G.cap, G.capStrap]
        : kit.hat === "crown" ? [G.crown, G.velvet]
        : [G.topHat, G.topStrap];
      this.hat.add(part(shape, mat(kit.hat === "crown" ? "Brass" : "Hat"), true));
      this.hat.add(bit(band, this.strap));
      this.height = (HEAD_ABS + (HAT_Y + HAT_TOP[kit.hat] * (mr ? 0.84 : 1)) * (mr ? 1.14 : 1)) * this.tall;
    }
    if (!was || was.coat !== kit.coat) {
      const cloth = mat(kit.coat);
      for (const p of this.coatParts) p.material = cloth;
    }
    if (kit.glasses !== (this.glasses !== null)) {
      if (this.glasses) this.head.remove(this.glasses);
      // his are dark; a visitor's are reading spectacles from the Stationer
      this.glasses = kit.glasses ? bit(mr ? G.glasses : G.spectacles, flatC(INK)) : null;
      if (this.glasses) this.head.add(this.glasses);
    }
    if (kit.cigar !== (this.cigar !== null)) {
      if (this.cigar) this.head.remove(this.cigar);
      this.cigar = null;
      this.ember = null;
      if (kit.cigar) {
        const cig = mr ? part(G.cigar, mat("Wood"), true) : bit(G.cigar, mat("Wood"));
        const dir = new THREE.Vector3(-0.3, -0.28, 1).normalize();
        cig.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        cig.position.set(-0.026 * HS, -0.074 * HS, 0.098 * HS).addScaledVector(dir, 0.075);
        this.ember = bit(G.ember, flatC("#ff7a1a"));
        this.ember.position.y = 0.083;
        cig.add(this.ember);
        this.head.add(cig);
        this.cigar = cig;
      }
    }
    if (kit.cane !== (this.cane !== null)) {
      if (this.cane) this.wrist[1].remove(this.cane);
      this.cane = null;
      if (kit.cane) {
        const cane = new THREE.Group();
        cane.position.set(0, -0.068, 0.022);
        const shaft = mr ? part(G.cane, mat("Ink"), true) : bit(G.cane, mat("Ink"));
        cane.add(shaft);
        const knob = bit(G.knob, mat("Brass"));
        knob.position.y = 0.03;
        cane.add(knob);
        this.wrist[1].add(cane);
        this.cane = cane;
        // the shaft reaches the ground from where the hand rests: measured in the standing pose, whatever the figure
        // is doing now (its motion is put back afterwards, so a walk or a gesture goes on where it was)
        const sp = this.sp, spV = this.spV, phase = this.phase, first = this.first;
        this.first = true;
        this.animate(0, 0, 0);
        this.root.updateMatrixWorld(true);
        cane.getWorldPosition(_v);
        const len = (_v.y - this.root.getWorldPosition(_v2).y) / this.tall;
        shaft.scale.y = len;
        shaft.position.y = -len / 2;
        this.sp = sp;
        this.spV = spV;
        this.phase = phase;
        this.first = first;
      }
    }
  }

  gesture(g: Gesture) {
    if (this.g && this.gt < GESTURE_S) {
      this.pg = this.g;
      this.pgt = this.gt;
      this.pgCut = 0;
    }
    this.g = g;
    this.gt = 0;
  }

  /** bend one arm's channels toward a gesture's pose for that arm, by k */
  private pose(a: Float32Array, g: Gesture, gt: number, k: number, s: number) {
    const sd = s === 0 ? 1 : -1;
    // the waving side: the right hand holds a cane, so whoever carries one waves and tips their hat with the left
    const side = this.cane ? 0 : 1;
    if (g === "wave" && s === side) {
      const osc = Math.sin(gt * TAU * 2.3) * smooth(0.22, 0.45, gt);
      // (a raised arm: a positive pitch carries it forward of the body)
      a[SX] = mix(a[SX], 0.22, k);
      a[SY] = mix(a[SY], 0, k);
      a[SZ] = mix(a[SZ], sd * 2.2, k);
      a[EX] = mix(a[EX], -0.3, k);
      a[EZ] = mix(a[EZ], sd * (0.72 + 0.42 * osc), k);
      a[HY] = mix(a[HY], sd * 1.4, k);
    } else if (g === "tip-hat" && s === side) {
      a[SX] = mix(a[SX], -2.02, k);
      a[SY] = mix(a[SY], 0, k);
      a[SZ] = mix(a[SZ], -sd * 0.16, k);
      a[EX] = mix(a[EX], -1.72, k);
      a[EZ] = mix(a[EZ], 0, k);
      a[HY] = mix(a[HY], -sd * 0.5, k);
    } else if (g === "cheer") {
      const pump = Math.sin(gt * TAU * 2.4 + s * 0.6) * smooth(0.25, 0.45, gt);
      a[SX] = mix(a[SX], 0.3, k);
      a[SY] = mix(a[SY], 0, k);
      a[SZ] = mix(a[SZ], sd * (2.72 + 0.14 * pump), k);
      a[EX] = mix(a[EX], -0.3 - 0.15 * pump, k);
      a[EZ] = mix(a[EZ], sd * 0.08, k);
      a[HY] = mix(a[HY], 0, k);
    } else if (g === "shrug") {
      a[SX] = mix(a[SX], -0.22, k);
      a[SY] = mix(a[SY], sd * 0.8, k);
      a[SZ] = mix(a[SZ], sd * 0.34, k);
      a[EX] = mix(a[EX], -1.4, k);
      a[EZ] = mix(a[EZ], 0, k);
      a[HY] = mix(a[HY], sd * 1.3, k);
    }
  }

  /** add a gesture's hat, head, shoulder and hop channels: e is its envelope, fade what is left of it if it was cut */
  private channels(g: Gesture, gt: number, e: number, fade: number) {
    const c = this.ch;
    if (g === "tip-hat") {
      const lift = bump(0.36, 0.56, 0.92, 1.14, gt) * fade;
      c[0] += 0.075 * lift;
      c[1] += 0.32 * lift;
      c[2] += 0.16 * bump(0.42, 0.66, 0.9, 1.18, gt) * fade;
    } else if (g === "cheer") {
      const hop = Math.sin(gt * Math.PI * 2.4);
      c[2] -= 0.16 * e;
      c[5] += 0.045 * hop * hop * e;
    } else if (g === "shrug") {
      c[3] += 0.16 * e;
      c[4] += 0.05 * e;
      c[2] -= 0.05 * e;
    } else if (g === "wave") {
      c[3] -= 0.08 * e * (this.cane ? -1 : 1);
    }
  }

  animate(dt: number, speed: number, t: number) {
    dt = clamp(dt, 0, 0.1);
    // the speed eases like a critically damped spring, so a start or a stop has no corner in it
    if (this.first) {
      this.sp = speed;
      this.spV = 0;
    } else {
      const om = 2 / 0.22;
      const x = om * dt;
      const ex = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      const change = this.sp - speed;
      const temp = (this.spV + om * change) * dt;
      this.spV = (this.spV - om * temp) * ex;
      this.sp = speed + (change + temp) * ex;
    }
    const sp = Math.max(0, this.sp);
    const w = smooth(0, 0.6, sp); // how much of the gait
    const run = clamp((sp - 1) / 0.6, 0, 1);
    const still = 1 - w;
    const freq = sp < 1 ? 1.15 + 0.65 * sp : 1.8 + 0.6 * run; // strides a second
    if (w > 0.001) this.phase = (this.phase + dt * freq * TAU) % TAU;
    const ph = this.phase;
    const mr = this.mr;

    // ---- the idle underneath: breath, a slow shift of weight, a look round
    const tt = t + this.seedPh;
    const breath = Math.sin((tt * TAU) / 4.3);
    const shift = Math.sin((tt * TAU) / 7.7) * still;
    const look = (Math.sin((tt * TAU) / 13.1) * 0.8 + Math.sin((tt * TAU) / 5.3) * 0.2) * still;

    // ---- the legs
    const thL = this.thL;
    let rL = 0;
    let rR = 0;
    for (let s = 0; s < 2; s++) {
      const p = s === 0 ? ph : (ph + Math.PI) % TAU;
      let th = mix(cyc(WALK_THIGH, p), cyc(RUN_THIGH, p), run) * w;
      let kn = mix(cyc(WALK_KNEE, p), cyc(RUN_KNEE, p), run) * w;
      let ft = mix(cyc(WALK_FOOT, p), cyc(RUN_FOOT, p), run) * w;
      // standing: the free leg eases its knee as the weight leaves it
      const free = s === 0 ? Math.max(0, -shift) : Math.max(0, shift);
      th += free * 0.06;
      kn += free * 0.16 + 0.03 * still;
      ft += 0;
      thL[s] = th;
      this.thigh[s].rotation.x = -th;
      this.knee[s].rotation.x = kn;
      this.ankle[s].rotation.x = ft + th - kn;
      if (s === 0) rL = reach(th, kn, ft);
      else rR = reach(th, kn, ft);
    }
    // the lower foot carries him (the corner rounded where the weight passes from one to the other)
    const lowest = soft(rL, rR, 0.035 * w + 0.002) - 0.008 * w;
    // a run leaves the ground between strides
    const lift = 0.5 + 0.5 * Math.sin(2 * ph - 3.93);
    const flight = run * 0.035 * lift * lift * lift;

    // ---- the hips and the spine
    const sway = Math.sin(ph) * w;
    const hipX = 0.022 * shift + 0.014 * sway;
    const hipRoll = 0.035 * shift + 0.03 * sway;
    const hipYaw = -0.13 * Math.cos(ph) * w * (1 + 0.4 * run);
    this.hips.position.x = hipX;
    this.hips.rotation.set(0, hipYaw, hipRoll);
    this.hips.position.y = HIP_Y;
    for (let s = 0; s < 2; s++) {
      const sx = s === 0 ? 1 : -1;
      // keep the feet under the hips as they shift, the soles level, and the toes a little out
      this.thigh[s].rotation.z = -hipRoll - hipX / HIP_Y + sx * (0.03 * still + 0.01);
      this.thigh[s].rotation.y = sx * (0.14 * still + 0.05);
      this.ankle[s].rotation.z = -this.thigh[s].rotation.z - hipRoll;
    }
    // the skirt: pushed by the leg in front, dragged by the leg behind
    const eLeg = 0.01 + 0.25 * w;
    const eRest = 0.01 + 0.12 * w;
    const fwd = soft(soft(thL[0], thL[1], eLeg), 0, eRest);
    const back = soft(soft(-thL[0], -thL[1], eLeg), 0, eRest);
    this.skirtF.rotation.x = -fwd * 0.86 - 0.02 * run;
    this.skirtB.rotation.x = back * 0.8 + 0.1 * run;

    const lean = mix(0.035, 0.17, run) * w;
    const spineYaw = 0.21 * Math.cos(ph) * w * (1 + 0.3 * run);
    this.spine.rotation.set(lean + 0.012 * breath * still, spineYaw, -hipRoll * 1.25);
    this.chest.scale.set(this.chestSX * (1 + 0.012 * breath), 1 + 0.006 * breath, this.chestSZ * (1 + 0.018 * breath));

    // ---- the gesture, and the one it cut short
    let e = 0;
    let pe = 0;
    let pfade = 0;
    const g = this.g;
    if (g) {
      this.gt += dt;
      if (this.gt >= GESTURE_S) this.g = null;
      else e = envelope(this.gt);
    }
    const pg = this.pg;
    if (pg) {
      this.pgt += dt;
      this.pgCut += dt;
      if (this.pgt >= GESTURE_S || this.pgCut >= CUT_S) this.pg = null;
      else {
        pfade = 1 - smooth(0, CUT_S, this.pgCut);
        pe = envelope(this.pgt) * pfade;
      }
    }

    // ---- the arms: swung against the legs, elbows easing as they come forward
    const armAmp = mix(0.42, 0.72, run) * w;
    for (let s = 0; s < 2; s++) {
      const sd = s === 0 ? 1 : -1;
      const a = this.arm[s];
      const caned = this.cane !== null && s === 1;
      const swing = -sd * Math.cos(ph - 0.2) * armAmp * (caned ? 0.45 : 1) - 0.12 * run * w;
      a[SX] = -swing - 0.02 * breath * still;
      a[SY] = 0;
      a[SZ] = sd * (this.abduct + 0.1 * run + 0.012 * breath * still);
      // a run carries the forearms high, folded most as the arm comes forward
      a[EX] = -mix(mix(0.14, 0.22 + 0.4 * Math.max(0, swing), w), 1.4 + 0.32 * swing, run);
      a[EZ] = 0;
      a[HY] = sd * 0.12;
      if (caned) {
        // resting on the cane, a little ahead and out
        a[SX] = mix(-0.3, a[SX] - 0.15, w);
        a[SZ] = sd * mix(0.24, this.abduct, w);
        a[EX] = mix(-0.5, a[EX] - 0.2, w);
      }
      if (pg && pe > 0) this.pose(a, pg, this.pgt, pe, s);
      if (g && e > 0) this.pose(a, g, this.gt, e, s);
      this.shoulder[s].rotation.set(a[SX], a[SY], a[SZ]);
      this.elbow[s].rotation.set(a[EX], 0, a[EZ]);
      this.wrist[s].rotation.set(0, a[HY], 0);
    }
    const ch = this.ch;
    ch.fill(0);
    if (pg) this.channels(pg, this.pgt, pe, pfade);
    if (g) this.channels(g, this.gt, e, 1);
    for (let s = 0; s < 2; s++) this.shoulder[s].position.y = SHOULDER_Y + 0.004 * breath * still + ch[4];

    // ---- the head: steadier than the body, and looking about when he stands
    this.neck.rotation.set(-lean * 0.7 + ch[2] - 0.01 * breath * still, -(hipYaw + spineYaw) * 0.85 + look * 0.32, -(hipRoll - hipRoll * 1.25) * 0.8 + ch[3]);
    this.hat.position.y = HAT_Y + ch[0];
    this.hat.rotation.x = this.hatTilt + ch[1];

    // ---- down onto the lower foot. Moving, that is blended with a drawn bob (a walk's lowest at the heel strike and
    // highest as the legs pass, fitted to the key poses; a run's lowest in mid-stance and highest in the flight), since
    // the lower foot alone puts a corner in the motion each time the weight changes feet
    const planted = lowest - REST_REACH + flight;
    const walkBob = -0.028 - 0.027 * Math.cos(2 * ph);
    const runBob = -0.06 + 0.035 * Math.cos(2 * (ph - 2.75));
    this.body.position.y = mix(planted, mix(walkBob, runBob, run), mix(0.5, 0.85, run) * w) + ch[5];

    if (this.ember) {
      const glow = 0.85 + 0.15 * Math.sin(t * 2.1) + 0.08 * Math.sin(t * 7.3);
      this.ember.scale.set(glow, 1, glow);
    }
    if (this.cane) {
      // the cane hangs plumb from his hand whatever the arm does, unless both arms go up and it goes up with them
      _q.setFromEuler(this.hips.rotation);
      _q.multiply(_q2.setFromEuler(this.spine.rotation));
      _q.multiply(_q2.setFromEuler(this.shoulder[1].rotation));
      _q.multiply(_q2.setFromEuler(this.elbow[1].rotation));
      _q.multiply(_q2.setFromEuler(this.wrist[1].rotation));
      _q.invert();
      const follow = (g === "cheer" ? e : 0) + (pg === "cheer" ? pe : 0);
      this.cane.quaternion.slerpQuaternions(_q, _qI, follow);
    }
    this.first = false;
  }
}

export function makeFigure(o: FigureOpts): Figure {
  return new Person(o);
}

/** how many draws a figure costs (each mesh is one, its contour another) */
export function drawCount(f: Figure): number {
  let n = 0;
  f.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n++;
  });
  return n;
}
