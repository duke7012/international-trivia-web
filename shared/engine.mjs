// The show's state machine. Pure: (session, action, context) -> new session, or throws ShowError.
// Nothing here reads a clock, a file, or random numbers directly; the server passes them in,
// which is what makes every rule below testable.
//
// The rule this file exists to protect: flying, showing the question, starting the timer and
// revealing the answer are four separate host actions. No action here performs two of them.

import { TOTAL_STOPS, publishErrors, difficultyForStop, MAX_LEAD_MS, RESCUE_KINDS, rescueScore, rescuePct, rescueCount, semantlePuzzles } from "./schema.mjs";
import { BEAT_SETS, DOODLES, doodleMix } from "./rescue-bank.mjs";

export class ShowError extends Error {}
const fail = (msg) => { throw new ShowError(msg); };

export const PHASES = [
  "LOBBY", "FLIGHT_ANIMATING", "DESTINATION_ARRIVED", "QUESTION_VISIBLE", "TIMER_RUNNING", "BOARDS_UP",
  "ANSWER_REVEALED", "ELIMINATION_REVIEW", "READY_TO_FLY", "ALL_ELIMINATED", "RESCUE", "FINISHED",
];
// Phases in which the question card is on the projector.
export const QUESTION_PHASES = ["QUESTION_VISIBLE", "TIMER_RUNNING", "BOARDS_UP", "ANSWER_REVEALED", "ELIMINATION_REVIEW"];
// Phases in which the correct answer is on the projector.
export const ANSWER_PHASES = ["ANSWER_REVEALED", "ELIMINATION_REVIEW"];
// Phases in which a preview may borrow the projector without covering live content.
export const PREVIEW_SAFE_PHASES = ["LOBBY", "DESTINATION_ARRIVED", "READY_TO_FLY", "FINISHED"];

export const idleMedia = () => ({ status: "idle", pos: 0, at: 0, muted: false, n: 0 });

export function newSession() {
  return {
    rev: 0, phase: "LOBBY", stop: 0,
    flight: null, currentQuestionId: null, chosenTopic: null,
    shown: null, timer: null, media: idleMedia(),
    played: [], contestants: [],
    review: null, lastReview: null, topicBoard: null,
    rescue: null, rescueAttempts: 0, lastRescue: null, rescueUsed: { beat: [], doodle: [], semantle: [] },
    allOutAtStop: null, answerAt: 0,
  };
}

// ---------- read-only helpers (also used by the server to build views) ----------

export const active = (s) => s.contestants.filter((c) => c.status === "active");
export const eliminated = (s) => s.contestants.filter((c) => c.status === "eliminated");
export const usedIds = (s) => new Set(s.played.map((p) => p.questionId));
const soloErrors = (q) => publishErrors(q, []);
export const isPlayable = (q) => q.status === "published" && soloErrors(q).length === 0;

// Fixed order = the first slot that has not been played yet. It must be published to fly into.
export function nextFixed(s, questions) {
  const used = usedIds(s);
  const i = questions.findIndex((q) => !used.has(q.id));
  if (i < 0) return { question: null, reason: "Every question slot has been played." };
  const q = questions[i], n = i + 1;
  if (q.status === "empty") return { question: null, slot: n, reason: `Question ${n} is not configured. Write and publish it, or pick by topic.` };
  if (q.status === "draft") return { question: null, slot: n, reason: `Question ${n} is still a draft. Publish it first.` };
  if (!isPlayable(q)) return { question: null, slot: n, reason: `Question ${n} is incomplete: ${soloErrors(q)[0]}` };
  return { question: q, slot: n };
}

// Every topic in the bank, with whether a question can be drawn from it for the next stop.
export function topicOptions(s, questions, settings) {
  const used = usedIds(s);
  const want = difficultyForStop(s.stop + 1, settings);
  const topics = new Map();
  questions.forEach((q, i) => {
    if (q.status === "empty" || !q.topic) return;
    const key = q.topic.toLowerCase();
    if (!topics.has(key)) topics.set(key, { topic: q.topic, eligible: [], unusedPublished: 0, drafts: 0, total: 0 });
    const t = topics.get(key);
    t.total++;
    if (used.has(q.id)) return;
    if (!isPlayable(q)) { t.drafts++; return; }
    t.unusedPublished++;
    if (!settings.matchDifficulty || q.difficulty === want) t.eligible.push({ id: q.id, slot: i + 1 });
  });
  return [...topics.values()].map((t) => {
    let reason = null;
    if (!t.eligible.length) {
      if (t.unusedPublished) reason = `No unused ${want} question in this topic (this stop calls for ${want}).`;
      else if (t.drafts) reason = "Only unpublished drafts are left in this topic.";
      else reason = "Every question in this topic has been played.";
    }
    return { topic: t.topic, available: t.eligible.length > 0, count: t.eligible.length, reason, next: t.eligible[0] || null };
  }).sort((a, b) => a.topic.localeCompare(b.topic));
}

