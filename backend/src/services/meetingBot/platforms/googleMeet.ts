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
  readAriaMuted,
  wakeControls,
  readNotice,
  setToggle,
  startPresenting,
  stopPresenting as stopSharingScreen,
  type SelectorGroup,
} from '../selectors';
import { assertNotAborted, type MeetingObservation, type PlatformDriver, type PlatformJoinOptions } from './types';

/**
 * Google Meet.
 *
 * Meet is the strictest of the three about who may join: an anonymous
 * participant is refused by many meetings outright, so this driver expects a
 * signed-in bot profile. It still handles the guest name field, because a
 * meeting configured to allow guests will show one.
 */

/** Meeting codes are three letters, four letters, three letters. */
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

const SELECTORS = {
  dismissDialog: {
    description: 'dismissable pre-join dialog',
    strategies: [
      { kind: 'role', role: 'button', name: /^(got it|dismiss|ok|continue|no thanks)$/i },
      { kind: 'role', role: 'button', name: /^(accept all|reject all|i agree)$/i },
    ],
  },

  /**
   * The guest name box, shown whenever Meet does not recognise the account.
   *
   * Filling this is not optional: "Ask to join" stays disabled while it is
   * empty, so a bot that cannot find this field cannot enter the meeting at
   * all, no matter what else works.
   *
   * Meet renders it with a floating Material label rather than a `placeholder`
   * attribute, so matching on placeholder text — which is what this used to
   * do — matches nothing. The last strategy is a deliberate catch-all: on the
   * pre-join screen there is only one text box.
   */
  nameInput: {
    description: 'guest name field',
    strategies: [
      { kind: 'role', role: 'textbox', name: /your name/i },
      { kind: 'css', value: 'input[aria-label*="Your name" i]' },
      { kind: 'css', value: 'input[placeholder*="Your name" i]' },
      { kind: 'css', value: 'input[jsname="YPqjbf"]' },
      { kind: 'css', value: 'input[type="text"][maxlength="60"]' },
      { kind: 'css', value: 'input[type="text"]:not([type="search"])' },
    ],
  },

  /**
   * `data-is-muted` is the one attribute Meet has kept stable for years, and
   * reading it is how the bot knows whether a click is needed at all — clicking
   * blind would turn the camera back *on* half the time.
   */
  cameraToggle: {
    description: 'camera toggle',
    strategies: [
      { kind: 'css', value: '[role="button"][data-is-muted][aria-label*="camera" i]' },
      { kind: 'css', value: 'div[jsname="BOHaEe"]' },
      { kind: 'label', value: 'camera' },
      { kind: 'role', role: 'button', name: /turn (off|on) camera/i },
    ],
  },

  microphoneToggle: {
    description: 'microphone toggle',
    strategies: [
      { kind: 'css', value: '[role="button"][data-is-muted][aria-label*="microphone" i]' },
      { kind: 'css', value: 'div[jsname="hw0c9"]' },
      { kind: 'label', value: 'microphone' },
      { kind: 'role', role: 'button', name: /turn (off|on) (microphone|mic)/i },
    ],
  },

  /** "Join now" and "Ask to join" both mean go, so both live in one group. */
  joinButton: {
    description: 'join control',
    strategies: [
      { kind: 'role', role: 'button', name: /^join now$/i },
      { kind: 'role', role: 'button', name: /^ask to join$/i },
      { kind: 'role', role: 'button', name: /^(join anyway|switch here|join)$/i },
      { kind: 'text', value: /^(join now|ask to join|join anyway)$/i },
    ],
  },

  waitingForAdmission: {
    description: 'waiting-for-admission notice',
    strategies: [
      { kind: 'text', value: /asking to be let in/i },
      { kind: 'text', value: /you.ll join.*when someone lets you in/i },
      { kind: 'text', value: /waiting for someone to let you in/i },
      { kind: 'text', value: /someone will let you in soon/i },
    ],
  },

  admissionDenied: {
    description: 'admission refused notice',
    strategies: [
      { kind: 'text', value: /(you can.t join this|no one responded to your request)/i },
      { kind: 'text', value: /(your request to join was denied|someone declined your request)/i },
    ],
  },

  /** The leave button only exists in-call, so its presence is proof of joining. */
  inCall: {
    description: 'in-call controls',
    strategies: [
      { kind: 'role', role: 'button', name: /leave call/i },
      { kind: 'css', value: '[aria-label*="Leave call" i]' },
      { kind: 'css', value: 'button[jsname="CQylAd"]' },
      { kind: 'css', value: '[data-meeting-code]' },
    ],
  },

  leaveButton: {
    description: 'leave call button',
    strategies: [
      { kind: 'role', role: 'button', name: /leave call/i },
      { kind: 'css', value: '[aria-label*="Leave call" i]' },
      { kind: 'css', value: 'button[jsname="CQylAd"]' },
    ],
  },

  /**
   * Letting someone in. Meet shows this as a notification card ("… wants to
   * join this call") and again in the People panel, so both are matched.
   *
   * Admit only — Deny is deliberately absent from this group.
   */
  admitButton: {
    description: 'admit waiting participant',
    strategies: [
      { kind: 'role', role: 'button', name: /^admit all$/i },
      { kind: 'role', role: 'button', name: /^admit$/i },
      { kind: 'role', role: 'button', name: /^let in$/i },
      { kind: 'css', value: 'button[aria-label*="Admit" i]:not([aria-label*="Deny" i])' },
      { kind: 'css', value: 'button[aria-label*="Let in" i]' },
      { kind: 'css', value: '[role="button"][aria-label^="Admit" i]' },
      { kind: 'text', value: /^(admit|admit all|let in)$/i },
    ],
  },

  peopleButton: {
    description: 'participants panel button',
    strategies: [
      { kind: 'role', role: 'button', name: /^(people|participants)$/i },
      { kind: 'css', value: '[aria-label*="people" i][role="button"]' },
      { kind: 'css', value: '[aria-label*="participant" i][role="button"]' },
    ],
  },

  /** Someone is knocking. Used to log it and to open the panel if needed. */
  admissionRequest: {
    description: 'someone is waiting to join',
    strategies: [
      { kind: 'text', value: /wants to join this call/i },
      { kind: 'text', value: /(people are waiting|waiting to join)/i },
      { kind: 'text', value: /\d+ (person|people) waiting/i },
    ],
  },

  presentButton: {
    description: 'present now button',
    strategies: [
      { kind: 'role', role: 'button', name: /present now/i },
      { kind: 'css', value: '[aria-label*="Present now" i]' },
      { kind: 'role', role: 'button', name: /^(share screen|share your screen)$/i },
    ],
  },

  presentTabOption: {
    description: 'share a tab option',
    strategies: [
      { kind: 'role', role: 'menuitem', name: /a (chrome )?tab/i },
      { kind: 'role', role: 'button', name: /a (chrome )?tab/i },
      { kind: 'text', value: /^a (chrome )?tab$/i },
    ],
  },

  stopSharing: {
    description: 'stop presenting control',
    strategies: [
      { kind: 'role', role: 'button', name: /stop (presenting|sharing)/i },
      { kind: 'css', value: '[aria-label*="Stop presenting" i], [aria-label*="Stop sharing" i]' },
      { kind: 'text', value: /you are presenting/i },
    ],
  },

  openChat: {
    description: 'chat panel button',
    strategies: [
      { kind: 'role', role: 'button', name: /chat with everyone/i },
      { kind: 'css', value: '[aria-label*="Chat with everyone" i]' },
      { kind: 'role', role: 'button', name: /^(chat|messages)$/i },
    ],
  },

  chatInput: {
    description: 'chat message box',
    strategies: [
      { kind: 'css', value: 'textarea[aria-label*="Send a message" i]' },
      { kind: 'css', value: 'textarea[placeholder*="Send a message" i]' },
      { kind: 'role', role: 'textbox', name: /send a message/i },
      { kind: 'css', value: 'div[contenteditable="true"][aria-label*="message" i]' },
    ],
  },

  chatSend: {
    description: 'chat send button',
    strategies: [
      { kind: 'role', role: 'button', name: /send (a )?message/i },
      { kind: 'css', value: 'button[aria-label*="Send a message" i]' },
    ],
  },

  meetingEnded: {
    description: 'meeting ended notice',
    strategies: [
      { kind: 'text', value: /you.ve been removed from the meeting/i },
      { kind: 'text', value: /(the meeting|your host) (has )?ended (the (call|meeting))?/i },
      { kind: 'text', value: /you left the meeting/i },
      { kind: 'role', role: 'button', name: /(return to home screen|rejoin)/i },
    ],
  },

  meetingUnavailable: {
    description: 'meeting unavailable notice',
    strategies: [
      { kind: 'text', value: /check your meeting code/i },
      { kind: 'text', value: /(this meeting|the meeting) (code )?(is invalid|does.?n.t exist|has not started)/i },
      { kind: 'text', value: /you can.t (create|join) a meeting/i },
      { kind: 'text', value: /couldn.t join the (video )?call/i },
    ],
  },

  signInWall: {
    description: 'Google sign-in wall',
    strategies: [
      { kind: 'css', value: 'input[type="email"][name="identifier"]' },
      { kind: 'css', value: 'input[type="password"][name="Passwd"]' },
    ],
  },

  securityChallenge: {
    description: 'Google security challenge',
    strategies: [
      { kind: 'text', value: /verify it.s you/i },
      { kind: 'text', value: /2-step verification/i },
      { kind: 'text', value: /unusual activity/i },
      { kind: 'css', value: 'iframe[src*="recaptcha"]' },
      { kind: 'css', value: '#captchaimg' },
    ],
  },
} satisfies Record<string, SelectorGroup>;

