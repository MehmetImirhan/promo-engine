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
