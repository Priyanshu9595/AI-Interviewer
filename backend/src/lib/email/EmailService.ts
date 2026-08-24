import { env } from '../env';

interface SendArgs {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
}

const shell = (title: string, body: string) => `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;padding:32px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="padding:24px 28px;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:15px;font-weight:600;color:#4f46e5;letter-spacing:-0.01em;">AI Interview Platform</div>
    </div>
    <div style="padding:28px;">
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#0f172a;font-weight:600;">${title}</h1>
      <div style="font-size:14px;line-height:1.65;color:#475569;">${body}</div>
    </div>
    <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">
      This is an automated message. Please do not reply.
    </div>
  </div>
</div>`;

const button = (href: string, label: string) => `
<a href="${href}" style="display:inline-block;margin:20px 0;padding:11px 22px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">${label}</a>`;

const formatWhen = (d: Date) =>
  d.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

/**
 * Sender addresses Brevo has verified for this account. Null until the check
 * runs (or if it could not run), in which case sends proceed unguarded.
 */
let verifiedSenders: Set<string> | null = null;

/**
 * Confirms at boot that EMAIL_FROM is one of the account's verified senders.
 *
 * This exists because Brevo's failure mode is silent: the transactional API
 * returns 201 Created and only later rejects the message with "the sender you
 * used is not valid", which never surfaces in application logs.
 */
