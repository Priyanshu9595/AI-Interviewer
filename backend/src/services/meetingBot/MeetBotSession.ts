import { EventEmitter } from 'events';
import type { Page } from 'playwright';
import type { MeetBotStatus } from '@prisma/client';
import { env } from '../../lib/env';
import { prisma } from '../../lib/prisma';
import { EvaluationQueue } from '../EvaluationQueue';
import { InterviewStateMachine, type InterviewState } from '../InterviewStateMachine';
import { AudioManager } from './audioManager';
import { launchBrowser, SHARE_TAB_TITLE, type BotBrowser } from './browser';
import { captureFailure } from './debugCapture';
import { BotError, toBotError, type BotErrorCode, type ParsedMeetingLink } from './errors';
import { joinMeeting } from './joinMeeting';
import { MeetingMonitor, leaveMeeting } from './meetingMonitor';
import { driverFor, parseMeetingLink, type PlatformDriver } from './platforms';

/**
 * One interview, from launching a browser to filing the report.
 *
 * The interview itself is not reimplemented here. `InterviewStateMachine`
 * already owns the script and `LiveInterviewerService` owns the conversation —
 * exactly as they do for the built-in browser room. This class is the transport
 * that connects them to a Google Meet call: it turns the machine's `say` events
 * into audio in the meeting, and turns Deepgram's transcripts into answers.
 *
 * Everything that can go wrong ends in one place: `fail()`, which records a
 * code and a sentence the recruiter can act on.
 */

export interface MeetBotSessionEvents {
  status: { status: MeetBotStatus; detail: string };
  joined: { requiredAdmission: boolean; waitedMs: number };
  message: { speaker: 'AI' | 'CANDIDATE' | 'SYSTEM'; text: string; at: string };
  question: { text: string; questionNumber: number };
  answer: { text: string; confidence: number };
  interim: { text: string };
  completed: { reason: string };
  error: { code: BotErrorCode; message: string };
  finished: void;
}

/**
 * How long a listening interviewer waits in silence before checking in.
 *
 * Long enough that a candidate thinking through a system-design question is not
 * interrupted, short enough that a dropped connection does not stall the call.
 */
const SILENCE_PROMPT_MS = 45_000;

/** After this many unanswered prompts on one question, move on. */
const MAX_SILENCE_PROMPTS = 2;

export class MeetBotSession extends EventEmitter {
  private browser: BotBrowser | null = null;
  private audio: AudioManager | null = null;
  private monitor: MeetingMonitor | null = null;
  private machine: InterviewStateMachine | null = null;
  private driver: PlatformDriver | null = null;

  private readonly abort = new AbortController();
  private status: MeetBotStatus = 'SCHEDULED';
  private finished = false;

  /** Serialises speech, so two turns can never talk over each other. */
  private speechChain: Promise<void> = Promise.resolve();

  private silenceTimer: NodeJS.Timeout | null = null;
  private silencePrompts = 0;
  private durationTimer: NodeJS.Timeout | null = null;
  private noShowTimer: NodeJS.Timeout | null = null;
  private codingTimer: NodeJS.Timeout | null = null;
  private lifetimeTimer: NodeJS.Timeout | null = null;
  /** Where the candidate writes their code, when the session has a coding round. */
  private codingUrl: string | null = null;
  /** The tab showing a live view of that code, shared into the meeting. */
  private codePage: Page | null = null;

  private questionNumber = 0;
  private lastQuestionId: string | undefined;
  private interviewStarted = false;
  /** Set when no meeting audio reached the bot; shown alongside the status. */
  private audioWarning: string | null = null;
  /** Reported once per interview; the monitor would otherwise repeat it. */
  private reportedAdmissionProblem = false;
  /** Same, for a candidate the bot can hear but cannot see in the roster. */
  private notedHeardButNotSeen = false;
  private scheduledAt = new Date();
  private durationMinutes = 30;
  private candidateName = 'the candidate';

  constructor(
    readonly interviewId: string,
    private readonly opts: { manualStart: boolean },
  ) {
    super();
  }

