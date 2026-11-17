// The show's state machine. Pure: (session, action, context) -> new session, or throws ShowError.
// Nothing here reads a clock, a file, or random numbers directly; the server passes them in,
// which is what makes every rule below testable.
//
// The rule this file exists to protect: flying, showing the question, starting the timer and
// revealing the answer are four separate host actions. No action here performs two of them.

import { TOTAL_STOPS, publishErrors, difficultyForStop, clueReady, rescueReturnCount, MAX_LEAD_MS } from "./schema.mjs";

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
    rescue: null, rescueAttempts: 0, usedClueIds: [], lastRescue: null,
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

export function rescueOutcome(s, rescueContent) {
  const r = s.rescue;
  if (!r) return null;
  const correct = r.clues.filter((c) => c.result === "correct").length;
  const rule = rescueContent.rules[correct];
  const out = eliminated(s).length;
  return { correct, rule, returnCount: rescueReturnCount(rule, out), eliminated: out };
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
const pick = (list, count, random) => {
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, count);
};
const backInTheAir = (s, returnedIds, now, extra = {}) => ({
  ...s,
  contestants: setStatus(s, returnedIds, "active", null),
  phase: "READY_TO_FLY", rescue: null, allOutAtStop: null,
  lastRescue: { returnedIds, at: now, ...extra },
});

function buildRescue(s, ctx, crew) {
  const ready = ctx.rescue.clues.filter(clueReady);
  if (ready.length < 3) fail("The rescue needs three ready clues (each with a prompt or image, and an answer). Add them in the Rescue tab, or use an emergency return.");
  let fresh = ready.filter((c) => !s.usedClueIds.includes(c.id));
  let usedClueIds = s.usedClueIds;
  if (fresh.length < 3) { fresh = ready; usedClueIds = []; }
  const clues = fresh.slice(0, 3).map((c) => ({ id: c.id, prompt: c.prompt, image: c.image, answer: c.answer, variants: c.variants, hostNotes: c.hostNotes, revealed: false, result: null }));
  const durationMs = ctx.rescue.timerSec * 1000;
  return {
    ...s, phase: "RESCUE", topicBoard: null,
    rescueAttempts: s.rescueAttempts + 1,
    usedClueIds: [...usedClueIds, ...clues.map((c) => c.id)],
    rescue: { attempt: s.rescueAttempts + 1, step: "INTRO", crew, clues, idx: 0, clock: { durationMs, remainingMs: durationMs, deadline: null, running: false, started: false } },
  };
}

