# CLAUDE.md — Promotion Management API

You are implementing a design that has already been decided. The architecture
is in `ADR.md`; read it before any non-trivial task. Your job is to implement
that design faithfully, in small reviewed steps. Do not re-architect. If you
believe a decision in the ADR is wrong, say so explicitly and stop — do not
silently implement something different.

## Workflow rules (non-negotiable)

- **Plan before code** for any task touching more than one file. Show the plan;
  wait for approval.
- **Small diffs.** One module or one concern per change. Never generate the
  whole project in one pass.
- **Every change ends with a commit proposal**: a conventional-commit message
  whose body explains *why*, not what. Example:
  `feat(promotions): enforce single-active-promo with EXCLUDE constraint` /
  body: "App-level check-then-insert had a race window; the partial GiST
  exclusion constraint makes overlap impossible from any code path."
- **Append to `PROMPTS.md`** whenever a correction is made to something you
  produced: what was wrong, why it mattered, what changed. Keep it terse.
- Run `npm run typecheck && npm test` before declaring any task done. Report
  actual output, not a summary of what you expect.
- Never touch `AI_APPENDIX.md`. It is written by hand.

## Stack

- Node 20+, **Express** (plain — no Nest), TypeScript strict mode.
- PostgreSQL 18 (`btree_gist` extension required), Redis 7. Primary keys default to
  `uuidv7()` (built in since 18) for index locality.
- **Kysely** for queries; migrations are plain `.sql` files in
  `db/migrations/`, applied by a small runner. No ORM.
- BullMQ for queues, `csv-parse` (streaming) for CSV, `zod` for validation,
  `pino` for logs, `vitest` for tests, `ioredis` for Redis.
- `docker-compose.yml` brings up Postgres + Redis. The app must run with
  `docker compose up -d && npm install && npm run migrate && npm run dev`.

## Architecture rules — these are the design, not suggestions

### Money
- All prices are `numeric(12,2)` in Postgres and are handled as **strings or a
  decimal library** in TypeScript. `parseFloat`, `Number(...)` on money, and
  JS float arithmetic on prices are forbidden. Grep for them before finishing.
- Percentage discounts round half-up to 2dp. Fixed discounts floor at zero at
  compute time (`GREATEST(0, ...)`).

### Promotions
- A promotion has exactly one scope: `product_id` XOR `category_id`.
- "At most one active promotion per product" is enforced **only** by the two
  partial `EXCLUDE USING gist` constraints in the migration. Do not add
  application-level overlap checks, advisory locks, or `SELECT ... FOR UPDATE`
  for this purpose. Map SQLSTATE `23P01` to HTTP 409 with a structured body.
- Cross-scope conflicts are resolved by precedence: **product-scope wins over
  category-scope.** This lives in the effective-price query, nowhere else.
- Cancelling a promotion sets `status = 'CANCELLED'`. Never delete promotion rows.
- Fixed-amount product-scope promotions with `value >= base_price` are
  rejected at creation (400). Category-scope promotions skip this check.

### Effective price (Scenario B)
- Effective price is **computed in SQL at read time** via a lateral join.
  There is no `effective_price` column on `products`. Do not add one. Do not
  add a materialization job, a `product_promotions` link table, or a scheduler.
- Creating a category promotion is one `INSERT`. It must not iterate products.
- The pricing expression exists in exactly one place
  (`src/products/effective-price.sql.ts` or equivalent). Both the listing
  query and the detail query use it.
- Listing sorts by `effective_price` **in SQL**, never in application code.

### Pagination
- Keyset only. Cursor is an opaque base64 of `(effective_price, id)`.
  `WHERE (effective_price, id) > ($price, $id)`; `id` is the tiebreaker.
  No `OFFSET`.

### Caching
- Cache-aside Redis for `GET /products/:id` and `GET /products`.
- Keys include a per-category version: `catver:{categoryId}` (Redis `INCR`).
  Invalidation = increment the version. **Never** `DEL` or `SCAN` product keys
  in bulk.
- Version is bumped on: promotion create, promotion cancel, product
  create/update, ingest job completion (per affected category).
- Cache misses go through a **single-flight** helper (in-process promise map
  keyed by cache key). Concurrent misses for the same key run one query.
- Cache reads fail open: if Redis is down, serve from Postgres and log.

