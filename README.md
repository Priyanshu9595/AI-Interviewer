# AI Interview Simulator Platform

An AI interviewer that runs complete first-round interviews on its own. A recruiter
describes the role once; the platform writes the question set, schedules the
interviews, conducts them as a spoken conversation, evaluates the candidate across
technical, communication and behavioural dimensions, and produces a scored report
with a hiring recommendation.

Interviews run either in the platform's own browser room, or — by pasting a
**Google Meet, Zoom or Microsoft Teams** link the recruiter already created —
inside that meeting, where a Playwright-driven Chromium joins as a participant
and conducts the interview by voice. See **[docs/MEETING_BOT.md](docs/MEETING_BOT.md)**
for that path, and **[docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)** for every
configuration value.

```
├── backend/       Express 5 + Prisma + PostgreSQL + Socket.IO + Groq
│   └── src/services/meetingBot/      Playwright bot that joins Meet/Zoom/Teams
├── frontend-v2/   Next.js 14 (App Router) + TypeScript + Tailwind  ← the frontend
├── docs/          setup guides
└── temp-repo/     unrelated scratch checkout — not part of the app
```

The application is **`backend/` + `frontend-v2/`**. `frontend-v2` is the only
frontend; an earlier Vite prototype was removed because half its sidebar routed to
an "under construction" placeholder.

---

## Quick start

**Prerequisites:** Node 20+, a PostgreSQL database (Neon works well), and a
[Groq API key](https://console.groq.com). Python 3 and/or `g++`/JDK are optional —
they are only needed to execute candidate code in those languages.

Run everything from the repository root:

```bash
npm run setup                 # installs backend + frontend dependencies

cp backend/.env.example backend/.env
#   fill in DATABASE_URL and GROQ_API_KEY

npm run db:push               # create the schema
npm run seed                  # optional: demo recruiter, sessions and candidates

npm run dev                   # starts BOTH apps
#   API  http://localhost:5000
#   Web  http://localhost:3000
```

Sign in with the seeded account — **`recruiter@demo.com` / `demo1234`**.

<details>
<summary>Running the two apps separately</summary>

```bash
npm run dev:api     # or: cd backend      && npm run dev
npm run dev:web     # or: cd frontend-v2  && npm run dev
```
</details>

### Root scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs the API and the web app together |
| `npm run build` | Builds both |
| `npm run typecheck` | Type-checks both |
| `npm run seed` | Loads demo data |
| `npm run db:push` / `db:studio` | Prisma schema push / browser |
| `npm run e2e` | Full end-to-end interview run (needs the API running) |

Use **Chrome or Edge** for the interview room: speech recognition relies on the
Web Speech API. Other browsers fall back to typed answers automatically.

---

## How it works

### The interview loop

```
Candidate opens their link
        │
        ▼
  PreCheckScreen ──── mic + camera check, device pick
        │
        ▼
  Socket.IO /interview  ◄──────────────┐
        │                              │
        ▼                              │
  InterviewStateMachine                │  ai_speak / state_change /
   owns the script:                    │  insight / coding_challenge
   which question is next,             │
   when a round ends                   │
        │                              │
        ├─► LiveInterviewerService ────┘
        │    owns the conversation: acknowledge,
        │    probe, rephrase, answer a doubt
        │
        ├─► InsightService      real-time signals per answer
        ├─► TranscriptService   every turn, with timing
        └─► on completion ─► EvaluationService ─► Report
```

The split matters: the **state machine** decides *what* comes next and cannot be
talked out of it, while the **interviewer service** decides only *how to react* to
an answer. That means the model cannot skip questions, reveal the question bank, or
end the interview early — those are structural guarantees, not prompt requests.

### When a candidate can join

The room opens **at the scheduled time — not before** — and the link **expires
`NO_SHOW_GRACE_MINUTES` after it** (5 by default) if nobody joined:

```
        scheduledAt              +2.5 min           +5 min
────────────┼─────────────────────────┼─────────────────┼──────────────
  TOO_EARLY │          OPEN           │      OPEN       │   EXPIRED
            │                    nudge email      marked ABSENT
```

A candidate who arrives early sees a live countdown and is let in automatically.
One who has *already joined* keeps their link regardless of the clock, so a
dropped connection mid-interview can always be resumed.

The same rule is enforced in two places — the HTTP context endpoint and the
Socket.IO handshake — because the socket is reachable directly and an HTTP-only
check would be advisory. Both call `evaluateJoinGate()`; there is no second copy
of the logic.

To change the window, set `NO_SHOW_GRACE_MINUTES`. It drives the nudge, the
expiry and the absent marking together, so they can never disagree.

### If report generation fails

A candidate can finish a full interview and still get no report — the LLM can be
rate limited, or the database can blip at the wrong moment. Losing an entire
assessment to a transient failure is not acceptable, so a completed interview
without a report is treated as outstanding work:

- The scheduler retries it, one at a time, with exponential backoff.
- A rate limit is honoured rather than hammered — the provider's own
  "try again in 11m24s" is parsed and respected.
- A **permanent** failure (nothing was ever said, so there is nothing to score)
  stops immediately instead of burning five attempts.
- The recruiter sees the state on the candidate row — *Generating report…*,
  *Report retrying in 8 minutes*, or *Report failed* with a **Retry now** button.

`GET /api/interviews/:id/evaluation` returns that state,
`POST /api/interviews/:id/evaluate` forces a fresh attempt, and
`npm run pending` lists everything still waiting.

### Speech to text

Candidate audio is streamed to **this server**, which relays it to Deepgram and
sends transcripts back over the same interview socket. The API key never reaches
the browser — a browser-held key is trivially lifted from the network tab.

Deepgram's own end-of-speech signal decides when an answer is finished, which
beats a fixed client-side silence timer: it tolerates a candidate pausing
mid-sentence to think.

If `DEEPGRAM_API_KEY` is unset, or Deepgram becomes unreachable mid-interview,
the room automatically falls back to the browser's built-in recognition (Chrome
and Edge only). `GET /health` reports which is active as `speechToText`.

