# CLAUDE.md — Promotion Management API

You are implementing a design that has already been decided. The architecture
is in `ADR.md`; read it before any non-trivial task. Your job is to implement
that design faithfully, in small reviewed steps. Do not re-architect. If you
believe a decision in the ADR is wrong, say so explicitly in the plan and stop
— do not silently implement something different. Disagreement is welcome;
silent divergence is not.

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
  No AI attribution trailers in commit messages.
- **Append to `PROMPTS.md`** (gitignored) whenever a correction is made to
  something you produced: what was wrong, why it mattered, what changed.
- Run `npm run typecheck && npm test` before declaring any task done. Report
  actual output, not a summary of what you expect.
- `ADR.md` is edited by hand; apply changes to it only on an explicit
  instruction. `AI_APPENDIX.md` is not part of this repository; never create
  one.

## Stack

- Node 20+, **Express 5** (plain — no Nest), TypeScript strict mode.
- PostgreSQL 18 (`btree_gist` extension required), Redis 7. Primary keys
  default to `uuidv7()` (built in since 18) for index locality.
- **Kysely** for queries, with raw `sql` fragments where the builder cannot
  express something; migrations are plain `.sql` files in `db/migrations/`,
  applied by a small runner under one session-level advisory lock. No ORM,
  no schema builder for DDL.
- BullMQ for queues, `csv-parse` (streaming) for CSV, `zod` for validation,
  `decimal.js` for ingest pricing arithmetic, `pino` for logs, `vitest` for
  tests, `ioredis` for Redis.
- `docker-compose.yml` brings up Postgres + Redis only. The app must run with
  `docker compose up -d && npm install && npm run migrate && npm run dev`.
  The `ui/` directory is a separate demo; nothing in the backend build,
  tests, or README startup depends on it.

## Architecture rules — these are the design, not suggestions

### Money
- All prices are `numeric(12,2)` in Postgres and **strings** in TypeScript;
  all price arithmetic happens in SQL. The one exception is the ingest
  pricing-rules step, which computes in the application layer with
  `decimal.js` and converts back to a string before the upsert.
  `parseFloat`, `Number(...)` on money, and JS float arithmetic on prices are
  forbidden. Grep for them before finishing.
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
- Cancelling a promotion sets `status = 'CANCELLED'`; cancel is idempotent.
  Never delete promotion rows.
- Assigning re-targets an existing promotion in one `UPDATE`; it is subject
  to the same constraints and rules as creation, and a cancelled promotion
  cannot be assigned (409).
- Fixed-amount product-scope promotions with `value >= base_price` are
  rejected (400) at creation and at assign, compared in SQL. Category-scope
  promotions skip this check; the zero floor covers them at compute time.

### Effective price (Scenario B)
- Effective price is **computed in SQL at read time** via a lateral join.
  There is no `effective_price` column on `products`. Do not add one. Do not
  add a materialization job, a `product_promotions` link table, or a scheduler.
- Creating a category promotion is one `INSERT`. It must not iterate products.
- The pricing expression exists in exactly one place
  (`src/products/effective-price.sql.ts`): a composable query both the
  listing and detail queries extend. Never duplicate it, including inside a
  keyset `WHERE` — wrap the priced query as a subquery instead.
- Listing sorts by `effective_price` **in SQL**, never in application code.
- The lateral join's scope lookup is served by the two EXCLUDE GiST indexes
  (measured: BitmapOr at 50k products). Do not add btree partial indexes on
  `promotions` without an `EXPLAIN` showing they change the plan.

### Pagination
- Keyset only. Cursor is an opaque base64url of the sort key
  `(effective_price, id)` plus the listing scope `(order, category_id)`; a
  cursor replayed with a different `order` or `category_id` is a 400.
  `WHERE (effective_price, id) > ($price, $id)` over the wrapped subquery;
  `id` is the tiebreaker; `limit + 1` lookahead. No `OFFSET`, no `COUNT`.

### Caching
- Cache-aside Redis for `GET /products/:id` (300 s) and `GET /products`
  (60 s). TTL is a safety net, not the invalidation mechanism.
- Keys carry a category-qualified version token `{categoryId}.{n}` from
  `catver:{categoryId}` (Redis `INCR`), so counters for different categories
  cannot collide; `catver:_all` backs the unfiltered listing and is bumped
  alongside every category bump. Detail requests resolve product → category
  through a cached mapping that is refreshed on every miss.
