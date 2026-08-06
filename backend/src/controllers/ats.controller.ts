import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../lib/auth';
import { badRequest, notFound, param } from '../lib/http';
import { prisma } from '../lib/prisma';
import { AtsService } from '../services/AtsService';
import { env } from '../lib/env';

export const listIntegrations = async (req: AuthRequest, res: Response) => {
  res.json(await AtsService.listIntegrations(req.user!.userId));
};

const createSchema = z.object({
  provider: z.enum(['GREENHOUSE', 'LEVER', 'WORKABLE', 'WEBHOOK']),
  name: z.string().min(1),
  webhookUrl: z.string().url('Enter a valid https URL'),
  apiKey: z.string().optional(),
});

export const createIntegration = async (req: AuthRequest, res: Response) => {
  const data = createSchema.parse(req.body);
  res.status(201).json(
    await AtsService.createIntegration({
      userId: req.user!.userId,
      provider: data.provider,
      name: data.name,
      webhookUrl: data.webhookUrl,
      apiKey: data.apiKey,
    }),
  );
};

export const deleteIntegration = async (req: AuthRequest, res: Response) => {
  await AtsService.deleteIntegration(req.user!.userId, param(req, 'id'));
  res.json({ ok: true });
};

export const getSyncLogs = async (req: AuthRequest, res: Response) => {
  res.json(await AtsService.logs(req.user!.userId, param(req, 'id')));
};

/** Fires the integration against the most recent report so the user can verify it. */
export const testIntegration = async (req: AuthRequest, res: Response) => {
  const integration = await prisma.atsIntegration.findFirst({
    where: { id: param(req, 'id'), userId: req.user!.userId },
  });
  if (!integration) throw notFound('Integration not found');

  const report = await prisma.report.findFirst({
    where: { sessionCandidate: { interviewSession: { userId: req.user!.userId } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!report) throw badRequest('Generate at least one report before testing an integration');

  res.json(await AtsService.sync(integration.id, report.id, env.APP_URL));
};
