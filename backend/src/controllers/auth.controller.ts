import { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuthRequest, AuthUser, signAccessToken, signRefreshToken } from '../lib/auth';
import { emailService } from '../lib/email/EmailService';
import { env } from '../lib/env';
import { badRequest, conflict, unauthorized } from '../lib/http';
import { prisma } from '../lib/prisma';
import { OtpService, otpConfigured } from '../services/OtpService';

const credentials = z.object({
  email: z.string().email().transform((e) => e.toLowerCase().trim()),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const registerSchema = credentials.extend({
  name: z.string().min(1).optional(),
  company: z.string().optional(),
});

const verifySchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase().trim()),
  code: z.string().regex(/^\d{6}$/, 'Enter the six digits from the email'),
});

const resendSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase().trim()),
});

/** Signing up needs somewhere to hold the code; refuse clearly if there is not. */
function requireOtpStore() {
  if (!otpConfigured) {
    throw badRequest('Email verification is not configured on this server, so accounts cannot be created.');
  }
}

const setRefreshCookie = (res: Response, token: string) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
};

const publicUser = (u: { id: string; email: string; name: string | null; company: string | null; role: string }) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  company: u.company,
  role: u.role,
});

/**
 * Step one of signing up: check the details, then post a code to the address.
 *
 * No row is written. The form waits in Redis until the code proves the address
 * belongs to whoever filled it in, so an abandoned sign-up leaves nothing to
 * clean up and nobody can hold somebody else's address hostage by starting a
 * sign-up with it.
 */
export const registerStart = async (req: AuthRequest, res: Response) => {
  requireOtpStore();
  const data = registerSchema.parse(req.body);

  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw conflict('An account with that email already exists');

  const issued = await OtpService.issue({
    email: data.email,
    // Hashed before it is stored, so a password never sits in Redis in the clear
    // even for the minutes this waits.
    passwordHash: await bcrypt.hash(data.password, 10),
    name: data.name ?? null,
    company: data.company ?? null,
  });

  if (!issued.ok) {
    throw badRequest(`A code was just sent. Try again in ${issued.retryInSeconds} seconds.`);
  }

  await emailService.sendSignupOtp({
    to: data.email,
    name: data.name ?? null,
    code: issued.code,
    expiresInSeconds: issued.expiresInSeconds,
  });

  res.status(202).json({
    email: data.email,
    expiresInSeconds: issued.expiresInSeconds,
    resendInSeconds: OtpService.resendCooldownSeconds,
  });
};

/** Step two: the code is right, so the account is real. */
export const registerVerify = async (req: AuthRequest, res: Response) => {
  requireOtpStore();
  const { email, code } = verifySchema.parse(req.body);

  const result = await OtpService.verify(email, code);

  if (!result.ok) {
    if (result.reason === 'expired') {
      throw badRequest('That code has expired. Ask for a new one.');
    }
    if (result.reason === 'exhausted') {
      throw badRequest('Too many wrong attempts. Ask for a new code.');
    }
    throw badRequest(
      `That code is not right. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left.`,
    );
  }

  const pending = result.pending;

  // Checked again here, not only at step one: minutes passed in between, and
  // two people can hold a code for the same address at once. The unique index
  // is the real guard, this is the readable error.
  const existing = await prisma.user.findUnique({ where: { email: pending.email } });
  if (existing) throw conflict('An account with that email already exists');

  const user = await prisma.user.create({
    data: {
      email: pending.email,
      password: pending.passwordHash,
      name: pending.name,
      company: pending.company,
    },
  });

  const payload: AuthUser = { userId: user.id, email: user.email, role: user.role };
  setRefreshCookie(res, signRefreshToken(payload));

  res.status(201).json({ accessToken: signAccessToken(payload), user: publicUser(user) });
};

/**
 * A fresh code for a sign-up already in flight.
 *
 * Says the same thing whether or not the address has a sign-up waiting, so the
 * endpoint cannot be used to find out who has started signing up.
 */
export const registerResend = async (req: AuthRequest, res: Response) => {
  requireOtpStore();
  const { email } = resendSchema.parse(req.body);

  const decision = await OtpService.resend(email);

  if (decision.ok && decision.pending) {
    await emailService.sendSignupOtp({
      to: email,
      name: decision.pending.name,
      code: decision.code,
      expiresInSeconds: decision.expiresInSeconds,
    });
  } else if (!decision.ok && decision.retryInSeconds > 0) {
    throw badRequest(`A code was just sent. Try again in ${decision.retryInSeconds} seconds.`);
  }

  res.status(202).json({
    email,
    expiresInSeconds: OtpService.codeTtlSeconds,
    resendInSeconds: OtpService.resendCooldownSeconds,
  });
};

export const login = async (req: AuthRequest, res: Response) => {
  const data = credentials.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email: data.email } });
  // Compare against a dummy hash when the user is missing so the response time
  // does not reveal whether the address is registered.
  const hash = user?.password ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
  const ok = await bcrypt.compare(data.password, hash);

  if (!user || !ok) throw unauthorized('Incorrect email or password');

  const payload: AuthUser = { userId: user.id, email: user.email, role: user.role };
  setRefreshCookie(res, signRefreshToken(payload));

  res.json({ accessToken: signAccessToken(payload), user: publicUser(user) });
};

export const refresh = async (req: AuthRequest, res: Response) => {
  const token = req.cookies?.refreshToken;
  if (!token) throw unauthorized('No refresh token');

  let payload: AuthUser;
  try {
    payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as AuthUser;
  } catch {
    throw unauthorized('Refresh token is invalid or expired');
  }

  // The user may have been deleted since the token was issued.
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user) throw unauthorized('Account no longer exists');

  const fresh: AuthUser = { userId: user.id, email: user.email, role: user.role };
  setRefreshCookie(res, signRefreshToken(fresh));

  res.json({ accessToken: signAccessToken(fresh), user: publicUser(user) });
};

export const logout = async (_req: AuthRequest, res: Response) => {
  res.clearCookie('refreshToken', { path: '/' });
  res.json({ ok: true });
};

export const me = async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user) throw unauthorized('Account no longer exists');
  res.json({ user: publicUser(user) });
};
