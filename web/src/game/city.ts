/**
 * THE SQUARE ROUND THE EXCHANGE (bands.finance Play): the city the plaza stands in, drawn with the same engraved kit as
 * everything inside the rope (./engraved.ts: ink lines on paper, one contour round every form).
 *
 * A ring of façades faces the plaza across a boulevard, fronts at r = 51 (the Exchange set back at 55 behind its steps),
 * broken by four diagonal streets that run out into the fog. North, behind the Pools Board, the Bands Exchange: eight
 * columns, the name on its frieze, a pediment and a dome, so the board stands framed by it. Beside it the clock tower
 * (real time), round it banks, counting houses and townhouses under mansards, and to the south a crescent over an
 * arcade. Inside the rope: a fountain at the centre (a stack of banded notes over a basin, water drawn as moving ink
 * lines) and a ring of trees in planters near the rim.
 *
 * Economy: every repeated piece (walls, windows, cornices, columns, balusters, leaves) is one InstancedMesh per shape and
 * material, and every one-off shape (roofs, domes, the fountain) is merged per material, so the whole city is a few
 * dozen draw calls. Outlines here take the fog, so the far streets fade the way an engraver lightens a distance.
 *
 * To mount: scene.add(city.root), push city.colliders into the world's colliders (the fountain, r 4 at the centre, and
 * the planters, r 1.45, small enough that the camera's clear-view check passes them), and call update(t, now) each
 * frame (the water's time and the clock's hands, nothing more). Everything outside the rope needs no collider. The
 * basin itself stays inside r 3.52 so the passers-by's loop, which passes 4 m from the centre, clears its lip.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { engraveMaterial, outlineRes, shared, type EngraveSpec } from "../stage/engrave";
import { CAPS, flat, INK, mat, PAPER, SERIF } from "./engraved";

export interface Circle {
  x: number;
  z: number;
  r: number;
}
export interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
export interface City {
  root: THREE.Group;
  colliders: Circle[];
  walls: Box[];
  update(t: number, now: Date): void;
}

const ORANGE = "#ff7a1a";
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- materials

/** the city's own stones and slates, on top of the house SPECS (Paper, Wood, Brass, Ink, Bill, Strap…) */
const CITY_SPECS: Record<string, EngraveSpec> = {
  /** a second stone a shade down, so neighbours part */
  Ashlar: { tone: 0.9 },
  /** brick: a light hatch in the sun, dark in the shade, under paper-white stone trim */
  Brick: { tone: 0.76, pitch: 0.95 },
  Slate: { tone: 0.5, shine: 0.2 },
  Lead: { tone: 0.64, shine: 0.55, gloss: 16 },
  /** window glass and deep openings: cross-hatched nearly to black */
  Void: { tone: 0.24 },
  /** foliage in a mid tone, so each clump hatches from paper to shade like an engraved tree */
  Leaf: { tone: 0.68, pitch: 0.9 },
  /** the carriageway: a light diagonal hatch that parts it from the pavements */
  Road: { tone: 0.8 },
};
const cityMats = new Map<string, THREE.Material>();

/**
 * The camera may come to rest in a crown (it trails you by up to 18 m). A clump whose centre is near the eye dissolves
 * whole, clump and contour together, in a stipple from 6.5 m to gone at 3.5 m, so a tree never fills the screen.
 */
const CUT_VERT = /* glsl */ `
  {
    #ifdef USE_INSTANCING
      vec3 cutC = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #else
      vec3 cutC = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #endif
    vCut = smoothstep(3.5, 6.5, length(cutC - cameraPosition));
  }
`;
const CUT_FRAG = /* glsl */ `
  if (vCut < 0.999) {
    float n = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
    if (n > vCut) discard;
  }
`;
function leafMaterial(): THREE.Material {
  let m = cityMats.get("LeafCut") as THREE.MeshLambertMaterial | undefined;
  if (!m) {
    const made = engraveMaterial(CITY_SPECS.Leaf);
    const base = made.onBeforeCompile;
    made.onBeforeCompile = (shader, r) => {
      base.call(made, shader, r);
      shader.vertexShader = shader.vertexShader.replace("void main() {", `varying float vCut;\nvoid main() {\n${CUT_VERT}`);
      shader.fragmentShader = shader.fragmentShader.replace("void main() {", `varying float vCut;\nvoid main() {\n${CUT_FRAG}`);
    };
    made.customProgramCacheKey = () => "engrave:0:nearcut";
    cityMats.set("LeafCut", made);
    m = made;
  }
  return m;
}
function M(name: string): THREE.Material {
  if (!CITY_SPECS[name]) return mat(name);
  let m = cityMats.get(name);
  if (!m) {
    m = engraveMaterial(CITY_SPECS[name]);
    cityMats.set(name, m);
  }
  return m;
}

