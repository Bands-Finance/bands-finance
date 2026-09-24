/**
 * THE BANDS EXCHANGE (bands.finance Play, 24 Sep): a plaza you walk, drawn as an engraving like mrbands.finance's desk
 * (src/stage/engrave.ts: every surface ink lines on paper, one contour round every form). Four landmarks: the Pools
 * Board (the live top pools) with a stall for each of the first four, Mr Bands at his desk, the Guard House (his rules)
 * and the Notice Board (his build notes).
 *
 * This file is the engine only: scene, avatars, input, camera, collisions and the spots you can use. It knows nothing
 * of React, the network or the mini-game; it reports where you are (onMove) and what you stand near (onNear), and the
 * page (src/components/PlayPage.tsx) opens the panels. Remote visitors are driven through addRemote/moveRemote.
 */
import * as THREE from "three";
import { outlineRes, shared, SPECS } from "../stage/engrave";
import { CAPS, fitText, flat, hexRgb, INK, labelSprite, mat, OUTLINE_FINE, PAPER, part, SERIF, signTexture } from "./engraved";
import { STRAPS, WORLD_RADIUS } from "./protocol";

export type SpotKind = "desk" | "stall" | "guards" | "notes";

export interface Spot {
  id: string;
  kind: SpotKind;
  x: number;
  z: number;
  /** how close you must stand, metres */
  r: number;
  prompt: string;
  /** for a stall: the pool's label */
  pool?: string;
}

export interface BoardRow {
  label: string;
  /** fees over the last hour as a share of liquidity, percent */
  feePct: number;
  venue: string;
}

export interface WorldCallbacks {
  onNear(spot: Spot | null): void;
  onMove(x: number, z: number, ry: number, moving: boolean): void;
  onInteract(spot: Spot): void;
  /** frames per second, sampled about once a second (for the quality step-down) */
  onFps?(fps: number): void;
}

interface Walker {
  root: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  tag: THREE.Sprite | null;
  bubble: THREE.Sprite | null;
  bubbleUntil: number;
  /** where the network last put a remote walker (it eases toward it) */
  target: THREE.Vector3;
  targetRy: number;
  moving: boolean;
  phase: number;
}

const SPAWN = new THREE.Vector3(0, 0, 20);
const WALK = 4.4;
const SPRINT = 7.2;
/** the camera looks at a point this high above your feet: above the head, so tall signs stay in frame */
const EYE = 2.4;

/** colliders: circles on the ground the walker is pushed out of */
interface Circle {
  x: number;
  z: number;
  r: number;
}

/** a wall: an axis-aligned rectangle on the ground (the board is long and thin: circles let you slip between them) */
interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

// ---------------------------------------------------------------- the walker

/** a visitor in a top hat and a long coat, the hat's strap in their colour */
function makeWalker(strapHex: string): Walker {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const leg = (x: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.92, 0);
    const l = part(new THREE.CylinderGeometry(0.11, 0.1, 0.9, 10), mat("Ink"), true);
    l.position.y = -0.45;
    const shoe = part(new THREE.BoxGeometry(0.2, 0.1, 0.34), mat("Shoe"), true);
    shoe.position.set(0, -0.88, 0.06);
    pivot.add(l, shoe);
    body.add(pivot);
    return pivot;
  };
  const legL = leg(-0.14);
  const legR = leg(0.14);
  const coat = part(new THREE.CylinderGeometry(0.3, 0.44, 1.05, 14), mat("Ink"), true);
  coat.position.y = 1.35;
  const collar = part(new THREE.CylinderGeometry(0.16, 0.26, 0.14, 12), mat("Paper"), true);
  collar.position.y = 1.9;
  const head = part(new THREE.SphereGeometry(0.26, 18, 14), mat("Ivory"), true);
  head.position.y = 2.12;
  const brim = part(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 20), mat("Hat"), true);
  brim.position.y = 2.33;
  const crown = part(new THREE.CylinderGeometry(0.27, 0.29, 0.52, 18), mat("Hat"), true);
  crown.position.y = 2.61;
  const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.296, 0.296, 0.12, 18), flat(strapHex));
  strap.position.y = 2.43;
  const tie = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.05), flat(strapHex));
  tie.position.set(0, 1.93, 0.25);
  body.add(coat, collar, head, brim, crown, strap, tie);
  return { root, legL, legR, tag: null, bubble: null, bubbleUntil: 0, target: new THREE.Vector3(), targetRy: 0, moving: false, phase: 0 };
}

// ---------------------------------------------------------------- the world

