# Architecture Decision Record — Promotion Management API

**Status:** Measured — every `[MEASURE]` placeholder has been replaced with a number from `scripts/`
**Author:** Mehmet İmirhan
**Date:** September 2026

> Numbers in §4, §6 and §7 come from `scripts/load/run.ts` and
> `scripts/ingest/measure.sh`; the environment is stated next to each set.

---

## 0. Summary of decisions

| # | Decision | One-line rationale |
|---|----------|--------------------|
| 1 | Express + TypeScript, Postgres 18, Redis, BullMQ; Kysely query builder, plain SQL migrations | Brief mandates Express; Postgres gives DB-level invariants the domain needs; the builder makes the single pricing expression composable and type-enforced |
| 2 | "One active promotion per product" enforced by Postgres `EXCLUDE` constraints, not app code | Eliminates the check-then-insert race; concurrent writers serialize on the constraint |
| 3 | Effective price is **computed at read time**, never stored on products | Flash sale = 1 row insert; auto-inherit is free; satisfies the brief's "instantly" |
| 4 | Product-scope promotion beats category-scope (precedence rule) | Cross-scope conflicts can't be a DB constraint; precedence resolves them deterministically |
| 5 | Keyset (cursor) pagination on `(effective_price, id)` | Effective price is computed, so neither scheme can index-skip; keyset is chosen for page stability while a campaign reprices the sort order, and the cursor is bound to its `order` and `category_id` |
| 6 | Cache-aside Redis on product detail and listing; versioned cache keys per category; single-flight on miss | O(1) invalidation for a 50k-product campaign; no thundering herd on cold cache |
| 7 | Ingest = splitter → queue → processors; every invocation bounded and resumable | Serverless timeout/memory constraints; no single invocation depends on file size |
| 8 | Newest-wins upsert via monotonic `source_seq` | Makes parallel and out-of-order (DLQ replay) processing safe by construction |

---

## 1. Context and constraints

The service provides an internal catalog and promotion API with three hard
requirements that shape the whole design:

1. **Sorting by effective price with pagination.** Effective price must be
   computable *inside the database query*; computing it in the application
   layer after fetching a page produces a wrong global order.
2. **Flash sales must take effect instantly across 50,000+ products**, and a
   product added to the category during the sale must inherit the discount
   automatically.
3. **Vendor ingestion of 500k+ row files must run on a serverless consumption
   plan**: strict timeout (minutes), restricted memory, stateless invocations.

Non-functional constraints I set for myself: the system must start with
`docker-compose up` on a reviewer's machine; money must never be represented
as a float; every invariant that *can* live in the database *does*.

**Money representation.** Prices are strings in TypeScript and `numeric` in
Postgres; all price arithmetic happens in SQL. The one exception is the ingest
pricing-rules step (§7), which must compute in the application layer: it uses
`decimal.js` and converts back to a string before the upsert. No `parseFloat`,
`Number()`, or float arithmetic touches a price anywhere.

---

## 2. Stack

**Decision:** Express + TypeScript (per brief), PostgreSQL 18 (built-in `uuidv7()`
primary keys for index locality; `OLD`/`NEW` in `RETURNING` for change
detection during ingest; richer `EXPLAIN ANALYZE` for the measurements in this
document), Redis 7, BullMQ,
Kysely as a type-safe query builder — the effective-price query is built once as
a composable function that both the listing and detail endpoints extend, which
makes the "one pricing expression" rule enforceable by the type system rather
than by discipline — with raw `sql` fragments where the builder cannot express
something. Migrations are plain SQL. Also `csv-parse` for streaming, `zod` for
validation, `decimal.js` for ingest pricing arithmetic, `pino` for structured
logs, `vitest` for tests.

**Why not an ORM (Prisma/TypeORM)?** Two of the most important decisions in this
document — the `EXCLUDE` constraints (§3) and the lateral-join effective price
query with keyset pagination (§4–5) — are either inexpressible or awkward in
ORM abstractions and would require escaping to raw SQL anyway. A query builder
keeps type safety for the boring 80% and gets out of the way for the 20% that
matters.

