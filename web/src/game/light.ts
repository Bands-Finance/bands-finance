/**
 * THE HOUR. The Exchange is printed at the hour its clock tower shows (UTC, the same sky for every visitor): dawn
 * 05–07 on warm paper with a low sun from the east and long shadows, day 07–18 as the plate is cut, dusk 18–20 on
 * rose paper with the sun low in the west, night 20–05 on a deep blue-grey paper where the hatch stays ink, the
 * contours lighten a shade so every form still parts from the paper, and the town lights itself: the lamps' globes
 * glow with a halo and a pool of light on the ground under each, three windows in five take lamplight, the
 * Exchange's frieze and the banks' porticoes are lit from below, and the clock faces are lit.
 *
 * It writes only the shared engraving uniforms (src/stage/engrave.ts: the paper, the contour ink, the night factor,
 * the light's direction), the scene's fog and clear colour, and the key light's place and strength, so nothing else
 * in the world has to know the hour; a scene that never mounts this (the desk) keeps its daylight. Everything lit
 * is one instanced mesh of quads (the halos billboard, the pools lie flat) drawn only when the night factor is up:
 * one draw call at night, none by day. The windows and globes take no extra draw: they carry a per-instance aLit
 * that the engraving turns to lamplight (engrave.ts ENG_LIT).
 *
 * To mount: mountLight(scene) once the city stands in it (it finds the key light, the ambient, the city's root and
 * the plaza's lamps by itself). The hour can be forced (dev.ts's ?hour=) with { hour } or setHour().
 */
import * as THREE from "three";
import { INK, LAMPLIGHT, litMaterial, PAPER, shared } from "../stage/engrave";
import { hexRgb, mat } from "./engraved";
import { PLACES } from "./town";

export interface LightOpts {
  /** a fixed hour, 0..24 with a fraction; left out, the real UTC hour runs */
  hour?: number;
}

export interface TownLight {
  /** the hour the town is printed at now */
  hour(): number;
  /** force an hour, or null for the real one */
  setHour(h: number | null): void;
  /** 0 by day, 1 at night */
  night(): number;
  dispose(): void;
}

// ---------------------------------------------------------------- the cycle

/** the paper at each turn of the day */
export const PAPER_DAWN = "#f5e0bf";
export const PAPER_DUSK = "#f1cfc2";
export const PAPER_NIGHT = "#4f586b";
/** the contour ink at night: a shade lighter than the hatch, so a form's edge still parts from the dark paper */
export const INK_NIGHT = "#2b2a33";

interface Keyframe {
  h: number;
  paper: string;
  line: string;
  night: number;
  /** where the light comes from (toward it), unnormalised */
  sun: [number, number, number];
  /** a factor on the key light's strength, and on the ambient's */
  keyK: number;
  ambK: number;
}

/**
 * The day's turns, by hour; between two the plate eases from one to the next. The day's sun is World.ts's (-16, 26, 13).
 * A low sun alone would hatch the whole ground (the plate hatches whatever the light leaves below bare paper), so
 * dawn and dusk raise the ambient: the ground stays bare paper and the low sun shows as long shadows across it.
 * The moon keeps the day's strengths, so the night is the tint and the lamps, not a darker hatch.
 */
const TURNS: Keyframe[] = [
  { h: 4.5, paper: PAPER_NIGHT, line: INK_NIGHT, night: 1, sun: [0.3, 0.85, -0.4], keyK: 0.85, ambK: 1 },
  { h: 5.75, paper: PAPER_DAWN, line: INK, night: 0, sun: [0.88, 0.3, 0.32], keyK: 1, ambK: 1.5 },
  { h: 7, paper: PAPER, line: INK, night: 0, sun: [-16, 26, 13], keyK: 1, ambK: 1 },
  { h: 18, paper: PAPER, line: INK, night: 0, sun: [-16, 26, 13], keyK: 1, ambK: 1 },
  { h: 19, paper: PAPER_DUSK, line: INK, night: 0, sun: [-0.9, 0.28, 0.3], keyK: 1, ambK: 1.5 },
  { h: 20.5, paper: PAPER_NIGHT, line: INK_NIGHT, night: 1, sun: [0.3, 0.85, -0.4], keyK: 0.85, ambK: 1 },
];

