/**
 * THE BANDS EXCHANGE (bands.finance Play, 24 Sep): a plaza you walk, drawn as an engraving like mrbands.finance's desk
 * (src/stage/engrave.ts: every surface ink lines on paper, one contour round every form). Four landmarks: the Pools
 * Board (the live top pools) with a stall for each of the first four, Mr Bands at his desk, the Guard House (his rules)
 * and the Notice Board (his build notes). Round it, the city (./city.ts): the Exchange, the clock tower, the banks and
 * the streets; at its centre, the fountain.
 *
 * THE TOWN (24 Sep): the ground you can walk is ./town.ts's (the plaza, the whole boulevard ring, the four streets out
 * to their domed ends), which the server shares; the rope is cut at the four street mouths and is a line you cannot
 * cross elsewhere (its spans fence the walker, as the server's rule does), and every named front is a Place from
 * town.ts's PLACES with a Spot at its door, a keeper standing beside it with a name tag, and a signpost the page can
 * hang there (setMarker). The Clock Tower's climb is viewFrom(): the camera goes up for a while.
 * What a visitor wears (protocol.ts's Kit) goes on their figure with setKit.
 *
 * COINS (24 Sep): the game is to walk the town and gather them. A coin the room lists (addLooseNote: the wire keeps
 * the notes' names) is a brass coin stamped with a B, turning where it lies; a mint mark (worth MARK_V or more) is
 * the same coin larger with a double ring. Walk onto one and the room is asked for it (onNote). When the Mint spills
 * a street's worth, the page hangs a second signpost at that street's mouth (setSpill).
 *
 * ALIVE (24 Sep): everything that moves of its own accord (the passers-by, the carts, the birds, the newsboy, the
 * sweeper, the dog, the wind on the awnings and the smoke) is ./life.ts's, built once the city stands and stepped
 * every frame; its carts' colliders are among the world's, so you step round them. The camera sits closer (DIST,
 * PITCH), sways a little at the walk's cadence, and opens out (FOV_OUT) beyond the rope, where the streets are long.
 *
 * This file is the engine only: scene, avatars, input, camera, collisions and the spots you can use. It knows nothing
 * of React, the network or the mini-game; it reports where you are (onMove) and what you stand near (onNear), and the
 * page (src/components/PlayPage.tsx) opens the panels. Remote visitors are driven through addRemote/moveRemote.
 */
import * as THREE from "three";
import { outlineRes, shared, SPECS } from "../stage/engrave";
import { CAPS, fitText, flat, hexRgb, INK, labelSprite, mat, OUTLINE, OUTLINE_FINE, PAPER, part, SERIF, signTexture } from "./engraved";
import { buildCity, type City, type Seg } from "./city";
import { makeFigure, type Figure, type Gesture } from "./figure";
import { buildLife, type Life } from "./life";
import { mountLight, type TownLight } from "./light";
import { boardHeading } from "./lpGame";
import { bands } from "./money";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { DESK_SPOT, DOOR_REACH_M, GUARD_SPOT, PLACE_IDS, STRAPS, WORLD_RADIUS, type Kit } from "./protocol";
import { nearestWalkable, PLACES, ROPE_POSTS, ropeCut, routeTo, STREET_ANGLES, type Place } from "./town";

export type SpotKind = "desk" | "stall" | "guards" | "notes" | "place";

export interface Spot {
  id: string;
  kind: SpotKind;
  x: number;
  z: number;
  /** how close you must stand, metres */
  r: number;
  prompt: string;
  /** for a stall: its index on the board (stall i shows and deals the board's row i; two rows can share a label) */
  stall?: number;
  /** for a stall: the pool's label */
  pool?: string;
  /** for a place: its row in town.ts's PLACES (the id is the place's id) */
  place?: Place;
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
  /** you walked onto a loose note: ask the room for it */
  onNote?(id: string): void;
}

interface Walker {
  fig: Figure;
  root: THREE.Group;
  /** a remote visitor's name and stack, for the name tag */
  name?: string;
  stack?: number;
  /** the figure's contours: drawn near, dropped far (half a figure's draws, and too fine to see at that size) */
  lines: THREE.Object3D[];
  near: boolean;
  tag: THREE.Sprite | null;
  bubble: THREE.Sprite | null;
  bubbleUntil: number;
  /** where the network last put a remote walker (it eases toward it) */
  target: THREE.Vector3;
  targetRy: number;
  moving: boolean;
  /** how fast a remote walker is actually going, as a share of a walk (eased, for the stride) */
  pace: number;
}

const SPAWN = new THREE.Vector3(0, 0, 20);
/** the town is big: a brisk walk, and a run to the street ends (the server's speed budget allows 9; the strollers keep their own) */
const WALK = 5.5;
const SPRINT = 8.5;
/** a click-walk's waypoint on the way is passed once you are this near it (the last, the target, keeps the spot's own reach) */
const WAYPOINT_M = 1.0;
/** a coin is asked for when you come this near it (the room allows a little more) */
const NOTE_PICK_M = 1.3;
/** a coin: a short brass cylinder standing on its edge, the same geometry for every coin */
const COIN_R = 0.32;
const COIN_H = 0.07;
const COIN_GEO = new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_H, 28);
/** a coin's centre floats this high, turning; a mark's as much higher as it is bigger, so its rim clears the ground */
const COIN_Y = 0.45;
/** a coin leans back this much off upright as it turns: a coin spinning on its edge, not a wheel */
const COIN_LEAN = 0.18;
/** a coin worth this much or more is a mint mark: drawn bigger, its faces with a double ring */
const MARK_V = 100;
const MARK_SCALE = 1.5;

/** a visitor's name tag: the name and the stack */
const tagText = (name: string, stack?: number): string => (typeof stack === "number" ? `${name} · ${bands(stack)}` : name);

/** "Enter the Hatter": a place's name in a prompt */
const inPrompt = (name: string): string => name.replace(/^The /, "the ");