/** the contour (src/stage/engrave.ts outlineMaterial), but taking the fog: far façades are drawn in fainter lines */
function fogOutline(widthPx: number, nearCut = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: nearCut ? { NEAR_CUT: "" } : {},
    side: THREE.BackSide,
    fog: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uInk: shared.uInk,
      uPaper: shared.uPaper,
      uFade: shared.uFade,
      uWidth: { value: widthPx },
      uRes: outlineRes,
    },
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform float uWidth; uniform vec2 uRes;
      varying float vCut;
      void main() {
        #ifdef NEAR_CUT
        ${CUT_VERT}
        #endif
        vec4 p = vec4(position, 1.0); vec3 n = normal;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p; n = mat3(instanceMatrix) * n;
        #endif
        vec4 mvPosition = modelViewMatrix * p;
        vec4 clip = projectionMatrix * mvPosition;
        vec3 nv = normalize(normalMatrix * n);
        vec2 dir = normalize((projectionMatrix * vec4(nv, 0.0)).xy + vec2(1e-6));
        clip.xy += dir * (uWidth * 2.0 / uRes) * clip.w;
        gl_Position = clip;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <fog_pars_fragment>
      uniform vec3 uInk; uniform vec3 uPaper; uniform float uFade;
      varying float vCut;
      void main() {
        #ifdef NEAR_CUT
        ${CUT_FRAG}
        #endif
        gl_FragColor = vec4(mix(uInk, uPaper, uFade), 1.0);
        #include <fog_fragment>
      }`,
  });
}
const BOLD = 1.3;
const FINE = 0.9;
const outlines = new Map<string, THREE.ShaderMaterial>();
function outline(w: number, nearCut = false): THREE.ShaderMaterial {
  const key = `${w}:${nearCut}`;
  let m = outlines.get(key);
  if (!m) {
    m = fogOutline(w, nearCut);
    outlines.set(key, m);
  }
  return m;
}

// ---------------------------------------------------------------- shapes

function prismGeo(): THREE.BufferGeometry {
  // a pediment: base 1 wide at y = 0, apex 0.2 up (a 22° pitch), 1 deep; scale x and y alike to keep the pitch true
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0);
  s.lineTo(0.5, 0);
  s.lineTo(0, 0.2);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  return g;
}

function archGeo(): THREE.BufferGeometry {
  // one bay of an arcade, 3.2 wide and 5.2 high, the arch 2.3 wide springing at 3.3; its face at z = 0, 0.5 deep
  const s = new THREE.Shape();
  s.moveTo(-1.6, 0);
  s.lineTo(-1.15, 0);
  s.lineTo(-1.15, 3.3);
  s.absarc(0, 3.3, 1.15, Math.PI, 0, true);
  s.lineTo(1.15, 0);
  s.lineTo(1.6, 0);
  s.lineTo(1.6, 5.2);
  s.lineTo(-1.6, 5.2);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.5, bevelEnabled: false, curveSegments: 12 });
  g.translate(0, 0, -0.5);
  return g;
}

function balusterGeo(): THREE.BufferGeometry {
  const pts = [
    [0.13, 0],
    [0.07, 0.12],
    [0.15, 0.42],
    [0.1, 0.66],
    [0.06, 0.8],
    [0.14, 0.92],
    [0.14, 1],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 5);
}

function planterGeo(): THREE.BufferGeometry {
  const pts = [
    [1.2, 0],
    [1.3, 0.06],
    [1.3, 0.14],
    [1.17, 0.2],
    [1.22, 0.5],
    [1.38, 0.56],
    [1.38, 0.7],
    [1.12, 0.71],
    [1.1, 0.6],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 20);
}

/** a box narrowing upward: a mansard, a hipped roof or (top 0) a pyramid; bottom centred on the origin, front at +z */
function frustum(w0: number, d0: number, w1: number, d1: number, h: number): THREE.BufferGeometry {
  const b = [
    [-w0 / 2, 0, d0 / 2],
    [w0 / 2, 0, d0 / 2],
    [w0 / 2, 0, -d0 / 2],
    [-w0 / 2, 0, -d0 / 2],
  ];
  const t = [
    [-w1 / 2, h, d1 / 2],
    [w1 / 2, h, d1 / 2],
    [w1 / 2, h, -d1 / 2],
    [-w1 / 2, h, -d1 / 2],
  ];
  const v: number[] = [];
  const quad = (a: number[], bb: number[], c: number[], d: number[]) => v.push(...a, ...bb, ...c, ...a, ...c, ...d);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    if (w1 < 0.01) v.push(...b[i], ...b[j], ...t[0]);
    else quad(b[i], b[j], t[j], t[i]);
  }
  if (w1 >= 0.01) quad(t[0], t[1], t[2], t[3]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/** a unit box without its back (-z) face: every box in the city stands against a wall or is only ever seen from the plaza side */
function slabGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const back = g.groups[5];
  const idx = g.index!.array as ArrayLike<number>;
  const keep: number[] = [];
  for (let i = 0; i < idx.length; i++) if (i < back.start || i >= back.start + back.count) keep.push(idx[i]);
  g.setIndex(keep);
  g.clearGroups();
  return g;
}

const hemi = (r: number, seg = 24) => new THREE.SphereGeometry(r, seg, Math.max(6, seg / 2 - 2), 0, TAU, 0, Math.PI / 2);

// ---------------------------------------------------------------- printed things: signs, the frieze, the clock face

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;

/** a canvas texture that redraws itself once the house faces have loaded (the first paint may be in Georgia) */
function paintedTexture(w: number, h: number, draw: Draw): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const paint = () => {
    g.clearRect(0, 0, w, h);
    draw(g, w, h);
  };
  paint();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.anisotropy = 8;
  document.fonts?.ready.then(() => {
    paint();
    t.needsUpdate = true;
  });
  return t;
}

/** letters set wide, centred on cx */
function spaced(g: CanvasRenderingContext2D, text: string, cx: number, y: number, track: number) {
  const widths = [...text].map((ch) => g.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + track * (text.length - 1);
  let x = cx - total / 2;
  [...text].forEach((ch, i) => {
    g.fillText(ch, x, y);
    x += widths[i] + track;
  });
}

function fitFont(g: CanvasRenderingContext2D, text: string, font: (px: number) => string, maxW: number, px: number, track: number) {
  let size = px;
  g.font = font(size);
  const w = () => [...text].reduce((a, ch) => a + g.measureText(ch).width, 0) + track * (text.length - 1);
  while (w() > maxW && size > 10) {
    size -= 2;
    g.font = font(size);
  }
}

/** all the small signs in one texture, so every name in the city is one draw call */
class Atlas {
  private entries = new Map<string, { x: number; y: number; w: number; h: number; draw: Draw }>();
  private x = 0;
  private y = 0;
  private rowH = 0;
  texture: THREE.CanvasTexture | null = null;
  constructor(private size = 1024) {}
  add(name: string, w: number, h: number, draw: Draw) {
    if (this.x + w > this.size) {
      this.x = 0;
      this.y += this.rowH + 6;
      this.rowH = 0;
    }
    this.entries.set(name, { x: this.x, y: this.y, w, h, draw });
    this.x += w + 6;
    this.rowH = Math.max(this.rowH, h);
  }
  build(): THREE.CanvasTexture {
    this.texture = paintedTexture(this.size, this.size, (g) => {
      for (const e of this.entries.values()) {
        g.save();
        g.translate(e.x, e.y);
        g.beginPath();
        g.rect(0, 0, e.w, e.h);
        g.clip();
        e.draw(g, e.w, e.h);
        g.restore();
      }
    });
    return this.texture;
  }
  /** a quad the sign's shape, w metres wide, its uv on the atlas */
  quad(name: string, w: number): THREE.BufferGeometry {
    const e = this.entries.get(name);
    if (!e) throw new Error(`no sign ${name}`);
    const h = (w * e.h) / e.w;
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const u0 = e.x / this.size;
    const u1 = (e.x + e.w) / this.size;
    const v0 = 1 - (e.y + e.h) / this.size;
    const v1 = 1 - e.y / this.size;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    return g;
  }
}

/** a name carved in the stone: ink capitals on paper, a hairline above and below */
function carved(text: string): Draw {
  return (g, w, h) => {
    g.fillStyle = PAPER;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(8, 5);
    g.lineTo(w - 8, 5);
    g.moveTo(8, h - 5);
    g.lineTo(w - 8, h - 5);
    g.stroke();
    fitFont(g, text, (px) => `700 ${px}px ${CAPS}`, w - 60, h * 0.78, h * 0.22);
    g.textBaseline = "middle";
    g.fillStyle = "rgba(22,18,15,0.35)";
    spaced(g, text, w / 2 + 2, h / 2 + 4, h * 0.22);
    g.fillStyle = INK;
    spaced(g, text, w / 2, h / 2 + 2, h * 0.22);
  };
}

/** a shop's fascia: paper capitals on an ink board, a paper rule inside */
function fascia(text: string): Draw {
  return (g, w, h) => {
    g.fillStyle = INK;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = PAPER;
    g.lineWidth = 2;
    g.strokeRect(6, 6, w - 12, h - 12);
    fitFont(g, text, (px) => `700 ${px}px ${CAPS}`, w - 40, h * 0.62, h * 0.12);
    g.textBaseline = "middle";
    g.fillStyle = PAPER;
    spaced(g, text, w / 2, h / 2 + 2, h * 0.12);
  };
}

/** the Exchange's banner, as in the house plate "Tradition": black cloth, an orange bow tie, a swallowtail hem */
const bannerDraw: Draw = (g, w, h) => {
  g.fillStyle = INK;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(w, 0);
  g.lineTo(w, h);
  g.lineTo(w / 2, h - w * 0.45);
  g.lineTo(0, h);
  g.closePath();
  g.fill();
  g.strokeStyle = PAPER;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(8, 8);
  g.lineTo(w - 8, 8);
  g.lineTo(w - 8, h - 14);
  g.lineTo(w / 2, h - w * 0.45 - 8);
  g.lineTo(8, h - 14);
  g.closePath();
  g.stroke();
  const cy = h * 0.42;
  const bw = w * 0.36;
  g.fillStyle = ORANGE;
  g.beginPath();
  g.moveTo(w / 2, cy);
  g.lineTo(w / 2 - bw, cy - bw * 0.62);
  g.lineTo(w / 2 - bw, cy + bw * 0.62);
  g.closePath();
  g.moveTo(w / 2, cy);
  g.lineTo(w / 2 + bw, cy - bw * 0.62);
  g.lineTo(w / 2 + bw, cy + bw * 0.62);
  g.closePath();
  g.fill();
  g.fillRect(w / 2 - bw * 0.2, cy - bw * 0.26, bw * 0.4, bw * 0.52);
};

/** the tympanum's emblem: his top hat with the orange band, in a wreath */
const emblemDraw: Draw = (g, w, h) => {
  const cx = w / 2;
  const cy = h / 2;
  const r = w * 0.46;
  g.fillStyle = PAPER;
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 5;
  g.stroke();
  g.lineWidth = 2;
  g.beginPath();
  g.arc(cx, cy, r * 0.86, 0, TAU);
  g.stroke();
  // the wreath: leaves up either side
  g.fillStyle = INK;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      const a = Math.PI / 2 + side * (0.35 + i * 0.27);
      const lx = cx + Math.cos(a) * r * 0.74;
      const ly = cy + Math.sin(a) * r * 0.74;
      g.save();
      g.translate(lx, ly);
      g.rotate(a + (side > 0 ? 0.6 : -0.6));
      g.beginPath();
      g.ellipse(0, 0, r * 0.1, r * 0.04, 0, 0, TAU);
      g.fill();
      g.restore();
    }
  }
  // the hat
  const hw = r * 0.62;
  g.fillStyle = INK;
  g.beginPath();
  g.ellipse(cx, cy + r * 0.3, hw, r * 0.1, 0, 0, TAU);
  g.fill();
  g.fillRect(cx - hw * 0.62, cy - r * 0.42, hw * 1.24, r * 0.72);
  g.fillStyle = ORANGE;
  g.fillRect(cx - hw * 0.62, cy + r * 0.04, hw * 1.24, r * 0.16);
};

function friezeTexture(): THREE.CanvasTexture {
  return paintedTexture(2048, 128, (g, w, h) => {
    g.fillStyle = PAPER;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = INK;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, 6);
    g.lineTo(w, 6);
    g.moveTo(0, h - 6);
    g.lineTo(w, h - 6);
    g.stroke();
    // rosettes at the ends
    for (const x of [90, w - 90]) {
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, h / 2, 30, 0, TAU);
      g.stroke();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        g.beginPath();
        g.ellipse(x + Math.cos(a) * 15, h / 2 + Math.sin(a) * 15, 11, 5, a, 0, TAU);
        g.stroke();
      }
    }
    g.textBaseline = "middle";
    g.font = `700 92px ${CAPS}`;
    g.fillStyle = "rgba(22,18,15,0.3)";
    spaced(g, "BANDS EXCHANGE", w / 2 + 3, h / 2 + 8, 34);
    g.fillStyle = INK;
    spaced(g, "BANDS EXCHANGE", w / 2, h / 2 + 5, 34);
  });
}

function clockTexture(): THREE.CanvasTexture {
  return paintedTexture(1024, 1024, (g, w) => {
    const c = w / 2;
    g.fillStyle = PAPER;
    g.fillRect(0, 0, w, w);
    g.strokeStyle = INK;
    g.fillStyle = INK;
    g.lineWidth = 10;
    g.beginPath();
    g.arc(c, c, c - 14, 0, TAU);
    g.stroke();
    g.lineWidth = 3;
    g.beginPath();
    g.arc(c, c, c - 40, 0, TAU);
    g.stroke();
    g.beginPath();
    g.arc(c, c, c - 88, 0, TAU);
    g.stroke();
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * TAU;
      const big = i % 5 === 0;
      g.lineWidth = big ? 9 : 3;
      g.beginPath();
      g.moveTo(c + Math.sin(a) * (c - 42), c - Math.cos(a) * (c - 42));
      g.lineTo(c + Math.sin(a) * (c - (big ? 86 : 64)), c - Math.cos(a) * (c - (big ? 86 : 64)));
      g.stroke();
    }
    const numerals = ["XII", "I", "II", "III", "IIII", "V", "VI", "VII", "VIII", "IX", "X", "XI"];
    g.font = `600 96px ${SERIF}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    numerals.forEach((n, i) => {
      const a = (i / 12) * TAU;
      g.save();
      g.translate(c + Math.sin(a) * (c - 160), c - Math.cos(a) * (c - 160));
      g.rotate(a);
      g.fillText(n, 0, 0);
      g.restore();
    });
    g.font = `600 44px ${CAPS}`;
    spaced(g, "TEMPUS", c, c - 190, 10);
    g.font = `500 30px ${CAPS}`;
    spaced(g, "MARKETS NEVER SLEEP", c, c + 200, 6);
  });
}

// ---------------------------------------------------------------- the kit: instanced pieces and merged one-offs

interface Piece {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  line: number;
  shadow?: boolean;
  /** dissolves near the camera (leaves) */
  nearCut?: boolean;
}
interface MergedDef {
  mat: THREE.Material;
  line: number;
  shadow?: boolean;
  attrs: string[];
  order?: number;
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, "YXZ");

class Kit {
  frame = new THREE.Matrix4();
  private stack: THREE.Matrix4[] = [];
  private lists = new Map<string, THREE.Matrix4[]>();
  private geos = new Map<string, THREE.BufferGeometry[]>();
  constructor(
    private pieces: Record<string, Piece>,
    private mdefs: Record<string, MergedDef>,
  ) {}

  at(m: THREE.Matrix4) {
    this.frame = m.clone();
    this.stack.length = 0;
  }
  push(m: THREE.Matrix4) {
    this.stack.push(this.frame);
    this.frame = this.frame.clone().multiply(m);
  }
  pop() {
    this.frame = this.stack.pop() ?? new THREE.Matrix4();
  }
  local(x: number, y: number, z: number, ry = 0, sx = 1, sy = 1, sz = 1, rz = 0, rx = 0): THREE.Matrix4 {
    _e.set(rx, ry, rz, "YXZ");
    _q.setFromEuler(_e);
    return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  }
  /** a piece, centred on (x, y, z) of the current frame, scaled and turned */
  put(kind: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, rz = 0, rx = 0) {
    if (!this.pieces[kind]) throw new Error(`no piece ${kind}`);
    let l = this.lists.get(kind);
    if (!l) this.lists.set(kind, (l = []));
    l.push(this.frame.clone().multiply(this.local(x, y, z, ry, sx, sy, sz, rz, rx)));
  }
  /** a box by its extents in the current frame */
  slab(kind: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    this.put(kind, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0);
  }
  /** a one-off shape, merged with the rest of its material */
  geo(key: string, g: THREE.BufferGeometry, x = 0, y = 0, z = 0, ry = 0, sx = 1, sy = 1, sz = 1, rz = 0, rx = 0) {
    const def = this.mdefs[key];
    if (!def) throw new Error(`no merged ${key}`);
    const h = g.index ? g.toNonIndexed() : g.clone();
    g.dispose();
    for (const name of Object.keys(h.attributes)) if (!def.attrs.includes(name)) h.deleteAttribute(name);
    h.applyMatrix4(this.frame.clone().multiply(this.local(x, y, z, ry, sx, sy, sz, rz, rx)));
    let l = this.geos.get(key);
    if (!l) this.geos.set(key, (l = []));
    l.push(h);
  }
  /** where a point of the current frame lands in the world */
  world(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.frame);
  }

  build(root: THREE.Group): { instances: number; pieces: number } {
    let instances = 0;
    for (const [kind, list] of this.lists) {
      const def = this.pieces[kind];
      const im = new THREE.InstancedMesh(def.geo, def.mat, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = !!def.shadow;
      im.receiveShadow = true;
      im.name = `city:${kind}`;
      root.add(im);
      if (def.line > 0) {
        const ol = new THREE.InstancedMesh(def.geo, outline(def.line, def.nearCut), list.length);
        ol.instanceMatrix = im.instanceMatrix;
        ol.computeBoundingSphere();
        ol.name = `city:${kind}:line`;
        root.add(ol);
      }
      instances += list.length;
    }
    for (const [key, list] of this.geos) {
      const def = this.mdefs[key];
      const g = mergeGeometries(list, false);
      if (!g) throw new Error(`could not merge ${key}`);
      list.forEach((x) => x.dispose());
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, def.mat);
      mesh.castShadow = !!def.shadow;
      mesh.receiveShadow = def.attrs.includes("normal");
      mesh.name = `city:${key}`;
      if (def.order) mesh.renderOrder = def.order;
      root.add(mesh);
      if (def.line > 0) {
        const ol = new THREE.Mesh(g, outline(def.line));
        ol.name = `city:${key}:line`;
        root.add(ol);
      }
    }
    return { instances, pieces: this.lists.size + this.geos.size };
  }
}

