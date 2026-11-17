// Questions tab: the numbered slots (30 for the journey, plus any extra topic-pick ones) and the editor.
// Saving here never moves the show: the projector keeps what it has until the host updates it.
import { html, useEffect, useMemo, useRef, useState } from "/vendor/preact/htm-preact.module.js";
import { clock } from "../net.js";
import { QuestionCard } from "../stage.js";
import { mediaReduce, idleMedia, QUESTION_PHASES } from "/shared/engine.mjs";
import { DIFFICULTIES, PRESENTATIONS, PRESENTATION_LABEL, FORMAT_LABEL, TOTAL_STOPS, MAX_QUESTIONS, normalizeQuestion, publishErrors, draftWarnings, answerText } from "/shared/schema.mjs";
import { run, say, excerpt, Field, MediaPicker, MediaControls, toStageMedia } from "./ui.js";

const blankForm = (q) => ({
  country: q.country, topic: q.topic, difficulty: q.difficulty, text: q.text, presentation: q.presentation, answerFormat: q.answerFormat,
  choices: [...q.choices], correctChoice: q.correctChoice, correctAnswer: q.correctAnswer, variants: q.variants.join("\n"), explanation: q.explanation,
  media: q.media ? { ...q.media } : null, hostNotes: q.hostNotes, countdown: q.countdown ?? "",
});

const STATUS = { empty: "Not configured", draft: "Draft", published: "Published" };

function SlotList({ view, selected, onSelect }) {
  const played = new Set(view.session.played.map((p) => p.questionId));
  return html`<ol class="slots" data-testid="slot-list">
    ${view.questions.map((q, i) => {
      const live = view.session.currentQuestionId === q.id && !["LOBBY", "READY_TO_FLY", "FINISHED", "ALL_ELIMINATED", "RESCUE"].includes(view.session.phase);
      const issues = q.status === "draft" ? view.checks[i]?.errors.length : 0;
      return html`${i === TOTAL_STOPS && html`<li class="extra-divider" data-testid="extra-divider"><b>Extra questions</b><span>Only played when a contestant picks a topic</span></li>`}
      <li class="slot ${q.status} ${selected === q.id ? "selected" : ""}" data-testid=${`slot-${i + 1}`} data-status=${q.status}>
        <button type="button" onClick=${() => onSelect(q.id)}>
          <b class="slot-num">${i + 1}</b>
          <span class="slot-main">
            <span class="slot-text">${q.status === "empty" ? "Not configured" : excerpt(q.text || "(no question text yet)", 64)}</span>
            <span class="slot-meta">
              ${q.status !== "empty" && html`<i class="badge ${q.status}">${STATUS[q.status]}</i>`}
              ${live ? html`<i class="badge live">On stage</i>` : played.has(q.id) && html`<i class="badge played">Played</i>`}
              ${q.status !== "empty" && html`<span>${[q.topic, q.country, q.difficulty, PRESENTATION_LABEL[q.presentation]].filter(Boolean).join(", ")}</span>`}
              ${issues > 0 && html`<span class="warn">${issues} to fix before publishing</span>`}
            </span>
          </span>
        </button>
      </li>`;
    })}
  </ol>`;
}

function InlinePreview({ form, number, settings }) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [mstate, setMstate] = useState(idleMedia());
  useEffect(() => setMstate(idleMedia()), [form.media?.src, form.presentation]);
  const q = useMemo(() => {
    const n = normalizeQuestion(form, "preview");
    return { n, stage: { text: n.text || "Your question appears here", presentation: n.presentation, answerFormat: n.answerFormat, choices: n.answerFormat === "choice" ? n.choices.map((c, i) => c || `Choice ${"ABCD"[i]}`) : null, topic: n.topic, media: toStageMedia(n.media), countdown: n.countdown || settings.defaultCountdown } };
  }, [form, settings.defaultCountdown]);
  const answer = showAnswer ? { correctChoice: q.n.answerFormat === "choice" ? q.n.correctChoice : null, text: answerText(q.n) || "(no answer yet)", explanation: q.n.explanation } : null;
  const timed = ["video", "audio"].includes(q.n.presentation) && q.n.media;
  return html`<div class="preview-box">
    <div class="preview-bar">
      <b>Projector preview</b>
      <label class="check"><input type="checkbox" checked=${showAnswer} onChange=${(e) => setShowAnswer(e.target.checked)} data-testid="preview-answer-toggle" /> Show with the answer revealed</label>
    </div>
    <div class="stage-frame" data-testid="inline-preview"><div class="stage">
      <${QuestionCard} key=${q.n.presentation + (q.n.media?.src || "")} q=${q.stage} number=${number} answer=${answer} phase=${answer ? "ANSWER_REVEALED" : "QUESTION_VISIBLE"} timer=${{ idle: true, durationMs: q.stage.countdown * 1000 }} mstate=${mstate} silent=${false} onEnded=${() => setMstate((m) => mediaReduce(m, "ended", clock.now()))} />
    </div></div>
    ${timed && html`<${MediaControls} mstate=${mstate} label="Test the clip here (only you hear it)" onOp=${(op, v) => setMstate((m) => mediaReduce(m, op, clock.now(), v))} />`}
  </div>`;
}

