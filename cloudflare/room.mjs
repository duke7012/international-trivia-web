// The show on Cloudflare: one Durable Object holds the single authoritative show state.
// It is the Cloudflare twin of server/server.mjs and wraps the very same show logic
// (server/show.mjs), so the rules cannot differ between the laptop and the cloud.
//
// State is saved in the object's own storage on every change. Screens stay connected with
// server-sent events. Deadlines (landing, time up, rescue clock) use an alarm, so they fire
// even if no screen is connected.
import { DurableObject } from "cloudflare:workers";
import { createShow } from "../server/show.mjs";
import { createAuth } from "../server/auth.mjs";
import { WORKSPACES, PARTS, hydrate, demoContent, mediaRefs, newId } from "../server/bank.mjs";
import { MIME, UPLOAD_EXT } from "../server/media-types.mjs";
import { ShowError, newSession } from "../shared/engine.mjs";
import seedQuestions from "../demo/seed/questions.json";
import seedRescue from "../demo/seed/rescue.json";

export const CHUNK_BYTES = 16 * 1024 * 1024; // uploads travel in pieces; Cloudflare caps one request at 100 MB
export const MIN_PASSWORD = 10;
const MAX_SCREENS = 300;
const DAY = 24 * 3600 * 1000;

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
// The shape server/auth.mjs expects of a request.
export const plain = (request) => ({ headers: Object.fromEntries(request.headers), socket: { encrypted: new URL(request.url).protocol === "https:" } });
export const passwordProblem = (env) => (!env.HOST_PASSWORD ? "The host password is not set yet. In Cloudflare, open this Worker's Settings, then Variables and Secrets, and add a secret named HOST_PASSWORD (at least 10 characters)." : String(env.HOST_PASSWORD).length < MIN_PASSWORD ? "HOST_PASSWORD is too short. Use at least 10 characters." : null);
export const maxUpload = (env) => Number(env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;

export class ShowRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.clients = new Set(); // open live connections: { writer, role, monitor, cid, sound }
    this.encoder = new TextEncoder();
    this.timer = null;
    this.beat = null;
    ctx.blockConcurrencyWhile(() => this.load());
  }

  async load() {
    const st = this.ctx.storage;
    const saved = await st.get(["app", "auth", ...WORKSPACES.flatMap((w) => PARTS.map((part) => `${w}/${part}`))]);
    const raw = (w) => Object.fromEntries(PARTS.map((part) => [part, saved.get(`${w}/${part}`)]));
    const app = { workspace: "live", ...(saved.get("app") || {}) };
    if (!WORKSPACES.includes(app.workspace)) app.workspace = "live";
    const spaces = { live: hydrate("live", raw("live")), demo: null };
    const seedDemo = () => {
      const demo = hydrate("demo", demoContent(seedQuestions, seedRescue, Date.now()));
      for (const part of PARTS) st.put(`demo/${part}`, demo[part]);
      return demo;
    };
    spaces.demo = saved.get("demo/questions") ? hydrate("demo", raw("demo")) : seedDemo();

    this.store = {
      app, spaces,
      get current() { return spaces[app.workspace]; },
      saveApp: () => { st.put("app", app); },
      save: (ws, part) => { st.put(`${ws.name}/${part}`, ws[part]); },
      resetDemo: () => { spaces.demo = seedDemo(); spaces.demo.session = newSession(); },
      sweepMedia: (ws, extra) => this.ctx.waitUntil(this.sweep(ws, extra).catch(() => {})),
    };
    this.problem = passwordProblem(this.env);
    this.auth = createAuth(this.problem ? "unset" : this.env.HOST_PASSWORD, () => Date.now(), { state: saved.get("auth") || { byAddress: {}, overall: [] }, save: (s) => { st.put("auth", s); } });
    this.show = createShow({ store: this.store, screens: () => this.screens(), extras: { signInRequired: true, upload: { chunkBytes: CHUNK_BYTES } } });
  }

  screens() {
    const real = [...this.clients].filter((c) => c.role === "projector" && !c.monitor);
    return { connected: real.length, soundOn: real.length > 0 && real.every((c) => c.sound) };
  }

  // ---------- pushing state to screens ----------
  send(client, text) { client.writer.write(this.encoder.encode(text)).catch(() => this.drop(client)); }
  drop(client) {
    if (!this.clients.delete(client)) return;
    client.writer.close().catch(() => {});
    if (client.role === "projector") this.broadcast("host");
    if (!this.clients.size && this.beat) { clearInterval(this.beat); this.beat = null; }
  }
  broadcast(only) {
    const cache = {};
    for (const c of this.clients) {
      if (only && c.role !== only) continue;
      cache[c.role] ??= `event: state\ndata: ${JSON.stringify(this.show.viewFor(c.role))}\n\n`;
      this.send(c, cache[c.role]);
    }
  }

  // ---------- the clock ----------
  schedule() {
    const at = this.show.nextDeadline();
    clearTimeout(this.timer); this.timer = null;
    if (at === null) { this.ctx.storage.deleteAlarm(); return; }
    this.ctx.storage.setAlarm(at); // fires even if this object has been unloaded
    this.timer = setTimeout(() => this.onClock(), Math.max(0, at - Date.now()) + 2); // precise while loaded
  }
  onClock() {
    try { if (this.show.tick()) this.broadcast(); } catch (e) { console.error("clock:", e.message); }
    this.schedule();
  }
  async alarm() { this.onClock(); }

  // ---------- media housekeeping ----------
  async sweep(ws, extra) {
    const refs = mediaRefs(ws, extra);
    let cursor;
    do {
      const page = await this.env.MEDIA.list({ prefix: `${ws.name}/`, cursor });
      for (const o of page.objects) if (!refs.has(o.key.split("/").pop()) && Date.now() - o.uploaded.getTime() > DAY) await this.env.MEDIA.delete(o.key);
      cursor = page.truncated ? page.cursor : null;
    } while (cursor);
  }

  // ---------- HTTP ----------
  async fetch(request) {
    const url = new URL(request.url), p = url.pathname, method = request.method;
    const req = plain(request);
    try {
      if (p === "/api/time" || p === "/healthz") return json({ now: Date.now() });

      if (p === "/api/events") {
        const role = url.searchParams.get("role") === "host" ? "host" : "projector";
        if (role === "host" && (this.problem || !this.auth.allowed(req))) return json({ error: this.problem || "Sign in to use the host dashboard." }, 401);
        if (this.clients.size >= MAX_SCREENS) return json({ error: "Too many screens are connected." }, 503);
        const { readable, writable } = new TransformStream();
        const client = { writer: writable.getWriter(), role, monitor: url.searchParams.has("monitor"), cid: url.searchParams.get("cid") || "", sound: false };
        this.clients.add(client);
        client.writer.closed.catch(() => this.drop(client));
        this.send(client, `retry: 800\nevent: state\ndata: ${JSON.stringify(this.show.viewFor(role))}\n\n`);
        this.beat ??= setInterval(() => { for (const c of this.clients) this.send(c, ": beat\n\n"); }, 15000);
        if (role === "projector") this.broadcast("host");
        return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
      }

      if (p === "/api/host/login" && method === "POST") {
        if (this.problem) return json({ error: this.problem }, 503);
        const { password } = await request.json().catch(() => ({}));
        const r = this.auth.login(req, password);
        if (r.ok) return json({ ok: true }, 200, { "set-cookie": this.auth.setCookie(req) });
        if (r.locked) return json({ error: `Too many wrong tries. Try again in ${Math.ceil(r.retryAfter / 60)} minute${r.retryAfter > 60 ? "s" : ""}.` }, 429);
        return json({ error: "That password is not right." }, 401);
      }
      if (p === "/api/host/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": this.auth.clearCookie(req) });

      if (p === "/api/projector/status" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        for (const c of this.clients) if (c.role === "projector" && c.cid && c.cid === body.cid) c.sound = !!body.sound;
        this.broadcast("host");
        return json({ ok: true });
      }
      if (p === "/api/projector/media-ended" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (this.show.mediaEnded(body.n)) this.broadcast();
        return json({ ok: true });
      }

      if (p.startsWith("/api/host/")) {
        if (this.problem) return json({ error: this.problem }, 401);
        if (!this.auth.allowed(req)) return json({ error: "Sign in to use the host dashboard.", kind: "password" }, 401);
        if (p === "/api/host/check") return json({ ok: true });
        if (p === "/api/host/action" && method === "POST") {
          const { type, payload } = await request.json();
          const result = this.show.act(String(type), payload);
          this.broadcast();
          this.schedule();
          return json({ ok: true, ...result });
        }
        // An upload begins here (the room knows which workspace is active); the pieces then go
        // straight to storage through the Worker.
        if (p === "/api/host/upload/start" && method === "POST") {
          const original = (url.searchParams.get("name") || "file").split(/[\\/]/).pop().slice(0, 200);
          const dot = original.lastIndexOf("."), ext = dot < 0 ? "" : original.slice(dot).toLowerCase();
          if (!UPLOAD_EXT.includes(ext)) return json({ error: `"${ext || original}" files are not supported. Use an image, a video (mp4, webm, mov) or audio (mp3, wav, m4a, ogg).` }, 415);
          const size = Number(url.searchParams.get("size") || 0);
          if (!size) return json({ error: "That file is empty." }, 400);
          if (size > maxUpload(this.env)) return json({ error: `That file is larger than the ${Math.round(maxUpload(this.env) / 1048576)} MB upload limit.` }, 413);
          const key = `${this.store.current.name}/${newId()}${newId()}${ext}`;
          const upload = await this.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: MIME[ext] || "application/octet-stream" } });
          return json({ key, uploadId: upload.uploadId, chunkBytes: CHUNK_BYTES });
        }
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof ShowError) return json({ error: e.message, errors: e.errors }, 422);
      console.error(e);
      return json({ error: "Something went wrong on the show server." }, 500);
    }
  }
}
