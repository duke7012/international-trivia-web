// Everything that lives on disk: two fully separate workspaces ("live" and "demo"),
// each with its own question bank, rescue clues, settings, session and media folder.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { TOTAL_STOPS, emptyQuestion, normalizeQuestion, isBlank, normalizeSettings, normalizeRescue, defaultRescue } from "../shared/schema.mjs";
import { newSession } from "../shared/engine.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const SEED = path.join(ROOT, "demo", "seed");
export const WORKSPACES = ["live", "demo"];
export const newId = () => crypto.randomBytes(5).toString("hex");

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

function padBank(list) {
  const bank = (Array.isArray(list) ? list : []).slice(0, TOTAL_STOPS).map((q) => ({ ...emptyQuestion(q.id || newId()), ...q }));
  while (bank.length < TOTAL_STOPS) bank.push(emptyQuestion(newId()));
  return bank;
}

// The demo set ships with the app and is copied into its own workspace. It never touches "live".
function seedDemo() {
  fs.rmSync(dir("demo"), { recursive: true, force: true });
  fs.mkdirSync(mediaDir("demo"), { recursive: true });
  const seedMedia = path.join(SEED, "media");
  if (fs.existsSync(seedMedia)) for (const f of fs.readdirSync(seedMedia)) fs.copyFileSync(path.join(seedMedia, f), path.join(mediaDir("demo"), f));
  const now = Date.now();
  const questions = readJson(path.join(SEED, "questions.json"), []).map((raw) => {
    const q = normalizeQuestion(raw, newId());
    return { ...q, status: isBlank(q) ? "empty" : "published", updatedAt: now };
  });
  writeJson(path.join(dir("demo"), "questions.json"), padBank(questions));
  writeJson(path.join(dir("demo"), "rescue.json"), normalizeRescue(readJson(path.join(SEED, "rescue.json"), defaultRescue()), newId));
}

function load(ws) {
  if (ws === "demo" && !fs.existsSync(path.join(dir("demo"), "questions.json"))) seedDemo();
  fs.mkdirSync(mediaDir(ws), { recursive: true });
  return {
    name: ws,
    questions: padBank(readJson(path.join(dir(ws), "questions.json"), [])),
    rescue: normalizeRescue(readJson(path.join(dir(ws), "rescue.json"), defaultRescue()), newId),
    settings: normalizeSettings(readJson(path.join(dir(ws), "settings.json"), {})),
    session: { ...newSession(), ...readJson(path.join(dir(ws), "session.json"), {}) },
  };
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
  };
}

// Delete uploaded files nothing refers to any more. Recent files are kept: an upload sitting in an
// unsaved editor form is not referenced anywhere yet.
export function sweepMedia(ws, extraRefs = [], maxAgeMs = 24 * 3600 * 1000) {
  const refs = new Set(extraRefs);
  const add = (m) => m && m.src && refs.add(path.basename(m.src));
  ws.questions.forEach((q) => add(q.media));
  ws.rescue.clues.forEach((c) => add(c.image));
  add(ws.session.shown?.question?.media);
  ws.session.rescue?.clues.forEach((c) => add(c.image));
  const now = Date.now();
  let removed = 0;
  for (const f of fs.readdirSync(mediaDir(ws.name))) {
    if (refs.has(f)) continue;
    const full = path.join(mediaDir(ws.name), f);
    try { if (now - fs.statSync(full).mtimeMs > maxAgeMs) { fs.unlinkSync(full); removed++; } } catch { /* already gone */ }
  }
  return removed;
}
