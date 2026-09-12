import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import type { Database } from './types.js';

export type Db = Kysely<Database>;

/** Kysely over an existing pg pool. Numeric/int8 stay strings (see pool.ts). */
export function createDb(pool: Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
