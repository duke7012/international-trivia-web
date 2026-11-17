// Everything that lives on disk (Node server): two fully separate workspaces ("live" and
// "demo"), each with its own question bank, rescue clues, settings, session and media folder.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newSession } from "../shared/engine.mjs";
import { WORKSPACES, PARTS, hydrate, demoContent, mediaRefs } from "./bank.mjs";

export { WORKSPACES, newId } from "./bank.mjs";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const SEED = path.join(ROOT, "demo", "seed");

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
// Write to a temp file and rename, so a crash mid-write never leaves a half-written file.
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
};

const dir = (ws) => path.join(DATA, ws);
export const mediaDir = (ws) => path.join(dir(ws), "media");

// The demo set ships with the app and is copied into its own workspace. It never touches "live".
function seedDemo() {
  fs.rmSync(dir("demo"), { recursive: true, force: true });
  fs.mkdirSync(mediaDir("demo"), { recursive: true });
  const seedMedia = path.join(SEED, "media");
  if (fs.existsSync(seedMedia)) for (const f of fs.readdirSync(seedMedia)) fs.copyFileSync(path.join(seedMedia, f), path.join(mediaDir("demo"), f));
  const demo = demoContent(readJson(path.join(SEED, "questions.json"), []), readJson(path.join(SEED, "rescue.json"), undefined), Date.now());
  writeJson(path.join(dir("demo"), "questions.json"), demo.questions);
  writeJson(path.join(dir("demo"), "rescue.json"), demo.rescue);
}

function load(ws) {
  if (ws === "demo" && !fs.existsSync(path.join(dir("demo"), "questions.json"))) seedDemo();
  fs.mkdirSync(mediaDir(ws), { recursive: true });
  return hydrate(ws, Object.fromEntries(PARTS.map((part) => [part, readJson(path.join(dir(ws), `${part}.json`), undefined)])));
}

export function openStore() {
  fs.mkdirSync(DATA, { recursive: true });
  const app = { workspace: "live", ...readJson(path.join(DATA, "app.json"), {}) };
  if (!WORKSPACES.includes(app.workspace)) app.workspace = "live";
  const spaces = { live: load("live"), demo: load("demo") };
  return {
    app, spaces,
    get current() { return spaces[app.workspace]; },
    saveApp() { writeJson(path.join(DATA, "app.json"), app); },
    save(ws, part) { writeJson(path.join(dir(ws.name), `${part}.json`), ws[part]); },
    resetDemo() { seedDemo(); spaces.demo = load("demo"); spaces.demo.session = newSession(); this.save(spaces.demo, "session"); },
    sweepMedia,
  };
}

// Delete uploaded files nothing refers to any more. Recent files are kept: an upload sitting in an
// unsaved editor form is not referenced anywhere yet.
export function sweepMedia(ws, extraRefs = [], maxAgeMs = 24 * 3600 * 1000) {
  const refs = mediaRefs(ws, extraRefs);
  const now = Date.now();
  let removed = 0;
  for (const f of fs.readdirSync(mediaDir(ws.name))) {
    if (refs.has(f)) continue;
    const full = path.join(mediaDir(ws.name), f);
    try { if (now - fs.statSync(full).mtimeMs > maxAgeMs) { fs.unlinkSync(full); removed++; } } catch { /* already gone */ }
  }
  return removed;
}
