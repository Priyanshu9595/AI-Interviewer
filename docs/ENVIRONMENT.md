# Environment reference

Every variable the platform reads, what happens without it, and which ones the
meeting bot actually needs.

Configuration is validated at boot by
[`backend/src/lib/env.ts`](../backend/src/lib/env.ts). The process refuses to
start on an invalid value rather than failing hours later, so a typo here is a
crash at startup, not a failed interview.

There is exactly one secrets file: **`backend/.env`**. Nothing in it is ever
sent to the browser. The frontend has its own `frontend-v2/.env.local`, which
holds one public URL and no secrets at all.

---

## 1. The short answer

To run an AI interview inside a Google Meet, Zoom or Teams call, you need
**five** values:

```env
DATABASE_URL=postgresql://user:password@host/db?sslmode=require
JWT_SECRET=<32+ random characters>
JWT_REFRESH_SECRET=<a different 32+ random characters>
GROQ_API_KEY=gsk_...
DEEPGRAM_API_KEY=...
```

Everything else has a working default. `MEET_BOT_*` variables tune behaviour;
none of them are required.

Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 2. Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Neon, Supabase, RDS or local all work. Neon needs `?sslmode=require`. |
| `JWT_SECRET` | Signs recruiter access tokens. Minimum 10 characters; use 32+. |
| `JWT_REFRESH_SECRET` | Signs refresh tokens. **Must differ** from `JWT_SECRET` — reusing one value means a stolen access token can mint refresh tokens. |
| `GROQ_API_KEY` | <https://console.groq.com>. Generates questions, runs each conversational turn, writes the report. |
| `DEEPGRAM_API_KEY` | <https://console.deepgram.com>. **Required for the meeting bot.** The browser room can fall back to the browser's own speech recognition; a bot in a meeting has no browser to fall back to, so without this it cannot hear the candidate at all. Also powers the default voice. |

---

## 3. Server

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `production` \| `test`. |
| `PORT` | `5000` | API and websocket port. |
| `APP_URL` | the deployed Vercel URL | Where candidates are sent for browser-room interviews. **Must be reachable from outside your network in production** — it goes into invitation emails. Not used for meeting-bot interviews: those emails carry the meeting link instead. |
| `API_URL` | `http://localhost:5000` | This server's own public URL. |

---

## 4. Models

| Variable | Default | Notes |
|---|---|---|
| `GROQ_FAST_MODEL` | `llama-3.1-8b-instant` | Every conversational turn. Latency is felt directly by the candidate, so speed wins here. |
| `GROQ_SMART_MODEL` | `llama-3.3-70b-versatile` | Question generation and final evaluation, where quality matters more than speed. |

---

## 5. Meeting bot

None of these are required. The defaults are what you want for a first run.

| Variable | Default | Notes |
|---|---|---|
| `MEET_BOT_ENABLED` | `true` | Master switch. `false` stops the scheduler launching anything. |
| `GOOGLE_BOT_PROFILE_PATH` | `./.meet-bot-profile` | Chromium profile holding the bot's signed-in sessions. **Treat as a credential** — it grants access to whatever accounts are signed into it. Already gitignored. All three platforms share it. |
| `MEET_BOT_BROWSER_CHANNEL` | `chrome` | `chrome` \| `msedge` \| `chromium`. Real Chrome handles all three meeting clients best. Falls back to Playwright's bundled Chromium automatically if the channel is not installed. |
| `MEET_BOT_HEADLESS` | `false` | Meeting clients are markedly more reliable in a visible window. Turn this on only once joining works. |
| `MEET_BOT_DISPLAY_NAME` | `AI Interviewer` | What the candidate sees in the participant list. |
| `MEET_BOT_JOIN_LEAD_MINUTES` | `0` | Minutes before the scheduled time that the bot opens the meeting. `0` joins at the scheduled time itself; raise it to be inside before the candidate arrives. |
| `MEET_BOT_ADMISSION_TIMEOUT_MS` | `600000` | How long to sit in a lobby or waiting room (10 minutes). |
| `MEET_BOT_CANDIDATE_WAIT_MINUTES` | `5` | Primary wait for the candidate, **counted from the scheduled start**. A 3:00 interview waits to 3:05. |
| `MEET_BOT_CANDIDATE_GRACE_MINUTES` | `2` | Final window after that — 3:05 to 3:07 — then the interview is cancelled and the candidate marked absent. |
| `MEET_BOT_MAX_CONCURRENT` | `2` | Meetings per process. Each is a full browser: budget ~400 MB and one core each. |
| `MEET_BOT_TTS` | `deepgram` | `deepgram` \| `webspeech`. See below. |
| `MEET_BOT_TTS_MODEL` | `aura-2-thalia-en` | Deepgram voice. Only read when `MEET_BOT_TTS=deepgram`. |
| `MEET_BOT_TTS_RATE` | `1` | Speaking rate. Only read when `MEET_BOT_TTS=webspeech`. |

