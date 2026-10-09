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
    '@nostr-wot/graph',
    'react',
  ],
  esbuildOptions(o: { jsx?: string }) {
    o.jsx = 'automatic';
  },
};

// One build owns dist/: cleaning one concurrent config could remove another's declarations.
export default defineConfig({
  ...COMMON,
  entry: {
    index: 'src/index.ts',
    'react/index': 'src/react/index.ts',
    'relay/index': 'src/relay/index.ts',
    'relay/react/index': 'src/relay/react/index.ts',
    'data/index': 'src/data/index.ts',
    'data/cache/index': 'src/data/cache/index.ts',
    'signers/index': 'src/signers/index.ts',
    'ui/index': 'src/ui/index.ts',
    'dm/index': 'src/dm/index.ts',
    'dm/react/index': 'src/dm/react/index.ts',
    'wallet/index': 'src/wallet/index.ts',
    'wallet/react/index': 'src/wallet/react/index.ts',
    'auth/index': 'src/auth/index.ts',
    'blossom/index': 'src/blossom/index.ts',
    'graph/index': 'src/graph/index.ts',
    'graph/react/index': 'src/graph/react/index.ts',
  },
  outDir: 'dist',
  clean: true,
});
