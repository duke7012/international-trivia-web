// The projector. It only ever draws what the server says is public right now:
// it holds no question before SHOW QUESTION and no answer before REVEAL ANSWER.
import { html, render, useEffect, useRef, useState } from "/vendor/preact/htm-preact.module.js";
import { connect, clock, plural } from "../net.js";
import { createWorld, ZONES, zoneOf, STOPS } from "./world.js";
import { QuestionCard } from "../stage.js";
import { sfx, play } from "./sfx.js";
import { createCuePlayer } from "./cues.js";
import { answerShowing } from "/shared/cues.mjs";
import { LATE_STAGE_STOP } from "/shared/schema.mjs";

const params = new URLSearchParams(location.search);
const MONITOR = params.has("monitor"); // the small silent copy inside the host dashboard
const cid = Math.random().toString(36).slice(2);
document.documentElement.classList.toggle("monitor", MONITOR);

const world = createWorld(document.getElementById("world"), { monitor: MONITOR });
window.__world = world;

const reportSound = () => !MONITOR && fetch("/api/projector/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cid, sound: sfx.armed }) }).catch(() => {});
const mediaEnded = (n) => !MONITOR && fetch("/api/projector/media-ended", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n }) }).catch(() => {});

// Long rules get the smaller type: too many lines, or too many words in all.
const dense = (lines, most, chars) => lines.length > most || lines.join("").length > chars;
const list = (names, max = 8) => (names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", "));

function sounds(prev, v) {
  if (MONITOR || !prev || prev.workspace !== v.workspace) return;
  sfx.setVolume(v.sound.volume);
  const to = (ph) => prev.phase !== ph && v.phase === ph;
  // Built-in sounds stand in only where the host has not supplied a file of their own.
  const own = (...ids) => ids.some((id) => v.cues?.[id]);
  if (to("FLIGHT_ANIMATING") && !own("flight")) play.takeoff();
  if (to("DESTINATION_ARRIVED") && prev.phase === "FLIGHT_ANIMATING" && !own("flight")) play.land();
  if (to("QUESTION_VISIBLE") && prev.phase === "DESTINATION_ARRIVED" && !own("questionLoop")) play.card();
  if (to("BOARDS_UP") && !own("thinkOver", "boardsLoop")) play.boardsUp(v.sound.timer);
  if (to("ANSWER_REVEALED") && !own("revealLead", "correct")) play.reveal();
  if (to("ALL_ELIMINATED") && prev.phase !== "RESCUE") play.mayday();
  if (to("FINISHED") && !own("finale")) play.goldenBell();
  if (v.lastRescue && !prev.lastRescue) play.fanfare();
  if (v.rules && v.rules.at !== prev.rules?.at) { if (v.rules.step > (prev.rules?.step ?? 0)) play.takeoff(); else play.card(); }
  if (v.preview?.kind === "flight" && prev.preview?.kind !== "flight" && !own("flight")) play.takeoff();
  // A new rescue game: the built-in alarm, unless the host has their own music for it.
  if (v.rescue && prev.rescue?.attempt !== v.rescue.attempt && !own("rescueGame")) play.mayday();
  const r = v.rescue, pr = prev.rescue;
  if (r?.kind && pr?.kind === r.kind && pr.attempt === r.attempt) {
    if (r.kind === "beat" && r.status === "playing" && pr.startedAt !== r.startedAt) {
      // count-in, then one beat per flag, then a closing hit, all timed from the server's start
      const ms = beatMs(r.bpm);
      for (let i = 0; i <= COUNT_IN + r.flags.length; i++) {
        const t = (r.startedAt + i * ms - clock.now()) / 1000;
        if (t > -0.03) play.beat(Math.max(0, t), i < COUNT_IN ? "count" : i === COUNT_IN + r.flags.length ? "end" : "flag", ms / 1000);
      }
    }
    if (r.status === "marked" && pr.status === "playing") (r.results[r.round] ? play.right : play.wrong)();
    if (r.status === "timeUp" && pr.status === "playing") play.timeUp();
    if (r.status === "done" && pr.status !== "done" && r.count > 0) play.fanfare();
  }
}