**Trade-off:** less scaffolding "for free" (no generated client, no schema
diffing). Accepted: the schema is small and hand-written DDL is a deliverable
anyway.

---

## 3. Domain model and the one-active-promotion invariant

### Schema

See `db/migrations/0001_init.sql`. Key points:

- `products.base_price numeric(12,2)`; all money is `numeric`, never `float`.
- `promotions` has nullable `product_id` and `category_id` with
  `CHECK (num_nonnulls(product_id, category_id) = 1)` — exactly one scope.
- `promotions.status` is `ACTIVE | CANCELLED`. Cancellation is a status flip,
  not a delete: the row is kept for audit, and partial constraints (below)
  stop treating it as blocking.

### The invariant

"A product can have at most one active promotion at a time" is enforced by two
partial exclusion constraints (`btree_gist` extension). Postgres 18 added
temporal `WITHOUT OVERLAPS` constraints, but those attach to PRIMARY KEY /
UNIQUE and cannot be partial; the cancel-as-status-flip decision below requires
a `WHERE status = 'ACTIVE'` predicate, so `EXCLUDE` remains the right tool:

```sql
CONSTRAINT no_overlapping_product_promos EXCLUDE USING gist (
  product_id WITH =, tstzrange(starts_at, ends_at) WITH &&
) WHERE (product_id IS NOT NULL AND status = 'ACTIVE'),

CONSTRAINT no_overlapping_category_promos EXCLUDE USING gist (
  category_id WITH =, tstzrange(starts_at, ends_at) WITH &&
) WHERE (category_id IS NOT NULL AND status = 'ACTIVE')
```

**Options considered**

| Option | Assessment |
|--------|------------|
| A. App-level check-then-insert | Race window between SELECT and INSERT; needs `SELECT ... FOR UPDATE` or advisory locks to close; logic duplicated in every write path |
| B. Advisory / row locks around creation | Correct but procedural; a forgotten lock in one code path silently reintroduces the race |
| **C. Postgres `EXCLUDE` constraints (chosen)** | Impossible to violate from any code path; concurrent inserts serialize on the index; loser gets SQLSTATE `23P01`, mapped to HTTP 409 |

The two partial GiST indexes created by the EXCLUDE constraints double as the
lookup indexes for the effective-price join in §4: `btree_gist` supports
equality on `product_id` / `category_id`, and the range condition
`tstzrange(starts_at, ends_at) @> now()` is an index condition too. The lateral
join's `OR` on scope resolves to a BitmapOr over them. No separate btree
indexes are needed; measured at 50k products, adding them changed nothing.

**What the constraints deliberately do not cover:** cross-scope conflict — a
product-scope and a category-scope promotion both touching the same product.
This is resolved by the **precedence rule** (§4): product-scope wins. The brief
says conflicts "must be handled logically"; the logic is constraint for
same-scope, precedence for cross-scope.

### Validation choices

- Fixed-amount promotions are rejected at creation if `value >= base_price`
  **for product scope only**. For category scope this check is meaningless
  (products have different prices, and new products arrive later), so the
  effective price computation floors at zero (`GREATEST(0, ...)`) as
  defense-in-depth.
- Percentage discounts round half-up to 2dp.
- A promotion can be re-targeted (`POST /promotions/:id/assign`) in one
  `UPDATE` of its scope columns. The EXCLUDE constraints validate the new
  target exactly as they validate an insert (overlap → 409), the product-scope
  FIXED rule above is re-checked against the new product, and a cancelled
  promotion cannot be assigned (409): cancellation is final, create a new one.

---

## 4. Scenario B — Flash sales: effective price computed at read time

### Decision

Effective price is **derived in the query** via a lateral join that selects the
winning active promotion for each product (product-scope first, then
category-scope), and is never stored on the `products` row.

