import { defineConfig } from 'tsup';
export default defineConfig({
  esbuildOptions(options) { options.jsx = "automatic"; },
  "entry": {
    "index": "src/index.ts",
    "react/index": "src/react/index.ts",
    "graph/index": "src/graph/index.ts",
    "graph/react/index": "src/graph/react/index.ts"
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
    "nostr-tools",
    "react-dom",
    "react"
  ]
});
