# Google Cloud Run Deployment Guide

Google Cloud Run is an excellent, highly scalable platform that runs Docker containers. 

However, for the AI Interviewer bot, there is a **critical configuration** you must enable: **CPU Always Allocated**. 

### The Catch: CPU Throttling
By default, Cloud Run is a serverless platform. This means it only provides CPU power when it is actively processing an incoming HTTP request. Once the request finishes, the CPU is throttled to zero. 
Because our AI bot joins a Google Meet/Zoom in the background and stays there for 30-60 minutes, Cloud Run will freeze the bot mid-interview if there is no active HTTP request keeping it awake.

To fix this, you must set the CPU to be **Always Allocated**. 
*Warning: Running a container 24/7 with "CPU Always Allocated" will exhaust the Cloud Run Free Tier (50 hours/month) in just 2 days. It will cost approximately $20-$40/month depending on your region.*

---

## Prerequisites
1. **Google Cloud Account**: Set up a GCP project with billing enabled.
2. **gcloud CLI**: Install the Google Cloud CLI on your machine.
3. **Docker**: Have Docker installed locally (or you can use Cloud Build).

## Step 1: Build and Submit the Docker Image

Open your terminal in the root of the project and run:

```bash
# Set your GCP Project ID
gcloud config set project YOUR_PROJECT_ID

# Build and push the image to Google Container Registry or Artifact Registry
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/ai-interviewer ./backend
```

## Step 2: Deploy to Cloud Run

Run the following command to deploy the image. Notice the `--no-cpu-throttling` flag—this is the setting that keeps the bot alive during meetings.

```bash
gcloud run deploy ai-interview-api \
  --image gcr.io/YOUR_PROJECT_ID/ai-interviewer \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 1 \
  --no-cpu-throttling \
  --set-env-vars="NODE_ENV=production,PORT=8080,MEET_BOT_ENABLED=true,SCHEDULER_ENABLED=true,MEET_BOT_BROWSER_CHANNEL=chromium,MEET_BOT_HEADLESS=false"
```

## Step 3: Configure Secrets

The above command only sets basic environment variables. You need to provide your secrets securely:
1. Go to the [Google Cloud Run Dashboard](https://console.cloud.google.com/run).
2. Click on your `ai-interview-api` service.
3. Click **Edit & Deploy New Revision**.
4. Go to the **Variables & Secrets** tab.
5. Add the remaining required variables (these are identical to the Render/Koyeb variables):
   - `DATABASE_URL`
   - `GROQ_API_KEY`
   - `DEEPGRAM_API_KEY`
   - `GOOGLE_BOT_COOKIES`
   - `APP_URL`
   - `JWT_SECRET`
   - `JWT_REFRESH_SECRET`
6. Click **Deploy**.

## Step 4: Update the Frontend

Once deployed, Cloud Run will give you a public URL (e.g., `https://ai-interview-api-xyz.run.app`).
Copy this URL, go to your Vercel frontend environment variables, update `NEXT_PUBLIC_API_URL` to match this Cloud Run URL, and redeploy your Vercel frontend.
