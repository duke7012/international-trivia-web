# Golden Bell: Around the World

A live-hosted quiz show for a room with a projector. An airplane flies a journey of 30 numbered
destinations; each destination is one question. The host runs everything from a dashboard.

**The rule the whole app is built around:** the host decides when the plane flies, when the
question appears, when the timer starts, and when the answer is revealed. These are four separate
buttons, and nothing in the app performs one of them on its own.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer. Nothing to install: running the show needs no
dependencies. (`npm install` is only needed for the tests and for deploying to Cloudflare.)

```bash
node server/server.mjs
```

Then open:

- **Host dashboard:** http://localhost:4173/host (the screen only you see)
- **Projector:** http://localhost:4173/projector (drag this window to the projector, press F11)

Click once on the projector window after opening it: browsers only allow sound after a click.
The dashboard tells you if the projector's sound is not on yet.

The show runs with no internet connection. Fonts, the 3D engine and all sounds are bundled.

### Host on one device, projector on another (same network)

By default the app only answers on the computer it runs on. To open the dashboard from a second
device on the same network:

```bash
HOST=0.0.0.0 node server/server.mjs
```

The server prints its network address and a **host PIN** for that run. The dashboard asks for it,
so the audience cannot open it. To choose your own, set `HOST_PASSWORD` (at least 10 characters).

### Host it online

The app can run permanently on a hosting service, so the host and the projector only need a
browser and an internet connection. It needs a host that offers:

- one always-on Node.js web service (not "serverless", and not a free plan that goes to sleep),
- a permanent disk for the `data` folder (questions, show state, uploaded media),
- exactly one running copy. The show's state lives in that one process.

Two ready-made setups are included: Cloudflare (below) and Render.

#### Cloudflare

Cloudflare has no always-on server with a disk, so the app runs there in a different shape with
the same show rules: a Worker serves the pages, one Durable Object holds and saves the live show,
and R2 storage holds uploaded media. `wrangler.jsonc` describes all of it.

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

```bash
npx wrangler secret put HOST_PASSWORD
```

The last command asks for the host password (at least 10 characters). Until it is set, the
dashboard stays locked and says so. Deploying prints your address, for example
`https://golden-bell.<your-subdomain>.workers.dev`.

You can also deploy without the command line: in the Cloudflare dashboard open Workers and Pages,
choose Create application, pick GitHub and select this repository. Name the Worker `golden-bell`
(it has to match the name in `wrangler.jsonc`). After it deploys, add `HOST_PASSWORD` as a secret
under the Worker's Settings, Variables and Secrets.

`npm run cf:dev` runs the Cloudflare version on your own computer (put `HOST_PASSWORD="..."` in a
file named `.dev.vars` first).

Things that differ on Cloudflare:

- Uploads travel in 16 MB pieces, because Cloudflare limits one request to 100 MB. A dropped
  piece is retried by itself.
- Media is stored in an R2 bucket named `golden-bell-media`. R2 has to be turned on for your
  account before the first deploy.

#### Render

