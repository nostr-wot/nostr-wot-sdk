import { defineConfig } from 'tsup';

const COMMON = {
  format: ['cjs', 'esm'] as const,
  dts: true,
  sourcemap: true,
  target: 'es2018' as const,
  treeshake: true,
  splitting: false,
  external: [
    '@nostr-wot/wot',
    '@nostr-wot/relay',
    '@nostr-wot/data',
    '@nostr-wot/signers',
    '@nostr-wot/ui',
    '@nostr-wot/dm',
    '@nostr-wot/wallet',
    '@nostr-wot/auth',
    '@nostr-wot/blossom',
    'react',
  ],
  esbuildOptions(o: { jsx?: string }) {
    o.jsx = 'automatic';
  },
};

export default defineConfig([
  { ...COMMON, entry: ['src/index.ts'], outDir: 'dist', clean: true },
  { ...COMMON, entry: ['src/react/index.ts'], outDir: 'dist/react' },
  { ...COMMON, entry: ['src/relay/index.ts'], outDir: 'dist/relay' },
  { ...COMMON, entry: ['src/relay/react/index.ts'], outDir: 'dist/relay/react' },
  { ...COMMON, entry: ['src/data/index.ts'], outDir: 'dist/data' },
  { ...COMMON, entry: ['src/data/cache/index.ts'], outDir: 'dist/data/cache' },
  { ...COMMON, entry: ['src/signers/index.ts'], outDir: 'dist/signers' },
  { ...COMMON, entry: ['src/ui/index.ts'], outDir: 'dist/ui' },
  { ...COMMON, entry: ['src/dm/index.ts'], outDir: 'dist/dm' },
  { ...COMMON, entry: ['src/dm/react/index.ts'], outDir: 'dist/dm/react' },
  { ...COMMON, entry: ['src/wallet/index.ts'], outDir: 'dist/wallet' },
  { ...COMMON, entry: ['src/wallet/react/index.ts'], outDir: 'dist/wallet/react' },
  { ...COMMON, entry: ['src/auth/index.ts'], outDir: 'dist/auth' },
  { ...COMMON, entry: ['src/blossom/index.ts'], outDir: 'dist/blossom' },
]);