export function QuestionsTab({ view }) {
  const [selected, setSelected] = useState(view.questions[0].id);
  const [form, setForm] = useState(() => blankForm(view.questions[0]));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const index = view.questions.findIndex((q) => q.id === selected);
  const saved = view.questions[index];
  const lastIndex = useRef(0);
  if (index >= 0) lastIndex.current = index;
  const normalized = useMemo(() => normalizeQuestion(form, selected), [form, selected]);

  // If the slot's question was replaced (deleted, demo reset, switch of show), stay on the same slot
  // number, or the last slot when an extra slot at the end was removed.
  useEffect(() => { if (index < 0) { const q = view.questions[Math.min(lastIndex.current, view.questions.length - 1)]; setSelected(q.id); setForm(blankForm(q)); setDirty(false); } }, [index, view.workspace]);
  // A slot just added: open it as soon as it arrives in the live state.
  const [pending, setPending] = useState(null);
  useEffect(() => { const q = pending && view.questions.find((x) => x.id === pending); if (q) { setSelected(q.id); setForm(blankForm(q)); setDirty(false); setPending(null); } }, [view.questions, pending]);
  if (index < 0) return null;

  const select = (id) => {
    if (id === selected) return;
    if (dirty && !confirm("You have unsaved changes in this question. Leave without saving?")) return;
    setSelected(id); setForm(blankForm(view.questions.find((q) => q.id === id))); setDirty(false);
  };
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); };
  const setMedia = (patch) => set({ media: patch === null ? null : { ...(form.media || {}), ...patch } });

  const errors = publishErrors(normalized, view.questions);
  const warnings = draftWarnings(normalized, view.questions);
  const onStage = view.session.currentQuestionId === selected && QUESTION_PHASES.includes(view.session.phase);
  const topics = [...new Set(view.questions.map((q) => q.topic).filter(Boolean))];

  const save = async (status) => {
    setBusy(true);
    const r = await run("bank.save", { id: selected, question: form, status });
    setBusy(false);
    if (!r) return;
    setForm(blankForm(r.question)); setDirty(false);
    say(status === "published" ? `Published question ${index + 1}.${onStage ? " The projector still shows the earlier version until you press Update projector." : ""}` : `Saved question ${index + 1} as a draft.`, "ok");
  };
  const addSlot = async () => {
    if (dirty && !confirm("You have unsaved changes in this question. Leave without saving?")) return;
    const r = await run("bank.add");
    if (r) setPending(r.id);
  };
  const clear = async () => {
    if (!confirm(index < TOTAL_STOPS ? `Delete question ${index + 1}? The slot goes back to "Not configured".` : `Delete extra question ${index + 1}? It is removed from the bank.`)) return;
    if (await run("bank.clear", { id: selected })) { setDirty(false); setSelected(null); }
  };
  const duplicate = async () => {
    if (dirty) { say("Save this question first, then duplicate it.", "error"); return; }
    const r = await run("bank.duplicate", { id: selected });
    if (r) say(`Copied into slot ${r.slot} as a draft. Give the copy its own country before publishing.`, "ok");
  };
  const move = (to) => run("bank.move", { id: selected, to });
  const previewOnProjector = () => run("preview.question", { id: selected, question: form, showAnswer: false });

  const kind = form.presentation;
  const pv = view.preview?.kind === "question" ? view.preview : null;
  return html`<div class="questions">
    <aside class="panel slots-panel">
      <header class="panel-head"><h2>Question slots</h2><span class="muted" data-testid="published-count">${view.questions.filter((q) => q.status === "published").length} of ${view.questions.length} published</span></header>
      <${SlotList} view=${view} selected=${selected} onSelect=${select} />
      <button type="button" class="btn small add-slot" onClick=${addSlot} disabled=${view.questions.length >= MAX_QUESTIONS} data-testid="btn-add-question">Add a question</button>
    </aside>

    <section class="panel editor" data-testid="editor">
      <header class="panel-head editor-head">
        <h2>Question ${index + 1} <i class="badge ${saved.status}" data-testid="editor-status">${STATUS[saved.status]}</i>${dirty && html`<i class="badge unsaved">Unsaved changes</i>`}</h2>
        <div class="row">
          <label class="inline">Move to position <select value=${index} onChange=${(e) => move(Number(e.target.value))} data-testid="move-select">${view.questions.map((_, i) => html`<option value=${i}>${i + 1}</option>`)}</select></label>
          <button type="button" class="btn ghost small" onClick=${() => move(index - 1)} disabled=${index === 0} aria-label="Move up">Up</button>
          <button type="button" class="btn ghost small" onClick=${() => move(index + 1)} disabled=${index === view.questions.length - 1} aria-label="Move down">Down</button>
          <button type="button" class="btn ghost small" onClick=${duplicate} disabled=${saved.status === "empty"} data-testid="btn-duplicate">Duplicate</button>
          <button type="button" class="btn ghost small danger" onClick=${clear} disabled=${saved.status === "empty" && !dirty && index < TOTAL_STOPS} data-testid="btn-delete">Delete</button>
        </div>
      </header>

      ${onStage && html`<p class="callout" data-testid="onstage-note">This question is on the projector right now. Publishing saves your changes, and the projector keeps the earlier version until you press <b>Update projector</b> on the Show tab.</p>`}

      <div class="editor-grid">
        <form class="form" onSubmit=${(e) => e.preventDefault()}>
          <fieldset><legend>How it is presented</legend>
            <div class="seg" role="radiogroup" aria-label="Presentation type">${PRESENTATIONS.map((p) => html`<label class=${kind === p ? "on" : ""}><input type="radio" name="presentation" checked=${kind === p} onChange=${() => set({ presentation: p })} data-testid=${`type-${p}`} />${PRESENTATION_LABEL[p]}</label>`)}</div>
          </fieldset>

          <${Field} label="Question text" wide><textarea rows="3" value=${form.text} onInput=${(e) => set({ text: e.target.value })} placeholder="Type the question exactly as you will read it" data-testid="f-text"></textarea><//>

          ${kind !== "text" && html`<fieldset><legend>${PRESENTATION_LABEL[kind].split(" +")[0]} file</legend>
            <${MediaPicker} kind=${kind} media=${form.media} onChange=${setMedia} allowUrl=${true} />
            ${form.media && kind !== "audio" && html`<div class="grid3">
              <${Field} label="Fit"><select value=${form.media.fit} onChange=${(e) => setMedia({ fit: e.target.value })} data-testid="f-fit"><option value="contain">Contain: show all of it</option><option value="cover">Cover: fill the frame, crop the rest</option></select><//>
              <${Field} label=${`Size ${Math.round((form.media.zoom || 1) * 100)}%`}><input type="range" min="0.5" max="3" step="0.05" value=${form.media.zoom} onInput=${(e) => setMedia({ zoom: Number(e.target.value) })} data-testid="f-zoom" /><//>
              <${Field} label="Crop position" hint="Which part stays in view">
                <span class="row"><input type="range" min="0" max="100" value=${form.media.focusX} onInput=${(e) => setMedia({ focusX: Number(e.target.value) })} aria-label="Horizontal position" /><input type="range" min="0" max="100" value=${form.media.focusY} onInput=${(e) => setMedia({ focusY: Number(e.target.value) })} aria-label="Vertical position" /></span>
              <//>
            </div>`}
            ${form.media && kind !== "image" && html`<div class="grid3">
              <${Field} label="Clip starts at (seconds)"><input type="number" min="0" step="0.1" value=${form.media.clipStart} onInput=${(e) => setMedia({ clipStart: e.target.value })} data-testid="f-clip-start" /><//>
              <${Field} label="Clip ends at (seconds)" hint="Leave empty to play to the end"><input type="number" min="0" step="0.1" value=${form.media.clipEnd ?? ""} onInput=${(e) => setMedia({ clipEnd: e.target.value })} data-testid="f-clip-end" /><//>
            </div>`}
          </fieldset>`}

          <fieldset><legend>How contestants answer</legend>
            <div class="seg" role="radiogroup" aria-label="Answer format">${["choice", "written"].map((a) => html`<label class=${form.answerFormat === a ? "on" : ""}><input type="radio" name="format" checked=${form.answerFormat === a} onChange=${() => set({ answerFormat: a })} data-testid=${`format-${a}`} />${FORMAT_LABEL[a]}</label>`)}</div>
            ${form.answerFormat === "choice"
              ? html`<div class="choices-edit">${form.choices.map((c, i) => html`<label class="choice-row ${form.correctChoice === i ? "correct" : ""}">
                  <input type="radio" name="correct" checked=${form.correctChoice === i} onChange=${() => set({ correctChoice: i })} aria-label=${`Choice ${"ABCD"[i]} is correct`} data-testid=${`f-correct-${i}`} />
                  <b>${"ABCD"[i]}</b>
                  <input type="text" value=${c} onInput=${(e) => set({ choices: form.choices.map((x, j) => (j === i ? e.target.value : x)) })} placeholder=${`Choice ${"ABCD"[i]}`} data-testid=${`f-choice-${i}`} />
                </label>`)}<p class="field-hint">Select the circle next to the correct choice.</p></div>`
              : html`<div class="grid2">
                  <${Field} label="Correct answer"><input type="text" value=${form.correctAnswer} onInput=${(e) => set({ correctAnswer: e.target.value })} data-testid="f-answer" /><//>
                  <${Field} label="Also accept" hint="One per line: spellings, short forms"><textarea rows="2" value=${form.variants} onInput=${(e) => set({ variants: e.target.value })} data-testid="f-variants"></textarea><//>
                </div>`}
          </fieldset>

          <div class="grid3">
            <${Field} label="Country focus"><input type="text" value=${form.country} onInput=${(e) => set({ country: e.target.value })} data-testid="f-country" /><//>
            <${Field} label="Topic"><input type="text" list="topic-list" value=${form.topic} onInput=${(e) => set({ topic: e.target.value })} data-testid="f-topic" /><datalist id="topic-list">${topics.map((t) => html`<option value=${t} />`)}</datalist><//>
            <${Field} label="Difficulty"><select value=${form.difficulty} onChange=${(e) => set({ difficulty: e.target.value })} data-testid="f-difficulty">${DIFFICULTIES.map((d) => html`<option value=${d}>${d[0].toUpperCase() + d.slice(1)}</option>`)}</select><//>
          </div>
          <${Field} label="Explanation" hint="Shown to the audience with the answer" wide><textarea rows="2" value=${form.explanation} onInput=${(e) => set({ explanation: e.target.value })} data-testid="f-explanation"></textarea><//>
          <div class="grid2">
            <${Field} label="Host notes" hint="Only ever shown on this dashboard"><textarea rows="2" value=${form.hostNotes} onInput=${(e) => set({ hostNotes: e.target.value })} data-testid="f-notes"></textarea><//>
            <${Field} label="Countdown (seconds)" hint=${`Leave empty for the show default, ${view.settings.defaultCountdown} seconds`}><input type="number" min="3" max="300" value=${form.countdown} onInput=${(e) => set({ countdown: e.target.value })} placeholder=${view.settings.defaultCountdown} data-testid="f-countdown" /><//>
          </div>

          ${errors.length > 0 && html`<div class="checklist" data-testid="publish-errors"><b>Before this can be published</b><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`}
          ${warnings.length > 0 && html`<div class="checklist soft"><ul>${warnings.map((w) => html`<li>${w}</li>`)}</ul></div>`}

          <div class="actions">
            <button type="button" class="btn" onClick=${() => save("draft")} disabled=${busy || onStage} title=${onStage ? "A question on stage has to stay published" : ""} data-testid="btn-save-draft">Save draft</button>
            <button type="button" class="btn primary" onClick=${() => save("published")} disabled=${busy || errors.length > 0} data-testid="btn-publish">Publish</button>
            ${pv
              ? html`<button type="button" class="btn warn" onClick=${() => run("preview.stop")} data-testid="btn-end-preview">End projector preview</button>`
              : html`<button type="button" class="btn" onClick=${previewOnProjector} data-testid="btn-preview-projector">Preview on projector</button>`}
          </div>
          ${pv && ["video", "audio"].includes(pv.presentation) && html`<div data-testid="preview-media"><${MediaControls} mstate=${pv.media} label="Clip on the projector preview" onOp=${(op, value) => run("preview.media", { op, value })} /></div>`}
          <p class="field-hint">Previews carry a "Preview" banner and never move the show. While a question is live on the projector, use the preview on this page.</p>
        </form>

        <${InlinePreview} form=${form} number=${index + 1} settings=${view.settings} />
      </div>
    </section>
  </div>`;
}
