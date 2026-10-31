import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { env: { TZ: 'Europe/Moscow' }, include: ['tests/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 240_000, fileParallelism: true },
});
