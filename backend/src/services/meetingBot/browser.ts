import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { env } from '../../lib/env';
import { BotError, toBotError } from './errors';

/**
 * Launches the Chromium the interviewer lives in.
 *
 * The bot signs in to Google exactly once, by hand, via `npm run bot:login`.
 * That leaves a Chromium user-data directory holding the account's session,
 * which every interview then reuses. Nothing here ever types a password, and
 * nothing here answers a security challenge — see docs/GOOGLE_MEET_BOT.md.
 */

export const MASTER_PROFILE_DIR = path.isAbsolute(env.GOOGLE_BOT_PROFILE_PATH)
  ? env.GOOGLE_BOT_PROFILE_PATH
  : path.resolve(process.cwd(), env.GOOGLE_BOT_PROFILE_PATH);

/**
 * The title of the tab the bot shares during a coding round.
 *
 * Chromium's screen-share picker cannot be automated — it is browser chrome,
 * outside the page — so instead it is told in advance which tab to choose, by
 * title. That makes this string load-bearing: it must match the `<title>` of
 * the spectator page in `frontend-v2/src/app/interview/[token]/code/live`
 * exactly, and must stay plain ASCII to survive the command line.
 */
export const SHARE_TAB_TITLE = 'AI Interview Candidate Code';

export interface LaunchOptions {
  /**
   * Give this run its own copy of the signed-in profile. Chromium takes an
   * exclusive lock on a user-data directory, so two interviews at once cannot
   * share one — the second would fail to start.
   */
  isolated?: boolean;
  /**
   * Whether a signed-in profile is required.
   *
   * Google Meet needs one: anonymous participants are refused by many meetings.
   * Zoom and Teams both admit named guests, so they start from whatever profile
   * exists — the signed-in one when the operator has made it, an empty one
   * otherwise — rather than refusing to run at all.
   */
  requireSignedInProfile?: boolean;
  headless?: boolean;
  /**
   * Whether the meeting's audio should be silenced at the browser level.
   *
   * True for the injected-audio path, where the bot reads remote audio straight
   * off the WebRTC tracks and playing it to a sound card would only risk an
   * echo. False for the virtual-cable path, which needs real playback.
   */
  muteOutput?: boolean;
  /**
   * Whether to hand Chromium synthetic capture devices. True when the bot
   * supplies its own microphone stream in-page; false when a real device (a
   * virtual cable) is carrying the AI's voice.
   */
  fakeDevices?: boolean;
}

export interface BotBrowser {
  context: BrowserContext;
  page: Page;
  /** Closes the browser and removes an isolated profile copy. */
  close(): Promise<void>;
  profileDir: string;
}

/**
 * Directories that make a Chromium profile large and that carry nothing we
 * need. Skipping them turns a multi-hundred-megabyte copy into a few megabytes,
 * which matters because it happens on the critical path of every interview.
 */
const DISPOSABLE = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Service Worker',
  'CacheStorage',
  'Crashpad',
  'component_crx_cache',
  'optimization_guide_model_store',
]);

/** Lock files a running Chromium leaves behind; copying them poisons the clone. */
const isLockFile = (name: string) => name.startsWith('Singleton') || name.endsWith('.lock') || name === 'lockfile';

async function cloneProfile(source: string, target: string): Promise<void> {
  await fs.cp(source, target, {
    recursive: true,
    force: true,
    // Errors on individual files (a handle still held by another Chromium) must
    // not abort the whole copy — the session lives in Cookies and Local State.
    errorOnExist: false,
    filter: (src) => {
      const name = path.basename(src);
      return !DISPOSABLE.has(name) && !isLockFile(name);
    },
  });
}

function chromiumArgs(opts: Required<Pick<LaunchOptions, 'muteOutput' | 'fakeDevices'>>): string[] {
  const args = [
    // Grant microphone and camera without a prompt. The bot still turns its
    // camera off explicitly on the pre-join screen; this only stops Chromium
    // blocking on a permission dialog no human is there to answer.
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // Meet degrades its UI when it recognises an automated browser, which
    // breaks the join controls this bot has to click.
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-infobars',
    '--disable-notifications',
    '--disable-popup-blocking',
    '--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
    '--window-size=1280,800',
    // Screen sharing opens a native picker that Playwright cannot reach — it is
    // browser chrome, not page content. These name the tab to choose in
    // advance, so the picker resolves itself. Both spellings are passed because
    // which one applies has moved between Chromium versions.
    `--auto-select-tab-capture-source-by-title=${SHARE_TAB_TITLE}`,
    `--auto-select-desktop-capture-source=${SHARE_TAB_TITLE}`,
  ];

  if (opts.muteOutput) {
    // Remote audio still flows through WebRTC and Web Audio; only the speakers
    // go quiet. Without this the meeting can be heard on the server's sound
    // card and, worse, fed back into the bot's own microphone.
    args.push('--mute-audio');
  }

  if (opts.fakeDevices) {
    // Meet checks that at least one input device exists before it will let the
    // bot join. The bot replaces the stream in-page, so the fake device's
    // contents are never used — only its existence.
    args.push('--use-fake-device-for-media-stream');
  }

  return args;
}

