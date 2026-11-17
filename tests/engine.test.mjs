// Rules of the show, tested without a browser or a server.  Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { reduce, newSession, due, ShowError, active, eliminated, nextFixed, topicOptions, rescueOutcome, QUESTION_PHASES } from "../shared/engine.mjs";
import { emptyQuestion, normalizeQuestion, publishErrors, defaultSettings, defaultRescue, normalizeRescue, rescueReturnCount, TOTAL_STOPS } from "../shared/schema.mjs";

let seq = 0;
const q = (over = {}) => ({
  ...normalizeQuestion({ text: "Q?", answerFormat: "written", correctAnswer: "A", topic: "Food", difficulty: "easy", country: `Land ${++seq}`, ...over }, `q${seq}`),
  status: over.status || "published", updatedAt: 1,
});
const bank = (...filled) => [...filled, ...Array.from({ length: TOTAL_STOPS - filled.length }, (_, i) => emptyQuestion(`e${i}`))];
const clues = (n = 3) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, prompt: `Clue ${i}`, answer: `Ans ${i}` }));
const makeCtx = (over = {}) => {
  let n = 0;
  return { now: 1000, questions: bank(q(), q(), q()), settings: defaultSettings(), rescue: normalizeRescue({ clues: clues() }, () => "x"), random: () => 0, id: () => `p${++n}`, ...over };
};
const run = (s, ctx, ...steps) => steps.reduce((acc, step) => reduce(acc, typeof step === "string" ? { type: step } : { type: step[0], payload: step[1] }, ctx), s);
const roster = (ctx, ...names) => run(newSession(), ctx, ["addContestants", { names }]);
const toBoards = (s, ctx) => run(s, ctx, "fly", "arrive", "showQuestion", "startTimer", "timeUp");
const knockOutAll = (s, ctx) => {
  s = run(toBoards(s, ctx), ctx, "revealAnswer", "startReview");
  return run(s, ctx, ["setWrong", { ids: active(s).map((c) => c.id) }], "confirmEliminations");
};

test("an empty bank loads, and flying into an unconfigured slot is refused", () => {
  const ctx = makeCtx({ questions: bank() });
  const s = roster(ctx, "Ana");
  assert.equal(nextFixed(s, ctx.questions).question, null);
  assert.throws(() => run(s, ctx, "fly"), /not configured/);
});

test("a draft slot blocks the flight until it is published", () => {
  const ctx = makeCtx({ questions: bank(q({ status: "draft" })) });
  assert.throws(() => run(roster(ctx, "Ana"), ctx, "fly"), /still a draft/);
});

test("the four host steps are separate: no step performs the next one", () => {
  const ctx = makeCtx();
  let s = run(roster(ctx, "Ana", "Ben"), ctx, "fly");
  assert.equal(s.phase, "FLIGHT_ANIMATING");
  assert.equal(s.shown, null);
  s = run(s, ctx, "arrive");
  assert.equal(s.phase, "DESTINATION_ARRIVED");
  assert.equal(s.shown, null, "landing must not show the question");
  assert.equal(s.timer, null);
  s = run(s, ctx, "showQuestion");
  assert.equal(s.phase, "QUESTION_VISIBLE");
  assert.equal(s.timer, null, "showing the question must not start the timer");
  s = run(s, ctx, "startTimer");
  assert.equal(s.phase, "TIMER_RUNNING");
  assert.equal(s.timer.deadline, 1000 + 10_000, "default countdown is 10 seconds");
  s = run(s, ctx, "timeUp");
  assert.equal(s.phase, "BOARDS_UP", "time running out raises boards, it does not reveal the answer");
  s = run(s, ctx, "revealAnswer");
  assert.equal(s.phase, "ANSWER_REVEALED");
});

test("skipping the flight lands on the waiting card, never on the question", () => {
  const ctx = makeCtx();
  const s = run(roster(ctx, "Ana"), ctx, "fly", "skipFlight");
  assert.equal(s.phase, "DESTINATION_ARRIVED");
  assert.equal(s.shown, null);
});

test("steps cannot be taken out of order", () => {
  const ctx = makeCtx();
  const flying = run(roster(ctx, "Ana"), ctx, "fly");
  for (const bad of ["showQuestion", "startTimer", "revealAnswer"]) assert.throws(() => run(flying, ctx, bad), ShowError);
  const arrived = run(flying, ctx, "arrive");
  for (const bad of ["startTimer", "revealAnswer", "fly"]) assert.throws(() => run(arrived, ctx, bad), ShowError);
  const visible = run(arrived, ctx, "showQuestion");
  for (const bad of ["revealAnswer", "fly", "showQuestion"]) assert.throws(() => run(visible, ctx, bad), ShowError);
});

