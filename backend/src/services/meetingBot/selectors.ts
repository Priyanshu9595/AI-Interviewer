import type { Frame, Locator, Page } from 'playwright';

/**
 * The selector engine every platform driver is built on.
 *
 * Google Meet, Zoom and Teams all ship UI changes continuously and all three
 * generate their CSS class names, so a class-based selector is broken by the
 * next deploy. Each control is therefore described as an ordered list of
 * *strategies* — accessible role and name first, then stable data attributes,
 * then aria-label substrings, then visible text — and the first one that
 * resolves to a visible element wins.
 *
 * The per-platform groups live in `platforms/`. When a platform changes, add a
 * new strategy to the front of the relevant group; nothing else needs to know.
 */

export type SelectorSpec =
  /** Accessible role plus accessible name. Survives almost every redesign. */
  | { kind: 'role'; role: RoleName; name: string | RegExp; exact?: boolean }
  /** Substring match on aria-label, for controls whose name carries a shortcut. */
  | { kind: 'label'; value: string }
  /** Raw CSS. Only for genuinely stable attributes such as `data-*` hooks. */
  | { kind: 'css'; value: string }
  /** Visible text, as a last resort. */
  | { kind: 'text'; value: string | RegExp };

export type RoleName =
  | 'button'
  | 'textbox'
  | 'dialog'
  | 'heading'
  | 'link'
  | 'list'
  | 'listitem'
  | 'checkbox'
  | 'menuitem'
  | 'tab';

export interface SelectorGroup {
  /** Used in logs and error messages, so keep it readable. */
  description: string;
  strategies: SelectorSpec[];
}

function build(scope: Page | Frame, spec: SelectorSpec): Locator {
  switch (spec.kind) {
    case 'role':
      return scope.getByRole(spec.role, { name: spec.name, exact: spec.exact });
    case 'label':
      // Case-insensitive substring: platforms append keyboard shortcuts to the
      // accessible name, as in "Turn off microphone (ctrl + d)".
      return scope.locator(`[aria-label*="${spec.value}" i]`);
    case 'css':
      return scope.locator(spec.value);
    case 'text':
      return scope.getByText(spec.value);
  }
}

/**
 * Every frame, not just the top one.
 *
 * Teams renders its whole pre-join experience in an iframe, and Meet
 * occasionally moves a dialog into a child frame. Searching all of them costs
 * one extra pass and removes a whole class of intermittent "button not found"
 * failures.
 */
function scopes(page: Page): Array<Page | Frame> {
  return [page, ...page.frames().filter((f) => f !== page.mainFrame())];
}

export interface FindOptions {
  /** How long to keep retrying before giving up. */
  timeoutMs?: number;
  /** Poll interval; these UIs animate controls in, so re-checking is necessary. */
  pollMs?: number;
}

/**
 * Returns the first visible element matching any strategy in the group, or null
 * once the timeout expires.
 *
 * Deliberately returns null rather than throwing: most groups are optional —
 * a dialog that may not appear, a notice that may never show — and callers that
 * do require an element raise a BotError with their own wording.
 */
export async function findFirst(
  page: Page,
  group: SelectorGroup,
  opts: FindOptions = {},
): Promise<Locator | null> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 350;
  const deadline = Date.now() + timeoutMs;

  do {
    if (page.isClosed()) return null;

    for (const scope of scopes(page)) {
      for (const spec of group.strategies) {
        try {
          const locator = build(scope, spec).first();
          if (await locator.isVisible({ timeout: 250 })) return locator;
        } catch {
          // A detached frame, or a selector that does not apply to this page
          // shape. Both are expected while the UI is still rendering.
        }
      }
    }

    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(pollMs);
  } while (Date.now() < deadline);

  return null;
}

/** Cheap presence check with no waiting, for polling loops. */
export async function isPresent(page: Page, group: SelectorGroup): Promise<boolean> {
  return (await findFirst(page, group, { timeoutMs: 0 })) !== null;
}

/**
 * Clicks the first match, falling back to a DOM-level click.
 *
 * All three platforms overlay invisible hit targets over their controls, which
 * makes Playwright's actionability checks fail on a button a person could click
 * perfectly well. The fallback dispatches the event directly on the element.
 */
export async function clickFirst(page: Page, group: SelectorGroup, opts: FindOptions = {}): Promise<boolean> {
  const locator = await findFirst(page, group, opts);
  if (!locator) return false;
  return clickLocator(locator);
}

