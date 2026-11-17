// The question card as the audience sees it: a boarding pass. Used by the projector, and by the
// editor's built-in preview on the host dashboard, so a preview is the real thing, not a mock-up.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/vendor/preact/htm-preact.module.js";
import { clock } from "./net.js";
import { mediaPosition } from "/shared/engine.mjs";

const LETTERS = ["A", "B", "C", "D"];

// Shrinks its text until it fits the box, so a long question never spills off the card.
export function FitText({ text, max = 5.2, min = 1.7, cls = "" }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const box = el.parentElement;
    const fit = () => {
      let size = max; el.style.fontSize = size + "em";
      while (size > min && (el.offsetHeight > box.clientHeight + 1 || el.scrollWidth > box.clientWidth + 1)) { size -= 0.15; el.style.fontSize = size + "em"; }
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(box);
    document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, [text, max, min]);
  return html`<div class="fit ${cls}"><p ref=${ref}>${text}</p></div>`;
}

// Countdown, always computed from the server's deadline, never from "when this page loaded".
export function useRemaining(timer) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!timer || !timer.running) return;
    let raf; const loop = () => { tick((n) => n + 1); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [timer?.running, timer?.deadline]);
  if (!timer) return null;
  if (timer.idle) return timer.durationMs;
  return timer.running ? Math.max(0, timer.deadline - clock.now()) : timer.remainingMs;
}

export function TimerDial({ timer, phase, onSecond }) {
  const ms = useRemaining(timer);
  const secs = ms == null ? null : Math.ceil(ms / 1000 - 0.001);
  const last = useRef(null);
  useEffect(() => {
    if (timer?.running && last.current !== null && secs !== last.current && secs > 0) onSecond?.(secs);
    last.current = secs;
  }, [secs, timer?.running]);
  if (ms == null) return null;
  const total = timer.durationMs || 1, frac = Math.max(0, Math.min(1, ms / total));
  const R = 44, C = 2 * Math.PI * R;
  const state = phase === "TIMER_RUNNING" ? (timer.running ? (secs <= 3 ? "urgent" : "running") : "paused") : phase === "QUESTION_VISIBLE" ? "idle" : "done";
  return html`<div class="dial ${state}" data-testid="timer" data-state=${state} data-seconds=${secs}>
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle class="dial-track" cx="50" cy="50" r=${R} />
      <circle class="dial-arc" cx="50" cy="50" r=${R} stroke-dasharray=${C} stroke-dashoffset=${C * (1 - frac)} transform="rotate(-90 50 50)" />
    </svg>
    <b>${state === "done" ? 0 : secs}</b>
    <span>${state === "idle" ? "seconds, when the timer starts" : state === "paused" ? "paused" : state === "done" ? "time is up" : secs === 1 ? "second" : "seconds"}</span>
  </div>`;
}

let ytReady = null;
const loadYouTube = () => (ytReady ??= new Promise((resolve) => {
  if (window.YT?.Player) return resolve(window.YT);
  window.onYouTubeIframeAPIReady = () => resolve(window.YT);
  const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(s);
}));

