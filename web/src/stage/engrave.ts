import * as THREE from "three";

/**
 * THE ENGRAVING. Every surface in the desk scene is drawn the way a banknote plate is cut: parallel ink
 * lines on paper whose WEIGHT carries the tone (thin in the light, swelling in shade, a second set crossing
 * them in shadow), the highlights left as bare paper, and one ink contour round every form.
 *
 * It rides on three's Lambert material so the lights and the shadow map are three's own; the end of the
 * fragment shader throws the colour away, keeps the luminance and redraws it as lines. The lines are cut
 * in WORLD space (horizontal slices on upright faces, so a stack of notes shows its edges and a hat its
 * rings; diagonals on level faces), so they stay on the objects when the camera moves. Their pitch is
 * chosen per pixel to stay a few pixels apart at any distance, and new lines grow in between the old
 * ones as the camera closes in, so there is never a jump.
 *
 * The renderer runs with a linear output colour space: the colours below are display colours, written as is.
 */

export type EngraveKind = "plain" | "bill" | "page" | "tape" | "accent" | "stripe";

export interface EngraveSpec {
  /** how dark the material is in full light: 1 is bare paper, 0.1 is nearly solid ink */
  tone: number;
  kind?: EngraveKind;
  /** a drawn highlight for metal: bare paper where the light glances */
  shine?: number;
  /** how tight that highlight is: the specular exponent, 28 by default (a pin of light on brass); a lower number spreads it into the broad soft glow of polished leather */
  gloss?: number;
  /** a factor on the line pitch: 1 is the plate's pitch, 0.9 cuts this material's lines a tenth closer (finer, more of them per form) */
  pitch?: number;
}

/** The contract with web/3d/build_desk.py: its material names. */
export const SPECS: Record<string, EngraveSpec> = {
  Paper: { tone: 1.0 },
  Ground: { tone: 1.0 },
  Bill: { tone: 0.98, kind: "bill" },
  Page: { tone: 1.0, kind: "page" },
  // the materials that carry small forms (his skin, his clothes, the ink things) are cut a touch finer than the plate.
  // Ivory sits a shade below bare paper so that skin carries a light hatch even in full light: the Paper parts against
  // it (his moustache, his hair, his shirt) then read as white at hero distance instead of merging with the face
  Ivory: { tone: 0.9, pitch: 0.92 },
  Tape: { tone: 1.0, kind: "tape" },
  Felt: { tone: 0.99 },
  Brass: { tone: 0.74, shine: 1 },
  Wood: { tone: 0.6 },
  // Ink is the coat, the hat and the shoes: a touch lighter and much less glossy than a metal, so the folds of the coat
  // read as gradations of line weight rather than a black mass cut by white bars where the light glances
  Ink: { tone: 0.3, shine: 0.3, pitch: 0.95 },
  // the figure's Ink (DeskStage picks it for Fig.* meshes): lighter and matter still, so the coat hatches as cloth
  FigInk: { tone: 0.36, shine: 0.22, pitch: 0.95 },
  Cloth: { tone: 0.5, pitch: 0.92 },
  Stripe: { tone: 0.55, kind: "stripe", pitch: 0.92 },
  /** polished leather (the figure's shoes): dark but not solid (a tone above 0.42 keeps the lit leather to one set of lines, so the
   *  cross-hatch is left for the shade under the welt), with a broad soft highlight (a low gloss spreads the lobe) so the toe and vamp
   *  are left as paper where the light glances, the way an engraver draws a shine on a boot; DeskStage keeps this material on Fig.* meshes */
  Shoe: { tone: 0.3, shine: 1.0, gloss: 12, pitch: 0.95 },
  Chip: { tone: 0.46 },
  Strap: { tone: 0.95, kind: "accent" },
  /** the cigar's burn line: a hairline of char sunk between wrapper and ash, so it prints as a dark seam and not a second band */
  Ember: { tone: 0.3, pitch: 0.8, shine: 0 },
  /** the figure's hat: Ink's colour, but matte and cut finer, so the brim's top never engraves near-white */
  Hat: { tone: 0.3, shine: 0.04, pitch: 0.85 },
};

