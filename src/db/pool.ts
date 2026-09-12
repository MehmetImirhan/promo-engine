import pg from 'pg';

/**
 * Create the shared pg pool.
 *
 * Deliberately no custom type parsers: `numeric` (money) and `int8`
 * (`source_seq`) arrive as strings, which is exactly what the money rule in
 * CLAUDE.md requires. Never add a parser that turns numeric into a JS number.
 *
 * JIT is disabled for every connection via the libpq startup `options`
 * parameter. Every query this service runs is short OLTP; the one expensive
 * query (the sorted 50k-product listing, ADR §4) crosses jit_above_cost
 * once the planner's estimates are accurate, and measured on it JIT
 * compilation cost ~140 ms of a ~300 ms execution — paid on every execution,
 * since nothing is cached across statements. With JIT off the same query
 * runs in ~145 ms.
 */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    options: '-c jit=off',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export type { Pool, PoolClient } from 'pg';
