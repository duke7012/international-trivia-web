// Show tab: the flight deck. Four separate buttons for the four separate host decisions
// (fly, show question, start timer, reveal answer). They sit in fixed places and never turn
// into one another, so a double-click can never run two steps.
import { html, useEffect, useState } from "/vendor/preact/htm-preact.module.js";
import { plural } from "../net.js";
import { useRemaining } from "../stage.js";
import { PRESENTATION_LABEL, FORMAT_LABEL, answerText, EMERGENCY_RULES, RESCUE_KINDS, rescueInfo, rescueLadder, rescueScore, rescuePct, rescueCount, showRules } from "/shared/schema.mjs";
import { semantleUrl } from "/shared/rescue-bank.mjs";
import { run, excerpt, PHASE_TEXT, MediaControls } from "./ui.js";

const secs = (ms) => Math.ceil(ms / 1000 - 0.001);

// Before take-off: walk the room through the rules, one card per press.
function RulesControls({ view }) {
  const lines = showRules(view.settings), r = view.session.rules;
  if (!r) return html`<div class="row rules-controls"><button type="button" class="btn" disabled=${!lines.length} onClick=${() => run("showRules")} data-testid="btn-show-rules">Show the rules</button>
    <span class="muted">${lines.length ? `${plural(lines.length, "rule")} on the projector, one at a time. Edit them in Settings.` : "Write the rules in Settings first."}</span></div>`;
  const go = (step) => run("rulesStep", { step });
  return html`<div class="rules-controls on" data-testid="rules-controls">
    <p class="rules-now"><b>Rule ${r.step + 1} of ${lines.length}</b> ${lines[r.step]}</p>
    <div class="row">
      <button type="button" class="btn" disabled=${r.step === 0} onClick=${() => go(r.step - 1)} data-testid="btn-rule-back">Back</button>
      <button type="button" class="btn primary" disabled=${r.step >= lines.length - 1} onClick=${() => go(r.step + 1)} data-testid="btn-rule-next">Next rule</button>
      <button type="button" class="btn ghost" onClick=${() => run("hideRules")} data-testid="btn-hide-rules">Close the rules</button>
    </div>
  </div>`;
}

function Steps({ view, topic }) {
  const s = view.session, ph = s.phase;
  const canFly = ["LOBBY", "READY_TO_FLY"].includes(ph);
  const activeCount = s.contestants.filter((c) => c.status === "active").length;
  const topicOpt = topic ? view.next.topics.find((t) => t.topic === topic) : null;
  let flyWhy = "";
  if (canFly) {
    if (view.preview) flyWhy = "End the projector preview first.";
    else if (!s.contestants.length) flyWhy = "Add contestants to the roster first.";
    else if (!activeCount) flyWhy = "Nobody is left in the game.";
    else if (topic) flyWhy = topicOpt?.available ? "" : topicOpt?.reason || "Pick a topic.";
    else if (!view.next.fixed.id) flyWhy = view.next.fixed.reason;
  }
  const order = ["LOBBY", "READY_TO_FLY", "FLIGHT_ANIMATING", "DESTINATION_ARRIVED", "QUESTION_VISIBLE", "TIMER_RUNNING", "BOARDS_UP", "ANSWER_REVEALED", "ELIMINATION_REVIEW"];
  const at = order.indexOf(ph);
  const step = (n, label, sub, { enabled, done, busy, onClick, testid, why }) => html`
    <button type="button" class="step ${enabled ? "ready" : ""} ${done ? "done" : ""} ${busy ? "busy" : ""}" disabled=${!enabled} onClick=${onClick} data-testid=${testid} title=${why || ""}>
      <i class="step-n">${done ? "✓" : n}</i>
      <span class="step-label">${label}</span>
      <span class="step-sub">${busy || sub}</span>
    </button>`;
  return html`<div class="steps" data-testid="steps">
    ${step(1, "Fly to next destination", canFly ? (flyWhy || `Destination ${s.stop + 1}${topic ? `, topic: ${topic}` : view.next.fixed.slot ? `, question ${view.next.fixed.slot}` : ""}`) : "", {
      enabled: canFly && !flyWhy, done: at >= 3, busy: ph === "FLIGHT_ANIMATING" && "In the air", testid: "btn-fly", why: flyWhy,
      onClick: () => run("fly", topic ? { topic } : {}),
    })}
    ${step(2, "Show question", "Puts the question on the projector. The timer stays stopped.", { enabled: ph === "DESTINATION_ARRIVED" && !view.preview, done: at >= 4, testid: "btn-show", onClick: () => run("showQuestion") })}
    ${step(3, "Start timer", `${view.session.shown?.question.countdown || view.settings.defaultCountdown} seconds. Start it after you have read the question.`, { enabled: ph === "QUESTION_VISIBLE", done: at >= 6, busy: ph === "TIMER_RUNNING" && "Counting down", testid: "btn-timer", onClick: () => run("startTimer") })}
    ${step(4, "Reveal answer", "Shows the correct answer and the explanation.", { enabled: ph === "BOARDS_UP", done: at >= 7, testid: "btn-reveal", onClick: () => run("revealAnswer") })}
  </div>`;
}

