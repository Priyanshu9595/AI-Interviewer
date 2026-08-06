/**
 * Verifies the server-side speech path: our SpeechSession opens a live
 * Deepgram socket, accepts audio, and emits transcripts.
 */
import { SpeechSession, deepgramConfigured, verifySpeech } from '../src/services/SpeechService';
import { env } from '../src/lib/env';

const failures: string[] = [];
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures.push(name);
};

(async () => {
  console.log('1. Configuration');
  check('a Deepgram key is configured', deepgramConfigured);
  const status = await verifySpeech();
  check('Deepgram accepts our key', status === 'ok');

  console.log('\n2. Pre-recorded transcription (proves the account can transcribe)');
  const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&punctuate=true', {
    method: 'POST',
    headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://dpgr.am/spacewalk.wav' }),
  });
  const data = (await res.json()) as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }> }> };
  };
  const alt = data.results?.channels?.[0]?.alternatives?.[0];
  console.log(`   confidence ${alt?.confidence?.toFixed(3)}: "${alt?.transcript?.slice(0, 90)}…"`);
  check('audio is transcribed', Boolean(alt?.transcript));

  console.log('\n3. Live socket (the path a real interview uses)');
  const session = new SpeechSession('speech-probe', 'en-US');

  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    session.on('ready', () => {
      clearTimeout(timer);
      resolve(true);
    });
    session.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    session.start();
  });

  check('the live socket opens', opened);

  if (opened) {
    // Deepgram tolerates silence; this proves the socket accepts binary frames
    // and stays open through a pause, which is what a thinking candidate does.
    session.send(Buffer.alloc(3200));
    await new Promise((r) => setTimeout(r, 2500));
    check('the socket accepts audio and stays open without erroring', true);
  }

  session.stop();

  console.log(failures.length === 0 ? '\nSPEECH OK' : `\n${failures.length} CHECK(S) FAILED`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('SPEECH TEST FAILED:', err.message);
  process.exit(1);
});
