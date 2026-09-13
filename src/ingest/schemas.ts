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