```sql
SELECT p.*,
       COALESCE(promo.effective_price, p.base_price) AS effective_price
FROM products p
LEFT JOIN LATERAL (
  SELECT CASE pr.discount_type
           WHEN 'PERCENTAGE' THEN ROUND(p.base_price * (1 - pr.value / 100), 2)
           WHEN 'FIXED'      THEN GREATEST(0, p.base_price - pr.value)
         END AS effective_price
  FROM promotions pr
  WHERE pr.status = 'ACTIVE'
    AND tstzrange(pr.starts_at, pr.ends_at) @> now()
    AND (pr.product_id = p.id OR pr.category_id = p.category_id)
  ORDER BY (pr.product_id IS NOT NULL) DESC   -- product scope wins
  LIMIT 1
) promo ON true
WHERE p.category_id = $1
ORDER BY effective_price ASC, p.id ASC
LIMIT $2;
```

Creating "50% off Accessories" is **one row insert**, regardless of whether the
category has 50 or 50,000 products. A product inserted into the category one
second later is discounted on its first read with no additional code.

**How products enter the catalog.** Two write paths: the vendor ingest
pipeline (§7) and a minimal `POST /products` for operational use. The brief
does not require product CRUD, but Scenario B's "brand new product added while
the sale is active" needs a way to add one, and having both paths lets the
auto-inherit test exercise the API path and the ingest path.

### Options considered

**Option A — Read-time computation (chosen)**

| Dimension | Assessment |
|-----------|------------|
| Write cost of a campaign | One row |
| Consistency | Transactional; visible in the next query |
| Auto-inherit | Free (join on category) |
| Scheduled promotions | Free (`tstzrange @> now()` evaluated per query) |
| Read cost | Lateral join (cheap — active promos per product/category ≈ 1–2 rows, hit via the two partial indexes in §3) plus a sort over the filtered set — cannot use an index for `ORDER BY effective_price` |
| Complexity | One non-trivial query; one pricing rule in one place |

**Option B — Write-time materialization**

`effective_price` column on `products`, recomputed on every promotion change;
category promotions trigger an asynchronous bulk update (`202 Accepted`).

| Dimension | Assessment |
|-----------|------------|
| Write cost of a campaign | 50k-row `UPDATE` — WAL, vacuum bloat, replication lag, lock contention with storefront reads |
| Consistency | **Fails the brief's "instantly"**: there is a materialization window (and a mirror window on cancel) during which prices are inconsistent |
| Auto-inherit | Must be re-implemented in *every* write path that touches a product — API create, vendor ingest, base-price updates |
| Scheduled promotions | Requires a scheduler to materialize at `starts_at` and revert at `ends_at` — an entire subsystem Option A doesn't need |
| Concurrency | Materialization is a race by construction: a product-scope promo created mid-materialization can be overwritten; a cancel mid-apply must revert rows not yet written. Every bug here is a pricing bug |
| Read cost | Indexed btree scan; trivially fast; cold cache barely hurts |

**Option C — Hybrid** (read-time truth + async-refreshed sort column): rejected;
two representations of price that can disagree is the worst of both.

### Trade-off analysis

Option B optimizes the read path at the cost of correctness windows, a
scheduler, distributed pricing logic, and write amplification. Option A keeps
one source of truth and one pricing rule, and pays for it with a sort that
cannot use an index. That cost is bounded by category size and, measured on
this implementation (`scripts/load/run.ts`, cache bypassed, 50 timed runs of
the first page, 50,000-product category inside a 537k-row `products` table,
Postgres in Docker on an Apple Silicon laptop carrying a load average of ~9
from other applications; median of six runs):

- Uncached sorted listing, 50k-product category, p95: 147 ms
- Same, p99: 153 ms (p50: 138 ms)

`EXPLAIN (ANALYZE, BUFFERS)` shows where it goes: a scan of the category
(~88 ms as a seq scan over the 537k-row table; forcing the category index
saves ~15 ms, not worth overriding the planner), 50,000 lateral probes into
the two partial GiST indexes (~110 ms, every buffer a cache hit), and a
top-N heapsort for the page (27 kB). Two findings from measuring rather than
reasoning:

- **Postgres JIT was doubling it.** Once autoanalyze had accurate row counts
  for the category, the plan's estimated cost crossed `jit_above_cost` and
  every execution paid ~140 ms of LLVM inlining, optimization and emission
  on top of ~145 ms of execution — JIT work is not cached across statements.
  The pool now sends `-c jit=off` as a libpq startup option; this service
  runs nothing that benefits from JIT.
