// Golden Bell: Around the World. The show server.
// One process holds the single authoritative show state, saves every change to disk, and pushes
// it to the host dashboard and the projector. No dependencies: `node server/server.mjs` runs it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT, DATA, WORKSPACES, openStore, mediaDir, newId, sweepMedia } from "./store.mjs";
import { createShow } from "./show.mjs";
import { secretFromEnv, createAuth } from "./auth.mjs";
import { ShowError } from "../shared/engine.mjs";
import { mediaKind } from "../shared/schema.mjs";
import { MIME, UPLOAD_EXT, SOUND_EXT, AREAS } from "./media-types.mjs";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(HOST);
// Off the laptop itself, the dashboard is protected by a password (or a PIN on a local network).
let access;
try { access = secretFromEnv(process.env, LOOPBACK); } catch (e) { console.error(`\n  Cannot start: ${e.message}\n`); process.exit(1); }
const auth = createAuth(access.secret);
const MAX_SCREENS = 300; // open live connections, so a flood of visitors cannot exhaust the server
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;

const store = openStore();
const clients = new Set(); // open live connections: { res, role, monitor, cid, sound }

function projectorStatus() {
  const real = [...clients].filter((c) => c.role === "projector" && !c.monitor);
  return { connected: real.length, soundOn: real.length > 0 && real.every((c) => c.sound) };
}
const show = createShow({ store, screens: projectorStatus, extras: { signInRequired: auth.required, upload: { chunkBytes: 0 } } });
const viewFor = (role) => show.viewFor(role);

function broadcast(only) {
  const cache = {};
  for (const c of clients) {
    if (only && c.role !== only) continue;
    cache[c.role] ??= `event: state\ndata: ${JSON.stringify(viewFor(c.role))}\n\n`;
    c.res.write(cache[c.role]);
  }
}
function act(type, payload) {
  const result = show.act(type, payload);
  broadcast();
  return result;
}

setInterval(() => {
  try { if (show.tick()) broadcast(); } catch (e) { console.error("clock:", e.message); }
}, 50).unref();

// ---------- HTTP ----------


const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = (req, limit = 2e6) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on("data", (c) => { size += c.length; if (size > limit) { reject(new ShowError("That request is too large.")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new ShowError("Malformed request.")); } });
  req.on("error", reject);
});

