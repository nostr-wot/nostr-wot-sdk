import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2018',
    outDir: 'dist',
    treeshake: true,
    splitting: false,
    external: ['@nostr-wot/relay', 'nostr-tools', 'react'],
  },
  {
    entry: ['src/react/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    target: 'es2018',
    outDir: 'dist/react',
    treeshake: true,
    splitting: false,
    external: ['@nostr-wot/relay', 'nostr-tools', 'react'],
  },
]);
