import { defineConfig } from 'tsup';
export default defineConfig({
  "entry": {
    "index": "src/index.ts",
    "cache/index": "src/cache/index.ts",
    "react/index": "src/react/index.ts"
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
    "nostr-wot-sdk",
    "react-dom",
    "nostr-tools",
    "react"
  ]
});
