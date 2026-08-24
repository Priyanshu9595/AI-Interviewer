import Redis from 'ioredis';
import { env } from './env';

/**
 * One shared Redis connection, for data that should expire on its own.
 *
 * Signup one-time codes are the only user so far, and they are the reason there
 * is deliberately no in-memory fallback. A code kept in a process is invisible
 * to every other process, so on more than one instance a correct code entered
 * against the wrong instance reads as wrong — a failure that looks like a bug
 * in the code generator and is miserable to trace. Better to refuse to start
 * the flow at all and say why.
 */
export const redisConfigured = Boolean(env.REDIS_URL);

let client: Redis | null = null;
let reported = false;

/**
 * The connection, opened on first use.
 *
 * Lazy because most requests never touch Redis, and because a dead Redis should
 * fail the signup endpoints rather than stop the server from booting.
 */
export function redis(): Redis {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is not set, so one-time codes cannot be stored.');
  }

  if (client) return client;

  client = new Redis(env.REDIS_URL, {
    // A command must not be able to hang a request forever, but it must be
    // allowed to wait out the opening TLS handshake. Disabling the offline
    // queue does the first at the cost of the second: the very first command
    // is rejected outright because the socket is still connecting, which on a
    // cold process means the first signup of the day fails and the next one
    // works. So the queue stays on and the bounds are timeouts instead.
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    // Upstash and Fly both terminate TLS; the URL scheme decides, and ioredis
    // reads rediss:// on its own. Nothing to configure here.
    lazyConnect: false,
  });

  client.on('error', (err: Error) => {
    // Logged once per connection rather than per retry: ioredis retries on a
    // backoff and would otherwise fill the log with the same line.
    if (reported) return;
    reported = true;
    console.warn(`[redis] connection error: ${err.message}`);
  });

  client.on('ready', () => {
    reported = false;
    console.log('[redis] ready — signup codes will be stored here');
  });

  return client;
}

export interface RedisStatus {
  configured: boolean;
  /** ioredis's own view: connecting, connect, ready, close, reconnecting, end. */
  state: string | null;
  reachable: boolean | null;
  error: string | null;
}

/**
 * Whether Redis is actually answering, for /health.
 *
 * Reported rather than assumed, because "signup is broken" and "Redis is
 * unreachable from this host" are the same incident and only one of them is
 * visible from the outside.
 */
export async function getRedisStatus(): Promise<RedisStatus> {
  if (!redisConfigured) {
    return { configured: false, state: null, reachable: null, error: 'REDIS_URL is not set' };
  }

  try {
    const c = redis();
    await c.ping();
    return { configured: true, state: c.status, reachable: true, error: null };
  } catch (err) {
    return {
      configured: true,
      state: client?.status ?? null,
      reachable: false,
      error: (err as Error).message,
    };
  }
}

/** Closes the connection on shutdown so the process can exit cleanly. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  await c.quit().catch(() => c.disconnect());
}
