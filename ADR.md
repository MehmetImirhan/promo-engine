# Architecture Decision Record — Promotion Management API

**Status:** Draft — to be finalized after implementation and measurement
**Author:** Mehmet İmirhan
**Date:** September 2026

> Sections marked `[MEASURE]` are placeholders for numbers produced by the load
> and ingest scripts in `scripts/`. Do not ship the ADR with placeholders.

---

## 0. Summary of decisions

| # | Decision | One-line rationale |
|---|----------|--------------------|
| 1 | Express + TypeScript, Postgres, Redis, BullMQ; Kysely for SQL | Brief mandates Express; Postgres gives DB-level invariants the domain needs; hand-written SQL on hot paths |
| 2 | "One active promotion per product" enforced by Postgres `EXCLUDE` constraints, not app code | Eliminates the check-then-insert race; concurrent writers serialize on the constraint |
| 3 | Effective price is **computed at read time**, never stored on products | Flash sale = 1 row insert; auto-inherit is free; satisfies the brief's "instantly" |
| 4 | Product-scope promotion beats category-scope (precedence rule) | Cross-scope conflicts can't be a DB constraint; precedence resolves them deterministically |
| 5 | Keyset (cursor) pagination on `(effective_price, id)` | Offset pagination degrades linearly and drifts under concurrent writes |
| 6 | Cache-aside Redis on product detail; versioned cache keys per category; single-flight on miss | O(1) invalidation for a 50k-product campaign; no thundering herd on cold cache |
| 7 | Ingest = splitter → queue → processors; every invocation bounded and resumable | Serverless timeout/memory constraints; no single invocation depends on file size |
| 8 | Newest-wins upsert via monotonic `source_seq` | Makes parallel and out-of-order (DLQ replay) processing safe by construction |

---

## 1. Context and constraints

Project needs an internal catalog and promotion API with three hard requirements
that shape the whole design:

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

---

## 2. Stack

**Decision:** Express + TypeScript (per brief), PostgreSQL 18 (built-in `uuidv7()`
primary keys for index locality; `OLD`/`NEW` in `RETURNING` for change
detection during ingest; richer `EXPLAIN ANALYZE` for the measurements in this
document), Redis 7, BullMQ,
Kysely as a type-safe query builder with plain SQL migrations, `csv-parse` for
streaming, `zod` for validation, `pino` for structured logs, `vitest` for tests.

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

### Options considered

**Option A — Read-time computation (chosen)**

| Dimension | Assessment |
|-----------|------------|
| Write cost of a campaign | One row |
| Consistency | Transactional; visible in the next query |
| Auto-inherit | Free (join on category) |
| Scheduled promotions | Free (`tstzrange @> now()` evaluated per query) |
| Read cost | Lateral join (cheap — active promos per category ≈ 1–2 rows, indexed) plus a sort over the filtered set — cannot use an index for `ORDER BY effective_price` |
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
this implementation, is small:

- Uncached sorted listing, 50k-product category, p95: `[MEASURE] ms`
- Same, p99: `[MEASURE] ms`

The interviewer's strongest objection to Option A — "your cache goes cold at
the exact moment traffic spikes" — is addressed in §6.

I have operated both patterns in production (a denormalized read model with
convergent re-fetch idempotency serving 250k+ daily orders). The operational
lesson that informs this decision: derived-price drift is the class of bug
that costs money and is hardest to detect. Given a choice, keep pricing logic
in one query.

---

## 5. Pagination

**Decision:** keyset pagination with an opaque cursor encoding
`(effective_price, id)`; `id` is the tiebreaker so the order is total.

Offset pagination over a computed sort key degrades linearly (`OFFSET 10000`
still computes and sorts 10,000 rows) and drifts when products are inserted or
promotions change between pages. Keyset pagination over a computed value is
slightly subtle — the cursor must carry the computed value, and the `WHERE`
must be `(effective_price, id) > ($cursor_price, $cursor_id)` — but it is
stable and O(page).

Trade-off: no "jump to page N". Acceptable for a storefront listing.

---

## 6. Caching and load distribution

**Product detail (`GET /products/:id`)** — the hottest endpoint. Cache-aside in
Redis, TTL `[decide, e.g. 300s]`, keyed by
`product:{id}:v{categoryVersion}`.

**Product listing (`GET /products`)** — cached per
`(category, filters, sort, cursor)` with a short TTL, keyed with the same
category version.

**Invalidation without a 50k-key delete.** Each category has a version counter
in Redis (`catver:{categoryId}`). Creating or cancelling a promotion (or
completing an ingest job that touched the category) increments the counter —
one `INCR`. Every key containing the old version becomes unreachable and
expires naturally. Invalidation is O(1) regardless of category size.

