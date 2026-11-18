// What each screen is allowed to know.
// The host sees everything. The projector is sent a question only once the host has shown it,
// and an answer only once the host has revealed it, so a refresh (or a curious look in the
// browser's developer tools) can never expose anything early.
import { TOTAL_STOPS, answerText, youtubeId, publishErrors, draftWarnings, rescueInfo, rescueLadder, rescueScore, rescuePct, rescueCount, showRules } from "../shared/schema.mjs";
import { QUESTION_PHASES, ANSWER_PHASES, active, eliminated, nextFixed, topicOptions, rounds } from "../shared/engine.mjs";
import { BEAT_BPM, semantleUrl } from "../shared/rescue-bank.mjs";
import OUTLINES from "./rescue-outlines.mjs";

const flag = (iso2) => `/flags/${iso2}.png`;
// The rescue game as the room sees it: only what is on screen right now, and a doodle's name
// only once that round is over.
function stageRescue(r, cfg, out) {
  const g = r.game;
  const v = { attempt: r.attempt, kind: g?.kind || null, out };
  if (!g) return v;
  const score = rescueScore(g), pct = rescuePct(g.kind, score, cfg);
  Object.assign(v, rescueInfo(g.kind, cfg), {
    ladder: rescueLadder(g.kind, cfg), status: g.status, round: g.round, rounds: rounds(g),
    startedAt: g.startedAt, deadline: g.deadline, results: g.results, score, pct, count: rescueCount(pct, out),
  });
  if (g.status === "intro") return v;
  if (g.kind === "beat") {
    v.bpm = BEAT_BPM[g.round] || BEAT_BPM.at(-1);
    v.flags = g.items.levels[g.round].map((f) => ({ src: flag(f.iso2), name: f.hidden ? null : f.name }));
  } else if (g.kind === "doodle") {
    // Nothing about the next country shows while it waits for Draw country: the outline
    // appears as it draws, the name once the round is marked.
    const c = g.items[g.round];
    v.drawMs = Math.round(cfg.doodle.drawSeconds * 1000);
    if (g.status !== "ready") v.outline = OUTLINES[c.iso3] || null;
    if (["marked", "done"].includes(g.status)) v.answer = { name: c.name, flag: flag(c.iso2), ok: !!g.results[g.round] };
  } else if (g.kind === "semantle") {
    v.puzzle = g.items.puzzle; v.url = semantleUrl(g.items.puzzle);
  }
  return v;
}

const stageMedia = (m) => m && {
  src: m.src, fit: m.fit, zoom: m.zoom, focusX: m.focusX, focusY: m.focusY,
  clipStart: m.clipStart, clipEnd: m.clipEnd, youtube: youtubeId(m.src),
};

// A question as the audience sees it: no answer, no country, no notes, no file name.
export const stageQuestion = (q, settings) => ({
  text: q.text, presentation: q.presentation, answerFormat: q.answerFormat,
  choices: q.answerFormat === "choice" ? q.choices : null,
  topic: q.topic, media: stageMedia(q.media),
  countdown: q.countdown || settings.defaultCountdown,
});
export const stageAnswer = (q) => ({ correctChoice: q.answerFormat === "choice" ? q.correctChoice : null, text: answerText(q), explanation: q.explanation });

export function projectorView(ws, preview, now, sounds = {}) {
  const s = ws.session, st = ws.settings;
  const names = (ids) => (st.showNames ? ids.map((id) => s.contestants.find((c) => c.id === id)?.name).filter(Boolean) : []);
  const v = {
    now, rev: s.rev, workspace: ws.name, title: st.showTitle,
    phase: s.phase, stop: s.stop, totalStops: TOTAL_STOPS, flight: s.flight,
    counts: { active: active(s).length, eliminated: eliminated(s).length, total: s.contestants.length },
    sound: { timer: st.timerSound, volume: st.volume },
    // the host's own sound files: where each is, and how long it runs (never its name)
    cues: Object.fromEntries(Object.entries(sounds).map(([id, s]) => [id, { src: s.src, durationMs: s.durationMs }])),
    answerAt: 0,
    chosenTopic: s.stop > 0 ? s.chosenTopic : null,
    question: null, answer: null, timer: null, media: null,
    lastReview: null, topicBoard: null, rescue: null, lastRescue: null, finale: null, preview: null, rules: null,
  };
  if (QUESTION_PHASES.includes(s.phase) && s.shown) {
    v.question = stageQuestion(s.shown.question, st);
    v.timer = s.timer || { idle: true, durationMs: v.question.countdown * 1000 };
    v.media = s.media;
    if (ANSWER_PHASES.includes(s.phase)) { v.answer = stageAnswer(s.shown.question); v.answerAt = s.answerAt || 0; }
  }
  if (s.lastReview && ["READY_TO_FLY", "ALL_ELIMINATED"].includes(s.phase)) v.lastReview = { stop: s.lastReview.stop, count: s.lastReview.eliminatedIds.length, names: names(s.lastReview.eliminatedIds) };
  if (s.topicBoard) {
    v.topicBoard = {
      chooser: s.topicBoard.contestantId ? names([s.topicBoard.contestantId])[0] || null : null,
      topics: topicOptions(s, ws.questions, st).map((t) => ({ topic: t.topic, available: t.available })),
    };
  }
  if (s.lastRescue && s.phase === "READY_TO_FLY") v.lastRescue = { count: s.lastRescue.returnedIds.length, names: names(s.lastRescue.returnedIds), via: s.lastRescue.via };
  if (s.phase === "RESCUE" && s.rescue) v.rescue = stageRescue(s.rescue, ws.rescue, eliminated(s).length);
  if (s.rules && s.phase === "LOBBY") v.rules = { ...s.rules, lines: showRules(st) };
  if (s.phase === "FINISHED") v.finale = { winners: names(active(s).map((c) => c.id)), count: active(s).length, stop: s.stop };
  if (preview) {
    v.preview = preview.kind === "flight"
      ? { kind: "flight", from: preview.from, to: preview.to, startedAt: preview.startedAt, durationMs: preview.durationMs }
      : { kind: "question", number: preview.number, question: stageQuestion(preview.question, st), answer: preview.showAnswer ? stageAnswer(preview.question) : null, media: preview.media };
  }
  return v;
}

export function hostView(ws, extra, now) {
  const s = ws.session;
  const current = ws.questions.find((q) => q.id === s.currentQuestionId) || null;
  return {
    now, workspace: ws.name,
    session: s, questions: ws.questions, rescue: ws.rescue, settings: ws.settings,
    checks: ws.questions.map((q) => (q.status === "empty" ? null : { errors: publishErrors(q, ws.questions), warnings: draftWarnings(q, ws.questions) })),
    next: { fixed: s.stop >= TOTAL_STOPS ? { question: null, reason: "The plane has reached the final destination." } : (({ question, slot, reason }) => ({ id: question?.id || null, slot, reason }))(nextFixed(s, ws.questions)), topics: topicOptions(s, ws.questions, ws.settings) },
    currentSlot: current ? ws.questions.indexOf(current) + 1 : null,
    // True when the bank's copy of the on-stage question is newer than what the projector shows.
    stale: !!(s.shown && current && current.updatedAt !== s.shown.sourceUpdatedAt),
    ...extra,
  };
}
