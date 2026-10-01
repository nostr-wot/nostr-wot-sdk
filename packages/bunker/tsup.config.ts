import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only, as every package in this release is. A dual build of a package that holds
  // process state (here the client and secret registries, in the signer stack a vault session)
  // can be loaded twice in one process and keep two of that state.
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