function NextPicker({ view, topic, setTopic }) {
  const s = view.session;
  const [byTopic, setByTopic] = useState(false);
  const [chooser, setChooser] = useState("");
  const act = s.contestants.filter((c) => c.status === "active");
  useEffect(() => { if (!byTopic) setTopic(null); }, [byTopic]);
  useEffect(() => { setByTopic(false); setChooser(""); }, [s.stop]);
  if (s.stop >= 30) return html`<div class="note">The plane is at the final destination. Press <b>Show the finale</b> when you are ready.</div>`;
  const nextQ = view.questions.find((q) => q.id === view.next.fixed.id);
  return html`<div class="next" data-testid="next-picker">
    <div class="seg small" role="radiogroup" aria-label="How the next question is chosen">
      <label class=${!byTopic ? "on" : ""}><input type="radio" checked=${!byTopic} onChange=${() => { setByTopic(false); if (s.topicBoard) run("closeTopicBoard"); }} data-testid="mode-fixed" />Next in order</label>
      <label class=${byTopic ? "on" : ""}><input type="radio" checked=${byTopic} onChange=${() => setByTopic(true)} data-testid="mode-topic" />A contestant picks the topic</label>
    </div>
    ${!byTopic
      ? html`<p class="next-line" data-testid="next-fixed">${nextQ ? html`Destination ${s.stop + 1} plays <b>question ${view.next.fixed.slot}</b>: ${excerpt(nextQ.text, 80)}` : html`<span class="warn" data-testid="next-blocked">${view.next.fixed.reason}</span>`}</p>`
      : html`<div class="topic-pick">
          <div class="row">
            <label class="inline">Who chooses
              <select value=${chooser} onChange=${(e) => setChooser(e.target.value)} data-testid="chooser">
                <option value="">Not shown</option>${act.map((c) => html`<option value=${c.id}>${c.name}</option>`)}
              </select>
            </label>
            <button type="button" class="btn ghost small" onClick=${() => act.length && setChooser(act[Math.floor(Math.random() * act.length)].id)}>Pick someone at random</button>
            ${s.topicBoard
              ? html`<button type="button" class="btn small on" onClick=${() => run("closeTopicBoard")}>Hide topics from projector</button>`
              : html`<button type="button" class="btn small" onClick=${() => run("openTopicBoard", { contestantId: chooser || null })} data-testid="btn-topic-board">Show topics on projector</button>`}
          </div>
          <div class="topic-chips">
            ${view.next.topics.length === 0 && html`<p class="warn">No question has a topic yet. Add topics in the Questions tab.</p>`}
            ${view.next.topics.map((t) => html`<button type="button" class="chip-btn ${topic === t.topic ? "on" : ""}" disabled=${!t.available} onClick=${() => setTopic(t.topic)} data-testid=${`topic-${t.topic}`} title=${t.reason || ""}>
              ${t.topic}<small>${t.available ? plural(t.count, "question") : t.reason}</small>
            </button>`)}
          </div>
          <p class="field-hint">Select the topic the contestant says, then press Fly. You still show the question and start the timer yourself.</p>
        </div>`}
  </div>`;
}