/** what a place's keeper wears: their trade on them; the rest of the town dresses by its seed */
const KEEPER_KIT: Record<string, Partial<Kit>> = {
  hatter: { hat: "boater" },
  cigars: { cigar: true },
  "glover-west": { cane: true },
  "glover-crescent": { cane: true },
  "stationer-east": { glasses: true },
  "stationer-crescent": { glasses: true },
  tailor: { coat: "Cloth" },
  "bookseller-west": { glasses: true, hat: "cap" },
  "bookseller-crescent": { glasses: true },
  ledgers: { glasses: true },
  printer: { hat: "cap" },
  barber: { hat: "cap" },
  "bands-co": { hat: "top", coat: "FigInk", glasses: true },
};
/** a keeper stands this far from the door, along the front */
const KEEPER_ASIDE_M = 1.5;
/** and this far back from it: a door is on the pavement's edge, 0.25 m past the kerb, and a keeper on the kerb is in the way */
const KEEPER_BACK_M = 0.5;
/** a signpost's post, a thing on open ground the walker goes round */
const SIGNPOST_R = 0.3;
/**
 * the Mint's signpost stands beside a street's mouth, just outside the rope on the ring's inner pavement: this far
 * round from the street's line (the mouth is one rope span, 0.07 rad each side; the click-route runs the line
 * itself) and this far out (the rope is at 42, the inner kerb at 45.6, the boulevard's trees at 44.4 and 0.17 round)
 */
const SPILL_ASIDE = 0.1;
const SPILL_R = 43.6;
/** a keeper is drawn (and animated) only within this far of the camera: a figure that far is a speck under the fog's edge, and the ring holds twenty-one of them */
const KEEPER_SHOW_M = 60;
/** the page's signpost at a door stands this far the other way, and this far forward of the door, clear of a shop's awning */
const MARKER_ASIDE_M = 1.7;
const MARKER_FORWARD_M = 1.3;

/** a label sprite (labelSprite draws each on its own canvas) taken down and its texture and material freed */
const dropSprite = (s: THREE.Sprite | null) => {
  if (!s) return;
  s.parent?.remove(s);
  (s.material as THREE.SpriteMaterial).map?.dispose();
  s.material.dispose();
};

/** figures farther than this from the camera are drawn without their contours */
const DETAIL_M = 26;
/** a label nearer the camera than this is shrunk to keep its size on screen */
const LABEL_NEAR_M = 11;
/** a name tag fades out between these distances from the camera (a bubble does not) */
const TAG_FADE_M = [22, 30] as const;
/** the camera looks at a point this high above your feet: above the head, so tall signs stay in frame */
const EYE = 2.4;
/** the follow camera's rest: this far behind you, this far down on you (a wheel changes the distance) */
const DIST = 8;
const PITCH = 0.22;
/** the camera's sway while you walk: this much roll, at the walk's cadence (the figure's own strides a second) */
const SWAY = 0.02;
/** the view, degrees across: the plaza as it was, and opened out beyond the rope, where the streets are long */
const FOV_PLAZA = 50;
const FOV_OUT = 55;

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

/** a visitor (./figure.ts): a jointed figure in a frock coat and a hat, the strap and bow tie in their colour */
function makeWalker(strapHex: string, seed?: number, kind: "visitor" | "mrbands" = "visitor", kit?: Partial<Kit>): Walker {
  const fig = makeFigure({ strap: strapHex, kind, seed, kit });
  const w: Walker = { fig, root: fig.root, lines: [], near: true, tag: null, bubble: null, bubbleUntil: 0, target: new THREE.Vector3(), targetRy: 0, moving: false, pace: 0 };
  relines(w);
  return w;
}

/** find the figure's contours again (new kit brings new ones) and show or hide them as the walker's distance says */
function relines(w: Walker) {
  w.lines = [];
  w.root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m === OUTLINE || m === OUTLINE_FINE) w.lines.push(o);
  });
  for (const l of w.lines) l.visible = w.near;
}

/** a name tag or a bubble sits over the hat: put it back there after the hat changed */
function retop(w: Walker) {
  if (w.tag) w.tag.position.y = w.fig.height + 0.3;
  if (w.bubble) w.bubble.position.y = w.fig.height + 1.1;
}

// ---------------------------------------------------------------- the world

