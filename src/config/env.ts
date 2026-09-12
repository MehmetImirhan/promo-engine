import { z } from 'zod';

/**
 * Every value has a default that matches docker-compose.yml / .env.example,
 * so the app boots with no .env. Malformed values still fail fast.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .default('postgres://promo:promo@localhost:5432/promo'),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://localhost:6379'),
  /** Used only by the integration test suite. Its tables are truncated before every run. */
  TEST_DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .default('postgres://promo:promo@localhost:5432/promo_test'),

  // --- ingest pipeline (ADR §7) ---
  /** Root of the local Storage implementation (uploads and chunk files). S3 bucket in production. */
  STORAGE_DIR: z.string().min(1).default('./data'),
  /**
   * Rows per chunk = rows held in memory by one splitter or processor
   * invocation. The upsert passes arrays, so SQL parameter limits never
   * apply; the ceiling here is purely a memory bound.
   */
  INGEST_CHUNK_SIZE: z.coerce.number().int().min(1).max(10_000).default(1_000),
  /** Concurrent chunk invocations per worker process (reserved concurrency in production). */
  INGEST_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Queue delivery attempts per chunk before it is parked in the DLQ (SQS maxReceiveCount). */
  INGEST_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  /** Simulated function timeout: the worker builds remainingTimeMs() from it; also the stale-PROCESSING reclaim age. */
  INGEST_INVOCATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  /** The splitter re-enqueues itself when less than this much of the invocation remains. */
  INGEST_SPLIT_RESERVE_MS: z.coerce.number().int().min(100).default(2_000),
}).refine((e) => e.INGEST_SPLIT_RESERVE_MS < e.INGEST_INVOCATION_TIMEOUT_MS, {
  path: ['INGEST_SPLIT_RESERVE_MS'],
  message: 'must be smaller than INGEST_INVOCATION_TIMEOUT_MS',
});

export type Env = z.infer<typeof envSchema>;

export interface EnvIssue {
  key: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: EnvIssue[];

  constructor(issues: EnvIssue[]) {
    const summary = issues.map((i) => `${i.key}: ${i.message}`).join('; ');
    super(`Invalid environment configuration — ${summary}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }

  /** The offending variable names, sorted, for logs and tests. */
  get keys(): string[] {
    return [...new Set(this.issues.map((i) => i.key))].sort();
  }
}

/**
 * Parse and validate configuration from an env-shaped object.
 * Throws ConfigError listing every invalid key, not just the first.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    key: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
  throw new ConfigError(issues);
}
