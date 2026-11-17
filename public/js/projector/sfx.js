// Every sound the projector makes is synthesised here, so the show needs no audio files and
// works offline. Browsers only allow sound after a click on the page, so the projector asks for
// one click ("arming") after each load.
let ctx = null, master = null, volume = 0.8;

export const sfx = {
  armed: false,
  arm() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC(); master = ctx.createGain(); master.gain.value = volume; master.connect(ctx.destination);
    }
    ctx.resume?.();
    this.armed = true;
    return true;
  },
  setVolume(v) { volume = v; if (master) master.gain.value = v; },
};

function tone({ f = 440, to = null, t = 0, d = 0.2, type = "sine", g = 0.3, attack = 0.005 }) {
  if (!sfx.armed || !ctx || volume <= 0) return;
  const t0 = ctx.currentTime + t, o = ctx.createOscillator(), a = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + d);
  a.gain.setValueAtTime(0.0001, t0); a.gain.exponentialRampToValueAtTime(g, t0 + attack); a.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  o.connect(a).connect(master); o.start(t0); o.stop(t0 + d + 0.05);
}
function noise({ t = 0, d = 0.5, g = 0.2, from = 400, to = 3000 }) {
  if (!sfx.armed || !ctx || volume <= 0) return;
  const t0 = ctx.currentTime + t, n = Math.floor(ctx.sampleRate * d), buf = ctx.createBuffer(1, n, ctx.sampleRate), data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), a = ctx.createGain();
  src.buffer = buf; flt.type = "bandpass"; flt.Q.value = 0.8;
  flt.frequency.setValueAtTime(from, t0); flt.frequency.exponentialRampToValueAtTime(to, t0 + d);
  a.gain.setValueAtTime(0.0001, t0); a.gain.exponentialRampToValueAtTime(g, t0 + d * 0.3); a.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  src.connect(flt).connect(a).connect(master); src.start(t0);
}
// a struck bell: a few inharmonic partials with a long tail
const bell = (t = 0, f = 880, g = 0.28, d = 2.2) => [1, 2.01, 2.76, 4.07, 5.4].forEach((m, i) => tone({ f: f * m, t, d: d / (1 + i * 0.5), g: g / (1 + i * 0.9), attack: 0.002 }));

export const play = {
  takeoff: () => { noise({ d: 1.6, g: 0.16, from: 250, to: 2400 }); tone({ f: 90, to: 210, d: 1.5, type: "sawtooth", g: 0.05 }); },
  land: () => { tone({ f: 660, d: 0.5, g: 0.2 }); tone({ f: 880, t: 0.16, d: 0.7, g: 0.2 }); },
  card: () => noise({ d: 0.35, g: 0.1, from: 1800, to: 500 }),
  tick: (style, urgent) => {
    if (style === "off") return;
    if (style === "pulse") tone({ f: urgent ? 620 : 420, d: 0.22, g: urgent ? 0.26 : 0.16 });
    else { tone({ f: urgent ? 1560 : 1040, d: 0.07, type: "square", g: urgent ? 0.2 : 0.12 }); if (urgent) tone({ f: 1560, t: 0.14, d: 0.06, type: "square", g: 0.16 }); }
  },
  boardsUp: (style) => { if (style === "off") return; bell(0, 660, 0.34, 2.4); bell(0.02, 990, 0.14, 1.6); },
  reveal: () => [523, 659, 784, 1047].forEach((f, i) => tone({ f, t: i * 0.09, d: 0.5, g: 0.2, type: "triangle" })),
  mayday: () => { for (let i = 0; i < 4; i++) { tone({ f: 740, t: i * 0.6, d: 0.28, type: "square", g: 0.14 }); tone({ f: 555, t: i * 0.6 + 0.3, d: 0.28, type: "square", g: 0.14 }); } },
  stamp: () => { noise({ d: 0.12, g: 0.4, from: 300, to: 120 }); tone({ f: 120, to: 60, d: 0.18, g: 0.4 }); },
  right: () => { tone({ f: 784, d: 0.18, g: 0.22, type: "triangle" }); tone({ f: 1175, t: 0.12, d: 0.45, g: 0.22, type: "triangle" }); },
  wrong: () => { tone({ f: 196, d: 0.4, type: "sawtooth", g: 0.14 }); tone({ f: 147, t: 0.18, d: 0.5, type: "sawtooth", g: 0.14 }); },
  timeUp: () => { tone({ f: 220, d: 0.9, type: "square", g: 0.16 }); tone({ f: 165, t: 0.05, d: 0.9, type: "square", g: 0.12 }); },
  fanfare: () => [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone({ f, t: i * 0.13, d: i === 6 ? 1.2 : 0.3, g: 0.2, type: "triangle" })),
  goldenBell: () => { bell(0, 587, 0.4, 3); bell(0.7, 587, 0.4, 3); bell(1.4, 587, 0.44, 4); play.fanfare(); },
};
