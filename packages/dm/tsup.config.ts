import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cache/index': 'src/cache/index.ts',
    'react/index': 'src/react/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2018',
  outDir: 'dist',
  treeshake: true,
  splitting: false,
  external: ['react', 'nostr-tools', '@nostr-wot/data', '@nostr-wot/signers'],
  esbuildOptions(o) {
    o.jsx = 'automatic';
  },
});
