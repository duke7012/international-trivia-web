// Host dashboard shell: tabs, live connection, notices, and the live/demo switch.
import { html, render, useEffect, useState } from "/vendor/preact/htm-preact.module.js";
import { connect, signIn } from "../net.js";
import { run, onNotice } from "./ui.js";
import { ShowTab } from "./show.js";
import { QuestionsTab } from "./editor.js";
import { RescueTab, SettingsTab } from "./setup.js";

const TABS = [["show", "Show"], ["questions", "Questions"], ["rescue", "Rescue"], ["settings", "Settings"]];

function App() {
  const [view, setView] = useState(null);
  const [status, setStatus] = useState("connecting");
  const [tab, setTab] = useState(() => (TABS.some(([k]) => k === location.hash.slice(1)) ? location.hash.slice(1) : "show"));
  const [notice, setNotice] = useState(null);
  const [conn, setConn] = useState(null);
  const [signInError, setSignInError] = useState("");

  useEffect(() => {
    onNotice(setNotice);
    setConn(connect("host", { onState: setView, onStatus: setStatus }));
  }, []);
  useEffect(() => { history.replaceState(null, "", "#" + tab); }, [tab]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), notice.kind === "error" ? 9000 : 4000); return () => clearTimeout(t); }, [notice]);

  if (status === "signin") {
    const submit = async (e) => {
      e.preventDefault();
      try { await signIn(new FormData(e.target).get("password")); setSignInError(""); setStatus("connecting"); conn.reconnect(); }
      catch (err) { setSignInError(err.message); }
    };
    return html`<form class="pin" onSubmit=${submit} data-testid="signin">
      <h1>Host sign-in</h1><p>Only the host can open this dashboard. Enter the host password (or the PIN shown in the show server's window).</p>
      <input name="password" type="password" autocomplete="current-password" autofocus aria-label="Host password" data-testid="signin-password" />
      ${signInError && html`<p class="form-error" role="alert" data-testid="signin-error">${signInError}</p>`}
      <button class="btn primary" data-testid="signin-submit">Open the dashboard</button>
    </form>`;
  }
  if (!view) return html`<p class="loading">Connecting to the show server…</p>`;

  const demo = view.workspace === "demo";
  const switchTo = (name) => {
    if (name === view.workspace) return;
    const msg = name === "demo"
      ? "Switch to the demo set for a rehearsal? Your live questions and live show are kept exactly as they are and stay separate."
      : "Switch back to the live show? The demo set is kept separately.";
    if (confirm(msg)) run("workspace.set", { name });
  };
  const notReady = view.questions.filter((q) => q.status !== "published").length;

  return html`<div class="app ${demo ? "is-demo" : ""}">
    <header class="top">
      <div class="top-brand"><b>Golden Bell</b><span>Host dashboard</span></div>
      <nav class="tabs" aria-label="Sections">${TABS.map(([k, label]) => html`<button type="button" class=${tab === k ? "on" : ""} onClick=${() => setTab(k)} data-testid=${`tab-${k}`} aria-current=${tab === k ? "page" : null}>${label}${k === "questions" && notReady > 0 ? html`<i>${30 - notReady}/30</i>` : ""}</button>`)}</nav>
      <div class="top-end">
        <div class="seg small ws" role="radiogroup" aria-label="Which set of content is in use">
          <label class=${!demo ? "on" : ""}><input type="radio" checked=${!demo} onChange=${() => switchTo("live")} data-testid="ws-live" />Live show</label>
          <label class=${demo ? "on" : ""}><input type="radio" checked=${demo} onChange=${() => switchTo("demo")} data-testid="ws-demo" />Demo rehearsal</label>
        </div>
        <span class="conn ${status}" data-testid="conn">${status === "online" ? "Connected" : "Reconnecting…"}</span>
      </div>
    </header>
    ${demo && html`<p class="demo-bar" data-testid="demo-bar">Rehearsal mode. You are using the demo questions. Nothing here touches your live question bank or live show.</p>`}
    ${notice && html`<div class="notice ${notice.kind}" role=${notice.kind === "error" ? "alert" : "status"} data-testid="notice" onClick=${() => setNotice(null)}>${notice.text}</div>`}
    <main>
      ${tab === "show" && html`<${ShowTab} view=${view} goTo=${setTab} />`}
      ${tab === "questions" && html`<${QuestionsTab} view=${view} key=${view.workspace} />`}
      ${tab === "rescue" && html`<${RescueTab} view=${view} key=${view.workspace} />`}
      ${tab === "settings" && html`<${SettingsTab} view=${view} key=${view.workspace} />`}
    </main>
  </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
