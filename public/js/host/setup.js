// Rescue tab (clues and rules, stored apart from the question bank) and Settings tab.
// Both are re-created when the host switches between the live show and the demo set, so each
// starts from that set's saved values.
import { html, useRef, useState } from "/vendor/preact/htm-preact.module.js";
import { upload } from "../net.js";
import { EMERGENCY_RULES, clueReady, SOUND_CUES, cueForFile } from "/shared/schema.mjs";
import { run, say, Field, MediaPicker } from "./ui.js";

const RULE_LABEL = { all: "Everyone returns", half: "Half return, rounded up", upTo: "Up to a number return", none: "Nobody returns (host uses the emergency rule)" };

export function RescueTab({ view }) {
  const [r, setR] = useState(() => structuredClone(view.rescue));
  const [dirty, setDirty] = useState(false);
  const set = (patch) => { setR((x) => ({ ...x, ...patch })); setDirty(true); };
  const setClue = (i, patch) => set({ clues: r.clues.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const save = async () => {
    const payload = { ...r, clues: r.clues.map((c) => ({ ...c, variants: typeof c.variants === "string" ? c.variants.split(/[\n;,]/) : c.variants })) };
    if (await run("rescue.save", { rescue: payload })) { setDirty(false); say("Rescue mission saved.", "ok"); }
  };
  const ready = r.clues.filter((c) => clueReady({ ...c, answer: (c.answer || "").trim(), prompt: (c.prompt || "").trim() })).length;
  return html`<div class="setup">
    <section class="panel">
      <header class="panel-head"><h2>MAYDAY! Save the flight! Destination clues</h2><span class="muted" data-testid="clues-ready">${ready} ready. Each rescue uses three.</span></header>
      <p class="muted">These clues are separate from the 30 main questions. The rescue only becomes available when every contestant has been eliminated, and only starts when you press the button. Add more than three so a retry gets fresh clues.</p>
      <ol class="clue-edit">
        ${r.clues.map((c, i) => html`<li data-testid=${`clue-edit-${i}`}>
          <div class="grid2">
            <${Field} label=${`Clue ${i + 1}: prompt shown to the crew`} hint="A landmark, flag, cultural object or short text"><textarea rows="2" value=${c.prompt} onInput=${(e) => setClue(i, { prompt: e.target.value })} data-testid=${`clue-prompt-${i}`}></textarea><//>
            <div>
              <${Field} label="Destination (the answer)"><input type="text" value=${c.answer} onInput=${(e) => setClue(i, { answer: e.target.value })} data-testid=${`clue-answer-${i}`} /><//>
              <${Field} label="Also accept"><input type="text" value=${Array.isArray(c.variants) ? c.variants.join(", ") : c.variants} onInput=${(e) => setClue(i, { variants: e.target.value })} placeholder="Separated by commas" /><//>
            </div>
          </div>
          <div class="grid2">
            <div><span class="field-label">Image (optional)</span><${MediaPicker} kind="image" media=${c.image} onChange=${(m) => setClue(i, { image: m })} allowUrl=${true} /></div>
            <${Field} label="Host notes"><input type="text" value=${c.hostNotes || ""} onInput=${(e) => setClue(i, { hostNotes: e.target.value })} /><//>
          </div>
          <div class="row"><button type="button" class="btn ghost small danger" onClick=${() => set({ clues: r.clues.filter((_, j) => j !== i) })}>Delete clue ${i + 1}</button>
            ${i > 0 && html`<button type="button" class="btn ghost small" onClick=${() => { const cl = [...r.clues]; [cl[i - 1], cl[i]] = [cl[i], cl[i - 1]]; set({ clues: cl }); }}>Move up</button>`}</div>
        </li>`)}
      </ol>
      <button type="button" class="btn" onClick=${() => set({ clues: [...r.clues, { id: "", prompt: "", answer: "", variants: [], image: null, hostNotes: "" }] })} data-testid="btn-add-clue">Add a clue</button>
    </section>

    <section class="panel">
      <header class="panel-head"><h2>Rescue rules</h2></header>
      <div class="grid3">
        <${Field} label="Rescue clock (seconds)" hint="One clock for all three clues"><input type="number" min="15" max="900" value=${r.timerSec} onInput=${(e) => set({ timerSec: e.target.value })} data-testid="rescue-timer" /><//>
      </div>
      <table class="rules"><tbody>
        ${[3, 2, 1, 0].map((k) => html`<tr>
          <th>${k} correct</th>
          <td><select value=${r.rules[k].type} onChange=${(e) => set({ rules: { ...r.rules, [k]: e.target.value === "upTo" ? { type: "upTo", n: r.rules[k].n || 3 } : { type: e.target.value } } })} data-testid=${`rule-${k}`}>${Object.entries(RULE_LABEL).map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></td>
          <td>${r.rules[k].type === "upTo" && html`<label class="inline">up to <input type="number" min="1" max="999" class="narrow" value=${r.rules[k].n} onInput=${(e) => set({ rules: { ...r.rules, [k]: { type: "upTo", n: e.target.value } } })} data-testid=${`rule-n-${k}`} /> contestants</label>`}</td>
        </tr>`)}
      </tbody></table>
      <${Field} label="Emergency continuation rule" hint="Used when a rescue returns nobody, or whenever you choose to skip the rescue">
        <select value=${r.emergencyRule} onChange=${(e) => set({ emergencyRule: e.target.value })} data-testid="emergency-rule">${Object.entries(EMERGENCY_RULES).map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
      <//>
      <p class="muted">For a partial rescue you choose on the night between drawing names at random and picking them yourself. Only eliminated contestants can ever be picked.</p>
    </section>

    <div class="savebar ${dirty ? "dirty" : ""}"><span>${dirty ? "You have unsaved rescue changes." : "Rescue mission is saved."}</span><button type="button" class="btn primary" onClick=${save} disabled=${!dirty} data-testid="btn-save-rescue">Save rescue mission</button></div>
  </div>`;
}

// How long a sound file runs, read by the browser. The show uses this for the two lead-ins.
const durationOf = (src) => new Promise((resolve) => {
  const a = new Audio();
  a.preload = "metadata";
  a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0);
  a.onerror = () => resolve(0);
  a.src = src;
});
const seconds = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

// Show sounds: the host's own audio for each moment. Shared by the live show and the demo set.
function SoundsPanel({ view }) {
  const sounds = view.sounds || {};
  const [busy, setBusy] = useState("");
  const [playing, setPlaying] = useState(null);
  const audio = useRef(null);
  const count = SOUND_CUES.filter((c) => sounds[c.id]).length;

  const add = async (files, forcedId) => {
    const next = { ...sounds }, skipped = [];
    for (const file of files) {
      const id = forcedId || cueForFile(file.name);
      if (!id) { skipped.push(file.name); continue; }
      setBusy(`Adding ${file.name}`);
      try {
        const up = await upload(file, null, "sounds");
        next[id] = { src: up.src, name: file.name, durationMs: await durationOf(up.src) };
      } catch (e) { say(`${file.name}: ${e.message}`, "error"); }
    }
    setBusy("");
    if (await run("sounds.save", { sounds: next })) {
      if (skipped.length) say(`Not sure where these belong, so they were left out: ${skipped.join(", ")}. Add each one with the button next to its moment.`, "error");
      else say("Show sounds updated.", "ok");
    }
  };
  const remove = (id) => { const next = { ...sounds }; delete next[id]; run("sounds.save", { sounds: next }); };
  const toggle = (id) => {
    audio.current?.pause();
    if (playing === id) { setPlaying(null); return; }
    const a = new Audio(sounds[id].src);
    a.onended = () => setPlaying(null);
    audio.current = a; setPlaying(id);
    a.play().catch(() => setPlaying(null));
  };
  const pick = (id) => (e) => { const files = [...e.target.files]; e.target.value = ""; if (files.length) add(files, id); };

  return html`<section class="panel" data-testid="sounds-panel">
    <header class="panel-head"><h2>Show sounds</h2><span class="muted" data-testid="sounds-count">${count} of ${SOUND_CUES.length} moments use your own sound</span></header>
    <p class="muted">Use your own audio for each moment of the show. Add all your files at once and each one is matched to its moment by its file name. A moment with no file uses the built-in sound. These sounds are shared by the live show and the demo rehearsal.</p>
    <div class="row">
      <label class="btn primary" data-testid="sounds-add">Add sound files<input type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac" multiple hidden onChange=${pick(null)} data-testid="sounds-input" /></label>
      ${busy && html`<span class="muted" role="status">${busy}…</span>`}
    </div>
    <ul class="sound-list">
      ${SOUND_CUES.map((c) => {
        const s = sounds[c.id];
        return html`<li class=${s ? "has" : ""} data-testid=${`sound-${c.id}`} data-set=${s ? "yes" : "no"}>
          <div class="sound-what"><b>${c.label}</b><span class="muted">${c.when}</span></div>
          <div class="sound-file">${s ? html`<span data-testid=${`sound-name-${c.id}`}>${s.name}</span><span class="muted">${s.durationMs ? seconds(s.durationMs) : "length unknown"}</span>` : html`<span class="muted">Built-in sound</span>`}</div>
          <div class="row">
            ${s && html`<button type="button" class="btn small ${playing === c.id ? "on" : ""}" onClick=${() => toggle(c.id)}>${playing === c.id ? "Stop" : "Listen"}</button>`}
            <label class="btn ghost small">${s ? "Replace" : "Choose file"}<input type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac" hidden onChange=${pick(c.id)} data-testid=${`sound-input-${c.id}`} /></label>
            ${s && html`<button type="button" class="btn ghost small danger" onClick=${() => remove(c.id)} data-testid=${`sound-remove-${c.id}`}>Remove</button>`}
          </div>
        </li>`;
      })}
    </ul>
    <p class="field-hint">With a timer lead-in, pressing Start timer plays it first and the countdown begins when it ends. With an answer lead-in, pressing Reveal answer plays it first and the answer appears when it ends. While a question's own video or audio clip plays, the question music pauses.</p>
  </section>`;
}

export function SettingsTab({ view }) {
  const [st, setSt] = useState(() => ({ ...view.settings }));
  const [dirty, setDirty] = useState(false);
  const set = (patch) => { setSt((x) => ({ ...x, ...patch })); setDirty(true); };
  const save = async () => { if (await run("settings.save", { settings: st })) { setDirty(false); say("Settings saved.", "ok"); } };
  const idle = ["LOBBY", "READY_TO_FLY", "DESTINATION_ARRIVED", "FINISHED"].includes(view.session.phase);
  const demo = view.workspace === "demo";
  return html`<div class="setup">
    <section class="panel">
      <header class="panel-head"><h2>Show</h2></header>
      <div class="grid3">
        <${Field} label="Show title"><input type="text" value=${st.showTitle} onInput=${(e) => set({ showTitle: e.target.value })} /><//>
        <${Field} label="Default countdown (seconds)"><input type="number" min="3" max="300" value=${st.defaultCountdown} onInput=${(e) => set({ defaultCountdown: e.target.value })} data-testid="set-countdown" /><//>
        <${Field} label="Flight length (seconds)" hint="You can always skip a flight"><input type="number" min="2" max="30" step="0.5" value=${st.flightSeconds} onInput=${(e) => set({ flightSeconds: e.target.value })} data-testid="set-flight" /><//>
        <${Field} label="Built-in timer sound" hint="Used when you have not added your own countdown sound"><select value=${st.timerSound} onChange=${(e) => set({ timerSound: e.target.value })}><option value="ticks">Ticks, then a bell</option><option value="pulse">Soft pulses, then a bell</option><option value="off">No timer sound</option></select><//>
        <${Field} label=${`Projector volume ${Math.round(st.volume * 100)}%`}><input type="range" min="0" max="1" step="0.05" value=${st.volume} onInput=${(e) => set({ volume: Number(e.target.value) })} /><//>
        <label class="check"><input type="checkbox" checked=${st.showNames} onChange=${(e) => set({ showNames: e.target.checked })} /> Show contestant names on the projector</label>
      </div>
    </section>

    <${SoundsPanel} view=${view} />

    <section class="panel">
      <header class="panel-head"><h2>Topic choice and difficulty</h2></header>
      <label class="check"><input type="checkbox" checked=${st.matchDifficulty} onChange=${(e) => set({ matchDifficulty: e.target.checked })} /> When a contestant picks a topic, draw a question of the difficulty that fits the stage of the journey</label>
      <div class="grid3">
        <${Field} label="Easy up to destination"><input type="number" min="0" max="30" value=${st.easyUntil} onInput=${(e) => set({ easyUntil: e.target.value })} /><//>
        <${Field} label="Medium up to destination" hint="Hard after that"><input type="number" min="0" max="30" value=${st.mediumUntil} onInput=${(e) => set({ mediumUntil: e.target.value })} /><//>
      </div>
    </section>

    <div class="savebar ${dirty ? "dirty" : ""}"><span>${dirty ? "You have unsaved settings." : "Settings are saved."}</span><button type="button" class="btn primary" onClick=${save} disabled=${!dirty} data-testid="btn-save-settings">Save settings</button></div>

    <section class="panel">
      <header class="panel-head"><h2>Preview the flight</h2></header>
      <p class="muted">Plays the airplane animation on the projector under a "Preview" banner. It works with an empty question bank and never changes the show.</p>
      <div class="row">
        <button type="button" class="btn" disabled=${!idle || !!view.preview} onClick=${() => run("preview.flight", {})} data-testid="btn-preview-flight">Preview the next flight</button>
        <button type="button" class="btn" disabled=${!idle || !!view.preview} onClick=${() => run("preview.flight", { tour: true })} data-testid="btn-preview-tour">Tour all 30 destinations</button>
        ${view.preview && html`<button type="button" class="btn warn" onClick=${() => run("preview.stop")} data-testid="btn-end-preview-settings">End preview</button>`}
      </div>
      ${!idle && html`<p class="field-hint">Available between questions.</p>`}
    </section>

    <section class="panel">
      <header class="panel-head"><h2>Start over</h2></header>
      <div class="row">
        <button type="button" class="btn warn" onClick=${() => confirm("Start a new show? The plane returns to the home airport and every contestant is back in. Questions are kept.") && run("resetShow", {})} data-testid="btn-reset-show">Start a new show, keep the roster</button>
        <button type="button" class="btn warn" onClick=${() => confirm("Start a new show and clear the roster? Questions are kept.") && run("resetShow", { clearRoster: true })}>Start a new show, clear the roster</button>
        ${demo && html`<button type="button" class="btn warn" onClick=${() => confirm("Reset the demo questions, demo rescue clues and demo show to how they shipped?") && run("demo.reset")} data-testid="btn-reset-demo">Reset the demo set</button>`}
      </div>
      <p class="muted">Questions, rescue clues, media and the state of the show are saved on this computer as you go, so closing the browser or restarting the app keeps everything.</p>
    </section>
  </div>`;
}
