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
import { apiRoutes } from './routes';
import { SchedulerService } from './services/SchedulerService';

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

httpServer.listen(env.PORT, () => {
  console.log(`API      http://localhost:${env.PORT}`);
  console.log(`Realtime ws://localhost:${env.PORT}/interview`);
  console.log(`Mode     ${env.NODE_ENV}`);
  void verifyEmailSender();
  void verifyCloudinary();
  void verifySpeech();
  SchedulerService.start();
});

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down.`);
  SchedulerService.stop();
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
