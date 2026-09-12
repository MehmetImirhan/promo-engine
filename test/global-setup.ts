/**
 * vitest globalSetup for the integration project.
 *
 * Ensures TEST_DATABASE_URL points at a database that exists, is migrated,
 * and is empty, and that TEST_REDIS_URL (a separate logical Redis db) is
 * empty. It never touches DATABASE_URL's or REDIS_URL's data, and refuses to
 * run if either pair is the same so `npm test` can never wipe dev data.
 */
import { createRedis } from '../src/cache/index.js';
import { env } from '../src/config/index.js';
import { createPool, runMigrations } from '../src/db/index.js';

const DOMAIN_TABLES = [
  'promotions',
  'products',
  'categories',
  'ingest_row_errors',
  'ingest_chunks',
  'ingest_jobs',
];

function databaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`TEST_DATABASE_URL has an unsafe database name: "${name}"`);
  }
  return name;
}

async function ensureDatabaseExists(): Promise<void> {
  const testDb = databaseName(env.TEST_DATABASE_URL);
  const admin = createPool(env.DATABASE_URL);
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDb]);
    if ((rowCount ?? 0) === 0) {
      await admin.query(`CREATE DATABASE "${testDb}"`);
    }
  } finally {
    await admin.end();
  }
}

export async function setup(): Promise<void> {
  if (env.TEST_DATABASE_URL === env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL: refusing to truncate the app database');
  }
  if (env.TEST_REDIS_URL === env.REDIS_URL) {
    throw new Error('TEST_REDIS_URL must differ from REDIS_URL: refusing to flush the app cache');
  }

  // Cached listings and version counters from a previous run must not outlive the truncated tables.
  const redis = createRedis(env.TEST_REDIS_URL);
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }

  await ensureDatabaseExists();

  const pool = createPool(env.TEST_DATABASE_URL);
  try {
    await runMigrations(pool);
    await pool.query(`TRUNCATE ${DOMAIN_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await pool.end();
  }
}