// The rules screen tours the route: rule i of n sits at its own stop, home airport to the Golden Bell.
const RULE_HOP_MS = 3200;
const ruleStop = (i, n) => Math.round((i * STOPS) / Math.max(1, n - 1));

function sceneFor(v) {
  if (v.rules && !v.preview) {
    const { step, from, at, lines } = v.rules, n = lines.length;
    // forward: fly the leg; back: cut straight there
    const flight = step > from ? { from: ruleStop(from, n), to: ruleStop(step, n), startedAt: at, durationMs: RULE_HOP_MS } : null;
    return { mode: "rules", stop: ruleStop(step, n), flight, next: null, bell: step === n - 1 };
  }
  const pf = v.preview?.kind === "flight" ? v.preview : null;
  const flight = pf || v.flight;
  const stop = pf ? pf.to : v.stop;
  const mode = pf ? "waiting" : v.phase === "LOBBY" ? "lobby" : ["ALL_ELIMINATED", "RESCUE"].includes(v.phase) ? "emergency" : v.phase === "FINISHED" ? "finale" : "waiting";
  return { mode, stop, flight, next: flight ? flight.to : stop + 1, bell: false };
}

// ---------- pieces of the screen ----------

function Bell() {
  return html`<svg class="bell" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a1.5 1.5 0 0 1 1.5 1.5v.6A6 6 0 0 1 18 11v3.5l1.8 2.6v1.1H4.2v-1.1L6 14.5V11a6 6 0 0 1 4.5-5.9v-.6A1.5 1.5 0 0 1 12 3Zm-2.2 16.4h4.4a2.2 2.2 0 0 1-4.4 0Z" fill="currentColor"/></svg>`;
}

function Rail({ at, flying }) {
  const z = ZONES[zoneOf(Math.round(at))];
  return html`<aside class="rail" aria-hidden="true">
    <div class="rail-line">
      <i class="rail-fill" style=${`height:${(at / STOPS) * 100}%`}></i>
      ${ZONES.map((zn) => html`<i class="rail-tick" style=${`top:${(zn.from / STOPS) * 100}%`}></i>`)}
      <b class="rail-plane ${flying ? "flying" : ""}" style=${`top:${(at / STOPS) * 100}%`}><span>${z.name}</span></b>
    </div>
  </aside>`;
}

function Hud({ v }) {
  if (!v.counts.total) return null;
  return html`<div class="hud" data-testid="hud"><${Bell} /><b>${v.counts.active}</b><span>of ${v.counts.total} still flying</span></div>`;
}

function Waiting({ v }) {
  return html`<section class="card waiting" data-testid="waiting-card">
    <p class="card-kicker">Destination</p>
    <p class="mega-num">${v.stop}</p>
    <p class="waiting-line"><i class="pulse"></i>Awaiting question</p>
    ${v.chosenTopic && html`<p class="chip">Topic: ${v.chosenTopic}</p>`}
  </section>`;
}

function Flying({ to, preview }) {
  return html`<section class="flying-tag" data-testid="flying-tag"><span>${preview ? "Preview flight to" : "Now flying to"}</span><b>Destination ${to}</b></section>`;
}

function Lobby({ v }) {
  return html`<section class="lobby" data-testid="lobby">
    <h1>${v.title.split(":")[0]}${v.title.includes(":") && html`<span>${v.title.split(":").slice(1).join(":").trim()}</span>`}</h1>
    <p>Thirty destinations. One Golden Bell. Boarding now.</p>
  </section>`;
}

function Rules({ v }) {
  const { step, lines } = v.rules;
  return html`<section class="rules-screen" data-testid="rules-screen">
    <div class="rule-card" key=${step} data-testid="rule-card">
      <p class="card-kicker">Rule ${step + 1} of ${lines.length}</p>
      <h2>${lines[step]}</h2>
    </div>
    <ol class="rule-dots" aria-hidden="true">${lines.map((_, i) => html`<li class=${i === step ? "on" : i < step ? "done" : ""}></li>`)}</ol>
  </section>`;
}

