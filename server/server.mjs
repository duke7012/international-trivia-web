// Golden Bell: Around the World. The show server.
// One process holds the single authoritative show state, saves every change to disk, and pushes
// it to the host dashboard and the projector. No dependencies: `node server/server.mjs` runs it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ROOT, DATA, WORKSPACES, openStore, mediaDir, newId, sweepMedia } from "./store.mjs";
import { projectorView, hostView } from "./views.mjs";
import { reduce, due, ShowError, ACTIONS, PREVIEW_SAFE_PHASES, idleMedia, mediaReduce } from "../shared/engine.mjs";
import { TOTAL_STOPS, emptyQuestion, normalizeQuestion, isBlank, publishErrors, normalizeSettings, normalizeRescue, mediaKind } from "../shared/schema.mjs";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(HOST);
// Off the laptop itself, the dashboard is protected by a PIN so the audience cannot open it.
const PIN = process.env.HOST_PIN || (LOOPBACK ? null : String(crypto.randomInt(100000, 999999)));
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;

const store = openStore();
let preview = null; // a rehearsal overlay on the projector; never part of the saved show
const clients = new Set(); // open live connections: { res, role, monitor, cid, sound }

// ---------- pushing state to screens ----------

function projectorStatus() {
  const real = [...clients].filter((c) => c.role === "projector" && !c.monitor);
  return { connected: real.length, soundOn: real.length > 0 && real.every((c) => c.sound) };
}
function viewFor(role) {
  const ws = store.current, now = Date.now();
  if (role === "projector") return projectorView(ws, preview, now);
  return hostView(ws, { projector: projectorStatus(), preview: preview && { kind: preview.kind, number: preview.number, media: preview.media, presentation: preview.question?.presentation }, pinRequired: !!PIN }, now);
}
function broadcast(only) {
  const cache = {};
  for (const c of clients) {
    if (only && c.role !== only) continue;
    cache[c.role] ??= `event: state\ndata: ${JSON.stringify(viewFor(c.role))}\n\n`;
    c.res.write(cache[c.role]);
  }
}

// ---------- changing state ----------

const ROSTER_ONLY = ["addContestants", "renameContestant", "removeContestant", "setContestantStatus"];
const ctxFor = (ws) => ({ now: Date.now(), questions: ws.questions, settings: ws.settings, rescue: ws.rescue, random: Math.random, id: newId });

function applyShowAction(type, payload) {
  const ws = store.current;
  const next = reduce(ws.session, { type, payload }, ctxFor(ws));
  if (next !== ws.session) { ws.session = next; store.save(ws, "session"); }
}

const onStage = (ws, id) => ws.session.currentQuestionId === id && !["LOBBY", "READY_TO_FLY", "ALL_ELIMINATED", "RESCUE", "FINISHED"].includes(ws.session.phase);
const fail = (msg) => { throw new ShowError(msg); };
const slotOf = (ws, id) => { const i = ws.questions.findIndex((q) => q.id === id); return i < 0 ? fail("That question slot no longer exists.") : i; };

const manage = {
  "bank.save"(ws, { id, question, status }) {
    const i = slotOf(ws, id);
    const q = normalizeQuestion(question || {}, id);
    if (status === "published") {
      const errors = publishErrors(q, ws.questions);
      if (errors.length) throw Object.assign(new ShowError(errors[0]), { errors });
      q.status = "published";
    } else q.status = isBlank(q) ? "empty" : "draft";
    if (q.status !== "published" && onStage(ws, id)) fail("This question is on stage right now, so it has to stay published. Publish your changes instead.");
    q.updatedAt = Date.now();
    ws.questions[i] = q;
    store.save(ws, "questions");
    return { question: q };
  },
  "bank.clear"(ws, { id }) {
    const i = slotOf(ws, id);
    if (onStage(ws, id)) fail("This question is on stage right now and cannot be deleted.");
    ws.questions[i] = emptyQuestion(newId());
    store.save(ws, "questions");
  },
  "bank.duplicate"(ws, { id }) {
    const src = ws.questions[slotOf(ws, id)];
    const to = ws.questions.findIndex((q) => q.status === "empty");
    if (to < 0) fail("All 30 slots are in use. Delete a question to make room for a copy.");
    ws.questions[to] = { ...structuredClone(src), id: newId(), status: "draft", updatedAt: Date.now() };
    store.save(ws, "questions");
    return { id: ws.questions[to].id, slot: to + 1 };
  },
  "bank.move"(ws, { id, to }) {
    const from = slotOf(ws, id);
    const dest = Math.max(0, Math.min(TOTAL_STOPS - 1, Number(to) | 0));
    const [q] = ws.questions.splice(from, 1);
    ws.questions.splice(dest, 0, q);
    store.save(ws, "questions");
  },
  "rescue.save"(ws, { rescue }) { ws.rescue = normalizeRescue(rescue, newId); store.save(ws, "rescue"); },
  "settings.save"(ws, { settings }) { ws.settings = normalizeSettings({ ...ws.settings, ...settings }); store.save(ws, "settings"); },
  "workspace.set"(_, { name }) {
    if (!WORKSPACES.includes(name)) fail("Unknown workspace.");
    store.app.workspace = name; store.saveApp(); preview = null;
  },
  "demo.reset"() {
    if (store.app.workspace !== "demo") fail("Switch to the demo set first.");
    preview = null; store.resetDemo();
  },
  // ----- previews: shown on the projector with a PREVIEW banner, never changing the show -----
  "preview.question"(ws, { id, question, showAnswer }) {
    needPreviewSafe(ws);
    const i = id ? ws.questions.findIndex((q) => q.id === id) : -1;
    const q = question ? normalizeQuestion(question, id || "preview") : ws.questions[i];
    if (!q || isBlank(q)) fail("There is nothing to preview in this slot yet.");
    preview = { kind: "question", number: i >= 0 ? i + 1 : null, question: q, showAnswer: !!showAnswer, media: idleMedia() };
  },
  "preview.flight"(ws, { tour }) {
    needPreviewSafe(ws);
    const from = tour ? 0 : Math.min(ws.session.stop, TOTAL_STOPS - 1);
    const to = tour ? TOTAL_STOPS : from + 1;
    preview = { kind: "flight", from, to, startedAt: Date.now(), durationMs: Math.round((tour ? 60 : ws.settings.flightSeconds) * 1000) };
  },
  "preview.media"(_, { op, value }) {
    if (preview?.kind !== "question") fail("No question preview is running.");
    preview = { ...preview, media: mediaReduce(preview.media, op, Date.now(), value) };
  },
  "preview.stop"() { preview = null; },
};
function needPreviewSafe(ws) {
  if (!PREVIEW_SAFE_PHASES.includes(ws.session.phase)) fail("The projector is showing the live show right now. Previews on the projector are available between questions; the preview inside the editor always works.");
}

