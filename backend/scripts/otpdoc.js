/**
 * Builds docs/Email-OTP-Redis-Brevo-Walkthrough.pdf
 *
 * Every code block is sliced out of the real source file at build time, so the
 * document cannot drift from what shipped. A missing marker throws rather than
 * quietly printing nothing. Markers are single-line and contain no backticks
 * or ${...}, both of which would break the surrounding template literal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = 'd:/AI INTERVIEW';
const OUT = path.join(ROOT, 'docs', 'Email-OTP-Redis-Brevo-Walkthrough.pdf');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function snippet(file, from, to, opts) {
  const { dedent = true, after = 0, before = 0 } = opts || {};
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n').split('\n');

  const start = lines.findIndex((l) => l.includes(from));
  if (start === -1) throw new Error(file + ': start marker not found -> ' + from);

  const rel = lines.slice(start).findIndex((l, i) => i > 0 && l.includes(to));
  if (rel === -1) throw new Error(file + ': end marker not found -> ' + to);

  let out = lines.slice(Math.max(0, start - before), start + rel + 1 + after);

  if (dedent) {
    const min = Math.min(...out.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
    out = out.map((l) => l.slice(min));
  }
  return out.join('\n');
}

const code = (file, from, to, opts) =>
  '<div class="code"><div class="codefile">' + esc(file) + '</div><pre>' +
  esc(snippet(file, from, to, opts)) + '</pre></div>';

const plain = (label, body) =>
  '<div class="code"><div class="codefile">' + esc(label) + '</div><pre>' + esc(body) + '</pre></div>';

const OTP = 'backend/src/services/OtpService.ts';
const MAIL = 'backend/src/lib/email/EmailService.ts';
const AUTH = 'backend/src/controllers/auth.controller.ts';
const PAGE = 'frontend-v2/src/app/(auth)/register/page.tsx';

const sections = [];
const S = (title, html) => sections.push({ title, html });

S('What we are building', [
  '<p>Before this change, <code>POST /auth/register</code> created the account immediately.',
  "Anyone could sign up with an address they did not own &mdash; a typo, or somebody else's.</p>",
  '<p>Now signing up takes two requests. A six-digit code goes to the address, and the account',
  'is only created once that code comes back. Nothing is written to Postgres in between.</p>',
  '<div class="flow">',
  '  <div class="fstep"><b>1</b> Browser posts the form to <code>/auth/register/start</code></div>',
  '  <div class="farrow">&darr;</div>',
  '  <div class="fstep"><b>2</b> Server checks the address is free, hashes the password,',
  '     generates a code, writes its keys to <b>Redis</b></div>',
  '  <div class="farrow">&darr;</div>',
  '  <div class="fstep"><b>3</b> Server hands the code to <b>Brevo</b>, which emails it</div>',
  '  <div class="farrow">&darr;</div>',
  '  <div class="fstep"><b>4</b> Browser posts the code to <code>/auth/register/verify</code></div>',
  '  <div class="farrow">&darr;</div>',
  '  <div class="fstep"><b>5</b> Code matches &rarr; the <code>User</code> row is created, tokens',
  '     issued, Redis keys deleted</div>',
  '</div>',
  '<p class="note"><b>Why no database row until step 5.</b> An abandoned sign-up leaves nothing',
  'behind, so there is no cleanup job for half-made accounts. And because <code>User.email</code>',
  'is unique, a row created at step 1 would let anyone take a real person\u2019s address out of',
  'circulation by starting a sign-up with it and walking away. It also means no migration and',
  'no <code>emailVerified</code> column.</p>',
].join('\n'));

S('Why Redis rather than a table', [
  '<p>The code has to disappear after sixty seconds. In Postgres that means an',
  '<code>expiresAt</code> column, a comparison against it on every read, and something running',
  'periodically to delete the dead rows &mdash; three moving parts to express one idea.</p>',
  '<p>Redis expiry <i>is</i> the feature. <code>SET key value EX 60</code> and the key is simply',
  'gone a minute later. Nothing to compare, nothing to sweep up.</p>',
  '<p>That is the whole reason Redis is here. In this design it is not a cache; it is a place',
  'where the deletion is automatic.</p>',
].join('\n'));

S('Step 1 &mdash; the Redis connection', [
  '<p>One shared, lazily-opened connection. <code>REDIS_URL</code> is optional so the rest of the',
  'app runs without it:</p>',
  code('backend/src/lib/env.ts', '* Redis, for signup one-time codes.', 'REDIS_URL: z.string().optional(),', { before: 1 }),
  '<p>The client itself:</p>',
  code('backend/src/lib/redis.ts', 'export function redis(): Redis {', 'lazyConnect: false,', { after: 1 }),
  '<h3>Two things that bit me here</h3>',
  '<p><b>The URL scheme decides TLS.</b> Upstash gives you a <code>redis-cli</code> command to copy.',
  'Pasting the whole thing in fails, and so does keeping the <code>redis://</code> scheme &mdash;',
  '<code>redis-cli</code> takes <code>--tls</code> as a separate flag, but a client library reads TLS',
  'from the scheme. It has to be <code>rediss://</code>, with two s characters:</p>',
  plain('what Upstash hands you, and what the variable needs',
    'wrong   REDIS_URL=redis-cli --tls -u redis://default:PASSWORD@host.upstash.io:6379\n' +
    'wrong   REDIS_URL=redis://default:PASSWORD@host.upstash.io:6379\n' +
    'right   REDIS_URL=rediss://default:PASSWORD@host.upstash.io:6379'),
  '<p><b>Turning off the offline queue broke the first request.</b> I set',
  '<code>enableOfflineQueue: false</code> so a command could not hang forever against a dead',
  'Redis. It also rejects the very first command on a cold process, because the TLS handshake',
  'has not finished yet &mdash; so the first sign-up after every deploy would fail and the next',
  'would work. The fix is to leave the queue on and bound it with timeouts instead, which is',
  'what the code above does.</p>',
  '<p class="note">I only found that by connecting to the real database. Reasoning about it had',
  'convinced me the option was correct.</p>',
].join('\n'));

S('Step 2 &mdash; three keys, three lifetimes', [
  '<p>Each in-flight sign-up has keys that expire at different times, on purpose:</p>',
  '<table>',
  '  <tr><th>Key</th><th>Holds</th><th>TTL</th></tr>',
  "  <tr><td><code>otp:&lt;email&gt;</code></td><td>the code's SHA-256 hash and the attempt count</td><td>60 seconds</td></tr>",
  '  <tr><td><code>signup:&lt;email&gt;</code></td><td>name, company, email, bcrypt password hash</td><td>15 minutes</td></tr>',
  '  <tr><td><code>otp:cooldown:&lt;email&gt;</code></td><td>nothing &mdash; its existence is the fact</td><td>30 seconds</td></tr>',
  '</table>',
  '<p>The code is the secret, so it is the thing that must be short-lived. The form is not a',
  'secret &mdash; the person filling it in supplied every field &mdash; so it outlives several',
  'codes. That is what makes a resend cost six digits instead of the whole form again.</p>',
  '<p>The cooldown key is a trick worth knowing: it stores no value. Asking',
  '<code>TTL otp:cooldown:someone@example.com</code> answers "how many seconds until they may ask',
  'for another code", and when the key expires the restriction lifts by itself.</p>',
  code(OTP, '/** Sixty seconds, as asked for. */', 'const MAX_ATTEMPTS = 5;'),
  code(OTP, 'const codeKey = (email: string)', 'const cooldownKey = (email: string)'),
].join('\n'));

