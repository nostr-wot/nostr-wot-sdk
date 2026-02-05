import { defineConfig } from 'tsup';

export default defineConfig([
  // Main entry point
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: false,
    target: 'es2018',
    outDir: 'dist',
    treeshake: true,
    splitting: false,
  },
  // React integration entry point
  {
    entry: ['src/react/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    target: 'es2018',
    outDir: 'dist/react',
    treeshake: true,
    splitting: false,
    external: ['react'],
  },
]);
