import { env } from '../src/lib/env';
import { AudioManager } from '../src/services/meetingBot/audioManager';
import { launchBrowser } from '../src/services/meetingBot/browser';
import { toBotError } from '../src/services/meetingBot/errors';
import { joinMeeting } from '../src/services/meetingBot/joinMeeting';
import { MeetingMonitor, leaveMeeting } from '../src/services/meetingBot/meetingMonitor';
import { driverFor, parseMeetingLink } from '../src/services/meetingBot/platforms';

/**
 * Proves the whole join-and-speak path against a real meeting, without
 * involving the database, the scheduler or an interview.
 *
 *   npm run bot:test -- https://meet.google.com/abc-defg-hij
 *   npm run bot:test -- https://us05web.zoom.us/j/85512345678?pwd=xxxx
 *   npm run bot:test -- "https://teams.microsoft.com/l/meetup-join/..."
 *
 * Run this first when setting the bot up. It fails in the same places a real
 * interview would — a signed-out profile, a lobby nobody answers, audio that
 * never reaches the call — but in seconds instead of at the scheduled time.
 *
 * Quote Teams links: their query strings contain characters the shell eats.
 */

const HOLD_SECONDS = 45;

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.error('\n  Usage: npm run bot:test -- <meeting link>');
    console.error('  Google Meet, Zoom and Microsoft Teams links are all accepted.\n');
    process.exit(1);
  }

  const link = parseMeetingLink(input);
  const driver = driverFor(link.platform);

  console.log('');
  console.log(
    `  Platform : ${driver.label}${driver.requiresSignIn ? ' (needs a signed-in bot profile)' : ' (guest join)'}`,
  );
  console.log(`  Meeting  : ${link.displayUrl}`);
  if (link.joinUrl !== link.displayUrl) console.log(`  Bot uses : ${link.joinUrl}`);
  console.log(
    `  Voice    : ${env.MEET_BOT_TTS}${env.MEET_BOT_TTS === 'webspeech' ? ' (needs a virtual audio cable)' : ''}`,
  );
  console.log(`  Browser  : ${env.MEET_BOT_BROWSER_CHANNEL}${env.MEET_BOT_HEADLESS ? ' headless' : ''}`);
  console.log('');

  const browser = await launchBrowser({ isolated: true, requireSignedInProfile: driver.requiresSignIn });
  const audio = new AudioManager(browser.page, { interviewId: 'bot-test', language: 'en-US' });

  try {
    await audio.install();
    console.log('  ✓ audio bridge installed');

    await joinMeeting(browser.page, {
      link,
      onProgress: ({ stage, detail }) => console.log(`  → ${stage.padEnd(22)} ${detail}`),
    });
    console.log('  ✓ joined the meeting');

    await audio.verifyBridge();
    console.log('  ✓ microphone and capture verified');

    const monitor = new MeetingMonitor(browser.page, driver);
    monitor.on('candidateArrived', (s) => console.log(`  → someone joined (${s.participants} in the meeting)`));
    monitor.on('ended', ({ reason }) => console.log(`  → the meeting ended (${reason})`));
    monitor.start();

    await audio.speak(
      'Hello. This is a test of the AI interviewer. If you can hear this sentence clearly in the meeting, the outgoing audio is working correctly.',
      { expectsAnswer: true },
    );
    console.log('  ✓ spoke a test line — you should have heard it in the meeting');

    let heard = false;
    audio.on('transcript', ({ text, confidence }) => {
      heard = true;
      console.log(`  ← heard: "${text}" (confidence ${confidence.toFixed(2)})`);
    });

    console.log(`\n  Listening for ${HOLD_SECONDS}s — say something in the meeting to test the incoming audio.\n`);
    await new Promise((resolve) => setTimeout(resolve, HOLD_SECONDS * 1_000));

    console.log('');
    console.log('  Outgoing audio : ok');
    console.log(`  Incoming audio : ${audio.hasHeardAudio ? 'ok — remote audio reached the bot' : 'NOTHING RECEIVED'}`);
    console.log(`  Transcription  : ${heard ? 'ok' : 'no speech transcribed'}`);
    console.log(`  Participants   : ${monitor.snapshot?.participants ?? 'unknown'}`);
    console.log('');

    monitor.stop();
    await leaveMeeting(browser.page, driver);
  } catch (err) {
    const error = toBotError(err);
    console.error(`\n  ✗ ${error.code}`);
    console.error(`    ${error.message}`);
    if (error.detail) console.error(`    detail: ${error.detail}`);
    console.error('');
    process.exitCode = 1;
  } finally {
    audio.dispose();
    await browser.close();
  }
}

void main();