export interface Printed {
  paper: THREE.Color;
  line: THREE.Color;
  night: number;
  sun: THREE.Vector3;
  keyK: number;
  ambK: number;
}

const rgb = (hex: string) => new THREE.Color().setRGB(...hexRgb(hex), THREE.LinearSRGBColorSpace);
const turns = TURNS.map((t) => ({ ...t, paperC: rgb(t.paper), lineC: rgb(t.line), sunV: new THREE.Vector3(...t.sun).normalize() }));

/** what the plate looks like at an hour of the day (0..24): the two turns either side, eased */
export function printedAt(hour: number, out: Printed): Printed {
  const h = ((hour % 24) + 24) % 24;
  let i = turns.length - 1;
  for (let k = 0; k < turns.length; k++) if (turns[k].h <= h) i = k;
  const a = turns[i];
  const b = turns[(i + 1) % turns.length];
  const span = ((b.h - a.h + 24) % 24) || 24;
  const t0 = ((h - a.h + 24) % 24) / span;
  const t = t0 * t0 * (3 - 2 * t0);
  out.paper.copy(a.paperC).lerp(b.paperC, t);
  out.line.copy(a.lineC).lerp(b.lineC, t);
  out.night = a.night + (b.night - a.night) * t;
  out.sun.copy(a.sunV).lerp(b.sunV, t).normalize();
  out.keyK = a.keyK + (b.keyK - a.keyK) * t;
  out.ambK = a.ambK + (b.ambK - a.ambK) * t;
  return out;
}

/** the hour the tower shows: UTC, with the minutes and seconds as a fraction */
export function utcHour(now = new Date()): number {
  return now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
}

// ---------------------------------------------------------------- the lit things

/** what a quad of the halo mesh is: kind 0 a globe's halo (billboard), 1 a glow rising from a foot (billboard), 2 a pool on the ground (flat) */
type HaloKind = 0 | 1 | 2;
interface Halo {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  kind: HaloKind;
  color: [number, number, number];
}

const GLOW = hexRgb(LAMPLIGHT);
/** a globe lower than this is not a lamp */
const LAMP_MIN_Y = 3;
const GLOW_SOFT: [number, number, number] = [GLOW[0] * 0.9, GLOW[1] * 0.8, GLOW[2] * 0.6];

function haloMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uOn: { value: 0 }, uTime: { value: 0 } }]),
    vertexShader: /* glsl */ `
      attribute vec4 aHalo;
      varying vec2 vQ; varying vec4 vH; varying float vFogDepth; varying float vPhase;
      void main() {
        vQ = position.xy;
        vH = aHalo;
        vec4 c = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vPhase = fract(c.x * 0.37 + c.z * 0.71) * 6.2832;
        vec4 mv;
        if (aHalo.w < 1.5) {
          // a billboard round the instance's centre, the quad's size from the instance's scale, a step toward the
          // eye so the halo sits before the globe it wraps
          vec2 sc = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
          mv = viewMatrix * c;
          mv.xy += position.xy * sc;
          mv.z += 0.45;
        } else {
          mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }
        vFogDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOn; uniform float uTime; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
      varying vec2 vQ; varying vec4 vH; varying float vFogDepth; varying float vPhase;
      void main() {
        float r = length(vQ) * 2.0;
        float a;
        if (vH.w < 0.5) {
          a = pow(clamp(1.0 - r, 0.0, 1.0), 1.8) * 0.75;
        } else if (vH.w < 1.5) {
          // lit from below: brightest at the foot, fading up and out to the sides
          float x = abs(vQ.x) * 2.0;
          float y = vQ.y + 0.5;
          a = (1.0 - smoothstep(0.0, 1.0, x)) * pow(1.0 - y, 1.7) * 0.7;
        } else {
          a = pow(clamp(1.0 - r, 0.0, 1.0), 1.5) * 0.6;
        }
        // a faint flicker, each lamp on its own phase
        float flick = 1.0 - 0.05 * sin(uTime * 9.0 + vPhase) * sin(uTime * 4.3 + vPhase * 2.0);
        float far = 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
        gl_FragColor = vec4(vH.rgb, a * uOn * flick * far);
      }`,
  });
}

