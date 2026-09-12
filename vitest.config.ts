import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests share one database; run files one at a time so
    // truncation and inserts from different files never interleave.
    // (Top-level only in vitest 5; unit files are cheap enough not to care.)
    fileParallelism: false,
    projects: [
      {
        // Pure logic; no infrastructure required.
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        // Talks to the docker-compose Postgres via TEST_DATABASE_URL.
        // global-setup.ts creates, migrates, and truncates that database.
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