### Choosing a voice

`deepgram` synthesises server-side and injects the audio straight into the
synthetic microphone the bot hands the meeting. **Nothing to install**, works
headless, and reuses the Deepgram key you already need.

`webspeech` uses the browser's `SpeechSynthesis` API. Free, but it plays to a
sound device and returns no audio samples, so it only reaches the meeting if
the host routes its output back in through a virtual audio cable. Setup is in
[MEETING_BOT.md §7](MEETING_BOT.md).

### What the bot does *not* need

**The `GOOGLE_CLIENT_*`, `ZOOM_*` and `MS_*` variables in §8 have nothing to do
with the meeting bot.** Those are API credentials for the older provider system
that *creates* meetings on your behalf. The bot joins a link the recruiter
already made, using a browser — so it needs no API keys for Zoom or Teams at
all, and no Google OAuth app.

What each platform *does* need:

| Platform | Requirement |
|---|---|
| Google Meet | A signed-in bot profile: `npm run bot:login google`. Anonymous participants are refused by many meetings. |
| Zoom | Nothing. Joins as a named guest. Sign in with `npm run bot:login zoom` only for meetings restricted to authenticated users. |
| Microsoft Teams | Nothing, provided the meeting allows anonymous guests. Sign in with `npm run bot:login teams` for tenants that disallow them. |

---

## 6. Scheduler

| Variable | Default | Notes |
|---|---|---|
| `SCHEDULER_ENABLED` | `true` | Drives reminders, bot launches, no-show detection and report retries. **Set `false` on every replica but one**, or candidates get duplicate emails. |
| `SCHEDULER_INTERVAL_MS` | `60000` | Tick interval. Lower is more punctual at the cost of database round-trips. |
| `NO_SHOW_GRACE_MINUTES` | `5` | How long a browser-room candidate has before being marked absent. Meeting-bot interviews use their own two-phase wait instead, and the scheduler defers to it. |

---

## 7. Email

Without a key, emails are printed to the console instead of sent. The whole
scheduling path still runs, so local development is unaffected.

| Variable | Default | Notes |
|---|---|---|
| `API_KEY_FOR_EMAIL` | — | Brevo transactional API key. |
| `EMAIL_FROM` | `no-reply@aiinterview.app` | Must be a verified sender on your Brevo account. |
| `EMAIL_FROM_NAME` | `AI Interview Platform` | |

---

## 8. Meeting *creation* providers (optional, unrelated to the bot)

These let the platform create a meeting for you when scheduling a session the
old way. Any provider left blank falls back to the built-in interview room.
**Skip this whole section if you are using the meeting bot** — it joins links
you already have.

| Variable | For |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Creating Google Calendar events with Meet links |
| `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | Creating Zoom meetings via server-to-server OAuth |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_ORGANIZER_ID` | Creating Teams meetings via Microsoft Graph |

---

## 9. Code execution

