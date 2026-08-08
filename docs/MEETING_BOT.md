# The meeting interviewer

The recruiter creates the meeting themselves — **Google Meet, Zoom or Microsoft
Teams** — and pastes the link. At the scheduled time a Playwright-driven
Chromium joins that meeting, waits for the candidate, conducts the interview by
voice, writes the transcript and files a report.

It never creates a meeting, never types a password, and never tries to get past
a security check. If a platform asks for one, the bot stops and says so.

Environment variables are documented separately in
[ENVIRONMENT.md](ENVIRONMENT.md).

---

## 1. How the audio actually works

This is the part worth understanding before anything else, because it is where
meeting bots usually go wrong. It is identical on all three platforms — all
three web clients are WebRTC in a browser.

```
  Candidate speaks
        │
        ▼
  Meeting client ── WebRTC remote audio track
        │
        ▼
  Injected bridge  ──  taps RTCPeerConnection, mixes, downsamples to 16 kHz
        │
        ▼
  Deepgram streaming STT  ──►  transcript
        │
        ▼
  Groq  ──►  next question / follow-up / score
        │
        ▼
  Text-to-speech  ──►  PCM
        │
        ▼
  Injected bridge  ──  writes into a MediaStreamAudioDestinationNode
        │
        ▼
  Meeting client   (this node IS the microphone it was handed)
        │
        ▼
  Candidate hears the AI
```

Two directions, kept strictly apart in
[`audioManager.ts`](../backend/src/services/meetingBot/audioManager.ts):

**inputAudio.** Three taps, because the three clients deliver remote audio in
three different ways:

1. **WebRTC** — `RTCPeerConnection` is wrapped before the client's own code
   loads, and every inbound audio track is tapped. This is Google Meet and
   Teams, and it is the cleanest: samples are read before they reach a speaker.
2. **Web Audio** — `AudioNode.connect` is watched, so anything the page routes
   to a speaker can be routed to the bridge as well. **Zoom needs this**: its
   web client decodes audio in WebAssembly and plays it through its own
   `AudioContext`, so no remote track ever exists for tap 1 to find.
3. **Media elements** — `<audio>`/`<video>` captured with `captureStream()`.

Taps 2 and 3 stay dormant until tap 1 has produced nothing for twelve seconds.
Enabling them unconditionally would double-count wherever tap 1 already works —
the same voice at twice the amplitude. Routing is *observed* from the first
moment either way, so a graph connected long before the fallback fires is still
picked up.

Reading the audio at the source — rather than recording whatever the speakers
play — means the bot hears the candidate and never hears itself.

**outputAudio.** A participant speaks through whatever `getUserMedia` returned.
The bridge replaces `getUserMedia` with one that returns a
`MediaStreamAudioDestinationNode` it owns, so the meeting treats that node as
the microphone and the bot writes synthesised speech into it.

Browser speakers are **not** the meeting microphone. Anything that plays to a
sound device — including `speechSynthesis` — reaches nobody in the meeting
unless the operating system routes it back in.

### The two voice options

| | `MEET_BOT_TTS=deepgram` (default) | `MEET_BOT_TTS=webspeech` |
|---|---|---|
| How | Deepgram Aura returns PCM, injected into the synthetic microphone | Browser `SpeechSynthesis`, played to the OS audio device |
| Host setup | None | A virtual audio cable (§7) |
| Headless | Works | Needs a real audio device |
| Cost | Billed per character, on the Deepgram key already required for transcription | Free |

`deepgram` is the default because `speechSynthesis` exposes no audio samples —
there is no API that hands you the bytes — so on its own it cannot reach the
meeting at all. `webspeech` is fully implemented and supported for anyone who
would rather configure a cable than pay for synthesis.

---

## 2. What each platform needs

| | Google Meet | Zoom | Microsoft Teams |
|---|---|---|---|
| Bot account | **Required** | Optional | Optional |
| How it joins | Signed in | Named guest | Anonymous guest |
| API keys | None | None | None |
| Link the bot opens | The link as given | The **web client** URL | The link as given |
| Meeting setting to check | — | Not restricted to signed-in users | Anonymous join allowed |

**No API keys anywhere.** The bot drives a browser, so it needs no Zoom app, no
Microsoft Graph registration and no Google OAuth client. (The `ZOOM_*`, `MS_*`
and `GOOGLE_CLIENT_*` variables belong to the older feature that *creates*
meetings — see [ENVIRONMENT.md §8](ENVIRONMENT.md).)