export class ExchangeWorld {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
  private key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.74);
  private me: Walker;
  private meRy = Math.PI;
  private remotes = new Map<string, Walker>();
  private colliders: Circle[] = [];
  private walls: Box[] = [];
  private spots: Spot[] = [];
  private near: Spot | null = null;
  private keys = new Set<string>();
  private joy = new THREE.Vector2();
  private yaw = 0;
  private pitch = 0.26;
  private dist = 9.5;
  private dragging: { x: number; y: number; id: number } | null = null;
  private raf = 0;
  private last = performance.now();
  private fpsFrames = 0;
  private fpsSince = performance.now();
  private boardMesh: THREE.Mesh | null = null;
  private noticeMesh: THREE.Mesh | null = null;
  private stallSigns: THREE.Mesh[] = [];
  private npc: Walker | null = null;
  private moved = false;
  private disposed = false;
  private dprCap: number;
  private ro: ResizeObserver;
  paused = false;

  constructor(private canvas: HTMLCanvasElement, private cb: WorldCallbacks) {
    const small = Math.min(window.innerWidth, window.innerHeight) < 700;
    this.dprCap = small ? 1.4 : 1.75;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(new THREE.Color().setRGB(...hexRgb(PAPER), THREE.LinearSRGBColorSpace), 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.fog = new THREE.Fog(new THREE.Color().setRGB(...hexRgb(PAPER), THREE.LinearSRGBColorSpace), 70, 150);

    this.scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.47));
    this.key.position.set(-16, 26, 13);
    this.key.castShadow = true;
    const sc = this.key.shadow.camera;
    sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 2; sc.far = 90;
    this.key.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.05;
    this.scene.add(this.key, this.key.target);
    const fill = new THREE.DirectionalLight(0xffffff, Math.PI * 0.16);
    fill.position.set(8, 6, 40);
    this.scene.add(fill);
    shared.uLightDir.value.copy(this.key.position).normalize();
    shared.uFade.value = 0;

    this.buildPlaza();
    this.me = makeWalker(STRAPS[0]);
    this.me.root.position.copy(SPAWN);
    this.me.root.rotation.y = this.meRy;
    this.scene.add(this.me.root);
    this.yaw = this.meRy + Math.PI;

    this.bindInput();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- building the plaza

  private buildPlaza() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat("Ground"));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // paving: ink rings like the plate's engraved border
    const ink = flat(INK);
    for (const [r, w] of [[8, 0.07], [16, 0.05], [26, 0.05], [WORLD_RADIUS - 1.5, 0.12], [WORLD_RADIUS - 1.1, 0.05]] as const) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - w, r + w, 128), ink);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.012;
      this.scene.add(ring);
    }
    // the rope and posts round the edge
    const posts = 44;
    const postGeo = new THREE.CylinderGeometry(0.16, 0.22, 1.1, 10);
    const ropeGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
    for (let i = 0; i < posts; i++) {
      const a = (i / posts) * Math.PI * 2;
      const r = WORLD_RADIUS;
      const p = part(postGeo, mat("Brass"));
      p.position.set(Math.sin(a) * r, 0.55, Math.cos(a) * r);
      this.scene.add(p);
      const a2 = ((i + 1) / posts) * Math.PI * 2;
      const x1 = Math.sin(a) * r, z1 = Math.cos(a) * r, x2 = Math.sin(a2) * r, z2 = Math.cos(a2) * r;
      const len = Math.hypot(x2 - x1, z2 - z1);
      const rope = new THREE.Mesh(ropeGeo, mat("Ink"));
      rope.scale.y = len;
      rope.position.set((x1 + x2) / 2, 0.95, (z1 + z2) / 2);
      // the cylinder stands on y: turn y onto the span between the two posts
      rope.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x2 - x1, 0, z2 - z1).normalize());
      this.scene.add(rope);
    }

    this.buildBoard();
    this.buildStalls();
    this.buildGuardHouse();
    this.buildNoticeBoard();
    this.buildDesk();
    this.buildDecor();
  }

  /** the Pools Board: a tall printed billboard of the live top pools */
  private buildBoard() {
    const g = new THREE.Group();
    g.position.set(0, 0, -20);
    for (const x of [-7.4, 7.4]) {
      const post = part(new THREE.BoxGeometry(0.6, 9.5, 0.6), mat("Wood"));
      post.position.set(x, 4.75, 0);
      g.add(post);
    }
    const frame = part(new THREE.BoxGeometry(15.4, 7.6, 0.5), mat("Wood"));
    frame.position.set(0, 5.6, 0);
    g.add(frame);
    this.boardMesh = new THREE.Mesh(new THREE.PlaneGeometry(14.6, 6.8), new THREE.MeshBasicMaterial({ map: this.boardTexture([]) }));
    this.boardMesh.position.set(0, 5.6, 0.26);
    g.add(this.boardMesh);
    const cap = part(new THREE.BoxGeometry(16.2, 0.5, 1), mat("Wood"));
    cap.position.set(0, 9.6, 0);
    g.add(cap);
    const strap = part(new THREE.BoxGeometry(16.25, 0.32, 1.02), mat("Strap"));
    strap.position.set(0, 9.6, 0);
    g.add(strap);
    this.scene.add(g);
    this.walls.push({ x0: -7.9, z0: -20.5, x1: 7.9, z1: -19.5 });
  }

  private boardTexture(rows: BoardRow[]): THREE.CanvasTexture {
    return signTexture(1600, 745, (g, w, h) => {
      g.fillStyle = "#c9560a";
      g.font = `700 34px ${CAPS}`;
      g.fillText("HOT NOW · EVERY TWO MINUTES", 70, 92);
      g.fillStyle = INK;
      g.font = `600 72px ${SERIF}`;
      g.fillText("Where the fees are this hour.", 70, 172);
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(70, 205);
      g.lineTo(w - 70, 205);
      g.stroke();
      const show = rows.slice(0, 8);
      if (!show.length) {
        g.font = `italic 400 40px ${SERIF}`;
        g.fillStyle = "#6f665b";
        g.fillText("Reading the board…", 70, 290);
        return;
      }
      show.forEach((r, i) => {
        const col = i < 4 ? 0 : 1;
        const row = i % 4;
        const x = 70 + col * ((w - 140) / 2);
        const y = 270 + row * 112;
        g.fillStyle = "#6f665b";
        g.font = `500 36px ${SERIF}`;
        g.fillText(String(i + 1).padStart(2, "0"), x, y);
        g.fillStyle = INK;
        fitText(g, r.label, (px) => `600 ${px}px ${SERIF}`, 420, 46);
        g.fillText(r.label, x + 70, y);
        g.fillStyle = "#c9560a";
        g.font = `600 44px ${SERIF}`;
        g.fillText(`${r.feePct.toFixed(3)}%`, x + 520, y);
        g.fillStyle = "#6f665b";
        g.font = `600 22px ${CAPS}`;
        g.fillText(`${r.venue.toUpperCase()} · FEES / LIQUIDITY, LAST HOUR`, x + 70, y + 36);
      });
    });
  }

  /** four stalls in an arc before the board, one per top pool: walk up and lay a band */
  private buildStalls() {
    const places: [number, number, number][] = [[-10.5, -9, 0.45], [-3.6, -11, 0.12], [3.6, -11, -0.12], [10.5, -9, -0.45]];
    places.forEach(([x, z, ry], i) => {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = ry;
      const counter = part(new THREE.BoxGeometry(3.2, 1.1, 1.3), mat("Wood"));
      counter.position.y = 0.55;
      const top = part(new THREE.BoxGeometry(3.4, 0.12, 1.5), mat("Felt"));
      top.position.y = 1.16;
      g.add(counter, top);
      for (const px of [-1.5, 1.5]) {
        const pole = part(new THREE.CylinderGeometry(0.07, 0.07, 2.4, 8), mat("Brass"));
        pole.position.set(px, 2.3, -0.55);
        g.add(pole);
      }
      const awning = part(new THREE.BoxGeometry(3.6, 0.16, 1.7), mat("Strap"));
      awning.position.set(0, 3.5, 0.05);
      awning.rotation.x = 0.16;
      g.add(awning);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(3, 0.95), new THREE.MeshBasicMaterial({ map: this.stallTexture(null) }));
      sign.position.set(0, 2.72, -0.5);
      g.add(sign);
      this.stallSigns.push(sign);
      // a stack of notes on the counter, strapped
      const stack = part(new THREE.BoxGeometry(0.62, 0.3, 0.32), mat("Bill"));
      stack.position.set(0.9, 1.37, 0.1);
      const band = part(new THREE.BoxGeometry(0.14, 0.32, 0.34), mat("Strap"));
      band.position.set(0.9, 1.37, 0.1);
      g.add(stack, band);
      this.scene.add(g);
      this.colliders.push({ x, z, r: 1.7 });
      const fx = x + Math.sin(ry) * 1.9;
      const fz = z + Math.cos(ry) * 1.9;
      this.spots.push({ id: `stall-${i}`, kind: "stall", x: fx, z: fz, r: 2.2, prompt: "Lay a band", pool: undefined });
    });
  }

  private stallTexture(row: BoardRow | null): THREE.CanvasTexture {
    return signTexture(620, 196, (g, w) => {
      g.fillStyle = INK;
      if (!row) {
        g.font = `italic 400 40px ${SERIF}`;
        g.fillText("Opening soon", 40, 118);
        return;
      }
      fitText(g, row.label, (px) => `600 ${px}px ${SERIF}`, w - 80, 58);
      g.fillText(row.label, 40, 100);
      g.fillStyle = "#c9560a";
      g.font = `700 30px ${CAPS}`;
      g.fillText(`${row.feePct.toFixed(3)}% FEES / HR · LAY A BAND`, 40, 152);
    });
  }

  /** the Guard House: a small temple of rules */
  private buildGuardHouse() {
    const g = new THREE.Group();
    g.position.set(24, 0, 2);
    g.rotation.y = -Math.PI / 2.4;
    const base = part(new THREE.BoxGeometry(7, 0.6, 5.4), mat("Paper"));
    base.position.y = 0.3;
    const step = part(new THREE.BoxGeometry(7.6, 0.3, 6), mat("Paper"));
    step.position.y = 0.15;
    g.add(step, base);
    for (const x of [-2.8, -0.95, 0.95, 2.8]) {
      const col = part(new THREE.CylinderGeometry(0.32, 0.36, 4.2, 14), mat("Paper"));
      col.position.set(x, 2.7, 2);
      g.add(col);
    }
    const cella = part(new THREE.BoxGeometry(6, 4.2, 3.4), mat("Paper"));
    cella.position.set(0, 2.7, -0.7);
    g.add(cella);
    const lintel = part(new THREE.BoxGeometry(7.2, 0.6, 5.6), mat("Paper"));
    lintel.position.y = 5.1;
    g.add(lintel);
    // the pediment: a triangle across the front, run back over the whole roof
    const tri = new THREE.Shape();
    tri.moveTo(-3.8, 0);
    tri.lineTo(3.8, 0);
    tri.lineTo(0, 1.5);
    tri.closePath();
    const pedGeo = new THREE.ExtrudeGeometry(tri, { depth: 5.6, bevelEnabled: false });
    pedGeo.translate(0, 0, -2.8);
    const pediment = part(pedGeo, mat("Paper"));
    pediment.position.y = 5.4;
    g.add(pediment);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 1.1),
      new THREE.MeshBasicMaterial({
        map: signTexture(920, 220, (c) => {
          c.fillStyle = INK;
          c.font = `700 70px ${CAPS}`;
          c.fillText("THE GUARD HOUSE", 60, 122);
          c.fillStyle = "#c9560a";
          c.font = `600 30px ${CAPS}`;
          c.fillText("THE RULES HE CAN'T BREAK", 64, 176);
        }),
      }),
    );
    sign.position.set(0, 5.1, 2.82);
    g.add(sign);
    this.scene.add(g);
    this.colliders.push({ x: 24, z: 2, r: 4.2 });
    const front = new THREE.Vector3(0, 0, 4.4).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y).add(g.position);
    this.spots.push({ id: "guards", kind: "guards", x: front.x, z: front.z, r: 2.6, prompt: "Read the rules" });
  }

  /** the Notice Board: his build notes, pinned */
  private buildNoticeBoard() {
    const g = new THREE.Group();
    g.position.set(-18, 0, 20);
    g.rotation.y = Math.PI * 0.72;
    for (const x of [-2.4, 2.4]) {
      const post = part(new THREE.BoxGeometry(0.34, 4, 0.34), mat("Wood"));
      post.position.set(x, 2, 0);
      g.add(post);
    }
    const board = part(new THREE.BoxGeometry(5.4, 3, 0.24), mat("Wood"));
    board.position.set(0, 2.6, 0);
    g.add(board);
    this.noticeMesh = new THREE.Mesh(new THREE.PlaneGeometry(5, 2.6), new THREE.MeshBasicMaterial({ map: this.noticeTexture([]) }));
    this.noticeMesh.position.set(0, 2.6, 0.13);
    g.add(this.noticeMesh);
    const roof = part(new THREE.BoxGeometry(5.9, 0.16, 0.9), mat("Strap"));
    roof.position.set(0, 4.2, 0.1);
    g.add(roof);
    this.scene.add(g);
    this.colliders.push({ x: -18, z: 20, r: 2.8 });
    const front = new THREE.Vector3(0, 0, 2.4).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y).add(g.position);
    this.spots.push({ id: "notes", kind: "notes", x: front.x, z: front.z, r: 2.4, prompt: "Read what he built" });
  }

  private noticeTexture(notes: string[]): THREE.CanvasTexture {
    return signTexture(1000, 520, (g, w) => {
      g.fillStyle = "#c9560a";
      g.font = `700 30px ${CAPS}`;
      g.fillText("BUILT LATELY · IN HIS OWN WORDS", 46, 70);
      g.fillStyle = INK;
      g.font = `400 26px ${SERIF}`;
      let y = 118;
      for (const n of notes.slice(0, 3)) {
        const words = n.split(/\s+/);
        let line = "";
        let lines = 0;
        for (const word of words) {
          const next = line ? `${line} ${word}` : word;
          if (g.measureText(next).width > w - 100) {
            g.fillText(line, 46, y);
            y += 32;
            line = word;
            if (++lines >= 3) break;
          } else line = next;
        }
        if (lines < 3 && line) {
          g.fillText(line, 46, y);
          y += 32;
        }
        y += 22;
        if (y > 480) break;
      }
      if (!notes.length) {
        g.font = `italic 400 30px ${SERIF}`;
        g.fillText("Nothing pinned yet.", 46, 140);
      }
    });
  }

  /** lamps, benches and strapped stacks, so the plaza is a place */
  private buildDecor() {
    const lamp = (x: number, z: number) => {
      const pole = part(new THREE.CylinderGeometry(0.09, 0.12, 4.4, 8), mat("Ink"));
      pole.position.set(x, 2.2, z);
      const head = part(new THREE.SphereGeometry(0.34, 12, 10), mat("Brass"));
      head.position.set(x, 4.55, z);
      this.scene.add(pole, head);
      this.colliders.push({ x, z, r: 0.35 });
    };
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3;
      lamp(Math.sin(a) * 31, Math.cos(a) * 31);
    }
    const stack = (x: number, z: number, ry: number, h: number) => {
      const s = part(new THREE.BoxGeometry(1.3, 0.24 * h, 0.66), mat("Bill"));
      s.position.set(x, 0.12 * h, z);
      s.rotation.y = ry;
      const b = part(new THREE.BoxGeometry(0.26, 0.24 * h + 0.02, 0.68), mat("Strap"));
      b.position.copy(s.position);
      b.rotation.y = ry;
      this.scene.add(s, b);
      this.colliders.push({ x, z, r: 0.8 });
    };
    stack(-6, 6, 0.4, 3);
    stack(-5.2, 7.2, 1.1, 2);
    stack(7, 9, -0.3, 4);
    stack(16, -16, 0.8, 3);
    stack(-15, -15, -0.6, 5);
    const bench = (x: number, z: number, ry: number) => {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = ry;
      const seat = part(new THREE.BoxGeometry(2.6, 0.14, 0.7), mat("Wood"));
      seat.position.y = 0.55;
      const back = part(new THREE.BoxGeometry(2.6, 0.7, 0.1), mat("Wood"));
      back.position.set(0, 0.95, -0.32);
      g.add(seat, back);
      for (const sx of [-1.1, 1.1]) {
        const leg = part(new THREE.BoxGeometry(0.1, 0.55, 0.6), mat("Ink"));
        leg.position.set(sx, 0.27, 0);
        g.add(leg);
      }
      this.scene.add(g);
      this.colliders.push({ x, z, r: 1.3 });
    };
    bench(-11, 12, 0.5);
    bench(11, 13, -0.5);
    bench(28, 18, -1.0);
  }

  /**
   * Mr Bands at his desk, made from the visitors' own parts so he stands in the same world: a head taller, his top hat
   * with the orange strap, dark glasses, a cigar and a cane, behind a writing desk with his ledger and a strapped stack.
   * (The real desk model, web/3d/desk.glb, is a close-up diorama 31 units across: it does not sit in a plaza, and it
   * would cost every visitor a megabyte.)
   */
  private buildDesk() {
    const g = new THREE.Group();
    g.position.set(-24, 0, 2);
    g.rotation.y = Math.PI / 2.4;
    // the desk
    const top = part(new THREE.BoxGeometry(4.2, 0.18, 1.9), mat("Wood"));
    top.position.y = 1.12;
    const felt = part(new THREE.BoxGeometry(3.4, 0.03, 1.4), mat("Felt"));
    felt.position.y = 1.23;
    g.add(top, felt);
    for (const [x, z] of [[-1.9, -0.8], [1.9, -0.8], [-1.9, 0.8], [1.9, 0.8]]) {
      const leg = part(new THREE.BoxGeometry(0.16, 1.05, 0.16), mat("Wood"));
      leg.position.set(x, 0.53, z);
      g.add(leg);
    }
    const front = part(new THREE.BoxGeometry(4.0, 0.7, 0.08), mat("Wood"));
    front.position.set(0, 0.72, 0.9);
    g.add(front);
    const ledgerHalf = new THREE.Vector3(0.45, 0.03, 0.6);
    for (const x of [-0.45, 0.45]) {
      const page = part(new THREE.BoxGeometry(0.9, 0.06, 1.2), mat("Page", ledgerHalf), true);
      page.position.set(x, 1.28, 0.1);
      page.rotation.z = x < 0 ? 0.04 : -0.04;
      g.add(page);
    }
    const stack = part(new THREE.BoxGeometry(0.7, 0.36, 0.34), mat("Bill"));
    stack.position.set(1.35, 1.43, -0.2);
    const band = part(new THREE.BoxGeometry(0.15, 0.38, 0.36), mat("Strap"));
    band.position.copy(stack.position);
    const lamp = part(new THREE.CylinderGeometry(0.05, 0.12, 0.8, 10), mat("Brass"));
    lamp.position.set(-1.5, 1.6, -0.5);
    const shade = part(new THREE.CylinderGeometry(0.12, 0.34, 0.3, 14), mat("Strap"));
    shade.position.set(-1.5, 2.05, -0.5);
    g.add(stack, band, lamp, shade);
    // the man himself, behind the desk, facing the plaza
    const him = makeWalker(STRAPS[0]);
    him.root.scale.setScalar(1.22);
    him.root.position.set(0, 0, -1.25);
    const body = him.root.children[0];
    const glasses = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.05), flat(INK));
    glasses.position.set(0, 2.17, 0.24);
    const cigar = part(new THREE.CylinderGeometry(0.028, 0.028, 0.3, 8), mat("Paper"), true);
    cigar.rotation.set(Math.PI / 2, 0, 0.35);
    cigar.position.set(0.12, 2.02, 0.36);
    const ember = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.04, 8), flat("#ff7a1a"));
    ember.rotation.copy(cigar.rotation);
    ember.position.set(0.17, 2.02, 0.5);
    const cane = part(new THREE.CylinderGeometry(0.035, 0.035, 1.6, 8), mat("Ink"), true);
    cane.position.set(0.55, 0.8, 0.25);
    cane.rotation.z = -0.12;
    const knob = part(new THREE.SphereGeometry(0.07, 10, 8), mat("Brass"), true);
    knob.position.set(0.6, 1.62, 0.25);
    body.add(glasses, cigar, ember, cane, knob);
    g.add(him.root);
    this.npc = him;
    this.scene.add(g);
    this.colliders.push({ x: -24, z: 2, r: 2.6 });
    const front2 = new THREE.Vector3(0, 0, 3.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y).add(g.position);
    this.spots.push({ id: "desk", kind: "desk", x: front2.x, z: front2.z, r: 3, prompt: "Talk to Mr Bands" });
    const sign = labelSprite("Mr Bands");
    sign.position.set(-24, 4.2, 2);
    this.scene.add(sign);
  }

  /** kept for the page's loading step: the desk is built in the constructor now */
  async loadDesk(_url?: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- live data

  setBoard(rows: BoardRow[]) {
    if (this.boardMesh) {
      const m = this.boardMesh.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.map = this.boardTexture(rows);
      m.needsUpdate = true;
    }
    this.stallSigns.forEach((sign, i) => {
      const m = sign.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.map = this.stallTexture(rows[i] ?? null);
      m.needsUpdate = true;
      const spot = this.spots.find((s) => s.id === `stall-${i}`);
      if (spot) {
        spot.pool = rows[i]?.label;
        spot.prompt = rows[i] ? `Lay a band on ${rows[i].label}` : "This stall opens with the next board";
      }
    });
  }

  setNotes(notes: string[]) {
    if (!this.noticeMesh) return;
    const m = this.noticeMesh.material as THREE.MeshBasicMaterial;
    m.map?.dispose();
    m.map = this.noticeTexture(notes);
    m.needsUpdate = true;
  }

  // ---------------------------------------------------------------- you and the others

  setMe(name: string, strap: number) {
    this.scene.remove(this.me.root);
    const pos = this.me.root.position.clone();
    this.me = makeWalker(STRAPS[strap] ?? STRAPS[0]);
    this.me.root.position.copy(pos);
    this.me.root.rotation.y = this.meRy;
    // no tag over your own head: your name is in the corner, and the tag would sit in your line of sight
    void name;
    this.scene.add(this.me.root);
  }

  addRemote(id: string, name: string, strap: number, x: number, z: number, ry: number) {
    if (this.remotes.has(id)) return;
    const w = makeWalker(STRAPS[strap] ?? STRAPS[0]);
    w.root.position.set(x, 0, z);
    w.root.rotation.y = ry;
    w.target.set(x, 0, z);
    w.targetRy = ry;
    w.tag = labelSprite(name);
    w.tag.position.y = 3.15;
    w.root.add(w.tag);
    this.scene.add(w.root);
    this.remotes.set(id, w);
  }

  moveRemote(id: string, x: number, z: number, ry: number, moving: boolean) {
    const w = this.remotes.get(id);
    if (!w) return;
    w.target.set(x, 0, z);
    w.targetRy = ry;
    w.moving = moving;
  }

  removeRemote(id: string) {
    const w = this.remotes.get(id);
    if (!w) return;
    this.scene.remove(w.root);
    this.remotes.delete(id);
  }

  /** a speech bubble over someone ("me" for you) for a few seconds */
  bubble(id: string, text: string) {
    const w = id === "me" ? this.me : this.remotes.get(id);
    if (!w) return;
    if (w.bubble) w.root.remove(w.bubble);
    w.bubble = labelSprite(text, { bubble: true });
    w.bubble.position.y = 3.95;
    w.root.add(w.bubble);
    w.bubbleUntil = performance.now() + 4200;
  }

  /** the server's word on where you are (your spawn, or a refused step): snap there; `face` also turns the camera behind you */
  setMyPosition(x: number, z: number, ry: number, face = false) {
    this.me.root.position.set(x, 0, z);
    this.meRy = ry;
    this.me.root.rotation.y = ry;
    if (face) {
      this.yaw = ry + Math.PI;
      this.camera.position.set(x + Math.sin(this.yaw) * this.dist, EYE + 3, z + Math.cos(this.yaw) * this.dist);
    }
  }

  get position(): { x: number; z: number; ry: number } {
    return { x: this.me.root.position.x, z: this.me.root.position.z, ry: this.me.root.rotation.y };
  }

  // ---------------------------------------------------------------- input

  setJoystick(x: number, y: number) {
    this.joy.set(x, y);
  }

  /** the action key (E, or the on-screen button) */
  interact() {
    if (this.near) this.cb.onInteract(this.near);
  }

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (e.type === "keydown") {
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
      if (k === "e" && !e.repeat) this.interact();
      this.keys.add(k);
    } else this.keys.delete(k);
  };

  private onBlur = () => this.keys.clear();

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "touch" && e.clientX < window.innerWidth * 0.42) return; // the left of a phone is the joystick
    this.dragging = { x: e.clientX, y: e.clientY, id: e.pointerId };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging || e.pointerId !== this.dragging.id) return;
    const dx = e.clientX - this.dragging.x;
    const dy = e.clientY - this.dragging.y;
    this.dragging.x = e.clientX;
    this.dragging.y = e.clientY;
    this.yaw -= dx * 0.006;
    this.pitch = Math.min(1.1, Math.max(0.08, this.pitch + dy * 0.004));
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.dragging?.id === e.pointerId) this.dragging = null;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.dist = Math.min(18, Math.max(4.5, this.dist + e.deltaY * 0.01));
  };

  private onVisibility = () => {
    this.paused = document.hidden;
    if (!this.paused) this.last = performance.now();
  };

  private bindInput() {
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    window.addEventListener("blur", this.onBlur);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  // ---------------------------------------------------------------- the loop

  private resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    outlineRes.value.set(w, h);
    shared.uPitch.value = 5.2 * dpr;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop(now: number) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.step(dt, now);
    this.renderer.render(this.scene, this.camera);
    this.fpsFrames++;
    if (now - this.fpsSince > 1000) {
      const fps = (this.fpsFrames * 1000) / (now - this.fpsSince);
      this.cb.onFps?.(fps);
      if (fps < 30 && this.dprCap > 1) {
        this.dprCap = Math.max(1, this.dprCap - 0.25);
        this.resize();
      }
      this.fpsFrames = 0;
      this.fpsSince = now;
    }
  }

  private step(dt: number, now: number) {
    // input: keys and the stick, turned by the camera's heading
    let fx = 0;
    let fz = 0;
    const k = this.keys;
    if (k.has("w") || k.has("arrowup")) fz -= 1;
    if (k.has("s") || k.has("arrowdown")) fz += 1;
    if (k.has("a") || k.has("arrowleft")) fx -= 1;
    if (k.has("d") || k.has("arrowright")) fx += 1;
    fx += this.joy.x;
    fz += this.joy.y;
    const mag = Math.min(1, Math.hypot(fx, fz));
    const moving = mag > 0.08;
    const me = this.me.root;
    if (moving) {
      const speed = (k.has("shift") || this.joy.length() > 0.95 ? SPRINT : WALK) * mag;
      // the camera sits at (sin yaw, cos yaw) behind you: forward (W, fz = -1) is away from it
      const heading = Math.atan2(fx, fz) + this.yaw;
      const nx = me.position.x + Math.sin(heading) * speed * dt;
      const nz = me.position.z + Math.cos(heading) * speed * dt;
      const p = this.collide(nx, nz);
      me.position.x = p.x;
      me.position.z = p.z;
      this.meRy = lerpAngle(this.meRy, heading, Math.min(1, dt * 12));
      me.rotation.y = this.meRy;
    }
    animateWalker(this.me, moving, dt);
    if (moving || this.moved) this.cb.onMove(me.position.x, me.position.z, me.rotation.y, moving);
    this.moved = moving;

    // the others ease toward where the network put them
    for (const w of this.remotes.values()) {
      const d = w.target.clone().sub(w.root.position);
      const far = d.length() > 12;
      w.root.position.add(far ? d : d.multiplyScalar(Math.min(1, dt * 10)));
      w.root.rotation.y = lerpAngle(w.root.rotation.y, w.targetRy, Math.min(1, dt * 10));
      animateWalker(w, w.moving, dt);
      if (w.bubble && now > w.bubbleUntil) {
        w.root.remove(w.bubble);
        w.bubble = null;
      }
    }
    if (this.me.bubble && now > this.me.bubbleUntil) {
      this.me.root.remove(this.me.bubble);
      this.me.bubble = null;
    }

    // Mr Bands, idle: a slow sway, and a turn toward you when you come close
    if (this.npc) {
      const body = this.npc.root.children[0];
      body.rotation.z = Math.sin(now / 1400) * 0.025;
    }

    // what you stand near
    let best: Spot | null = null;
    let bestD = Infinity;
    for (const s of this.spots) {
      const d = Math.hypot(s.x - me.position.x, s.z - me.position.z);
      if (d < s.r && d < bestD) {
        best = s;
        bestD = d;
      }
    }
    if (best !== this.near) {
      this.near = best;
      this.cb.onNear(best);
    }

    // the camera: behind and above, eased; the key light's shadow box follows you
    const target = new THREE.Vector3(me.position.x, EYE, me.position.z);
    const cam = new THREE.Vector3(
      target.x + Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist,
      target.y + Math.sin(this.pitch) * this.dist + 0.6,
      target.z + Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist,
    );
    this.camera.position.lerp(cam, Math.min(1, dt * 8));
    this.camera.lookAt(target);
    this.key.position.set(me.position.x - 16, 26, me.position.z + 13);
    this.key.target.position.set(me.position.x, 0, me.position.z);
  }

  /** push a step out of every collider and keep it on the plaza */
  private collide(x: number, z: number): { x: number; z: number } {
    const R = 0.45;
    for (const b of this.walls) {
      // inside the wall grown by the walker's radius: out along the shortest way
      if (x > b.x0 - R && x < b.x1 + R && z > b.z0 - R && z < b.z1 + R) {
        const out = [
          [x - (b.x0 - R), -1, 0],
          [b.x1 + R - x, 1, 0],
          [z - (b.z0 - R), 0, -1],
          [b.z1 + R - z, 0, 1],
        ].sort((p, q) => p[0] - q[0])[0];
        x += out[1] * out[0];
        z += out[2] * out[0];
      }
    }
    for (const c of this.colliders) {
      const dx = x - c.x;
      const dz = z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + R;
      if (d < min && d > 1e-6) {
        x = c.x + (dx / d) * min;
        z = c.z + (dz / d) * min;
      }
    }
    const r = Math.hypot(x, z);
    const max = WORLD_RADIUS - 1.2;
    if (r > max) {
      x = (x / r) * max;
      z = (z / r) * max;
    }
    return { x, z };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.renderer.dispose();
  }
}

function animateWalker(w: Walker, moving: boolean, dt: number) {
  w.phase += dt * (moving ? 9 : 0);
  const swing = moving ? Math.sin(w.phase) * 0.55 : 0;
  w.legL.rotation.x += (swing - w.legL.rotation.x) * Math.min(1, dt * 14);
  w.legR.rotation.x += (-swing - w.legR.rotation.x) * Math.min(1, dt * 14);
  const body = w.root.children[0];
  body.position.y = moving ? Math.abs(Math.sin(w.phase)) * 0.06 : body.position.y * 0.8;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
