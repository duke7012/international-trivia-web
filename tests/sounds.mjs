// Browser check for the host's own show sounds: files named like the organiser's are added in
// one go, and each one must play at its moment on the projector.
//
//   npm run test:sounds      (needs Playwright with Chromium, like npm run test:e2e)
//
// The stand-in files are short generated tones, so no real audio is needed.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5300 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), "golden-bell-sounds-"));
const FILES = path.join(DATA, "files");
mkdirSync(FILES);

// name -> [seconds, tone]
const SOUNDS = {
  goldenbell_game_fast_forward_long: [30, 330],
  goldenbell_game_question_show_loop: [3, 440],
  goldenbell_game_think_start: [3, 550],
  goldenbell_game_think_clock_extended: [20, 660],
  goldenbell_game_think_drums_extended: [20, 220],
  goldenbell_game_think_over: [1.5, 770],
  goldenbell_game_correct_answer_reveal: [3, 880],
  goldenbell_game_correct_answer: [1.5, 990],
  goldenbell_game_congratulations: [1.5, 1100],
  goldenbell_game_contestant_answer_reveal_loop: [3, 300],
  goldenbell_game_contestant_elimination: [3, 200],
};
function wav(seconds, hz) {
  const rate = 8000, n = Math.round(seconds * rate), buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 3000), 44 + i * 2);
  return buf;
}
const paths = Object.entries(SOUNDS).map(([name, [s, hz]]) => { const p = path.join(FILES, `${name}.wav`); writeFileSync(p, wav(s, hz)); return p; });

