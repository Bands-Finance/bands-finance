// record-town.mjs --shot descent|desk [--out data-video] [--url https://bands.finance/#/play?debug]
//
// Rendered, not generated: the live town's own camera is driven through keyframes and the WebGL canvas is recorded
// in-page (MediaRecorder on canvas.captureStream, VP9 at 24 Mbit/s), so the board, the signs and the style are the real
// ones (Zach, 25 Sep: no slop, the text always readable). Same CDP harness as capture-town.mjs; the HUD and the site
// header are hidden and the canvas is made full-bleed at 1920x1080 before recording. The webm is converted to an mp4
// with ffmpeg when it is on the PATH, and review stills are cut from it into <out>/review/.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => { if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]); return acc; }, []));
const SHOT = args.shot ?? "descent";
const OUT = args.out ?? "data-video";
const URL = args.url ?? "https://bands.finance/#/play?debug";
fs.mkdirSync(path.join(OUT, "review"), { recursive: true });

const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9863;
const prof = fs.mkdtempSync(path.join(OUT, "prof-"));
const proc = spawn(CH, ["--headless=new", "--use-angle=metal", "--no-first-run", "--autoplay-policy=no-user-gesture-required", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--window-size=1920,1080", "about:blank"], { stdio: "ignore" });
let list;
for (let i = 0; i < 60; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails?.exception?.description?.slice(0, 160)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed"); return r.result?.result?.value; };
const click = (label) => ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
const until = async (expr, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } return false; };
const hideHud = () => ev(`(() => { let n = 0; for (const el of document.querySelectorAll('[class*="play__"]')) { if (el.tagName !== 'CANVAS' && !el.querySelector('canvas')) { el.style.visibility = 'hidden'; n++; } } for (const h of document.querySelectorAll('header, nav')) { if (!h.querySelector('canvas')) { h.style.display = 'none'; n++; } } const c = document.querySelector('canvas'); if (c) { c.style.position = 'fixed'; c.style.inset = '0'; c.style.width = '100vw'; c.style.height = '100vh'; } window.dispatchEvent(new Event('resize')); return n; })()`);
const finish = async (code) => { ws.close(); proc.kill(); await sleep(300); fs.rmSync(prof, { recursive: true, force: true }); process.exit(code); };

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL });
if (!(await until("!!document.querySelector('.play__gate button:not([disabled])')", 45000))) { console.error("the gate never opened"); await finish(1); }
await click("Enter the Exchange");
console.log("online:", await until("(document.querySelector('.play__net')||{}).textContent?.startsWith('Online')", 20000));
await sleep(3000);
console.log("hud hidden:", await hideHud());
await sleep(1500);
await hideHud();