// Plays the clip exactly as the host's controls say. It never starts by itself, and it tells the
// server when the clip ends (which changes nothing about the timer).
export function MediaPlayer({ media, kind, mstate, silent, onEnded }) {
  const ref = useRef(), yt = useRef(null), reported = useRef(-1);
  const start = media.clipStart || 0, end = media.clipEnd;
  const live = useRef();
  live.current = { st: mstate || { status: "idle", pos: 0, at: 0, muted: false, n: 0 }, silent };
  const st = live.current.st;
  const ended = () => { const n = live.current.st.n; if (reported.current !== n) { reported.current = n; onEnded?.(n); } };

  useEffect(() => {
    if (!media.youtube) return;
    let dead = false, poll;
    loadYouTube().then((YT) => {
      if (dead) return;
      yt.current = new YT.Player(ref.current, {
        videoId: media.youtube, width: "100%", height: "100%",
        playerVars: { controls: 0, rel: 0, playsinline: 1, modestbranding: 1, disablekb: 1, start: Math.floor(start), ...(end ? { end: Math.ceil(end) } : {}) },
        events: { onReady: () => { yt.current.ready = true; apply(); }, onStateChange: (e) => e.data === 0 && ended() },
      });
      poll = setInterval(() => { const p = yt.current; if (p?.ready && end && p.getCurrentTime?.() >= end && p.getPlayerState?.() === 1) { p.pauseVideo(); ended(); } }, 250);
    });
    return () => { dead = true; clearInterval(poll); yt.current?.destroy?.(); yt.current = null; };
  }, [media.youtube]);

  const apply = () => {
    const { st, silent } = live.current; // always the latest controls, even from an old callback
    const want = start + mediaPosition(st, clock.now());
    const mute = silent || st.muted;
    if (media.youtube) {
      const p = yt.current; if (!p?.ready) return;
      mute ? p.mute() : p.unMute();
      if (st.status === "playing") { p.seekTo(want, true); p.playVideo(); } else if (st.status !== "ended") { p.pauseVideo(); p.seekTo(want, true); }
      return;
    }
    const el = ref.current; if (!el) return;
    el.muted = mute;
    const seek = (tol) => { if (Math.abs(el.currentTime - want) > tol) { try { el.currentTime = want; } catch { /* metadata not loaded yet */ } } };
    if (st.status === "playing") { seek(0.4); el.play().catch(() => { el.muted = true; el.play().catch(() => {}); }); }
    // "ended" is only a report that a clip finished. It never stops a clip, so a false report
    // from elsewhere cannot interrupt the projector.
    else if (st.status !== "ended") { el.pause(); seek(0.05); }
  };
  useEffect(apply, [st.n, st.status, silent, media.src]);

  if (media.youtube) return html`<div class="media-frame video"><div ref=${ref}></div></div>`;
  const common = {
    ref, src: media.src, preload: "auto", playsInline: true,
    onLoadedMetadata: apply,
    onTimeUpdate: (e) => { if (end && e.target.currentTime >= end && live.current.st.status === "playing") { e.target.pause(); ended(); } },
    onEnded: ended,
  };
  if (kind === "audio") {
    return html`<div class="audio-card ${st.status === "playing" ? "playing" : ""}" data-testid="audio-card">
      <audio ...${common}></audio>
      <div class="bars" aria-hidden="true">${Array.from({ length: 28 }, (_, i) => html`<i style=${`--d:${(0.55 + ((i * 37) % 11) / 14).toFixed(2)}s;--h:${30 + ((i * 53) % 70)}%;--o:${-((i * 29) % 13) / 10}s`}></i>`)}</div>
      <p>${st.status === "playing" ? "Listen closely" : st.status === "ended" ? "That was the clip" : "Sound clip"}</p>
    </div>`;
  }
  return html`<div class="media-frame video"><video ...${common} style=${fitStyle(media)}></video></div>`;
}

const fitStyle = (m) => `object-fit:${m.fit};object-position:${m.focusX}% ${m.focusY}%;transform:scale(${m.zoom});transform-origin:${m.focusX}% ${m.focusY}%`;

export function QuestionCard({ q, number, phase = "QUESTION_VISIBLE", answer = null, timer = null, mstate = null, silent = false, onEnded, onSecond, airline = "Golden Bell Air" }) {
  const hasMedia = q.presentation !== "text" && q.media;
  const boards = phase === "BOARDS_UP";
  const revealed = !!answer;
  const long = q.text.length > 150;
  return html`<article class="pass ${hasMedia ? "with-media" : ""} kind-${q.presentation} ${long ? "long" : ""}" data-testid="question-card" data-phase=${phase}>
    <div class="pass-main">
      <header class="pass-head">
        <span class="pass-air">${airline}</span>
        <span class="pass-dest">Destination <b>${number ?? ""}</b></span>
        ${q.topic && html`<span class="pass-topic">${q.topic}</span>`}
      </header>
      <div class="pass-body">
        ${hasMedia && html`<div class="pass-media">
          ${q.presentation === "image"
            ? html`<div class="media-frame"><img src=${q.media.src} alt="" style=${fitStyle(q.media)} data-testid="question-image" /></div>`
            : html`<${MediaPlayer} media=${q.media} kind=${q.presentation} mstate=${mstate} silent=${silent} onEnded=${onEnded} />`}
        </div>`}
        <div class="pass-text">
          <${FitText} text=${q.text} max=${hasMedia ? 4.4 : q.choices ? 6.2 : 7} cls="q" />
          ${q.choices
            ? html`<ol class="choices">${q.choices.map((c, i) => html`<li class=${revealed ? (i === answer.correctChoice ? "right" : "dim") : ""} data-testid=${`choice-${i}`}><b>${LETTERS[i]}</b><span>${c}</span></li>`)}</ol>`
            : !revealed && html`<p class="write-hint">Write your answer on your board</p>`}
          ${revealed && html`<div class="answer" data-testid="answer">
            ${!q.choices && html`<p class="answer-line"><span>Answer</span><b>${answer.text}</b></p>`}
            ${answer.explanation && html`<p class="answer-why">${answer.explanation}</p>`}
          </div>`}
        </div>
      </div>
    </div>
    <aside class="pass-stub">
      <${TimerDial} timer=${timer} phase=${phase} onSecond=${onSecond} />
      <div class="stub-foot"><span>Gate</span><b>${String(number ?? 0).padStart(2, "0")}</b></div>
      ${boards && html`<div class="stamp boards" data-testid="boards-up">Boards up!</div>`}
    </aside>
  </article>`;
}