// ---------------------------------------------------------------- façade parts (a façade's frame: its face on z = 0, facing +z, x across, y up)

type Body = "stone" | "ashlar" | "brick";

interface WinOpt {
  /** a stone architrave round the opening */
  frame?: boolean;
  /** what crowns it: a pediment, a flat hood, or nothing */
  ped?: "tri" | "flat" | "none";
  key?: boolean;
  bars?: boolean;
  balc?: boolean;
}

/** set while the far streets are drawn: their windows go without architraves and glazing bars (fog takes them anyway) */
let plain = false;

function win(k: Kit, x: number, y: number, w: number, h: number, o: WinOpt = {}) {
  const framed = o.frame !== false && !plain;
  if (framed) k.slab("trim", x - w / 2 - 0.2, x + w / 2 + 0.2, y - 0.2, y + h + 0.2, 0, 0.1);
  k.slab("void", x - w / 2, x + w / 2, y, y + h, 0.02, 0.13);
  if (o.bars !== false && !plain) {
    k.slab("bar", x - 0.035, x + 0.035, y, y + h, 0.13, 0.15);
    k.slab("bar", x - w / 2, x + w / 2, y + h * 0.64 - 0.035, y + h * 0.64 + 0.035, 0.13, 0.15);
  }
  k.slab("trim", x - w / 2 - 0.32, x + w / 2 + 0.32, y - 0.36, y - 0.2, 0, 0.3);
  if (o.balc) {
    k.slab("trim", x - w / 2 - 0.45, x + w / 2 + 0.45, y - 0.42, y - 0.28, 0, 0.75);
    k.slab("rail", x - w / 2 - 0.4, x + w / 2 + 0.4, y + 0.62, y + 0.68, 0.68, 0.74);
    for (let i = 0; i <= 6; i++) {
      const bx = x - w / 2 - 0.4 + ((w + 0.8) * i) / 6;
      k.slab("rail", bx - 0.02, bx + 0.02, y - 0.28, y + 0.62, 0.69, 0.73);
    }
  }
  if (o.key) k.slab("trim", x - 0.2, x + 0.2, y + h - 0.12, y + h + 0.42, 0, 0.2);
  const ped = o.ped ?? "flat";
  if (ped !== "none") k.slab("trim", x - w / 2 - 0.38, x + w / 2 + 0.38, y + h + 0.2, y + h + 0.4, 0, 0.3);
  if (ped === "tri") k.put("ped", x, y + h + 0.4, 0.15, w + 0.76, w + 0.76, 0.3);
}

function door(k: Kit, x: number, w: number, h: number) {
  k.slab("trim", x - w / 2 - 0.3, x + w / 2 + 0.3, 0, h + 0.95, 0, 0.12);
  k.slab("wood", x - w / 2, x + w / 2, 0.25, h, 0.06, 0.16);
  k.slab("bar", x - 0.03, x + 0.03, 0.25, h, 0.16, 0.18);
  k.slab("void", x - w / 2, x + w / 2, h + 0.12, h + 0.72, 0.06, 0.16);
  k.slab("trim", x - w / 2 - 0.45, x + w / 2 + 0.45, h + 0.95, h + 1.12, 0, 0.32);
  k.slab("trim", x - w / 2 - 0.4, x + w / 2 + 0.4, 0, 0.25, 0, 0.6);
}

function shopfront(k: Kit, atlas: Atlas, x0: number, x1: number, sign?: string, awning = false) {
  k.slab("trim", x0, x1, 0, 0.75, 0, 0.18);
  k.slab("void", x0 + 0.1, x1 - 0.1, 0.75, 3.15, 0, 0.1);
  const n = Math.max(2, Math.round((x1 - x0) / 1.3));
  for (let i = 1; i < n; i++) {
    const xm = x0 + ((x1 - x0) * i) / n;
    k.slab("bar", xm - 0.04, xm + 0.04, 0.75, 3.15, 0.1, 0.13);
  }
  k.slab("bar", x0 + 0.1, x1 - 0.1, 2.5, 2.57, 0.1, 0.13);
  k.slab("trim", x0 - 0.28, x0 + 0.06, 0, 3.95, 0, 0.26);
  k.slab("trim", x1 - 0.06, x1 + 0.28, 0, 3.95, 0, 0.26);
  k.slab("ink", x0 - 0.2, x1 + 0.2, 3.22, 3.92, 0, 0.26);
  k.slab("trim", x0 - 0.36, x1 + 0.36, 3.92, 4.08, 0, 0.4);
  if (sign) k.geo("signs", atlas.quad(sign, Math.min(x1 - x0, 5.2)), (x0 + x1) / 2, 3.57, 0.27);
  if (awning) k.put("strap", (x0 + x1) / 2, 2.98, 0.95, x1 - x0 + 0.2, 0.08, 1.8, 0, 0, 0.42);
}

function cornice(k: Kit, W: number, y: number, proj: number, dentils = false) {
  const hw = W / 2 - 0.01;
  k.slab("trim", -hw, hw, y - 0.45, y - 0.2, -0.3, proj * 0.45);
  k.slab("stone", -hw, hw, y - 0.2, y + 0.15, -0.6, proj);
  if (dentils) dentilRow(k, -hw, hw, y - 0.45, y - 0.2, proj * 0.45);
}

/** a dentil course: paper teeth on a dark bed, drawn without a contour each so a far cornice stays a clean ruled band */
function dentilRow(k: Kit, x0: number, x1: number, y0: number, y1: number, z: number) {
  k.slab("groove", x0, x1, y0 + 0.02, y1 - 0.02, z - 0.1, z + 0.12);
  for (let x = x0 + 0.2; x < x1 - 0.1; x += 0.42) k.slab("tooth", x - 0.1, x + 0.1, y0, y1, z, z + 0.2);
}

function balustrade(k: Kit, xa: number, xb: number, y: number, z: number, piers: number[]) {
  k.slab("stone", xa, xb, y, y + 0.22, z - 0.3, z + 0.3);
  k.slab("stone", xa, xb, y + 0.9, y + 1.08, z - 0.32, z + 0.32);
  for (const px of piers) if (px > xa - 0.1 && px < xb + 0.1) k.slab("stone", Math.max(xa, px - 0.3), Math.min(xb, px + 0.3), y, y + 1.14, z - 0.34, z + 0.34);
  for (let x = xa + 0.22; x < xb - 0.1; x += 0.36) {
    if (piers.some((px) => Math.abs(px - x) < 0.48)) continue;
    k.put("baluster", x, y + 0.22, z, 1, 0.68, 1);
  }
}

function mansard(k: Kit, W: number, D: number, y: number, xs: number[]) {
  k.geo("slate", frustum(W - 0.1, D - 0.1, W - 2.9, D - 2.9, 3.3), 0, y, -D / 2);
  for (const x of xs) {
    k.slab("stone", x - 0.72, x + 0.72, y + 0.35, y + 2.35, -2.0, -0.12);
    k.slab("void", x - 0.42, x + 0.42, y + 0.6, y + 2.0, -0.2, -0.05);
    k.slab("bar", x - 0.03, x + 0.03, y + 0.6, y + 2.0, -0.05, -0.03);
    k.put("ped", x, y + 2.35, -1.05, 1.75, 1.75, 1.95);
  }
}

function chimney(k: Kit, x: number, z: number, y0: number, y1: number) {
  k.slab("brick", x - 0.45, x + 0.45, y0, y1, z - 0.8, z + 0.8);
  k.slab("trim", x - 0.55, x + 0.55, y1, y1 + 0.18, z - 0.9, z + 0.9);
  if (!plain) for (const dz of [-0.4, 0.4]) k.put("drum", x, y1 + 0.5, z + dz, 0.34, 0.65, 0.34);
}

function quoins(k: Kit, W: number, y0: number, y1: number, sides: number[] = [-1, 1]) {
  let i = 0;
  for (let y = y0; y + 0.5 < y1; y += 0.62, i++) {
    const long = i % 2 ? 0.95 : 0.6;
    for (const s of sides) {
      const xa = s * (W / 2 - 0.01);
      k.slab("trim", Math.min(xa, xa - s * long), Math.max(xa, xa - s * long), y, y + 0.54, 0, 0.08);
    }
  }
}

function bays(W: number, c: number): number[] {
  return Array.from({ length: c }, (_, i) => -W / 2 + (W / c) * (i + 0.5));
}

/** a dome on a drum, pilasters and windows round it, a lantern on top */
function dome(k: Kit, x: number, y: number, z: number, r: number) {
  const dh = r * 0.55;
  k.geo("stonework", new THREE.CylinderGeometry(r + 0.25, r + 0.25, 0.5, 28), x, y + 0.25, z);
  k.geo("stonework", new THREE.CylinderGeometry(r, r, dh, 28, 1, true), x, y + 0.5 + dh / 2, z);
  k.geo("stonework", new THREE.CylinderGeometry(r + 0.4, r + 0.3, 0.4, 28), x, y + 0.5 + dh + 0.2, z);
  const n = 12;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    k.put("trim", x + Math.sin(a) * (r + 0.1), y + 0.5 + dh / 2, z + Math.cos(a) * (r + 0.1), 0.42, dh, 0.22, a);
    const b = a + Math.PI / n;
    k.put("void", x + Math.sin(b) * (r + 0.03), y + 0.5 + dh * 0.52, z + Math.cos(b) * (r + 0.03), 0.34 * r, dh * 0.5, 0.1, b);
  }
  const base = y + 0.5 + dh + 0.4;
  k.geo("lead", hemi(r + 0.1, 28), x, base, z);
  const top = base + (r + 0.1) * 0.985;
  k.geo("stonework", new THREE.CylinderGeometry(r * 0.17, r * 0.19, r * 0.36, 12), x, top + r * 0.16, z);
  k.geo("lead", hemi(r * 0.21, 12), x, top + r * 0.34, z);
  k.geo("brass", new THREE.CylinderGeometry(0.04, 0.07, r * 0.28, 6), x, top + r * 0.5 + r * 0.14, z);
  k.geo("brass", new THREE.SphereGeometry(r * 0.045, 8, 6), x, top + r * 0.8, z);
}

// ---------------------------------------------------------------- the buildings

interface Ctx {
  k: Kit;
  atlas: Atlas;
  extras: THREE.Group;
  hands: { hour: THREE.Object3D; minute: THREE.Object3D }[];
}

