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

const pinKey = "gb-host-pin";
export const getPin = () => sessionStorage.getItem(pinKey) || "";
export const setPin = (p) => sessionStorage.setItem(pinKey, p);

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
    if (role === "host" && getPin()) q.set("pin", getPin());
    es = new EventSource(`/api/events?${q}`);
    es.addEventListener("state", (e) => {
      const view = JSON.parse(e.data);
      if (!sawState && Math.abs(view.now - clock.now()) > 1500) offset = view.now - Date.now();
      sawState = true;
      onStatus?.("online");
      onState(view);
    });
    es.onerror = async () => {
      onStatus?.("offline");
      if (role === "host" && es.readyState === EventSource.CLOSED) {
        // A closed (not retrying) connection usually means the PIN was refused.
        const r = await fetch("/api/host/check", { headers: { "x-host-pin": getPin() } }).catch(() => null);
        if (r && r.status === 401) { onStatus?.("pin"); return; }
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
    res = await fetch("/api/host/action", { method: "POST", headers: { "content-type": "application/json", "x-host-pin": getPin() }, body: JSON.stringify({ type, payload }) });
  } catch { throw new Error("The show server is not answering. Check that it is still running."); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || "That did not work."), { errors: body.errors, status: res.status });
  return body;
}

// Upload with progress. Streams to the show computer's disk, not into browser storage.
export function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/host/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("x-host-pin", getPin());
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
