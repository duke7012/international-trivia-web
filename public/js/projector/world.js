// The flight world behind everything on the projector: one continuous 3D journey.
// A toy airplane hops between 31 floating islands (the home airport plus 30 numbered
// destinations) while the sky moves from sunrise to night to a golden dawn.
// All artwork here is built from primitives in code; there are no model or texture files.
import * as THREE from "three";
import { RoundedBoxGeometry, RoomEnvironment } from "three";
import { clock } from "../net.js";

export const STOPS = 30;
export const ZONES = [
  { name: "Sunrise Coast", from: 0, to: 6 },
  { name: "Tropic Blue", from: 7, to: 12 },
  { name: "Golden Dunes", from: 13, to: 18 },
  { name: "Lantern Dusk", from: 19, to: 24 },
  { name: "Aurora Night", from: 25, to: 29 },
  { name: "Golden Bell", from: 30, to: 30 },
];
export const zoneOf = (stop) => ZONES.findIndex((z) => stop >= z.from && stop <= z.to);

// Sky gradient (zenith, middle, horizon) by journey progress 0..1.
const SKY = [
  [0.0, "#4f7fe6", "#f4a3b4", "#ffd9a6"],
  [0.17, "#3f8fe8", "#bfd9f2", "#ffe6bf"],
  [0.3, "#1c78d6", "#58c4e8", "#c8f4ea"],
  [0.42, "#2f8fd4", "#9fd8d0", "#fbe9b4"],
  [0.52, "#e8873a", "#f6b55a", "#fde4ac"],
  [0.62, "#d9603f", "#f08a55", "#f9c480"],
  [0.72, "#5b2f96", "#c8508f", "#f59a6e"],
  [0.8, "#2a1f72", "#7a3aa0", "#d0608c"],
  [0.87, "#050a2a", "#131d5c", "#2b3f8f"],
  [0.96, "#081036", "#1b2a70", "#4a4f9c"],
  [1.0, "#f09a1c", "#f9c64e", "#fff0c0"],
].map(([p, a, b, c]) => [p, new THREE.Color(a), new THREE.Color(b), new THREE.Color(c)]);
const STORM = [new THREE.Color("#1a0a12"), new THREE.Color("#5a1620"), new THREE.Color("#b04a38")];
const GOLD = [new THREE.Color("#f09a1c"), new THREE.Color("#f9c64e"), new THREE.Color("#fff0c0")];

const ZONE_LOOK = [
  { top: "#a6d894", side: "#c2906c", accent: "#f4a3b4" },
  { top: "#f1dea6", side: "#d0a070", accent: "#2bb8a8" },
  { top: "#edc477", side: "#c27a4a", accent: "#e8603a" },
  { top: "#b79bd8", side: "#6a4892", accent: "#ffb347" },
  { top: "#edf3ff", side: "#8ba0c6", accent: "#7ce8d0" },
  { top: "#f6d778", side: "#c9953a", accent: "#fff3c4" },
];

const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (u) => u * u * u * (u * (u * 6 - 15) + 10);
const UP = new THREE.Vector3(0, 1, 0);
const HOP = 6.2, GEAR = 0.62;