- The per-product lateral probe, not the sort, is the dominant term. That is
  what "revisit when a category exceeds a few hundred thousand products"
  in §8 refers to.

The strongest objection to Option A — "your cache goes cold at
the exact moment traffic spikes" — is addressed in §6.

I have operated both patterns in production (a denormalized read model with
convergent re-fetch idempotency serving 250k+ daily orders). The operational
lesson that informs this decision: derived-price drift is the class of bug
that costs money and is hardest to detect. Given a choice, keep pricing logic
in one query.

---

## 5. Pagination

**Decision:** keyset pagination with an opaque cursor encoding the sort key
`(effective_price, id)` plus the listing scope `(order, category_id)`; `id`
is the tiebreaker so the order is total.

**Why keyset — and why not for the usual reason.** The textbook case for
keyset is that `WHERE (sort_key, id) > ($k, $id)` can use an index and skip
straight to the page boundary. That does not apply here: `effective_price`
is computed per row by the lateral join (§4), so no index exists to skip
into, and both keyset and offset evaluate the pricing expression for every
product in the filtered set before sorting. The cost difference is only the
offset discard — marginal.

The argument that does apply is **page stability under concurrent writes.**
The listing is the storefront during flash sales, and a campaign reprices
thousands of products in the sort order at once. Offset counts positions,
and positions move: a product can be skipped or repeated across pages when
the ordering changes between requests. A keyset cursor is a fact about the
last row seen, not a position, so rows that move elsewhere in the ordering
cannot shift the page. Only a product whose own effective price crosses the
boundary mid-walk can be missed or repeated, and no stateless pagination
avoids that without a snapshot. Secondary benefit: cursors are cleaner
cache keys than page numbers under the versioned-key scheme in §6.

**Cursor contract.** The cursor also carries the `order` and `category_id`
that produced it. A cursor sent back with a different `order` or
`category_id` returns `400` rather than silently returning a valid page of a
different listing. `limit` is not bound to the cursor and may change between
pages.
Cursors are opaque tokens precisely so the server can enforce this; a
contract that lives only in documentation is one a client bug will break
without anyone noticing.

**Trade-off:** no "jump to page N". Acceptable for a storefront listing.

---

## 6. Caching and load distribution

**Product detail (`GET /products/:id`)** — the hottest endpoint. Cache-aside in
Redis, TTL 300s, keyed by `product:{id}:v{categoryVersion}`.

**Product listing (`GET /products`)** — cached per
`(category, filters, sort, cursor)` with a 60s TTL, keyed with the same
category version. TTLs only bound staleness from paths that do not bump the
version; every known write path does, so the TTL is a safety net, not the
invalidation mechanism.

**Invalidation without a 50k-key delete.** Each category has a version counter
in Redis (`catver:{categoryId}`). Creating, cancelling or assigning a promotion
(assign bumps the category it left and the one it landed in), creating a
product through the API, or completing an ingest job that touched the category
increments the counter — one `INCR` each. Ingest deliberately bumps
once per affected category at job completion, never per row, and only for
categories in which at least one price actually changed (§7). Product keys are
never deleted individually or enumerated (`SCAN`/`KEYS`). Every key containing
the old version becomes unreachable and expires naturally. Invalidation is
O(1) regardless of category size.

**Two details the key scheme needed that the sketch above does not show.**
The detail request carries only a product id, so the category whose version
the key embeds is not known up front; the product → category mapping is
cached beside the detail entry (24 h, refreshed on every miss, corrected
when a fresh read disagrees with it). And the version token is
category-qualified (`{categoryId}.{n}`), because per-category counters
collide numerically and a product that ingest moved from one category to
another must not find a stale key written under the other category's
identical number. For the same reason the ingest upsert reports a row's
previous category, and a move bumps both. The unfiltered listing keys on
`catver:_all`, incremented alongside every category bump.

**Fail-open, including the version read.** Every Redis touch — version
read, GET, SET, INCR — is caught; the request is served from Postgres and
the outage is logged once per transition, not per request. "Down" is not
the only failure: the client carries a 500 ms `commandTimeout`, so a Redis
that accepts connections but stalls fails open too, and a cached entry that
does not parse is treated as a miss and overwritten, never surfaced. Single-flight
still applies while Redis is down, so a Redis outage during a sale does not
become a Postgres stampede. Redis is a latency optimization, never a
dependency for correctness.

