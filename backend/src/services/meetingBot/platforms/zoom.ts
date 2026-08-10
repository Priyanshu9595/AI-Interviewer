import type { Page } from 'playwright';
import { BotError, type ParsedMeetingLink } from '../errors';
import {
  admitAllWaiting,
  clickFirst,
  clickLocator,
  fillFirst,
  findFirst,
  isPresent,
  postChatMessage,
  readNotice,
  wakeControls,
  setToggle,
  startPresenting,
  stopPresenting as stopSharingScreen,
  type SelectorGroup,
} from '../selectors';
import { assertNotAborted, type MeetingObservation, type PlatformDriver, type PlatformJoinOptions } from './types';

/**
 * Zoom, through the browser client.
 *
 * The link a recruiter copies (`https://us05web.zoom.us/j/8551234567?pwd=…`)
 * does not open a meeting — it opens a page whose whole job is to launch the
 * desktop app, with "Join from your browser" buried underneath. So the bot
 * rewrites it to the web client URL and goes straight there. That is the same
 * destination a person reaches by clicking that link; it just skips a page
 * whose only purpose is to sell them the native app.
 *
 * Zoom allows named guests, so no account is needed for the common case. Sign
 * the bot in with `npm run bot:login zoom` for meetings that require one.
 */

/** Zoom meeting ids are 9–11 digits, usually shown in groups. */
const ZOOM_ID = /^\d{9,11}$/;