interface HouseOpts {
  H: number;
  body: Body;
  mansard?: boolean;
  shop?: string;
  awning?: boolean;
  rich?: boolean;
}

/** a townhouse: a door and a shop or two windows below, two or three floors, a cornice, a mansard with dormers, chimneys */
function townhouse(c: Ctx, W: number, D: number, o: HouseOpts) {
  const { k } = c;
  const { H } = o;
  const hw = W / 2 - 0.01;
  k.slab(o.body, -W / 2, W / 2, 0, H, -D, 0);
  k.slab("trim", -hw, hw, 0, 0.55, -0.3, 0.1);
  const gf = 4.3;
  const n = Math.max(2, Math.round(W / 3.1));
  const xs = bays(W, n);
  const pitch = W / n;
  // the ground floor: a door in the last bay; a shop, or windows, in the rest
  door(k, xs[n - 1], 1.3, 2.7);
  if (o.shop) shopfront(k, c.atlas, -W / 2 + 0.45, xs[n - 1] - pitch / 2 - 0.1, o.shop, o.awning);
  else for (const x of xs.slice(0, -1)) win(k, x, 0.95, 1.25, 2.5, { frame: false, key: true });
  k.slab("trim", -hw, hw, gf - 0.12, gf + 0.18, -0.3, 0.22);
  const floors = Math.max(1, Math.floor((H - gf - 1.1) / 3.5));
  for (let f = 0; f < floors; f++) {
    const y = gf + 0.9 + f * 3.5;
    const first = f === 0;
    xs.forEach((x, i) =>
      win(k, x, y, first ? 1.2 : 1.1, first ? 2.4 : 2.0, {
        ped: first ? (o.rich && i % 2 === 0 ? "tri" : "flat") : "none",
        balc: first && !!o.rich,
      }),
    );
  }
  cornice(k, W, H, 0.6, !!o.rich);
  if (o.mansard) {
    mansard(k, W, D, H + 0.15, xs.length > 2 ? xs.filter((_, i) => i % 2 === 0 || n <= 3) : xs);
    chimney(k, W / 2 - 0.6, -D * 0.45, H + 1, H + 4.9);
    chimney(k, -W / 2 + 0.6, -D * 0.45, H + 1, H + 4.6);
  } else {
    k.slab(o.body, -W / 2, W / 2, H + 0.15, H + 1.0, -D, -0.2);
    k.slab("trim", -hw, hw, H + 1.0, H + 1.15, -D, 0);
    chimney(k, 0, -D * 0.5, H + 1, H + 3.6);
  }
}

interface BankOpts {
  H: number;
  body: Body;
  sign?: string;
  dome?: number;
  portico?: boolean;
  arches?: boolean;
  flag?: boolean;
}

/** a bank: a rusticated (or arcaded) ground floor, a giant order of pilasters, pedimented windows, a cornice and a balustrade */
function bank(c: Ctx, W: number, D: number, o: BankOpts) {
  const { k } = c;
  const { H } = o;
  const hw = W / 2 - 0.01;
  k.slab(o.body, -W / 2, W / 2, 0, H, -D, 0);
  const gf = 5.2;
  let n = Math.max(3, Math.round(W / 3.9));
  if (n % 2 === 0) n += 1;
  const pitch = W / n;
  const xs = bays(W, n);
  const mid = (n - 1) / 2;
  k.slab("trim", -hw, hw, 0, 0.7, -0.3, 0.14);
  if (!o.arches) for (let y = 1.3; y < gf - 0.35; y += 0.62) k.slab("groove", -hw, hw, y - 0.035, y + 0.035, -0.05, 0.03);
  xs.forEach((x, i) => {
    const centre = i === mid;
    if (o.arches) {
      const s = Math.min(1.15, (pitch - 0.3) / 3.2);
      k.put("arch", x, 0, 0.5, s, 1, 1);
      k.slab("void", x - 1.15 * s, x + 1.15 * s, 0, 4.45, 0.02, 0.1);
      k.slab("bar", x - 1.15 * s, x + 1.15 * s, 3.3, 3.37, 0.1, 0.13);
      if (!centre) k.slab("bar", x - 0.04, x + 0.04, 0, 3.3, 0.1, 0.13);
      k.slab("trim", x - 0.22, x + 0.22, 4.1, 4.75, 0.45, 0.62);
      if (centre && !o.portico) k.slab("wood", x - 1.0, x + 1.0, 0, 3.25, 0.1, 0.16);
    } else if (centre && !o.portico) door(k, x, 2.2, 3.4);
    else if (!(o.portico && Math.abs(i - mid) <= 1)) win(k, x, 1.3, 1.5, 2.6, { frame: false, key: true });
  });
  k.slab("trim", -hw, hw, gf - 0.2, gf + 0.25, -0.3, 0.32);
  const top = H - 2.3;
  for (let i = 0; i <= n; i++) {
    const x = -W / 2 + pitch * i;
    const x0 = Math.max(-hw, x - 0.42);
    const x1 = Math.min(hw, x + 0.42);
    k.slab(o.body === "brick" ? "stone" : o.body, x0, x1, gf + 0.25, top - 0.4, 0, 0.26);
    k.slab("trim", Math.max(-hw, x0 - 0.14), Math.min(hw, x1 + 0.14), top - 0.4, top, 0, 0.38);
    k.slab("trim", Math.max(-hw, x0 - 0.1), Math.min(hw, x1 + 0.1), gf + 0.25, gf + 0.6, 0, 0.34);
  }
  const pn = gf + 1.3;
  const upper = top - (pn + 3.0) > 3.4;
  xs.forEach((x, i) => {
    win(k, x, pn, 1.4, upper ? 2.9 : Math.min(3.4, top - pn - 1.6), { ped: i % 2 === mid % 2 ? "tri" : "flat", balc: i === mid });
    if (upper) win(k, x, pn + 4.5, 1.3, Math.min(2.0, top - pn - 5.4), { ped: "none" });
  });
  k.slab("trim", -hw, hw, top, top + 0.45, -0.3, 0.3);
  if (o.sign && !o.portico) k.geo("signs", c.atlas.quad(o.sign, Math.min(W * 0.62, 15)), 0, (top + 0.45 + H - 0.8) / 2, 0.02);
  cornice(k, W, H - 0.35, 0.95, true);
  const piers = Array.from({ length: n + 1 }, (_, i) => -W / 2 + pitch * i);
  const pw = 3 * pitch + 2.2;
  if (o.portico) {
    balustrade(k, -hw, -pw / 2 - 0.3, H - 0.2, 0.25, piers);
    balustrade(k, pw / 2 + 0.3, hw, H - 0.2, 0.25, piers);
  } else balustrade(k, -hw, hw, H - 0.2, 0.25, piers);
  if (o.portico) {
    k.slab("stone", -pw / 2, pw / 2, 0, 1.0, 0, 3.4);
    for (let s = 0; s < 3; s++) k.slab("stone", -pw / 2 + 0.3, pw / 2 - 0.3, 0, 1.0 - s * 0.33, 3.4, 3.4 + 0.45 * (s + 1));
    for (const x of [-1.5, -0.5, 0.5, 1.5].map((f) => f * pitch)) {
      k.put("drum", x, 1.18, 2.3, 1.2, 0.36, 1.2);
      k.put("shaft", x, (1.36 + top - 0.55) / 2, 2.3, 1.0, top - 0.55 - 1.36, 1.0);
      k.put("capital", x, top - 0.3, 2.3, 1.25, 0.5, 1.25);
      k.slab("trim", x - 0.7, x + 0.7, top - 0.05, top + 0.1, 1.6, 3.0);
    }
    k.slab("stone", -pw / 2, pw / 2, top + 0.1, H - 0.55, -0.2, 3.2);
    k.slab("stone", -pw / 2 - 0.3, pw / 2 + 0.3, H - 0.55, H - 0.15, -0.2, 3.6);
    k.put("ped", 0, H - 0.15, 1.7, pw + 0.6, pw + 0.6, 3.8);
    if (o.sign) k.geo("signs", c.atlas.quad(o.sign, pw - 1.2), 0, (top + 0.1 + H - 0.55) / 2, 3.21);
    door(k, 0, 2.4, 3.9);
    win(k, -pitch, 1.3, 1.5, 2.6, { frame: true, ped: "flat" });
    win(k, pitch, 1.3, 1.5, 2.6, { frame: true, ped: "flat" });
  }
  if (o.dome) dome(k, 0, H + 0.9, -Math.min(D * 0.5, o.dome + 4), o.dome);
  if (o.flag) {
    k.put("pole", 0, H + 1.1, -2.0, 0.6, 7.5, 0.6);
    k.put("strap", 1.32, H + 7.8, -2.0, 2.5, 1.5, 0.05);
    k.geo("brass", new THREE.SphereGeometry(0.16, 8, 6), 0, H + 8.7, -2.0);
  }
}

/** a counting house: brick over a row of shops with fascias and awnings, stone quoins and trim, three floors, a cornice */
function counting(c: Ctx, W: number, D: number, o: { H: number; signs: string[] }) {
  const { k } = c;
  const { H } = o;
  const hw = W / 2 - 0.01;
  k.slab("brick", -W / 2, W / 2, 0, H, -D, 0);
  const shops = Math.max(2, Math.min(o.signs.length, Math.round(W / 4.5)));
  for (let i = 0; i < shops; i++) {
    const x0 = -W / 2 + 0.5 + ((W - 1.0) * i) / shops;
    const x1 = -W / 2 + 0.5 + ((W - 1.0) * (i + 1)) / shops;
    shopfront(k, c.atlas, x0 + 0.3, x1 - 0.3, o.signs[i], i % 2 === 0);
  }
  k.slab("trim", -hw, hw, 4.2, 4.55, -0.3, 0.3);
  quoins(k, W, 4.55, H - 0.6);
  const n = Math.max(3, Math.round(W / 2.7));
  const xs = bays(W - 1.4, n);
  for (let y = 5.2, f = 0; y + 2.2 < H - 1.3; y += 3.4, f++) {
    xs.forEach((x) => win(k, x, y, 1.15, f === 0 ? 2.4 : 2.1, { ped: f === 0 ? "flat" : "none", frame: true }));
  }
  cornice(k, W, H, 0.7, false);
  k.slab("brick", -W / 2, W / 2, H + 0.15, H + 1.1, -D, -0.4);
  k.slab("trim", -hw, hw, H + 1.1, H + 1.25, -D, -0.3);
  chimney(k, W / 2 - 0.7, -D * 0.4, H + 1, H + 3.9);
  chimney(k, -W / 2 + 0.7, -D * 0.55, H + 1, H + 3.4);
}

