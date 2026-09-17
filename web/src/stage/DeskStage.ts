import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SPECS, PAPER, engraveMaterial, glassMaterial, outlineMaterial, outlineRes, shared, type EngraveKind } from "./engrave";

/**
 * THE DESK: the one world the page travels through. The model is web/3d/build_desk.py's (Blender); this
 * loads it, redraws it as an engraving, lays out one tray per open band from the live feed (a strapped
 * bundle for every bin that still holds SOL, a dark slab for every bin the price has crossed, the cursor
 * where the price is), puts one coin in the dish for every tenth of a SOL of fees, and flies a camera
 * between the stations authored in the file as the page's scroll progress asks.
 *
 * It renders on demand: a frame is drawn only when the camera, the data or the size changed.
 */

export interface StageBand {
  label: string;
  lowerPrice: number;
  upperPrice: number;
  activePrice: number;
  bins: number;
}
export interface StageData {
  bands: StageBand[];
  /** fees earned, in SOL: one coin a tenth */
  feesSol: number;
  /** the abacus: coins standing on each seat, oldest bucket first; the last entry is the newest bucket and takes the last seat */
  chart?: number[];
}

const MAX_ROWS = 2;
const MAX_BINS = 70;
const MAX_COINS = 140;
const MAX_CHART_COINS = 24 * 18;
const BAND_SHARE = 0.68; // the band takes this share of the scale's length; the rest is room for the price to be outside it
const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

interface Row {
  group: THREE.Group;
  cursor: THREE.Object3D;
  stacks: THREE.InstancedMesh;
  straps: THREE.InstancedMesh;
  chips: THREE.InstancedMesh;
  outlines: THREE.InstancedMesh[];
  cursorX: number;
  cursorTarget: number;
}