/** ?hour= from the page's query or its hash query (0..24, a fraction allowed), else null: the real hour runs */
function forcedHour(): number | null {
  if (typeof location === "undefined") return null;
  for (const q of [location.search, location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?")) : ""]) {
    const v = new URLSearchParams(q).get("hour");
    if (v !== null && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** a Date whose local-time reading is UTC, so the tower's hands (city.ts reads getHours) match the shared sky */
function utcClock(): Date {
  const now = new Date();
  return new Date(now.getTime() + now.getTimezoneOffset() * 60_000);
}

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
  /** the façades' fronts and flanks, lines a walker and the camera stay off */
  private fences: Seg[] = [];
  /** the rope's spans between its posts: lines a walker stays off but the camera looks over (a rope is a metre high) */
  private ropes: Seg[] = [];
  private spots: Spot[] = [];
  /** the keeper at each door, idle, with a name tag */
  private keepers: Walker[] = [];
  /**
   * two signposts with hanging boards, each built the first time it is asked for, its post's collider in the list
   * while it stands: the page's marker at a door (setMarker), and the Mint's at a street's mouth (setSpill)
   */
  private signpost: Signpost | null = null;
  private spillpost: Signpost | null = null;
  /** the tower's climb: where the camera is held, and until when */
  private view: { pos: THREE.Vector3; until: number } | null = null;
  /** what you wear, kept through setMe's rebuild */
  private myKit: Kit | undefined;
  private near: Spot | null = null;
  private keys = new Set<string>();
  private joy = new THREE.Vector2();
  private yaw = 0;
  private pitch = PITCH;
  private dist = DIST;
  /** the walk's cadence, for the camera's sway, and the sway itself (eased, so a stop has no corner in it) */
  private cadence = 0;
  private roll = 0;
  /** the view's width now, eased toward where you are (the plaza or beyond the rope) */
  private fovNow = FOV_PLAZA;
  private dragging: { x: number; y: number; id: number; startX: number; startY: number; at: number; moved: boolean } | null = null;
  /**
   * click or tap to walk: the way there (town.ts's routeTo: through a mouth, round the ring, along a street), the
   * waypoint you are headed for, the spot to open on arrival, and the stuck check on the current waypoint
   */
  private goal: { path: [number, number][]; i: number; spot: Spot | null; checkAt: number; checkD: number } | null = null;
  private lastDragAt = 0;
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  /** the landmarks you can click, each with the spot it opens */
  private pickables: { obj: THREE.Object3D; spot: string }[] = [];
  private marker!: THREE.Mesh;
  private hoverAt = 0;
  /** how fast you are actually going, as a share of a walk (for the stride) */
  private gait = 0;
  private raf = 0;
  private last = performance.now();
  private fpsFrames = 0;
  private fpsSince = performance.now();
  private boardMesh: THREE.Mesh | null = null;
  private noticeMesh: THREE.Mesh | null = null;
  private stallSigns: THREE.Mesh[] = [];
  private npc: Walker | null = null;
  private city!: City;
  /** the town's own life (./life.ts): the passers-by, carts, birds, the newsboy, sweeper and dog, the wind and smoke */
  private life!: Life;
  /** the day cycle: the town printed at the hour its clock shows (light.ts); the page owns it, so bands.finance sees night */
  light!: TownLight;
  /** the stalls' awnings, hinged at the back, for the wind */
  private stallAwnings: THREE.Mesh[] = [];
  /** where the other visitors stand, handed to the life each frame (the birds scatter from them, the dog follows them) */
  private otherAt: THREE.Vector3[] = [];
  private moved = false;
  private disposed = false;
  /** the coins on the ground, turning where they lie (by the wire's name for them) */
  private looseNotes = new Map<string, { g: THREE.Group; x: number; z: number; askedAt: number; phase: number; y: number }>();
  /** keys and E are read only while this is on (the page turns it off while a panel is open) */
  private inputOn = true;
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
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.46, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...hexRgb(INK), THREE.LinearSRGBColorSpace), transparent: true, opacity: 0 }));
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.position.y = 0.03;
    this.scene.add(this.marker);
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
    // the rope and posts round the edge, the rope cut at the four street mouths (town.ts's ropeCut: the two posts
    // there stand as gateposts); every span strung is a line the walker stays off, the same line the server refuses
    const postGeo = new THREE.CylinderGeometry(0.16, 0.22, 1.1, 10);
    const ropeGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
    for (let i = 0; i < ROPE_POSTS; i++) {
      const a = (i / ROPE_POSTS) * Math.PI * 2;
      const r = WORLD_RADIUS;
      const p = part(postGeo, mat("Brass"));
      p.position.set(Math.sin(a) * r, 0.55, Math.cos(a) * r);
      this.scene.add(p);
      if (ropeCut(i)) continue;
      const a2 = ((i + 1) / ROPE_POSTS) * Math.PI * 2;
      const x1 = Math.sin(a) * r, z1 = Math.cos(a) * r, x2 = Math.sin(a2) * r, z2 = Math.cos(a2) * r;
      const len = Math.hypot(x2 - x1, z2 - z1);
      const rope = new THREE.Mesh(ropeGeo, mat("Ink"));
      rope.scale.y = len;
      rope.position.set((x1 + x2) / 2, 0.95, (z1 + z2) / 2);
      // the cylinder stands on y: turn y onto the span between the two posts
      rope.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x2 - x1, 0, z2 - z1).normalize());
      this.scene.add(rope);
      this.ropes.push({ x0: x1, z0: z1, x1: x2, z1: z2 });
    }

    this.buildBoard();
    this.buildStalls();
    this.buildGuardHouse();
    this.buildNoticeBoard();
    this.buildDesk();
    this.buildDecor();

    this.city = buildCity();
    this.scene.add(this.city.root);
    this.colliders.push(...this.city.colliders);
    this.walls.push(...this.city.walls);
    this.fences.push(...this.city.fences);
    this.buildPlaces();
    // the life reads the city's instances (awnings, flags, chimney pots, globes), so it comes after the city
    this.life = buildLife(this.city.root);
    this.scene.add(this.life.root);
    this.colliders.push(...this.life.colliders);
    // the hour can be forced from the page's query (?hour=22, on the dev page or after #/play?debug) for a look at night
    this.light = mountLight(this.scene, forcedHour() === null ? {} : { hour: forcedHour()! });
  }

  /** every door in the town (town.ts's PLACES): a spot to use, and a keeper beside it, idle, named by the sign */
  private buildPlaces() {
    for (const p of PLACES) {
      const prompt = p.kind === "end" ? `See ${inPrompt(p.name)}` : p.kind === "climb" ? `Climb ${inPrompt(p.name)}` : `Enter ${inPrompt(p.name)}`;
      this.spots.push({ id: p.id, kind: "place", x: p.x, z: p.z, r: DOOR_REACH_M, prompt, place: p });
      if (p.kind === "end") continue;
      const seed = seedOf(p.id);
      const w = makeWalker(STRAPS[seed % STRAPS.length], seed, "visitor", KEEPER_KIT[p.id]);
      // beside the door, along the front (the door faces the plaza; its right hand is a quarter turn round), and a
      // step back from it, off the kerb
      const along = p.facing + Math.PI / 2;
      w.root.position.set(
        p.x + Math.sin(along) * KEEPER_ASIDE_M - Math.sin(p.facing) * KEEPER_BACK_M,
        0,
        p.z + Math.cos(along) * KEEPER_ASIDE_M - Math.cos(p.facing) * KEEPER_BACK_M,
      );
      w.root.rotation.y = p.facing;
      w.name = p.name;
      w.tag = labelSprite(p.name);
      w.tag.userData.base = w.tag.scale.clone();
      w.tag.position.y = w.fig.height + 0.3;
      w.root.add(w.tag);
      this.scene.add(w.root);
      this.keepers.push(w);
      this.pickables.push({ obj: w.root, spot: p.id });
    }
  }

  /**
   * the page's signpost: an engraved signpost with a board hanging from its arm, at a door (a PLACES door, or the
   * plaza's own Guard House and desk); null takes it down, its post's collider with it
   */
  setMarker(placeId: string | null) {
    const p = placeId ? markerAt(placeId) : null;
    if (!p) {
      this.takeDown(this.signpost);
      return;
    }
    if (!this.signpost) {
      this.signpost = makeSignpost((c, w, h) => {
        c.fillStyle = "#c9560a";
        c.font = `700 40px ${CAPS}`;
        c.textAlign = "center";
        c.fillText("THIS WAY", w / 2, 78);
        arrowDown(c, w / 2, 96, h - 34);
      });
      this.scene.add(this.signpost.g);
    }
    // the other side of the door from the keeper and a step toward the plaza, the arm reaching over the door
    const along = p.facing + Math.PI / 2;
    const x = p.x - Math.sin(along) * MARKER_ASIDE_M + Math.sin(p.facing) * MARKER_FORWARD_M;
    const z = p.z - Math.cos(along) * MARKER_ASIDE_M + Math.cos(p.facing) * MARKER_FORWARD_M;
    this.putUp(this.signpost, x, z, p.facing);
  }

  /**
   * the Mint spilled on a street (0..3, town.ts's order): a signpost at that street's mouth, beside a gatepost on the
   * ring, its arm reaching over the mouth; null takes it down. Its own post, so the page's signpost can stand elsewhere
   */
  setSpill(street: number | null) {
    if (street === null || !(street in STREET_ANGLES)) {
      this.takeDown(this.spillpost);
      return;
    }
    if (!this.spillpost) {
      this.spillpost = makeSignpost((c, w, h) => {
        c.textAlign = "center";
        c.fillStyle = "#c9560a";
        c.font = `700 40px ${CAPS}`;
        c.fillText("THE MINT", w / 2, 68);
        c.fillStyle = INK;
        c.font = `600 26px ${CAPS}`;
        c.fillText("SPILLED THIS WAY", w / 2, 106);
        arrowDown(c, w / 2, 124, h - 34);
      });
      this.scene.add(this.spillpost.g);
    }
    // the post stands SPILL_ASIDE round from the street's line, facing the fountain: its arm then points at the mouth
    const a = STREET_ANGLES[street] + SPILL_ASIDE;
    const x = Math.sin(a) * SPILL_R;
    const z = Math.cos(a) * SPILL_R;
    this.putUp(this.spillpost, x, z, Math.atan2(-x, -z));
  }

  /** a signpost stood at (x, z) turned to face `facing`, its post in the walker's way */
  private putUp(s: Signpost, x: number, z: number, facing: number) {
    s.g.position.set(x, 0, z);
    s.g.rotation.y = facing;
    s.g.visible = true;
    s.hit.x = x;
    s.hit.z = z;
    if (!this.colliders.includes(s.hit)) this.colliders.push(s.hit);
  }

  /** a signpost taken down: hidden, its post out of the walker's way (it is kept for the next time) */
  private takeDown(s: Signpost | null) {
    if (!s) return;
    s.g.visible = false;
    const i = this.colliders.indexOf(s.hit);
    if (i >= 0) this.colliders.splice(i, 1);
  }

  /** the camera goes to (x, y, z) and looks over the town from there for ms, then comes back behind you */
  viewFrom(x: number, y: number, z: number, ms: number) {
    this.view = { pos: new THREE.Vector3(x, y, z), until: performance.now() + ms };
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

  /** the board as of the tick it shows (asOf: hot.json's generatedAt), never a cadence it cannot keep (lpGame.ts boardHeading) */
  private boardTexture(rows: BoardRow[], asOf?: string): THREE.CanvasTexture {
    return signTexture(1600, 745, (g, w, h) => {
      g.fillStyle = "#c9560a";
      g.font = `700 34px ${CAPS}`;
      g.fillText(boardHeading(asOf), 70, 92);
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
      // the awning hangs from its back edge (the geometry is pushed forward of the pivot), so the wind can lift its front
      const awning = part(new THREE.BoxGeometry(3.6, 0.16, 1.7).translate(0, 0, 0.85), mat("Strap"));
      awning.position.set(0, 3.5, -0.8);
      awning.rotation.x = 0.16;
      g.add(awning);
      this.stallAwnings.push(awning);
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
      this.spots.push({ id: `stall-${i}`, kind: "stall", x: fx, z: fz, r: 2.2, prompt: "Lay a band", stall: i, pool: undefined });
      this.pickables.push({ obj: g, spot: `stall-${i}` });
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
    this.pickables.push({ obj: g, spot: "guards" });
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
    this.pickables.push({ obj: g, spot: "notes" });
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
    stack(-13.5, 4.5, 0.4, 3);
    stack(-12.8, 5.8, 1.1, 2);
    stack(13.5, 6.5, -0.3, 4);
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
   * Mr Bands at his desk: the visitors' figure drawn as him (./figure.ts), a head taller, his top hat with the orange
   * strap, dark glasses, a cigar and a cane, behind a writing desk with his ledger and a strapped stack.
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
    const him = makeWalker(STRAPS[0], 1, "mrbands");
    him.root.position.set(0, 0, -1.25);
    g.add(him.root);
    this.npc = him;
    this.scene.add(g);
    this.colliders.push({ x: -24, z: 2, r: 2.6 });
    const front2 = new THREE.Vector3(0, 0, 3.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y).add(g.position);
    this.spots.push({ id: "desk", kind: "desk", x: front2.x, z: front2.z, r: 3, prompt: "Talk to Mr Bands" });
    this.pickables.push({ obj: g, spot: "desk" });
    const sign = labelSprite("Mr Bands");
    sign.position.set(-24, 4.2, 2);
    this.scene.add(sign);
  }

  /** kept for the page's loading step: the desk is built in the constructor now */
  async loadDesk(_url?: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- live data

  setBoard(rows: BoardRow[], asOf?: string) {
    if (this.boardMesh) {
      const m = this.boardMesh.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.map = this.boardTexture(rows, asOf);
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

  setMe(name: string, strap: number, kit?: Kit) {
    dropSprite(this.me.tag);
    dropSprite(this.me.bubble);
    this.scene.remove(this.me.root);
    const pos = this.me.root.position.clone();
    if (kit) this.myKit = kit;
    this.me = makeWalker(STRAPS[strap] ?? STRAPS[0], 3, "visitor", this.myKit);
    this.me.root.position.copy(pos);
    this.me.root.rotation.y = this.meRy;
    // no tag over your own head: your name is in the corner, and the tag would sit in your line of sight
    void name;
    this.scene.add(this.me.root);
  }

  /** someone's kit changed ("me" for you): the figure swaps the pieces that differ */
  setKit(id: string, kit: Kit) {
    const w = id === "me" ? this.me : this.remotes.get(id);
    if (!w) return;
    if (id === "me") this.myKit = kit;
    w.fig.setKit(kit);
    relines(w);
    retop(w);
  }

  addRemote(id: string, name: string, strap: number, x: number, z: number, ry: number, stack?: number, kit?: Kit) {
    if (this.remotes.has(id)) return;
    const w = makeWalker(STRAPS[strap] ?? STRAPS[0], seedOf(id), "visitor", kit);
    w.root.position.set(x, 0, z);
    w.root.rotation.y = ry;
    w.target.set(x, 0, z);
    w.targetRy = ry;
    w.name = name;
    w.stack = stack;
    w.tag = labelSprite(tagText(name, stack));
    w.tag.userData.base = w.tag.scale.clone();
    w.tag.position.y = w.fig.height + 0.3;
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

  /** a visitor's stack changed: their name tag says so */
  setStack(id: string, stack: number) {
    const w = this.remotes.get(id);
    if (!w || !w.tag || w.name === undefined || w.stack === stack) return;
    w.stack = stack;
    const old = w.tag;
    const tag = labelSprite(tagText(w.name, stack));
    tag.userData.base = tag.scale.clone();
    tag.position.copy(old.position);
    dropSprite(old);
    w.root.add(tag);
    w.tag = tag;
  }

  /**
   * a coin on the ground (the wire's "note"): brass, on its edge, a B on both faces; one the room lists as a mark is
   * bigger, with a double ring. Its value is the room's business: nothing here reads it as money
   */
  addLooseNote(n: { id: string; x: number; z: number; kind?: "coin" | "mark"; v?: number }) {
    if (this.looseNotes.has(n.id)) return;
    // the room says which are marks (the wire's `kind`); a value, when a dev script gives one, sizes it the same way
    const mark = n.kind === "mark" || (n.v ?? 0) >= MARK_V;
    const g = new THREE.Group();
    // the coin stands on its edge with a lean; the group turns it about the vertical
    const stand = new THREE.Group();
    stand.rotation.x = Math.PI / 2 - COIN_LEAN;
    stand.add(part(COIN_GEO, mat("Brass"), true), new THREE.Mesh(coinFaces(), coinFace(mark)));
    g.add(stand);
    const scale = mark ? MARK_SCALE : 1;
    g.scale.setScalar(scale);
    const y = COIN_Y * scale;
    g.position.set(n.x, y, n.z);
    this.scene.add(g);
    this.looseNotes.set(n.id, { g, x: n.x, z: n.z, askedAt: -Infinity, phase: (n.x * 7.3 + n.z * 3.1) % 6.28, y });
  }

  /** a coin was picked up (by anyone), or is not there any more (a coin shares its geometry and materials: nothing to free) */
  removeLooseNote(id: string) {
    const n = this.looseNotes.get(id);
    if (!n) return;
    this.scene.remove(n.g);
    this.looseNotes.delete(id);
  }

  /** the room's word on the coins: what it lists is on the ground, nothing else is (a fresh welcome after a reconnect) */
  setLooseNotes(list: { id: string; x: number; z: number; kind?: "coin" | "mark"; v?: number }[]) {
    const keep = new Set(list.map((n) => n.id));
    for (const id of [...this.looseNotes.keys()]) if (!keep.has(id)) this.removeLooseNote(id);
    for (const n of list) this.addLooseNote(n);
  }

  /** a coin the room will not give this visitor (today's coins are gathered): not asked for again this session */
  muteNote(id: string) {
    const n = this.looseNotes.get(id);
    if (n) n.askedAt = Infinity;
  }

  removeRemote(id: string) {
    const w = this.remotes.get(id);
    if (!w) return;
    dropSprite(w.tag);
    dropSprite(w.bubble);
    this.scene.remove(w.root);
    this.remotes.delete(id);
  }

  /** a fresh welcome: everyone and every coin goes, and the room lists them again (so nobody who left meanwhile lingers) */
  resetRoom() {
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
    for (const id of [...this.looseNotes.keys()]) this.removeLooseNote(id);
  }

  /** a speech bubble over someone ("me" for you) for a few seconds */
  bubble(id: string, text: string) {
    const w = id === "me" ? this.me : this.remotes.get(id);
    if (!w) return;
    dropSprite(w.bubble);
    w.bubble = labelSprite(text, { bubble: true });
    w.bubble.userData.base = w.bubble.scale.clone();
    w.bubble.position.y = w.fig.height + 1.1;
    w.root.add(w.bubble);
    w.bubbleUntil = performance.now() + 4200;
  }

  /** someone ("me" for you) waves, tips their hat, cheers or shrugs */
  gesture(id: string, g: Gesture) {
    const w = id === "me" ? this.me : this.remotes.get(id);
    w?.fig.gesture(g);
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

  /** off while a panel is open: keys held then are dropped, and W A S D and E do nothing until it is on again */
  setInputEnabled(on: boolean) {
    this.inputOn = on;
    if (!on) this.keys.clear();
  }

  /** the action key (E, or the on-screen button) */
  interact() {
    if (this.near) this.cb.onInteract(this.near);
  }

  /** walk to a spot and open it (a landmark named by the page) */
  goToSpot(id: string) {
    const spot = this.spots.find((s) => s.id === id);
    if (spot) this.walkTo(spot.x, spot.z, spot);
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.inputOn) return;
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
    if (e.button !== 0 && e.pointerType === "mouse") return;
    this.dragging = { x: e.clientX, y: e.clientY, id: e.pointerId, startX: e.clientX, startY: e.clientY, at: performance.now(), moved: false };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging || e.pointerId !== this.dragging.id) {
      // hovering: a hand over anything you can click (checked a few times a second, not on every move)
      if (e.pointerType === "mouse" && performance.now() - this.hoverAt > 120) {
        this.hoverAt = performance.now();
        this.canvas.style.cursor = this.pick(e.clientX, e.clientY)?.spot ? "pointer" : "";
      }
      return;
    }
    if (!this.dragging.moved && Math.hypot(e.clientX - this.dragging.startX, e.clientY - this.dragging.startY) < 7) return;
    this.dragging.moved = true;
    const dx = e.clientX - this.dragging.x;
    const dy = e.clientY - this.dragging.y;
    this.dragging.x = e.clientX;
    this.dragging.y = e.clientY;
    this.yaw -= dx * 0.006;
    this.pitch = Math.min(1.1, Math.max(0.08, this.pitch + dy * 0.004));
    this.lastDragAt = performance.now();
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.dragging;
    if (!d || d.id !== e.pointerId) return;
    this.dragging = null;
    // a click or a tap, not a drag: walk there (a landmark: walk to it and open it)
    if (!d.moved && performance.now() - d.at < 450) {
      const hit = this.pick(e.clientX, e.clientY);
      if (hit) this.walkTo(hit.x, hit.z, hit.spot ? (this.spots.find((s) => s.id === hit.spot) ?? null) : null);
    }
  };

  /** what the pointer is over: a landmark's spot, or a point on the ground */
  private pick(clientX: number, clientY: number): { x: number; z: number; spot: string | null } | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables.map((p) => p.obj), true);
    if (hits.length) {
      let o: THREE.Object3D | null = hits[0].object;
      while (o) {
        const obj = o;
        const found = this.pickables.find((p) => p.obj === obj);
        if (found) {
          const spot = this.spots.find((s) => s.id === found.spot);
          if (spot) return { x: spot.x, z: spot.z, spot: spot.id };
        }
        o = o.parent;
      }
    }
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.ground, p)) return null;
    // a click on a roof or beyond the town walks you to the nearest ground you can stand on
    const [x, z] = nearestWalkable(p.x, p.z);
    return { x, z, spot: null };
  }

  /**
   * head somewhere (a click, a tap, or a landmark named by the page): the way there is routed through the town's
   * shape from where you stand, and the marker ring is set down at the end of it
   */
  walkTo(x: number, z: number, spot: Spot | null = null) {
    const me = this.me.root.position;
    const path = routeTo(me.x, me.z, x, z);
    this.goal = { path, i: 0, spot, checkAt: performance.now() + 700, checkD: Infinity };
    const [ex, ez] = path[path.length - 1];
    this.marker.position.set(ex, 0.03, ez);
    (this.marker.material as THREE.MeshBasicMaterial).opacity = 0.85;
  }

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
    this.fovNow = this.fovFor(this.fovNow);
    this.camera.fov = this.fovNow;
    this.camera.updateProjectionMatrix();
  }

  /**
   * the view's width for the canvas's shape: the one wanted in landscape; a phone held upright opens out so the
   * plaza is not seen through a slot (about 37 degrees across at most phone shapes, where a 50 degree view gives 24)
   */
  private fovFor(landscape: number): number {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    return w < h ? Math.min(72, (2 * Math.atan(Math.tan((40 * Math.PI) / 360) / (w / h)) * 180) / Math.PI) : landscape;
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
    const steering = mag > 0.08;
    const me = this.me.root;
    if (steering) this.goal = null; // your hands on the keys or the stick: a click-walk ends
    let heading = this.meRy;
    let speed = 0;
    if (steering) {
      speed = (k.has("shift") || this.joy.length() > 0.95 ? SPRINT : WALK) * mag;
      // the camera sits at (sin yaw, cos yaw) behind you: forward (W, fz = -1) is away from it
      heading = Math.atan2(fx, fz) + this.yaw;
    } else if (this.goal) {
      const g = this.goal;
      const next = () => {
        g.i++;
        g.checkAt = now + 700;
        g.checkD = Infinity;
      };
      // a waypoint on the way is passed when you come within WAYPOINT_M of it; the last is the target itself
      while (g.i < g.path.length - 1 && Math.hypot(g.path[g.i][0] - me.position.x, g.path[g.i][1] - me.position.z) <= WAYPOINT_M) next();
      const last = g.i === g.path.length - 1;
      const [gx, gz] = g.path[g.i];
      const dx = gx - me.position.x;
      const dz = gz - me.position.z;
      const d = Math.hypot(dx, dz);
      const arriveAt = g.spot ? Math.min(0.9, g.spot.r * 0.4) : 0.3;
      if (last && d <= arriveAt) {
        this.arrive();
      } else {
        heading = Math.atan2(dx, dz);
        speed = last ? Math.min(WALK, d * 3 + 0.8) : WALK;
        // stuck against something: on to the next waypoint; at the last, open the spot if it is already in reach,
        // else give up
        if (now > g.checkAt) {
          if (g.checkD - d < 0.25) {
            if (!last) next();
            else if (g.spot && d < g.spot.r) this.arrive();
            else this.goal = null;
          } else {
            g.checkAt = now + 700;
            g.checkD = d;
          }
        }
      }
    }
    const moving = speed > 0.05;
    if (moving) {
      const x0 = me.position.x;
      const z0 = me.position.z;
      const p = this.collide(me.position.x + Math.sin(heading) * speed * dt, me.position.z + Math.cos(heading) * speed * dt, x0, z0);
      me.position.x = p.x;
      me.position.z = p.z;
      this.meRy = lerpAngle(this.meRy, heading, Math.min(1, dt * 12));
      me.rotation.y = this.meRy;
      this.gait = Math.hypot(p.x - x0, p.z - z0) / Math.max(dt, 1e-3) / WALK;
      // the camera swings in behind you as you go: not while you look round, not when you walk backwards
      const behind = this.meRy + Math.PI;
      const facingAway = Math.cos(behind - this.yaw) > -0.2;
      if (now - this.lastDragAt > 1500 && facingAway && (this.goal !== null || fz < -0.2)) this.yaw = lerpAngle(this.yaw, behind, Math.min(1, dt * 1.8));
    } else this.gait = 0;
    const mm = this.marker.material as THREE.MeshBasicMaterial;
    if (!this.goal && mm.opacity > 0) mm.opacity = Math.max(0, mm.opacity - dt * 2.5);
    const secs = now / 1000;
    this.me.fig.animate(dt, moving ? Math.min(1.7, this.gait) : 0, secs);
    if (moving || this.moved) this.cb.onMove(me.position.x, me.position.z, me.rotation.y, moving);
    this.moved = moving;

    // the others ease toward where the network put them
    for (const w of this.remotes.values()) {
      const d = w.target.clone().sub(w.root.position);
      const far = d.length() > 12;
      const step = far ? d : d.multiplyScalar(Math.min(1, dt * 10));
      w.root.position.add(step);
      w.root.rotation.y = lerpAngle(w.root.rotation.y, w.targetRy, Math.min(1, dt * 10));
      const pace = far ? 0 : step.length() / Math.max(dt, 1e-3) / WALK;
      w.pace += (pace - w.pace) * Math.min(1, dt * 6);
      w.fig.animate(dt, w.moving ? Math.min(1.7, Math.max(0.35, w.pace)) : 0, secs);
      if (w.bubble && now > w.bubbleUntil) {
        dropSprite(w.bubble);
        w.bubble = null;
      }
    }
    if (this.me.bubble && now > this.me.bubbleUntil) {
      dropSprite(this.me.bubble);
      this.me.bubble = null;
    }

    // the town's life: the passers-by by the clock, the carts, the birds (which scatter from everyone), the rest
    this.otherAt.length = 0;
    for (const w of this.remotes.values()) this.otherAt.push(w.root.position);
    this.life.update(dt, secs, this.camera.position, me.position, this.otherAt);
    // the wind on the stalls' awnings
    this.stallAwnings.forEach((a, i) => (a.rotation.x = 0.16 + 0.03 * Math.sin(secs * 1.6 + i * 1.9) + 0.012 * Math.sin(secs * 4.1 + i)));
    // the tower shows the hour the sky is printed at: UTC, the same for every visitor in the room (light.ts)
    this.city.update(secs, utcClock());
    // the coins turn and bob; one you walk onto is asked for (again after a moment, if the room has not answered)
    for (const [id, n] of this.looseNotes) {
      n.g.rotation.y = secs * 1.1 + n.phase;
      n.g.position.y = n.y + Math.sin(secs * 2.2 + n.phase) * 0.07;
      if (now - n.askedAt > 1500 && Math.hypot(n.x - me.position.x, n.z - me.position.z) <= NOTE_PICK_M) {
        n.askedAt = now;
        this.cb.onNote?.(id);
      }
    }
    for (const w of this.remotes.values()) this.detail(w);

    // Mr Bands, standing at his desk (his idle: breath, weight, a look round); the keepers at their doors likewise
    this.npc?.fig.animate(dt, 0, secs);
    for (const w of this.keepers) {
      const show = this.camera.position.distanceTo(w.root.position) < KEEPER_SHOW_M;
      w.root.visible = show;
      if (!show) continue;
      w.fig.animate(dt, 0, secs);
      this.detail(w);
    }
    // a signpost's board swings a little on its chains
    for (const s of [this.signpost, this.spillpost]) if (s?.g.visible) s.board.rotation.x = Math.sin(secs * 1.7) * 0.05;

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

    // the camera: behind and above, eased; the key light's shadow box follows you. On a climb it is held high over
    // the town, looking at the fountain, until its time is up
    const target = new THREE.Vector3(me.position.x, EYE, me.position.z);
    if (this.view && now > this.view.until) this.view = null;
    if (this.view) {
      this.camera.position.lerp(this.view.pos, Math.min(1, dt * 2));
      this.camera.lookAt(0, 4, 0);
    } else {
      const cam = new THREE.Vector3(
        target.x + Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist,
        target.y + Math.sin(this.pitch) * this.dist + 0.6,
        target.z + Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist,
      );
      this.camera.position.lerp(this.clearView(target, cam), Math.min(1, dt * 8));
      this.camera.lookAt(target);
      // a sway at the walk's cadence (the figure's strides a second, by its gait), rolled about the line of sight
      const g = Math.min(1, this.gait);
      if (moving) this.cadence = (this.cadence + dt * (1.15 + 0.65 * g) * Math.PI * 2) % (Math.PI * 2);
      this.roll += (SWAY * Math.sin(this.cadence) * g - this.roll) * Math.min(1, dt * 6);
      this.camera.rotateZ(this.roll);
    }
    // the view opens out beyond the rope, where the streets are long, and closes to the plaza's own inside it
    const r = Math.hypot(me.position.x, me.position.z);
    const fovWant = this.fovFor(r > WORLD_RADIUS ? FOV_OUT : FOV_PLAZA);
    if (Math.abs(fovWant - this.fovNow) > 0.01) {
      this.fovNow += (fovWant - this.fovNow) * Math.min(1, dt * 2.5);
      this.camera.fov = this.fovNow;
      this.camera.updateProjectionMatrix();
    }
    this.key.position.set(me.position.x - 16, 26, me.position.z + 13);
    this.key.target.position.set(me.position.x, 0, me.position.z);
  }

  /** contours on a figure near the camera, off one far from it (switched only when it crosses, with a metre of slack) */
  private detail(w: Walker) {
    const d = this.camera.position.distanceTo(w.root.position);
    // labels: no bigger on screen than at LABEL_NEAR_M when someone comes close, and names fade out across the plaza
    // (measured to the label itself, which floats well above the feet, nearer the camera)
    const cam = this.camera.position;
    const p = w.root.position;
    for (const s of [w.tag, w.bubble]) {
      const b = s?.userData.base as THREE.Vector3 | undefined;
      if (!s || !b) continue;
      const ds = Math.hypot(cam.x - p.x, cam.y - (p.y + s.position.y), cam.z - p.z);
      const f = Math.min(1, Math.max(0.2, ds / LABEL_NEAR_M));
      s.scale.set(b.x * f, b.y * f, 1);
      if (s === w.tag) {
        const o = 1 - Math.min(1, Math.max(0, (ds - TAG_FADE_M[0]) / (TAG_FADE_M[1] - TAG_FADE_M[0])));
        (s.material as THREE.SpriteMaterial).opacity = o;
        // (and none for someone right at the lens, between the camera and you)
        s.visible = o > 0.02 && ds > 3.5;
      }
    }
    const near = w.near ? d < DETAIL_M + 1 : d < DETAIL_M - 1;
    if (near === w.near) return;
    w.near = near;
    for (const l of w.lines) l.visible = near;
  }

  /** you reached a click-walk's end: stop, face the spot, open it */
  private arrive() {
    const spot = this.goal?.spot ?? null;
    this.goal = null;
    if (spot) this.cb.onInteract(spot);
  }

  /**
   * The camera's place with a clear view of you: walked from you toward where it wants to be, it stops short of the
   * first big thing in the way (a building's footprint, the board) and of every façade (the fences: a building is
   * taller than the camera ever goes, so those block at any height).
   */
  private clearView(target: THREE.Vector3, want: THREE.Vector3): THREE.Vector3 {
    const steps = 14;
    let ok = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = target.x + (want.x - target.x) * t;
      const z = target.z + (want.z - target.z) * t;
      const y = target.y + (want.y - target.y) * t;
      let blocked = false;
      for (const f of this.fences) if (segDist(f, x, z) < 0.8) blocked = true;
      if (!blocked && y < 11) {
        for (const c of this.colliders) if (c.r >= 1.5 && Math.hypot(x - c.x, z - c.z) < c.r) blocked = true;
        for (const b of this.walls) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) blocked = true;
      }
      if (blocked) break;
      ok = t;
    }
    if (ok >= 1) return want;
    const t = Math.max(0.25, ok - 0.03);
    return new THREE.Vector3(target.x + (want.x - target.x) * t, Math.max(1.2, target.y + (want.y - target.y) * t), target.z + (want.z - target.z) * t);
  }

  /**
   * Push a step out of every collider, off every façade's line and the rope's (to the side it came from, so a fast
   * step never slips through), and onto ground you can walk (town.ts's rule, the server's too: the last word)
   */
  private collide(x: number, z: number, fromX: number, fromZ: number): { x: number; z: number } {
    const R = 0.45;
    for (const f of this.fences) [x, z] = offLine(f, x, z, fromX, fromZ, R);
    for (const f of this.ropes) [x, z] = offLine(f, x, z, fromX, fromZ, R);
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
    const [wx, wz] = nearestWalkable(x, z);
    return { x: wx, z: wz };
  }

  dispose() {
    this.disposed = true;
    this.light.dispose();
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.renderer.dispose();
  }
}

