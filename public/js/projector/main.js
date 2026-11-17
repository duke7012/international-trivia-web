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
  if (to("FINISHED")) play.goldenBell();
  if (v.lastRescue && !prev.lastRescue) play.fanfare();
  if (v.preview?.kind === "flight" && prev.preview?.kind !== "flight" && !own("flight")) play.takeoff();
  // A new rescue game: the built-in alarm, unless the host has their own music for it.
  if (v.rescue && prev.rescue?.attempt !== v.rescue.attempt && !own("rescueGame")) play.mayday();
}

function sceneFor(v) {
  const pf = v.preview?.kind === "flight" ? v.preview : null;
  const flight = pf || v.flight;
  const stop = pf ? pf.to : v.stop;
  const mode = pf ? "waiting" : v.phase === "LOBBY" ? "lobby" : ["ALL_ELIMINATED", "RESCUE"].includes(v.phase) ? "emergency" : v.phase === "FINISHED" ? "finale" : "waiting";
  return { mode, stop, flight, next: flight ? flight.to : stop + 1 };
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

function Rescue({ v }) {
  const r = v.rescue;
  return html`<section class="rescue" data-testid="rescue-game">
    <div class="hazard top"></div>
    <p class="alarm-kicker"><i class="lamp"></i>Mayday! Save the flight!${r.attempt > 1 ? ` Round ${r.attempt}` : ""}</p>
    <h1 data-testid="rescue-title">${r.title}</h1>
    <ol class="game-rules ${r.rules.length > 6 ? "many" : ""}" data-testid="rescue-rules">
      ${r.rules.map((line, i) => html`<li style=${`animation-delay:${0.25 + i * 0.12}s`}>${line}</li>`)}
    </ol>
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
  const quiet = !!v.question || !!pq || ["ALL_ELIMINATED", "RESCUE", "FINISHED"].includes(v.phase);

  let body = null;
  if (pq) body = html`<div class="veil"></div><${QuestionCard} key="preview" q=${pq.question} number=${pq.number} answer=${pq.answer} phase=${pq.answer ? "ANSWER_REVEALED" : "QUESTION_VISIBLE"} timer=${{ idle: true, durationMs: pq.question.countdown * 1000 }} mstate=${pq.media} silent=${MONITOR || !armed} onEnded=${mediaEnded} />`;
  else if (pf) body = flying ? html`<${Flying} to=${Math.min(pf.to, Math.floor(at) + 1)} preview=${true} />` : html`<${Waiting} v=${{ ...v, stop: pf.to, chosenTopic: null }} />`;
  else if (v.phase === "LOBBY") body = v.topicBoard ? html`<${TopicBoard} v=${v} />` : html`<${Lobby} v=${v} />`;
  else if (v.phase === "FLIGHT_ANIMATING") body = html`<${Flying} to=${v.flight.to} />`;
  else if (v.phase === "DESTINATION_ARRIVED") body = html`<${Waiting} v=${v} />`;
  else if (v.question) body = html`<div class="veil"></div><${QuestionCard} key=${"q" + v.stop} q=${v.question} number=${v.stop} phase=${v.answer && !shown ? "BOARDS_UP" : v.phase} answer=${shown ? v.answer : null} timer=${v.timer} mstate=${v.media} silent=${MONITOR || !armed} onEnded=${mediaEnded} onSecond=${onSecond} />
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