export async function clickLocator(locator: Locator): Promise<boolean> {
  try {
    await locator.click({ timeout: 5_000 });
    return true;
  } catch {
    try {
      await locator.evaluate((el) => (el as HTMLElement).click());
      return true;
    } catch {
      return false;
    }
  }
}

/** Types into the first match, clearing whatever was there. */
export async function fillFirst(
  page: Page,
  group: SelectorGroup,
  value: string,
  opts: FindOptions = {},
): Promise<boolean> {
  const locator = await findFirst(page, group, opts);
  if (!locator) return false;

  try {
    await locator.fill(value, { timeout: 5_000 });
    return true;
  } catch {
    try {
      await locator.click({ timeout: 2_000 });
      await locator.press('Control+A');
      await locator.type(value, { delay: 20 });
      return true;
    } catch {
      return false;
    }
  }
}

/** The visible text of a notice, for the recruiter-facing error message. */
export async function readNotice(page: Page, group: SelectorGroup): Promise<string> {
  const locator = await findFirst(page, group, { timeoutMs: 0 });
  if (!locator) return '';

  const text = await locator.textContent().catch(() => '');
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Drives a device toggle to a known state.
 *
 * The hazard this exists to avoid is clicking blind: a toggle whose state is
 * unread is as likely to turn the camera *on* as off. `readState` is supplied
 * by the platform because each one advertises muting differently — Meet has
 * `data-is-muted`, Teams flips its aria-label, Zoom changes the button's text.
 *
 * Returns false when the state could not be established, leaving it to the
 * caller to decide whether that is fatal. A camera that might be on is
 * embarrassing; a microphone that might be off ends the interview.
 */
export async function setToggle(
  page: Page,
  group: SelectorGroup,
  desiredMuted: boolean,
  readState: (locator: Locator) => Promise<boolean | null>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const toggle = await findFirst(page, group, { timeoutMs: attempt === 0 ? 10_000 : 3_000 });
    if (!toggle) return false;

    const current = await readState(toggle);

    // Unknown state, with attempts left: the control may still be initialising.
    if (current === null && attempt < 2) {
      await page.waitForTimeout(700);
      continue;
    }
    if (current === desiredMuted) return true;
    if (current === null) return false;

    await clickLocator(toggle);
    await page.waitForTimeout(700);

    if ((await readState(toggle)) === desiredMuted) return true;
  }

  return false;
}

/**
 * Opens the chat panel and posts one line.
 *
 * Shared by all three drivers because the shape is identical everywhere: press
 * the chat button, find the box, type, press Enter. Only the selectors differ.
 * Returns false rather than throwing — a chat panel that has moved must not
 * take an interview down with it.
 */
export async function postChatMessage(
  page: Page,
  groups: { openChat: SelectorGroup; chatInput: SelectorGroup; sendButton?: SelectorGroup },
  text: string,
): Promise<boolean> {
  try {
    // The panel may already be open, in which case the button toggles it shut.
    let input = await findFirst(page, groups.chatInput, { timeoutMs: 1_000 });

    if (!input) {
      // Every one of these clients fades its control bar out after a few
      // seconds of stillness, and a faded button is not a visible one. A bot
      // never moves its mouse, so the bar is always hidden by the time it wants
      // to click something — which is why chat posting silently failed.
      await wakeControls(page);

      if (!(await clickFirst(page, groups.openChat, { timeoutMs: 5_000 }))) return false;
      await page.waitForTimeout(1_500);
      input = await findFirst(page, groups.chatInput, { timeoutMs: 6_000 });
    }

    if (!input) return false;

    await input.click({ timeout: 3_000 }).catch(() => {});
    // Typed rather than filled: these boxes are rich-text editors that ignore a
    // value set directly and only react to real key events.
    await input.type(text, { delay: 10 });
    await page.waitForTimeout(300);

    if (groups.sendButton && (await clickFirst(page, groups.sendButton, { timeoutMs: 1_500 }))) {
      return true;
    }

    await input.press('Enter');
    await page.waitForTimeout(500);
    return true;
  } catch {
    return false;
  }
}