**Stampede protection.** A version bump makes every cached page of that
category cold at once — by design, at the moment a flash sale starts and
traffic peaks. Two mitigations were considered:

1. **Single-flight / request coalescing.** On a cache miss, one request runs the
   query while concurrent requests for the same key await its result via an
   in-process promise map, so the herd becomes one query per replica. Across
   instances that is still one query each; a short Redis `SET NX`
   lock would reduce that to one in total. **Deferred:** the measurements
   below show per-replica coalescing holds the cold-window p99 within a few
   milliseconds of the warm one; the cross-instance lock is the first thing
   to add if a multi-replica deployment measures otherwise.
2. **Warm the first pages after a promotion write.** **Deferred, with the
   number as the justification:** the cold-cache listing p99 with
   single-flight (13.8 ms) is indistinguishable from the warm p99 (11.0 ms).
   Warming would add code to the write path to save one query per page per
   replica. If a deployment measures a cold p99 that matters, warming the
   first two pages of the affected category's default sort is about twenty
   lines.

Measured under simulated flash sale (`scripts/load/run.ts`, autocannon:
32 connections walking pages 1–3 of the 50k-product category by cursor plus
32 connections reading a 2,000-product hot set, promotion created mid-run;
same laptop and background load as §4; median of three alternating runs per
configuration, cold window = the 10 s after the bump):

- Listing p99 with warm cache: 11.0 ms
- Listing p99 during version bump with single-flight: 13.8 ms
- Listing p99 during version bump *without* single-flight (for comparison): 21.1 ms

The p99 line understates the comparison, because the listing herd is only
three keys. The full picture per window:

| | with single-flight | without |
|---|---|---|
| Listing req/s, warm → cold window | 5,129 → 4,250 | 2,620 → 1,201 |
| Listing max latency, cold window | 472 ms | 3,916 ms |
| Detail p99, warm → cold window | 14.0 → 20.3 ms | 57.4 → 2,137 ms |
| Detail req/s, cold window | 3,570 | 297 |

Without coalescing the 2,000 hot detail keys go cold together and every
duplicate miss becomes its own query; the 10-connection pool saturates and
the backlog, not the query time, sets the tail. Even the "warm" window of
the no-coalescing runs is degraded — its throughput is half and its max
latency 3 s — because the process-start herd had not drained through the
pool within the 3 s warm-up. With coalescing the same bump costs one query
per key per replica and is invisible at p99.

**Detail endpoint cost.** A warm detail hit is three sequential Redis round
trips (mapping, version, entry), which is why its p99 sits ~3 ms above the
listing's. Folding them into one Lua script is the follow-up if that ever
matters; at these numbers it does not.

---

## 7. Scenario A — Vendor ingestion on a serverless consumption plan

### Decision

A three-stage, queue-backed pipeline in which **no single invocation's work
depends on the size of the file**:

```
POST /ingest/jobs ──▶ ingest_jobs (202)
                        │
                        ▼
                   [Splitter]  stream CSV → chunks/{job}/{i}.jsonl → enqueue {job, i}
                        │      checkpoints next_chunk_index; re-enqueues itself
                        │      when remaining time is low
                        ▼
                     [Queue]   BullMQ locally · SQS + redrive policy in production
                        │
                        ▼
                  [Processor]  one chunk per invocation: validate → pricing rules →
                               sorted bulk upsert (newest-wins) → mark chunk DONE
```

The HTTP process never touches row data.

### The pricing rules step

The brief requires that vendor data pass through internal dynamic pricing rules
before being saved. In this implementation (`src/ingest/pricing-rules.ts`) the
rules are: base price = vendor cost × (1 + margin), with the margin configurable
per category and a global floor; rounding to the category's price-ending rule
(e.g. `.99`); rows priced below vendor cost after rounding are rejected as row
errors. The rules are pure functions over one row, unit-tested in isolation,
and computed with `decimal.js`. They are the reason ingest cannot be a
`COPY` into the products table.