function act(type, payload = {}) {
  let result;
  if (manage[type]) result = manage[type](store.current, payload) || {};
  else if (ACTIONS.includes(type)) {
    if (preview && !ROSTER_ONLY.includes(type)) fail("A preview is on the projector. End the preview first.");
    applyShowAction(type, payload);
    result = {};
  } else fail(`Unknown action "${type}".`);
  if (type.startsWith("bank.") || type === "rescue.save" || type === "demo.reset") sweepMedia(store.current, preview?.question?.media ? [path.basename(preview.question.media.src)] : []);
  broadcast();
  return result;
}

// The clock's only powers: land the plane, raise the boards, end the rescue clock.
setInterval(() => {
  const a = due(store.current.session, Date.now());
  if (a) { try { applyShowAction(a.type, {}); broadcast(); } catch (e) { console.error("clock:", e.message); } }
}, 50).unref();

// ---------- HTTP ----------

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".woff2": "font/woff2", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ico": "image/x-icon",
};
const UPLOAD_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".mp4", ".m4v", ".webm", ".mov", ".ogv", ".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac"];

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
  const ws = store.current;
  const original = path.basename(url.searchParams.get("name") || "file").slice(0, 200);
  const ext = path.extname(original).toLowerCase();
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

const pinOk = (req, url) => !PIN || req.headers["x-host-pin"] === PIN || url.searchParams.get("pin") === PIN;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);
  try {
    // Another website open in the host's browser must not be able to drive the show.
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: "Cross-site request refused." });

    if (p === "/api/events") {
      const role = url.searchParams.get("role") === "host" ? "host" : "projector";
      if (role === "host" && !pinOk(req, url)) return json(res, 401, { error: "PIN required" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      const client = { res, role, monitor: url.searchParams.has("monitor"), cid: url.searchParams.get("cid") || "", sound: false };
      clients.add(client);
      res.write(`retry: 800\nevent: state\ndata: ${JSON.stringify(viewFor(role))}\n\n`);
      const beat = setInterval(() => res.write(": beat\n\n"), 15000);
      req.on("close", () => { clearInterval(beat); clients.delete(client); if (role === "projector") broadcast("host"); });
      if (role === "projector") broadcast("host");
      return;
    }
    if (p === "/api/time") return json(res, 200, { now: Date.now() });

    if (p === "/api/projector/status" && req.method === "POST") {
      const body = await readBody(req, 2000);
      for (const c of clients) if (c.role === "projector" && c.cid && c.cid === body.cid) c.sound = !!body.sound;
      broadcast("host");
      return json(res, 200, { ok: true });
    }
    // The projector may report exactly one thing about the show: that a clip finished playing.
    if (p === "/api/projector/media-ended" && req.method === "POST") {
      const body = await readBody(req, 2000);
      try {
        if (preview?.kind === "question") { if (preview.media.n === body.n) { preview = { ...preview, media: mediaReduce(preview.media, "ended", Date.now()) }; broadcast(); } }
        else if (store.current.session.media.n === body.n) { applyShowAction("media", { op: "ended" }); broadcast(); }
      } catch { /* the show moved on; nothing to do */ }
      return json(res, 200, { ok: true });
    }

    if (p.startsWith("/api/host/")) {
      if (!pinOk(req, url)) return json(res, 401, { error: "PIN required" });
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
      if (!WORKSPACES.includes(ws) || !file) return json(res, 404, { error: "Not found" });
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
    console.log(`  On your network  ${ips.map((ip) => `http://${ip}:${PORT}`).join("  ") || "(no network address found)"}\n  Host PIN         ${PIN}\n`);
  }
  console.log(`  Show data is saved in ${DATA}. Press Ctrl+C to stop.\n`);
});
