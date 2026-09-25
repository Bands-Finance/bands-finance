#!/usr/bin/env node
// Any fal.ai queue model, from the command line, with local files sent as data URIs (the lip-sync model, the image
// models, anything seedance.mjs does not cover):
//   node ops/video/fal.mjs --model fal-ai/bytedance/omnihuman/v1.5 --file image_url=data-video/frames/portrait-cigar.png \
//        --file audio_url=data-video/talk/seg1.mp3 --input resolution=1080p --name talk-seg1 [--out data-video/talk] [--dry]
// --input k=v repeats (numbers and true/false are typed); --file k=path repeats. Key: FAL_KEY in ~/.mrbands/video.env.
// Saves every url in the result (video/audio/image) plus a sidecar JSON. Each job is charged; nothing retries on its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const argv = process.argv.slice(2);
const inputs = {}; const files = {}; const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--input") { const [k, ...v] = argv[++i].split("="); const raw = v.join("="); inputs[k] = raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw; }
  else if (a === "--file") { const [k, ...v] = argv[++i].split("="); files[k] = v.join("="); }
  else if (a === "--json") { Object.assign(inputs, JSON.parse(argv[++i])); }
  else if (a.startsWith("--")) { flags[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; }
}
// a key written `name[]` collects into an array (image_urls[]=a.png --upload image_urls[]=b.png)
const setInput = (k, v) => { if (k.endsWith("[]")) { const kk = k.slice(0, -2); (inputs[kk] ??= []).push(v); } else inputs[k] = v; };
const die = (m) => { console.error(`fal: ${m}`); process.exit(1); };
if (!flags.model) die("--model is required");
// --upload k=path: the file goes to fal's storage first (some models refuse data URIs; audio always does)
const uploads = {};
const uploadList = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--upload") { const [k, ...v] = argv[++i].split("="); uploadList.push([k, v.join("=")]); }
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".zip": "application/zip" };
for (const [k, p] of Object.entries(files)) {
  if (/^https?:\/\//.test(p)) { inputs[k] = p; continue; }
  if (!fs.existsSync(p)) die(`file not found: ${p}`);
  const bytes = fs.readFileSync(p); if (bytes.length > 12 * 1024 * 1024) die(`${p} is ${(bytes.length / 1e6).toFixed(1)} MB: too big for a data URI`);
  setInput(k, `data:${MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream"};base64,${bytes.toString("base64")}`);
}
let shown = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, typeof v === "string" && v.startsWith("data:") ? `<${files[k]}>` : Array.isArray(v) ? v.map((x) => (typeof x === "string" && x.startsWith("data:") ? "<data>" : x)) : v]));
console.log(`model ${flags.model}\n${JSON.stringify(shown, null, 2)}`);
if (flags.dry === "true") { console.log("dry run: nothing submitted"); process.exit(0); }
const keyFile = path.join(os.homedir(), ".mrbands", "video.env");
const line = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").split("\n").find((l) => l.startsWith("FAL_KEY=")) : null;
const key = line ? line.slice(8).trim().replace(/^"(.*)"$/, "$1") : ""; if (!key) die(`FAL_KEY is not set in ${keyFile}`);
const H = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
for (const [k, p] of uploadList) {
  if (!fs.existsSync(p)) die(`file not found: ${p}`);
  const type = MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
  const init = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", { method: "POST", headers: H, body: JSON.stringify({ content_type: type, file_name: path.basename(p) }) });
  if (!init.ok) die(`upload initiate failed ${init.status}: ${(await init.text()).slice(0, 300)}`);
  const { upload_url, file_url } = await init.json();
  const put = await fetch(upload_url, { method: "PUT", headers: { "Content-Type": type }, body: fs.readFileSync(p) });
  if (!put.ok) die(`upload failed ${put.status}: ${(await put.text()).slice(0, 300)}`);
  setInput(k, file_url); shown[k.replace(/\[\]$/, "")] = `<uploaded ${p}>`; console.log(`uploaded ${p} -> ${file_url.slice(0, 60)}…`);
}
const out = flags.out ?? "data-video/talk"; fs.mkdirSync(out, { recursive: true });
const name = flags.name ?? flags.model.replace(/[^a-z0-9]+/gi, "-");
const sub = await fetch(`https://queue.fal.run/${flags.model}`, { method: "POST", headers: H, body: JSON.stringify(inputs) });
if (!sub.ok) die(`submit failed ${sub.status}: ${(await sub.text()).slice(0, 400)}`);
const { request_id, status_url, response_url } = await sub.json();
console.log(`queued ${request_id}`);
let last = "";
for (let i = 0; i < 300; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const s = await (await fetch(status_url, { headers: H })).json();
  const l = `${s.status}${s.queue_position !== undefined ? ` (queue ${s.queue_position})` : ""}`; if (l !== last) { console.log(l); last = l; }
  if (s.status === "COMPLETED") break; if (s.status === "FAILED") die(JSON.stringify(s).slice(0, 400));
}
const res = await (await fetch(response_url, { headers: H })).json();
if (res && res.detail) die(`the model refused: ${JSON.stringify(res.detail).slice(0, 300)}`);
const saved = [];
const walk = async (o, label) => { if (o && typeof o === "object") { if (typeof o.url === "string" && /^https?:/.test(o.url)) { const ext = path.extname(new URL(o.url).pathname) || (o.content_type ? "." + o.content_type.split("/")[1].replace("jpeg", "jpg") : ".bin"); const f = path.join(out, `${name}${label ? "-" + label : ""}${ext}`); fs.writeFileSync(f, Buffer.from(await (await fetch(o.url)).arrayBuffer())); saved.push(f); return; } for (const [k, v] of Object.entries(o)) await walk(v, Array.isArray(o) ? `${label}${k}` : k); } };
await walk(res, "");
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ model: flags.model, request: shown, requestId: request_id, result: res, at: new Date().toISOString() }, null, 2));
console.log("saved", saved.join(", ") || "(no files in the result)");
