-- 0002_ingest_progress.sql
-- Ingest observability columns (ADR §7). None of these drive control flow:
-- job completion stays derived from chunk statuses, and the splitter's
-- checkpoint stays next_chunk_index. They exist so GET /ingest/jobs/:id and
-- the cache session can read what happened without re-scanning products.

-- How many times the splitter ran for this job. Continuations are
-- (split_invocations - 1); the measurement script reports it.
ALTER TABLE ingest_jobs
  ADD COLUMN split_invocations integer NOT NULL DEFAULT 0;

ALTER TABLE ingest_chunks
  -- Rows that passed validation and pricing, rows recorded in ingest_row_errors,
  -- and rows the upsert actually wrote (i.e. not skipped by the source_seq guard).
  ADD COLUMN rows_valid   integer NOT NULL DEFAULT 0,
  ADD COLUMN rows_invalid integer NOT NULL DEFAULT 0,
  ADD COLUMN rows_applied integer NOT NULL DEFAULT 0,
  -- Categories in which at least one product's base_price actually changed
  -- (from RETURNING OLD/NEW). The cache session bumps each once at job
  -- completion; there is deliberately no per-SKU list.
  ADD COLUMN changed_category_ids uuid[] NOT NULL DEFAULT '{}';
