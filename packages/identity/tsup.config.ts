import { defineConfig } from 'tsup';
export default defineConfig({
  "entry": {
    "accounts/index": "src/accounts/index.ts",
    "vault/index": "src/vault/index.ts",
    "permissions/index": "src/permissions/index.ts",
    "signing/index": "src/signing/index.ts",
    "bunker/index": "src/bunker/index.ts",
    "index": "src/index.ts"
  },
  "format": [
    "esm"
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
    "@scure/bip32",
    "@scure/base",
    "@noble/ciphers",
    "@noble/curves",
    "@nostr-wot/pq",
    "@scure/bip39",
    "nostr-tools",
    "@noble/hashes",
    "nostr-wot-sdk",
    "react-dom",
    "react"
  ]
});
