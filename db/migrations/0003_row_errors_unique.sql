-- 0003_row_errors_unique.sql
-- One error record per (job, file row). The processor's insert becomes
-- ON CONFLICT DO NOTHING, so a chunk run twice (stale-PROCESSING reclaim of
-- a worker that was slow rather than dead) is idempotent for errors exactly
-- as source_seq makes it idempotent for products. The unique index leads
-- with job_id, so the plain job_id index is redundant.

ALTER TABLE ingest_row_errors
  ADD CONSTRAINT ingest_row_errors_job_row_key UNIQUE (job_id, row_no);

DROP INDEX ingest_row_errors_job_id_idx;