test("the clock only lands the plane, raises boards, or ends the rescue clock", () => {
  const ctx = makeCtx();
  let s = run(roster(ctx, "Ana"), ctx, "fly");
  assert.equal(due(s, 1000 + 7999), null);
  assert.deepEqual(due(s, 1000 + 8000), { type: "arrive" });
  s = run(s, ctx, "arrive");
  assert.equal(due(s, 9e9), null, "waiting at a destination never times out");
  s = run(s, ctx, "showQuestion");
  assert.equal(due(s, 9e9), null, "a visible question never starts its own timer");
  s = run(s, ctx, "startTimer");
  assert.deepEqual(due(s, 11_000), { type: "timeUp" });
  s = run(s, ctx, "timeUp");
  assert.equal(due(s, 9e9), null, "boards up never reveals the answer by itself");
});

test("pausing keeps the remaining time; resuming sets a new deadline", () => {
  const ctx = makeCtx();
  let s = run(roster(ctx, "Ana"), ctx, "fly", "arrive", "showQuestion", "startTimer");
  s = reduce(s, { type: "pauseTimer" }, { ...ctx, now: 4000 });
  assert.equal(s.timer.remainingMs, 7000);
  assert.equal(due(s, 9e9), null);
  s = reduce(s, { type: "resumeTimer" }, { ...ctx, now: 20_000 });
  assert.equal(s.timer.deadline, 27_000);
});

test("a question's own countdown overrides the default", () => {
  const ctx = makeCtx({ questions: bank(q({ countdown: 25 })) });
  const s = run(roster(ctx, "Ana"), ctx, "fly", "arrive", "showQuestion", "startTimer");
  assert.equal(s.timer.durationMs, 25_000);
});

test("editing during the show does not change the projector until the host updates it", () => {
  const ctx = makeCtx();
  let s = run(roster(ctx, "Ana"), ctx, "fly", "arrive", "showQuestion");
  const edited = ctx.questions.map((x, i) => (i === 0 ? { ...x, text: "Edited?", updatedAt: 2 } : x));
  const ctx2 = { ...ctx, questions: edited };
  assert.equal(s.shown.question.text, "Q?");
  s = run(s, ctx2, "startTimer");
  assert.equal(s.shown.question.text, "Q?", "other actions leave the projector's copy alone");
  s = run(s, ctx2, "updateProjector");
  assert.equal(s.shown.question.text, "Edited?");
});

test("eliminating some contestants continues the journey", () => {
  const ctx = makeCtx();
  let s = run(toBoards(roster(ctx, "Ana", "Ben", "Cy"), ctx), ctx, "revealAnswer", "startReview");
  s = run(s, ctx, ["setWrong", { ids: [s.contestants[0].id] }], "confirmEliminations");
  assert.equal(s.phase, "READY_TO_FLY");
  assert.equal(active(s).length, 2);
  assert.equal(s.contestants[0].eliminatedAtStop, 1);
});

test("eliminating everyone enters ALL_ELIMINATED and waits for the host", () => {
  const ctx = makeCtx();
  const s = knockOutAll(roster(ctx, "Ana", "Ben"), ctx);
  assert.equal(s.phase, "ALL_ELIMINATED");
  assert.equal(s.rescue, null, "the rescue must not start by itself");
  assert.equal(s.stop, 1, "the plane must not advance by itself");
  assert.equal(due(s, 9e9), null);
  assert.throws(() => run(s, ctx, "fly"), ShowError);
});

test("there is no rescue while anyone is still in the game", () => {
  const ctx = makeCtx();
  const s = roster(ctx, "Ana");
  assert.throws(() => run(s, ctx, ["startRescue", { crewIds: [s.contestants[0].id] }]), ShowError);
});

test("rescue crew is one to three eliminated contestants", () => {
  const ctx = makeCtx();
  const s = knockOutAll(roster(ctx, "A", "B", "C", "D"), ctx);
  const ids = s.contestants.map((c) => c.id);
  assert.throws(() => run(s, ctx, ["startRescue", { crewIds: [] }]), /one, two or three/);
  assert.throws(() => run(s, ctx, ["startRescue", { crewIds: ids }]), /one, two or three/);
  assert.equal(run(s, ctx, ["startRescue", { crewIds: ids.slice(0, 3) }]).rescue.step, "INTRO");
});

const playRescue = (s, ctx, results) => {
  s = run(s, ctx, ["startRescue", { crewIds: [s.contestants[0].id] }], "rescueShowMap");
  results.forEach((r, i) => {
    s = run(s, ctx, "rescueRevealClue", ["rescueMark", { result: r }]);
    if (i < 2) s = run(s, ctx, "rescueNextClue");
  });
  return run(s, ctx, "rescueRevealResult");
};