const SELECTORS = {
  /** The launcher page, when the bot lands on it despite the rewrite. */
  joinFromBrowser: {
    description: 'join from browser link',
    strategies: [
      { kind: 'role', role: 'link', name: /join from your browser/i },
      { kind: 'role', role: 'button', name: /join from your browser/i },
      { kind: 'text', value: /join from your browser/i },
      { kind: 'css', value: 'a[href*="/wc/join"]' },
      { kind: 'css', value: '#browser_join, .browser_join' },
    ],
  },

  cookieBanner: {
    description: 'cookie or consent banner',
    strategies: [
      { kind: 'role', role: 'button', name: /^(accept cookies|accept all cookies|i accept|agree)$/i },
      { kind: 'css', value: '#onetrust-accept-btn-handler' },
      { kind: 'css', value: '.onetrust-close-btn-handler' },
    ],
  },

  nameInput: {
    description: 'display name field',
    strategies: [
      { kind: 'css', value: '#input-for-name' },
      { kind: 'css', value: 'input[aria-label*="name" i]:not([type="password"])' },
      { kind: 'css', value: 'input[placeholder*="Your Name" i]' },
      { kind: 'role', role: 'textbox', name: /your name/i },
    ],
  },

  passcodeInput: {
    description: 'passcode field',
    strategies: [
      { kind: 'css', value: '#input-for-pwd' },
      { kind: 'css', value: 'input[type="password"][aria-label*="passcode" i]' },
      { kind: 'css', value: 'input[placeholder*="passcode" i]' },
    ],
  },

  /**
   * Zoom's pre-join toggles carry their state in the button text and the
   * aria-label both, and flip between "Start Video" and "Stop Video".
   */
  cameraToggle: {
    description: 'camera toggle',
    strategies: [
      { kind: 'css', value: '#preview-video-control-button' },
      { kind: 'role', role: 'button', name: /(start|stop) video/i },
      { kind: 'label', value: 'video' },
    ],
  },

  microphoneToggle: {
    description: 'microphone toggle',
    strategies: [
      { kind: 'css', value: '#preview-audio-control-button' },
      { kind: 'role', role: 'button', name: /(mute|unmute)/i },
      { kind: 'label', value: 'audio' },
    ],
  },

  joinButton: {
    description: 'join control',
    strategies: [
      { kind: 'css', value: 'button.preview-join-button' },
      { kind: 'role', role: 'button', name: /^join$/i },
      { kind: 'role', role: 'button', name: /^join (audio )?(meeting|now)$/i },
      { kind: 'css', value: '#joinBtn, .joinBtn' },
    ],
  },

  /**
   * The web client joins muted with no audio device until this is pressed. Skip
   * it and the interviewer is in the meeting and completely silent.
   */
  joinAudio: {
    description: 'join computer audio',
    strategies: [
      { kind: 'role', role: 'button', name: /join audio by computer/i },
      { kind: 'css', value: 'button.join-audio-by-voip__join-btn' },
      { kind: 'role', role: 'button', name: /^(join audio|join with computer audio)$/i },
      { kind: 'css', value: '.join-dialog__button, .join-audio-container__btn' },
    ],
  },

  waitingRoom: {
    description: 'waiting room notice',
    strategies: [
      { kind: 'text', value: /please wait, the meeting host will let you in soon/i },
      { kind: 'text', value: /waiting for the host to (start|let)/i },
      { kind: 'text', value: /you are in the waiting room/i },
      { kind: 'css', value: '.wr-content, .waiting-room-container' },
    ],
  },

  admissionDenied: {
    description: 'admission refused notice',
    strategies: [
      { kind: 'text', value: /the host has (denied|removed)/i },
      { kind: 'text', value: /you have been removed (from|by)/i },
      { kind: 'text', value: /host has declined your request/i },
    ],
  },

  inCall: {
    description: 'in-call controls',
    strategies: [
      { kind: 'role', role: 'button', name: /^leave$/i },
      { kind: 'css', value: '.footer__leave-btn, button.footer__leave-btn-container' },
      { kind: 'css', value: '[aria-label*="Leave Meeting" i]' },
      { kind: 'css', value: '#foot-bar, .footer-button__button' },
    ],
  },

  leaveButton: {
    description: 'leave button',
    strategies: [
      { kind: 'role', role: 'button', name: /^leave$/i },
      { kind: 'css', value: '.footer__leave-btn' },
      { kind: 'css', value: '[aria-label*="Leave Meeting" i]' },
    ],
  },

  confirmLeave: {
    description: 'leave confirmation',
    strategies: [
      { kind: 'role', role: 'button', name: /^leave meeting$/i },
      { kind: 'css', value: '.leave-meeting-options__btn' },
    ],
  },

  /** Admit only; Deny is deliberately absent from this group. */
  admitButton: {
    description: 'admit waiting participant',
    strategies: [
      { kind: 'role', role: 'button', name: /^admit all$/i },
      { kind: 'role', role: 'button', name: /^admit$/i },
      { kind: 'css', value: 'button[aria-label*="Admit" i]' },
      { kind: 'css', value: '.waiting-room-list__btn-admit, .participants-item__admit-btn' },
    ],
  },

  admissionRequest: {
    description: 'someone is in the waiting room',
    strategies: [
      { kind: 'text', value: /(is|are) waiting (in the waiting room|to join)/i },
      { kind: 'text', value: /\d+ (person|people) (is|are) waiting/i },
      { kind: 'text', value: /waiting room \(\d+\)/i },
    ],
  },

  presentButton: {
    description: 'share screen button',
    strategies: [
      { kind: 'role', role: 'button', name: /^share screen$/i },
      { kind: 'css', value: '[aria-label*="Share Screen" i]' },
      { kind: 'css', value: '.footer-button__share-btn, .sharer-button' },
    ],
  },

  presentTabOption: {
    description: 'share a tab option',
    strategies: [
      { kind: 'role', role: 'button', name: /^(share|share screen)$/i },
      { kind: 'role', role: 'tab', name: /(tab|chrome tab)/i },
      { kind: 'text', value: /^(chrome tab|a tab)$/i },
    ],
  },

  stopSharing: {
    description: 'stop sharing control',
    strategies: [
      { kind: 'role', role: 'button', name: /stop shar(e|ing)/i },
      { kind: 'css', value: '[aria-label*="Stop Share" i], [aria-label*="Stop sharing" i]' },
      { kind: 'text', value: /you are (screen )?sharing/i },
    ],
  },

  openChat: {
    description: 'chat panel button',
    strategies: [
      { kind: 'label', value: 'open the chat panel' },
      { kind: 'label', value: 'chat' },
      { kind: 'role', role: 'button', name: /^chat$/i },
      { kind: 'role', role: 'button', name: /(open|show) chat/i },
      { kind: 'css', value: '.footer-button__chat-icon' },
      { kind: 'css', value: '[aria-label*="chat" i][role="button"], button[aria-label*="chat" i]' },
      { kind: 'css', value: '[class*="footer-button"][class*="chat"]' },
      // The controls bar hides itself; the button is present but not visible
      // until the pointer moves, which `findFirst` cannot do on its own.
      { kind: 'text', value: /^chat$/i },
    ],
  },

  chatInput: {
    description: 'chat message box',
    strategies: [
      { kind: 'css', value: 'textarea.chat-box__chat-textarea' },
      { kind: 'css', value: 'textarea[aria-label*="Type message here" i]' },
      { kind: 'css', value: 'textarea[placeholder*="Type message" i]' },
      { kind: 'css', value: 'div[contenteditable="true"][aria-label*="message" i]' },
      { kind: 'css', value: 'div[contenteditable="true"][class*="chat"]' },
      { kind: 'role', role: 'textbox', name: /type message/i },
      { kind: 'css', value: '.chat-rtf-box__editor, #chatTextarea' },
    ],
  },

  participantsButton: {
    description: 'participants button',
    strategies: [
      { kind: 'label', value: 'participant' },
      { kind: 'css', value: '[aria-label*="open the participants list" i]' },
      { kind: 'css', value: '.footer-button__participants' },
    ],
  },

  meetingEnded: {
    description: 'meeting ended notice',
    strategies: [
      { kind: 'text', value: /this meeting has been ended by (the )?host/i },
      { kind: 'text', value: /the host has ended (this|the) meeting/i },
      { kind: 'text', value: /you have been removed from (this|the) meeting/i },
      { kind: 'text', value: /meeting has ended/i },
    ],
  },

  meetingUnavailable: {
    description: 'meeting unavailable notice',
    strategies: [
      { kind: 'text', value: /(this meeting|the meeting id) (is not valid|does not exist|has not started)/i },
      { kind: 'text', value: /invalid meeting id/i },
      { kind: 'text', value: /waiting for the host to start this meeting/i },
      { kind: 'text', value: /this meeting has not started/i },
    ],
  },

  signInWall: {
    description: 'Zoom sign-in requirement',
    strategies: [
      { kind: 'text', value: /sign in to join (this )?meeting/i },
      { kind: 'text', value: /this meeting is for authorized (attendees|participants) only/i },
      { kind: 'text', value: /you must sign in to join/i },
    ],
  },

  passcodeError: {
    description: 'wrong or missing passcode notice',
    strategies: [
      { kind: 'text', value: /(passcode|password) (is )?(wrong|incorrect|invalid)/i },
      { kind: 'text', value: /enter the meeting passcode/i },
    ],
  },
} satisfies Record<string, SelectorGroup>;