  get currentStatus(): MeetBotStatus {
    return this.status;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async run(): Promise<void> {
    try {
      if (!env.MEET_BOT_ENABLED) throw new BotError('BOT_DISABLED');

      // Armed before anything else can hang. A session occupies one of a small
      // number of concurrency slots, so one that never finishes does not just
      // lose its own interview — it silently stops every later one from being
      // launched at all.
      this.armLifetimeGuard();

      const context = await this.load();
      const driver = this.driver!;

      // Now that the real duration is known, re-arm against it.
      this.armLifetimeGuard();

      await this.setStatus('STARTING', `Starting the AI interviewer for ${driver.label}`);
      await prisma.meetBotRun.update({
        where: { sessionCandidateId: this.interviewId },
        data: { startedAt: new Date(), attempts: { increment: 1 }, errorCode: null, errorMessage: null },
      });

      this.browser = await launchBrowser({
        // Copying the profile exists only so two interviews can run at once —
        // Chromium takes an exclusive lock on a user-data directory. When only
        // one runs at a time the copy is pure cost, and worse than that: recent
        // Chrome binds cookie encryption to the profile's path, so a copied
        // profile arrives signed out and Meet falls back to asking for a guest
        // name. Use the real profile when nothing needs to share it.
        isolated: env.MEET_BOT_MAX_CONCURRENT > 1,
        // Zoom and Teams join as named guests, so a missing profile is not a
        // reason to refuse the interview — only Meet genuinely needs one.
        requireSignedInProfile: driver.requiresSignIn,
      });
      this.watchForCrash();

      this.audio = new AudioManager(this.browser.page, {
        interviewId: this.interviewId,
        language: context.language,
      });
      // Must happen before navigation: the bridge overrides APIs the meeting
      // client captures references to as soon as its bundle runs.
      await this.audio.install();

      const joined = await this.joinWithRetries(context.link);

      await prisma.meetBotRun.update({
        where: { sessionCandidateId: this.interviewId },
        data: { joinedAt: joined.joinedAt },
      });

      await this.setStatus('JOINED', `Joined the ${driver.label} meeting`);
      this.emit('joined', { requiredAdmission: joined.requiredAdmission, waitedMs: joined.elapsedMs });

      await this.audio.verifyBridge();
      this.wireAudio();

      this.monitor = new MeetingMonitor(this.browser.page, driver);
      this.wireMonitor();
      this.monitor.start();

      await this.waitForCandidate();
      // The wait can close the interview itself when nobody turns up, in which
      // case there is nothing left to start.
      if (this.finished) return;
      await this.startInterview();
    } catch (err) {
      await this.fail(toBotError(err));
    }
  }

  /** Stops the interview from the dashboard. */
  async stop(reason = 'Stopped from the dashboard'): Promise<void> {
    if (this.finished) return;

    this.abort.abort();
    await this.audio?.stopSpeaking().catch(() => {});

    // A candidate who was mid-interview has still given real answers, so the
    // machine is told they left rather than being discarded outright: it marks
    // the interview INCOMPLETE and preserves the transcript.
    if (this.interviewStarted && this.machine) {
      await this.machine.candidateLeft().catch(() => {});
    }

    await this.finish('CANCELLED', reason);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /**
   * Joins, retrying failures that a second attempt could plausibly clear.
   *
   * The bot joins minutes before the scheduled start precisely so there is room
   * for this. A meeting page that loaded slowly, or a control that had not
   * rendered yet, should not cost the candidate their interview — and a
   * recruiter reading "the join screen never appeared" cannot tell the
   * difference between bad luck and a broken selector.
   *
   * Failures that will never clear on their own — a signed-out account, a
   * denied admission, a link to nowhere — are thrown on the first attempt.
   */
  private async joinWithRetries(link: ParsedMeetingLink) {
    const attempts = 3;

    for (let attempt = 1; ; attempt++) {
      try {
        return await joinMeeting(this.browser!.page, {
          link,
          signal: this.abort.signal,
          onProgress: ({ stage, detail }) => {
            void this.setStatus(stage as MeetBotStatus, detail);
          },
        });
      } catch (err) {
        const error = toBotError(err);
        const last = attempt >= attempts;

        // Record what the page looked like on the attempt that gave up, so a
        // selector that no longer matches can actually be fixed.
        if (last || !error.retryable) {
          await captureFailure(this.browser!.page, this.interviewId, error.code.toLowerCase()).catch(() => {});
        }

        if (!error.retryable || last || this.abort.signal.aborted) throw error;

        console.warn(
          `[meet-bot ${this.interviewId}] join attempt ${attempt}/${attempts} failed (${error.code}), retrying`,
        );
        await this.setStatus('OPENING_MEETING', `Retrying the join (attempt ${attempt + 1} of ${attempts})`);
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      }
    }
  }

  /**
   * The absolute latest this session may still be alive.
   *
   * Everything inside has its own timeout, so reaching this means something got
   * stuck in a way nothing anticipated. The generous margin is deliberate: it
   * must never cut short a real interview, only rescue a wedged one.
   */
  private armLifetimeGuard(): void {
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);

    const minutes =
      env.MEET_BOT_JOIN_LEAD_MINUTES +
      Math.ceil(env.MEET_BOT_ADMISSION_TIMEOUT_MS / 60_000) +
      env.MEET_BOT_CANDIDATE_WAIT_MINUTES +
      env.MEET_BOT_CANDIDATE_GRACE_MINUTES +
      Math.ceil(this.durationMinutes * 1.5) +
      15;

    this.lifetimeTimer = setTimeout(
      () => {
        if (this.finished) return;
        console.error(
          `[meet-bot ${this.interviewId}] still running after ${minutes} minutes — forcing it to stop so the slot is freed`,
        );
        void this.finish(
          'FAILED',
          `The interview did not finish within ${minutes} minutes and was stopped.`,
          'UNKNOWN',
        );
      },
      minutes * 60_000,
    );
  }

  private async load() {
    const run = await prisma.meetBotRun.findUnique({
      where: { sessionCandidateId: this.interviewId },
      include: {
        sessionCandidate: {
          include: { candidate: true, interviewSession: true },
        },
      },
    });

    if (!run) throw new BotError('RUN_NOT_FOUND', `no bot run exists for interview ${this.interviewId}`);

    // Re-parsed rather than trusted: the stored platform is a label, the link
    // is the fact, and a recruiter may have edited one without the other.
    const link: ParsedMeetingLink = parseMeetingLink(run.meetLink);
    this.driver = driverFor(link.platform);

    const session = run.sessionCandidate.interviewSession;

    this.scheduledAt = session.scheduledAt;
    this.durationMinutes = session.durationMinutes;
    this.candidateName = run.sessionCandidate.candidate.name;
    this.codingUrl = session.codingEnabled
      ? `${env.APP_URL}/interview/${run.sessionCandidate.accessToken}/code`
      : null;

    if (run.platform !== link.platform) {
      await prisma.meetBotRun
        .update({ where: { sessionCandidateId: this.interviewId }, data: { platform: link.platform } })
        .catch(() => {});
    }

    return { link, language: session.language };
  }

  private watchForCrash(): void {
    const lost = (detail: string) => {
      if (this.finished) return;

      // An interview that got several turns in is worth keeping. Telling the
      // machine the candidate left marks it INCOMPLETE and preserves the
      // transcript, rather than discarding a real conversation as a failure.
      if (this.interviewStarted && this.machine) {
        console.warn(`[meet-bot ${this.interviewId}] ${detail} — keeping the transcript as an incomplete interview`);
        void this.machine.candidateLeft().catch(() => {});
        return;
      }

      void this.fail(
        new BotError(
          'BROWSER_CRASHED',
          detail,
          env.MEET_BOT_HEADLESS
            ? undefined
            : 'The interviewer’s browser window closed. When MEET_BOT_HEADLESS=false the bot drives a visible window — closing it ends the interview.',
        ),
      );
    };

    this.browser?.context.on('close', () => lost('the browser closed while the interview was running'));
    this.browser?.page.on('crash', () => lost('the meeting page crashed'));
  }

  private wireAudio(): void {
    const audio = this.audio!;

    audio.on('interim', ({ text }) => this.emit('interim', { text }));

    audio.on('transcript', ({ text, confidence, latencyMs }) => {
      if (!this.interviewStarted || !this.machine) return;

      // Close the gate the moment an answer lands. The machine is about to
      // think and then speak; anything heard in between is not a new answer.
      audio.stopListening();
      this.clearSilenceTimer();
      this.silencePrompts = 0;

      this.emit('answer', { text, confidence });
      this.emit('message', { speaker: 'CANDIDATE', text, at: new Date().toISOString() });

      void this.machine.candidateAnswered({ text, confidence, latencyMs });
    });

    audio.on('speechFailed', (err: BotError) => {
      // An interviewer that cannot hear cannot interview. Fail loudly rather
      // than sit in the meeting asking questions into the void.
      void this.fail(err);
    });

    audio.on('deaf', (status) => {
      // Not fatal on its own — the candidate may simply be muted, and the
      // interview can still recover if they unmute. But the recruiter must see
      // it, because the alternative is a transcript full of "(no answer given)"
      // with no explanation.
      this.audioWarning =
        'No audio is reaching the interviewer. Check that the candidate is unmuted' +
        (status && status.sources.rtc + status.sources.webaudio + status.sources.element === 0
          ? ' — no audio source was found in the meeting at all.'
          : '.');

      void this.setStatus(this.status, this.audioWarning);
      this.emit('message', { speaker: 'SYSTEM', text: this.audioWarning, at: new Date().toISOString() });
    });
  }

  private wireMonitor(): void {
    const monitor = this.monitor!;

    monitor.on('ended', ({ reason }) => {
      if (this.finished) return;

      if (this.interviewStarted && this.machine) {
        // Keep whatever was recorded; the machine decides whether a partial
        // interview is scoreable.
        void this.machine.candidateLeft().catch(() => {});
        return;
      }

      void this.fail(new BotError(reason === 'REMOVED' ? 'REMOVED_FROM_MEETING' : 'MEETING_ENDED'));
    });

    monitor.on('admitted', ({ count }: { count: number }) => {
      const text = `Let ${count === 1 ? 'the candidate' : `${count} participants`} in from the waiting room.`;
      this.emit('message', { speaker: 'SYSTEM', text, at: new Date().toISOString() });
    });

    monitor.on('admissionStuck', ({ seconds }: { seconds: number }) => {
      if (this.reportedAdmissionProblem) return;
      this.reportedAdmissionProblem = true;

      const text =
        `Somebody has been waiting to be let in for ${Math.round(seconds)}s and the interviewer cannot ` +
        'admit them. Please admit them from the meeting yourself — the interview will carry on normally.';

      console.error(`[meet-bot ${this.interviewId}] ${text}`);
      this.emit('message', { speaker: 'SYSTEM', text, at: new Date().toISOString() });
      void this.setStatus(this.status, 'Cannot admit the waiting candidate — admit them manually');

      // The page as it stands is the only way to find out which control moved.
      // Without it this is unfixable from the outside: the symptom is silence.
      if (this.browser && !this.browser.page.isClosed()) {
        void captureFailure(this.browser.page, this.interviewId, 'admit_failed').catch(() => {});
      }
    });

    monitor.on('alone', () => {
      if (this.finished || !this.interviewStarted) return;
      console.log(`[meet-bot ${this.interviewId}] the candidate left the meeting`);
      void this.machine?.candidateLeft().catch(() => {});
    });
  }

  // -------------------------------------------------------------------------
  // Waiting for the candidate
  // -------------------------------------------------------------------------

  /**
   * Holds in the meeting until the candidate is present and the slot has begun.
   *
   * The bot deliberately joins early — that is the point of the lead time — so
   * it is normal to sit here for several minutes. It will not start talking
   * before the scheduled time even if the candidate arrives first, other than a
   * short acknowledgement so they are not left staring at a silent participant.
   */
  private async waitForCandidate(): Promise<void> {
    const clock = (at: number) =>
      new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    const startAt = this.opts.manualStart ? Date.now() : Math.max(Date.now(), this.scheduledAt.getTime());

    // Two deadlines, not one. A 3:00 interview waits until 3:05; if nobody has
    // arrived it waits a final two minutes and cancels at 3:07. The candidate is
    // admitted and the interview starts the moment they appear in either window.
    const scheduled = this.scheduledAt.getTime();
    const waitUntil = scheduled + env.MEET_BOT_CANDIDATE_WAIT_MINUTES * 60_000;
    const graceUntil = waitUntil + env.MEET_BOT_CANDIDATE_GRACE_MINUTES * 60_000;

    await this.setStatus(
      'WAITING_FOR_CANDIDATE',
      `Waiting for ${this.candidateName} — until ${clock(waitUntil)}`,
    );

    let greetedEarly = false;
    let announcedGrace = false;
    /** How long the deadline has been held open for someone still knocking. */
    let admissionExtensionMs = 0;
    const MAX_ADMISSION_EXTENSION_MS = 3 * 60_000;

    for (;;) {
      if (this.abort.signal.aborted) throw new BotError('STOPPED_BY_RECRUITER');
      if (this.finished) return;

      // Two independent signals, because the first one is not trustworthy on
      // its own. Counting participants means reading the meeting client's own
      // interface, and when those selectors drift the bot decides it is alone
      // in a room it can plainly hear. Hearing somebody speak cannot be argued
      // with — a meeting client does not generate speech by itself.
      const seen = this.monitor?.candidateHasJoined ?? false;
      const heard = this.audio?.hasHeardSomeoneSpeak ?? false;
      const present = seen || heard;

      if (heard && !seen && !this.notedHeardButNotSeen) {
        this.notedHeardButNotSeen = true;
        console.warn(
          `[meet-bot ${this.interviewId}] someone is audible but the participant count does not show them — ` +
            'starting on the audio. The participant selectors for this platform need attention.',
        );
        if (this.browser && !this.browser.page.isClosed()) {
          void captureFailure(this.browser.page, this.interviewId, 'participants_miscounted').catch(() => {});
        }
      }

      const knocking = this.monitor?.someoneWaiting ?? false;
      const now = Date.now();

      if (present && now >= startAt) return;

      // Entering the final window. Worth saying plainly, because this is the
      // point at which a recruiter watching can still intervene.
      if (!present && !announcedGrace && now > waitUntil) {
        announcedGrace = true;
        await this.setStatus(
          'WAITING_FOR_CANDIDATE',
          `${this.candidateName} is late — final wait until ${clock(graceUntil)}`,
        );
        this.emit('message', {
          speaker: 'SYSTEM',
          text: `${this.candidateName} has not joined by ${clock(waitUntil)}. Waiting until ${clock(graceUntil)} before cancelling.`,
          at: new Date().toISOString(),
        });
      }

      if (!present && now > graceUntil + admissionExtensionMs) {
        // Someone is visibly knocking. They turned up; the bot simply has not
        // managed to let them in. Cancelling now would blame the wrong person,
        // so hold the door a little longer while admission keeps retrying.
        if (knocking && admissionExtensionMs < MAX_ADMISSION_EXTENSION_MS) {
          admissionExtensionMs += 30_000;
          console.warn(
            `[meet-bot ${this.interviewId}] someone is in the waiting room at the deadline — extending 30s while admission retries`,
          );
          await this.setStatus(
            'WAITING_FOR_CANDIDATE',
            'Someone is in the waiting room — trying to admit them',
          );
        } else {
          await this.cancelForNoShow(knocking, clock(graceUntil));
          return;
        }
      }

      // Present, but early. Say something once so the candidate knows the
      // interviewer is there and waiting rather than broken.
      if (present && !greetedEarly && startAt - now > 60_000) {
        greetedEarly = true;
        const minutes = Math.max(1, Math.round((startAt - now) / 60_000));
        await this.say(
          `Hello ${this.candidateName}, thanks for joining early. I am your interviewer for today. We will begin in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} — please stay on the call.`,
          { expectsAnswer: false },
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  /**
   * Closes an interview nobody came to.
   *
   * Recorded as cancelled rather than failed: nothing broke, and a recruiter
   * scanning a list of interviews should not have to open a red "failed" row to
   * discover the candidate simply did not turn up.
   */
  private async cancelForNoShow(wasKnocking: boolean, deadline: string): Promise<void> {
    await prisma.sessionCandidate
      .update({ where: { id: this.interviewId }, data: { status: 'ABSENT', absentAt: new Date() } })
      .catch((err) => console.error(`[meet-bot ${this.interviewId}] absent write failed:`, err.message));

    const detail = wasKnocking
      ? `Cancelled at ${deadline} — someone was in the waiting room but could not be admitted automatically.`
      : `Cancelled at ${deadline} — ${this.candidateName} did not join.`;

    this.emit('message', { speaker: 'SYSTEM', text: detail, at: new Date().toISOString() });
    await this.finish('CANCELLED', detail, 'CANDIDATE_NO_SHOW');
  }

  // -------------------------------------------------------------------------
  // The interview
  // -------------------------------------------------------------------------

  private async startInterview(): Promise<void> {
    this.interviewStarted = true;
    await this.setStatus('INTRODUCTION', 'The AI interviewer is introducing itself');

    const machine = new InterviewStateMachine(this.interviewId);
    this.machine = machine;

    machine.on('say', ({ text, expectsAnswer, questionId }) => {
      this.trackQuestion(text, questionId);
      void this.say(text, { expectsAnswer });
    });

    machine.on('state', ({ state }: { state: InterviewState }) => {
      void this.setStatus(this.mapState(state), describeState(state));
    });

    // A meeting call has no shared editor, so the candidate writes their code
    // in a browser tab instead. The link goes into the meeting chat and was
    // also emailed with the invitation, because a chat panel the candidate has
    // collapsed is not a delivery mechanism.
    machine.on('coding', () => void this.startCodingRound());

    machine.on('ended', ({ reason }) => {
      void this.onInterviewEnded(reason);
    });

    // The booked slot is the contract with the candidate, so the clock — not
    // the number of questions left — decides when to wrap up.
    this.durationTimer = setTimeout(
      () => void machine.concludeEarly().catch(() => {}),
      this.durationMinutes * 60_000,
    );

    await machine.candidateJoined();
  }

  /**
   * Hands the candidate the coding exercise.
   *
   * The state machine has already queued the spoken introduction, so this only
   * has to deliver the link and then get out of the way. It does not block the
   * interview: the machine stays in CODING until a submission arrives, and the
   * timer below moves it on if one never does.
   */
  private async startCodingRound(): Promise<void> {
    if (this.finished || !this.codingUrl) return;

    await this.setStatus('QUESTIONING', 'Coding exercise — waiting for the candidate to submit');

    // Do not hand out a link that does not work. APP_URL is generated here but
    // served by the frontend, so the two can disagree, and a candidate who
    // opens a 404 mid-interview has no way to recover on their own.
    if (!(await this.codingPageLoads())) {
      const warning =
        `The coding editor is not reachable at ${this.codingUrl}. Check APP_URL, or deploy a frontend that has the page. Skipping the coding round.`;

      console.error(`[meet-bot ${this.interviewId}] ${warning}`);
      this.emit('message', { speaker: 'SYSTEM', text: warning, at: new Date().toISOString() });
      await this.setStatus('QUESTIONING', 'Coding exercise skipped — the editor is not reachable');

      // Better to carry on with the rest of the interview than to sit waiting
      // for a submission that cannot possibly arrive.
      await this.machine?.codingSubmitted({ passed: 0, total: 0 }).catch(() => {});
      return;
    }

    const message = `Coding exercise — open this link to write your solution: ${this.codingUrl}`;
    this.emit('message', { speaker: 'SYSTEM', text: message, at: new Date().toISOString() });

    // Two attempts: the control bar the chat button lives on fades out, and the
    // first click is often what brings it back rather than what opens the chat.
    let posted = false;
    for (let attempt = 0; attempt < 2 && !posted; attempt++) {
      if (!this.browser || !this.driver) break;
      posted = await this.driver.sendChat(this.browser.page, message).catch(() => false);
      if (!posted) await new Promise((r) => setTimeout(r, 2_000));
    }

    if (!posted) {
      console.warn(`[meet-bot ${this.interviewId}] could not post the coding link to the meeting chat`);

      // The chat is the only place this link is delivered, so a failure there
      // leaves the candidate with no way to reach the exercise. Reading it out
      // is a poor substitute for a clickable link, but it is not nothing — and
      // it tells them the round has started rather than leaving them waiting.
      await this.say(
        'I have tried to put a link in the meeting chat. If you cannot see it, please ask the recruiter for your coding exercise link.',
        { expectsAnswer: false },
      );

      this.emit('message', {
        speaker: 'SYSTEM',
        text: 'Could not post the coding link to the meeting chat — send it to the candidate manually.',
        at: new Date().toISOString(),
      });
    }

    await this.presentCandidateCode();

    // A candidate who never submits must not strand the interview. The state
    // machine's own hard stop is much further out, and the remaining questions
    // are worth more than an empty coding round.
    if (this.codingTimer) clearTimeout(this.codingTimer);
    this.codingTimer = setTimeout(
      () => {
        if (this.finished) return;
        console.log(`[meet-bot ${this.interviewId}] coding round timed out; moving on`);
        void this.machine?.codingSubmitted({ passed: 0, total: 0 }).catch(() => {});
      },
      Math.max(5, Math.round(this.durationMinutes / 3)) * 60_000,
    );
  }

  /** Confirms the candidate's editor is actually served before offering it. */
  private async codingPageLoads(): Promise<boolean> {
    if (!this.codingUrl) return false;

    try {
      const res = await fetch(this.codingUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(8_000),
      });
      return res.status === 200;
    } catch (err) {
      console.error(`[meet-bot ${this.interviewId}] coding page check failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Puts a live view of the candidate's editor on the meeting's shared screen.
   *
   * The spectator page renders what the candidate types, over a websocket, and
   * the bot shares that tab. Everyone in the meeting watches the code appear;
   * nobody but the candidate can type into it.
   *
   * Every step here is best effort. Screen sharing is the least dependable
   * thing the bot does — the picker is browser chrome, steered by a
   * command-line flag rather than clicked — and the coding round works without
   * it, so a failure is logged and the interview carries on.
   */
  private async presentCandidateCode(): Promise<void> {
    if (!env.MEET_BOT_SHARE_CODE_SCREEN) return;
    if (!this.browser || !this.driver || !this.codingUrl) return;

    try {
      // The tab has to exist before the picker opens: Chromium matches it by
      // title, and cannot select a tab that is not there yet.
      this.codePage = await this.browser.context.newPage();
      await this.codePage.goto(`${this.codingUrl}/live`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // And it has to be *named* before the picker opens, which is the part
      // that used to be assumed. The picker is steered entirely by a
      // command-line title match; if nothing matches, Chromium does not give
      // up, it shares whatever it finds first. That was usually the meeting
      // itself, so the call was shared back into the call and filled with
      // feedback — the echo after the coding round.
      //
      // The page sets its title from JavaScript after hydrating, so a fixed
      // wait is a guess. Waiting for the actual title turns a race into a
      // decision: either the tab the picker will match exists, or we do not
      // open the picker at all.
      if (!(await this.codePageIsNamed())) {
        console.warn(
          `[meet-bot ${this.interviewId}] the code tab never took the title Chromium matches on; not sharing, because the picker would have chosen the meeting`,
        );
        await this.codePage.close().catch(() => {});
        this.codePage = null;
        return;
      }

      // Sharing is driven from the meeting tab, so bring it back to the front.
      await this.browser.page.bringToFront();

      const shared = await this.driver.presentTab(this.browser.page);

      if (shared) {
        console.log(`[meet-bot ${this.interviewId}] presenting the candidate's editor`);
        this.emit('message', {
          speaker: 'SYSTEM',
          text: 'Sharing a live view of the candidate’s code with the meeting.',
          at: new Date().toISOString(),
        });
      } else {
        console.warn(
          `[meet-bot ${this.interviewId}] could not start screen sharing — the coding round continues without it`,
        );
      }
    } catch (err) {
      console.warn(`[meet-bot ${this.interviewId}] screen sharing failed: ${(err as Error).message}`);
    }
  }

  /**
   * Waits for the code tab to carry the exact title Chromium is told to match.
   *
   * Exact, not "contains": the flag matches on the whole title, and a page
   * still showing the framework's default one is precisely the case this
   * exists to catch.
   */
  private async codePageIsNamed(): Promise<boolean> {
    if (!this.codePage) return false;

    for (let i = 0; i < 20; i++) {
      const title = await this.codePage.title().catch(() => '');
      if (title.trim() === SHARE_TAB_TITLE) return true;
      await this.codePage.waitForTimeout(500);
    }

    return false;
  }

  private async stopPresentingCode(): Promise<void> {
    if (this.browser && this.driver && !this.browser.page.isClosed()) {
      await this.driver.stopPresenting(this.browser.page).catch(() => {});
    }

    await this.codePage?.close().catch(() => {});
    this.codePage = null;
  }

  /** Called when the candidate submits from the coding page. */
  async codingSubmitted(summary: { passed: number; total: number }): Promise<void> {
    if (this.finished || !this.machine) return;

    if (this.codingTimer) clearTimeout(this.codingTimer);
    this.codingTimer = null;

    // The code is no longer being written, so it no longer needs the screen.
    await this.stopPresentingCode();

    this.emit('message', {
      speaker: 'SYSTEM',
      text: `Coding solution submitted — ${summary.passed}/${summary.total} test cases passed.`,
      at: new Date().toISOString(),
    });

    await this.machine.codingSubmitted(summary);
  }

  private trackQuestion(text: string, questionId?: string): void {
    if (!questionId) return;

    if (questionId !== this.lastQuestionId) {
      this.lastQuestionId = questionId;
      this.questionNumber++;
      this.emit('question', { text, questionNumber: this.questionNumber });
      return;
    }

    // Same question, spoken again: the interviewer is probing or rephrasing.
    void this.setStatus('FOLLOW_UP', 'Asking a follow-up question');
  }

  /** Speaks one line into the meeting, strictly after everything before it. */
  private say(text: string, opts: { expectsAnswer: boolean }): Promise<void> {
    this.speechChain = this.speechChain
      .then(async () => {
        if (this.finished || !this.audio) return;

        this.emit('message', { speaker: 'AI', text, at: new Date().toISOString() });
        await this.audio.speak(text, { expectsAnswer: opts.expectsAnswer, signal: this.abort.signal });

        if (opts.expectsAnswer) this.armSilenceTimer();
      })
      .catch((err) => {
        const botError = toBotError(err);
        // Losing the voice mid-interview is terminal: there is no fallback
        // channel to the candidate inside a Meet call.
        if (botError.code === 'TTS_UNAVAILABLE' || botError.code === 'BROWSER_CRASHED') {
          void this.fail(botError);
        } else {
          console.error(`[meet-bot ${this.interviewId}] speech failed: ${botError.message}`);
        }
      });

    return this.speechChain;
  }

  private armSilenceTimer(): void {
    this.clearSilenceTimer();

    this.silenceTimer = setTimeout(() => {
      if (this.finished || !this.machine) return;

      // Nothing has been asked yet — the interviewer said hello and is waiting
      // to be greeted back. The machine owns what to do about that, and what
      // it does not do is pretend a question went unanswered.
      if (this.machine.state === 'GREETING') {
        void this.machine.greetingUnanswered();
        return;
      }

      this.silencePrompts++;

      if (this.silencePrompts > MAX_SILENCE_PROMPTS) {
        // Treated as an unanswered question rather than a stalled interview:
        // the machine records the gap and moves the script forward.
        this.silencePrompts = 0;
        void this.machine.candidateAnswered({ text: '(no answer given)', confidence: 0 });
        return;
      }

      void this.machine.silenceDetected();
    }, SILENCE_PROMPT_MS);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  private async onInterviewEnded(reason: string): Promise<void> {
    if (this.finished) return;

    await this.setStatus('ENDING', 'Wrapping up');

    // Let the closing line finish playing before leaving, or the candidate
    // hears the interviewer cut itself off mid-sentence.
    await this.speechChain.catch(() => {});

    if (reason === 'no_show') {
      await this.finish('CANCELLED', 'Cancelled — the candidate never joined', 'CANDIDATE_NO_SHOW');
      return;
    }

    await this.finish('COMPLETED', `Interview ${reason}`);

    // Only a full interview earns a report; the machine has already recorded
    // an abandoned one as INCOMPLETE and it is deliberately not scored.
    if (reason === 'completed' || reason === 'ended_early') {
      void EvaluationQueue.run(this.interviewId)
        .then((ok) => {
          if (ok) this.emit('completed', { reason: 'report_ready' });
        })
        .catch((err) => console.error(`[meet-bot ${this.interviewId}] evaluation failed:`, err.message));
    }
  }

  // -------------------------------------------------------------------------
  // Status and teardown
  // -------------------------------------------------------------------------

  private lastDetail = '';

  private async setStatus(status: MeetBotStatus, detail: string): Promise<void> {
    if (this.finished && status !== 'COMPLETED' && status !== 'FAILED' && status !== 'CANCELLED') return;
    // A repeated status with new wording still matters — an audio warning
    // arrives while the status itself stays QUESTIONING.
    if (this.status === status && this.lastDetail === detail && status !== 'FOLLOW_UP') return;

    this.status = status;
    this.lastDetail = detail;
    this.emit('status', { status, detail });

    await prisma.meetBotRun
      .update({ where: { sessionCandidateId: this.interviewId }, data: { status, statusDetail: detail } })
      .catch((err) => console.error(`[meet-bot ${this.interviewId}] status write failed:`, err.message));
  }

  private mapState(state: InterviewState): MeetBotStatus {
    switch (state) {
      case 'WAITING_FOR_CANDIDATE':
        return 'WAITING_FOR_CANDIDATE';
      case 'GREETING':
      case 'IDENTITY_VERIFICATION':
        return 'INTRODUCTION';
      case 'IN_ROUND':
      case 'CODING':
        return 'QUESTIONING';
      case 'CLOSING':
        return 'FINAL_QUESTION';
      case 'COMPLETED':
        return 'COMPLETED';
      case 'INCOMPLETE':
      case 'ABSENT':
        return 'FAILED';
      default:
        return 'QUESTIONING';
    }
  }

  private async fail(error: BotError): Promise<void> {
    if (this.finished) return;

    console.error(
      `[meet-bot ${this.interviewId}] ${error.code}: ${error.detail ?? error.message}`,
    );

    this.emit('error', { code: error.code, message: error.message });
    await this.finish('FAILED', error.message, error.code);
  }

  /** Single exit path: writes the outcome, leaves the meeting, frees the browser. */
  private async finish(status: 'COMPLETED' | 'FAILED' | 'CANCELLED', detail: string, code?: BotErrorCode): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    this.clearSilenceTimer();
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.noShowTimer) clearTimeout(this.noShowTimer);
    if (this.codingTimer) clearTimeout(this.codingTimer);
    if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);

    this.status = status;
    this.emit('status', { status, detail });

    await prisma.meetBotRun
      .update({
        where: { sessionCandidateId: this.interviewId },
        data: {
          status,
          statusDetail: detail,
          endedAt: new Date(),
          errorCode: code ?? null,
          errorMessage: status === 'FAILED' ? detail : null,
        },
      })
      .catch((err) => console.error(`[meet-bot ${this.interviewId}] final status write failed:`, err.message));

    this.monitor?.stop();
    this.monitor = null;

    await this.stopPresentingCode().catch(() => {});

    if (this.browser && this.driver && !this.browser.page.isClosed()) {
      await leaveMeeting(this.browser.page, this.driver).catch(() => {});
    }

    this.audio?.dispose();
    this.audio = null;

    this.machine?.dispose();
    this.machine = null;

    await this.browser?.close().catch(() => {});
    this.browser = null;

    if (status === 'COMPLETED') this.emit('completed', { reason: detail });
    this.emit('finished');
    this.removeAllListeners();
  }
}

function describeState(state: InterviewState): string {
  switch (state) {
    case 'WAITING_FOR_CANDIDATE':
      return 'Waiting for the candidate to join';
    case 'GREETING':
      return 'Introducing itself';
    case 'IDENTITY_VERIFICATION':
      return 'Confirming the candidate’s identity';
    case 'IN_ROUND':
      return 'Asking interview questions';
    case 'CODING':
      return 'Coding round';
    case 'CLOSING':
      return 'Final question';
    case 'COMPLETED':
      return 'Interview completed';
    case 'INCOMPLETE':
      return 'The candidate left before the interview finished';
    case 'ABSENT':
      return 'The candidate never joined';
    default:
      return 'In progress';
  }
}
