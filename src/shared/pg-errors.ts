/**
 * Translate Postgres integrity errors into typed application errors.
 * The database is the source of truth for these rules; this maps the
 * SQLSTATE + constraint name to a 4xx with the same detail shape zod uses.
 */
import { DatabaseError } from 'pg';
import { Conflict, Validation } from './errors.js';

export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
} as const;

export function isPgError(err: unknown, code: string): err is DatabaseError {
  return err instanceof DatabaseError && err.code === code;
}

export interface ConstraintMessage {
  /** Request field the constraint is about, for the details array. */
  path?: string;
  message: string;
}
export type ConstraintMessages = Record<string, ConstraintMessage>;

/**
 * Unique → 409, foreign key / check → 400, for constraints listed in `known`.
 * Anything else is rethrown untouched (and becomes a 500), because an unknown
 * integrity error is a bug, not bad input. Exclusion violations (23P01) are
 * not handled here: their 409 body is domain-specific.
 */
export function translateIntegrityError(err: unknown, known: ConstraintMessages): never {
  if (err instanceof DatabaseError && err.constraint !== undefined) {
    const mapped = known[err.constraint];
    if (mapped) {
      const details = [{ path: mapped.path ?? err.constraint, message: mapped.message }];
      if (err.code === PG.UNIQUE_VIOLATION) throw new Conflict(mapped.message, details);
      if (err.code === PG.FOREIGN_KEY_VIOLATION || err.code === PG.CHECK_VIOLATION) {
        throw new Validation(mapped.message, details);
      }
    }
  }
  throw err;
}
