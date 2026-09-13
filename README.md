# Promotion Management API

Catalog + promotion API with read-time effective pricing, keyset pagination,
versioned Redis caching, and a resumable chunked CSV ingest pipeline.
Design decisions live in [ADR.md](./ADR.md).

## Run

Requires Node 20.12+ and Docker.

```sh
docker compose up -d
npm install
npm run migrate
npm run seed        # optional: 4 categories, 200 products, 2 promotions
npm run dev
```

Optional: `cp .env.example .env` to change ports or credentials. Every variable
has a default that matches `docker-compose.yml`.

## Scripts

| Script              | What it does                                   |
|---------------------|------------------------------------------------|
| `npm run dev`       | API server with reload                         |
| `npm run worker`    | Ingest worker: splitter + chunk processor (`-- --only split\|process-chunk`) |
| `npm run migrate`   | Apply `db/migrations/*.sql` in order           |
| `npm run seed`      | Dev data: `--categories N --products N`, idempotent |
| `npm run typecheck` | `tsc --noEmit`                                 |
| `npm test`          | Unit + integration tests (needs docker compose) |
| `npm run build`     | Compile to `dist/`                             |
| `npm run ingest:generate` | Vendor CSV with realistic mess: `-- --rows N --out file [--seed S]` |
| `npm run ingest:measure`  | 500k-row ingest under a 128 MB heap; prints wall time, RSS, continuations |
| `npm run load`            | Flash-sale load test (ADR §4/§6): 50k-product category, listing + detail traffic, promotion created mid-run; `-- --single-flight off` for the comparison |
| `npm run ui`              | Web UI on http://localhost:5173 (API on 3000 must be running; everything goes through the API): products, promotions, ingest upload with live chunk progress |

## Tests

Unit tests live next to the code (`src/**/*.test.ts`) and need nothing running.
Integration tests (`test/**/*.test.ts`) use a separate database given by
`TEST_DATABASE_URL` (default `promo_test` on the compose Postgres) and a
separate Redis logical database given by `TEST_REDIS_URL` (default db 1,
flushed before each run). Before each
run, `test/global-setup.ts` creates it if missing, migrates it, and truncates
its tables. The application database in `DATABASE_URL` is never touched;
the setup refuses to run if the two URLs are equal.

## Endpoints

All money fields (`base_price`, `effective_price`, promotion `value`) are
decimal strings such as `"19.99"`, in requests and responses alike. JSON
numbers for money are rejected with 400. Errors always have the shape
`{ "error": { "code", "message", "details?" }, "requestId" }`.

### Products

| Method | Path | Notes |
|--------|------|-------|
| `GET`  | `/products` | Query: `category_id` (uuid), `order` = `asc` \| `desc` (default `asc`), `limit` 1–100 (default 20), `cursor`. Sorted by `effective_price` in SQL, keyset-paginated. Response `{ items, next_cursor }`. |
| `GET`  | `/products/search` | Query: `q` (2–100 chars, matches SKU or name, case-insensitive), `limit` 1–20 (default 8). Response `{ items: [{ id, sku, name, category_id, base_price }] }`. For picking a product by hand: unpriced, uncached, and a scan when nothing matches. |
| `GET`  | `/categories` | Every category, `{ items: [{ id, name }] }`, sorted by name. |
| `GET`  | `/products/:id` | Product with `effective_price` and the applied `promotion` (`{ id, name, type, value }` or `null`). |
| `POST` | `/products` | Body `{ sku, name, category_id, base_price, stock_quantity? }` → 201 with the priced view. A product created into a category with an active promotion is returned already discounted. Duplicate SKU → 409. |

Pagination: pass `next_cursor` back as `cursor` with the same `category_id`
and `order`; `null` means last page. The cursor is opaque and bound to the
listing that issued it — replaying it with a different `order` or
`category_id` returns 400. There is no offset pagination.

### Promotions

| Method | Path | Notes |
|--------|------|-------|
| `GET`  | `/promotions` | Query: `limit` 1–100 (default 50). Newest first, `{ items }`. Each item is the promotion row plus `effective_status` (`SCHEDULED` \| `ACTIVE` \| `ENDED` \| `CANCELLED`: `status` evaluated against now) and the named target, `product: { id, sku, name, category_id }` or `category: { id, name }`. |
| `POST` | `/promotions` | Body `{ name, product_id \| category_id (exactly one), discount_type: "PERCENTAGE" \| "FIXED", value, starts_at, ends_at }` (ISO 8601 with offset) → 201. Product-scope `FIXED` with `value >= base_price` → 400. |
| `POST` | `/promotions/:id/cancel` | Sets `status = "CANCELLED"` and returns the row. Idempotent. Rows are never deleted. |
| `POST` | `/promotions/:id/assign` | Body `{ product_id \| category_id }`. Re-targets an active promotion in one `UPDATE`. Cancelled promotion → 409. |