export async function verifyEmailSender(): Promise<void> {
  if (!env.API_KEY_FOR_EMAIL) {
    console.log('[email] no API key configured — emails will be logged, not sent');
    return;
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/senders', {
      headers: { Accept: 'application/json', 'api-key': env.API_KEY_FOR_EMAIL },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[email] could not list senders (${res.status}); sending will be attempted unchecked`);
      return;
    }

    const data = (await res.json()) as { senders?: Array<{ email: string; active: boolean }> };
    verifiedSenders = new Set((data.senders ?? []).filter((s) => s.active).map((s) => s.email.toLowerCase()));

    if (verifiedSenders.has(env.EMAIL_FROM.toLowerCase())) {
      console.log(`[email] sending as ${env.EMAIL_FROM} (verified)`);
    } else {
      console.error(
        `[email] EMAIL_FROM="${env.EMAIL_FROM}" is NOT a verified Brevo sender — every email will be rejected.\n` +
          `[email] Verify it at https://app.brevo.com/senders, or set EMAIL_FROM to one of: ${
            [...verifiedSenders].join(', ') || '(none verified yet)'
          }`,
      );
    }
  } catch (err) {
    console.warn('[email] sender verification skipped:', (err as Error).message);
  }
}

/** Whether the configured sender is known-good. Surfaced by /health. */
export const emailSenderStatus = () => {
  if (!env.API_KEY_FOR_EMAIL) return 'disabled' as const;
  if (!verifiedSenders) return 'unchecked' as const;
  return verifiedSenders.has(env.EMAIL_FROM.toLowerCase()) ? ('verified' as const) : ('unverified' as const);
};

export class EmailService {
  /**
   * Sends through Brevo when a key is present. Without one it logs the message
   * so local development still exercises the full scheduling path.
   */
  async send({ to, toName, subject, html, text }: SendArgs): Promise<void> {
    if (!env.API_KEY_FOR_EMAIL) {
      console.log(`\n[email:dev] To: ${to}\n[email:dev] Subject: ${subject}\n${text}\n`);
      return;
    }

    // Brevo answers 201 and *then* drops the message if the sender address is
    // not verified, so a send that looks successful can silently never arrive.
    // Refusing up front turns that into an error the scheduler can retry and log.
    if (verifiedSenders && !verifiedSenders.has(env.EMAIL_FROM.toLowerCase())) {
      throw new Error(
        `Brevo will reject mail from "${env.EMAIL_FROM}" because it is not a verified sender. ` +
          `Verify it at https://app.brevo.com/senders, or set EMAIL_FROM to one of: ${[...verifiedSenders].join(', ')}`,
      );
    }

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'api-key': env.API_KEY_FOR_EMAIL,
      },
      body: JSON.stringify({
        sender: { name: env.EMAIL_FROM_NAME, email: env.EMAIL_FROM },
        to: [{ email: to, name: toName ?? to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });

    if (!res.ok) {
      throw new Error(`Brevo rejected the message (${res.status}): ${await res.text()}`);
    }
  }

  /**
   * The sign-up verification code.
   *
   * Deliberately plain: no links and nothing to click, because a message whose
   * only instruction is "type these six digits into the tab you already have
   * open" cannot be turned into a phishing template. The code is shown large
   * because most people read it off a phone while typing on a laptop.
   */
  async sendSignupOtp(args: { to: string; name?: string | null; code: string; expiresInSeconds: number }) {
    const minutes = Math.round(args.expiresInSeconds / 60);
    const validFor = args.expiresInSeconds < 90 ? `${args.expiresInSeconds} seconds` : `${minutes} minutes`;

    const body = `
      <p>Hi${args.name ? ` ${args.name}` : ''},</p>
      <p>Use this code to finish creating your account.</p>
      <div style="margin:24px 0;padding:20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;text-align:center;">
        <div style="font-size:34px;font-weight:600;letter-spacing:0.22em;color:#0f172a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${args.code}</div>
        <div style="font-size:12px;color:#64748b;margin-top:8px;">Valid for ${validFor}</div>
      </div>
      <p style="color:#64748b;font-size:14px;">If you did not try to sign up, you can ignore this — no account has been created, and nothing happens unless the code is used.</p>`;

    await this.send({
      to: args.to,
      toName: args.name ?? undefined,
      subject: `${args.code} is your verification code`,
      html: shell('Verify your email', body),
      text: `Your verification code is ${args.code}. It is valid for ${validFor}.

If you did not try to sign up, you can ignore this - no account has been created.`,
    });
  }

  async sendInvite(args: {
    to: string;
    name: string;
    role: string;
    joinUrl: string;
    scheduledAt: Date;
    durationMinutes: number;
    /**
     * Where the coding exercise will appear, for interviews the AI runs inside
     * a meeting call. Sent up front because a meeting has no shared editor: the
     * interviewer posts this link in the chat when the round starts, and a
     * candidate whose chat is collapsed or whose client hides it would
     * otherwise have no way to reach it.
     */
    codingUrl?: string;
  }) {
    const when = formatWhen(args.scheduledAt);
    const body = `
      <p>Hi ${args.name},</p>
      <p>You have been invited to an interview for <strong>${args.role}</strong>, conducted by our AI interviewer.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <tr><td style="padding:6px 0;color:#64748b;">When</td><td style="padding:6px 0;color:#0f172a;font-weight:500;">${when}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;">Duration</td><td style="padding:6px 0;color:#0f172a;font-weight:500;">${args.durationMinutes} minutes</td></tr>
      </table>
      ${button(args.joinUrl, 'Join the interview')}
      ${
        args.codingUrl
          ? `<p style="font-size:13px;color:#64748b;margin-top:20px;">This interview includes a short coding exercise. When the interviewer asks for it, open your code editor here — it stays open for the whole interview:<br>
             <a href="${args.codingUrl}" style="color:#4f46e5;">${args.codingUrl}</a></p>`
          : ''
      }
      <p style="font-size:13px;color:#64748b;">Use a quiet room, a working microphone and a stable connection. The link is unique to you — please do not share it.</p>`;

    await this.send({
      to: args.to,
      toName: args.name,
      subject: `Interview invitation — ${args.role}`,
      html: shell('Your interview is scheduled', body),
      text:
        `Hi ${args.name},\n\nYou are invited to an interview for ${args.role}.\nWhen: ${when}\nDuration: ${args.durationMinutes} minutes\nJoin: ${args.joinUrl}\n` +
        (args.codingUrl ? `Code editor: ${args.codingUrl}\n` : '') +
        `\nThis link is unique to you.`,
    });
  }

  async sendReminder(args: {
    to: string;
    name: string;
    role: string;
    joinUrl: string;
    scheduledAt: Date;
    timeframe: string;
  }) {
    const when = formatWhen(args.scheduledAt);
    const body = `
      <p>Hi ${args.name},</p>
      <p>Your interview for <strong>${args.role}</strong> starts in <strong>${args.timeframe}</strong>.</p>
      <p style="color:#64748b;">Scheduled for ${when}.</p>
      ${button(args.joinUrl, 'Join now')}`;

    await this.send({
      to: args.to,
      toName: args.name,
      subject: `Reminder: your interview starts in ${args.timeframe}`,
      html: shell(`Starting in ${args.timeframe}`, body),
      text: `Hi ${args.name},\n\nYour interview for ${args.role} starts in ${args.timeframe} (${when}).\nJoin: ${args.joinUrl}`,
    });
  }

  async sendNoShowNudge(args: { to: string; name: string; role: string; joinUrl: string }) {
    const body = `
      <p>Hi ${args.name},</p>
      <p>Your interview for <strong>${args.role}</strong> has started and we are waiting for you. The room stays open for a few more minutes.</p>
      ${button(args.joinUrl, 'Join now')}`;

    await this.send({
      to: args.to,
      toName: args.name,
      subject: 'Your interview is waiting for you',
      html: shell('We are waiting for you', body),
      text: `Hi ${args.name},\n\nYour interview for ${args.role} has started and we are waiting.\nJoin: ${args.joinUrl}`,
    });
  }

  async sendFeedback(args: {
    to: string;
    name: string;
    role: string;
    overall: number;
    strengths: string[];
    improvements: string[];
    message: string;
  }) {
    const list = (items: string[]) =>
      items.length
        ? `<ul style="margin:8px 0 16px;padding-left:20px;">${items
            .map((i) => `<li style="margin-bottom:6px;">${i}</li>`)
            .join('')}</ul>`
        : '<p style="color:#94a3b8;margin:8px 0 16px;">Not enough signal to comment.</p>';

    const body = `
      <p>Hi ${args.name},</p>
      <p>Thank you for interviewing for <strong>${args.role}</strong>. Here is a summary of your performance.</p>
      <div style="margin:20px 0;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
        <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Overall rating</div>
        <div style="font-size:28px;font-weight:600;color:#4f46e5;">${args.overall.toFixed(1)}<span style="font-size:15px;color:#94a3b8;font-weight:400;"> / 10</span></div>
      </div>
      <p style="font-weight:600;color:#0f172a;margin-bottom:0;">What went well</p>
      ${list(args.strengths)}
      <p style="font-weight:600;color:#0f172a;margin-bottom:0;">Where to focus next</p>
      ${list(args.improvements)}
      <p>${args.message}</p>`;

    await this.send({
      to: args.to,
      toName: args.name,
      subject: `Your interview feedback — ${args.role}`,
      html: shell('Your interview feedback', body),
      text: `Hi ${args.name},\n\nThank you for interviewing for ${args.role}.\n\nOverall rating: ${args.overall.toFixed(
        1,
      )}/10\n\nStrengths:\n${args.strengths.map((s) => `- ${s}`).join('\n')}\n\nAreas to improve:\n${args.improvements
        .map((s) => `- ${s}`)
        .join('\n')}\n\n${args.message}`,
    });
  }
}

export const emailService = new EmailService();
