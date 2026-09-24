/**
 * The Exchange's shared drawing kit: every module that puts something in the plaza (World.ts, figure.ts, city.ts)
 * draws with these, so the whole place is one engraving (src/stage/engrave.ts: ink lines on paper, one contour round
 * every form). Materials are cached by name; part() is a mesh with its contour that casts and takes shadows.
 */
import * as THREE from "three";
import { engraveMaterial, outlineMaterial, SPECS, PAPER, INK } from "../stage/engrave";

export { PAPER, INK };


export const matCache = new Map<string, THREE.MeshLambertMaterial>();
export function mat(name: keyof typeof SPECS | string, half?: THREE.Vector3): THREE.MeshLambertMaterial {
  const key = half ? `${name}:${half.toArray().join(",")}` : String(name);
  let m = matCache.get(key);
  if (!m) {
    m = engraveMaterial({ ...(SPECS[name] ?? SPECS.Paper), ...(half ? { half } : {}) });
    matCache.set(key, m);
  }
  return m;
}
export const OUTLINE = outlineMaterial(1.3);
export const OUTLINE_FINE = outlineMaterial(0.9);

/** a mesh in an engraved material, with its contour, casting and taking shadows */
export function part(geo: THREE.BufferGeometry, material: THREE.Material, fine = false): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = true;
  m.add(new THREE.Mesh(geo, fine ? OUTLINE_FINE : OUTLINE));
  return m;
}

export function flat(hex: string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...hexRgb(hex), THREE.LinearSRGBColorSpace) });
}

export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** a printed sign: paper, an ink rule, words in the house faces, drawn to a canvas */
export function signTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = INK;
  g.lineWidth = Math.max(4, w / 160);
  g.strokeRect(g.lineWidth, g.lineWidth, w - 2 * g.lineWidth, h - 2 * g.lineWidth);
  g.lineWidth = Math.max(1.5, w / 480);
  const inset = w / 40;
  g.strokeRect(inset, inset, w - 2 * inset, h - 2 * inset);
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export const SERIF = '"Fraunces", Georgia, serif';
export const CAPS = '"Cormorant SC", Georgia, serif';

export function fitText(g: CanvasRenderingContext2D, text: string, font: (px: number) => string, maxW: number, px: number): number {
  let size = px;
  g.font = font(size);
  while (g.measureText(text).width > maxW && size > 10) {
    size -= 2;
    g.font = font(size);
  }
  return size;
}

/** a name tag or a speech bubble above a head */
export function labelSprite(text: string, opts: { bubble?: boolean } = {}): THREE.Sprite {
  const px = 44;
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  g.font = `600 ${px}px ${opts.bubble ? SERIF : CAPS}`;
  const tw = Math.ceil(g.measureText(text).width);
  c.width = tw + 48;
  c.height = px + 34;
  g.font = `600 ${px}px ${opts.bubble ? SERIF : CAPS}`;
  g.fillStyle = opts.bubble ? PAPER : "rgba(243,236,221,0.92)";
  g.strokeStyle = INK;
  g.lineWidth = 3;
  const r = 14;
  g.beginPath();
  g.roundRect(2, 2, c.width - 4, c.height - 4, r);
  g.fill();
  g.stroke();
  g.fillStyle = INK;
  g.textBaseline = "middle";
  g.fillText(text, 24, c.height / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true, transparent: true }));
  const k = opts.bubble ? 0.0085 : 0.0068;
  s.scale.set(c.width * k, c.height * k, 1);
  s.renderOrder = 10;
  return s;
}