S('Step 3 &mdash; generating and storing the code', [
  '<p>Three small functions carry all the security in this file:</p>',
  code(OTP, '/** SHA-256 is right here', 'return crypto.timingSafeEqual(left, right);', { after: 1 }),
  '<ul>',
  '  <li><b><code>crypto.randomInt</code>, not <code>Math.random</code>.</b>',
  '      <code>Math.random</code> is predictable from previous outputs. This is a secret, so it',
  '      comes from the operating system.</li>',
  '  <li><b>Stored as a hash.</b> Anyone reading the Redis database &mdash; a leaked URL, a',
  '      support tool, a backup &mdash; sees a hash, not a code they could use.</li>',
  '  <li><b>Compared with <code>timingSafeEqual</code>.</b> A normal <code>===</code> on strings',
  '      returns as soon as two bytes differ, so how long it takes leaks how much of the guess',
  '      was right.</li>',
  '</ul>',
  '<p>Writing it happens in one <code>MULTI</code>, so the keys are set together rather than a',
  'code existing for a moment with no form behind it:</p>',
  code(OTP, 'static async issue(pending: PendingSignup)', 'return { ok: true, expiresInSeconds: CODE_TTL_SECONDS, code };', { after: 1 }),
  '<p class="note"><b>Notice what <code>issue</code> returns.</b> It hands the code back to its',
  'caller rather than sending the email itself. That is what lets the test suite read a real',
  'code without a mailbox, and it keeps this file free of any knowledge of Brevo.</p>',
].join('\n'));

