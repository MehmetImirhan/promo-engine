import { z } from 'zod';

/** Multipart fields of POST /ingest/jobs (the file part is handled separately). */
export const createJobFields = z.object({
  vendor_id: z.string().trim().min(1).max(100),
});

export const idParams = z.object({ id: z.uuid() });

export const MAX_JOBS_PAGE = 50;

export const listJobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_JOBS_PAGE).default(10),
});

export const MAX_ERRORS_PAGE = 500;

/** Keyset on row_no: pass the last row_no seen as `after` for the next page. */
export const listErrorsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_ERRORS_PAGE).default(100),
  after: z.coerce.number().int().min(0).default(0),
});
