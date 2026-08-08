#!/usr/bin/env bash
#
# The one-time Google sign-in, inside the container, viewable over VNC.
#
# This exists because a Chromium profile is not portable across operating
# systems: Windows encrypts its cookie store with DPAPI, bound to that machine's
# user account, so a profile signed in on a laptop arrives on a Linux server
# unreadable and the bot is simply signed out. The profile has to be made on
# Linux — which means being able to see a browser in here, once.
#
#   docker build -t ai-interview-api ./backend
#   docker run --rm -it -p 5900:5900 -v "$PWD/bot-profile:/var/data" \
#     ai-interview-api npm run bot:login:vnc
#
# Then point any VNC viewer at localhost:5900, sign in, and press Enter here.
# The result is a Linux profile in ./bot-profile that a Linux server can use.

set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
VNC_PORT="${VNC_PORT:-5900}"
export DISPLAY=":${DISPLAY_NUM}"

cleanup() {
  # Killing the display before Chromium has flushed the profile to disk would
  # leave a half-written session that fails in a way nobody can diagnose.
  sleep 1
  kill "${XVFB_PID:-}" "${VNC_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

Xvfb "${DISPLAY}" -screen 0 1280x900x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2

# No password: the port is only reachable from wherever you published it to,
# which for this is your own machine for a few minutes.
x11vnc -display "${DISPLAY}" -nopw -forever -shared -rfbport "${VNC_PORT}" -quiet >/dev/null 2>&1 &
VNC_PID=$!
sleep 1

echo ""
echo "  A browser is running on display ${DISPLAY}, shared over VNC."
echo "  Connect a VNC viewer to localhost:${VNC_PORT} to see it."
echo ""

exec npx tsx scripts/botlogin.ts "$@"