S('Step 4 &mdash; verifying, and why six digits is safe', [
  '<p>Six digits is one million combinations. That sounds strong until you notice a script can',
  'try many thousands inside the sixty seconds the code is alive. <b>The attempt cap, not the',
  'length, is what makes it safe.</b></p>',
  code(OTP, 'static async verify(email: string, code: string)', 'return { ok: true, pending };', { after: 1 }),
  '<p>Three decisions in there worth pulling out:</p>',
  '<ul>',
  '  <li><b>Five wrong guesses burn the code, not the sign-up.</b> The <code>signup:</code> key',
  '      survives, so the user asks for a new code rather than refilling the form.</li>',
  '  <li><b>A wrong guess must not reset the TTL.</b> The code reads the remaining time and',
  '      writes it back. Calling <code>SET ... EX 60</code> here would let an attacker extend the',
  '      very window they are guessing inside, simply by guessing.</li>',
  '  <li><b>A correct code is deleted.</b> Without that, a repeated request &mdash; a',
  '      double-click, a retry &mdash; could create two accounts from one code.</li>',
  '</ul>',
].join('\n'));

S('Step 5 &mdash; Brevo', [
  '<p>Brevo is a plain HTTPS API. No SDK is involved: one <code>fetch</code> to',
  '<code>/v3/smtp/email</code> with the key in an <code>api-key</code> header.</p>',
  code(MAIL, 'api.brevo.com/v3/smtp/email', 'Brevo rejected the message', { dedent: false, after: 1 }),
  '<h3>The failure mode that makes Brevo worth guarding</h3>',
  '<p>Brevo answers <b>201 Created</b> and <i>then</i> silently drops the message if the sender',
  'address is not one your account has verified. The send looks successful, the mail never',
  'arrives, and nothing in any log says so.</p>',
  '<p>So the app asks Brevo at boot which senders are verified, and refuses to send from an',
  'address that is not among them:</p>',
  code(MAIL, 'export async function verifyEmailSender()', 'verifiedSenders = new Set('),
  '<p>That is what the <code>[email] sending as ... (verified)</code> line at startup means, and',
  'why <code>/health</code> reports <code>emailSender</code>.</p>',
  '<h3>The OTP message itself</h3>',
  code(MAIL, 'async sendSignupOtp(args:', "html: shell('Verify your email', body),"),
  '<p class="note"><b>No links, deliberately.</b> A verification email whose only instruction is',
  '"type these six digits into the tab you already have open" cannot be repurposed as a',
  'phishing template. Anything clickable in an email teaches people to click things in',
  'emails.</p>',
].join('\n'));