"At most one active promotion per product/category at a time" is enforced by
the database's `EXCLUDE` constraints, not by application code. A conflicting
create or assign returns:

```json
{ "error": { "code": "CONFLICT",
             "message": "An active category-scope promotion already overlaps this window",
             "details": { "constraint": "no_overlapping_category_promos", "scope": "category",
                          "category_id": "…", "starts_at": "…", "ends_at": "…" } },
  "requestId": "…" }
```

Cross-scope conflicts (a product promotion and a category promotion both
covering one product) are resolved by precedence in the pricing query:
product scope wins.

### Postman

`postman/promo-engine.postman_collection.json` covers every endpoint above,
including the 400/404/409 cases. Requests chain through collection variables
(`categoryId` is picked up from the first listing, so run `npm run seed`
first) and each carries assertions, so it doubles as a smoke test:

```sh
npx newman run postman/promo-engine.postman_collection.json --working-dir .
```

The ingest upload points at `data/vendor.csv` (create it with
`npm run ingest:generate -- --rows 200 --out data/vendor.csv`).

### Operational

- `GET /health` — process is up (no dependencies)
- `GET /ready` — Postgres and Redis reachable

### Caching (ADR §6)

`GET /products/:id` (300 s) and `GET /products` (60 s) are cache-aside in
Redis. Every key embeds its category's version (`catver:{categoryId}`, and
`catver:_all` for the unfiltered listing). Promotion create / cancel /
assign, `POST /products`, and ingest job completion each do one `INCR`;
nothing is ever deleted or scanned, and the old keys expire on their own.
Concurrent misses for one key run one query (in-process single-flight).
Every Redis error fails open to Postgres, including the version read.
`CACHE_ENABLED=false` bypasses Redis entirely; `CACHE_SINGLE_FLIGHT=false`
exists only for the measurement in the ADR.

### Ingest (Scenario A)

Vendor files are CSV with header `sku,name,category,cost,stock_quantity`
(any column order; extra columns ignored). `cost` is the vendor cost; the
pricing rules in `src/ingest/pricing-rules.ts` turn it into `base_price`
(margin per category with a global floor, rounded to a `.99` ending, rows
that would land below cost are rejected as row errors).

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/ingest/jobs` | `multipart/form-data` with `vendor_id` and `file`. The file is streamed to storage while hashed; `202 { id, status, created: true }`. The same file for the same vendor again → `200` with the existing job. |
| `GET`  | `/ingest/jobs` | Query: `limit` 1–50 (default 10). Newest first, `{ items }` in the same shape as `GET /ingest/jobs/:id`. |
| `GET`  | `/ingest/jobs/:id` | `status`, `split_invocations`, `chunks` by status, `rows` `{ total, valid, invalid, applied }`, `error_count`. |
| `GET`  | `/ingest/jobs/:id/chunks` | Every chunk in order: `{ items: [{ chunk_index, status, attempts, row_count, rows_valid, rows_invalid, rows_applied, error, updated_at }] }`. Unpaginated: a 500k-row file is 500 chunks. |
| `POST` | `/ingest/jobs/:id/replay-failed` | Re-enqueues `FAILED` chunks, chunks stuck in `PROCESSING` past the invocation timeout, and an unfinished split. Safe in any order. |

Job status: `PENDING → SPLITTING → SPLIT_DONE → COMPLETED | PARTIAL`
(`PARTIAL` = some chunk failed after every retry; `FAILED` = the file itself
could not be split, e.g. missing header columns). Row-level problems never
fail a job: they are recorded in `ingest_row_errors` with the raw row and a
path per issue.

Pipeline (`npm run worker`): the splitter streams the file with `csv-parse`,
writes chunks of `INGEST_CHUNK_SIZE` rows to storage, checkpoints after
every chunk and re-enqueues itself when `remainingTimeMs()` is below
`INGEST_SPLIT_RESERVE_MS`; each chunk is one queue message and one
processor invocation (validate → price → sorted single-statement upsert).
Newest wins by `source_seq = (job_seq << 32) | row_no`, so duplicate SKUs,
out-of-order chunks and replays converge. Job completion is derived from
chunk statuses, never counted. Storage is `STORAGE_DIR` (default `./data`)
behind the `Storage` interface; queues are BullMQ behind the `Queue`
interface. Design and the production mapping (S3, SQS, Lambda) are in
ADR §7.

To try it locally:

```sh
npm run ingest:generate -- --rows 20000 --out data/vendor.csv
npm run worker                                   # in a second terminal
curl -F vendor_id=acme -F file=@data/vendor.csv localhost:3000/ingest/jobs
curl localhost:3000/ingest/jobs/<id>
```
