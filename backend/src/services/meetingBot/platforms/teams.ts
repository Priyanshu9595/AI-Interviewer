import type { Locator, Page } from 'playwright';
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
 * Microsoft Teams, through the web client.
 *
 * A Teams link opens a launcher offering the desktop app, the store, or
 * "Continue on this browser". The bot takes the third, then joins anonymously
 * with a display name — which is what an external candidate does too.
 *
 * Anonymous join is a tenant setting. When it is off, Teams demands a sign-in
 * and the bot reports that rather than trying to get around it. Signing the bot
 * account in with `npm run bot:login teams` covers those tenants.
 *
 * The query string is load-bearing here in a way it is not for Meet or Zoom:
 * the `context` parameter carries the tenant and organiser, and a link stripped
 * of it does not resolve to a meeting at all.
 */

const SELECTORS = {
  /** The launcher's third option, which is the only one the bot can use. */
  continueInBrowser: {
    description: 'continue on this browser',
    strategies: [
      { kind: 'css', value: 'button[data-tid="joinOnWeb"]' },
      { kind: 'css', value: '[data-tid="joinOnWeb"], [data-tid="continueOnBrowser"]' },
      { kind: 'role', role: 'button', name: /continue on this browser/i },
      { kind: 'role', role: 'link', name: /continue on this browser/i },
      { kind: 'role', role: 'button', name: /(use the web app instead|join on the web instead)/i },
      { kind: 'role', role: 'link', name: /(use the web app instead|join on the web instead)/i },
      { kind: 'text', value: /continue on this browser/i },
      { kind: 'text', value: /join on the web instead/i },
      { kind: 'css', value: 'a[href*="launcher"][href*="web"]' },
    ],
  },

  /**
   * Consumer Teams asks how you want to be identified before the pre-join
   * screen. The guest path is the one an external candidate takes too.
   */
  guestOption: {
    description: 'join as guest',
    strategies: [
      { kind: 'role', role: 'button', name: /^(join as a guest|continue as guest|join as guest)$/i },
      { kind: 'role', role: 'link', name: /^(join as a guest|continue as guest|join as guest)$/i },
      { kind: 'css', value: '[data-tid="joinAsGuest"], [data-tid="anonymous-join-button"]' },
      { kind: 'text', value: /^(join as a guest|continue as guest)$/i },
    ],
  },

  dismissDialog: {
    description: 'consent or notice dialog',
    strategies: [
      { kind: 'role', role: 'button', name: /^(accept|accept all|got it|ok|close|dismiss|continue)$/i },
      { kind: 'css', value: 'button[data-tid="acceptAll"]' },
      { kind: 'css', value: '#onetrust-accept-btn-handler' },
      { kind: 'css', value: 'button[aria-label*="Close" i][data-tid]' },
    ],
  },

  nameInput: {
    description: 'display name field',
    strategies: [
      { kind: 'css', value: 'input[data-tid="prejoin-display-name-input"]' },
      { kind: 'css', value: 'input[placeholder*="Type your name" i]' },
      { kind: 'css', value: 'input[placeholder*="Enter name" i]' },
      { kind: 'css', value: 'input[placeholder*="Your name" i]' },
      { kind: 'css', value: 'input[aria-label*="type your name" i]' },
      { kind: 'css', value: 'input[aria-label*="enter your name" i]' },
      { kind: 'css', value: 'input[aria-label*="name" i][type="text"]' },
      { kind: 'role', role: 'textbox', name: /(type your name|your name|enter name|enter your name)/i },
      // Consumer Teams renders an unlabelled text box on the pre-join screen.
      { kind: 'css', value: 'input[type="text"]:not([type="search"])' },
    ],
  },

  cameraToggle: {
    description: 'camera toggle',
    strategies: [
      { kind: 'css', value: '[data-tid="toggle-video"]' },
      { kind: 'css', value: 'div[title*="camera" i][role="button"]' },
      { kind: 'role', role: 'checkbox', name: /camera/i },
      { kind: 'label', value: 'camera' },
    ],
  },

  microphoneToggle: {
    description: 'microphone toggle',
    strategies: [
      { kind: 'css', value: '[data-tid="toggle-mute"]' },
      { kind: 'css', value: 'div[title*="microphone" i][role="button"]' },
      { kind: 'role', role: 'checkbox', name: /(microphone|mic)/i },
      { kind: 'label', value: 'microphone' },
    ],
  },

  joinButton: {
    description: 'join control',
    strategies: [
      { kind: 'css', value: 'button[data-tid="prejoin-join-button"]' },
      { kind: 'css', value: '[data-tid="prejoin-join-button"], [data-tid="joinButton"]' },
      { kind: 'role', role: 'button', name: /^join now$/i },
      { kind: 'role', role: 'button', name: /^join (meeting|as a guest|the meeting)$/i },
      { kind: 'text', value: /^join now$/i },
      { kind: 'css', value: 'button[aria-label*="Join now" i]' },
    ],
  },

  lobby: {
    description: 'lobby notice',
    strategies: [
      { kind: 'text', value: /someone will let you in shortly/i },
      { kind: 'text', value: /when the meeting starts, we.ll let people know/i },
      { kind: 'text', value: /you.re in the lobby/i },
      { kind: 'text', value: /waiting for (someone|the organi[sz]er) to let you in/i },
      { kind: 'css', value: '[data-tid="lobby-screen"]' },
    ],
  },

  admissionDenied: {
    description: 'admission refused notice',
    strategies: [
      { kind: 'text', value: /(sorry, you were denied access|you were not admitted)/i },
      { kind: 'text', value: /didn.t (get an answer|let you in)/i },
      { kind: 'text', value: /no one (answered|responded)/i },
    ],
  },

  inCall: {
    description: 'in-call controls',
    strategies: [
      { kind: 'css', value: '#hangup-button' },
      { kind: 'css', value: '[data-tid="hangup-main-btn"]' },
      { kind: 'css', value: '[data-tid="call-controls"]' },
      { kind: 'role', role: 'button', name: /^(leave|hang up)$/i },
      { kind: 'label', value: 'leave (ctrl' },
    ],
  },

  leaveButton: {
    description: 'leave button',
    strategies: [
      { kind: 'css', value: '#hangup-button' },
      { kind: 'css', value: '[data-tid="hangup-main-btn"]' },
      { kind: 'role', role: 'button', name: /^leave$/i },
    ],
  },

  peopleButton: {
    description: 'people button',
    strategies: [
      { kind: 'css', value: '[data-tid="roster-button"]' },
      { kind: 'css', value: '#roster-button' },
      { kind: 'label', value: 'people' },
      { kind: 'label', value: 'participants' },
    ],
  },

  /** Admit only; Deny is deliberately absent from this group. */
  admitButton: {
    description: 'admit waiting participant',
    strategies: [
      { kind: 'css', value: '[data-tid="lobby-admit-all"], [data-tid="admit-all-button"]' },
      { kind: 'css', value: '[data-tid^="lobby-admit"], [data-tid="admit-button"]' },
      { kind: 'role', role: 'button', name: /^admit all$/i },
      { kind: 'role', role: 'button', name: /^admit$/i },
      { kind: 'css', value: 'button[aria-label*="Admit" i]' },
    ],
  },

  admissionRequest: {
    description: 'someone is in the lobby',
    strategies: [
      { kind: 'text', value: /(is|are) waiting in the lobby/i },
      { kind: 'text', value: /\d+ (person|people) (is|are) waiting/i },
      { kind: 'text', value: /waiting in lobby/i },
      { kind: 'css', value: '[data-tid="lobby-section"]' },
    ],
  },

  presentButton: {
    description: 'share content button',
    strategies: [
      { kind: 'css', value: '[data-tid="share-button"], #share-button' },
      { kind: 'role', role: 'button', name: /^(share|share content|share screen)$/i },
      { kind: 'label', value: 'share content' },
    ],
  },

  presentTabOption: {
    description: 'share a tab or screen option',
    strategies: [
      { kind: 'css', value: '[data-tid="share-screen-option"], [data-tid="desktop-share"]' },
      { kind: 'role', role: 'button', name: /(browser tab|chrome tab|screen #?1|entire screen)/i },
      { kind: 'text', value: /^(browser tab|chrome tab)$/i },
    ],
  },

  stopSharing: {
    description: 'stop sharing control',
    strategies: [
      { kind: 'css', value: '[data-tid="stop-sharing-button"], [data-tid="stopsharing-button"]' },
      { kind: 'role', role: 'button', name: /stop (sharing|presenting)/i },
      { kind: 'text', value: /you.re sharing/i },
    ],
  },

  openChat: {
    description: 'chat panel button',
    strategies: [
      { kind: 'css', value: '[data-tid="chat-button"]' },
      { kind: 'css', value: '#chat-button' },
      { kind: 'role', role: 'button', name: /^(chat|show conversation|meeting chat)$/i },
      { kind: 'label', value: 'conversation' },
    ],
  },

  chatInput: {
    description: 'chat message box',
    strategies: [
      { kind: 'css', value: '[data-tid="ckeditor"]' },
      { kind: 'css', value: 'div[role="textbox"][contenteditable="true"]' },
      { kind: 'css', value: 'div[contenteditable="true"][aria-label*="message" i]' },
      { kind: 'role', role: 'textbox', name: /type a (new )?message/i },
    ],
  },

  meetingEnded: {
    description: 'meeting ended notice',
    strategies: [
      { kind: 'text', value: /(the meeting|the call) (has )?ended/i },
      { kind: 'text', value: /you (have been|were) removed from (the|this) meeting/i },
      { kind: 'text', value: /thanks for joining/i },
      { kind: 'role', role: 'button', name: /^rejoin$/i },
    ],
  },

  signInWall: {
    description: 'sign-in requirement',
    strategies: [
      { kind: 'text', value: /sign in (to join|to continue)/i },
      { kind: 'text', value: /this meeting (requires|is only for) (a sign|signed)/i },
      { kind: 'text', value: /only people in (this|the) organi[sz]ation can join/i },
      { kind: 'css', value: 'input[type="email"][name="loginfmt"]' },
    ],
  },

  meetingUnavailable: {
    description: 'meeting unavailable notice',
    strategies: [
      { kind: 'text', value: /(this meeting|that link) (is no longer valid|has expired|couldn.t be found)/i },
      { kind: 'text', value: /we couldn.t (find|connect you to) (the|this) meeting/i },
      { kind: 'text', value: /the meeting (link|code) (is|was) invalid/i },
    ],
  },
} satisfies Record<string, SelectorGroup>;

export const teamsDriver: PlatformDriver = {
  platform: 'MS_TEAMS',
  label: 'Microsoft Teams',
  requiresSignIn: false,

  matches: (input) => /(^|\/\/)teams\.(microsoft|live)\.com\//i.test(input.trim()),

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
    if (!/^teams\.(microsoft|live)\.com$/.test(host)) {
      throw new BotError('INVALID_MEETING_URL', `host ${host}`);
    }

    // Two shapes: the long `l/meetup-join/19:meeting_…@thread.v2/0?context=…`
    // for tenant meetings, and the short `meet/<id>` for personal accounts.
    const path = url.pathname;
    const meetupId = path.match(/l\/meetup-join\/([^/]+)/i)?.[1];
    const shortId = path.match(/\/meet\/(\d+)/i)?.[1];

    if (!meetupId && !shortId) {
      throw new BotError(
        'INVALID_MEETING_URL',
        `path "${path}"`,
        'That is not a Microsoft Teams meeting link. Use the full "Join the meeting now" link from the invitation.',
      );
    }

    // Kept whole and unmodified. `context` carries the tenant and organiser, and
    // a link without it does not resolve to a meeting.
    const canonical = url.toString();

    return {
      platform: 'MS_TEAMS',
      displayUrl: canonical,
      joinUrl: canonical,
      id: shortId ?? decodeURIComponent(meetupId!).slice(0, 60),
      passcode: url.searchParams.get('p') ?? undefined,
    };
  },

  async join(page, opts) {
    assertNotAborted(opts.signal);
    opts.onProgress('OPENING_MEETING', 'Opening the Teams meeting');

    try {
      await page.goto(opts.link.joinUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (err) {
      throw new BotError('MEETING_PAGE_TIMEOUT', (err as Error).message);
    }

    await page.waitForTimeout(3_000);
    await clickFirst(page, SELECTORS.dismissDialog, { timeoutMs: 3_000 });

    // The launcher page. Its "continue on this browser" option is the only one
    // that leads anywhere the bot can drive. Consumer Teams (teams.live.com)
    // then asks how to identify you, where the guest path is the candidate's
    // path too. Both screens are optional and either may be skipped.
    if (await clickFirst(page, SELECTORS.continueInBrowser, { timeoutMs: 15_000 })) {
      await page.waitForTimeout(5_000);
      await clickFirst(page, SELECTORS.dismissDialog, { timeoutMs: 2_000 });
    }

    if (await clickFirst(page, SELECTORS.guestOption, { timeoutMs: 6_000 })) {
      await page.waitForTimeout(4_000);
    }

    await assertTeamsJoinable(page);

    assertNotAborted(opts.signal);
    opts.onProgress('PRE_JOIN', 'Setting up camera and microphone');

    // Teams renders pre-join inside an iframe and is the slowest of the three
    // to get there. The name box is the landmark that says the screen is ready;
    // a signed-in account skips it, in which case the join button is.
    const ready = await waitForPreJoin(page, opts.displayName);

    if (!ready) {
      // Say why, if the page says why. "The join screen never appeared" is true
      // but useless when the real answer is on screen in plain English.
      await assertTeamsJoinable(page);
      throw new BotError(
        'PRE_JOIN_NOT_FOUND',
        `no Teams pre-join screen at ${page.url()} — see the saved screenshot for what was on the page`,
      );
    }

    // Neither is worth failing the interview over: a machine with no webcam
    // offers no readable camera state, and a microphone that reads wrong here
    // is set again below once the in-call controls exist. What actually matters
    // is verified in-call by the audio bridge.
    if (!(await setToggle(page, SELECTORS.cameraToggle, true, readTeamsMuted))) {
      console.warn('[meet-bot] could not confirm the Teams camera is off — continuing');
    }
    if (!(await setToggle(page, SELECTORS.microphoneToggle, false, readTeamsMuted))) {
      console.warn('[meet-bot] could not confirm the Teams microphone is on — will retry in the call');
    }

    assertNotAborted(opts.signal);

    const joinButton = await findFirst(page, SELECTORS.joinButton, { timeoutMs: 15_000 });
    if (!joinButton) throw new BotError('JOIN_CONTROL_NOT_FOUND', `no Teams join control on ${page.url()}`);
    if (!(await clickLocator(joinButton))) {
      throw new BotError('JOIN_CONTROL_NOT_FOUND', 'the Teams join control could not be clicked');
    }

    opts.onProgress('PRE_JOIN', 'Joining the meeting');
    await waitUntilAdmitted(page, opts);

    // Teams can join muted regardless of the pre-join state.
    await setToggle(page, SELECTORS.microphoneToggle, false, readTeamsMuted).catch(() => false);

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

        for (const el of Array.from(document.querySelectorAll('[aria-label], [title]'))) {
          const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`;
          if (!/(people|participant)/i.test(label)) continue;
          const match = label.match(/(\d+)/);
          if (match) counts.push(Number(match[1]));
        }

        const roster = document.querySelectorAll(
          '[data-tid="roster-participant"], [data-tid^="participant-"], [data-tid="calling-roster-tree-item"]',
        );
        if (roster.length) counts.push(roster.length);

        const tiles = document.querySelectorAll('[data-tid="video-tile"], [data-stream-type]');
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

    // Teams lists the lobby inside the People panel.
    if (admitted === 0 && (await isPresent(page, SELECTORS.admissionRequest))) {
      await clickFirst(page, SELECTORS.peopleButton, { timeoutMs: 2_000 });
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
    await page.waitForTimeout(1_500);
  },
};

// ---------------------------------------------------------------------------

/**
 * Teams toggles are checkboxes as often as buttons, so `aria-checked` is the
 * primary signal — and it reads the opposite way round from the others here:
 * a camera checkbox that is checked is a camera that is on.
 */
const readTeamsMuted = (locator: Locator): Promise<boolean | null> =>
  locator
    .evaluate((el) => {
      const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
      if (checked === 'true') return false;
      if (checked === 'false') return true;

      const text = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`.toLowerCase();
      // The label names the action, so "turn off" only appears while it is on.
      if (/\b(turn off|mute)\b/.test(text)) return false;
      if (/\b(turn on|unmute)\b/.test(text)) return true;

      return null;
    })
    .catch(() => null);

/**
 * Waits for the pre-join screen and fills in the display name.
 *
 * Polls rather than waiting once on each selector, because Teams renders the
 * launcher, the guest prompt and the pre-join screen into the same document in
 * sequence — a single long wait on the name box would sit through a guest
 * prompt that needed clicking.
 */
async function waitForPreJoin(page: Page, displayName: string): Promise<boolean> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (await fillFirst(page, SELECTORS.nameInput, displayName, { timeoutMs: 0 })) return true;
    // Signed-in accounts get no name field, only the button.
    if (await isPresent(page, SELECTORS.joinButton)) return true;

    // Either screen can still be in the way, and both are safe to re-click.
    await clickFirst(page, SELECTORS.continueInBrowser, { timeoutMs: 0 });
    await clickFirst(page, SELECTORS.guestOption, { timeoutMs: 0 });
    await clickFirst(page, SELECTORS.dismissDialog, { timeoutMs: 0 });

    await page.waitForTimeout(1_500);
  }

  return false;
}

async function assertTeamsJoinable(page: Page): Promise<void> {
  if (await isPresent(page, SELECTORS.signInWall)) {
    throw new BotError(
      'GUEST_JOIN_BLOCKED',
      await readNotice(page, SELECTORS.signInWall),
      'This Teams meeting does not allow anonymous guests. Either enable anonymous join for the meeting, or sign the bot in with `npm run bot:login teams`.',
    );
  }

  if (await isPresent(page, SELECTORS.meetingUnavailable)) {
    throw new BotError('INVALID_MEETING_URL', await readNotice(page, SELECTORS.meetingUnavailable));
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

    if (!announced && (await isPresent(page, SELECTORS.lobby))) {
      announced = true;
      opts.onProgress('WAITING_FOR_ADMISSION', 'Waiting in the Teams lobby');
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