// The recorder and the camera programs live in the page. A program is a list of keyframes {t, dist, pitch} eased with
// smoothstep between neighbours, plus optional actions at times (a walk to a spot). It resolves when the last keyframe is
// past, or when `untilPanel` is set and the interior panel has opened (an arrival), plus a hold.
await ev(`(() => {
  const w = window.__world;
  const ease = (a, b, u) => a + (b - a) * (u * u * (3 - 2 * u));
  window.__rig = {
    rec: null, chunks: [], b64: null,
    start() {
      const c = document.querySelector('canvas');
      const stream = c.captureStream(30);
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 24_000_000 });
      this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
      this.rec.start(250);
      return mime;
    },
    async stop() {
      await new Promise((r) => { this.rec.onstop = r; this.rec.stop(); });
      const blob = new Blob(this.chunks, { type: this.rec.mimeType });
      const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      this.b64 = url.slice(url.indexOf(',') + 1);
      return blob.size;
    },
    program(keys, opts = {}) {
      if (opts.face === 'front' && !w.__setMyPositionOrig) { w.__setMyPositionOrig = w.setMyPosition; w.setMyPosition = function (x, z, ry, face) { return w.__setMyPositionOrig.call(w, x, z, ry, false); }; }
      window.__rigLog = [];
      return new Promise((resolve) => {
        const t0 = performance.now(); let done = false; let arrivedAt = null; let frame = 0;
        const step = () => {
          const t = (performance.now() - t0) / 1000;
          const yawBefore = w.yaw;
          let i = 0; while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
          const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
          const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
          w.dist = ease(a.dist, b.dist, u); w.pitch = ease(a.pitch, b.pitch, u);
          if (a.yaw !== undefined && b.yaw !== undefined) w.yaw = ease(a.yaw, b.yaw, u);
          if (opts.face === 'front') { w.lastDragAt = performance.now(); w.yaw = w.meRy + (opts.faceOffset ?? 0); }
          if (++frame % 15 === 0) { const front = w.meRy + (opts.faceOffset ?? 0); const err = Math.atan2(Math.sin(yawBefore - front), Math.cos(yawBefore - front)); const dx = w.camera.position.x - w.me.root.position.x, dz = w.camera.position.z - w.me.root.position.z; const camAng = Math.atan2(dx, dz); const camErr = Math.atan2(Math.sin(camAng - w.meRy), Math.cos(camAng - w.meRy)); window.__rigLog.push([Math.round(t * 10) / 10, Math.round(err * 100) / 100, Math.round(camErr * 100) / 100, Math.round(Math.hypot(dx, dz) * 10) / 10]); }
          for (const act of opts.actions ?? []) if (!act.done && t >= act.t) { act.done = true; act.run(w); }
          if (opts.untilPanel && arrivedAt === null && document.querySelector('.play__panel')) { arrivedAt = t; for (const el of document.querySelectorAll('[class*="play__"]')) if (el.tagName !== 'CANVAS' && !el.querySelector('canvas')) el.style.visibility = 'hidden'; }
          if (arrivedAt !== null && opts.arrive) { const v = Math.min(1, (t - arrivedAt) / (opts.hold ?? 3)); w.dist = ease(opts.arrive.fromDist ?? w.dist, opts.arrive.dist, v); w.pitch = ease(opts.arrive.fromPitch ?? w.pitch, opts.arrive.pitch, v); }
          const over = opts.untilPanel ? (arrivedAt !== null && t - arrivedAt >= (opts.hold ?? 3)) || t >= (opts.max ?? 30) : t >= keys[keys.length - 1].t;
          if (over && !done) { done = true; resolve(t); return; }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },
  };
  return true;
})()`);