// Position of a clip, in seconds from its start, given the shared media state.
export const mediaPosition = (m, now) => (m.status === "playing" ? m.pos + Math.max(0, now - m.at) / 1000 : m.pos);

export function mediaReduce(m, op, now, arg) {
  const n = m.n + 1;
  switch (op) {
    case "play": return { ...m, status: "playing", pos: m.status === "ended" ? 0 : m.pos, at: now, n };
    case "pause": return { ...m, status: "paused", pos: mediaPosition(m, now), at: now, n };
    case "replay": return { ...m, status: "playing", pos: 0, at: now, n };
    case "mute": return { ...m, muted: !!arg, n };
    case "ended": return m.status === "playing" ? { ...m, status: "ended", pos: mediaPosition(m, now), at: now, n } : m;
    default: return fail("Unknown media control.");
  }
}

// Time left on the question timer. A lead-in sound may play first; the count only starts after it.
export const timerRemaining = (t, now) => (t.running ? Math.min(t.durationMs, Math.max(0, t.deadline - now)) : t.remainingMs);
// Length of a host-supplied lead-in sound, if there is one.
const lead = (ctx, id) => Math.min(MAX_LEAD_MS, Math.max(0, ctx.sounds?.[id]?.durationMs || 0));

// ---------- the reducer ----------

const need = (s, phases, what) => {
  if (!phases.includes(s.phase)) fail(`${what} is not available right now (the show is in ${s.phase.replaceAll("_", " ").toLowerCase()}).`);
};
const byId = (s, id) => s.contestants.find((c) => c.id === id) || fail("That contestant is not on the roster.");
const setStatus = (s, ids, status, stop) => {
  const set = new Set(ids);
  return s.contestants.map((c) => (set.has(c.id) ? { ...c, status, eliminatedAtStop: status === "eliminated" ? stop : null } : c));
};
const afterElimination = (s) => (active(s).length === 0 && s.contestants.length > 0 ? { ...s, phase: "ALL_ELIMINATED", allOutAtStop: s.stop, rescue: null, topicBoard: null } : s);
const snapshot = (q, slot) => ({ question: structuredClone(q), slot, sourceUpdatedAt: q.updatedAt });
// ----- rescue helpers -----
const game = (s, what) => { need(s, ["RESCUE"], what); return s.rescue?.game || fail("Choose a rescue game first."); };
export const rounds = (g) => (g.kind === "beat" ? g.items.levels.length : g.kind === "doodle" ? g.items.length : 1);
const shuffle = (list, random) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// Unused first, in bank order; once everything has been used, the longest-unused first.
const freshest = (list, key, used) => {
  const last = (x) => used.lastIndexOf(key(x));
  return [...list].sort((a, b) => last(a) - last(b));
};
function drawRescue(kind, used, ctx) {
  if (kind === "beat") {
    const set = freshest(BEAT_SETS, (x) => x.id, used.beat || [])[0];
    const final = shuffle(set.levels.flat(), ctx.random).slice(0, 8).map((f) => ({ ...f, hidden: true }));
    return { set: set.id, levels: [...set.levels, final] };
  }
  if (kind === "doodle") {
    const mix = doodleMix(ctx.rescue.doodle.rounds);
    return ["easy", "medium", "hard"].flatMap((level) => {
      const pool = DOODLES.filter((c) => c.level === level);
      const order = freshest(shuffle(pool, ctx.random), (c) => c.iso3, used.doodle || []);
      return order.slice(0, mix[level]).map(({ name, iso2, iso3 }) => ({ name, iso2, iso3 }));
    });
  }
  if (kind === "semantle") {
    const list = semantlePuzzles(ctx.rescue.semantle.puzzles);
    if (!list.length) fail("Add Semantle puzzle numbers in the Rescue tab first.");
    return { puzzle: freshest(list, (n) => n, used.semantle || [])[0] };
  }
  return {};
}
const backInTheAir = (s, returnedIds, now, extra = {}) => ({
  ...s,
  contestants: setStatus(s, returnedIds, "active", null),
  phase: "READY_TO_FLY", rescue: null, allOutAtStop: null,
  lastRescue: { returnedIds, at: now, ...extra },
});