export const zoomDriver: PlatformDriver = {
  platform: 'ZOOM',
  label: 'Zoom',
  requiresSignIn: false,

  matches: (input) => /(^|\/\/|\.)zoom\.(us|com)\//i.test(input.trim()),

  parse(input): ParsedMeetingLink {
    const trimmed = (input ?? '').trim();
    if (!trimmed) throw new BotError('INVALID_MEETING_URL', 'empty link');

    let url: URL;
    try {
      url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    } catch {
      throw new BotError('INVALID_MEETING_URL', trimmed);
    }

    const host = url.hostname.toLowerCase();
    if (!/(^|\.)zoom\.(us|com)$/.test(host)) throw new BotError('INVALID_MEETING_URL', `host ${host}`);

    // Zoom uses /j/<id> for invitations, /s/<id> for host start links and
    // /wc/<id>/join (or the older /wc/join/<id>) for the web client. All of
    // them identify the meeting by the same numeric id.
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    const id =
      path.match(/^(?:j|s|w|wc)\/(\d{9,11})/i)?.[1] ??
      path.match(/^wc\/join\/(\d{9,11})/i)?.[1] ??
      path.match(/^(\d{9,11})$/)?.[1] ??
      '';

    if (!ZOOM_ID.test(id)) {
      throw new BotError(
        'INVALID_MEETING_URL',
        `path "${path}"`,
        'That is not a Zoom meeting link. It should look like https://us05web.zoom.us/j/85512345678?pwd=…',
      );
    }

    // The encrypted passcode travels in `pwd`. Keeping it means the bot is not
    // stopped by a passcode prompt it has no way to answer.
    const passcode = url.searchParams.get('pwd') ?? undefined;

    // The recruiter and the candidate keep the link they know; only the bot
    // uses the web client, because the launcher page cannot be automated into
    // a meeting.
    const query = passcode ? `?pwd=${encodeURIComponent(passcode)}` : '';

    return {
      platform: 'ZOOM',
      displayUrl: `https://${host}/j/${id}${query}`,
      joinUrl: `https://${host}/wc/${id}/join${query}`,
      id,
      passcode,
    };
  },

  async join(page, opts) {
    assertNotAborted(opts.signal);
    opts.onProgress('OPENING_MEETING', 'Opening the Zoom meeting');

    try {
      await page.goto(opts.link.joinUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (err) {
      throw new BotError('MEETING_PAGE_TIMEOUT', (err as Error).message);
    }

    await page.waitForTimeout(2_500);
    await clickFirst(page, SELECTORS.cookieBanner, { timeoutMs: 3_000 });

    // Zoom sometimes bounces the web client URL back to the launcher.
    if (await clickFirst(page, SELECTORS.joinFromBrowser, { timeoutMs: 4_000 })) {
      await page.waitForTimeout(3_000);
      await clickFirst(page, SELECTORS.cookieBanner, { timeoutMs: 2_000 });
    }

    await assertZoomJoinable(page);

    assertNotAborted(opts.signal);
    opts.onProgress('PRE_JOIN', 'Setting up camera and microphone');

    // The name box is the pre-join screen's landmark; without it there is
    // nothing to fill in and nothing to press.
    const nameFilled = await fillFirst(page, SELECTORS.nameInput, opts.displayName, { timeoutMs: 25_000 });
    if (!nameFilled && !(await isPresent(page, SELECTORS.joinButton))) {
      throw new BotError('PRE_JOIN_NOT_FOUND', `no Zoom pre-join screen at ${page.url()}`);
    }

    if (opts.link.passcode && (await findFirst(page, SELECTORS.passcodeInput, { timeoutMs: 1_500 }))) {
      await fillFirst(page, SELECTORS.passcodeInput, opts.link.passcode, { timeoutMs: 2_000 });
    }

    // Zoom's pre-join preview only offers a camera toggle; the microphone is
    // chosen after joining, at the "join computer audio" prompt below.
    await setToggle(page, SELECTORS.cameraToggle, true, readZoomMuted);

    assertNotAborted(opts.signal);

    const joinButton = await findFirst(page, SELECTORS.joinButton, { timeoutMs: 15_000 });
    if (!joinButton) throw new BotError('JOIN_CONTROL_NOT_FOUND', `no Zoom join control on ${page.url()}`);
    if (!(await clickLocator(joinButton))) {
      throw new BotError('JOIN_CONTROL_NOT_FOUND', 'the Zoom join control could not be clicked');
    }

    opts.onProgress('PRE_JOIN', 'Joining the meeting');
    await waitUntilAdmitted(page, opts);

    // Without this the bot is in the meeting with no audio device at all, which
    // looks like a working join and sounds like total silence.
    await joinComputerAudio(page);

    // Zoom joins muted by default on most accounts.
    await setToggle(page, SELECTORS.microphoneToggle, false, readZoomMuted).catch(() => false);

    opts.onProgress('JOINED', 'In the meeting');
  },

  async observe(page): Promise<MeetingObservation> {
    if (await isPresent(page, SELECTORS.meetingEnded)) {
      const text = (await readNotice(page, SELECTORS.meetingEnded)).toLowerCase();
      return {
        inCall: false,
        participants: 0,
        waitingRoomOccupied: false,
        ended: true,
        endReason: text.includes('removed') ? 'REMOVED' : 'ENDED',
      };
    }

    const inCall = await isPresent(page, SELECTORS.inCall);
    if (!inCall) {
      return { inCall: false, participants: 0, waitingRoomOccupied: false, ended: true, endReason: 'ENDED' };
    }

    const waitingRoomOccupied = await isPresent(page, SELECTORS.admissionRequest);

    const participants = await page
      .evaluate(() => {
        const counts: number[] = [];

        // The participants button shows the count beside it, and its
        // accessible name repeats it.
        for (const el of Array.from(document.querySelectorAll('[aria-label]'))) {
          const label = el.getAttribute('aria-label') ?? '';
          if (!/participant/i.test(label)) continue;
          const match = label.match(/(\d+)/);
          if (match) counts.push(Number(match[1]));
        }

        const counter = document.querySelector('.footer-button__number-counter span');
        if (counter?.textContent) {
          const n = Number(counter.textContent.trim());
          if (Number.isFinite(n) && n > 0) counts.push(n);
        }

        const tiles = document.querySelectorAll(
          '.participants-item__item-layout, li[class*="participants-li"], .gallery-video-container__video-frame',
        );
        if (tiles.length) counts.push(tiles.length);

        return counts.length ? Math.max(...counts) : 0;
      })
      .catch(() => 0);

    return { inCall: true, participants, waitingRoomOccupied, ended: false, endReason: null };
  },

  async admitWaiting(page) {
    let admitted = await admitAllWaiting(page, SELECTORS.admitButton);
    if (admitted > 0) return admitted;

    // The controls fade out when the pointer is still, and a bot's never moves.
    await wakeControls(page);
    admitted = await admitAllWaiting(page, SELECTORS.admitButton);

    // Zoom keeps its waiting room inside the participants panel, so the Admit
    // buttons only exist once that panel is open.
    if (admitted === 0 && (await isPresent(page, SELECTORS.admissionRequest))) {
      await clickFirst(page, SELECTORS.participantsButton, { timeoutMs: 2_000 });
      await page.waitForTimeout(1_200);
      admitted = await admitAllWaiting(page, SELECTORS.admitButton);
    }

    return admitted;
  },

  presentTab(page) {
    return startPresenting(page, {
      presentButton: SELECTORS.presentButton,
      tabOption: SELECTORS.presentTabOption,
      stopSharing: SELECTORS.stopSharing,
    });
  },

  stopPresenting(page) {
    return stopSharingScreen(page, SELECTORS.stopSharing);
  },

  sendChat(page, text) {
    return postChatMessage(page, { openChat: SELECTORS.openChat, chatInput: SELECTORS.chatInput }, text);
  },

  async leave(page) {
    await clickFirst(page, SELECTORS.leaveButton, { timeoutMs: 5_000 });
    // Zoom asks again before it lets anyone out.
    await clickFirst(page, SELECTORS.confirmLeave, { timeoutMs: 3_000 });
    await page.waitForTimeout(1_500);
  },
};

// ---------------------------------------------------------------------------

/**
 * Zoom advertises "Start Video"/"Stop Video" rather than a muted attribute, so
 * the action verb in the label is what carries the state.
 */
const readZoomMuted = (locator: import('playwright').Locator): Promise<boolean | null> =>
  locator
    .evaluate((el) => {
      const text = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.toLowerCase();
      // The label names what pressing it would do, so "stop" means it is on.
      if (/\b(stop video|mute\b)/.test(text)) return false;
      if (/\b(start video|unmute\b)/.test(text)) return true;
      return null;
    })
    .catch(() => null);

async function assertZoomJoinable(page: Page): Promise<void> {
  if (await isPresent(page, SELECTORS.signInWall)) {
    throw new BotError(
      'GUEST_JOIN_BLOCKED',
      await readNotice(page, SELECTORS.signInWall),
      'This Zoom meeting only admits signed-in users. Either turn that requirement off for the meeting, or sign the bot in with `npm run bot:login zoom`.',
    );
  }

  if (await isPresent(page, SELECTORS.meetingUnavailable)) {
    const notice = await readNotice(page, SELECTORS.meetingUnavailable);
    // "Waiting for the host to start" is a meeting that exists but has not
    // opened, which is a different problem from a bad id.
    const notStarted = /not started|waiting for the host/i.test(notice);
    throw new BotError(notStarted ? 'MEETING_NOT_STARTED' : 'INVALID_MEETING_URL', notice);
  }
}

async function waitUntilAdmitted(page: Page, opts: PlatformJoinOptions): Promise<void> {
  const deadline = Date.now() + opts.admissionTimeoutMs;
  let announced = false;

  for (;;) {
    assertNotAborted(opts.signal);

    if (await isPresent(page, SELECTORS.inCall)) return;

    if (await isPresent(page, SELECTORS.admissionDenied)) {
      throw new BotError('ADMISSION_DENIED', await readNotice(page, SELECTORS.admissionDenied));
    }

    if (await isPresent(page, SELECTORS.meetingEnded)) {
      throw new BotError('MEETING_ENDED', 'the meeting ended while waiting to be admitted');
    }

    if (await isPresent(page, SELECTORS.passcodeError)) {
      throw new BotError('PASSCODE_REQUIRED', await readNotice(page, SELECTORS.passcodeError));
    }

    if (!announced && (await isPresent(page, SELECTORS.waitingRoom))) {
      announced = true;
      opts.onProgress('WAITING_FOR_ADMISSION', 'Waiting in the Zoom waiting room');
    }

    if (Date.now() > deadline) {
      throw new BotError(
        announced ? 'ADMISSION_TIMEOUT' : 'MEETING_PAGE_TIMEOUT',
        `no one admitted the interviewer within ${Math.round(opts.admissionTimeoutMs / 1000)}s`,
      );
    }

    await page.waitForTimeout(2_000);
  }
}

/**
 * Presses "Join Audio by Computer".
 *
 * Zoom's web client puts every participant into the meeting with no audio
 * device until this is confirmed, and it can appear a second or two after the
 * meeting UI does. Not finding it is not fatal — some accounts join audio
 * automatically — so the audio bridge's own verification is what actually
 * decides whether the interviewer has a voice.
 */
async function joinComputerAudio(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await clickFirst(page, SELECTORS.joinAudio, { timeoutMs: 2_000 })) {
      await page.waitForTimeout(1_500);
      return;
    }
    await page.waitForTimeout(1_500);
  }

  console.warn('[meet-bot] no Zoom "join computer audio" prompt appeared — assuming audio joined automatically');
}
