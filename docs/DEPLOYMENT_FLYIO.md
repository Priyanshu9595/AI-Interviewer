# Deploying to Fly.io

Backend on Fly, frontend on Vercel. Seven steps.

```
   Vercel                          Fly.io
   ┌────────────────────┐          ┌──────────────────────────────┐
   │ frontend-v2        │  HTTPS   │ backend                      │
   │ Next.js pages      │ ───────► │ API + Socket.IO              │
   │                    │  WSS     │ scheduler (always awake)     │
   │ NEXT_PUBLIC_API_URL│          │ Chromium under Xvfb          │
   └────────────────────┘          └──────────────────────────────┘
```

**No volume is needed.** The bot's Google session travels as a secret rather
than living on a disk — see step 4. That is what keeps this cheap and simple.

**Cost:** a `shared-cpu-2x` machine with 2 GB is roughly **$5–6/month**. Fly's
256 MB default cannot start Chromium at all, so this is the real floor, not an
upsell. Everything else here is free.

---

## 1. Install flyctl and sign in

**Windows (PowerShell):**
```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

**macOS / Linux:**
```bash
curl -L https://fly.io/install.sh | sh
```

```bash
fly auth login
```

Fly asks for a card even on small apps. Nothing is charged until the machine
runs.

---

## 2. Create the app

[`backend/fly.toml`](../backend/fly.toml) is already written — memory, health
check and the never-sleep setting are all in it. **Do not run `fly launch`**: it
would overwrite that file with defaults that do not work here.

```bash
cd backend
fly apps create ai-interviewer-api      # or any free name
```

If you pick a different name, change the `app = ` line at the top of
`fly.toml` to match.

---

## 2a. Check your database can stay awake

This catches people out around day four, so it is worth settling before you
deploy.

The scheduler queries the database every 60 seconds, for ever. That is the
whole point of it — it is what launches interviews on time. But it also means
the database never goes idle, and **Neon's free plan allows 100 CU-hours per
month, which is about four days of continuous compute.** After that Neon
suspends the compute until the next billing month and every interview fails.

| Option | Cost | Notes |
|---|---|---|
| **Fly Postgres** | ~$2–3/mo | A machine you control, same datacentre as the app, no compute-hour limit. `fly pg create` |
| **Supabase free** | free | Always-on; pauses only after ~7 days with no queries, which this never is |
| Neon free | free | **Runs out in ~4 days** of always-on use |
| Neon Launch | paid | Fine, but you are paying for a managed feature set you are not using |

If you are only testing for a few days, Neon free is genuinely fine — just know
the clock is running. For anything longer, move the database first; changing
`DATABASE_URL` later means re-running `npx prisma db push` against the new one.

---

## 3. Push your database and secrets

Secrets are encrypted at rest and injected as environment variables. Do them in
one command — each `fly secrets set` restarts the machine.

```bash
fly secrets set \
  DATABASE_URL="postgresql://...?sslmode=require" \
  GROQ_API_KEY="gsk_..." \
  DEEPGRAM_API_KEY="..." \
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  JWT_REFRESH_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  APP_URL="https://your-app.vercel.app" \
  API_URL="https://ai-interviewer-api.fly.dev"
```

On PowerShell the `\` line continuations do not work — put it on one line, or
use `fly secrets import` as in the next step.

`DEEPGRAM_API_KEY` is **required**: a bot inside a meeting has no browser to
fall back to, so without it the interviewer cannot hear anyone.

---

## 4. Give the bot its Google session

**Only Google Meet needs this.** Zoom and Teams join as named guests — skip this
step if you are only using those.

The bot signs in once, inside the container, onto a volume that survives
restarts. It takes about five minutes and you never do it again.

### Why not just copy cookies across

An earlier version of this guide exported cookies from a laptop into a
`GOOGLE_BOT_COOKIES` secret, to avoid paying for a volume. Do not do that. It
works for a day or two and then fails in the worst possible way: Google revokes
a rotating session that reappears somewhere new, the bot quietly becomes an
anonymous guest, and Meet turns it away mid-interview with *"you can't join this
video call"* — which reads like the host refused it.

A profile is not a snapshot. The browser rotates its own cookies in place and
keeps the session alive, which is the whole difference.

### Create the volume

```bash
fly volumes create botprofile -a <your-app> -r <your-region> -n 1 -s 1
```

One gigabyte is far more than a profile needs, and it is the smallest Fly sells
— about $0.15 a month. `fly.toml` already mounts it at `/data` and points
`GOOGLE_BOT_PROFILE_PATH` there.

A volume pins the app to one machine in one region. That was already required
here: a second machine runs a second scheduler and every candidate is emailed
twice. Keep `fly scale count 1`.

### Sign in over VNC

The profile has to be *made on Linux*: Windows encrypts its cookie store with
DPAPI, bound to that machine's user account, so a profile built on a laptop
arrives here unreadable. The image ships `x11vnc` for exactly this.

You will need any VNC viewer — RealVNC Viewer and TightVNC are both fine.

In one terminal, forward the port:

```bash
fly proxy 5900:5900 -a <your-app>
```

In a second, start the sign-in inside the machine:

```bash
fly ssh console -a <your-app>
cd /app && npm run bot:login:vnc
```

Point the VNC viewer at `localhost:5900`. A browser is waiting there. Sign in as
the bot's Google account, then return to the second terminal and press Enter to
save the profile to `/data`.

Nothing about the sign-in is automated, and nothing should be: you type the
password into a real Google form. If Google asks for 2FA or a security check,
complete it yourself in that window — the bot will never attempt one.

### Check it took

```bash
fly ssh console -a <your-app> -C "ls /data/meet-bot-profile"
```

A `Default` directory means the profile is there. It will still be there after a
restart, which is the point.

---

## 5. Deploy

```bash
fly deploy
```

Fly builds the Dockerfile (Playwright's image plus Chromium — the first build
takes a few minutes) and starts one machine.

```bash
fly logs
```

You are looking for:

```
API      http://localhost:5000
Meet bot ws://localhost:5000/meet-bot (voice: deepgram)
[scheduler] running every 60s
[meet-bot] no interviews scheduled
```

Then check from outside:

```bash
curl https://ai-interviewer-api.fly.dev/health
```

```json
{
  "status": "ok",
  "database": "ok",
  "speechToText": "ok",
  "meetBot": { "enabled": true, "unsupportedHost": null, "capacity": 1 }
}
```

`unsupportedHost` must be `null`, and `speechToText` must be `ok`.

---

## 6. Point Vercel at it

Vercel → project → **Settings** → **Environment Variables**:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://ai-interviewer-api.fly.dev` |