/**
 * Brings the auto-hiding control bar back on screen.
 *
 * Meet, Zoom and Teams all fade their controls out after a few seconds without
 * pointer movement. A bot never moves its pointer, so by the time it wants to
 * open the chat or start sharing, every one of those buttons is present in the
 * DOM but invisible — and an invisible element is one `findFirst` will not
 * return, by design.
 *
 * Moving the mouse across the viewport is what a person does without thinking.
 */
export async function wakeControls(page: Page): Promise<void> {
  try {
    const size = page.viewportSize() ?? { width: 1280, height: 800 };
    // Two moves: some clients only react to an actual change in position.
    await page.mouse.move(size.width / 2, size.height / 2);
    await page.mouse.move(size.width / 2, size.height - 40, { steps: 8 });
    await page.waitForTimeout(600);
  } catch {
    // A closed page. The caller's own failure is the one worth reporting.
  }
}

/**
 * Clicks every visible Admit control, returning how many were pressed.
 *
 * Deliberately clicks repeatedly rather than once: several people can be
 * waiting, and each admission re-renders the list. Bounded so a control that
 * refuses to go away cannot spin forever.
 *
 * Only ever clicks Admit. Deny is never in any of these groups, because a bot
 * that could refuse someone entry is a bot that will eventually refuse the
 * wrong person.
 */
export async function admitAllWaiting(page: Page, group: SelectorGroup): Promise<number> {
  let admitted = 0;

  for (let i = 0; i < 5; i++) {
    const button = await findFirst(page, group, { timeoutMs: 0 });
    if (!button) break;

    if (!(await clickLocator(button))) break;
    admitted++;

    // Give the list a moment to settle before looking for the next one.
    await page.waitForTimeout(800);
  }

  return admitted;
}

/**
 * Walks a "share my screen" flow: press Present, then pick the tab option.
 *
 * The native picker that follows is not reachable from here — it belongs to the
 * browser, not the page — so Chromium is told which tab to choose in advance,
 * with `--auto-select-tab-capture-source-by-title`. All this has to do is get
 * the picker to open.
 *
 * Success is judged by the stop-sharing control appearing, because the menus
 * happily accept clicks that lead nowhere.
 */
export async function startPresenting(
  page: Page,
  groups: { presentButton: SelectorGroup; tabOption: SelectorGroup; stopSharing: SelectorGroup },
): Promise<boolean> {
  if (await isPresent(page, groups.stopSharing)) return true; // already sharing

  // Same auto-hiding control bar as the chat button.
  await wakeControls(page);

  if (!(await clickFirst(page, groups.presentButton, { timeoutMs: 6_000 }))) return false;
  await page.waitForTimeout(1_200);

  // Some clients go straight to the picker; others offer screen/window/tab first.
  await clickFirst(page, groups.tabOption, { timeoutMs: 4_000 });

  // The picker resolves itself via the flag, but takes a moment to do it.
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1_000);
    if (await isPresent(page, groups.stopSharing)) return true;
  }

  return false;
}

export async function stopPresenting(page: Page, stopSharing: SelectorGroup): Promise<void> {
  await clickFirst(page, stopSharing, { timeoutMs: 3_000 }).catch(() => false);
  await page.waitForTimeout(800);
}

/**
 * Reads a muted state from the conventions these web clients share.
 *
 * `data-is-muted` when present, otherwise the accessible name: a control
 * labelled "Turn off microphone" only says that while the microphone is on.
 * Platforms with their own vocabulary pass their own reader to `setToggle`.
 */
export const readAriaMuted = (locator: Locator): Promise<boolean | null> =>
  locator
    .evaluate((el) => {
      const holder =
        (el as HTMLElement).closest('[data-is-muted]') ??
        (el as HTMLElement).querySelector('[data-is-muted]') ??
        el;

      const attr = holder.getAttribute?.('data-is-muted');
      if (attr === 'true') return true;
      if (attr === 'false') return false;

      const label = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').toLowerCase();
      if (/\b(turn off|stop|mute|disable)\b/.test(label)) return false;
      if (/\b(turn on|start|unmute|enable)\b/.test(label)) return true;

      // Toggle buttons usually expose their state as well as their action.
      const pressed = el.getAttribute('aria-pressed');
      if (pressed === 'true') return false;
      if (pressed === 'false') return true;

      const checked = el.getAttribute('aria-checked');
      if (checked === 'true') return false;
      if (checked === 'false') return true;

      return null;
    })
    .catch(() => null);
