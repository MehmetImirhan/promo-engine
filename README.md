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
| `npm run typecheck` | `tsc --noEmit`                                 |
| `npm test`          | Unit + integration tests (needs docker compose) |
| `npm run build`     | Compile to `dist/`                             |

## Endpoints

- `GET /health` — process is up (no dependencies)
- `GET /ready` — Postgres and Redis reachable

Product, promotion and ingest endpoints are added in later sessions.
