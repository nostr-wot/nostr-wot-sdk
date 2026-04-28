import { defineConfig } from 'tsup';

const COMMON = {
  format: ['cjs', 'esm'] as const,
  dts: true,
  sourcemap: true,
  target: 'es2018' as const,
  treeshake: true,
  splitting: false,
  external: ['@nostr-wot/wot', '@nostr-wot/relay', '@nostr-wot/data', 'react', 'solid-js'],
};

export default defineConfig([
  { ...COMMON, entry: ['src/index.ts'], outDir: 'dist', clean: true },
  { ...COMMON, entry: ['src/react/index.ts'], outDir: 'dist/react' },
  { ...COMMON, entry: ['src/solid/index.ts'], outDir: 'dist/solid' },
  { ...COMMON, entry: ['src/relay/index.ts'], outDir: 'dist/relay' },
  { ...COMMON, entry: ['src/relay/react/index.ts'], outDir: 'dist/relay/react' },
  { ...COMMON, entry: ['src/data/index.ts'], outDir: 'dist/data' },
  { ...COMMON, entry: ['src/data/cache/index.ts'], outDir: 'dist/data/cache' },
]);
