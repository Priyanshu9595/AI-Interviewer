import { EventEmitter } from 'events';
import { Question, QuestionCategory } from '@prisma/client';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { emailService } from '../lib/email/EmailService';
import { InsightService, analyseAnswer } from './InsightService';
import { LiveInterviewerService } from './LiveInterviewerService';
import { ResumeProfile, ResumeService } from './ResumeService';
import { TranscriptService } from './TranscriptService';

export type InterviewState =
  | 'WAITING_FOR_CANDIDATE'
  | 'GREETING'
  | 'IDENTITY_VERIFICATION'
  | 'IN_ROUND'
  | 'CODING'
  | 'CLOSING'
  | 'COMPLETED'
  | 'ABSENT';

/** Events the machine emits back to the socket layer. */
export interface StateMachineEvents {
  say: { text: string; questionId?: string; round?: string; expectsAnswer: boolean };
  state: { state: InterviewState; round?: string; progress: number };
  insight: { type: string; message: string; severity: number };
  coding: { question: unknown };
  ended: { reason: 'completed' | 'no_show' | 'abandoned' | 'ended_early' };
  thinking: { active: boolean };
}

const ROUND_ORDER: QuestionCategory[] = ['INTRO', 'HR', 'TECHNICAL', 'SCENARIO', 'PROJECT', 'CODING'];

/**
 * Drives a single candidate's interview from joining through to completion.
 *
 * The machine owns the *script* — which question is next, when a round ends,
 * when to stop — while LiveInterviewerService owns the *conversation*: how to
 * acknowledge, whether to probe, how to answer a doubt.
 */
export class InterviewStateMachine extends EventEmitter {
  state: InterviewState = 'WAITING_FOR_CANDIDATE';

  private questions: Question[] = [];
  private index = -1;
  private interviewer: LiveInterviewerService | null = null;
  private noShowTimer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private hardStopTimer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Follow-ups asked on the current question, capped so we always progress. */
  private probesOnCurrent = 0;
  private startedAt: Date | null = null;
  private candidateName = 'Candidate';
  private askedIdentity = false;