/**
 * Opens the bot's browser.
 *
 * Real Chrome is preferred because Meet treats it as a first-class client;
 * Playwright's bundled Chromium works but is likelier to be nudged towards the
 * "your browser is not supported" path. If the configured channel is missing,
 * the launch falls back rather than failing the interview outright.
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<BotBrowser> {
  const isolated = opts.isolated ?? true;
  const headless = opts.headless ?? env.MEET_BOT_HEADLESS;
  const muteOutput = opts.muteOutput ?? env.MEET_BOT_TTS !== 'webspeech';
  const fakeDevices = opts.fakeDevices ?? env.MEET_BOT_TTS !== 'webspeech';

  const signedIn = await hasSignedInProfile();

  if (opts.requireSignedInProfile && !signedIn) {
    throw new BotError(
      'SIGN_IN_REQUIRED',
      `no signed-in bot profile at ${MASTER_PROFILE_DIR}`,
      'The bot has never been signed in to Google. Run `npm run bot:login google` on the server first.',
    );
  }

  let profileDir = MASTER_PROFILE_DIR;
  let temporary = false;

  if (isolated) {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meet-bot-'));
    temporary = true;

    if (signedIn) {
      try {
        await cloneProfile(MASTER_PROFILE_DIR, profileDir);
      } catch (err) {
        await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
        throw new BotError(
          'BROWSER_LAUNCH_FAILED',
          `could not copy the bot profile: ${(err as Error).message}`,
        );
      }
    }
    // Without a signed-in profile the temporary directory is left empty, which
    // is exactly what a guest join wants: a clean browser with no identity.
  } else if (!signedIn) {
    await fs.mkdir(MASTER_PROFILE_DIR, { recursive: true });
  }

  const args = chromiumArgs({ muteOutput, fakeDevices });
  const launchOptions = {
    headless,
    args,
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--enable-automation'],
    permissions: ['microphone', 'camera'],
    // Meet will not start a call without one, and the value affects which
    // greeting and controls it renders.
    locale: 'en-US',
    timezoneId: process.env.TZ || 'UTC',
  };

  const channels: Array<string | undefined> =
    env.MEET_BOT_BROWSER_CHANNEL === 'chromium'
      ? [undefined]
      : [env.MEET_BOT_BROWSER_CHANNEL, undefined];

  let context: BrowserContext | null = null;
  let lastError: unknown = null;

  for (const channel of channels) {
    try {
      context = await chromium.launchPersistentContext(profileDir, { ...launchOptions, channel });
      if (channel === undefined && env.MEET_BOT_BROWSER_CHANNEL !== 'chromium') {
        console.warn(
          `[meet-bot] ${env.MEET_BOT_BROWSER_CHANNEL} is not installed; using Playwright's bundled Chromium instead`,
        );
      }
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!context) {
    if (temporary) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    const cause = toBotError(lastError);
    throw new BotError('BROWSER_LAUNCH_FAILED', cause.detail ?? cause.message);
  }

  await context
    .grantPermissions(['microphone', 'camera'], { origin: 'https://meet.google.com' })
    .catch(() => {
      // Non-fatal: --use-fake-ui-for-media-stream already covers the prompt.
    });

  // A persistent context opens with one blank page; reuse it rather than
  // leaving an orphan tab behind.
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);

  let closed = false;

  return {
    context,
    page,
    profileDir,
    async close() {
      if (closed) return;
      closed = true;

      await context.close().catch(() => {});
      if (temporary) {
        // Chromium can hold handles for a moment after close; one retry is
        // enough, and a leftover temp directory is not worth failing over.
        await fs.rm(profileDir, { recursive: true, force: true }).catch(async () => {
          await new Promise((r) => setTimeout(r, 1500));
          await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
        });
      }
    },
  };
}

/**
 * Whether the one-time sign-in has actually been run.
 *
 * A Chromium profile that has been used at all has a `Local State` file and a
 * `Default` directory; an empty or missing directory has neither. This does not
 * prove the session is still valid — only the platform can say that — but it
 * distinguishes "never set up" from "expired", which are different problems
 * with different fixes.
 */
export async function hasSignedInProfile(): Promise<boolean> {
  try {
    const stat = await fs.stat(MASTER_PROFILE_DIR);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }

  const entries = await fs.readdir(MASTER_PROFILE_DIR).catch(() => [] as string[]);
  return entries.some((e) => e === 'Default' || e === 'Local State');
}

/**
 * Opens the master profile directly, headful, for the interactive sign-in.
 *
 * Used only by `npm run bot:login`. It is the one place a human drives the
 * browser, which is exactly why the bot itself never has to.
 */
export async function launchForLogin(): Promise<BotBrowser> {
  await fs.mkdir(MASTER_PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(MASTER_PROFILE_DIR, {
    headless: false,
    channel: env.MEET_BOT_BROWSER_CHANNEL === 'chromium' ? undefined : env.MEET_BOT_BROWSER_CHANNEL,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? (await context.newPage());

  return {
    context,
    page,
    profileDir: MASTER_PROFILE_DIR,
    close: () => context.close(),
  };
}
