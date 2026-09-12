/**
 * vitest globalSetup for the integration project.
 *
 * Ensures TEST_DATABASE_URL points at a database that exists, is migrated,
 * and is empty. It never touches DATABASE_URL's database, and refuses to run
 * if the two are the same so `npm test` can never truncate dev data.
 */
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

  await ensureDatabaseExists();

  const pool = createPool(env.TEST_DATABASE_URL);
  try {
    await runMigrations(pool);
    await pool.query(`TRUNCATE ${DOMAIN_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await pool.end();
  }
}
