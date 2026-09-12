-- 0001_init.sql
-- Domain model (ADR §3) and ingest tables (ADR §7).
-- Money is numeric(12,2) everywhere. Primary keys are uuidv7() (Postgres 18).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT categories_name_key UNIQUE (name)
);

CREATE TABLE products (
  id          uuid          PRIMARY KEY DEFAULT uuidv7(),
  sku         text          NOT NULL,
  name        text          NOT NULL,
  category_id uuid          NOT NULL REFERENCES categories (id),
  base_price  numeric(12,2) NOT NULL,
  stock_quantity integer    NOT NULL DEFAULT 0,
  -- Ingest ordering key: (job_seq << 32) | row_no of the row that last wrote
  -- this product. 0 means "never written by ingest". The upsert only applies
  -- when EXCLUDED.source_seq > products.source_seq (newest wins, any order).
  source_seq  bigint        NOT NULL DEFAULT 0,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT products_sku_key                    UNIQUE (sku),
  CONSTRAINT products_base_price_nonnegative     CHECK (base_price >= 0),
  CONSTRAINT products_stock_quantity_nonnegative CHECK (stock_quantity >= 0)
);

CREATE INDEX products_category_id_idx ON products (category_id);

-- ---------------------------------------------------------------------------
-- Promotions — exactly one scope; at most one ACTIVE per product/category at
-- any instant, enforced only by the two partial EXCLUDE constraints below.
-- Cross-scope conflicts (product vs. category) are NOT a constraint; they are
-- resolved by precedence in the effective-price query (product wins).
-- Cancellation is a status flip, never a delete, so the partial predicate
-- stops treating the row as blocking while keeping it for audit.
-- ---------------------------------------------------------------------------

CREATE TABLE promotions (
  id            uuid          PRIMARY KEY DEFAULT uuidv7(),
  name          text          NOT NULL,
  product_id    uuid          REFERENCES products (id),
  category_id   uuid          REFERENCES categories (id),
  discount_type text          NOT NULL,
  value         numeric(12,2) NOT NULL,
  starts_at     timestamptz   NOT NULL,
  ends_at       timestamptz   NOT NULL,
  status        text          NOT NULL DEFAULT 'ACTIVE',
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT promotions_one_scope        CHECK (num_nonnulls(product_id, category_id) = 1),
  CONSTRAINT promotions_discount_type    CHECK (discount_type IN ('PERCENTAGE', 'FIXED')),
  CONSTRAINT promotions_status           CHECK (status IN ('ACTIVE', 'CANCELLED')),
  CONSTRAINT promotions_value_positive   CHECK (value > 0),
  CONSTRAINT promotions_percentage_range CHECK (discount_type <> 'PERCENTAGE' OR value <= 100),
  CONSTRAINT promotions_valid_range      CHECK (ends_at > starts_at),

  CONSTRAINT no_overlapping_product_promos EXCLUDE USING gist (
    product_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (product_id IS NOT NULL AND status = 'ACTIVE'),

  CONSTRAINT no_overlapping_category_promos EXCLUDE USING gist (
    category_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (category_id IS NOT NULL AND status = 'ACTIVE')
);

-- The two partial GiST indexes created by the EXCLUDE constraints also serve
-- the effective-price lateral join (equality on product_id / category_id via
-- btree_gist), so no separate lookup indexes are needed.

-- ---------------------------------------------------------------------------
-- Ingest (ADR §7)
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_jobs (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  -- Monotonic per job; high 32 bits of every row's source_seq.
  job_seq          bigint      NOT NULL GENERATED ALWAYS AS IDENTITY,
  vendor_id        text        NOT NULL,
  file_checksum    text        NOT NULL,
  -- Key in the Storage abstraction (local path now, S3 key in production).
  file_key         text        NOT NULL,
  status           text        NOT NULL DEFAULT 'PENDING',
  -- Splitter checkpoint. On retry the splitter re-streams the file and skips
  -- next_chunk_index * CHUNK_SIZE records through the parser. Byte offsets are
  -- deliberately not stored: they are not safe resume points in CSV.
  next_chunk_index integer     NOT NULL DEFAULT 0,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,

  CONSTRAINT ingest_jobs_job_seq_key         UNIQUE (job_seq),
  CONSTRAINT ingest_jobs_vendor_checksum_key UNIQUE (vendor_id, file_checksum),
  CONSTRAINT ingest_jobs_status CHECK (
    status IN ('PENDING', 'SPLITTING', 'SPLIT_DONE', 'COMPLETED', 'PARTIAL', 'FAILED')
  ),
  -- (job_seq << 32) must stay within a signed bigint.
  CONSTRAINT ingest_jobs_job_seq_range CHECK (job_seq > 0 AND job_seq < 2147483648)
);

CREATE TABLE ingest_chunks (
  job_id      uuid        NOT NULL REFERENCES ingest_jobs (id),
  chunk_index integer     NOT NULL,
  status      text        NOT NULL DEFAULT 'PENDING',
  attempts    integer     NOT NULL DEFAULT 0,
  row_count   integer     NOT NULL,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (job_id, chunk_index),
  CONSTRAINT ingest_chunks_status CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
  CONSTRAINT ingest_chunks_index_nonnegative     CHECK (chunk_index >= 0),
  CONSTRAINT ingest_chunks_row_count_nonnegative CHECK (row_count >= 0)
);

-- Derived job completion: "does this job still have any chunk outside DONE?"
-- There is deliberately no processed_chunks counter anywhere.
CREATE INDEX ingest_chunks_unfinished_idx ON ingest_chunks (job_id) WHERE status <> 'DONE';

CREATE TABLE ingest_row_errors (
  id          bigint      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  job_id      uuid        NOT NULL REFERENCES ingest_jobs (id),
  chunk_index integer     NOT NULL,
  row_no      integer     NOT NULL,
  sku         text,
  raw         jsonb       NOT NULL,
  errors      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ingest_row_errors_job_id_idx ON ingest_row_errors (job_id);
