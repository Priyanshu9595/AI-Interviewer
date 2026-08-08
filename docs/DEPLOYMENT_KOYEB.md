# Koyeb Deployment Guide

This guide explains how to deploy the AI Interviewer backend to Koyeb. Koyeb's "Eco" instance (Free tier) **never sleeps**, meaning your bot's scheduler will run 24/7 without needing any cron jobs.

## Prerequisites
1. **GitHub Repository**: Your code must be pushed to a GitHub repository.
2. **PostgreSQL Database**: Koyeb provides a managed Postgres database (free tier available), or you can use [Neon.tech](https://neon.tech/) or [Supabase](https://supabase.com/) for a free cloud database.
3. **Google Bot Cookies**: You need the long cookie string generated from running `npm run bot:export-cookies` on your local machine.

---

## Step 1: Create a Koyeb Service

1. Log in to [Koyeb Dashboard](https://app.koyeb.com/).
2. Click **Create Web Service**.
3. **Deployment Method**: Select **GitHub**.
4. **Repository**: Select your `AI-Interviewer` repository and the `main` branch.

## Step 2: Configure the Build

1. Under **Builder**, select **Dockerfile**.
2. **Docker context**: Since our backend is in a folder, enter `/backend`.
3. **Dockerfile location**: Enter `/backend/Dockerfile`.

## Step 3: Configure Environment Variables

Under **Environment Variables**, you need to add all your secrets. The most critical ones are:

- `NODE_ENV`: `production`
- `PORT`: `5000`
- `DATABASE_URL`: *(Your Postgres connection string)*
- `APP_URL`: *(The URL of your Vercel frontend, e.g., https://ai-interviewer.vercel.app)*
- `API_URL`: *(We will update this later once Koyeb generates your URL)*
- `JWT_SECRET`: *(Any random long string)*
- `JWT_REFRESH_SECRET`: *(Any random long string)*
- `GROQ_API_KEY`: *(Your Groq Key)*
- `DEEPGRAM_API_KEY`: *(Your Deepgram Key)*
- `MEET_BOT_ENABLED`: `true`
- `GOOGLE_BOT_PROFILE_PATH`: `/tmp/meet-bot-profile`
- `MEET_BOT_BROWSER_CHANNEL`: `chromium`
- `MEET_BOT_HEADLESS`: `false`
- `GOOGLE_BOT_COOKIES`: *(Paste the huge base64 string you got from `npm run bot:export-cookies`)*

## Step 4: Configure Networking & Instance

1. Under **Exposed ports**, ensure the port is set to **5000** and the path is `/`.
2. Under **Instance type**, select **Eco** (the free option).
3. **Name your service**: (e.g., `ai-interview-api`).
4. Click **Deploy**.

*Note: The first deployment will take a few minutes as it downloads and builds the Playwright browser image.*

## Step 5: Initialize the Database

Once the service is successfully deployed and running on Koyeb:
1. Go to your Koyeb Service dashboard.
2. Click on the **Console** tab.
3. Run the following command to create the database tables:
   ```bash
   npm run db:push
   ```

## Step 6: Connect the Frontend

1. Copy the public URL Koyeb gave you (e.g., `https://ai-interview-api.koyeb.app`).
2. Go to your Koyeb Environment Variables and update `API_URL` to this URL. (Redeploy if Koyeb asks).
3. Go to your **Vercel Dashboard** (where your frontend is).
4. Update the `NEXT_PUBLIC_API_URL` environment variable to match the Koyeb URL.
5. **Redeploy your Vercel frontend** so it picks up the new URL.

You are fully deployed! Your server will not sleep, and the bot will auto-join meetings automatically.
