import { defineConfig } from 'tsup';

// One build owns the output directory, so declaration cleanup cannot race
// the optional React or hub entrypoint. Shared modules keep one identity.
export default defineConfig({
  entry: { index: 'src/index.ts', 'hub/index': 'src/hub/index.ts', 'react/index': 'src/react/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2018',
  outDir: 'dist',
  treeshake: true,
  splitting: true,
  external: ['react'],
});