// Files, with byte-range support so videos can seek and large files stream instead of loading whole.
function sendFile(req, res, file, cache) {
  let stat;
  try { stat = fs.statSync(file); } catch { return json(res, 404, { error: "Not found" }); }
  if (!stat.isFile()) return json(res, 404, { error: "Not found" });
  const headers = { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": cache, "accept-ranges": "bytes", "x-content-type-options": "nosniff" };
  if (file.endsWith(".svg")) headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) { res.writeHead(416, { "content-range": `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": stat.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}
const inside = (base, rel) => { const full = path.resolve(base, "." + path.posix.normalize("/" + rel)); return full.startsWith(base + path.sep) || full === base ? full : null; };

// Uploads stream straight to the workspace's media folder on disk, so a large video never has to
// fit in memory or in the browser's storage.
function upload(req, res, url) {
  // Question media goes with the active workspace; show sounds have their own shared area.
  const sound = url.searchParams.get("area") === "sounds";
  const ws = { name: sound ? "sounds" : store.current.name };
  const original = path.basename(url.searchParams.get("name") || "file").slice(0, 200);
  const ext = path.extname(original).toLowerCase();
  if (sound && !SOUND_EXT.includes(ext)) return json(res, 415, { error: `"${ext || original}" is not a sound file. Use mp3, wav, m4a or ogg.` });
  if (!UPLOAD_EXT.includes(ext)) return json(res, 415, { error: `"${ext || original}" files are not supported. Use an image, a video (mp4, webm, mov) or audio (mp3, wav, m4a, ogg).` });
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_UPLOAD) return json(res, 413, { error: `That file is larger than the ${Math.round(MAX_UPLOAD / 1048576)} MB upload limit.` });
  try {
    const fsStat = fs.statfsSync(mediaDir(ws.name));
    if (declared && declared > fsStat.bavail * fsStat.bsize - 200 * 1048576) return json(res, 507, { error: "There is not enough free disk space on the show computer for that file." });
  } catch { /* statfs unavailable: the size limit still applies */ }
  const name = `${newId()}${newId()}${ext}`;
  const dest = path.join(mediaDir(ws.name), name), tmp = dest + ".part";
  const out = fs.createWriteStream(tmp);
  let size = 0, done = false;
  const abort = (code, error) => { if (done) return; done = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); if (!res.headersSent) { res.setHeader("connection", "close"); json(res, code, { error }); } req.resume(); };
  req.on("data", (c) => { size += c.length; if (size > MAX_UPLOAD) abort(413, `That file is larger than the ${Math.round(MAX_UPLOAD / 1048576)} MB upload limit.`); });
  req.on("aborted", () => abort(400, "The upload was interrupted."));
  out.on("error", (e) => abort(507, e.code === "ENOSPC" ? "The show computer ran out of disk space while saving that file." : "The file could not be saved."));
  req.pipe(out);
  out.on("finish", () => {
    if (done) return; done = true;
    if (!size) { fs.rm(tmp, { force: true }, () => {}); return json(res, 400, { error: "That file is empty." }); }
    fs.renameSync(tmp, dest);
    const media = { src: `/media/${ws.name}/${name}`, name: original, mime: MIME[ext] || "", size };
    json(res, 200, { ...media, kind: mediaKind(media) });
  });
}

const SIGN_IN = { error: "Sign in to use the host dashboard." };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "SAMEORIGIN"); // the dashboard embeds the projector; nobody else may
  res.setHeader("referrer-policy", "no-referrer");
  try {
    // Another website open in the host's browser must not be able to drive the show.
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: "Cross-site request refused." });

    if (p === "/api/events") {
      const role = url.searchParams.get("role") === "host" ? "host" : "projector";
      if (role === "host" && !auth.allowed(req)) return json(res, 401, SIGN_IN);
      if (clients.size >= MAX_SCREENS) return json(res, 503, { error: "Too many screens are connected." });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      const client = { res, role, monitor: url.searchParams.has("monitor"), cid: url.searchParams.get("cid") || "", sound: false };
      clients.add(client);
      res.write(`retry: 800\nevent: state\ndata: ${JSON.stringify(viewFor(role))}\n\n`);
      const beat = setInterval(() => res.write(": beat\n\n"), 15000);
      req.on("close", () => { clearInterval(beat); clients.delete(client); if (role === "projector") broadcast("host"); });
      if (role === "projector") broadcast("host");
      return;
    }
    if (p === "/api/time" || p === "/healthz") return json(res, 200, { now: Date.now() });

    if (p === "/api/host/login" && req.method === "POST") {
      const { password } = await readBody(req, 2000);
      const r = auth.login(req, password);
      if (r.ok) { const c = auth.setCookie(req); if (c) res.setHeader("set-cookie", c); return json(res, 200, { ok: true }); }
      if (r.locked) return json(res, 429, { error: `Too many wrong tries. Try again in ${Math.ceil(r.retryAfter / 60)} minute${r.retryAfter > 60 ? "s" : ""}.` });
      return json(res, 401, { error: `That ${access.kind || "password"} is not right.` });
    }
    if (p === "/api/host/logout" && req.method === "POST") { const c = auth.clearCookie(req); if (c) res.setHeader("set-cookie", c); return json(res, 200, { ok: true }); }

    if (p === "/api/projector/status" && req.method === "POST") {
      const body = await readBody(req, 2000);
      for (const c of clients) if (c.role === "projector" && c.cid && c.cid === body.cid) c.sound = !!body.sound;
      broadcast("host");
      return json(res, 200, { ok: true });
    }
    // The projector may report exactly one thing about the show: that a clip finished playing.
    if (p === "/api/projector/media-ended" && req.method === "POST") {
      const body = await readBody(req, 2000);
      if (show.mediaEnded(body.n)) broadcast();
      return json(res, 200, { ok: true });
    }

    if (p.startsWith("/api/host/")) {
      if (!auth.allowed(req)) return json(res, 401, { ...SIGN_IN, kind: access.kind });
      if (p === "/api/host/action" && req.method === "POST") {
        const { type, payload } = await readBody(req);
        return json(res, 200, { ok: true, ...act(String(type), payload) });
      }
      if (p === "/api/host/upload" && req.method === "PUT") return upload(req, res, url);
      if (p === "/api/host/check") return json(res, 200, { ok: true });
      return json(res, 404, { error: "Not found" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
    if (p.startsWith("/media/")) {
      const [, , ws, file] = p.split("/");
      if (!AREAS.includes(ws) || !file) return json(res, 404, { error: "Not found" });
      const full = inside(mediaDir(ws), file);
      return full ? sendFile(req, res, full, "private, max-age=86400, immutable") : json(res, 404, { error: "Not found" });
    }
    if (p.startsWith("/shared/")) {
      const full = inside(path.join(ROOT, "shared"), p.slice(8));
      return full ? sendFile(req, res, full, "no-cache") : json(res, 404, { error: "Not found" });
    }
    const page = { "/": "index.html", "/host": "host.html", "/projector": "projector.html" }[p];
    const full = inside(path.join(ROOT, "public"), page || p);
    if (!full) return json(res, 404, { error: "Not found" });
    return sendFile(req, res, full, p.startsWith("/vendor/") ? "public, max-age=86400" : "no-cache");
  } catch (e) {
    if (e instanceof ShowError) return json(res, 422, { error: e.message, errors: e.errors });
    console.error(e);
    return json(res, 500, { error: "Something went wrong on the show server. Check its console window." });
  }
});

server.listen(PORT, HOST, () => {
  for (const name of WORKSPACES) sweepMedia(store.spaces[name]);
  const base = `http://localhost:${PORT}`;
  console.log(`\n  Golden Bell: Around the World is running.\n\n  Host dashboard   ${base}/host\n  Projector        ${base}/projector\n`);
  if (!LOOPBACK) {
    const ips = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === "IPv4" && !n.internal).map((n) => n.address);
    console.log(`  On your network  ${ips.map((ip) => `http://${ip}:${PORT}`).join("  ") || "(no network address found)"}`);
    console.log(access.generated ? `  Host PIN         ${access.secret}   (for this run; set HOST_PASSWORD to choose your own)\n` : `  The host dashboard asks for your ${access.kind}.\n`);
  }
  console.log(`  Show data is saved in ${DATA}. Press Ctrl+C to stop.\n`);
});

// Hosting platforms stop the app with SIGTERM when they deploy or restart. Every change is
// already on disk, so there is nothing to flush.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
