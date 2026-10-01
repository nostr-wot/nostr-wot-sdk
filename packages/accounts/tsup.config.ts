import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2018',
  outDir: 'dist',
  treeshake: true,
  splitting: false,
  // The dist stamp is written by the build script after tsup exits, not from onSuccess: that
  // hook runs concurrently with the declaration worker, so the hash of the outputs would cover
  // the previous `.d.ts` or none at all. See `scripts/dist-stamp.mjs`.
});