test("three correct returns everyone, and the journey skips the question that caused the wipe-out", () => {
  const ctx = makeCtx();
  let s = playRescue(knockOutAll(roster(ctx, "A", "B", "C", "D", "E"), ctx), ctx, ["correct", "correct", "correct"]);
  assert.equal(rescueOutcome(s, ctx.rescue).returnCount, 5);
  s = run(s, ctx, ["rescueApply", {}]);
  assert.equal(s.phase, "READY_TO_FLY");
  assert.equal(active(s).length, 5);
  const firstQuestion = s.played[0].questionId;
  s = run(s, ctx, "fly");
  assert.equal(s.stop, 2);
  assert.notEqual(s.currentQuestionId, firstQuestion);
});

test("two correct returns half, rounded up; one correct returns up to three", () => {
  const ctx = makeCtx();
  const out5 = knockOutAll(roster(ctx, "A", "B", "C", "D", "E"), ctx);
  assert.equal(rescueOutcome(playRescue(out5, ctx, ["correct", "wrong", "correct"]), ctx.rescue).returnCount, 3);
  assert.equal(rescueOutcome(playRescue(out5, ctx, ["wrong", "skipped", "correct"]), ctx.rescue).returnCount, 3);
  const out2 = knockOutAll(roster(makeCtx(), "A", "B"), ctx);
  assert.equal(rescueOutcome(playRescue(out2, ctx, ["correct", "wrong", "wrong"]), ctx.rescue).returnCount, 2);
  assert.equal(rescueReturnCount({ type: "half" }, 7), 4);
});

test("partial rescue: manual picks are limited to the eliminated and to the allowed number; random never exceeds it", () => {
  const ctx = makeCtx();
  const s = playRescue(knockOutAll(roster(ctx, "A", "B", "C", "D", "E", "F"), ctx), ctx, ["correct", "correct", "wrong"]); // half of 6 = 3
  const ids = s.contestants.map((c) => c.id);
  assert.throws(() => run(s, ctx, ["rescueApply", { mode: "manual", ids: ids.slice(0, 4) }]), /at most 3/);
  assert.throws(() => run(s, ctx, ["rescueApply", { mode: "manual", ids: ["nobody"] }]), /Only eliminated/);
  const manual = run(s, ctx, ["rescueApply", { mode: "manual", ids: ids.slice(0, 2) }]);
  assert.deepEqual(active(manual).map((c) => c.id), ids.slice(0, 2));
  const random = run(s, ctx, ["rescueApply", { mode: "random" }]);
  assert.equal(active(random).length, 3);
});

test("zero correct returns nobody; the host can retry or use the emergency rule, so the show is never stuck", () => {
  const ctx = makeCtx({ rescue: normalizeRescue({ clues: clues(6) }, () => "x") });
  const s = playRescue(knockOutAll(roster(ctx, "A", "B"), ctx), ctx, ["wrong", "wrong", "skipped"]);
  assert.equal(rescueOutcome(s, ctx.rescue).returnCount, 0);
  assert.throws(() => run(s, ctx, ["rescueApply", {}]), /returns nobody/);
  const retry = run(s, ctx, "rescueRetry");
  assert.equal(retry.rescue.step, "INTRO");
  assert.equal(retry.rescue.attempt, 2);
  assert.notDeepEqual(retry.rescue.clues.map((c) => c.id), s.rescue.clues.map((c) => c.id), "a retry uses fresh clues when there are any");
  const rule = run(s, ctx, "emergencyRule");
  assert.equal(rule.phase, "READY_TO_FLY");
  assert.equal(active(rule).length, 2);
});

test("a host-authorised emergency return works straight from ALL_ELIMINATED, even with no rescue clues", () => {
  const ctx = makeCtx({ rescue: defaultRescue() });
  const s = knockOutAll(roster(ctx, "A", "B"), ctx);
  assert.throws(() => run(s, ctx, ["startRescue", { crewIds: [s.contestants[0].id] }]), /three ready clues/);
  const back = run(s, ctx, ["emergencyReturn", { ids: [s.contestants[1].id] }]);
  assert.equal(back.phase, "READY_TO_FLY");
  assert.deepEqual(active(back).map((c) => c.name), ["B"]);
});