/** one bay-group of the crescent: an arcade below, two floors, a cornice and a mansard; the middle one a pavilion */
function crescent(c: Ctx, W: number, D: number, o: { H: number; pavilion?: boolean; end?: boolean; signs?: (string | null)[] }) {
  const { k } = c;
  const { H } = o;
  const hw = W / 2 - 0.01;
  const gf = 5.2;
  k.slab("ashlar", -W / 2, W / 2, gf, H, -D, 0);
  k.slab("ashlar", -W / 2, W / 2, 0, gf, -D, -3.2);
  // the arcade: three arches on piers, dark within
  const n = 3;
  const s = W / n / 3.2;
  bays(W, n).forEach((x, i) => {
    k.put("arch", x, 0, 0, s, 1, 1);
    k.slab("trim", x - 0.22, x + 0.22, 4.1, 4.75, -0.05, 0.12);
    const sign = o.signs?.[i];
    if (sign) k.geo("signs", c.atlas.quad(sign, 1.9 * s), x, 3.2, -3.08);
  });
  k.slab("void", -hw, hw, 0, gf, -3.3, -3.1);
  k.slab("void", -hw, hw, 0, 0.03, -3.2, -0.5);
  k.slab("stone", -hw, hw, gf - 0.2, gf - 0.02, -3.2, -0.3);
  k.slab("trim", -hw, hw, gf - 0.05, gf + 0.3, -0.5, 0.25);
  const xs = bays(W, 3);
  const floors = Math.floor((H - gf - 1.0) / 3.6);
  for (let f = 0; f < floors; f++) {
    const y = gf + 0.95 + f * 3.6;
    xs.forEach((x, i) =>
      win(k, x, y, f === 0 ? 1.25 : 1.15, f === 0 ? 2.5 : 2.0, {
        ped: f === 0 ? (i === 1 ? "tri" : "flat") : "none",
        balc: f === 0 && (o.pavilion || i === 1),
      }),
    );
  }
  if (o.pavilion) {
    for (const x of [-W / 2 + 0.5, -W / 6, W / 6, W / 2 - 0.5]) {
      k.slab("stone", Math.max(-hw, x - 0.4), Math.min(hw, x + 0.4), gf + 0.3, H - 1.1, 0, 0.26);
      k.slab("trim", Math.max(-hw, x - 0.55), Math.min(hw, x + 0.55), H - 1.5, H - 1.1, 0, 0.36);
    }
    cornice(k, W, H, 0.8, true);
    k.put("ped", 0, H + 0.15, 0.1, W + 0.6, W + 0.6, 1.4);
    k.geo("signs", c.atlas.quad("THE CRESCENT", W * 0.6), 0, H - 0.75, 0.3);
    k.slab("slate", -W / 2 + 0.2, W / 2 - 0.2, H + 0.1, H + 2.2, -D, -1.4);
    chimney(k, 0, -D * 0.5, H + 1, H + 4.4);
  } else {
    cornice(k, W, H, 0.6, false);
    mansard(k, W, D, H + 0.15, [xs[0], xs[2]]);
    chimney(k, o.end ? 0 : W / 2 - 0.5, -D * 0.45, H + 1, H + 4.8);
  }
}

/** a street wall on a corner lot's flank: windows up its length and its cornice carried round */
function flank(c: Ctx, W: number, D: number, H: number, side: 1 | -1) {
  const { k } = c;
  k.push(k.local((side * W) / 2, 0, -D / 2, (side * Math.PI) / 2));
  const L = D - 1.2;
  const n = Math.max(2, Math.round(L / 3.3));
  const xs = bays(L, n);
  xs.forEach((x, i) => (i % 2 === 1 ? win(k, x, 0.95, 1.25, 2.5, { frame: false, key: true }) : win(k, x, 0.95, 1.25, 2.5, { frame: false })));
  for (let y = 5.2; y + 2.1 < H - 1.1; y += 3.5) xs.forEach((x) => win(k, x, y, 1.1, 2.1, { ped: "none" }));
  cornice(k, D, H, 0.6, false);
  k.pop();
}

/** the clock tower: a strong base, a clock stage with faces to the plaza and the street, a belfry, a lead dome and spire */
function clockTower(c: Ctx, W: number, D: number, streetSide: 1 | -1) {
  const { k } = c;
  const T0 = W;
  // B: the top of the base; the clock sits low enough on the tower to be in the frame of the walking camera
  const B = 9.6;
  k.slab("ashlar", -T0 / 2, T0 / 2, 0, B, -D, 0);
  k.slab("trim", -T0 / 2 + 0.01, T0 / 2 - 0.01, 0, 0.7, -0.3, 0.14);
  quoins(k, T0, 0.7, B - 0.2);
  k.put("arch", 0, 0, 0.5, 0.95, 0.95, 1);
  k.slab("void", -1.1, 1.1, 0, 4.25, 0.02, 0.1);
  k.slab("wood", -0.9, 0.9, 0, 3.1, 0.1, 0.16);
  k.slab("trim", -T0 / 2 + 0.01, T0 / 2 - 0.01, 5.1, 5.4, -0.3, 0.26);
  win(k, 0, 6.1, 1.3, 2.2, { ped: "tri", balc: true });
  cornice(k, T0, B, 0.55, true);
  // the flank toward the street
  k.push(k.local((streetSide * T0) / 2, 0, -D / 2, (streetSide * Math.PI) / 2));
  bays(D - 2, 3).forEach((x) => {
    win(k, x, 1.2, 1.3, 2.6, { frame: false, key: true });
    win(k, x, 6.1, 1.2, 2.2, { ped: "flat" });
  });
  cornice(k, D, B, 0.55, true);
  k.pop();
  // the clock stage, a face to the plaza and one to the street
  const T1 = 7.6;
  const zc = -T0 / 2;
  const s0 = B + 0.1;
  const s1 = B + 5.6;
  k.slab("stone", -T1 / 2, T1 / 2, s0, s1, zc - T1 / 2, zc + T1 / 2);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) k.slab("trim", sx * (T1 / 2) - 0.35 - sx * 0.2, sx * (T1 / 2) + 0.35 - sx * 0.2, s0, s1 - 0.4, zc + sz * (T1 / 2) - 0.34, zc + sz * (T1 / 2) + 0.34);
  k.slab("stone", -T1 / 2 - 0.5, T1 / 2 + 0.5, s1 - 0.4, s1 + 0.2, zc - T1 / 2 - 0.5, zc + T1 / 2 + 0.5);
  k.slab("trim", -T1 / 2 - 0.25, T1 / 2 + 0.25, B, B + 0.4, zc - T1 / 2 - 0.25, zc + T1 / 2 + 0.25);
  const cy = (s0 + s1) / 2 + 0.1;
  clockFace(c, 0, cy, zc + T1 / 2 + 0.02, 0, 2.05);
  clockFace(c, streetSide * (T1 / 2 + 0.02), cy, zc, (streetSide * Math.PI) / 2, 2.05);
  // the belfry: an arch each way, pilasters at the corners
  const T2 = 6.0;
  const b0 = s1 + 0.2;
  const b1 = b0 + 4.4;
  k.slab("ashlar", -T2 / 2, T2 / 2, b0, b1, zc - T2 / 2, zc + T2 / 2);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    k.push(k.local(Math.sin(a) * (T2 / 2), 0, zc + Math.cos(a) * (T2 / 2), a));
    k.put("arch", 0, b0 + 0.4, 0.45, 0.62, 0.66, 0.9);
    k.slab("void", -0.72, 0.72, b0 + 0.4, b0 + 3.3, -0.4, 0.02);
    k.slab("trim", -0.18, 0.18, b0 + 3.0, b0 + 3.7, 0.3, 0.5);
    k.slab("trim", -T2 / 2 - 0.02, -T2 / 2 + 0.7, b0, b1, 0, 0.22);
    k.slab("trim", T2 / 2 - 0.7, T2 / 2 + 0.02, b0, b1, 0, 0.22);
    k.pop();
  }
  k.slab("stone", -T2 / 2 - 0.45, T2 / 2 + 0.45, b1, b1 + 0.55, zc - T2 / 2 - 0.45, zc + T2 / 2 + 0.45);
  k.slab("stone", -T2 / 2 + 0.2, T2 / 2 - 0.2, b1 + 0.55, b1 + 1.3, zc - T2 / 2 + 0.2, zc + T2 / 2 - 0.2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.put("drum", sx * (T2 / 2 - 0.1), b1 + 1.15, zc + sz * (T2 / 2 - 0.1), 0.6, 1.3, 0.6);
  // the lead dome, its lantern and spire
  const d0 = b1 + 1.3;
  k.geo("stonework", new THREE.CylinderGeometry(2.45, 2.55, 0.9, 24), 0, d0 + 0.45, zc);
  k.geo("lead", hemi(2.6, 24), 0, d0 + 0.9, zc, 0, 1, 1.25, 1);
  k.geo("stonework", new THREE.CylinderGeometry(0.6, 0.66, 1.5, 10), 0, d0 + 4.9, zc);
  k.geo("lead", new THREE.ConeGeometry(0.8, 1.9, 10), 0, d0 + 6.6, zc);
  k.geo("brass", new THREE.CylinderGeometry(0.03, 0.05, 1.6, 6), 0, d0 + 8.3, zc);
  k.geo("brass", new THREE.SphereGeometry(0.13, 8, 6), 0, d0 + 8.2, zc);
}

/** a clock face at (x, y, z) of the current frame, turned by ry; its hands are kept for update() */
function clockFace(c: Ctx, x: number, y: number, z: number, ry: number, r: number) {
  const { k } = c;
  k.geo("clock", new THREE.CircleGeometry(r, 48), x, y, z, ry);
  k.geo("brass", new THREE.TorusGeometry(r + 0.05, 0.12, 6, 48), x, y, z, ry);
  const pivot = new THREE.Group();
  pivot.applyMatrix4(k.frame.clone().multiply(k.local(x, y, z, ry)));
  const hand = (len: number, wid: number, dz: number) => {
    const s = new THREE.Shape();
    s.moveTo(-wid * 0.5, -len * 0.18);
    s.lineTo(wid * 0.5, -len * 0.18);
    s.lineTo(wid * 0.34, len * 0.78);
    s.lineTo(0, len);
    s.lineTo(-wid * 0.34, len * 0.78);
    s.closePath();
    const m = new THREE.Mesh(new THREE.ShapeGeometry(s), flat(INK));
    m.position.z = dz;
    pivot.add(m);
    return m;
  };
  const hour = hand(r * 0.55, 0.22, 0.04);
  const minute = hand(r * 0.84, 0.14, 0.07);
  const cap = new THREE.Mesh(new THREE.CircleGeometry(0.13, 16), flat(INK));
  cap.position.z = 0.09;
  pivot.add(cap);
  c.extras.add(pivot);
  c.hands.push({ hour, minute });
}

/**
 * THE BANDS EXCHANGE: eight columns on a stepped podium, the name on the frieze, a pediment with his hat in a wreath, two
 * banners, a dome behind; rusticated wings. Frame at the column line, r = 55.
 */
