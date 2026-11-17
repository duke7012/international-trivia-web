// Small shared pieces for the host dashboard.
import { html, useState } from "/vendor/preact/htm-preact.module.js";
import { act, upload, fmtBytes } from "../net.js";
import { youtubeId, mediaKind } from "/shared/schema.mjs";

// One place where every host action goes, so failures always surface as a readable message.
let notify = () => {};
export const onNotice = (fn) => { notify = fn; };
export const say = (text, kind = "info") => notify({ text, kind, at: Date.now() });
export async function run(type, payload) {
  try { return await act(type, payload); }
  catch (e) { say(e.message, "error"); return null; }
}

export const excerpt = (t, n = 70) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

export const PHASE_TEXT = {
  LOBBY: ["Before the show", "The projector shows the title screen and the plane at the home airport."],
  FLIGHT_ANIMATING: ["Flying", "The plane is in the air. No question is on screen."],
  DESTINATION_ARRIVED: ["Landed, question hidden", "The projector shows the waiting card. The question is hidden until you show it."],
  QUESTION_VISIBLE: ["Question on screen, timer stopped", "Read the question aloud. The countdown has not started."],
  TIMER_RUNNING: ["Timer running", "Contestants are writing. The answer is hidden."],
  BOARDS_UP: ["Boards up", "Time is up. The answer is still hidden until you reveal it."],
  ANSWER_REVEALED: ["Answer on screen", "The correct answer is showing."],
  ELIMINATION_REVIEW: ["Checking boards", "Mark who got it wrong, then confirm."],
  READY_TO_FLY: ["Between questions", "The plane is waiting at the destination."],
  ALL_ELIMINATED: ["Everyone is out", "The projector shows the emergency screen. Nothing moves until you start a rescue or an emergency return."],
  RESCUE: ["Rescue mission", "MAYDAY! Save the flight!"],
  FINISHED: ["Show finished", "The projector shows the finale."],
};

export function Field({ label, hint, children, wide }) {
  return html`<label class="field ${wide ? "wide" : ""}"><span class="field-label">${label}</span>${children}${hint && html`<span class="field-hint">${hint}</span>`}</label>`;
}

// The form's media in the shape the projector card expects.
export const toStageMedia = (m) => m && { src: m.src, fit: m.fit || "contain", zoom: Number(m.zoom) || 1, focusX: Number(m.focusX ?? 50), focusY: Number(m.focusY ?? 50), clipStart: Number(m.clipStart) || 0, clipEnd: m.clipEnd === "" || m.clipEnd == null ? null : Number(m.clipEnd), youtube: youtubeId(m.src) };

const ACCEPT = { image: "image/*", video: "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v,.ogv", audio: "audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac" };

// Upload a file to the show computer's disk, or link to one by URL.
export function MediaPicker({ kind, media, onChange, allowUrl = true }) {
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const pick = async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    setError(""); setProgress(0);
    try {
      const up = await upload(file, setProgress);
      if (up.kind && up.kind !== kind) { setError(`That file is ${up.kind}, but this question is set to ${kind}. Change the presentation type or choose another file.`); return; }
      onChange({ ...(media || {}), src: up.src, name: up.name, mime: up.mime, size: up.size, fit: media?.fit || "contain", zoom: media?.zoom || 1, focusX: media?.focusX ?? 50, focusY: media?.focusY ?? 50, clipStart: 0, clipEnd: null });
    } catch (err) { setError(err.message); } finally { setProgress(null); }
  };
  const useUrl = () => {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) { setError("A link has to start with http:// or https://"); return; }
    const k = mediaKind({ src: u, mime: "" });
    if (k && k !== kind) { setError(`That link looks like ${k}, but this question is set to ${kind}.`); return; }
    setError(""); setUrl("");
    onChange({ src: u, name: "", mime: "", size: 0, fit: "contain", zoom: 1, focusX: 50, focusY: 50, clipStart: 0, clipEnd: null });
  };
  return html`<div class="media-picker">
    ${media
      ? html`<div class="media-current">
          <div class="media-thumb">${kind === "image" ? html`<img src=${media.src} alt="" />` : kind === "video" && !youtubeId(media.src) ? html`<video src=${media.src} muted preload="metadata"></video>` : html`<span>${kind === "audio" ? "Audio" : "Video link"}</span>`}</div>
          <div class="media-meta">
            <b data-testid="media-name">${media.name || (youtubeId(media.src) ? "YouTube video" : "Linked file")}</b>
            <span>${media.size ? fmtBytes(media.size) + ", saved on the show computer" : excerpt(media.src, 60)}</span>
            <span class="field-hint">The audience never sees the file name.</span>
          </div>
          <button type="button" class="btn ghost small" onClick=${() => onChange(null)}>Remove</button>
        </div>`
      : html`<div class="media-empty">
          <label class="btn small" data-testid="upload-button">Upload ${kind}<input type="file" accept=${ACCEPT[kind]} onChange=${pick} hidden data-testid="upload-input" /></label>
          ${allowUrl && html`<span class="or">or</span><input type="url" placeholder=${kind === "video" ? "Paste a video link (mp4, webm or YouTube)" : `Paste a link to the ${kind}`} value=${url} onInput=${(e) => setUrl(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && (e.preventDefault(), useUrl())} /><button type="button" class="btn ghost small" onClick=${useUrl}>Use link</button>`}
        </div>`}
    ${progress !== null && html`<div class="progress" role="progressbar" aria-valuenow=${Math.round(progress * 100)}><i style=${`width:${progress * 100}%`}></i><span>Uploading, ${Math.round(progress * 100)}%</span></div>`}
    ${error && html`<p class="form-error" data-testid="media-error">${error}</p>`}
    ${media && youtubeId(media.src) && html`<p class="field-hint">YouTube needs an internet connection at the venue. An uploaded file is safer for a live show.</p>`}
  </div>`;
}

// Host controls for a clip. They only ever send play, pause, replay and mute.
export function MediaControls({ mstate, onOp, label }) {
  const st = mstate || { status: "idle", muted: false };
  return html`<div class="media-controls" data-testid="media-controls" data-status=${st.status}>
    <span class="mc-label">${label} <i class="mc-state">${{ idle: "ready", playing: "playing", paused: "paused", ended: "finished" }[st.status]}</i></span>
    ${st.status === "playing"
      ? html`<button type="button" class="btn small" onClick=${() => onOp("pause")} data-testid="media-pause">Pause</button>`
      : html`<button type="button" class="btn small primary" onClick=${() => onOp("play")} data-testid="media-play">${st.status === "paused" ? "Resume" : "Play"}</button>`}
    <button type="button" class="btn small" onClick=${() => onOp("replay")} data-testid="media-replay">Replay from start</button>
    <button type="button" class="btn small ${st.muted ? "on" : ""}" onClick=${() => onOp("mute", !st.muted)} data-testid="media-mute" aria-pressed=${String(!!st.muted)}>${st.muted ? "Unmute" : "Mute"}</button>
  </div>`;
}