function Between({ v }) {
  if (v.lastRescue) {
    return html`<section class="card between good" data-testid="rescue-done">
      <p class="card-kicker">${v.lastRescue.via === "rescue" ? "Flight restored" : "Emergency return"}</p>
      <h2>${plural(v.lastRescue.count, "passenger")} back on board</h2>
      ${v.lastRescue.names.length > 0 && html`<p class="names">${list(v.lastRescue.names, 12)}</p>`}
      <p class="sub">Cleared for take-off.</p>
    </section>`;
  }
  if (!v.lastReview) return null;
  const n = v.lastReview.count;
  return html`<section class="card between" data-testid="review-summary">
    <p class="card-kicker">After destination ${v.lastReview.stop}</p>
    <h2>${n === 0 ? "Everyone stays on board" : `${plural(n, "passenger")} left the flight`}</h2>
    ${n > 0 && v.lastReview.names.length > 0 && html`<p class="names">${list(v.lastReview.names)}</p>`}
    <p class="sub">${plural(v.counts.active, "passenger")} still flying.</p>
  </section>`;
}

function TopicBoard({ v }) {
  const tb = v.topicBoard;
  return html`<section class="card topics" data-testid="topic-board">
    <p class="card-kicker">Next destination: ${v.stop + 1}</p>
    <h2>${tb.chooser ? `${tb.chooser}, choose the topic` : "Choose the topic"}</h2>
    <ul>${tb.topics.map((t) => html`<li class=${t.available ? "" : "off"}>${t.topic}</li>`)}</ul>
  </section>`;
}

function AllOut({ v }) {
  return html`<section class="alarm" data-testid="all-eliminated">
    <div class="hazard top"></div><div class="hazard bottom"></div>
    <div class="alarm-in">
      <p class="alarm-kicker"><i class="lamp"></i>Emergency landing at destination ${v.stop}</p>
      <h1>Every passenger is out</h1>
      <p class="alarm-sub">The flight cannot continue. Stand by for the rescue game.</p>
    </div>
  </section>`;
}

// ----- rescue games -----
const useNow = (ms, on = true) => {
  const [t, setT] = useState(clock.now());
  useEffect(() => { if (!on) return; const i = setInterval(() => setT(clock.now()), ms); return () => clearInterval(i); }, [ms, on]);
  return on ? t : clock.now();
};
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const COUNT_IN = 4;
const beatMs = (bpm) => 60000 / bpm;

function Countdown({ deadline, big }) {
  const now = useNow(200, !!deadline);
  return html`<p class="rg-clock ${big ? "big" : ""} ${deadline && deadline - now < 10500 ? "low" : ""}" data-testid="rescue-clock">${deadline ? mmss(deadline - now) : "0:00"}</p>`;
}

function Beat({ r }) {
  const playing = r.status === "playing";
  const now = useNow(25, playing);
  const n = playing ? Math.floor((now - r.startedAt) / beatMs(r.bpm)) - COUNT_IN : -99;
  const count = playing && n < 0 && n >= -COUNT_IN ? n + COUNT_IN + 1 : null;
  return html`<div class="beat" data-testid="beat-grid">
    <div class="beat-grid">${r.flags.map((f, i) => html`<figure class="${i === n ? "lit" : ""} ${playing && i < n ? "said" : ""}"><img src=${f.src} alt="" draggable="false" />${f.name && html`<figcaption>${f.name}</figcaption>`}</figure>`)}</div>
    <p class="beat-cue">${count ? html`<b class="count" key=${count}>${count}</b>` : playing && n >= r.flags.length ? "Level over" : !playing ? `Level ${r.round + 1} · ${r.bpm} beats a minute${r.flags[0].name ? "" : " · no names!"}` : ""}</p>
  </div>`;
}