### Storage: what lives where

| Asset | Where | Why |
|---|---|---|
| Interview recordings | Cloudinary | Large, and must survive a container restart |
| Resume files | **Postgres** (`Bytes`) | Small, and part of the hiring record — kept with the interview it belongs to |
| Parsed resume text and profile | Postgres | Queryable, feeds question generation and evaluation |

Recordings are **cloud-only**: if Cloudinary rejects an upload, the streamed
chunks stay queued and retry on the next scheduler tick rather than being
written into the app's `uploads/` folder, where they would look stored but
vanish on the next deploy. Cloudinary is verified at boot and reported by
`/health` as `recordingStorage`.

A resume upload stores the file and its extracted text **before** attempting AI
analysis, so a provider outage never costs the candidate their upload — the
profile and tailored questions are filled in later by the scheduler.

### Recordings

Recordings are listed under **Recordings** in the sidebar, and reachable per
candidate from a session's candidate list and from the report page.

**Recordings are streamed, not buffered.** The browser ships a chunk every five
seconds and the server appends it. The original design held the whole recording
in memory and uploaded once at the end, which meant closing the tab, refreshing,
or a dropped socket lost the entire session — and in practice, that is what
happened. Now the worst case is losing the last five seconds. When an interview
ends the server assembles whatever arrived, so an abandoned interview still
produces a playable recording.

### LLM quota

Every conversational turn, question set and report is a live model call, so the
provider's quota is a real operational limit. When it is hit:

- The error is recognised and the provider's own "try again in 1h5m" is parsed
  (hours, minutes and seconds).
- A **global cooldown** pauses all model calls until then. Without it, every
  retry rediscovered the block, flooding the log and burning a request each time.
- Callers get **HTTP 429** with a `Retry-After` header and a message naming the
  wait — not an opaque 500.
- Question generation falls back to a deterministic template set, so a session
  is never left unusable.

On Groq's free tier the daily limit is 100,000 tokens, which a few full
interviews will exhaust. `GROQ_SMART_MODEL` (evaluation, question generation) is
the expensive one; point it at a smaller model to stretch the quota.

Playback needs a URL rather than a protected byte stream, because a `<video>`
element cannot send an `Authorization` header. The authenticated endpoint
therefore returns a URL — the Cloudinary one, or a short-lived signed route for
local files — and the player uses that. Local playback supports HTTP range
requests so seeking works instead of buffering the whole file.

### Rounds

`GREETING → IDENTITY → INTRO → HR → TECHNICAL → SCENARIO → PROJECT → CODING → CLOSING`

Rounds present in a given interview depend on the type (Technical / HR / Mixed) and
whether coding is enabled. Within a round the AI may ask up to two follow-ups per
question before the machine forces progress.

### Resumes

A resume is optional — the interview runs from the job description either way.
When one is uploaded (by the candidate on the pre-check screen, or by the
recruiter from the candidates list), three things change:

