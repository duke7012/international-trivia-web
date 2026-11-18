// Shared data rules: question shape, validation, settings defaults.
// Imported by the server and by the host dashboard, so both agree on what "ready to publish" means.

export const TOTAL_STOPS = 30;
// The bank always has the 30 journey slots, and can grow past them: slots 31 and up are an extra
// pool that is only ever played when a contestant picks a topic ("Next in order" never gets that far).
export const MAX_QUESTIONS = 200;
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

// ---- Show sounds: the host's own audio files, one per moment of the show ----
// `match` recognises a file by its name, so a whole folder can be dropped in at once.
export const SOUND_CUES = [
  { id: "flight", label: "Plane in flight", when: "Plays while the plane flies to the next destination.", match: /fast_forward|flight|flying/i },
  { id: "questionLoop", label: "Question on screen", when: "Loops while you read the question, until you start the timer.", match: /question_show|question_loop/i },
  { id: "thinkStart", label: "Timer lead-in", when: "Plays when you press Start timer. The countdown begins when it ends.", match: /think_start/i },
  { id: "thinkClock", label: "Countdown, destinations 1 to 15", when: "Plays while the timer counts down.", match: /think_clock/i },
  { id: "thinkDrums", label: "Countdown, destinations 16 to 30", when: "Plays while the timer counts down.", match: /think_drums/i },
  { id: "thinkOver", label: "Time is up", when: "Plays once when the timer stops.", match: /think_over/i },
  { id: "boardsLoop", label: "Boards up", when: "Loops while contestants hold up their boards.", match: /contestant_answer_reveal|boards_up/i },
  { id: "revealLead", label: "Answer lead-in", when: "Plays when you press Reveal answer. The answer appears when it ends.", match: /correct_answer_reveal/i },
  { id: "correct", label: "Correct answer appears", when: "Plays as the answer appears.", match: /correct_answer(?!_reveal)/i },
  { id: "congrats", label: "After the correct answer", when: "Plays straight after the one above.", match: /congratulations/i },
  { id: "elimination", label: "Checking eliminations", when: "Loops while you mark who is out.", match: /contestant_elimination|elimination/i },
  { id: "rescueGame", label: "Rescue game", when: "Loops while the rescue game is on the projector (it pauses for the beat game's own beat).", match: /rescue|mayday/i },
  { id: "finale", label: "Finale", when: "Loops while the finale is on the projector.", match: /finale/i },
];
export const cueForFile = (name) => SOUND_CUES.find((c) => c.match.test(name || ""))?.id || null;
export const LATE_STAGE_STOP = 16; // from this destination on, the countdown uses the "drums" music
export const MAX_LEAD_MS = 20000; // a lead-in longer than this is cut, so a wrong file cannot stall the show

export function normalizeSounds(input = {}) {
  const out = {};
  for (const { id } of SOUND_CUES) {
    const s = input && input[id];
    if (!s || typeof s.src !== "string" || !/^\/media\/sounds\/[\w.-]+$/.test(s.src)) continue;
    out[id] = { src: s.src, name: str(s.name, 200), durationMs: Math.round(num(s.durationMs, 0, 3600000, 0)) };
  }
  return out;
}

export function difficultyForStop(stop, settings) {
  if (stop <= settings.easyUntil) return "easy";
  if (stop <= settings.mediumUntil) return "medium";
  return "hard";
}

// ---- Rescue content (kept apart from the main question bank) ----

export const EMERGENCY_RULES = {
  returnLastOut: "Everyone knocked out on the last question returns",
  returnAll: "Every eliminated contestant returns",
  hostPick: "Host picks who returns",
  endShow: "The show ends here",
};

// The rescue: every eliminated contestant plays one of four games as a team. The team's score sets
// what share of them comes back on board; the host then picks who, up to that number.
export const RESCUE_KINDS = ["beat", "doodle", "semantle", "tower"];
export const DEFAULT_TOWER_RULES = [
  "Everyone plays as one team.",
  "Take turns: one person places one paper cup at a time.",
  "Build the tallest tower you can in the time.",
  "Each level of the tower that is still standing at the end counts.",
].join("\n");
export const DEFAULT_SEMANTLE_PUZZLES = "1700, 1650, 1600, 1550, 1500, 1450, 1400, 1350, 1300, 1250";

export function defaultRescue() {
  return {
    emergencyRule: "returnLastOut",
    beat: { rate: 10, allAt: 4 },
    doodle: { rate: 10, allAt: 7, rounds: 10, drawSeconds: 8, guessSeconds: 10 },
    semantle: { minutes: 5, puzzles: DEFAULT_SEMANTLE_PUZZLES, lowAt: 900, lowPct: 20, highAt: 990, highPct: 50 },
    tower: { title: "Control tower", rules: DEFAULT_TOWER_RULES, seconds: 90, rate: 10, allAt: 7 },
  };
}

