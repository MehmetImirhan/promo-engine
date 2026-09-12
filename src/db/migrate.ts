import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Pool } from 'pg';

/** `db/migrations/` relative to the repo root; valid from both src/ and dist/src/. */
export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

const MIGRATION_FILE = /^\d{4}_[\w-]+\.sql$/;

/**
 * Serialises concurrent runners (e.g. two app instances starting at once).
 * Arbitrary constant; unrelated to any domain invariant.
 */
const MIGRATION_LOCK_KEY = 728_411_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every `NNNN_name.sql` in `dir` (lexical order) that is not yet recorded
 * in `schema_migrations`. Each file runs in its own transaction and is recorded
 * in that same transaction, so a failed migration leaves no partial state and
 * no record. Idempotent: a second run applies nothing.
 */
export async function runMigrations(
  pool: Pool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const result: MigrationResult = { applied: [], skipped: [] };

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

        // Checked under the lock so two runners cannot both apply the same file.
        const seen = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
        if ((seen.rowCount ?? 0) > 0) {
          await client.query('ROLLBACK');
          result.skipped.push(file);
          continue;
        }

        const sql = await readFile(path.join(dir, file), 'utf8');
        await client.query(sql); // simple-query protocol: multiple statements allowed
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    client.release();
  }

  return result;
}

/** Wait for Postgres to accept connections (it may still be starting after `docker compose up -d`). */
async function waitForPostgres(pool: Pool, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error(`postgres not reachable after ${timeoutMs}ms`, { cause: lastError });
}

async function main(): Promise<void> {
  const [{ env }, { createPool }, { createLogger }] = await Promise.all([
    import('../config/index.js'),
    import('./pool.js'),
    import('../shared/logger.js'),
  ]);
  const log = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
  const pool = createPool(env.DATABASE_URL);

  try {
    await waitForPostgres(pool, 30_000);
    const { applied, skipped } = await runMigrations(pool);
    log.info({ applied, skipped: skipped.length }, 'migrations complete');
  } catch (err) {
    log.error({ err }, 'migration failed');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