**Stampede protection.** A version bump makes every cached page of that
category cold at once — by design, at the moment a flash sale starts and
traffic peaks. Two mitigations:

1. **Single-flight / request coalescing.** On a cache miss, one request runs the
   query while concurrent requests for the same key await its result
   (in-process promise map; a short Redis `SET NX` lock across instances).
   The herd becomes one query.
2. **Warm the first pages.** After a promotion is created, synchronously warm
   the first N pages of the affected category's default sort. Option A makes
   the write path cheap enough to spend the budget here.

Measured under simulated flash sale (k6/autocannon, `scripts/load/`):

- Listing p99 with warm cache: `[MEASURE] ms`
- Listing p99 during version bump with single-flight: `[MEASURE] ms`
- Listing p99 during version bump *without* single-flight (for comparison): `[MEASURE] ms`

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
                        │      checkpoints (byte_offset, next_chunk); re-enqueues itself
                        │      when remaining time is low
                        ▼
                     [Queue]   BullMQ locally · SQS + redrive policy in production
                        │
                        ▼
                  [Processor]  one chunk per invocation: validate → pricing rules →
                               sorted bulk upsert (newest-wins) → mark chunk DONE
```

The HTTP process never touches row data.

### Failure modes and how each is handled

| Failure | Handling |
|---------|----------|
| Splitter times out or crashes mid-file | Checkpoint `(byte_offset, next_chunk_index)` persisted every N chunks; deterministic chunk filenames make rewrites idempotent; splitter checks remaining time and re-enqueues itself before the limit — any invocation is bounded |
| Chunk processed twice (splitter retry re-enqueues) | `ingest_chunks (job_id, chunk_index)` PK; processor's first statement is `UPDATE ... SET status='PROCESSING' WHERE status='PENDING'`; zero rows → already handled, exit |
| Completion detected too early (processors finish before splitter sets total) | No counter. Job is complete when splitter status is `SPLIT_DONE` **and** no chunk is non-DONE; checked by whichever finishes last |
| Same SKU appears twice in one file, chunks land out of order, or a DLQ'd chunk is replayed later | Monotonic `source_seq = (job_seq << 32) \| row_no` on every row; `ON CONFLICT (sku) DO UPDATE ... WHERE EXCLUDED.source_seq > products.source_seq`. Newest wins in any order; an old job's replay can never overwrite a newer job's data |
| Concurrent multi-row upserts deadlock | Every batch is `ORDER BY sku` before upsert — deterministic lock order |
| One malformed row poisons a 1,000-row chunk | Validate first; partition valid/invalid; upsert valid; record invalid in `ingest_row_errors`. Row errors are data, not exceptions |
| Two processors create the same new category | `INSERT ... ON CONFLICT (name) DO NOTHING` then select |
| 500 chunks fan out to 500 DB connections | The queue is the throttle: worker concurrency cap locally; reserved concurrency + RDS Proxy/PgBouncer in production |
| Stale cache after prices change | `RETURNING sku` from the upsert filtered to rows whose price actually changed; invalidate in pipelined batches; bump category versions on job completion |
| Vendor re-uploads the same file | `UNIQUE (vendor_id, file_checksum)`; re-POST returns the existing job |
| Float precision | Prices parsed as strings into `numeric`; no `parseFloat` anywhere in the pipeline |

### Local ↔ production mapping

| Concern | Local (this repo) | Production |
|---------|-------------------|------------|
| Object storage | `uploads/` directory behind a `Storage` interface | S3 |
| Splitter trigger | BullMQ `split` job | Lambda on `S3:ObjectCreated` |
| Queue | BullMQ on Redis | SQS with redrive policy → DLQ |
| Processor | `npm run worker` (concurrency-capped) | Lambda with SQS event source mapping, reserved concurrency |
| DLQ replay | `POST /ingest/jobs/:id/replay-failed` | SQS redrive to source |

The pipeline code is identical in both modes; only the adapters differ.

Measured (`scripts/ingest/generate.ts`, 500,000 rows):

- Wall time end-to-end: `[MEASURE]`
- Peak RSS of splitter: `[MEASURE] MB`
- Peak RSS of a processor invocation: `[MEASURE] MB`
- Rows/sec sustained: `[MEASURE]`

---

## 8. Consequences

**Easier:** promotions are one row; scheduled promotions need no scheduler;
pricing logic lives in one query; every invariant is database-enforced;
ingestion scales with file size without code changes.

**Harder:** the listing query is non-trivial SQL that must be maintained by
hand; the sort cannot use an index, so caching is load-bearing for the
storefront; keyset cursors over a computed value need care.

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