S('Step 6 &mdash; the endpoints', [
  '<p>Three routes replace the single old one:</p>',
  code('backend/src/routes/index.ts', '// Signing up is two steps', 'auth.registerResend'),
  '<p>Step one &mdash; validate, hash, issue, send. The password is hashed <i>before</i> it goes',
  'into Redis, so it is never sitting there in the clear even for the minutes it waits:</p>',
  code(AUTH, 'export const registerStart', 'resendInSeconds: OtpService.resendCooldownSeconds,', { dedent: false, after: 2 }),
  '<p>Step two &mdash; the code is right, so the account becomes real:</p>',
  code(AUTH, 'export const registerVerify', 'res.status(201).json({ accessToken: signAccessToken(payload)', { dedent: false, after: 1 }),
  '<p class="note">The address is checked for availability <i>twice</i> &mdash; once at step one',
  'and again at step two. Minutes pass in between, and two people can hold a code for the same',
  'address at once. The unique index on <code>User.email</code> is the real guard; this second',
  'check is what turns a database constraint violation into a sentence a person can read.</p>',
].join('\n'));

S('Step 7 &mdash; the two-step form', [
  '<p>The register page keeps both steps in one component and holds the details in state, so',
  'going back to fix a typo in the address does not mean retyping the password.</p>',
  code(PAGE, 'const [step, setStep] = useState', 'const codeInput = useRef<HTMLInputElement>(null);'),
  '<p>One interval drives both countdowns &mdash; the remaining life of the code, and the wait',
  'until another can be sent:</p>',
  code(PAGE, '// One interval drives both countdowns', '}, [step]);', { dedent: false }),
  '<p>The input is filtered to digits as it is typed, and carries',
  '<code>autoComplete="one-time-code"</code> so phones offer the code from the notification:</p>',
  code(PAGE, 'onChange={(e) => setCode', 'autoComplete="one-time-code"', { dedent: false }),
].join('\n'));

S('Step 8 &mdash; testing it without a mailbox', [
  '<p><code>npm run verify:otp</code> runs against the real Redis in <code>.env</code> and sends no',
  'email, because <code>issue()</code> returns the code to its caller.</p>',
  '<p>The tests worth having are the failure modes, not the happy path:</p>',
  code('backend/scripts/otptest.ts', '3. The attempt cap is what makes six digits safe', 'but the form survives', { dedent: false }),
  '<p>Expiry is tested by shortening the TTL rather than waiting sixty seconds. The expiry',
  'under test is Redis\u2019s own, and it does not care how the TTL got short:</p>',
  code('backend/scripts/otptest.ts', '// The real code lives 60s.', 'an expired code is refused', { dedent: false }),
  plain('npm run verify:otp',
    '1. Issuing a code\n' +
    '  PASS  the code is six digits  - 053497\n' +
    '  PASS  the code is not stored in the clear\n' +
    '  PASS  the form is held alongside it\n' +
    '2. Wrong codes\n' +
    '  PASS  a wrong code is refused and counted  - 4 left\n' +
    '  PASS  a wrong guess does not extend the code  - 60s left of 60\n' +
    '3. The attempt cap is what makes six digits safe\n' +
    '  PASS  the code is burned after five wrong attempts\n' +
    '  PASS  but the form survives, so a resend costs six digits not the whole form\n' +
    '4. Resend\n' +
    '  PASS  a resend inside the cooldown is refused  - 29s\n' +
    '5. The right code\n' +
    '  PASS  a used code cannot be used twice\n' +
    '6. Expiry\n' +
    '  PASS  an expired code is refused\n\n' +
    'OTP OK'),
].join('\n'));