Two platform quirks worth knowing:

**Zoom's normal link does not open a meeting.** `https://…zoom.us/j/8551234567`
opens a page whose job is to launch the desktop app, with "Join from your
browser" underneath. The bot rewrites it to `…/wc/8551234567/join?pwd=…` and
goes straight there — the same destination that link leads to, minus a page
selling the native app. The recruiter and candidate keep the link they know;
only the bot uses the rewritten one.

**Zoom passcodes must be in the link.** Copy the full invitation URL, the one
ending `?pwd=…`. The form warns you if it is missing.

---

## 3. Prerequisites

| What | Why |
|---|---|
| PostgreSQL | Interviews, transcripts, reports |
| Groq API key | The interviewer's reasoning |
| Deepgram API key | Speech to text — **required**, there is no browser to fall back to |
| Google account | Only for Google Meet; a dedicated one, see §5 |
| Google Chrome | Optional; Playwright's bundled Chromium works |

---

## 4. Install

```bash
npm run setup                             # backend + frontend dependencies
npm --prefix backend run bot:install      # downloads Chromium for Playwright
npm --prefix backend run db:push          # creates the MeetBotRun table
```

Copy `backend/.env.example` to `backend/.env`. The five values you must fill in
are listed in [ENVIRONMENT.md §1](ENVIRONMENT.md).

---

## 5. The bot's accounts

Create a **separate** Google account for the interviewer. Do not use a personal
or admin account: the profile directory below grants access to whatever signs
into it.

```bash
npm --prefix backend run bot:login            # Google — required for Meet
npm --prefix backend run bot:login -- zoom    # optional
npm --prefix backend run bot:login -- teams   # optional
```

A window opens. Sign in as the bot account, clear any verification, tick
*remember this device* if offered, and confirm the platform loads signed in.
Press Enter in the terminal and the helper checks the session actually stuck.

All three share the one Chromium profile at `GOOGLE_BOT_PROFILE_PATH`. **Treat
that directory as a credential.** It is gitignored; keep it off shared volumes
and back it up the way you would a private key.

Every interview clones the profile into a temporary directory and deletes the
copy afterwards. Chromium takes an exclusive lock on a user-data directory, so
without the clone two interviews at once would fail to start.

Re-run `bot:login` when the status shows `SIGN_IN_REQUIRED` (the session
expired) or `VERIFICATION_REQUIRED` (the platform wants a human — the bot will
not attempt these, by design).

---

## 6. Try it before scheduling anything

Start a meeting from your own account, then:

```bash
npm --prefix backend run bot:test -- https://meet.google.com/abc-defg-hij
npm --prefix backend run bot:test -- https://us05web.zoom.us/j/85512345678?pwd=xxxx
npm --prefix backend run bot:test -- "https://teams.microsoft.com/l/meetup-join/…"
```

Quote Teams links — their query strings contain characters the shell eats.

It joins, verifies the microphone injection and the capture tap, speaks a test
sentence, then listens for 45 seconds so you can check transcription:

```
  Platform : Zoom (guest join)
  Meeting  : https://us05web.zoom.us/j/85512345678?pwd=xxxx
  Bot uses : https://us05web.zoom.us/wc/85512345678/join?pwd=xxxx
  → OPENING_MEETING        Opening the Zoom meeting
  → PRE_JOIN               Setting up camera and microphone
  → WAITING_FOR_ADMISSION  Waiting in the Zoom waiting room
  → JOINED                 In the meeting
  ✓ microphone and capture verified
  ← heard: "testing one two three" (confidence 0.98)
```

If you hear the test sentence and see your own speech transcribed, everything
below will work.

---

## 7. Windows virtual audio (only for `MEET_BOT_TTS=webspeech`)

Skip this section entirely on the default `deepgram` voice.

`speechSynthesis` plays to the system audio device and returns no samples, so
the only way its output reaches the meeting is to loop the device back in as a
microphone.

1. Install **VB-CABLE** from <https://vb-audio.com/Cable/> and reboot.
2. *Sound settings → Output* → set **CABLE Input (VB-Audio Virtual Cable)** as
   the default playback device. The AI's voice now goes into the cable.
3. *Sound settings → Input* → set **CABLE Output (VB-Audio Virtual Cable)** as
   the default recording device. Chromium opens this as its microphone, so the
   meeting transmits whatever the cable carries.
4. Set `MEET_BOT_TTS=webspeech` and `MEET_BOT_HEADLESS=false`.

