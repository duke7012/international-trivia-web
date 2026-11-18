// Rules of the show, tested without a browser or a server.  Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { reduce, newSession, due, ShowError, active, eliminated, nextFixed, topicOptions, QUESTION_PHASES } from "../shared/engine.mjs";
import { emptyQuestion, normalizeQuestion, publishErrors, defaultSettings, defaultRescue, normalizeRescue, ruleLines, rescuePct, rescueCount, rescueLadder, TOTAL_STOPS } from "../shared/schema.mjs";
import { DOODLES } from "../shared/rescue-bank.mjs";

let seq = 0;
const q = (over = {}) => ({
  ...normalizeQuestion({ text: "Q?", answerFormat: "written", correctAnswer: "A", topic: "Food", difficulty: "easy", country: `Land ${++seq}`, ...over }, `q${seq}`),
  status: over.status || "published", updatedAt: 1,
});
const bank = (...filled) => [...filled, ...Array.from({ length: TOTAL_STOPS - filled.length }, (_, i) => emptyQuestion(`e${i}`))];
const makeCtx = (over = {}) => {
  let n = 0;
  return { now: 1000, questions: bank(q(), q(), q()), settings: defaultSettings(), rescue: defaultRescue(), random: () => 0, id: () => `p${++n}`, ...over };
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

test("the clock only lands the plane or raises boards", () => {
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

test("there is no rescue game while anyone is still in the game", () => {
  const ctx = makeCtx();
  assert.throws(() => run(roster(ctx, "Ana"), ctx, "startRescue"), ShowError);
});

test("the rescue game is started by the host and never ends by itself", () => {
  const ctx = makeCtx();
  const s = run(knockOutAll(roster(ctx, "A", "B", "C"), ctx), ctx, "startRescue");
  assert.equal(s.phase, "RESCUE");
  assert.deepEqual(s.rescue, { attempt: 1, game: null });
  assert.equal(due(s, 9e9), null, "nothing runs until the host picks and starts a game");
  assert.equal(eliminated(s).length, 3, "nobody returns until the host picks the winners");
  assert.throws(() => run(s, ctx, "fly"), ShowError);
  assert.throws(() => run(s, ctx, "rescueGo"), /Choose a rescue game/);
});

// Plays a whole beat game: one ok/miss per level.
const playBeat = (s, ctx, marks) => {
  s = run(s, ctx, ["rescuePick", { kind: "beat" }]);
  for (const ok of marks) s = run(s, ctx, "rescueGo", ["rescueMark", { ok }], "rescueNext");
  return s;
};

test("the team's score sets how many may return: 2 of 5 levels is 20%, the threshold brings everyone back", () => {
  const cfg = defaultRescue();
  assert.equal(rescuePct("beat", 2, cfg), 20);
  assert.equal(rescuePct("beat", 4, cfg), 100);
  assert.equal(rescuePct("tower", 0, cfg), 0);
  assert.equal(rescuePct("semantle", 899, cfg), 0);
  assert.equal(rescuePct("semantle", 950, cfg), 20);
  assert.equal(rescuePct("semantle", 995, cfg), 50);
  assert.equal(rescuePct("semantle", 1000, cfg), 100);
  assert.equal(rescueCount(20, 5), 1);
  assert.equal(rescueCount(10, 3), 1, "anything won brings back at least one");
  assert.equal(rescueCount(0, 5), 0);
  assert.equal(rescueCount(100, 5), 5);

  const ctx = makeCtx();
  let s = playBeat(run(knockOutAll(roster(ctx, "A", "B", "C", "D", "E"), ctx), ctx, "startRescue"), ctx, [true, false, true, false, false]);
  assert.equal(s.rescue.game.status, "done");
  const ids = s.contestants.map((c) => c.id);
  assert.throws(() => run(s, ctx, ["rescueApply", { ids: ids.slice(0, 2) }]), /earned 1 place/);
  assert.throws(() => run(s, ctx, ["rescueApply", { ids: ["nobody"] }]), /Only eliminated/);
  s = run(s, ctx, ["rescueApply", { ids: [ids[3]] }]);
  assert.equal(s.phase, "READY_TO_FLY");
  assert.deepEqual(active(s).map((c) => c.name), ["D"]);
  assert.equal(s.lastRescue.via, "rescue");
  const firstQuestion = s.played[0].questionId;
  s = run(s, ctx, "fly");
  assert.equal(s.stop, 2, "the journey skips the question that caused the wipe-out");
  assert.notEqual(s.currentQuestionId, firstQuestion);
});

test("nobody can return before the game is over, or when the team scored nothing", () => {
  const ctx = makeCtx();
  let s = run(knockOutAll(roster(ctx, "A", "B"), ctx), ctx, "startRescue", ["rescuePick", { kind: "tower" }], "rescueGo");
  const ids = s.contestants.map((c) => c.id);
  assert.throws(() => run(s, ctx, ["rescueApply", { ids }]), /Finish the game/);
  assert.throws(() => run(s, ctx, ["rescueScore", { score: -1 }]), ShowError);
  const zero = run(s, ctx, ["rescueScore", { score: 0 }]);
  assert.throws(() => run(zero, ctx, ["rescueApply", { ids }]), /did not score enough/);
  s = run(s, ctx, ["rescueScore", { score: 7 }]);
  assert.equal(run(s, ctx, ["rescueApply", { ids }]).phase, "READY_TO_FLY", "7 tower levels bring everyone back");
});

test("a doodle nobody guesses in time is skipped as a miss; timed games stop and wait for the score", () => {
  const ctx = makeCtx();
  let s = run(knockOutAll(roster(ctx, "A", "B"), ctx), ctx, "startRescue", ["rescuePick", { kind: "doodle" }]);
  assert.equal(s.rescue.game.items.length, 10);
  assert.deepEqual(s.rescue.game.items.slice(0, 4).map((c) => DOODLES.find((d) => d.iso3 === c.iso3).level), ["easy", "easy", "easy", "easy"]);
  s = run(s, ctx, "rescueGo");
  const end = s.rescue.game.deadline;
  assert.equal(end, ctx.now + 18000, "8 s of drawing and 10 s to guess");
  assert.equal(due(s, end - 1), null);
  assert.deepEqual(due(s, end), { type: "rescueTimeout" });
  s = run(s, ctx, "rescueTimeout");
  assert.deepEqual(s.rescue.game.results, [false]);
  assert.equal(s.rescue.game.status, "marked");
  assert.equal(due(s, 9e9), null);

  let t = run(knockOutAll(roster(ctx, "A"), ctx), ctx, "startRescue", ["rescuePick", { kind: "semantle" }], "rescueGo");
  assert.equal(t.rescue.game.items.puzzle, 1700);
  assert.equal(t.rescue.game.deadline, ctx.now + 5 * 60000);
  t = run(t, ctx, "rescueTimeout");
  assert.equal(t.rescue.game.status, "timeUp");
  assert.equal(run(t, ctx, ["rescueScore", { score: 1000 }]).rescue.game.status, "done");
});

test("a second rescue round plays fresh flags, countries and puzzles", () => {
  const ctx = makeCtx();
  const out = knockOutAll(roster(ctx, "A"), ctx);
  const first = run(out, ctx, "startRescue", ["rescuePick", { kind: "doodle" }], "rescueGo", "rescueAbort");
  const second = run(first, ctx, "startRescue", ["rescuePick", { kind: "doodle" }]);
  const a = new Set(first.rescueUsed.doodle);
  assert.equal(a.size, 10);
  assert.ok(second.rescue.game.items.every((c) => !a.has(c.iso3)), "no country repeats");
  const b1 = run(second, ctx, "rescueAbort", "startRescue", ["rescuePick", { kind: "beat" }], "rescueGo", "rescueAbort");
  const b2 = run(b1, ctx, "startRescue", ["rescuePick", { kind: "beat" }]);
  assert.notEqual(b2.rescue.game.items.set, b1.rescueUsed.beat[0]);
  assert.equal(b2.rescue.game.items.levels.length, 5);
  assert.ok(b2.rescue.game.items.levels[4].every((f) => f.hidden), "the last level shows no names");
  // A game only counts as used once it starts: picking and swapping spends nothing.
  const swap = run(out, ctx, "startRescue", ["rescuePick", { kind: "semantle" }], ["rescuePick", { kind: "beat" }]);
  assert.deepEqual(swap.rescueUsed, { beat: [], doodle: [], semantle: [] });
});

test("leaving the rescue game goes back to the emergency screen; a second game counts as round 2", () => {
  const ctx = makeCtx();
  const s = run(knockOutAll(roster(ctx, "A", "B"), ctx), ctx, "startRescue", "rescueAbort");
  assert.equal(s.phase, "ALL_ELIMINATED");
  assert.equal(s.rescue, null);
  assert.equal(run(s, ctx, "startRescue").rescue.attempt, 2);
});

test("emergency exits work from the emergency screen and during the rescue game, so the show is never stuck", () => {
  const ctx = makeCtx();
  const out = knockOutAll(roster(ctx, "A", "B"), ctx);
  const back = run(out, ctx, ["emergencyReturn", { ids: [out.contestants[1].id] }]);
  assert.equal(back.phase, "READY_TO_FLY");
  assert.deepEqual(active(back).map((c) => c.name), ["B"]);
  const rule = run(out, ctx, "startRescue", "emergencyRule");
  assert.equal(rule.phase, "READY_TO_FLY");
  assert.equal(active(rule).length, 2);
});

test("rescue settings: older rule-list saves fall back to the defaults; Semantle numbers are cleaned up", () => {
  assert.deepEqual(ruleLines("  Run to the wall \n\n Touch it\n"), ["Run to the wall", "Touch it"]);
  const old = normalizeRescue({ title: "Paper planes", rules: "Hop", emergencyRule: "returnAll" });
  assert.deepEqual(old, { ...defaultRescue(), emergencyRule: "returnAll" });
  const r = normalizeRescue({ semantle: { puzzles: "1700,  1650 x 1700, 0" }, beat: { rate: "25", allAt: 9 } });
  assert.equal(r.semantle.puzzles, "1700, 1650");
  assert.equal(r.beat.rate, 25);
  assert.equal(r.beat.allAt, 5, "beat has only five levels");
  assert.deepEqual(rescueLadder("beat", defaultRescue()), ["1 level → 10% back", "2 levels → 20% back", "3 levels → 30% back", "4 levels → everyone back"]);
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

test("questions past slot 30 are an extra pool: a topic pick can draw them, Next in order never reaches them", () => {
  // slots 1 to 30 are all published Geography; slot 31 is the only Food question
  const journey = Array.from({ length: TOTAL_STOPS }, () => q({ topic: "Geography", difficulty: "easy" }));
  const extra = q({ topic: "Food", difficulty: "easy" });
  const questions = [...journey, extra];
  const ctx = makeCtx({ questions });
  let s = roster(ctx, "Ana");
  assert.deepEqual(topicOptions(s, questions, ctx.settings).find((t) => t.topic === "Food").next, { id: extra.id, slot: 31 });
  s = run(s, ctx, ["fly", { topic: "Food" }]);
  assert.equal(s.currentQuestionId, extra.id, "the topic pick draws slot 31");
  // with every journey slot but the last already played, Next in order still lands inside 1 to 30
  const nearlyDone = { ...roster(ctx, "Ana"), stop: TOTAL_STOPS - 1, played: journey.slice(0, TOTAL_STOPS - 1).map((x) => ({ questionId: x.id })) };
  assert.equal(nextFixed(nearlyDone, questions).slot, TOTAL_STOPS);
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
  s = run(s, ctx, ["media", { op: "play" }], ["media", { op: "stop" }]);
  assert.equal(s.media.status, "ended", "stopping counts as done watching");
  assert.equal(s.timer, null);
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

// ---------- the host's own show sounds ----------
import { timerRemaining } from "../shared/engine.mjs";
import { planAudio, answerShowing } from "../shared/cues.mjs";
import { cueForFile, normalizeSounds, SOUND_CUES } from "../shared/schema.mjs";

const snd = (ms = 5000) => ({ src: "/media/sounds/x.mp3", name: "x.mp3", durationMs: ms });

test("the user's file names are matched to the right moments", () => {
  const files = {
    "goldenbell_game_fast_forward_long.mp3": "flight",
    "goldenbell_game_question_show_loop.mp3": "questionLoop",
    "goldenbell_game_think_start.mp3": "thinkStart",
    "goldenbell_game_think_clock_extended.mp3": "thinkClock",
    "goldenbell_game_think_drums_extended.mp3": "thinkDrums",
    "goldenbell_game_think_over.mp3": "thinkOver",
    "goldenbell_game_correct_answer_reveal.mp3": "revealLead",
    "goldenbell_game_correct_answer.mp3": "correct",
    "goldenbell_game_congratulations.mp3": "congrats",
    "goldenbell_game_contestant_answer_reveal_loop.mp3": "boardsLoop",
    "goldenbell_game_contestant_elimination.mp3": "elimination",
    "rescue_game_music.mp3": "rescueGame",
    "finale_music.mp3": "finale",
  };
  for (const [name, id] of Object.entries(files)) assert.equal(cueForFile(name), id, name);
  assert.equal(new Set(Object.values(files)).size, SOUND_CUES.length, "every moment has a file");
  assert.equal(cueForFile("holiday_photo.mp3"), null);
  assert.deepEqual(normalizeSounds({ flight: { src: "https://elsewhere/x.mp3" }, nonsense: snd() }), {}, "only files in the sounds area are accepted");
});

test("a timer lead-in delays the count, not the host's control: pause and resume keep both parts", () => {
  const ctx = makeCtx({ sounds: { thinkStart: snd(3000) } });
  let s = run(roster(ctx, "Ana"), ctx, "fly", "arrive", "showQuestion", "startTimer");
  assert.equal(s.phase, "TIMER_RUNNING");
  assert.equal(s.timer.deadline, 1000 + 3000 + 10_000);
  assert.equal(timerRemaining(s.timer, 2000), 10_000, "the count has not started during the lead-in");
  assert.equal(timerRemaining(s.timer, 6000), 8000);
  assert.equal(due(s, 13_999), null);
  assert.deepEqual(due(s, 14_000), { type: "timeUp" });
  const paused = reduce(s, { type: "pauseTimer" }, { ...ctx, now: 2000 });
  assert.equal(paused.timer.remainingMs, 10_000);
  assert.equal(paused.timer.leadLeftMs, 2000);
  assert.equal(reduce(paused, { type: "resumeTimer" }, { ...ctx, now: 50_000 }).timer.deadline, 62_000);
});

test("an answer lead-in delays when the answer shows; without one it shows at once", () => {
  const plain = run(toBoards(roster(makeCtx(), "Ana"), makeCtx()), makeCtx(), "revealAnswer");
  assert.equal(plain.answerAt, 1000);
  const ctx = makeCtx({ sounds: { revealLead: snd(4000) } });
  const s = run(toBoards(roster(ctx, "Ana"), ctx), ctx, "revealAnswer");
  assert.equal(s.phase, "ANSWER_REVEALED");
  assert.equal(s.answerAt, 5000);
  assert.equal(answerShowing({ answer: {}, answerAt: 5000 }, 4999), false);
  assert.equal(answerShowing({ answer: {}, answerAt: 5000 }, 5000), true);
  // a mistaken very long file cannot stall the show
  const long = makeCtx({ sounds: { revealLead: snd(999_000) } });
  assert.equal(run(toBoards(roster(long, "Ana"), long), long, "revealAnswer").answerAt, 1000 + 20_000);
});

test("which sound plays when", () => {
  const all = Object.fromEntries(SOUND_CUES.map((c) => [c.id, snd(c.id === "thinkStart" ? 3000 : c.id === "revealLead" ? 4000 : 5000)]));
  const v = (over) => ({ phase: "LOBBY", stop: 3, cues: all, ...over });
  const cueNames = (p) => p && p.steps.map((x) => x.cue);

  assert.equal(planAudio(v({}), 0), null, "silence before the show");
  assert.equal(planAudio(v({ phase: "DESTINATION_ARRIVED" }), 0), null, "silence while waiting at a destination");

  const flying = v({ phase: "FLIGHT_ANIMATING", flight: { startedAt: 1000, durationMs: 8000 } });
  assert.deepEqual(planAudio(flying, 2000).steps, [{ cue: "flight", at: 1000 }]);
  assert.equal(planAudio(flying, 9000), null, "the flight sound stops when the plane lands");

  const q = planAudio(v({ phase: "QUESTION_VISIBLE", media: { status: "idle" } }), 0);
  assert.deepEqual(q.steps, [{ cue: "questionLoop", loop: true }]);
  assert.equal(q.hold, false);
  assert.equal(planAudio(v({ phase: "QUESTION_VISIBLE", media: { status: "playing" } }), 0).hold, true, "pauses while the question's own clip plays");

  const timer = { running: true, startedAt: 1000, leadMs: 3000, durationMs: 10_000, deadline: 14_000 };
  assert.deepEqual(cueNames(planAudio(v({ phase: "TIMER_RUNNING", timer }), 2000)), ["thinkStart"], "lead-in first");
  const early = planAudio(v({ phase: "TIMER_RUNNING", timer }), 5000);
  assert.deepEqual(early.steps, [{ cue: "thinkClock", loop: true, at: 4000 }], "then the clock music for destinations 1 to 15");
  assert.deepEqual(cueNames(planAudio(v({ phase: "TIMER_RUNNING", timer, stop: 15 }), 5000)), ["thinkClock"]);
  assert.deepEqual(cueNames(planAudio(v({ phase: "TIMER_RUNNING", timer, stop: 16 }), 5000)), ["thinkDrums"], "drums from destination 16");
  assert.deepEqual(cueNames(planAudio(v({ phase: "TIMER_RUNNING", timer, stop: 30 }), 5000)), ["thinkDrums"]);
  assert.notEqual(planAudio(v({ phase: "TIMER_RUNNING", timer }), 2000).key, early.key, "lead-in and countdown are separate stretches");
  assert.equal(planAudio(v({ phase: "TIMER_RUNNING", timer: { ...timer, running: false, remainingMs: 6000, leadLeftMs: 0, deadline: null } }), 9000).hold, true, "pausing the timer pauses its music");

  assert.deepEqual(planAudio(v({ phase: "BOARDS_UP" }), 0).steps, [{ cue: "thinkOver", live: true }, { cue: "boardsLoop", loop: true }], "time-up sting, then the boards loop");

  const revealed = v({ phase: "ANSWER_REVEALED", answer: {}, answerAt: 5000 });
  assert.deepEqual(planAudio(revealed, 2000).steps, [{ cue: "revealLead", at: 1000 }], "lead-in before the answer shows");
  assert.deepEqual(cueNames(planAudio(revealed, 5000)), ["correct", "congrats"], "then correct answer, then congratulations");

  assert.deepEqual(planAudio(v({ phase: "ELIMINATION_REVIEW" }), 0).steps, [{ cue: "elimination", loop: true }]);
  assert.equal(planAudio(v({ phase: "READY_TO_FLY" }), 0), null);
  assert.equal(planAudio(v({ phase: "ALL_ELIMINATED" }), 0), null, "the emergency screen keeps its alarm");
  const rescue = planAudio(v({ phase: "RESCUE", rescue: { attempt: 1 } }), 0);
  assert.deepEqual(rescue.steps, [{ cue: "rescueGame", loop: true }], "music loops through the rescue game");
  assert.notEqual(planAudio(v({ phase: "RESCUE", rescue: { attempt: 2 } }), 0).key, rescue.key, "a second game starts the music again");
  assert.equal(planAudio(v({ phase: "RESCUE", rescue: { attempt: 1, kind: "beat", status: "playing" } }), 0), null, "the beat game's own beat plays alone");
  assert.ok(planAudio(v({ phase: "RESCUE", rescue: { attempt: 1, kind: "beat", status: "marked" } }), 0));
  assert.deepEqual(planAudio(v({ phase: "FINISHED" }), 0).steps, [{ cue: "finale", loop: true }], "music loops through the finale");

  // with only some files supplied, only those play
  assert.equal(planAudio({ phase: "BOARDS_UP", stop: 1, cues: {} }, 0), null);
  assert.deepEqual(cueNames(planAudio({ phase: "BOARDS_UP", stop: 1, cues: { boardsLoop: snd() } }, 0)), ["boardsLoop"]);
  // previews stay quiet apart from the flight preview
  assert.equal(planAudio(v({ phase: "LOBBY", preview: { kind: "question" } }), 0), null);
  assert.deepEqual(cueNames(planAudio(v({ phase: "LOBBY", preview: { kind: "flight", startedAt: 0, durationMs: 9000 } }), 100)), ["flight"]);
});

test("the rules screen steps before take-off and closes when the plane flies", () => {
  const ctx = makeCtx();
  let s = run(roster(ctx, "Ana"), ctx, "showRules");
  assert.deepEqual([s.rules.step, s.rules.from], [0, 0]);
  s = run(s, ctx, ["rulesStep", { step: 2 }]);
  assert.deepEqual([s.rules.step, s.rules.from], [2, 0], "remembers where it came from, for the camera move");
  s = run(s, ctx, ["rulesStep", { step: 99 }]);
  assert.equal(s.rules.step, 6, "clamped to the last of the 7 default rules");
  s = run(s, ctx, "fly");
  assert.equal(s.rules, null);
  assert.throws(() => run(s, ctx, "showRules"), ShowError, "only on the start screen");
});
