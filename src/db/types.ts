/**
 * Kysely table types. Hand-written to mirror db/migrations/*.sql exactly;
 * update both together.
 *
 * Column conventions:
 * - numeric(12,2) -> `Money` (string in and out). Never a JS number.
 * - int8          -> string on read (pg default); bigint or string on write.
 * - timestamptz   -> Date on read; Date or ISO string on write.
 */
import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';

export type Money = ColumnType<string, string, string>;
export type BigIntColumn = ColumnType<string, string | bigint, string | bigint>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** timestamptz with a DEFAULT: optional on insert. */
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type DiscountType = 'PERCENTAGE' | 'FIXED';
export type PromotionStatus = 'ACTIVE' | 'CANCELLED';
export type IngestJobStatus =
  | 'PENDING'
  | 'SPLITTING'
  | 'SPLIT_DONE'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED';
export type IngestChunkStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface CategoriesTable {
  id: Generated<string>;
  name: string;
  created_at: GeneratedTimestamp;
}

export interface ProductsTable {
  id: Generated<string>;
  sku: string;
  name: string;
  category_id: string;
  base_price: Money;
  stock_quantity: Generated<number>;
  /** (job_seq << 32) | row_no; 0 = never written by ingest. */
  source_seq: ColumnType<string, string | bigint | undefined, string | bigint>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PromotionsTable {
  id: Generated<string>;
  name: string;
  /** Exactly one of product_id / category_id is non-null (CHECK num_nonnulls = 1). */
  product_id: string | null;
  category_id: string | null;
  discount_type: DiscountType;
  value: Money;
  starts_at: Timestamp;
  ends_at: Timestamp;
  status: Generated<PromotionStatus>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export interface IngestJobsTable {
  id: Generated<string>;
  job_seq: Generated<string>; // int8 identity; read as string
  vendor_id: string;
  file_checksum: string;
  file_key: string;
  status: Generated<IngestJobStatus>;
  /** Splitter checkpoint: chunks [0, next_chunk_index) are written and enqueued. */
  next_chunk_index: Generated<number>;
  /** Splitter runs for this job; continuations = split_invocations - 1. */
  split_invocations: Generated<number>;
  error: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  completed_at: Timestamp | null;
}

export interface IngestChunksTable {
  job_id: string;
  chunk_index: number;
  status: Generated<IngestChunkStatus>;
  attempts: Generated<number>;
  row_count: number;
  rows_valid: Generated<number>;
  rows_invalid: Generated<number>;
  /** Rows the upsert wrote, i.e. not skipped by the source_seq guard. */
  rows_applied: Generated<number>;
  /** Categories with at least one real base_price change in this chunk. */
  changed_category_ids: Generated<string[]>;
  error: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface IngestRowErrorsTable {
  id: Generated<string>; // int8 identity; read as string
  job_id: string;
  chunk_index: number;
  row_no: number;
  sku: string | null;
  /** The raw CSV row as parsed (string values). */
  raw: JSONColumnType<Record<string, string>>;
  /** Validation issues for the row. */
  errors: JSONColumnType<Array<{ path: string; message: string }>>;
  created_at: GeneratedTimestamp;
}

export interface SchemaMigrationsTable {
  name: string;
  applied_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------

export interface Database {
  categories: CategoriesTable;
  products: ProductsTable;
  promotions: PromotionsTable;
  ingest_jobs: IngestJobsTable;
  ingest_chunks: IngestChunksTable;
  ingest_row_errors: IngestRowErrorsTable;
  schema_migrations: SchemaMigrationsTable;
}

export type Category = Selectable<CategoriesTable>;
export type NewCategory = Insertable<CategoriesTable>;

export type Product = Selectable<ProductsTable>;
export type NewProduct = Insertable<ProductsTable>;
export type ProductUpdate = Updateable<ProductsTable>;

export type Promotion = Selectable<PromotionsTable>;
export type NewPromotion = Insertable<PromotionsTable>;
export type PromotionUpdate = Updateable<PromotionsTable>;

export type IngestJob = Selectable<IngestJobsTable>;
export type NewIngestJob = Insertable<IngestJobsTable>;
export type IngestJobUpdate = Updateable<IngestJobsTable>;

export type IngestChunk = Selectable<IngestChunksTable>;
export type NewIngestChunk = Insertable<IngestChunksTable>;
export type IngestChunkUpdate = Updateable<IngestChunksTable>;

export type IngestRowError = Selectable<IngestRowErrorsTable>;
export type NewIngestRowError = Insertable<IngestRowErrorsTable>;
