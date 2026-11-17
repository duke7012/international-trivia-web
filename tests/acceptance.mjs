// End-to-end acceptance run: the 20 required scenarios, driven through the real host dashboard
// in a real browser, with a real projector page beside it.
//
//   npm run test:e2e          (needs Playwright with Chromium:  npm i -D playwright && npx playwright install chromium)
//
// It starts its own server on a spare port with a throwaway data folder, so it never touches
// your show data.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "demo", "seed", "media");
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), "golden-bell-e2e-"));

// TARGET=cloudflare runs the same scenarios against the Cloudflare version, served locally by
// Cloudflare's own runtime (wrangler dev). It needs a .dev.vars file with HOST_PASSWORD, and
// E2E_PASSWORD set to the same value so the run can sign in.
const CLOUDFLARE = process.env.TARGET === "cloudflare";
const PASSWORD = process.env.E2E_PASSWORD || "";
let server;
const startServer = () => new Promise((resolve, reject) => {
  server = CLOUDFLARE
    ? spawn(path.join(ROOT, "node_modules", ".bin", "wrangler"), ["dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", DATA, "--show-interactive-dev-session=false"], { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, detached: true })
    : spawn(process.execPath, ["server/server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, HOST: "127.0.0.1" } });
  let out = "";
  const seen = (d) => { out += d; if (out.includes(CLOUDFLARE ? "Ready on" : "is running")) resolve(); };
  server.stdout.on("data", seen);
  server.stderr.on("data", (d) => (CLOUDFLARE ? seen(d) : process.stderr.write(`[server] ${d}`)));
  server.on("exit", (c) => c && reject(new Error(`server exited ${c}`)));
});
// wrangler starts helper processes, so its whole group is stopped.
const killServer = () => { try { CLOUDFLARE ? process.kill(-server.pid, "SIGTERM") : server.kill(); } catch { /* already gone */ } };
const stopServer = () => new Promise((r) => { server.once("exit", () => setTimeout(r, CLOUDFLARE ? 1500 : 0)); killServer(); });

// What the projector is actually sent over the wire (not just what it draws).
async function wire(role = "projector") {
  const res = await fetch(`${BASE}/api/events?role=${role}`, { headers: PASSWORD ? { "x-host-pin": PASSWORD } : {} });
  const reader = res.body.getReader();
  let buf = "";
  while (!buf.includes("\n\n")) buf += Buffer.from((await reader.read()).value).toString();
  reader.cancel();
  return JSON.parse(buf.slice(buf.indexOf("data: ") + 6, buf.indexOf("\n\n")));
}

const results = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
let broken = false; // the scenarios form one continuous show, so the first failure stops the run
async function scenario(n, title, fn) {
  if (broken) { results.push([n, title, false, "not run"]); console.log(`  SKIP  ${String(n).padStart(2)}. ${title} (an earlier scenario failed)`); return; }
  try { await fn(); results.push([n, title, true]); console.log(`  PASS  ${String(n).padStart(2)}. ${title}`); }
  catch (e) { broken = true; results.push([n, title, false, e.message]); console.log(`  FAIL  ${String(n).padStart(2)}. ${title}\n          ${e.stack.split("\n").slice(0, 6).join("\n          ")}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
try {
  await startServer();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const host = await ctx.newPage(), proj = await ctx.newPage();
  for (const [name, p] of [["host", host], ["projector", proj]]) p.on("pageerror", (e) => { console.log(`  [${name} page error] ${e.message}`); results.push(["x", `${name} page error`, false, e.message]); });
  host.on("dialog", (d) => d.accept());
  const H = (id) => host.locator(`[data-testid="${id}"]`);
  const P = (id) => proj.locator(`[data-testid="${id}"]`);
  const phase = async (want) => {
    await host.locator(`[data-testid="state"][data-phase="${want}"]`).waitFor({ timeout: 30000 });
    await proj.locator(`[data-testid="projector"][data-phase="${want}"]`).waitFor({ timeout: 30000 });
  };
  const tab = (t) => H(`tab-${t}`).click();
  const notice = async (re) => { await host.locator('[data-testid="notice"]').filter({ hasText: re }).waitFor({ timeout: 8000 }); };
  const openSlot = async (n) => { await tab("questions"); await H(`slot-${n}`).locator("button").click(); await host.locator(".editor h2", { hasText: `Question ${n}` }).waitFor(); };

  async function writeQuestion(n, q) {
    await openSlot(n);
    await H(`type-${q.type}`).check({ force: true });
    await H("f-text").fill(q.text);
    if (q.file) { await H("upload-input").setInputFiles(path.join(FIX, q.file)); await H("media-name").waitFor({ timeout: 20000 }); }
    if (q.clip) { await H("f-clip-start").fill(String(q.clip[0])); await H("f-clip-end").fill(String(q.clip[1])); }
    await H(`format-${q.choices ? "choice" : "written"}`).check({ force: true });
    if (q.choices) { for (let i = 0; i < 4; i++) await H(`f-choice-${i}`).fill(q.choices[i]); await H(`f-correct-${q.correct}`).check(); }
    else await H("f-answer").fill(q.answer);
    await H("f-country").fill(q.country); await H("f-topic").fill(q.topic);
    if (q.why) await H("f-explanation").fill(q.why);
    if (q.countdown) await H("f-countdown").fill(String(q.countdown));
    await H("btn-publish").click();
    await notice(new RegExp(`Published question ${n}`));
    assert((await H(`slot-${n}`).getAttribute("data-status")) === "published", `slot ${n} should be published`);
  }

  await host.goto(`${BASE}/host`); await proj.goto(`${BASE}/projector`);
  if (PASSWORD) { await H("signin-password").fill(PASSWORD); await H("signin-submit").click(); }
  await H("state").waitFor(); await P("projector").waitFor();
  await proj.mouse.click(700, 400); // one click turns the projector's sound on

  await scenario(1, "Launch with an empty question bank", async () => {
    await phase("LOBBY");
    await tab("questions");
    assert((await host.locator('[data-testid^="slot-"][data-status="empty"]').count()) === 30, "expected 30 empty slots");
    assert((await host.locator(".slot-text", { hasText: "Not configured" }).count()) === 30, 'every empty slot should read "Not configured"');
    const w = await wire();
    assert(w.question === null && w.answer === null, "projector must hold no question");
    await P("lobby").waitFor();
    // flying into an empty slot is blocked, with the reason shown
    await tab("show");
    await H("roster-input").fill("Mina, Jun, Sofia, Leo");
    await H("roster-add").click();
    await host.locator('[data-testid="tally"]', { hasText: "4" }).waitFor();
    assert(await H("btn-fly").isDisabled(), "Fly must be disabled with an empty bank");
    assert(/not configured/i.test(await H("next-blocked").innerText()), "the reason should say the slot is not configured");
  });

  await scenario(2, "Create and save a text-only question", async () => {
    await writeQuestion(1, { type: "text", text: "Which planet do we live on?", choices: ["Mars", "Earth", "Venus", "Jupiter"], correct: 1, country: "Testland", topic: "Space", why: "We live on Earth.", countdown: 8 });
  });
  await scenario(3, "Create and save an image question", async () => {
    await writeQuestion(2, { type: "image", text: "How many colour bands does this picture have?", file: "d01.svg", choices: ["Two", "Three", "Four", "Five"], correct: 1, country: "Imageland", topic: "Flags", countdown: 40 });
  });
  await scenario(4, "Create and save a video question", async () => {
    await writeQuestion(3, { type: "video", text: "What is the last colour to appear in the clip?", file: "d02.webm", clip: [1, 7], answer: "Gold", country: "Videoland", topic: "Flags", countdown: 4 });
  });
  await scenario(5, "Create and save an audio question", async () => {
    await writeQuestion(4, { type: "audio", text: "Does the melody go up or down at the end?", file: "d03.mp3", answer: "Up", country: "Audioland", topic: "Music", countdown: 3 });
    // edits survive a browser refresh and an application restart
    await host.reload(); await H("conn").waitFor();
    await stopServer(); await startServer();
    await host.reload(); await proj.reload(); await H("conn").waitFor(); await P("projector").waitFor();
    await tab("questions");
    assert((await host.locator('[data-testid^="slot-"][data-status="published"]').count()) === 4, "four published questions should survive refresh and restart");
    if (!CLOUDFLARE) assert(readdirSync(path.join(DATA, "live", "media")).length === 3, "three media files should be on disk");
  });

  await scenario(6, "Preview all four presentation types, without moving the show", async () => {
    const before = (await wire("host")).session.rev;
    const expect = { 1: ".kind-text", 2: '[data-testid="question-image"]', 3: "video", 4: '[data-testid="audio-card"]' };
    for (const n of [1, 2, 3, 4]) {
      await openSlot(n);
      await host.locator(`[data-testid="inline-preview"] ${expect[n]}`).first().waitFor({ timeout: 8000 });
      await H("btn-preview-projector").click();
      await P("preview-ribbon").waitFor();
      await proj.locator(`[data-testid="question-card"] ${n === 1 ? ".fit" : expect[n]}`).first().waitFor({ timeout: 8000 });
      assert((await proj.locator('[data-testid="answer"]').count()) === 0, "a preview must not show the answer unless asked");
      if (n === 3) { // the host can run the clip on the projector preview
        await H("preview-media").locator('[data-testid="media-play"]').click();
        await proj.waitForFunction(() => { const v = document.querySelector("video"); return v && !v.paused && v.currentTime > 1.2; }, null, { timeout: 10000 });
      }
      await H("btn-end-preview").click();
      await P("preview-ribbon").waitFor({ state: "detached" });
    }
    const after = await wire("host");
    assert(after.session.rev === before && after.session.phase === "LOBBY" && after.session.stop === 0, "previews must not change the show");
  });

  // Flight length is set through the Settings tab. Long enough that a slow test machine can
  // still catch the plane in the air; later flights are skipped with the host's Skip button.
  await tab("settings"); await H("set-flight").fill("20"); await H("btn-save-settings").click(); await notice(/Settings saved/);
  // the rescue game's name and rules, stored apart from the question bank
  await tab("rescue");
  await H("rescue-title").fill("Paper plane relay");
  await H("rescue-rules").fill("Fold a paper plane\n\nThrow it past the line");
  assert(/2 rules/.test(await H("rules-count").innerText()), "blank lines are not rules");
  await H("btn-save-rescue").click(); await notice(/Rescue game saved/);

  await scenario(7, "Start the airplane animation: no question is revealed", async () => {
    await tab("show");
    await H("btn-fly").click();
    await phase("FLIGHT_ANIMATING");
    await P("flying-tag").waitFor();
    assert((await P("question-card").count()) === 0, "no question card during the flight");
    const w = await wire();
    assert(w.question === null && w.timer === null, "the projector is not even sent the question during the flight");
  });

  await scenario(8, "The animation ends on the destination waiting screen", async () => {
    await phase("DESTINATION_ARRIVED");
    await P("waiting-card").waitFor();
    assert(/Awaiting question/.test(await P("waiting-card").innerText()), "waiting card text");
    await sleep(2500); // and it stays there
    assert((await P("question-card").count()) === 0, "question must stay hidden after landing");
    assert((await wire()).question === null, "still nothing sent to the projector");
    assert((await wire("host")).session.phase === "DESTINATION_ARRIVED", "still waiting");
  });

  await scenario(9, "SHOW QUESTION shows the question without starting the timer", async () => {
    await H("btn-show").click();
    await phase("QUESTION_VISIBLE");
    await P("question-card").waitFor();
    assert(/Which planet do we live on/.test(await P("question-card").innerText()), "question text on the projector");
    assert((await P("choice-0").count()) === 1, "choices are shown");
    assert((await P("timer").getAttribute("data-state")) === "idle", "timer must be idle");
    await sleep(2500);
    assert((await P("timer").getAttribute("data-state")) === "idle" && (await P("timer").getAttribute("data-seconds")) === "8", "timer must not have started by itself");
    assert((await P("answer").count()) === 0, "no answer yet");
  });

  await scenario(10, "START TIMER begins the countdown", async () => {
    await H("btn-timer").click();
    await phase("TIMER_RUNNING");
    assert(["running", "urgent"].includes(await P("timer").getAttribute("data-state")), "timer running on the projector");
    const a = Number(await P("timer").getAttribute("data-seconds")); await sleep(1300);
    const b = Number(await P("timer").getAttribute("data-seconds"));
    assert(b < a || b === 0, `countdown should move (${a} -> ${b})`);
  });

  await scenario(11, "The timer ends with boards up and the answer still hidden", async () => {
    await phase("BOARDS_UP");
    await P("boards-up").waitFor();
    await sleep(1500);
    assert((await P("answer").count()) === 0 && (await proj.locator(".choices li.right").count()) === 0, "answer must stay hidden after time is up");
    assert((await wire()).answer === null, "the projector is not sent the answer before the reveal");
    assert((await wire("host")).session.phase === "BOARDS_UP", "still boards up");
  });

  await scenario(12, "REVEAL ANSWER shows the answer", async () => {
    await H("btn-reveal").click();
    await phase("ANSWER_REVEALED");
    await proj.locator('[data-testid="choice-1"].right').waitFor();
    assert(/We live on Earth/.test(await P("answer").innerText()), "explanation shown");
  });

  await scenario(13, "Eliminate every remaining contestant", async () => {
    await H("btn-review").click();
    await phase("ELIMINATION_REVIEW");
    await H("mark-all").click();
    await host.locator('[data-testid="btn-confirm"]', { hasText: "Eliminate 4" }).click();
  });

  await scenario(14, "The show enters ALL_ELIMINATED and does not start the rescue by itself", async () => {
    await phase("ALL_ELIMINATED");
    await P("all-eliminated").waitFor();
    await H("btn-rescue-start").waitFor();
    await sleep(2500);
    const s = (await wire("host")).session;
    assert(s.phase === "ALL_ELIMINATED" && s.rescue === null && s.stop === 1, "must wait for the host: no rescue, no flight");
    assert((await P("rescue-game").count()) === 0, "no rescue on the projector yet");
    assert(await H("btn-fly").isDisabled(), "cannot fly with nobody in the game");
  });

  await scenario(15, "The host starts the rescue game manually", async () => {
    await H("btn-rescue-start").click();
    await phase("RESCUE");
    await P("rescue-game").waitFor();
  });

  await scenario(16, "The projector shows the rescue game's rules", async () => {
    assert((await P("rescue-title").innerText()) === "Paper plane relay", "the game's name");
    const rules = await proj.locator('[data-testid="rescue-rules"] li').allInnerTexts();
    assert(rules.join("|") === "Fold a paper plane|Throw it past the line", `one numbered rule per line, got ${rules.join("|")}`);
    await sleep(2500);
    assert((await wire("host")).session.phase === "RESCUE", "the game never ends by itself");
    await proj.reload(); await P("rescue-game").waitFor(); // a refreshed projector comes back to the rules
  });

  await scenario(17, "The host returns the winners of the game", async () => {
    assert(await H("btn-rescue-apply").isDisabled(), "pick the winners first");
    await H("return-pick-Sofia").check(); await H("return-pick-Leo").check();
    await H("btn-rescue-apply").click();
    await phase("READY_TO_FLY");
    await P("rescue-done").waitFor();
    const s = (await wire("host")).session;
    assert(s.contestants.filter((c) => c.status === "active").map((c) => c.name).sort().join() === "Leo,Sofia", "exactly the chosen two are back");
  });

  await scenario(18, "The journey resumes with the next unplayed question", async () => {
    await H("btn-fly").click();
    await phase("FLIGHT_ANIMATING");
    await H("btn-skip").click(); // skipping must also land on the waiting card
    await phase("DESTINATION_ARRIVED");
    await P("waiting-card").waitFor();
    assert((await P("question-card").count()) === 0 && (await wire()).question === null, "skipping the flight must not reveal the question");
    const s = (await wire("host")).session;
    assert(s.stop === 2 && s.played.length === 2 && s.played[1].slot === 2, "destination 2 plays question 2, not question 1 again");
  });

  await scenario(19, "Refresh either screen during the destination waiting phase", async () => {
    await proj.reload(); await P("projector").waitFor();
    await P("waiting-card").waitFor();
    assert((await P("question-card").count()) === 0, "projector refresh must not reveal the question");
    await host.reload(); await H("conn").waitFor();
    await phase("DESTINATION_ARRIVED");
    assert((await H("btn-show").isEnabled()) && (await H("btn-timer").isDisabled()), "host comes back in the same step");
    assert((await wire()).question === null, "still nothing sent to the projector");
  });

  await scenario(20, "Question secrecy and synchronisation stay intact", async () => {
    // refresh while the question is visible: it comes back, and the timer is still stopped
    await H("btn-show").click(); await phase("QUESTION_VISIBLE");
    await P("question-image").waitFor();
    await proj.reload(); await P("projector").waitFor();
    await P("question-image").waitFor();
    await sleep(1500);
    assert((await P("timer").getAttribute("data-state")) === "idle", "refresh must not start the timer");
    assert((await wire()).answer === null, "no answer on the wire");
    // editing the live question changes the projector only when the host says so
    await openSlot(2); await H("f-text").fill("How many bands are in this picture?"); await H("btn-publish").click(); await notice(/Published question 2/);
    await tab("show");
    assert(/How many colour bands/.test(await P("question-card").innerText()), "projector keeps the earlier version");
    await H("btn-update-projector").click();
    await proj.locator('[data-testid="question-card"]', { hasText: "How many bands are in this picture?" }).waitFor();
    // refresh while the timer runs: the remaining time comes from the server's deadline
    await H("btn-timer").click(); await phase("TIMER_RUNNING");
    await H("btn-pause").click();
    await proj.reload(); await P("projector").waitFor(); await P("timer").waitFor();
    const hostSecs = Number(await H("host-timer").innerText()), projSecs = Number(await P("timer").getAttribute("data-seconds"));
    assert(hostSecs === projSecs && hostSecs > 0, `both screens show the same remaining time (${hostSecs} vs ${projSecs})`);
    await H("btn-resume").click(); await H("btn-timeup").click(); await phase("BOARDS_UP");
    await H("btn-reveal").click(); await phase("ANSWER_REVEALED");
    await H("btn-review").click(); await H("btn-confirm").click(); await phase("READY_TO_FLY");
    // video: playing or finishing the clip never starts the countdown
    await H("btn-fly").click(); await H("btn-skip").click(); await phase("DESTINATION_ARRIVED");
    await H("btn-show").click(); await phase("QUESTION_VISIBLE");
    await proj.mouse.click(700, 400);
    await H("media-play").click();
    await proj.waitForFunction(() => { const v = document.querySelector("video"); return v && !v.paused && v.currentTime > 1.3; }, null, { timeout: 10000 });
    await H("media-pause").click();
    await proj.waitForFunction(() => document.querySelector("video").paused);
    await H("media-replay").click();
    await host.locator('[data-testid="media-controls"][data-status="ended"]').waitFor({ timeout: 45000 }); // clip end (7s) reached
    const s = (await wire("host")).session;
    assert(s.phase === "QUESTION_VISIBLE" && s.timer === null, "the clip ending must not start the timer");
    await H("btn-timer").click(); await H("btn-timeup").click(); await H("btn-reveal").click(); await H("btn-review").click(); await H("btn-confirm").click(); await phase("READY_TO_FLY");
    // audio: themed card, host-controlled, and no file name anywhere on the projector
    await H("btn-fly").click(); await H("btn-skip").click(); await phase("DESTINATION_ARRIVED");
    await H("btn-show").click(); await phase("QUESTION_VISIBLE");
    await H("media-play").click();
    await proj.locator('[data-testid="audio-card"].playing').waitFor();
    await proj.waitForFunction(() => { const a = document.querySelector("audio"); return a && !a.paused && a.currentTime > 0.5; }, null, { timeout: 10000 });
    assert(!/d03|\.mp3/i.test(await proj.locator("body").innerText()) && !/d03/.test(JSON.stringify(await wire())), "no file name reaches the projector");
    assert((await host.locator('[data-testid="state"]').getAttribute("data-phase")) === (await P("projector").getAttribute("data-phase")), "both screens are in the same state");
  });
} finally {
  await browser.close();
  if (server) killServer();
  rmSync(DATA, { recursive: true, force: true });
}

const failed = results.filter((r) => !r[2]);
console.log(`\n  ${results.length - failed.length} of ${results.length} passed.`);
process.exit(failed.length ? 1 : 0);