const stopClock = (clock, now) => (clock.running ? { ...clock, running: false, remainingMs: Math.max(0, clock.deadline - now), deadline: null } : clock);

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
  startRescue(s, { crewIds }, ctx) {
    need(s, ["ALL_ELIMINATED"], "The rescue mission");
    const crew = [...new Set(crewIds || [])];
    if (crew.length < 1 || crew.length > 3) fail("Pick one, two or three contestants as the rescue crew.");
    crew.forEach((id) => { if (byId(s, id).status !== "eliminated") fail("Only eliminated contestants can join the rescue crew."); });
    return buildRescue(s, ctx, crew);
  },
  rescueShowMap(s) { need(s, ["RESCUE"], "The route map"); if (s.rescue.step !== "INTRO") fail("The map is already up."); return { ...s, rescue: { ...s.rescue, step: "MAP" } }; },
  rescueRevealClue(s) {
    need(s, ["RESCUE"], "Revealing a clue");
    const r = s.rescue;
    if (!["MAP", "CLUES"].includes(r.step)) fail("Clues cannot be revealed at this point of the rescue.");
    if (r.clues[r.idx].revealed) fail("This clue is already on screen.");
    return { ...s, rescue: { ...r, step: "CLUES", clues: r.clues.map((c, i) => (i === r.idx ? { ...c, revealed: true } : c)) } };
  },
  rescueClock(s, { op }, ctx) {
    need(s, ["RESCUE"], "The rescue clock");
    const r = s.rescue;
    if (!["MAP", "CLUES"].includes(r.step)) fail("The rescue clock is not in use at this point.");
    if (op === "pause") return { ...s, rescue: { ...r, clock: stopClock(r.clock, ctx.now) } };
    if (r.clock.running) return s;
    if (r.clock.remainingMs <= 0) fail("The rescue clock has run out.");
    return { ...s, rescue: { ...r, clock: { ...r.clock, running: true, started: true, deadline: ctx.now + r.clock.remainingMs } } };
  },
  rescueMark(s, { result }, ctx) {
    need(s, ["RESCUE"], "Recording the answer");
    const r = s.rescue;
    if (!["MAP", "CLUES"].includes(r.step)) fail("Answers cannot be recorded at this point of the rescue.");
    if (!["correct", "wrong", "skipped"].includes(result)) fail("Unknown result.");
    if (result !== "skipped" && !r.clues[r.idx].revealed) fail("Reveal the clue before recording an answer.");
    const clues = r.clues.map((c, i) => (i === r.idx ? { ...c, result } : c));
    const done = clues.every((c) => c.result);
    return { ...s, rescue: { ...r, step: "CLUES", clues, clock: done ? stopClock(r.clock, ctx.now) : r.clock } };
  },
  rescueNextClue(s) {
    need(s, ["RESCUE"], "The next clue");
    const r = s.rescue;
    if (r.step !== "CLUES" || !r.clues[r.idx].result) fail("Record this clue's result first.");
    if (r.idx >= 2) fail("That was the last clue.");
    return { ...s, rescue: { ...r, idx: r.idx + 1 } };
  },
  rescueTimeUp(s) {
    need(s, ["RESCUE"], "Rescue time-out");
    const r = s.rescue;
    return { ...s, rescue: { ...r, step: "TIME_UP", clues: r.clues.map((c) => (c.result ? c : { ...c, result: "timeout" })), clock: { ...r.clock, running: false, remainingMs: 0, deadline: null } } };
  },
  rescueOverride(s, { idx, result }) {
    need(s, ["RESCUE"], "Overriding a result");
    const r = s.rescue;
    if (!["CLUES", "TIME_UP", "RESULT"].includes(r.step)) fail("Nothing to override yet.");
    if (!["correct", "wrong"].includes(result) || !r.clues[idx]) fail("Unknown override.");
    return { ...s, rescue: { ...r, clues: r.clues.map((c, i) => (i === idx ? { ...c, result, revealed: true } : c)) } };
  },
  rescueRevealResult(s, _, ctx) {
    need(s, ["RESCUE"], "Revealing the rescue result");
    const r = s.rescue;
    if (r.step === "RESULT") return s;
    if (!r.clues.every((c) => c.result)) fail("Record or skip all three clues before revealing the result.");
    return { ...s, rescue: { ...r, step: "RESULT", clock: stopClock(r.clock, ctx.now) } };
  },
  rescueApply(s, { mode, ids }, ctx) {
    need(s, ["RESCUE"], "Returning contestants");
    if (s.rescue.step !== "RESULT") fail("Reveal the rescue result first.");
    const o = rescueOutcome(s, ctx.rescue);
    if (o.returnCount < 1) fail("This result returns nobody. Retry the rescue or use the emergency rule.");
    const out = eliminated(s); // never includes an active contestant
    let back;
    if (o.returnCount >= out.length) back = out.map((c) => c.id);
    else if (mode === "random") back = pick(out, o.returnCount, ctx.random).map((c) => c.id);
    else {
      back = [...new Set(ids || [])];
      const okIds = new Set(out.map((c) => c.id));
      if (!back.length) fail("Pick who returns.");
      if (back.some((id) => !okIds.has(id))) fail("Only eliminated contestants can return.");
      if (back.length > o.returnCount) fail(`This result returns at most ${o.returnCount}.`);
    }
    return backInTheAir(s, back, ctx.now, { correct: o.correct, via: "rescue" });
  },
  rescueRetry(s, _, ctx) {
    need(s, ["RESCUE"], "Retrying the rescue");
    if (!["RESULT", "TIME_UP"].includes(s.rescue.step)) fail("Finish this attempt before retrying.");
    return buildRescue({ ...s, phase: "ALL_ELIMINATED" }, ctx, s.rescue.crew);
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

// What the clock alone is allowed to do: land the plane, raise the boards, end the rescue clock.
export function due(session, now) {
  if (session.phase === "FLIGHT_ANIMATING" && session.flight && now >= session.flight.startedAt + session.flight.durationMs) return { type: "arrive" };
  if (session.phase === "TIMER_RUNNING" && session.timer.running && now >= session.timer.deadline) return { type: "timeUp" };
  if (session.phase === "RESCUE" && session.rescue.clock.running && now >= session.rescue.clock.deadline) return { type: "rescueTimeUp" };
  return null;
}
