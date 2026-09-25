import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2018',
  outDir: 'dist',
  treeshake: true,
  splitting: false,
  // Stamp dist/ with a hash of what it was built from; `npm run check:dist` compares.
  onSuccess: 'node scripts/stamp-dist.mjs',
});