const handlers = {
  // ----- roster -----
  addContestants(s, { names }, ctx) {
    const clean = (names || []).map((n) => String(n).trim().slice(0, 40)).filter(Boolean);
    if (!clean.length) fail("Type at least one name.");
    if (s.contestants.length + clean.length > 500) fail("The roster is limited to 500 contestants.");
    const fresh = clean.map((name) => ({ id: ctx.id(), name, status: "active", eliminatedAtStop: null }));
    return { ...s, contestants: [...s.contestants, ...fresh] };
  },
  renameContestant(s, { id, name }) {
    byId(s, id);
    const n = String(name || "").trim().slice(0, 40);
    if (!n) fail("A contestant needs a name.");
    return { ...s, contestants: s.contestants.map((c) => (c.id === id ? { ...c, name: n } : c)) };
  },
  removeContestant(s, { id }) {
    byId(s, id);
    need(s, ["LOBBY", "READY_TO_FLY", "FINISHED"], "Removing a contestant");
    return afterElimination({ ...s, contestants: s.contestants.filter((c) => c.id !== id) });
  },
  // Manual correction by the host (a mis-marked board, a late arrival and so on).
  setContestantStatus(s, { id, status }) {
    const c = byId(s, id);
    if (!["active", "eliminated"].includes(status)) fail("Unknown status.");
    need(s, ["LOBBY", "READY_TO_FLY", "FINISHED"], "Changing a contestant by hand");
    if (c.status === status) return s;
    return afterElimination({ ...s, contestants: setStatus(s, [id], status, s.stop) });
  },

  // ----- topic choice board -----
  openTopicBoard(s, { contestantId }) {
    need(s, ["LOBBY", "READY_TO_FLY"], "A topic choice");
    if (contestantId) { if (byId(s, contestantId).status !== "active") fail("Only a contestant who is still in the game can choose the topic."); }
    return { ...s, topicBoard: { contestantId: contestantId || null } };
  },
  closeTopicBoard(s) { return { ...s, topicBoard: null }; },

  // ----- Step A: fly -----
  fly(s, { topic }, ctx) {
    need(s, ["LOBBY", "READY_TO_FLY"], "Flying");
    if (!s.contestants.length) fail("Add contestants to the roster before the first flight.");
    if (!active(s).length) fail("Nobody is left in the game.");
    if (s.stop >= TOTAL_STOPS) fail("The plane has reached the final destination.");
    let q, slot;
    if (topic) {
      const opt = topicOptions(s, ctx.questions, ctx.settings).find((t) => t.topic.toLowerCase() === String(topic).toLowerCase());
      if (!opt) fail("That topic is not in the question bank.");
      if (!opt.available) fail(opt.reason);
      q = ctx.questions.find((x) => x.id === opt.next.id); slot = opt.next.slot;
    } else {
      const nf = nextFixed(s, ctx.questions);
      if (!nf.question) fail(nf.reason);
      q = nf.question; slot = nf.slot;
    }
    const stop = s.stop + 1;
    return {
      ...s, phase: "FLIGHT_ANIMATING", stop,
      flight: { from: s.stop, to: stop, startedAt: ctx.now, durationMs: Math.round(ctx.settings.flightSeconds * 1000) },
      currentQuestionId: q.id, chosenTopic: topic ? q.topic : null,
      played: [...s.played, { stop, questionId: q.id, slot }],
      shown: null, timer: null, media: idleMedia(), review: null, lastReview: null, topicBoard: null, lastRescue: null,
    };
  },
  // Landing, whether the animation ran or was skipped, only ever leads to the waiting card.
  arrive(s) { need(s, ["FLIGHT_ANIMATING"], "Landing"); return { ...s, phase: "DESTINATION_ARRIVED", flight: null }; },
  skipFlight(s) { need(s, ["FLIGHT_ANIMATING"], "Skipping the flight"); return { ...s, phase: "DESTINATION_ARRIVED", flight: null }; },

  // ----- Step B: show the question -----
  showQuestion(s, _, ctx) {
    need(s, ["DESTINATION_ARRIVED"], "Showing the question");
    const i = ctx.questions.findIndex((x) => x.id === s.currentQuestionId);
    const q = ctx.questions[i];
    if (!q || q.status !== "published") fail("This destination's question is no longer published. Publish it in the Questions tab first.");
    if (!isPlayable(q)) fail(`This question is incomplete: ${soloErrors(q)[0]}`);
    return { ...s, phase: "QUESTION_VISIBLE", shown: snapshot(q, i + 1), timer: null, media: idleMedia() };
  },
  hideQuestion(s) { need(s, ["QUESTION_VISIBLE"], "Hiding the question"); return { ...s, phase: "DESTINATION_ARRIVED", shown: null, media: idleMedia() }; },
  // Deliberate push of an edited question to the projector.
  updateProjector(s, _, ctx) {
    need(s, QUESTION_PHASES, "Updating the projector");
    const i = ctx.questions.findIndex((x) => x.id === s.currentQuestionId);
    const q = ctx.questions[i];
    if (!q || !isPlayable(q)) fail("The edited question is not publishable yet, so the projector keeps the version it has.");
    const mediaChanged = JSON.stringify(q.media) !== JSON.stringify(s.shown.question.media);
    return { ...s, shown: snapshot(q, i + 1), media: mediaChanged ? idleMedia() : s.media };
  },

  // ----- Step C: timer -----
  startTimer(s, _, ctx) {
    need(s, ["QUESTION_VISIBLE"], "Starting the timer");
    const durationMs = (s.shown.question.countdown || ctx.settings.defaultCountdown) * 1000;
    // If the host has a "timer lead-in" sound, it plays first and the count starts when it ends.
    const leadMs = lead(ctx, "thinkStart");
    return { ...s, phase: "TIMER_RUNNING", timer: { durationMs, leadMs, startedAt: ctx.now, deadline: ctx.now + leadMs + durationMs, remainingMs: durationMs, running: true } };
  },
  pauseTimer(s, _, ctx) {
    need(s, ["TIMER_RUNNING"], "Pausing the timer");
    if (!s.timer.running) return s;
    const left = Math.max(0, s.timer.deadline - ctx.now);
    return { ...s, timer: { ...s.timer, running: false, remainingMs: Math.min(s.timer.durationMs, left), leadLeftMs: Math.max(0, left - s.timer.durationMs), deadline: null } };
  },
  resumeTimer(s, _, ctx) {
    need(s, ["TIMER_RUNNING"], "Resuming the timer");
    if (s.timer.running) return s;
    return { ...s, timer: { ...s.timer, running: true, deadline: ctx.now + (s.timer.leadLeftMs || 0) + s.timer.remainingMs } };
  },
  resetTimer(s) { need(s, ["TIMER_RUNNING", "BOARDS_UP"], "Resetting the timer"); return { ...s, phase: "QUESTION_VISIBLE", timer: null }; },
  // Reaching zero (or the host calling time) raises the boards. It never reveals the answer.
  timeUp(s) {
    need(s, ["TIMER_RUNNING"], "Calling time");
    return { ...s, phase: "BOARDS_UP", timer: { ...s.timer, running: false, remainingMs: 0, deadline: null } };
  },

  // ----- Step D: reveal -----
  // The reveal is the host's decision at this moment. If there is an "answer lead-in" sound, the
  // answer appears on screen when that sound ends.
  revealAnswer(s, _, ctx) { need(s, ["BOARDS_UP"], "Revealing the answer"); return { ...s, phase: "ANSWER_REVEALED", answerAt: ctx.now + lead(ctx, "revealLead") }; },

  // ----- eliminations -----
  startReview(s) { need(s, ["ANSWER_REVEALED"], "The elimination review"); return { ...s, phase: "ELIMINATION_REVIEW", review: { wrong: [] } }; },
  setWrong(s, { ids }) {
    need(s, ["ELIMINATION_REVIEW"], "Marking boards");
    const ok = new Set(active(s).map((c) => c.id));
    return { ...s, review: { wrong: [...new Set(ids || [])].filter((id) => ok.has(id)) } };
  },
  confirmEliminations(s) {
    need(s, ["ELIMINATION_REVIEW"], "Confirming eliminations");
    const out = s.review.wrong;
    const next = { ...s, contestants: setStatus(s, out, "eliminated", s.stop), phase: "READY_TO_FLY", review: null, lastReview: { stop: s.stop, eliminatedIds: out } };
    return afterElimination(next);
  },

  // ----- MAYDAY rescue (only ever reachable from ALL_ELIMINATED, only ever started by the host) -----
  // Everyone who is out plays one game as a team. The host runs it round by round; the team's
  // score sets how many may return, and the host picks who.
  startRescue(s) {
    need(s, ["ALL_ELIMINATED"], "The rescue game");
    return { ...s, phase: "RESCUE", topicBoard: null, rescueAttempts: s.rescueAttempts + 1, rescue: { attempt: s.rescueAttempts + 1, game: null } };
  },
  rescuePick(s, { kind }, ctx) {
    need(s, ["RESCUE"], "Choosing the rescue game");
    if (!RESCUE_KINDS.includes(kind)) fail("Unknown rescue game.");
    if (s.rescue.game && s.rescue.game.status !== "intro") fail("A game is already under way. Leave the rescue to start over.");
    const items = drawRescue(kind, s.rescueUsed || {}, ctx);
    return { ...s, rescue: { ...s.rescue, game: { kind, items, round: 0, status: "intro", startedAt: null, deadline: null, results: [], score: null } } };
  },
  rescueGo(s, _, ctx) {
    const g = game(s, "Starting the game");
    const cfg = ctx.rescue, now = ctx.now;
    let next;
    if (g.kind === "beat") {
      if (!["intro", "ready", "playing"].includes(g.status)) fail("Mark this level first.");
      next = { ...g, status: "playing", startedAt: now };
    } else if (g.kind === "doodle") {
      if (!["intro", "ready"].includes(g.status)) fail("This country is already on screen.");
      next = { ...g, status: "playing", startedAt: now, deadline: now + Math.round((cfg.doodle.drawSeconds + cfg.doodle.guessSeconds) * 1000) };
    } else {
      if (g.status !== "intro") fail("The timer has already run.");
      const ms = g.kind === "semantle" ? cfg.semantle.minutes * 60000 : cfg.tower.seconds * 1000;
      next = { ...g, status: "playing", startedAt: now, deadline: now + Math.round(ms) };
    }
    // What a game uses is spent once it starts, so the next rescue round gets fresh ones.
    const used = s.rescueUsed || { beat: [], doodle: [], semantle: [] };
    const rescueUsed = g.status !== "intro" ? used
      : g.kind === "beat" ? { ...used, beat: [...used.beat, g.items.set] }
      : g.kind === "doodle" ? { ...used, doodle: [...used.doodle, ...g.items.map((c) => c.iso3)] }
      : g.kind === "semantle" ? { ...used, semantle: [...used.semantle, g.items.puzzle] } : used;
    return { ...s, rescueUsed, rescue: { ...s.rescue, game: next } };
  },
  rescueMark(s, { ok }) {
    const g = game(s, "Marking the round");
    if (!["beat", "doodle"].includes(g.kind)) fail("This game is scored at the end.");
    if (g.status !== "playing") fail("Start the round first.");
    const results = [...g.results]; results[g.round] = !!ok;
    return { ...s, rescue: { ...s.rescue, game: { ...g, results, status: "marked", deadline: null } } };
  },
  rescueNext(s) {
    const g = game(s, "Moving on");
    if (g.status !== "marked") fail("Mark this round first.");
    const last = g.round + 1 >= rounds(g);
    return { ...s, rescue: { ...s.rescue, game: { ...g, round: last ? g.round : g.round + 1, status: last ? "done" : "ready", startedAt: last ? g.startedAt : null } } };
  },
  rescueScore(s, { score }) {
    const g = game(s, "Entering the score");
    if (!["semantle", "tower"].includes(g.kind)) fail("This game is scored round by round.");
    if (g.status === "intro") fail("Start the game first.");
    const n = Math.round(Number(score));
    const max = g.kind === "semantle" ? 1000 : 99;
    if (!Number.isFinite(n) || n < 0 || n > max) fail(g.kind === "semantle" ? "Enter the closeness from 0 to 1000 (1000 if they found the word)." : "Enter how many levels the tower reached.");
    return { ...s, rescue: { ...s.rescue, game: { ...g, score: n, status: "done", deadline: null } } };
  },
  // The clock: a doodle nobody guessed is a miss; a timed game stops and waits for its score.
  rescueTimeout(s) {
    const g = game(s, "Calling time");
    if (g.status !== "playing" || !g.deadline) return s;
    if (g.kind === "doodle") return handlers.rescueMark(s, { ok: false });
    return { ...s, rescue: { ...s.rescue, game: { ...g, status: "timeUp", deadline: null } } };
  },
  rescueApply(s, { ids }, ctx) {
    const g = game(s, "Returning contestants");
    if (g.status !== "done") fail("Finish the game first.");
    const out = eliminated(s);
    const okIds = new Set(out.map((c) => c.id)); // never includes an active contestant
    const back = [...new Set(ids || [])];
    const max = rescueCount(rescuePct(g.kind, rescueScore(g), ctx.rescue), out.length);
    if (!max) fail("The team did not score enough to bring anyone back. Use an emergency exit or leave the rescue.");
    if (!back.length) fail("Pick who returns.");
    if (back.length > max) fail(`The team earned ${max} ${max === 1 ? "place" : "places"} back on board.`);
    if (back.some((id) => !okIds.has(id))) fail("Only eliminated contestants can return.");
    return backInTheAir(s, back, ctx.now, { via: "rescue" });
  },
  rescueAbort(s) { need(s, ["RESCUE"], "Leaving the rescue"); return { ...s, phase: "ALL_ELIMINATED", rescue: null }; },

  // ----- emergency exits: the show can never be stranded with nobody in the game -----
  emergencyReturn(s, { ids }, ctx) {
    need(s, ["ALL_ELIMINATED", "RESCUE"], "An emergency return");
    const okIds = new Set(eliminated(s).map((c) => c.id));
    const back = [...new Set(ids || [])];
    if (!back.length) fail("Pick who returns.");
    if (back.some((id) => !okIds.has(id))) fail("Only eliminated contestants can return.");
    return backInTheAir(s, back, ctx.now, { via: "emergency" });
  },
  emergencyRule(s, { ids }, ctx) {
    need(s, ["ALL_ELIMINATED", "RESCUE"], "The emergency rule");
    const rule = ctx.rescue.emergencyRule;
    const out = eliminated(s);
    if (rule === "endShow") return { ...s, phase: "FINISHED", rescue: null };
    if (rule === "hostPick") return handlers.emergencyReturn(s, { ids }, ctx);
    const back = rule === "returnAll" ? out : out.filter((c) => c.eliminatedAtStop === s.allOutAtStop);
    return backInTheAir(s, (back.length ? back : out).map((c) => c.id), ctx.now, { via: "emergency" });
  },

  // ----- ending -----
  finishShow(s) { need(s, ["READY_TO_FLY"], "The finale"); return { ...s, phase: "FINISHED", topicBoard: null }; },
  reopenShow(s) {
    need(s, ["FINISHED"], "Reopening the show");
    if (!active(s).length && s.contestants.length) return { ...s, phase: "ALL_ELIMINATED", allOutAtStop: s.stop };
    return { ...s, phase: s.stop === 0 ? "LOBBY" : "READY_TO_FLY" };
  },
  resetShow(s, { clearRoster }) {
    const fresh = newSession();
    fresh.contestants = clearRoster ? [] : s.contestants.map((c) => ({ ...c, status: "active", eliminatedAtStop: null }));
    return fresh;
  },

  // ----- media on the question card (host-driven; never touches the timer) -----
  media(s, { op, value }, ctx) {
    need(s, QUESTION_PHASES, "Media controls");
    if (!["video", "audio"].includes(s.shown.question.presentation)) fail("This question has no video or audio.");
    return { ...s, media: mediaReduce(s.media, op, ctx.now, value) };
  },
};

export const ACTIONS = Object.keys(handlers);

export function reduce(session, action, ctx) {
  const h = handlers[action.type];
  if (!h) fail(`Unknown action "${action.type}".`);
  const next = h(session, action.payload || {}, ctx);
  return next === session ? session : { ...next, rev: session.rev + 1 };
}

// What the clock alone is allowed to do: land the plane, raise the boards, and end a rescue round.
export function due(session, now) {
  const g = session.phase === "RESCUE" && session.rescue?.game;
  if (g && g.status === "playing" && g.deadline && now >= g.deadline) return { type: "rescueTimeout" };
  if (session.phase === "FLIGHT_ANIMATING" && session.flight && now >= session.flight.startedAt + session.flight.durationMs) return { type: "arrive" };
  if (session.phase === "TIMER_RUNNING" && session.timer.running && now >= session.timer.deadline) return { type: "timeUp" };
  return null;
}
