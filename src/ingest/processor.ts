/**
 * Chunk processor (ADR §7): exactly one chunk per invocation.
 *
 *   claim → read chunk → validate + price every row → partition →
 *   [tx: row errors, categories, sorted single-statement upsert, chunk DONE]
 *   → derived completion check
 *
 * Correctness does not depend on order or on running once:
 *   - the claim statement makes a duplicate delivery a no-op;
 *   - source_seq makes the upsert newest-wins in any order, so duplicate
 *     SKUs across chunks, out-of-order chunks and replays converge;
 *   - the batch is deduplicated by SKU (highest row_no) and sorted by SKU,
 *     so one statement never touches a row twice and concurrent chunks
 *     take row locks in the same order;
 *   - row errors are data: an invalid row never fails the chunk.
 *
 * Memory is one chunk. The upsert passes arrays, so its parameter count is
 * constant regardless of chunk size.
 */
import { createInterface } from 'node:readline';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { ProcessChunkMessage } from '../queue/index.js';
import type { Logger } from '../shared/logger.js';
import type { Storage } from '../storage/index.js';
import { checkJobCompletion } from './completion.js';
import type { InvocationContext } from './context.js';
import { DEFAULT_PRICING_RULES, priceRow, type PricingRules } from './pricing-rules.js';
import { validateRow, type RowIssue } from './row-schema.js';
import { sourceSeq } from './source-seq.sql.js';
import { chunkKey, type ChunkRow } from './splitter.js';

export interface ProcessorDeps {
  db: Db;
  storage: Storage;
  logger: Logger;
}

export interface ProcessorOptions {
  maxAttempts: number;
  /** A chunk left PROCESSING longer than this is presumed orphaned and may be reclaimed. */
  staleAfterMs: number;
  rules?: PricingRules;
}

interface ValidRow {
  row_no: number;
  sku: string;
  name: string;
  category: string;
  base_price: string;
  stock_quantity: number;
}

interface InvalidRow {
  row_no: number;
  sku: string | null;
  raw: Record<string, string | undefined>;
  errors: RowIssue[];
}

export interface ChunkOutcome {
  rows_valid: number;
  rows_invalid: number;
  rows_applied: number;
  changed_category_ids: string[];
}

export class ChunkProcessor {
  private readonly rules: PricingRules;

  constructor(
    private readonly deps: ProcessorDeps,
    private readonly options: ProcessorOptions,
  ) {
    this.rules = options.rules ?? DEFAULT_PRICING_RULES;
  }

  async handle(event: ProcessChunkMessage, _ctx: InvocationContext): Promise<void> {
    const { db, logger } = this.deps;
    const { jobId, chunkIndex } = event;
    const log = logger.child({ jobId, chunkIndex });

    const attempts = await this.claim(jobId, chunkIndex);
    if (attempts === null) {
      log.info('chunk: not claimable (already done, in progress, or unknown); skipping');
      return;
    }

    try {
      const outcome = await this.process(jobId, chunkIndex);
      log.info({ attempts, ...outcome }, 'chunk: done');
    } catch (err) {
      // Outside the failed transaction: the chunk must be visibly FAILED before the retry fires.
      await db
        .updateTable('ingest_chunks')
        .set({ status: 'FAILED', error: err instanceof Error ? err.message : String(err), updated_at: sql`now()` })
        .where('job_id', '=', jobId)
        .where('chunk_index', '=', chunkIndex)
        .where('status', '=', 'PROCESSING')
        .execute();
      log.warn({ attempts, err: err instanceof Error ? err.message : err }, 'chunk: failed');
      await checkJobCompletion(db, jobId, this.options.maxAttempts);
      throw err;
    }

    await checkJobCompletion(db, jobId, this.options.maxAttempts);
  }

  /**
   * First statement, always. PENDING and FAILED are claimable; PROCESSING
   * only if it has been so for longer than the invocation timeout (the
   * worker holding it is gone). Zero rows → someone else has it.
   */
  private async claim(jobId: string, chunkIndex: number): Promise<number | null> {
    const row = await this.deps.db
      .updateTable('ingest_chunks')
      .set({ status: 'PROCESSING', attempts: sql`attempts + 1`, updated_at: sql`now()` })
      .where('job_id', '=', jobId)
      .where('chunk_index', '=', chunkIndex)
      .where((eb) =>
        eb.or([
          eb('status', 'in', ['PENDING', 'FAILED']),
          eb.and([
            eb('status', '=', 'PROCESSING'),
            eb('updated_at', '<', sql<Date>`now() - make_interval(secs => ${this.options.staleAfterMs / 1000})`),
          ]),
        ]),
      )
      .returning('attempts')
      .executeTakeFirst();
    return row?.attempts ?? null;
  }

  private async process(jobId: string, chunkIndex: number): Promise<ChunkOutcome> {
    const { db } = this.deps;

    const job = await db
      .selectFrom('ingest_jobs')
      .select('job_seq')
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow(() => new Error(`ingest job ${jobId} not found`));

    const rows = await this.readChunk(jobId, chunkIndex);
    const { valid, invalid } = this.partition(rows);
    const batch = dedupeAndSort(valid);

    return db.transaction().execute(async (trx) => {
      if (invalid.length > 0) await recordRowErrors(trx, jobId, chunkIndex, invalid);

      const categoryIds = await resolveCategories(trx, batch.map((r) => r.category));
      const applied = batch.length > 0 ? await upsertProducts(trx, job.job_seq, batch, categoryIds) : [];

      const changed = new Set(applied.filter((r) => r.price_changed).map((r) => r.category_id));
      const outcome: ChunkOutcome = {
        rows_valid: valid.length,
        rows_invalid: invalid.length,
        rows_applied: applied.length,
        changed_category_ids: [...changed],
      };

      await trx
        .updateTable('ingest_chunks')
        .set({ status: 'DONE', error: null, updated_at: sql`now()`, ...outcome })
        .where('job_id', '=', jobId)
        .where('chunk_index', '=', chunkIndex)
        .execute();

      return outcome;
    });
  }