`render.yaml` is a ready-made setup for [Render](https://render.com):

1. Create a Render account and add a payment method (a permanent disk needs a paid plan).
2. In Render choose **New**, then **Blueprint**, and connect this GitHub repository.
3. When asked for `HOST_PASSWORD`, type a phrase of at least 10 characters. This is what you will
   type to open the dashboard. It is stored in Render, never in the repository.
4. Apply. When the deploy finishes, Render shows the address, for example
   `https://golden-bell.onrender.com`. Open `/host` for the dashboard and `/projector` for the
   audience screen.

Any other host works with the same settings: run `node server/server.mjs` with `HOST=0.0.0.0`,
`PUBLIC_HOSTING=1`, `HOST_PASSWORD` set, `DATA_DIR` pointing at the permanent disk, and `PORT` set
to whatever port the host expects. The health check address is `/healthz`.

Things to know about running online:

- **Sign-in.** The dashboard asks for the host password once per browser and remembers it for 30
  days. Eight wrong tries from one address lock sign-in from that address for up to ten minutes.
- **The projector address is public.** Anyone who has it can watch the audience screen. They still
  never receive a question before you show it or an answer before you reveal it.
- **The venue needs internet.** If the connection drops, both screens show "Reconnecting" and catch
  up by themselves when it returns. For a venue with unreliable internet, run it on the laptop.
- **Deploys restart the app.** Pushing new code makes the service restart, which takes the show
  offline briefly. The show resumes exactly where it was. Do not push changes during an event.
- **Disk size.** The setup file asks for 5 GB. Uploaded videos count against it; you can enlarge
  the disk in Render later.
- **Back up before an important show.** Your content lives on that one disk.

Other options: `PORT` (default 4173), `DATA_DIR` (where show data is saved), `MAX_UPLOAD_MB`
(default 2048).

## How one question runs

| Step | Host presses | Show state | Projector |
| --- | --- | --- | --- |
| A | **Fly to next destination** | `FLIGHT_ANIMATING`, then `DESTINATION_ARRIVED` | Plane flies and lands. Waiting card: "Destination 12, awaiting question". No question, no timer. |
| B | **Show question** | `QUESTION_VISIBLE` | Question card with media and choices. Timer stopped. |
| C | **Start timer** | `TIMER_RUNNING`, then `BOARDS_UP` at zero | Countdown, then "Boards up!". Answer still hidden. |
| D | **Reveal answer** | `ANSWER_REVEALED` | Correct answer and explanation. |
| | **Check boards and eliminate** | `ELIMINATION_REVIEW`, then `READY_TO_FLY` | Who left the flight, who is still flying. |

Skipping the flight animation lands on the same waiting card. It never shows the question.

Useful extras on the dashboard: hide the question again, pause or reset the timer, call time
early, and play, pause, replay or mute a video or audio clip. Playing a clip, or a clip ending,
never starts the countdown.

Before take-off, **Show the rules** puts the show rules on the projector one card at a time:
each **Next rule** flies the plane further along the route, ending on the Golden Bell. Edit the
rules in **Settings** (one per line, up to 8). The rules close when the first flight leaves.

A video question opens with only the video and "Watch the following video". When the host
presses **Stop and show the question**, or the video finishes, the question writes itself out
and the video keeps looping, muted, beside it. **Watch again** goes back to the full video.

### What the projector knows

The projector is only *sent* a question after you press Show question, and an answer after you
press Reveal answer. So refreshing the projector on the waiting card cannot leak anything, and a
refresh mid-question brings back exactly what was on screen. A running timer is restored from the
server's deadline, not restarted.

## Questions

The app starts with **30 empty slots, each marked "Not configured"**. Nothing is preloaded. In the
**Questions** tab you can write, edit, delete, duplicate and reorder questions.

Slots 1 to 30 are the journey: **Next in order** plays them in turn. **Add a question** adds slots
past 30 (up to 200 in all), shown under **Extra questions**. Those are only ever played when a
contestant picks a topic, so a bigger bank gives every topic more to draw from. Deleting an extra
question removes its slot; deleting a journey question sets it back to "Not configured".

- **Presentation type** (separate from answer format): text only, image + text, video + text,
  audio + text.
- **Answer format:** multiple choice with four options, or a written answer with accepted
  variants.
- Also per question: country focus, topic, difficulty, explanation, host notes, countdown length.
- **Save draft** keeps it out of the show. **Publish** makes it playable. Publishing is blocked,
  with the reason shown, while something is missing or two questions share a country.
- The right-hand **projector preview** is the real projector card, live as you type, including
  image fit, size and crop position. It works any time.
- **Preview on projector** puts the card on the real projector under a "Preview" banner. It never
  moves the show, and is available between questions.
- You can edit during the show. If you edit the question that is on the projector, the audience
  keeps seeing the earlier version until you press **Update projector** on the Show tab.

In the live show the plane will not fly into a slot that is empty or still a draft. The Fly button
is disabled and says why.

### Media

Uploads are saved as files in the data folder on the show computer, not in the browser, so large
videos are fine (limit 2 GB per file by default, and the app refuses a file that will not fit on
the disk). Files get random names, and the audience never sees a file name. You can also link to a
file or a YouTube video by URL; an uploaded file is safer for a live show because a link needs
internet at the venue.

For video and audio you can set where the clip starts and ends.

### Order, or topic choice

Before each flight choose **Next in order** (the first unplayed slot) or **A contestant picks the
topic**. For a topic pick you can show the topics on the projector, select who is choosing, then
select the topic they say. The app draws an unused, published question from that topic at the
difficulty for that stage of the journey (by default destinations 1 to 10 are easy, 11 to 20
medium, 21 to 30 hard; change this in Settings). A topic with nothing eligible is disabled and
says why. After the flight you still press Show question and Start timer yourself.

## Your own show sounds

In **Settings, Show sounds**, press **Add sound files** and select all your audio files at once.
Each file is matched to its moment by its file name, and you can also set or replace any moment
by hand. A moment with no file of its own uses the built-in sound. The sounds are shared by the
live show and the demo rehearsal, and play on the projector.

| Moment | What happens | Recognised in a file name |
| --- | --- | --- |
| Plane in flight | Plays while the plane flies, and stops when it lands | `fast_forward` |
| Question on screen | Loops until you start the timer. Pauses while a question's own clip plays | `question_show` |
| Timer lead-in | Plays when you press Start timer. The countdown begins when it ends | `think_start` |
| Countdown, destinations 1 to 15 | Plays while the timer counts | `think_clock` |
| Countdown, destinations 16 to 30 | Plays while the timer counts | `think_drums` |
| Time is up | Plays once when the timer stops | `think_over` |
| Boards up | Loops after the time-up sound, while boards are raised | `contestant_answer_reveal` |
| Answer lead-in | Plays when you press Reveal answer. The answer appears when it ends | `correct_answer_reveal` |
| Correct answer appears | Plays as the answer appears | `correct_answer` |
| After the correct answer | Plays straight after the one above | `congratulations` |
| Checking eliminations | Loops while you mark who is out | `contestant_elimination` |
| Rescue game | Loops while the rescue game is on the projector (it pauses during the beat game's own beat) | `rescue` or `mayday` |
| Finale | Loops while the finale is on the projector | `finale` |

The two lead-ins change the timing on purpose: the host still presses Start timer and Reveal
answer, and the count or the answer then waits for the lead-in to finish (never more than 20
seconds). A projector that is refreshed mid-show rejoins looping music in the right place and
does not replay one-off sounds.

## Everyone eliminated: MAYDAY! Save the flight!

There is no scheduled rescue. A rescue only becomes possible when the last contestant is
eliminated. Then the show stops in `ALL_ELIMINATED`: the projector shows the emergency screen and
the dashboard shows **START RESCUE GAME**. Nothing else happens until you choose.

Everyone who is out plays **one game as a team**, and the team's score sets how many come back:

| Game | How it plays | Score |
|---|---|---|
| **Say it on the beat** | Eight flags light up one per beat; the team says each country on the beat. Five levels, each faster; the last one has no names. | levels passed |
| **Guess the doodle** | A country's outline draws itself, then a 10-second countdown. No guess in time and it skips. | countries guessed |
| **Semantle** | An archived [semantle.com](https://semantle.com/archive) puzzle fills the projector for 5 minutes; contestants come up and type. | best closeness out of 1000 |
| **Physical game** | Your own game (by default *Control tower*: stack paper cups in turns for 90 seconds) with its rules and a clock on screen. | what you enter, e.g. tower levels |

Each success adds a set percentage (10% by default), and reaching the game's threshold brings
everyone back. Semantle counts its closeness score the same way: every 100 points adds 5% by
default (so 900+ is 45%), and finding the word is everyone. The share becomes a number of passengers, at least one once anything is won.

1. Press **START RESCUE GAME**, pick a game, and check its rules and score ladder on the projector.
2. Press **Start**. For the beat and doodle games, mark each round **✓** or **✗** and press
   **Next**. For Semantle and the physical game, enter the score when the clock stops.
3. Tick who comes back (up to the number earned), and press **Return to the flight**.

Set the rates, thresholds, timings, Semantle puzzle numbers and the physical game's rules in the
**Rescue** tab. Each rescue round uses flags, countries and puzzles that have not been played yet.
**Leave rescue** goes back to the emergency screen; a second game shows as round 2. Semantle needs
internet at the venue; everything else is stored in the app.

The flags come from [REST Countries](https://restcountries.com/flags) and the country outlines from
[geoBoundaries](https://www.geoboundaries.org) (CC-BY 4.0). `node scripts/fetch-rescue-assets.mjs`
downloads them again after the bank in `shared/rescue-bank.mjs` changes.

An **emergency return** (you pick who comes back) and the **emergency rule** you set in advance are
always available, so the show can never be stuck with nobody in the game. Only eliminated
contestants can ever be picked.

After a rescue the journey continues with the next unplayed question. The question that caused the
wipe-out is not replayed.

## Rehearsing

- **Demo rehearsal** (switch at the top right) is a separate workspace with 12 sample questions
  covering all four presentation types, and a sample rescue game. It has its own roster and show state
  and never mixes with your live questions. The projector shows a "Rehearsal" ribbon.
- **Settings, Preview the flight** plays the animation (one flight, or a tour of all 30
  destinations) under a "Preview" banner. It works with an empty question bank.

## Your data

Everything is saved as you go in the `data/` folder next to the app: questions, the rescue game,
settings, uploaded media, and the state of the show itself. Closing the browser, refreshing, or
restarting the app loses nothing; a show interrupted mid-question resumes mid-question. To back up
or move a show, copy the `data/` folder. `data/live` is your show, `data/demo` is the rehearsal set.

## Tests

```bash
npm test             # the rules of the show, the sounds and the sign-in (no browser needed)
npm run test:e2e     # the 20 acceptance scenarios in a real browser
npm run test:sounds  # your own show sounds, each at its moment, in a real browser
```

To run the 20 scenarios against the Cloudflare version (served locally by `wrangler dev`), set
`TARGET=cloudflare` and `E2E_PASSWORD` to the password in `.dev.vars`.

The second needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).
It starts its own server with a throwaway data folder.

## How it is built

- `server/` is a small Node server with no dependencies. It holds the one authoritative show state,
  saves every change to disk, and pushes updates to both screens.
- `server/show.mjs` is the show itself, independent of where it runs. The Node server and the
  Cloudflare version in `cloudflare/` both wrap it, so the rules cannot differ between them.
- `shared/engine.mjs` is the state machine: every rule above is a few lines there, and
  `tests/engine.test.mjs` exercises each one.
- `public/js/projector/world.js` is the 3D journey (three.js). All artwork is built in code.
- `public/js/host/` is the dashboard (Preact, no build step).

Bundled open-source pieces, with their licence files in `public/vendor/`: three.js (MIT),
Preact (MIT), htm (Apache 2.0), and the typefaces Bricolage Grotesque and DM Mono (SIL Open Font
License 1.1).

## Assumptions and limits

This repository started empty, so anything defined only in an earlier written spec was built to
the standard reading:

- **Elimination:** after the answer is revealed, the host ticks everyone who got it wrong, and
  those contestants are out.
- **Roster:** the host types names (or adds numbered contestants) before the first flight.
- **Finale:** the host ends the journey when ready; everyone still in the game is a champion.

Known limits:

- YouTube links are supported in code but could not be tested where this was built (no access to
  YouTube). Test one at your venue, or upload the file instead.
- Which video formats play depends on the browser showing the projector. MP4 (H.264) plays in
  current Chrome, Edge and Safari. WebM plays there too, in Safari from version 14.1. Check each
  clip with the editor's preview on the show computer.
- The bundled display typeface covers Latin scripts. Other scripts (Korean, Japanese, Chinese and
  so on) are shown in the computer's own fonts.
- The bank has exactly 30 slots, one per destination.
