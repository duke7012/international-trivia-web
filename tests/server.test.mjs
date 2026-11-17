// Server behaviour when the dashboard is password-protected (network or online hosting).
// Starts real servers on spare ports with throwaway data folders.  Run: npm test
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth, secretFromEnv } from "../server/auth.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const running = [];
after(() => running.forEach(({ child, dir }) => { child.kill(); rmSync(dir, { recursive: true, force: true }); }));

function start(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "golden-bell-srv-"));
  const port = 4800 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ["server/server.mjs"], { cwd: ROOT, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dir, HOST_PIN: "", HOST_PASSWORD: "", PUBLIC_HOSTING: "", ...env } });
  running.push({ child, dir });
  let out = "";
  return new Promise((resolve) => {
    const done = (code) => resolve({ base: `http://127.0.0.1:${port}`, code, out: () => out });
    child.stdout.on("data", (d) => { out += d; if (out.includes("is running")) done(null); });
    child.stderr.on("data", (d) => { out += d; });
    child.on("exit", done);
  });
}
const post = (base, url, body, headers = {}) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const addOne = { type: "addContestants", payload: { names: ["Ana"] } };

test("on the show laptop there is no sign-in", async () => {
  const { base } = await start({});
  assert.equal((await post(base, "/api/host/action", addOne)).status, 200);
});

test("with a password: the dashboard is closed until the host signs in, and the cookie then opens it", async () => {
  const { base } = await start({ HOST_PASSWORD: "seven golden bells" });
  assert.equal((await post(base, "/api/host/action", addOne)).status, 401);
  assert.equal((await fetch(base + "/api/events?role=host")).status, 401);

  const wrong = await post(base, "/api/host/login", { password: "nope" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);

  const ok = await post(base, "/api/host/login", { password: "seven golden bells" });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie");
  assert.match(cookie, /^gb_host=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  assert.ok(!cookie.includes("seven"), "the cookie must not contain the password");

  const session = cookie.split(";")[0];
  assert.equal((await post(base, "/api/host/action", addOne, { cookie: session })).status, 200);
  assert.equal((await post(base, "/api/host/action", addOne, { cookie: "gb_host=" + "0".repeat(64) })).status, 401);
  // the password in the web address is not accepted
  assert.equal((await fetch(base + "/api/events?role=host&pin=seven%20golden%20bells")).status, 401);
});

test("the question bank grows past 30 and shrinks back, never below the 30 journey slots", async () => {
  const { base } = await start({});
  const act = async (type, payload = {}) => { const r = await post(base, "/api/host/action", { type, payload }); return { status: r.status, body: await r.json() }; };
  const bankNow = async () => { const r = await fetch(base + "/api/events?role=host"); const reader = r.body.getReader(); let t = ""; while (!t.includes("\n\n")) t += new TextDecoder().decode((await reader.read()).value); reader.cancel(); return JSON.parse(t.split("data: ")[1].split("\n")[0]).questions; };
  assert.equal((await bankNow()).length, 30);
  const added = await act("bank.add");
  assert.equal(added.status, 200);
  assert.equal(added.body.slot, 31);
  assert.equal((await bankNow()).length, 31);
  // deleting an extra slot removes it; deleting a journey slot only empties it
  assert.equal((await act("bank.clear", { id: added.body.id })).status, 200);
  assert.equal((await bankNow()).length, 30);
  const first = (await bankNow())[0].id;
  await act("bank.clear", { id: first });
  assert.equal((await bankNow()).length, 30);
});

test("the projector needs no sign-in and is never sent host-only content", async () => {
  const { base } = await start({ HOST_PASSWORD: "seven golden bells" });
  const res = await fetch(base + "/api/events?role=projector");
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let buf = "";
  while (!buf.includes("\n\n")) buf += Buffer.from((await reader.read()).value).toString();
  reader.cancel();
  const view = JSON.parse(buf.slice(buf.indexOf("data: ") + 6, buf.indexOf("\n\n")));
  assert.equal(view.questions, undefined);
  assert.equal(view.session, undefined);
  assert.equal(view.question, null);
});

test("behind an https proxy the cookie is marked Secure", async () => {
  const { base } = await start({ HOST_PASSWORD: "seven golden bells" });
  const ok = await post(base, "/api/host/login", { password: "seven golden bells" }, { "x-forwarded-proto": "https" });
  assert.match(ok.headers.get("set-cookie"), /; Secure$/);
});

test("repeated wrong passwords lock sign-in, even for the right password, until the window passes", async () => {
  const { base } = await start({ HOST_PASSWORD: "seven golden bells" });
  for (let i = 0; i < 8; i++) assert.equal((await post(base, "/api/host/login", { password: `guess ${i}` })).status, 401);
  const locked = await post(base, "/api/host/login", { password: "seven golden bells" });
  assert.equal(locked.status, 429);
  assert.match((await locked.json()).error, /Too many wrong tries/);
});

test("lockout rules: per address, overall, and expiry", () => {
  let t = 0;
  const auth = createAuth("correct horse", () => t);
  const req = (ip) => ({ headers: { "x-forwarded-for": ip }, socket: {} });
  for (let i = 0; i < 8; i++) assert.deepEqual(auth.login(req("1.1.1.1"), "x"), { ok: false, locked: false });
  assert.equal(auth.login(req("1.1.1.1"), "correct horse").locked, true, "that address is locked");
  assert.equal(auth.login(req("2.2.2.2"), "correct horse").ok, true, "another address is not");
  t += 10 * 60 * 1000 + 1;
  assert.equal(auth.login(req("1.1.1.1"), "correct horse").ok, true, "the lock expires");
  // many addresses guessing together trip the overall limit
  for (let i = 0; i < 40; i++) auth.login(req(`9.9.${i}.1`), "x");
  assert.equal(auth.login(req("3.3.3.3"), "correct horse").locked, true);
});

test("online hosting refuses to start without a real password", async () => {
  const none = await start({ PUBLIC_HOSTING: "1" });
  assert.equal(none.code, 1);
  assert.match(none.out(), /needs a host password/);
  const short = await start({ PUBLIC_HOSTING: "1", HOST_PASSWORD: "12345" });
  assert.equal(short.code, 1);
  assert.match(short.out(), /too short/);
  assert.throws(() => secretFromEnv({ HOST_PASSWORD: "short" }, true), /too short/);
  assert.equal(secretFromEnv({}, true).secret, null);
  assert.match(secretFromEnv({}, false).secret, /^\d{6}$/);
});

test("health check answers without sign-in", async () => {
  const { base } = await start({ HOST_PASSWORD: "seven golden bells" });
  assert.equal((await fetch(base + "/healthz")).status, 200);
});
