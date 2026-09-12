/**
 * The ordering key that makes ingest newest-wins in any processing order
 * (ADR §7, decision 8):
 *
 *   source_seq = (job_seq << 32) | row_no
 *
 * job_seq is the job's identity value (monotonic across uploads), row_no
 * the 1-based record number within the file. A later file always outranks
 * an earlier one; within a file a later row outranks an earlier one. The
 * upsert applies a row only when its source_seq is greater than the one
 * already stored, so duplicate SKUs, out-of-order chunks and DLQ replays
 * all converge on the same final state.
 *
 * Computed in SQL, never in TypeScript, so the value can never disagree
 * between the query and a test. `ingest_jobs_job_seq_range` keeps the
 * shift inside a signed bigint.
 */
import { sql, type Expression, type RawBuilder } from 'kysely';

export function sourceSeq(jobSeq: Expression<unknown>, rowNo: Expression<unknown>): RawBuilder<string> {
  return sql<string>`((${jobSeq}::bigint << 32) | ${rowNo}::bigint)`;
}