test("the rescue clock is host-started, pausable, and times out into TIME_UP without applying anything", () => {
  const ctx = makeCtx();
  let s = run(knockOutAll(roster(ctx, "A"), ctx), ctx, ["startRescue", { crewIds: ["p1"] }], "rescueShowMap", "rescueRevealClue");
  assert.equal(s.rescue.clock.running, false, "revealing a clue does not start the clock");
  s = run(s, ctx, ["rescueClock", { op: "start" }]);
  assert.equal(s.rescue.clock.deadline, 1000 + 90_000);
  s = reduce(s, { type: "rescueClock", payload: { op: "pause" } }, { ...ctx, now: 31_000 });
  assert.equal(s.rescue.clock.remainingMs, 60_000);
  s = reduce(s, { type: "rescueClock", payload: { op: "start" } }, { ...ctx, now: 50_000 });
  assert.deepEqual(due(s, 110_000), { type: "rescueTimeUp" });
  s = run(s, ctx, "rescueTimeUp");
  assert.equal(s.rescue.step, "TIME_UP");
  assert.equal(eliminated(s).length, 1, "nobody returns until the host applies a result");
  s = run(s, ctx, ["rescueOverride", { idx: 0, result: "correct" }], "rescueRevealResult");
  assert.equal(rescueOutcome(s, ctx.rescue).correct, 1);
});

test("changed thresholds are honoured", () => {
  const rescue = normalizeRescue({ clues: clues(), rules: { 3: { type: "all" }, 2: { type: "upTo", n: 1 }, 1: { type: "none" }, 0: { type: "none" } } }, () => "x");
  const ctx = makeCtx({ rescue });
  const s = playRescue(knockOutAll(roster(ctx, "A", "B", "C"), ctx), ctx, ["correct", "correct", "wrong"]);
  assert.equal(rescueOutcome(s, rescue).returnCount, 1);
});

test("topic choice draws an unused published question of the stop's difficulty, and explains why a topic is closed", () => {
  const questions = bank(
    q({ topic: "Food", difficulty: "easy" }), q({ topic: "Music", difficulty: "hard" }),
    q({ topic: "Sports", difficulty: "easy", status: "draft" }), q({ topic: "Food", difficulty: "easy" }),
  );
  const ctx = makeCtx({ questions });
  let s = roster(ctx, "Ana");
  const opts = Object.fromEntries(topicOptions(s, questions, ctx.settings).map((t) => [t.topic, t]));
  assert.equal(opts.Food.available, true);
  assert.match(opts.Music.reason, /calls for easy/);
  assert.match(opts.Sports.reason, /drafts/);
  assert.throws(() => run(s, ctx, ["fly", { topic: "Music" }]), /calls for easy/);
  s = run(s, ctx, ["fly", { topic: "Food" }]);
  assert.equal(s.currentQuestionId, questions[0].id);
  assert.equal(s.phase, "FLIGHT_ANIMATING", "a topic pick still only flies");
  s = run(s, ctx, "arrive");
  assert.equal(s.shown, null, "the host must still press Show question");
});

test("one country per main question", () => {
  const a = q({ country: "Peru" }), b = q({ country: " peru " });
  assert.match(publishErrors(b, [a, b]).join(" "), /already the country for question 1/);
  assert.deepEqual(publishErrors(a, [a]), []);
});

test("media and choice rules for publishing", () => {
  const img = normalizeQuestion({ text: "Which?", presentation: "image", answerFormat: "choice", choices: ["a", "b", "c", "d"], correctChoice: 2 }, "m1");
  assert.match(publishErrors(img).join(" "), /Add the image/);
  const dup = normalizeQuestion({ text: "Which?", answerFormat: "choice", choices: ["a", "a", "c", "d"], correctChoice: 0 }, "m2");
  assert.match(publishErrors(dup).join(" "), /the same/);
});

test("media controls never touch the timer or the phase", () => {
  const video = q({ presentation: "video", media: { src: "/media/live/x.mp4", mime: "video/mp4" } });
  const ctx = makeCtx({ questions: bank(video) });
  let s = run(roster(ctx, "Ana"), ctx, "fly", "arrive", "showQuestion", ["media", { op: "play" }]);
  assert.equal(s.phase, "QUESTION_VISIBLE");
  assert.equal(s.timer, null);
  s = run(s, ctx, ["media", { op: "ended" }]);
  assert.equal(s.phase, "QUESTION_VISIBLE", "a clip ending does not start the countdown");
  assert.equal(s.timer, null);
  assert.ok(QUESTION_PHASES.includes(s.phase));
});

test("the journey ends at stop 30", () => {
  const all = Array.from({ length: TOTAL_STOPS }, () => q());
  const ctx = makeCtx({ questions: all });
  let s = roster(ctx, "Ana");
  for (let i = 0; i < TOTAL_STOPS; i++) s = run(toBoards(s, ctx), ctx, "revealAnswer", "startReview", "confirmEliminations");
  assert.equal(s.stop, 30);
  assert.throws(() => run(s, ctx, "fly"), /final destination/);
  assert.equal(run(s, ctx, "finishShow").phase, "FINISHED");
});