/** the halos as one instanced mesh: kinds 0 and 1 billboard in the shader, kind 2 lies flat by its matrix */
function buildHalos(list: Halo[]): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  const attr = new Float32Array(list.length * 4);
  const mesh = new THREE.InstancedMesh(geo, haloMaterial(), list.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  list.forEach((h, i) => {
    m.compose(new THREE.Vector3(h.x, h.y, h.z), h.kind === 2 ? flat : q, new THREE.Vector3(h.w, h.h, 1));
    mesh.setMatrixAt(i, m);
    attr.set([h.color[0], h.color[1], h.color[2], h.kind], i * 4);
  });
  geo.setAttribute("aHalo", new THREE.InstancedBufferAttribute(attr, 4));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = "light:halos";
  mesh.renderOrder = 3;
  return mesh;
}

/** a small fast hash on integers, 0..1 */
function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();

/**
 * Which stretch of façade a window is on: its wall's heading and a 12 m run along it. The city cuts every window of a
 * house in one frame, so a house's windows share the heading; the run parts the houses along a street (a house is
 * about a run wide, so a big one may light in two halves, which reads as two tenants).
 */
function stretchOf(m: THREE.Matrix4): [number, number, number] {
  _p.setFromMatrixPosition(m);
  _x.setFromMatrixColumn(m, 0).setY(0).normalize();
  _z.setFromMatrixColumn(m, 2).setY(0).normalize();
  const heading = Math.round(Math.atan2(_z.x, _z.z) * 50);
  const along = Math.floor(_p.dot(_x) / 12);
  const out = Math.floor(_p.dot(_z) / 6);
  return [heading, along, out];
}

/**
 * Tags the city's window voids (three stretches in five, by a hash of the stretch, so every visitor sees the same
 * houses lit) and its lamps' globes (all) with aLit, on a copy of their geometry so the other pieces cut from the
 * same box are untouched; returns the globes' places and sizes for the halos.
 */
function tagCity(root: THREE.Object3D): { x: number; y: number; z: number; s: number }[] {
  const voids = root.getObjectByName("city:void") as THREE.InstancedMesh | undefined;
  if (voids) {
    const n = voids.count;
    const lit = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      voids.getMatrixAt(i, _m);
      const [h, a, o] = stretchOf(_m);
      lit[i] = hash(h, a, o) < 0.6 ? 1 : 0;
    }
    voids.geometry = voids.geometry.clone();
    voids.geometry.setAttribute("aLit", new THREE.InstancedBufferAttribute(lit, 1));
    litMaterial(voids.material as THREE.Material);
  }
  const globes: { x: number; y: number; z: number; s: number }[] = [];
  const gm = root.getObjectByName("city:globe") as THREE.InstancedMesh | undefined;
  if (gm) {
    const n = gm.count;
    const lit = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      gm.getMatrixAt(i, _m);
      _p.setFromMatrixPosition(_m);
      _x.setFromMatrixColumn(_m, 0);
      // a lamp's globe is up a pole; the same globe at knee height is a finial on the fountain's rim, and stays brass
      if (_p.y < LAMP_MIN_Y) continue;
      lit[i] = 1;
      globes.push({ x: _p.x, y: _p.y, z: _p.z, s: _x.length() });
    }
    gm.geometry = gm.geometry.clone();
    gm.geometry.setAttribute("aLit", new THREE.InstancedBufferAttribute(lit, 1));
    litMaterial(gm.material as THREE.Material);
  }
  return globes;
}

