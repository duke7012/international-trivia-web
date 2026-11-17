// Shared data rules: question shape, validation, settings defaults.
// Imported by the server and by the host dashboard, so both agree on what "ready to publish" means.

export const TOTAL_STOPS = 30;
export const PRESENTATIONS = ["text", "image", "video", "audio"];
export const ANSWER_FORMATS = ["choice", "written"];
export const DIFFICULTIES = ["easy", "medium", "hard"];

export const PRESENTATION_LABEL = { text: "Text only", image: "Image + text", video: "Video + text", audio: "Audio + text" };
export const FORMAT_LABEL = { choice: "Multiple choice", written: "Written answer" };

const str = (v, max = 2000) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function emptyQuestion(id) {
  return {
    id, status: "empty",
    country: "", topic: "", difficulty: "easy",
    text: "", presentation: "text", answerFormat: "choice",
    choices: ["", "", "", ""], correctChoice: null,
    correctAnswer: "", variants: [], explanation: "",
    media: null, hostNotes: "", countdown: null, updatedAt: 0,
  };
}

export function youtubeId(url) {
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(url || "");
  return m ? m[1] : null;
}

export function normalizeMedia(m) {
  if (!m || typeof m !== "object" || !str(m.src).trim()) return null;
  const src = str(m.src, 1000).trim();
  const local = src.startsWith("/media/");
  if (!local && !/^https?:\/\//i.test(src)) return null;
  const clipStart = num(m.clipStart, 0, 86400, 0);
  let clipEnd = m.clipEnd === null || m.clipEnd === "" || m.clipEnd === undefined ? null : num(m.clipEnd, 0, 86400, null);
  if (clipEnd !== null && clipEnd <= clipStart) clipEnd = null;
  return {
    src, source: local ? "upload" : "url",
    name: str(m.name, 200), mime: str(m.mime, 100), size: num(m.size, 0, 1e13, 0),
    fit: m.fit === "cover" ? "cover" : "contain",
    zoom: num(m.zoom, 0.5, 3, 1), focusX: num(m.focusX, 0, 100, 50), focusY: num(m.focusY, 0, 100, 50),
    clipStart, clipEnd,
  };
}

// Clean whatever the editor sent into a well-formed question. Status is decided by the caller.
export function normalizeQuestion(input, id) {
  const q = emptyQuestion(id);
  q.country = str(input.country, 80).trim();
  q.topic = str(input.topic, 60).trim();
  q.difficulty = DIFFICULTIES.includes(input.difficulty) ? input.difficulty : "easy";
  q.text = str(input.text, 600).trim();
  q.presentation = PRESENTATIONS.includes(input.presentation) ? input.presentation : "text";
  q.answerFormat = ANSWER_FORMATS.includes(input.answerFormat) ? input.answerFormat : "choice";
  const ch = Array.isArray(input.choices) ? input.choices : [];
  q.choices = [0, 1, 2, 3].map((i) => str(ch[i], 160).trim());
  q.correctChoice = [0, 1, 2, 3].includes(input.correctChoice) ? input.correctChoice : null;
  q.correctAnswer = str(input.correctAnswer, 200).trim();
  const vs = Array.isArray(input.variants) ? input.variants : str(input.variants).split(/[\n;]/);
  q.variants = vs.map((v) => str(v, 200).trim()).filter(Boolean).slice(0, 20);
  q.explanation = str(input.explanation, 800).trim();
  q.media = q.presentation === "text" ? null : normalizeMedia(input.media);
  q.hostNotes = str(input.hostNotes, 1000).trim();
  q.countdown = input.countdown === null || input.countdown === "" || input.countdown === undefined ? null : Math.round(num(input.countdown, 3, 300, 10));
  return q;
}

export const isBlank = (q) =>
  !q.text && !q.country && !q.topic && !q.media && !q.correctAnswer && !q.explanation && !q.hostNotes && q.choices.every((c) => !c);

export const countryKey = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

export function mediaKind(media) {
  if (!media) return null;
  if (youtubeId(media.src)) return "video";
  const s = (media.mime || "") + " " + media.src.split("?")[0].toLowerCase();
  if (/image\/|\.(png|jpe?g|gif|webp|svg|avif)$/.test(s)) return "image";
  if (/video\/|\.(mp4|webm|mov|m4v|ogv)$/.test(s)) return "video";
  if (/audio\/|\.(mp3|wav|ogg|oga|m4a|aac|flac)$/.test(s)) return "audio";
  return null;
}

// Problems that stop a question going live. `others` = the rest of the bank (for the one-country-per-question rule).
export function publishErrors(q, others = []) {
  const e = [];
  if (!q.text) e.push("Add the question text.");
  if (q.presentation !== "text") {
    if (!q.media) e.push(`Add the ${q.presentation} file or link.`);
    else {
      const k = mediaKind(q.media);
      if (k && k !== q.presentation) e.push(`The attached media is ${k}, but the presentation type is ${q.presentation}.`);
    }
  }
  if (q.answerFormat === "choice") {
    if (q.choices.some((c) => !c)) e.push("Fill in all four answer choices.");
    else if (new Set(q.choices.map((c) => c.toLowerCase())).size < 4) e.push("Two answer choices are the same.");
    if (q.correctChoice === null) e.push("Mark which choice is correct.");
  } else if (!q.correctAnswer) e.push("Add the correct answer.");
  const clash = countryClash(q, others, true);
  if (clash) e.push(`${q.country} is already the country for question ${clash.number}. Each main question needs a different country.`);
  return e;
}

// Softer notes shown while drafting.
export function draftWarnings(q, others = []) {
  const w = [];
  const clash = countryClash(q, others, false);
  if (clash) w.push(`Question ${clash.number} also uses ${q.country}.`);
  if (!q.topic) w.push("No topic set, so this question cannot be picked in a topic choice.");
  if (!q.country) w.push("No country set.");
  return w;
}

function countryClash(q, others, publishedOnly) {
  const k = countryKey(q.country);
  if (!k) return null;
  for (let i = 0; i < others.length; i++) {
    const o = others[i];
    if (o.id === q.id || o.status === "empty") continue;
    if (publishedOnly && o.status !== "published") continue;
    if (countryKey(o.country) === k) return { number: i + 1 };
  }
  return null;
}

export const answerText = (q) => (q.answerFormat === "choice" ? (q.correctChoice === null ? "" : q.choices[q.correctChoice]) : q.correctAnswer);

export function defaultSettings() {
  return {
    showTitle: "Golden Bell: Around the World",
    defaultCountdown: 10,
    flightSeconds: 8,
    timerSound: "ticks", // ticks | pulse | off
    volume: 0.8,
    showNames: true,
    matchDifficulty: true,
    easyUntil: 10, // stops 1..easyUntil are easy
    mediumUntil: 20, // then medium up to here, hard after
  };
}

export function normalizeSettings(s = {}) {
  const d = defaultSettings();
  const easyUntil = Math.round(num(s.easyUntil, 0, TOTAL_STOPS, d.easyUntil));
  return {
    showTitle: str(s.showTitle ?? d.showTitle, 80).trim() || d.showTitle,
    defaultCountdown: Math.round(num(s.defaultCountdown, 3, 300, d.defaultCountdown)),
    flightSeconds: num(s.flightSeconds, 2, 30, d.flightSeconds),
    timerSound: ["ticks", "pulse", "off"].includes(s.timerSound) ? s.timerSound : d.timerSound,
    volume: num(s.volume, 0, 1, d.volume),
    showNames: s.showNames !== false,
    matchDifficulty: s.matchDifficulty !== false,
    easyUntil,
    mediumUntil: Math.round(num(s.mediumUntil, easyUntil, TOTAL_STOPS, Math.max(easyUntil, d.mediumUntil))),
  };
}

export function difficultyForStop(stop, settings) {
  if (stop <= settings.easyUntil) return "easy";
  if (stop <= settings.mediumUntil) return "medium";
  return "hard";
}

// ---- Rescue content (kept apart from the main question bank) ----

export const RESCUE_RULE_TYPES = ["all", "half", "upTo", "none"];
export const EMERGENCY_RULES = {
  returnLastOut: "Everyone knocked out on the last question returns",
  returnAll: "Every eliminated contestant returns",
  hostPick: "Host picks who returns",
  endShow: "The show ends here",
};

export function defaultRescue() {
  return {
    clues: [],
    timerSec: 90,
    rules: { 3: { type: "all" }, 2: { type: "half" }, 1: { type: "upTo", n: 3 }, 0: { type: "none" } },
    emergencyRule: "returnLastOut",
  };
}

export function normalizeClue(c, id) {
  const img = c.image && str(c.image.src).trim() ? normalizeMedia(c.image) : null;
  return {
    id,
    prompt: str(c.prompt, 300).trim(),
    image: img && mediaKind(img) !== "video" && mediaKind(img) !== "audio" ? img : null,
    answer: str(c.answer, 120).trim(),
    variants: (Array.isArray(c.variants) ? c.variants : str(c.variants).split(/[\n;]/)).map((v) => str(v, 120).trim()).filter(Boolean).slice(0, 12),
    hostNotes: str(c.hostNotes, 400).trim(),
  };
}

export const clueReady = (c) => !!c.answer && (!!c.prompt || !!c.image);

export function normalizeRescue(r = {}, makeId) {
  const d = defaultRescue();
  const rules = {};
  for (const k of [3, 2, 1, 0]) {
    const x = (r.rules && r.rules[k]) || d.rules[k];
    const type = RESCUE_RULE_TYPES.includes(x.type) ? x.type : d.rules[k].type;
    rules[k] = type === "upTo" ? { type, n: Math.round(num(x.n, 1, 999, 3)) } : { type };
  }
  return {
    clues: (Array.isArray(r.clues) ? r.clues : []).slice(0, 60).map((c) => normalizeClue(c, c.id || makeId())),
    timerSec: Math.round(num(r.timerSec, 15, 900, d.timerSec)),
    rules,
    emergencyRule: EMERGENCY_RULES[r.emergencyRule] ? r.emergencyRule : d.emergencyRule,
  };
}

// How many eliminated contestants a rule lets back in.
export function rescueReturnCount(rule, eliminated) {
  if (!rule || eliminated <= 0) return 0;
  if (rule.type === "all") return eliminated;
  if (rule.type === "half") return Math.ceil(eliminated / 2);
  if (rule.type === "upTo") return Math.min(rule.n || 0, eliminated);
  return 0;
}

export function describeRule(rule) {
  if (rule.type === "all") return "Everyone returns";
  if (rule.type === "half") return "Half return, rounded up";
  if (rule.type === "upTo") return `Up to ${rule.n} return`;
  return "Nobody returns: host uses the emergency rule";
}
