// What each screen is allowed to know.
// The host sees everything. The projector is sent a question only once the host has shown it,
// and an answer only once the host has revealed it, so a refresh (or a curious look in the
// browser's developer tools) can never expose anything early.
import { TOTAL_STOPS, answerText, describeRule, youtubeId, publishErrors, draftWarnings } from "../shared/schema.mjs";
import { QUESTION_PHASES, ANSWER_PHASES, active, eliminated, nextFixed, topicOptions, rescueOutcome } from "../shared/engine.mjs";

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

export function projectorView(ws, preview, now) {
  const s = ws.session, st = ws.settings;
  const names = (ids) => (st.showNames ? ids.map((id) => s.contestants.find((c) => c.id === id)?.name).filter(Boolean) : []);
  const v = {
    now, rev: s.rev, workspace: ws.name, title: st.showTitle,
    phase: s.phase, stop: s.stop, totalStops: TOTAL_STOPS, flight: s.flight,
    counts: { active: active(s).length, eliminated: eliminated(s).length, total: s.contestants.length },
    sound: { timer: st.timerSound, volume: st.volume },
    chosenTopic: s.stop > 0 ? s.chosenTopic : null,
    question: null, answer: null, timer: null, media: null,
    lastReview: null, topicBoard: null, rescue: null, lastRescue: null, finale: null, preview: null,
  };
  if (QUESTION_PHASES.includes(s.phase) && s.shown) {
    v.question = stageQuestion(s.shown.question, st);
    v.timer = s.timer || { idle: true, durationMs: v.question.countdown * 1000 };
    v.media = s.media;
    if (ANSWER_PHASES.includes(s.phase)) v.answer = stageAnswer(s.shown.question);
  }
  if (s.lastReview && ["READY_TO_FLY", "ALL_ELIMINATED"].includes(s.phase)) v.lastReview = { stop: s.lastReview.stop, count: s.lastReview.eliminatedIds.length, names: names(s.lastReview.eliminatedIds) };
  if (s.topicBoard) {
    v.topicBoard = {
      chooser: s.topicBoard.contestantId ? names([s.topicBoard.contestantId])[0] || null : null,
      topics: topicOptions(s, ws.questions, st).map((t) => ({ topic: t.topic, available: t.available })),
    };
  }
  if (s.lastRescue && s.phase === "READY_TO_FLY") v.lastRescue = { count: s.lastRescue.returnedIds.length, names: names(s.lastRescue.returnedIds), via: s.lastRescue.via };
  if (s.phase === "RESCUE" && s.rescue) {
    const r = s.rescue, o = rescueOutcome(s, ws.rescue);
    v.rescue = {
      attempt: r.attempt, step: r.step, idx: r.idx, crew: names(r.crew), clock: r.clock,
      clues: r.clues.map((c) => ({
        revealed: c.revealed, result: c.result,
        prompt: c.revealed ? c.prompt : null, image: c.revealed ? stageMedia(c.image) : null,
        answer: c.result ? c.answer : null,
      })),
      outcome: r.step === "RESULT" ? { correct: o.correct, returnCount: o.returnCount, eliminated: o.eliminated, rule: describeRule(o.rule) } : null,
    };
  }
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
    rescueOutcome: s.rescue ? (({ correct, returnCount, eliminated: out, rule }) => ({ correct, returnCount, eliminated: out, rule: describeRule(rule) }))(rescueOutcome(s, ws.rescue)) : null,
    ...extra,
  };
}
