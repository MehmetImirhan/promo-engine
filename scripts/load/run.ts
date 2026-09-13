/**
 * Flash-sale load measurement for ADR §4 and §6.
 *
 *   npm run load                          # single-flight on
 *   npm run load -- --single-flight off   # the comparison line in ADR §6
 *   npm run load -- --products 50000 --connections 32 --before 15 --cold 10 --steady 20
 *
 * What it does:
 *   1. seeds (idempotently) a "Load test" category with --products products
 *      and cancels any promotion a previous run left on it
 *   2. times the uncached sorted listing in-process with the cache bypassed
 *      (the §4 number: what one cold page costs Postgres)
 *   3. builds dist/ and starts the API on --port with CACHE_SINGLE_FLIGHT
 *      set from the flag
 *   4. runs two autocannon instances for warmup + before + cold + steady
 *      seconds: listing walkers (pages 1 → 3 of the category, default sort,
 *      chained through next_cursor) and detail readers (uniform over a
 *      --hot product hot set); every response is stamped with the wall
 *      clock so latency can be bucketed by window
 *   5. creates a 30% category promotion when the "before" window ends —
 *      one INSERT and one INCR that make every cached page cold at once
 *   6. prints p50/p95/p99 per window per endpoint and the lines to paste
 *      into the ADR; the raw samples go to data/load/
 *
 * Requires docker compose up (Postgres + Redis) and a migrated DATABASE_URL.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import autocannon from 'autocannon';
import { z } from 'zod';
import { Cache, CategoryVersions, createRedis, type CacheRedis, type VersionRedis } from '../../src/cache/index.js';
import { env } from '../../src/config/index.js';
import { createDb, createPool, type Pool } from '../../src/db/index.js';
import { ProductsService } from '../../src/products/service.js';
import { createLogger } from '../../src/shared/logger.js';

const CATEGORY_NAME = 'Load test';
const PAGE_SIZE = 20;
const PAGES = 3;
const UNCACHED_RUNS = 50;

const argsSchema = z.object({
  products: z.coerce.number().int().min(1).max(1_000_000),
  connections: z.coerce.number().int().min(1).max(500),
  hot: z.coerce.number().int().min(1),
  warmup: z.coerce.number().min(0),
  before: z.coerce.number().min(1),
  cold: z.coerce.number().min(1),
  steady: z.coerce.number().min(1),
  port: z.coerce.number().int().min(1024).max(65535),
  'single-flight': z.enum(['on', 'off']),
});
type Args = z.infer<typeof argsSchema>;

interface Sample {
  /** ms since traffic start */
  t: number;
  ms: number;
  status: number;
}

interface WindowStats {
  n: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  non200: number;
}

const logger = createLogger({ level: 'warn', pretty: true });

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function stats(samples: Sample[], fromMs: number, toMs: number): WindowStats {
  const inWindow = samples.filter((s) => s.t >= fromMs && s.t < toMs);
  const sorted = inWindow.map((s) => s.ms).sort((a, b) => a - b);
  return {
    n: sorted.length,
    rps: sorted.length / ((toMs - fromMs) / 1000),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? NaN,
    non200: inWindow.filter((s) => s.status !== 200).length,
  };
}

function fmt(ms: number): string {
  return Number.isFinite(ms) ? ms.toFixed(1) : '-';
}

function printTable(title: string, rows: Array<[string, WindowStats]>): void {
  console.log(`\n${title}`);
  console.log('  window          n      req/s     p50     p95     p99     max  non-200');
  for (const [name, s] of rows) {
    console.log(
      `  ${name.padEnd(12)} ${String(s.n).padStart(6)} ${s.rps.toFixed(0).padStart(9)} ${fmt(s.p50).padStart(7)} ${fmt(s.p95).padStart(7)} ${fmt(s.p99).padStart(7)} ${fmt(s.max).padStart(7)} ${String(s.non200).padStart(8)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. seed
// ---------------------------------------------------------------------------

async function seed(pool: Pool, products: number, hot: number): Promise<{ categoryId: string; hotIds: string[]; count: number }> {
  await pool.query(`INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [CATEGORY_NAME]);
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM categories WHERE name = $1`, [CATEGORY_NAME]);
  const categoryId = rows[0]!.id;

  // 5,000 distinct prices over N products: plenty of ties for the (effective_price, id) tiebreaker.
  await pool.query(
    `INSERT INTO products (sku, name, category_id, base_price, stock_quantity)
     SELECT 'LOAD-' || lpad(g::text, 7, '0'), 'Load product ' || g, $1,
            (((g * 7919) % 5000) * 37 + 100)::numeric / 100, g % 50
     FROM generate_series(1, $2::int) g
     ON CONFLICT (sku) DO NOTHING`,
    [categoryId, products],
  );
  await pool.query(`UPDATE promotions SET status = 'CANCELLED', updated_at = now() WHERE category_id = $1 AND status = 'ACTIVE'`, [
    categoryId,
  ]);
  const count = Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM products WHERE category_id = $1`, [categoryId])).rows[0]!.n);
  const hotIds = (
    await pool.query<{ id: string }>(`SELECT id FROM products WHERE category_id = $1 ORDER BY random() LIMIT $2`, [categoryId, hot])
  ).rows.map((r) => r.id);
  return { categoryId, hotIds, count };
}

