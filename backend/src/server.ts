import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { env } from './lib/env';
import { errorHandler, notFoundHandler } from './lib/http';
import { emailSenderStatus, verifyEmailSender } from './lib/email/EmailService';
import { getCloudinaryStatus, verifyCloudinary } from './lib/storage';
import { getSpeechStatus, verifySpeech } from './services/SpeechService';
import { checkDatabase, prisma } from './lib/prisma';
import { configureInterviewGateway, activeInterviewCount } from './realtime/interviewGateway';
import { configureMeetBotGateway } from './realtime/meetBotGateway';
import { configureCodingGateway } from './realtime/codingGateway';
import { apiRoutes } from './routes';
import { SchedulerService } from './services/SchedulerService';
import { MeetBotManager } from './services/meetingBot/MeetBotManager';
import { serverlessHost } from './services/meetingBot/browser';

const app = express();
const httpServer = http.createServer(app);

// Any origin may serve the candidate room, so reflect the request origin
// rather than pinning a single host, while still allowing credentials.
const corsOptions: cors.CorsOptions = { origin: true, credentials: true };

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get('/health', async (_req, res) => {
  const alive = await checkDatabase();
  const database = alive ? 'ok' : 'unreachable';

  res.status(alive ? 200 : 503).json({
    status: alive ? 'ok' : 'degraded',
    database,
    emailSender: emailSenderStatus(),
    recordingStorage: getCloudinaryStatus(),
    speechToText: getSpeechStatus(),
    activeInterviews: activeInterviewCount(),
    meetBot: {
      enabled: env.MEET_BOT_ENABLED,
      voice: env.MEET_BOT_TTS,
      running: MeetBotManager.activeCount(),
      capacity: env.MEET_BOT_MAX_CONCURRENT,
      // Non-null means this host cannot run the bot at all, whatever else is
      // configured. Worth reporting from /health so it is visible remotely.
      unsupportedHost: serverlessHost(),
    },
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.use('/api', apiRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const io = new Server(httpServer, {
  cors: corsOptions,
  // Long interviews sit idle while the candidate thinks; be patient.
  pingTimeout: 60_000,
  pingInterval: 25_000,
});

configureInterviewGateway(io);
configureMeetBotGateway(io);
configureCodingGateway(io);

httpServer.listen(env.PORT, () => {
  console.log(`API      http://localhost:${env.PORT}`);
  console.log(`Realtime ws://localhost:${env.PORT}/interview`);
  console.log(`Meet bot ws://localhost:${env.PORT}/meet-bot (${env.MEET_BOT_ENABLED ? `voice: ${env.MEET_BOT_TTS}` : 'disabled'})`);
  console.log(`Mode     ${env.NODE_ENV}`);
  void verifyEmailSender();
  void verifyCloudinary();
  void verifySpeech();
  warnAboutHost();
  warnAboutAppUrl();
  // Interviews whose process died still hold a lock and an in-progress status.
  // Clearing them before the scheduler starts lets them be retried instead of
  // sitting "running" forever with no browser behind them.
  void MeetBotManager.recoverOrphans()
    .finally(() => SchedulerService.start())
    // Printed after the scheduler is armed, so the queue shown is the queue it
    // will actually act on.
    .then(() => MeetBotManager.logUpcoming())
    .catch(() => {});
});

/**
 * APP_URL is the address candidates are sent to, and it is the one setting
 * whose mistakes are invisible from here.
 *
 * A backend running locally against a deployed frontend hands out links to a
 * build that may not have the page yet — the coding editor being the case that
 * bites, because the recruiter only finds out when a candidate cannot open it
 * mid-interview. Saying so at boot costs one line and saves that.
 */
/**
 * The meeting bot needs a long-running process with a disk. Serverless hosts
 * provide neither, and the failure otherwise surfaces hours later as a
 * confusing "the bot has never been signed in".
 */
function warnAboutHost(): void {
  const serverless = serverlessHost();
  if (!serverless || !env.MEET_BOT_ENABLED) return;

  console.warn(
    `[config] MEET_BOT_ENABLED=true but this process is running on ${serverless}.\n` +
      '         The meeting bot cannot work there: it holds a browser open for the whole\n' +
      '         interview, needs a signed-in Chromium profile that survives between runs,\n' +
      '         and needs an always-awake scheduler.\n' +
      '         Deploy the backend to Railway, Render, Fly.io or a VPS. The frontend is fine\n' +
      '         where it is. Set MEET_BOT_ENABLED=false here to silence this.',
  );
}

function warnAboutAppUrl(): void {
  const local = /localhost|127\.0\.0\.1/.test(env.API_URL);
  const remoteApp = !/localhost|127\.0\.0\.1/.test(env.APP_URL);

  if (local && remoteApp) {
    console.warn(
      `[config] APP_URL is ${env.APP_URL} but this server is running locally.\n` +
        '         Candidate links — including the coding editor at /interview/<token>/code —\n' +
        '         will point at that deployment, which must be running the same frontend build.\n' +
        '         For local testing set APP_URL=http://localhost:3000 in backend/.env.',
    );
  }
}

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down.`);
  SchedulerService.stop();
  // Leave the meetings properly and close the browsers, or Chromium processes
  // outlive the server and hold onto their profile directories.
  await MeetBotManager.shutdown().catch(() => {});
  io.close();
  httpServer.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