Only one cable is needed. The candidate's audio never touches it — that side is
tapped from the WebRTC tracks inside the page — so there is no feedback loop
between the two directions.

Two details the bot handles for you: Chromium is launched **without**
`--mute-audio` in this mode, since playback is the whole point; and the
synthetic-microphone override is disabled so the client opens the real device.

To check the routing: play any audio and watch the input level on **CABLE
Output** move in *Sound settings → Input*.

Linux equivalent: a PulseAudio null sink plus `remap-source` on its monitor.
macOS: BlackHole. Neither is needed for the default voice.

---

## 8. Scheduling an interview

Dashboard → **AI interviews** → **Create AI interview**. Paste any supported
link; the form recognises the platform as you type and validates the shape.

What happens then:

1. The link is validated and canonicalised before anything is stored.
2. Questions are generated from the job description and skills, in the
   background.
3. The candidate is emailed the **meeting link** — not the built-in room.
4. `MEET_BOT_JOIN_LEAD_MINUTES` before the start (default 5), the scheduler
   launches the bot. It joins and waits inside the meeting.
5. If the candidate arrives early, the bot says so and still starts at the
   scheduled time.
6. If nobody arrives, the two-phase wait below applies.

### Why an interview might not join by itself

Auto-join only happens while this server is running. Nothing is lost if it is
down — the run stays `SCHEDULED` in the database and is picked up on the next
boot — but a moment that has already passed cannot be joined retrospectively,
and after the wait window closes the run is cancelled as a missed one.

So the queue is printed at boot:

```
[meet-bot] 2 interview(s) queued:
           Priyanshu Raj (GOOGLE_MEET) — joining 9 Aug 2026, 12:30 pm
           Asha Menon (ZOOM) — joining 9 Aug 2026, 2:55 pm [overdue, starting now]
```

and `GET /api/interviews/queue` returns the same thing, with the configured
timings and how many of the concurrency slots are in use.

Three things worth knowing:

- **An interview scheduled for now starts immediately.** Its lead time is
  already in the past, so it does not wait for the next scheduler tick — which
  otherwise looked like up to a minute of nothing happening.
- **Rescheduling a session moves the bot with it.** The launch time is re-timed
  along with the reminder emails; previously it kept pointing at the original
  slot and the interview was written off as missed.
- **A wedged interview cannot block later ones.** Each session has a hard
  lifetime — lead + lobby + wait + 1.5× duration + margin — after which it is
  forced to stop and its concurrency slot released.

### How long the bot waits

For a 3:00 pm interview, with the defaults:

```
              3:00              3:05          3:07
               │                 │             │
               ▼                 ▼             ▼
               ├── primary wait ─┼── grace ────┤
        bot joins here           │             │
               └─── candidate arrives anywhere in here:
                    admit, and start immediately           │
                                                           ▼
                                                     CANCELLED
                                                  candidate absent
```

| Setting | Default | Meaning |
|---|---|---|
| `MEET_BOT_JOIN_LEAD_MINUTES` | 0 | Bot opens the meeting **at** 3:00. Raise it to join early and wait inside. |
| `MEET_BOT_CANDIDATE_WAIT_MINUTES` | 5 | Primary window: 3:00 → 3:05. |
| `MEET_BOT_CANDIDATE_GRACE_MINUTES` | 2 | Final window: 3:05 → 3:07. |

The launch is punctual to about a second, not to the nearest scheduler tick: an
interview due inside the next tick gets its own timer. Opening the meeting and
being admitted still takes a few seconds on top, as it would for a person.

A candidate arriving at **any** point in either window is admitted and the
interview begins at once — the grace window is not a lesser interview, just a
later start. One who arrives *before* 3:00 is greeted, told when the interview
begins, and asked to stay on the call; the bot does not start early.

The recruiter sees the phase change: the status detail moves from *"Waiting for
Priyanshu Raj — until 3:05 PM"* to *"Priyanshu Raj is late — final wait until
3:07 PM"*, and the same is written into the live conversation panel.

After 3:07 the run is recorded as **Cancelled** — not Failed, because nothing
broke — with the reason on the row, and the candidate is marked **absent**.

One exception: if somebody is visibly knocking at the deadline, the bot holds
the door for up to three more minutes while it keeps retrying admission. A
candidate sitting in the waiting room has turned up; cancelling on them would
record the wrong thing. If it still cannot admit them, the reason says so —
*"someone was in the waiting room but could not be admitted automatically"* —
rather than blaming the candidate for not coming.