export function normalizeRescue(r = {}) {
  const d = defaultRescue();
  const int = (v, lo, hi, dflt) => Math.round(num(v, lo, hi, dflt));
  const rated = (x = {}, dd) => ({ rate: int(x.rate, 1, 100, dd.rate), allAt: int(x.allAt, 1, 99, dd.allAt) });
  const b = r.beat || {}, o = r.doodle || {}, m = r.semantle || {}, t = r.tower || {};
  const lowAt = int(m.lowAt, 1, 999, d.semantle.lowAt);
  return {
    emergencyRule: EMERGENCY_RULES[r.emergencyRule] ? r.emergencyRule : d.emergencyRule,
    beat: { ...rated(b, d.beat), allAt: int(b.allAt, 1, 5, d.beat.allAt) },
    doodle: { ...rated(o, d.doodle), rounds: int(o.rounds, 3, 20, d.doodle.rounds), drawSeconds: num(o.drawSeconds, 2, 30, d.doodle.drawSeconds), guessSeconds: int(o.guessSeconds, 3, 60, d.doodle.guessSeconds) },
    semantle: {
      minutes: num(m.minutes, 1, 30, d.semantle.minutes),
      puzzles: semantlePuzzles(m.puzzles ?? d.semantle.puzzles).join(", ") || d.semantle.puzzles,
      lowAt, lowPct: int(m.lowPct, 1, 99, d.semantle.lowPct),
      highAt: int(m.highAt, lowAt, 999, Math.max(lowAt, d.semantle.highAt)), highPct: int(m.highPct, 1, 99, d.semantle.highPct),
    },
    tower: {
      ...rated(t, d.tower),
      title: str(t.title, 80).trim() || d.tower.title,
      rules: typeof t.rules === "string" ? str(t.rules, 2000).trim() : d.tower.rules,
      seconds: int(t.seconds, 10, 600, d.tower.seconds),
    },
  };
}

// Archive numbers typed by the host, e.g. "1700, 1650 1600".
export const semantlePuzzles = (text) => [...new Set(String(text || "").split(/[^0-9]+/).filter(Boolean).map(Number).filter((n) => n > 0 && n < 100000))].slice(0, 50);

// The team's score: rounds won (beat, doodle), Semantle closeness out of 1000, tower levels.
export const rescueScore = (game) => (!game ? 0 : ["beat", "doodle"].includes(game.kind) ? game.results.filter(Boolean).length : game.score || 0);

// Share of the eliminated contestants who come back, in percent.
export function rescuePct(kind, score, cfg) {
  if (kind === "semantle") {
    const m = cfg.semantle;
    return score >= 1000 ? 100 : score >= m.highAt ? m.highPct : score >= m.lowAt ? m.lowPct : 0;
  }
  const g = cfg[kind];
  return score >= g.allAt ? 100 : Math.min(100, score * g.rate);
}
// How many of `out` eliminated contestants that is: rounded, at least one once anything is won.
export const rescueCount = (pct, out) => (pct <= 0 || out <= 0 ? 0 : pct >= 100 ? out : Math.min(out, Math.max(1, Math.round((pct * out) / 100))));

const UNIT = { beat: ["level", "levels"], doodle: ["country", "countries"], tower: ["level", "levels"] };
// The score ladder shown before a game starts.
export function rescueLadder(kind, cfg) {
  if (kind === "semantle") {
    const m = cfg.semantle;
    return [`Closeness ${m.lowAt}+ → ${m.lowPct}% back`, `Closeness ${m.highAt}+ → ${m.highPct}% back`, "Find the word → everyone back"];
  }
  const g = cfg[kind], [one, many] = UNIT[kind], lines = [];
  for (let n = 1; n < g.allAt; n++) if (n * g.rate < 100) lines.push(`${n} ${n === 1 ? one : many} → ${n * g.rate}% back`);
  lines.push(`${g.allAt} ${g.allAt === 1 ? one : many} → everyone back`);
  return lines;
}

export function rescueInfo(kind, cfg) {
  switch (kind) {
    case "beat": return { title: "Say it on the beat", howTo: ["Eight flags light up one at a time, on the beat.", "Say each country out loud, together, right on the beat.", "Five levels, each one faster. The last level has no names!"] };
    case "doodle": return { title: "Guess the doodle", howTo: ["A country's outline draws itself on the screen.", `Shout the country before the ${cfg.doodle.guessSeconds}-second countdown runs out.`, `${cfg.doodle.rounds} countries. No guess in time and the plane moves on.`] };
    case "semantle": return { title: "Semantle", howTo: [`Find the secret word in ${cfg.semantle.minutes} minutes.`, "Come up one at a time and type a single word.", "The closer the meaning, the higher the score out of 1000."] };
    case "tower": return { title: cfg.tower.title, howTo: ruleLines(cfg.tower.rules) };
    default: return { title: "Rescue game", howTo: [] };
  }
}

// The rules as the projector lists them: one per non-empty line.
export const ruleLines = (text) => String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12);