S('The Redis commands used, and why', [
  '<table>',
  '  <tr><th>Command</th><th>Used for</th></tr>',
  '  <tr><td><code>SET key value EX 60</code></td><td>Write with a lifetime in one step. The',
  '      <code>EX</code> is the whole reason Redis is here.</td></tr>',
  '  <tr><td><code>GET key</code></td><td>Read the code record or the pending form. A missing key',
  '      <i>is</i> expiry &mdash; there is no date to compare.</td></tr>',
  '  <tr><td><code>TTL key</code></td><td>Two jobs: how long the cooldown has left, and how much',
  '      life to preserve when writing back an incremented attempt count.</td></tr>',
  '  <tr><td><code>MULTI ... EXEC</code></td><td>Set the code, the form and the cooldown together,',
  '      so a code never exists without a form behind it.</td></tr>',
  '  <tr><td><code>DEL k1 k2 k3</code></td><td>Consume everything on success, so one code cannot',
  '      make two accounts.</td></tr>',
  '  <tr><td><code>EXPIRE key 1</code></td><td>Test only &mdash; ages a key so expiry can be',
  '      checked without waiting a minute.</td></tr>',
  '</table>',
].join('\n'));

S('What to watch for', [
  '<ul>',
  '  <li><b>Sixty seconds is tight.</b> Brevo usually delivers in a few seconds, but a',
  '      twenty-second delivery leaves forty seconds to switch apps, find the mail and type.',
  '      Expect real users to need the resend button; it is a support cost, not a',
  '      hypothetical.</li>',
  '  <li><b>No in-memory fallback, on purpose.</b> A code held in one process is invisible to',
  '      every other process, so with more than one instance running, a <i>correct</i> code',
  '      entered against the wrong instance reads as wrong. That looks like a bug in the code',
  '      generator and is miserable to trace. Better to refuse to start and say why.</li>',
  '  <li><b>The resend endpoint says the same thing either way.</b> Whether or not an address',
  '      has a sign-up waiting, the response is identical &mdash; otherwise it becomes a way to',
  '      find out who has started signing up.</li>',
  '  <li><b>Deployment.</b> <code>fly secrets set REDIS_URL=...</code> before this works in',
  '      production. Without it, sign-up refuses cleanly rather than half-working.</li>',
  '</ul>',
].join('\n'));

const toc = sections.map((s, i) => '<li><span class="tocn">' + (i + 1) + '</span> ' + s.title + '</li>').join('');
const body = sections
  .map((s, i) => '<section><h2><span class="secn">' + (i + 1) + '</span>' + s.title + '</h2>' + s.html + '</section>')
  .join('');

