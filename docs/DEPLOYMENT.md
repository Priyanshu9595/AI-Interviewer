# Deploying: Vercel frontend + Render backend

Six steps, in order. Step 5 is the only fiddly one and the reason it is fiddly
is explained there.

```
   Vercel                          Render
   ┌────────────────────┐          ┌──────────────────────────────┐
   │ frontend-v2        │  HTTPS   │ backend                      │
   │ Next.js pages      │ ───────► │ API + Socket.IO              │
   │                    │  WSS     │ scheduler (always awake)     │
   │ NEXT_PUBLIC_API_URL│          │ Chromium under Xvfb          │
   └────────────────────┘          │ /var/data ← signed-in profile│
                                   └──────────────────────────────┘
```

**The backend cannot go on Vercel.** It holds a browser open for the length of
an interview, needs a Chromium profile that survives between deploys, and needs
a scheduler that is always awake. Serverless gives none of those. The frontend
is fine there — it is just pages.

---

## 1. Push the code

Render builds from a Git repository, so everything has to be on GitHub first.

```bash
git add -A
git commit -m "Add deployment configuration for Render"
git push origin main
```

---

## 2. Backend on Render

Render dashboard → **New** → **Blueprint** → pick this repository. It reads
[`render.yaml`](../render.yaml) and creates the service.

**Plan: `standard`, not free and not `starter`.** Two reasons, both fatal
otherwise:

- Free instances sleep after 15 minutes idle. A sleeping process has no
  scheduler, so no interview ever joins by itself.
- `starter` has 512 MB. Node plus one Chromium does not fit. Each concurrent
  meeting is roughly 400 MB.

**Keep the disk.** The blueprint mounts 2 GB at `/var/data`, which is where the
signed-in Chromium profile lives. Without it the profile is wiped on every
deploy and every interview fails with `SIGN_IN_REQUIRED`.

**One instance only.** The interview state machine is held in memory and the
scheduler must run in exactly one place.

Then set the secrets Render marked as required:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Your Neon connection string, with `?sslmode=require` |
| `GROQ_API_KEY` | From <https://console.groq.com> |
| `DEEPGRAM_API_KEY` | From <https://console.deepgram.com> — **required**, the bot cannot hear without it |
| `APP_URL` | Your Vercel URL (step 3) |
| `API_URL` | The Render URL Render just gave you |

`JWT_SECRET` and `JWT_REFRESH_SECRET` are generated for you. `NODE_ENV` is
already set to `production` in the blueprint — leave it, it is what makes the
refresh cookie work across two domains.

Wait for the first deploy, then check:

```bash
curl https://<your-service>.onrender.com/health
```

```json
{
  "status": "ok",
  "database": "ok",
  "speechToText": "ok",
  "meetBot": { "enabled": true, "unsupportedHost": null, "capacity": 2 }
}
```

`unsupportedHost` must be `null`. Anything else means the bot cannot run there.

---

## 3. Frontend on Vercel

You already have a Vercel project. It needs one environment variable and a
fresh deploy of the **current** build.

Vercel → project → **Settings** → **Environment Variables**:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<your-service>.onrender.com` |

Set it for Production, then **redeploy**. Vercel bakes `NEXT_PUBLIC_*` in at
build time, so changing it without redeploying changes nothing.

The redeploy also matters on its own: the coding editor lives at
`/interview/[token]/code`, and a deployment that predates it hands candidates a
404 in the middle of their interview.

Confirm it shipped:

```bash
curl -o /dev/null -w "%{http_code}\n" \
  https://<your-app>.vercel.app/interview/probe/code
```

`200` means the page is deployed. `404` means the build is stale.

---

## 4. Point the two at each other

Back on Render, set `APP_URL` to the Vercel URL and let it redeploy.

`APP_URL` is where candidates are sent — invitation links and the coding editor
are built from it. Getting it wrong is invisible until a candidate cannot open
something mid-interview, so the dashboard checks it: an interview page will say
plainly if the coding editor is unreachable.

---

## 5. Sign the bot in

This is the awkward step, and it is worth knowing why rather than fighting it.

**A Chromium profile is not portable across operating systems.** Windows
encrypts its cookie store with DPAPI, tied to that machine's user account. Copy
that profile to a Linux server and the cookies cannot be decrypted — the bot
arrives signed out, with no useful error. So the profile has to be *created* on
Linux, which means seeing a browser inside a Linux container, once.

Locally, with Docker running:

```bash
docker build -t ai-interview-api ./backend

docker run --rm -it -p 5900:5900 \
  -v "$PWD/bot-profile:/var/data" \
  ai-interview-api npm run bot:login:vnc
```

Connect any VNC viewer to **localhost:5900** — on Windows, [TightVNC
Viewer](https://www.tightvnc.com/download.php) or RealVNC will do. You will see
a browser. Sign in as the bot's Google account, clear any verification, then
press Enter in the terminal. The helper checks the session actually took.

You now have a Linux-format profile in `./bot-profile/meet-bot-profile`. Copy it
to the Render disk over SSH (enable SSH on the service first, in Render →
Settings):

```bash
rsync -avz ./bot-profile/meet-bot-profile/ \
  srv-xxxxxxxx@ssh.oregon.render.com:/var/data/meet-bot-profile/
```

Restart the service. Google may challenge the session the first time it is used
from a new IP address; if it does, repeat the sign-in — the challenge is
answered once and then remembered.

**Only Google Meet needs this.** Zoom and Teams join as named guests, so if you
are only using those, skip this step entirely.

> Treat `bot-profile/` as a credential. It grants access to that Google account.
> Do not commit it — it is already gitignored.

---

## 6. Check it end to end

1. Sign in to the Vercel app as a recruiter.
2. Create a meeting in Google Meet, Zoom or Teams yourself.
3. **AI interviews** → **Create AI interview**, paste the link, schedule it a
   few minutes out.
4. The interview page should show the coding editor link as reachable, and the
   status move `Scheduled → Starting → Joining → Joined`.
5. Join the meeting yourself as the candidate and talk to it.

The Render logs print the queue at boot, which is the quickest way to see the
bot is armed:

```
[meet-bot] 1 interview(s) queued:
           Priyanshu Raj (GOOGLE_MEET) — joining 9 Aug 2026, 12:30 pm
```

---

## If something is wrong

| Symptom | Cause |
|---|---|
| `unsupportedHost` is not `null` in `/health` | The backend is on a serverless host. It has to be Render, Railway, Fly.io or a VPS. |
| Signed out on every reload; 401 on `/api/auth/refresh` | `NODE_ENV` is not `production` on Render, so the refresh cookie is not `SameSite=None; Secure` and the browser drops it between domains. |
| Coding editor 404s | Either `APP_URL` points somewhere stale, or the Vercel build predates the page. Redeploy Vercel. |
| `SIGN_IN_REQUIRED` after a deploy | No disk mounted, or the profile was made on Windows. See step 5. |
| Nothing joins automatically | The service is asleep (free plan) or was down at the scheduled moment. Check the boot log's queue. |
| Interview joins but hears nothing | See [MEETING_BOT.md §9](MEETING_BOT.md) — the bot logs which audio tap found what. |

Everything else: [MEETING_BOT.md](MEETING_BOT.md) for the bot,
[ENVIRONMENT.md](ENVIRONMENT.md) for every variable.
