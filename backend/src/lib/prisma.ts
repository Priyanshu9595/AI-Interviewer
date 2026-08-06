import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from './env';

const globalForPrisma = global as unknown as { prisma?: PrismaClient; pool?: Pool };

/**
 * Serverless Postgres (Neon and friends) drops idle connections on its own
 * side. Without the settings below, `pg` keeps handing out sockets the server
 * has already closed, and queries hang forever instead of failing — which in
 * this app meant a candidate sitting in a silent interview room.
 *
 * - `idleTimeoutMillis` well under the provider's idle cutoff, so we retire
 *   connections before the far end does.
 * - `connectionTimeoutMillis` / `query_timeout` so a dead socket surfaces as a
 *   rejected promise rather than an unresolved one.
 * - `keepAlive` so long-lived connections survive NAT and idle timeouts.
 */
const pool =
  globalForPrisma.pool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
    allowExitOnIdle: false,
  });

// An idle client erroring emits on the pool. Without a listener, Node treats it
// as an unhandled 'error' event and tears the process down.
pool.on('error', (err) => {
  console.error('[db] idle client error (the pool will replace it):', err.message);
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg(pool),
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

/** Cheap liveness probe used by /health. */
export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    console.error('[db] health check failed:', (err as Error).message);
    return false;
  }
}

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
  globalForPrisma.pool = pool;
}