const css = [
  '@page { size: A4; margin: 18mm 16mm 20mm; }',
  '* { box-sizing: border-box; }',
  'body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
  '       color: #1e2836; font-size: 10.5pt; line-height: 1.62; margin: 0; }',
  '.cover { height: 235mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }',
  '.cover .kicker { color: #4f46e5; font-weight: 700; font-size: 9.5pt; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 14mm; }',
  '.cover h1 { font-size: 30pt; line-height: 1.14; margin: 0 0 6mm; letter-spacing: -.02em; color: #0f172a; }',
  '.cover .sub { font-size: 12.5pt; color: #64748b; margin-bottom: 16mm; max-width: 132mm; line-height: 1.5; }',
  '.cover .meta { font-size: 9pt; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 5mm; max-width: 132mm; }',
  '.toc { page-break-after: always; }',
  '.toc h2 { font-size: 15pt; margin: 0 0 6mm; color: #0f172a; }',
  '.toc ol { list-style: none; padding: 0; margin: 0; }',
  '.toc li { padding: 2.6mm 0; border-bottom: 1px solid #eef2f7; font-size: 10.5pt; color: #334155; }',
  '.tocn { display: inline-block; width: 9mm; color: #4f46e5; font-weight: 700; }',
  'section { margin-bottom: 9mm; }',
  'h2 { font-size: 14.5pt; color: #0f172a; margin: 0 0 4mm; letter-spacing: -.01em; page-break-after: avoid; }',
  '.secn { display: inline-block; min-width: 9mm; color: #4f46e5; font-weight: 700; }',
  'h3 { font-size: 11.5pt; color: #0f172a; margin: 6mm 0 2mm; page-break-after: avoid; }',
  'p { margin: 0 0 3.2mm; }',
  'ul { margin: 0 0 3.2mm; padding-left: 6mm; }',
  'li { margin-bottom: 1.8mm; }',
  'code { font-family: "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace; font-size: 8.8pt;',
  '       background: #f1f5f9; padding: .4mm 1.2mm; border-radius: 2px; color: #0f172a; }',
  '.code { margin: 3mm 0 4mm; border: 1px solid #e2e8f0; border-radius: 3px; overflow: hidden; page-break-inside: avoid; }',
  '.codefile { background: #f8fafc; border-bottom: 1px solid #e2e8f0; padding: 1.6mm 3mm;',
  '            font-family: Consolas, monospace; font-size: 7.6pt; color: #64748b; }',
  '.code pre { margin: 0; padding: 3mm; background: #fbfcfe; font-family: "Cascadia Mono", Consolas, monospace;',
  '            font-size: 7.7pt; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: #1e2836; }',
  '.note { background: #f5f3ff; border-left: 2.5pt solid #7c6cf6; padding: 3mm 4mm; margin: 3.5mm 0;',
  '        font-size: 9.8pt; page-break-inside: avoid; }',
  'table { border-collapse: collapse; width: 100%; margin: 3.5mm 0 4.5mm; font-size: 9.3pt; page-break-inside: avoid; }',
  'th { text-align: left; background: #f8fafc; border-bottom: 1.5pt solid #cbd5e1; padding: 2.2mm 3mm;',
  '     font-size: 8.4pt; text-transform: uppercase; letter-spacing: .05em; color: #475569; }',
  'td { border-bottom: 1px solid #eef2f7; padding: 2.2mm 3mm; vertical-align: top; }',
  '.flow { margin: 4mm 0 5mm; page-break-inside: avoid; }',
  '.fstep { border: 1px solid #dbe3ec; border-left: 2.5pt solid #4f46e5; border-radius: 3px;',
  '         padding: 2.4mm 3.5mm; font-size: 9.6pt; background: #fbfcfe; }',
  '.fstep b { color: #4f46e5; margin-right: 2mm; }',
  '.farrow { text-align: center; color: #94a3b8; font-size: 9pt; line-height: 1.1; padding: .8mm 0; }',
].join('\n');

const html =
  '<!doctype html><html><head><meta charset="utf-8"><title>Email OTP with Redis and Brevo</title>' +
  '<style>' + css + '</style></head><body>' +
  '<div class="cover">' +
  '  <div class="kicker">AI Interview Platform &middot; Implementation Walkthrough</div>' +
  '  <h1>Email OTP verification<br>with Redis and Brevo</h1>' +
  '  <div class="sub">How sign-up came to verify the address first &mdash; what each piece does, why it is' +
  '   built that way, and the two mistakes worth not repeating.</div>' +
  '  <div class="meta">Every code block in this document is sliced out of the real source file when the' +
  '   document is built, so it cannot drift from what shipped.</div>' +
  '</div>' +
  '<div class="toc"><h2>Contents</h2><ol>' + toc + '</ol></div>' +
  body +
  '</body></html>';

(async () => {
  const tmp = path.join(os.tmpdir(), 'otpdoc.html');
  fs.writeFileSync(tmp, html, 'utf8');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + tmp.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font-size:8pt;color:#94a3b8;font-family:Segoe UI,sans-serif;' +
      'padding:0 16mm;display:flex;justify-content:space-between;">' +
      '<span>Email OTP with Redis and Brevo</span><span class="pageNumber"></span></div>',
    margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' },
  });
  await browser.close();

  console.log('wrote ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
})();
