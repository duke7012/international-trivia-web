// The show itself, independent of where it runs: applies host actions to the saved state, builds
// what each screen may see, and lets the clock do its few permitted things.
// The Node server and the Cloudflare Durable Object both wrap this same object.
import { projectorView, hostView } from "./views.mjs";
import { WORKSPACES, newId } from "./bank.mjs";
import { reduce, due, ShowError, ACTIONS, PREVIEW_SAFE_PHASES, idleMedia, mediaReduce } from "../shared/engine.mjs";
import { TOTAL_STOPS, MAX_QUESTIONS, emptyQuestion, normalizeQuestion, isBlank, publishErrors, normalizeSettings, normalizeRescue, normalizeSounds } from "../shared/schema.mjs";

const ROSTER_ONLY = ["addContestants", "renameContestant", "removeContestant", "setContestantStatus"];
const fail = (msg) => { throw new ShowError(msg); };

// store: { app, spaces, current, saveApp(), save(ws, part), resetDemo(), sweepMedia(ws, extraRefs) }
// screens(): { connected, soundOn } for the projectors currently connected
// extras: fixed facts for the dashboard, e.g. { signInRequired, upload: { chunkBytes } }
export function createShow({ store, screens, extras = {}, now = () => Date.now(), random = Math.random }) {
  let preview = null; // a rehearsal overlay on the projector; never part of the saved show

  const ctxFor = (ws) => ({ now: now(), questions: ws.questions, settings: ws.settings, rescue: ws.rescue, sounds: store.app.sounds || {}, random, id: newId });
  function applyShowAction(type, payload) {
    const ws = store.current;
    const next = reduce(ws.session, { type, payload }, ctxFor(ws));
    if (next !== ws.session) { ws.session = next; store.save(ws, "session"); }
  }
  const onStage = (ws, id) => ws.session.currentQuestionId === id && !["LOBBY", "READY_TO_FLY", "ALL_ELIMINATED", "RESCUE", "FINISHED"].includes(ws.session.phase);
  const slotOf = (ws, id) => { const i = ws.questions.findIndex((q) => q.id === id); return i < 0 ? fail("That question slot no longer exists.") : i; };
  const needPreviewSafe = (ws) => {
    if (!PREVIEW_SAFE_PHASES.includes(ws.session.phase)) fail("The projector is showing the live show right now. Previews on the projector are available between questions; the preview inside the editor always works.");
  };

  const manage = {
    "bank.save"(ws, { id, question, status }) {
      const i = slotOf(ws, id);
      const q = normalizeQuestion(question || {}, id);
      if (status === "published") {
        const errors = publishErrors(q, ws.questions);
        if (errors.length) throw Object.assign(new ShowError(errors[0]), { errors });
        q.status = "published";
      } else q.status = isBlank(q) ? "empty" : "draft";
      if (q.status !== "published" && onStage(ws, id)) fail("This question is on stage right now, so it has to stay published. Publish your changes instead.");
      q.updatedAt = now();
      ws.questions[i] = q;
      store.save(ws, "questions");
      return { question: q };
    },
    "bank.add"(ws) {
      if (ws.questions.length >= MAX_QUESTIONS) fail(`The bank holds at most ${MAX_QUESTIONS} questions.`);
      ws.questions.push(emptyQuestion(newId()));
      store.save(ws, "questions");
      return { id: ws.questions.at(-1).id, slot: ws.questions.length };
    },
    "bank.clear"(ws, { id }) {
      const i = slotOf(ws, id);
      if (onStage(ws, id)) fail("This question is on stage right now and cannot be deleted.");
      // A journey slot (1 to 30) goes back to "Not configured"; an extra slot is removed.
      if (i < TOTAL_STOPS) ws.questions[i] = emptyQuestion(newId());
      else ws.questions.splice(i, 1);
      store.save(ws, "questions");
    },
    "bank.duplicate"(ws, { id }) {
      const src = ws.questions[slotOf(ws, id)];
      let to = ws.questions.findIndex((q) => q.status === "empty");
      if (to < 0) {
        if (ws.questions.length >= MAX_QUESTIONS) fail(`The bank holds at most ${MAX_QUESTIONS} questions. Delete one to make room for a copy.`);
        to = ws.questions.push(emptyQuestion(newId())) - 1;
      }
      ws.questions[to] = { ...structuredClone(src), id: newId(), status: "draft", updatedAt: now() };
      store.save(ws, "questions");
      return { id: ws.questions[to].id, slot: to + 1 };
    },
    "bank.move"(ws, { id, to }) {
      const from = slotOf(ws, id);
      const dest = Math.max(0, Math.min(ws.questions.length - 1, Number(to) | 0));
      const [q] = ws.questions.splice(from, 1);
      ws.questions.splice(dest, 0, q);
      store.save(ws, "questions");
    },
    "rescue.save"(ws, { rescue }) { ws.rescue = normalizeRescue(rescue); store.save(ws, "rescue"); },
    // The host's own sound files, shared by the live show and the demo set.
    "sounds.save"(_, { sounds }) { store.app.sounds = normalizeSounds(sounds); store.saveApp(); store.sweepSounds(store.app.sounds); },
    "settings.save"(ws, { settings }) { ws.settings = normalizeSettings({ ...ws.settings, ...settings }); store.save(ws, "settings"); },
    "workspace.set"(_, { name }) {
      if (!WORKSPACES.includes(name)) fail("Unknown workspace.");
      store.app.workspace = name; store.saveApp(); preview = null;
    },
    "demo.reset"() {
      if (store.app.workspace !== "demo") fail("Switch to the demo set first.");
      preview = null; store.resetDemo();
    },
    // ----- previews: shown on the projector with a PREVIEW banner, never changing the show -----
    "preview.question"(ws, { id, question, showAnswer }) {
      needPreviewSafe(ws);
      const i = id ? ws.questions.findIndex((q) => q.id === id) : -1;
      const q = question ? normalizeQuestion(question, id || "preview") : ws.questions[i];
      if (!q || isBlank(q)) fail("There is nothing to preview in this slot yet.");
      preview = { kind: "question", number: i >= 0 ? i + 1 : null, question: q, showAnswer: !!showAnswer, media: idleMedia() };
    },
    "preview.flight"(ws, { tour }) {
      needPreviewSafe(ws);
      const from = tour ? 0 : Math.min(ws.session.stop, TOTAL_STOPS - 1);
      const to = tour ? TOTAL_STOPS : from + 1;
      preview = { kind: "flight", from, to, startedAt: now(), durationMs: Math.round((tour ? 60 : ws.settings.flightSeconds) * 1000) };
    },
    "preview.media"(_, { op, value }) {
      if (preview?.kind !== "question") fail("No question preview is running.");
      preview = { ...preview, media: mediaReduce(preview.media, op, now(), value) };
    },
    "preview.stop"() { preview = null; },
  };

  return {
    // Every host action comes through here. Throws ShowError with a message the host can read.
    act(type, payload = {}) {
      let result;
      if (manage[type]) result = manage[type](store.current, payload) || {};
      else if (ACTIONS.includes(type)) {
        if (preview && !ROSTER_ONLY.includes(type)) fail("A preview is on the projector. End the preview first.");
        applyShowAction(type, payload);
        result = {};
      } else fail(`Unknown action "${type}".`);
      if (type.startsWith("bank.") || type === "rescue.save" || type === "demo.reset") store.sweepMedia(store.current, preview?.question?.media ? [preview.question.media.src.split("/").pop()] : []);
      return result;
    },

    // The clock's only powers: land the plane, raise the boards, and end a rescue round.
    // Returns true when something changed.
    tick() {
      const a = due(store.current.session, now());
      if (!a) return false;
      applyShowAction(a.type, {});
      return true;
    },
    // When the clock next has something to do, or null.
    nextDeadline() {
      const s = store.current.session;
      if (s.phase === "FLIGHT_ANIMATING" && s.flight) return s.flight.startedAt + s.flight.durationMs;
      if (s.phase === "TIMER_RUNNING" && s.timer.running) return s.timer.deadline;
      const g = s.phase === "RESCUE" && s.rescue?.game;
      if (g && g.status === "playing" && g.deadline) return g.deadline;
      return null;
    },

    // The projector may report exactly one thing about the show: that a clip finished playing.
    mediaEnded(n) {
      try {
        if (preview?.kind === "question") {
          if (preview.media.n !== n) return false;
          preview = { ...preview, media: mediaReduce(preview.media, "ended", now()) };
          return true;
        }
        if (store.current.session.media.n !== n) return false;
        applyShowAction("media", { op: "ended" });
        return true;
      } catch { return false; /* the show moved on; nothing to do */ }
    },

    viewFor(role) {
      const ws = store.current;
      if (role === "projector") return projectorView(ws, preview, now(), store.app.sounds || {});
      return hostView(ws, { sounds: store.app.sounds || {}, projector: screens(), preview: preview && { kind: preview.kind, number: preview.number, media: preview.media, presentation: preview.question?.presentation }, ...extras }, now());
    },
  };
}