  constructor(readonly sessionCandidateId: string) {
    super();
    this.armNoShowTimers();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Two timers run while we wait: a nudge email partway through the grace
   * period, and the hard cutoff that marks the candidate absent.
   */
  private armNoShowTimers() {
    const graceMs = env.NO_SHOW_GRACE_MINUTES * 60_000;

    this.nudgeTimer = setTimeout(() => void this.sendNoShowNudge(), Math.floor(graceMs * 0.5));
    this.noShowTimer = setTimeout(() => void this.markAbsent(), graceMs);
  }

  private clearWaitTimers() {
    if (this.noShowTimer) clearTimeout(this.noShowTimer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.noShowTimer = null;
    this.nudgeTimer = null;
  }

  private async sendNoShowNudge() {
    if (this.state !== 'WAITING_FOR_CANDIDATE') return;

    try {
      const sc = await prisma.sessionCandidate.findUnique({
        where: { id: this.sessionCandidateId },
        include: { candidate: true, interviewSession: true },
      });
      if (!sc) return;

      await emailService.sendNoShowNudge({
        to: sc.candidate.email,
        name: sc.candidate.name,
        role: sc.interviewSession.title,
        joinUrl: `${env.APP_URL}/interview/${sc.accessToken}`,
      });

      await prisma.reminder.upsert({
        where: { sessionCandidateId_kind: { sessionCandidateId: sc.id, kind: 'NO_SHOW_NUDGE' } },
        create: {
          sessionCandidateId: sc.id,
          kind: 'NO_SHOW_NUDGE',
          status: 'SENT',
          scheduledFor: new Date(),
          sentAt: new Date(),
        },
        update: { status: 'SENT', sentAt: new Date() },
      });
    } catch (err) {
      console.error('[interview] no-show nudge failed:', (err as Error).message);
    }
  }

  private async markAbsent() {
    if (this.state !== 'WAITING_FOR_CANDIDATE') return;

    this.state = 'ABSENT';
    await prisma.sessionCandidate
      .update({
        where: { id: this.sessionCandidateId },
        data: { status: 'ABSENT', absentAt: new Date() },
      })
      .catch((e) => console.error('[interview] could not mark absent:', e.message));

    this.emit('state', { state: this.state, progress: 0 });
    this.emit('ended', { reason: 'no_show' });
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private async load() {
    const sc = await prisma.sessionCandidate.findUnique({
      where: { id: this.sessionCandidateId },
      include: {
        candidate: true,
        interviewSession: {
          include: { questionSet: { include: { questions: { orderBy: { order: 'asc' } } } } },
        },
      },
    });

    if (!sc) throw new Error('Interview not found');

    const session = sc.interviewSession;
    this.candidateName = sc.candidate.name;

    const all = session.questionSet?.questions ?? [];

    // Questions written against this candidate's own resume. They are not
    // persisted as Question rows because the question set is shared by every
    // candidate in the session, so they are materialised here instead.
    const resumeQuestions = Array.isArray(sc.resumeQuestions)
      ? (sc.resumeQuestions as unknown as Array<{ text: string; focusArea?: string; expectedPoints?: string[] }>)
      : [];

    const resumeRows: Question[] = resumeQuestions
      .filter((q) => typeof q?.text === 'string' && q.text.trim())
      .map((q, i) => ({
        id: `resume-${i}`,
        questionSetId: session.questionSet?.id ?? 'resume',
        content: q.text.trim(),
        // Placed after the generated project questions.
        order: 10_000 + i,
        category: 'PROJECT',
        difficulty: 'MEDIUM',
        skill: q.focusArea ?? 'resume',
        expectedAnswer: (q.expectedPoints ?? []).join('; ') || null,
        meta: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

    // Order by round rather than raw insertion order so the interview always
    // flows intro -> behavioural -> technical -> scenario -> project -> coding.
    this.questions = [...all, ...resumeRows]
      .filter((q) => (session.codingEnabled ? true : q.category !== 'CODING'))
      .sort((a, b) => {
        const ra = ROUND_ORDER.indexOf(a.category);
        const rb = ROUND_ORDER.indexOf(b.category);
        return ra === rb ? a.order - b.order : ra - rb;
      });

    this.interviewer = new LiveInterviewerService({
      candidateName: sc.candidate.name,
      jobTitle: session.title,
      experienceLevel: session.experienceLevel,
      interviewType: session.type,
      durationMinutes: session.durationMinutes,
      personality: session.personality,
      language: session.language,
      skills: session.skills,
      // Lets follow-ups reference their actual background instead of guessing.
      resumeBlock: ResumeService.promptBlock(
        (sc.resumeProfile as unknown as ResumeProfile | null) ?? null,
        sc.resumeText,
      ),
    });

    // A hard stop at 1.5x the scheduled duration protects against a candidate
    // who never stops talking and against a stuck client.
    this.hardStopTimer = setTimeout(
      () => void this.finish('completed'),
      session.durationMinutes * 90_000,
    );

    return sc;
  }

  // -------------------------------------------------------------------------
  // Public entry points
  // -------------------------------------------------------------------------

  async candidateJoined() {
    if (this.state !== 'WAITING_FOR_CANDIDATE') {
      // Reconnect: replay current position rather than restarting.
      this.emit('state', { state: this.state, progress: this.progress() });
      return;
    }

    this.clearWaitTimers();
    this.startedAt = new Date();

    await prisma.sessionCandidate
      .update({
        where: { id: this.sessionCandidateId },
        data: { status: 'IN_PROGRESS', joinedAt: new Date(), startedAt: new Date() },
      })
      .catch((e) => console.error('[interview] could not mark in-progress:', e.message));

    // A transient database blip must not leave the candidate in silence, so
    // retry once before giving up and letting the caller surface the failure.
    try {
      await this.load();
    } catch (err) {
      console.warn('[interview] load failed, retrying once:', (err as Error).message);
      await new Promise((r) => setTimeout(r, 1200));
      await this.load();
    }

    this.state = 'GREETING';
    this.emit('state', { state: this.state, round: 'GREETING', progress: 0 });

    const greeting = this.interviewer!.greeting();
    await this.say(greeting, { round: 'GREETING', expectsAnswer: true });
  }

  /** Handles one candidate utterance. */
  async candidateAnswered(payload: {
    text: string;
    latencyMs?: number;
    durationMs?: number;
    confidence?: number;
  }) {
    if (this.busy || this.state === 'COMPLETED' || this.state === 'ABSENT') return;
    this.busy = true;
    this.emit('thinking', { active: true });

    try {
      const text = (payload.text ?? '').trim();

      await TranscriptService.logTurn(this.sessionCandidateId, {
        speaker: 'CANDIDATE',
        text,
        questionId: this.current()?.id ?? null,
        round: this.state === 'IN_ROUND' ? this.current()?.category ?? null : this.state,
        latencyMs: payload.latencyMs ?? null,
        durationMs: payload.durationMs ?? null,
        confidence: payload.confidence ?? null,
      });

      switch (this.state) {
        case 'GREETING':
          await this.afterGreeting();
          break;
        case 'IDENTITY_VERIFICATION':
          await this.afterIdentity(text);
          break;
        case 'IN_ROUND':
        case 'CODING':
          await this.afterAnswer(text, payload);
          break;
        case 'CLOSING':
          await this.finish('completed');
          break;
        default:
          break;
      }
    } catch (err) {
      console.error('[interview] turn failed:', err);
      // Never strand the candidate in silence — move the script forward.
      await this.advance();
    } finally {
      this.busy = false;
      this.emit('thinking', { active: false });
    }
  }

  /** The candidate asked the interviewer a question mid-round. */
  async candidateAskedDoubt(question: string) {
    if (this.busy || !this.interviewer) return;
    this.busy = true;
    this.emit('thinking', { active: true });

    try {
      await TranscriptService.logTurn(this.sessionCandidateId, {
        speaker: 'CANDIDATE',
        text: question,
        round: 'DOUBT',
      });

      const reply = await this.interviewer.handleDoubt(question, this.current()?.content ?? 'the current question');
      await this.say(reply, { round: 'DOUBT', expectsAnswer: true, questionId: this.current()?.id });
    } finally {
      this.busy = false;
      this.emit('thinking', { active: false });
    }
  }

  /** The candidate went quiet for a long time without answering. */
  async silenceDetected() {
    if (this.busy || this.state === 'COMPLETED' || this.state === 'ABSENT') return;

    await InsightService.record(this.sessionCandidateId, [
      { type: 'LONG_PAUSE', message: 'Went silent without answering.', severity: 0.6 },
    ]);
    this.emit('insight', { type: 'LONG_PAUSE', message: 'Long silence', severity: 0.6 });

    await this.say('Take your time. Would you like me to rephrase the question?', {
      round: this.current()?.category ?? 'IN_ROUND',
      expectsAnswer: true,
    });
  }

  async candidateLeft() {
    if (this.state === 'COMPLETED' || this.state === 'ABSENT') return;
    await this.finish('abandoned');
  }

  /** Called when a coding submission has been graded so the round can resume. */
  async codingSubmitted(summary: { passed: number; total: number }) {
    if (this.state !== 'CODING') return;

    const remark =
      summary.total > 0
        ? 'Thanks, I have got your submission.'
        : 'Thanks, I have noted that down.';

    await this.say(remark, { round: 'CODING', expectsAnswer: false });
    await this.advance();
  }

  dispose() {
    this.clearWaitTimers();
    if (this.hardStopTimer) clearTimeout(this.hardStopTimer);
    this.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // Internal flow
  // -------------------------------------------------------------------------

  private current(): Question | undefined {
    return this.index >= 0 ? this.questions[this.index] : undefined;
  }

  private progress(): number {
    if (!this.questions.length) return this.state === 'COMPLETED' ? 100 : 0;
    return Math.min(100, Math.round(((this.index + 1) / this.questions.length) * 100));
  }

  private async afterGreeting() {
    this.state = 'IDENTITY_VERIFICATION';
    this.emit('state', { state: this.state, round: 'IDENTITY', progress: 0 });

    this.askedIdentity = true;
    await this.say(
      `Before we start, could you confirm your full name and the role you have applied for?`,
      { round: 'IDENTITY', expectsAnswer: true },
    );
  }

  private async afterIdentity(text: string) {
    // A loose match is enough: ASR mangles names, and this is a sanity check,
    // not authentication. The recruiter sees the raw answer in the transcript.
    const said = text.toLowerCase().replace(/[^a-z\s]/g, '');
    const parts = this.candidateName.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
    const verified = parts.length > 0 && parts.some((p) => said.includes(p));

    await prisma.sessionCandidate
      .update({ where: { id: this.sessionCandidateId }, data: { identityVerified: verified } })
      .catch(() => {});

    if (!verified) {
      await InsightService.record(this.sessionCandidateId, [
        {
          type: 'UNCLEAR_RESPONSE',
          message: 'Stated name did not clearly match the invited candidate.',
          severity: 0.5,
          meta: { expected: this.candidateName, heard: text },
        },
      ]);
    }

    this.state = 'IN_ROUND';
    await this.advance('Thank you, that is confirmed.');
  }

  private async afterAnswer(
    text: string,
    payload: { latencyMs?: number; durationMs?: number; confidence?: number },
  ) {
    const question = this.current();
    if (!question || !this.interviewer) {
      await this.advance();
      return;
    }

    const turn = await this.interviewer.respond({
      question: question.content,
      category: question.category,
      expectedAnswer: question.expectedAnswer,
      answer: text,
      latencyMs: payload.latencyMs,
      isFinalQuestion: this.index >= this.questions.length - 1,
    });

    // Real-time signals from this answer.
    const insights = analyseAnswer({
      text,
      latencyMs: payload.latencyMs,
      durationMs: payload.durationMs,
      confidence: payload.confidence,
      answerQuality: turn.answerQuality,
    });
    if (insights.length) {
      await InsightService.record(this.sessionCandidateId, insights);
      for (const i of insights) {
        this.emit('insight', { type: i.type, message: i.message, severity: i.severity });
      }
    }

    if (turn.decision === 'END_EARLY') {
      await this.say(turn.spokenResponse, { round: String(question.category), expectsAnswer: false });
      await this.finish('ended_early');
      return;
    }

    // Cap follow-ups so a single question cannot consume the whole interview.
    if ((turn.decision === 'PROBE' || turn.decision === 'REPEAT' || turn.decision === 'CLARIFY') && this.probesOnCurrent < 2) {
      this.probesOnCurrent++;
      await this.say(turn.spokenResponse, {
        round: String(question.category),
        questionId: question.id,
        expectsAnswer: true,
      });
      return;
    }

    await this.advance(turn.spokenResponse);
  }

  /** Moves to the next question, optionally prefixed with an acknowledgement. */
  private async advance(acknowledgement?: string) {
    this.probesOnCurrent = 0;
    this.index++;

    const next = this.current();

    if (!next) {
      this.state = 'CLOSING';
      this.emit('state', { state: this.state, round: 'CLOSING', progress: 100 });

      const ack = acknowledgement ? `${acknowledgement} ` : '';
      await this.say(
        `${ack}That covers everything I wanted to ask. Before we finish, do you have any questions for me about the role or the team?`,
        { round: 'CLOSING', expectsAnswer: true },
      );
      return;
    }

    const isCoding = next.category === 'CODING';
    this.state = isCoding ? 'CODING' : 'IN_ROUND';
    this.emit('state', { state: this.state, round: next.category, progress: this.progress() });

    if (isCoding) {
      const meta = (next.meta ?? {}) as Record<string, unknown>;
      // Hidden test cases must never reach the browser.
      const visibleCases = Array.isArray(meta.testCases)
        ? (meta.testCases as Array<{ input: string; output: string; hidden?: boolean }>).filter((t) => !t.hidden)
        : [];

      this.emit('coding', {
        question: {
          id: next.id,
          title: meta.title ?? 'Coding challenge',
          prompt: next.content,
          constraints: meta.constraints ?? [],
          starterCode: meta.starterCode ?? '',
          difficulty: next.difficulty,
          skill: next.skill,
          sampleTests: visibleCases,
        },
      });

      const ack = acknowledgement ? `${acknowledgement} ` : '';
      await this.say(
        `${ack}Now for a short coding exercise. I have put the problem on your screen. ${next.content} Take your time, talk me through your thinking if you like, and submit when you are ready.`,
        { round: 'CODING', questionId: next.id, expectsAnswer: false },
      );
      return;
    }

    const ack = acknowledgement ? `${acknowledgement} ` : '';
    await this.say(`${ack}${next.content}`, {
      round: String(next.category),
      questionId: next.id,
      expectsAnswer: true,
    });
  }

  private async say(
    text: string,
    opts: { round?: string; questionId?: string; expectsAnswer: boolean },
  ) {
    const clean = text.replace(/\s+/g, ' ').trim();

    await TranscriptService.logTurn(this.sessionCandidateId, {
      speaker: 'AI',
      text: clean,
      questionId: opts.questionId ?? null,
      round: opts.round ?? null,
    }).catch((e) => console.error('[interview] transcript write failed:', e.message));

    this.emit('say', {
      text: clean,
      questionId: opts.questionId,
      round: opts.round,
      expectsAnswer: opts.expectsAnswer,
    });
  }

  private async finish(reason: 'completed' | 'abandoned' | 'ended_early') {
    if (this.state === 'COMPLETED') return;

    this.clearWaitTimers();
    if (this.hardStopTimer) clearTimeout(this.hardStopTimer);

    if (reason === 'completed' || reason === 'ended_early') {
      await this.say(this.interviewer?.closing() ?? 'Thank you for your time today. Goodbye.', {
        round: 'CLOSING',
        expectsAnswer: false,
      });
    }

    this.state = 'COMPLETED';

    await prisma.sessionCandidate
      .update({
        where: { id: this.sessionCandidateId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      })
      .catch((e) => console.error('[interview] completion write failed:', e.message));

    this.emit('state', { state: this.state, progress: 100 });

    // Give the client a beat to finish speaking the closing line.
    setTimeout(() => this.emit('ended', { reason }), 1500);
  }
}
