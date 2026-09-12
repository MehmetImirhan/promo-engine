import { z } from 'zod';

/** Multipart fields of POST /ingest/jobs (the file part is handled separately). */
export const createJobFields = z.object({
  vendor_id: z.string().trim().min(1).max(100),
});

export const idParams = z.object({ id: z.uuid() });