// ---------------------------------------------------------------------------
// 2. uncached listing (ADR §4)
// ---------------------------------------------------------------------------

async function measureUncached(pool: Pool, categoryId: string): Promise<number[]> {
  // A cache that never touches Redis; the client is never called because enabled is false.
  const never = {
    get: async () => {
      throw new Error('cache bypassed');
    },
  };
  const redis = { ...never, set: never.get, incr: never.get } as unknown as CacheRedis & VersionRedis;
  const cache = new Cache(redis, new CategoryVersions(redis, logger), logger, { enabled: false });
  const products = new ProductsService(createDb(pool), cache);
  const params = { category_id: categoryId, order: 'asc' as const, limit: PAGE_SIZE };

  for (let i = 0; i < 5; i++) await products.listProducts(params);
  const timings: number[] = [];
  for (let i = 0; i < UNCACHED_RUNS; i++) {
    const t0 = performance.now();
    await products.listProducts(params);
    timings.push(performance.now() - t0);
  }
  return timings.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 3. API process
// ---------------------------------------------------------------------------

async function startApi(port: number, singleFlight: boolean): Promise<ChildProcess> {
  execFileSync('npm', ['run', '-s', 'build'], { stdio: 'inherit' });
  const child = spawn(process.execPath, ['dist/src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      CACHE_ENABLED: 'true',
      CACHE_SINGLE_FLIGHT: singleFlight ? 'true' : 'false',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  // /health first (process up), then /ready (Postgres and Redis answering) so the cache is live before traffic.
  for (const probe of ['/health', '/ready']) {
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ok = await fetch(`${base}${probe}`)
        .then((res) => res.status === 200)
        .catch(() => false);
    }
    if (!ok) break;
    if (probe === '/ready') return child;
  }
  child.kill('SIGTERM');
  throw new Error('API did not become ready');
}

function stopApi(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

// ---------------------------------------------------------------------------
// 4. traffic
// ---------------------------------------------------------------------------

interface Traffic {
  listing: Sample[];
  detail: Sample[];
}

function cannon(
  opts: autocannon.Options,
  sink: Sample[],
  t0: () => number,
): Promise<autocannon.Result> {
  return new Promise((resolve, reject) => {
    const instance = autocannon(opts, (err, result) => (err ? reject(err) : resolve(result)));
    instance.on('response', (_client, status, _bytes, responseTime) => {
      sink.push({ t: performance.now() - t0(), ms: responseTime, status });
    });
  });
}

async function runTraffic(
  base: string,
  categoryId: string,
  hotIds: string[],
  args: Args,
  onBeforeEnds: () => Promise<void>,
): Promise<{ traffic: Traffic; tPromo: number; listing: autocannon.Result; detail: autocannon.Result }> {
  const traffic: Traffic = { listing: [], detail: [] };
  const durationS = args.warmup + args.before + args.cold + args.steady;
  let start = performance.now();
  const t0 = () => start;

  const listPath = `/products?category_id=${categoryId}&limit=${PAGE_SIZE}`;
  interface WalkContext {
    cursor?: string;
  }
  const onPage = (status: number, body: string, context: object): void => {
    (context as WalkContext).cursor = status === 200 ? ((JSON.parse(body) as { next_cursor: string | null }).next_cursor ?? '') : '';
  };
  const nextPage = (req: autocannon.Request, context: object): autocannon.Request => {
    const { cursor } = context as WalkContext;
    // A falsy return restarts the walk from page 1 (only when the category runs out of pages).
    return (cursor ? { ...req, path: `${listPath}&cursor=${cursor}` } : null) as autocannon.Request;
  };
  const listingRequests: autocannon.Request[] = [
    { method: 'GET', path: listPath, onResponse: onPage },
    ...Array.from({ length: PAGES - 1 }, (): autocannon.Request => ({ method: 'GET', setupRequest: nextPage, onResponse: onPage })),
  ];
  const detailRequests: autocannon.Request[] = [
    {
      method: 'GET',
      setupRequest: (req) => ({ ...req, path: `/products/${hotIds[Math.floor(Math.random() * hotIds.length)]}` }),
    },
  ];

  start = performance.now();
  const listing = cannon({ url: base, connections: args.connections, duration: durationS, requests: listingRequests }, traffic.listing, t0);
  const detail = cannon({ url: base, connections: args.connections, duration: durationS, requests: detailRequests }, traffic.detail, t0);

  await new Promise((r) => setTimeout(r, (args.warmup + args.before) * 1000));
  await onBeforeEnds();
  const tPromo = performance.now() - start;

  const [listingResult, detailResult] = await Promise.all([listing, detail]);
  return { traffic, tPromo, listing: listingResult, detail: detailResult };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      products: { type: 'string', default: '50000' },
      connections: { type: 'string', default: '32' },
      hot: { type: 'string', default: '2000' },
      warmup: { type: 'string', default: '3' },
      before: { type: 'string', default: '15' },
      cold: { type: 'string', default: '10' },
      steady: { type: 'string', default: '20' },
      port: { type: 'string', default: '3902' },
      'single-flight': { type: 'string', default: 'on' },
    },
  });
  const args = argsSchema.parse(values);
  const singleFlight = args['single-flight'] === 'on';
  const base = `http://127.0.0.1:${args.port}`;
  const pool = createPool(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  await redis.connect();
  const versions = new CategoryVersions(redis, logger);

  try {
    console.log(`== seed: "${CATEGORY_NAME}" with ${args.products} products`);
    const { categoryId, hotIds, count } = await seed(pool, args.products, args.hot);
    // Whatever a previous run cached under this category must not count as warm.
    await versions.bump([categoryId]);
    console.log(`   category ${categoryId}: ${count} products, hot set ${hotIds.length}`);

    console.log(`== uncached sorted listing (cache bypassed, ${UNCACHED_RUNS} runs, limit ${PAGE_SIZE})`);
    const uncached = await measureUncached(pool, categoryId);
    console.log(`   p50 ${fmt(percentile(uncached, 50))}  p95 ${fmt(percentile(uncached, 95))}  p99 ${fmt(percentile(uncached, 99))}  max ${fmt(uncached.at(-1)!)} ms`);

    console.log(`== start API on :${args.port} (single-flight ${singleFlight ? 'on' : 'off'})`);
    const api = await startApi(args.port, singleFlight);
    let promotionId: string | null = null;
    try {
      console.log(
        `== traffic: ${args.connections} listing walkers + ${args.connections} detail readers for ${args.warmup}+${args.before}+${args.cold}+${args.steady}s`,
      );
      const HOUR = 3_600_000;
      const run = await runTraffic(base, categoryId, hotIds, args, async () => {
        const res = await fetch(`${base}/promotions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Load test flash sale',
            category_id: categoryId,
            discount_type: 'PERCENTAGE',
            value: '30',
            starts_at: new Date(Date.now() - HOUR).toISOString(),
            ends_at: new Date(Date.now() + HOUR).toISOString(),
          }),
        });
        if (res.status !== 201) throw new Error(`promotion create failed: ${res.status} ${await res.text()}`);
        promotionId = ((await res.json()) as { id: string }).id;
        console.log('   promotion created; cache is cold from here');
      });

      const warmupEnd = args.warmup * 1000;
      const coldEnd = run.tPromo + args.cold * 1000;
      const end = (args.warmup + args.before + args.cold + args.steady) * 1000;
      const windows = (samples: Sample[]): Array<[string, WindowStats]> => [
        ['before', stats(samples, warmupEnd, run.tPromo)],
        ['cold (10s)', stats(samples, run.tPromo, coldEnd)],
        ['steady', stats(samples, coldEnd, end)],
      ];
      const listingWindows = windows(run.traffic.listing);
      const detailWindows = windows(run.traffic.detail);
      printTable(`GET /products (category, default sort, pages 1-${PAGES}) — ms`, listingWindows);
      printTable('GET /products/:id (hot set) — ms', detailWindows);
      console.log(
        `\n  autocannon: listing ${run.listing.requests.total} req, ${run.listing.errors} errors, ${run.listing.timeouts} timeouts; detail ${run.detail.requests.total} req, ${run.detail.errors} errors, ${run.detail.timeouts} timeouts`,
      );

      const sfLabel = singleFlight ? 'with single-flight' : '*without* single-flight (for comparison)';
      const before = listingWindows[0]![1];
      const cold = listingWindows[1]![1];
      const summary = [
        '',
        'Lines for ADR.md:',
        '§4',
        `- Uncached sorted listing, ${count.toLocaleString('en-US')}-product category, p95: ${fmt(percentile(uncached, 95))} ms`,
        `- Same, p99: ${fmt(percentile(uncached, 99))} ms`,
        '§6',
        `- Listing p99 with warm cache: ${fmt(before.p99)} ms`,
        `- Listing p99 during version bump ${sfLabel}: ${fmt(cold.p99)} ms`,
        `  (detail p99 warm ${fmt(detailWindows[0]![1].p99)} ms, during bump ${fmt(detailWindows[1]![1].p99)} ms; ${args.connections}+${args.connections} connections, ${count} products)`,
      ];
      console.log(summary.join('\n'));

      await mkdir('data/load', { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const out = `data/load/${stamp}-single-flight-${singleFlight ? 'on' : 'off'}.json`;
      await writeFile(
        out,
        JSON.stringify({ args, count, uncached, tPromo: run.tPromo, listing: listingWindows, detail: detailWindows, summary }, null, 2),
      );
      console.log(`\n  raw results: ${out}`);
    } finally {
      if (promotionId) await fetch(`${base}/promotions/${promotionId}/cancel`, { method: 'POST' }).catch(() => undefined);
      await stopApi(api);
    }
  } finally {
    redis.disconnect();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'load script failed');
  process.exit(1);
});
