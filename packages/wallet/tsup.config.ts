import { defineConfig } from 'tsup';

// Build entrypoints together: shared chunks preserve NwcError identity and
// one declaration build owns dist/, including the optional React surface.
export default defineConfig({
  entry: ['src/index.ts', 'src/nwc/index.ts', 'src/react/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2018',
  outDir: 'dist',
  treeshake: true,
  splitting: true,
  external: ['react'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
