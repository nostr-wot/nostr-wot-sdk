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
  // The dist stamp is written by the build script after tsup exits: onSuccess runs
  // concurrently with the dts worker and would hash the previous declarations or none.
});