function Doodle({ r }) {
  const playing = r.status === "playing";
  const now = useNow(200, playing);
  const guessing = playing && now >= r.startedAt + r.drawMs;
  const last = useRef(null);
  const [into] = useState(() => clock.now() - (r.startedAt || 0)); // fixed per country (the component is keyed by it)
  const left = guessing ? Math.ceil((r.deadline - now) / 1000) : null;
  useEffect(() => { if (!MONITOR && guessing && left !== last.current && left > 0) { last.current = left; play.tick("ticks", left <= 3); } }, [left]);
  const o = r.outline;
  return html`<div class="doodle" data-testid="doodle">
    ${o && html`<svg viewBox=${`-40 -40 ${o.w + 80} ${o.h + 80}`} class=${r.answer ? "done" : ""}><path key=${r.round + ":" + r.startedAt} d=${o.d} pathLength="1" style=${playing ? `animation-duration:${r.drawMs}ms;animation-delay:${-into}ms` : ""} class=${playing ? "drawing" : ""} /></svg>`}
    <div class="doodle-side">
      ${guessing && html`<p class="rg-clock big ${left <= 3 ? "low" : ""}" data-testid="doodle-count">${Math.max(0, left)}</p>`}
      ${playing && !guessing && html`<p class="doodle-note">Drawing…</p>`}
      ${r.answer && html`<div class="doodle-answer ${r.answer.ok ? "ok" : "miss"}" data-testid="doodle-answer"><img src=${r.answer.flag} alt="" /><b>${r.answer.name}</b><span>${r.answer.ok ? "Got it!" : "Missed"}</span></div>`}
      ${!playing && !r.answer && html`<p class="doodle-note">Country ${r.round + 1} of ${r.rounds}</p>`}
    </div>
  </div>`;
}

