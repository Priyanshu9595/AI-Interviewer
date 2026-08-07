import { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuthRequest, AuthUser, signAccessToken, signRefreshToken } from '../lib/auth';
import { env } from '../lib/env';
import { conflict, unauthorized } from '../lib/http';
import { prisma } from '../lib/prisma';

const credentials = z.object({
  email: z.string().email().transform((e) => e.toLowerCase().trim()),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const registerSchema = credentials.extend({
  name: z.string().min(1).optional(),
  company: z.string().optional(),
});

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

export const register = async (req: AuthRequest, res: Response) => {
  const data = registerSchema.parse(req.body);

  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw conflict('An account with that email already exists');

  const user = await prisma.user.create({
    data: {
      email: data.email,
      password: await bcrypt.hash(data.password, 10),
      name: data.name ?? null,
      company: data.company ?? null,
    },
  });

  const payload: AuthUser = { userId: user.id, email: user.email, role: user.role };
  setRefreshCookie(res, signRefreshToken(payload));

  res.status(201).json({ accessToken: signAccessToken(payload), user: publicUser(user) });
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
