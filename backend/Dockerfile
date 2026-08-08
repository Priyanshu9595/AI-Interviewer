# The meeting bot drives a real browser, so the image is built on Playwright's
# own — it already carries Chromium and the several dozen system libraries a
# browser needs, which is the part that is tedious to get right by hand.
#
# The tag must match the playwright version in package.json. A mismatch fails at
# runtime with "Executable doesn't exist", because Playwright looks for browsers
# in a version-stamped directory.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

# x11vnc is here for one job: the one-time Google sign-in.
#
# A Chromium profile signed in on Windows cannot be copied to a Linux server —
# Windows encrypts its cookie store with DPAPI, which is bound to that machine's
# user account, so the session arrives unreadable and the bot is signed out. The
# profile therefore has to be created on Linux, which means being able to see a
# browser inside this image once. See `npm run bot:login:vnc`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends x11vnc \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first, so a code change does not reinstall them. NODE_ENV is
# deliberately not set yet: the build needs typescript and the Prisma CLI, both
# of which are dev dependencies that a production install would skip.
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# `prisma generate && tsc`. The generated Prisma client is written into
# node_modules, which is why the dev dependencies are left in place afterwards:
# `npm prune` would rearrange node_modules and can take the generated client
# with it. The base image is already large; the few megabytes saved are not
# worth an image that fails at startup.
RUN npm run build

ENV NODE_ENV=production

# Where the signed-in Chromium profile lives. Mount a persistent disk here, or
# the bot is signed out again on every deploy.
ENV GOOGLE_BOT_PROFILE_PATH=/var/data/meet-bot-profile
RUN mkdir -p /var/data /app/uploads

EXPOSE 5000

# Run under a virtual display rather than headless.
#
# Meeting clients are measurably more cooperative in a headed browser — Google
# Meet in particular degrades its UI for what it thinks is an automated client,
# and the controls the bot has to click are part of what it takes away. Xvfb
# gives a headed browser on a machine with no monitor, which is the best of both.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x800x24", "node", "dist/server.js"]