function TimerReadout({ timer }) {
  const ms = useRemaining(timer);
  return html`<b class="readout ${timer.running ? "" : "paused"}" data-testid="host-timer">${secs(ms)}</b>`;
}

function HostQuestion({ view }) {
  const s = view.session;
  const bank = view.questions.find((q) => q.id === s.currentQuestionId);
  const q = s.shown?.question || bank;
  if (!q || ["LOBBY"].includes(s.phase)) return html`<div class="panel stagecard empty"><h2>On stage</h2><p class="muted">No question yet. Your copy of each question, with the answer and your notes, appears here when the plane lands.</p></div>`;
  const hidden = s.phase === "FLIGHT_ANIMATING" || s.phase === "DESTINATION_ARRIVED";
  return html`<div class="panel stagecard" data-testid="host-question">
    <header class="panel-head">
      <h2>Destination ${s.stop}, question ${view.currentSlot ?? s.shown?.slot ?? ""}</h2>
      <span class="muted">${[q.topic, q.country, q.difficulty, PRESENTATION_LABEL[q.presentation], FORMAT_LABEL[q.answerFormat]].filter(Boolean).join(", ")}</span>
    </header>
    ${hidden && html`<p class="secret">Only you can see this. The projector shows the waiting card.</p>`}
    ${view.stale && html`<div class="callout" data-testid="stale-note">This question was edited after it went on the projector. The audience still sees the earlier version.
      <button type="button" class="btn small primary" onClick=${() => run("updateProjector")} data-testid="btn-update-projector">Update projector</button></div>`}
    <p class="hq-text">${q.text}</p>
    ${q.answerFormat === "choice"
      ? html`<ol class="hq-choices">${q.choices.map((c, i) => html`<li class=${i === q.correctChoice ? "right" : ""}><b>${"ABCD"[i]}</b>${c}${i === q.correctChoice && html`<i>correct</i>`}</li>`)}</ol>`
      : html`<p class="hq-answer">Answer: <b>${answerText(q)}</b>${q.variants.length > 0 && html`<span> also accept ${q.variants.join(", ")}</span>`}</p>`}
    ${q.explanation && html`<p class="hq-why">${q.explanation}</p>`}
    ${q.hostNotes && html`<p class="hq-notes"><b>Your notes</b> ${q.hostNotes}</p>`}
  </div>`;
}

function Review({ view }) {
  const s = view.session, wrong = new Set(s.review.wrong);
  const act = s.contestants.filter((c) => c.status === "active");
  const toggle = (id) => { const next = new Set(wrong); next.has(id) ? next.delete(id) : next.add(id); run("setWrong", { ids: [...next] }); };
  const allOut = wrong.size === act.length && act.length > 0;
  return html`<div class="review" data-testid="review">
    <div class="row between">
      <b>Who got it wrong?</b>
      <span class="row"><button type="button" class="btn ghost small" onClick=${() => run("setWrong", { ids: act.map((c) => c.id) })} data-testid="mark-all">Mark everyone</button><button type="button" class="btn ghost small" onClick=${() => run("setWrong", { ids: [] })}>Clear</button></span>
    </div>
    <div class="people">${act.map((c) => html`<label class="person ${wrong.has(c.id) ? "out" : ""}"><input type="checkbox" checked=${wrong.has(c.id)} onChange=${() => toggle(c.id)} data-testid=${`wrong-${c.name}`} />${c.name}</label>`)}</div>
    ${allOut && html`<p class="warn">This eliminates everyone. The show will stop on the emergency screen and wait for you.</p>`}
    <button type="button" class="btn primary big" onClick=${() => run("confirmEliminations")} data-testid="btn-confirm">${wrong.size ? `Eliminate ${plural(wrong.size, "contestant")}` : "Nobody is eliminated"}, continue</button>
  </div>`;
}

