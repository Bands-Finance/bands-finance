/**
 * Video for his posts: the chunked media upload (INIT, APPEND, FINALIZE, then STATUS until X has processed it),
 * signed with the same OAuth 1.0a keys as src/talk/x.ts. v1.1 (upload.twitter.com) first, the v2 route
 * (api.x.com/2/media/upload) when v1.1 refuses; both take the same commands. The caller (src/scripts/talk.ts
 * post-video) checks the live gate and lints the text BEFORE anything is uploaded, and passes the media id to
 * postTweet. Nothing here prints a key; failures report the status and X's error text only. 512 MB and 140 s are
 * X's limits for a tweet video; the file is checked for size here and for length by X.
 */
import fs from "node:fs";
import path from "node:path";
import { oauthHeader, type OAuthCredentials } from "./x";

export const V11_UPLOAD = "https://upload.twitter.com/1.1/media/upload.json";
export const V2_UPLOAD = "https://api.x.com/2/media/upload";
const CHUNK = 4 * 1024 * 1024;
const MAX_BYTES = 512 * 1024 * 1024;

export interface MediaDeps {
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  /** how long to wait for X's processing, ms (default 3 minutes) */
  processingMs?: number;
  log?: (line: string) => void;
}

export type UploadResult = { ok: true; mediaId: string; endpoint: "v1.1" | "v2" } | { ok: false; reason: string };

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

/** One upload against one endpoint. Returns the media id, or the reason it failed. */
async function uploadTo(endpoint: string, file: string, creds: OAuthCredentials, deps: MediaDeps): Promise<UploadResult> {
  const f = deps.fetch ?? fetch;
  const now = () => (deps.now ?? Date.now)();
  const log = deps.log ?? (() => {});
  const bytes = fs.readFileSync(file);
  const mime = mimeOf(file);
  const category = mime.startsWith("video/") ? "tweet_video" : mime === "image/gif" ? "tweet_gif" : "tweet_image";
  const label = endpoint === V11_UPLOAD ? "v1.1" : "v2";
  const auth = (method: "GET" | "POST", url: string, bodyParams?: Record<string, string>) =>
    oauthHeader({ method, url, creds, bodyParams, nonce: deps.nonce?.(), timestamp: Math.floor(now() / 1000) });
  const xError = async (res: Response): Promise<string> => {
    let text = "";
    try {
      const j = (await res.json()) as { title?: string; detail?: string; errors?: { message?: string }[]; error?: string };
      text = j.detail ?? j.title ?? j.errors?.[0]?.message ?? j.error ?? "";
    } catch {
      /* not json */
    }
    return `${res.status}${text ? ` ${text.slice(0, 160)}` : ""}`;
  };

  // INIT (form-encoded, signed)
  const init: Record<string, string> = { command: "INIT", media_type: mime, total_bytes: String(bytes.length), media_category: category };
  let res: Response;
  try {
    res = await f(endpoint, { method: "POST", headers: { authorization: auth("POST", endpoint, init), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(init).toString() });
  } catch (err) {
    return { ok: false, reason: `${label} unreachable: ${(err as Error).name}` };
  }
  if (!res.ok) return { ok: false, reason: `${label} INIT refused: ${await xError(res)}` };
  const initJson = (await res.json()) as { media_id_string?: string; data?: { id?: string } };
  const mediaId = initJson.media_id_string ?? initJson.data?.id;
  if (!mediaId) return { ok: false, reason: `${label} INIT gave no media id` };
  log(`${label} INIT ok: ${bytes.length} bytes as ${category}`);

  // APPEND (multipart, the body unsigned)
  for (let i = 0, seg = 0; i < bytes.length; i += CHUNK, seg++) {
    const form = new FormData();
    form.set("command", "APPEND");
    form.set("media_id", mediaId);
    form.set("segment_index", String(seg));
    form.set("media", new Blob([bytes.subarray(i, i + CHUNK)]), "chunk");
    try {
      res = await f(endpoint, { method: "POST", headers: { authorization: auth("POST", endpoint) }, body: form });
    } catch (err) {
      return { ok: false, reason: `${label} APPEND ${seg} unreachable: ${(err as Error).name}` };
    }
    if (!res.ok && res.status !== 204) return { ok: false, reason: `${label} APPEND ${seg} refused: ${await xError(res)}` };
    log(`${label} APPEND ${seg} ok`);
  }

  // FINALIZE (form-encoded, signed), then STATUS until X is done
  const fin: Record<string, string> = { command: "FINALIZE", media_id: mediaId };
  try {
    res = await f(endpoint, { method: "POST", headers: { authorization: auth("POST", endpoint, fin), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fin).toString() });
  } catch (err) {
    return { ok: false, reason: `${label} FINALIZE unreachable: ${(err as Error).name}` };
  }
  if (!res.ok) return { ok: false, reason: `${label} FINALIZE refused: ${await xError(res)}` };
  type Info = { processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } } };
  let info = (await res.json()) as Info & { data?: Info };
  let proc = info.processing_info ?? info.data?.processing_info;
  const deadline = now() + (deps.processingMs ?? 180_000);
  while (proc && proc.state !== "succeeded") {
    if (proc.state === "failed") return { ok: false, reason: `${label} processing failed: ${proc.error?.message ?? "no reason given"}` };
    if (now() > deadline) return { ok: false, reason: `${label} processing did not finish in time` };
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(10, proc?.check_after_secs ?? 2)) * 1000));
    const url = `${endpoint}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`;
    try {
      res = await f(url, { method: "GET", headers: { authorization: auth("GET", url) } });
    } catch (err) {
      return { ok: false, reason: `${label} STATUS unreachable: ${(err as Error).name}` };
    }
    if (!res.ok) return { ok: false, reason: `${label} STATUS refused: ${await xError(res)}` };
    info = (await res.json()) as Info & { data?: Info };
    proc = info.processing_info ?? info.data?.processing_info;
    log(`${label} STATUS ${proc?.state ?? "done"}`);
  }
  return { ok: true, mediaId, endpoint: label as "v1.1" | "v2" };
}

/** Upload a video (or image) for a post. v1.1 first; the v2 route when v1.1 refuses with a client error. */
export async function uploadMedia(file: string, creds: OAuthCredentials, deps: MediaDeps = {}): Promise<UploadResult> {
  if (!fs.existsSync(file)) return { ok: false, reason: `no such file: ${file}` };
  const size = fs.statSync(file).size;
  if (size > MAX_BYTES) return { ok: false, reason: `${(size / 1e6).toFixed(0)} MB is over X's 512 MB limit` };
  const first = await uploadTo(V11_UPLOAD, file, creds, deps);
  if (first.ok || !/refused: 4\d\d/.test(first.reason)) return first;
  (deps.log ?? (() => {}))(`v1.1 refused (${first.reason}); trying the v2 route`);
  const second = await uploadTo(V2_UPLOAD, file, creds, deps);
  return second.ok ? second : { ok: false, reason: `${first.reason}; ${second.reason}` };
}
