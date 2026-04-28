import { defineConfig } from 'tsup';
import { solidPlugin } from 'esbuild-plugin-solid';

const JSX_AUTO = {
  esbuildOptions(o: { jsx?: string }) {
    o.jsx = 'automatic';
  },
};

export default defineConfig([
  {
    ...JSX_AUTO,
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2018',
    outDir: 'dist',
    treeshake: true,
    splitting: false,
  },
  {
    ...JSX_AUTO,
    entry: ['src/react/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    target: 'es2018',
    outDir: 'dist/react',
    treeshake: true,
    splitting: false,
    external: ['react', '@nostr-wot/data'],
  },
  // Solid uses its own JSX transform via the plugin — don't override.
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
]);