**Start now** on the interview page skips the wait and launches immediately.

### Statuses

`SCHEDULED → STARTING → OPENING_MEETING → PRE_JOIN → WAITING_FOR_ADMISSION →
JOINED → WAITING_FOR_CANDIDATE → INTRODUCTION → QUESTIONING → FOLLOW_UP →
FINAL_QUESTION → ENDING → COMPLETED`, or `FAILED` with a reason.

They stream to the dashboard over Socket.IO on `/meet-bot` as
`interview:status`, `interview:joined`, `interview:message`,
`interview:question`, `interview:answer`, `interview:completed` and
`interview:error`. HTTP polling backs it up, so a blocked websocket makes the
page slower, not wrong.

If the meeting uses a lobby or waiting room the bot waits and the dashboard
shows **Waiting for admission** until someone admits it. It does not attempt to
enter any other way.

---

## 7a. Admitting the candidate

The bot admits anyone waiting, on every platform, every three seconds while it
is in the call.

This matters more than it sounds. Recruiters normally create the meeting from
the same account the bot signs in as, which makes **the bot the host** — and a
host that never presses Admit leaves the candidate in the waiting room for the
entire interview, producing a transcript of nothing but silence. Google Meet
says so plainly on the pre-join screen: *"People are waiting. Join to let them
in."*

It only ever presses **Admit**. Deny is not in any selector group, deliberately:
a bot that can refuse someone entry will eventually refuse the wrong person.

Admissions appear in the live conversation panel as
*"Let the candidate in from the waiting room."*

---

## 8a. The coding round

A meeting call has no shared editor, so the coding round moves to a browser tab.

Tick **Include a coding exercise** when creating the interview. Then:

1. The candidate's invitation email carries the editor link,
   `.../interview/<token>/code`, alongside the meeting link.
2. When the interviewer reaches the coding round, it says so out loud and posts
   the same link into the meeting chat.
3. The candidate opens it, writes their solution, runs it against the sample
   tests, and submits. The meeting stays open beside it — they are expected to
   keep talking through their thinking.
4. **The bot shares a live view of their code with the meeting** (below).
5. The submission is graded, scored and stored exactly as it is for the built-in
   room, and it is what tells the interviewer to carry on with the next
   question. Sharing stops at that point.
6. If nothing is submitted within a third of the interview's length, the
   interviewer moves on rather than stranding the interview.

### The live view

```
  CANDIDATE'S EDITOR                    THE MEETING
  /interview/<token>/code               (bot is presenting)
  ┌──────────────────────┐              ┌──────────────────────┐
  │ function solve(a,t){ │  websocket   │ 1  function solve(a,t│
  │   const m = new Map()│ ───────────► │ 2    const m = new Ma│
  │ }                    │   /coding    │ 3  }                 │
  │        [Run] [Submit]│              │            ● Live    │
  └──────────────────────┘              └──────────────────────┘
     candidate types                       everyone watches
                                           nobody else can type
```

The editor publishes its contents every 400 ms to the `/coding` namespace,
keyed by the interview and authenticated by the same access token that opens the
editor. A read-only spectator page at `.../code/live` renders it, and the bot
opens that page in a second tab and shares that tab into the meeting.

Two details worth knowing:

- The spectator page's `<title>` is fixed at **`AI Interview Candidate Code`**
  and must stay in step with `SHARE_TAB_TITLE` in
  [`browser.ts`](../backend/src/services/meetingBot/browser.ts). Chromium's
  share picker is browser chrome and cannot be clicked from a page, so the bot
  passes `--auto-select-tab-capture-source-by-title` instead. Change one and the
  bot will share the wrong thing.
- A spectator that connects late is sent whatever has been typed so far, so
  presenting halfway through a round does not show a blank screen.

Screen sharing is the least dependable thing the bot does — three different
"Present" menus, plus a picker steered by a flag. **It is best effort by
design.** If it fails, the round still works: the candidate has the editor, the
interviewer still receives the submission, and the failure is logged rather than
raised. The candidate sees a **Shared on screen** badge whenever the mirror is
connected, so they always know their code is visible.

The link is emailed as well as posted because a chat panel the candidate has
collapsed — or a client that hides it from guests — is not a reliable way to
hand someone something they need mid-interview. Chat posting is best effort; a
failure is logged and costs convenience, not the round. The recruiter can also
copy the link from the interview page, under **Details → Coding editor**.