/** a remote visitor's own look, from their id (so they look the same to everyone) */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** where the page's marker stands: a PLACES door, or the plaza's own two it may name, facing the fountain */
function markerAt(id: string): { x: number; z: number; facing: number } | null {
  const p = PLACES.find((q) => q.id === id);
  if (p) return p;
  const spot = id === PLACE_IDS.guardHouse ? GUARD_SPOT : id === PLACE_IDS.desk ? DESK_SPOT : null;
  return spot ? { x: spot.x, z: spot.z, facing: Math.atan2(-spot.x, -spot.z) } : null;
}

/** a signpost: its group, the board that swings on its arm, and its post's collider */
interface Signpost {
  g: THREE.Group;
  board: THREE.Group;
  hit: Circle;
}

/** an engraved signpost: an ink pole with a brass finial, an arm, and a board hanging from it on two chains, printed by `draw` */
function makeSignpost(draw: (c: CanvasRenderingContext2D, w: number, h: number) => void): Signpost {
  const g = new THREE.Group();
  const pole = part(new THREE.CylinderGeometry(0.06, 0.08, 3.6, 8), mat("Ink"));
  pole.position.y = 1.8;
  const arm = part(new THREE.BoxGeometry(1.3, 0.09, 0.09), mat("Ink"));
  arm.position.set(0.55, 3.5, 0);
  const finial = part(new THREE.SphereGeometry(0.09, 8, 6), mat("Brass"));
  finial.position.y = 3.66;
  const board = new THREE.Group();
  board.position.set(0.75, 3.46, 0);
  for (const x of [-0.32, 0.32]) {
    const chain = part(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 5), mat("Ink"));
    chain.position.set(x, -0.17, 0);
    board.add(chain);
  }
  const back = part(new THREE.BoxGeometry(0.94, 0.66, 0.04), mat("Wood"));
  back.position.y = -0.67;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.62), new THREE.MeshBasicMaterial({ map: signTexture(360, 248, draw) }));
  face.position.set(0, -0.67, 0.025);
  board.add(back, face);
  g.add(pole, arm, finial, board);
  return { g, board, hit: { x: 0, z: 0, r: SIGNPOST_R } };
}