  private async readChunk(jobId: string, chunkIndex: number): Promise<ChunkRow[]> {
    const stream = await this.deps.storage.getStream(chunkKey(jobId, chunkIndex));
    const rows: ChunkRow[] = [];
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (line.length > 0) rows.push(JSON.parse(line) as ChunkRow);
    }
    return rows;
  }

  /** Validation and pricing, before any write. Neither ever throws for a bad row. */
  private partition(rows: ChunkRow[]): { valid: ValidRow[]; invalid: InvalidRow[] } {
    const valid: ValidRow[] = [];
    const invalid: InvalidRow[] = [];
    for (const { row_no, raw } of rows) {
      const validation = validateRow(raw);
      if (!validation.ok) {
        invalid.push({ row_no, sku: raw.sku?.trim() || null, raw, errors: validation.errors });
        continue;
      }
      const { sku, name, category, cost, stock_quantity } = validation.row;
      const priced = priceRow({ cost, category }, this.rules);
      if (!priced.ok) {
        invalid.push({ row_no, sku, raw, errors: [{ path: 'cost', message: priced.reason }] });
        continue;
      }
      valid.push({ row_no, sku, name, category, base_price: priced.base_price, stock_quantity });
    }
    return { valid, invalid };
  }
}

/**
 * One row per SKU (highest row_no wins, same rule as source_seq), sorted by
 * SKU. Postgres rejects an INSERT ... ON CONFLICT DO UPDATE that touches the
 * same row twice; the sort gives concurrent chunks a deterministic lock order.
 */
export function dedupeAndSort(rows: ValidRow[]): ValidRow[] {
  const bySku = new Map<string, ValidRow>();
  for (const row of rows) {
    const existing = bySku.get(row.sku);
    if (!existing || row.row_no > existing.row_no) bySku.set(row.sku, row);
  }
  return [...bySku.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

async function recordRowErrors(db: Db, jobId: string, chunkIndex: number, rows: InvalidRow[]): Promise<void> {
  await db
    .insertInto('ingest_row_errors')
    .values(
      rows.map((r) => ({
        job_id: jobId,
        chunk_index: chunkIndex,
        row_no: r.row_no,
        sku: r.sku,
        raw: JSON.stringify(r.raw),
        errors: JSON.stringify(r.errors),
      })),
    )
    .execute();
}

/** INSERT ... ON CONFLICT DO NOTHING, then select: two processors creating the same category both end up with its id. */
async function resolveCategories(db: Db, names: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(names)];
  if (unique.length === 0) return new Map();
  await sql`INSERT INTO categories (name) SELECT unnest(${unique}::text[]) ON CONFLICT (name) DO NOTHING`.execute(db);
  const found = await db.selectFrom('categories').select(['id', 'name']).where('name', 'in', unique).execute();
  return new Map(found.map((c) => [c.name, c.id]));
}

interface AppliedRow {
  sku: string;
  category_id: string;
  price_changed: boolean;
}

/**
 * One statement for the whole batch. source_seq is computed in SQL from the
 * job's sequence and each row's number; the WHERE makes it newest-wins.
 * RETURNING only includes rows actually written, and OLD/NEW (Postgres 18)
 * tell us whether the price really moved. A brand-new product has OLD NULL,
 * so it counts as a price change for its category.
 */
async function upsertProducts(
  db: Db,
  jobSeq: string,
  batch: ValidRow[],
  categoryIds: Map<string, string>,
): Promise<AppliedRow[]> {
  const categoryId = (name: string): string => {
    const id = categoryIds.get(name);
    if (!id) throw new Error(`category ${JSON.stringify(name)} was not resolved`);
    return id;
  };
  const result = await sql<AppliedRow>`
    INSERT INTO products (sku, name, category_id, base_price, stock_quantity, source_seq)
    SELECT v.sku, v.name, v.category_id, v.base_price, v.stock_quantity,
           ${sourceSeq(sql`${jobSeq}`, sql`v.row_no`)}
    FROM unnest(
      ${batch.map((r) => r.sku)}::text[],
      ${batch.map((r) => r.name)}::text[],
      ${batch.map((r) => categoryId(r.category))}::uuid[],
      ${batch.map((r) => r.base_price)}::numeric[],
      ${batch.map((r) => r.stock_quantity)}::int[],
      ${batch.map((r) => r.row_no)}::bigint[]
    ) AS v(sku, name, category_id, base_price, stock_quantity, row_no)
    ON CONFLICT (sku) DO UPDATE SET
      name           = EXCLUDED.name,
      category_id    = EXCLUDED.category_id,
      base_price     = EXCLUDED.base_price,
      stock_quantity = EXCLUDED.stock_quantity,
      source_seq     = EXCLUDED.source_seq,
      updated_at     = now()
    WHERE EXCLUDED.source_seq > products.source_seq
    RETURNING products.sku, products.category_id,
              (OLD.base_price IS DISTINCT FROM NEW.base_price) AS price_changed
  `.execute(db);
  return result.rows;
}