function PickPeople({ people, value, onChange, max, testid }) {
  const set = new Set(value);
  return html`<div class="people" data-testid=${testid}>${people.map((c) => html`<label class="person ${set.has(c.id) ? "in" : ""}">
    <input type="checkbox" checked=${set.has(c.id)} disabled=${!set.has(c.id) && max && set.size >= max} onChange=${() => { const n = new Set(set); n.has(c.id) ? n.delete(c.id) : n.add(c.id); onChange([...n]); }} data-testid=${`${testid}-${c.name}`} />${c.name}</label>`)}</div>`;
}

function EmergencyExits({ view }) {
  const s = view.session, out = s.contestants.filter((c) => c.status === "eliminated");
  const [ids, setIds] = useState([]);
  const rule = view.rescue.emergencyRule;
  return html`<details class="exits" data-testid="emergency-exits">
    <summary>Emergency options (host override)</summary>
    <div class="exit">
      <p><b>Predefined emergency rule:</b> ${EMERGENCY_RULES[rule]}.</p>
      ${rule === "hostPick" && html`<p class="field-hint">Tick who returns below, then use the rule.</p>`}
      <button type="button" class="btn warn" onClick=${() => confirm(`Use the emergency rule now? ${EMERGENCY_RULES[rule]}.`) && run("emergencyRule", { ids })} disabled=${rule === "hostPick" && !ids.length} data-testid="btn-emergency-rule">Use the emergency rule</button>
    </div>
    <div class="exit">
      <p><b>Emergency return:</b> choose exactly who comes back.</p>
      <div class="row"><button type="button" class="btn ghost small" onClick=${() => setIds(out.map((c) => c.id))}>Select everyone</button><button type="button" class="btn ghost small" onClick=${() => setIds([])}>Clear</button></div>
      <${PickPeople} people=${out} value=${ids} onChange=${setIds} testid="exit-pick" />
      <button type="button" class="btn warn" disabled=${!ids.length} onClick=${() => run("emergencyReturn", { ids })} data-testid="btn-emergency-return">Return ${plural(ids.length, "contestant")} now</button>
    </div>
  </details>`;
}

function AllOut({ view }) {
  const s = view.session;
  return html`<div class="allout" data-testid="allout-panel">
    <p class="alert">Everyone has been eliminated. The plane has made an emergency stop at destination ${s.stop}. Nothing happens until you choose.</p>
    <p class="note">In the rescue, everyone who is out plays one game as a team, and their score sets how many come back. You choose the game next. Scoring is set in the Rescue tab.</p>
    <button type="button" class="btn mayday big" disabled=${!!view.preview} onClick=${() => run("startRescue")} data-testid="btn-rescue-start">START RESCUE GAME</button>
    <${EmergencyExits} view=${view} />
  </div>`;
}

function RescueClock({ deadline }) {
  const ms = useRemaining({ running: true, deadline, durationMs: Infinity });
  const t = secs(ms);
  return html`<b class="readout" data-testid="rescue-host-clock">${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}</b>`;
}