- Invalidation = increment the version. Bumped by: promotion create, cancel,
  and assign (assign bumps both old and new target categories); `POST
  /products`; ingest job completion, once per category in the union of the
  chunks' `changed_category_ids` (price changes and category moves — a move
  bumps both categories). Ingest never bumps per row and never writes cache
  keys.
- Product keys are never deleted or enumerated (`DEL`/`SCAN`/`KEYS`);
  invalidation is the version bump, nothing else.
- The version is read once per request and reused for both the key and the
  write. Cache misses go through the **single-flight** helper (in-process
  promise map keyed by cache key; `fn` starts synchronously — never deferred
  to a microtask). Concurrent misses for the same key run one query.
- Cache reads fail open: if Redis is down, slow (`commandTimeout` 500 ms),
  or returns something unparseable (parse inside the try), serve from
  Postgres and log. Fail-open covers the version read too. Single-flight
  stays active when Redis is down.

### Ingest pipeline (Scenario A)
- The HTTP handler for `POST /ingest/jobs` streams the multipart upload into
  the `Storage` interface with a streaming checksum — never buffered in
  memory — creates the job row, enqueues `split`, and only then responds
  202. Nothing runs after the response. It never reads row data.
  `UNIQUE (vendor_id, file_checksum)`: a re-POST returns the existing job
  with 200 and discards the duplicate upload.
- The queue is a hard dependency for ingest, not a fail-open one. The API's
  queue connection sets `enableOfflineQueue: false`; if Redis is unreachable,
  `POST /ingest/jobs` returns 503 immediately with a typed error. Never let
  an upload sit in an offline queue and run later.
- `split` and `process-chunk` are handler-shaped functions
  `(event, ctx) => Promise<void>` with `ctx.remainingTimeMs()`. The BullMQ
  worker is a thin adapter that builds `ctx` from
  `INGEST_INVOCATION_TIMEOUT_MS`; a Lambda handler would call the same
  functions. Logic never lives inside a `Worker` callback.
- **Splitter:** streams the CSV (`csv-parse` in stream mode, never
  `fs.readFile`), emits chunks of `INGEST_CHUNK_SIZE` rows as
  `chunks/{jobId}/{index}.jsonl`, inserts an `ingest_chunks` row, enqueues
  `{jobId, chunkIndex}` with a deterministic job id. The checkpoint is
  `next_chunk_index` only, persisted after every chunk (`GREATEST` on
  write); resume re-streams from the start and skips that many records with
  the parser's `from` option — no byte offsets, CSV records do not align
  with bytes safely. It checks `remainingTimeMs()` between chunks and
  re-enqueues itself when time is low, guaranteeing at least one chunk per
  invocation. When the stream ends it sets `status = 'SPLIT_DONE'` and runs
  the completion check.
- **Processor:** handles exactly one chunk per invocation. First statement
  claims the row: `UPDATE ingest_chunks SET status='PROCESSING',
  attempts = attempts + 1 WHERE job_id=$1 AND chunk_index=$2 AND (status IN
  ('PENDING','FAILED') OR (status='PROCESSING' AND updated_at < now() -
  invocation_timeout))` — zero rows affected means exit without doing
  anything. On any thrown error: set `status='FAILED'` in a separate
  statement outside the failed transaction, then rethrow so the queue retry
  can reclaim.
- Validate every row with zod **before** any DB write. Partition valid/
  invalid. A row whose *priced* value exceeds `numeric(12,2)` is invalid too
  — bound the output of the pricing rules, not just the input. Invalid rows
  go to `ingest_row_errors` with `ON CONFLICT (job_id, row_no) DO NOTHING`
  so a reclaimed chunk never duplicates them; they never throw and never
  fail the chunk. `GET /ingest/jobs/:id/errors` exposes them.
- Apply pricing rules (`src/ingest/pricing-rules.ts`) in the application
  layer: pure functions over one row, `decimal.js`. This is the "dynamic
  pricing rules" step from the brief.
- Duplicate SKUs within one chunk are deduped in memory (highest `row_no`
  wins) before the upsert; Postgres rejects touching one row twice in a
  statement. Across chunks the same rule is enforced by `source_seq`.
- Every row carries `source_seq = (job_seq << 32) | row_no` as a bigint,
  computed in SQL from `$job_seq` and `$row_no`. `CHECK (job_seq < 2^31)`.
