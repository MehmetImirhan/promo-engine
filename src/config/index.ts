import { ConfigError, loadEnv, type Env } from './env.js';

export { ConfigError, loadEnv };
export type { Env, EnvIssue } from './env.js';

/**
 * Load `.env` from the working directory if present. Variables already set in
 * the real environment take precedence over the file (same as `node --env-file`).
 */
function loadDotEnvIfPresent(): void {
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

loadDotEnvIfPresent();

/** Validated process configuration. Importing this module fails fast on bad env. */
export const env: Env = loadEnv();
