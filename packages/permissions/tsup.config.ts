import { defineConfig } from 'tsup';
export default defineConfig({
  "entry": {
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
    "nostr-tools",
    "@nostr-wot/identity",
    "react-dom",
    "react"
  ]
});
