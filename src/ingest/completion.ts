import { sql } from 'kysely';
import type { Db, IngestJobStatus } from '../db/index.js';

/**
 * Derived job completion (ADR §7). There is no counter anywhere: a job is
 * finished when the splitter has declared SPLIT_DONE and no chunk is still
 * outstanding. A chunk is outstanding unless it is DONE, or FAILED with no
 * retries left. If any terminal FAILED chunk exists the job is PARTIAL,
 * otherwise COMPLETED.
 *
 * Whoever finishes last runs this: the splitter after SPLIT_DONE (covers
 * "all chunks were already processed" and the empty file), and every
 * processor after DONE or FAILED. Running it more often is harmless — it
 * is one conditional UPDATE and matches at most once.
 */
export async function checkJobCompletion(db: Db, jobId: string, maxAttempts: number): Promise<IngestJobStatus | null> {
  const result = await sql<{ status: IngestJobStatus }>`
    UPDATE ingest_jobs j
    SET status = CASE
          WHEN EXISTS (SELECT 1 FROM ingest_chunks c WHERE c.job_id = j.id AND c.status = 'FAILED')
          THEN 'PARTIAL' ELSE 'COMPLETED' END,
        completed_at = now(),
        updated_at = now()
    WHERE j.id = ${jobId}
      AND j.status = 'SPLIT_DONE'
      AND NOT EXISTS (
        SELECT 1 FROM ingest_chunks c
        WHERE c.job_id = j.id
          AND c.status <> 'DONE'
          AND NOT (c.status = 'FAILED' AND c.attempts >= ${maxAttempts})
      )
    RETURNING j.status
  `.execute(db);
  return result.rows[0]?.status ?? null;
}