const v3 = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export const PAPER = "#f3ecdd";
export const INK = "#16120f";
export const ORANGE = "#ff7a1a";
const ORANGE_INK = "#8f3a06";

/** Shared by every engraved material so one write moves them all. */
export const shared = {
  uPaper: { value: v3(PAPER) },
  uInk: { value: v3(INK) },
  uAccent: { value: v3(ORANGE) },
  uAccentInk: { value: v3(ORANGE_INK) },
  uLightDir: { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
  /** the target distance between lines, in device pixels */
  uPitch: { value: 5.0 },
  /** 0..1, fades the whole plate toward bare paper (used while the stage boots) */
  uFade: { value: 0 },
  /** how far the ticker has fed its tape, in tape widths */
  uFeed: { value: 0 },
};

const KIND_ID: Record<EngraveKind, number> = { plain: 0, bill: 1, page: 2, tape: 3, accent: 4, stripe: 5 };

const VERT_PARS = /* glsl */ `
varying vec3 vEngWP;
varying vec3 vEngWN;
varying vec3 vEngLP;
varying vec2 vEngUV;
`;

const VERT_MAIN = /* glsl */ `
{
  vec4 engP = vec4(transformed, 1.0);
  vec3 engN = objectNormal;
  #ifdef USE_INSTANCING
    engP = instanceMatrix * engP;
    engN = mat3(instanceMatrix) * engN;
  #endif
  vEngWP = (modelMatrix * engP).xyz;
  vEngWN = normalize(mat3(modelMatrix) * engN);
  vEngLP = position;
  #ifdef ENG_HAS_UV
    vEngUV = uv;
  #else
    vEngUV = vec2(0.0);
  #endif
}
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vEngWP;
varying vec3 vEngWN;
varying vec3 vEngLP;
varying vec2 vEngUV;
uniform vec3 uPaper;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform vec3 uAccentInk;
uniform vec3 uLightDir;
uniform float uPitch;
uniform float uFade;
uniform float uFeed;
uniform float uTone;
uniform float uShine;
uniform float uGloss;   // the specular exponent: how tight the drawn highlight is
uniform float uPitchK;  // this material's factor on uPitch
uniform int uKind;
uniform vec3 uHalf;   // the prototype's half extents, for the bill and page drawing

// One family of parallel lines along the coordinate c. cover is the share of the paper the ink takes.
// The pitch follows the pixel: lines at f always, the ones in between growing in as the camera closes.
float engLines(float c, float cover) {
  float px = max(fwidth(c), 1e-6);              // world units per pixel along c
  float lf = log2(1.0 / (px * uPitch * uPitchK)); // log2 of the wanted lines per unit
  float f0 = exp2(floor(lf));
  float t = fract(lf);
  float x = c * f0;
  float aa = px * f0 * 1.2;
  float even = abs(fract(x) - 0.5) * 2.0;       // 1 on an old line, 0 between
  float odd = abs(fract(x + 0.5) - 0.5) * 2.0;  // 1 on a new line
  float wE = clamp(cover * (2.0 - t) * 0.5, 0.0, 0.98);
  float wO = clamp(cover * t * 0.5, 0.0, 0.98);
  float a = smoothstep(1.0 - wE - aa, 1.0 - wE + aa, even) * smoothstep(0.0, 0.035, wE);
  float b = smoothstep(1.0 - wO - aa, 1.0 - wO + aa, odd) * smoothstep(0.0, 0.035, wO);
  return max(a, b);
}

float engRect(vec2 p, vec2 h) { vec2 d = abs(p) - h; return max(d.x, d.y); }
`;

const FRAG_MAIN = /* glsl */ `
{
  vec3 lit = gl_FragColor.rgb;
  float L = clamp(dot(lit, vec3(0.3333)), 0.0, 1.0);
  vec3 N = normalize(vEngWN);
  vec3 V = normalize(cameraPosition - vEngWP);
  float spec = pow(max(dot(N, normalize(uLightDir + V)), 0.0), uGloss) * uShine;
  float tone = clamp(L * uTone + spec * 0.9, 0.0, 1.0);
  float dark = 1.0 - tone;

  // which way the lines are cut: slices across upright faces, diagonals on level ones
  float level = smoothstep(0.72, 0.9, abs(N.y));
  float cSide = vEngWP.y;
  float cTop = (vEngWP.x + vEngWP.z) * 0.70711;
  float xSide = (vEngWP.x - vEngWP.z) * 0.5 + vEngWP.y * 0.70711;
  float xTop = (vEngWP.x - vEngWP.z) * 0.70711;

  float cover1 = clamp((dark - 0.05) * 1.05, 0.0, 0.8);
  float cover2 = clamp((dark - 0.58) * 1.5, 0.0, 0.62);
  float l1 = mix(engLines(cSide, cover1), engLines(cTop, cover1), level);
  float l2 = cover2 > 0.0 ? mix(engLines(xSide, cover2), engLines(xTop, cover2), level) : 0.0;
  float ink = max(l1, l2);

  vec3 paper = uPaper;
  vec3 inkCol = uInk;

  if (uKind == 1) {
    // a banknote seen from above: a ruled border and an oval, drawn in the prototype's own space
    if (N.y > 0.8) {
      vec2 p = vEngLP.xz / uHalf.xz;                         // -1..1 across the note
      float pxl = fwidth(p.x) + fwidth(p.y);
      float border = abs(engRect(p, vec2(0.86, 0.9)));
      float inner = abs(engRect(p, vec2(0.78, 0.86)));
      float lineB = 1.0 - smoothstep(0.0, pxl * 1.1, border - 0.012);
      float lineI = 1.0 - smoothstep(0.0, pxl * 0.9, inner - 0.004);
      ink = max(ink, max(lineB, lineI * 0.7));
    }
  } else if (uKind == 2) {
    // a ledger page: feint rules and a margin
    if (N.y > 0.8) {
      float q = vEngLP.z * 5.2;
      float r = abs(fract(q) - 0.5) * 2.0;                   // 1 on a rule, 0 between
      float pxl = fwidth(q) * 2.0;
      float rule = smoothstep(0.94 - pxl, 0.94 + pxl, r) * step(abs(vEngLP.x), uHalf.x * 0.86) * step(abs(vEngLP.z), uHalf.z * 0.9);
      ink = max(ink, rule * 0.5);
    }
  } else if (uKind == 3) {
    // ticker tape: two edge rules and the printed characters down the middle
    float u = vEngUV.x, v = vEngUV.y - uFeed;
    float pu = fwidth(u);
    float edge = 1.0 - smoothstep(0.035, 0.035 + pu * 1.5, min(u, 1.0 - u));
    float cell = fract(v * 1.15);
    float word = step(0.18, fract(v * 0.16));
    float glyph = step(0.22, cell) * step(cell, 0.78) * step(0.34, u) * step(u, 0.66) * word;
    float bar = step(0.5, fract(sin(floor(v * 1.15) * 91.7) * 43758.5)) ;
    glyph *= mix(0.55, 1.0, bar);
    ink = max(max(ink * 0.6, edge), glyph * 0.9);
  } else if (uKind == 5) {
    // pinstripes: cut round each trouser leg's own axis. build_desk.py lays a cylindrical UV per leg (u round the
    // leg, v its height), so the stripes hang straight down a leg however it tilts or curves; 24 hairlines round a leg,
    // each a seventh of its period, the antialias band widening with the pixel so they soften at hero distance
    float q = vEngUV.x * 24.0;
    float r = abs(fract(q) - 0.5) * 2.0;
    float w = min(fwidth(q) * 1.6, 0.25);
    float stripe = smoothstep(0.86 - w, 0.86 + w, r) * (1.0 - level);
    // a stripe on a surface turned away from the eye is foreshortened to nothing: fade it with the facing
    stripe *= smoothstep(0.15, 0.5, abs(dot(N, V)));
    // the sheet's trousers are DARK cloth with WHITE pinstripes: a stripe is a paper hairline cut through the hatch
    ink *= 1.0 - stripe * 0.9;
  }

  vec3 col;
  if (uKind == 4) {
    col = mix(uAccent, uAccentInk, ink * 0.85);
  } else {
    col = mix(paper, inkCol, ink);
  }
  col = mix(col, uPaper, uFade);
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface EngraveOptions extends EngraveSpec {
  /** half extents of the prototype in its local space, for the bill and the page */
  half?: THREE.Vector3;
  hasUv?: boolean;
  doubleSide?: boolean;
  /** a further factor on the pitch for this one material instance (the figure's copies of the desk's materials are finer still) */
  pitchScale?: number;
}

export function engraveMaterial(opts: EngraveOptions): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide });
  const own = {
    uTone: { value: opts.tone },
    uShine: { value: opts.shine ?? 0 },
    uGloss: { value: opts.gloss ?? 28 },
    uPitchK: { value: (opts.pitch ?? 1) * (opts.pitchScale ?? 1) },
    uKind: { value: KIND_ID[opts.kind ?? "plain"] },
    uHalf: { value: opts.half ?? new THREE.Vector3(1, 1, 1) },
  };
  m.defines = { ...(m.defines ?? {}), ...(opts.hasUv ? { ENG_HAS_UV: "" } : {}) };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, own);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
      .replace("#include <dithering_fragment>", `#include <dithering_fragment>\n${FRAG_MAIN}`);
  };
  // one program per kind/uv combination is enough; the tone and the rest are uniforms
  m.customProgramCacheKey = () => `engrave:${opts.hasUv ? 1 : 0}`;
  m.userData.engrave = own;
  return m;
}

