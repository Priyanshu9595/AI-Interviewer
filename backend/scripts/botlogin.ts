import readline from 'readline';
import { launchForLogin, MASTER_PROFILE_DIR } from '../src/services/meetingBot/browser';

/**
 * One-time interactive sign-in for the bot's meeting accounts.
 *
 *   npm run bot:login            # Google, the default
 *   npm run bot:login -- zoom
 *   npm run bot:login -- teams
 *
 * A window opens, a human signs in, and the session is left in the Chromium
 * profile at GOOGLE_BOT_PROFILE_PATH. All three platforms share that one
 * profile, so signing in to each is just running this again.
 *
 * Google Meet requires this: an anonymous participant is refused by many
 * meetings. Zoom and Teams both admit named guests, so signing in there is
 * only needed for meetings restricted to authenticated users.
 *
 * This exists so the bot never has to handle credentials. Passwords, two-step
 * verification and any security check a platform raises are dealt with here,
 * by a person, once — the bot itself stops and reports if it ever meets one.
 */

interface Target {
  label: string;
  /** Where the sign-in starts. */
  signInUrl: string;
  /** Where success is confirmed. */
  verifyUrl: string;
  /** A URL still matching this means the sign-in did not take. */
  signedOutPattern: RegExp;
  required: boolean;
}

const TARGETS: Record<string, Target> = {
  google: {
    label: 'Google (for Google Meet)',
    signInUrl: 'https://accounts.google.com/',
    verifyUrl: 'https://meet.google.com/',
    signedOutPattern: /accounts\.google\.com|\/signin/i,
    required: true,
  },
  zoom: {
    label: 'Zoom',
    signInUrl: 'https://zoom.us/signin',
    verifyUrl: 'https://zoom.us/profile',
    signedOutPattern: /\/signin|\/oauth/i,
    required: false,
  },
  teams: {
    label: 'Microsoft Teams',
    signInUrl: 'https://login.microsoftonline.com/',
    verifyUrl: 'https://teams.microsoft.com/',
    signedOutPattern: /login\.microsoftonline\.com|login\.live\.com/i,
    required: false,
  },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question: string) => new Promise<string>((resolve) => rl.question(question, resolve));

async function main() {
  const key = (process.argv[2] ?? 'google').toLowerCase();
  const target = TARGETS[key];

  if (!target) {
    console.error(`\n  Unknown platform "${key}". Use one of: ${Object.keys(TARGETS).join(', ')}\n`);
    rl.close();
    process.exit(1);
  }

  console.log('');
  console.log(`  Meeting bot — one-time sign-in: ${target.label}`);
  console.log('  ------------------------------------------------');
  console.log(`  Profile: ${MASTER_PROFILE_DIR}`);
  if (!target.required) {
    console.log('  Optional: this platform lets the bot join as a named guest.');
    console.log('  Sign in only for meetings that require an authenticated account.');
  }
  console.log('');
  console.log('  A browser window will open. In it:');
  console.log('    1. Sign in as the dedicated bot account (not your own).');
  console.log('    2. Complete any verification you are asked for.');
  console.log('    3. Choose "stay signed in" or "remember this device" if offered.');
  console.log(`    4. Open ${target.verifyUrl} and confirm you are signed in.`);
  console.log('');
  console.log('  Then come back here and press Enter.');
  console.log('');

  const browser = await launchForLogin();
  await browser.page.goto(target.signInUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  await ask('  Press Enter once signed in... ');

  // Confirm rather than assume. Getting this wrong means every interview fails
  // at the same point, hours later, with the profile blamed last.
  console.log('\n  Checking the session...');
  await browser.page.goto(target.verifyUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await browser.page.waitForTimeout(5_000);

  const url = browser.page.url();

  if (target.signedOutPattern.test(url)) {
    console.log(`\n  ✗ Still signed out — ${target.verifyUrl} redirected to a sign-in page.`);
    console.log('    Nothing usable was saved. Run this again and complete the sign-in.\n');
  } else {
    const account = await browser.page
      .evaluate(() => document.body?.innerHTML?.match(/[\w.+-]+@[\w.-]+\.\w{2,}/)?.[0] ?? null)
      .catch(() => null);

    console.log(`\n  ✓ Signed in to ${target.label}${account ? ` as ${account}` : ''}.`);
    console.log(`    The session is stored in ${MASTER_PROFILE_DIR}.`);
    console.log('    Treat that directory as a credential: it grants access to the account.\n');
  }

  await browser.close();
  rl.close();
}

main().catch((err) => {
  console.error('\n  Sign-in helper failed:', err.message, '\n');
  rl.close();
  process.exit(1);
});