1. **Text is extracted** from the PDF/DOCX/TXT and analysed against the job
   description into a structured profile: skills, roles, projects, and — the
   useful part — `claimsToProbe` (quantified claims worth verifying live) and
   `missingJdSkills` (required skills the resume never evidences).
2. **Per-candidate questions are written** against that profile and spliced into
   the project round. The session's shared question set stays job-description
   driven so every candidate faces the same core questions; the resume questions
   are additive.
3. **The live interviewer is briefed** on the background, so its follow-ups can
   push on a vague answer about something the resume claims.

The interviewer is explicitly instructed never to say "your resume says" — it
behaves as though it was briefed before the call. At evaluation time the resume
is used only to notice a gap between what was claimed and what the candidate
could actually explain; scores come from the interview.

### Scoring

| Dimension | How it is produced |
|---|---|
| **Communication** | Rule-based, from measured speech: pause length before answering, filler-word density, speaking rate, lexical variety, sentence length, ASR confidence. Not an LLM opinion. |
| **Technical / Behavioural** | LLM judgement over the transcript, constrained to cite a specific moment for every strength and weakness, and calibrated to the stated experience level. |
| **Coding** | Real execution against test cases (60%), plus code quality, readability and whether the complexity matches the optimal solution. Included whenever the recruiter enables it and the round is not HR-only — a short session shrinks the spoken questions instead of dropping the challenge. |
| **Video confidence** | Face presence, gaze steadiness and movement, sampled in the browser. |

The overall score is a weighted blend whose weights shift by interview type — an HR
round is not decided by a technical score derived from three questions. Any
dimension that could not be measured has its weight redistributed rather than
counted as zero.

The **hiring recommendation** applies hard gates on top of the score: three or more
red flags forces Reject, and Strong Hire additionally requires technical ≥ 8,
communication ≥ 7 and no red flags — so a fluent talker with no substance cannot
top the list.

---

## Feature map

| Requirement | Where it lives |
|---|---|
| Session creation, JD, skills, type, schedule, duration | `session.controller.ts`, `/sessions/new` |
| Candidate upload, single and bulk CSV/Excel | `candidate.controller.ts`, `CandidatesTab.tsx` |
| Resume upload, parsing and per-candidate questions | `ResumeService.ts`, `ResumeUpload.tsx`, `ResumePanel.tsx` |
| Meeting links (Meet / Zoom / Teams / built-in) | `lib/providers/` |
| AI joins an existing Meet / Zoom / Teams link and interviews there | `services/meetingBot/`, `/ai-interviews` — [guide](docs/MEETING_BOT.md) |
| Per-platform join flow, pre-join, camera/mic, lobby admission | `meetingBot/platforms/`, `selectors.ts` |
| Meeting audio in and out (WebRTC tap, synthetic microphone) | `meetingBot/audioManager.ts`, `injected/audioBridge.ts` |
| Live bot status over Socket.IO | `realtime/meetBotGateway.ts`, `hooks/useMeetBot.ts` |
| Invitations and 24h / 1h / 5min reminders | `SchedulerService.ts` |
| No-show detection and absent marking | `SchedulerService.ts` + `InterviewStateMachine.ts` |
| Dynamic question generation from the JD | `QuestionGenerationService.ts` |
| Live voice interview | `useSpeech.ts`, `LiveRoom.tsx`, `interviewGateway.ts` |
| Identity verification | `InterviewStateMachine.afterIdentity` |
| Follow-ups, doubts, clarifications | `LiveInterviewerService.ts` |
| Communication analysis | `CommunicationAnalyzer.ts` |
| Technical and behavioural assessment | `EvaluationService.ts` |
| Real-time intelligence (hesitation, pauses, confidence) | `InsightService.ts` |
| Coding assessment with execution | `CodeExecutorService.ts`, `CodeAnalysisService.ts` |
| Video / facial / emotion analysis | `useVideoAnalysis.ts`, `VideoAnalysisService.ts` |
| Recording and transcripts | `interview.controller.ts`, `TranscriptService.ts` |
| Reports, PDF and Excel export | `ExportService.ts`, `/reports/[id]` |
| Candidate ranking and comparison | `RankingService.ts`, `/sessions/[id]/compare` |
| Recruiter dashboard and analytics | `/dashboard`, `/analytics` |
| Multi-language interviews | `services/personality.ts` (15 locales) |
| Custom interviewer personalities | `services/personality.ts` (4 personas) |
| ATS integration | `AtsService.ts`, `/integrations` |
| Automated feedback emails | `report.controller.ts`, `EmailService.ts` |
| Shortlist recommendations | `RankingService.shortlist` |