function exchange(c: Ctx, W: number, D: number) {
  const { k } = c;
  const y0 = 1.5;
  const zc = -1.2;
  const half = 18.2;
  // podium and steps
  k.slab("stone", -half, half, 0, y0, -7, -0.2);
  for (let s = 0; s < 5; s++) k.slab("stone", -half + 0.6, half - 0.6, 0, y0 - s * 0.3, -0.2, 0.25 + 0.55 * (s + 1));
  for (const sx of [-1, 1]) {
    k.slab("stone", Math.min(sx * half, sx * (half - 1.2)), Math.max(sx * half, sx * (half - 1.2)), 0, y0 + 0.9, -0.2, 3.0);
    k.geo("stonework", new THREE.CylinderGeometry(0.55, 0.6, 1.0, 12), sx * (half - 0.6), y0 + 1.4, 2.4);
  }
  // the colonnade; E is the top of the capitals, where the entablature starts
  const E = 12.3;
  const xs = Array.from({ length: 8 }, (_, i) => (i - 3.5) * 4.4);
  for (const x of xs) {
    k.slab("trim", x - 0.95, x + 0.95, y0, y0 + 0.22, zc - 0.95, zc + 0.95);
    k.put("drum", x, y0 + 0.38, zc, 1.7, 0.32, 1.7);
    k.put("shaft", x, (y0 + 0.54 + E - 1.05) / 2, zc, 1.42, E - 1.05 - y0 - 0.54, 1.42);
    k.put("capital", x, E - 0.65, zc, 1.8, 0.8, 1.8);
    k.slab("trim", x - 1.0, x + 1.0, E - 0.25, E, zc - 1.0, zc + 1.0);
  }
  // entablature: architrave, the frieze with the name, the cornice with dentils
  k.slab("stone", -half, half, E, E + 0.72, -7, -0.15);
  k.slab("trim", -half, half, E + 0.72, E + 0.82, -7, -0.05);
  k.slab("stone", -half + 0.1, half - 0.1, E + 0.82, E + 2.42, -7, -0.25);
  k.geo("frieze", new THREE.PlaneGeometry(25.6, 1.6), 0, E + 1.62, -0.24);
  k.slab("trim", -half - 0.2, half + 0.2, E + 2.42, E + 2.64, -7, 0.1);
  dentilRow(k, -half, half, E + 2.42, E + 2.62, 0.1);
  const PB = E + 3.05;
  k.slab("stone", -half - 0.5, half + 0.5, E + 2.6, PB, -7.3, 0.75);
  // the pediment, its raking cornices and the emblem
  const pw = 2 * (half + 0.5);
  const ph = 5.0;
  const tri = new THREE.Shape();
  tri.moveTo(-pw / 2 + 0.6, 0);
  tri.lineTo(pw / 2 - 0.6, 0);
  tri.lineTo(0, ph - 0.25);
  tri.closePath();
  const pg = new THREE.ExtrudeGeometry(tri, { depth: 7.0, bevelEnabled: false });
  k.geo("stonework", pg, 0, PB, -7.0);
  const slope = Math.atan2(ph, pw / 2);
  const len = Math.hypot(pw / 2, ph) + 0.6;
  for (const sx of [-1, 1]) {
    k.put("stone", (sx * pw) / 4, PB + ph / 2 + 0.05, 0.25, len, 0.5, 1.1, 0, -sx * slope);
    k.put("trim", (sx * pw) / 4, PB + ph / 2 - 0.35, 0.35, len - 0.8, 0.22, 0.6, 0, -sx * slope);
  }
  k.put("drum", 0, PB + ph + 0.35, -0.1, 1.0, 0.8, 1.0);
  for (const sx of [-1, 1]) k.put("drum", sx * (pw / 2 - 0.3), PB + 0.35, 0.2, 0.9, 0.7, 0.9);
  k.geo("signs", c.atlas.quad("emblem", 3.5), 0, PB + 1.85, 0.03);
  // the banners, flanking the board, hung from the architrave
  for (const sx of [-1, 1]) k.geo("signs", c.atlas.quad("banner", 2.2), sx * 13.2, E - 3.4, zc + 0.05);
  // behind the portico: the cella wall and its doors
  k.slab("ashlar", -half + 0.2, half - 0.2, y0, E, -D, -6.0);
  for (const x of [-4.4, 0, 4.4]) {
    k.push(k.local(x, y0, -6.0));
    door(k, 0, 2.4, x === 0 ? 5.2 : 4.4);
    k.pop();
  }
  for (const x of [-13.2, -8.8, 8.8, 13.2]) {
    k.push(k.local(x, y0, -6.0));
    win(k, 0, 1.6, 1.6, 3.4, { ped: "tri" });
    win(k, 0, 6.8, 1.4, 2.2, { ped: "none" });
    k.pop();
  }
  k.slab("ashlar", -half, half, E, PB, -D, -7);
  // the wings: set back, rusticated, two floors of windows, balustrade
  for (const sx of [-1, 1]) {
    const inner = half + 0.3;
    const outer = W / 2 + 4;
    const wW = outer - inner;
    k.push(k.local((sx * (inner + outer)) / 2, 0, -3.0));
    k.slab("ashlar", -wW / 2, wW / 2, 0, 13.8, -D + 3, 0);
    k.slab("trim", -wW / 2, wW / 2, 0, 0.7, -0.3, 0.14);
    for (let y = 1.3; y < 5.0; y += 0.62) k.slab("groove", -wW / 2, wW / 2, y - 0.035, y + 0.035, -0.05, 0.03);
    k.slab("trim", -wW / 2, wW / 2, 5.0, 5.45, -0.3, 0.32);
    const wx = bays(wW - 4, 2).map((x) => x - (sx * 2) / 1);
    for (const x of wx) {
      win(k, x, 1.3, 1.5, 2.6, { frame: false, key: true });
      win(k, x, 6.3, 1.4, 2.9, { ped: "tri" });
      win(k, x, 10.3, 1.3, 1.7, { ped: "none" });
    }
    k.slab("stone", -wW / 2, -wW / 2 + 0.9, 5.45, 12.9, 0, 0.26);
    k.slab("stone", wW / 2 - 0.9, wW / 2, 5.45, 12.9, 0, 0.26);
    cornice(k, wW, 13.6, 0.8, true);
    balustrade(k, -wW / 2 + 0.01, wW / 2 - 0.01, 13.75, 0.2, [-wW / 2 + 0.4, -sx * 2, wW / 2 - 0.4]);
    k.pop();
  }
  // the dome
  dome(k, 0, PB, -19, 6.3);
  // a lamp either side of the steps: a post with three globes
  for (const sx of [-1, 1]) {
    k.push(k.local(sx * (half + 1.6), 0, 3.4));
    k.put("pole", 0, 0, 0, 1.1, 4.8, 1.1);
    k.put("globe", 0, 5.05, 0, 1.25, 1.25, 1.25);
    k.put("globe", -0.55, 4.6, 0, 0.8, 0.8, 0.8);
    k.put("globe", 0.55, 4.6, 0, 0.8, 0.8, 0.8);
    k.slab("ink", -0.6, 0.6, 4.28, 4.36, -0.04, 0.04);
    k.pop();
  }
}

// ---------------------------------------------------------------- the fountain

