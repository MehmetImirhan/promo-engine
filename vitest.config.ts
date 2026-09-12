import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests talk to the docker-compose Postgres; give them room.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