### Ingest pipeline (Scenario A)
- The HTTP handler for `POST /ingest/jobs` creates the job row, stores the
  file via the `Storage` interface, enqueues a `split` job, and returns 202.
  It never reads row data.
- **Splitter:** streams the CSV (`csv-parse` in stream mode, never
  `fs.readFile`), emits chunks of `INGEST_CHUNK_SIZE` rows as
  `chunks/{jobId}/{index}.jsonl`, inserts an `ingest_chunks` row, enqueues
  `{jobId, chunkIndex}`. It persists a checkpoint `(byte_offset,
  next_chunk_index)` on the job every N chunks and **resumes from it on
  retry**. It checks a `remainingTimeMs()` function (injected; Lambda-shaped)
  and re-enqueues itself with the checkpoint when time is low. When the stream
  ends it sets `status = 'SPLIT_DONE'`.
- **Processor:** handles exactly one chunk per job. First statement:
  `UPDATE ingest_chunks SET status='PROCESSING', attempts = attempts + 1 WHERE
  job_id=$1 AND chunk_index=$2 AND status IN ('PENDING','FAILED')` — zero rows
  affected means exit without doing anything.
- Validate every row with zod **before** any DB write. Partition valid/invalid.
  Invalid rows go to `ingest_row_errors`; they never throw and never fail the
  chunk.
- Apply pricing rules (`src/ingest/pricing-rules.ts`) in the application
  layer. This is the "dynamic pricing rules" step from the brief.
- Every row carries `source_seq = (job_seq << 32) | row_no` as a bigint.
- **Sort the batch by `sku`** before the upsert.
- Upsert is one statement:
  `INSERT ... ON CONFLICT (sku) DO UPDATE SET ... WHERE EXCLUDED.source_seq > products.source_seq RETURNING sku, category_id, OLD.base_price IS DISTINCT FROM NEW.base_price AS price_changed`
  (Postgres 18 `OLD`/`NEW` in `RETURNING`; do not use the `xmax = 0` trick).
- Categories are resolved with `INSERT ... ON CONFLICT (name) DO NOTHING`
  followed by a select.
- **Job completion** is derived, never counted: a job is `COMPLETED` when
  `status = 'SPLIT_DONE'` and no `ingest_chunks` row is outside `DONE`;
  `PARTIAL` if any chunk is `FAILED` after max attempts. Whoever finishes last
  runs the check. There is no `processed_chunks` counter.
- Worker concurrency is capped via `INGEST_WORKER_CONCURRENCY`. Never
  `Promise.all` over all chunks.
- Failed chunks after `INGEST_MAX_ATTEMPTS` are marked `FAILED` and moved to
  the DLQ queue. `POST /ingest/jobs/:id/replay-failed` re-enqueues them; the
  `source_seq` guard makes replay safe in any order.
- `UNIQUE (vendor_id, file_checksum)` on `ingest_jobs`; re-POST returns the
  existing job with 200.

### Storage / queue abstractions
- `Storage` interface (`put`, `getStream`, `exists`) with a local-filesystem
  implementation. Comment the S3 mapping; do not add the AWS SDK.
- Queue access goes through a thin `Queue` interface over BullMQ so the SQS
  mapping in the ADR is honest.

## Code conventions

- Folder layout: `src/{config,db,cache,queue,storage,products,promotions,ingest,shared}`.
- Route handlers are thin: parse → call service → map result/error to HTTP.
- Errors are typed (`NotFound`, `Conflict`, `Validation`) and mapped in one
  error middleware.
- Structured logs with a request id; no `console.log`.
- Tests: unit tests for pure logic (pricing rules, cursor encoding,
  effective-price arithmetic); integration tests against the docker-compose
  Postgres for the constraint, precedence, cross-page sort correctness, and
  ingest resume/replay. Keep the integration suite small and pointed.

## Things you will be tempted to do — don't

- Compute effective price in TypeScript after fetching rows.
- Add an `effective_price` column or a materialization job "for performance".
- Use offset pagination "for simplicity".
- Read the whole CSV into memory or process it in one worker call.
- Track ingest progress with a counter.
- Upsert an unsorted batch.
- Use `parseFloat` on a price.
- Delete cache keys with `SCAN`/`KEYS`.
- Generate the ADR or AI appendix content.