export class DeskStage {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1.6, 0.5, 400);
  private key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.72);
  private camCurve: THREE.CatmullRomCurve3 | null = null;
  private lookCurve: THREE.CatmullRomCurve3 | null = null;
  private fovs: number[] = [];
  private camPts: THREE.Vector3[] = [];
  private lookPts: THREE.Vector3[] = [];
  private follows: string[] = [];
  private drifts: THREE.Vector3[] = [];
  private library = new Map<string, { cam: THREE.Vector3; look: THREE.Vector3; fov: number; follow: string; drift: THREE.Vector3 }>();
  private routeNames: string[] = [];
  private hold = 0.5;
  private holdNow = 0.5;
  private chartCoins: THREE.InstancedMesh | null = null;
  private chartOutline: THREE.InstancedMesh | null = null;
  private chartOrigin = new THREE.Vector3();
  private chartSeats = 24;
  private chartPitch = 0.62;
  /** called after every drawn frame, for labels pinned to things on the desk */
  onFrame: (() => void) | null = null;
  private frames: { x: number; y: number }[] = [];
  private tallFrames: { x: number; y: number }[] = [];
  private rows: Row[] = [];
  private protos: Record<string, THREE.Mesh | THREE.Object3D> = {};
  private coins: THREE.InstancedMesh | null = null;
  private coinOutline: THREE.InstancedMesh | null = null;
  private coinSpots: THREE.Vector3[] = [];
  private rowLen = 16;
  private mats = new Map<string, THREE.Material>();
  private outline = outlineMaterial(1.35);
  private data: StageData = { bands: [], feesSol: 0 };
  private pTarget = 0;
  private pNow = 0;
  private pointer = new THREE.Vector2();
  private pointerNow = new THREE.Vector2();
  private dirty = true;
  private raf = 0;
  private last = 0;
  private motion = true;
  private fade = 1;
  private fadeTarget = 1;
  private disposed = false;
  private visible = true;
  private dprCap = 2;
  private slow = 0;
  private skip = false;
  stations = 0;
  ready = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(new THREE.Color().setRGB(...hexRgb(PAPER), THREE.LinearSRGBColorSpace), 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.5));
    this.key.position.set(-16, 26, 13);
    this.key.target.position.set(0, 0, 0);
    this.key.castShadow = true;
    const sc = this.key.shadow.camera;
    sc.left = -24; sc.right = 24; sc.top = 16; sc.bottom = -16; sc.near = 4; sc.far = 80;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.04;
    this.key.shadow.radius = 3;
    this.scene.add(this.key, this.key.target);
    shared.uLightDir.value.copy(this.key.position).normalize();
    shared.uFade.value = 1;
  }

  async load(url: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    if (this.disposed) return;
    const root = gltf.scene;
    root.updateMatrixWorld(true);

    // the numbers the Blender file carries
    const info = root.getObjectByName("Info");
    const groundY = num(info?.userData.ground_z, -0.22);
    this.rowLen = num(info?.userData.row_len, 16);

    // camera stations, by name: every Cam.<name> carries its station name, and Look.<name> is what it looks at
    const looksByName = new Map<string, THREE.Object3D>();
    root.traverse((o) => {
      const m = /^Look\.?(.+)$/.exec(o.name);
      if (m) looksByName.set(m[1], o);
    });
    root.traverse((o) => {
      const name = o.userData.station;
      if (typeof name !== "string") return;
      const l = looksByName.get(name);
      if (!l) return;
      this.library.set(name, {
        cam: o.getWorldPosition(new THREE.Vector3()),
        look: l.getWorldPosition(new THREE.Vector3()),
        fov: num(o.userData.fov, 30),
        follow: typeof o.userData.follow === "string" ? o.userData.follow : "",
        // Blender's (x, y, z) is three's (x, z, -y)
        drift: new THREE.Vector3(num(o.userData.drift_x, 0), num(o.userData.drift_z, 0), -num(o.userData.drift_y, 0)),
      });
    });

    // prototypes leave the scene; the rows are built from them
    const protoRoot = root.getObjectByName("Protos");
    if (protoRoot) {
      for (const child of [...protoRoot.children]) this.protos[child.name.replace(/^Proto\.?/, "")] = child;
      protoRoot.removeFromParent();
    }

    // the desk: every mesh becomes an engraving with a contour
    this.dress(root);
    this.scene.add(root);

    // the paper the desk stands on
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), this.material("Ground"));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = groundY;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // the dish's coins
    const coinProto = this.mesh("Coin");
    const dish = root.getObjectByName("DishCoins") ?? root.getObjectByName("Dish.Coins");
    if (coinProto && dish) {
      const at = dish.getWorldPosition(new THREE.Vector3());
      this.coinSpots = coinLayout(at, 1.32, 0.3, 0.06);
      this.coins = this.instanced(coinProto, MAX_COINS, "Brass");
      this.coinOutline = this.instanced(coinProto, MAX_COINS, null);
      this.scene.add(this.coins, this.coinOutline);
    }

    // the abacus: columns of the same coin on the plinth's seats
    const seats = root.getObjectByName("ChartSeats") ?? root.getObjectByName("Chart.Seats");
    if (coinProto && seats) {
      seats.getWorldPosition(this.chartOrigin);
      this.chartSeats = num(seats.userData.count, 24);
      this.chartPitch = num(seats.userData.pitch, 0.62);
      this.chartCoins = this.instanced(coinProto, MAX_CHART_COINS, "Brass");
      this.chartOutline = this.instanced(coinProto, MAX_CHART_COINS, null);
      this.scene.add(this.chartCoins, this.chartOutline);
    }

    for (let i = 0; i < MAX_ROWS; i++) this.rows.push(this.buildRow());
    this.buildRoute();
    this.ready = true;
    this.applyData();
    this.resize();
    this.fadeTarget = 0;
    this.start();
  }

  // ------------------------------------------------------------------ materials
  private material(name: string, half?: THREE.Vector3, hasUv = false): THREE.Material {
    const key = `${name}:${half ? half.toArray().map((n) => n.toFixed(3)).join(",") : ""}:${hasUv}`;
    let m = this.mats.get(key);
    if (!m) {
      if (name === "Glass") m = glassMaterial();
      else {
        const spec = SPECS[name] ?? SPECS.Paper;
        m = engraveMaterial({ ...spec, kind: spec.kind as EngraveKind | undefined, half, hasUv, doubleSide: name === "Tape" });
      }
      this.mats.set(key, m);
    }
    return m;
  }

  private dress(root: THREE.Object3D) {
    const adds: [THREE.Object3D, THREE.Mesh][] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const name = (mesh.material as THREE.Material).name || "Paper";
      const glass = name === "Glass";
      let half: THREE.Vector3 | undefined;
      if (SPECS[name]?.kind === "bill" || SPECS[name]?.kind === "page") {
        mesh.geometry.computeBoundingBox();
        half = mesh.geometry.boundingBox!.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      }
      mesh.material = this.material(name, half, name === "Tape");
      mesh.castShadow = !glass && name !== "Tape";
      mesh.receiveShadow = !glass;
      if (glass) mesh.renderOrder = 5;
      const wantsOutline = !glass && name !== "Tape" && mesh.userData.outline !== 0 && mesh.parent?.userData.outline !== 0;
      if (wantsOutline) {
        const hull = new THREE.Mesh(mesh.geometry, this.outline);
        hull.name = `${mesh.name}.contour`;
        adds.push([mesh, hull]);
      }
    });
    for (const [mesh, hull] of adds) mesh.add(hull);
  }

  private mesh(proto: string): THREE.Mesh | null {
    const o = this.protos[proto];
    if (!o) return null;
    let found: THREE.Mesh | null = null;
    o.traverse((c) => {
      if (!found && (c as THREE.Mesh).isMesh) found = c as THREE.Mesh;
    });
    return found;
  }

  /**
   * An instanced copy of a prototype mesh. The geometry stays in the prototype's own space (the bill's
   * drawing depends on that); the prototype's node offset is folded into every instance matrix instead.
   */
  private offsets = new Map<THREE.InstancedMesh, THREE.Matrix4>();
  private instanced(proto: THREE.Mesh, count: number, mat: string | null): THREE.InstancedMesh {
    const g = proto.geometry;
    g.computeBoundingBox();
    const half = g.boundingBox!.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const material = mat === null ? this.outline : this.material(mat, SPECS[mat]?.kind === "bill" ? half : undefined);
    const im = new THREE.InstancedMesh(g, material, count);
    im.count = 0;
    im.castShadow = mat !== null;
    im.receiveShadow = mat !== null;
    im.frustumCulled = false;
    proto.updateMatrix();
    this.offsets.set(im, proto.matrix.clone());
    return im;
  }
  private put(im: THREE.InstancedMesh, i: number, m: THREE.Matrix4) {
    im.setMatrixAt(i, tmpM2.multiplyMatrices(m, this.offsets.get(im)!));
  }

  /** The page's beats, in order, each naming the station it stands at. */
  setRoute(names: string[]) {
    this.routeNames = names;
    if (this.ready) this.buildRoute();
  }
  private buildRoute() {
    const names = this.routeNames.length ? this.routeNames : [...this.library.keys()];
    const known = names.map((n) => this.library.get(n) ?? this.library.get("hero")).filter((s): s is NonNullable<typeof s> => !!s);
    this.camPts = known.map((s) => s.cam);
    this.lookPts = known.map((s) => s.look);
    this.fovs = known.map((s) => s.fov);
    this.follows = known.map((s) => s.follow);
    this.drifts = known.map((s) => s.drift);
    this.stations = known.length;
    this.route();
  }

  /**
   * The camera's road through the stations. A station that follows the cursor slides along the tray to where the
   * price is; one that follows a row moves with that tray (a lone band sits mid-desk, two sit front and back).
   */
  private route() {
    if (this.camPts.length < 2) return;
    const authoredZ = [1.9, -2.3];
    const cams: THREE.Vector3[] = [];
    const looks: THREE.Vector3[] = [];
    this.camPts.forEach((c, i) => {
      const cam = c.clone();
      const look = this.lookPts[i].clone();
      const follow = this.follows[i];
      const front = this.rows.find((r) => r.group.visible);
      if (follow === "cursor" && front) {
        const to = new THREE.Vector3(front.group.position.x + front.cursorTarget, look.y, front.group.position.z + 0.4);
        cam.add(to.clone().sub(look));
        look.copy(to);
      } else if (follow === "row0" || follow === "row1") {
        const k = follow === "row0" ? 0 : 1;
        const row = this.rows[k];
        if (row?.group.visible) {
          const dz = row.group.position.z - authoredZ[k];
          cam.z += dz;
          look.z += dz;
          // and along it to where the price is, so the cursor is what the camera is looking at
          const dx = Math.max(-4.5, Math.min(4.5, row.group.position.x + row.cursorTarget)) - look.x;
          cam.x += dx;
          look.x += dx;
        }
      }
      // two beats at the same spot would make a zero-length leg: nudge the second a hair
      if (cams.length && cams[cams.length - 1].distanceToSquared(cam) < 1e-6) cam.x += 0.01;
      if (looks.length && looks[looks.length - 1].distanceToSquared(look) < 1e-6) look.x += 0.01;
      cams.push(cam);
      looks.push(look);
    });
    this.camCurve = new THREE.CatmullRomCurve3(cams, false, "centripetal");
    this.lookCurve = new THREE.CatmullRomCurve3(looks, false, "centripetal");
  }

  // ------------------------------------------------------------------ rows
  private buildRow(): Row {
    const group = new THREE.Group();
    group.visible = false;
    const tray = this.protos.Tray?.clone(true);
    const cursor = this.protos.Cursor?.clone(true) ?? new THREE.Group();
    if (tray) {
      tray.position.set(0, 0, 0);
      this.dress(tray);
      group.add(tray);
    }
    cursor.position.set(0, 0, 0);
    this.dress(cursor);
    group.add(cursor);
    const stackP = this.mesh("Stack")!;
    const strapP = this.mesh("Strap")!;
    const chipP = this.mesh("Chip")!;
    const stacks = this.instanced(stackP, MAX_BINS, "Bill");
    const straps = this.instanced(strapP, MAX_BINS, "Strap");
    const chips = this.instanced(chipP, MAX_BINS, "Chip");
    const outlines = [this.instanced(stackP, MAX_BINS, null), this.instanced(chipP, MAX_BINS, null)];
    group.add(stacks, straps, chips, ...outlines);
    this.scene.add(group);
    return { group, cursor, stacks, straps, chips, outlines, cursorX: 0, cursorTarget: 0 };
  }

  setData(data: StageData) {
    this.data = data;
    if (this.ready) this.applyData();
  }

  private applyData() {
    const bands = this.data.bands.slice(0, MAX_ROWS);
    const centreX = -1.4;
    const rowZ = bands.length <= 1 ? [-0.2] : [1.9, -2.3]; // three's z is Blender's -y: the first band sits in front
    this.rows.forEach((row, i) => {
      const band = bands[i];
      row.group.visible = !!band;
      if (!band) return;
      row.group.position.set(centreX, 0, rowZ[i]);
      const n = Math.max(1, Math.min(MAX_BINS, Math.round(band.bins)));
      const bandLen = this.rowLen * BAND_SHARE;
      const pitch = bandLen / n;
      const x0 = -bandLen / 2;
      // bins are geometric in price, so the price's place along the band is a ratio of logs
      const t = band.upperPrice > band.lowerPrice && band.activePrice > 0 ? Math.log(band.activePrice / band.lowerPrice) / Math.log(band.upperPrice / band.lowerPrice) : 0.5;
      const edge = this.rowLen / 2 - 0.35;
      row.cursorTarget = Math.max(-edge, Math.min(edge, x0 + t * bandLen));
      if (!row.cursorX) row.cursorX = row.cursorTarget;
      let nCash = 0;
      let nChip = 0;
      for (let b = 0; b < n; b++) {
        const x = x0 + (b + 0.5) * pitch;
        const holdsSol = (b + 0.5) / n <= t; // the price is above this bin, so it still holds his SOL
        tmpM.compose(tmpP.set(x, 0.16, 0), tmpQ.identity(), tmpS.set(pitch * 0.86, 1, 1));
        if (holdsSol) {
          this.put(row.stacks, nCash, tmpM);
          this.put(row.straps, nCash, tmpM);
          this.put(row.outlines[0], nCash, tmpM);
          nCash++;
        } else {
          this.put(row.chips, nChip, tmpM);
          this.put(row.outlines[1], nChip, tmpM);
          nChip++;
        }
      }
      row.stacks.count = row.straps.count = row.outlines[0].count = nCash;
      row.chips.count = row.outlines[1].count = nChip;
      for (const im of [row.stacks, row.straps, row.chips, ...row.outlines]) im.instanceMatrix.needsUpdate = true;
    });
    if (this.coins && this.coinOutline) {
      const n = Math.max(0, Math.min(MAX_COINS, this.coinSpots.length, Math.floor(this.data.feesSol / 0.1 + 1e-9)));
      for (let i = 0; i < n; i++) {
        tmpM.compose(this.coinSpots[i], tmpQ.identity(), tmpS.set(1, 1, 1));
        this.put(this.coins, i, tmpM);
        this.put(this.coinOutline, i, tmpM);
      }
      this.coins.count = this.coinOutline.count = n;
      this.coins.instanceMatrix.needsUpdate = this.coinOutline.instanceMatrix.needsUpdate = true;
    }
    if (this.chartCoins && this.chartOutline) {
      const cols = (this.data.chart ?? []).slice(-this.chartSeats);
      const firstSeat = this.chartSeats - cols.length;
      let n = 0;
      cols.forEach((coins, c) => {
        for (let k = 0; k < Math.min(18, Math.max(0, Math.round(coins))) && n < MAX_CHART_COINS; k++) {
          tmpM.compose(tmpP.set(this.chartOrigin.x + (firstSeat + c) * this.chartPitch, this.chartOrigin.y + k * 0.064, this.chartOrigin.z), tmpQ.identity(), tmpS.set(0.86, 1, 0.86));
          this.put(this.chartCoins!, n, tmpM);
          this.put(this.chartOutline!, n, tmpM);
          n++;
        }
      });
      this.chartCoins.count = this.chartOutline.count = n;
      this.chartCoins.instanceMatrix.needsUpdate = this.chartOutline.instanceMatrix.needsUpdate = true;
    }
    this.route();
    this.renderer.shadowMap.needsUpdate = true;
    this.dirty = true;
  }

  /** Where a named thing on the desk is in the window, in CSS pixels: "row0.cursor", "row0.low", "row0.high". Null when it is not there. */
  project(key: string): { x: number; y: number } | null {
    const m = /^row(\d)\.(cursor|low|high)$/.exec(key);
    if (!m) return null;
    const row = this.rows[+m[1]];
    if (!row?.group.visible) return null;
    const bandLen = this.rowLen * BAND_SHARE;
    const x = m[2] === "cursor" ? row.cursorX : m[2] === "low" ? -bandLen / 2 : bandLen / 2;
    const y = m[2] === "cursor" ? 1.75 : 0.5;
    const z = m[2] === "cursor" ? 0 : 1.55;
    tmpP.set(row.group.position.x + x, y, row.group.position.z + z).project(this.camera);
    if (tmpP.z > 1) return null;
    return { x: ((tmpP.x + 1) / 2) * (this.canvas.clientWidth || 1), y: ((1 - tmpP.y) / 2) * (this.canvas.clientHeight || 1) };
  }

  // ------------------------------------------------------------------ the journey
  /** p is the station the page is at, a float: 0 is the hero, 1.5 is half way from the first beat to the second. */
  setProgress(p: number, hold = 0.5) {
    this.hold = hold;
    this.pTarget = Math.max(0, Math.min(Math.max(0, this.stations - 1), p));
    if (!this.motion) this.pNow = this.pTarget;
    this.dirty = true;
  }
  /** Where the subject stands at each station, as a shift of the picture in window fractions (x right, y down), so it clears the words. */
  setFrames(frames: { x: number; y: number }[], tall: { x: number; y: number }[] = []) {
    this.frames = frames;
    this.tallFrames = tall;
    this.dirty = true;
  }
  setPointer(x: number, y: number) {
    this.pointer.set(x, y);
    this.dirty = true;
  }
  setMotion(on: boolean) {
    this.motion = on;
    if (!on) {
      this.pNow = this.pTarget;
      this.pointer.set(0, 0);
    }
    this.dirty = true;
  }
  setVisible(v: boolean) {
    this.visible = v;
    if (v) this.dirty = true;
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, w < 700 ? 1.75 : 2, this.dprCap);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    outlineRes.value.set(w, h);
    shared.uPitch.value = 5.4 * dpr;
    (this.outline.uniforms.uWidth as { value: number }).value = 1.3;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private start() {
    const tick = (t: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (t - (this.last || t)) / 1000);
      this.last = t;
      if (!this.visible) return;
      let moving = false;
      // the camera trails the page a little, so a wheel tick becomes a glide
      const dp = this.pTarget - this.pNow;
      if (Math.abs(dp) > 0.0004) {
        this.pNow += dp * (this.motion ? 1 - Math.exp(-dt * 7) : 1);
        moving = true;
      }
      if (Math.abs(this.hold - this.holdNow) > 0.002) moving = true;
      const dx = this.pointer.x - this.pointerNow.x;
      const dy = this.pointer.y - this.pointerNow.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.0005) {
        this.pointerNow.x += dx * (1 - Math.exp(-dt * 4));
        this.pointerNow.y += dy * (1 - Math.exp(-dt * 4));
        moving = true;
      }
      for (const row of this.rows) {
        const d = row.cursorTarget - row.cursorX;
        if (Math.abs(d) > 0.002) {
          row.cursorX += d * (this.motion ? 1 - Math.exp(-dt * 3) : 1);
          this.renderer.shadowMap.needsUpdate = true;
          moving = true;
        }
        row.cursor.position.x = row.cursorX;
      }
      const df = this.fadeTarget - this.fade;
      if (Math.abs(df) > 0.002) {
        this.fade += df * (1 - Math.exp(-dt * 2.4));
        shared.uFade.value = this.fade;
        moving = true;
      }
      // the ticker feeds its tape while motion is on: a slow, steady sign of life, drawn at half the frame rate
      if (this.motion && !moving && !this.dirty) {
        this.skip = !this.skip;
        if (this.skip) return;
        shared.uFeed.value = (t / 1000) * 0.22;
      } else if (!moving && !this.dirty) return;
      else if (this.motion) shared.uFeed.value = (t / 1000) * 0.22;
      this.dirty = false;
      this.place();
      this.renderer.render(this.scene, this.camera);
      this.onFrame?.();
      // a slow machine gets a coarser plate, not a stuttering one: step the pixel ratio down while frames run long
      if (moving && dt > 0.034) {
        if (++this.slow > 24 && this.dprCap > 1) {
          this.dprCap = Math.max(1, this.dprCap - 0.25);
          this.slow = 0;
          this.resize();
        }
      } else if (moving) this.slow = Math.max(0, this.slow - 1);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** dev only: hold the camera at a pose given in three's coordinates */
  debugPose: { pos: THREE.Vector3; look: THREE.Vector3; fov: number } | null = null;
  debugFrame: { x: number; y: number } | null = null;

  private place() {
    if (this.debugPose) {
      const w = this.canvas.clientWidth || 1;
      const h = this.canvas.clientHeight || 1;
      this.camera.position.copy(this.debugPose.pos);
      this.camera.fov = this.debugPose.fov;
      const fr = this.debugFrame ?? { x: 0, y: 0 };
      this.camera.setViewOffset(w, h, -fr.x * w, -fr.y * h, w, h);
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(this.debugPose.look);
      return;
    }
    if (!this.camCurve || !this.lookCurve) return;
    const u = this.stations > 1 ? this.pNow / (this.stations - 1) : 0;
    const pos = this.camCurve.getPoint(u);
    const look = this.lookCurve.getPoint(u);
    const i = Math.min(this.fovs.length - 2, Math.floor(this.pNow));
    const f = this.pNow - i;
    const fov = this.fovs.length > 1 ? this.fovs[i] * (1 - f) + this.fovs[i + 1] * f : 30;
    // while a long block of words scrolls past, the camera wanders along its station's drift
    const k = Math.round(this.pNow);
    const near = Math.max(0, 1 - Math.abs(this.pNow - k) * 2.5);
    const drift = this.drifts[k];
    if (drift && near > 0 && drift.lengthSq() > 0) {
      this.holdNow += (this.hold - this.holdNow) * 0.12;
      const w = (this.holdNow - 0.5) * near;
      pos.addScaledVector(drift, w);
      look.addScaledVector(drift, w);
    }
    // a tall window sees a narrow slice: stand further back so the same things stay in frame
    const aspect = this.camera.aspect;
    const back = aspect < 1.35 ? Math.min(1.55, Math.pow(1.35 / aspect, 0.9)) : 1;
    pos.sub(look).multiplyScalar(back).add(look);
    // the pointer leans the camera a touch, like a head moving over the desk
    const right = tmpP.copy(pos).sub(look).cross(this.camera.up).normalize();
    pos.addScaledVector(right, this.pointerNow.x * -0.5);
    pos.y += this.pointerNow.y * 0.3;
    this.camera.position.copy(pos);
    this.camera.fov = fov;
    // the subject stands clear of the words: shift the picture sideways in a wide window, upward in a tall one
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const set = aspect >= 1.05 ? this.frames : this.tallFrames;
    const f0 = this.debugFrame ?? set[Math.max(0, i)] ?? { x: 0, y: 0 };
    const f1 = this.debugFrame ?? set[Math.max(0, i) + 1] ?? f0;
    const fx = f0.x * (1 - f) + f1.x * f;
    const fy = f0.y * (1 - f) + f1.y * f;
    this.camera.setViewOffset(w, h, -fx * w, -fy * h, w, h);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(look);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const m of this.mats.values()) m.dispose();
    this.outline.dispose();
    this.renderer.dispose();
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Coins in columns of ten on rings inside the dish: the first ten make one column, and so on outward. */
function coinLayout(at: THREE.Vector3, radius: number, r: number, h: number): THREE.Vector3[] {
  const spots: THREE.Vector3[] = [];
  const cols: [number, number][] = [[0, 0]];
  for (let ring = 1; ring * r * 2.15 + r <= radius; ring++) {
    const R = ring * r * 2.15;
    const n = Math.floor((2 * Math.PI * R) / (r * 2.12));
    for (let k = 0; k < n; k++) cols.push([R * Math.cos((k / n) * Math.PI * 2 + ring), R * Math.sin((k / n) * Math.PI * 2 + ring)]);
  }
  for (const [x, z] of cols) for (let k = 0; k < 10; k++) spots.push(new THREE.Vector3(at.x + x, at.y + k * (h + 0.004), at.z + z));
  return spots;
}
