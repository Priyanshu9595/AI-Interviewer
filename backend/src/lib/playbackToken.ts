import jwt from 'jsonwebtoken';
import { env } from './env';

interface PlaybackClaims {
  rid: string;
  kind: 'recording-playback';
}

/**
 * A media element cannot send an Authorization header, so recording playback
 * needs the credential in the URL. This mints a short-lived token scoped to a
 * single recording — it grants nothing else, and expires quickly enough that a
 * URL copied out of devtools is not a lasting leak.
 */
export function signPlaybackToken(recordingId: string): string {
  return jwt.sign({ rid: recordingId, kind: 'recording-playback' } satisfies PlaybackClaims, env.JWT_SECRET, {
    expiresIn: '2h',
  });
}

/** Returns the recording id, or null when the token is invalid or expired. */
export function verifyPlaybackToken(token: string): string | null {
  try {
    const claims = jwt.verify(token, env.JWT_SECRET) as Partial<PlaybackClaims>;
    // A session access token must never double as a playback token.
    if (claims.kind !== 'recording-playback' || !claims.rid) return null;
    return claims.rid;
  } catch {
    return null;
  }
}