/**
 * The contour: the same geometry drawn again inside out and pushed along its normals by a width in
 * PIXELS, so every form sits inside one even ink line whatever its distance.
 */
export function outlineMaterial(widthPx = 1.5): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uInk: shared.uInk, uPaper: shared.uPaper, uFade: shared.uFade, uWidth: { value: widthPx }, uRes: outlineRes },
    vertexShader: /* glsl */ `
      uniform float uWidth; uniform vec2 uRes;
      void main() {
        vec4 p = vec4(position, 1.0); vec3 n = normal;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p; n = mat3(instanceMatrix) * n;
        #endif
        vec4 mv = modelViewMatrix * p;
        vec4 clip = projectionMatrix * mv;
        vec3 nv = normalize(normalMatrix * n);
        vec2 dir = normalize((projectionMatrix * vec4(nv, 0.0)).xy + vec2(1e-6));
        clip.xy += dir * (uWidth * 2.0 / uRes) * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uInk; uniform vec3 uPaper; uniform float uFade;
      void main() { gl_FragColor = vec4(mix(uInk, uPaper, uFade), 1.0); }`,
  });
}
export const outlineRes = { value: new THREE.Vector2(1440, 900) };

/** Glass: nothing but a rim line and a few glancing strokes, so what is under the dome stays readable. */
export function glassMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    uniforms: { uInk: shared.uInk, uPaper: shared.uPaper, uFade: shared.uFade, uPitch: shared.uPitch, uLightDir: shared.uLightDir },
    vertexShader: /* glsl */ `
      varying vec3 vWP; varying vec3 vWN;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWP = w.xyz; vWN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      varying vec3 vWP; varying vec3 vWN;
      uniform vec3 uInk; uniform vec3 uPaper; uniform float uFade; uniform float uPitch; uniform vec3 uLightDir;
      void main() {
        vec3 N = normalize(vWN); vec3 V = normalize(cameraPosition - vWP);
        float fres = pow(1.0 - abs(dot(N, V)), 2.2);
        float rim = smoothstep(0.62, 0.8, fres);
        float c = vWP.y; float px = max(fwidth(c), 1e-6);
        float f0 = exp2(floor(log2(1.0 / (px * uPitch * 1.6))));
        float even = abs(fract(c * f0) - 0.5) * 2.0;
        float w = clamp(fres * 0.9 - 0.12, 0.0, 0.6);
        float ln = smoothstep(1.0 - w - px * f0, 1.0 - w + px * f0, even);
        float glint = pow(max(dot(N, normalize(uLightDir + V)), 0.0), 60.0);
        float a = max(rim, ln * 0.85);
        vec3 col = mix(uInk, uPaper, uFade);
        gl_FragColor = vec4(col, max(a, glint * 0.0) * (1.0 - uFade));
      }`,
  });
}