> **`APP_URL` has to be right, or none of those links work.** It is the address
> the candidate is sent to. A backend running locally with
> `APP_URL=https://your-app.vercel.app` hands out links to a deployment that may
> not have the coding page in its build — the candidate gets a 404 mid-interview
> and there is no way to recover. For local testing set
> `APP_URL=http://localhost:3000`. The server warns at boot when it is running
> locally with a remote `APP_URL`.

Code execution runs in the same sandbox as everywhere else, so
`CODE_EXEC_ENABLED` and `CODE_EXEC_TIMEOUT_MS` apply.

---

## 8b. Reports

A report is written when the interviewer carries an interview through to its
closing round. The interview page shows which of these applies, rather than a
bare "no report":

| State | Meaning |
|---|---|
| **Report ready** | Done. |
| **Writing the report** | Finished seconds ago; evaluation is running. |
| **Retrying** | A temporary failure — a provider rate limit, most often. Retried automatically with backoff; the next attempt time is shown. |
| **Report failed** | Give it a nudge with **Retry now**. |
| **Nothing to score** | Nobody said anything. Usually an audio problem — see §9. |
| **Not scored** | The candidate left before the interviewer finished. Partial interviews are deliberately not scored, because a low score caused by walking out would misrepresent them. The transcript is kept in full. |

The most common real cause of a missing report is a Groq quota. The error is
shown verbatim on the page (`provider quota still exhausted, try again in 23m`),
the scheduler retries on its own, and **Retry now** forces an attempt as soon as
the quota clears.

---

## 9. When it fails

Every failure stores a code and a sentence on the run, both shown on the
interview page. The codes are defined in
[`errors.ts`](../backend/src/services/meetingBot/errors.ts).

| Code | What to do |
|---|---|
| `INVALID_MEETING_URL` | Not a Meet, Zoom or Teams link, or an incomplete one. |
| `SIGN_IN_REQUIRED` | Run `npm run bot:login` for that platform again. |
| `VERIFICATION_REQUIRED` | Sign in by hand and clear the check. The bot will not. |
| `GUEST_JOIN_BLOCKED` | Teams: anonymous join is off for this meeting. Zoom: it is restricted to signed-in users. Change the setting, or sign the bot in. |
| `PASSCODE_REQUIRED` | The Zoom link is missing its `?pwd=…`. Copy the full invitation link. |
| `ADMISSION_TIMEOUT` | Nobody let the bot in. Admit it, or turn off the lobby. |
| `ADMISSION_DENIED` | Someone declined the request. |
| `MEETING_NOT_STARTED` | The meeting had not opened yet. |
| `CANDIDATE_NO_SHOW` | Nobody joined inside the wait window. |
| `MICROPHONE_UNAVAILABLE` | The client never requested a microphone — usually a UI change; see §10. |
| `JOIN_CONTROL_NOT_FOUND` | The join button moved; see §10. |
| `SPEECH_TO_TEXT_UNAVAILABLE` | `DEEPGRAM_API_KEY` is missing or rejected. |
| `TTS_UNAVAILABLE` | Deepgram speech failed, or `speechSynthesis` produced nothing. |
| `BROWSER_LAUNCH_FAILED` | Run `npm run bot:install`. |
| `CAPACITY_REACHED` | Raise `MEET_BOT_MAX_CONCURRENT`, or add a replica. |
| `ALREADY_RUNNING` | A bot already has this interview. Nothing to do. |
| `NOT_STARTABLE` | The interview already finished; it cannot be started again. |

**Nothing starts at all.** Check `MEET_BOT_ENABLED`, then `GET /health`, which
reports `meetBot.enabled`, the configured voice, and how many are running
against capacity.

**The bot joins but says nothing.** Almost always the voice. On `deepgram`,
check the key and `MEET_BOT_TTS_MODEL`. On `webspeech`, re-check §7 — the usual
cause is the default *playback* device not being CABLE Input. On Zoom
specifically, it can also be the "Join Audio by Computer" prompt not appearing;
the bot presses it for six seconds and logs a warning if it never shows.

**The bot speaks but never hears anything.** This shows up as a transcript full
of `(no answer given)`. The bot notices it itself: after twelve seconds of
silence it switches on the Web Audio and media-element taps, and after forty it
logs

```
[meet-bot <id>] STILL NO AUDIO after 40s. Bridge: {"rtc":0,"webaudio":0,"element":0},
media elements 0, peak 0. The interviewer cannot hear the candidate.
```