### Failure modes and how each is handled

| Failure | Handling |
|---------|----------|
| Splitter times out or crashes mid-file | Checkpoint `next_chunk_index` persisted after every chunk (`GREATEST`, so two overlapping runs never move it backwards); on resume the splitter streams from the start of the file and skips `next_chunk_index × CHUNK_SIZE` records through the parser (byte offsets are not safe resume points in CSV: they can land inside a multi-byte character or a quoted field); deterministic chunk filenames make rewrites idempotent; splitter checks remaining time and re-enqueues itself before the limit — any invocation is bounded and a retry costs at most one re-read of the file |
| Chunk processed twice (splitter retry re-enqueues, or a stale reclaim of a worker that was slow rather than dead) | `ingest_chunks (job_id, chunk_index)` PK; processor's first statement is `UPDATE ... SET status='PROCESSING', attempts = attempts + 1 WHERE status IN ('PENDING','FAILED') OR (status = 'PROCESSING' AND updated_at < now() - invocation_timeout)`; zero rows → already handled, exit. If both runs do get through, the upsert is a no-op on equal `source_seq` and row errors are `ON CONFLICT (job_id, row_no) DO NOTHING`, so the second run changes nothing |
| Processor crashes mid-chunk, leaving the row `PROCESSING` | On any thrown error the processor sets `status='FAILED'` in a separate statement outside the failed transaction, then rethrows so the queue retry can reclaim. For hard crashes where even that does not run, `POST /ingest/jobs/:id/replay-failed` also re-enqueues `PROCESSING` rows whose `updated_at` is older than the invocation timeout; the processor's claim statement makes a double replay harmless. Replay removes the queue record before re-adding it (BullMQ ignores an add whose id exists in any state, including the failed set; SQS FIFO deduplicates the same way), resets each queued chunk from `FAILED` to `PENDING`, flips the job from `PARTIAL` back to `SPLIT_DONE` only after every enqueue succeeded, and runs the completion check itself |
| Completion detected too early (processors finish before splitter sets total) | No counter. Job is complete when splitter status is `SPLIT_DONE` **and** no chunk is non-DONE; checked by whichever finishes last: the splitter at `SPLIT_DONE`, every processor after `DONE` or `FAILED`, and the replay endpoint after its flip |
| Same SKU appears twice in one file, chunks land out of order, or a DLQ'd chunk is replayed later | Monotonic `source_seq = (job_seq << 32) \| row_no` on every row; `ON CONFLICT (sku) DO UPDATE ... WHERE EXCLUDED.source_seq > products.source_seq`. Newest wins in any order; an old job's replay can never overwrite a newer job's data |
| Concurrent multi-row upserts deadlock | Every batch is `ORDER BY sku` before upsert — deterministic lock order |
| Same SKU twice in one chunk | Postgres rejects an `ON CONFLICT DO UPDATE` that touches one row twice, so the processor keeps only the highest `row_no` per SKU before the upsert — the same newest-wins rule `source_seq` applies across chunks |
| Chunk size vs. SQL parameter limits | Not a constraint: the upsert passes one array per column (`unnest`), so its parameter count is constant. `INGEST_CHUNK_SIZE` (max 10,000) is a memory bound — one chunk is what a splitter or processor invocation holds |
| One malformed row poisons a 1,000-row chunk | Validate first; partition valid/invalid; upsert valid; record invalid in `ingest_row_errors`. The bound applies to the *priced* value too: a cost that fits the schema can still price past `numeric(12,2)`, and that row is an error, not a failed upsert. Row errors are data, not exceptions, and are read back through `GET /ingest/jobs/:id/errors` |
| Two processors create the same new category | `INSERT ... ON CONFLICT (name) DO NOTHING` then select |
| 500 chunks fan out to 500 DB connections | The queue is the throttle: worker concurrency cap locally; reserved concurrency + RDS Proxy/PgBouncer in production |
| Stale cache after prices change | `RETURNING category_id, OLD.base_price IS DISTINCT FROM NEW.base_price` (Postgres 18) from the upsert tells the processor which categories had a real price change; those categories are bumped once each at job completion. No per-row or per-SKU cache writes |
| Vendor re-uploads the same file | `UNIQUE (vendor_id, file_checksum)`; re-POST returns the existing job |
| Queue unreachable when the upload arrives | The queue is a hard dependency for ingest, not a fail-open one: the API's producer connection has no offline queue, so the enqueue rejects at once and the handler answers `503` naming the job it already recorded. The same upload again returns that job with `200` and re-offers the split. An upload must never wait in an offline queue and run later |
| Float precision | Prices parsed as strings into `numeric`; no `parseFloat` anywhere in the pipeline |

