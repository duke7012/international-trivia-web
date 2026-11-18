// Plays the host's own sound files at the right moments. What should be playing is decided by
// shared/cues.mjs from the show state alone, so a projector that refreshes mid-show rejoins the
// music in the right place instead of restarting or replaying one-off stings.
import { clock } from "../net.js";
import { planAudio } from "/shared/cues.mjs";

const FADE_MS = 280;

export function createCuePlayer() {
  const players = new Map(); // cue id -> { src, el }
  let view = null, armed = false, volume = 0.8;
  let cur = null; // { key, steps, i, el, held }
  let sawLive = false; // false until this page has watched one stretch begin; one-off stings need that

  const note = () => { const r = document.documentElement; r.dataset.cue = cur && !cur.held && cur.i < cur.steps.length ? cur.steps[cur.i].cue : ""; r.dataset.cueKey = cur?.key || ""; };

  function sync(cues) {
    for (const [id, c] of Object.entries(cues || {})) {
      const p = players.get(id);
      if (p && p.src === c.src) continue;
      p?.el.pause();
      const el = new Audio(c.src); el.preload = "auto"; el.volume = volume;
      players.set(id, { src: c.src, el });
    }
    for (const id of [...players.keys()]) if (!cues?.[id]) { players.get(id).el.pause(); players.delete(id); }
  }

  // A fade belongs to one stretch: if the same file starts again before it ends (a level played
  // again), the new start cancels it instead of being paused by it.
  function fadeOut(el) {
    const from = el.volume, t0 = performance.now(), id = (el.fading = {});
    const step = () => {
      if (el.fading !== id) return;
      const k = (performance.now() - t0) / FADE_MS;
      if (k >= 1) { el.pause(); el.volume = volume; return; }
      el.volume = from * (1 - k); requestAnimationFrame(step);
    };
    step();
  }
  function stop() { if (cur?.el) { cur.el.onended = null; fadeOut(cur.el); } cur = null; }

  function playStep(run, late) {
    if (run !== cur) return;
    for (; run.i < run.steps.length; run.i++) {
      const s = run.steps[run.i], p = players.get(s.cue);
      if (!p) continue;
      if (s.live && late) continue; // a sting whose moment this page did not see
      const el = p.el;
      let offset = s.at != null ? Math.max(0, (clock.now() - s.at) / 1000) : 0;
      if (s.loop && el.duration > 0) offset %= el.duration;
      else if (!s.loop && el.duration > 0 && offset >= el.duration - 0.05) continue; // already over
      el.fading = null; el.loop = !!s.loop; el.volume = volume;
      try { el.currentTime = offset > 0.25 ? offset : 0; } catch { /* not loaded yet: start from the top */ }
      el.onended = () => { el.onended = null; run.i++; playStep(run, false); note(); };
      run.el = el;
      if (!run.held) el.play().catch(() => {});
      return;
    }
    run.el = null;
  }

  function tick() {
    if (!armed || !view) return;
    const plan = planAudio(view, clock.now());
    if (!plan) { if (cur) { stop(); note(); } sawLive = true; return; }
    if (!cur || cur.key !== plan.key) {
      stop();
      cur = { key: plan.key, steps: plan.steps, i: 0, el: null, held: plan.hold };
      playStep(cur, !sawLive);
      sawLive = true;
    } else if (plan.hold !== cur.held) {
      cur.held = plan.hold;
      if (cur.el) plan.hold ? cur.el.pause() : cur.el.play().catch(() => {});
    }
    note();
  }
  setInterval(tick, 100);

  return {
    update(v) { view = v; volume = v.sound?.volume ?? volume; sync(v.cues); for (const p of players.values()) p.el.volume = volume; tick(); },
    // Browsers only allow sound after a click on the page.
    arm() { armed = true; sawLive = false; tick(); },
    has: (id) => players.has(id),
  };
}