---

## Configuration

Everything is validated at boot by `src/lib/env.ts`; the process refuses to start
with an invalid configuration rather than failing later.

### Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | ≥ 10 characters |
| `JWT_REFRESH_SECRET` | ≥ 10 characters, different from the above |
| `GROQ_API_KEY` | From console.groq.com |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | API port |
| `APP_URL` | `http://localhost:3000` | Used to build candidate links in emails |
| `GROQ_FAST_MODEL` | `llama-3.1-8b-instant` | Per-turn conversation (latency matters) |
| `GROQ_SMART_MODEL` | `llama-3.3-70b-versatile` | Question generation and evaluation |
| `API_KEY_FOR_EMAIL` | — | Brevo key. Without it, emails are logged instead of sent |
| `EMAIL_FROM` | — | **Must be a sender verified in Brevo** — see below |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | — | Recording and resume storage. Falls back to local disk |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | — | Google Meet links |
| `ZOOM_ACCOUNT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` | — | Zoom links |
| `MS_TENANT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` / `MS_ORGANIZER_ID` | — | Teams links |
| `SCHEDULER_ENABLED` | `true` | Set `false` on replicas so reminders send once |
| `SCHEDULER_INTERVAL_MS` | `60000` | Reminder tick |
| `NO_SHOW_GRACE_MINUTES` | `5` | Wait before marking a candidate absent |
| `CODE_EXEC_ENABLED` | `true` | Set `false` to disable code execution entirely |
| `CODE_EXEC_TIMEOUT_MS` | `5000` | Per-test-case wall clock |

Frontend needs one variable, in `frontend-v2/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:5000
```

---

### Email: the one setting that silently breaks

Brevo answers `201 Created` and **then** discards the message if `EMAIL_FROM` is
not a sender you have verified, so a send that looks successful never arrives.
Nothing in the response tells you.

The server therefore checks at boot and refuses to attempt a send it knows will
be rejected:

```
[email] sending as you@yourdomain.com (verified)          <- good
[email] EMAIL_FROM="no-reply@example.com" is NOT a verified Brevo sender
[email] Verify it at https://app.brevo.com/senders, or set EMAIL_FROM to one of: …
```

`GET /health` reports the same thing as `emailSender`: `verified`,
`unverified`, `unchecked` or `disabled`. If it is not `verified`, no candidate
will receive an invitation.