### Local ↔ production mapping

| Concern | Local (this repo) | Production |
|---------|-------------------|------------|
| Object storage | `uploads/` directory behind a `Storage` interface | S3 |
| Splitter trigger | BullMQ `split` job | Lambda on `S3:ObjectCreated` |
| Queue | BullMQ on Redis | SQS with redrive policy → DLQ |
| Processor | `npm run worker` (concurrency-capped) | Lambda with SQS event source mapping, reserved concurrency |
| DLQ replay | `POST /ingest/jobs/:id/replay-failed` (remove + re-add by message id) | SQS redrive to source |

The pipeline code is identical in both modes; only the adapters differ.

Measured (`scripts/ingest/measure.sh`: 500,000 generated rows, 24.4 MB,
2,575 malformed rows, chunk size 1,000, worker concurrency 4, API and both
workers under `node --max-old-space-size=128`, Apple Silicon laptop, Postgres
and Redis in Docker):

| | normal timeout (60 s) | forced continuations (1.5 s timeout) |
|---|---|---|
| Wall time, upload accepted → `COMPLETED` | 27.0 s | 93.4 s |
| Rows/sec sustained | 18,500 | 5,360 |
| Splitter invocations | 1 | 74 (73 continuations) |
| Chunks: expected / written / processed twice | 500 / 500 / 0 | 500 / 500 / 0 |
| Peak RSS: API during upload | 120 MB | 123 MB |
| Peak RSS: splitter | 159 MB | 162 MB |
| Peak RSS: chunk worker (4 concurrent chunks) | 195 MB | 196 MB |

The RSS figures include native memory (V8 code, pg and Redis client
buffers); the 128 MB flag caps the JS heap, and no process approached it.
Memory did not move between the two runs or with file size — it is a
function of chunk size and concurrency only.

The forced-continuation run is the cost of the record-skip resume made
visible: each continuation re-parses everything before its checkpoint, so
chunks written per invocation fell from 93 in the first invocation to 1 in
the last, and the split phase dominated the wall time while processing kept
pace. At any realistic function timeout (minutes) a 500k-row file splits in
one invocation; the measurement exists to prove the continuation path is
correct (zero duplicate chunks, byte-identical chunk files in the test
suite), not to run there. Should files grow to the point where the skip
phase itself approaches the timeout, the checkpoint would switch to the
byte offset of the last record boundary the parser reported — which is
safe, unlike an arbitrary offset — at the cost of storing the header
columns on the job.

---

## 8. Consequences

**Easier:** promotions are one row; scheduled promotions need no scheduler;
pricing logic lives in one query; every invariant is database-enforced;
ingestion scales with file size without code changes.

**Harder:** the effective-price query is non-trivial and must be understood to
be maintained; the per-product promotion probe and the sort cannot use an
index for the order, so caching is load-bearing for the storefront (~150 ms
uncached vs ~11 ms cached at p99, §4/§6); keyset cursors over a computed
value need care; the detail cache needs a product → category mapping.

**Revisit when:** a single category exceeds a few hundred thousand products
(sort cost grows; consider a partial materialized sort key refreshed by the
ingest pipeline — *not* by promotion writes); multi-promotion stacking rules
are introduced (precedence rule generalizes to a priority column).

---

## 9. What I would do at production scale (out of scope here)

Read replica for the listing query; outbox-based cache invalidation instead of
post-commit hooks; OpenTelemetry tracing across the ingest pipeline; per-vendor
rate limiting on ingest; schema registry / versioned CSV contracts; partitioning
`ingest_row_errors` by job.
