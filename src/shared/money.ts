import { z } from 'zod';

/**
 * Money and discount values cross the API as decimal strings, never JSON
 * numbers (CLAUDE.md money rule). Up to 10 integer digits and 2 decimals,
 * matching numeric(12,2).
 */
export const MONEY_STRING = /^\d{1,10}(\.\d{1,2})?$/;

export const moneyString = z
  .string()
  .regex(MONEY_STRING, 'must be a decimal string with at most 2 decimal places, e.g. "19.99"');
