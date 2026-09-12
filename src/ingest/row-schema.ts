/**
 * Vendor CSV contract and per-row validation. Every row is validated here
 * before any database write; an invalid row becomes an ingest_row_errors
 * entry, never an exception.
 */
import { z } from 'zod';
import { MONEY_STRING } from '../shared/money.js';

/** Required header columns, in no particular order. Extra columns are ignored. */
export const CSV_COLUMNS = ['sku', 'name', 'category', 'cost', 'stock_quantity'] as const;

export const vendorRow = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  /** Vendor cost as a decimal string; pricing rules turn it into base_price. Must be positive. */
  cost: z
    .string()
    .trim()
    .regex(MONEY_STRING, 'must be a decimal with at most 2 decimal places')
    .refine((v) => /[1-9]/.test(v), 'must be greater than 0'),
  stock_quantity: z
    .string()
    .trim()
    .regex(/^\d{1,9}$/, 'must be a non-negative integer')
    .transform((v) => Number(v)),
});

export type VendorRow = z.infer<typeof vendorRow>;

export interface RowIssue {
  path: string;
  message: string;
}

export type RowValidation = { ok: true; row: VendorRow } | { ok: false; errors: RowIssue[] };

/** `raw` is the record as csv-parse produced it: string values, possibly missing keys. */
export function validateRow(raw: Record<string, string | undefined>): RowValidation {
  const result = vendorRow.safeParse(raw);
  if (result.success) return { ok: true, row: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
  };
}

/** Header check the splitter runs once: a file missing a required column fails the job, not 500k rows. */
export function missingColumns(header: string[]): string[] {
  const present = new Set(header.map((h) => h.trim()));
  return CSV_COLUMNS.filter((c) => !present.has(c));
}