- **Sort the batch by `sku`** before the upsert.
- Upsert is one statement using `unnest` arrays (parameter count is
  constant; `INGEST_CHUNK_SIZE ≤ 10000` is a memory bound, not a SQL bound):
  `INSERT ... ON CONFLICT (sku) DO UPDATE SET ... WHERE EXCLUDED.source_seq >
  products.source_seq RETURNING sku, OLD.category_id, NEW.category_id,
  OLD.base_price IS DISTINCT FROM NEW.base_price AS price_changed`
  (Postgres 18 `OLD`/`NEW` in `RETURNING`; do not use the `xmax = 0` trick).
  The chunk row records `changed_category_ids` and the three row counts;
  no SKU lists.
- Categories are resolved with `INSERT ... ON CONFLICT (name) DO NOTHING`
  followed by a select.
- **Job completion** is derived, never counted: one conditional `UPDATE`
  that sets `COMPLETED` when `status = 'SPLIT_DONE'` and no `ingest_chunks`
  row is outside `DONE`, or `PARTIAL` if any chunk is `FAILED` after max
  attempts. The splitter (at `SPLIT_DONE`), every processor (after `DONE`
  or `FAILED`) and the replay endpoint (after its flip) run it; whoever
  finishes last transitions. There is no `processed_chunks` counter. The
  completion transition triggers the cache bump.
- Worker concurrency is capped via `INGEST_WORKER_CONCURRENCY`. Never
  `Promise.all` over all chunks.
- Failed chunks after `INGEST_MAX_ATTEMPTS` are marked `FAILED` and moved to
  the DLQ queue. `POST /ingest/jobs/:id/replay-failed` re-enqueues FAILED
  and stale-PROCESSING chunks (and an unfinished split). Under BullMQ, `add`
  is silently ignored if a job with the same id exists in any state,
  including the failed set — always `remove` the existing record before
  re-enqueueing. Enqueue first, then reset that chunk from `FAILED` to
  `PENDING` (a FAILED chunk at max attempts reads as terminal to the
  completion check); flip the job from `PARTIAL` back to `SPLIT_DONE` only
  after every enqueue succeeded, then run the completion check. The
  `source_seq` guard makes replay safe in any order.

### Storage / queue abstractions
- `Storage` interface (`put` from stream, `getStream`, `exists`, `delete`)
  with a local-filesystem implementation (key validation, atomic
  temp+rename writes) under `STORAGE_DIR`. Comment the S3 mapping; do not
  add the AWS SDK.
- Queue access goes through a thin `Queue<T>` interface (enqueue with
  deterministic id, remove, consume) over BullMQ so the SQS mapping in the
  ADR is honest. `MemoryQueue` exists for pipeline-logic tests only.

## Code conventions

- Folder layout: `src/{config,db,cache,queue,storage,products,promotions,ingest,shared}`.
- Route handlers are thin: parse → call service → map result/error to HTTP.
  Services are plain classes with dependencies in the constructor; no nested
  closure factories.
- Errors are typed (`NotFound`, `Conflict`, `Validation`, `Unavailable`) and
  mapped in one error middleware. Postgres unique/FK/check violations map by
  constraint name.
- Structured logs with a request id; no `console.log`.
- Tests run against `TEST_DATABASE_URL` / `TEST_REDIS_URL`, never the dev
  database; the global setup refuses to run if they are equal. Unit tests
  need no infrastructure. SQL fragments are "unit"-tested by executing them.
- Any behaviour that depends on driver semantics (queue re-enqueue, DLQ,
  Redis timeouts) needs at least one integration test against the real
  driver. The in-memory queue is more forgiving than BullMQ and will not
  catch driver-level bugs.
- Measurements are scripts, not claims: `scripts/ingest/measure.sh` (500k
  rows under a 128 MB heap cap and a forced-short timeout) and
  `scripts/load/run.ts` (flash-sale p95/p99, single-flight on/off). ADR
  numbers come from these.

## Things you will be tempted to do — don't

- Compute effective price in TypeScript after fetching rows.
- Add an `effective_price` column or a materialization job "for performance".
- Use offset pagination "for simplicity".
- Read the whole CSV into memory or process it in one worker call.
- Resume a CSV stream by byte offset.
- Track ingest progress with a counter.
- Upsert an unsorted batch, or a batch with duplicate SKUs.
- Use `parseFloat` on a price.
- Enumerate cache keys with `SCAN`/`KEYS`.
- Let an ingest upload wait in an offline queue.
- Trust the in-memory queue for driver semantics.
- Generate the ADR or AI appendix content.