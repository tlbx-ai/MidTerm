import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/ts/**/*.test.ts'],
    environment: 'node',
  },
});