function fountain(c: Ctx, root: THREE.Group): { update(t: number): void } {
  const { k } = c;
  k.at(new THREE.Matrix4());
  const V = (r: number, y: number) => new THREE.Vector2(r, y);
  // the basin: a low wall with a lip, the floor under the water
  k.geo("fountain", new THREE.LatheGeometry([V(3.3, 0), V(3.4, 0.08), V(3.4, 0.5), V(3.52, 0.56), V(3.52, 0.74), V(3.02, 0.76), V(3.0, 0.3), V(0.01, 0.3)], 56));
  // the plinth: an octagon in two stages, then the tazza, a shallow bowl the veil falls from
  k.geo("fountain", new THREE.CylinderGeometry(1.2, 1.38, 0.75, 8), 0, 0.3 + 0.375, 0, Math.PI / 8);
  k.geo("fountain", new THREE.CylinderGeometry(0.72, 0.9, 0.42, 8), 0, 1.05 + 0.21, 0, Math.PI / 8);
  k.geo("fountain", new THREE.LatheGeometry([V(0.55, 1.36), V(1.2, 1.44), V(1.95, 1.56), V(2.02, 1.72), V(1.9, 1.74), V(0.6, 1.66), V(0.01, 1.66)], 40));
  k.geo("fountain", new THREE.CylinderGeometry(0.62, 0.74, 0.34, 8), 0, 1.66 + 0.17, 0, Math.PI / 8);
  k.geo("fountain", new THREE.BoxGeometry(1.7, 0.18, 1.1), 0, 2.09, 0);
  // the sculpture: six bundles of notes, each strapped twice in orange, climbing in a slow twist
  for (let i = 0; i < 6; i++) {
    const ry = i * 0.27 - 0.4;
    const y = 2.18 + 0.13 + i * 0.26;
    k.put("bill", 0, y, 0, 1, 1, 1, ry);
    for (const bx of [-0.34, 0.34]) {
      const cx = Math.cos(ry) * bx;
      const cz = -Math.sin(ry) * bx;
      k.put("band", cx, y, cz, 1, 1, 1, ry);
    }
  }
  // spouts: eight brass mouths on the lip
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    k.put("globe", Math.sin(a) * 3.04, 0.86, Math.cos(a) * 3.04, 0.4, 0.4, 0.4);
  }

  // the water surface: paper, ringed with ink ripples running out from under the tazza
  const surfaceMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uInk: shared.uInk, uPaper: shared.uPaper },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uInk; uniform vec3 uPaper;
      varying vec2 vP;
      void main() {
        float r = length(vP);
        float a = atan(vP.y, vP.x);
        float q = r * 2.3 + sin(a * 7.0 + uTime * 0.8) * 0.06 - uTime * 0.55;
        float d = abs(fract(q) - 0.5) * 2.0;
        float aa = fwidth(q) * 1.5;
        float ring = smoothstep(0.86 - aa, 0.86 + aa, d);
        // a light hatch in the shade of the basin wall
        float h = abs(fract(vP.y * 3.2 + vP.x * 0.9) - 0.5) * 2.0;
        float hatch = smoothstep(0.93 - fwidth(vP.y * 3.2) * 2.0, 0.93, h) * 0.35 * smoothstep(2.4, 3.0, r);
        float ink = max(ring * 0.8 * smoothstep(1.9, 2.3, r), hatch);
        gl_FragColor = vec4(mix(uPaper, uInk, ink), 1.0);
      }`,
  });
  const surface = new THREE.Mesh(new THREE.CircleGeometry(3.01, 56), surfaceMat);
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = 0.55;
  surface.name = "city:water";
  root.add(surface);

  // the water that moves: jets arcing in from the spouts to the tazza, and a veil falling from its rim, drawn as ink strands
  const pos: number[] = [];
  const tt: number[] = [];
  const kk: number[] = [];
  const strand = (pts: THREE.Vector3[], seed: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      pos.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
      tt.push(i / (pts.length - 1), (i + 1) / (pts.length - 1));
      kk.push(seed, seed);
    }
  };
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    for (let sI = 0; sI < 3; sI++) {
      const off = (sI - 1) * 0.05;
      const side = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)).multiplyScalar(off);
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 18; j++) {
        const s = j / 18;
        const r = 2.92 - 1.5 * s;
        const y = 0.9 + (1.7 - 0.9) * s + 4 * (1.25 + sI * 0.06) * s * (1 - s);
        pts.push(new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r).add(side));
      }
      strand(pts, (i * 3 + sI) * 0.137);
    }
  }
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * TAU;
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j <= 8; j++) {
      const s = j / 8;
      const r = 2.02 + 0.24 * s * s;
      pts.push(new THREE.Vector3(Math.sin(a) * r, 1.7 - 1.15 * s, Math.cos(a) * r));
    }
    strand(pts, 0.5 + ((i * 7) % 11) * 0.09);
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  lg.setAttribute("aT", new THREE.Float32BufferAttribute(tt, 1));
  lg.setAttribute("aK", new THREE.Float32BufferAttribute(kk, 1));
  const waterMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uInk: shared.uInk },
    vertexShader: /* glsl */ `
      attribute float aT; attribute float aK;
      varying float vT; varying float vK;
      void main() { vT = aT; vK = aK; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uInk;
      varying float vT; varying float vK;
      void main() {
        float x = fract(vT * 3.0 - uTime * (1.1 + fract(vK * 3.7) * 0.5) + vK * 7.13);
        float dash = smoothstep(0.0, 0.1, x) * (1.0 - smoothstep(0.45, 0.7, x));
        gl_FragColor = vec4(uInk, max(dash, 0.3) * 0.9);
      }`,
  });
  const water = new THREE.LineSegments(lg, waterMat);
  water.name = "city:jets";
  water.renderOrder = 2;
  root.add(water);

  return {
    update(t: number) {
      surfaceMat.uniforms.uTime.value = t;
      waterMat.uniforms.uTime.value = t;
    },
  };
}

// ---------------------------------------------------------------- trees and lamps

/** a tree: a trunk and two boughs in Wood, a crown of clumps; in the plaza (planter) it casts its shadow, out in the streets it has fewer clumps */
function tree(k: Kit, rand: () => number, x: number, z: number, o: { planter: boolean; trunk: number; crown: number; lumps?: "full" | "mid" | "few" }) {
  const leaf = o.planter ? "leaf" : "leafFar";
  const lumps = o.lumps ?? "full";
  const base = o.planter ? 0.6 : 0;
  if (o.planter) {
    k.put("planter", x, 0, z, 1, 1, 1);
    k.put("soil", x, 0.62, z, 1.12, 1, 1.12);
  }
  const R = o.crown;
  k.put("trunk", x, base, z, 1, o.trunk + R * 0.5, 1, rand() * TAU);
  for (let i = 0; i < 2; i++) {
    const a = rand() * TAU;
    k.put("trunk", x + Math.sin(a) * 0.15, base + o.trunk * 0.72, z + Math.cos(a) * 0.15, 0.55, R * 1.1, 0.55, a, 0, 0.55);
  }
  const cy = base + o.trunk + R * 0.75;
  const lump = (lx: number, ly: number, lz: number, s: number) =>
    k.put(leaf, x + lx, ly, z + lz, s * (0.95 + rand() * 0.2), s * (0.72 + rand() * 0.14), s * (0.95 + rand() * 0.2), rand() * TAU, rand() * 0.3, rand() * 0.3);
  lump(0, cy + R * 0.78, 0, R * 0.52);
  const n = lumps === "few" ? 4 : lumps === "mid" ? 5 : 6;
  const a0 = rand() * TAU;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU + rand() * 0.3;
    lump(Math.sin(a) * R * 0.66, cy + (rand() - 0.4) * R * 0.3, Math.cos(a) * R * 0.66, R * ((lumps === "few" ? 0.56 : 0.46) + rand() * 0.1));
  }
  const low = lumps === "few" ? 0 : lumps === "mid" ? 2 : 3;
  for (let i = 0; i < low; i++) {
    const a = a0 + (i / low) * TAU + 0.5;
    lump(Math.sin(a) * R * 0.4, cy - R * 0.5, Math.cos(a) * R * 0.4, R * 0.42);
  }
  if (lumps === "full") lump(0, cy + R * 0.1, 0, R * 0.62);
}

function lamp(k: Kit, x: number, z: number) {
  k.put("pole", x, 0, z, 1, 4.4, 1);
  k.put("globe", x, 4.55, z, 1, 1, 1);
}

// ---------------------------------------------------------------- the city

/** where a lot's front runs: a chord from angle a0 to a1, its middle r = R from the centre, facing in */
function lotFrame(a0: number, a1: number, R: number): { m: THREE.Matrix4; W: number } {
  const am = (a0 + a1) / 2;
  const W = 2 * R * Math.tan((a1 - a0) / 2);
  const m = new THREE.Matrix4().makeRotationY(am + Math.PI).setPosition(Math.sin(am) * R, 0, Math.cos(am) * R);
  return { m, W };
}

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the four streets, on the diagonals, and half the angle each one opens in the ring */
const STREETS = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
const GAP = 0.125;
const FRONT = 51;
const KERB_IN = 45.6;
const KERB_OUT = 49.25;

export function buildCity(): City {
  const root = new THREE.Group();
  root.name = "city";
  const colliders: Circle[] = [];
  const walls: Box[] = [];

  const atlas = new Atlas(1024);
  for (const s of ["MERCHANTS' BANK", "BANDS & CO.", "TRUST & SAVINGS", "THE CRESCENT", "COUNTING HOUSE"]) atlas.add(s, 1024, 68, carved(s));
  for (const s of ["HATTER", "CIGARS", "WINE MERCHANT", "COFFEE HOUSE", "STATIONER", "TAILOR", "BOOKSELLER", "LEDGERS", "TEA ROOM", "BARBER", "PRINTER", "GLOVER"])
    atlas.add(s, 336, 64, fascia(s));
  atlas.add("banner", 104, 300, bannerDraw);
  atlas.add("emblem", 300, 300, emblemDraw);
  const atlasTex = atlas.build();

  const BOX = slabGeo();
  const LUMP = new THREE.IcosahedronGeometry(1, 1);
  const trunkGeo = new THREE.CylinderGeometry(0.13, 0.2, 1, 7).translate(0, 0.5, 0);
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 1, 8).translate(0, 0.5, 0);
  const soilGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
  const pieces: Record<string, Piece> = {
    stone: { geo: BOX, mat: M("Paper"), line: BOLD },
    ashlar: { geo: BOX, mat: M("Ashlar"), line: BOLD },
    brick: { geo: BOX, mat: M("Brick"), line: BOLD },
    slate: { geo: BOX, mat: M("Slate"), line: BOLD },
    trim: { geo: BOX, mat: M("Paper"), line: FINE },
    void: { geo: BOX, mat: M("Void"), line: FINE },
    bar: { geo: BOX, mat: M("Paper"), line: 0 },
    groove: { geo: BOX, mat: M("Void"), line: 0 },
    rail: { geo: BOX, mat: M("Ink"), line: 0 },
    wood: { geo: BOX, mat: M("Wood"), line: FINE },
    ink: { geo: BOX, mat: M("Ink"), line: FINE },
    strap: { geo: BOX, mat: M("Strap"), line: FINE },
    ped: { geo: prismGeo(), mat: M("Paper"), line: FINE },
    arch: { geo: archGeo(), mat: M("Ashlar"), line: BOLD },
    shaft: { geo: new THREE.CylinderGeometry(0.43, 0.5, 1, 18, 1, true), mat: M("Paper"), line: BOLD },
    capital: { geo: new THREE.CylinderGeometry(0.5, 0.36, 1, 18), mat: M("Paper"), line: FINE },
    drum: { geo: new THREE.CylinderGeometry(0.5, 0.5, 1, 10), mat: M("Paper"), line: FINE },
    tooth: { geo: BOX, mat: M("Paper"), line: 0 },
    baluster: { geo: balusterGeo(), mat: M("Paper"), line: FINE },
    leaf: { geo: LUMP, mat: leafMaterial(), line: BOLD, shadow: true, nearCut: true },
    leafFar: { geo: LUMP, mat: leafMaterial(), line: BOLD, nearCut: true },
    trunk: { geo: trunkGeo, mat: M("Wood"), line: FINE, shadow: true },
    planter: { geo: planterGeo(), mat: M("Paper"), line: BOLD, shadow: true },
    soil: { geo: soilGeo, mat: M("Void"), line: 0 },
    pole: { geo: poleGeo, mat: M("Ink"), line: FINE },
    globe: { geo: new THREE.SphereGeometry(0.34, 10, 8), mat: M("Brass"), line: FINE },
    bill: { geo: new THREE.BoxGeometry(1.4, 0.26, 0.64), mat: mat("Bill", new THREE.Vector3(0.7, 0.13, 0.32)), line: FINE, shadow: true },
    band: { geo: new THREE.BoxGeometry(0.17, 0.275, 0.655), mat: M("Strap"), line: FINE, shadow: true },
  };
  const signMat = new THREE.MeshBasicMaterial({ map: atlasTex, alphaTest: 0.5 });
  const clockMat = new THREE.MeshBasicMaterial({ map: clockTexture() });
  const friezeMat = new THREE.MeshBasicMaterial({ map: friezeTexture() });
  const mdefs: Record<string, MergedDef> = {
    slate: { mat: M("Slate"), line: BOLD, attrs: ["position", "normal"] },
    lead: { mat: M("Lead"), line: BOLD, attrs: ["position", "normal"] },
    stonework: { mat: M("Paper"), line: BOLD, attrs: ["position", "normal"] },
    brass: { mat: M("Brass"), line: FINE, attrs: ["position", "normal"] },
    fountain: { mat: M("Paper"), line: BOLD, shadow: true, attrs: ["position", "normal"] },
    road: { mat: M("Road"), line: 0, attrs: ["position", "normal"] },
    kerb: { mat: M("Paper"), line: FINE, attrs: ["position", "normal"] },
    lines: { mat: flat(INK), line: 0, attrs: ["position"] },
    signs: { mat: signMat, line: 0, attrs: ["position", "uv"] },
    clock: { mat: clockMat, line: 0, attrs: ["position", "uv"] },
    frieze: { mat: friezeMat, line: 0, attrs: ["position", "uv"] },
  };
  const k = new Kit(pieces, mdefs);
  const extras = new THREE.Group();
  extras.name = "city:extras";
  const c: Ctx = { k, atlas, extras, hands: [] };

  // ---- the ring of façades
  type LotFn = (c: Ctx, W: number, D: number) => void;
  interface Lot {
    a0: number;
    a1: number;
    R?: number;
    D?: number;
    H: number;
    build: LotFn;
    /** a flank on a street: +1 the lot's +x side (its lower angle), -1 its -x side */
    street?: 1 | -1;
    /** the lot draws its own flank */
    ownFlank?: boolean;
  }
  const S = STREETS;
  const house = (o: HouseOpts): LotFn => (cc, W, D) => townhouse(cc, W, D, o);
  const bankL = (o: BankOpts): LotFn => (cc, W, D) => bank(cc, W, D, o);
  const lots: Lot[] = [
    // east, from the south-east street to the north-east one; the Guard House stands before the Merchants' Bank
    { a0: S[0] + GAP, a1: 1.06, H: 12.5, build: house({ H: 12.5, body: "ashlar", mansard: true, shop: "HATTER", awning: true, rich: true }), street: 1 },
    { a0: 1.06, a1: 1.2, H: 14.5, build: house({ H: 14.5, body: "stone", mansard: true }) },
    { a0: 1.2, a1: 1.32, H: 11, build: house({ H: 11, body: "brick", shop: "CIGARS", awning: true }) },
    { a0: 1.32, a1: 1.82, D: 22, H: 18, build: bankL({ H: 18, body: "stone", sign: "MERCHANTS' BANK", dome: 5.2, portico: true }) },
    { a0: 1.82, a1: 2.03, H: 15, build: (cc, W, D) => counting(cc, W, D, { H: 15, signs: ["COFFEE HOUSE", "STATIONER"] }) },
    { a0: 2.03, a1: S[1] - GAP, H: 13, build: house({ H: 13, body: "ashlar", mansard: true, shop: "WINE MERCHANT", rich: true }), street: -1 },
    // north: the clock tower on the corner, the Exchange, a small domed bank
    { a0: S[1] + GAP, a1: 2.69, D: 18, H: 11.4, build: (cc, W, D) => clockTower(cc, W, D, 1), street: 1, ownFlank: true },
    { a0: 2.69, a1: 3.59, R: 55, D: 34, H: 15.6, build: (cc, W, D) => exchange(cc, W, D) },
    { a0: 3.59, a1: S[2] - GAP, D: 20, H: 15, build: bankL({ H: 15, body: "ashlar", sign: "TRUST & SAVINGS", dome: 3.1 }), street: -1 },
    // west, behind Mr Bands' desk: his own house
    { a0: S[2] + GAP, a1: 4.26, H: 16, build: (cc, W, D) => counting(cc, W, D, { H: 16, signs: ["TAILOR", "BOOKSELLER"] }), street: 1 },
    { a0: 4.26, a1: 4.4, H: 13, build: house({ H: 13, body: "stone", mansard: true, rich: true }) },
    { a0: 4.4, a1: 4.53, H: 15.5, build: house({ H: 15.5, body: "ashlar", mansard: true, shop: "LEDGERS" }) },
    { a0: 4.53, a1: 5.06, D: 20, H: 17, build: bankL({ H: 17, body: "stone", sign: "BANDS & CO.", arches: true, flag: true }) },
    { a0: 5.06, a1: 5.22, H: 12, build: house({ H: 12, body: "brick", shop: "GLOVER", awning: true }) },
    { a0: 5.22, a1: S[3] - GAP, H: 14, build: house({ H: 14, body: "ashlar", mansard: true, shop: "TEA ROOM", awning: true, rich: true }), street: -1 },
  ];
  // south: the crescent, seven bay-groups on the curve, the middle one a pavilion
  const cs0 = S[3] + GAP - TAU;
  const cs1 = S[0] - GAP;
  const cSigns: (string | null)[][] = [
    ["PRINTER", null, null],
    [null, "BARBER", null],
    [null, null, "GLOVER"],
    [null, null, null],
    ["COFFEE HOUSE", null, null],
    [null, "BOOKSELLER", null],
    [null, null, "STATIONER"],
  ];
  for (let i = 0; i < 7; i++) {
    const a0 = cs0 + ((cs1 - cs0) * i) / 7;
    const a1 = cs0 + ((cs1 - cs0) * (i + 1)) / 7;
    const pavilion = i === 3;
    const end = i === 0 || i === 6;
    const H = pavilion ? 16.5 : end ? 14.2 : 13;
    lots.push({
      a0,
      a1,
      H,
      build: (cc, W, D) => crescent(cc, W, D, { H, pavilion, end, signs: cSigns[i] }),
      street: i === 0 ? 1 : i === 6 ? -1 : undefined,
    });
  }

  const corners: THREE.Vector3[][] = [[], [], [], []];
  for (const lot of lots) {
    const R = lot.R ?? FRONT;
    const D = lot.D ?? 16;
    const { m, W } = lotFrame(lot.a0, lot.a1, R);
    k.at(m);
    lot.build(c, W, D);
    if (lot.street) {
      k.at(m);
      if (!lot.ownFlank) flank(c, W, D, lot.H, lot.street);
      // remember where this corner's flank ends, to line the street up behind it
      const back = k.world((lot.street * W) / 2, 0, -D);
      const sAng = lot.street === 1 ? lot.a0 - GAP : lot.a1 + GAP;
      const si = STREETS.findIndex((a) => Math.abs(((sAng - a + TAU + Math.PI) % TAU) - Math.PI) < 0.01);
      if (si >= 0) corners[si].push(back);
    }
  }

  // ---- the streets: blocks either side running out into the fog, and a domed front closing each vista
  const rs = mulberry(7);
  plain = true;
  STREETS.forEach((as, si) => {
    const u = new THREE.Vector3(Math.sin(as), 0, Math.cos(as));
    const v = new THREE.Vector3(Math.cos(as), 0, -Math.sin(as));
    let F = 9.5;
    for (const p of corners[si]) F = Math.max(F, Math.abs(p.dot(v)) - 0.4);
    for (const s of [-1, 1]) {
      let t = 66;
      for (let b = 0; b < 3; b++) {
        const W = 15 + rs() * 5;
        const H = 12 + Math.round(rs() * 6);
        const pos = u.clone().multiplyScalar(t + W / 2).addScaledVector(v, s * F);
        const th = Math.atan2(-s * v.x, -s * v.z);
        k.at(new THREE.Matrix4().makeRotationY(th).setPosition(pos));
        if ((b + si + (s > 0 ? 1 : 0)) % 2 === 0) townhouse(c, W, 14, { H, body: b % 2 ? "brick" : "ashlar", mansard: true });
        else counting(c, W, 14, { H, signs: [] });
        t += W;
      }
    }
    const vista = lotFrame(as - 0.1, as + 0.1, 126);
    k.at(vista.m);
    bank(c, vista.W, 20, { H: 16, body: "stone", dome: 4.5, portico: si % 2 === 0 });
  });
  plain = false;

  // ---- the boulevard: the carriageway (a light hatch), kerbs, paving joints, trees and lamps
  k.at(new THREE.Matrix4());
  k.geo("road", new THREE.RingGeometry(KERB_IN + 0.25, KERB_OUT, 180, 1), 0, 0.02, 0, 0, 1, 1, 1, 0, -Math.PI / 2);
  const kerbArc = (r0: number, r1: number, p0: number, len: number) =>
    k.geo("kerb", new THREE.LatheGeometry([new THREE.Vector2(r1, 0), new THREE.Vector2(r1, 0.16), new THREE.Vector2(r0 + 0.01, 0.17), new THREE.Vector2(r0, 0)], Math.max(8, Math.round(len * 40)), p0, len));
  kerbArc(KERB_IN, KERB_IN + 0.25, 0, TAU);
  const roadHalf = 4.2;
  const gapOut = Math.asin(roadHalf / KERB_OUT);
  STREETS.forEach((as, i) => {
    const next = STREETS[(i + 1) % 4] + (i === 3 ? TAU : 0);
    kerbArc(KERB_OUT, KERB_OUT + 0.25, as + gapOut, next - as - 2 * gapOut);
    const u = new THREE.Vector3(Math.sin(as), 0, Math.cos(as));
    const L = 128 - KERB_OUT;
    const mid = u.clone().multiplyScalar(KERB_OUT - 2 + L / 2);
    k.geo("road", new THREE.PlaneGeometry(roadHalf * 2, L + 4), mid.x, 0.02, mid.z, as, 1, 1, 1, 0, -Math.PI / 2);
    for (const s of [-1, 1]) {
      const p = u
        .clone()
        .multiplyScalar(KERB_OUT + L / 2)
        .add(new THREE.Vector3(Math.cos(as), 0, -Math.sin(as)).multiplyScalar(s * (roadHalf + 0.12)));
      k.put("trim", p.x, 0.08, p.z, 0.25, 0.16, L, as);
    }
  });
  // paving joints on the pavement before the fronts, and a line round the promenade
  const line = (x0: number, z0: number, x1: number, z1: number, w: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    k.geo("lines", new THREE.PlaneGeometry(w, len), (x0 + x1) / 2, 0.03, (z0 + z1) / 2, Math.atan2(x1 - x0, z1 - z0), 1, 1, 1, 0, -Math.PI / 2);
  };
  const nearStreet = (a: number, pad: number) => STREETS.some((as) => Math.abs(((a - as + TAU + Math.PI) % TAU) - Math.PI) < pad);
  for (let i = 0; i < 150; i++) {
    const a = (i / 150) * TAU;
    if (nearStreet(a, 0.1)) continue;
    line(Math.sin(a) * (KERB_OUT + 0.25), Math.cos(a) * (KERB_OUT + 0.25), Math.sin(a) * 50.8, Math.cos(a) * 50.8, 0.05);
  }
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * TAU + 0.02;
    line(Math.sin(a) * 42.3, Math.cos(a) * 42.3, Math.sin(a) * KERB_IN, Math.cos(a) * KERB_IN, 0.04);
  }
  k.geo("lines", new THREE.RingGeometry(43.93, 44.0, 180, 1), 0, 0.03, 0, 0, 1, 1, 1, 0, -Math.PI / 2);

  const rt = mulberry(11);
  // (none on the clock tower's side of the north-east street, where it would stand before the tower's door)
  const bTrees = [S[0] - 0.17, S[0] + 0.17, S[1] - 0.17, S[2] - 0.17, S[2] + 0.17, S[3] - 0.17, S[3] + 0.17, 0.4, -0.4, 1.25, 1.95, 4.35, 5.15];
  for (const a of bTrees) tree(k, rt, Math.sin(a) * 44.4, Math.cos(a) * 44.4, { planter: false, trunk: 3.6, crown: 2.5, lumps: "mid" });
  // lamps between the trees, none straight behind a landmark (Mr Bands' desk is at 4.8, the Guard House at 1.49)
  for (const a of [0, 0.34, -0.34, 1.1, 1.75, 2.1, Math.PI - 0.33, Math.PI + 0.33, 4.2, 4.5, 5.25]) lamp(k, Math.sin(a) * 44.4, Math.cos(a) * 44.4);
  // street trees down the four streets
  STREETS.forEach((as) => {
    const u = new THREE.Vector3(Math.sin(as), 0, Math.cos(as));
    const v = new THREE.Vector3(Math.cos(as), 0, -Math.sin(as));
    for (const s of [-1, 1])
      for (let t = 58; t < 120; t += 13) {
        const p = u.clone().multiplyScalar(t + (s > 0 ? 6 : 0)).addScaledVector(v, s * (roadHalf + 1.4));
        if ((t / 13) % 2 < 1) tree(k, rt, p.x, p.z, { planter: false, trunk: 3.4, crown: 2.2, lumps: "few" });
        else lamp(k, p.x, p.z);
      }
  });

  // ---- inside the rope: trees in planters near the rim, clear of the lamps and the landmarks
  const inner: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    let a = 0.3 + (i + 0.5) * (TAU / 10);
    if (Math.abs(a - Math.PI) < 0.2) continue; // not behind the Pools Board
    if (Math.abs(a - TAU) < 0.2) continue; // not on the spawn's line, where the camera stands back
    if (Math.abs(a - 2.5) < 0.01) a = 2.3; // out of the clock tower's way
    if (Math.abs(a - 3.757) < 0.01) a = 3.98; // and, to match, the far side
    inner.push([a, 36]);
  }
  // either side of the spawn's line, and by the two southern street mouths
  inner.push([0.36, 36.5], [-0.36, 36.5], [0.9, 38], [-0.9, 38]);
  const rp = mulberry(3);
  for (const [a, r] of inner) {
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    tree(k, rp, x, z, { planter: true, trunk: 2.6, crown: 2.3 });
    colliders.push({ x, z, r: 1.45 });
  }

  // ---- the fountain at the centre
  const f = fountain(c, root);
  colliders.push({ x: 0, z: 0, r: 4 });

  const stats = k.build(root);
  root.add(extras);
  root.userData.stats = stats;

  const hands = c.hands;
  return {
    root,
    colliders,
    walls,
    update(t: number, now: Date) {
      f.update(t);
      const h = now.getHours() % 12;
      const m = now.getMinutes();
      const s = now.getSeconds() + now.getMilliseconds() / 1000;
      const hourA = -((h + m / 60) / 12) * TAU;
      const minA = -((m + s / 60) / 60) * TAU;
      for (const hd of hands) {
        hd.hour.rotation.z = hourA;
        hd.minute.rotation.z = minA;
      }
    },
  };
}