/** the plaza's own lamps (World.ts's ten at r 31): brass spheres of the lamps' size, up a pole, drawn one by one */
function tagPlazaLamps(scene: THREE.Scene, root: THREE.Object3D): { x: number; y: number; z: number; s: number }[] {
  const globes: { x: number; y: number; z: number; s: number }[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
    const g = mesh.geometry as THREE.SphereGeometry;
    if (g.type !== "SphereGeometry" || g.parameters.radius < 0.3 || g.parameters.radius > 0.5 || mesh.material !== mat("Brass")) return;
    mesh.getWorldPosition(_p);
    if (_p.y < LAMP_MIN_Y || _p.y > 6) return;
    let inCity = false;
    mesh.traverseAncestors((p) => {
      if (p === root) inCity = true;
    });
    if (inCity) return;
    if (!g.getAttribute("aLit")) g.setAttribute("aLit", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(1), 1));
    litMaterial(mesh.material as THREE.Material);
    globes.push({ x: _p.x, y: _p.y, z: _p.z, s: 1 });
  });
  return globes;
}

/** the centres of the two clock faces, from the merged clock mesh (its two discs are apart, so their vertices part on the tower's facing) */
function clockFaces(root: THREE.Object3D): THREE.Vector3[] {
  const clock = root.getObjectByName("city:clock") as THREE.Mesh | undefined;
  if (!clock) return [];
  const pos = clock.geometry.getAttribute("position");
  const tower = PLACES.find((p) => p.id === "clock-tower");
  if (!pos || !tower) return [];
  const dir = new THREE.Vector2(Math.sin(tower.facing), Math.cos(tower.facing));
  const sums = [new THREE.Vector3(), new THREE.Vector3()];
  const counts = [0, 0];
  const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) c.add(_p.fromBufferAttribute(pos, i));
  c.divideScalar(pos.count);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    const k = (_p.x - c.x) * dir.x + (_p.z - c.z) * dir.y > 0 ? 0 : 1;
    sums[k].add(_p);
    counts[k]++;
  }
  return sums.filter((_, k) => counts[k] > 0).map((s, k) => s.divideScalar(counts[k]));
}

/** the Exchange's frieze: its band's foot and width, from the merged frieze mesh */
function friezeFoot(root: THREE.Object3D): { x: number; y: number; z: number; w: number } | null {
  const f = root.getObjectByName("city:frieze") as THREE.Mesh | undefined;
  if (!f) return null;
  f.geometry.computeBoundingBox();
  const b = f.geometry.boundingBox!;
  return { x: (b.min.x + b.max.x) / 2, y: b.min.y, z: (b.min.z + b.max.z) / 2, w: b.max.x - b.min.x };
}

// ---------------------------------------------------------------- mounting

const SUN_M = 40;

