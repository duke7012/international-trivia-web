// Shared plumbing for both screens: the live connection to the show server, a clock that agrees
// with the server's, and the one function the host dashboard uses to do anything.

let offset = 0; // server time minus this device's time
export const clock = { now: () => Date.now() + offset };

async function syncClock() {
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now(), d0 = Date.now();
    try {
      const { now } = await (await fetch("/api/time", { cache: "no-store" })).json();
      const rtt = performance.now() - t0;
      if (rtt < best) { best = rtt; offset = now + rtt / 2 - (d0 + rtt); }
    } catch { /* offline for a moment; the next state message corrects it */ }
  }
}

// Sign in to the host dashboard. The server answers with a cookie the browser keeps, so the
// password is never stored by this page or put in a web address.
export async function signIn(password) {
  let res;
  try { res = await fetch("/api/host/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }); }
  catch { throw new Error("The show server is not answering."); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Sign-in failed.");
}

// Keeps a live connection open and calls onState with every update. The browser reconnects by
// itself, and the server sends the full current state on every (re)connection, so a refreshed
// or briefly disconnected screen always lands on the truth.
export function connect(role, { onState, onStatus, monitor = false, cid = "" }) {
  syncClock();
  let es, sawState = false;
  const open = () => {
    const q = new URLSearchParams({ role });
    if (monitor) q.set("monitor", "1");
    if (cid) q.set("cid", cid);
    es = new EventSource(`/api/events?${q}`);
    es.addEventListener("state", (e) => {
      const view = JSON.parse(e.data);
      if (!sawState && Math.abs(view.now - clock.now()) > 1500) offset = view.now - Date.now();
      sawState = true;
      if (view.upload) chunkBytes = view.upload.chunkBytes || 0;
      onStatus?.("online");
      onState(view);
    });
    es.onerror = async () => {
      onStatus?.("offline");
      if (role === "host" && es.readyState === EventSource.CLOSED) {
        // A closed (not retrying) connection usually means the host is not signed in.
        const r = await fetch("/api/host/check").catch(() => null);
        if (r && r.status === 401) { onStatus?.("signin"); return; }
        setTimeout(open, 1500);
      }
    };
  };
  open();
  return { reconnect: () => { es?.close(); open(); } };
}

export async function act(type, payload = {}) {
  let res;
  try {
    res = await fetch("/api/host/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, payload }) });
  } catch { throw new Error("The show server is not answering. Check that it is still running."); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || "That did not work."), { errors: body.errors, status: res.status });
  return body;
}

// How this server takes uploads. Set from the host's state: 0 means one request for the whole
// file; a number means the file goes up in pieces of that many bytes (needed on Cloudflare).
let chunkBytes = 0;

const sendPiece = (url, blob, onProgress) => new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", url);
  xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
  xhr.onload = () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch { /* fall through */ }
    xhr.status === 200 ? resolve(body) : reject(Object.assign(new Error(body.error || "The upload failed."), { final: xhr.status < 500 }));
  };
  xhr.onerror = () => reject(new Error("The upload was interrupted. Check the connection and try again."));
  xhr.send(blob);
});

async function uploadInPieces(file, onProgress, area) {
  const call = async (url, init) => {
    const res = await fetch(url, init).catch(() => { throw new Error("The upload was interrupted. Check the connection and try again."); });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "The upload failed.");
    return body;
  };
  const start = await call(`/api/host/upload/start?name=${encodeURIComponent(file.name)}&size=${file.size}${area ? `&area=${area}` : ""}`, { method: "POST" });
  const parts = [];
  for (let offset = 0, n = 1; offset < file.size; offset += start.chunkBytes, n++) {
    const blob = file.slice(offset, offset + start.chunkBytes);
    const url = `/api/host/upload/part?key=${encodeURIComponent(start.key)}&uploadId=${encodeURIComponent(start.uploadId)}&n=${n}`;
    for (let attempt = 1; ; attempt++) { // a dropped piece is retried, not the whole file
      try { parts.push(await sendPiece(url, blob, (sent) => onProgress?.((offset + sent) / file.size))); break; }
      catch (e) { if (e.final || attempt >= 3) throw e; }
    }
  }
  return call("/api/host/upload/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: start.key, uploadId: start.uploadId, parts, name: file.name }) });
}

// Upload with progress. Goes to the show server's storage, not into browser storage.
// `area` is "sounds" for show sounds; question media goes with the active set of questions.
export function upload(file, onProgress, area = "") {
  if (chunkBytes) return uploadInPieces(file, onProgress, area);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/host/upload?name=${encodeURIComponent(file.name)}${area ? `&area=${area}` : ""}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* fall through */ }
      xhr.status === 200 ? resolve(body) : reject(new Error(body.error || "The upload failed."));
    };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check the connection to the show computer and try again."));
    xhr.send(file);
  });
}

export const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
export const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