function RescueGame({ g, cfg }) {
  const [score, setScore] = useState("");
  const go = (label, testid = "btn-rescue-go") => html`<button type="button" class="btn primary big" onClick=${() => run("rescueGo")} data-testid=${testid}>${label}</button>`;
  const mark = html`<div class="row"><button type="button" class="btn primary" onClick=${() => run("rescueMark", { ok: true })} data-testid="btn-rescue-ok">✓ They got it</button>
    <button type="button" class="btn warn" onClick=${() => run("rescueMark", { ok: false })} data-testid="btn-rescue-miss">✗ Missed</button></div>`;
  const next = html`<button type="button" class="btn primary big" onClick=${() => run("rescueNext")} data-testid="btn-rescue-next">${g.round + 1 >= (g.kind === "beat" ? g.items.levels.length : g.items.length) ? "See the result" : "Next"}</button>`;
  if (g.kind === "beat") {
    const level = g.items.levels[g.round];
    return html`<div class="rescue-game">
      <p><b>Level ${g.round + 1} of ${g.items.levels.length}</b>${g.round === g.items.levels.length - 1 ? " (no names on screen)" : ""}: <span class="muted">${level.map((f) => f.name).join(", ")}</span></p>
      ${g.status === "ready" && go(`Play level ${g.round + 1}`)}
      ${g.status === "playing" && html`${mark}<button type="button" class="btn ghost small" onClick=${() => run("rescueGo")} data-testid="btn-rescue-again">Play this level again</button>`}
      ${g.status === "marked" && next}
    </div>`;
  }
  if (g.kind === "doodle") {
    const c = g.items[g.round];
    return html`<div class="rescue-game">
      <p><b>Country ${g.round + 1} of ${g.items.length}:</b> <span class="secret-answer" data-testid="doodle-host-answer">${c.name}</span></p>
      ${g.status === "ready" && go(`Draw country ${g.round + 1}`)}
      ${g.status === "playing" && html`<div class="clock-row"><${RescueClock} deadline=${g.deadline} /><span class="muted">Skips by itself when the countdown ends.</span></div>${mark}`}
      ${g.status === "marked" && next}
    </div>`;
  }
  const semantle = g.kind === "semantle", groups = g.items.groups || 1;
  return html`<div class="rescue-game">
    ${semantle && html`<p>Semantle puzzle <a href=${semantleUrl(g.items.puzzle)} target="_blank" rel="noopener">#${g.items.puzzle}</a> is on the projector. Contestants type there.</p>`}
    ${!semantle && html`<p>${groups > 1 ? `Group ${g.round + 1} of ${groups} (up to ${cfg.tower.groupSize} people each, ${Math.round(cfg.tower.seconds / 60 * 10) / 10} min each).` : "One group."} Show the builders each tower design yourself.</p>`}
    ${g.status === "playing" && html`<div class="clock-row"><${RescueClock} deadline=${g.deadline} /><button type="button" class="btn" onClick=${() => run("rescueTimeout")} data-testid="btn-rescue-stop">Stop the clock</button></div>`}
    ${!semantle && g.status === "timeUp" && g.round + 1 < groups && html`<div class="row"><button type="button" class="btn primary big" onClick=${() => run("rescueGo")} data-testid="btn-rescue-next-group">Start group ${g.round + 2} of ${groups}</button></div>`}
    <div class="row">
      <label class="field-label">${semantle ? "Best closeness out of 1000 (1000 = found the word)" : "Towers finished, all groups so far"}
        <input type="number" min="0" max=${semantle ? 1000 : 99} class="narrow" value=${score} onInput=${(e) => setScore(e.target.value)} data-testid="rescue-score-input" /></label>
      <button type="button" class="btn primary" disabled=${score === ""} onClick=${() => run("rescueScore", { score: Number(score) })} data-testid="btn-rescue-score">Save the score</button>
    </div>
  </div>`;
}

function RescuePanel({ view }) {
  const s = view.session, r = s.rescue, g = r.game, cfg = view.rescue;
  const out = s.contestants.filter((c) => c.status === "eliminated");
  const [ids, setIds] = useState([]);
  const pct = g ? rescuePct(g.kind, rescueScore(g), cfg) : 0, max = rescueCount(pct, out.length);
  const intro = !g || g.status === "intro";
  return html`<div class="rescue-panel" data-testid="rescue-panel" data-status=${g?.status || "choose"}>
    <div class="row between"><b>Rescue game${r.attempt > 1 ? `, round ${r.attempt}` : ""}${g ? `: ${rescueInfo(g.kind, cfg).title}` : ""}</b><button type="button" class="btn ghost small" onClick=${() => confirm("Leave the rescue game and go back to the emergency screen?") && run("rescueAbort")} data-testid="btn-rescue-leave">Leave rescue</button></div>
    ${intro && html`<p class="note">Everyone who is out plays as one team. Pick the game, check it on the projector, then start it.</p>
      <div class="row">${RESCUE_KINDS.map((k) => html`<button type="button" class="btn ${g?.kind === k ? "on" : ""}" onClick=${() => run("rescuePick", { kind: k })} data-testid=${`rescue-pick-${k}`}>${rescueInfo(k, cfg).title}</button>`)}</div>
      ${g && html`<ul class="ladder-host">${rescueLadder(g.kind, cfg).map((l) => html`<li>${l}</li>`)}</ul>
        ${g.kind === "doodle" && html`<p class="muted">Countries: ${g.items.map((c) => c.name).join(", ")}</p>`}
        ${g.kind === "semantle" && html`<p class="muted">Puzzle #${g.items.puzzle}. The projector loads it when you start.</p>`}
        ${g.kind === "tower" && html`<p class="muted">${plural(out.length, "person", "people")} out: ${plural(g.items.groups, "group")} of up to ${cfg.tower.groupSize}, one after another.</p>`}
        <button type="button" class="btn primary big" onClick=${() => run("rescueGo")} data-testid="btn-rescue-go">Start ${rescueInfo(g.kind, cfg).title}${g.kind === "tower" && g.items.groups > 1 ? " (group 1)" : ""}</button>`}`}
    ${g && !intro && g.status !== "done" && html`<${RescueGame} g=${g} cfg=${cfg} key=${g.kind} />`}
    ${g && !intro && html`<p class="rescue-tally" data-testid="rescue-tally">Score <b>${rescueScore(g)}</b> → <b>${pct}%</b> → <b>${max} of ${out.length}</b> may return</p>`}
    ${g?.status === "done" && (max > 0 ? html`
      <div class="row"><button type="button" class="btn ghost small" onClick=${() => setIds(out.slice(0, max).map((c) => c.id))} data-testid="return-all">${max >= out.length ? "Select everyone" : `Select the first ${max}`}</button><button type="button" class="btn ghost small" onClick=${() => setIds([])}>Clear</button><span class="muted">${ids.length} of ${max} chosen</span></div>
      <${PickPeople} people=${out} value=${ids} onChange=${setIds} max=${max} testid="return-pick" />
      <button type="button" class="btn primary big" disabled=${!ids.length} onClick=${() => run("rescueApply", { ids })} data-testid="btn-rescue-apply">Return ${plural(ids.length, "contestant")} to the flight</button>`
      : html`<p class="warn">The team did not score enough to bring anyone back. Use an emergency option below, or leave the rescue and try another game.</p>`)}
    <${EmergencyExits} view=${view} />
  </div>`;
}

function Roster({ view }) {
  const s = view.session;
  const [text, setText] = useState("");
  const [count, setCount] = useState(20);
  const act = s.contestants.filter((c) => c.status === "active").length;
  const editable = ["LOBBY", "READY_TO_FLY", "FINISHED"].includes(s.phase);
  const add = async () => { const names = text.split(/[\n,]/).map((n) => n.trim()).filter(Boolean); if (names.length && (await run("addContestants", { names }))) setText(""); };
  const addNumbered = () => run("addContestants", { names: Array.from({ length: Math.max(1, Math.min(300, count | 0)) }, (_, i) => `Contestant ${s.contestants.length + i + 1}`) });
  return html`<aside class="panel roster" data-testid="roster">
    <header class="panel-head"><h2>Roster</h2><span class="tally" data-testid="tally"><b>${act}</b> in, ${s.contestants.length - act} out</span></header>
    <div class="roster-add">
      <textarea rows="2" placeholder="Names, one per line or separated by commas" value=${text} onInput=${(e) => setText(e.target.value)} data-testid="roster-input"></textarea>
      <div class="row"><button type="button" class="btn small primary" onClick=${add} data-testid="roster-add">Add to roster</button>
        <span class="or">or</span><input type="number" min="1" max="300" value=${count} onInput=${(e) => setCount(e.target.value)} aria-label="How many numbered contestants" class="narrow" /><button type="button" class="btn ghost small" onClick=${addNumbered}>Add numbered</button></div>
    </div>
    ${!editable && s.contestants.length > 0 && html`<p class="field-hint">Changes by hand are available between questions.</p>`}
    <ul class="roster-list">${s.contestants.map((c) => html`<li class=${c.status} data-testid=${`r-${c.name}`} data-status=${c.status}>
      <span class="r-name">${c.name}</span>
      <span class="r-state">${c.status === "active" ? "in" : `out at ${c.eliminatedAtStop ?? "?"}`}</span>
      ${editable && html`<button type="button" class="btn ghost tiny" onClick=${() => run("setContestantStatus", { id: c.id, status: c.status === "active" ? "eliminated" : "active" })}>${c.status === "active" ? "Eliminate" : "Restore"}</button>
        <button type="button" class="btn ghost tiny" aria-label=${`Remove ${c.name}`} onClick=${() => confirm(`Remove ${c.name} from the roster?`) && run("removeContestant", { id: c.id })}>Remove</button>`}
    </li>`)}</ul>
    ${s.contestants.length === 0 && html`<p class="muted">No contestants yet. Add everyone who is playing before the first flight.</p>`}
  </aside>`;
}

export function ShowTab({ view, goTo }) {
  const s = view.session, ph = s.phase;
  const [topic, setTopic] = useState(null);
  const [monitor, setMonitor] = useState(() => localStorage.getItem("gb-monitor") !== "off");
  useEffect(() => { if (!["LOBBY", "READY_TO_FLY"].includes(ph)) setTopic(null); }, [ph]);
  const q = s.shown?.question;
  const timed = q && ["video", "audio"].includes(q.presentation);
  const [title, sub] = PHASE_TEXT[ph];
  return html`<div class="show">
    <section class="deck">
      <div class="panel state" data-testid="state" data-phase=${ph}>
        <span class="state-code">${ph}</span>
        <h1>${title}${s.stop > 0 && !["LOBBY", "FINISHED"].includes(ph) ? html`<small> at destination ${s.stop} of 30</small>` : ""}</h1>
        <p>${sub}</p>
      </div>

      ${view.preview && html`<div class="callout preview-on" data-testid="preview-on">A preview is on the projector${view.preview.kind === "flight" ? " (flight)" : view.preview.number ? ` (question ${view.preview.number})` : ""}. The show is paused behind it.
        <button type="button" class="btn small primary" onClick=${() => run("preview.stop")} data-testid="btn-end-preview-show">End preview</button></div>`}

      <${Steps} view=${view} topic=${topic} />

      <div class="panel context">
        ${ph === "LOBBY" && html`<${RulesControls} view=${view} />`}
        ${["LOBBY", "READY_TO_FLY"].includes(ph) && html`<${NextPicker} view=${view} topic=${topic} setTopic=${setTopic} />
          ${ph === "READY_TO_FLY" && html`<div class="row"><button type="button" class="btn" onClick=${() => confirm("End the journey here and show the finale with everyone still in the game as champions?") && run("finishShow")} data-testid="btn-finish">Show the finale</button></div>`}`}
        ${ph === "FLIGHT_ANIMATING" && html`<div class="row"><button type="button" class="btn" onClick=${() => run("skipFlight")} data-testid="btn-skip">Skip the flight animation</button><span class="muted">Skipping lands on the waiting card. It does not show the question.</span></div>`}
        ${ph === "DESTINATION_ARRIVED" && html`<p class="note">Landed at destination ${s.stop}. The audience sees "Awaiting question". Press <b>Show question</b> when you are ready.</p>`}
        ${ph === "QUESTION_VISIBLE" && html`<div class="row"><button type="button" class="btn ghost" onClick=${() => run("hideQuestion")} data-testid="btn-hide">Hide question again</button><span class="muted">The timer is stopped. ${q?.presentation === "video" ? "Play the video. Stop it, or let it finish, to show the question, then start the timer." : `Read the question${timed ? ", play the clip," : ""} then start the timer.`}</span></div>`}
        ${ph === "TIMER_RUNNING" && html`<div class="clock-row"><${TimerReadout} timer=${s.timer} />
          ${s.timer.running ? html`<button type="button" class="btn" onClick=${() => run("pauseTimer")} data-testid="btn-pause">Pause</button>` : html`<button type="button" class="btn primary" onClick=${() => run("resumeTimer")} data-testid="btn-resume">Resume</button>`}
          <button type="button" class="btn" onClick=${() => run("timeUp")} data-testid="btn-timeup">Call time now</button>
          <button type="button" class="btn ghost" onClick=${() => run("resetTimer")} data-testid="btn-reset-timer">Reset timer</button></div>`}
        ${ph === "BOARDS_UP" && html`<div class="row"><span class="note">Boards are up. The answer stays hidden until you press <b>Reveal answer</b>.</span><button type="button" class="btn ghost" onClick=${() => run("resetTimer")}>Run the timer again</button></div>`}
        ${ph === "ANSWER_REVEALED" && html`<button type="button" class="btn primary big" onClick=${() => run("startReview")} data-testid="btn-review">Check boards and eliminate</button>`}
        ${ph === "ELIMINATION_REVIEW" && html`<${Review} view=${view} />`}
        ${ph === "ALL_ELIMINATED" && html`<${AllOut} view=${view} />`}
        ${ph === "RESCUE" && html`<${RescuePanel} view=${view} />`}
        ${ph === "FINISHED" && html`<div class="row"><span class="note">The finale is on the projector.</span><button type="button" class="btn ghost" onClick=${() => run("reopenShow")} data-testid="btn-reopen">Go back to the show</button></div>`}
        ${timed && html`<${MediaControls} mstate=${s.media} video=${q.presentation === "video"} label=${q.presentation === "video" ? "Video on the projector" : "Audio on the projector"} onOp=${(op, value) => run("media", { op, value })} />
          <p class="field-hint">Playing or finishing the clip never starts the countdown.</p>`}
      </div>

      <${HostQuestion} view=${view} />
    </section>

    <section class="side">
      <div class="panel monitor">
        <header class="panel-head"><h2>Projector, live</h2>
          <span class="row"><span class="pstat ${view.projector.connected ? "ok" : "bad"}" data-testid="projector-status">${view.projector.connected ? `${plural(view.projector.connected, "projector")} connected${view.projector.soundOn ? "" : ", sound not turned on"}` : "No projector connected"}</span>
          <button type="button" class="btn ghost tiny" onClick=${() => { localStorage.setItem("gb-monitor", monitor ? "off" : "on"); setMonitor(!monitor); }}>${monitor ? "Hide" : "Show"}</button></span>
        </header>
        ${monitor && html`<div class="monitor-frame"><iframe src="/projector?monitor=1" title="Live copy of the projector" tabindex="-1"></iframe></div>`}
        ${view.projector.connected > 0 && !view.projector.soundOn && html`<p class="field-hint">Click once on the projector window to turn its sound on.</p>`}
        <p class="field-hint">This is exactly what the audience sees. <a href="/projector" target="_blank" rel="noopener">Open the projector window</a></p>
      </div>
      <${Roster} view=${view} />
    </section>
  </div>`;
}
