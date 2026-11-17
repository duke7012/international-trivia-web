// Who may use the host dashboard.
// On the show laptop itself (the default) nobody else can reach the app, so there is no login.
// On a network or online, the host signs in once with a password; the browser then holds a
// cookie, so the password never travels in a web address. Wrong guesses are rate-limited.
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

const WINDOW_MS = 10 * 60 * 1000;
const PER_ADDRESS = 8; // wrong tries from one address inside the window
const OVERALL = 40; // wrong tries from everyone inside the window
const COOKIE = "gb_host";
const MIN_PASSWORD = 10;

// Decide the secret from the environment. Throws a plain-language error the server prints and exits on.
export function secretFromEnv(env, loopback) {
  const password = env.HOST_PASSWORD || "";
  if (password && password.length < MIN_PASSWORD) throw new Error(`HOST_PASSWORD is too short. Use at least ${MIN_PASSWORD} characters: a short phrase works well.`);
  if (env.PUBLIC_HOSTING && !password) throw new Error("This app is set up for online hosting (PUBLIC_HOSTING), which needs a host password. Set HOST_PASSWORD to a phrase of at least 10 characters.");
  if (password) return { secret: password, kind: "password", generated: false };
  if (env.HOST_PIN) return { secret: String(env.HOST_PIN), kind: "PIN", generated: false };
  // Shared on a local network without a password: make a PIN for this run and print it.
  if (!loopback) return { secret: String(crypto.randomInt(100000, 999999)), kind: "PIN", generated: true };
  return { secret: null, kind: null, generated: false };
}

// `memory` lets a host that can be unloaded at any moment (Cloudflare) keep the record of wrong
// tries somewhere durable: { state: { byAddress: {}, overall: [] }, save(state) }.
export function createAuth(secret, now = () => Date.now(), memory = null) {
  if (!secret) return { required: false, allowed: () => true, signedIn: () => true, login: () => ({ ok: true }), setCookie: () => null, clearCookie: () => null };

  const digest = (s) => crypto.createHmac("sha256", "golden-bell-compare").update(String(s)).digest();
  const want = digest(secret);
  const matches = (attempt) => crypto.timingSafeEqual(digest(attempt), want);
  // The cookie value is derived from the password, so a restart keeps the host signed in and a
  // changed password signs everyone out.
  const token = crypto.createHmac("sha256", String(secret)).update("golden-bell-host-session-v1").digest("hex");
  const tokenOk = (value) => typeof value === "string" && value.length === token.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));

  const state = memory?.state || { byAddress: {}, overall: [] }; // address -> times of wrong tries
  state.byAddress ||= {}; state.overall ||= [];
  const recent = (list) => list.filter((t) => now() - t < WINDOW_MS);
  const lockedFor = (address) => {
    state.overall = recent(state.overall);
    const mine = recent(state.byAddress[address] || []);
    if (mine.length) state.byAddress[address] = mine; else delete state.byAddress[address];
    const oldest = mine.length >= PER_ADDRESS ? mine[0] : state.overall.length >= OVERALL ? state.overall[0] : null;
    return oldest === null ? 0 : Math.max(1, Math.ceil((oldest + WINDOW_MS - now()) / 1000));
  };
  const attempt = (address, value) => {
    const wait = lockedFor(address);
    if (wait) return { ok: false, locked: true, retryAfter: wait };
    if (matches(value)) { delete state.byAddress[address]; memory?.save(state); return { ok: true }; }
    state.overall.push(now());
    state.byAddress[address] = [...(state.byAddress[address] || []), now()];
    if (Object.keys(state.byAddress).length > 5000) state.byAddress = {}; // never let the table grow without bound
    memory?.save(state);
    return { ok: false, locked: false };
  };

  const cookieOf = (req) => {
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  };
  const secure = (req) => (String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" || req.socket?.encrypted ? "; Secure" : "");

  return {
    required: true,
    address: (req) => req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown",
    // Signed in by cookie only. Never counts as a guess, so it is safe to call from anywhere.
    signedIn: (req) => tokenOk(cookieOf(req)),
    // Signed in by cookie, or (for scripts and tests) by sending the secret in a header.
    allowed(req) {
      if (tokenOk(cookieOf(req))) return true;
      const header = req.headers["x-host-pin"];
      return header ? attempt(this.address(req), header).ok : false;
    },
    login(req, value) { return attempt(this.address(req), String(value ?? "")); },
    setCookie: (req) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 3600}${secure(req)}`,
    clearCookie: (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(req)}`,
  };
}
