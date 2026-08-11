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
  /// The candidate left before the interviewer finished. Never scored.
  | 'INCOMPLETE'
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
 * How many times to ask a silent candidate to say hello before giving up.
 *
 * At the caller's 45-second spacing that is four prompts over three minutes,
 * with the interview closing just before the four-minute mark — long enough to
 * find the unmute button, short enough not to spend a booked slot on someone
 * who is not there.
 */
const MAX_GREETING_PROMPTS = 4;

/** Strips the filler a transcript arrives wrapped in, so patterns can match. */
function bare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?]+/g, '')
    .replace(/^(um+|uh+|er+|so|well|okay|ok|actually|i think|i guess)\b\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "No, nothing from me" — the candidate is done. */
export function isDecline(text: string): boolean {
  const t = bare(text);
  if (t.split(' ').length > 8) return false; // too long to be a simple no
  return /^(no|nope|nah|nahi+n?|not really|none|nothing|no thanks?|no thank you|i'?m good|im good|all good|that'?s (it|all)|thats (it|all)|i'?m fine|no questions?( from me)?)\b/.test(
    t,
  );
}

/**
 * "Yes." — an answer to *whether* they have a question, not the question.
 *
 * Deliberately narrow: only a short, purely affirmative utterance counts. A
 * candidate who says "yes, what does the team look like" has asked, and must
 * not be sent back round to ask again. Length is the honest test here, since
 * speech to text seldom supplies the question mark that would settle it.
 */
export function isBareAffirmative(text: string): boolean {
  const t = bare(text);
  if (t.split(' ').length > 5) return false;
  return /^(yes|yeah|yep|yup|ya|haa+n?|sure|i do|yes i do|yes please|definitely|absolutely)( i have( a| one)?( question| questions)?)?$/.test(
    t,
  );
}

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
  /** Times we have invited a candidate who said "yes" to actually ask. */
  private closingPrompts = 0;
  /** Times we have asked a joined-but-silent candidate to say hello. */
  private greetingPrompts = 0;
  /** Turns of hello-how-are-you spoken so far, capped so it stays brief. */
  private greetingExchanges = 0;
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
    if (this.busy || this.state === 'COMPLETED' || this.state === 'INCOMPLETE' || this.state === 'ABSENT') return;
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
          await this.afterGreeting(text);
          break;
        case 'IDENTITY_VERIFICATION':
          await this.afterIdentity(text);
          break;
        case 'IN_ROUND':
        case 'CODING':
          await this.afterAnswer(text, payload);
          break;
        case 'CLOSING':
          await this.afterClosing(text);
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

  /**
   * The candidate's reply to "do you have any questions for me?".
   *
   * This used to end the interview on whatever came back, which meant an
   * eager "Yes." was answered with goodbye — the interviewer asked a question
   * and then hung up before the candidate could ask theirs. Nothing in a
   * transcript looks worse.
   *
   * So three outcomes rather than one: a refusal closes, a bare "yes" waits,
   * and anything else is treated as the question itself and answered.
   */
  private async afterClosing(text: string) {
    const said = text.trim();

    if (!said || isDecline(said)) {
      await this.finish('completed');
      return;
    }

    // "Yes" is not a question — it is notice that one is coming. Speech to text
    // rarely returns the question in the same breath, so invite it and wait.
    if (isBareAffirmative(said)) {
      // Bounded, because a candidate who only ever says "yes" would otherwise
      // keep the interview open forever.
      if (this.closingPrompts >= 2) {
        await this.finish('completed');
        return;
      }
      this.closingPrompts++;
      await this.say('Of course — please go ahead.', { round: 'CLOSING', expectsAnswer: true });
      return;
    }

    // A real question. Answering it is the point of having asked.
    if (!this.interviewer) {
      await this.finish('completed');
      return;
    }

    // The caller has already written this turn to the transcript.
    const reply = await this.interviewer.answerClosingQuestion(said);

    // Answered, and that is the end of it. Offering "anything else?" kept the
    // interview open on a candidate who had already finished: the usual reply
    // is silence, which the silence timer then treated as an unanswered
    // question and asked whether they would like it rephrased.
    await this.say(reply, { round: 'CLOSING', expectsAnswer: false });
    await this.finish('completed');
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
    if (this.busy || this.state === 'COMPLETED' || this.state === 'INCOMPLETE' || this.state === 'ABSENT') return;

    // Silence after "any questions for me?" is an answer, and the answer is
    // no. Offering to rephrase treats it as a question they failed to follow,
    // which is both wrong and a strange note to end an interview on.
    if (this.state === 'CLOSING') {
      await this.finish('completed');
      return;
    }

    await InsightService.record(this.sessionCandidateId, [
      { type: 'LONG_PAUSE', message: 'Went silent without answering.', severity: 0.6 },
    ]);
    this.emit('insight', { type: 'LONG_PAUSE', message: 'Long silence', severity: 0.6 });

    await this.say('Take your time. Would you like me to rephrase the question?', {
      round: this.current()?.category ?? 'IN_ROUND',
      expectsAnswer: true,
    });
  }

  /**
   * Silence after "Hello — shall we begin?", before the candidate has said a
   * single word.
   *
   * This is not an unanswered question and must not be treated as one. Nothing
   * has been asked yet: the interviewer said hello and is waiting to be said
   * hello back to. Scoring that as a skipped answer and moving on walks the
   * entire script past someone who never spoke — a full transcript of
   * "(no answer given)", a report, and a candidate who was sitting there the
   * whole time with a microphone that was not working.
   *
   * So we wait, and keep asking. What eventually runs out is patience, not the
   * script: if nothing ever comes back the interview stops honestly as
   * incomplete rather than pretending to have happened.
   */
  async greetingUnanswered() {
    if (this.busy || this.state !== 'GREETING') return;

    this.greetingPrompts++;

    if (this.greetingPrompts > MAX_GREETING_PROMPTS) {
      await InsightService.record(this.sessionCandidateId, [
        {
          type: 'LONG_PAUSE',
          message: 'Joined but never responded to the greeting.',
          severity: 1,
        },
      ]);
      await this.say(
        'I have not been able to hear anything from you, so I will stop here rather than carry on by myself. Please check your microphone and contact the recruiting team to rearrange.',
        { round: 'GREETING', expectsAnswer: false },
      );
      await this.finish('abandoned');
      return;
    }

    const line =
      this.greetingPrompts === 1
        ? `Can you hear me, ${this.candidateName}? Say hello whenever you are ready and we will make a start.`
        : this.greetingPrompts === 2
          ? 'I still cannot hear you. Have a look at your microphone — you may be muted — and just say hello when it is working.'
          : 'Take your time. I will wait here until I hear you.';

    await this.say(line, { round: 'GREETING', expectsAnswer: true });
  }

  async candidateLeft() {
    if (this.state === 'COMPLETED' || this.state === 'INCOMPLETE' || this.state === 'ABSENT') return;
    await this.finish('abandoned');
  }

  /**
   * Skips the remaining questions and moves straight to the closing round.
   *
   * For callers that own the clock rather than the script — the Google Meet
   * bot runs inside a slot the recruiter booked, so it has to wrap up on time
   * even with questions left. The interview still ends properly and is still
   * scored, because the interviewer chose to stop rather than the candidate.
   */
  async concludeEarly() {
    if (['CLOSING', 'COMPLETED', 'INCOMPLETE', 'ABSENT'].includes(this.state)) return;

    // A turn already in flight owns the conversation; interrupting it would
    // talk over the interviewer. Wait briefly, then take over regardless.
    for (let i = 0; i < 20 && this.busy; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }

    if (['CLOSING', 'COMPLETED', 'INCOMPLETE', 'ABSENT'].includes(this.state)) return;

    this.busy = true;
    try {
      // advance() increments first, so land it one short of the end and let it
      // fall off into the closing round through the normal path.
      this.index = Math.max(this.index, this.questions.length - 1);
      this.state = 'IN_ROUND';
      await this.advance('We are coming up on time, so I will stop there.');
    } finally {
      this.busy = false;
    }
  }

  /** Whether a turn is currently being processed. */
  get isBusy(): boolean {
    return this.busy;
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

  /**
   * The hellos, before any of it is an interview.
   *
   * People do not open with an agenda. They say hello, ask how you are, wait,
   * answer when it comes back to them, and only then get to the point. The
   * interviewer used to skip all of that: it delivered its whole preamble to
   * an empty room and moved on regardless of what the candidate said, so a
   * candidate who replied "hi" was answered with the schedule and a candidate
   * who asked "and yourself?" was never answered at all.
   *
   * At most two turns of this. It is warmth, not conversation, and a candidate
   * who wants to keep chatting is better served by starting the interview.
   */
  private async afterGreeting(text: string) {
    this.greetingExchanges++;

    const said = bare(text);
    const askedBack = /\b(what about you|how about you|how are you|and you|and yourself|yourself)\b/.test(said);

    // Split rather than lumped together as "said how they are". A candidate
    // who admits to being nervous and is told "glad to hear it" is worse off
    // than one who got the old recorded announcement.
    const unwell = /\b(nervous|anxious|scared|worried|tired|exhausted|stressed|unwell|sick|not (great|good|well)|bit off)\b/.test(
      said,
    );
    const well = /\b(fine|good|great|well|okay|ok|alright|not bad|excellent|amazing|perfect|theek|badhiya|thik)\b/.test(
      said,
    );

    // They said hello without saying how they are. Ask — once, and reworded,
    // because repeating the question verbatim sounds like a stuck record.
    if (!well && !unwell && !askedBack && this.greetingExchanges < 2) {
      await this.say(this.interviewer?.howAreYou() ?? 'How are you doing today?', {
        round: 'GREETING',
        expectsAnswer: true,
      });
      return;
    }

    // Answering the question they asked, before moving on. Sailing past it is
    // the single most robotic thing an interviewer can do.
    const opener = unwell
      ? 'That is completely normal, and there is no rush at all — we will take it at your pace.'
      : askedBack
        ? 'I am doing well, thank you for asking.'
        : well
          ? 'Glad to hear it.'
          : 'Thank you.';

    this.state = 'IDENTITY_VERIFICATION';
    this.emit('state', { state: this.state, round: 'IDENTITY', progress: 0 });

    this.askedIdentity = true;
    await this.say(
      this.interviewer?.intro(opener) ??
        `${opener} Before we start, could you confirm your full name and the role you have applied for?`,
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

    const isFollowUp =
      turn.decision === 'PROBE' || turn.decision === 'REPEAT' || turn.decision === 'CLARIFY';

    // Cap follow-ups so a single question cannot consume the whole interview.
    if (isFollowUp && this.probesOnCurrent < 2) {
      this.probesOnCurrent++;
      await this.say(turn.spokenResponse, {
        round: String(question.category),
        questionId: question.id,
        expectsAnswer: true,
      });
      return;
    }

    // Out of follow-ups, so we move on — but `spokenResponse` here is still a
    // follow-up *question*, and `advance` puts the next question straight after
    // whatever it is given. Passing it through asks two things in one breath:
    //
    //   "...Can you tell me something you are proud of? What is the difference
    //    between a controlled and an uncontrolled component in React?"
    //
    // The candidate answers neither. Only a NEXT response is an acknowledgement
    // — and only that one has been trimmed to a few words — so anything else is
    // dropped for a plain one.
    await this.advance(isFollowUp ? 'Thank you.' : turn.spokenResponse);
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

  /**
   * Ends the interview.
   *
   * Only an interview the AI carried through to its closing round counts as
   * COMPLETED and earns a score. A candidate who cuts it short is recorded as
   * INCOMPLETE: a partial interview cannot be scored fairly against a full one,
   * and a low score caused by walking out would misrepresent them.
   *
   * `ended_early` is the exception — the interviewer itself chose to stop (the
   * candidate was unwell or asked to stop), so it is closed off properly.
   */
  private async finish(reason: 'completed' | 'abandoned' | 'ended_early') {
    if (this.state === 'COMPLETED' || this.state === 'INCOMPLETE') return;

    this.clearWaitTimers();
    if (this.hardStopTimer) clearTimeout(this.hardStopTimer);

    const interviewerFinished = reason === 'completed' || reason === 'ended_early';

    if (interviewerFinished) {
      await this.say(this.interviewer?.closing() ?? 'Thank you for your time today. Goodbye.', {
        round: 'CLOSING',
        expectsAnswer: false,
      });
    }

    this.state = interviewerFinished ? 'COMPLETED' : 'INCOMPLETE';

    await prisma.sessionCandidate
      .update({
        where: { id: this.sessionCandidateId },
        data: interviewerFinished
          ? { status: 'COMPLETED', completedAt: new Date() }
          : {
              status: 'INCOMPLETE',
              // Recorded so the recruiter can see how far they got.
              completedAt: new Date(),
            },
      })
      .catch((e) => console.error('[interview] completion write failed:', e.message));

    if (!interviewerFinished) {
      const answered = this.index + 1;
      console.log(
        `[interview] ${this.sessionCandidateId} left after ${answered}/${this.questions.length} questions — marked INCOMPLETE, not scored`,
      );
    }

    this.emit('state', { state: this.state, progress: this.progress() });

    // Give the client a beat to finish speaking the closing line.
    setTimeout(() => this.emit('ended', { reason }), 1500);
  }
}