To fix: add and confirm the address at
[app.brevo.com/senders](https://app.brevo.com/senders), or authenticate the whole
domain for a professional `no-reply@yourcompany.com` sender.

### Recordings and resumes

Both go to Cloudinary when the three `CLOUDINARY_*` variables are set, and to
`backend/uploads/` otherwise. A Cloudinary outage falls back to local disk rather
than losing the file. Local storage does not survive a container restart, so set
Cloudinary for any real deployment.

Recording playback redirects to the Cloudinary URL; local recordings stream from
the API. Replacing a recording deletes the previous asset rather than orphaning it.

## Deployment

### Backend

```bash
cd backend
npm ci
npm run build          # prisma generate && tsc  →  dist/
npm start              # node dist/server.js
```

Runs anywhere Node runs — Railway, Render, Fly.io, ECS, a VM. It needs a writable
`uploads/` directory for recordings and a persistent filesystem, or an object-store
adapter in front of `interview.controller.ts`.

**Scaling:** the interview state machine is held **in memory**, so all sockets for
one interview must reach the same instance. Behind a load balancer, either enable
sticky sessions or add the Socket.IO Redis adapter. Set `SCHEDULER_ENABLED=false`
on every replica but one, otherwise candidates receive duplicate reminders.

### Frontend

```bash
cd frontend-v2
npm ci
npm run build
npm start
```

Deploys cleanly to Vercel. Set `NEXT_PUBLIC_API_URL` to the public API origin.

### Database

`npx prisma db push` is fine for development. For production use migrations:

```bash
npx prisma migrate dev --name init     # once, to author the migration
npx prisma migrate deploy              # in CI/CD
```

### Production checklist

- [ ] Replace the development `JWT_SECRET` and `JWT_REFRESH_SECRET` with random values
- [ ] Serve both apps over HTTPS — `getUserMedia` and the Web Speech API require a secure context
- [ ] Restrict CORS in `server.ts` from `origin: true` to your actual frontend origin
- [ ] Rotate the API keys that were committed to `.env` during development
- [ ] Run code execution in a container with a read-only root filesystem, a memory cap and no network (see below)
- [ ] Point `uploads/` at durable storage, or swap in S3
- [ ] Set `SCHEDULER_ENABLED=false` on all but one replica

---

## Security notes

**Code execution is sandboxed, not isolated.** Submitted code runs as a child
process with a blank environment, a working directory under the OS temp dir, a wall
clock limit, an output cap, and a static ban on process/network/filesystem APIs.
That stops accidents and casual abuse. It is **not** a hardened boundary — a
determined attacker who can submit code can still read files the server user can
read. For untrusted candidates, run the backend in a container with no network
egress and a read-only filesystem, or set `CODE_EXEC_ENABLED=false`.

**Video analysis never transmits imagery.** The browser samples frames to a 64×48
canvas, computes face presence, motion and gaze steadiness locally, and posts only
those four numbers. No frame, image or face embedding leaves the candidate's
machine, and nothing is stored server-side beyond the aggregates.

**Access tokens.** Each candidate gets an unguessable UUID in their interview URL.
It grants access only to that one interview and expires implicitly when the
interview is marked complete or absent. Recruiter endpoints are separately
protected by a short-lived JWT plus an httpOnly refresh cookie.

**What the AI is prevented from doing** — structurally, not by asking politely: it
cannot choose which question comes next, reveal expected answers or scores, skip
ahead, or end the interview early. `LiveInterviewerService.sanitise()` overrides an
unprompted `END_EARLY` and truncates acknowledgements that drift into a second
introduction.

---

## Verifying it works

```bash
npm run typecheck       # both apps
npm run build           # both apps

npm run dev:api         # in one terminal
npm run e2e             # in another
```

Targeted checks, run from `backend/` (all need the API running except the last three):

| Command | Verifies |
|---|---|
| `npm run verify:e2e` | A whole interview: session → questions → invite → conversation → report → exports → ranking |
| `npm run verify:coding` | Optimal vs brute-force vs broken submissions score correctly, hidden tests run |
| `npm run verify:resume` | PDF extraction, profile analysis, missing-skill detection, tailored questions |
| `npm run verify:noshow` | Nudge inside the grace window, absent after it, future sessions untouched, idempotent |
| `npm run verify:storage` | Cloudinary upload or local fallback, path traversal blocked, delete works |
| `npm run verify:codingflow` | A coding question is generated, pushed to the editor, and runs on the compiler |
| `npm run verify:gate` | Room does not open early; unused links expire; reconnects still work |
| `npm run verify:recording` | Chunk streaming, abandoned-tab salvage, auth-free playback, range seeking |
| `npm run verify:ratelimit` | Quota hints parsed (h/m/s), global cooldown engages and extends |
| `npm run verify:speech` | Deepgram key, pre-recorded transcription, live socket |
| `npm run verify:resumedb` | Resume bytes stored in Postgres and served back byte-identical |
| `npm run diagnose` | Recent interviews: what was captured, what is missing, and why |

`backend/e2e.ts` creates a session, waits for question generation, invites a
candidate, runs the entire interview over Socket.IO with realistic answers and
timings, then verifies the report, exports, ranking and analytics. It takes several
minutes because every conversational turn is a real model call.

A passing run looks like this:

```
28 AI turns · rounds: GREETING → IDENTITY → INTRO → HR → TECHNICAL → SCENARIO → PROJECT → CLOSING
Overall 7.9 · Technical 7.6 · Communication 9.0 · Behavioral 7.0 · Video 7.9 → HIRE
55 transcript turns · 11 live signals · PDF/Excel exports · ranking · analytics
E2E PASSED
```

---

## Known limitations

- **Speech recognition is browser-provided.** Chrome and Edge are fully supported;
  Firefox and Safari fall back to typed answers. Swapping in Deepgram or Whisper
  would mean replacing `useSpeech.ts` only — the socket protocol does not change.
- **Interview state is in memory.** A backend restart mid-interview loses the
  in-flight session; the candidate would need to rejoin, and the state machine would
  restart from the greeting. Persisting the machine would fix this.
- **Emotion detection is heuristic.** It is derived from skin-tone centroid
  stability and inter-frame motion, not a trained facial-expression model. The
  labels (`ENGAGED`, `TENSE`, `RESTLESS`, `DISTRACTED`) are honest proxies for
  presence and steadiness — treat them as engagement signals, not psychology.
- **Question generation depends on the LLM.** If Groq is unavailable, a deterministic
  template set is used instead so a session is never left unusable, but those
  questions are generic rather than JD-specific.

# AI-Interviewer