const SHOTS = {
  // the descent: the aerial over the plaza settling at eye level on the exchange (the walker stands at the spawn)
  descent: { keys: [{ t: 0, dist: 30, pitch: 1.0 }, { t: 1.5, dist: 30, pitch: 1.0 }, { t: 10, dist: 8, pitch: 0.22 }, { t: 12, dist: 8, pitch: 0.22 }], opts: {} },
  // to the desk: a walk from the plaza to Mr Bands' desk, the camera settling close as the panel opens
  desk: { keys: [{ t: 0, dist: 9, pitch: 0.3 }, { t: 30, dist: 9, pitch: 0.3 }], opts: { untilPanel: true, hold: 3.5, max: 40, actions: [{ t: 0.5, run: (w) => w.goToSpot("desk") }] } },
  // walk and talk: the walker dressed as Mr Bands, the camera held in front of him (we see his face, the town behind),
  // out along the north street, then into the park; the narration is laid over this in the edit
  walktalk: { kit: { hat: "top", coat: "Ink", cane: true, glasses: true, cigar: true }, keys: [{ t: 0, dist: 6, pitch: 0.16 }, { t: 3, dist: 6, pitch: 0.16 }, { t: 12, dist: 7.5, pitch: 0.2 }, { t: 58, dist: 7.5, pitch: 0.2 }], opts: { face: "front", faceOffset: 0.35, actions: [{ t: 3, run: (w) => w.goToSpot("north-end") }, { t: 27, run: (w) => w.goToSpot("park") }] } },
  walkdiag: { kit: { hat: "top", coat: "Ink", cane: true, glasses: true, cigar: true }, keys: [{ t: 0, dist: 6, pitch: 0.16 }, { t: 12, dist: 6, pitch: 0.16 }], opts: { face: "front", faceOffset: 0.35, actions: [{ t: 2, run: (w) => w.goToSpot("north-end") }] } },
  // the town, one take: the descent, a breath, then the walk to Mr Bands' desk, the camera closing on him as the panel opens
  town: { keys: [{ t: 0, dist: 30, pitch: 1.0 }, { t: 1.5, dist: 30, pitch: 1.0 }, { t: 10, dist: 8, pitch: 0.22 }, { t: 40, dist: 8, pitch: 0.22 }], opts: { untilPanel: true, hold: 4, max: 45, actions: [{ t: 12, run: (w) => w.goToSpot("desk") }], arrive: { fromDist: 8, fromPitch: 0.22, dist: 5.5, pitch: 0.12 } } },
};
const shot = SHOTS[SHOT];
if (!shot) { console.error(`unknown shot ${SHOT}; one of ${Object.keys(SHOTS).join(", ")}`); await finish(1); }
// pre-position the camera at the first keyframe, then start recording
await ev(`(() => { const w = window.__world; w.dist = ${shot.keys[0].dist}; w.pitch = ${shot.keys[0].pitch}; ${shot.kit ? `w.setKit('me', ${JSON.stringify(shot.kit)});` : ""} ${shot.opts.face === "front" ? "w.lastDragAt = performance.now(); w.yaw = w.meRy + " + (shot.opts.faceOffset ?? 0) + ";" : ""} return true; })()`);
await sleep(1200);
await hideHud();
const mime = await ev("window.__rig.start()");
console.log("recording", SHOT, "as", mime);
const actions = (shot.opts.actions ?? []).map((a) => `{ t: ${a.t}, run: ${a.run.toString()} }`).join(",");
const secs = await ev(`window.__rig.program(${JSON.stringify(shot.keys)}, { untilPanel: ${!!shot.opts.untilPanel}, hold: ${shot.opts.hold ?? 3}, max: ${shot.opts.max ?? 30}, arrive: ${JSON.stringify(shot.opts.arrive ?? null)}, face: ${JSON.stringify(shot.opts.face ?? null)}, faceOffset: ${shot.opts.faceOffset ?? 0}, actions: [${actions}] })`);
// the close on the desk after the arrival: ease in over the hold
const rigLog = await ev("JSON.stringify(window.__rigLog.filter((_, i) => i % 8 === 0))");
console.log("[t, yaw err before my write, camera angle err vs facing (0 = in front, ±3.14 = behind), dist]:", rigLog.slice(0, 700));
const size = await ev("window.__rig.stop()");
console.log(`recorded ${secs.toFixed(1)} s, ${(size / 1e6).toFixed(1)} MB webm`);
// pull the base64 out in slices
const len = await ev("window.__rig.b64.length");
let b64 = "";
for (let i = 0; i < len; i += 4_000_000) b64 += await ev(`window.__rig.b64.slice(${i}, ${i + 4_000_000})`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const base = path.join(OUT, `${stamp}-render-${SHOT}`);
fs.writeFileSync(`${base}.webm`, Buffer.from(b64, "base64"));
console.log("saved", `${base}.webm`, "| errors:", errors.length ? errors.slice(0, 2) : "none");
try {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", `${base}.webm`, "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", `${base}.mp4`]);
  const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${base}.mp4`]).toString().trim();
  for (const f of [0, 0.25, 0.5, 0.75, 0.98]) execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Number(dur) * f), "-i", `${base}.mp4`, "-frames:v", "1", "-vf", "scale=960:-1", path.join(OUT, "review", `render-${SHOT}-${Math.round(f * 100)}.jpg`)]);
  console.log(`mp4 ${base}.mp4 (${dur} s), stills in ${path.join(OUT, "review")}`);
} catch (e) { console.log("ffmpeg step skipped:", String(e.message).slice(0, 120)); }
await finish(0);