export const googleMeetDriver: PlatformDriver = {
  platform: 'GOOGLE_MEET',
  label: 'Google Meet',
  requiresSignIn: true,

  matches: (input) => /(^|\/\/)meet\.google\.com\//i.test(input.trim()),

  parse(input): ParsedMeetingLink {
    const trimmed = (input ?? '').trim();
    if (!trimmed) throw new BotError('INVALID_MEETING_URL', 'empty link');

    let url: URL;
    try {
      url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    } catch {
      throw new BotError('INVALID_MEETING_URL', trimmed);
    }

    if (url.hostname.toLowerCase() !== 'meet.google.com') {
      throw new BotError('INVALID_MEETING_URL', `host ${url.hostname}`);
    }

    const code = url.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
    if (!MEET_CODE.test(code)) {
      throw new BotError(
        'INVALID_MEETING_URL',
        `code "${code}"`,
        'That is not a Google Meet link. It should look like https://meet.google.com/abc-defg-hij',
      );
    }

    // Query strings on a Meet link are tracking and account hints; the meeting
    // is entirely identified by its code.
    const canonical = `https://meet.google.com/${code}`;
    return { platform: 'GOOGLE_MEET', displayUrl: canonical, joinUrl: canonical, id: code };
  },

  async join(page, opts) {
    assertNotAborted(opts.signal);
    opts.onProgress('OPENING_MEETING', 'Opening the Google Meet link');

    try {
      // `domcontentloaded` rather than `load`: Meet keeps long-lived
      // connections open, so the load event can be minutes away or never come.
      await page.goto(opts.link.joinUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (err) {
      throw new BotError('MEETING_PAGE_TIMEOUT', (err as Error).message);
    }

    await page.waitForTimeout(2_500);
    await assertNoGoogleWall(page);

    if (await isPresent(page, SELECTORS.meetingUnavailable)) {
      const notice = await readNotice(page, SELECTORS.meetingUnavailable);
      const notStarted = /not started|hasn.t started/i.test(notice);
      throw new BotError(notStarted ? 'MEETING_NOT_STARTED' : 'INVALID_MEETING_URL', notice);
    }

    const alreadyInCall = await waitForPreJoin(page);
    if (alreadyInCall) {
      opts.onProgress('JOINED', 'Already in the meeting');
      return;
    }

    assertNotAborted(opts.signal);
    opts.onProgress('PRE_JOIN', 'Setting up camera and microphone');

    await enterGuestNameIfAsked(page, opts.displayName);

    // Neither of these is worth failing the interview over. A machine with no
    // webcam reports "Camera not found" and offers no readable toggle state,
    // and a microphone that reads wrong here can be corrected once inside —
    // whereas refusing to join guarantees there is no interview at all. What
    // actually matters is verified in-call by the audio bridge.
    if (!(await setToggle(page, SELECTORS.cameraToggle, true, readAriaMuted))) {
      console.warn('[meet-bot] could not confirm the Google Meet camera is off — continuing');
    }
    if (!(await setToggle(page, SELECTORS.microphoneToggle, false, readAriaMuted))) {
      console.warn('[meet-bot] could not confirm the Google Meet microphone is on — will retry in the call');
    }

    assertNotAborted(opts.signal);
    await pressJoin(page, opts);

    // Meet can join muted regardless of the pre-join state, so the microphone
    // is set again now that the in-call controls exist.
    await setToggle(page, SELECTORS.microphoneToggle, false, readAriaMuted).catch(() => false);

    opts.onProgress('JOINED', 'In the meeting');
  },

  async observe(page): Promise<MeetingObservation> {
    const inCall = await isPresent(page, SELECTORS.inCall);

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

    if (!inCall) {
      return { inCall: false, participants: 0, waitingRoomOccupied: false, ended: true, endReason: 'ENDED' };
    }

    const waitingRoomOccupied = await isPresent(page, SELECTORS.admissionRequest);

    const participants = await page
      .evaluate(() => {
        const counts: number[] = [];

        // The participants button carries the head-count in its accessible name.
        for (const el of Array.from(document.querySelectorAll('[aria-label]'))) {
          const label = el.getAttribute('aria-label') ?? '';
          if (!/(people|participant)/i.test(label)) continue;
          const match = label.match(/(\d+)/);
          if (match) counts.push(Number(match[1]));
        }

        // Video tiles and participant rows both carry a participant id.
        const ids = new Set<string>();
        for (const el of Array.from(document.querySelectorAll('[data-participant-id]'))) {
          const id = el.getAttribute('data-participant-id');
          if (id) ids.add(id);
        }
        if (ids.size) counts.push(ids.size);

        // Meet says so in as many words, which is the one signal that is
        // reliable at a count of one.
        if (/(you.re the only one here|no one else is here)/i.test(document.body?.innerText ?? '')) counts.push(1);

        return counts.length ? Math.max(...counts) : 0;
      })
      .catch(() => 0);

    return { inCall: true, participants, waitingRoomOccupied, ended: false, endReason: null };
  },

  async admitWaiting(page) {
    // The notification card carries its own Admit button, so no panel needs
    // opening in the common case. If only the People panel shows the request,
    // opening it puts an Admit button on screen for the next pass.
    let admitted = await admitAllWaiting(page, SELECTORS.admitButton);
    if (admitted > 0) return admitted;

    // Nothing clickable on screen. Meet fades its whole interface out when the
    // pointer has not moved, and a bot's pointer never moves — so the admit
    // prompt can be sitting there, rendered but invisible, which is the one
    // state `findFirst` will not return.
    await wakeControls(page);
    admitted = await admitAllWaiting(page, SELECTORS.admitButton);
    if (admitted > 0) return admitted;

    // Still nothing. The notification may already have been dismissed, in which
    // case the request only survives in the People panel.
    if (await isPresent(page, SELECTORS.admissionRequest)) {
      await clickFirst(page, SELECTORS.peopleButton, { timeoutMs: 2_000 });
      await page.waitForTimeout(1_500);
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
    return postChatMessage(
      page,
      { openChat: SELECTORS.openChat, chatInput: SELECTORS.chatInput, sendButton: SELECTORS.chatSend },
      text,
    );
  },

  async leave(page) {
    await clickFirst(page, SELECTORS.leaveButton, { timeoutMs: 5_000 });
    await page.waitForTimeout(1_500);
  },
};

// ---------------------------------------------------------------------------

/**
 * Google never asks the bot to sign in during normal operation — the profile
 * carries a live session. When it does, something changed outside this system
 * and only a human can settle it.
 */
async function assertNoGoogleWall(page: Page): Promise<void> {
  if (await isPresent(page, SELECTORS.securityChallenge)) {
    throw new BotError(
      'VERIFICATION_REQUIRED',
      (await readNotice(page, SELECTORS.securityChallenge)) || page.url(),
      'Google asked the bot account to complete a security check. Sign in manually with `npm run bot:login google` and clear it — the bot will not attempt it.',
    );
  }

  if (page.url().includes('accounts.google.com') || (await isPresent(page, SELECTORS.signInWall))) {
    throw new BotError(
      'SIGN_IN_REQUIRED',
      page.url(),
      'The bot’s Google account is signed out. Run `npm run bot:login google` on the server to sign in again.',
    );
  }
}

/** Resolves true when Meet skipped the pre-join screen and went straight in. */
async function waitForPreJoin(page: Page): Promise<boolean> {
  // Interstitials sit on top of the pre-join controls and swallow clicks.
  await clickFirst(page, SELECTORS.dismissDialog, { timeoutMs: 3_000 });

  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (await isPresent(page, SELECTORS.inCall)) return true;
    if (await findFirst(page, SELECTORS.joinButton, { timeoutMs: 0 })) return false;

    await assertNoGoogleWall(page);

    if (await isPresent(page, SELECTORS.meetingUnavailable)) {
      throw new BotError('MEETING_NOT_STARTED', await readNotice(page, SELECTORS.meetingUnavailable));
    }

    await clickFirst(page, SELECTORS.dismissDialog, { timeoutMs: 0 });
    await page.waitForTimeout(1_000);
  }

  throw new BotError('PRE_JOIN_NOT_FOUND', `still on ${page.url()} after 60s`);
}

/**
 * Fills the guest name box, when Meet is showing one.
 *
 * A signed-in bot never sees this field and the function does nothing. A
 * signed-out one cannot proceed without it — "Ask to join" is disabled while
 * the box is empty — so unlike most of the pre-join steps this one is checked
 * rather than attempted. Failing loudly here is much kinder than clicking a
 * dead button for forty seconds and reporting that no join control was found.
 */
async function enterGuestNameIfAsked(page: Page, displayName: string): Promise<void> {
  const field = await findFirst(page, SELECTORS.nameInput, { timeoutMs: 8_000 });
  if (!field) return; // signed in — Meet already knows who this is

  console.log('[meet-bot] Google Meet is asking for a guest name — the bot account is not signed in');

  for (let attempt = 0; attempt < 3; attempt++) {
    await field.fill(displayName, { timeout: 5_000 }).catch(async () => {
      // Some builds ignore a programmatic fill on this box and only respond to
      // real key events.
      await field.click({ timeout: 3_000 }).catch(() => {});
      await field.type(displayName, { delay: 30 }).catch(() => {});
    });

    const written = await field.inputValue().catch(() => '');
    if (written.trim().length > 0) return;

    await page.waitForTimeout(700);
  }

  throw new BotError(
    'PRE_JOIN_NOT_FOUND',
    'Google Meet asked for a guest name and the field could not be filled, so the join button stays disabled',
    'Google Meet is treating the interviewer as a guest and its name box could not be filled, so it cannot ask to join. Sign the bot in with `npm run bot:login google`, or refresh GOOGLE_BOT_COOKIES.',
  );
}

/**
 * Presses Join and confirms it took.
 *
 * A single click is not enough in practice. Meet re-renders the pre-join screen
 * when a device changes state — a machine with no webcam does this on its own —
 * and the click lands on an element that is replaced a moment later, leaving the
 * bot sitting on "Ready to join?" indefinitely with no error to report. So the
 * click is repeated until the page actually changes.
 */
async function pressJoin(page: Page, opts: PlatformJoinOptions): Promise<void> {
  const attempts = 4;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await isPresent(page, SELECTORS.inCall)) return;
    assertNotAborted(opts.signal);

    const button = await findFirst(page, SELECTORS.joinButton, { timeoutMs: attempt === 1 ? 20_000 : 5_000 });

    if (!button) {
      // No button and not in the call: either we are already in the lobby
      // waiting, or the screen has moved on. Let the wait below decide.
      if (attempt === 1) throw new BotError('JOIN_CONTROL_NOT_FOUND', `no join control on ${page.url()}`);
      break;
    }

    // A disabled join button is Meet saying a precondition is unmet — nearly
    // always an empty guest name. Clicking it repeatedly achieves nothing, and
    // reporting "no join control was found" forty seconds later describes the
    // wrong problem entirely.
    const usable = await button.isEnabled({ timeout: 2_000 }).catch(() => true);
    if (!usable) {
      const named = await findFirst(page, SELECTORS.nameInput, { timeoutMs: 0 });
      const value = named ? await named.inputValue().catch(() => '') : '';

      throw new BotError(
        'JOIN_CONTROL_NOT_FOUND',
        `the join button is disabled (guest name is "${value}")`,
        value.trim()
          ? 'Google Meet will not let the interviewer ask to join. The meeting may not accept guests.'
          : 'Google Meet is refusing the join button because the interviewer has no name set. Sign the bot in with `npm run bot:login google`, or refresh GOOGLE_BOT_COOKIES.',
      );
    }

    // Read the label before clicking: it says whether the organiser has to let
    // the bot in, and the button is gone the moment it is pressed.
    const label = ((await button.textContent().catch(() => '')) ?? '').trim().toLowerCase();
    const clicked = await clickLocator(button);

    if (clicked) {
      opts.onProgress(
        label.includes('ask') ? 'WAITING_FOR_ADMISSION' : 'PRE_JOIN',
        label.includes('ask') ? 'Waiting for organizer approval' : 'Joining the meeting',
      );
    }

    // Long enough for the call UI to render, short enough that a swallowed
    // click is retried rather than waited out.
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1_000);
      if (await isPresent(page, SELECTORS.inCall)) return;
      if (await isPresent(page, SELECTORS.waitingForAdmission)) {
        // Knocking. Stop clicking and wait properly.
        await waitUntilAdmitted(page, opts);
        return;
      }
    }

    console.warn(`[meet-bot] join click ${attempt}/${attempts} did not take; the pre-join screen is still showing`);
  }

  await waitUntilAdmitted(page, opts);
}

/**
 * Sits in the lobby until the organiser admits the bot.
 *
 * There is nothing clever here on purpose. If a meeting requires approval, the
 * bot waits for approval; it does not try to get in another way.
 */
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

    if (!announced && (await isPresent(page, SELECTORS.waitingForAdmission))) {
      announced = true;
      opts.onProgress('WAITING_FOR_ADMISSION', 'Waiting for organizer approval');
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
