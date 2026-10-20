import { defineConfig } from 'tsup';
export default defineConfig({
  esbuildOptions(options) { options.jsx = "automatic"; },
  "entry": {
    "index": "src/index.ts",
    "react/index": "src/react/index.ts",
    "relay/index": "src/relay/index.ts",
    "relay/react/index": "src/relay/react/index.ts",
    "data/index": "src/data/index.ts",
    "data/cache/index": "src/data/cache/index.ts",
    "signers/index": "src/signers/index.ts",
    "ui/index": "src/ui/index.ts",
    "dm/index": "src/dm/index.ts",
    "dm/react/index": "src/dm/react/index.ts",
    "wallet/index": "src/wallet/index.ts",
    "wallet/react/index": "src/wallet/react/index.ts",
    "auth/index": "src/auth/index.ts",
    "blossom/index": "src/blossom/index.ts",
    "graph/index": "src/graph/index.ts",
    "graph/react/index": "src/graph/react/index.ts",
    "relay/hub/index": "src/relay/hub/index.ts",
    "data/react/index": "src/data/react/index.ts",
    "storage/index": "src/storage/index.ts"
  },
  "format": [
    "esm",
    "cjs"
  ],
  "dts": {"compilerOptions": {"rootDir": "../.."}},
  "tsconfig": "tsconfig.build.json",
  "clean": true,
  "sourcemap": true,
  "target": "es2018",
  "outDir": "dist",
  "treeshake": true,
  "splitting": true,
  "external": [
    "@nostr-wot/auth",
    "@nostr-wot/wallet",
    "@nostr-wot/pq",
    "@nostr-wot/dm",
    "nostr-tools",
    "@nostr-wot/ui",
    "@noble/hashes",
    "react-dom",
    "@nostr-wot/wot",
    "react"
  ]
});
