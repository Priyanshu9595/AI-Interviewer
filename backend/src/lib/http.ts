import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

/** An error carrying an intended HTTP status code. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = 'Unauthorized') => new HttpError(401, message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

/**
 * Reads a route parameter as a string.
 *
 * Express 5 types params as `string | string[]` because a pattern can repeat.
 * None of ours do, so collapse to the single value and fail loudly otherwise.
 */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  throw badRequest(`Missing route parameter: ${name}`);
}

/**
 * Wraps an async route handler so rejected promises reach the error middleware
 * instead of hanging the request.
 */
export const asyncHandler =
  <T extends Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };

export const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // A provider quota block is not a server fault. Tell the caller how long to
  // wait instead of returning an opaque 500.
  if ((err as { isRateLimit?: boolean })?.isRateLimit) {
    const retryAfter = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter));

    const minutes = retryAfter ? Math.ceil(retryAfter / 60) : null;
    return res.status(429).json({
      error: minutes
        ? `The AI provider's quota is exhausted. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
        : "The AI provider's quota is exhausted. Please try again later.",
      retryAfterSeconds: retryAfter ?? null,
      code: 'LLM_RATE_LIMITED',
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }

  // Prisma unique-constraint violations are a client error, not a server fault.
  const code = (err as { code?: string })?.code;
  if (code === 'P2002') {
    return res.status(409).json({ error: 'A record with that value already exists' });
  }
  if (code === 'P2025') {
    return res.status(404).json({ error: 'Record not found' });
  }

  console.error('[unhandled]', err);
  return res.status(500).json({ error: 'Internal server error' });
};

export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
};