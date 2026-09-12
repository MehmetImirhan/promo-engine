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
| `npm run worker`    | Ingest worker (later session)                  |
| `npm run migrate`   | Apply `db/migrations/*.sql` in order           |
| `npm run seed`      | Dev data: `--categories N --products N`, idempotent |
| `npm run typecheck` | `tsc --noEmit`                                 |
| `npm test`          | Unit + integration tests (needs docker compose) |
| `npm run build`     | Compile to `dist/`                             |

## Tests

Unit tests live next to the code (`src/**/*.test.ts`) and need nothing running.
Integration tests (`test/**/*.test.ts`) use a separate database given by
`TEST_DATABASE_URL` (default `promo_test` on the compose Postgres). Before each
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
| `GET`  | `/products/:id` | Product with `effective_price` and the applied `promotion` (`{ id, name, type, value }` or `null`). |
| `POST` | `/products` | Body `{ sku, name, category_id, base_price, stock_quantity? }` → 201 with the priced view. A product created into a category with an active promotion is returned already discounted. Duplicate SKU → 409. |

Pagination: pass `next_cursor` back as `cursor` with the same `category_id`
and `order`; `null` means last page. The cursor is opaque and bound to the
listing that issued it — replaying it with a different `order` or
`category_id` returns 400. There is no offset pagination.

### Promotions

| Method | Path | Notes |
|--------|------|-------|
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

### Operational

- `GET /health` — process is up (no dependencies)
- `GET /ready` — Postgres and Redis reachable

Ingest endpoints are added in a later session.