and posts a warning to the dashboard. Read the numbers as follows:

| Reading | Meaning |
|---|---|
| all sources `0` | No audio source found at all. The client is delivering audio some fourth way, or nobody has joined. |
| a source `> 0`, `peak: 0` | Connected to silence. The candidate is muted, or their microphone is not working. |
| a source `> 0`, `peak > 0` | Audio is arriving. If there is still no transcript, the problem is Deepgram, not capture. |

`bot:test` prints the same summary at the end of its run.

**Join failed and the reason is not obvious.** Every failed join saves a
screenshot and a text dump of the page — the visible text plus every control's
accessible name and `data-*` hooks — to `backend/uploads/bot-debug/`:

```
[meet-bot <id>] saved join diagnostics: .../uploads/bot-debug/48c7342f-pre_join_not_found-....png
```

That file is what a selector is written against, so it turns a broken selector
from a guess into a five-minute fix. They are pruned after three days.

**Duplicate bots in one meeting.** Cannot happen from this system: the run is
claimed with a single conditional update, so a second replica or an overlapping
scheduler tick finds it taken. If you see two, one is a stale Chromium —
restart the server, which closes them on shutdown.

**A restart during an interview.** Scheduled interviews live in the database and
are not lost. Interviews that were mid-flight are released at boot by
`recoverOrphans` and marked failed with an explanation, so they can be retried
from the dashboard rather than sitting "running" with no browser behind them.

---

## 10. When a platform changes its interface

All three ship UI changes continuously and all three generate their class names,
so a class-based selector breaks on the next deploy. Every element the bot
touches is therefore described as an ordered list of strategies, in that
platform's driver under
[`platforms/`](../backend/src/services/meetingBot/platforms/):

```ts
joinButton: {
  description: 'join control',
  strategies: [
    { kind: 'css',  value: 'button[data-tid="prejoin-join-button"]' },
    { kind: 'role', role: 'button', name: /^join now$/i },
    { kind: 'text', value: /^join now$/i },
  ],
},
```

Accessible role and name first, then stable `data-*` attributes, then aria-label
substrings, then visible text. The first strategy that resolves to a visible
element wins, and **all frames are searched** — Teams renders its whole pre-join
in an iframe.

To fix a break: run `bot:test` with `MEET_BOT_HEADLESS=false`, inspect the
control that was missed, and add a strategy to the **front** of that group.
Nothing else in the bot needs to change.

Adding a fourth platform means writing one driver against
[`PlatformDriver`](../backend/src/services/meetingBot/platforms/types.ts) and
listing it in `platforms/index.ts`. The audio bridge, interview engine,
scheduler and dashboard are all platform-agnostic already.

---

## 11. Running more than one

Each concurrent interview is a full browser: budget roughly 400 MB of RAM and
one core. Raise `MEET_BOT_MAX_CONCURRENT` on a bigger machine, or run several
replicas — the database claim keeps them from colliding. Set
`SCHEDULER_ENABLED=false` on every replica but one, or candidates receive
duplicate reminder emails.

---

## 12. API

All recruiter endpoints require a bearer token and only return interviews from
the caller's own sessions.

```
POST   /api/interviews             create and schedule
GET    /api/interviews             list
GET    /api/interviews/:id         details
GET    /api/interviews/:id/status  current bot status (cheap; safe to poll)
GET    /api/interviews/:id/transcript
GET    /api/interviews/:id/report  → { reportId }
POST   /api/interviews/:id/start   start now
POST   /api/interviews/:id/stop    stop a running interview
```

Realtime lives on the `/meet-bot` Socket.IO namespace. Authenticate with the
access token in the handshake, then `subscribe` with `{ interviewId }`. It is
read-only: start and stop go through the REST endpoints, where ownership is
checked and the action is recorded.

---

## 13. What this deliberately does not do

- Create meetings. The recruiter supplies a link they already made.
- Store or type credentials. Sign-in is interactive and one-time.
- Solve CAPTCHAs, satisfy 2-step verification, or work around any security
  control. It stops and reports instead.
- Enter a meeting it has not been admitted to. A lobby means waiting.
- Join a meeting that disallows guests by pretending otherwise. It reports
  `GUEST_JOIN_BLOCKED` and leaves the setting to a human.
- Record video or run a coding round. A meeting call has no shared editor and no
  client to capture from, so both are off for these interviews rather than
  silently ignored.