Only used by browser-room interviews with a coding round. Meeting-bot
interviews have coding disabled: a meeting call has no shared editor.

| Variable | Default | Notes |
|---|---|---|
| `CODE_EXEC_ENABLED` | `true` | Set `false` for untrusted candidates unless the backend runs in a locked-down container. |
| `CODE_EXEC_TIMEOUT_MS` | `5000` | Wall-clock cap per submission. |

The sandbox blocks process, network and filesystem APIs and caps wall clock,
but it is **not a hardened boundary**.

---

## 10. Frontend

`frontend-v2/.env.local`. This is the only variable the browser sees, and it is
deliberately not a secret.

```env
NEXT_PUBLIC_API_URL=http://localhost:5000
```

Point it at the deployed API in production. It must be reachable from the
recruiter's browser, and it carries the websocket connection for live interview
status as well as the REST calls.

---

## 11. A complete `backend/.env` for the meeting bot

```env
# --- required ---------------------------------------------------------------
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
JWT_SECRET=replace_with_32_plus_random_characters
JWT_REFRESH_SECRET=replace_with_different_32_plus_random_characters
GROQ_API_KEY=gsk_...
DEEPGRAM_API_KEY=...

# --- server -----------------------------------------------------------------
PORT=5000
NODE_ENV=development
APP_URL=http://localhost:3000
API_URL=http://localhost:5000

# --- meeting bot ------------------------------------------------------------
MEET_BOT_ENABLED=true
GOOGLE_BOT_PROFILE_PATH=./.meet-bot-profile
MEET_BOT_BROWSER_CHANNEL=chrome
MEET_BOT_HEADLESS=false
MEET_BOT_DISPLAY_NAME=AI Interviewer
MEET_BOT_JOIN_LEAD_MINUTES=0
MEET_BOT_ADMISSION_TIMEOUT_MS=600000
MEET_BOT_CANDIDATE_WAIT_MINUTES=5
MEET_BOT_CANDIDATE_GRACE_MINUTES=2
MEET_BOT_MAX_CONCURRENT=2
MEET_BOT_TTS=deepgram
MEET_BOT_TTS_MODEL=aura-2-thalia-en

# --- email (optional; logs to console without it) ---------------------------
API_KEY_FOR_EMAIL=
EMAIL_FROM=no-reply@yourdomain.com
EMAIL_FROM_NAME=AI Interview Platform

# --- scheduler --------------------------------------------------------------
SCHEDULER_ENABLED=true
SCHEDULER_INTERVAL_MS=60000
NO_SHOW_GRACE_MINUTES=5
```

Then, once:

```bash
npm --prefix backend run bot:install        # Chromium for Playwright
npm --prefix backend run bot:login google   # sign the bot in, one time
npm --prefix backend run db:push            # create the tables
```

---

## 12. Checking it

`GET /health` reports what actually resolved at boot, which is faster than
reading the file back:

```json
{
  "status": "ok",
  "database": "ok",
  "emailSender": "verified",
  "speechToText": "ok",
  "meetBot": { "enabled": true, "voice": "deepgram", "running": 0, "capacity": 2 }
}
```

- `speechToText: "disabled"` — `DEEPGRAM_API_KEY` is missing. The bot cannot hear.
- `speechToText: "unreachable"` — the key was rejected, or the network is blocked.
- `emailSender: "console"` — no `API_KEY_FOR_EMAIL`; invitations are printed, not sent.

---

## 13. Handling secrets

- `backend/.env` is gitignored. Keep it that way.
- `backend/.meet-bot-profile/` is gitignored and is a credential in its own
  right — a copied profile is a signed-in session. Do not put it on a shared
  volume or in an image layer.
- No key in `backend/.env` is ever sent to the browser. Candidate audio is
  proxied through this server precisely so the Deepgram key stays here.
- Rotating `JWT_SECRET` or `JWT_REFRESH_SECRET` signs everyone out. That is the
  intended way to revoke every session at once.