/** an ink arrow pointing down a board, from y0 to y1 about x (a pointing hand would need a face; an arrow is cut as the rest of the town is) */
function arrowDown(c: CanvasRenderingContext2D, x: number, y0: number, y1: number) {
  const head = y1 - Math.min(48, (y1 - y0) * 0.45);
  c.fillStyle = INK;
  c.beginPath();
  c.moveTo(x - 22, y0);
  c.lineTo(x + 22, y0);
  c.lineTo(x + 22, head);
  c.lineTo(x + 56, head);
  c.lineTo(x, y1);
  c.lineTo(x - 56, head);
  c.lineTo(x - 22, head);
  c.closePath();
  c.fill();
}

/**
 * a coin's two faces in one geometry, a hair off each end of the cylinder: the bottom one turned so its B reads
 * upright from behind once the coin stands on its edge. Built once, shared by every coin
 */
let coinFacesGeo: THREE.BufferGeometry | null = null;
function coinFaces(): THREE.BufferGeometry {
  if (!coinFacesGeo) {
    const lift = COIN_H / 2 + 0.003;
    const top = new THREE.CircleGeometry(COIN_R, 28).rotateX(-Math.PI / 2).translate(0, lift, 0);
    const bottom = new THREE.CircleGeometry(COIN_R, 28).rotateZ(Math.PI).rotateX(Math.PI / 2).translate(0, -lift, 0);
    coinFacesGeo = mergeGeometries([top, bottom]);
    top.dispose();
    bottom.dispose();
  }
  return coinFacesGeo;
}