export function createWorld(canvas, { monitor = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !monitor, powerPreference: "high-performance" });
  renderer.setPixelRatio(monitor ? 1 : Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !monitor;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  scene.fog = new THREE.Fog("#ffd9a6", 40, 210);
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 900);

  const hemi = new THREE.HemisphereLight(0xeaf5ff, 0xf2c890, 1.25);
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
  sun.castShadow = !monitor;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(hemi, sun, sun.target);

  // ---------------- the route ----------------
  const pts = [];
  for (let i = 0; i <= STOPS; i++) pts.push(new THREE.Vector3(Math.sin(i * 0.83) * 15 + Math.sin(i * 0.31 + 1.3) * 9, Math.sin(i * 0.57) * 2.4 + i * 0.25, -i * 36));
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const planeAt = (f, out) => {
    curve.getPoint(clamp(f / STOPS, 0, 1), out);
    const fr = f - Math.floor(f);
    out.y += GEAR + (HOP * (1 - Math.cos(2 * Math.PI * fr))) / 2;
    return out;
  };
  const frames = pts.map((p, i) => {
    const t = curve.getTangent(i / STOPS); t.y = 0; t.normalize();
    return { c: p, t, s: new THREE.Vector3().crossVectors(t, UP).normalize(), yaw: Math.atan2(t.x, t.z), r: i === 0 ? 11.5 : i === STOPS ? 10.5 : 8.2 + (i % 3) * 0.5, zone: zoneOf(i) };
  });

  // ---------------- instanced building blocks ----------------
  const std = (o = {}) => new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0, ...o });
  const kinds = {
    trunk: [new THREE.CylinderGeometry(0.5, 0.62, 1, 8), std()],
    blob: [new THREE.IcosahedronGeometry(1, 2), std({ roughness: 0.8 })],
    cone: [new THREE.ConeGeometry(1, 1, 9), std({ roughness: 0.8 })],
    roof: [new THREE.ConeGeometry(1, 1, 4), std()],
    box: [new RoundedBoxGeometry(1, 1, 1, 2, 0.08), std()],
    flat: [new THREE.BoxGeometry(1, 1, 1), std({ roughness: 0.85 })],
    rock: [new THREE.DodecahedronGeometry(1, 0), std({ flatShading: true, roughness: 0.9 })],
    dome: [new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), std()],
    glow: [new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ toneMapped: false })],
  };
  const batches = Object.fromEntries(Object.keys(kinds).map((k) => [k, []]));
  const tmp = new THREE.Object3D(), col = new THREE.Color();
  const put = (kind, x, y, z, sx, sy, sz, ry, color, rx = 0, rz = 0) => {
    tmp.position.set(x, y, z); tmp.scale.set(sx, sy, sz); tmp.rotation.set(rx, ry, rz); tmp.updateMatrix();
    batches[kind].push([tmp.matrix.clone(), new THREE.Color(color)]);
  };

  // Each island is built in its own frame: +t along the runway, +s to the side.
  const islandMeshes = new THREE.Group();
  scene.add(islandMeshes);
  const topGeo = (r) => new THREE.CylinderGeometry(r, r * 0.9, 1.1, 48);
  function underGeo(r, rand) {
    const g = new THREE.CylinderGeometry(r * 0.9, r * 0.12, 6.5, 11, 3);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < 3.2) { p.setX(i, p.getX(i) * (0.8 + rand() * 0.45)); p.setZ(i, p.getZ(i) * (0.8 + rand() * 0.45)); p.setY(i, y - rand() * 0.8); }
    }
    g.computeVertexNormals();
    return g;
  }
  const signs = [];
  const signGeo = new THREE.CircleGeometry(1.75, 48);
  const ringGeo = new THREE.TorusGeometry(1.86, 0.16, 12, 48);
  const goldMat = std({ color: "#f2b31b", metalness: 0.75, roughness: 0.28 });

  frames.forEach((fr, i) => {
    const rand = rng(1000 + i * 77);
    const look = ZONE_LOOK[fr.zone];
    const { c, t, s, r, yaw } = fr;
    const at = (a, b, h = 0) => [c.x + t.x * a + s.x * b, c.y + h, c.z + t.z * a + s.z * b];

    const top = new THREE.Mesh(topGeo(r), std({ color: look.top, roughness: 0.9 }));
    top.position.set(c.x, c.y - 0.55, c.z); top.receiveShadow = true;
    const under = new THREE.Mesh(underGeo(r, rand), std({ color: look.side, flatShading: true, roughness: 0.95 }));
    under.position.set(c.x, c.y - 1.1 - 3.25, c.z);
    islandMeshes.add(top, under);
    if (fr.zone === 1) put("trunk", ...at(0, 0, -0.02), r * 1.45, 0.08, r * 1.45, 0, "#7fd4a2"); // a green heart on the sand
    if (fr.zone === 4) put("trunk", ...at(0, 0, -0.02), r * 1.3, 0.08, r * 1.3, 0, "#dbe8ff");

    // runway with centre dashes and thresholds
    const len = i === 0 ? 15 : 11.5;
    put("flat", ...at(0, 0, 0.02), 2.9, 0.06, len, yaw, "#565d70");
    for (let k = -2; k <= 2; k++) put("flat", ...at(k * (len / 5.6), 0, 0.06), 0.16, 0.03, 0.95, yaw, "#fffaf0");
    for (const e of [-1, 1]) for (let k = -2; k <= 2; k++) put("flat", ...at(e * (len / 2 - 0.6), k * 0.48, 0.06), 0.2, 0.03, 0.7, yaw, "#fffaf0");
    for (const e of [-1, 1]) for (const side of [-1, 1]) put("glow", ...at(e * (len / 2 - 0.2), side * 1.6, 0.14), 0.1, 0.1, 0.1, 0, e > 0 ? "#7cffc6" : "#ffcf5a");

    // destination sign: a round gate marker on a post
    if (i > 0) {
      const sp = at(-2.6, -4.6, 0);
      put("trunk", sp[0], sp[1] + 1.25, sp[2], 0.26, 2.5, 0.26, 0, "#fffaf0");
      put("trunk", sp[0], sp[1] + 0.12, sp[2], 0.9, 0.24, 0.9, 0, "#565d70");
      const g = new THREE.Group();
      g.position.set(sp[0], sp[1] + 4.1, sp[2]);
      const face = new THREE.Mesh(signGeo, new THREE.MeshBasicMaterial({ color: "#fffaf0", toneMapped: false }));
      const back = new THREE.Mesh(signGeo, std({ color: "#1c2a5e" })); back.rotation.y = Math.PI; back.position.z = -0.05;
      const ring = new THREE.Mesh(ringGeo, goldMat); ring.castShadow = true;
      g.add(face, back, ring);
      scene.add(g);
      signs.push({ g, face, n: i, z: c.z });
    }

    // scenery, kept clear of the runway and the sign
    const spots = [];
    const want = i === 0 ? 7 : 8 + Math.floor(rand() * 4);
    for (let tries = 0; spots.length < want && tries < 90; tries++) {
      const ang = rand() * Math.PI * 2, rad = 3.2 + rand() * (r - 4.4);
      const a = Math.cos(ang) * rad, b = Math.sin(ang) * rad;
      if (Math.abs(b) < 2.9) continue;
      if (i === 0 ? b < 0 && a < 2 : b > 0 && a > -3.5) continue; // keep the camera's side of the island open
      if (i > 0 && Math.hypot(a + 2.6, b + 4.6) < 2.6) continue;
      if (spots.some((q) => Math.hypot(q[0] - a, q[1] - b) < 2.1)) continue;
      spots.push([a, b]);
    }
    spots.forEach(([a, b], k) => {
      const [x, y, z] = at(a, b, 0);
      const sc = 0.75 + rand() * 0.55, pickN = rand(), ry = rand() * 6.28;
      scenery(fr.zone, i, k, x, y, z, sc, pickN, ry, look, rand);
    });
    if (i === 0) {
      // home airport: control tower and hangar
      const [tx, ty, tz] = at(6.5, -7.2, 0);
      put("trunk", tx, ty + 2.6, tz, 1.3, 5.2, 1.3, 0, "#fffaf0");
      put("trunk", tx, ty + 5.5, tz, 2.5, 1.1, 2.5, 0, "#2748d8");
      put("trunk", tx, ty + 5.5, tz, 2.56, 0.5, 2.56, 0, "#bfe6ff");
      put("cone", tx, ty + 6.5, tz, 1.5, 0.9, 1.5, 0, "#f2b31b");
      const [hx, hy, hz] = at(-0.5, -7.4, 0);
      put("box", hx, hy + 1.2, hz, 4.2, 2.4, 3.4, yaw, "#fffaf0");
      put("dome", hx, hy + 2.3, hz, 2.3, 1.1, 1.9, yaw, "#e5484d");
    }
    if (i === STOPS) {
      // the final destination wears a gold arch
      for (const e of [-1, 1]) { const [ax, ay, az] = at(-4.6, e * 2.6, 0); put("trunk", ax, ay + 2.2, az, 0.5, 4.4, 0.5, 0, "#f2b31b"); }
      const [ax, ay, az] = at(-4.6, 0, 0); put("box", ax, ay + 4.5, az, 6.2, 0.6, 0.7, yaw + Math.PI / 2, "#f2b31b");
    }
  });

  function scenery(zone, i, k, x, y, z, sc, n, ry, look, rand) {
    const tree = (leaf, leaf2) => {
      put("trunk", x, y + 0.7 * sc, z, 0.3 * sc, 1.4 * sc, 0.3 * sc, 0, "#a8754f");
      put("blob", x, y + 2.0 * sc, z, 1.15 * sc, 1.1 * sc, 1.15 * sc, ry, leaf);
      put("blob", x + 0.55 * sc, y + 2.75 * sc, z + 0.2 * sc, 0.72 * sc, 0.7 * sc, 0.72 * sc, ry, leaf2);
    };
    const house = (wall, roof) => {
      put("box", x, y + 0.65 * sc, z, 1.7 * sc, 1.3 * sc, 1.5 * sc, ry, wall);
      put("roof", x, y + 1.75 * sc, z, 1.5 * sc, 1.0 * sc, 1.5 * sc, ry + Math.PI / 4, roof);
    };
    const rock = (c2) => put("rock", x, y + 0.35 * sc, z, 0.9 * sc, 0.6 * sc, 0.8 * sc, ry, c2);
    if (zone === 0) {
      if (n < 0.6) tree("#8fcb8a", "#b4dfa0"); else if (n < 0.82) house("#fff4e2", k % 2 ? "#f08a6c" : "#5b7fe6"); else rock("#d9c2ad");
    } else if (zone === 1) {
      if (n < 0.62) { // palm
        put("trunk", x, y + 1.5 * sc, z, 0.2 * sc, 3.0 * sc, 0.2 * sc, 0, "#c79a6a", 0, 0.12);
        for (let j = 0; j < 5; j++) { const a = ry + (j * Math.PI * 2) / 5; put("blob", x - 0.2 * sc + Math.cos(a) * 0.95 * sc, y + 3.0 * sc, z + Math.sin(a) * 0.95 * sc, 1.05 * sc, 0.16 * sc, 0.36 * sc, -a, "#3fb58a", 0, -0.35); }
      } else if (n < 0.84) { put("trunk", x, y + 0.55 * sc, z, 1.5 * sc, 1.1 * sc, 1.5 * sc, 0, "#fff4e2"); put("cone", x, y + 1.6 * sc, z, 1.35 * sc, 1.1 * sc, 1.35 * sc, 0, "#e9b75c"); } else rock("#e8d6b8");
    } else if (zone === 2) {
      if (n < 0.45) { // cactus
        put("blob", x, y + 1.1 * sc, z, 0.36 * sc, 1.2 * sc, 0.36 * sc, 0, "#5fae7a");
        put("blob", x + 0.5 * sc, y + 1.2 * sc, z, 0.2 * sc, 0.55 * sc, 0.2 * sc, 0, "#5fae7a");
        put("blob", x - 0.45 * sc, y + 0.9 * sc, z, 0.2 * sc, 0.45 * sc, 0.2 * sc, 0, "#5fae7a");
      } else if (n < 0.75) { put("roof", x, y + 0.85 * sc, z, 1.3 * sc, 1.7 * sc, 1.3 * sc, ry, k % 2 ? "#e8603a" : "#fff4e2"); } else { put("rock", x, y + 0.8 * sc, z, 1.1 * sc, 1.5 * sc, 1.0 * sc, ry, "#d98a55"); }
    } else if (zone === 3) {
      if (n < 0.45) tree("#e58bb0", "#f4b0c8");
      else if (n < 0.8) { // lantern post
        put("trunk", x, y + 1.2 * sc, z, 0.12 * sc, 2.4 * sc, 0.12 * sc, 0, "#3a2a5c");
        put("glow", x, y + 2.6 * sc, z, 0.42 * sc, 0.52 * sc, 0.42 * sc, 0, k % 2 ? "#ffb347" : "#ff7a59");
      } else house("#4a3570", "#ffb347");
    } else if (zone === 4) {
      if (n < 0.6) { // pine
        put("trunk", x, y + 0.4 * sc, z, 0.24 * sc, 0.8 * sc, 0.24 * sc, 0, "#7a5a48");
        for (let j = 0; j < 3; j++) put("cone", x, y + (1.2 + j * 0.75) * sc, z, (1.05 - j * 0.26) * sc, 1.2 * sc, (1.05 - j * 0.26) * sc, 0, j === 2 ? "#eaf3ff" : "#3c8c7c");
      } else if (n < 0.82) put("dome", x, y, z, 1.25 * sc, 1.0 * sc, 1.25 * sc, 0, "#ffffff");
      else { put("glow", x, y + 0.9 * sc, z, 0.3 * sc, 1.0 * sc, 0.3 * sc, ry, "#7ce8d0"); rock("#c9d6ee"); }
    } else {
      if (n < 0.6) tree("#f2c14e", "#ffe08a"); else put("glow", x, y + 0.8, z, 0.35, 0.35, 0.35, 0, "#fff3c4");
    }
  }

  // far-off floating rocks, for depth
  { const rand = rng(42);
    for (let k = 0; k < 46; k++) {
      const f = rand() * STOPS, p = planeAt(Math.floor(f), new THREE.Vector3());
      const side = (rand() < 0.5 ? -1 : 1) * (38 + rand() * 80), sc = 2 + rand() * 6;
      put("rock", p.x + side, p.y - 8 - rand() * 26, p.z - rand() * 36, sc, sc * (0.6 + rand() * 0.5), sc, rand() * 6, k % 3 ? "#c9a58c" : "#a6c8a0");
    }
  }

  const made = {};
  for (const k of Object.keys(kinds)) {
    const list = batches[k];
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(kinds[k][0], kinds[k][1], list.length);
    list.forEach(([m, c2], n) => { mesh.setMatrixAt(n, m); mesh.setColorAt(n, c2); });
    mesh.castShadow = k !== "glow" && k !== "flat"; mesh.receiveShadow = k === "flat";
    mesh.frustumCulled = false;
    scene.add(mesh); made[k] = mesh;
  }

  // sign faces need the display typeface, so they are painted once fonts are in
  function paintSigns() {
    for (const sgn of signs) {
      const cv = document.createElement("canvas"); cv.width = cv.height = 256;
      const x = cv.getContext("2d");
      x.fillStyle = "#fffaf0"; x.fillRect(0, 0, 256, 256);
      x.fillStyle = "#121a33"; x.textAlign = "center"; x.textBaseline = "middle";
      x.font = `800 ${sgn.n > 9 ? 138 : 158}px "Bricolage Grotesque", system-ui, sans-serif`;
      x.fillText(String(sgn.n), 128, 138);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      sgn.face.material.map = tex; sgn.face.material.needsUpdate = true;
    }
  }
  (document.fonts?.load ? document.fonts.load('800 100px "Bricolage Grotesque"').catch(() => {}) : Promise.resolve()).then(paintSigns);

  // ---------------- dotted route ----------------
  const DOT = 0.05, dotCount = Math.round(STOPS / DOT);
  const dots = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), dotCount);
  const dotAhead = new THREE.Color("#ffffff"), dotDone = new THREE.Color("#f2b31b");
  { const p = new THREE.Vector3();
    for (let n = 0; n < dotCount; n++) {
      const f = (n + 0.5) * DOT, fr = f - Math.floor(f);
      planeAt(f, p); tmp.position.copy(p); tmp.rotation.set(0, 0, 0);
      tmp.scale.setScalar(fr < 0.12 || fr > 0.88 ? 0.0001 : 1); tmp.updateMatrix();
      dots.setMatrixAt(n, tmp.matrix); dots.setColorAt(n, dotAhead);
    }
  }
  dots.frustumCulled = false; scene.add(dots);
  let dotMark = 0;
  function markDots(f) {
    const upTo = clamp(Math.floor(f / DOT), 0, dotCount);
    if (upTo === dotMark) return;
    const [a, b] = upTo > dotMark ? [dotMark, upTo] : [upTo, dotMark];
    for (let n = a; n < b; n++) dots.setColorAt(n, upTo > dotMark ? dotDone : dotAhead);
    dots.instanceColor.needsUpdate = true; dotMark = upTo;
  }

  // ---------------- clouds, balloons, sea, sky ----------------
  const cloudMat = std({ color: "#ffffff", roughness: 1, emissive: "#ffffff", emissiveIntensity: 0.22 });
  const puffs = [];
  { const rand = rng(7);
    for (let k = 0; k < 120; k++) {
      const f = rand() * (STOPS + 2) - 1, base = planeAt(clamp(f, 0, STOPS), new THREE.Vector3());
      const low = k % 3 === 0; // a third form a cloud floor far below
      const side = (rand() < 0.5 ? -1 : 1) * (low ? rand() * 70 : 9 + rand() * 46);
      const cx = base.x + side, cy = low ? base.y - 16 - rand() * 12 : base.y - 5 + rand() * 20, cz = -f * 36 + (rand() - 0.5) * 20;
      const big = (low ? 3.2 : 1.5) + rand() * 2.4, n = 5 + Math.floor(rand() * 3);
      for (let j = 0; j < n; j++) puffs.push([cx + (j - n / 2) * big * 0.85 + rand() * 0.6, cy + (rand() - 0.5) * big * 0.5, cz + (rand() - 0.5) * big * 0.9, big * (0.7 + rand() * 0.6) * (1 - Math.abs(j - (n - 1) / 2) / n)]);
    }
  }
  const clouds = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), cloudMat, puffs.length);
  puffs.forEach(([x, y, z, sc], n) => { tmp.position.set(x, y, z); tmp.rotation.set(0, 0, 0); tmp.scale.set(sc * 1.25, sc * 0.72, sc); tmp.updateMatrix(); clouds.setMatrixAt(n, tmp.matrix); });
  clouds.frustumCulled = false; scene.add(clouds);

  const balloons = [];
  { const rand = rng(99), hues = ["#e5484d", "#2748d8", "#f2b31b", "#37c6a8", "#f08a6c", "#8a5cf0"];
    const env = new THREE.SphereGeometry(1, 24, 16), band = new THREE.TorusGeometry(0.82, 0.09, 8, 24), basket = new RoundedBoxGeometry(0.5, 0.42, 0.5, 2, 0.06);
    for (let k = 0; k < 14; k++) {
      const f = 1.2 + rand() * (STOPS - 2), base = planeAt(f, new THREE.Vector3());
      const g = new THREE.Group(), c1 = hues[k % hues.length];
      const e = new THREE.Mesh(env, std({ color: c1, roughness: 0.5 })); e.scale.set(1.5, 1.85, 1.5);
      const b = new THREE.Mesh(band, std({ color: "#fffaf0" })); b.rotation.x = Math.PI / 2; b.scale.setScalar(1.86); b.position.y = 0.15;
      const bk = new THREE.Mesh(basket, std({ color: "#a8754f" })); bk.position.y = -2.5;
      g.add(e, b, bk);
      g.position.set(base.x + (rand() < 0.5 ? -1 : 1) * (11 + rand() * 22), base.y + rand() * 9 - 2, base.z + (rand() - 0.5) * 16);
      g.scale.setScalar(0.9 + rand() * 0.9);
      scene.add(g); balloons.push({ g, y: g.position.y, ph: rand() * 6 });
    }
  }

  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), std({ color: "#7fb8e0", roughness: 0.55, metalness: 0.1 }));
  sea.rotation.x = -Math.PI / 2; scene.add(sea);

  const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 20), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color() }, middle: { value: new THREE.Color() }, bottom: { value: new THREE.Color() }, time: { value: 0 }, night: { value: 0 } },
    vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform vec3 top; uniform vec3 middle; uniform vec3 bottom; uniform float time; uniform float night; varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y * 1.7, 0.0, 1.0);
        vec3 c = mix(bottom, middle, smoothstep(0.0, 0.42, h));
        c = mix(c, top, smoothstep(0.36, 1.0, h));
        // aurora ribbons, only at night
        float a = atan(vDir.x, -vDir.z);
        float wave = sin(a * 5.0 + time * 0.25) * 0.07 + sin(a * 11.0 - time * 0.4) * 0.03;
        float band = smoothstep(0.16, 0.0, abs(vDir.y - 0.34 - wave)) + 0.6 * smoothstep(0.1, 0.0, abs(vDir.y - 0.52 - wave * 1.6));
        c += night * band * mix(vec3(0.2, 0.95, 0.7), vec3(0.55, 0.4, 1.0), 0.5 + 0.5 * sin(a * 3.0 + time * 0.2)) * 0.55;
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
  sky.renderOrder = -10; scene.add(sky);

  const starGeo = new THREE.BufferGeometry();
  { const rand = rng(5), n = 1400, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = new THREE.Vector3(rand() * 2 - 1, rand() * 0.95 + 0.05, rand() * 2 - 1).normalize().multiplyScalar(620); arr.set([v.x, v.y, v.z], i * 3); }
    starGeo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  }
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: "#ffffff", size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  scene.add(stars);

  // ---------------- the airplane ----------------
  const plane = new THREE.Group();
  const body = new THREE.Group(); plane.add(body);
  const cream = std({ color: "#fffaf0", roughness: 0.38 }), blue = std({ color: "#2748d8", roughness: 0.4 }), glass = std({ color: "#16224f", roughness: 0.12, metalness: 0.3 });
  const part = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; body.add(m); return m; };
  part(new THREE.CapsuleGeometry(0.62, 2.5, 10, 24), cream, 0, 0, 0, Math.PI / 2);
  part(new THREE.CylinderGeometry(0.635, 0.635, 0.22, 24), blue, 0, 0, -0.55, Math.PI / 2);
  part(new THREE.CylinderGeometry(0.635, 0.635, 0.08, 24), goldMat, 0, 0, -0.78, Math.PI / 2);
  part(new THREE.SphereGeometry(0.5, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), glass, 0, 0.3, 0.75).scale.set(0.82, 0.62, 1.25);
  part(new RoundedBoxGeometry(6.0, 0.13, 1.2, 3, 0.06), cream, 0, -0.12, 0.25);
  for (const e of [-1, 1]) { part(new RoundedBoxGeometry(0.75, 0.15, 1.22, 3, 0.06), blue, e * 2.7, -0.12, 0.25); part(new THREE.CapsuleGeometry(0.2, 0.5, 6, 12), goldMat, e * 1.25, -0.4, 0.45, Math.PI / 2); }
  part(new RoundedBoxGeometry(2.3, 0.1, 0.72, 3, 0.05), cream, 0, 0.1, -1.72);
  part(new RoundedBoxGeometry(0.12, 1.05, 0.85, 3, 0.05), blue, 0, 0.62, -1.7, -0.22);
  part(new THREE.ConeGeometry(0.34, 0.6, 20), goldMat, 0, 0, 2.1, Math.PI / 2);
  const prop = new THREE.Group(); prop.position.set(0, 0, 2.0); body.add(prop);
  for (let j = 0; j < 3; j++) { const b = new THREE.Mesh(new RoundedBoxGeometry(0.2, 1.25, 0.05, 2, 0.02), std({ color: "#121a33" })); b.position.y = 0.62; const h = new THREE.Group(); h.rotation.z = (j * Math.PI * 2) / 3; h.add(b); prop.add(h); }
  const propDisc = new THREE.Mesh(new THREE.CircleGeometry(1.28, 32), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  propDisc.position.z = 2.02; body.add(propDisc);
  for (const e of [-1, 1]) { part(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), cream, e * 0.55, -0.6, 0.5); part(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 16), std({ color: "#121a33" }), e * 0.55, -0.88, 0.5, 0, 0, Math.PI / 2); }
  part(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 12), std({ color: "#121a33" }), 0, -0.52, -1.6, 0, 0, Math.PI / 2);
  body.position.y = 0.46;
  scene.add(plane);

  const beacon = new THREE.PointLight("#ff3b30", 0, 30, 1.6); beacon.position.set(0, 1.6, 0); plane.add(beacon);

  // wingtip trails
  const TRAIL = 70, trail = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16, 1), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.75, depthWrite: false }), TRAIL);
  const trailPts = Array.from({ length: TRAIL }, () => ({ p: new THREE.Vector3(0, -999, 0), born: -1e9 }));
  trail.frustumCulled = false; scene.add(trail);
  let trailHead = 0, trailClock = 0;

  // engine smoke for the emergency
  const SMOKE = 26, smoke = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), std({ color: "#3a3440", roughness: 1, transparent: true, opacity: 0.82 }), SMOKE);
  smoke.frustumCulled = false; smoke.visible = false; scene.add(smoke);

  // target ring over the next destination
  const target = new THREE.Mesh(new THREE.TorusGeometry(3.1, 0.09, 10, 64), new THREE.MeshBasicMaterial({ color: "#f2b31b", transparent: true, opacity: 0.9, toneMapped: false }));
  target.rotation.x = Math.PI / 2; scene.add(target);

  // the Golden Bell and confetti, for the finale
  const bellPts = [[0.0, 2.1], [0.34, 2.05], [0.5, 1.8], [0.62, 1.2], [0.8, 0.6], [1.15, 0.2], [1.42, 0], [1.42, -0.1], [1.2, -0.1]].map(([x, y]) => new THREE.Vector2(x, y));
  const bell = new THREE.Group(), bellSwing = new THREE.Group();
  const bellBody = new THREE.Mesh(new THREE.LatheGeometry(bellPts, 48), std({ color: "#f5b81f", metalness: 0.9, roughness: 0.2, side: THREE.DoubleSide }));
  bellBody.position.y = -2.3;
  const clap = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), goldMat); clap.position.y = -2.3;
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.09, 10, 24), goldMat); loop.position.y = 0.05;
  bellSwing.add(bellBody, clap, loop); bell.add(bellSwing); bell.visible = false; scene.add(bell);
  const CONF = 260, confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.28, 0.16), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), CONF);
  const confSeed = Array.from({ length: CONF }, (_, i) => { const r = rng(300 + i); return [r() * 30 - 15, r() * 16, r() * 30 - 15, r() * 6.28, 0.6 + r() * 1.2]; });
  ["#f2b31b", "#e5484d", "#2748d8", "#37c6a8", "#fffaf0"].forEach((c2, k) => { for (let i = k; i < CONF; i += 5) confetti.setColorAt(i, col.set(c2)); });
  confetti.frustumCulled = false; confetti.visible = false; scene.add(confetti);

  // ---------------- per-frame ----------------
  let state = { mode: "lobby", stop: 0, flight: null, next: 1 };
  let fCur = 0, firstFrame = true, emerg = 0, fin = 0, lastT = performance.now(), time = 0, spin = 0.3;
  const P = new THREE.Vector3(), Pa = new THREE.Vector3(), Pb = new THREE.Vector3(), fwd = new THREE.Vector3(), side = new THREE.Vector3();
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3();
  const zen = new THREE.Color(), mid = new THREE.Color(), hor = new THREE.Color();

  function skyAt(p) {
    for (let i = 0; i < SKY.length - 1; i++) {
      const [a, za, ma, ha] = SKY[i], [b, zb, mb, hb] = SKY[i + 1];
      if (p <= b) { const k = clamp((p - a) / (b - a), 0, 1); zen.copy(za).lerp(zb, k); mid.copy(ma).lerp(mb, k); hor.copy(ha).lerp(hb, k); return; }
    }
  }

  function frame(nowMs) {
    const dt = Math.min(0.05, (nowMs - lastT) / 1000); lastT = nowMs; time += dt;

    // where is the plane?
    let flying = false, speed = 0;
    const fl = state.flight;
    if (fl) {
      const u = clamp((clock.now() - fl.startedAt) / fl.durationMs, 0, 1);
      const legs = Math.abs(fl.to - fl.from);
      // one leg: ease out of and into the runway. A long tour: steady cruise.
      const e = legs <= 1 ? smooth(u) : u < 0.04 ? (u * u) / 0.08 : u > 0.96 ? 1 - ((1 - u) * (1 - u)) / 0.08 : u;
      const f = fl.from + (fl.to - fl.from) * e;
      speed = Math.abs(f - fCur) / Math.max(dt, 0.001); fCur = f; flying = u < 1;
    } else {
      const d = state.stop - fCur;
      if (Math.abs(d) > 1.5) firstFrame = true; // a jump (reset, switch of show): cut, do not fly
      if (firstFrame || Math.abs(d) < 0.0005) fCur = state.stop; else { const stepF = d * (1 - Math.exp(-dt * 5)); fCur += stepF; speed = Math.abs(stepF) / dt; flying = Math.abs(d) > 0.02; }
    }
    const fr = fCur - Math.floor(fCur), airborne = clamp(Math.sin(Math.PI * fr) * 1.6, 0, 1);
    planeAt(fCur, P); planeAt(Math.max(0, fCur - 0.012), Pa); planeAt(Math.min(STOPS, fCur + 0.012), Pb);
    fwd.subVectors(Pb, Pa).normalize();
    if (airborne < 0.02) { const k = frames[clamp(Math.round(fCur), 0, STOPS)]; fwd.copy(k.t); }
    side.crossVectors(fwd, UP).normalize();
    plane.position.copy(P); plane.position.y -= GEAR;
    plane.lookAt(P.x + fwd.x, P.y - GEAR + fwd.y, P.z + fwd.z);
    // bank into turns while airborne
    const t0 = curve.getTangent(clamp((fCur - 0.08) / STOPS, 0, 1)), t1 = curve.getTangent(clamp((fCur + 0.08) / STOPS, 0, 1));
    const turn = t0.x * t1.z - t0.z * t1.x;
    body.rotation.z = THREE.MathUtils.lerp(body.rotation.z, clamp(turn * 9, -0.5, 0.5) * airborne, 1 - Math.exp(-dt * 4));
    body.position.y = 0.46 + (airborne > 0.05 ? Math.sin(time * 2.1) * 0.06 : 0);

    // emergency and finale blend in and out
    emerg += ((state.mode === "emergency" ? 1 : 0) - emerg) * (1 - Math.exp(-dt * 2.5));
    fin += ((state.mode === "finale" ? 1 : 0) - fin) * (1 - Math.exp(-dt * 1.5));
    const wantSpin = state.mode === "emergency" ? 0 : flying ? 1 : 0.22;
    spin += (wantSpin - spin) * (1 - Math.exp(-dt * 2));
    prop.rotation.z += dt * spin * 46;
    propDisc.material.opacity = clamp(spin - 0.35, 0, 1) * 0.16;
    if (emerg > 0.3) { body.rotation.z += Math.sin(time * 23) * 0.004; body.rotation.x = -0.05 + Math.sin(time * 2) * 0.01; } else body.rotation.x *= 0.9;

    // sky, light and fog follow the journey
    const p = fCur / STOPS;
    skyAt(p);
    zen.lerp(STORM[0], emerg * 0.85).lerp(GOLD[0], fin); mid.lerp(STORM[1], emerg * 0.8).lerp(GOLD[1], fin); hor.lerp(STORM[2], emerg * 0.7).lerp(GOLD[2], fin);
    const night = clamp(1 - Math.abs(p - 0.905) / 0.085, 0, 1) * (1 - fin) * (1 - emerg);
    const dusk = clamp(1 - Math.abs(p - 0.76) / 0.12, 0, 1);
    sky.material.uniforms.top.value.copy(zen); sky.material.uniforms.middle.value.copy(mid); sky.material.uniforms.bottom.value.copy(hor);
    sky.material.uniforms.time.value = time; sky.material.uniforms.night.value = night;
    scene.fog.color.copy(hor);
    stars.material.opacity = night * 0.95;
    sea.material.color.copy(hor).lerp(mid, 0.2).multiplyScalar(0.9);
    cloudMat.color.setRGB(1, 1, 1).lerp(hor, 0.28 + night * 0.4 + emerg * 0.35);
    cloudMat.emissive.copy(cloudMat.color); cloudMat.emissiveIntensity = 0.22 - night * 0.12;
    hemi.intensity = 1.25 - night * 0.7 - emerg * 0.5; hemi.color.copy(zen).lerp(col.set("#ffffff"), 0.6); hemi.groundColor.copy(hor);
    sun.intensity = 2.4 - night * 1.5 - dusk * 0.5 - emerg * 1.2;
    sun.color.set("#fff0d8").lerp(col.set("#ff9a6a"), dusk * 0.6).lerp(col.set("#9db8ff"), night);
    renderer.toneMappingExposure = 1.05 - night * 0.12;
    beacon.intensity = emerg * (Math.sin(time * 7) > 0 ? 60 : 4);

    // camera
    const here = frames[clamp(Math.round(fCur), 0, STOPS)];
    const sway = Math.sin(time * 0.22);
    if (flying && state.mode !== "emergency") {
      wantPos.copy(P).addScaledVector(fwd, -11.5).addScaledVector(side, 2.2 + sway * 0.8); wantPos.y = P.y + 3.6 + airborne * 0.6;
      wantLook.copy(P).addScaledVector(fwd, 9); wantLook.y = P.y + 0.3;
    } else if (state.mode === "lobby") {
      wantPos.copy(here.c).addScaledVector(here.t, -16).addScaledVector(here.s, -3 + sway); wantPos.y += 6.4;
      wantLook.copy(here.c).addScaledVector(here.t, 12).addScaledVector(here.s, -5); wantLook.y += 2.2;
    } else if (state.mode === "emergency") {
      wantPos.copy(here.c).addScaledVector(here.t, 8.5).addScaledVector(here.s, 5.5 + sway * 0.6); wantPos.y += 2.4 + Math.sin(time * 31) * 0.015 * emerg;
      wantLook.copy(here.c).addScaledVector(here.s, -1.2); wantLook.y += 1.5;
    } else if (state.mode === "finale") {
      const a = time * 0.16;
      wantPos.copy(here.c).addScaledVector(here.t, Math.cos(a) * 17).addScaledVector(here.s, Math.sin(a) * 17); wantPos.y += 4.5;
      // look to one side of the bell, so it hangs in the right half of the screen, clear of the names
      wantLook.copy(here.c).addScaledVector(here.t, Math.sin(a) * 6.5).addScaledVector(here.s, -Math.cos(a) * 6.5); wantLook.y += 5.2;
    } else {
      // landed and waiting: a slow drift around the island with the number in view
      wantPos.copy(here.c).addScaledVector(here.t, 12.5 + sway * 1.5).addScaledVector(here.s, 13 - sway * 1.2); wantPos.y += 7.4;
      wantLook.copy(here.c).addScaledVector(here.s, -3.2).addScaledVector(here.t, -0.6); wantLook.y += 2.3;
    }
    if (firstFrame) { camPos.copy(wantPos); camLook.copy(wantLook); firstFrame = false; }
    else { camPos.lerp(wantPos, 1 - Math.exp(-dt * (flying ? 3.2 : 1.7))); camLook.lerp(wantLook, 1 - Math.exp(-dt * (flying ? 4.2 : 2.2))); }
    camera.position.copy(camPos); camera.lookAt(camLook);
    camera.fov += ((flying ? 46 + clamp(speed, 0, 1) * 5 : 42) - camera.fov) * (1 - Math.exp(-dt * 2));
    camera.updateProjectionMatrix();

    sky.position.copy(camPos); stars.position.copy(camPos); sea.position.set(camPos.x, -38, camPos.z);
    sun.position.set(P.x + 14, P.y + 26, P.z + 10); sun.target.position.copy(P);

    // signs turn to face the camera; the target ring marks where the plane is headed
    for (const sgn of signs) if (Math.abs(sgn.z - camPos.z) < 190) sgn.g.rotation.y = Math.atan2(camPos.x - sgn.g.position.x, camPos.z - sgn.g.position.z);
    const nxt = state.next;
    if (nxt && nxt <= STOPS && state.mode !== "emergency" && state.mode !== "finale") {
      const k = frames[nxt]; target.visible = true;
      target.position.set(k.c.x, k.c.y + 2.2 + Math.sin(time * 2) * 0.25, k.c.z);
      target.scale.setScalar(1 + Math.sin(time * 3) * 0.06); target.rotation.z = time * 0.5;
    } else target.visible = false;
    markDots(fCur);

    // trails
    trailClock += dt;
    if (flying && airborne > 0.25 && trailClock > 0.045) {
      trailClock = 0;
      for (const e of [-1, 1]) { const tp = trailPts[trailHead++ % TRAIL]; tp.p.copy(P).addScaledVector(side, e * 2.9).addScaledVector(fwd, -0.4); tp.p.y += 0.3; tp.born = time; }
    }
    trailPts.forEach((tp, n) => { const age = time - tp.born, k = clamp(1 - age / 1.4, 0, 1); tmp.position.copy(tp.p); tmp.rotation.set(0, 0, 0); tmp.scale.setScalar(k > 0 ? 0.3 + k : 0.0001); tmp.updateMatrix(); trail.setMatrixAt(n, tmp.matrix); });
    trail.instanceMatrix.needsUpdate = true;

    // smoke
    smoke.visible = emerg > 0.05;
    if (smoke.visible) {
      for (let n = 0; n < SMOKE; n++) {
        const life = (time * 0.45 + n / SMOKE) % 1;
        tmp.position.copy(P).addScaledVector(fwd, 1.4 - life * 1.2).addScaledVector(side, Math.sin(n * 2.4 + life * 4) * 0.5 * life); tmp.position.y = P.y + 0.2 + life * 5.5;
        tmp.rotation.set(0, 0, 0); tmp.scale.setScalar((0.25 + life * 1.3) * emerg * (1 - life * 0.35)); tmp.updateMatrix(); smoke.setMatrixAt(n, tmp.matrix);
      }
      smoke.instanceMatrix.needsUpdate = true;
    }

    // drifting things
    for (const b of balloons) { b.g.position.y = b.y + Math.sin(time * 0.5 + b.ph) * 0.7; b.g.rotation.y = time * 0.1 + b.ph; }

    // finale
    bell.visible = confetti.visible = fin > 0.02;
    if (bell.visible) {
      bell.position.set(here.c.x, here.c.y + 9.2 - (1 - fin) * 6, here.c.z); bell.scale.setScalar(0.4 + fin * 0.9);
      bellSwing.rotation.z = Math.sin(time * 3.2) * 0.42 * fin; clap.position.x = -Math.sin(time * 3.2) * 0.5;
      for (let n = 0; n < CONF; n++) {
        const [x, y, z, ph, sp] = confSeed[n], fall = (y - time * sp * 1.6) % 16;
        tmp.position.set(here.c.x + x + Math.sin(time + ph) * 0.6, here.c.y + (fall < 0 ? fall + 16 : fall), here.c.z + z);
        tmp.rotation.set(time * sp * 2 + ph, ph, time * sp); tmp.scale.setScalar(fin); tmp.updateMatrix(); confetti.setMatrixAt(n, tmp.matrix);
      }
      confetti.instanceMatrix.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  addEventListener("resize", resize); resize();

  let lastDraw = 0;
  renderer.setAnimationLoop((t) => { if (monitor && t - lastDraw < 42) return; lastDraw = t; frame(t); });

  return {
    // mode: lobby | waiting | emergency | finale.   flight: { from, to, startedAt, durationMs } | null
    set(next) { state = { ...state, ...next }; },
    resize,
    progress: () => fCur,
  };
}
