#!/usr/bin/env node
// Mr Bands' voice: ElevenLabs multilingual v2 through fal.ai, with word timestamps (they time the captions).
//   node ops/video/tts.mjs --text-file ops/video/talk/script.txt --voice George [--speed 0.95] [--stability 0.6] [--name walk-george] [--out data-video/talk]
// Key: FAL_KEY in ~/.mrbands/video.env. Writes <out>/<name>.mp3 and <name>.json (the response with timestamps).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => { if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]); return acc; }, []));
const die = (m) => { console.error(`tts: ${m}`); process.exit(1); };
const text = args["text-file"] ? fs.readFileSync(args["text-file"], "utf8").trim() : args.text;
if (!text) die("--text-file or --text is required");
const keyFile = path.join(os.homedir(), ".mrbands", "video.env");
const line = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").split("\n").find((l) => l.startsWith("FAL_KEY=")) : null;
const key = line ? line.slice(8).trim().replace(/^"(.*)"$/, "$1") : "";
if (!key) die(`FAL_KEY is not set in ${keyFile}`);
const model = args.model ?? "fal-ai/elevenlabs/tts/multilingual-v2";
const body = { text, voice: args.voice ?? "George", stability: Number(args.stability ?? 0.6), similarity_boost: Number(args.similarity ?? 0.8), style: Number(args.style ?? 0.1), speed: Number(args.speed ?? 0.95), timestamps: true };
const H = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
const out = args.out ?? "data-video/talk"; fs.mkdirSync(out, { recursive: true });
const name = args.name ?? `tts-${(args.voice ?? "George").toLowerCase()}`;
const sub = await fetch(`https://queue.fal.run/${model}`, { method: "POST", headers: H, body: JSON.stringify(body) });
if (!sub.ok) die(`submit failed ${sub.status}: ${(await sub.text()).slice(0, 300)}`);
const { status_url, response_url } = await sub.json();
for (let i = 0; i < 120; i++) { await new Promise((r) => setTimeout(r, 2000)); const s = await (await fetch(status_url, { headers: H })).json(); if (s.status === "COMPLETED") break; if (s.status === "FAILED") die(JSON.stringify(s).slice(0, 300)); }
const res = await (await fetch(response_url, { headers: H })).json();
const url = res.audio?.url; if (!url) die(`no audio in the result: ${JSON.stringify(res).slice(0, 300)}`);
fs.writeFileSync(path.join(out, `${name}.mp3`), Buffer.from(await (await fetch(url)).arrayBuffer()));
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ model, request: { ...body, text: text.slice(0, 80) + "…" }, result: res }, null, 2));
const ts = res.timestamps ?? res.alignment ?? null;
console.log(`saved ${path.join(out, name)}.mp3 | timestamps: ${ts ? "yes" : "no"} | words: ${Array.isArray(ts) ? ts.length : ts?.characters?.length ?? "?"}`);
