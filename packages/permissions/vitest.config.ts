import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Compile-time contracts: `*.test-d.ts` files run through tsc, so a `@ts-expect-error`
    // on an omitted parameter is a test that fails the moment the parameter becomes optional.
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'], tsconfig: './tsconfig.test.json' },
  },
});
