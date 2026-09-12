import pg from 'pg';

/**
 * Create the shared pg pool.
 *
 * Deliberately no custom type parsers: `numeric` (money) and `int8`
 * (`source_seq`) arrive as strings, which is exactly what the money rule in
 * CLAUDE.md requires. Never add a parser that turns numeric into a JS number.
 */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export type { Pool, PoolClient } from 'pg';
