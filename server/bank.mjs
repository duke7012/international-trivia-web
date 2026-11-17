// Shaping stored content, with no knowledge of where it is stored.
// Used by the file store (Node) and by the Cloudflare store.
import { TOTAL_STOPS, emptyQuestion, normalizeQuestion, isBlank, normalizeSettings, normalizeRescue, defaultRescue } from "../shared/schema.mjs";
import { newSession } from "../shared/engine.mjs";

export const WORKSPACES = ["live", "demo"];
export const PARTS = ["questions", "rescue", "settings", "session"];
export const newId = () => [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function padBank(list) {
  const bank = (Array.isArray(list) ? list : []).slice(0, TOTAL_STOPS).map((q) => ({ ...emptyQuestion(q.id || newId()), ...q }));
  while (bank.length < TOTAL_STOPS) bank.push(emptyQuestion(newId()));
  return bank;
}

// One workspace, made whole from whatever was saved (or nothing).
export function hydrate(name, raw = {}) {
  return {
    name,
    questions: padBank(raw.questions),
    rescue: normalizeRescue(raw.rescue || defaultRescue(), newId),
    settings: normalizeSettings(raw.settings || {}),
    session: { ...newSession(), ...(raw.session || {}) },
  };
}

// The demo set as it ships: every seeded question published.
export function demoContent(seedQuestions, seedRescue, now) {
  const questions = (seedQuestions || []).map((raw) => {
    const q = normalizeQuestion(raw, newId());
    return { ...q, status: isBlank(q) ? "empty" : "published", updatedAt: now };
  });
  return { questions: padBank(questions), rescue: normalizeRescue(seedRescue || defaultRescue(), newId) };
}

// File names of every media file something still points at.
export function mediaRefs(ws, extra = []) {
  const refs = new Set(extra);
  const add = (m) => m && m.src && refs.add(m.src.split("/").pop());
  ws.questions.forEach((q) => add(q.media));
  ws.rescue.clues.forEach((c) => add(c.image));
  add(ws.session.shown?.question?.media);
  ws.session.rescue?.clues.forEach((c) => add(c.image));
  return refs;
}
