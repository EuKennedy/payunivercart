import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    // First endpoint test ships with Better-Auth wiring; until then the
    // package has no tests by design and `vitest` would exit 1 without
    // this flag.
    passWithNoTests: true,
  },
});
