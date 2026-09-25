// capture-town.mjs <outdir>: clean 1920x1080 frames of the live town (bands.finance/#/play) for video first frames.
// Same CDP harness as scratchpad/uxr/town-e2e.mjs; the HUD is hidden before each shot.
import { spawn } from "node:child_process";
import fs from "node:fs";
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9861;
const dir = fs.mkdtempSync(`${OUT}/prof-`);
const proc = spawn(CH, ["--headless=new", "--use-angle=metal", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--window-size=1920,1080", "about:blank"], { stdio: "ignore" });
let list;
for (let i = 0; i < 60; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails?.exception?.description?.slice(0, 160)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (n) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.result.data, "base64")); console.log("shot", n); };
const click = (label) => ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
const until = async (expr, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } return false; };
const hideHud = () => ev(`(() => { let n = 0; for (const el of document.querySelectorAll('[class*="play__"]')) { if (el.tagName !== 'CANVAS' && !el.querySelector('canvas')) { el.style.visibility = 'hidden'; n++; } } for (const h of document.querySelectorAll('header, nav')) { if (!h.querySelector('canvas')) { h.style.display = 'none'; n++; } } const c = document.querySelector('canvas'); if (c) { c.style.position = 'fixed'; c.style.inset = '0'; c.style.width = '100vw'; c.style.height = '100vh'; } window.dispatchEvent(new Event('resize')); return n; })()`);

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "https://bands.finance/#/play?debug" });
console.log("gate:", await until("!!document.querySelector('.play__gate button:not([disabled])')", 45000));
await click("Enter the Exchange");
console.log("online:", await until("(document.querySelector('.play__net')||{}).textContent?.startsWith('Online')", 30000));
await sleep(4000);
const api = await ev("(() => { const w = window.__world; if (!w) return 'no __world'; const own = Object.keys(w); const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(w)); return JSON.stringify({ own: own.slice(0, 60), proto: proto.slice(0, 80) }); })()");
console.log("world api:", api);
console.log("hud hidden:", await hideHud());
await shot("01-plaza-spawn");
const setCam = async (dist, pitch) => { await ev(`(() => { const w = window.__world; w.dist = ${dist}; w.pitch = ${pitch}; return true; })()`); await sleep(900); };
await hideHud(); await sleep(800);
await setCam(30, 1.0); await hideHud(); await shot("A-aerial");
await setCam(16, 0.55); await hideHud(); await shot("B-plaza-mid");
await setCam(8, 0.22); await hideHud(); await shot("C-plaza-ground");
// the desk: walk there at the default camera, then a close frame
await ev("window.__world.goToSpot('desk')");
for (let i = 0; i < 10; i++) { await sleep(3000); await hideHud(); if (await ev("!!document.querySelector('.play__panel')")) break; }
await hideHud(); await sleep(600); await shot("D-desk-arrive");
await setCam(5.5, 0.12); await hideHud(); await shot("E-desk-close");
await setCam(12, 0.8); await hideHud(); await shot("F-desk-high");
console.log("errors:", errors.length ? errors.slice(0, 3) : "none");
ws.close(); proc.kill(); await sleep(300); fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
