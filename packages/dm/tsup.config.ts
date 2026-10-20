import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cache/index': 'src/cache/index.ts',
    'react/index': 'src/react/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: { compilerOptions: { rootDir: '../..' } },
    tsconfig: 'tsconfig.build.json',
  clean: true,
  sourcemap: true,
  target: 'es2018',
  outDir: 'dist',
  treeshake: true,
  splitting: false,
  external: ['react', 'nostr-tools', 'nostr-wot-sdk/data', 'nostr-wot-sdk/signers'],
  esbuildOptions(o) {
    o.jsx = 'automatic';
  },
});
