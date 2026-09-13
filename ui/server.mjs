/**
 * Local UI for the Promotion Management API.
 *
 *   npm run ui        then open http://localhost:5173
 *
 * /api/*     proxied to the API (API_URL, default http://localhost:3000), so the
 *            page is same-origin and the API needs no CORS.
 * /lookup/*  read-only queries for what the API has no endpoint for: category
 *            names, the promotion list, product search, recent ingest jobs.
 *            Every write goes through the API.
 * otherwise  the static page.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pino } from 'pino';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(here, '..', '.env'));
} catch {
  // no .env: defaults below match docker-compose.yml
}

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const UI_PORT = Number(process.env.UI_PORT ?? 5173);
const API_URL = new URL(process.env.API_URL ?? 'http://localhost:3000');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://promo:promo@localhost:5432/promo',
  max: 4,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const LOOKUPS = {
  categories: () => pool.query('SELECT id, name FROM categories ORDER BY name'),

  promotions: () =>
    pool.query(`
      SELECT pr.id, pr.name, pr.discount_type, pr.value, pr.starts_at, pr.ends_at,
             CASE WHEN pr.status = 'CANCELLED' THEN 'CANCELLED'
                  WHEN now() < pr.starts_at    THEN 'SCHEDULED'
                  WHEN now() >= pr.ends_at     THEN 'ENDED'
                  ELSE 'ACTIVE' END AS state,
             pr.product_id, p.name AS product_name, p.sku AS product_sku,
             pr.category_id, c.name AS category_name
      FROM promotions pr
      LEFT JOIN products p   ON p.id = pr.product_id
      LEFT JOIN categories c ON c.id = COALESCE(pr.category_id, p.category_id)
      ORDER BY pr.created_at DESC
      LIMIT 100`),

  // No ORDER BY on the fuzzy branch: LIMIT can stop the scan early on a 500k-row table.
  products: (params) => {
    const q = (params.get('q') ?? '').trim();
    if (q === '') return { rows: [] };
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return pool.query(
      `(SELECT id, sku, name, base_price FROM products WHERE sku = $1)
       UNION ALL
       (SELECT id, sku, name, base_price FROM products
        WHERE sku <> $1 AND (sku ILIKE $2 OR name ILIKE $2) LIMIT 8)
       LIMIT 8`,
      [q, like],
    );
  },

  jobs: () => pool.query('SELECT id FROM ingest_jobs ORDER BY created_at DESC LIMIT 8'),

  // Per-chunk state for the progress grid; the API's job status only has counts by status.
  chunks: (params) => {
    const job = params.get('job') ?? '';
    if (!UUID.test(job)) return { rows: [] };
    return pool.query(
      `SELECT chunk_index, status, attempts, row_count, rows_valid, rows_invalid, rows_applied, error
       FROM ingest_chunks WHERE job_id = $1 ORDER BY chunk_index`,
      [job],
    );
  },
};

function send(res, status, body, type) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function proxy(req, res, url) {
  const target = new URL(url.pathname.slice('/api'.length) + url.search, API_URL);
  const upstream = http.request(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    send(
      res,
      502,
      JSON.stringify({ error: { code: 'API_UNREACHABLE', message: `API is not reachable at ${API_URL.origin}` } }),
      'application/json',
    );
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://ui.local');

  if (url.pathname.startsWith('/api/')) return proxy(req, res, url);

  if (url.pathname.startsWith('/lookup/') && req.method === 'GET') {
    const lookup = LOOKUPS[url.pathname.slice('/lookup/'.length)];
    if (!lookup) return send(res, 404, '{"error":{"message":"Unknown lookup"}}', 'application/json');
    try {
      const { rows } = await lookup(url.searchParams);
      return send(res, 200, JSON.stringify(rows), 'application/json');
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: { code: 'LOOKUP_FAILED', message: err.message } }), 'application/json');
    }
  }

  const file = STATIC[url.pathname];
  if (file && req.method === 'GET') return send(res, 200, await readFile(path.join(here, file[0])), file[1]);

  send(res, 404, 'Not found', 'text/plain');
});

server.listen(UI_PORT, () => {
  logger.info({ url: `http://localhost:${UI_PORT}`, api: API_URL.origin }, 'ui server listening');
});
