import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // src/env.d.ts is ambient declarations only; vendored bzip2 is covered by
      // its own codec vectors but has unreachable defensive branches.
      exclude: ['src/env.d.ts'],
    },
  },
});