export function mountLight(scene: THREE.Scene, opts: LightOpts = {}): TownLight {
  let key: THREE.DirectionalLight | null = null;
  let ambient: THREE.AmbientLight | null = null;
  scene.traverse((o) => {
    const l = o as THREE.Light;
    if ((l as THREE.DirectionalLight).isDirectionalLight && l.castShadow) key = l as THREE.DirectionalLight;
    if ((l as THREE.AmbientLight).isAmbientLight) ambient = l as THREE.AmbientLight;
  });
  const keyLight = key as THREE.DirectionalLight | null;
  const amb = ambient as THREE.AmbientLight | null;
  const keyBase = keyLight?.intensity ?? 1;
  const ambBase = amb?.intensity ?? 1;
  const city = scene.getObjectByName("city") ?? scene;

  // what glows: every globe, a pool under every post, the faces, the frieze and the porticoes
  const globes = [...tagCity(city), ...tagPlazaLamps(scene, city)];
  const halos: Halo[] = [];
  const posts = new Map<string, { x: number; z: number }>();
  for (const g of globes) {
    halos.push({ x: g.x, y: g.y, z: g.z, w: 2.6 * g.s, h: 2.6 * g.s, kind: 0, color: GLOW });
    posts.set(`${Math.round(g.x)}:${Math.round(g.z)}`, { x: g.x, z: g.z });
  }
  for (const p of posts.values()) halos.push({ x: p.x, y: 0.06, z: p.z, w: 7.5, h: 7.5, kind: 2, color: GLOW_SOFT });
  for (const c of clockFaces(city)) halos.push({ x: c.x, y: c.y, z: c.z, w: 6.5, h: 6.5, kind: 0, color: GLOW_SOFT });
  const frieze = friezeFoot(city);
  if (frieze) {
    const toPlaza = new THREE.Vector2(-frieze.x, -frieze.z).normalize();
    for (const k of [-0.3, 0, 0.3]) {
      halos.push({ x: frieze.x + k * frieze.w + toPlaza.x * 0.4, y: frieze.y - 0.4 + 2.2, z: frieze.z + toPlaza.y * 0.4, w: frieze.w * 0.42, h: 4.4, kind: 1, color: GLOW_SOFT });
    }
  }
  for (const p of PLACES) {
    if (p.kind !== "bank") continue;
    // the columns stand about 3.5 m behind the door at the foot of the steps; a glow rises up each side of the portico
    const dx = Math.sin(p.facing), dz = Math.cos(p.facing);
    const cx = p.x - dx * 3.4, cz = p.z - dz * 3.4;
    for (const s of [-2.6, 2.6]) halos.push({ x: cx + dz * s, y: 4.2, z: cz - dx * s, w: 6, h: 8.4, kind: 1, color: GLOW_SOFT });
  }
  const haloMesh = buildHalos(halos);
  haloMesh.visible = false;
  scene.add(haloMesh);
  const haloU = haloMesh.material as THREE.ShaderMaterial;

  const fog = scene.fog as THREE.Fog | null;
  const printed: Printed = { paper: new THREE.Color(), line: new THREE.Color(), night: 0, sun: new THREE.Vector3(), keyK: 1, ambK: 1 };
  let forced: number | null = opts.hour ?? null;
  let hourNow = forced ?? utcHour();
  const t0 = performance.now();

  const before = scene.onBeforeRender;
  scene.onBeforeRender = (...args) => {
    before.apply(scene, args);
    const renderer = args[0];
    hourNow = forced ?? utcHour();
    printedAt(hourNow, printed);
    shared.uPaper.value.set(printed.paper.r, printed.paper.g, printed.paper.b);
    shared.uInk.value.set(printed.line.r, printed.line.g, printed.line.b);
    shared.uNight.value = printed.night;
    shared.uLightDir.value.copy(printed.sun);
    if (fog) fog.color.copy(printed.paper);
    renderer.setClearColor(printed.paper, 1);
    if (keyLight) {
      // the sun stands off the key's target (World.ts keeps that on you) in the hour's direction; the world's own
      // matrices were brought up to date before this hook, so the light's is redone here
      keyLight.position.copy(keyLight.target.position).addScaledVector(printed.sun, SUN_M);
      keyLight.updateMatrixWorld();
      keyLight.intensity = keyBase * printed.keyK;
    }
    if (amb) amb.intensity = ambBase * printed.ambK;
    // the lamps come on as the dusk deepens, before the paper is fully dark
    const lamps = THREE.MathUtils.smoothstep(printed.night, 0.02, 0.55);
    haloMesh.visible = lamps > 0;
    haloU.uniforms.uOn.value = lamps;
    haloU.uniforms.uTime.value = (performance.now() - t0) / 1000;
  };

  return {
    hour: () => hourNow,
    setHour(h) {
      forced = h;
    },
    night: () => printed.night,
    dispose() {
      scene.onBeforeRender = before;
      scene.remove(haloMesh);
      haloMesh.geometry.dispose();
      haloU.dispose();
      const day = printedAt(12, printed);
      shared.uPaper.value.set(day.paper.r, day.paper.g, day.paper.b);
      shared.uInk.value.set(day.line.r, day.line.g, day.line.b);
      shared.uNight.value = 0;
      shared.uLightDir.value.copy(day.sun);
      if (fog) fog.color.copy(day.paper);
      if (keyLight) keyLight.intensity = keyBase;
      if (amb) amb.intensity = ambBase;
    },
  };
}
