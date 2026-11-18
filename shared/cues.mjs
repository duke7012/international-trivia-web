// Which of the host's sound files should be playing right now, worked out from what the
// projector has been told. Pure, so the same rules run in the browser and in the tests.
//
// A plan is { key, steps, hold }:
//   key    names this stretch of the show; a new key means "stop the old sound, start this"
//   steps  sounds to play one after another: { cue, loop, at, live }
//            at    the moment the sound should have started (so a late or refreshed projector
//                  joins it at the right place)
//            live  a one-off sting with no fixed start time: played only if the projector
//                  saw the moment happen, never replayed after a refresh
//   hold   pause without losing the place (timer paused, or a question's own clip is playing)
import { LATE_STAGE_STOP } from "./schema.mjs";

export function planAudio(v, now) {
  if (!v) return null;
  const cues = v.cues || {};
  const has = (id) => !!cues[id];
  const plan = (key, steps, hold = false) => { const s = steps.filter((x) => x && has(x.cue)); return s.length ? { key, steps: s, hold } : null; };

  if (v.preview?.kind === "question") return null; // a preview only ever plays its own clip
  const flight = v.preview?.kind === "flight" ? v.preview : v.phase === "FLIGHT_ANIMATING" ? v.flight : null;
  if (flight) return now < flight.startedAt + flight.durationMs ? plan(`flight:${flight.startedAt}`, [{ cue: "flight", at: flight.startedAt }]) : null;
  if (v.preview) return null;

  switch (v.phase) {
    case "QUESTION_VISIBLE":
      return plan(`question:${v.stop}`, [{ cue: "questionLoop", loop: true }], v.media?.status === "playing");
    case "TIMER_RUNNING": {
      const t = v.timer;
      if (!t) return null;
      const bed = v.stop >= LATE_STAGE_STOP ? "thinkDrums" : "thinkClock";
      const leadLeft = t.running ? t.deadline - now - t.durationMs : t.leadLeftMs || 0;
      // The lead-in sting first; the countdown music takes over when the count begins.
      if (leadLeft > 0 && has("thinkStart")) return plan(`think-lead:${t.startedAt}`, [{ cue: "thinkStart", at: t.startedAt }], !t.running);
      return plan(`think:${t.startedAt}`, [{ cue: bed, loop: true, at: t.startedAt + (t.leadMs || 0) }], !t.running);
    }
    case "BOARDS_UP":
      return plan(`boards:${v.stop}`, [{ cue: "thinkOver", live: true }, { cue: "boardsLoop", loop: true }]);
    case "ANSWER_REVEALED": {
      const at = v.answerAt || 0;
      if (now < at && has("revealLead")) return plan(`reveal-lead:${at}`, [{ cue: "revealLead", at: at - cues.revealLead.durationMs }]);
      return plan(`answer:${v.stop}:${at}`, [{ cue: "correct", live: true }, { cue: "congrats", live: true }]);
    }
    case "ELIMINATION_REVIEW":
      return plan(`elimination:${v.stop}`, [{ cue: "elimination", loop: true }]);
    case "RESCUE":
      // The beat game brings its own beat; the music would only fight it.
      if (v.rescue?.kind === "beat" && v.rescue.status === "playing") return null;
      return plan(`rescue:${v.rescue?.attempt}`, [{ cue: "rescueGame", loop: true }]);
    case "FINISHED":
      return plan(`finale:${v.stop}`, [{ cue: "finale", loop: true }]);
    default:
      return null;
  }
}

// Is the answer on screen yet? It waits for the answer lead-in sound, if there is one.
export const answerShowing = (v, now) => !!v.answer && now >= (v.answerAt || 0);
