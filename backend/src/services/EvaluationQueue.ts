import { RateLimitError, llmCooldown } from '../lib/ai';
import { prisma } from '../lib/prisma';
import { EvaluationService, PermanentEvaluationError } from './EvaluationService';

const MAX_ATTEMPTS = 5;

/** Exponential backoff between attempts, capped so it stays same-day. */
function backoffSeconds(attempt: number): number {
  return Math.min(30 * 60, 60 * 2 ** (attempt - 1));
}

/**
 * Makes report generation self-healing.
 *
 * A candidate can finish a full interview and still end up with no report if the
 * LLM is rate limited or the database blips at the wrong moment. Losing the
 * whole assessment to a transient failure is unacceptable, so every completed
 * interview without a report is treated as outstanding work and retried.
 */
export class EvaluationQueue {
  /**
   * Runs an evaluation and records the outcome. Never throws — callers are
   * fire-and-forget paths such as the socket gateway.
   */
  static async run(sessionCandidateId: string): Promise<boolean> {
    try {
      await EvaluationService.evaluate(sessionCandidateId);
      await prisma.sessionCandidate
        .update({
          where: { id: sessionCandidateId },
          data: { evaluationError: null, evaluationRetryAt: null },
        })
        .catch(() => {});
      return true;
    } catch (err) {
      const error = err as Error;

      // Nothing to score means nothing will ever be scored. Stop now rather
      // than retrying the same empty transcript five times.
      if (err instanceof PermanentEvaluationError) {
        await prisma.sessionCandidate
          .update({
            where: { id: sessionCandidateId },
            data: {
              evaluationAttempts: MAX_ATTEMPTS,
              evaluationError: error.message.slice(0, 500),
              evaluationRetryAt: null,
            },
          })
          .catch(() => {});

        console.warn(`[evaluation] ${sessionCandidateId} cannot be evaluated: ${error.message}`);
        return false;
      }

      // A rate limit tells us when it will lift; anything else backs off.
      const attempts = await this.bumpAttempts(sessionCandidateId);
      const waitSeconds =
        err instanceof RateLimitError && err.retryAfterSeconds
          ? err.retryAfterSeconds + 30
          : backoffSeconds(attempts);

      await prisma.sessionCandidate
        .update({
          where: { id: sessionCandidateId },
          data: {
            evaluationError: error.message.slice(0, 500),
            evaluationRetryAt: attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + waitSeconds * 1000),
          },
        })
        .catch(() => {});

      console.error(
        `[evaluation] attempt ${attempts}/${MAX_ATTEMPTS} failed for ${sessionCandidateId}: ${error.message.slice(0, 200)}` +
          (attempts >= MAX_ATTEMPTS ? ' — giving up, a recruiter can retry manually' : ` — retrying in ${waitSeconds}s`),
      );

      return false;
    }
  }

  private static async bumpAttempts(sessionCandidateId: string): Promise<number> {
    try {
      const row = await prisma.sessionCandidate.update({
        where: { id: sessionCandidateId },
        data: { evaluationAttempts: { increment: 1 } },
        select: { evaluationAttempts: true },
      });
      return row.evaluationAttempts;
    } catch {
      return MAX_ATTEMPTS; // cannot track it, so do not loop forever
    }
  }

  /**
   * Picks up completed interviews that still have no report. Called on every
   * scheduler tick.
   */
  static async processPending(): Promise<number> {
    // No point querying, let alone calling the model, while the provider is
    // known to be blocked — that is what produced the retry flood.
    const cooling = llmCooldown.remainingSeconds();
    if (cooling > 0) return 0;

    const now = new Date();

    const pending = await prisma.sessionCandidate.findMany({
      where: {
        // INCOMPLETE interviews are deliberately never scored.
        status: 'COMPLETED',
        report: null,
        // There must be something to evaluate.
        transcript: { isNot: null },
        evaluationAttempts: { lt: MAX_ATTEMPTS },
        OR: [{ evaluationRetryAt: null }, { evaluationRetryAt: { lte: now } }],
      },
      select: { id: true, completedAt: true },
      orderBy: { completedAt: 'asc' },
      // One at a time: evaluation is token-heavy, and a burst is what caused
      // the rate limit in the first place.
      take: 1,
    });

    const first = pending[0];
    if (!first) return 0;

    // Give the gateway's own attempt a moment to land before duplicating it.
    if (first.completedAt && Date.now() - first.completedAt.getTime() < 45_000) return 0;

    console.log(`[evaluation] retrying report for ${first.id}`);
    const ok = await this.run(first.id);
    return ok ? 1 : 0;
  }

  /** Clears the failure state so a recruiter can force another attempt. */
  static async reset(sessionCandidateId: string) {
    await prisma.sessionCandidate.update({
      where: { id: sessionCandidateId },
      data: { evaluationAttempts: 0, evaluationError: null, evaluationRetryAt: null },
    });
  }
}
