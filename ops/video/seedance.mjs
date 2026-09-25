#!/usr/bin/env node
// Seedance through fal.ai's queue, for the house videos (Zach, 25 Sep: "high quality seedance videos", first the town).
//
//   node ops/video/seedance.mjs --image frames/town.png --prompt "..." [--end frames/desk.png] [--duration 10]
//        [--ratio 16:9] [--res 1080p] [--audio] [--seed 7] [--model fal-ai/bytedance/seedance/v1.5/pro/image-to-video]
//        [--out data-video] [--dry]
//
// The key is FAL_KEY in ~/.mrbands/video.env (mode 600), never in the repo's .env and never printed. Images are sent
// as data URIs (a 1080p JPEG is a few hundred KB; PNGs are re-sent as they are). Every run writes the mp4 and a
// sidecar JSON (the request without the images, the response, the cost line fal reports) next to it. --dry prints
// the payload and stops before anything is charged. Each job costs money: nothing here retries on its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => { if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]); return acc; }, []));
const die = (m) => { console.error(`seedance: ${m}`); process.exit(1); };
if (!args.prompt) die("--prompt is required");
const model = args.model ?? "fal-ai/bytedance/seedance/v1.5/pro/image-to-video";
const isI2V = /image-to-video/.test(model);
if (isI2V && !args.image) die("--image is required for an image-to-video model");

const keyFile = path.join(os.homedir(), ".mrbands", "video.env");
function readKey() {
  if (!fs.existsSync(keyFile)) die(`${keyFile} does not exist: put FAL_KEY=... in it (chmod 600)`);
  const line = fs.readFileSync(keyFile, "utf8").split("\n").find((l) => l.startsWith("FAL_KEY="));
  const key = line ? line.slice("FAL_KEY=".length).trim().replace(/^"(.*)"$/, "$1") : "";
  if (!key) die(`FAL_KEY is not set in ${keyFile}`);
  return key;
}

function imageUrl(p) {
  if (/^https?:\/\//.test(p)) return p;
  if (!fs.existsSync(p)) die(`image not found: ${p}`);
  const ext = path.extname(p).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const bytes = fs.readFileSync(p);
  if (bytes.length > 8 * 1024 * 1024) die(`${p} is ${(bytes.length / 1e6).toFixed(1)} MB: send a JPEG under 8 MB`);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

const body = {
  prompt: args.prompt,
  duration: String(args.duration ?? "10"),
  resolution: args.res ?? "1080p",
  aspect_ratio: args.ratio ?? "16:9",
  camera_fixed: args.fixed === "true",
  ...(args.seed ? { seed: Number(args.seed) } : {}),
  ...(isI2V ? { image_url: imageUrl(args.image) } : {}),
  ...(args.end ? { end_image_url: imageUrl(args.end) } : {}),
  ...(/v1\.5/.test(model) ? { generate_audio: args.audio === "true" } : {}),
};
const shown = { ...body, image_url: body.image_url ? `<${args.image}>` : undefined, end_image_url: body.end_image_url ? `<${args.end}>` : undefined };
console.log(`model ${model}\n${JSON.stringify(shown, null, 2)}`);
if (args.dry === "true") { console.log("dry run: nothing submitted"); process.exit(0); }

const key = readKey();
const H = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
const outDir = args.out ?? "data-video";
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const base = path.join(outDir, `${stamp}-${(args.name ?? "seedance").replace(/[^a-z0-9-]/gi, "-")}`);

const sub = await fetch(`https://queue.fal.run/${model}`, { method: "POST", headers: H, body: JSON.stringify(body) });
if (!sub.ok) die(`submit failed ${sub.status}: ${(await sub.text()).slice(0, 400)}`);
const { request_id: rid, status_url: statusUrl, response_url: responseUrl } = await sub.json();
console.log(`queued ${rid}`);
let last = "";
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await fetch(`${statusUrl}?logs=1`, { headers: H });
  if (!st.ok) die(`status failed ${st.status}: ${(await st.text()).slice(0, 300)}`);
  const s = await st.json();
  const line = `${s.status}${s.queue_position !== undefined ? ` (queue ${s.queue_position})` : ""}`;
  if (line !== last) { console.log(line); last = line; }
  if (s.status === "COMPLETED") break;
  if (s.status === "FAILED") die(`failed: ${JSON.stringify(s).slice(0, 400)}`);
}
const res = await fetch(responseUrl, { headers: H });
if (!res.ok) die(`result failed ${res.status}: ${(await res.text()).slice(0, 400)}`);
const out = await res.json();
const url = out.video?.url;
if (!url) die(`no video url in the result: ${JSON.stringify(out).slice(0, 400)}`);
const mp4 = await fetch(url);
fs.writeFileSync(`${base}.mp4`, Buffer.from(await mp4.arrayBuffer()));
fs.writeFileSync(`${base}.json`, JSON.stringify({ model, request: shown, requestId: rid, result: out, at: new Date().toISOString() }, null, 2));
console.log(`saved ${base}.mp4 (${(fs.statSync(`${base}.mp4`).size / 1e6).toFixed(1)} MB), seed ${out.seed ?? "n/a"}`);