function Semantle({ r }) {
  return html`<div class="semantle" data-testid="semantle">
    ${MONITOR ? html`<div class="semantle-stub">Semantle #${r.puzzle} is open on the projector</div>` : html`<iframe src=${r.url} title=${`Semantle puzzle ${r.puzzle}`} allow="clipboard-write"></iframe>`}
    <div class="semantle-clock">${r.status === "playing" ? html`<${Countdown} deadline=${r.deadline} />` : html`<p class="rg-clock low">Time's up</p>`}</div>
  </div>`;
}

function ScoreStrip({ r }) {
  const rounds = ["beat", "doodle"].includes(r.kind);
  return html`<footer class="rg-score" data-testid="rescue-score">
    ${rounds && html`<ol class="rg-dots">${Array.from({ length: r.rounds }, (_, i) => html`<li class=${r.results[i] === true ? "ok" : r.results[i] === false ? "miss" : i === r.round ? "now" : ""}></li>`)}</ol>`}
    <p><b>${r.pct}%</b> back on board · ${r.count} of ${r.out} passengers</p>
  </footer>`;
}

function Rescue({ v }) {
  const r = v.rescue;
  const head = html`<div class="hazard top"></div><p class="alarm-kicker"><i class="lamp"></i>Mayday! Save the flight!${r.attempt > 1 ? ` Round ${r.attempt}` : ""}</p>`;
  if (!r.kind) return html`<section class="rescue" data-testid="rescue-game">${head}<h1 data-testid="rescue-title">Rescue game</h1><p class="rg-lead">Everyone who is out plays as one team. The host is choosing the game…</p></section>`;
  if (r.status === "intro") {
    return html`<section class="rescue" data-testid="rescue-game" data-kind=${r.kind}>${head}
      <h1 data-testid="rescue-title">${r.title}</h1>
      <ol class="game-rules ${dense(r.howTo, 6, 260) ? "many" : ""}" data-testid="rescue-rules">${r.howTo.map((line, i) => html`<li style=${`animation-delay:${0.25 + i * 0.12}s`}>${line}</li>`)}</ol>
      <ul class="ladder" data-testid="rescue-ladder">${r.ladder.map((l) => html`<li>${l}</li>`)}</ul>
    </section>`;
  }
  if (r.status === "done") {
    return html`<section class="rescue done" data-testid="rescue-game" data-kind=${r.kind}>${head}
      <p class="rg-lead">${r.title}: ${r.kind === "semantle" ? (r.score >= 1000 ? "the word was found!" : `closest guess ${r.score} / 1000`) : r.kind === "tower" ? `${r.score} ${r.score === 1 ? "tower" : "towers"} finished` : `${r.score} of ${r.rounds} ${r.kind === "beat" ? "levels" : "countries"}`}</p>
      <h1 data-testid="rescue-result">${r.count === 0 ? "Nobody returns this time" : r.count >= r.out ? "Everyone is back on board!" : `${r.count} of ${r.out} passengers return`}</h1>
      <p class="rg-pct">${r.pct}%</p>
    </section>`;
  }
  return html`<section class="rescue playing rg-${r.kind}" data-testid="rescue-game" data-kind=${r.kind} data-status=${r.status}>${head}
    ${r.kind !== "semantle" && html`<h2 class="rg-title">${r.title}</h2>`}
    ${r.kind === "beat" && html`<${Beat} r=${r} />`}
    ${r.kind === "doodle" && html`<${Doodle} r=${r} key=${r.round + ":" + r.startedAt} />`}
    ${r.kind === "semantle" && html`<${Semantle} r=${r} />`}
    ${r.kind === "tower" && html`<div class="tower"><ol class="game-rules ${dense(r.howTo, 5, 180) ? "many" : ""}">${r.howTo.map((line) => html`<li>${line}</li>`)}</ol>
      <div class="tower-clock">${r.rounds > 1 && html`<p class="tower-group" data-testid="tower-group">Group ${r.round + 1} of ${r.rounds}</p>`}
      ${r.status === "playing" ? html`<${Countdown} deadline=${r.deadline} big />` : html`<p class="rg-clock big low">Time's up</p>`}
      ${r.status === "timeUp" && r.round + 1 < r.rounds && html`<p class="tower-next">Group ${r.round + 2}, get ready</p>`}</div></div>`}
    <${ScoreStrip} r=${r} />
  </section>`;
}

function Finale({ v }) {
  const f = v.finale;
  return html`<section class="finale" data-testid="finale">
    <p class="card-kicker">${f.count ? `After ${plural(f.stop, "destination")}` : "End of the journey"}</p>
    <h1>${f.count === 0 ? "The Golden Bell stays silent" : f.count === 1 ? "The Golden Bell rings" : "The Golden Bell rings"}</h1>
    ${f.count > 0 && html`<p class="winners">${f.winners.length ? list(f.winners, 14) : plural(f.count, "champion")}</p>`}
    ${f.count > 0 && html`<p class="sub">${f.count === 1 ? "Champion of the journey" : `${f.count} champions of the journey`}</p>`}
  </section>`;
}

function Screen({ v, status, armed, onArm }) {
  const pf = v.preview?.kind === "flight" ? v.preview : null, pq = v.preview?.kind === "question" ? v.preview : null;
  const [at, setAt] = useState(v.stop);
  useEffect(() => { const t = setInterval(() => setAt(world.progress()), 120); return () => clearInterval(t); }, []);
  const flying = pf ? clock.now() < pf.startedAt + pf.durationMs : v.phase === "FLIGHT_ANIMATING";
  const onSecond = (s) => !MONITOR && !v.cues?.[v.stop >= LATE_STAGE_STOP ? "thinkDrums" : "thinkClock"] && play.tick(v.sound.timer, s <= 3);
  // The answer may wait for a lead-in sound to finish; redraw at that moment.
  const [, redraw] = useState(0);
  const shown = answerShowing(v, clock.now());
  useEffect(() => {
    if (!v.answer || shown) return;
    const t = setTimeout(() => redraw((n) => n + 1), Math.max(0, v.answerAt - clock.now()) + 20);
    return () => clearTimeout(t);
  }, [v.answerAt, !!v.answer, shown]);
  const quiet = !!v.question || !!pq || !!v.rules || ["ALL_ELIMINATED", "RESCUE", "FINISHED"].includes(v.phase);

  let body = null;
  if (pq) body = html`<div class="veil"></div><${QuestionCard} key="preview" typing q=${pq.question} number=${pq.number} answer=${pq.answer} phase=${pq.answer ? "ANSWER_REVEALED" : "QUESTION_VISIBLE"} timer=${{ idle: true, durationMs: pq.question.countdown * 1000 }} mstate=${pq.media} silent=${MONITOR || !armed} onEnded=${mediaEnded} />`;
  else if (pf) body = flying ? html`<${Flying} to=${Math.min(pf.to, Math.floor(at) + 1)} preview=${true} />` : html`<${Waiting} v=${{ ...v, stop: pf.to, chosenTopic: null }} />`;
  else if (v.phase === "LOBBY") body = v.topicBoard ? html`<${TopicBoard} v=${v} />` : v.rules ? html`<${Rules} v=${v} />` : html`<${Lobby} v=${v} />`;
  else if (v.phase === "FLIGHT_ANIMATING") body = html`<${Flying} to=${v.flight.to} />`;
  else if (v.phase === "DESTINATION_ARRIVED") body = html`<${Waiting} v=${v} />`;
  else if (v.question) body = html`<div class="veil"></div><${QuestionCard} key=${"q" + v.stop} typing q=${v.question} number=${v.stop} phase=${v.answer && !shown ? "BOARDS_UP" : v.phase} answer=${shown ? v.answer : null} timer=${v.timer} mstate=${v.media} silent=${MONITOR || !armed} onEnded=${mediaEnded} onSecond=${onSecond} />
    ${v.phase === "ELIMINATION_REVIEW" && html`<p class="checking" data-testid="checking"><i class="pulse"></i>Checking boards</p>`}`;
  else if (v.phase === "READY_TO_FLY") body = v.topicBoard ? html`<${TopicBoard} v=${v} />` : html`<${Between} v=${v} />`;
  else if (v.phase === "ALL_ELIMINATED") body = html`<${AllOut} v=${v} />`;
  else if (v.phase === "RESCUE") body = html`<${Rescue} v=${v} />`;
  else if (v.phase === "FINISHED") body = html`<${Finale} v=${v} />`;

  return html`<div class="stage phase-${v.phase.toLowerCase()} ${quiet ? "quiet" : ""}" data-testid="projector" data-phase=${v.phase} data-stop=${v.stop} data-rev=${v.rev}>
    <div class="brand"><${Bell} /><span>${v.title}</span></div>
    ${!quiet && html`<${Rail} at=${at} flying=${flying} />`}
    ${body}
    <${Hud} v=${v} />
    ${v.preview && html`<div class="ribbon preview" data-testid="preview-ribbon">Preview. Not part of the show.</div>`}
    ${v.workspace === "demo" && html`<div class="ribbon demo" data-testid="demo-ribbon">Rehearsal with demo questions</div>`}
    ${status === "offline" && html`<div class="ribbon offline">Reconnecting to the show computer</div>`}
    ${!MONITOR && !armed && html`<button class="arm" onClick=${onArm} data-testid="arm-sound">Click anywhere to turn on sound</button>`}
  </div>`;
}

// ---------- wiring ----------

let view = null, status = "online", armed = false;
const root = document.getElementById("overlay");
const draw = () => view && render(html`<${Screen} v=${view} status=${status} armed=${armed} onArm=${arm} />`, root);
const cuePlayer = MONITOR ? null : createCuePlayer();
function arm() { if (!armed && sfx.arm()) { armed = true; cuePlayer?.arm(); reportSound(); draw(); } }
if (!MONITOR) { addEventListener("pointerdown", arm); addEventListener("keydown", arm); }

connect("projector", {
  monitor: MONITOR, cid,
  onState(v) { sounds(view, v); view = v; world.set(sceneFor(v)); cuePlayer?.update(v); draw(); },
  onStatus(s) { if (s === "online" && status !== "online") reportSound(); status = s; draw(); },
});
