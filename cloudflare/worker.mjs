// Cloudflare entry point. Pages, scripts and fonts are served as static assets; this Worker
// handles everything else:
//   /api/*    -> the one Durable Object that holds the show (cloudflare/room.mjs)
//   /media/*  -> uploaded files in R2 storage, with byte ranges so video can seek
//   upload pieces -> straight into R2
import { createAuth } from "../server/auth.mjs";
import { mediaKind } from "../shared/schema.mjs";
import { MIME } from "../server/media-types.mjs";
import { ShowRoom, json, plain, passwordProblem, maxUpload } from "./room.mjs";

export { ShowRoom };

const KEY = /^(live|demo)\/[0-9a-f]{20}\.[a-z0-9]{2,5}$/;
const SECURITY = { "x-content-type-options": "nosniff", "x-frame-options": "SAMEORIGIN", "referrer-policy": "no-referrer" };
const secured = (res) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
  return out;
};

async function media(request, env, url) {
  if (!["GET", "HEAD"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
  const [, , ws, file] = decodeURIComponent(url.pathname).split("/");
  if (!["live", "demo"].includes(ws) || !file || file.includes("..")) return json({ error: "Not found" }, 404);
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const headers = new Headers({ "content-type": MIME[ext] || "application/octet-stream", "accept-ranges": "bytes", "cache-control": "private, max-age=86400, immutable" });
  if (ext === ".svg") headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");

  const object = await env.MEDIA.get(`${ws}/${file}`, { range: request.headers, onlyIf: request.headers });
  if (!object) {
    // The demo set's own media ships with the app rather than living in storage.
    if (ws !== "demo") return json({ error: "Not found" }, 404);
    const seed = await env.ASSETS.fetch(new URL(`/seed-media/${file}`, url));
    if (!seed.ok) return json({ error: "Not found" }, 404);
    // These files are tiny, so byte ranges (which let a video seek) are cut from memory.
    const bytes = await seed.arrayBuffer();
    headers.set("cache-control", "private, max-age=86400");
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, bytes.byteLength - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
      if (start >= bytes.byteLength || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.byteLength}` } });
      headers.set("content-range", `bytes ${start}-${end}/${bytes.byteLength}`);
      return new Response(request.method === "HEAD" ? null : bytes.slice(start, end + 1), { status: 206, headers });
    }
    return new Response(request.method === "HEAD" ? null : bytes, { headers });
  }
  headers.set("etag", object.httpEtag);
  if (!("body" in object)) return new Response(null, { status: 304, headers }); // the browser's copy is current
  let status = 200;
  if (object.range && request.headers.has("range")) {
    const offset = object.range.offset ?? object.size - object.range.suffix;
    const length = object.range.length ?? object.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    status = 206;
  } else headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}

// The pieces of an upload, and the call that joins them. The host must be signed in.
async function uploadStep(request, env, url) {
  const problem = passwordProblem(env);
  if (problem || !createAuth(env.HOST_PASSWORD).signedIn(plain(request))) return json({ error: problem || "Sign in to use the host dashboard." }, 401);
  try {
    if (url.pathname.endsWith("/part") && request.method === "PUT") {
      const key = url.searchParams.get("key"), n = Number(url.searchParams.get("n"));
      if (!KEY.test(key || "") || !(n >= 1 && n <= 10000)) return json({ error: "Malformed upload." }, 400);
      const part = await env.MEDIA.resumeMultipartUpload(key, url.searchParams.get("uploadId")).uploadPart(n, request.body);
      return json({ partNumber: part.partNumber, etag: part.etag });
    }
    if (url.pathname.endsWith("/finish") && request.method === "POST") {
      const { key, uploadId, parts, name } = await request.json();
      if (!KEY.test(key || "") || !Array.isArray(parts) || !parts.length) return json({ error: "Malformed upload." }, 400);
      const object = await env.MEDIA.resumeMultipartUpload(key, uploadId).complete(parts.map((x) => ({ partNumber: x.partNumber, etag: x.etag })));
      if (object.size > maxUpload(env)) { await env.MEDIA.delete(key); return json({ error: `That file is larger than the ${Math.round(maxUpload(env) / 1048576)} MB upload limit.` }, 413); }
      const ext = key.slice(key.lastIndexOf("."));
      const result = { src: `/media/${key}`, name: String(name || "").slice(0, 200), mime: MIME[ext] || "", size: object.size };
      return json({ ...result, kind: mediaKind(result) });
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "The file could not be saved. Try the upload again." }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname;
    // Another website open in the host's browser must not be able to drive the show.
    const origin = request.headers.get("origin");
    if (!["GET", "HEAD"].includes(request.method) && origin && new URL(origin).host !== url.host) return secured(json({ error: "Cross-site request refused." }, 403));

    if (p.startsWith("/media/")) return secured(await media(request, env, url));
    if (p === "/api/host/upload/part" || p === "/api/host/upload/finish") return secured(await uploadStep(request, env, url));
    if (p.startsWith("/api/") || p === "/healthz") return secured(await env.ROOM.get(env.ROOM.idFromName("show")).fetch(request));
    return env.ASSETS.fetch(request);
  },
};