/**
 * the stamp on a coin's faces, drawn once to a small canvas in the house faces: brass as the engraver hatches it, a
 * ring at the rim (two on a mint mark), a B in the middle. One material for the coins, one for the marks
 */
const coinFaceMats = new Map<boolean, THREE.MeshBasicMaterial>();
function coinFace(mark: boolean): THREE.MeshBasicMaterial {
  let m = coinFaceMats.get(mark);
  if (m) return m;
  const px = 128;
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const g = c.getContext("2d")!;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, px, px);
  // the hatch that reads as brass on every other brass thing in the plaza
  g.strokeStyle = INK;
  g.globalAlpha = 0.28;
  g.lineWidth = 1.2;
  for (let d = -px; d < px * 2; d += 5) {
    g.beginPath();
    g.moveTo(d, 0);
    g.lineTo(d - px, px);
    g.stroke();
  }
  g.globalAlpha = 1;
  const mid = px / 2;
  g.lineWidth = 4;
  for (const r of mark ? [mid - 7, mid - 16] : [mid - 8]) {
    g.beginPath();
    g.arc(mid, mid, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = INK;
  g.font = `700 ${mark ? 60 : 74}px ${CAPS}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("B", mid, mid + 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.anisotropy = 4;
  m = new THREE.MeshBasicMaterial({ map: t });
  coinFaceMats.set(mark, m);
  return m;
}

/** a point within r of a line on the ground, put r off it on the side the step came from; any other point as it is */
function offLine(f: Seg, x: number, z: number, fromX: number, fromZ: number, r: number): [number, number] {
  const dx = f.x1 - f.x0;
  const dz = f.z1 - f.z0;
  const len2 = dx * dx + dz * dz;
  const t = Math.min(1, Math.max(0, ((x - f.x0) * dx + (z - f.z0) * dz) / len2));
  const px = f.x0 + dx * t;
  const pz = f.z0 + dz * t;
  if (Math.hypot(x - px, z - pz) >= r) return [x, z];
  // the line's normal, turned to the side the step came from
  let nx = -dz / Math.sqrt(len2);
  let nz = dx / Math.sqrt(len2);
  if ((fromX - f.x0) * nx + (fromZ - f.z0) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  return [px + nx * r, pz + nz * r];
}

/** how far a point on the ground is from a fence */
function segDist(f: Seg, x: number, z: number): number {
  const dx = f.x1 - f.x0;
  const dz = f.z1 - f.z0;
  const t = Math.min(1, Math.max(0, ((x - f.x0) * dx + (z - f.z0) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (f.x0 + dx * t), z - (f.z0 + dz * t));
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