Then **redeploy**. Vercel bakes `NEXT_PUBLIC_*` in at build time, so changing it
without redeploying changes nothing.

The redeploy matters on its own too: the coding editor lives at
`/interview/[token]/code`, and a deployment predating it hands candidates a 404
mid-interview. Confirm it shipped:

```bash
curl -o /dev/null -w "%{http_code}\n" https://your-app.vercel.app/interview/probe/code
```

`200` means deployed. `404` means the build is stale.

Finally make sure `APP_URL` on Fly is that same Vercel URL — it is where
candidates are sent.

---

## 7. Try one interview

1. Sign in to the Vercel app as a recruiter.
2. Create a Google Meet, Zoom or Teams meeting yourself.
3. **AI interviews** → **Create AI interview**, paste the link, schedule a few
   minutes out.
4. Watch `fly logs`. At the scheduled second:

```
[meet-bot] 1 interview(s) queued:
           Priyanshu Raj (GOOGLE_MEET) — joining 9 Aug 2026, 12:30 pm
[meet-bot <id>] audio bridge ready — mic injected, 1 remote track(s)
```

5. Join the meeting yourself and talk to it.

---

## Useful commands

```bash
fly logs                  # live logs
fly ssh console           # shell on the machine
fly status                # is the machine running
fly secrets list          # names only, never values
fly scale memory 4096     # more room for concurrent meetings
fly apps restart ai-interviewer-api
```

To run more than one interview at a time, raise memory **and**
`MEET_BOT_MAX_CONCURRENT` in `fly.toml` together — roughly 1 GB per concurrent
meeting on top of ~500 MB for the app.

---

## If something is wrong

| Symptom | Cause |
|---|---|
| Machine keeps stopping | `auto_stop_machines` is not `'off'`. A stopped machine has no scheduler, so nothing auto-joins. |
| Out of memory / browser crashes | The machine is below 2 GB, or `MEET_BOT_MAX_CONCURRENT` is above what the memory supports. |
| `SIGN_IN_REQUIRED` | The bot account is signed out, so Meet treated it as an uninvited stranger rather than a guest a host could admit. Re-run step 4. Check the logs for "asking for a guest name" — that line appears about a minute before the failure and says the same thing. |
| Signed out on every reload; 401 on `/api/auth/refresh` | `NODE_ENV` is not `production`, so the refresh cookie is not `SameSite=None; Secure` and the browser drops it between domains. It is set in `fly.toml`; check a secret has not overridden it. |
| Coding editor 404s | `APP_URL` points somewhere stale, or the Vercel build predates the page. Redeploy Vercel. |
| Times are wrong in emails and on the dashboard | `TZ` is not set, so the container formats everything in UTC. It is set to `Asia/Kolkata` in `fly.toml` — change it to wherever your candidates are. |
| Everything worked, then died around day four | Neon's free compute-hour allowance ran out. See §2a. |
| Joins but hears nothing | See [MEETING_BOT.md §9](MEETING_BOT.md) — the bot logs which audio tap found what. |
| `unsupportedHost` is not `null` | You are not on Fly. The bot cannot run on serverless platforms. |

Everything else: [MEETING_BOT.md](MEETING_BOT.md) for the bot,
[ENVIRONMENT.md](ENVIRONMENT.md) for every variable. Render instructions are in
[DEPLOYMENT.md](DEPLOYMENT.md).