const server = spawn(process.execPath, ["server/server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(DATA, "data"), HOST: "127.0.0.1" } });
await new Promise((resolve, reject) => { server.stdout.on("data", (d) => String(d).includes("is running") && resolve()); server.on("exit", (c) => c && reject(new Error(`server exited ${c}`))); });
const act = async (type, payload = {}) => { const r = await fetch(`${BASE}/api/host/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, payload }) }); const j = await r.json(); if (!r.ok) throw new Error(`${type}: ${j.error}`); return j; };
const hostState = async () => {
  const res = await fetch(`${BASE}/api/events?role=host`); const reader = res.body.getReader(); let buf = "";
  while (!buf.includes("\n\n")) buf += Buffer.from((await reader.read()).value).toString();
  reader.cancel(); return JSON.parse(buf.slice(buf.indexOf("data: ") + 6, buf.indexOf("\n\n")));
};

const results = [];
let broken = false;
async function step(title, fn) {
  if (broken) { results.push(false); console.log(`  SKIP  ${title}`); return; }
  try { await fn(); results.push(true); console.log(`  PASS  ${title}`); }
  catch (e) { broken = true; results.push(false); console.log(`  FAIL  ${title}\n          ${e.message.split("\n").slice(0, 4).join("\n          ")}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const host = await ctx.newPage(), proj = await ctx.newPage();
  for (const [name, p] of [["host", host], ["projector", proj]]) p.on("pageerror", (e) => { console.log(`  [${name} page error] ${e.message}`); results.push(false); });
  const H = (id) => host.locator(`[data-testid="${id}"]`), P = (id) => proj.locator(`[data-testid="${id}"]`);
  // The sound the projector is playing right now ("" for none).
  const cue = (want, timeout = 30000) => proj.waitForFunction((w) => document.documentElement.dataset.cue === w, want, { timeout });

  await host.goto(`${BASE}/host#settings`); await proj.goto(`${BASE}/projector`);
  await H("sounds-panel").waitFor(); await P("projector").waitFor();
  await proj.mouse.click(700, 400); // turn the projector's sound on

  await step("add all eleven files at once; each is matched to its moment by name", async () => {
    assert((await H("sounds-count").innerText()).startsWith("0 of 11"), "starts with built-in sounds only");
    await H("sounds-input").setInputFiles(paths);
    await host.locator('[data-testid="sounds-count"]', { hasText: "11 of 11" }).waitFor({ timeout: 60000 });
    assert((await H("sound-name-thinkDrums").innerText()) === "goldenbell_game_think_drums_extended.wav", "drums file on the drums moment");
    assert((await H("sound-name-correct").innerText()) === "goldenbell_game_correct_answer.wav", "correct-answer file is not confused with its lead-in");
    assert((await H("sound-name-revealLead").innerText()) === "goldenbell_game_correct_answer_reveal.wav", "lead-in file on the lead-in moment");
    const s = (await hostState()).sounds;
    assert(Math.abs(s.thinkStart.durationMs - 3000) < 200 && Math.abs(s.revealLead.durationMs - 3000) < 200, "the lengths of the two lead-ins were measured");
    assert(Object.values(s).every((x) => x.src.startsWith("/media/sounds/")), "kept in the shared sounds area");
  });

  const state = await hostState();
  await act("bank.save", { id: state.questions[0].id, status: "published", question: { text: "First?", answerFormat: "written", correctAnswer: "One", country: "A", countdown: 6 } });
  await act("bank.save", { id: state.questions[1].id, status: "published", question: { text: "Second?", answerFormat: "written", correctAnswer: "Two", country: "B", countdown: 6 } });
  await act("addContestants", { names: ["Mina", "Jun"] });
  await H("tab-show").click(); await H("state").waitFor();

  await step("flying: the flight sound plays, and stops when the plane lands", async () => {
    assert((await proj.evaluate(() => document.documentElement.dataset.cue || "")) === "", "silence before the show");
    await H("btn-fly").click();
    await cue("flight");
    await proj.locator('[data-testid="projector"][data-phase="DESTINATION_ARRIVED"]').waitFor({ timeout: 30000 });
    await cue("");
  });

  await step("question on screen: the question music loops", async () => {
    await H("btn-show").click();
    await cue("questionLoop");
    await new Promise((r) => setTimeout(r, 4000)); // longer than the 3-second file, so it has looped
    assert((await proj.evaluate(() => document.documentElement.dataset.cue)) === "questionLoop", "still playing after one pass: it loops");
  });

  await step("start timer: lead-in first with the count held, then the clock music while it counts", async () => {
    await H("btn-timer").click();
    await cue("thinkStart");
    assert((await P("timer").getAttribute("data-state")) === "lead" && (await P("timer").getAttribute("data-seconds")) === "6", "the count waits for the lead-in");
    await cue("thinkClock");
    await proj.locator('[data-testid="timer"][data-state="running"], [data-testid="timer"][data-state="urgent"]').waitFor();
  });

  await step("time up: the time-up sound, then the boards loop", async () => {
    await cue("thinkOver");
    assert((await P("projector").getAttribute("data-phase")) === "BOARDS_UP", "boards up");
    await cue("boardsLoop");
  });

  await step("reveal answer: lead-in with the answer still hidden, then correct answer, then congratulations", async () => {
    await H("btn-reveal").click();
    await cue("revealLead");
    assert((await P("answer").count()) === 0, "the answer waits for the lead-in to finish");
    await cue("correct");
    await P("answer").waitFor();
    await cue("congrats");
  });

  await step("checking eliminations: the elimination loop, then silence", async () => {
    await H("btn-review").click();
    await cue("elimination");
    await H("btn-confirm").click();
    await cue("");
  });

  await step("a refreshed projector rejoins the question music and does not replay one-off sounds", async () => {
    await H("btn-fly").click(); await H("btn-skip").click(); await H("btn-show").click();
    await cue("questionLoop");
    await proj.reload(); await P("projector").waitFor();
    await proj.mouse.click(700, 400);
    await cue("questionLoop");
    await H("btn-timer").click(); await H("btn-timeup").click();
    await cue("thinkOver");
    await proj.reload(); await P("projector").waitFor(); await proj.mouse.click(700, 400);
    await cue("boardsLoop"); // straight to the loop: the time-up sound already happened
  });

  await step("removing a file brings the built-in sound back for that moment", async () => {
    await H("tab-settings").click(); await H("sounds-panel").waitFor();
    await H("sound-remove-boardsLoop").click();
    await host.locator('[data-testid="sounds-count"]', { hasText: "10 of 11" }).waitFor();
    assert((await H("sound-boardsLoop").getAttribute("data-set")) === "no", "back to built-in");
  });
} finally {
  await browser.close();
  server.kill();
  rmSync(DATA, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n  ${results.length - failed} of ${results.length} passed.`);
process.exit(failed ? 1 : 0);
