import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from './env';
import { unauthorized } from './http';

export interface AuthUser {
  userId: string;
  email: string;
  role: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export const signAccessToken = (user: AuthUser) =>
  jwt.sign(user, env.JWT_SECRET, { expiresIn: '30m' });

export const signRefreshToken = (user: AuthUser) =>
  jwt.sign(user, env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

export const requireAuth = (req: AuthRequest, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(unauthorized('Missing bearer token'));
  }

  const token = header.slice('Bearer '.length);
  try {
    req.user = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
};

/** Reads the user when a token is present but never rejects the request. */
export const optionalAuth = (req: AuthRequest, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice('Bearer '.length), env.JWT_SECRET) as AuthUser;
    } catch {
      /* ignore — treated as anonymous */
    }
  }
  next();
};