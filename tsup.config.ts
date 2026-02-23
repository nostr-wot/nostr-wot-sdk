import { defineConfig } from 'tsup';
import { solidPlugin } from 'esbuild-plugin-solid';

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
  // SolidJS integration entry point
  {
    entry: ['src/solid/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    target: 'es2018',
    outDir: 'dist/solid',
    treeshake: true,
    splitting: false,
    external: ['solid-js'],
    esbuildPlugins: [solidPlugin({ solid: { generate: 'dom' } })],
  },
  // Relay utilities entry point
  {
    entry: ['src/relay/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    target: 'es2018',
    outDir: 'dist/relay',
    treeshake: true,
    splitting: false,
  },
  // Relay React integration entry point
  {
    entry: ['src/relay/react/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    target: 'es2018',
    outDir: 'dist/relay/react',
    treeshake: true,
    splitting: false,
    external: ['react'],
  },
]);
