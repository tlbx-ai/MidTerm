import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/Ai.Tlbx.MidTerm/src/ts/**/*.test.ts'],
    environment: 'node',
  },
});
